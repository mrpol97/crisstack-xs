const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const media = require('../src/main/engine/media');
const color = require('../src/main/engine/color');
const filters = require('../src/main/engine/filters');
const report = require('../src/main/engine/report');
const { LutLibrary } = require('../src/main/engine/lutlib');
const { Store } = require('../src/main/engine/store');
const { Library } = require('../src/main/engine/library');

let tmp, video;
test.before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cinestack5-'));
  video = path.join(tmp, 'A001.mp4');
  const r = spawnSync(media.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=3', '-timecode', '10:00:00:00', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  assert.equal(r.status, 0, String(r.stderr));
});
test.after(async () => { await new Promise((r) => setTimeout(r, 300)); await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); });

test('recorte: un ancho o alto a 0 ya no rompe la previsualizacion (antes: "Failed to inject frame into filter network")', async () => {
  assert.equal(filters.safeCrop({ x: 0, y: 0, w: 1, h: 1 }), null, 'un recorte neutro no recorta');
  const c = filters.safeCrop({ x: 0.9, y: 0, w: 0, h: 1 });
  assert.ok(c.w >= 0.05 && c.x + c.w <= 1 + 1e-9, 'ancho minimo y dentro de la imagen');
  for (const crop of [{ x: 0, y: 0, w: 0, h: 1 }, { x: 0.5, y: 0.5, w: 1, h: 1 }, { x: 0.2, y: 0.2, w: 0.333, h: 0.333 }]) {
    const jpg = await media.previewFrame(video, { crop, time: 0.5 });
    assert.match(jpg, /^data:image\/jpeg;base64,/);
  }
});

test('errores de ffmpeg explicados en castellano', () => {
  assert.match(filters.explainFfmpegError('Failed to inject frame into filter network: Invalid argument'), /recorte/);
  assert.match(filters.explainFfmpegError('Error: lut3d something'), /LUT/);
  assert.equal(filters.explainFfmpegError('otro fallo\nlinea final'), 'otro fallo | linea final');
});

test('LUT 1D: se convierte a 3D y se puede usar en ffmpeg (antes fallaba)', async () => {
  const oneD = 'LUT_1D_SIZE 4\n0 0 0\n0.3 0.3 0.3\n0.6 0.6 0.6\n1 1 1\n';
  const n = color.normalizeCube(oneD);
  assert.equal(n.converted, true); assert.equal(n.size, 33);
  const f = path.join(tmp, 'curva.cube'); await fsp.writeFile(f, n.text);
  const plain = await media.previewFrame(video, { time: 0.5 });
  const graded = await media.previewFrame(video, { luts: [f], time: 0.5 });
  assert.notEqual(plain, graded);
  assert.equal(color.normalizeCube('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n').converted, false);
  assert.throws(() => color.parseCube('esto no es una LUT'), /no válido/);
});

test('biblioteca de LUTs: se importan una vez, sin duplicados, y se pueden quitar', async () => {
  const store = new Store(path.join(tmp, 'app.json'), {});
  const lib = new LutLibrary(path.join(tmp, 'luts'), store);
  const a = path.join(tmp, 'Mi LUT.cube'); await fsp.writeFile(a, color.cdlToCube({ slope: [0.7, 0.7, 0.7], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 }, 5));
  const b = path.join(tmp, 'curva.cube');
  const bad = path.join(tmp, 'rota.cube'); await fsp.writeFile(bad, 'nada');
  const r = await lib.addMany([a, b, bad]);
  assert.equal(r.added.length, 2); assert.equal(r.errors.length, 1);
  assert.equal(lib.list().length, 2);
  assert.ok(lib.list().every((l) => fs.existsSync(l.file)), 'la LUT queda copiada en la carpeta de la app');
  const again = await lib.addMany([a]); assert.equal(again.duplicates.length, 1); assert.equal(lib.list().length, 2);
  await fsp.rm(a); // el original puede desaparecer: la copia sigue ahi
  assert.ok(fs.existsSync(lib.list().find((l) => l.name === 'Mi LUT').file));
  const sub = path.join(tmp, 'pack', 'a'); await fsp.mkdir(sub, { recursive: true });
  await fsp.writeFile(path.join(sub, 'x.cube'), color.cdlToCube({ slope: [0.9, 0.9, 0.9], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 }, 5));
  const folder = await lib.addFolder(path.join(tmp, 'pack')); assert.equal(folder.added.length, 1); assert.equal(lib.list().length, 3);
  lib.rename(folder.added[0].id, 'Mi pack'); assert.ok(lib.list().some((l) => l.name === 'Mi pack'));
  lib.remove(folder.added[0].id); assert.equal(lib.list().length, 2);
  const reopened = new LutLibrary(path.join(tmp, 'luts'), new Store(path.join(tmp, 'app.json'), {})); assert.equal(reopened.list().length, 2, 'persisten al reabrir');
});

