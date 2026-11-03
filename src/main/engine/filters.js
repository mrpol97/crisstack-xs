// Cadena de filtros de video de ffmpeg (recorte, giro, LUTs, escala, textos en pantalla) y metadatos para el transcode.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const filterPath = (p) => String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (v !== '' && v != null && Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * Fuente para los textos. Se usa una incluida en la app (DejaVu Sans) para que el resultado sea igual en Mac y Windows y no dependa
 * de las fuentes instaladas; ffmpeg no puede leer dentro del asar, asi que se copia una vez a la carpeta temporal.
 */
let fontCache = null;
function fontFile() {
  if (fontCache && fs.existsSync(fontCache)) return fontCache;
  const candidates = [];
  try {
    const dir = path.join(os.tmpdir(), 'cinestack-fonts'); fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, 'DejaVuSans.ttf');
    if (!fs.existsSync(dst) || fs.statSync(dst).size === 0) fs.copyFileSync(path.join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf'), dst);
    candidates.push(dst);
  } catch { /* se prueban las fuentes del sistema */ }
  if (process.platform === 'darwin') candidates.push('/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf');
  else if (process.platform === 'win32') candidates.push('C:/Windows/Fonts/arial.ttf');
  else candidates.push('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  fontCache = candidates.find((f) => fs.existsSync(f)) || null;
  return fontCache;
}

const POS = {
  'top-left': 'x=20:y=20', 'top-center': 'x=(w-tw)/2:y=20', 'top-right': 'x=w-tw-20:y=20', center: 'x=(w-tw)/2:y=(h-th)/2',
  'bottom-left': 'x=20:y=h-th-20', 'bottom-center': 'x=(w-tw)/2:y=h-th-20', 'bottom-right': 'x=w-tw-20:y=h-th-20',
};
/** Centro (fraccion del ancho y del alto) de cada posicion con nombre. */
const POS_XY = { 'top-left': [0.14, 0.07], 'top-center': [0.5, 0.07], 'top-right': [0.86, 0.07], center: [0.5, 0.5], 'bottom-left': [0.14, 0.93], 'bottom-center': [0.5, 0.93], 'bottom-right': [0.86, 0.93] };
const COLORS = { white: 'white', yellow: '#ffd33d', black: 'black', red: '#ff4d4d', green: '#34c47c' };
const rid = () => Math.random().toString(36).slice(2, 8);

async function textFile(content) {
  const f = path.join(os.tmpdir(), `cine_txt_${Date.now()}_${rid()}.txt`);
  await fsp.writeFile(f, String(content));
  return f;
}

/** Recorte siempre valido: ancho y alto minimos, dentro de la imagen. Devuelve null si no recorta nada. */
function safeCrop(c) {
  if (!c || typeof c !== 'object') return null;
  const w = clamp(num(c.w, 1), 0.05, 1), h = clamp(num(c.h, 1), 0.05, 1);
  const x = clamp(num(c.x, 0), 0, 1 - w), y = clamp(num(c.y, 0), 0, 1 - h);
  if (w >= 0.999 && h >= 0.999 && x <= 0.001 && y <= 0.001) return null;
  return { x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4) };
}

/** Textos {escena}, {toma}... : sustituye las claves conocidas y deja las demas tal cual. */
function expandTokens(text, ctx = {}) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (m, k) => (ctx[k] !== undefined && ctx[k] !== null ? String(ctx[k]) : m));
}
const TOKENS = [['clip', 'Nombre sin extensión'], ['file', 'Nombre con extensión'], ['scene', 'Escena'], ['shot', 'Plano'], ['take', 'Toma'], ['camera', 'Cámara'], ['reel', 'Reel'], ['shotId', 'ShotID'], ['project', 'Proyecto'], ['date', 'Fecha'], ['notes', 'Notas']];
function clipContext(clip = {}, info = {}) {
  const file = clip.name || '';
  return { clip: file ? path.basename(file, path.extname(file)) : '', file, scene: clip.scene || '', shot: clip.shot || '', take: clip.take || '', camera: clip.camera || '', reel: clip.reel || '', shotId: clip.shotId || '', notes: clip.notes || '',
    project: info?.name || '', date: new Date().toLocaleDateString('es-ES') };
}
/** Deja los textos de los overlays listos para un clip concreto. */
function resolveOverlays(overlays, ctx) {
  return (overlays || []).filter((o) => o && o.enabled !== false).map((o) => (o.kind === 'tc' ? { ...o } : { ...o, text: expandTokens(o.text ?? '', ctx) }));
}

/** Ajustes antiguos (burnTimecode, burnName, text) convertidos a overlays. */
function legacyOverlays(o = {}) {
  const out = [];
  if (o.burnTimecode) out.push({ kind: 'tc', x: 0.5, y: 0.93, size: 3.6 });
  if (o.burnName) out.push({ kind: 'name', x: 0.14, y: 0.07, size: 3.1 });
  if (o.text?.value) { const [x, y] = POS_XY[o.text.pos] || POS_XY['bottom-left']; out.push({ kind: 'text', text: o.text.value, x, y, size: +(100 / (Number(o.text.size) || 26)).toFixed(2) }); }
  return out;
}

