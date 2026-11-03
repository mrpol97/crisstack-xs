// Informes HTML (se convierten a PDF con printToPDF desde la app). Tipos:
// shooting_day, clips, thumbnails, contact_print, volume
const fs = require('node:fs');
const path = require('node:path');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtBytes = (n) => { if (n == null) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n.toFixed(i ? 2 : 0)} ${u[i]}`; };
const fmtDur = (s) => { if (s == null) return ''; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60); return [h, m, x].map((v) => String(v).padStart(2, '0')).join(':'); };

const CSS = (dark) => `
:root{--bg:${dark ? '#14161a' : '#fff'};--fg:${dark ? '#e8eaed' : '#1a1c20'};--mut:${dark ? '#9aa0a8' : '#5f6670'};--line:${dark ? '#2a2e35' : '#d9dce1'};--ok:#1f9d55;--bad:#d64545;--acc:#3b82f6}
*{box-sizing:border-box}body{margin:0;padding:28px;font:12px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg)}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:22px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}.sub{color:var(--mut);margin-bottom:14px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:700}.mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;word-break:break-all}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{border:1px solid var(--line);border-radius:6px;overflow:hidden}.card img{width:100%;display:block;background:#000}.card div{padding:6px 8px}
.stat{display:inline-block;margin-right:22px}.stat b{display:block;font-size:18px}`;

function thumbSrc(clip) {
  if (!clip.thumb) return '';
  try { return 'data:image/jpeg;base64,' + fs.readFileSync(clip.thumb).toString('base64'); } catch { return ''; }
}

let CURRENT_INFO = null; // ficha del proyecto del informe que se esta generando (build es sincrono)
const ROLES = [['director', 'Director'], ['cinematographer', 'Dir. fotografía'], ['cameraAssistant', '1.er ayte. cámara'], ['cameraAssistant2', '2.º ayte. cámara'], ['dit', 'DIT'], ['dataManager', 'Data manager'], ['soundMixer', 'Sonido'], ['scriptSupervisor', 'Script'], ['producer', 'Productor']];

function projectHeader(info) {
  if (!info) return '';
  const crew = ROLES.filter(([k]) => info[k]).map(([k, l]) => `<span><b>${esc(l)}</b> ${esc(info[k])}</span>`).join('');
  const logo = info.logo && /^data:image\/(png|jpe?g|svg\+xml|webp);base64,/.test(info.logo) ? `<img class="logo" src="${info.logo}" alt="">` : '';
  return `<div class="proj">${logo}<div><div class="pname">${esc(info.production || info.name || '')}</div><div class="psub">${esc([info.name, info.location].filter(Boolean).join(' · '))}</div><div class="crew">${crew}</div></div></div>`;
}

function wrap(title, subtitle, body, dark) {
  const css = `${CSS(dark)}.proj{display:flex;gap:16px;align-items:center;border-bottom:2px solid var(--line);padding-bottom:12px;margin-bottom:14px}.proj .logo{max-height:56px;max-width:160px;object-fit:contain}.pname{font-size:16px;font-weight:700}.psub{color:var(--mut)}.crew{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:4px;font-size:11px}.crew b{color:var(--mut);font-weight:600;margin-right:4px}.foot{margin-top:24px;padding-top:8px;border-top:1px solid var(--line);color:var(--mut);font-size:10px}`;
  const foot = CURRENT_INFO?.copyright ? `<div class="foot">${esc(CURRENT_INFO.copyright)}</div>` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${projectHeader(CURRENT_INFO)}<h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div>${body}${foot}</body></html>`;
}

function jobSummary(jobs) {
  const bytes = jobs.reduce((s, j) => s + (j.totalBytes || 0), 0);
  const files = jobs.reduce((s, j) => s + (j.fileCount || 0), 0);
  const fails = jobs.reduce((s, j) => s + (j.failures || 0), 0);
  return `<div><span class="stat"><b>${jobs.length}</b>Jobs</span><span class="stat"><b>${files}</b>Ficheros</span><span class="stat"><b>${fmtBytes(bytes)}</b>Datos</span><span class="stat"><b class="${fails ? 'bad' : 'ok'}">${fails ? fails + ' errores' : 'Todo verificado'}</b>Estado</span></div>`;
}

