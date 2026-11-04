const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const raw = require('../src/main/engine/rawdec');
const media = require('../src/main/engine/media');
const { Store } = require('../src/main/engine/store');
const { Library } = require('../src/main/engine/library');

const FAKE = path.join(__dirname, 'fixtures', 'fake-raw-helper.js');
const overrides = { braw: { cmd: process.execPath, args: [FAKE] } };
let tmp;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
test.before(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cinestack7-')); });
test.after(async () => { await wait(500); await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); });

test('deteccion de formato: firmas de contenido primero, extension como ultimo recurso y con su certeza', () => {
  const be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const red = Buffer.concat([be(0x200), Buffer.from('RED2'), Buffer.alloc(64)]);
  assert.deepEqual(raw.detectFormat('A001_C001.R3D', red), { id: 'r3d', confidence: 'magic', evidence: 'firma RED2 en la cabecera' });
  const braw = Buffer.concat([be(24), Buffer.from('ftypqt  '), Buffer.alloc(8), Buffer.from('....stsd....braw....')]);
  assert.equal(raw.detectFormat('x.braw', braw).confidence, 'magic'); assert.equal(raw.detectFormat('x.braw', braw).id, 'braw');
  assert.equal(raw.detectFormat('x.braw', Buffer.alloc(100)).confidence, 'extension');
  const prr = Buffer.concat([be(24), Buffer.from('ftypqt  '), Buffer.alloc(8), Buffer.from('....stsd....aprh....')]);
  assert.equal(raw.detectFormat('clip.mov', prr).id, 'proresraw');
  assert.equal(raw.detectFormat('clip.mov', Buffer.alloc(100)).id, null, 'un .mov normal no se confunde con ProRes RAW');
  const crm = Buffer.concat([be(24), Buffer.from('ftypcrx '), Buffer.alloc(8), Buffer.from('CRM')]);
  assert.equal(raw.detectFormat('a.crm', crm).id, 'crm'); assert.equal(raw.detectFormat('a.nev', Buffer.alloc(10)).id, 'nraw'); assert.equal(raw.detectFormat('a.ari', Buffer.alloc(10)).id, 'arriraw');
  assert.equal(raw.detectFormat('a.mxf', Buffer.from('....X-OCN....')).confidence, 'heuristic');
  assert.equal(raw.detectFormat('a.mp4', Buffer.alloc(10)).id, null);
});

test('ajustes: se validan, y lo que el SDK no ofrece se declara en lugar de simularse', () => {
  const caps = { iso: { min: 100, max: 12800 }, kelvin: { min: 2000, max: 15000 }, quality: ['full', 'half'], colorSpaces: ['A'], scale: [1, 2], bitDepths: [16] };
  const n = raw.normalize({ iso: 1600, kelvin: 4300, tint: 5, quality: 'half', colorSpace: 'A', gamma: 'X', scale: 2, bitDepth: 16 }, caps);
  assert.deepEqual(n.send, { iso: 1600, kelvin: 4300, quality: 'half', colorSpace: 'A', scale: 2, bitDepth: 16 }); assert.deepEqual(n.unsupported.sort(), ['gamma', 'tint']);
  assert.throws(() => raw.normalize({ iso: 99999 }, caps), /fuera de rango/); assert.throws(() => raw.normalize({ quality: 'ultra' }, caps), /no admitido/);
  assert.deepEqual(raw.normalize({ iso: '', kelvin: null }, caps).send, {}, 'vacio = como se grabo');
});

