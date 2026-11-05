// Motor de offload: lee cada fichero de origen UNA vez, calcula el hash de origen y escribe en todos los destinos
// A LA VEZ, cada uno con su propio escritor y su propia cola (un disco lento no bloquea a la lectura mas alla de unos
// pocos bloques); despues relee todos los destinos en paralelo y compara (verificacion real).
// Un fallo en un destino (disco lleno, desconectado...) no detiene a los demas: ese destino queda marcado como ERROR.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHasher } = require('./hasher');

const CHUNK = 4 * 1024 * 1024;
const DEPTH = 4; // bloques en vuelo por destino (4 x 4 MB)
const DEFAULT_IGNORE = [/^_CrisStack_versiones$/, /^\.DS_Store$/, /^Thumbs\.db$/i, /^\.Spotlight-V100$/, /^\.Trashes$/, /^\.fseventsd$/];

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

/**
 * Copia un fichero a varios destinos. Devuelve { hashes, errors:[Error|null por destino] }.
 * Si se cancela, borra las copias a medias y lanza 'Cancelado'. Si un destino falla, los demas siguen.
 * hooks: { onRead(n), onDest(d, n) }
 */
async function copyOne(file, destPaths, algos, hooks = {}, signal) {
  const hasher = await createHasher(algos);
  const outs = destPaths.map((p) => ({ p, fd: null, err: null, chain: Promise.resolve(), inflight: [] }));
  let src = null;
  try {
    src = await fsp.open(file.abs, 'r');
    for (const o of outs) {
      try { await fsp.mkdir(path.dirname(o.p), { recursive: true }); o.fd = await fsp.open(o.p, 'w'); } catch (e) { o.err = e; }
    }
    for (;;) {
      if (signal?.aborted) throw new Error('Cancelado');
      if (outs.every((o) => o.err)) break; // ningun destino util: no seguimos leyendo
      const buf = Buffer.allocUnsafe(CHUNK);
      const { bytesRead } = await src.read(buf, 0, CHUNK, null);
      if (!bytesRead) break;
      hasher.update(buf.subarray(0, bytesRead));
      hooks.onRead?.(bytesRead);
      outs.forEach((o, d) => {
        if (o.err) return;
        const pr = (o.chain = o.chain.then(async () => {
          if (o.err) return;
          try { await o.fd.write(buf, 0, bytesRead); hooks.onDest?.(d, bytesRead); } catch (e) { o.err = e; }
        }));
        o.inflight.push(pr);
      });
      for (const o of outs) while (o.inflight.length >= DEPTH) await o.inflight.shift(); // contrapresion por destino
    }
    await Promise.all(outs.map((o) => o.chain));
    await Promise.all(outs.map(async (o) => { if (o.fd && !o.err) { try { await o.fd.sync(); } catch (e) { o.err = e; } } }));
  } catch (e) {
    await Promise.all(outs.map((o) => o.chain.catch(() => {})));
    await Promise.all(outs.map(async (o) => { try { await o.fd?.close(); } catch { /* */ } o.fd = null; await fsp.rm(o.p, { force: true }).catch(() => {}); }));
    await src?.close().catch(() => {});
    throw e;
  }
  await src.close();
  await Promise.all(outs.map(async (o) => { try { await o.fd?.close(); } catch (e) { o.err = o.err || e; } }));
  const t = new Date(file.mtime);
  await Promise.all(outs.map(async (o) => {
    if (o.err) { await fsp.rm(o.p, { force: true }).catch(() => {}); return; } // no dejamos copias incompletas
    await fsp.utimes(o.p, t, t).catch(() => {});
  }));
  return { hashes: hasher.digest(), errors: outs.map((o) => o.err || null) };
}

/**
 * opts: { sources:[dir|fichero], destinations:[dir], folderName?, flat?, include?:Set<rel>, algos?, verify?, onProgress?, signal?, rename? }
 *   flat: copia a destino/<ruta relativa> sin carpeta intermedia (sincronizar carpetas)
 *   include: solo estos ficheros (rutas relativas al origen)
 * Devuelve el resumen del job con una entrada por fichero y por destino, mas las muestras de velocidad.
 */
