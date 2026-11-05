const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const media = require('../src/main/engine/media');
const { runOffload } = require('../src/main/engine/offload');
const { expand } = require('../src/main/engine/wildcards');
const color = require('../src/main/engine/color');
const tools = require('../src/main/engine/tools');
const report = require('../src/main/engine/report');

let tmp;
test.before(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cinestack4-')); });
test.after(async () => { await new Promise((r) => setTimeout(r, 300)); await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); });
const mkVideo = (f, extra = []) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const r = spawnSync(media.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=2', '-timecode', '10:00:00:00', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...extra, f]); assert.equal(r.status, 0, String(r.stderr)); };

test('offload: ficheros sueltos y datos de progreso (fichero, paso y destino) siempre presentes', async () => {
  const a = path.join(tmp, 'src', 'a.bin'), b = path.join(tmp, 'src', 'b.bin');
  await fsp.mkdir(path.dirname(a), { recursive: true }); await fsp.writeFile(a, Buffer.alloc(300000, 1)); await fsp.writeFile(b, Buffer.alloc(100000, 2));
  const ev = [];
  const job = await runOffload({ sources: [a, b], destinations: [path.join(tmp, 'd1'), path.join(tmp, 'd2')], folderName: 'Mi Peli/Dia_01/Camara_A/Sueltos', algos: ['xxh64'], onProgress: (p) => ev.push(p) });
  assert.ok(job.ok); assert.equal(job.fileCount, 2);
  for (const d of ['d1', 'd2']) assert.ok(fs.existsSync(path.join(tmp, d, 'Mi Peli', 'Dia_01', 'Camara_A', 'Sueltos', 'a.bin')));
  const mid = ev.filter((e) => e.doneBytes > 0 && e.phase !== 'done');
  assert.ok(mid.length >= 2 && mid.every((e) => e.phase && e.current && e.fileIndex), 'cada evento sabe en qué fase y fichero está');
  const last = ev.at(-1);
  assert.ok(ev.some((e) => e.phase === 'verify'), 'se informa de la fase de verificación (todos los destinos a la vez)');
  assert.ok(last.perDest.length === 2 && last.perDest.every((d) => d.copied === 400000 && d.verified === 400000), 'los dos destinos informan de lo escrito y de lo verificado');
  assert.equal(ev.find((e) => e.phase === 'copy').destCount, 2); assert.equal(ev.at(-1).phase, 'done');
  assert.ok(ev.every((e, i) => i === 0 || e.doneBytes >= ev[i - 1].doneBytes), 'el progreso nunca retrocede');
});

test('comodin {type}: carpetas de camara y de sonido dentro del mismo dia', () => {
  const c = expand('{project}/Dia_{day}/Camara_{camera}/{reel}', { project: 'Peli', day: 1, camera: 'A', reel: 'A001', type: 'camera' });
  const s = expand('{project}/Dia_{day}/{type}/{reel}', { project: 'Peli', day: 1, reel: 'SD1', type: 'sound' });
  assert.equal(c, 'Peli/Dia_01/Camara_A/A001'); assert.equal(s, 'Peli/Dia_01/Sonido/SD1');
  assert.equal(expand('{type}', { type: 'camera' }), 'Camara');
});

test('orden de color: LUT primero y ajuste del clip encima (o al reves)', async () => {
  const lut = path.join(tmp, 'base.cube'); await fsp.writeFile(lut, color.cdlToCube({ slope: [0.5, 0.5, 0.5], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 }, 9));
  const cdl = { slope: [0.8, 0.8, 0.8], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 };
  const post = await color.buildFfmpegLooks({ cdl, lut }, path.join(tmp, 'cubes')); // por defecto: LUT y despues ajuste
  assert.equal(post.length, 2); assert.equal(post[0], lut); assert.match(post[1], /cdl_.*\.cube$/);
  const pre = await color.buildFfmpegLooks({ cdl, lut, order: 'cdl-first' }, path.join(tmp, 'cubes'));
  assert.match(pre[0], /cdl_.*\.cube$/); assert.equal(pre[1], lut);
  assert.deepEqual(await color.buildFfmpegLooks({ cdl: color.IDENTITY(), lut }, path.join(tmp, 'cubes')), [lut], 'un CDL neutro no anade pasos');
});

test('transcode: metadatos, timecode, texto y nombre quemados, y previsualizacion con los mismos filtros', async () => {
  const src = path.join(tmp, 'v', 'A001.mp4'); mkVideo(src, ['-metadata', 'title=original']);
  const clip = { name: 'A001.mp4', scene: '12', shot: 'B', take: '3', camera: 'A', reel: 'R1', shotId: 'S-77', notes: 'toma buena', rating: 4, flag: 'good', custom: { 'Lente prestada': 'sí' }, cam: { iso: '800' }, meta: {} };
  const info = { name: 'Mi Peli', director: 'Ana', dit: 'Pol', copyright: '© 2026', production: 'Prod SL' };
  const md = tools.buildClipMetadata(clip, info, ['project', 'director', 'scene', 'take', 'notes', 'iso', 'custom:Lente prestada', 'copyright', 'noexiste']);
  assert.deepEqual(md, { title: 'A001.mp4', project: 'Mi Peli', director: 'Ana', scene: '12', take: '3', comment: 'toma buena', iso: '800', 'Lente prestada': 'sí', copyright: '© 2026' });
  const out = path.join(tmp, 'out', 'A001.mp4');
  await media.transcode(src, out, { preset: 'h264_dailies', height: 360, burnTimecode: true, burnName: true, text: { value: 'COPIA DE TRABAJO: no distribuir', pos: 'top-center', size: 26 }, fps: 25, startTimecode: '10:00:00:00', metadata: md, timecodeOut: '10:00:00:00', duration: 2 });
  const i = await media.probe(out);
  assert.equal(i.height, 360); assert.equal(i.timecode, '10:00:00:00'); assert.equal(i.tags.project, 'Mi Peli'); assert.equal(i.tags.director, 'Ana'); assert.equal(i.tags.scene, '12'); assert.equal(i.tags.comment, 'toma buena');
  assert.equal(i.tags.iso, '800'); assert.equal(i.tags.title, 'A001.mp4');
  assert.deepEqual((await fsp.readdir(path.join(tmp, 'out'))).filter((n) => n.includes('partial')), []);
  assert.equal((await fsp.readdir(os.tmpdir())).filter((n) => /^cine_(txt|name)_.*\.txt$/.test(n) && fs.statSync(path.join(os.tmpdir(), n)).mtimeMs > Date.now() - 60000).length, 0, 'no quedan ficheros de texto temporales');
  const prores = path.join(tmp, 'out', 'A001.mov');
  await media.transcode(src, prores, { preset: 'prores_proxy', metadata: { project: 'Mi Peli' }, timecodeOut: '10:00:00:00', duration: 2 });
  const pi = await media.probe(prores); assert.equal(pi.codec, 'prores'); assert.equal(pi.timecode, '10:00:00:00'); assert.equal(pi.tags.project, 'Mi Peli');
  const jpg = await media.previewFrame(src, { height: 180, burnTimecode: true, burnName: true, text: { value: 'BORRADOR', pos: 'center', size: 18 }, fps: 25, startTimecode: '10:00:00:00', time: 0.5 });
  assert.match(jpg, /^data:image\/jpeg;base64,/); assert.ok(jpg.length > 3000);
  const plain = await media.previewFrame(src, { height: 180, time: 0.5 });
  assert.notEqual(jpg, plain, 'los textos quemados cambian la imagen');
});

test('informes: titulo propio y columnas elegidas (incluidas las propias)', () => {
  const clips = [{ name: 'A001.mp4', reel: 'R1', verified: 'verified', cam: { iso: '800' }, custom: { 'Lente prestada': 'sí' }, size: 2048, meta: { width: 640, height: 360 } }];
  const html = report.build('clips', { clips, jobs: [], title: 'Lista para producción', columns: ['name', 'iso', 'custom:Lente prestada', 'format', 'columna-inexistente'], projectInfo: { name: 'P' } });
  assert.match(html, /<h1>Lista para producción<\/h1>/); assert.match(html, /<th>Clip<\/th><th>ISO<\/th><th>Lente prestada<\/th><th>Formato<\/th>/);
  assert.match(html, /<td>800<\/td><td>sí<\/td><td>640×360<\/td>/); assert.doesNotMatch(html, /<th>Reel<\/th>/);
  assert.match(report.build('clips', { clips, jobs: [] }), /<th>Esc\/Plano\/Toma<\/th>/, 'sin columnas se usa la tabla estandar');
  assert.match(report.build('volume', { clips, jobs: [], title: 'Mi volumen', dark: true }), /<h1>Mi volumen<\/h1>[\s\S]*|#14161a/);
});
