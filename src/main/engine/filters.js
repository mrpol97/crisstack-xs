// Cadena de filtros de video de ffmpeg (recorte, giro, LUTs, escala, textos quemados) y metadatos para el transcode.
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const filterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
function fontFile() {
  if (process.platform === 'darwin') return '/System/Library/Fonts/Helvetica.ttc';
  if (process.platform === 'win32') return 'C\\:/Windows/Fonts/arial.ttf';
  return '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
}

const POS = {
  'top-left': 'x=20:y=20', 'top-center': 'x=(w-tw)/2:y=20', 'top-right': 'x=w-tw-20:y=20', center: 'x=(w-tw)/2:y=(h-th)/2',
  'bottom-left': 'x=20:y=h-th-20', 'bottom-center': 'x=(w-tw)/2:y=h-th-20', 'bottom-right': 'x=w-tw-20:y=h-th-20',
};
const rid = () => Math.random().toString(36).slice(2, 8);

async function textFile(content) {
  const f = path.join(os.tmpdir(), `cine_txt_${Date.now()}_${rid()}.txt`);
  await fsp.writeFile(f, String(content));
  return f;
}

/**
 * opts: { crop, desqueeze, flip, rotate, luts[]|lut, height, burnTimecode, startTimecode, fps, burnName, text:{value,pos,size} }
 * Devuelve { vf: [filtros], temps: [ficheros temporales a borrar] }
 */
async function buildVf(input, opts = {}) {
  const vf = []; const temps = [];
  if (opts.crop) { const c = opts.crop; vf.push(`crop=iw*${c.w}:ih*${c.h}:iw*${c.x}:ih*${c.y}`); }
  if (opts.desqueeze && opts.desqueeze !== 1) vf.push(`scale=iw*${Number(opts.desqueeze)}:ih,setsar=1`);
  if (opts.flip === 'h' || opts.flip === 'hv') vf.push('hflip');
  if (opts.flip === 'v' || opts.flip === 'hv') vf.push('vflip');
  if (opts.rotate === 90) vf.push('transpose=1'); else if (opts.rotate === 180) vf.push('hflip,vflip'); else if (opts.rotate === 270) vf.push('transpose=2');
  for (const l of (opts.luts || (opts.lut ? [opts.lut] : []))) vf.push(`lut3d='${filterPath(l)}'`);
  if (opts.height) vf.push(`scale=-2:${Number(opts.height)}`);
  const ff = fontFile();
  if (opts.burnTimecode) {
    const tc = (opts.startTimecode || '00:00:00:00').replace(/:/g, '\\:');
    vf.push(`drawtext=fontfile='${ff}':timecode='${tc}':rate=${opts.fps || 25}:fontcolor=white:fontsize=h/28:box=1:boxcolor=black@0.5:${POS['bottom-center']}`);
  }
  if (opts.burnName) {
    const tf = await textFile(path.basename(input)); temps.push(tf);
    vf.push(`drawtext=fontfile='${ff}':textfile='${filterPath(tf)}':fontcolor=white:fontsize=h/32:box=1:boxcolor=black@0.5:${POS['top-left']}`);
  }
  if (opts.text?.value) { // texto libre del usuario: marca de agua, titulo de entrega...
    const tf = await textFile(opts.text.value); temps.push(tf);
    vf.push(`drawtext=fontfile='${ff}':textfile='${filterPath(tf)}':fontcolor=white:fontsize=h/${Number(opts.text.size) || 26}:box=1:boxcolor=black@0.5:${POS[opts.text.pos] || POS['bottom-left']}`);
  }
  return { vf, temps };
}

/** Argumentos -metadata clave=valor (y -timecode) para llevar datos del clip al fichero transcodificado. */
function metadataArgs(preset, opts = {}) {
  const out = [];
  const md = opts.metadata || {};
  for (const [k, v] of Object.entries(md)) {
    if (v === undefined || v === null || String(v) === '') continue;
    out.push('-metadata', `${k.replace(/[^\w]/g, '_')}=${String(v).replace(/[\r\n]+/g, ' ')}`);
  }
  if (out.length && ['.mov', '.mp4'].includes(preset.ext)) out.push('-movflags', '+use_metadata_tags' + (preset.ext === '.mp4' ? '+faststart' : ''));
  if (opts.timecodeOut) out.push('-timecode', String(opts.timecodeOut));
  return out;
}

/** Quita de los argumentos del preset el -movflags cuando metadataArgs ya aporta el suyo. */
function presetArgsWithout(presetArgs, drop) {
  if (!drop) return presetArgs;
  const out = [];
  for (let i = 0; i < presetArgs.length; i++) { if (presetArgs[i] === '-movflags') { i++; continue; } out.push(presetArgs[i]); }
  return out;
}

module.exports = { buildVf, metadataArgs, presetArgsWithout, filterPath, fontFile, POS };
