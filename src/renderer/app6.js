'use strict';
/* v0.6: acciones sobre carpetas y clips de la biblioteca (renombrar, crear, mover, eliminar, reflejado en el disco), edicion en bloque,
   menu contextual, arrastrar clips a carpetas y proxy vinculado para formatos RAW sin decodificador. */

const FM = /Mac/i.test(navigator.platform) ? 'el Finder' : 'el Explorador';
/* ---------- ventana modal sencilla ---------- */
function modal({ title, body = [], ok = 'Aceptar', cancel = 'Cancelar', danger = false, onOk }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'pform' });
    const err = h('div', { class: 'bad', role: 'alert' });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const okBtn = h('button', { type: 'button', class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: async () => {
      okBtn.disabled = true; err.textContent = '';
      try { const r = onOk ? await onOk() : true; close(r ?? true); } catch (e) { err.textContent = errText(e); okBtn.disabled = false; }
    } }, ok);
    dlg.append(h('div', { class: 'col', style: 'gap:12px' }, h('b', { style: 'font-size:15px' }, title), ...body, err,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, cancel ? h('button', { type: 'button', class: 'btn', onclick: () => close(false) }, cancel) : '', okBtn)));
    dlg.addEventListener('cancel', () => { dlg.remove(); resolve(false); });
    document.body.append(dlg); dlg.showModal(); (dlg.querySelector('input[type=text]') || okBtn).focus();
  });
}
function checkbox(label, checked = false, disabled = false) {
  const input = h('input', { type: 'checkbox', checked, disabled });
  return { input, el: h('label', { class: 'chip', style: 'align-self:flex-start' }, input, label) };
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const binPath = (b) => { const bins = state.lib.bins; const n = []; for (let x = b; x; x = x.parent && bins.find((y) => y.id === x.parent)) n.unshift(x.name); return n.join(' / '); };
const afterChange = () => { state.lib.sel.clear(); state.playerClipId = null; return render(); };

/* ---------- menu contextual ---------- */
let ctxEl = null;
function closeCtx() { ctxEl?.remove(); ctxEl = null; }
function ctxMenu(items, x, y) {
  closeCtx();
  ctxEl = h('div', { class: 'ctxmenu', role: 'menu' }, ...items.map((it) => (it.sep ? h('div', { class: 'ctxsep' }) : h('button', { role: 'menuitem', class: it.danger ? 'danger' : '', disabled: !!it.disabled, onclick: () => { closeCtx(); it.onclick(); } }, it.label))));
  document.body.append(ctxEl);
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px'; ctxEl.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  ctxEl.querySelector('button:not([disabled])')?.focus();
}
document.addEventListener('mousedown', (e) => { if (ctxEl && !ctxEl.contains(e.target)) closeCtx(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ctxEl) { closeCtx(); e.stopPropagation(); } }, true);
window.addEventListener('blur', closeCtx); window.addEventListener('resize', closeCtx);

/* ---------- carpetas ---------- */
async function renameBinUI(bin) {
  const info = await api.invoke('bin:info', bin.id);
  const input = h('input', { type: 'text', value: bin.name, 'aria-label': 'Nuevo nombre' }); const chk = checkbox(`Cambiar también el nombre de la carpeta en ${FM}`, !!info.dir, !info.dir);
  const ok = await modal({ title: `Renombrar «${bin.name}»`, ok: 'Renombrar', body: [h('label', { class: 'f' }, 'Nuevo nombre', input),
    h('div', { class: 'mut' }, info.dir ? `Carpeta en el disco: ${info.dir}` : 'Esta carpeta no corresponde a una carpeta del disco (o el disco no está conectado): solo se puede cambiar en la biblioteca.'), chk.el],
  onOk: async () => { const r = await api.invoke('bin:rename', bin.id, input.value, chk.input.checked); toast(r.renamed ? (chk.input.checked ? `Renombrada también en ${FM}: ${plural(r.clips, 'clip actualizado', 'clips actualizados')}` : 'Carpeta renombrada en la biblioteca') : 'Sin cambios'); } });
  if (ok) render();
}
async function newBinUI(parent) {
  const info = parent ? await api.invoke('bin:info', parent.id) : { dir: null };
  const input = h('input', { type: 'text', placeholder: 'Nombre de la carpeta', 'aria-label': 'Nombre' }); const chk = checkbox(`Crearla también en ${FM}`, !!info.dir, !info.dir);
  const ok = await modal({ title: parent ? `Nueva subcarpeta en «${parent.name}»` : 'Nueva carpeta', ok: 'Crear', body: [h('label', { class: 'f' }, 'Nombre', input),
    h('div', { class: 'mut' }, info.dir ? `Se creará dentro de: ${info.dir}` : (parent ? 'La carpeta padre no corresponde a una carpeta del disco: solo se crea en la biblioteca.' : 'En la raíz de la biblioteca solo se crea en la biblioteca (no hay carpeta del disco asociada).')), chk.el],
  onOk: async () => { const r = await api.invoke('bin:create', parent?.id || null, input.value, chk.input.checked); state.lib.bin = r.id; toast(r.dir ? `Carpeta creada en ${r.dir}` : 'Carpeta creada en la biblioteca'); } });
  if (ok) render();
}
async function deleteBinUI(bin) {
  const info = await api.invoke('bin:info', bin.id);
  const chk = checkbox(`Mover también la carpeta del disco a la Papelera`, false, !info.dir);
  const ok = await modal({ title: `Eliminar «${bin.name}»`, ok: 'Eliminar', danger: true, body: [
    h('div', {}, `Se quitará de la biblioteca la carpeta con sus subcarpetas y ${plural(bin.count, 'clip', 'clips')}.`),
    h('div', { class: 'mut' }, info.dir ? `Carpeta en el disco: ${info.dir}. Con la casilla marcada se mueve entera a la Papelera (se puede recuperar desde ahí).` : 'Esta carpeta no corresponde a una carpeta del disco: solo se quita de la biblioteca.'),
    h('div', { class: 'mut' }, 'Por defecto los ficheros del disco no se tocan.'), chk.el],
  onOk: async () => { const r = await api.invoke('bin:remove', bin.id, chk.input.checked); if (state.lib.bin === bin.id) state.lib.bin = null; toast(r.trashed ? `Eliminada. La carpeta está en la Papelera: ${r.trashed}` : `Eliminada de la biblioteca (${plural(r.clips, 'clip', 'clips')})`); } });
  if (ok) afterChange();
}
function binMenu(bin, x, y) {
  ctxMenu([
    { label: 'Renombrar…', onclick: () => renameBinUI(bin) }, { label: 'Nueva subcarpeta…', onclick: () => newBinUI(bin) },
    { label: `Mostrar en ${FM}`, onclick: async () => { const i = await api.invoke('bin:info', bin.id); if (i.dir) api.invoke('shell:reveal', i.dir); else toast('Esta carpeta no corresponde a una carpeta del disco'); } },
    { sep: true }, { label: 'Eliminar…', danger: true, onclick: () => deleteBinUI(bin) }]);
}
/** Propiedades de una fila de carpeta del arbol: menu contextual y zona donde soltar clips. */
function binRowProps(bin) {
  return {
    oncontextmenu: (e) => { e.preventDefault(); binMenu(bin, e.clientX, e.clientY); },
    ondragover: (e) => { if (state.lib.dragIds) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('dropok'); } },
    ondragleave: (e) => e.currentTarget.classList.remove('dropok'),
    ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('dropok'); const ids = state.lib.dragIds; state.lib.dragIds = null; if (ids?.length) moveClipsUI(ids, bin); },
  };
}

