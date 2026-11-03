const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const media = require('../src/main/engine/media');
const { Store } = require('../src/main/engine/store');
const { Library } = require('../src/main/engine/library');
const exportsM = require('../src/main/engine/exports');
const report = require('../src/main/engine/report');

let tmp;
test.before(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cinestack3-')); });
test.after(async () => { await new Promise((r) => setTimeout(r, 1200)); await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); });
const newLib = (name) => new Library(new Store(path.join(tmp, name + '.json')), path.join(tmp, 'thumbs-' + name));
const mkVideo = (f, secs = 1) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const r = spawnSync(media.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=24:duration=${secs}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]); assert.equal(r.status, 0, String(r.stderr)); };

test('ficha de proyecto: campos, nombre obligatorio y limite del logo', () => {
  const lib = newLib('p');
  assert.equal(lib.getProject(), null);
  assert.throws(() => lib.setProject({ director: 'Ana' }), /nombre/);
  const p = lib.setProject({ name: ' Mi Peli ', director: 'Ana', dit: 'Pol', cinematographer: 'Luis', production: 'Prod SL', copyright: '© 2026', logo: 'data:image/png;base64,AAAA' });
  assert.equal(p.name, 'Mi Peli'); assert.equal(p.director, 'Ana'); assert.equal(p.logo, 'data:image/png;base64,AAAA');
  lib.setProject({ dit: 'Otro DIT' }); // se puede cambiar despues sin perder el resto
  assert.equal(lib.getProject().dit, 'Otro DIT'); assert.equal(lib.getProject().director, 'Ana'); assert.equal(lib.getProject().name, 'Mi Peli');
  assert.throws(() => lib.setProject({ logo: 'x'.repeat(2.2 * 1024 * 1024) }), /logo/);
});

