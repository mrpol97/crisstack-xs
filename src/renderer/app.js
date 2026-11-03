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
const views = { offload: viewOffload, jobs: viewJobs, library: viewLibrary, verify: viewVerify, reports: viewReports, transcode: viewTranscode };
const SHEET_TITLES = { offload: 'Offload y workflow', jobs: 'Trabajos', compare: 'Comparar', audio: 'Audio', exchange: 'Intercambio', archive: 'Archivo', verify: 'Verificar', reports: 'Informes', transcode: 'Transcodificar', settings: 'Ajustes' };
function setSheet(open, title) { $('#sheet').hidden = !open; if (open) $('#sheetTitle').textContent = title || ''; }
async function render() {
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
$('#qcBtn').addEventListener('click', () => { const on = document.body.classList.toggle('qc'); try { localStorage.setItem('cine.qc', on ? '1' : '0'); } catch { /* */ } });

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
api.on('job:start', (e) => { state.progress[e.key] = { pct: 0, label: `${e.reel}: preparando`, done: false }; runningCount++; updateBadge(); if (state.view === 'offload') renderProgress(); });
api.on('job:progress', (e) => {
  const p = state.progress[e.key]; if (!p) return;
  p.pct = e.totalBytes ? (e.doneBytes / e.totalBytes) * 100 : 100;
  p.label = `${e.phase === 'verify' ? 'Verificando' : e.phase === 'done' ? 'Listo' : 'Copiando'} · ${e.current || ''}`;
  drawJobsBar();
  if (state.view === 'offload') renderProgress();
});
api.on('job:done', (e) => {
  const p = state.progress[e.key] || (state.progress[e.key] = {});
  p.pct = 100; p.done = true; p.ok = e.ok; p.label = e.ok ? 'Copiado y verificado' : (e.error || `${e.failures} fallos de verificacion`);
  runningCount = Math.max(0, runningCount - 1); updateBadge();
  toast(e.ok ? 'Offload completado y verificado' : `Offload con problemas: ${p.label}`);
  if (state.view === 'offload') renderProgress();
});
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

/* ---------- OFFLOAD ---------- */
async function viewOffload() {
  const o = state.offload;
  const vols = await api.invoke('volumes:list');
  const presets = await api.invoke('presets:list');
  const wfs = await api.invoke('workflows:list');
  const P = await api.invoke('project:get'); const pinfo = P.info; if (pinfo?.name) o.project = pinfo.name; // el proyecto activo manda
  const list = (arr, key) => h('div', { class: 'list' }, arr.length ? arr.map((p, i) => h('div', { class: 'item' }, h('span', { title: p }, p), h('button', { class: 'x', 'aria-label': 'Quitar', onclick: () => { arr.splice(i, 1); render(); } }, '×'))) : h('div', { class: 'mut' }, key === 'src' ? 'Añade una tarjeta o carpeta de origen.' : 'Añade al menos un destino. Con varios destinos se hace backup redundante.'));
  const algo = (id, label) => h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: o.algos.includes(id), onchange: (e) => { o.algos = e.target.checked ? [...new Set([...o.algos, id])] : o.algos.filter((x) => x !== id); if (!o.algos.length) { o.algos = ['xxh64']; render(); } } }), label);
  const preview = h('div', { class: 'mono mut' });
  const upd = async () => { preview.textContent = 'Ejemplo: ' + await api.invoke('wildcards:preview', o.template, { project: o.project, day: o.day, camera: o.camera, source: o.sources[0] || 'A001' }); };
  const bind = (key, type = 'text') => ({ value: o[key], oninput: (e) => { o[key] = type === 'number' ? Number(e.target.value) : e.target.value; upd(); } });

  main.append(
    h('h1', {}, 'Offload'), h('div', { class: 'sub' }, 'Copia con checksum a varios destinos a la vez y verifica releyendo cada copia.'),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Origen'), list(o.sources, 'src'),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { o.sources.push(...(await api.invoke('dialog:folder', true))); render(); } }, 'Añadir carpeta…'),
          ...vols.slice(0, 6).map((v) => h('button', { class: 'btn', title: v.path, onclick: () => { if (!o.sources.includes(v.path)) o.sources.push(v.path); render(); } }, v.name)))),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Destinos'), list(o.destinations, 'dst'),
        h('button', { class: 'btn', onclick: async () => { o.destinations.push(...(await api.invoke('dialog:folder', true))); render(); } }, 'Añadir destino…'))),
    h('h2', {}, 'Estructura de carpetas'),
    h('div', { class: 'card col' },
      h('div', { class: 'row' },
        h('label', { class: 'f', style: 'flex:2;min-width:260px' }, 'Plantilla (comodines)', h('input', { type: 'text', ...bind('template') })),
        h('label', { class: 'f', title: 'Se cambia en Biblioteca → Editar proyecto' }, 'Proyecto (enlazado)', pinfo?.name ? h('input', { type: 'text', value: pinfo.name, disabled: true }) : h('input', { type: 'text', ...bind('project') })),
        h('label', { class: 'f', style: 'width:90px' }, 'Cámara', h('input', { type: 'text', ...bind('camera') })),
        h('label', { class: 'f', style: 'width:80px' }, 'Día', h('input', { type: 'number', min: 1, ...bind('day', 'number') }))),
      preview,
      pinfo?.name ? h('div', { class: 'projlink' }, h('b', {}, 'Proyecto: '), pinfo.name, ...[['production', ''], ['director', 'Dir. '], ['dit', 'DIT '], ['dataManager', 'Data manager ']].filter(([k]) => pinfo[k]).map(([k, p]) => h('span', { class: 'mut' }, ` · ${p}${pinfo[k]}`)),
        h('span', { class: 'mut' }, ' — estos datos salen en los informes y en la lista MHL.'), h('button', { class: 'btn', style: 'margin-left:8px', onclick: async () => { await editProject(); render(); } }, 'Editar'))
        : h('div', { class: 'projlink warn' }, 'Aún no hay proyecto. ', h('button', { class: 'btn', onclick: newProject }, 'Crear proyecto'), ' para enlazar nombre, equipo y logo con el offload y los informes.'),
      h('div', { class: 'mut' }, 'Comodines: {project} {day} {camera} {reel} {card} {volume} {date} {yyyy} {mm} {dd} {time} {counter}')),
    h('h2', {}, 'Verificación y post-pasos'),
    h('div', { class: 'card col' },
      h('div', { class: 'chips' }, algo('xxh64', 'XXH64'), algo('md5', 'MD5'), algo('sha1', 'SHA-1'), algo('sha256', 'SHA-256'),
        h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: o.verify, onchange: (e) => (o.verify = e.target.checked) }), 'Releer y verificar destinos'),
        h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: o.mhl, onchange: (e) => (o.mhl = e.target.checked) }), 'Escribir lista MHL')),
      h('div', { class: 'row' },
        h('label', { class: 'f' }, 'Informe al terminar', h('select', { onchange: (e) => (o.report = e.target.value) }, ...[['', 'Ninguno'], ['volume', 'Volumen (PDF)'], ['shooting_day', 'Día de rodaje (PDF)'], ['contact_print', 'Contact print (PDF)']].map(([v, l]) => h('option', { value: v, selected: o.report === v }, l)))),
        h('label', { class: 'f' }, 'Transcodificar al terminar', h('select', { onchange: (e) => (o.transcode = e.target.value) }, h('option', { value: '' }, 'No'), ...presets.map((p) => h('option', { value: p.id, selected: o.transcode === p.id }, p.label)))))),
    h('div', { class: 'card col', style: 'margin-top:10px' },
      h('div', { class: 'chips' },
        h('label', { class: 'chip', title: 'Historial ASC MHL en cada carpeta de destino' }, h('input', { type: 'checkbox', checked: o.ascmhl, onchange: (e) => (o.ascmhl = e.target.checked) }), 'Sellar con ASC MHL'),
        h('label', { class: 'chip', title: 'Sube los transcodes al bucket configurado en Ajustes' }, h('input', { type: 'checkbox', checked: o.s3, onchange: (e) => (o.s3 = e.target.checked) }), 'Subir transcodes a S3')),
      h('div', { class: 'row' },
        h('label', { class: 'f', style: 'flex:1;min-width:240px' }, 'Renombrar ficheros al copiar (opcional)', h('input', { type: 'text', value: o.rename, placeholder: '{reel}_{counter:3}  ·  tokens: {name} {ext} {reel} {camera} {project} {counter:N} {date}', oninput: (e) => (o.rename = e.target.value) })),
        h('label', { class: 'f', style: 'flex:1;min-width:240px' }, 'Script al terminar (opcional)', h('input', { type: 'text', value: o.script, placeholder: 'Variables: CINESTACK_REEL, CINESTACK_DEST', oninput: (e) => (o.script = e.target.value) }))),
      h('div', { class: 'row' },
        h('label', { class: 'f' }, 'Workflow guardado', h('select', { id: 'wfSel' }, h('option', { value: '' }, '—'), ...wfs.map((w) => h('option', { value: w.name }, w.name)))),
        h('button', { class: 'btn', style: 'align-self:end', onclick: () => { const w = wfs.find((x) => x.name === $('#wfSel').value); if (w) { Object.assign(o, w.cfg); render(); toast('Workflow cargado'); } } }, 'Cargar'),
        h('button', { class: 'btn', style: 'align-self:end', onclick: async () => { const r = await askForm('Guardar workflow', [{ key: 'n', label: 'Nombre' }]); if (r?.n) { const { sources, running, ...cfg } = o; await api.invoke('workflows:save', { name: r.n, cfg: JSON.parse(JSON.stringify(cfg)) }); toast('Workflow guardado'); render(); } } }, 'Guardar actual'))),
    h('div', { class: 'row', style: 'margin-top:16px' },
      h('button', { class: 'btn primary', disabled: !o.sources.length || !o.destinations.length || o.running, onclick: start }, o.running ? 'En curso…' : 'Iniciar offload'),
      h('button', { class: 'btn danger', disabled: !o.running, onclick: () => api.invoke('job:cancel') }, 'Cancelar')),
    h('div', { id: 'progress', style: 'margin-top:16px' }));
  upd(); renderProgress();
}
function renderProgress() {
  const box = $('#progress'); if (!box) return;
  box.replaceChildren(...Object.entries(state.progress).slice(-6).map(([, p]) => h('div', { class: 'card', style: 'margin-bottom:8px' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { class: p.done ? (p.ok ? 'ok' : 'bad') : '' }, p.label || ''), h('span', { class: 'mut' }, Math.round(p.pct || 0) + '%')),
    h('div', { class: 'bar', style: 'margin-top:6px' }, h('i', { style: `transform:scaleX(${(p.pct || 0) / 100})` })))));
}
async function start() {
  const o = state.offload; o.running = true; state.progress = {}; render();
  const cfg = { sources: o.sources, destinations: o.destinations, template: o.template, project: o.project, camera: o.camera, day: o.day, algos: o.algos, verify: o.verify, mhl: o.mhl,
    report: o.report ? { type: o.report, format: 'pdf' } : null, transcode: o.transcode ? { preset: o.transcode, s3: o.s3 } : null,
    ascmhl: o.ascmhl, rename: o.rename || undefined, script: o.script || undefined };
  try { await api.invoke('workflow:start', cfg); } catch (e) { toast('Error: ' + e.message); }
  o.running = false; if (state.view === 'offload') { const keep = { ...state.progress }; await render(); state.progress = keep; renderProgress(); }
}

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
    h('div', { class: 'th' }, c.thumb ? h('img', { src: `cine://thumb/${c.id}`, alt: '', loading: 'lazy' }) : (c.kind === 'video' ? 'Analizando…' : c.kind)),
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
    p.onStill = async (t) => { try { toast('Still guardado: ' + await api.invoke('still:export', c.id, t, 'jpeg')); } catch (e) { toast('Error: ' + e.message); } };
    p.onThumb = async (t) => { await api.invoke('thumb:set', c.id, t); toast('Miniatura actualizada'); refreshClips(); };
    p.video.play().catch(() => {});
  } catch (err) { box.replaceChildren(h('div', { class: 'bad' }, err.message)); }
}
const COLORS = ['', '#ef5b5b', '#f0b13c', '#34c47c', '#4c8dff', '#8a5cff'];
function drawInspector() {
  const L = state.lib, box = $('#inspector'); if (!box) return;
  const sel = L.clips.filter((c) => L.sel.has(c.id));
  if (!sel.length) return box.replaceChildren(h('div', { class: 'empty' }, 'Selecciona un clip. Doble clic para reproducir.'));
  const one = sel.length === 1 ? sel[0] : null;
  const patch = async (p) => { await api.invoke('library:bulk', sel.map((c) => c.id), p); refreshClips(); };
  const field = (label, key, w) => h('label', { class: 'f', style: w ? `width:${w}` : 'flex:1' }, label, h('input', { type: 'text', value: one ? one[key] ?? '' : '', placeholder: one ? '' : '(varios)', onchange: (e) => patch({ [key]: e.target.value }) }));
  const reuse = one && state.playerClipId === one.id && state.playerHost;
  const kids = [h('div', { id: 'player' }, reuse ? state.playerHost : one?.kind === 'video' ? h('button', { class: 'btn', onclick: () => play(one) }, 'Reproducir') : '')];
  kids.push(h('h2', {}, one ? one.name : `${sel.length} clips`));
  kids.push(h('div', { class: 'row' }, ...[['good', '✔ Bueno'], ['bad', '✖ Malo'], ['hold', '● Pend.'], ['circled', '◯ Circled'], ['', 'Quitar']].map(([f, l]) => h('button', { class: 'btn', onclick: () => patch({ flag: f }) }, l))));
  kids.push(h('div', { class: 'stars', style: 'margin:6px 0' }, ...[1, 2, 3, 4, 5].map((n) => h('button', { class: one && one.rating >= n ? 'on' : '', 'aria-label': n + ' estrellas', onclick: () => patch({ rating: one && one.rating === n ? 0 : n }) }, '★'))));
  kids.push(h('div', { class: 'colors' }, ...COLORS.map((c) => h('button', { 'aria-label': 'Color ' + (c || 'ninguno'), style: `background:${c || 'transparent'};border-color:${one && one.color === c ? '#fff' : c ? 'transparent' : '#444'}`, onclick: () => patch({ color: c }) }))));
  kids.push(h('div', { class: 'row', style: 'margin-top:10px' }, field('Escena', 'scene', '30%'), field('Plano', 'shot', '30%'), field('Toma', 'take', '30%')));
  kids.push(h('div', { class: 'row', style: 'margin-top:8px' }, field('Cámara', 'camera'), field('Reel', 'reel'), field('ShotID', 'shotId')));
  if (typeof colorPanel === 'function' && sel.some((c) => c.kind === 'video')) kids.push(colorPanel(sel, one));
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

/* ---------- INFORMES ---------- */
async function viewReports() {
  const r = state.rep || (state.rep = { type: 'shooting_day', format: 'pdf', dark: false, project: 'Proyecto', day: '' });
  const sel = (key, opts) => h('select', { onchange: (e) => (r[key] = e.target.value) }, ...opts.map(([v, l]) => h('option', { value: v, selected: r[key] === v }, l)));
  main.append(h('h1', {}, 'Informes'), h('div', { class: 'sub' }, 'Genera informes en PDF o HTML a partir de la biblioteca y del historial de trabajos.'),
    h('div', { class: 'card col' }, h('div', { class: 'row' },
      h('label', { class: 'f' }, 'Tipo', sel('type', [['shooting_day', 'Día de rodaje'], ['clips', 'Clips'], ['thumbnails', 'Miniaturas'], ['contact_print', 'Contact print'], ['volume', 'Volumen / checksums']])),
      h('label', { class: 'f' }, 'Formato', sel('format', [['pdf', 'PDF'], ['html', 'HTML']])),
      h('label', { class: 'f' }, 'Proyecto', h('input', { type: 'text', value: r.project, oninput: (e) => (r.project = e.target.value) })),
      h('label', { class: 'f', style: 'width:80px' }, 'Día', h('input', { type: 'text', value: r.day, oninput: (e) => (r.day = e.target.value) })),
      h('label', { class: 'chip', style: 'align-self:end' }, h('input', { type: 'checkbox', checked: r.dark, onchange: (e) => (r.dark = e.target.checked) }), 'Tema oscuro')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
        const ids = [...state.lib.sel];
        try { const f = await api.invoke('report:make', r.type, { ...r, clipIds: ids }); toast('Informe generado'); api.invoke('shell:open', f); } catch (e) { toast('Error: ' + e.message); }
      } }, 'Generar'), h('span', { class: 'mut' }, state.lib.sel.size ? `Se usaran los ${state.lib.sel.size} clips seleccionados en Biblioteca.` : 'Se usaran todos los clips de la biblioteca.'))));
}

