const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { runOffload } = require('../src/main/engine/offload');
const { compareFolders } = require('../src/main/engine/sync');
const speed = require('../src/main/engine/speed');
const report = require('../src/main/engine/report');

let tmp;
test.before(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cinestack8-')); });
test.after(async () => { await new Promise((r) => setTimeout(r, 200)); await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });

async function mk(dir, files) {
  for (const [rel, data] of Object.entries(files)) { const p = path.join(dir, rel); await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, data); }
}

test('un destino que falla no detiene a los demás y no deja copias a medias', async () => {
  const src = path.join(tmp, 'f1', 'src'); await mk(src, { 'A.bin': crypto.randomBytes(9 * 1024 * 1024), 'sub/B.bin': crypto.randomBytes(1000) });
  const good = path.join(tmp, 'f1', 'good'); const bad = path.join(tmp, 'f1', 'bad');
  await fsp.writeFile(bad, 'esto es un fichero, no una carpeta'); // no se puede crear nada dentro
  const job = await runOffload({ sources: [src], destinations: [good, bad], folderName: 'R1', algos: ['xxh64', 'md5'] });
  assert.equal(job.ok, false);
  assert.equal(job.failures, 2, 'un fallo por fichero en el destino roto');
  for (const f of job.files) { assert.equal(f.dests[0].status, 'verified'); assert.equal(f.dests[1].status, 'ERROR'); }
  assert.equal((await fsp.readFile(path.join(good, 'R1', 'A.bin'))).length, 9 * 1024 * 1024);
  assert.equal(job.perDest[0].errors, 0); assert.equal(job.perDest[1].errors, 2);
});

test('cancelar borra la copia a medias', async () => {
  const src = path.join(tmp, 'f2', 'src'); await mk(src, { 'big.bin': crypto.randomBytes(12 * 1024 * 1024) });
  const dest = path.join(tmp, 'f2', 'd'); const ac = new AbortController();
  await assert.rejects(runOffload({ sources: [src], destinations: [dest], folderName: 'X', signal: ac.signal, onProgress: (p) => { if (p.phase === 'copy') ac.abort(); } }), /Cancelado/);
  assert.equal(fs.existsSync(path.join(dest, 'X', 'big.bin')), false, 'no queda un fichero incompleto en el destino');
});

test('include + flat: copia solo lo pedido, directamente a destino/ruta', async () => {
  const src = path.join(tmp, 'f3', 'src'); await mk(src, { 'a.txt': 'aaa', 'dir/b.txt': 'bbb', 'dir/c.txt': 'ccc' });
  const dest = path.join(tmp, 'f3', 'dst');
  const job = await runOffload({ sources: [src], destinations: [dest], flat: true, include: new Set(['dir/b.txt']), algos: ['xxh64'] });
  assert.ok(job.ok); assert.equal(job.fileCount, 1);
  assert.equal(await fsp.readFile(path.join(dest, 'dir', 'b.txt'), 'utf8'), 'bbb');
  assert.equal(fs.existsSync(path.join(dest, 'a.txt')), false);
});

test('el job guarda segundos y bytes por destino', async () => {
  const src = path.join(tmp, 'f4', 'src'); await mk(src, { 'a.bin': crypto.randomBytes(300000) });
  const job = await runOffload({ sources: [src], destinations: [path.join(tmp, 'f4', 'd1'), path.join(tmp, 'f4', 'd2')], folderName: 'R', algos: ['xxh64'] });
  assert.ok(job.seconds > 0);
  assert.deepEqual(job.perDest.map((d) => [d.copiedBytes, d.verifiedBytes]), [[300000, 300000], [300000, 300000]]);
  assert.ok(job.samples.length >= 1);
});

