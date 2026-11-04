// Fotograma decodificado -> imagen para ver. Se usa ffmpeg SOLO para pintar los pixeles que ya entrego el SDK (no decodifica RAW).
const { spawn } = require('node:child_process');

const PIX = { rgb48le: 'rgb48le', rgba64le: 'rgba64le', rgb24: 'rgb24', rgbaf16le: 'rgbaf16le' };

/** frame: {width,height,layout,data}. Devuelve un Buffer JPEG de maxWidth px como maximo. Los valores se muestran tal cual salen del SDK. */
function frameToJpeg(frame, { maxWidth = 960, quality = 3 } = {}) {
  const { FFMPEG } = require('../media');
  const pix = PIX[frame.layout]; if (!pix) return Promise.reject(new Error(`Disposición no soportada para la vista: ${frame.layout}`));
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', pix, '-s', `${frame.width}x${frame.height}`, '-i', 'pipe:0', '-vf', `scale='min(${maxWidth},iw)':-2`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', String(quality), 'pipe:1'], { windowsHide: true });
    const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => (err += d));
    p.on('error', reject); p.stdin.on('error', () => {});
    p.on('close', (code) => (code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error(err.trim().split('\n').slice(-2).join(' | ') || 'No se pudo dibujar el fotograma'))));
    p.stdin.end(frame.data);
  });
}

module.exports = { frameToJpeg };
