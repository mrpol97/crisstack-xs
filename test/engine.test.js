const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { runOffload, verifyFolder, hashFile } = require('../src/main/engine/offload');
const { buildMhl, parseMhl } = require('../src/main/engine/mhl');
const { expand } = require('../src/main/engine/wildcards');
const { Store } = require('../src/main/engine/store');
const { Library, matchSmart } = require('../src/main/engine/library');
const media = require('../src/main/engine/media');
const report = require('../src/main/engine/report');

let tmp;
test.before(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cinestack-')); });
test.after(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

async function makeCard(dir) {
  await fsp.mkdir(path.join(dir, 'PRIVATE', 'M4ROOT'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'A001.bin'), crypto.randomBytes(9 * 1024 * 1024 + 123)); // cruza varios chunks
  await fsp.writeFile(path.join(dir, 'PRIVATE', 'M4ROOT', 'B.dat'), crypto.randomBytes(5000));
  await fsp.writeFile(path.join(dir, 'empty.txt'), '');
  await fsp.writeFile(path.join(dir, '.DS_Store'), 'ignorar');
}

test('offload a 2 destinos con xxh64+md5 verifica y detecta corrupcion', async () => {
  const card = path.join(tmp, 'CARD1'), d1 = path.join(tmp, 'D1'), d2 = path.join(tmp, 'D2');
  await makeCard(card);
  const events = [];
  const job = await runOffload({ sources: [card], destinations: [d1, d2], algos: ['xxh64', 'md5'], onProgress: (p) => events.push(p) });
  assert.equal(job.ok, true);
  assert.equal(job.fileCount, 3, '.DS_Store debe ignorarse');
  assert.ok(events.at(-1).phase === 'done');
  for (const f of job.files) for (const d of f.dests) assert.equal(d.status, 'verified');
  const src = await hashFile(path.join(card, 'A001.bin'), ['md5']);
  const dst = await hashFile(path.join(d2, 'CARD1', 'A001.bin'), ['md5']);
  assert.equal(src.md5, dst.md5);
  assert.equal((await fsp.stat(path.join(d1, 'CARD1', 'A001.bin'))).mtimeMs | 0, (await fsp.stat(path.join(card, 'A001.bin'))).mtimeMs | 0);

  // MHL ida y vuelta + verificacion posterior
  const entries = parseMhl(buildMhl(job));
  assert.equal(entries.length, 3);
  const root = path.join(d1, 'CARD1');
  const entriesLocal = entries.map((e) => ({ ...e, rel: e.rel.replace(/^CARD1\//, '') }));
  const ok = await verifyFolder(root, entriesLocal, ['xxh64', 'md5']);
  assert.ok(ok.every((r) => r.status === 'ok'));

  // corrompe 1 byte y borra otro fichero
  const target = path.join(root, 'A001.bin');
  const fd = await fsp.open(target, 'r+'); await fd.write(Buffer.from([0xff ^ (await fsp.readFile(target))[100]]), 0, 1, 100); await fd.close();
  await fsp.rm(path.join(root, 'PRIVATE', 'M4ROOT', 'B.dat'));
  const bad = await verifyFolder(root, entriesLocal, ['xxh64', 'md5']);
  assert.equal(bad.find((r) => r.rel.endsWith('A001.bin')).status, 'MISMATCH');
  assert.equal(bad.find((r) => r.rel.endsWith('B.dat')).status, 'MISSING');
});

test('cancelar con AbortSignal', async () => {
  const card = path.join(tmp, 'CARD2'); await makeCard(card);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(runOffload({ sources: [card], destinations: [path.join(tmp, 'DX')], signal: ac.signal }), /Cancelado/);
});

test('xxh64 coincide con valor conocido', async () => {
  const f = path.join(tmp, 'known.txt'); await fsp.writeFile(f, 'hello');
  const h = await hashFile(f, ['xxh64', 'md5']);
  assert.equal(h.xxh64, '26c7827d889f6da3'); // XXH64("hello", seed 0)
  assert.equal(h.md5, '5d41402abc4b2a76b9719d911017c592');
});

test('comodines de ruta', () => {
  const p = expand('{project}/Dia_{day}/{camera}_{reel}', { project: 'Peli', day: 3, camera: 'B', source: '/x/A007' });
  assert.equal(p, 'Peli/Dia_03/B_A007');
  assert.equal(expand('{desconocido}', {}), '{desconocido}');
});

test('carpetas inteligentes', () => {
  const clip = { name: 'A001C002.mov', flag: 'good', rating: 4, meta: { fps: 24, width: 3840 }, custom: { Lente: '35mm' } };
  assert.ok(matchSmart(clip, { match: 'all', rules: [{ field: 'flag', op: 'eq', value: 'good' }, { field: 'rating', op: 'gt', value: 3 }] }));
  assert.ok(matchSmart(clip, { match: 'any', rules: [{ field: 'Lente', op: 'contains', value: '50' }, { field: 'width', op: 'gt', value: 2000 }] }));
  assert.ok(!matchSmart(clip, { match: 'all', rules: [{ field: 'fps', op: 'gt', value: 30 }] }));
});

test('ffprobe, miniatura, transcode, biblioteca e informes con video real', async () => {
  const card = path.join(tmp, 'CARD3'); await fsp.mkdir(card);
  const clipFile = path.join(card, 'A001C001.mov');
  const gen = spawnSync(media.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-timecode', '01:02:03:04', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipFile]);
  assert.equal(gen.status, 0, String(gen.stderr));

  const info = await media.probe(clipFile);
  assert.equal(info.width, 640); assert.equal(info.height, 360); assert.equal(Math.round(info.fps), 24); assert.equal(info.codec, 'h264');
  assert.equal(info.timecode, '01:02:03:04');

  const job = await runOffload({ sources: [card], destinations: [path.join(tmp, 'LIBDEST')], algos: ['xxh64'] });
  const lib = new Library(new Store(path.join(tmp, 'lib.json')), path.join(tmp, 'thumbs'));
  const { clips } = await lib.registerJob(job, { project: 'Test', reel: 'A001', camera: 'A' });
  assert.equal(clips.length, 1);
  await new Promise((r) => { const t = setInterval(() => { if (clips[0].thumb || clips[0].metaError) { clearInterval(t); r(); } }, 100); });
  assert.ok(clips[0].thumb && fs.existsSync(clips[0].thumb), clips[0].metaError);
  assert.equal(clips[0].meta.width, 640);
  lib.updateClip(clips[0].id, { flag: 'good', rating: 5, scene: '12', custom: { Lente: '35mm' } });
  assert.equal(lib.listClips({ search: '12' }).length, 1);

  const out = path.join(tmp, 'out', 'prores.mov');
  const progress = [];
  await media.transcode(clipFile, out, { preset: 'prores_proxy', height: 180, duration: info.duration, onProgress: (p) => progress.push(p) });
  const outInfo = await media.probe(out);
  assert.equal(outInfo.codec, 'prores'); assert.equal(outInfo.height, 180);

  const out2 = path.join(tmp, 'out', 'dnx.mxf');
  await media.transcode(clipFile, out2, { preset: 'dnxhr_lb', duration: info.duration });
  assert.equal((await media.probe(out2)).codec, 'dnxhd');

  const html = report.build('shooting_day', { clips: lib.listClips(), jobs: [job], project: 'Test' });
  assert.match(html, /A001C001\.mov/); assert.match(html, /Todo verificado/);
  assert.match(report.build('volume', { jobs: [job] }), /Informe de volumen/);
  assert.match(report.build('contact_print', { clips: lib.listClips() }), /data:image\/jpeg;base64/);
  assert.match(report.toCsv(lib.listClips()), /A001C001\.mov/);
  assert.match(report.toEdl(lib.listClips(), 'T', 24), /01:02:03:04 01:02:05:04/);
});
