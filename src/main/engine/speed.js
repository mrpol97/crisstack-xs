// Estadisticas y grafica de la velocidad de un traspaso, a partir de job.samples:
// cada muestra es [segundos, bytesTotales, fase (0 copia / 1 verificacion), ...bytesAcumuladosPorDestino].
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtBytes = (n) => { if (n == null || !isFinite(n)) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n.toFixed(i ? 2 : 0)} ${u[i]}`; };
const fmtClock = (s) => { s = Math.max(0, Math.round(s)); return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, '0')).join(':'); };
const shortPath = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).slice(-2).join('/');
const COLORS = ['#4da3ff', '#ffb454', '#7bd88f', '#ff6b8a', '#c792ea', '#5ad1c8'];

/** Serie de velocidades (bytes/s) por intervalo: [{t, total, per:[...], phase}] */
function rates(job) {
  let s = job.samples || [];
  if (s.length && s[0][0] > 0) s = [[0, 0, 0, ...s[0].slice(3).map(() => 0)], ...s]; // el traspaso empieza en 0
  const out = [];
  for (let i = 1; i < s.length; i++) {
    const dt = s[i][0] - s[i - 1][0];
    if (dt <= 0) continue;
    // El total de "trabajo" es la lectura del origen (copia) mas las relecturas (verificacion); aqui sumamos lo que se movio en los destinos
    const per = s[i].slice(3).map((v, k) => Math.max(0, (v - (s[i - 1][3 + k] || 0)) / dt));
    out.push({ t: s[i][0], total: Math.max(0, (s[i][1] - s[i - 1][1]) / dt), per, phase: s[i][2] });
  }
  return out;
}

function stats(job) {
  const r = rates(job);
  const vals = r.map((x) => x.total).filter((v) => v > 0);
  const avg = job.seconds ? (job.perDest || []).reduce((s, d) => s + d.copiedBytes + d.verifiedBytes, 0) / job.seconds : 0;
  const slow = r.filter((x) => x.total > 0).sort((x, y) => x.total - y.total)[0];
  return {
    seconds: job.seconds || 0,
    avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
    peak: vals.length ? Math.max(...vals) : 0,
    min: slow ? slow.total : 0,
    minAt: slow ? slow.t : 0,
    overall: avg,
    perDest: (job.perDest || []).map((d, i) => {
      const series = r.map((x) => x.per[i] || 0).filter((v) => v > 0);
      return { path: d.path, copiedBytes: d.copiedBytes, verifiedBytes: d.verifiedBytes, errors: d.errors, avg: job.seconds ? (d.copiedBytes + d.verifiedBytes) / job.seconds : 0, peak: series.length ? Math.max(...series) : 0 };
    }),
  };
}

/** Grafica SVG de velocidad en el tiempo: una linea por destino y la zona de verificacion sombreada. */
function chartSvg(job, { width = 760, height = 240, dark = true } = {}) {
  const r = rates(job);
  if (r.length < 2) return `<div class="sub">Este traspaso fue demasiado corto para trazar la velocidad.</div>`;
  const fg = dark ? '#c9d1dc' : '#333', grid = dark ? '#2a3140' : '#ddd';
  const L = 84, R = 12, T = 12, B = 30, w = width - L - R, h = height - T - B;
  const tmax = r[r.length - 1].t;
  const peak = Math.max(...r.flatMap((x) => [x.total, ...x.per])) || 1;
  const ymax = Math.pow(10, Math.floor(Math.log10(peak))) * Math.ceil(peak / Math.pow(10, Math.floor(Math.log10(peak))));
  const X = (t) => L + (t / tmax) * w, Y = (v) => T + h - (v / ymax) * h;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Velocidad del traspaso en el tiempo" style="font:11px sans-serif;max-width:${width}px">`;
  for (let i = 0; i <= 4; i++) { const v = (ymax / 4) * i; svg += `<line x1="${L}" x2="${width - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${grid}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" fill="${fg}">${esc(fmtBytes(v))}/s</text>`; }
  const nice = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]; const stepT = nice.find((n) => tmax / n <= 7) || 7200;
  for (let t = 0; t <= tmax + 0.001; t += stepT) svg += `<text x="${X(t)}" y="${height - 10}" text-anchor="middle" fill="${fg}">${esc(fmtClock(t))}</text>`;
  // sombreado de las fases de verificacion
  let start = null;
  r.forEach((x, i) => {
    const prev = i ? r[i - 1].t : 0;
    if (x.phase === 1 && start == null) start = prev;
    if ((x.phase !== 1 || i === r.length - 1) && start != null) { const end = x.phase === 1 ? x.t : prev; svg += `<rect x="${X(start)}" y="${T}" width="${Math.max(1, X(end) - X(start))}" height="${h}" fill="${fg}" opacity="0.07"/>`; start = null; }
  });
  const line = (get, color, wdt = 1.6) => `<polyline fill="none" stroke="${color}" stroke-width="${wdt}" stroke-linejoin="round" points="${[{ t: 0, v: get(r[0]) }, ...r.map((x) => ({ t: x.t, v: get(x) }))].map((x) => `${X(x.t).toFixed(1)},${Y(x.v).toFixed(1)}`).join(' ')}"/>`;
  const nd = (job.perDest || []).length;
  if (nd > 1) for (let i = 0; i < nd; i++) svg += line((x) => x.per[i] || 0, COLORS[i % COLORS.length]);
  svg += line((x) => x.total, dark ? '#ffffff' : '#111', nd > 1 ? 1 : 2);
  svg += `</svg>`;
  const legend = [`<span style="color:${dark ? '#fff' : '#111'}">━ Total (lectura del origen + relecturas)</span>`, ...(job.perDest || []).map((d, i) => `<span style="color:${COLORS[i % COLORS.length]}">━ Destino ${i + 1}: …/${esc(shortPath(d.path))}</span>`), '<span>▒ zona sombreada = verificación</span>'];
  return svg + `<div class="sub" style="display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:4px">${nd > 1 ? legend.join('') : legend.filter((_, i) => i !== 1).join('')}</div>`;
}

