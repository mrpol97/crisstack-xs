const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const media = require('../src/main/engine/media');
const color = require('../src/main/engine/color');
const audio = require('../src/main/engine/audio');
const exportsM = require('../src/main/engine/exports');
const importer = require('../src/main/engine/importer');
const ascmhl = require('../src/main/engine/ascmhl');
const s3 = require('../src/main/engine/s3');
const tools = require('../src/main/engine/tools');
const { runOffload } = require('../src/main/engine/offload');

let tmp;
test.before(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cinestack2-')); });
test.after(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });
const ff = (args) => { const r = spawnSync(media.FFMPEG, ['-v', 'error', '-y', ...args]); assert.equal(r.status, 0, String(r.stderr)); };
const firstPixel = (file) => { const r = spawnSync(media.FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']); return [...r.stdout.subarray(0, 3)]; };

test('CDL: identidad, matematicas y .cube/.ccc ida y vuelta', () => {
  assert.deepEqual(color.applyCdl([0.2, 0.5, 0.8], color.IDENTITY()).map((v) => +v.toFixed(6)), [0.2, 0.5, 0.8]);
  const out = color.applyCdl([0.5, 0.5, 0.5], { slope: [2, 2, 2], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 });
  assert.deepEqual(out, [1, 1, 1]);
  const gray = color.applyCdl([0.8, 0.4, 0.2], { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 0 });
  assert.ok(Math.abs(gray[0] - gray[1]) < 1e-9 && Math.abs(gray[1] - gray[2]) < 1e-9, 'sat 0 = escala de grises');
  const cube = color.parseCube(color.cdlToCube({ slope: [1.1, 1, 0.9], offset: [0.01, 0, 0], power: [1, 1.2, 1], sat: 1.1 }, 9));
  assert.equal(cube.size, 9); assert.equal(cube.data.length, 9 ** 3 * 3);
  const xml = color.writeCcc([{ id: 'A001', cdl: { slope: [1.1, 1, 0.9], offset: [0.01, 0, 0], power: [1, 1.2, 1], sat: 0.8 } }]);
  const back = color.parseCdlXml(xml);
  assert.equal(back[0].id, 'A001'); assert.deepEqual(back[0].cdl.slope, [1.1, 1, 0.9]); assert.equal(back[0].cdl.sat, 0.8);
});

test('transcode aplica CDL y recorte/giro con ffmpeg real', async () => {
  const src = path.join(tmp, 'gray.mov');
  ff(['-f', 'lavfi', '-i', 'color=c=0x808080:s=320x180:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', src]);
  const before = firstPixel(src);
  const luts = await color.buildFfmpegLooks({ cdl: { slope: [0.5, 0.5, 0.5], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 } }, path.join(tmp, 'cubes'));
  assert.equal(luts.length, 1);
  const out = path.join(tmp, 'graded.mov');
  await media.transcode(src, out, { preset: 'h264_dailies', luts, duration: 1 });
  const after = firstPixel(out);
  assert.ok(before[0] > 120 && before[0] < 136, `antes ${before}`);
  assert.ok(after[0] > 56 && after[0] < 76, `despues ${after} (esperado ~64)`);
  const rot = path.join(tmp, 'rot.mp4');
  await media.transcode(src, rot, { preset: 'h264_dailies', rotate: 90, crop: { x: 0, y: 0, w: 0.5, h: 1 }, duration: 1 });
  const info = await media.probe(rot);
  assert.equal(info.width % 2, 0); assert.ok(info.height > info.width / 2 - 2, `${info.width}x${info.height}`);
  const still = await media.exportStill(src, path.join(tmp, 'still.png'), { preset: 'png', time: 0 });
  assert.ok(fs.statSync(still).size > 100);
});

function burstWav(file, shiftSec, seconds = 20) {
  const sr = 8000, n = sr * seconds, buf = Buffer.alloc(44 + n * 2); let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const samples = new Float32Array(n); let t = 0;
  while (t < n - 800) { const len = Math.floor(rnd() * 600 + 100); const gap = Math.floor(rnd() * 1500 + 300); const f = 200 + rnd() * 800; for (let i = 0; i < len && t + i < n; i++) samples[t + i] = Math.sin(i * f * 2 * Math.PI / sr) * 0.8; t += len + gap; }
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  const sh = Math.round(shiftSec * sr);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round((samples[i - sh] || 0) * 32000), 44 + i * 2);
  return fs.writeFileSync(file, buf);
}

test('sync de audio: por forma de onda (retardo 1.5 s) y por timecode BWF', async () => {
  const scratch = path.join(tmp, 'scratch.wav'), ext = path.join(tmp, 'ext.wav'), vid = path.join(tmp, 'cam.mov');
  burstWav(scratch, 0); burstWav(ext, 1.5);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=20', '-i', scratch, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', vid]);
  const m = await audio.matchByWaveform(vid, ext, 10);
  assert.ok(Math.abs(m.offset - 1.5) < 0.05, `offset ${m.offset}`);
  assert.ok(m.confidence > 0.3, `confianza ${m.confidence}`);
  const synced = await audio.renderSynced(vid, ext, m.offset, path.join(tmp, 'synced.mov'));
  const si = await media.probe(synced);
  assert.equal(si.codec, 'h264'); assert.ok(si.audioTracks >= 1);

  // timecode: video 10:00:00:00 @24, audio BWF empieza 1 s antes
  const bwf = path.join(tmp, 'bwf.wav');
  ff(['-i', scratch, '-write_bext', '1', '-metadata', `time_reference=${35999 * 8000}`, bwf]);
  const ai = await audio.probeAudio(bwf);
  assert.ok(ai.startSeconds != null && Math.abs(ai.startSeconds - 35999) < 0.01, `start ${ai.startSeconds}`);
  const hits = audio.matchByTimecode([{ id: 'c1', meta: { timecode: '10:00:00:00', fps: 24, duration: 5 } }], [ai]);
  assert.equal(hits.length, 1); assert.ok(Math.abs(hits[0].offset - 1) < 0.01);
});

