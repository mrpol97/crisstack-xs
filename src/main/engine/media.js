// Analisis de medios (ffprobe), miniaturas y transcodificacion (ffmpeg).
const path = require('node:path');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

const { buildVf, metadataArgs, presetArgsWithout, explainFfmpegError } = require('./filters');
const unpacked = (p) => p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const FFMPEG = unpacked(require('ffmpeg-static'));
const FFPROBE = unpacked(require('ffprobe-static').path);

const VIDEO_EXT = new Set(['.mov', '.mp4', '.mxf', '.mkv', '.avi', '.m4v', '.mts', '.m2ts', '.r3d', '.braw', '.ari', '.arx', '.crm', '.mpg', '.webm']);
const AUDIO_EXT = new Set(['.wav', '.bwf', '.aif', '.aiff', '.mp3', '.m4a', '.flac']);
const STILL_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.dng', '.cr2', '.arw', '.exr']);

function kindOf(file) {
  const e = path.extname(file).toLowerCase();
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  if (STILL_EXT.has(e)) return 'still';
  return null;
}

function run(bin, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, signal });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.split('\n').slice(-4).join('\n') || `exit ${code}`))));
  });
}

function parseRate(r) {
  if (!r) return null;
  const [a, b] = String(r).split('/').map(Number);
  return b ? a / b : a || null;
}

/* ---------- formatos RAW de camara y otros codecs que ffmpeg no puede decodificar ---------- */
// Estos formatos necesitan el SDK del fabricante (Blackmagic, RED, ARRI, Sony...): la app los registra como clips con su informacion
// y miniatura generica, y permite vincularles un proxy para verlos y transcodificarlos.
const RAW_BY_EXT = { '.braw': 'Blackmagic RAW', '.r3d': 'REDCODE RAW (R3D)', '.ari': 'ARRIRAW', '.arx': 'ARRIRAW', '.crm': 'Canon Cinema RAW Light', '.nev': 'Nikon N-RAW', '.rmf': 'Canon RAW (RMF)' };
const RAW_BY_TAG = { braw: 'Blackmagic RAW', aprn: 'Apple ProRes RAW', aprh: 'Apple ProRes RAW HQ', xocn: 'Sony X-OCN', r3d: 'REDCODE RAW (R3D)' };
let decoderSet = null;
function decoders() {
  if (!decoderSet) {
    decoderSet = new Set();
    try { for (const l of String(require('node:child_process').spawnSync(FFMPEG, ['-hide_banner', '-decoders'], { windowsHide: true }).stdout).split('\n')) { const m = /^ ([VAS][A-Z.]{5}) (\S+)/.exec(l); if (m) decoderSet.add(m[2]); } } catch { /* sin lista */ }
  }
  return decoderSet;
}
/** { decodable, label } para el primer stream de video. */
function decodability(file, v) {
  const ext = path.extname(file).toLowerCase(); const name = v?.codec_name;
  const tag = String(v?.codec_tag_string || '').toLowerCase().replace(/[^\w]/g, '');
  if (RAW_BY_EXT[ext]) return { decodable: false, label: RAW_BY_EXT[ext] };
  if (!v) return { decodable: true, label: null };
  if (RAW_BY_TAG[tag] && (!name || name === 'none' || name === 'unknown' || !decoders().has(name))) return { decodable: false, label: RAW_BY_TAG[tag] };
  if (!name || name === 'none' || name === 'unknown' || (decoders().size > 50 && !decoders().has(name))) return { decodable: false, label: (tag && RAW_BY_TAG[tag]) || (ext === '.mxf' ? 'MXF (códec propietario)' : (v.codec_long_name && !/unknown/i.test(v.codec_long_name) ? v.codec_long_name : (tag ? tag.toUpperCase() : 'Códec no soportado'))) };
  return { decodable: true, label: null };
}