/** Cuerpo HTML del informe de velocidad de uno o varios jobs. */
function reportBody(jobs, { dark = true } = {}) {
  let body = '';
  for (const j of jobs) {
    const s = stats(j);
    body += `<h2>${esc((j.sources || []).join(', '))} → ${esc((j.destinations || []).join(' | '))}</h2><div class="sub">${esc(j.started)} · ${j.fileCount} ficheros · ${fmtBytes(j.totalBytes)} · duración ${fmtClock(s.seconds)}</div>`;
    body += `<div><span class="stat"><b>${fmtBytes(s.overall)}/s</b>Media global</span><span class="stat"><b>${fmtBytes(s.peak)}/s</b>Máxima</span><span class="stat"><b>${fmtBytes(s.min)}/s</b>Mínima (a los ${fmtClock(s.minAt)})</span></div>`;
    body += chartSvg(j, { dark });
    body += '<table><tr><th>Destino</th><th>Escrito</th><th>Releído (verificación)</th><th>Media</th><th>Máxima</th><th>Errores</th></tr>';
    for (const d of s.perDest) body += `<tr><td>${esc(d.path)}</td><td>${fmtBytes(d.copiedBytes)}</td><td>${fmtBytes(d.verifiedBytes)}</td><td>${fmtBytes(d.avg)}/s</td><td>${fmtBytes(d.peak)}/s</td><td class="${d.errors ? 'bad' : 'ok'}">${d.errors || 0}</td></tr>`;
    body += '</table>';
    if (!j.samples?.length) body += '<div class="sub">Este traspaso es anterior a la v0.8 y no guardó muestras de velocidad.</div>';
  }
  return body;
}

module.exports = { rates, stats, chartSvg, reportBody };