test('exportaciones ALE / FCP7 / FCPXML / CCC', () => {
  const clips = [{ id: '1', kind: 'video', name: 'A001C001.mov', path: 'C:/m/A001C001.mov', reel: 'A001', scene: '12', take: '3', camera: 'A', notes: 'ok\ttab', flag: 'good',
    meta: { timecode: '01:00:00:00', fps: 24, duration: 10, width: 1920, height: 1080, audioTracks: 2 }, look: { cdl: { slope: [1, 1, 1.1], offset: [0, 0, 0], power: [1, 1, 1], sat: 0.9 } } }];
  const ale = exportsM.toAle(clips, 24);
  assert.match(ale, /^Heading\nFIELD_DELIM\tTABS/); assert.match(ale, /A001C001\t+VA1A2\t01:00:00:00\t01:00:10:00\t00:00:10:00/); assert.match(ale, /\(1 1 1.1\)/);
  assert.match(exportsM.toFcp7Xml(clips, 'Test', 24), /<xmeml version="4">[\s\S]*<timebase>24<\/timebase>[\s\S]*<string>01:00:00:00<\/string>/);
  assert.match(exportsM.toFcpxml(clips, 'Test', 24), /<asset-clip ref="a1" name="A001C001.mov" offset="0\/24s" start="86400\/24s" duration="240\/24s"/);
  assert.match(exportsM.toCcc(clips), /<Slope>1 1 1.1<\/Slope>/);
  assert.equal(exportsM.framesToTc(exportsM.tcToFrames('02:03:04:05', 24), 24), '02:03:04:05');
});