test('textos en pantalla: posicion libre, varios a la vez, texto propio con campos del clip y sin que "%" ni ":" lo rompan', async () => {
  const plain = await media.previewFrame(video, { time: 0.5 });
  const at = (x, y) => media.previewFrame(video, { time: 0.5, overlays: [{ kind: 'text', text: 'COPIA: 100% (borrador)', x, y, size: 5 }] });
  const a = await at(0.2, 0.2), b = await at(0.8, 0.8);
  assert.notEqual(a, plain, 'el texto con % y : se dibuja'); assert.notEqual(a, b, 'la posicion cambia la imagen');
  const multi = await media.previewFrame(video, { time: 0.5, fps: 25, startTimecode: '10:00:00:00', overlays: [{ kind: 'tc', x: 0.5, y: 0.9 }, { kind: 'name', x: 0.2, y: 0.08 }, { kind: 'text', text: 'Esc 4', x: 0.8, y: 0.08, color: 'yellow', box: false }] });
  assert.notEqual(multi, plain);
  const ctx = filters.clipContext({ name: 'A001.mp4', scene: '12', shot: 'B', take: '3' }, { name: 'Mi Peli' });
  assert.equal(filters.expandTokens('Esc {scene} Pl {shot} T{take} · {clip} · {project} {nada}', ctx), 'Esc 12 Pl B T3 · A001 · Mi Peli {nada}');
  const res = filters.resolveOverlays([{ kind: 'text', text: '{clip}' }, { kind: 'tc' }, { kind: 'text', text: 'oculto', enabled: false }], ctx);
  assert.equal(res.length, 2); assert.equal(res[0].text, 'A001');
  const out = path.join(tmp, 'o', 'A001.mov');
  await media.transcode(video, out, { preset: 'prores_proxy', fps: 25, startTimecode: '10:00:00:00', duration: 3, overlays: [{ kind: 'tc', x: 0.5, y: 0.9 }, { kind: 'text', text: 'Hola', x: 0.5, y: 0.1 }] });
  assert.ok((await fsp.stat(out)).size > 1000);
  const legacy = await media.previewFrame(video, { time: 0.5, burnTimecode: true, fps: 25 });
  assert.notEqual(legacy, plain, 'los ajustes antiguos (burnTimecode) siguen funcionando');
});

test('fuente incluida en la app: existe y se usa aunque el sistema no tenga la suya', () => {
  const f = filters.fontFile();
  assert.ok(f && fs.existsSync(f), 'hay una fuente disponible');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'assets', 'fonts', 'DejaVuSans.ttf')));
});

test('miniatura con look, tira de fotogramas y stills: usan el look del clip', async () => {
  const thumb = path.join(tmp, 'th', 'a.jpg'); await media.thumbnail(video, thumb, 1);
  const lut = path.join(tmp, 'dark.cube'); await fsp.writeFile(lut, color.cdlToCube({ slope: [0.4, 0.4, 0.4], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 }, 9));
  const looked = path.join(tmp, 'th', 'looks', 'a_x.jpg');
  await media.lookThumb(thumb, looked, { luts: [lut] });
  const [s0, s1] = [await fsp.stat(thumb), await fsp.stat(looked)];
  assert.ok(s1.size > 500 && s1.size !== s0.size, 'la miniatura con LUT es otra imagen');
  assert.equal(fs.readdirSync(path.dirname(looked)).filter((n) => n.includes('.part')).length, 0);
  const strip = await media.filmstrip(video, { count: 6, duration: 3, luts: [lut] });
  assert.equal(strip.length, 6); assert.ok(strip.every((f) => /^data:image\/jpeg/.test(f.img))); assert.ok(strip[0].t < strip[5].t);
  const still = path.join(tmp, 'st', 'x.png');
  await media.exportStill(video, still, { time: 1, preset: 'png', luts: [lut], crop: { x: 0, y: 0, w: 0, h: 0 } });
  assert.ok((await fsp.stat(still)).size > 100, 'incluso con un recorte vacio el still se genera (con el recorte minimo)');
});

