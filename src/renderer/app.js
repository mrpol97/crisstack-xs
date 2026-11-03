'use strict';
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push(e.message));
window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));
const api = window.cinestack;
const $ = (s, r = document) => r.querySelector(s);
const main = $('#main');

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtBytes = (n) => { if (n == null) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; };
const fmtDur = (s) => { if (s == null) return ''; const m = Math.floor(s / 60), x = Math.floor(s % 60); return `${m}:${String(x).padStart(2, '0')}`; };
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3500); }

const state = {
  view: 'library',
  offload: { sources: [], destinations: [], template: '{project}/Dia_{day}/{camera}_{reel}', project: 'Proyecto', camera: 'A', day: 1, algos: ['xxh64'], verify: true, mhl: true, report: '', transcode: '', ascmhl: false, s3: false, rename: '', script: '', running: false },
  progress: {}, // key -> {pct, label, done, ok}
  lib: { bin: null, smart: null, search: '', sel: new Set(), last: null, clips: [], bins: [], smarts: [], fields: [] },
  transcode: { preset: 'prores_proxy', height: '', lut: '', burnTimecode: false, burnName: false, dir: '', applyLooks: true, s3: false },
};

if (/Mac/i.test(navigator.platform)) document.body.classList.add('mac');
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
function go(view) {
  state.view = view;
  document.querySelectorAll('#top [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  render();
}
const views = { jobs: viewJobs, library: viewLibrary, verify: viewVerify }; // offload, transcode e informes se registran en app4.js
const SHEET_TITLES = { offload: 'Offload y workflow', jobs: 'Trabajos', compare: 'Comparar', audio: 'Audio', exchange: 'Intercambio', archive: 'Archivo', verify: 'Verificar', reports: 'Informes', transcode: 'Transcodificar', settings: 'Ajustes', stills: 'Stills por escena' };
function setSheet(open, title) { $('#sheet').hidden = !open; if (open) $('#sheetTitle').textContent = title || ''; }
let renderChain = Promise.resolve();
function render() { renderChain = renderChain.then(doRender, doRender); return renderChain; } // una vista termina de dibujarse antes de empezar la siguiente
async function doRender() {
  if (typeof floatsVisible === 'function') floatsVisible(state.view === 'library');
  if (state.view === 'library') { setSheet(false); await Promise.all([viewLibrary(), drawProjects()]); return; }
  setSheet(true, SHEET_TITLES[state.view]); main.replaceChildren(); main.scrollTop = 0; await views[state.view]();
}
$('#sheetClose').addEventListener('click', () => go('library'));
$('#sheet').addEventListener('mousedown', (e) => { if (e.target.id === 'sheet') go('library'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.view !== 'library' && !document.querySelector('dialog[open]')) go('library'); });

/* selector de proyecto y diseno QC */
async function drawProjects() {
  const sel = $('#projectSel'), [list, S] = await Promise.all([api.invoke('project:list'), api.invoke('settings:get')]);
  sel.replaceChildren(...list.map((p) => h('option', { value: p.id, selected: p.id === S.project }, p.name)), h('option', { value: '__new__' }, '＋ Nuevo proyecto…'));
}
$('#projectSel').addEventListener('change', async (e) => {
  if (e.target.value === '__new__') { await drawProjects(); return newProject(); }
  await api.invoke('project:switch', e.target.value); state.lib.sel.clear(); state.lib.bin = state.lib.smart = null; state.playerClipId = null; toast('Proyecto: ' + e.target.selectedOptions[0].textContent); render();
});
try { if (localStorage.getItem('cine.qc') === '1') document.body.classList.add('qc'); } catch { /* sin storage */ }
$('#qcBtn').setAttribute('aria-pressed', String(document.body.classList.contains('qc')));
$('#qcBtn').addEventListener('click', () => { const on = document.body.classList.toggle('qc'); $('#qcBtn').setAttribute('aria-pressed', String(on)); try { localStorage.setItem('cine.qc', on ? '1' : '0'); } catch { /* */ } });

/* barra de trabajos (abajo): resumen de lo que esta corriendo */
function drawJobsBar() {
  const active = Object.values(state.progress).filter((p) => !p.done);
  const bar = $('#jobsProg'), txt = $('#jobsText');
  if (active.length) {
    const pct = active.reduce((s, p) => s + (p.pct || 0), 0) / active.length;
    txt.textContent = `${active.length === 1 ? active[0].label : active.length + ' trabajos en curso'}`; bar.hidden = false; $('i', bar).style.transform = `scaleX(${pct / 100})`;
  } else if (state.tc) {
    txt.textContent = `Transcodificando ${state.tc.name}`; bar.hidden = false; $('i', bar).style.transform = `scaleX(${state.tc.p || 0})`;
  } else {
    const last = Object.values(state.progress).filter((p) => p.done).at(-1);
    txt.textContent = last ? `Último: ${last.label}` : 'Sin trabajos activos'; txt.className = last ? (last.ok ? 'ok' : 'bad') : 'mut'; bar.hidden = true;
  }
  if (active.length || state.tc) txt.className = '';
}

/* Dialogo modal sencillo (Electron no soporta window.prompt). fields: [{key,label,value,options?}] */
function askForm(title, fields) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { style: 'background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:18px;min-width:340px' });
    const inputs = {};
    const form = h('form', { method: 'dialog', class: 'col', style: 'gap:10px' }, h('b', {}, title),
      ...fields.map((f) => h('label', { class: 'f' }, f.label, inputs[f.key] = f.options
        ? h('select', {}, ...f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)))
        : h('input', { type: 'text', value: f.value ?? '' }))),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Cancelar'), h('button', { class: 'btn primary', value: 'ok' }, 'Aceptar')));
    dlg.append(form); document.body.append(dlg);
    dlg.addEventListener('close', () => { const ok = dlg.returnValue === 'ok'; const out = ok ? Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])) : null; dlg.remove(); resolve(out); });
    dlg.showModal(); Object.values(inputs)[0].focus();
  });
}

