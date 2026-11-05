// Comparar dos carpetas (A = origen, B = destino) y ver que hay de nuevo. Solo lee; copiar lo nuevo lo hace runOffload (con checksum).
const fsp = require('node:fs/promises');
const path = require('node:path');
const { walk, hashFile } = require('./offload');

const norm = (rel) => rel.split(path.sep).join('/');

/**
 * Categorias:
 *   onlyA      esta en A y no en B (lo nuevo)
 *   onlyB      esta en B y no en A
 *   differ     mismo nombre pero contenido distinto (distinto tamano o, en modo hash, distinto checksum)
 *   dateOnly   mismo tamano y distinta fecha (solo en modo rapido: no se sabe si el contenido cambia; usa el modo checksum)
 *   same       iguales
 * opts: { hash?:boolean, algo?:string, tolMs?:number, onProgress?, signal? }
 */
async function compareFolders(a, b, opts = {}) {
  const tol = opts.tolMs ?? 2000; // FAT/exFAT guardan la fecha con 2 s de precision
  const [fa, fb] = await Promise.all([walk(a), walk(b)]);
  const mb = new Map(fb.map((f) => [norm(f.rel), f]));
  const ma = new Map(fa.map((f) => [norm(f.rel), f]));
  const out = { a, b, onlyA: [], onlyB: [], differ: [], dateOnly: [], same: [], hashed: !!opts.hash };
  const toHash = [];
  for (const [rel, f] of ma) {
    const g = mb.get(rel);
    if (!g) { out.onlyA.push({ rel, size: f.size, mtime: f.mtime }); continue; }
    if (f.size !== g.size) { out.differ.push({ rel, size: f.size, sizeB: g.size, mtime: f.mtime, mtimeB: g.mtime, reason: 'tamaño' }); continue; }
    if (opts.hash) { toHash.push([rel, f, g]); continue; }
    if (Math.abs(f.mtime - g.mtime) > tol) out.dateOnly.push({ rel, size: f.size, mtime: f.mtime, mtimeB: g.mtime });
    else out.same.push({ rel, size: f.size });
  }
  for (const [rel, g] of mb) if (!ma.has(rel)) out.onlyB.push({ rel, size: g.size, mtime: g.mtime });
  if (toHash.length) {
    const total = toHash.reduce((s, [, f]) => s + f.size * 2, 0);
    let done = 0;
    const algo = opts.algo || 'xxh64';
    for (const [rel, f, g] of toHash) {
      // A y B se leen a la vez (son discos distintos casi siempre)
      const [ha, hb] = await Promise.all([f.abs, g.abs].map((p) => hashFile(p, [algo], (n) => { done += n; opts.onProgress?.({ doneBytes: done, totalBytes: total, current: rel }); }, opts.signal)));
      if (ha[algo] === hb[algo]) out.same.push({ rel, size: f.size });
      else out.differ.push({ rel, size: f.size, sizeB: g.size, mtime: f.mtime, mtimeB: g.mtime, reason: 'checksum' });
    }
  }
  for (const k of ['onlyA', 'onlyB', 'differ', 'dateOnly', 'same']) out[k].sort((x, y) => x.rel.localeCompare(y.rel));
  out.bytesNew = out.onlyA.reduce((s, f) => s + f.size, 0);
  out.bytesDiffer = out.differ.reduce((s, f) => s + f.size, 0);
  return out;
}

/**
 * Antes de reemplazar ficheros en B, guarda la version anterior en B/_CrisStack_versiones/<fecha>/<ruta> (nunca se pierde).
 * Devuelve { list: rutas que se pueden copiar, kept: cuantas versiones se guardaron, dir }.
 */
async function archiveExisting(b, rels, { replace = false, stamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  const dir = path.join(b, '_CrisStack_versiones', stamp);
  const list = []; let kept = 0;
  for (const rel of rels) {
    const dst = path.join(b, rel);
    const exists = await fsp.stat(dst).then(() => true, () => false);
    if (exists) {
      if (!replace) continue; // sin permiso para reemplazar nunca se pisa nada
      const old = path.join(dir, rel);
      await fsp.mkdir(path.dirname(old), { recursive: true });
      await fsp.rename(dst, old);
      kept++;
    }
    list.push(rel);
  }
  return { list, kept, dir: kept ? dir : null };
}

module.exports = { compareFolders, archiveExisting };
