'use strict';
/* v0.3: ficha de proyecto, carpetas en arbol, importar y tres vistas de biblioteca (lista, miniaturas, carpetas). */
Object.assign(state.lib, { mode: 'grid', open: new Set(), closed: new Set(), sort: { col: 'name', dir: 1 }, loaded: false });
try { const m = localStorage.getItem('cine.mode'); if (['list', 'grid', 'folders'].includes(m)) state.lib.mode = m; } catch { /* sin storage */ }

/* ---------- ficha de proyecto ---------- */
const PROJECT_FIELDS = [
  ['director', 'Director'], ['cinematographer', 'Director de fotografía'], ['cameraAssistant', 'Ayudante de cámara (1.º)'], ['cameraAssistant2', 'Ayudante de cámara (2.º)'],
  ['dit', 'DIT'], ['dataManager', 'Data manager'], ['soundMixer', 'Sonido (sound mixer)'], ['scriptSupervisor', 'Script supervisor'],
  ['producer', 'Productor'], ['production', 'Productora'], ['location', 'Localización'], ['copyright', 'Copyright'],
];

function projectForm(initial = {}, title = 'Proyecto') {
  return new Promise((resolve) => {
    const v = { ...initial }; let done = false;
    const dlg = h('dialog', { class: 'pform' });
    const err = h('div', { class: 'bad', role: 'alert' });
    const logoBox = h('div', { class: 'logobox' });
    const drawLogo = () => logoBox.replaceChildren(v.logo ? h('img', { src: v.logo, alt: 'Logo' }) : h('span', { class: 'mut' }, 'Sin logo'));
    drawLogo();
    const inp = (key, label, ph = '') => h('label', { class: 'f' }, label, h('input', { type: 'text', value: v[key] || '', placeholder: ph, oninput: (e) => (v[key] = e.target.value) }));
    const close = (val) => { if (done) return; done = true; dlg.close(); dlg.remove(); resolve(val); };
    dlg.append(h('form', { class: 'col', style: 'gap:12px', onsubmit: (e) => e.preventDefault() },
      h('b', { style: 'font-size:15px' }, title),
      h('div', { class: 'pgrid' }, h('div', { style: 'grid-column:1/-1' }, inp('name', 'Nombre del proyecto *', 'p. ej. La casa de papel')), ...PROJECT_FIELDS.slice(0, 11).map(([k, l]) => inp(k, l)),
        h('div', { style: 'grid-column:1/-1' }, inp('copyright', 'Copyright', '© 2026 Productora S.L. Todos los derechos reservados'))),
      h('div', { class: 'row', style: 'align-items:center;gap:14px' }, logoBox,
        h('div', { class: 'col' }, h('div', { class: 'mut' }, 'Logo de la producción (PNG, JPG, SVG o WebP, máx. 1,5 MB). Sale en los informes junto al nombre de la productora.'),
          h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: async () => { try { const d = await api.invoke('logo:pick'); if (d) { v.logo = d; drawLogo(); err.textContent = ''; } } catch (e) { err.textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); } } }, 'Elegir logo…'),
            h('button', { type: 'button', class: 'btn', onclick: () => { v.logo = ''; drawLogo(); } }, 'Quitar logo')))),
      err,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Cancelar'),
        h('button', { type: 'submit', class: 'btn primary', onclick: (ev) => { ev.preventDefault(); if (!String(v.name || '').trim()) { err.textContent = 'Escribe el nombre del proyecto.'; return; } close(v); } }, 'Guardar'))));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dlg); dlg.showModal(); dlg.querySelector('input').focus();
  });
}
async function newProject() {
  const info = await projectForm({}, 'Nuevo proyecto'); if (!info) return;
  try { await api.invoke('project:create', info); state.lib.sel.clear(); state.lib.bin = state.lib.smart = null; state.playerClipId = null; toast(`Proyecto «${info.name}» creado`); go('library'); render(); }
  catch (e) { toast('Error: ' + e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
}
async function editProject() {
  const P = await api.invoke('project:get'); const info = await projectForm(P.info || {}, 'Editar proyecto'); if (!info) return;
  try { await api.invoke('project:update', info); toast('Proyecto actualizado'); render(); } catch (e) { toast('Error: ' + e.message); }
}

/* ---------- columnas de la vista lista ---------- */
const cam = (c, k) => c.cam?.[k] ?? c.meta?.camera?.[k] ?? '';
const dateStr = (s) => { if (!s) return ''; const d = new Date(s); return isNaN(d) ? String(s) : d.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }); };
const hms = (s) => { if (s == null) return ''; const h2 = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60); return [h2, m, x].map((n) => String(n).padStart(2, '0')).join(':'); };
const frames = (c) => (c.meta?.duration && c.meta?.fps ? Math.round(c.meta.duration * c.meta.fps) : '');
const tcFrames = (tc, fps) => { const [a, b, s, f] = String(tc).split(/[:;]/).map(Number); return ((a * 60 + b) * 60 + s) * Math.round(fps) + (f || 0); };
const tcFmt = (n, fps) => { const r = Math.round(fps), f = n % r, s = Math.floor(n / r) % 60, m = Math.floor(n / (r * 60)) % 60, hh = Math.floor(n / (r * 3600)); return [hh, m, s, f].map((x) => String(x).padStart(2, '0')).join(':'); };
const tcEnd = (c) => (c.meta?.timecode && c.meta?.fps && frames(c) ? tcFmt(tcFrames(c.meta.timecode, c.meta.fps) + frames(c), c.meta.fps) : '');
function shutterAngle(c) {
  const manual = c.cam?.shutterAngle; if (manual) return manual;
  const s = String(cam(c, 'shutter') || ''); const m = /^1\s*\/\s*([\d.]+)/.exec(s); const fps = c.meta?.fps;
  if (m && fps) return `${(360 * fps / Number(m[1])).toFixed(1)}°`;
  return /^[\d.]+$/.test(s) && Number(s) <= 360 ? `${s}°` : '';
}
const lookInfo = (c) => { const l = c.look; if (!l) return ''; const parts = []; if (l.cdl && (l.cdl.sat !== 1 || l.cdl.slope.some((x) => x !== 1) || l.cdl.offset.some((x) => x !== 0) || l.cdl.power.some((x) => x !== 1))) parts.push('CDL'); if (l.lut) parts.push('LUT ' + l.lut.split(/[\\/]/).pop()); return parts.join(' + '); };
const backups = (c) => (c.copies || []).filter((x) => ['verified', 'copied'].includes(x.status)).length;
const FLAG_ICON = { good: '✔', bad: '✖', hold: '●', circled: '◯' };
const FLAG_CYCLE = ['', 'good', 'bad', 'hold', 'circled'];

