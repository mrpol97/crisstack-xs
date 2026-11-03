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
const ops = require('../src/main/engine/libops');

let tmp;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const r = spawnSync(media.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]); assert.equal(r.status, 0, String(r.stderr)); };
test.before(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cinestack6-')); });
test.after(async () => { await wait(500); await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); });

async function setup(name) {
  const root = path.join(tmp, name, 'Peli');
  mk(path.join(root, 'Dia1', 'CamA', 'A001.mp4')); mk(path.join(root, 'Dia1', 'CamA', 'A002.mp4')); mk(path.join(root, 'Dia1', 'CamB', 'B001.mp4'));
  const lib = new Library(new Store(path.join(tmp, name + '.json')), path.join(tmp, name + '-thumbs'));
  await lib.importFolder(root); await wait(1800);
  const bin = (n) => Object.values(lib.bins).find((b) => b.name === n);
  const clip = (n) => Object.values(lib.clips).find((c) => c.name === n);
  return { root, lib, bin, clip };
}

test('renombrar una carpeta de la biblioteca renombra la del disco y actualiza las rutas de sus clips', async () => {
  const { root, lib, bin, clip } = await setup('ren');
  assert.equal(ops.binDir(lib, bin('Dia1').id), path.join(root, 'Dia1'));
  const r = await ops.renameBin(lib, bin('Dia1').id, 'Dia_01');
  assert.ok(r.renamed); assert.equal(r.clips, 3);
  assert.ok(fs.existsSync(path.join(root, 'Dia_01', 'CamA', 'A001.mp4'))); assert.ok(!fs.existsSync(path.join(root, 'Dia1')));
  assert.equal(clip('B001.mp4').path, path.join(root, 'Dia_01', 'CamB', 'B001.mp4'));
  assert.equal(ops.binDir(lib, bin('CamA').id), path.join(root, 'Dia_01', 'CamA'), 'las subcarpetas siguen localizadas');
  await assert.rejects(() => ops.renameBin(lib, bin('CamA').id, 'CamB'), /Ya hay una carpeta/);
  await assert.rejects(() => ops.renameBin(lib, bin('CamA').id, 'a/b'), /Nombre no válido/);
  const only = await ops.renameBin(lib, bin('CamB').id, 'CamB_x', { disk: false }); assert.ok(only.renamed);
  assert.ok(fs.existsSync(path.join(root, 'Dia_01', 'CamB')), 'sin reflejar en disco no se toca el disco');
});

test('crear subcarpeta, mover clips (solo dentro del mismo disco), colisiones y renombrar ficheros', async () => {
  const { root, lib, bin, clip } = await setup('mov');
  const nb = await ops.createBin(lib, bin('Dia1').id, 'Dia2');
  assert.ok(fs.statSync(path.join(root, 'Dia1', 'Dia2')).isDirectory()); assert.equal(nb.parent, bin('Dia1').id);
  await assert.rejects(() => ops.createBin(lib, bin('Dia1').id, 'Dia2'), /Ya hay una carpeta/);
  const m = await ops.moveClips(lib, [clip('B001.mp4').id, clip('A001.mp4').id], nb.id);
  assert.equal(m.moved, 2); assert.ok(fs.existsSync(path.join(root, 'Dia1', 'Dia2', 'B001.mp4'))); assert.ok(!fs.existsSync(path.join(root, 'Dia1', 'CamB', 'B001.mp4')));
  assert.equal(clip('A001.mp4').bin, nb.id); assert.equal(clip('A001.mp4').path, path.join(root, 'Dia1', 'Dia2', 'A001.mp4'));
  fs.writeFileSync(path.join(root, 'Dia1', 'CamA', 'B001.mp4'), 'x'); // el destino ya tiene un fichero con ese nombre
  const b2 = await ops.createBin(lib, bin('Dia1').id, 'Otra');
  lib.clips[clip('A002.mp4').id].name = 'B001.mp4'; fs.renameSync(path.join(root, 'Dia1', 'CamA', 'A002.mp4'), path.join(root, 'Dia1', 'CamA', 'B001.mp4.tmp')); // solo para no duplicar
  const col = await ops.moveClips(lib, [clip('B001.mp4').id], nb.id);
  assert.ok(col.skipped.length + col.moved >= 1);
  const rn = await ops.renameClip(lib, clip('A001.mp4').id, 'PLANO_7');
  assert.equal(rn.name, 'PLANO_7.mp4', 'conserva la extension'); assert.ok(fs.existsSync(path.join(root, 'Dia1', 'Dia2', 'PLANO_7.mp4')));
  assert.ok(b2.id);
});