/* ---------- eventos del main ---------- */
let runningCount = 0;
api.on('library:clip', () => { if (state.view === 'library') refreshClips(); });
api.on('transcode:start', (e) => { state.tc = { name: e.name, p: 0 }; drawJobsBar(); });
api.on('transcode:progress', (e) => { if (state.tc) { state.tc.p = e.p; drawJobsBar(); } });
api.on('transcode:done', (e) => { state.tc = null; drawJobsBar(); toast(e.error ? `Error de transcode: ${e.error}` : `Transcode listo: ${e.out}`); });
api.on('transcode:error', (e) => { state.tc = null; drawJobsBar(); toast(`Error: ${e.error}`); });
api.on('transcode:summary', (e) => {
  state.tcResults = e.results; state.tcLog = e.logFile;
  const bad = e.results.filter((r) => r.error).length;
  toast(bad ? `Transcodificación terminada con ${bad} ${bad === 1 ? 'error' : 'errores'}. Mira el detalle en Transcodificar.` : `Transcodificación terminada: ${e.results.length} ${e.results.length === 1 ? 'clip' : 'clips'}. Están en la carpeta «Transcodes» de la biblioteca.`);
  if (state.view === 'transcode') render(); else if (state.view === 'library') refreshClips();
});
function updateBadge() { const b = $('#jobsBadge'); b.hidden = !runningCount; b.textContent = runningCount; drawJobsBar(); }

/* ---------- TRABAJOS ---------- */
async function viewJobs() {
  const jobs = await api.invoke('jobs:list');
  main.append(h('h1', {}, 'Trabajos'), h('div', { class: 'sub' }, 'Historial de offloads con su estado de verificacion.'));
  if (!jobs.length) return main.append(h('div', { class: 'empty' }, 'Todavía no hay trabajos. Haz un offload para empezar.'));
  const t = h('table', {}, h('thead', {}, h('tr', {}, ...['Fecha', 'Reel', 'Origen', 'Ficheros', 'Datos', 'Hash', 'Estado', ''].map((x) => h('th', {}, x)))));
  const tb = h('tbody');
  for (const j of jobs) {
    tb.append(h('tr', {}, h('td', {}, new Date(j.started).toLocaleString('es-ES')), h('td', {}, j.reel || ''), h('td', { title: j.sources.join('\n') }, (j.sources[0] || '').split(/[\\/]/).pop()),
      h('td', {}, String(j.fileCount)), h('td', {}, fmtBytes(j.totalBytes)), h('td', { class: 'mono' }, j.algos.join(',').toUpperCase()),
      h('td', { class: j.ok ? 'ok' : 'bad' }, j.ok ? 'Verificado' : `${j.failures} fallos`),
      h('td', {}, h('button', { class: 'btn', onclick: async () => { const f = await api.invoke('report:make', 'volume', { jobIds: [j.id], format: 'pdf' }); toast('Informe: ' + f); api.invoke('shell:reveal', f); } }, 'Informe'))));
  }
  t.append(tb); main.append(h('div', { class: 'card', style: 'padding:0;overflow:auto' }, t));
}