/* edit: 'top' (campo del clip) o 'cam' (dato de camara editable) */
const COLS = [
  { id: 'flag', label: 'Flag', w: 52, kind: 'flag', text: (c) => ({ good: 'bueno', bad: 'malo', hold: 'pendiente', circled: 'circled' }[c.flag] || '') },
  { id: 'rating', label: 'Rating', w: 90, kind: 'rating', text: (c) => c.rating || '' },
  { id: 'preview', label: 'Preview', w: 76, kind: 'preview', text: () => '' },
  { id: 'name', label: 'Nombre', w: 220, edit: 'top', key: 'name', text: (c) => c.name },
  { id: 'duration', label: 'Duración', w: 82, text: (c) => hms(c.meta?.duration) },
  { id: 'frames', label: 'Frames', w: 70, text: (c) => frames(c) },
  { id: 'camera', label: 'Cámara', w: 80, edit: 'top', key: 'camera', text: (c) => c.camera || '' },
  { id: 'iso', label: 'ISO (clip)', w: 76, edit: 'cam', key: 'iso', text: (c) => cam(c, 'iso') },
  { id: 'wb', label: 'WB (clip)', w: 76, edit: 'cam', key: 'wb', text: (c) => cam(c, 'wb') },
  { id: 'shutter', label: 'Shutter', w: 76, edit: 'cam', key: 'shutter', text: (c) => cam(c, 'shutter') },
  { id: 'shutterAngle', label: 'Shutter angle', w: 96, edit: 'cam', key: 'shutterAngle', text: shutterAngle },
  { id: 'sensorFps', label: 'Sensor FPS', w: 86, edit: 'cam', key: 'sensorFps', text: (c) => cam(c, 'sensorFps') },
  { id: 'nd', label: 'ND filter', w: 80, edit: 'cam', key: 'nd', text: (c) => cam(c, 'nd') },
  { id: 'projectFps', label: 'FPS proyecto', w: 92, text: (c) => (c.meta?.fps ? +c.meta.fps.toFixed(3) : '') },
  { id: 'lens', label: 'Modelo de lente', w: 130, edit: 'cam', key: 'lens', text: (c) => cam(c, 'lens') },
  { id: 'codec', label: 'Códec', w: 110, text: (c) => [c.meta?.codec, c.meta?.profile].filter(Boolean).join(' ') },
  { id: 'fileType', label: 'Tipo de fichero', w: 90, text: (c) => (c.name.includes('.') ? c.name.split('.').pop().toUpperCase() : '') },
  { id: 'resolution', label: 'Resolución', w: 92, text: (c) => (c.meta?.width ? `${c.meta.width}×${c.meta.height}` : '') },
  { id: 'registered', label: 'Fecha de registro', w: 130, text: (c) => dateStr(c.added) },
  { id: 'tcFormat', label: 'Formato TC', w: 80, text: (c) => c.meta?.tcFormat || '' },
  { id: 'tcStart', label: 'TC inicio', w: 92, text: (c) => c.meta?.timecode || '' },
  { id: 'tcEnd', label: 'TC final', w: 92, text: tcEnd },
  { id: 'shotId', label: 'ShotID', w: 90, edit: 'top', key: 'shotId', text: (c) => c.shotId || '' },
  { id: 'reel', label: 'Reel/Tape', w: 90, edit: 'top', key: 'reel', text: (c) => c.reel || '' },
  { id: 'recDate', label: 'Fecha de grabación', w: 130, text: (c) => dateStr(c.meta?.creationTime) },
  { id: 'make', label: 'Fabricante', w: 100, edit: 'cam', key: 'make', text: (c) => cam(c, 'make') },
  { id: 'audioTracks', label: 'Pistas de audio', w: 92, text: (c) => c.meta?.audioTracks ?? '' },
  { id: 'size', label: 'Tamaño', w: 84, text: (c) => fmtBytes(c.size) },
  { id: 'look', label: 'Look', w: 110, text: lookInfo },
  { id: 'cameraT', label: 'Camera T', w: 84, edit: 'cam', key: 'cameraT', text: (c) => cam(c, 'cameraT') },
  { id: 'isoNative', label: 'ISO nativo', w: 84, edit: 'cam', key: 'isoNative', text: (c) => cam(c, 'isoNative') },
  { id: 'rawColorSpace', label: 'Espacio de color (RAW)', w: 150, edit: 'cam', key: 'rawColorSpace', text: (c) => cam(c, 'rawColorSpace') },
  { id: 'audioCodec', label: 'Códec de audio', w: 100, text: (c) => c.meta?.audioCodec || '' },
  { id: 'volume', label: 'Volúmenes', w: 110, text: (c) => c.volume || '' },
  { id: 'backups', label: 'Backups', w: 76, text: (c) => backups(c) },
  { id: 'scene', label: 'Escena', w: 70, edit: 'top', key: 'scene', text: (c) => c.scene || '' },
  { id: 'shot', label: 'Plano', w: 70, edit: 'top', key: 'shot', text: (c) => c.shot || '' },
  { id: 'take', label: 'Toma', w: 70, edit: 'top', key: 'take', text: (c) => c.take || '' },
  { id: 'notes', label: 'Notas', w: 200, edit: 'top', key: 'notes', text: (c) => c.notes || '' },
];
const DEFAULT_COLS = ['flag', 'rating', 'preview', 'name', 'duration', 'frames', 'camera', 'iso', 'wb', 'shutter', 'projectFps', 'lens', 'codec', 'fileType', 'resolution', 'tcStart', 'tcEnd', 'shotId', 'reel', 'audioTracks', 'size', 'look', 'volume', 'backups'];
const customCol = (name) => ({ id: 'custom:' + name, label: name, w: 110, edit: 'custom', key: name, text: (c) => c.custom?.[name] ?? '' });
const allCols = () => [...COLS, ...state.lib.fields.map(customCol)];
function visibleCols() {
  let ids; try { ids = JSON.parse(localStorage.getItem('cine.cols') || 'null'); } catch { ids = null; }
  const have = allCols(); const set = new Set(ids || DEFAULT_COLS);
  return have.filter((c) => set.has(c.id));
}
const saveCols = (ids) => { try { localStorage.setItem('cine.cols', JSON.stringify(ids)); } catch { /* */ } };

