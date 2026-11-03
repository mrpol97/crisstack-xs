'use strict';
/* v0.5: miniaturas con el look del clip, biblioteca de LUTs guardadas, paneles flotantes (reproductor y color) y espacio de stills por escena. */
const natural = (a, b) => String(a).localeCompare(String(b), 'es', { numeric: true });
const clampN = (v, a, b) => Math.min(b, Math.max(a, v));
const pad2 = (n) => String(n).padStart(2, '0');
try { document.fonts?.load('16px "DejaVu Sans"').catch(() => {}); } catch { /* sin fuentes */ } // la misma fuente que dibuja ffmpeg: sirve para medir los textos de la previsualizacion

/* ---------- miniaturas con look ---------- */
try { state.lib.thumbLook = localStorage.getItem('cine.thumbLook') !== '0'; } catch { state.lib.thumbLook = true; }
function hash32(s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(36); }
function clipHasLook(c) {
  const l = c.look, t = c.transform;
  const cdl = l?.cdl && (l.cdl.sat !== 1 || l.cdl.slope.some((v) => v !== 1) || l.cdl.offset.some((v) => v !== 0) || l.cdl.power.some((v) => v !== 1));
  return !!(l?.lut || cdl || (t && (t.crop || (t.desqueeze && t.desqueeze !== 1) || t.flip || t.rotate)));
}
/** Direccion de la miniatura de un clip; con el interruptor activo lleva aplicados la LUT, el ajuste de color y la transformacion. */
function thumbSrc(c) {
  let q = `?v=${c.thumbAt ?? 0}.${c.thumbRev ?? 0}`;
  if (state.lib.thumbLook !== false && clipHasLook(c)) q += `&look=1&k=${hash32(JSON.stringify([c.look, c.transform]))}`;
  return `cine://thumb/${c.id}${q}`;
}
/** Vuelve a pedir los clips y redibuja solo la rejilla (sin tocar el panel de color que se esta moviendo). */
async function lightRefresh() {
  const L = state.lib; if (state.view !== 'library') return;
  L.clips = await api.invoke('library:clips', { bin: L.bin, smartId: L.smart, search: L.search });
  const grid = $('#clipGrid'); if (grid && L.mode !== 'compare') drawClips(grid);
}