async function probe(file) {
  let raw;
  try { raw = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]); }
  catch (e) {
    const ext = path.extname(file).toLowerCase();
    if (RAW_BY_EXT[ext] || kindOf(file) === 'video') { const label = RAW_BY_EXT[ext] || 'Códec no soportado'; return { audioCodec: null, tcFormat: null, camera: {}, container: ext.slice(1), duration: null, bitrate: null, codec: label, codecLabel: label, decodable: false, width: null, height: null, fps: null, timecode: null, audioTracks: 0, audioChannels: 0 }; }
    throw e;
  }
  const j = JSON.parse(raw);
  const v = j.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = j.streams.filter((s) => s.codec_type === 'audio');
  const tc = j.format?.tags?.timecode || v?.tags?.timecode || j.streams.find((s) => s.tags?.timecode)?.tags?.timecode || null;
  // etiquetas del contenedor y de los streams (en minusculas) para extraer datos de camara cuando existen
  const tags = {}; const put = (o) => { for (const [k, val] of Object.entries(o || {})) tags[k.toLowerCase()] = String(val).slice(0, 200); };
  put(j.format?.tags); put(v?.tags); a.forEach((s) => put(s.tags));
  const pick = (re) => { const k = Object.keys(tags).find((x) => re.test(x)); return k ? tags[k] : null; };
  const camera = {
    make: pick(/^(make|manufacturer|com\.apple\.proapps\.manufacturer)$/), model: pick(/(^model$|camera.*model|com\.apple\.proapps\.model)/),
    iso: pick(/(^iso$|iso_speed|exposure_?index|iso_?setting)/), isoNative: pick(/(native.*iso|iso.*native)/), wb: pick(/white.?balance|color.?temp/), shutter: pick(/shutter/),
    nd: pick(/nd.?filter/), lens: pick(/lens/), sensorFps: pick(/sensor.?fps|capture.?fps|sensor_frame/), rawColorSpace: pick(/raw.*color|color.?space/),
  };
  const dec = decodability(file, v);
  return {
    decodable: dec.decodable, codecLabel: dec.label,
    audioCodec: a[0]?.codec_name || null,
    tcFormat: tc ? (tc.includes(';') ? 'DF' : 'NDF') : null,
    tags: Object.keys(tags).length > 60 ? undefined : tags,
    camera,
    container: j.format?.format_name,
    duration: Number(j.format?.duration) || null,
    bitrate: Number(j.format?.bit_rate) || null,
    codec: dec.decodable ? (v?.codec_name || null) : dec.label,
    profile: v?.profile || null,
    width: v?.width || null,
    height: v?.height || null,
    fps: parseRate(v?.avg_frame_rate || v?.r_frame_rate),
    pixFmt: v?.pix_fmt || null,
    colorSpace: v?.color_space || null,
    timecode: tc,
    audioTracks: a.length,
    audioChannels: a.reduce((s, x) => s + (x.channels || 0), 0),
    sampleRate: a[0] ? Number(a[0].sample_rate) : null,
    creationTime: j.format?.tags?.creation_time || null,
    cameraModel: j.format?.tags?.['com.apple.proapps.manufacturer'] || j.format?.tags?.encoder || null,
  };
}