test('comparar carpetas: nuevos, distintos, fechas y solo en destino', async () => {
  const a = path.join(tmp, 'f5', 'A'), b = path.join(tmp, 'f5', 'B');
  await mk(a, { 'igual.txt': 'hola', 'nuevo.txt': 'nuevo', 'dir/otro.txt': 'x', 'cambia.txt': 'version larga', 'misma.txt': 'abcd' });
  await mk(b, { 'igual.txt': 'hola', 'cambia.txt': 'v1', 'misma.txt': 'zzzz', 'soloB.txt': 's' });
  const t = new Date(Date.now() - 3600 * 1000); await fsp.utimes(path.join(b, 'misma.txt'), t, t); // mismo tamano, otra fecha
  const t2 = new Date('2024-01-01T10:00:00Z'); for (const p of [path.join(a, 'igual.txt'), path.join(b, 'igual.txt')]) await fsp.utimes(p, t2, t2);
  const r = await compareFolders(a, b);
  assert.deepEqual(r.onlyA.map((x) => x.rel), ['dir/otro.txt', 'nuevo.txt']);
  assert.deepEqual(r.onlyB.map((x) => x.rel), ['soloB.txt']);
  assert.deepEqual(r.differ.map((x) => x.rel), ['cambia.txt']);
  assert.deepEqual(r.dateOnly.map((x) => x.rel), ['misma.txt']);
  assert.deepEqual(r.same.map((x) => x.rel), ['igual.txt']);
  const h = await compareFolders(a, b, { hash: true });
  assert.deepEqual(h.differ.map((x) => x.rel).sort(), ['cambia.txt', 'misma.txt'], 'con checksum, el mismo tamaño pero distinto contenido se detecta');
  assert.equal(h.dateOnly.length, 0);
});

test('sincronizar: copiar lo nuevo con verificación y volver a comparar deja todo igual', async () => {
  const a = path.join(tmp, 'f6', 'A'), b = path.join(tmp, 'f6', 'B');
  await mk(a, { 'x.bin': crypto.randomBytes(5000), 'd/y.bin': crypto.randomBytes(7000), 'ya.txt': 'ya' }); await mk(b, { 'ya.txt': 'ya' });
  const before = await compareFolders(a, b);
  const job = await runOffload({ sources: [a], destinations: [b], flat: true, include: new Set(before.onlyA.map((f) => f.rel)), algos: ['xxh64'] });
  assert.ok(job.ok && job.fileCount === 2);
  const after = await compareFolders(a, b, { hash: true });
  assert.equal(after.onlyA.length, 0); assert.equal(after.differ.length, 0); assert.equal(after.same.length, 3);
});

test('velocidad: estadísticas, gráfica SVG e informe', () => {
  // muestras acumuladas [t, total, fase, d1, d2]: 100 MB/s en copia, 50 MB/s en verificación
  const MB = 1024 * 1024; const samples = [];
  for (let t = 0; t <= 10; t++) samples.push([t, t * 100 * MB, t < 6 ? 0 : 1, t * 80 * MB, t * 100 * MB]);
  const job = { id: 'j1', started: '2026-11-05T10:00:00Z', sources: ['/src'], destinations: ['/d1', '/d2'], fileCount: 3, totalBytes: 600 * MB, seconds: 10, failures: 0, samples, perDest: [{ path: '/d1', copiedBytes: 400 * MB, verifiedBytes: 400 * MB, errors: 0 }, { path: '/d2', copiedBytes: 500 * MB, verifiedBytes: 500 * MB, errors: 0 }] };
  const s = speed.stats(job);
  assert.equal(Math.round(s.peak / MB), 100); assert.equal(Math.round(s.perDest[1].peak / MB), 100); assert.equal(Math.round(s.perDest[0].peak / MB), 80);
  const svg = speed.chartSvg(job);
  assert.match(svg, /<svg/); assert.match(svg, /polyline/); assert.ok((svg.match(/<polyline/g) || []).length === 3, 'total + un trazo por destino');
  const html = report.build('transfer', { jobs: [job], project: 'P' });
  assert.match(html, /Velocidad del traspaso/); assert.match(html, /\/d2/);
  assert.match(speed.chartSvg({ ...job, samples: [] }), /demasiado corto/);
});