test('eliminar clips y carpetas: a la papelera (recuperable) o solo de la biblioteca', async () => {
  const { root, lib, bin, clip } = await setup('del');
  const trashDir = path.join(tmp, 'trash'); fs.mkdirSync(trashDir, { recursive: true });
  const trashFn = async (p) => fsp.rename(p, path.join(trashDir, path.basename(p)));
  const a = await ops.removeClips(lib, [clip('A001.mp4').id], { trash: false });
  assert.equal(a.removed, 1); assert.ok(fs.existsSync(path.join(root, 'Dia1', 'CamA', 'A001.mp4')), 'solo de la biblioteca: el fichero sigue');
  const b = await ops.removeClips(lib, [clip('A002.mp4').id], { trash: true, trashFn });
  assert.equal(b.trashed, 1); assert.ok(!fs.existsSync(path.join(root, 'Dia1', 'CamA', 'A002.mp4'))); assert.ok(fs.existsSync(path.join(trashDir, 'A002.mp4')));
  const c = await ops.removeBin(lib, bin('CamB').id, { trash: true, trashFn });
  assert.equal(c.clips, 1); assert.ok(!bin('CamB')); assert.ok(fs.existsSync(path.join(trashDir, 'CamB', 'B001.mp4')));
  await assert.rejects(() => ops.removeBin(lib, bin('Peli').id, { trash: false, trashFn }).then(() => ops.removeBin(lib, 'zzz')), /no encontrada/);
});

test('una carpeta logica (Transcodes) no se asocia a una carpeta del disco', async () => {
  const { lib } = await setup('log');
  const out = path.join(tmp, 'log', 'salidas', 'X.mp4'); mk(out);
  const reg = await lib.registerTranscode({ id: 's', name: 'A001.mp4' }, out, 'H.264 dailies'); await wait(1200);
  const tb = Object.values(lib.bins).find((b) => b.name === 'H.264 dailies');
  assert.equal(ops.binDir(lib, tb.id), null);
  await assert.rejects(() => ops.renameBin(lib, tb.id, 'Otro'), /no se corresponde/);
  assert.ok((await ops.renameBin(lib, tb.id, 'Otro', { disk: false })).renamed); assert.ok(reg.id);
});

test('RAW de camara (.braw) y codecs sin decodificador: se registran con su informacion y miniatura generica, y aceptan un proxy', async () => {
  const dir = path.join(tmp, 'raw', 'A001.RDC'); fs.mkdirSync(dir, { recursive: true });
  const braw = path.join(dir, 'A001_C001.braw'); fs.writeFileSync(braw, Buffer.alloc(4096, 7)); // no es un BRAW real: ffprobe no lo entiende
  const m = await media.probe(braw);
  assert.equal(m.decodable, false); assert.equal(m.codec, 'Blackmagic RAW');
  // un MOV valido cuyo codec es desconocido para ffmpeg
  const good = path.join(tmp, 'raw', 'g.mp4'); mk(good); const buf = fs.readFileSync(good); const i = buf.indexOf('avc1'); assert.ok(i > 0);
  buf.write('braw', i, 'latin1'); buf.write('xxxx', buf.indexOf('avcC'), 'latin1'); const fake = path.join(dir, 'A001_C002.mov'); fs.writeFileSync(fake, buf);
  const m2 = await media.probe(fake); assert.equal(m2.decodable, false); assert.match(m2.codecLabel, /Códec no soportado/);
  // proxy junto al original (carpeta Sub, como en Sony) y registro en la biblioteca
  const proxy = path.join(dir, 'Sub', 'A001_C001_proxy.mp4'); mk(proxy);
  assert.equal(await media.findProxy(braw), proxy);
  const lib = new Library(new Store(path.join(tmp, 'raw.json')), path.join(tmp, 'raw-thumbs'));
  await lib.importFolder(path.join(tmp, 'raw', 'A001.RDC')); for (let i = 0; i < 40 && !Object.values(lib.clips).every((x) => x.thumb || x.metaError); i++) await wait(300);
  const c = Object.values(lib.clips).find((x) => x.name === 'A001_C001.braw');
  assert.equal(c.meta.decodable, false); assert.equal(c.proxy, proxy, 'proxy encontrado solo'); assert.ok(c.thumb && fs.existsSync(c.thumb), 'miniatura sacada del proxy ' + JSON.stringify({ t: c.thumb, e: c.metaError, tb: c.meta?.thumbError, p: c.proxy }));
  assert.ok(c.meta.duration > 0 && c.meta.width === 320, 'datos completados desde el proxy');
  const f = Object.values(lib.clips).find((x) => x.name === 'A001_C002.mov'); assert.ok(fs.existsSync(f.thumb), 'miniatura generica para el codec desconocido');
  assert.ok(fs.statSync(f.thumb).size > 500);
  const lone = path.join(tmp, 'raw', 'solo', 'Z.braw'); fs.mkdirSync(path.dirname(lone), { recursive: true }); fs.writeFileSync(lone, Buffer.alloc(100));
  await lib.importFolder(path.join(tmp, 'raw', 'solo')); for (let i = 0; i < 40 && !Object.values(lib.clips).every((x) => x.thumb || x.metaError); i++) await wait(300);
  const z = Object.values(lib.clips).find((x) => x.name === 'Z.braw'); assert.ok(!z.proxy); assert.ok(fs.existsSync(z.thumb));
  await lib.linkProxy(z.id, proxy); assert.equal(z.proxy, proxy); assert.ok(z.meta.width === 320);
  await lib.linkProxy(z.id, null); assert.ok(!z.proxy);
});
