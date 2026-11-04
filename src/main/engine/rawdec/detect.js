// Deteccion automatica del formato RAW de un fichero: firmas de contenido cuando se conocen y, si no, extension.
// Cada resultado dice con que certeza se ha identificado (magic > heuristic > extension) para no presentar una suposicion como un hecho.
// Las firmas estan por validar con ficheros reales de cada camara: se comprueban primero y la extension queda como ultimo recurso.
const fs = require('node:fs');
const path = require('node:path');
const { FORMATS } = require('./formats');

const HEAD = 4 * 1024 * 1024; // la mayoria de las firmas (atomos moov/stsd) estan al principio; se leen los primeros 4 MB

function readHead(file, n = HEAD) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(n); const got = fs.readSync(fd, buf, 0, n, 0); return buf.subarray(0, got); } finally { fs.closeSync(fd); }
}
const has = (buf, s) => buf.indexOf(s, 0, 'latin1') >= 0;

/** Devuelve { id, confidence: 'magic'|'heuristic'|'extension', evidence } o { id: null }. */
function detectFormat(file, head) {
  const ext = path.extname(file).toLowerCase();
  let buf = head; if (!buf) { try { buf = readHead(file); } catch { buf = Buffer.alloc(0); } }
  const ftyp = buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp' ? buf.toString('latin1', 8, 12) : null;

  // RED: tras el tamano del primer bloque aparece «RED1» o «RED2»
  if (buf.length > 8 && /^RED[12]$/.test(buf.toString('latin1', 4, 8))) return { id: 'r3d', confidence: 'magic', evidence: `firma ${buf.toString('latin1', 4, 8)} en la cabecera` };
  // Canon: contenedor ISO-BMFF con marca «crx »
  if (ftyp === 'crx ' && (ext === '.crm' || has(buf, 'CRM'))) return { id: 'crm', confidence: 'magic', evidence: 'marca ftyp «crx »' };
  // ProRes RAW: entrada de muestra «aprn» (RAW) o «aprh» (RAW HQ) en un MOV
  if (['.mov', '.mp4'].includes(ext) && (has(buf, 'aprn') || has(buf, 'aprh')) && has(buf, 'stsd')) return { id: 'proresraw', confidence: 'magic', evidence: 'entrada de muestra aprn/aprh' };
  // Blackmagic RAW: entrada de muestra «braw» en un contenedor QuickTime
  if (ext === '.braw' && has(buf, 'braw')) return { id: 'braw', confidence: 'magic', evidence: 'entrada de muestra «braw»' };
  // Sony X-OCN: etiqueta en la cabecera MXF (heuristica: por validar con ficheros reales)
  if (ext === '.mxf' && /X-?OCN/i.test(buf.toString('latin1'))) return { id: 'xocn', confidence: 'heuristic', evidence: 'texto «X-OCN» en la cabecera MXF' };
  // Por extension (ultimo recurso)
  for (const f of Object.values(FORMATS)) if (f.id !== 'xocn' && f.id !== 'proresraw' && f.extensions.includes(ext)) return { id: f.id, confidence: 'extension', evidence: `extensión ${ext}` };
  return { id: null, confidence: null, evidence: null };
}

module.exports = { detectFormat, readHead };