/* ---------- biblioteca de LUTs ---------- */
state.luts = [];
async function loadLuts() { state.luts = await api.invoke('luts:list'); return state.luts; }
const lutLabel = (p) => state.luts.find((x) => x.file === p)?.name || String(p || '').split(/[\\/]/).pop();
function importSummary(r) {
  if (!r) return;
  const bits = [];
  if (r.added.length) bits.push(`${r.added.length} ${r.added.length === 1 ? 'LUT guardada' : 'LUTs guardadas'}`);
  if (r.duplicates.length) bits.push(`${r.duplicates.length} ya estaban`);
  if (r.errors.length) bits.push(`${r.errors.length} no válidas (${r.errors[0].error})`);
  toast(bits.join(' · ') || 'No se encontraron LUTs .cube');
}
/** Selector de LUT con las guardadas y un botón para importar nuevas (quedan guardadas para siempre). */
function lutField(value, onPick, { none = 'Sin LUT', label = 'LUT' } = {}) {
  let cur = value || '';
  const sel = h('select', { 'aria-label': label, onchange: (e) => { cur = e.target.value; onPick(cur); } });
  const fill = () => {
    const known = state.luts.some((l) => l.file === cur);
    sel.replaceChildren(h('option', { value: '' }, none), ...state.luts.map((l) => h('option', { value: l.file, selected: l.file === cur }, `${l.name} · ${l.size}³`)),
      ...(cur && !known ? [h('option', { value: cur, selected: true }, `${lutLabel(cur)} (fuera de la biblioteca)`)] : []));
    sel.value = cur;
  };
  fill(); loadLuts().then(fill).catch(() => {});
  return h('div', { class: 'lutfield' }, sel,
    h('button', { type: 'button', class: 'btn', title: 'Importa una o varias LUT .cube: se guardan en la app y ya no hace falta volver a buscarlas en el Finder', onclick: async () => {
      const r = await api.invoke('luts:import'); if (!r) return; await loadLuts(); importSummary(r);
      const first = r.added[0] || r.duplicates[0]; if (first) { cur = first.file; fill(); onPick(first.file); } else fill();
    } }, 'Importar…'),
    h('button', { type: 'button', class: 'btn', title: 'Renombrar o quitar LUTs guardadas, o importar una carpeta entera', onclick: () => lutManager().then(fill) }, 'Gestionar…'));
}
async function lutManager() {
  await loadLuts();
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'pform', style: 'min-width:480px' });
    const list = h('div', { class: 'col', style: 'gap:6px;max-height:52vh;overflow:auto' });
    const draw = () => list.replaceChildren(...(state.luts.length ? state.luts.map((l) => h('div', { class: 'row lutitem', style: 'flex-wrap:nowrap' },
      h('input', { type: 'text', value: l.name, 'aria-label': 'Nombre de la LUT', style: 'flex:1;min-width:0', onchange: async (e) => { await api.invoke('luts:rename', l.id, e.target.value); await loadLuts(); } }),
      h('span', { class: 'mut mono', title: l.file }, `${l.size}³${l.converted ? ' · de 1D' : ''}`),
      h('button', { type: 'button', class: 'btn danger', onclick: async () => { await api.invoke('luts:remove', l.id); await loadLuts(); draw(); } }, 'Quitar')))
      : [h('div', { class: 'mut' }, 'Todavía no hay LUTs guardadas. Importa alguna.')]));
    draw();
    const close = () => { dlg.close(); dlg.remove(); resolve(); };
    dlg.append(h('div', { class: 'col', style: 'gap:12px' }, h('b', { style: 'font-size:15px' }, 'LUTs guardadas'),
      h('div', { class: 'mut' }, 'Las LUTs importadas se copian a la app, así que siguen disponibles aunque muevas o borres el original. «Quitar» solo las saca de esta lista: los clips que ya las usan no cambian.'),
      list,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: async () => { const r = await api.invoke('luts:import'); if (r) { await loadLuts(); importSummary(r); draw(); } } }, 'Importar LUTs…'),
        h('button', { type: 'button', class: 'btn', onclick: async () => { const r = await api.invoke('luts:importFolder'); if (r) { await loadLuts(); importSummary(r); draw(); } } }, 'Importar carpeta…')),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'btn primary', onclick: close }, 'Listo'))));
    dlg.addEventListener('cancel', () => { dlg.remove(); resolve(); });
    document.body.append(dlg); dlg.showModal();
  });
}

