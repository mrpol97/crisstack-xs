// Analisis de medios (ffprobe), miniaturas y transcodificacion (ffmpeg).
const path = require('node:path');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

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

async function probe(file) {
  const raw = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(raw);
  const v = j.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = j.streams.filter((s) => s.codec_type === 'audio');
  const tc = j.format?.tags?.timecode || v?.tags?.timecode || j.streams.find((s) => s.tags?.timecode)?.tags?.timecode || null;
  return {
    container: j.format?.format_name,
    duration: Number(j.format?.duration) || null,
    bitrate: Number(j.format?.bit_rate) || null,
    codec: v?.codec_name || null,
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
  await run(FFMPEG, ['-v', 'error', '-y', '-ss', String(atSeconds), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', outPath]);
  return outPath;
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

const filterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
function fontFile() {
  if (process.platform === 'darwin') return '/System/Library/Fonts/Helvetica.ttc';
  if (process.platform === 'win32') return 'C\\:/Windows/Fonts/arial.ttf';
  return '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
}

/**
 * opts: { preset, height?, lut?, burnTimecode?, burnName?, startTimecode? , onProgress?, signal?, duration? }
 */
async function transcode(input, output, opts) {
  const preset = PRESETS[opts.preset];
  if (!preset) throw new Error(`Preset desconocido: ${opts.preset}`);
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const vf = [];
  if (opts.crop) { const c = opts.crop; vf.push(`crop=iw*${c.w}:ih*${c.h}:iw*${c.x}:ih*${c.y}`); }
  if (opts.desqueeze && opts.desqueeze !== 1) vf.push(`scale=iw*${Number(opts.desqueeze)}:ih,setsar=1`);
  if (opts.flip === 'h' || opts.flip === 'hv') vf.push('hflip');
  if (opts.flip === 'v' || opts.flip === 'hv') vf.push('vflip');
  if (opts.rotate === 90) vf.push('transpose=1'); else if (opts.rotate === 180) vf.push('hflip,vflip'); else if (opts.rotate === 270) vf.push('transpose=2');
  for (const l of (opts.luts || (opts.lut ? [opts.lut] : []))) vf.push(`lut3d='${filterPath(l)}'`);
  if (opts.height) vf.push(`scale=-2:${Number(opts.height)}`);
  if (opts.burnTimecode || opts.burnName) {
    const parts = [];
    const ff = fontFile();
    if (opts.burnTimecode) {
      const tc = (opts.startTimecode || '00:00:00:00').replace(/:/g, '\\:');
      parts.push(`drawtext=fontfile='${ff}':timecode='${tc}':rate=${opts.fps || 25}:fontcolor=white:fontsize=h/28:box=1:boxcolor=black@0.5:x=(w-tw)/2:y=h-th-20`);
    }
    if (opts.burnName) {
      const t = path.basename(input).replace(/[:'\\]/g, ' ');
      parts.push(`drawtext=fontfile='${ff}':text='${t}':fontcolor=white:fontsize=h/32:box=1:boxcolor=black@0.5:x=20:y=20`);
    }
    vf.push(...parts);
  }
  const args = ['-v', 'error', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a?', ...(vf.length ? ['-vf', vf.join(',')] : []), ...preset.args, '-progress', 'pipe:1', '-nostats', output];
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true, signal: opts.signal });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/.exec(String(d));
      if (m && opts.duration) opts.onProgress?.(Math.min(1, Number(m[1]) / 1e6 / opts.duration));
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-3).join('\n') || `ffmpeg salio con ${code}`))));
  });
  return output;
}

const STILL_PRESETS = { jpeg: { ext: '.jpg', args: ['-q:v', '2'] }, png: { ext: '.png', args: [] }, tiff: { ext: '.tif', args: ['-pix_fmt', 'rgb48le'] } };

/** Exporta un fotograma (still) aplicando look/recorte/giro. opts: { time, preset, luts, crop, flip, rotate, desqueeze, height } */
async function exportStill(input, output, opts = {}) {
  const p = STILL_PRESETS[opts.preset || 'jpeg'];
  if (!p) throw new Error('Preset de still desconocido');
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const vf = [];
  if (opts.crop) { const c = opts.crop; vf.push(`crop=iw*${c.w}:ih*${c.h}:iw*${c.x}:ih*${c.y}`); }
  if (opts.desqueeze && opts.desqueeze !== 1) vf.push(`scale=iw*${Number(opts.desqueeze)}:ih,setsar=1`);
  if (opts.flip === 'h') vf.push('hflip'); if (opts.flip === 'v') vf.push('vflip');
  if (opts.rotate === 90) vf.push('transpose=1'); else if (opts.rotate === 270) vf.push('transpose=2');
  for (const l of opts.luts || []) vf.push(`lut3d='${filterPath(l)}'`);
  if (opts.height) vf.push(`scale=-2:${Number(opts.height)}`);
  await run(FFMPEG, ['-v', 'error', '-y', '-ss', String(opts.time || 0), '-i', input, '-frames:v', '1', ...(vf.length ? ['-vf', vf.join(',')] : []), ...p.args, output]);
  return output;
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

module.exports = { probe, thumbnail, transcode, exportStill, combineClips, kindOf, run, PRESETS, STILL_PRESETS, FFMPEG, FFPROBE };
