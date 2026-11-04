// Registro de decodificadores RAW: un helper por fabricante, deteccion automatica del formato y estado honesto de cada uno.
// Regla de diseno: si no hay decodificador nativo disponible se dice (RawUnavailableError) y se explica por que; NUNCA se sustituye
// en silencio por una conversion con perdida (p. ej. un proxy H.264). Los proxies solo se usan si el usuario los vincula a mano y la
// interfaz los marca como proxy.
const fs = require('node:fs');
const path = require('node:path');
const { FORMATS } = require('./formats');
const { detectFormat } = require('./detect');
const { normalize } = require('./settings');
const { HelperClient } = require('./helper');

const BYTES = { rgb48le: 6, rgba64le: 8, rgb24: 3, rgbaf16le: 8 };

class RawUnavailableError extends Error {
  constructor(format, state, reason) {
    super(`${format ? FORMATS[format].name : 'Formato RAW'}: ${reason}`);
    this.code = 'RAW_UNAVAILABLE'; this.format = format; this.state = state; this.reason = reason;
  }
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

class RawClip {
  constructor(format, detection, client, hello, clip) { this.format = format; this.detection = detection; this.client = client; this.hello = hello; this.clip = clip; }
  info() { return { format: this.format, detection: this.detection, helper: this.hello.helper, sdk: this.hello.sdk, gpu: this.hello.gpu || [], capabilities: this.hello.capabilities || {}, ...this.clip }; }
  /** Decodifica un fotograma con los ajustes pedidos. Devuelve los datos tal cual los entrega el SDK y que ajustes no se pudieron aplicar. */
  async frame(index, settings = {}) {
    const { send, unsupported } = normalize(settings, this.hello.capabilities || {});
    const r = await this.client.request('frame', { index, settings: send });
    const bpp = BYTES[r.layout]; if (!bpp) throw new Error(`Disposición de píxeles no soportada: ${r.layout}`);
    if (r.data.length !== r.width * r.height * bpp) throw new Error(`El decodificador devolvió ${r.data.length} bytes y se esperaban ${r.width * r.height * bpp}`);
    const applied = r.settingsApplied || {};
    return { width: r.width, height: r.height, layout: r.layout, bitDepth: r.bitDepth, data: r.data, gpuUsed: r.gpuUsed || 'desconocida', settingsApplied: applied,
      unsupported, notApplied: Object.keys(send).filter((k) => applied[k] === undefined || applied[k] !== send[k]) };
  }
  close() { this.client.close(); }
}

class RawRegistry {
  /** dirs: carpetas donde buscar crisstack-raw-<fabricante>; overrides: {fabricante: {cmd, args}} (pruebas); env: variables CRISSTACK_RAW_HELPER_<FABRICANTE>. */
  constructor({ dirs = [], env = process.env, overrides = {} } = {}) { this.dirs = dirs; this.env = env; this.overrides = overrides; this.hellos = new Map(); }

  locate(key) {
    if (this.overrides[key]) return this.overrides[key];
    const fromEnv = this.env[`CRISSTACK_RAW_HELPER_${key.toUpperCase()}`]; if (fromEnv && isFile(fromEnv)) return { cmd: fromEnv, args: [] };
    for (const d of this.dirs) for (const n of [`crisstack-raw-${key}`, `crisstack-raw-${key}.exe`]) { const p = path.join(d, n); if (isFile(p)) return { cmd: p, args: [] }; }
    return null;
  }

  async hello(key) {
    if (this.hellos.has(key)) return this.hellos.get(key);
    const loc = this.locate(key); if (!loc) return null;
    const c = new HelperClient(loc.cmd, loc.args, { timeout: 15000 });
    try {
      const h = await c.request('hello'); delete h.data;
      if (h.protocol !== 1) throw new Error(`protocolo ${h.protocol} no soportado (se esperaba 1)`);
      const out = { ...h, path: loc.cmd }; this.hellos.set(key, out); return out;
    } finally { c.close(); }
  }

  /** Estado de cada formato: ready | no-helper | helper-error. */
  async status() {
    const out = [];
    for (const f of Object.values(FORMATS)) {
      const base = { id: f.id, name: f.name, vendor: f.vendor, extensions: f.extensions, sdk: f.sdk, helperName: `crisstack-raw-${f.helper}` };
      let state, reason, helper = null;
      try {
        const h = await this.hello(f.helper);
        if (!h) { state = 'no-helper'; reason = `No hay decodificador instalado (${base.helperName}). Hace falta compilarlo con el SDK oficial (${f.sdk.name}) y copiarlo a la carpeta de decodificadores.`; }
        else if (!h.formats?.includes(f.id)) { state = 'helper-error'; reason = `El decodificador instalado no declara soporte para ${f.name}.`; helper = h; }
        else { state = 'ready'; reason = `${h.sdk?.name || 'SDK'} ${h.sdk?.version || ''}`.trim(); helper = h; }
      } catch (e) { state = 'helper-error'; reason = e.message; }
      out.push({ ...base, state, reason, helper });
    }
    return out;
  }

  detect(file) { return detectFormat(file); }

  async open(file, { format } = {}) {
    const det = format ? { id: format, confidence: 'forzado', evidence: 'indicado por el usuario' } : detectFormat(file);
    if (!det.id) throw new RawUnavailableError(null, 'unknown-format', 'no se reconoce el formato RAW de este fichero');
    const f = FORMATS[det.id];
    let h; try { h = await this.hello(f.helper); } catch (e) { throw new RawUnavailableError(det.id, 'helper-error', e.message); }
    if (!h) throw new RawUnavailableError(det.id, 'no-helper', `no hay decodificador nativo instalado (crisstack-raw-${f.helper}). No se convierte a otro formato en su lugar. SDK necesario: ${f.sdk.name}.`);
    if (!h.formats?.includes(det.id)) throw new RawUnavailableError(det.id, 'helper-error', 'el decodificador instalado no declara soporte para este formato');
    const loc = this.locate(f.helper); const client = new HelperClient(loc.cmd, loc.args);
    try { const r = await client.request('open', { path: file }); return new RawClip(det.id, det, client, h, r.clip || {}); }
    catch (e) { client.close(); throw e; }
  }
}

module.exports = { RawRegistry, RawUnavailableError, RawClip };
