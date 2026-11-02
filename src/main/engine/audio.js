// Sincronizacion de audio externo: por timecode (BWF) o por correlacion de forma de onda.
const path = require('node:path');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const media = require('./media');

const tcToSeconds = (tc, fps) => {
  if (!tc) return null;
  const [h, m, s, f] = tc.split(/[:;]/).map(Number);
  return h * 3600 + m * 60 + s + (f || 0) / (fps || 25);
};

/** Info de un fichero de audio: duracion, inicio por timecode BWF (segundos desde medianoche). */
async function probeAudio(file) {
  const raw = await new Promise((resolve, reject) => {
    const p = spawn(media.FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true });
    let o = '', e = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d));
    p.on('close', (c) => (c === 0 ? resolve(o) : reject(new Error(e))));
  });
  const j = JSON.parse(raw); const a = j.streams.find((s) => s.codec_type === 'audio');
  const sr = Number(a?.sample_rate) || 48000;
  const tags = { ...j.format?.tags };
  const ref = tags.time_reference ?? tags.TIME_REFERENCE;
  let start = ref != null ? Number(ref) / sr : null;
  if (start == null && tags.timecode) start = tcToSeconds(tags.timecode, 25);
  return { file, duration: Number(j.format?.duration) || 0, sampleRate: sr, channels: a?.channels || 0, startSeconds: start };
}

/** Empareja clips de video con audios por solape de timecode. Devuelve [{clipId, audio, offset}] (offset = segundos de audio a saltar; negativo = audio empieza despues). */
function matchByTimecode(clips, audios) {
  const out = [];
  for (const c of clips) {
    const vs = tcToSeconds(c.meta?.timecode, c.meta?.fps); const vd = c.meta?.duration;
    if (vs == null || !vd) continue;
    const hit = audios.find((a) => a.startSeconds != null && a.startSeconds < vs + vd && a.startSeconds + a.duration > vs);
    if (hit) out.push({ clipId: c.id, audio: hit.file, offset: vs - hit.startSeconds, method: 'timecode' });
  }
  return out;
}

function pcmEnvelope(file, seconds = 90, rate = 4000) {
  return new Promise((resolve, reject) => {
    const p = spawn(media.FFMPEG, ['-v', 'error', '-i', file, '-t', String(seconds), '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { windowsHide: true });
    const bufs = []; let err = '';
    p.stdout.on('data', (d) => bufs.push(d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err));
      const b = Buffer.concat(bufs); const n = b.length >> 1; const hop = rate / 100; // envolvente a 100 Hz
      const env = new Float32Array(Math.floor(n / hop));
      for (let i = 0; i < env.length; i++) { let s = 0; for (let k = 0; k < hop; k++) s += Math.abs(b.readInt16LE((i * hop + k) * 2)); env[i] = s / hop; }
      resolve(env);
    });
  });
}
function normalize(env) {
  let mean = 0; for (const v of env) mean += v; mean /= env.length || 1;
  let sd = 0; for (const v of env) sd += (v - mean) ** 2; sd = Math.sqrt(sd / (env.length || 1)) || 1;
  return env.map((v) => (v - mean) / sd);
}

/** Correlacion cruzada de envolventes. Devuelve offset en segundos: audio(t) coincide con video(t - offset)... ver uso en renderSynced. */
async function matchByWaveform(videoFile, audioFile, maxLag = 30) {
  const [ve, ae] = await Promise.all([pcmEnvelope(videoFile), pcmEnvelope(audioFile)]);
  const v = normalize(ve), a = normalize(ae), L = maxLag * 100;
  let best = -Infinity, bestLag = 0;
  for (let lag = -L; lag <= L; lag++) { // lag>0: el audio externo va retrasado respecto al video
    let s = 0, n = 0;
    for (let i = Math.max(0, -lag); i < v.length && i + lag < a.length; i++) { s += v[i] * a[i + lag]; n++; }
    if (n > 200) { s /= n; if (s > best) { best = s; bestLag = lag; } }
  }
  return { offset: bestLag / 100, confidence: Math.max(0, Math.min(1, best)), method: 'waveform' };
}

/** offset > 0: saltar `offset` s del audio. offset < 0: retrasar el audio |offset| s. */
async function renderSynced(videoFile, audioFile, offset, out, { keepCameraAudio = false } = {}) {
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const args = ['-v', 'error', '-y', '-i', videoFile];
  args.push(...(offset >= 0 ? ['-ss', String(offset)] : ['-itsoffset', String(-offset)]), '-i', audioFile);
  const ext = path.extname(out).toLowerCase();
  const a = ext === '.mp4' ? ['-c:a', 'aac', '-b:a', '256k'] : ['-c:a', 'pcm_s24le', '-ar', '48000'];
  args.push('-map', '0:v:0', '-map', '1:a:0', ...(keepCameraAudio ? ['-map', '0:a?'] : []), '-c:v', 'copy', ...a, '-shortest', out);
  await new Promise((resolve, reject) => {
    const p = spawn(media.FFMPEG, args, { windowsHide: true }); let e = '';
    p.stderr.on('data', (d) => (e += d)); p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(e.trim().split('\n').slice(-3).join('\n')))));
  });
  return out;
}

module.exports = { probeAudio, matchByTimecode, matchByWaveform, renderSynced, tcToSeconds };
