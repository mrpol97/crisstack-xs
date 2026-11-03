// Color: ASC CDL, LUT 3D (.cube), conversion CDL -> .cube y lectura/escritura de .cdl/.cc/.ccc.
const fsp = require('node:fs/promises');
const path = require('node:path');

const IDENTITY = () => ({ slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 });
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Aplica ASC CDL a un pixel RGB (0..1), con saturacion Rec.709. */
function applyCdl(rgb, cdl) {
  const o = rgb.map((v, i) => {
    const x = clamp01(v * cdl.slope[i] + cdl.offset[i]);
    return Math.pow(x, cdl.power[i]);
  });
  const luma = 0.2126 * o[0] + 0.7152 * o[1] + 0.0722 * o[2];
  return o.map((v) => clamp01(luma + (v - luma) * cdl.sat));
}

const isIdentity = (c) => !c || (c.sat === 1 && [0, 1, 2].every((i) => c.slope[i] === 1 && c.offset[i] === 0 && c.power[i] === 1));

/** Genera un .cube 3D (orden R mas rapido) con el CDL aplicado. */
function cdlToCube(cdl, size = 33, title = 'Cinestack CDL') {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const o = applyCdl([r / (size - 1), g / (size - 1), b / (size - 1)], cdl);
    lines.push(o.map((v) => v.toFixed(6)).join(' '));
  }
  return lines.join('\n') + '\n';
}

function parseCube(text) {
  let size = 0, size1 = 0; const data = []; let dmin = [0, 0, 0], dmax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    if (l.startsWith('LUT_3D_SIZE')) size = Number(l.split(/\s+/)[1]);
    else if (l.startsWith('LUT_1D_SIZE')) size1 = Number(l.split(/\s+/)[1]);
    else if (l.startsWith('DOMAIN_MIN')) dmin = l.split(/\s+/).slice(1).map(Number);
    else if (l.startsWith('DOMAIN_MAX')) dmax = l.split(/\s+/).slice(1).map(Number);
    else if (/^[-\d.]/.test(l)) data.push(...l.split(/\s+/).map(Number));
  }
  if (!size && size1 > 1 && data.length === size1 * 3) return expand1d(size1, data); // LUT 1D: se convierte a 3D
  if (!size || data.length !== size ** 3 * 3 || data.some((v) => !Number.isFinite(v))) throw new Error('Fichero .cube no válido (se esperaba una LUT 3D o 1D con todos sus valores)');
  return { size, data: Float32Array.from(data), dmin, dmax };
}

/** LUT 1D (una curva por canal) convertida a un cubo 3D de 33 puntos: cada canal sale de su propia curva. */
function expand1d(n, curve, size = 33) {
  const at = (ch, v) => { const p = Math.min(1, Math.max(0, v)) * (n - 1); const i = Math.min(n - 2, Math.floor(p)); const f = p - i; return curve[i * 3 + ch] * (1 - f) + curve[(i + 1) * 3 + ch] * f; };
  const data = [];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) data.push(at(0, r / (size - 1)), at(1, g / (size - 1)), at(2, b / (size - 1)));
  return { size, data: Float32Array.from(data), dmin: [0, 0, 0], dmax: [1, 1, 1] };
}

/**
 * Devuelve el texto de una LUT lista para ffmpeg y el reproductor, siempre en un formato limpio (ffmpeg no entiende todas las lineas
 * extra que escriben otros programas): las 3D se reescriben tal cual y las 1D se convierten a 3D.
 */
function normalizeCube(text) {
  const c = parseCube(text);
  const converted = !/^\s*LUT_3D_SIZE/m.test(text);
  const lines = [`TITLE "${converted ? 'LUT 1D convertida' : 'LUT'}"`, `LUT_3D_SIZE ${c.size}`, `DOMAIN_MIN ${c.dmin.join(' ')}`, `DOMAIN_MAX ${c.dmax.join(' ')}`];
  for (let i = 0; i < c.data.length; i += 3) lines.push(`${c.data[i].toFixed(6)} ${c.data[i + 1].toFixed(6)} ${c.data[i + 2].toFixed(6)}`);
  return { text: lines.join('\n') + '\n', size: c.size, converted };
}


const f3 = (a) => a.map((v) => +v.toFixed(6)).join(' ');
function cdlToXml(cdl, id = 'look') {
  return `<ColorDecision><ColorCorrection id="${id}"><SOPNode><Slope>${f3(cdl.slope)}</Slope><Offset>${f3(cdl.offset)}</Offset><Power>${f3(cdl.power)}</Power></SOPNode><SATNode><Saturation>${+cdl.sat.toFixed(6)}</Saturation></SATNode></ColorCorrection></ColorDecision>`;
}
/** Un .ccc con varias correcciones: [{id, cdl}] */
function writeCcc(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ColorCorrectionCollection xmlns="urn:ASC:CDL:v1.01">\n${items.map((i) => '  ' + cdlToXml(i.cdl, i.id).replace('<ColorDecision>', '').replace('</ColorDecision>', '')).join('\n')}\n</ColorCorrectionCollection>\n`;
}
function parseCdlXml(xml) {
  const out = [];
  const re = /<ColorCorrection\b([^>]*)>([\s\S]*?)<\/ColorCorrection>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = /id="([^"]*)"/.exec(m[1])?.[1] || `cc${out.length + 1}`;
    const v = (tag) => new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(m[2])?.[1];
    const triple = (tag, d) => (v(tag) ? v(tag).split(/\s+/).map(Number) : d);
    out.push({ id, cdl: { slope: triple('Slope', [1, 1, 1]), offset: triple('Offset', [0, 0, 0]), power: triple('Power', [1, 1, 1]), sat: v('Saturation') ? Number(v('Saturation')) : 1 } });
  }
  return out;
}

/** Escribe los .cube necesarios para un look y devuelve la cadena de lut3d de ffmpeg (o null). */
async function buildFfmpegLooks(look, tmpDir) {
  // Orden por defecto: LUT de base y, encima, el ajuste fino del clip (CDL). 'cdl-first' lo invierte (ajuste en log y despues LUT).
  const cdlFirst = look?.order === 'cdl-first';
  const luts = [];
  let cdlCube = null;
  if (look?.cdl && !isIdentity(look.cdl)) {
    await fsp.mkdir(tmpDir, { recursive: true });
    cdlCube = path.join(tmpDir, `cdl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.cube`);
    await fsp.writeFile(cdlCube, cdlToCube(look.cdl, 33));
  }
  if (cdlFirst) { if (cdlCube) luts.push(cdlCube); if (look?.lut) luts.push(look.lut); }
  else { if (look?.lut) luts.push(look.lut); if (cdlCube) luts.push(cdlCube); }
  return luts;
}

module.exports = { IDENTITY, applyCdl, isIdentity, cdlToCube, parseCube, normalizeCube, cdlToXml, writeCcc, parseCdlXml, buildFfmpegLooks };