async function thumbnail(file, outPath, atSeconds = 1, width = 320) {
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const exists = () => fsp.access(outPath).then(() => true, () => false);
  await fsp.rm(outPath, { force: true });
  // Si el momento pedido cae fuera del clip ffmpeg termina sin error pero sin fotograma: se reintenta con el primero.
  for (const t of [atSeconds, 0]) {
    await run(FFMPEG, ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', outPath]);
    if (await exists()) return outPath;
  }
  throw new Error('No se pudo extraer un fotograma del clip');
}

/** Miniatura generica (con el nombre del formato) para clips que no se pueden decodificar. */
async function placeholderThumb(outPath, title, subtitle = 'sin vista previa') {
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const { fontFile, filterPath } = require('./filters'); const os = require('node:os');
  const font = fontFile(); const temps = []; const lines = [];
  const mk = async (text, size, y, color) => { const f = path.join(os.tmpdir(), `cine_ph_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.txt`); await fsp.writeFile(f, text); temps.push(f); lines.push(`drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(f)}':expansion=none:fontcolor=${color}:fontsize=${size}:x=(w-tw)/2:y=${y}`); };
  try {
    if (font) { await mk(String(title).slice(0, 26), 22, '(h-th)/2-16', '0xe8eaed'); await mk(subtitle, 13, '(h)/2+14', '0x9aa0a8'); }
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x161a22:s=320x180:d=1', ...(lines.length ? ['-vf', lines.join(',')] : []), '-frames:v', '1', '-q:v', '4', outPath]);
  } finally { for (const f of temps) await fsp.rm(f, { force: true }); }
  return outPath;
}

/** Busca un proxy que la camara haya dejado junto al original (Sony: carpeta Sub, RED/ARRI/BRAW: _proxy, etc.). */
async function findProxy(file) {
  const dir = path.dirname(file); const base = path.basename(file, path.extname(file)).toLowerCase();
  const dirs = [dir, ...['Sub', 'SUB', 'Proxy', 'PROXY', 'Proxies', '_proxy', '_Proxy'].flatMap((d) => [path.join(dir, d), path.join(dir, '..', d)])];
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(_?(proxy|lr|lowres)|-proxy|s0?\\d)?\\.(mp4|mov|m4v)$`, 'i');
  for (const d of dirs) {
    let names = []; try { names = await fsp.readdir(d); } catch { continue; }
    const hit = names.find((n) => re.test(n) && path.join(d, n) !== file);
    if (hit) return path.join(d, hit);
  }
  return null;
}

const PRESETS = {
  prores_proxy: { label: 'ProRes 422 Proxy', ext: '.mov', args: ['-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', '-ar', '48000'] },
  prores_422: { label: 'ProRes 422', ext: '.mov', args: ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', '-ar', '48000'] },
  prores_422hq: { label: 'ProRes 422 HQ', ext: '.mov', args: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', '-ar', '48000'] },
  dnxhr_lb: { label: 'DNxHR LB', ext: '.mxf', args: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb', '-pix_fmt', 'yuv422p', '-c:a', 'pcm_s16le', '-ar', '48000'] },
  dnxhr_sq: { label: 'DNxHR SQ', ext: '.mxf', args: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_sq', '-pix_fmt', 'yuv422p', '-c:a', 'pcm_s16le', '-ar', '48000'] },
  h264_dailies: { label: 'H.264 dailies', ext: '.mp4', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] },
  h265_dailies: { label: 'H.265 dailies', ext: '.mp4', args: ['-c:v', 'libx265', '-preset', 'medium', '-crf', '24', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] },
};

/**
 * opts: { preset, height?, lut?, burnTimecode?, burnName?, startTimecode? , onProgress?, signal?, duration? }
 */
async function transcode(input, output, opts) {
  const preset = PRESETS[opts.preset];
  if (!preset) throw new Error(`Preset desconocido: ${opts.preset}`);
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const { vf, temps } = await buildVf(input, opts);
  // Se escribe a un fichero temporal y solo se renombra si ffmpeg termina bien y el resultado tiene tamano: nunca queda un clip vacio.
  const tmp = path.join(path.dirname(output), `.${path.basename(output, path.extname(output))}.partial${path.extname(output)}`);
  const mdArgs = metadataArgs(preset, opts);
  const args = ['-v', 'error', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a?', ...(vf.length ? ['-vf', vf.join(',')] : []), ...presetArgsWithout(preset.args, mdArgs.includes('-movflags')), ...mdArgs, '-progress', 'pipe:1', '-nostats', tmp];
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, args, { windowsHide: true, signal: opts.signal });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.stdout.on('data', (d) => {
        const m = /out_time_us=(\d+)/.exec(String(d));
        if (m && opts.duration) opts.onProgress?.(Math.min(1, Number(m[1]) / 1e6 / opts.duration));
      });
      p.on('error', (e) => reject(new Error(`No se pudo ejecutar ffmpeg (${e.code || e.message}) en ${FFMPEG}`)));
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(explainFfmpegError(err) || `ffmpeg salió con código ${code}`))));
    });
    const st = await fsp.stat(tmp);
    if (!st.size) throw new Error('ffmpeg terminó pero el fichero resultante está vacío');
    await fsp.rm(output, { force: true });
    await fsp.rename(tmp, output);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  } finally {
    for (const f of temps) await fsp.rm(f, { force: true });
  }
  return output;
}

/** Fotograma de previsualizacion (data URL JPEG) con los mismos filtros que tendra el transcode. opts incluye time. */
async function previewFrame(input, opts = {}) {
  const { vf, temps } = await buildVf(input, opts);
  try {
    vf.push("scale='min(960,iw)':-2");
    const buf = await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, ['-v', 'error', '-ss', String(opts.time || 0), '-i', input, '-frames:v', '1', '-vf', vf.join(','), '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3', '-'], { windowsHide: true });
      const chunks = []; let err = '';
      p.stdout.on('data', (d) => chunks.push(d)); p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 && chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error(err.trim() ? explainFfmpegError(err) : 'No se pudo generar la previsualización'))));
    });
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } finally { for (const f of temps) await fsp.rm(f, { force: true }); }
}

const STILL_PRESETS = { jpeg: { ext: '.jpg', args: ['-q:v', '2'] }, png: { ext: '.png', args: [] }, tiff: { ext: '.tif', args: ['-pix_fmt', 'rgb48le'] } };

/** Exporta un fotograma (still) aplicando look/recorte/giro. opts: { time, preset, luts, crop, flip, rotate, desqueeze, height } */
async function exportStill(input, output, opts = {}) {
  const p = STILL_PRESETS[opts.preset || 'jpeg'];
  if (!p) throw new Error('Preset de still desconocido');
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const { vf } = await buildVf(input, { ...opts, overlays: [] });
  try {
    await run(FFMPEG, ['-v', 'error', '-y', '-ss', String(opts.time || 0), '-i', input, '-frames:v', '1', ...(vf.length ? ['-vf', vf.join(',')] : []), ...p.args, output]);
  } catch (e) { throw new Error(explainFfmpegError(e.message)); }
  return output;
}

/** Miniatura con el look del clip: parte de la miniatura ya extraida (rapido) y le aplica recorte, giro, LUT y CDL. */
async function lookThumb(thumbFile, output, opts = {}) {
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const { vf } = await buildVf(thumbFile, { ...opts, overlays: [], height: undefined });
  const tmp = output + '.part.jpg';
  try {
    await run(FFMPEG, ['-v', 'error', '-y', '-i', thumbFile, ...(vf.length ? ['-vf', vf.join(',')] : []), '-frames:v', '1', '-q:v', '4', tmp]);
    await fsp.rename(tmp, output);
  } catch (e) { await fsp.rm(tmp, { force: true }); throw new Error(explainFfmpegError(e.message)); }
  return output;
}

/** Varios fotogramas repartidos por el clip (tira para elegir un momento), como data URLs. Cuatro ffmpeg a la vez como maximo. */
async function filmstrip(input, { count = 12, duration = 0, width = 200, luts = [], crop, desqueeze, flip, rotate } = {}) {
  const n = Math.max(2, Math.min(40, count)); const d = Math.max(0.1, duration || 1);
  const { vf } = await buildVf(input, { luts, crop, desqueeze, flip, rotate, overlays: [] });
  const chain = [...vf, `scale=${width}:-2`].join(',');
  const times = Array.from({ length: n }, (_, i) => +((d * (i + 0.5)) / n).toFixed(3));
  const out = new Array(n).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < n) {
      const i = next++;
      try {
        out[i] = await new Promise((resolve, reject) => {
          const p = spawn(FFMPEG, ['-v', 'error', '-ss', String(times[i]), '-i', input, '-frames:v', '1', '-vf', chain, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', '-'], { windowsHide: true });
          const chunks = []; p.stdout.on('data', (c) => chunks.push(c)); p.on('error', reject);
          p.on('close', (code) => (code === 0 && chunks.length ? resolve(`data:image/jpeg;base64,${Buffer.concat(chunks).toString('base64')}`) : reject(new Error('sin fotograma'))));
        });
      } catch { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return times.map((t, i) => ({ t, img: out[i] }));
}

/** Une varios clips en una sola transcodificacion (clip combinado). */
async function combineClips(files, output, opts) {
  const list = path.join(require('node:os').tmpdir(), `cine_concat_${Date.now()}.txt`);
  const tmp = output + '.tmp' + path.extname(output);
  await fsp.writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    const preset = PRESETS[opts.preset]; if (!preset) throw new Error('Preset desconocido');
    await fsp.mkdir(path.dirname(output), { recursive: true });
    const vf = [];
    if (opts.height) vf.push(`scale=-2:${Number(opts.height)}`);
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, ...(vf.length ? ['-vf', vf.join(',')] : []), ...preset.args, tmp]);
    await fsp.rename(tmp, output);
  } finally { await fsp.rm(list, { force: true }); }
  return output;
}

module.exports = { probe, thumbnail, placeholderThumb, findProxy, decoders, transcode, previewFrame, exportStill, lookThumb, filmstrip, combineClips, kindOf, run, PRESETS, STILL_PRESETS, FFMPEG, FFPROBE };