test('protocolo con un decodificador de prueba: estado, apertura, metadatos, fotograma con ajustes y vista', async () => {
  const reg = new raw.RawRegistry({ overrides });
  const st = await reg.status(); const by = Object.fromEntries(st.map((s) => [s.id, s]));
  assert.equal(by.braw.state, 'ready'); assert.match(by.braw.reason, /FakeSDK/); assert.equal(by.r3d.state, 'no-helper'); assert.match(by.r3d.reason, /SDK oficial/); assert.equal(st.length, 7);
  const f = path.join(tmp, 'A001.braw'); await fsp.writeFile(f, Buffer.alloc(200));
  const clip = await reg.open(f);
  try {
    const info = clip.info();
    assert.equal(info.width, 64); assert.equal(info.bitDepth, 16); assert.equal(info.camera.model, 'RAW-1'); assert.equal(info.sensor.bayer, 'RGGB'); assert.equal(info.asShot.iso, 800); assert.ok(info.capabilities.iso);
    const a = await clip.frame(3, { iso: 800, kelvin: 5600 }); const b = await clip.frame(3, { iso: 3200, kelvin: 3000, quality: 'half', tint: 10 });
    assert.equal(a.layout, 'rgb48le'); assert.equal(a.data.length, 64 * 36 * 6); assert.equal(a.bitDepth, 16);
    assert.ok(a.data.readUInt16LE(2 * 6) < b.data.readUInt16LE(2 * 6), 'subir el ISO aclara la imagen: el ajuste llega al decodificador');
    assert.deepEqual(b.notApplied, ['quality'], 'lo que el SDK pidió y no aplicó se declara'); assert.deepEqual(b.unsupported, ['tint'], 'lo que el SDK no ofrece se declara');
    const small = await clip.frame(0, { scale: 2 }); assert.equal(small.width, 32);
    const jpg = await raw.frameToJpeg(a); assert.equal(jpg[0], 0xff); assert.equal(jpg[1], 0xd8); assert.ok(jpg.length > 300);
    await assert.rejects(() => clip.frame(0, { iso: 5 }), /fuera de rango/);
  } finally { clip.close(); }
  await assert.rejects(() => reg.open(path.join(tmp, 'corrupt.braw')).then(async () => { await fsp.writeFile(path.join(tmp, 'corrupt.braw'), 'x'); }), /./);
});

test('sin decodificador: error claro y NINGUNA conversion silenciosa', async () => {
  const reg = new raw.RawRegistry({});
  const f = path.join(tmp, 'A002_C001.R3D'); await fsp.writeFile(f, Buffer.concat([Buffer.alloc(4), Buffer.from('RED2'), Buffer.alloc(50)]));
  await assert.rejects(() => reg.open(f), (e) => e.code === 'RAW_UNAVAILABLE' && e.state === 'no-helper' && /No se convierte a otro formato/.test(e.message) && /R3D SDK/.test(e.message));
  await assert.rejects(() => reg.open(path.join(tmp, 'x.txt')), (e) => e.state === 'unknown-format');
  const broken = new raw.RawRegistry({ overrides: { braw: { cmd: process.execPath, args: ['-e', 'process.exit(3)'] } } });
  assert.equal((await broken.status()).find((s) => s.id === 'braw').state, 'helper-error');
});

test('biblioteca: con decodificador nativo el clip RAW sale con su informacion y miniatura reales, sin él queda marcado y sin conversion', async () => {
  const dir = path.join(tmp, 'lib'); await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'A001_C001.braw'), Buffer.alloc(4096, 9));
  const withDec = new Library(new Store(path.join(tmp, 'l1.json')), path.join(tmp, 'th1')); withDec.raw = new raw.RawRegistry({ overrides });
  await withDec.importFolder(dir); for (let i = 0; i < 40 && !Object.values(withDec.clips).every((c) => c.thumb || c.metaError); i++) await wait(300);
  const a = Object.values(withDec.clips)[0];
  assert.equal(a.meta.rawFormat, 'braw'); assert.equal(a.meta.rawNative, true); assert.equal(a.meta.width, 64); assert.equal(a.meta.camera.model, 'RAW-1'); assert.equal(a.meta.rawSensor.bayer, 'RGGB'); assert.equal(a.meta.bitDepth, 16);
  assert.ok(fs.existsSync(a.thumb) && fs.statSync(a.thumb).size > 300);
  const without = new Library(new Store(path.join(tmp, 'l2.json')), path.join(tmp, 'th2')); without.raw = new raw.RawRegistry({});
  await without.importFolder(dir); for (let i = 0; i < 40 && !Object.values(without.clips).every((c) => c.thumb || c.metaError); i++) await wait(300);
  const b = Object.values(without.clips)[0];
  assert.equal(b.meta.rawFormat, 'braw'); assert.ok(!b.meta.rawNative); assert.equal(b.meta.decodable, false); assert.match(b.meta.codecLabel, /Blackmagic RAW/); assert.ok(!b.proxy);
});
