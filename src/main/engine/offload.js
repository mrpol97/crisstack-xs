// Motor de offload: lee cada fichero de origen UNA vez, calcula el hash de origen y escribe
// en todos los destinos a la vez; despues relee cada destino y compara (verificacion real).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHasher } = require('./hasher');

const CHUNK = 4 * 1024 * 1024;
const DEFAULT_IGNORE = [/^\.DS_Store$/, /^Thumbs\.db$/i, /^\.Spotlight-V100$/, /^\.Trashes$/, /^\.fseventsd$/];

async function walk(root, ignore = DEFAULT_IGNORE) {
  const files = [];
  async function rec(dir) {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      if (ignore.some((re) => re.test(ent.name))) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await rec(full);
      else if (ent.isFile()) {
        const st = await fsp.stat(full);
        files.push({ abs: full, rel: path.relative(root, full), size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  await rec(root);
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function hashFile(file, algos, onBytes, signal) {
  const hasher = await createHasher(algos);
  const fd = await fsp.open(file, 'r');
  const buf = Buffer.allocUnsafe(CHUNK);
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('Cancelado');
      const { bytesRead } = await fd.read(buf, 0, CHUNK, null);
      if (!bytesRead) break;
      hasher.update(buf.subarray(0, bytesRead));
      onBytes?.(bytesRead);
    }
  } finally {
    await fd.close();
  }
  return hasher.digest();
}

async function copyOne(file, destPaths, algos, onBytes, signal) {
  const hasher = await createHasher(algos);
  const src = await fsp.open(file.abs, 'r');
  const outs = [];
  for (const d of destPaths) {
    await fsp.mkdir(path.dirname(d), { recursive: true });
    outs.push(await fsp.open(d, 'w'));
  }
  const buf = Buffer.allocUnsafe(CHUNK);
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('Cancelado');
      const { bytesRead } = await src.read(buf, 0, CHUNK, null);
      if (!bytesRead) break;
      const slice = buf.subarray(0, bytesRead);
      hasher.update(slice);
      await Promise.all(outs.map((o) => o.write(slice, 0, bytesRead)));
      onBytes?.(bytesRead);
    }
    await Promise.all(outs.map((o) => o.sync()));
  } finally {
    await src.close();
    await Promise.all(outs.map((o) => o.close()));
  }
  // conserva fecha de modificacion original
  const t = new Date(file.mtime);
  await Promise.all(destPaths.map((d) => fsp.utimes(d, t, t)));
  return hasher.digest();
}

/**
 * opts: { sources:[dir], destinations:[dir], folderName?, algos?, verify?, onProgress?, signal? }
 * Devuelve el resumen del job con una entrada por fichero y por destino.
 */
async function runOffload(opts) {
  const algos = opts.algos?.length ? opts.algos : ['xxh64'];
  const verify = opts.verify !== false;
  const started = new Date();
  const jobFiles = [];
  for (const src of opts.sources) {
    const name = opts.folderName || path.basename(src);
    for (const f of await walk(src)) jobFiles.push({ ...f, srcRoot: src, name });
  }
  const totalBytes = jobFiles.reduce((s, f) => s + f.size, 0);
  const totalWork = totalBytes * (verify ? 1 + opts.destinations.length : 1);
  let done = 0;
  const emit = (extra = {}) =>
    opts.onProgress?.({ doneBytes: done, totalBytes: totalWork, files: jobFiles.length, ...extra });
  const bump = (n) => { done += n; emit(); };

  const results = [];
  let failures = 0;
  for (const f of jobFiles) {
    const outRel = opts.rename ? opts.rename(f.rel) : f.rel;
    const destPaths = opts.destinations.map((d) => path.join(d, f.name, outRel));
    emit({ phase: 'copy', current: f.rel });
    const entry = { rel: path.join(f.name, outRel), srcRel: f.rel, size: f.size, mtime: f.mtime, hashes: null, dests: [] };
    try {
      entry.hashes = await copyOne(f, destPaths, algos, bump, opts.signal);
    } catch (e) {
      if (e.message === 'Cancelado') throw e;
      entry.error = e.message;
      failures++;
      results.push(entry);
      continue;
    }
    for (const dp of destPaths) {
      const d = { path: dp, status: 'copied' };
      if (verify) {
        emit({ phase: 'verify', current: f.rel });
        try {
          const h = await hashFile(dp, algos, bump, opts.signal);
          const bad = algos.filter((a) => h[a] !== entry.hashes[a]);
          d.status = bad.length ? 'MISMATCH' : 'verified';
          if (bad.length) { d.mismatch = bad; failures++; }
        } catch (e) {
          if (e.message === 'Cancelado') throw e;
          d.status = 'ERROR'; d.error = e.message; failures++;
        }
      }
      entry.dests.push(d);
    }
    results.push(entry);
  }
  const finished = new Date();
  emit({ phase: 'done' });
  return {
    id: `${started.toISOString().replace(/[:.]/g, '-')}`,
    started: started.toISOString(),
    finished: finished.toISOString(),
    sources: opts.sources,
    destinations: opts.destinations,
    algos,
    verified: verify,
    totalBytes,
    fileCount: jobFiles.length,
    failures,
    ok: failures === 0,
    files: results,
  };
}

/** Verifica una carpeta existente contra los hashes de un job/MHL anterior. */
async function verifyFolder(root, entries, algos, onProgress, signal) {
  const total = entries.reduce((s, e) => s + e.size, 0);
  let done = 0;
  const out = [];
  for (const e of entries) {
    const abs = path.join(root, e.rel);
    const r = { rel: e.rel, status: 'ok' };
    try {
      await fsp.access(abs, fs.constants.R_OK);
      const h = await hashFile(abs, algos, (n) => { done += n; onProgress?.({ doneBytes: done, totalBytes: total, current: e.rel }); }, signal);
      const bad = algos.filter((a) => h[a] !== e.hashes[a]);
      if (bad.length) { r.status = 'MISMATCH'; r.mismatch = bad; }
    } catch (err) {
      if (err.message === 'Cancelado') throw err;
      r.status = err.code === 'ENOENT' ? 'MISSING' : 'ERROR';
      r.error = err.message;
    }
    out.push(r);
  }
  return out;
}

module.exports = { walk, hashFile, runOffload, verifyFolder };