/* ---------- paneles flotantes: el reproductor y el color se pueden sacar y colocar donde quieras ---------- */
const FLOAT_TITLES = { player: 'Reproductor', color: 'Color y transformación' };
const FLOAT_DEFAULT = { player: { w: 460 }, color: { w: 340, h: 520 } };
let floats = {};
try { floats = JSON.parse(localStorage.getItem('cine.float') || '{}') || {}; } catch { floats = {}; }
const saveFloats = () => { try { localStorage.setItem('cine.float', JSON.stringify(floats)); } catch { /* sin storage */ } };
let floatLayerEl = null;
function floatLayer() { if (!floatLayerEl || !floatLayerEl.isConnected) { floatLayerEl = h('div', { id: 'floatLayer' }); $('#app').append(floatLayerEl); } return floatLayerEl; }
function floatsVisible(on) { floatLayer().hidden = !on; }
function fitFloat(g) { // que el panel nunca quede fuera de la ventana
  g.w = clampN(g.w || 400, 260, Math.max(300, window.innerWidth - 40));
  g.x = clampN(g.x ?? window.innerWidth - g.w - 30, 0, Math.max(0, window.innerWidth - 120)); g.y = clampN(g.y ?? 70, 46, Math.max(46, window.innerHeight - 80));
  if (g.h) g.h = clampN(g.h, 120, Math.max(160, window.innerHeight - 60));
}
function panelEl(key) {
  let el = floatLayer().querySelector(`[data-fp="${key}"]`); if (el) return el;
  const g = floats[key]; fitFloat(g);
  const head = h('div', { class: 'fphead' }, h('b', { title: 'Arrastra esta barra para mover el panel; tira de la esquina inferior derecha para cambiar su tamaño' }, FLOAT_TITLES[key]), h('span', { class: 'grow' }), h('span', { class: 'mut', style: 'font-size:11px' }, 'arrastra para mover'),
    h('button', { class: 'btn mini', title: 'Volver a colocar este panel en la columna de la derecha', onclick: () => setFloat(key, false) }, 'Acoplar'));
  el = h('div', { class: 'fpanel', 'data-fp': key, role: 'group', 'aria-label': FLOAT_TITLES[key], style: `left:${g.x}px;top:${g.y}px;width:${g.w}px;${g.h ? `height:${g.h}px` : ''}` }, head, h('div', { class: 'fpbody' }));
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = el.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top; try { head.setPointerCapture(e.pointerId); } catch { /* sin captura */ } el.classList.add('moving');
    const move = (ev) => { el.style.left = clampN(ev.clientX - ox, 8 - r.width + 120, window.innerWidth - 120) + 'px'; el.style.top = clampN(ev.clientY - oy, 46, window.innerHeight - 50) + 'px'; };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); el.classList.remove('moving'); g.x = parseFloat(el.style.left); g.y = parseFloat(el.style.top); saveFloats(); };
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up);
  });
  if (typeof ResizeObserver !== 'undefined') {
    let t; new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => { if (!el.isConnected || el.classList.contains('moving')) return; const r = el.getBoundingClientRect(); if (r.width > 0) { g.w = Math.round(r.width); g.h = Math.round(r.height); saveFloats(); } }, 250); }).observe(el);
  }
  floatLayer().append(el); return el;
}
function setFloat(key, on) {
  const g = floats[key] || (floats[key] = {}); g.on = on;
  if (on) { for (const [k, v] of Object.entries(FLOAT_DEFAULT[key])) if (!g[k]) g[k] = v; if (g.x == null) { const other = floats[key === 'color' ? 'player' : 'color']; const right = window.innerWidth - g.w - 30; g.x = other?.on && other.x != null && other.x + (other.w || 0) > right - 12 ? Math.max(8, other.x - g.w - 12) : right; g.y = key === 'player' ? 70 : 110; } fitFloat(g); }
  else floatLayer().querySelector(`[data-fp="${key}"]`)?.remove();
  saveFloats(); if (typeof drawInspector === 'function') drawInspector();
}
/** Coloca un panel del inspector: acoplado en la columna o flotando. node=null → panel sin contenido para esta selección. */
function placePanel(key, title, node) {
  const g = floats[key];
  if (g?.on) {
    const body = $('.fpbody', panelEl(key));
    body.replaceChildren(node || h('div', { class: 'mut', style: 'padding:12px' }, 'Selecciona un clip de vídeo para ver este panel.'));
    return h('div', { class: 'fpstub' }, h('span', { class: 'mut' }, `${title}: en ventana flotante`), h('button', { class: 'btn mini', onclick: () => setFloat(key, false) }, 'Acoplar'));
  }
  floatLayer().querySelector(`[data-fp="${key}"]`)?.remove();
  if (!node) return '';
  return h('div', { class: 'dockpanel' }, h('div', { class: 'dockhead' }, h('span', { class: 'mut' }, key === 'player' ? title : ''),
    h('button', { class: 'btn mini', title: 'Sacar a una ventana flotante: la mueves y le cambias el tamaño donde quieras', onclick: () => setFloat(key, true) }, '⇱ Separar')), node);
}
function floatsIdle() { for (const key of Object.keys(FLOAT_TITLES)) if (floats[key]?.on) $('.fpbody', panelEl(key)).replaceChildren(h('div', { class: 'mut', style: 'padding:12px' }, 'Selecciona un clip para ver este panel.')); }
window.addEventListener('resize', () => { for (const el of floatLayer().querySelectorAll('.fpanel')) { const g = floats[el.dataset.fp]; if (!g) continue; fitFloat(g); el.style.left = g.x + 'px'; el.style.top = g.y + 'px'; } });