/* ---------- BIBLIOTECA ---------- */
async function refreshClips() {
  const L = state.lib;
  L.clips = await api.invoke('library:clips', { bin: L.bin, smartId: L.smart, search: L.search });
  const grid = $('#clipGrid'); if (grid) drawClips(grid);
  drawInspector();
}
async function viewLibrary() { return libraryScreen(); }
function drawGrid(grid) {
  const L = state.lib;
  if (!L.clips.length) return grid.replaceChildren(h('div', { class: 'empty', style: 'grid-column:1/-1' }, 'No hay clips. Haz un offload o cambia el filtro.'));
  grid.replaceChildren(...L.clips.map((c, idx) => h('div', { class: 'clip' + (L.sel.has(c.id) ? ' sel' : ''), tabindex: 0, onclick: (e) => selectClip(c, idx, e), ondblclick: () => play(c) },
    h('div', { class: 'th' }, c.thumb ? h('img', { src: thumbSrc(c), alt: '', loading: 'lazy' }) : (c.kind === 'video' ? 'Analizando…' : c.kind)),
    h('div', { class: 'meta' }, h('b', { title: c.name }, c.name),
      h('span', { class: 'mut' }, [c.meta?.width ? `${c.meta.width}×${c.meta.height}` : '', c.meta?.fps ? `${+c.meta.fps.toFixed(2)}p` : '', fmtDur(c.meta?.duration)].filter(Boolean).join(' · ') || fmtBytes(c.size)),
      h('div', {}, h('span', { class: c.flag ? 'flag-' + c.flag : 'mut' }, c.flag ? { good: '✔ Bueno', bad: '✖ Malo', hold: '● Pendiente', circled: '◯ Circled' }[c.flag] : ''), c.rating ? h('span', { class: 'warn' }, ' ' + '★'.repeat(c.rating)) : '', c.verified && c.verified !== 'verified' ? h('span', { class: 'bad' }, ' ' + c.verified) : '')))));
}
function selectClip(c, idx, e) {
  const L = state.lib;
  if (e.shiftKey && L.last != null) { const [a, b] = [Math.min(L.last, idx), Math.max(L.last, idx)]; L.clips.slice(a, b + 1).forEach((x) => L.sel.add(x.id)); }
  else if (e.ctrlKey || e.metaKey) { L.sel.has(c.id) ? L.sel.delete(c.id) : L.sel.add(c.id); L.last = idx; }
  else { L.sel = new Set([c.id]); L.last = idx; }
  drawClips($('#clipGrid')); drawInspector();
}
async function play(c) {
  const box = $('#player'); if (!box) return;
  box.replaceChildren(h('div', { class: 'mut' }, 'Preparando reproducción…'));
  try {
    const s = await api.invoke('playback:source', c.id);
    state.player?.destroy();
    const host = state.playerHost = h('div'); state.playerClipId = c.id;
    box.replaceChildren(host, s.proxy ? h('div', { class: 'mut' }, 'Reproduciendo proxy H.264') : '');
    const p = state.player = new CinePlayer(host, { fps: c.meta?.fps });
    p.load(s.url); p.setLook(c.look); p.setTransform(c.transform || {});
    if (c.look?.lut) p.setLut(await api.invoke('lut:read', c.look.lut)).catch?.(() => {});
    p.onStill = async (t) => { try { const r = await api.invoke('stills:capture', { clipId: c.id, t }); toast(`Still guardado en ${r.scene ? 'la escena ' + r.scene : 'Sin escena'}. Míralo en Stills.`); } catch (e) { toast('Error: ' + errText(e)); } };
    p.onThumb = async (t) => { try { await api.invoke('thumb:set', c.id, t); toast('Miniatura actualizada'); refreshClips(); } catch (e) { toast('Error: ' + errText(e)); } };
    p.video.play().catch(() => {});
  } catch (err) {
    box.replaceChildren(h('div', { class: 'bad' }, errText(err)), h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn', onclick: () => go('archive') }, 'Ir a Relink'),
      h('button', { class: 'btn danger', onclick: async () => { if (!confirm(`¿Quitar «${c.name}» de la biblioteca? El fichero no se borra.`)) return; await api.invoke('library:remove', [c.id]); state.lib.sel.delete(c.id); state.playerClipId = null; toast('Clip quitado de la biblioteca'); render(); } }, 'Quitar de la biblioteca')));
  }
}
const COLORS = ['', '#ef5b5b', '#f0b13c', '#34c47c', '#4c8dff', '#8a5cff'];
function drawInspector() {
  const L = state.lib, box = $('#inspector'); if (!box) return;
  const sel = L.clips.filter((c) => L.sel.has(c.id));
  if (!sel.length) { if (typeof floatsIdle === 'function') floatsIdle(); return box.replaceChildren(h('div', { class: 'empty' }, 'Selecciona un clip. Doble clic para reproducir.')); }
  const one = sel.length === 1 ? sel[0] : null;
  const patch = async (p) => { await api.invoke('library:bulk', sel.map((c) => c.id), p); refreshClips(); };
  const field = (label, key, w) => h('label', { class: 'f', style: w ? `width:${w}` : 'flex:1' }, label, h('input', { type: 'text', value: one ? one[key] ?? '' : '', placeholder: one ? '' : '(varios)', onchange: (e) => patch({ [key]: e.target.value }) }));
  const reuse = one && state.playerClipId === one.id && state.playerHost;
  const playerBox = h('div', { id: 'player' }, reuse ? state.playerHost : one?.kind === 'video' ? h('button', { class: 'btn', onclick: () => play(one) }, 'Reproducir') : '');
  const kids = [placePanel('player', 'Reproductor', playerBox)];
  kids.push(h('h2', {}, one ? one.name : `${sel.length} clips`));
  kids.push(h('div', { class: 'row' }, ...[['good', '✔ Bueno'], ['bad', '✖ Malo'], ['hold', '● Pend.'], ['circled', '◯ Circled'], ['', 'Quitar']].map(([f, l]) => h('button', { class: 'btn', onclick: () => patch({ flag: f }) }, l))));
  kids.push(h('div', { class: 'stars', style: 'margin:6px 0' }, ...[1, 2, 3, 4, 5].map((n) => h('button', { class: one && one.rating >= n ? 'on' : '', 'aria-label': n + ' estrellas', onclick: () => patch({ rating: one && one.rating === n ? 0 : n }) }, '★'))));
  kids.push(h('div', { class: 'colors' }, ...COLORS.map((c) => h('button', { 'aria-label': 'Color ' + (c || 'ninguno'), style: `background:${c || 'transparent'};border-color:${one && one.color === c ? '#fff' : c ? 'transparent' : '#444'}`, onclick: () => patch({ color: c }) }))));
  kids.push(h('div', { class: 'row', style: 'margin-top:10px' }, field('Escena', 'scene', '30%'), field('Plano', 'shot', '30%'), field('Toma', 'take', '30%')));
  kids.push(h('div', { class: 'row', style: 'margin-top:8px' }, field('Cámara', 'camera'), field('Reel', 'reel'), field('ShotID', 'shotId')));
  kids.push(placePanel('color', 'Color y transformación', typeof colorPanel === 'function' && sel.some((c) => c.kind === 'video') ? colorPanel(sel, one) : null));
  kids.push(h('label', { class: 'f', style: 'margin-top:8px' }, 'Notas', h('textarea', { onchange: (e) => patch({ notes: e.target.value }) }, one?.notes || '')));
  if (L.fields.length) kids.push(h('h2', {}, 'Campos personalizados'), ...L.fields.map((f) => h('label', { class: 'f', style: 'margin-bottom:6px' }, f, h('input', { type: 'text', value: one?.custom?.[f] ?? '', onchange: (e) => patch({ custom: { [f]: e.target.value } }) }))));
  kids.push(h('button', { class: 'btn', style: 'margin-top:8px', onclick: async () => { const r = await askForm('Campo personalizado', [{ key: 'n', label: 'Nombre del campo' }]); if (r?.n) { await api.invoke('library:fields:add', r.n); render(); } } }, '+ Campo personalizado'));
  if (one) {
    const m = one.meta || {};
    const rows = [['Codec', [m.codec, m.profile].filter(Boolean).join(' ')], ['Resolución', m.width ? `${m.width}×${m.height}` : ''], ['FPS', m.fps ? +m.fps.toFixed(3) : ''], ['Timecode', m.timecode], ['Duración', fmtDur(m.duration)], ['Audio', m.audioTracks ? `${m.audioTracks} pistas / ${m.audioChannels} canales` : ''], ['Tamaño', fmtBytes(one.size)], ['Estado', one.verified], ...Object.entries(one.hashes || {}).map(([a, v]) => [a.toUpperCase(), v]), ['Ruta', one.path]];
    kids.push(h('h2', {}, 'Información'), h('table', {}, ...rows.filter((r) => r[1] !== '' && r[1] != null).map(([k, v]) => h('tr', {}, h('td', { class: 'mut', style: 'width:84px' }, k), h('td', { class: 'mono', style: 'word-break:break-all' }, String(v))))));
    kids.push(h('button', { class: 'btn', style: 'margin-top:8px', onclick: () => api.invoke('shell:reveal', one.path) }, 'Mostrar en carpeta'));
  }
  box.replaceChildren(...kids);
}
async function smartDialog() {
  const fields = ['flag', 'rating', 'scene', 'shot', 'take', 'camera', 'reel', 'codec', 'fps', 'width', 'height', 'timecode', 'notes', 'verified', ...state.lib.fields].map((f) => [f, f]);
  const ops = [['eq', 'es igual a'], ['neq', 'distinto de'], ['contains', 'contiene'], ['not_contains', 'no contiene'], ['gt', 'mayor que'], ['lt', 'menor que'], ['empty', 'vacio'], ['not_empty', 'no vacio']];
  const r = await askForm('Nueva carpeta inteligente', [{ key: 'name', label: 'Nombre' }, { key: 'field', label: 'Campo', options: fields, value: 'flag' }, { key: 'op', label: 'Condición', options: ops, value: 'eq' }, { key: 'value', label: 'Valor (ej. good, 4, 24)' }]);
  if (!r || !r.name) return;
  await api.invoke('library:smart:add', { name: r.name, match: 'all', rules: [{ field: r.field, op: r.op, value: r.value }] });
  toast('Carpeta inteligente creada'); render();
}

