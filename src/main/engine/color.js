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
  let size = 0; const data = []; let dmin = [0, 0, 0], dmax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    if (l.startsWith('LUT_3D_SIZE')) size = Number(l.split(/\s+/)[1]);
    else if (l.startsWith('DOMAIN_MIN')) dmin = l.split(/\s+/).slice(1).map(Number);
    else if (l.startsWith('DOMAIN_MAX')) dmax = l.split(/\s+/).slice(1).map(Number);
    else if (/^[-\d.]/.test(l)) data.push(...l.split(/\s+/).map(Number));
  }
  if (!size || data.length !== size ** 3 * 3) throw new Error('Fichero .cube invalido o LUT 1D no soportada');
  return { size, data: Float32Array.from(data), dmin, dmax };
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
  const luts = [];
  if (look?.cdl && !isIdentity(look.cdl)) {
    await fsp.mkdir(tmpDir, { recursive: true });
    const f = path.join(tmpDir, `cdl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.cube`);
    await fsp.writeFile(f, cdlToCube(look.cdl, 33));
    luts.push(f);
  }
  if (look?.lut) luts.push(look.lut);
  return luts;
}

module.exports = { IDENTITY, applyCdl, isIdentity, cdlToCube, parseCube, cdlToXml, writeCcc, parseCdlXml, buildFfmpegLooks };
