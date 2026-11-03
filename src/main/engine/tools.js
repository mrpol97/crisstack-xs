// Utilidades: aviso Slack, secuencias de imagenes, renombrado en offload y relink de clips.
const path = require('node:path');
const fsp = require('node:fs/promises');
const https = require('node:https');
const http = require('node:http');
const { walk, hashFile } = require('./offload');

function postJson(urlStr, body) {
  const u = new URL(urlStr); const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = (u.protocol === 'https:' ? https : http).request({ method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => (res.statusCode < 300 ? resolve(b) : reject(new Error(`HTTP ${res.statusCode} ${b.slice(0, 120)}`))));
    });
    r.on('error', reject); r.end(data);
  });
}
/** Mensaje de resumen de un job para Slack (webhook entrante). */
function jobMessage(job) {
  const gb = (job.totalBytes / 1e9).toFixed(2);
  return { text: `${job.ok ? ':white_check_mark:' : ':x:'} Offload ${job.reel || ''} — ${job.fileCount} ficheros, ${gb} GB, ${job.ok ? 'verificado' : job.failures + ' fallos'}` };
}
const notifySlack = (url, job) => postJson(url, jobMessage(job));

/** Agrupa ficheros tipo name.0001.ext en una secuencia. */
function detectSequences(relPaths) {
  const groups = new Map(); const singles = [];
  for (const p of relPaths) {
    const m = /^(.*?)(\d{3,})(\.[^./\\]+)$/.exec(p);
    if (!m) { singles.push(p); continue; }
    const key = `${m[1]}#${m[2].length}${m[3]}`;
    if (!groups.has(key)) groups.set(key, { prefix: m[1], pad: m[2].length, ext: m[3], frames: [] });
    groups.get(key).frames.push(Number(m[2]));
  }
  const sequences = [];
  for (const g of groups.values()) {
    if (g.frames.length < 2) { singles.push(`${g.prefix}${String(g.frames[0]).padStart(g.pad, '0')}${g.ext}`); continue; }
    g.frames.sort((a, b) => a - b);
    const gaps = []; for (let i = 1; i < g.frames.length; i++) for (let f = g.frames[i - 1] + 1; f < g.frames[i]; f++) gaps.push(f);
    sequences.push({ pattern: `${g.prefix}${'#'.repeat(g.pad)}${g.ext}`, first: g.frames[0], last: g.frames.at(-1), count: g.frames.length, gaps });
  }
  return { sequences, singles };
}

/** Plantilla de renombrado para ficheros copiados. Tokens: {name} {ext} {reel} {camera} {project} {counter:N} {date} */
function makeRenamer(pattern, ctx = {}) {
  if (!pattern) return null;
  let n = 0;
  return (rel) => {
    n++;
    const ext = path.extname(rel), name = path.basename(rel, ext), dir = path.dirname(rel);
    const date = new Date().toISOString().slice(0, 10);
    const out = pattern.replace(/\{(\w+)(?::(\d+))?\}/g, (m, k, w) => {
      const v = { name, ext: ext.slice(1), reel: ctx.reel, camera: ctx.camera, project: ctx.project, counter: n, date }[k];
      return v == null ? m : (w ? String(v).padStart(Number(w), '0') : v);
    }).replace(/[<>:"|?*\\/]/g, '_');
    return path.join(dir === '.' ? '' : dir, out.includes('.') ? out : out + ext);
  };
}

/** Busca ficheros movidos: compara por nombre+tamano y, si hay varios candidatos, por hash. Devuelve [{id, from, to}]. */
async function relink(clips, roots, { algo = 'xxh64' } = {}) {
  const index = new Map();
  for (const r of roots) for (const f of await walk(r)) { const k = `${path.basename(f.abs).toLowerCase()}|${f.size}`; (index.get(k) || index.set(k, []).get(k)).push(f.abs); }
  const out = []; const notFound = [];
  for (const c of clips) {
    const exists = await fsp.access(c.path).then(() => true, () => false);
    if (exists) continue;
    let cand = index.get(`${c.name.toLowerCase()}|${c.size}`) || [];
    if (cand.length > 1 && c.hashes?.[algo]) { const ok = []; for (const p of cand) if ((await hashFile(p, [algo])) [algo] === c.hashes[algo]) ok.push(p); cand = ok; }
    if (cand.length >= 1) out.push({ id: c.id, from: c.path, to: cand[0], ambiguous: cand.length > 1 });
    else notFound.push(c.id);
  }
  return { relinked: out, notFound };
}

/** Campos de metadatos que se pueden llevar al fichero transcodificado: id -> [clave del contenedor, funcion de lectura]. */
const META_FIELDS = {
  project: ['project', (c, i) => i?.name], production: ['production', (c, i) => i?.production], director: ['director', (c, i) => i?.director],
  cinematographer: ['cinematographer', (c, i) => i?.cinematographer], dit: ['dit', (c, i) => i?.dit], dataManager: ['data_manager', (c, i) => i?.dataManager],
  copyright: ['copyright', (c, i) => i?.copyright], scene: ['scene', (c) => c.scene], shot: ['shot', (c) => c.shot], take: ['take', (c) => c.take],
  camera: ['camera', (c) => c.camera], reel: ['reel', (c) => c.reel], shotId: ['shot_id', (c) => c.shotId], notes: ['comment', (c) => c.notes],
  flag: ['flag', (c) => c.flag], rating: ['rating', (c) => (c.rating ? String(c.rating) : '')],
  iso: ['iso', (c) => c.cam?.iso ?? c.meta?.camera?.iso], wb: ['white_balance', (c) => c.cam?.wb ?? c.meta?.camera?.wb], lens: ['lens', (c) => c.cam?.lens ?? c.meta?.camera?.lens],
  shutter: ['shutter', (c) => c.cam?.shutter ?? c.meta?.camera?.shutter],
};
/** fields: ids de META_FIELDS o 'custom:<nombre>'. Devuelve {clave: valor} solo con los que tienen valor. */
function buildClipMetadata(clip, info, fields = []) {
  const out = { title: clip.name };
  for (const f of fields) {
    if (f.startsWith('custom:')) { const n = f.slice(7); const v = clip.custom?.[n]; if (v) out[n] = v; continue; }
    const def = META_FIELDS[f]; if (!def) continue;
    const v = def[1](clip, info); if (v !== undefined && v !== null && String(v) !== '') out[def[0]] = v;
  }
  return out;
}

module.exports = { buildClipMetadata, META_FIELDS, notifySlack, jobMessage, postJson, detectSequences, makeRenamer, relink };
