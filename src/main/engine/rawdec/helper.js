// Cliente del protocolo de «helpers»: cada fabricante se decodifica en un ejecutable aparte (crisstack-raw-<fabricante>) que enlaza el SDK
// oficial. Asi las librerias del fabricante nunca van mezcladas con el codigo de la app (cada SDK tiene su licencia), un fallo del SDK no
// tumba la aplicacion y cada helper se puede compilar, firmar y actualizar por separado.
//
// Protocolo v1 (por stdin/stdout): cada mensaje es [4 bytes big-endian = longitud de la cabecera][cabecera JSON][payload binario]
// La cabecera lleva `payload` (bytes del bloque binario que sigue, 0 si no hay). Peticiones: {id, op, ...}; respuestas: {id, ok, ...} o {id, ok:false, error}.
//   hello  -> {protocol:1, helper, sdk:{name,version}, formats:[ids], gpu:[...], capabilities:{iso:{min,max}, kelvin:{min,max}, tint:{min,max},
//              colorSpaces:[], gammas:[], quality:[], scale:[], bitDepths:[], gpu:[]}}
//   open   {path} -> {clip:{width,height,frames,fps,timecode,bitDepth,sensor:{}, camera:{}, asShot:{iso,kelvin,tint,colorSpace,gamma}}}
//   frame  {index, settings} -> {width,height,layout:'rgb48le'|'rgba64le'|'rgb24'|'rgbaf16le', bitDepth, settingsApplied:{}, gpuUsed, payload:N}
//   close  {}
const { spawn } = require('node:child_process');

class HelperError extends Error { constructor(msg, code = 'RAW_HELPER') { super(msg); this.code = code; } }

class HelperClient {
  constructor(cmd, args = [], { timeout = 60000 } = {}) {
    this.cmd = cmd; this.args = args; this.timeout = timeout; this.seq = 0; this.pending = new Map(); this.buf = Buffer.alloc(0); this.closed = false;
    this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.stderr = '';
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000); });
    this.proc.stdout.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    this.proc.on('error', (e) => this.fail(new HelperError(`No se pudo ejecutar el decodificador (${e.code || e.message}): ${cmd}`)));
    this.proc.on('close', (code) => this.fail(new HelperError(`El decodificador terminó (código ${code}). ${this.stderr.trim().split('\n').slice(-2).join(' | ')}`.trim())));
  }
  fail(err) { this.closed = true; for (const p of this.pending.values()) { clearTimeout(p.t); p.reject(err); } this.pending.clear(); }
  drain() {
    for (;;) {
      if (this.buf.length < 4) return;
      const hl = this.buf.readUInt32BE(0); if (this.buf.length < 4 + hl) return;
      let head; try { head = JSON.parse(this.buf.toString('utf8', 4, 4 + hl)); } catch { return this.fail(new HelperError('Respuesta del decodificador ilegible')); }
      const total = 4 + hl + (head.payload || 0); if (this.buf.length < total) return;
      const payload = this.buf.subarray(4 + hl, total); this.buf = this.buf.subarray(total);
      const p = this.pending.get(head.id); if (!p) continue; this.pending.delete(head.id); clearTimeout(p.t);
      if (head.ok === false) p.reject(new HelperError(head.error || 'Error del decodificador')); else p.resolve({ ...head, data: payload });
    }
  }
  request(op, args = {}) {
    if (this.closed) return Promise.reject(new HelperError('El decodificador ya no está en marcha'));
    const id = ++this.seq; const head = Buffer.from(JSON.stringify({ id, op, ...args }), 'utf8'); const len = Buffer.alloc(4); len.writeUInt32BE(head.length);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new HelperError(`El decodificador no responde (${op})`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, t });
      this.proc.stdin.write(Buffer.concat([len, head]), (e) => { if (e) { clearTimeout(t); this.pending.delete(id); reject(new HelperError('No se pudo hablar con el decodificador')); } });
    });
  }
  close() { if (this.closed) return; try { this.proc.stdin.end(); } catch { /* ya cerrado */ } setTimeout(() => this.proc.kill(), 500).unref(); }
}

module.exports = { HelperClient, HelperError };