/* ---------- VERIFICAR ---------- */
async function viewVerify() {
  const v = state.verify || (state.verify = { root: '', mhl: '', res: null, running: false });
  main.append(h('h1', {}, 'Verificar'), h('div', { class: 'sub' }, 'Comprueba una carpeta ya copiada contra una lista MHL: detecta ficheros alterados o ausentes.'),
    h('div', { class: 'card col' },
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const [p] = await api.invoke('dialog:folder', false); if (p) { v.root = p; render(); } } }, 'Carpeta a verificar…'), h('span', { class: 'mono mut' }, v.root || 'sin seleccionar')),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const p = await api.invoke('dialog:file', [{ name: 'MHL', extensions: ['mhl'] }]); if (p) { v.mhl = p; render(); } } }, 'Lista MHL…'), h('span', { class: 'mono mut' }, v.mhl || 'sin seleccionar')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', disabled: !v.root || !v.mhl || v.running, onclick: async () => {
        v.running = true; v.res = null; render();
        try { v.res = await api.invoke('verify:folder', v.root, v.mhl); } catch (e) { toast('Error: ' + e.message); }
        v.running = false; render();
      } }, v.running ? 'Verificando…' : 'Verificar'))),
    h('div', { class: 'bar', id: 'vbar', style: 'margin-top:12px' }, h('i')));
  if (v.res) {
    const bad = v.res.filter((r) => r.status !== 'ok');
    main.append(h('h2', {}, bad.length ? `${bad.length} problemas de ${v.res.length}` : `Todo correcto (${v.res.length} ficheros)`),
      h('div', { class: 'card', style: 'padding:0' }, h('table', {}, h('tbody', {}, ...v.res.map((r) => h('tr', {}, h('td', {}, r.rel), h('td', { class: r.status === 'ok' ? 'ok' : 'bad' }, r.status)))))));
  }
}
api.on('verify:progress', (p) => { const i = $('#vbar i'); if (i) i.style.transform = `scaleX(${p.totalBytes ? p.doneBytes / p.totalBytes : 1})`; });