/* ---------- clips ---------- */
function clipDrag(e, c) {
  const L = state.lib; L.dragIds = L.sel.has(c.id) ? [...L.sel] : [c.id];
  e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', `${L.dragIds.length} clips`);
}
async function moveClipsUI(ids, targetBin) {
  const L = state.lib; const bins = [...L.bins].sort((a, b) => natural(binPath(a), binPath(b)));
  let target = targetBin?.id || (L.bin && bins.find((b) => b.id === L.bin)?.id) || bins[0]?.id;
  if (!target) return toast('No hay carpetas: crea una primero');
  const chk = checkbox(`Mover también los ficheros en ${FM}`, true); const hint = h('div', { class: 'mut' });
  const refresh = async () => { const d = (await api.invoke('bin:info', target)).dir; chk.input.disabled = !d; chk.input.checked = !!d; hint.textContent = d ? `Carpeta de destino en el disco: ${d}` : 'La carpeta de destino no corresponde a una carpeta del disco: solo se moverán dentro de la biblioteca.'; };
  const pick = targetBin ? h('div', {}, 'Destino: ', h('b', {}, binPath(bins.find((b) => b.id === target) || targetBin)))
    : h('label', { class: 'f' }, 'Carpeta de destino', h('select', { onchange: (e) => { target = e.target.value; refresh(); } }, ...bins.map((b) => h('option', { value: b.id, selected: b.id === target }, binPath(b)))));
  await refresh();
  let result = null;
  const ok = await modal({ title: `Mover ${plural(ids.length, 'clip', 'clips')}`, ok: 'Mover', body: [pick, hint, chk.el, h('div', { class: 'mut' }, 'Los ficheros solo se mueven dentro del mismo disco. Para pasarlos a otro disco usa un Offload (copia verificada).')],
    onOk: async () => { result = await api.invoke('clips:move', ids, target, chk.input.checked); } });
  if (!ok) return;
  toast(`${plural(result.moved, 'clip movido', 'clips movidos')}${result.skipped.length ? `, ${result.skipped.length} sin mover` : ''}`);
  if (result.skipped.length) await modal({ title: 'Algunos clips no se han movido', cancel: false, ok: 'Entendido', body: [h('div', { class: 'list', style: 'max-height:40vh;overflow:auto' }, ...result.skipped.map((s) => h('div', { class: 'item' }, h('b', {}, s.name), h('span', { class: 'mut' }, s.reason))))] });
  afterChange();
}
async function renameClipUI(c) {
  const input = h('input', { type: 'text', value: c.name, 'aria-label': 'Nuevo nombre' }); const chk = checkbox(`Cambiar también el nombre del fichero en ${FM}`, true);
  const ok = await modal({ title: `Renombrar «${c.name}»`, ok: 'Renombrar', body: [h('label', { class: 'f' }, 'Nuevo nombre (si no escribes la extensión se conserva)', input), h('div', { class: 'mono mut' }, c.path), chk.el],
    onOk: async () => { await api.invoke('clip:rename', c.id, input.value, chk.input.checked); toast('Clip renombrado'); } });
  if (ok) render();
}
async function removeClipsUI(ids) {
  const chk = checkbox(`Mover también los ficheros a la Papelera`, false);
  const ok = await modal({ title: `Quitar ${plural(ids.length, 'clip', 'clips')}`, ok: 'Quitar', danger: true, body: [h('div', {}, 'Se quitan de la biblioteca. Por defecto los ficheros del disco no se tocan.'), chk.el, h('div', { class: 'mut' }, 'Solo se envía a la Papelera el fichero de la biblioteca; las demás copias de seguridad no se tocan.')],
    onOk: async () => { const r = await api.invoke('clips:remove', ids, chk.input.checked); toast(r.trashed ? `${plural(r.removed, 'clip quitado', 'clips quitados')}; ${plural(r.trashed, 'fichero', 'ficheros')} en la Papelera` : `${plural(r.removed, 'clip quitado', 'clips quitados')} de la biblioteca`); } });
  if (ok) afterChange();
}
async function linkProxyUI(c) {
  try { const r = await api.invoke('clip:linkProxy', c.id); if (!r) return; toast('Proxy vinculado: ya puedes verlo, sacar miniaturas y transcodificar'); state.playerClipId = null; render(); }
  catch (e) { toast('Error: ' + errText(e)); }
}
async function bulkEditUI(ids) {
  const L = state.lib; const clips = ids.map((id) => L.clips.find((c) => c.id === id)).filter(Boolean); const dirty = {};
  const common = (get) => { const v = new Set(clips.map(get)); return v.size === 1 ? [...v][0] : undefined; };
  const field = (label, key, get) => { const cv = common(get || ((c) => c[key] ?? '')); const inp = h('input', { type: 'text', value: cv ?? '', placeholder: cv === undefined ? '(varios valores: escribe para igualarlos)' : '', oninput: () => { dirty[key] = inp.value; } }); return h('label', { class: 'f' }, label, inp); };
  const choice = (label, key, opts) => h('label', { class: 'f' }, label, h('select', { onchange: (e) => { if (e.target.value === '__') delete dirty[key]; else dirty[key] = e.target.value; } }, h('option', { value: '__' }, '(sin cambios)'), ...opts.map(([v, l]) => h('option', { value: v }, l))));
  const ok = await modal({ title: `Editar ${plural(clips.length, 'clip', 'clips')} a la vez`, ok: 'Aplicar a todos', body: [
    h('div', { class: 'mut' }, 'Solo se cambian los campos que modifiques; el resto queda como está. Si un campo tiene valores distintos se muestra «(varios valores)». Vacía un campo para borrarlo en todos.'),
    h('div', { class: 'row' }, field('Escena', 'scene'), field('Plano', 'shot'), field('Toma', 'take')), h('div', { class: 'row' }, field('Cámara', 'camera'), field('Reel', 'reel'), field('ShotID', 'shotId')),
    h('div', { class: 'row' }, choice('Marca', 'flag', [['good', 'Bueno'], ['bad', 'Malo'], ['hold', 'Pendiente'], ['circled', 'Circled'], ['', 'Quitar marca']]), choice('Valoración', 'rating', [['0', 'Sin valoración'], ['1', '1 estrella'], ['2', '2 estrellas'], ['3', '3 estrellas'], ['4', '4 estrellas'], ['5', '5 estrellas']])),
    field('Notas', 'notes'), ...L.fields.map((f) => field(f, 'custom:' + f, (c) => c.custom?.[f] ?? ''))],
  onOk: async () => {
    const patch = {};
    for (const [k, v] of Object.entries(dirty)) { if (k.startsWith('custom:')) (patch.custom ||= {})[k.slice(7)] = v; else patch[k] = k === 'rating' ? Number(v) : v; }
    if (!Object.keys(patch).length) throw new Error('No has cambiado ningún campo');
    await api.invoke('library:bulk', ids, patch); toast(`${plural(clips.length, 'clip actualizado', 'clips actualizados')}`); } });
  if (ok) { await refreshClips(); }
}
function clipCtx(e, c) {
  e.preventDefault(); const L = state.lib;
  if (!L.sel.has(c.id)) { L.sel = new Set([c.id]); L.last = L.clips.findIndex((x) => x.id === c.id); drawClips($('#clipGrid')); drawInspector(); }
  const ids = [...L.sel]; const one = ids.length === 1;
  ctxMenu([
    ...(ids.length > 1 ? [{ label: `Editar ${ids.length} clips a la vez…`, onclick: () => bulkEditUI(ids) }] : [{ label: 'Editar datos…', onclick: () => bulkEditUI(ids) }]),
    { label: `Mover ${one ? 'a otra carpeta' : ids.length + ' clips a otra carpeta'}…`, onclick: () => moveClipsUI(ids) },
    ...(one ? [{ label: 'Renombrar fichero…', onclick: () => renameClipUI(c) }, { label: `Mostrar en ${FM}`, onclick: () => api.invoke('shell:reveal', c.path) }] : []),
    ...(one && (c.meta?.decodable === false || c.proxy) ? [{ label: c.proxy ? 'Cambiar proxy vinculado…' : 'Vincular proxy…', onclick: () => linkProxyUI(c) }] : []),
    { sep: true }, { label: `Quitar ${one ? 'de la biblioteca' : ids.length + ' clips'}…`, danger: true, onclick: () => removeClipsUI(ids) }], e.clientX, e.clientY);
}
/** Botones de accion de la seleccion (inspector). */
function selectionActions(sel) {
  const ids = sel.map((c) => c.id); const one = sel.length === 1 ? sel[0] : null;
  return h('div', { class: 'row', style: 'margin:6px 0' },
    h('button', { class: 'btn', title: 'Cambia escena, plano, toma, cámara, reel… de todos los clips seleccionados a la vez', onclick: () => bulkEditUI(ids) }, one ? 'Editar datos…' : `Editar ${ids.length} a la vez…`),
    h('button', { class: 'btn', onclick: () => moveClipsUI(ids) }, 'Mover…'),
    one ? h('button', { class: 'btn', onclick: () => renameClipUI(one) }, 'Renombrar…') : '',
    h('button', { class: 'btn danger', onclick: () => removeClipsUI(ids) }, 'Quitar…'));
}
document.addEventListener('keydown', (e) => { // Ctrl/Cmd + A selecciona todos los clips visibles
  if (state.view !== 'library' || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || document.querySelector('dialog[open]')) return;
  e.preventDefault(); const L = state.lib; L.sel = new Set(L.clips.map((c) => c.id)); drawClips($('#clipGrid')); drawInspector(); toast(`${plural(L.sel.size, 'clip seleccionado', 'clips seleccionados')}`);
});