test('stills guardados por escena y hoja de informe', async () => {
  const lib = new Library(new Store(path.join(tmp, 'proj.json')), path.join(tmp, 'tt'));
  const s1 = lib.addStill({ id: 'a', clipId: 'c1', clipName: 'A001.mov', scene: '12', shot: 'B', take: '3', tc: '10:00:01:00', t: 1, note: 'cara', file: '/x.jpg', thumb: '/x.t.jpg' });
  lib.addStill({ id: 'b', clipId: 'c2', clipName: 'A002.mov', scene: '3', shot: '', take: '1', tc: '', t: 2, note: '', file: '/y.jpg', thumb: '/y.t.jpg' });
  lib.addStill({ id: 'c', clipId: 'c3', clipName: 'A003.mov', scene: '', shot: '', take: '', tc: '', t: 0, note: '', file: '/z.jpg', thumb: '/z.t.jpg' });
  assert.equal(lib.listStills().length, 3);
  lib.updateStill('a', { scene: '13', note: 'primer plano' }); assert.equal(s1.scene, '13');
  const html = report.buildStills(lib.listStills(), { projectInfo: { name: 'Peli' }, thumbs: { a: 'data:image/jpeg;base64,AA' } });
  assert.match(html, /Escena 13/); assert.match(html, /Escena 3/); assert.match(html, /Sin escena/); assert.match(html, /primer plano/);
  assert.ok(html.indexOf('Escena 3') < html.indexOf('Escena 13'), 'escenas en orden natural');
  assert.equal(lib.removeStill('b').id, 'b'); assert.equal(lib.listStills().length, 2);
  assert.equal(new Library(new Store(path.join(tmp, 'proj.json')), path.join(tmp, 'tt')).listStills().length, 2, 'persisten');
});

test('LUT con lineas extra de otros programas: se reescribe limpia y ffmpeg la acepta', async () => {
  const lines = ['# creada con otro programa', 'TITLE "mi look"', 'LUT_3D_INPUT_RANGE 0.0 1.0', 'LUT_IN_VIDEO_RANGE', 'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${(r * 0.5).toFixed(4)} ${(g * 0.5).toFixed(4)} ${(b * 0.5).toFixed(4)}`);
  const n = color.normalizeCube(lines.join('\r\n'));
  assert.equal(n.converted, false); assert.doesNotMatch(n.text, /INPUT_RANGE|IN_VIDEO_RANGE/);
  const f = path.join(tmp, 'extra.cube'); await fsp.writeFile(f, n.text);
  assert.notEqual(await media.previewFrame(video, { luts: [f], time: 0.5 }), await media.previewFrame(video, { time: 0.5 }));
});

test('registrar la salida de un transcode que ya existe actualiza el clip, no lo duplica', async () => {
  const lib = new Library(new Store(path.join(tmp, 'dup.json')), path.join(tmp, 'dupthumbs'));
  const out = path.join(tmp, 'o', 'A001.mov');
  const a = await lib.registerTranscode({ id: 'src', name: 'A001.mp4' }, out, 'ProRes 422 Proxy');
  const b = await lib.registerTranscode({ id: 'src', name: 'A001.mp4' }, out, 'ProRes 422 Proxy');
  assert.equal(a.id, b.id); assert.equal(Object.values(lib.clips).filter((c) => c.path === out).length, 1);
  await new Promise((r) => setTimeout(r, 1500));
});