test('importar carpetas: arbol de carpetas, estadisticas, sin duplicados y solo ficheros pedidos', async () => {
  const root = path.join(tmp, 'ROOT');
  mkVideo(path.join(root, 'Dia 1', 'CamA', 'A001.mp4')); mkVideo(path.join(root, 'Dia 1', 'CamA', 'A002.mp4')); mkVideo(path.join(root, 'Dia 2', 'CamB', 'B001.mp4'));
  spawnSync(media.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', path.join(root, 'Dia 1', 'toma.wav')]);
  await fsp.writeFile(path.join(root, 'notas.txt'), 'nada');
  const lib = newLib('imp');
  const r = await lib.importFolder(root, {}, () => {});
  assert.equal(r.imported, 4); assert.equal(r.skipped, 1); assert.equal(r.duplicates, 0);
  const bins = lib.listBins(); const byName = (n) => bins.find((b) => b.name === n);
  assert.equal(byName('ROOT').parent, null); assert.equal(byName('Dia 1').parent, byName('ROOT').id); assert.equal(byName('CamA').parent, byName('Dia 1').id);
  assert.equal(byName('ROOT').count, 4); assert.equal(byName('Dia 1').count, 3); assert.equal(byName('CamA').count, 2); assert.equal(byName('Dia 1').own, 1); // toma.wav cuelga de Dia 1
  assert.equal(byName('ROOT').stats.video, 3); assert.equal(byName('ROOT').stats.audio, 1);
  assert.ok(byName('ROOT').stats.size > 0);
  assert.equal(lib.listClips({ bin: byName('Dia 1').id }).length, 3, 'una carpeta incluye sus subcarpetas');
  assert.equal(lib.listClips({ bin: byName('Dia 1').id, recursive: false }).length, 1);
  assert.equal((await lib.importFolder(root, {}, () => {})).duplicates, 4, 'reimportar no duplica');
  const only = await lib.importFolder(root, { only: [path.join(root, 'notas.txt')] }, () => {});
  assert.equal(only.imported, 0);
  await new Promise((res) => { const t = setInterval(() => { if (Object.values(lib.clips).every((c) => c.meta || c.metaError)) { clearInterval(t); res(); } }, 100); });
  const a = Object.values(lib.clips).find((c) => c.name === 'A001.mp4');
  assert.equal(a.meta.width, 320); assert.equal(a.meta.audioCodec, null); assert.ok(a.volume); assert.equal(a.copies.length, 1);
  lib.updateClip(a.id, { cam: { iso: '800', lens: '35mm' }, shotId: 'S12', flag: 'circled' });
  assert.equal(lib.clips[a.id].cam.iso, '800'); assert.equal(lib.clips[a.id].shotId, 'S12');
  assert.equal(lib.listClips({ search: 'S12' }).length, 1);
});

test('transcode: registra la salida con informacion y tamano; un fallo no deja ficheros vacios', async () => {
  const src = path.join(tmp, 'ROOT', 'Dia 1', 'CamA', 'A001.mp4');
  const out = path.join(tmp, 'tc', 'A001.mov');
  await media.transcode(src, out, { preset: 'prores_proxy', duration: 1 });
  assert.ok(fs.statSync(out).size > 1000);
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'tc')).filter((n) => n.includes('partial')), []);
  const lib = newLib('tc');
  const clip = await lib.registerTranscode({ id: 's', reel: 'R1', camera: 'A' }, out, 'ProRes 422 Proxy', () => {});
  assert.equal(clip.size, fs.statSync(out).size); assert.equal(clip.verified, 'transcode'); assert.equal(clip.reel, 'R1');
  await new Promise((res) => { const t = setInterval(() => { if (clip.meta || clip.metaError) { clearInterval(t); res(); } }, 100); });
  assert.equal(clip.meta.codec, 'prores', 'la salida registrada trae su informacion');
  assert.equal(lib.bins[clip.bin].name, 'ProRes 422 Proxy'); assert.equal(lib.bins[lib.bins[clip.bin].parent].name, 'Transcodes');
  // un fichero que no es video: error claro y nada que limpiar
  const bad = path.join(tmp, 'falso.mp4'); await fsp.writeFile(bad, 'esto no es un video');
  const out2 = path.join(tmp, 'tc', 'falso.mov');
  await assert.rejects(media.transcode(bad, out2, { preset: 'prores_proxy' }));
  assert.equal(fs.existsSync(out2), false); assert.deepEqual(fs.readdirSync(path.join(tmp, 'tc')).filter((n) => n.includes('partial')), []);
});

test('ALE con ISO/WB/lente y columnas propias; informe con ficha de proyecto', () => {
  const clips = [{ kind: 'video', name: 'A001.mp4', reel: 'R', shot: 'B', shotId: 'S1', meta: { timecode: '01:00:00:00', fps: 25, duration: 2, audioTracks: 1, camera: { iso: '400' } }, cam: { lens: '50mm', wb: '5600' }, custom: { 'Lente prestada': 'sí', Otro: 'x' } }];
  const ale = exportsM.toAle(clips, 25, ['Lente prestada']);
  assert.match(ale, /ISO\tWB\tShutter\tLens\tLente prestada/); assert.match(ale, /\tB\tS1\t400\t5600\t\t50mm\tsí/);
  const html = report.build('clips', { clips, jobs: [], projectInfo: { name: 'Mi Peli', production: 'Prod SL', director: 'Ana', dit: 'Pol', copyright: '© 2026 Prod SL', logo: 'data:image/png;base64,iVBORw0KGgo=' } });
  assert.match(html, /Prod SL/); assert.match(html, /Ana/); assert.match(html, /Pol/); assert.match(html, /© 2026 Prod SL/); assert.match(html, /<img class="logo"/);
  assert.doesNotMatch(report.build('clips', { clips, jobs: [], projectInfo: { name: 'X', logo: 'javascript:alert(1)' } }), /<img class="logo"/, 'un logo no-imagen no se incrusta');
  assert.doesNotMatch(report.build('clips', { clips, jobs: [] }), /class="proj"/, 'sin ficha no hay cabecera');
});