async function runOffload(opts) {
  const algos = opts.algos?.length ? opts.algos : ['xxh64'];
  const verify = opts.verify !== false;
  const nd = opts.destinations.length;
  const started = new Date();
  const t0 = Date.now();
  const jobFiles = [];
  for (const src of opts.sources) {
    const st = await fsp.stat(src);
    if (st.isFile()) { // fichero suelto: se copia a la carpeta del job con su nombre
      jobFiles.push({ abs: src, rel: path.basename(src), size: st.size, mtime: st.mtimeMs, srcRoot: path.dirname(src), name: opts.flat ? '' : (opts.folderName || path.basename(path.dirname(src))) });
      continue;
    }
    const name = opts.flat ? '' : (opts.folderName || path.basename(src));
    for (const f of await walk(src)) if (!opts.include || opts.include.has(f.rel.split(path.sep).join('/'))) jobFiles.push({ ...f, srcRoot: src, name });
  }
  const totalBytes = jobFiles.reduce((s, f) => s + f.size, 0);
  const totalWork = totalBytes * (verify ? 1 + nd : 1);
  let done = 0;
  const ds = opts.destinations.map((p) => ({ path: p, copied: 0, verified: 0, errors: 0 }));
  const cur = {}; // fase actual: se conserva entre eventos para que la interfaz siempre sepa que fichero y que paso
  let lastEmit = 0;
  let speeds = ds.map(() => 0);
  const emit = (extra = {}, force = false) => {
    Object.assign(cur, extra);
    const now = Date.now();
    if (!force && now - lastEmit < 100) return; // la interfaz no necesita mas de 10 avisos por segundo
    lastEmit = now;
    opts.onProgress?.({ doneBytes: done, totalBytes: totalWork, files: jobFiles.length, destCount: nd, verify, perDest: ds.map((d, i) => ({ path: d.path, copied: d.copied, verified: d.verified, errors: d.errors, speed: speeds[i] })), ...cur });
  };

  // muestras de velocidad: una por segundo (la serie se aclara si el traspaso dura horas)
  const samples = []; // [segundos, bytesTotales, fase(0 copia, 1 verificacion), ...bytesPorDestino]
  let lastSample = { t: t0, per: ds.map(() => 0) };
  const sample = (last) => {
    const now = Date.now(); const dt = (now - lastSample.t) / 1000;
    const per = ds.map((d) => d.copied + d.verified);
    if (last === true && dt < 0.5 && samples.length) samples.pop(); // un ultimo intervalo muy corto se funde con el anterior: evita picos falsos
    else if (dt > 0) speeds = per.map((p, i) => (p - lastSample.per[i]) / dt);
    lastSample = { t: now, per };
    samples.push([Math.round((now - t0) / 100) / 10, done, cur.phase === 'verify' ? 1 : 0, ...per]);
    if (samples.length > 7200) for (let i = samples.length - 1; i > 0; i -= 2) samples.splice(i, 1);
  };
  const timer = setInterval(sample, 1000);

  const results = [];
  let failures = 0;
  try {
    for (let fi = 0; fi < jobFiles.length; fi++) {
      const f = jobFiles[fi];
      const outRel = opts.rename ? opts.rename(f.rel) : f.rel;
      const destPaths = opts.destinations.map((d) => path.join(d, f.name, outRel));
      emit({ phase: 'copy', current: f.rel, fileIndex: fi + 1, fileSize: f.size, dest: null }, true);
      const entry = { rel: path.join(f.name, outRel), srcRel: f.rel, size: f.size, mtime: f.mtime, hashes: null, dests: [] };
      let cp;
      try {
        cp = await copyOne(f, destPaths, algos, { onRead: (n) => { done += n; emit(); }, onDest: (d, n) => { ds[d].copied += n; } }, opts.signal);
      } catch (e) {
        if (e.message === 'Cancelado') throw e;
        entry.error = e.message;
        failures++;
        results.push(entry);
        continue;
      }
      entry.hashes = cp.hashes;
      if (verify) emit({ phase: 'verify', current: f.rel, dest: null }, true);
      // todos los destinos se releen a la vez
      entry.dests = await Promise.all(destPaths.map(async (dp, di) => {
        const d = { path: dp, status: 'copied' };
        if (cp.errors[di]) { d.status = 'ERROR'; d.error = cp.errors[di].message; ds[di].errors++; failures++; return d; }
        if (!verify) return d;
        try {
          const h = await hashFile(dp, algos, (n) => { done += n; ds[di].verified += n; emit(); }, opts.signal);
          const bad = algos.filter((a) => h[a] !== cp.hashes[a]);
          d.status = bad.length ? 'MISMATCH' : 'verified';
          if (bad.length) { d.mismatch = bad; ds[di].errors++; failures++; }
        } catch (e) {
          if (e.message === 'Cancelado') throw e;
          d.status = 'ERROR'; d.error = e.message; ds[di].errors++; failures++;
        }
        return d;
      }));
      results.push(entry);
    }
  } finally {
    clearInterval(timer);
  }
  sample(true);
  const finished = new Date();
  done = totalWork;
  emit({ phase: 'done' }, true);
  const seconds = Math.max(0.001, (finished - started) / 1000);
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
    seconds,
    perDest: ds.map((d) => ({ path: d.path, copiedBytes: d.copied, verifiedBytes: d.verified, errors: d.errors })),
    samples,
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

module.exports = { walk, hashFile, copyOne, runOffload, verifyFolder };