/* ---------- TRANSCODIFICAR ---------- */
async function viewTranscode() {
  const t = state.transcode, presets = await api.invoke('presets:list');
  const clips = await api.invoke('library:clips', {});
  const ids = state.lib.sel.size ? [...state.lib.sel] : clips.filter((c) => c.kind === 'video').map((c) => c.id);
  main.append(h('h1', {}, 'Transcodificar'), h('div', { class: 'sub' }, `Se transcodificaran ${ids.length} clips${state.lib.sel.size ? ' seleccionados' : ' (toda la biblioteca)'}.`),
    h('div', { class: 'card col' },
      h('div', { class: 'row' },
        h('label', { class: 'f' }, 'Preset', h('select', { onchange: (e) => (t.preset = e.target.value) }, ...presets.map((p) => h('option', { value: p.id, selected: t.preset === p.id }, p.label)))),
        h('label', { class: 'f', style: 'width:130px' }, 'Alto (px, opc.)', h('input', { type: 'number', value: t.height, placeholder: 'original', oninput: (e) => (t.height = e.target.value) }))),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const p = await api.invoke('dialog:file', [{ name: 'LUT 3D', extensions: ['cube', '3dl'] }]); if (p) { t.lut = p; render(); } } }, 'LUT .cube…'), h('span', { class: 'mono mut' }, t.lut || 'sin LUT'), t.lut ? h('button', { class: 'btn', onclick: () => { t.lut = ''; render(); } }, 'Quitar') : ''),
      h('div', { class: 'chips' },
        h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: t.burnTimecode, onchange: (e) => (t.burnTimecode = e.target.checked) }), 'Timecode quemado'),
        h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: t.burnName, onchange: (e) => (t.burnName = e.target.checked) }), 'Nombre de clip quemado'),
        h('label', { class: 'chip', title: 'Aplica el CDL y la LUT de cada clip, y su recorte/giro' }, h('input', { type: 'checkbox', checked: t.applyLooks, onchange: (e) => (t.applyLooks = e.target.checked) }), 'Aplicar looks y transformación'),
        h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: t.s3, onchange: (e) => (t.s3 = e.target.checked) }), 'Subir a S3')),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const [p] = await api.invoke('dialog:folder', false); if (p) { t.dir = p; render(); } } }, 'Carpeta de salida…'), h('span', { class: 'mono mut' }, t.dir || 'Documentos/Cinestack Transcodes')),
      h('div', {}, h('button', { class: 'btn primary', disabled: !ids.length, onclick: () => { api.invoke('transcode:start', ids, { ...t, height: t.height ? Number(t.height) : undefined, lut: t.lut || undefined, dir: t.dir || undefined }); toast('Transcodificación en cola'); } }, 'Iniciar'),
        h('button', { class: 'btn', disabled: ids.length < 2, title: 'Une los clips en un solo fichero', onclick: async () => { try { toast('Creando clip combinado…'); const f = await api.invoke('combine:run', ids, t.preset, t.height ? Number(t.height) : undefined); toast('Clip combinado: ' + f); api.invoke('shell:reveal', f); } catch (e) { toast('Error: ' + e.message); } } }, 'Unir en un clip'))));
  if (state.tcResults?.length) main.append(h('h2', {}, 'Último resultado'), h('div', { class: 'card', style: 'padding:0' }, h('table', {}, h('thead', {}, h('tr', {}, ...['Clip', 'Resultado', 'Tamaño', 'Fichero'].map((x) => h('th', {}, x)))),
    h('tbody', {}, ...state.tcResults.map((r) => h('tr', {}, h('td', {}, r.name), h('td', { class: r.error ? 'bad' : 'ok' }, r.error ? r.error : 'Correcto'), h('td', {}, r.size ? fmtBytes(r.size) : '—'), h('td', { class: 'mono mut', style: 'word-break:break-all' }, r.out || '—')))))),
    state.tcResults.some((r) => r.out) ? h('button', { class: 'btn', style: 'margin-top:8px', onclick: () => api.invoke('shell:reveal', state.tcResults.find((r) => r.out).out) }, 'Mostrar en carpeta') : '',
    state.tcResults.some((r) => r.error) ? h('div', { class: 'mut', style: 'margin-top:6px' }, 'Registro de errores: ' + state.tcLog) : '');
}