/* ---------- STILLS POR ESCENA ---------- */
async function mountPlayer(host, c) {
  const s = await api.invoke('playback:source', c.id);
  const p = new CinePlayer(host, { fps: c.meta?.fps }); p.load(s.url); p.setLook(c.look); p.setTransform(c.transform || {});
  if (c.look?.lut) { try { await p.setLut(await api.invoke('lut:read', c.look.lut)); } catch { /* la LUT no se pudo leer: se ve sin ella */ } }
  return { p, proxy: s.proxy };
}
const stTc = (c, t) => { const fps = c.meta?.fps; if (!c.meta?.timecode || !fps) return ''; const r = Math.round(fps); const [a, b, s, f] = c.meta.timecode.split(/[:;]/).map(Number); let n = ((a * 60 + b) * 60 + s) * r + (f || 0) + Math.round(t * fps); const ff = n % r; n = Math.floor(n / r); return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60, ff].map(pad2).join(':'); };

views.stills = async function viewStills() {
  const st = state.st || (state.st = { scene: null, clipId: null, format: 'jpeg', only: true });
  state.player?.destroy(); state.player = null; state.playerClipId = null; state.playerHost = null; // dos reproductores a la vez se pisarian las teclas
  const tok = st.tok = (st.tok || 0) + 1;
  const [clips, all] = await Promise.all([api.invoke('library:clips', {}), api.invoke('stills:list')]);
  const videos = clips.filter((c) => c.kind === 'video');
  const sceneOf = (c) => String(c.scene || '').trim();
  const scenes = [...new Set([...videos.map(sceneOf), ...all.map((s) => s.scene || '')])].sort(natural);
  if (st.scene === null) { const pick = videos.find((c) => state.lib.sel.has(c.id)); st.scene = pick ? sceneOf(pick) : (scenes[0] ?? ''); st.clipId = pick?.id ?? null; }
  if (!scenes.includes(st.scene) && scenes.length) st.scene = scenes[0];
  const inScene = videos.filter((c) => sceneOf(c) === st.scene).sort((a, b) => natural(a.name, b.name));
  if (!inScene.some((c) => c.id === st.clipId)) st.clipId = inScene[0]?.id ?? null;
  const clip = inScene.find((c) => c.id === st.clipId);
  const sceneLabel = (s) => (s ? `Escena ${s}` : 'Sin escena');
  const count = (s) => all.filter((x) => (x.scene || '') === s).length;

  main.append(h('h1', {}, 'Stills por escena'),
    h('div', { class: 'sub' }, 'Elige una escena y un clip, busca el momento que quieres (tira de fotogramas, barra o teclas ← →) y guarda el still con su look aplicado. Los stills quedan agrupados por escena y puedes sacar un informe.'),
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('label', { class: 'f' }, 'Escena', h('select', { onchange: (e) => { st.scene = e.target.value; st.clipId = null; render(); } }, ...(scenes.length ? scenes : ['']).map((s) => h('option', { value: s, selected: s === st.scene }, `${sceneLabel(s)} (${videos.filter((c) => sceneOf(c) === s).length} clips · ${count(s)} stills)`)))),
      h('label', { class: 'f', style: 'min-width:200px' }, 'Clip', h('select', { disabled: !inScene.length, onchange: (e) => { st.clipId = e.target.value; render(); } }, ...inScene.map((c) => h('option', { value: c.id, selected: c.id === st.clipId }, `${c.name}${c.shot ? ' · Pl ' + c.shot : ''}${c.take ? ' · T ' + c.take : ''}`)))),
      h('label', { class: 'f' }, 'Formato', h('select', { onchange: (e) => (st.format = e.target.value) }, ...[['jpeg', 'JPEG'], ['png', 'PNG'], ['tiff', 'TIFF 16 bits']].map(([v, l]) => h('option', { value: v, selected: v === st.format }, l)))),
      h('span', { class: 'row', style: 'margin-left:auto' },
        h('button', { class: 'btn', disabled: !count(st.scene), onclick: async () => { try { const f = await api.invoke('stills:report', { scene: st.scene, format: 'pdf' }); toast('Informe de la escena: ' + f); api.invoke('shell:reveal', f); } catch (e) { toast('Error: ' + errText(e)); } } }, 'Informe PDF de esta escena'),
        h('button', { class: 'btn', disabled: !all.length, onclick: async () => { try { const f = await api.invoke('stills:report', { scene: '__all__', format: 'pdf' }); toast('Informe de todas las escenas: ' + f); api.invoke('shell:reveal', f); } catch (e) { toast('Error: ' + errText(e)); } } }, 'Informe de todas'))));

  const viewer = h('div', { class: 'card' }), gallery = h('div', { class: 'card' });
  main.append(h('div', { class: 'stgrid' }, viewer, gallery));

  /* galeria */
  const drawGallery = async () => {
    const list = (await api.invoke('stills:list')).filter((s) => !st.only || (s.scene || '') === st.scene).sort((a, b) => natural((a.scene || '') + a.shot + a.take + a.clipName, (b.scene || '') + b.shot + b.take + b.clipName) || a.t - b.t);
    gallery.replaceChildren(h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { style: 'margin:0' }, st.only ? `Stills · ${sceneLabel(st.scene)}` : 'Stills · todas las escenas'),
      h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: st.only, onchange: (e) => { st.only = e.target.checked; drawGallery(); } }), 'Solo esta escena')),
    list.length ? h('div', { class: 'stgal' }, ...list.map((s) => h('figure', { class: 'stcard' },
      h('img', { src: `cine://still/${s.id}`, alt: `Still de ${s.clipName}`, loading: 'lazy', title: 'Clic para verlo grande', onclick: () => bigStill(s) }),
      h('figcaption', {}, h('b', {}, s.clipName), h('span', { class: 'mut' }, [!st.only && sceneLabel(s.scene), s.shot && 'Pl ' + s.shot, s.take && 'T ' + s.take, s.tc].filter(Boolean).join(' · ')),
        h('input', { type: 'text', value: s.note || '', placeholder: 'Nota…', 'aria-label': 'Nota del still', onchange: (e) => api.invoke('stills:update', s.id, { note: e.target.value }) }),
        h('div', { class: 'row', style: 'gap:4px' },
          h('button', { class: 'btn mini', onclick: () => api.invoke('shell:reveal', s.file) }, 'Carpeta'),
          h('button', { class: 'btn mini danger', onclick: async () => { if (!confirm('¿Borrar este still? También se borra el fichero de imagen.')) return; await api.invoke('stills:remove', s.id, true); drawGallery(); } }, 'Borrar')))))
    ) : h('div', { class: 'empty' }, st.only ? 'Todavía no hay stills en esta escena. Guarda el primero con el botón «Guardar still».' : 'Todavía no hay stills.'));
  };
  const bigStill = (s) => {
    const dlg = h('dialog', { class: 'pform', style: 'max-width:90vw;padding:12px' }, h('img', { src: `cine://stillfull/${s.id}`, alt: s.clipName, style: 'max-width:86vw;max-height:78vh;display:block;border-radius:6px' }),
      h('div', { class: 'row', style: 'justify-content:space-between;margin-top:8px' }, h('span', { class: 'mut' }, `${s.clipName} · ${s.tc || ''} ${s.look ? '· ' + s.look : ''}`), h('button', { class: 'btn', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cerrar')));
    dlg.addEventListener('cancel', () => dlg.remove()); document.body.append(dlg); dlg.showModal();
  };
  drawGallery();

  /* visor */
  if (!clip) { viewer.append(h('h2', { style: 'margin-top:0' }, 'Elegir el momento'), h('div', { class: 'empty' }, videos.length ? 'Esta escena no tiene clips de vídeo. Asigna la escena a tus clips desde la Biblioteca (campo «Escena» del inspector).' : 'No hay clips de vídeo en la biblioteca.')); return; }
  const host = h('div'), strip = h('div', { class: 'filmstrip', role: 'list', 'aria-label': 'Fotogramas del clip' }, h('span', { class: 'mut' }, 'Preparando fotogramas…'));
  const note = h('input', { type: 'text', placeholder: 'Nota para el still (opcional)', 'aria-label': 'Nota', style: 'flex:1;min-width:140px' });
  viewer.append(h('h2', { style: 'margin-top:0' }, `Elegir el momento · ${clip.name}`), host, strip);
  let mp; try { mp = await mountPlayer(host, clip); } catch (e) { viewer.replaceChildren(h('h2', { style: 'margin-top:0' }, clip.name), h('div', { class: 'bad' }, errText(e))); return; }
  if (tok !== st.tok) { mp.p.destroy(); return; }
  const p = mp.p; p.controls.querySelectorAll('button').forEach((b) => { if (/Still|Miniatura/.test(b.textContent)) b.style.display = 'none'; }); // las acciones se hacen con los botones de abajo
  const fps = clip.meta?.fps || 25;
  const step = (frames) => { p.video.pause(); p.video.currentTime = clampN(p.video.currentTime + frames / fps, 0, p.video.duration || 1e9); };
  const where = h('span', { class: 'mono mut' }, '');
  const upd = () => { where.textContent = stTc(clip, p.video.currentTime) || `${p.video.currentTime.toFixed(2)} s`; };
  p.video.addEventListener('timeupdate', upd); p.video.addEventListener('seeked', upd);
  viewer.append(h('div', { class: 'row', style: 'margin-top:8px' },
    h('button', { class: 'btn', title: '1 segundo atrás', onclick: () => step(-fps) }, '−1 s'), h('button', { class: 'btn', title: 'Fotograma anterior (←)', onclick: () => step(-1) }, '◀ 1f'),
    h('button', { class: 'btn', title: 'Fotograma siguiente (→)', onclick: () => step(1) }, '1f ▶'), h('button', { class: 'btn', title: '1 segundo adelante', onclick: () => step(fps) }, '+1 s'), where),
  h('div', { class: 'row', style: 'margin-top:8px' }, note,
    h('button', { class: 'btn primary', onclick: async (e) => {
      e.target.disabled = true;
      try { const r = await api.invoke('stills:capture', { clipId: clip.id, t: p.video.currentTime, format: st.format, note: note.value }); note.value = ''; toast(`Still guardado en ${sceneLabel(r.scene)} (${r.tc || r.t.toFixed(2) + ' s'})`); await drawGallery(); }
      catch (err) { toast('Error: ' + errText(err)); } finally { e.target.disabled = false; }
    } }, '📷 Guardar still'),
    h('button', { class: 'btn', title: 'Este fotograma será la miniatura del clip en la biblioteca', onclick: async () => { try { await api.invoke('thumb:set', clip.id, p.video.currentTime); toast('Miniatura del clip actualizada'); } catch (err) { toast('Error: ' + errText(err)); } } }, 'Usar como miniatura del clip')),
  h('div', { class: 'mut', style: 'margin-top:6px' }, mp.proxy ? 'Reproduciendo un proxy H.264; el still se saca del original.' : 'El still se saca del original con el look del clip (LUT, color y transformación).'));
  upd();
  api.invoke('stills:strip', clip.id, 12).then((frames) => {
    if (tok !== st.tok) return;
    strip.replaceChildren(...frames.map((f, i) => f.img ? h('button', { class: 'fsframe', role: 'listitem', title: `Ir a ${f.t.toFixed(1)} s`, 'aria-label': `Fotograma ${i + 1}, ${f.t.toFixed(1)} segundos`, onclick: () => { p.video.pause(); p.video.currentTime = f.t; } }, h('img', { src: f.img, alt: '' }), h('span', {}, `${f.t.toFixed(1)} s`)) : ''));
  }).catch((err) => { if (tok === st.tok) strip.replaceChildren(h('span', { class: 'bad' }, 'No se pudieron sacar los fotogramas: ' + errText(err))); });
};