test('importacion CSV/ALE y emparejado de metadatos', () => {
  const csv = 'Clip;Escena;Plano;Toma;Notas;Lente\nA001C001;12;B;3;"buena; con coma";35mm\nZZZ;1;1;1;x;y\n';
  const { columns, rows } = importer.parseCsv(csv);
  assert.deepEqual(columns, ['Clip', 'Escena', 'Plano', 'Toma', 'Notas', 'Lente']);
  assert.equal(rows[0].Notas, 'buena; con coma');
  const mapping = { ...importer.suggestMapping(columns), Lente: 'Lente' };
  assert.equal(mapping.Escena, 'scene'); assert.equal(mapping.Notas, 'notes');
  const r = importer.applyRows([{ id: 'c1', name: 'A001C001.mov' }], rows, { match: 'name', keyColumn: 'Clip', mapping });
  assert.equal(r.updates.length, 1); assert.equal(r.updates[0].patch.scene, '12'); assert.equal(r.updates[0].patch.custom.Lente, '35mm'); assert.deepEqual(r.unmatched, ['ZZZ']);
  const ale = importer.parseAle('Heading\nFIELD_DELIM\tTABS\n\nColumn\nName\tScene\tTake\n\nData\nA001C002\t5\t2\n');
  assert.equal(ale.rows[0].Scene, '5');
});

test('ASC MHL: generaciones, verificacion, manipulacion y cadena', async () => {
  const root = path.join(tmp, 'SEAL'); await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(root, 'a.bin'), crypto.randomBytes(5000)); await fsp.writeFile(path.join(root, 'sub', 'b.bin'), crypto.randomBytes(777));
  const g1 = await ascmhl.seal(root, { algos: ['xxh64', 'md5'] });
  assert.equal(g1.ok, true); assert.equal(g1.generation, 1); assert.equal(g1.new, 2);
  assert.ok((await ascmhl.verify(root)).ok);
  await fsp.writeFile(path.join(root, 'c.bin'), 'nuevo');
  const v = await ascmhl.verify(root); assert.equal(v.ok, false); assert.ok(v.results.some((r) => r.status === 'NEW'));
  const g2 = await ascmhl.seal(root, { algos: ['xxh64', 'md5'] });
  assert.equal(g2.generation, 2); assert.equal(g2.new, 1);
  const xml = await fsp.readFile(g2.file, 'utf8'); assert.match(xml, /action="verified"/); assert.match(xml, /action="original"/);
  assert.match(await fsp.readFile(path.join(root, 'ascmhl', 'ascmhl_chain.xml'), 'utf8'), /c4[1-9A-Za-z]{88}/);
  assert.ok((await ascmhl.verify(root)).ok);
  // corrupcion: seal se niega a crear generacion y verify lo detecta
  const fd = await fsp.open(path.join(root, 'a.bin'), 'r+'); await fd.write(Buffer.from([1, 2, 3]), 0, 3, 10); await fd.close();
  const g3 = await ascmhl.seal(root, { algos: ['xxh64', 'md5'] }); assert.equal(g3.ok, false); assert.equal(g3.mismatches[0].rel, 'a.bin');
  assert.equal((await ascmhl.verify(root)).results.find((r) => r.rel === 'a.bin').status, 'MISMATCH');
  // manipulacion de una generacion anterior: rompe la cadena
  const first = (await fsp.readdir(path.join(root, 'ascmhl'))).find((f) => f.startsWith('0001_'));
  await fsp.appendFile(path.join(root, 'ascmhl', first), '<!-- editado -->');
  const v2 = await ascmhl.verify(root); assert.equal(v2.chainOk, false); assert.deepEqual(v2.chainBad, [first]);
});