function build(type, { clips = [], jobs = [], project = 'Proyecto', day = '', dark = false, projectInfo = null } = {}) {
  CURRENT_INFO = projectInfo;
  if (projectInfo?.name) project = projectInfo.name;
  const sub = `${project}${day ? ' · Día ' + day : ''} · generado ${new Date().toLocaleString('es-ES')}`;
  if (type === 'volume') {
    let body = jobSummary(jobs);
    for (const j of jobs) {
      body += `<h2>${esc(j.sources.join(', '))} → ${esc(j.destinations.join(' | '))}</h2><div class="sub">${esc(j.started)} · ${j.algos.join(', ').toUpperCase()} · ${j.fileCount} ficheros · ${fmtBytes(j.totalBytes)}</div>`;
      body += '<table><tr><th>Fichero</th><th>Tamaño</th><th>Hash</th><th>Destinos</th></tr>';
      for (const f of j.files) {
        const h = f.hashes ? Object.entries(f.hashes).map(([a, v]) => `${a.toUpperCase()} ${v}`).join('<br>') : esc(f.error || '');
        const d = (f.dests || []).map((x) => `<span class="${x.status === 'verified' || x.status === 'copied' ? 'ok' : 'bad'}">${esc(x.status)}</span>`).join(' / ');
        body += `<tr><td>${esc(f.rel)}</td><td>${fmtBytes(f.size)}</td><td class="mono">${h}</td><td>${d}</td></tr>`;
      }
      body += '</table>';
    }
    return wrap('Informe de volumen', sub, body, dark);
  }
  if (type === 'thumbnails' || type === 'contact_print') {
    const per = type === 'contact_print' ? '' : '';
    const cards = clips.filter((c) => c.kind === 'video').map((c) => `<div class="card"><img src="${thumbSrc(c)}" alt=""><div><b>${esc(c.name)}</b><br>${esc(c.meta?.timecode || '')} ${fmtDur(c.meta?.duration)}${type === 'thumbnails' ? `<br>${esc(c.scene)} ${esc(c.shot)} ${esc(c.take)} ${c.flag ? '· ' + esc(c.flag) : ''}` : ''}</div></div>`).join('');
    return wrap(type === 'contact_print' ? 'Contact print' : 'Informe de miniaturas', sub, `<div class="grid">${cards}</div>${per}`, dark);
  }
  const rows = clips.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.reel)}</td><td>${esc(c.scene)}/${esc(c.shot)}/${esc(c.take)}</td><td>${esc(c.meta?.codec || '')} ${c.meta?.width ? c.meta.width + 'x' + c.meta.height : ''}</td><td>${c.meta?.fps ? c.meta.fps.toFixed(3) : ''}</td><td>${esc(c.meta?.timecode || '')}</td><td>${fmtDur(c.meta?.duration)}</td><td>${fmtBytes(c.size)}</td><td>${esc(c.flag)} ${'★'.repeat(c.rating || 0)}</td><td class="${c.verified === 'verified' ? 'ok' : 'bad'}">${esc(c.verified)}</td></tr>`).join('');
  const table = `<table><tr><th>Clip</th><th>Reel</th><th>Esc/Plano/Toma</th><th>Formato</th><th>FPS</th><th>TC</th><th>Dur.</th><th>Tamaño</th><th>Valoración</th><th>Estado</th></tr>${rows}</table>`;
  if (type === 'shooting_day') {
    const dur = clips.reduce((s, c) => s + (c.meta?.duration || 0), 0);
    const size = clips.reduce((s, c) => s + (c.size || 0), 0);
    const head = `<div><span class="stat"><b>${clips.length}</b>Clips</span><span class="stat"><b>${fmtDur(dur)}</b>Duración</span><span class="stat"><b>${fmtBytes(size)}</b>Datos</span></div>`;
    return wrap('Informe del día de rodaje', sub, head + jobSummary(jobs) + '<h2>Clips</h2>' + table, dark);
  }
  return wrap('Informe de clips', sub, table, dark);
}

function toCsv(clips) {
  const cols = ['name', 'reel', 'camera', 'scene', 'shot', 'take', 'flag', 'rating', 'color', 'notes', 'size', 'verified'];
  const meta = ['codec', 'width', 'height', 'fps', 'timecode', 'duration'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [[...cols, ...meta].join(',')];
  for (const c of clips) lines.push([...cols.map((k) => q(c[k])), ...meta.map((k) => q(c.meta?.[k]))].join(','));
  return lines.join('\n');
}

/** EDL CMX3600 basico a partir de clips con timecode y duracion. */
function toEdl(clips, title = 'CINESTACK', fps = 25) {
  const f2tc = (frames) => { const ff = Math.round(fps); const h = Math.floor(frames / (3600 * ff)); const m = Math.floor(frames / (60 * ff)) % 60; const s = Math.floor(frames / ff) % 60; const fr = frames % ff; return [h, m, s, fr].map((v) => String(v).padStart(2, '0')).join(':'); };
  const tc2f = (tc) => { const [h, m, s, f] = (tc || '00:00:00:00').split(/[:;]/).map(Number); return ((h * 60 + m) * 60 + s) * Math.round(fps) + f; };
  let rec = 3600 * Math.round(fps);
  const out = [`TITLE: ${title}`, 'FCM: NON-DROP FRAME', ''];
  clips.filter((c) => c.meta?.duration).forEach((c, i) => {
    const frames = Math.round(c.meta.duration * fps);
    const src = tc2f(c.meta.timecode);
    const reel = (c.reel || 'AX').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).padEnd(8, ' ');
    out.push(`${String(i + 1).padStart(3, '0')}  ${reel} V     C        ${f2tc(src)} ${f2tc(src + frames)} ${f2tc(rec)} ${f2tc(rec + frames)}`);
    out.push(`* FROM CLIP NAME: ${c.name}`, '');
    rec += frames;
  });
  return out.join('\n');
}

module.exports = { build, toCsv, toEdl };