async function columnsDialog() {
  const L = state.lib; const chosen = new Set(visibleCols().map((c) => c.id));
  const dlg = h('dialog', { class: 'pform' }); const list = h('div', { class: 'colgrid' });
  const draw = () => list.replaceChildren(...allCols().map((c) => h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: chosen.has(c.id), onchange: (e) => (e.target.checked ? chosen.add(c.id) : chosen.delete(c.id)) }), c.label || c.id, c.id.startsWith('custom:') ? h('span', { class: 'mut' }, ' (propia)') : '')));
  draw();
  const nf = h('input', { type: 'text', placeholder: 'Nueva columna, p. ej. Lente prestada', style: 'flex:1' });
  dlg.append(h('form', { method: 'dialog', class: 'col', style: 'gap:12px' }, h('b', { style: 'font-size:15px' }, 'Columnas de la lista'), h('div', { class: 'mut' }, 'Las columnas propias se editan en la lista y se exportan con el CSV y el ALE.'), list,
    h('div', { class: 'row' }, nf, h('button', { type: 'button', class: 'btn', onclick: async () => { const n = nf.value.trim(); if (!n) return; L.fields = await api.invoke('library:fields:add', n); chosen.add('custom:' + n); nf.value = ''; draw(); } }, 'Añadir columna')),
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('button', { type: 'button', class: 'btn', onclick: () => { chosen.clear(); DEFAULT_COLS.forEach((x) => chosen.add(x)); draw(); } }, 'Restaurar'),
      h('span', { class: 'row' }, h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Cancelar'), h('button', { class: 'btn primary', value: 'ok' }, 'Aplicar')))));
  document.body.append(dlg);
  dlg.addEventListener('close', () => { if (dlg.returnValue === 'ok') { saveCols([...chosen]); drawClips($('#clipGrid')); } dlg.remove(); });
  dlg.showModal();
}

async function exportColumns() {
  const L = state.lib; const rows = L.sel.size ? L.clips.filter((c) => L.sel.has(c.id)) : L.clips;
  const cols = visibleCols().filter((c) => c.kind !== 'preview');
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.map((c) => q(c.label || c.id)).join(','), ...rows.map((c) => cols.map((col) => q(col.text(c))).join(','))].join('\n');
  const f = await api.invoke('export:text', 'clips.csv', '﻿' + csv); if (f) toast(`Exportadas ${rows.length} filas y ${cols.length} columnas`);
}

/* ---------- pantalla de biblioteca ---------- */
async function libraryScreen() {
  const L = state.lib;
  const [bins, smarts, fields, proj] = await Promise.all([api.invoke('library:bins'), api.invoke('library:smart:list'), api.invoke('library:fields:list'), api.invoke('project:get')]);
  Object.assign(L, { bins, smarts, fields, project: proj.info });
  if (L.bin && !bins.some((b) => b.id === L.bin)) L.bin = null;

  const kids = new Map(); for (const b of bins) { const k = b.parent || null; (kids.get(k) || kids.set(k, []).get(k)).push(b); }
  const row = (label, count, active, onclick, depth = 0, toggle = null, title = '') => h('button', { class: 'trow' + (active ? ' active' : ''), style: `padding-left:${8 + depth * 14}px`, title, onclick },
    toggle ? h('span', { class: 'tog', role: 'button', 'aria-label': toggle.open ? 'Contraer' : 'Expandir', onclick: (e) => { e.stopPropagation(); toggle.fn(); } }, toggle.open ? '▾' : '▸') : h('span', { class: 'tog' }),
    h('span', { class: 'ficon', 'aria-hidden': 'true' }, '▤'), h('span', { class: 'tname' }, label), h('span', { class: 'mut' }, count ?? ''));
  const branch = (b, depth) => {
    const ch = kids.get(b.id) || []; const open = !L.closed.has(b.id);
    return [row(b.name, b.count, L.bin === b.id, () => { L.bin = b.id; L.smart = null; render(); }, depth, ch.length ? { open, fn: () => { open ? L.closed.add(b.id) : L.closed.delete(b.id); render(); } } : null, b.name),
      ...(open ? ch.flatMap((c) => branch(c, depth + 1)) : [])];
  };
  const isUnder = (binId, ancestor) => { let cur = bins.find((b) => b.id === binId); const seen = new Set(); while (cur && cur.parent && !seen.has(cur.id)) { seen.add(cur.id); if (cur.parent === ancestor) return true; cur = bins.find((b) => b.id === cur.parent); } return false; };
  const total = bins.reduce((s, b) => s + (b.parent ? 0 : b.count), 0);

  const info = proj.info;
  const projCard = h('div', { class: 'projcard' },
    info?.logo ? h('img', { src: info.logo, alt: '' }) : h('span', { class: 'plogo', 'aria-hidden': 'true' }, (info?.name || '?').slice(0, 1).toUpperCase()),
    h('div', { class: 'ptext' }, h('b', {}, info?.name || 'Sin proyecto'), h('span', { class: 'mut' }, info ? [info.production, info.director && 'Dir. ' + info.director].filter(Boolean).join(' · ') || 'Ficha del proyecto' : 'Crea uno para empezar')),
    h('button', { class: 'btn', onclick: info ? editProject : newProject, title: info ? 'Editar los datos del proyecto' : 'Crear proyecto' }, info ? 'Editar' : 'Crear'));

  const tree = h('div', { class: 'pane tree' }, projCard,
    h('div', { class: 'grp' }, 'Carpetas'), row('Todos los clips', total, !L.bin && !L.smart, () => { L.bin = L.smart = null; render(); }),
    ...(kids.get(null) || []).flatMap((b) => branch(b, 0)),
    h('div', { class: 'grp' }, 'Carpetas inteligentes'),
    ...smarts.map((s) => row(s.name, '', L.smart === s.id, () => { L.smart = s.id; L.bin = null; render(); })),
    h('button', { class: 'trow', onclick: smartDialog }, h('span', { class: 'tog' }), h('span', { class: 'tname mut' }, '+ Nueva carpeta inteligente')));

  const modeBtn = (m, label, title) => h('button', { class: 'btn seg' + (L.mode === m ? ' on' : ''), title, 'aria-pressed': String(L.mode === m), onclick: () => { L.mode = m; try { localStorage.setItem('cine.mode', m); } catch { /* */ } render(); } }, label);
  const crumbs = []; { let cur = L.bin && bins.find((b) => b.id === L.bin); const seen = new Set(); while (cur && !seen.has(cur.id)) { seen.add(cur.id); crumbs.unshift(cur); cur = cur.parent ? bins.find((b) => b.id === cur.parent) : null; } }
  const crumbEl = h('div', { class: 'crumbs mut' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); L.bin = L.smart = null; render(); } }, info?.name || 'Biblioteca'),
    ...crumbs.flatMap((b) => [' / ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); L.bin = b.id; render(); } }, b.name)]));
  const importMenu = h('div', { class: 'row', style: 'gap:6px' },
    h('button', { class: 'btn primary', title: 'Importar carpetas a la biblioteca (no copia: solo registra los ficheros)', onclick: () => doImport('import:folder') }, 'Importar carpetas…'),
    h('button', { class: 'btn', onclick: () => doImport('import:files') }, 'Ficheros…'));
  const center = h('div', { class: 'pane center' },
    h('div', { class: 'row', style: 'margin-bottom:6px;flex-wrap:nowrap' }, importMenu,
      h('input', { type: 'text', placeholder: 'Buscar clip, escena, ShotID, notas…', value: L.search, style: 'flex:1;min-width:120px', oninput: (e) => { L.search = e.target.value; clearTimeout(L.t); L.t = setTimeout(refreshClips, 200); } }),
      h('span', { class: 'segs' }, modeBtn('list', 'Lista', 'Tabla con todas las columnas'), modeBtn('grid', 'Miniaturas', 'Miniaturas de los clips'), modeBtn('folders', 'Carpetas', 'Resumen por carpeta: clips, tamaño y tipos'))),
    h('div', { class: 'row', style: 'margin-bottom:8px;justify-content:space-between' }, crumbEl,
      h('span', { class: 'row' }, L.mode === 'list' ? h('button', { class: 'btn', onclick: columnsDialog }, 'Columnas…') : '',
        h('button', { class: 'btn', title: 'Exporta las columnas visibles', onclick: exportColumns }, 'CSV'), h('button', { class: 'btn', onclick: async () => { const f = await api.invoke('export:edl', [...L.sel], 25); if (f) toast('EDL guardado'); } }, 'EDL'))),
    h('div', { id: 'clipGrid', class: 'clips' }));
  const insp = h('div', { class: 'pane', id: 'inspector' });
  $('#libHost').replaceChildren(h('div', { class: 'lib' }, tree, center, insp));
  L.clips = await api.invoke('library:clips', { bin: L.bin, smartId: L.smart, search: L.search });
  drawClips($('#clipGrid')); drawInspector();
  if (!bins.length && !info) toast('Empieza creando un proyecto con «Crear» y luego importa tus carpetas.');
}

async function doImport(channel) {
  try {
    const r = await api.invoke(channel); if (!r) return;
    toast(r.imported ? `Importados ${r.imported} clips${r.duplicates ? ` (${r.duplicates} ya estaban)` : ''}${r.skipped ? `, ${r.skipped} ficheros ignorados` : ''}` : (r.duplicates ? 'Esos ficheros ya estaban en la biblioteca' : 'No se encontraron vídeos, audios ni imágenes'));
    render();
  } catch (e) { toast('Error al importar: ' + e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
}

/* ---------- despachador de vistas ---------- */
function drawClips(grid) {
  const L = state.lib; if (!grid) return;
  grid.className = L.mode === 'list' ? 'listwrap' : L.mode === 'folders' ? 'folders' : 'clips';
  if (L.mode === 'list') return drawList(grid);
  if (L.mode === 'folders') return drawFolders(grid);
  return drawGrid(grid);
}

/* vista carpetas: cuantos clips, tamano y tipos de cada carpeta */
function drawFolders(grid) {
  const L = state.lib; const bins = L.bins;
  const children = bins.filter((b) => (b.parent || null) === (L.bin || null));
  const cur = L.bin ? bins.find((b) => b.id === L.bin) : null;
  const card = (b) => { const s = b.stats; return h('button', { class: 'fcard', onclick: () => { L.bin = b.id; L.smart = null; L.open.add(b.id); render(); } },
    h('div', { class: 'fname' }, h('span', { class: 'ficon', 'aria-hidden': 'true' }, '▤'), b.name),
    h('div', { class: 'fbig' }, `${s.clips} ${s.clips === 1 ? 'clip' : 'clips'}`, h('span', { class: 'mut' }, ' · ' + fmtBytes(s.size))),
    h('div', { class: 'ftypes' }, h('span', {}, `${s.video} vídeo`), h('span', {}, `${s.audio} audio`), h('span', {}, `${s.still} imágenes`), s.duration ? h('span', {}, hms(s.duration)) : '')); };
  if (!bins.length) return grid.replaceChildren(h('div', { class: 'empty', style: 'grid-column:1/-1' }, 'La biblioteca está vacía. Usa «Importar carpetas…» o haz un Offload.'));
  const own = cur && cur.own ? [h('div', { class: 'fsum', style: 'grid-column:1/-1' }, h('b', {}, `${cur.name}: `), `${cur.stats.clips} clips · ${fmtBytes(cur.stats.size)} · ${cur.stats.video} vídeo · ${cur.stats.audio} audio · ${cur.stats.still} imágenes`, h('button', { class: 'btn', style: 'margin-left:12px', onclick: () => { L.mode = 'list'; render(); } }, 'Ver clips en lista'))] : [];
  if (!children.length && cur) return grid.replaceChildren(...own, h('div', { class: 'empty', style: 'grid-column:1/-1' }, 'Esta carpeta no tiene subcarpetas.'));
  grid.replaceChildren(...own, ...children.map(card));
}

/* vista lista */
function drawList(host) {
  const L = state.lib; const cols = visibleCols();
  const col = cols.find((c) => c.id === L.sort.col) || cols.find((c) => c.id === 'name') || cols[0];
  const val = (c) => { const t = col.text(c); const n = Number(String(t).replace(',', '.')); return t !== '' && !isNaN(n) && !/[:/a-z]/i.test(String(t)) ? n : String(t).toLowerCase(); };
  if (!['flag', 'rating', 'preview'].includes(col.kind || '')) L.clips.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * L.sort.dir; });
  else if (col.kind === 'rating') L.clips.sort((a, b) => ((a.rating || 0) - (b.rating || 0)) * L.sort.dir);
  else if (col.kind === 'flag') L.clips.sort((a, b) => String(a.flag || '').localeCompare(String(b.flag || '')) * L.sort.dir);
  if (!L.clips.length) return host.replaceChildren(h('div', { class: 'empty' }, 'No hay clips. Usa «Importar carpetas…» o haz un Offload.'));
  const patch = async (c, p) => { await api.invoke('library:update', c.id, p); refreshClips(); };
  const editCell = (td, c, colDef) => {
    const cur = colDef.text(c); const inp = h('input', { type: 'text', value: cur, class: 'cellinput' });
    let saved = false; const save = async () => { if (saved) return; saved = true; const nv = inp.value; if (nv === String(cur)) return drawClips($('#clipGrid')); const p = colDef.edit === 'cam' ? { cam: { [colDef.key]: nv } } : colDef.edit === 'custom' ? { custom: { [colDef.key]: nv } } : { [colDef.key]: nv }; await patch(c, p); };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') save(); if (e.key === 'Escape') { saved = true; drawClips($('#clipGrid')); } });
    inp.addEventListener('blur', save); td.replaceChildren(inp); inp.focus(); inp.select();
  };
  const cell = (c, colDef) => {
    const td = h('td', { style: `max-width:${colDef.w + 80}px` });
    if (colDef.kind === 'flag') td.append(h('button', { class: 'flagbtn flag-' + (c.flag || 'none'), title: 'Cambiar marca', 'aria-label': 'Marca: ' + (c.flag || 'ninguna'), onclick: (e) => { e.stopPropagation(); const nx = FLAG_CYCLE[(FLAG_CYCLE.indexOf(c.flag || '') + 1) % FLAG_CYCLE.length]; patch(c, { flag: nx }); } }, FLAG_ICON[c.flag] || '○'));
    else if (colDef.kind === 'rating') td.append(h('span', { class: 'stars' }, ...[1, 2, 3, 4, 5].map((n) => h('button', { class: (c.rating || 0) >= n ? 'on' : '', 'aria-label': n + ' estrellas', onclick: (e) => { e.stopPropagation(); patch(c, { rating: c.rating === n ? 0 : n }); } }, '★'))));
    else if (colDef.kind === 'preview') td.append(c.thumb ? h('img', { class: 'lthumb', src: `cine://thumb/${c.id}`, alt: '', loading: 'lazy' }) : h('span', { class: 'lthumb ph' }, c.kind === 'audio' ? '♪' : ''));
    else { td.textContent = colDef.text(c); td.title = String(colDef.text(c)); if (colDef.edit) { td.classList.add('editable'); td.addEventListener('dblclick', (e) => { e.stopPropagation(); editCell(td, c, colDef); }); } }
    return td;
  };
  const head = h('tr', {}, ...cols.map((c) => h('th', { style: `min-width:${c.w}px`, 'aria-sort': L.sort.col === c.id ? (L.sort.dir > 0 ? 'ascending' : 'descending') : 'none', onclick: () => { L.sort = { col: c.id, dir: L.sort.col === c.id ? -L.sort.dir : 1 }; drawClips($('#clipGrid')); } }, c.label, L.sort.col === c.id ? (L.sort.dir > 0 ? ' ▴' : ' ▾') : '')));
  const body = L.clips.map((c, idx) => h('tr', { class: L.sel.has(c.id) ? 'sel' : '', tabindex: 0, onclick: (e) => selectClip(c, idx, e), ondblclick: () => play(c) }, ...cols.map((colDef) => cell(c, colDef))));
  host.replaceChildren(h('table', { class: 'ltable' }, h('thead', {}, head), h('tbody', {}, ...body)), h('div', { class: 'mut', style: 'padding:6px 4px' }, `${L.clips.length} clips · doble clic en una celda subrayada para editarla · doble clic en la fila para reproducir`));
}
render();