test('S3: firma SigV4 con el vector oficial de AWS y subida a servidor local', async () => {
  const r = s3.signRequest({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', region: 'us-east-1', accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', now: new Date('2013-05-24T00:00:00Z') });
  assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');

  const file = path.join(tmp, 'up.bin'); const data = crypto.randomBytes(300000); await fsp.writeFile(file, data);
  let got = null;
  const srv = http.createServer((req, res) => { const b = []; req.on('data', (d) => b.push(d)); req.on('end', () => { got = { url: req.url, auth: req.headers.authorization, hash: req.headers['x-amz-content-sha256'], body: Buffer.concat(b) }; res.setHeader('etag', '"abc"'); res.end(); }); });
  await new Promise((rs) => srv.listen(0, '127.0.0.1', rs));
  const prog = [];
  const out = await s3.uploadFile({ endpoint: `http://127.0.0.1:${srv.address().port}`, region: 'eu-west-1', bucket: 'mi-bucket', key: 'dailies/A 001.bin', accessKey: 'AK', secretKey: 'SK', file, onProgress: (p) => prog.push(p) });
  srv.close();
  assert.equal(out.status, 200); assert.equal(got.url, '/mi-bucket/dailies/A%20001.bin');
  assert.match(got.auth, /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/eu-west-1\/s3\/aws4_request, SignedHeaders=.*content-length.*host.*x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(got.hash, crypto.createHash('sha256').update(data).digest('hex')); assert.ok(got.body.equals(data)); assert.equal(prog.at(-1), 1);
});

test('secuencias, renombrado, relink, Slack, still y clip combinado', async () => {
  const { sequences, singles } = tools.detectSequences(['sh/A.0001.dpx', 'sh/A.0002.dpx', 'sh/A.0004.dpx', 'x.mov']);
  assert.equal(sequences.length, 1); assert.equal(sequences[0].pattern, 'sh/A.####.dpx'); assert.deepEqual(sequences[0].gaps, [3]); assert.deepEqual(singles, ['x.mov']);
  const ren = tools.makeRenamer('{project}_{reel}_{counter:3}', { project: 'Peli', reel: 'A001' });
  assert.equal(ren('dir/C001.mov'), path.join('dir', 'Peli_A001_001.mov')); assert.equal(ren('C002.mov'), 'Peli_A001_002.mov');

  // renombrado real durante el offload
  const card = path.join(tmp, 'RCARD'); await fsp.mkdir(card); await fsp.writeFile(path.join(card, 'C001.mov'), 'datos1'); await fsp.writeFile(path.join(card, 'C002.mov'), 'datos22');
  const job = await runOffload({ sources: [card], destinations: [path.join(tmp, 'RDEST')], rename: tools.makeRenamer('X_{counter:2}'), algos: ['xxh64'] });
  assert.ok(job.ok); assert.deepEqual(job.files.map((f) => path.basename(f.rel)), ['X_01.mov', 'X_02.mov']);

  // relink: movemos el fichero y lo encontramos por nombre+tamano (y hash si hay duplicados)
  const moved = path.join(tmp, 'MOVED'); await fsp.mkdir(moved); await fsp.mkdir(path.join(moved, 'otro'));
  await fsp.writeFile(path.join(moved, 'X_01.mov'), 'datos1'); await fsp.writeFile(path.join(moved, 'otro', 'X_01.mov'), 'datos1');
  const clip = { id: 'k', name: 'X_01.mov', size: 6, path: path.join(tmp, 'perdido', 'X_01.mov'), hashes: job.files[0].hashes };
  const rl = await tools.relink([clip], [moved]); assert.equal(rl.relinked.length, 1); assert.equal(rl.relinked[0].ambiguous, true); assert.ok(rl.relinked[0].to.startsWith(moved));

  let hook = null; const srv = http.createServer((q, s) => { const b = []; q.on('data', (d) => b.push(d)); q.on('end', () => { hook = JSON.parse(Buffer.concat(b)); s.end('ok'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  await tools.notifySlack(`http://127.0.0.1:${srv.address().port}/hook`, { ok: true, reel: 'A001', fileCount: 3, totalBytes: 2e9, failures: 0 }); srv.close();
  assert.match(hook.text, /Offload A001 .* 3 ficheros, 2.00 GB, verificado/);

  const a = path.join(tmp, 'ca.mp4'), b = path.join(tmp, 'cb.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', a]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', b]);
  const comb = await media.combineClips([a, b], path.join(tmp, 'comb.mp4'), { preset: 'h264_dailies' });
  assert.ok(Math.abs((await media.probe(comb)).duration - 2) < 0.2);
});
