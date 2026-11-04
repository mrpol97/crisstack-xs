// Decodificador RAW de PRUEBA que habla el protocolo v1 (ver src/main/engine/rawdec/helper.js). No decodifica nada real:
// genera fotogramas sinteticos de 16 bits que dependen de los ajustes, para probar el registro, el protocolo y la interfaz sin SDK.
let buf = Buffer.alloc(0);
const send = (head, payload = Buffer.alloc(0)) => { const h = Buffer.from(JSON.stringify({ ...head, payload: payload.length }), 'utf8'); const l = Buffer.alloc(4); l.writeUInt32BE(h.length); process.stdout.write(Buffer.concat([l, h, payload])); };
const CAPS = { iso: { min: 100, max: 12800 }, kelvin: { min: 2000, max: 15000 }, colorSpaces: ['Film Gen5', 'Rec.709'], gammas: ['Log', 'Rec.709'], quality: ['full', 'half'], scale: [1, 2], bitDepths: [16], gpu: ['cpu', 'metal'] };
let clipPath = null;

function handle(req) {
  const { id, op } = req;
  try {
    if (op === 'hello') return send({ id, ok: true, protocol: 1, helper: 'crisstack-raw-braw (prueba)', sdk: { name: 'FakeSDK', version: '0.0-test' }, formats: ['braw'], gpu: ['cpu', 'metal'], capabilities: CAPS });
    if (op === 'open') {
      if (/corrupt/i.test(req.path)) return send({ id, ok: false, error: 'Fichero BRAW corrupto' });
      clipPath = req.path;
      return send({ id, ok: true, clip: { width: 64, height: 36, frames: 24, fps: 24, bitDepth: 16, timecode: '01:00:00:00', duration: 1, camera: { make: 'Fake', model: 'RAW-1', lens: '35mm' }, sensor: { name: 'FakeSensor', bayer: 'RGGB', width: 4096, height: 2304 }, asShot: { iso: 800, kelvin: 5600, tint: 0, colorSpace: 'Film Gen5', gamma: 'Log' } } });
    }
    if (op === 'frame') {
      const s = req.settings || {}; const scale = s.scale || 1; const w = 64 / scale, h = 36 / scale; const iso = s.iso || 800, k = s.kelvin || 5600;
      const data = Buffer.alloc(w * h * 6);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 6; const gain = iso / 800;
        data.writeUInt16LE(Math.min(65535, Math.round((x / (w - 1)) * 65535 * gain)), o);
        data.writeUInt16LE(Math.round((y / (h - 1)) * 65535), o + 2);
        data.writeUInt16LE(Math.min(65535, Math.round(((k - 2000) / 13000) * 65535)), o + 4);
      }
      const applied = { ...s }; delete applied.quality; // simula un SDK que no aplica la calidad pedida
      return send({ id, ok: true, width: w, height: h, layout: 'rgb48le', bitDepth: 16, settingsApplied: applied, gpuUsed: 'cpu', index: req.index }, data);
    }
    if (op === 'close') return send({ id, ok: true });
    send({ id, ok: false, error: `operación desconocida: ${op}` });
  } catch (e) { send({ id, ok: false, error: e.message }); }
}

process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (buf.length < 4) return; const hl = buf.readUInt32BE(0); if (buf.length < 4 + hl) return;
    const req = JSON.parse(buf.toString('utf8', 4, 4 + hl)); buf = buf.subarray(4 + hl); handle(req);
  }
});
process.stdin.on('end', () => process.exit(0));