async function overlayFilter(o, input, opts, font, temps) {
  const kind = o.kind || 'text';
  const size = clamp(num(o.size, kind === 'name' ? 3.1 : 3.6), 1, 15);
  const fx = clamp(num(o.x, 0.5), 0, 1), fy = clamp(num(o.y, 0.9), 0, 1);
  const col = COLORS[o.color] || COLORS.white;
  const box = o.box !== false;
  let src;
  if (kind === 'tc') {
    src = `timecode='${String(opts.startTimecode || '00:00:00:00').replace(/:/g, '\\:')}':rate=${opts.fps || 25}`;
  } else {
    const text = kind === 'name' && !String(o.text ?? '').trim() ? path.basename(input) : String(o.text ?? '');
    if (!text.trim()) return null;
    const tf = await textFile(text); temps.push(tf);
    src = `textfile='${filterPath(tf)}'`;
  }
  // El centro del texto va en (fx, fy) pero sin salirse de la imagen.
  return `drawtext=fontfile='${filterPath(font)}':${src}:expansion=none:fontcolor=${col}:fontsize=h*${(size / 100).toFixed(4)}`
    + (box ? `:box=1:boxcolor=${o.color === 'black' ? 'white@0.6' : 'black@0.55'}:boxborderw=6` : '')
    + `:x='min(max(w*${fx}-tw/2,w*0.01),w-tw-w*0.01)':y='min(max(h*${fy}-th/2,h*0.01),h-th-h*0.01)'`;
}

/**
 * opts: { crop, desqueeze, flip, rotate, luts[]|lut, height, startTimecode, fps, overlays:[{kind:'tc'|'name'|'text', text, x, y, size, color, box}] }
 * (si no hay overlays se aceptan los ajustes antiguos burnTimecode / burnName / text).
 * Devuelve { vf: [filtros], temps: [ficheros temporales a borrar] }
 */
async function buildVf(input, opts = {}) {
  const vf = []; const temps = [];
  const c = safeCrop(opts.crop);
  if (c) vf.push(`crop=trunc(iw*${c.w}/2)*2:trunc(ih*${c.h}/2)*2:trunc(iw*${c.x}/2)*2:trunc(ih*${c.y}/2)*2`);
  if (opts.desqueeze && Number(opts.desqueeze) !== 1) vf.push(`scale=trunc(iw*${Number(opts.desqueeze)}/2)*2:ih,setsar=1`);
  if (opts.flip === 'h' || opts.flip === 'hv') vf.push('hflip');
  if (opts.flip === 'v' || opts.flip === 'hv') vf.push('vflip');
  if (opts.rotate === 90) vf.push('transpose=1'); else if (opts.rotate === 180) vf.push('hflip,vflip'); else if (opts.rotate === 270) vf.push('transpose=2');
  for (const l of (opts.luts || (opts.lut ? [opts.lut] : []))) vf.push(`lut3d='${filterPath(l)}'`);
  if (opts.height) vf.push(`scale=-2:${Number(opts.height)}`);
  const overlays = (opts.overlays || legacyOverlays(opts)).filter((o) => o && o.enabled !== false);
  if (overlays.length) {
    const font = fontFile();
    if (!font) throw new Error('No se encuentra ninguna fuente para dibujar los textos en pantalla');
    try { for (const o of overlays) { const f = await overlayFilter(o, input, opts, font, temps); if (f) vf.push(f); } }
    catch (e) { for (const f of temps) await fsp.rm(f, { force: true }); throw e; }
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

/** Convierte los errores crudos de ffmpeg en algo que se pueda entender. */
function explainFfmpegError(raw) {
  const t = String(raw || '').trim();
  const last = t.split('\n').filter(Boolean).slice(-3).join(' | ') || 'sin detalle';
  if (/Failed to inject frame into filter network|Error reinitializing filters|too big or non positive size|Invalid too small size/i.test(t)) return `Algún ajuste de imagen no es válido (recorte, escala o texto). Revisa que el recorte de «Color y transformación» no tenga ancho o alto a 0. Detalle: ${last}`;
  if (/lut3d|\.cube|LUT/i.test(t)) return `No se pudo aplicar la LUT: comprueba que el fichero .cube es correcto. Detalle: ${last}`;
  if (/font|drawtext|freetype/i.test(t)) return `No se pudieron dibujar los textos (fuente). Detalle: ${last}`;
  return last;
}

module.exports = { buildVf, metadataArgs, presetArgsWithout, filterPath, fontFile, safeCrop, expandTokens, clipContext, resolveOverlays, legacyOverlays, explainFfmpegError, TOKENS, POS, POS_XY, COLORS };
