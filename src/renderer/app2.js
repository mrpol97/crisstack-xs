'use strict';
/* Vistas y paneles adicionales: color, comparar, audio, intercambio, archivo, ajustes, atajos. */
const IDENT = () => ({ slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 });
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---------- panel de color / transformacion (dentro del inspector) ---------- */
function colorPanel(sel, one) {
  const ids = sel.map((c) => c.id);
  const look = clone(one?.look || { cdl: IDENT(), lut: null }); if (!look.cdl) look.cdl = IDENT();
  const tr = clone(one?.transform || {}); let t1, t2;
  const live = () => { if (state.player && one && state.playerClipId === one.id) state.player.setLook(look); clearTimeout(t1); t1 = setTimeout(() => api.invoke('look:set', ids, look), 250); };
  const liveTr = () => { if (state.player && one && state.playerClipId === one.id) state.player.setTransform(tr); clearTimeout(t2); t2 = setTimeout(() => api.invoke('transform:set', ids, tr), 250); };
  const ch = ['R', 'G', 'B'];
  const grp = (key, title, min, max, step) => h('div', {}, h('div', { class: 'mut', style: 'margin:6px 0 2px' }, title),
    h('div', { class: 'row', style: 'flex-wrap:nowrap;gap:6px' }, ...[0, 1, 2].map((i) => h('label', { class: 'f', style: 'flex:1' }, ch[i], h('input', { type: 'range', min, max, step, value: look.cdl[key][i], oninput: (e) => { look.cdl[key][i] = Number(e.target.value); live(); } })))));
  const looksBox = h('div', { class: 'row' });
  api.invoke('looks:list').then((ls) => looksBox.replaceChildren(...ls.map((l) => h('span', { class: 'chip', title: 'Aplicar look' }, h('span', { onclick: async () => { look.cdl = clone(l.cdl); look.lut = l.lut; if (l.lut && state.player) await state.player.setLut(await api.invoke('lut:read', l.lut)); live(); render(); } }, l.name), h('button', { class: 'x', style: 'all:unset;cursor:pointer;color:var(--mut)', 'aria-label': 'Borrar look', onclick: async () => { await api.invoke('looks:remove', l.id); render(); } }, '×')))));
  const sel1 = (label, opts, val, fn) => h('label', { class: 'f', style: 'flex:1' }, label, h('select', { onchange: (e) => fn(e.target.value) }, ...opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val ?? '') }, l))));
  const crop = tr.crop || { x: 0, y: 0, w: 1, h: 1 };
  const cs = (k, label) => h('label', { class: 'f', style: 'flex:1' }, label, h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: crop[k], oninput: (e) => { crop[k] = Number(e.target.value); crop.w = Math.min(crop.w, 1 - crop.x); crop.h = Math.min(crop.h, 1 - crop.y); tr.crop = (crop.x || crop.y || crop.w < 1 || crop.h < 1) ? { ...crop } : undefined; liveTr(); } }));
  const body = h('div', {},
    grp('slope', 'Slope (ganancia)', 0, 3, 0.01), grp('offset', 'Offset', -0.3, 0.3, 0.005), grp('power', 'Power (gamma)', 0.3, 3, 0.01),
    h('label', { class: 'f', style: 'margin-top:6px' }, 'Saturación', h('input', { type: 'range', min: 0, max: 2, step: 0.01, value: look.cdl.sat, oninput: (e) => { look.cdl.sat = Number(e.target.value); live(); } })),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn', onclick: () => { look.cdl = IDENT(); look.lut = null; state.player?.setLut(null); live(); render(); } }, 'Reiniciar'),
      h('button', { class: 'btn', onclick: () => { state.lookClip = clone(look); toast('Look copiado'); } }, 'Copiar'),
      h('button', { class: 'btn', onclick: async () => { if (!state.lookClip) return toast('No hay look copiado'); Object.assign(look, clone(state.lookClip)); if (look.lut && state.player) await state.player.setLut(await api.invoke('lut:read', look.lut)); live(); render(); } }, 'Pegar')),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn', onclick: async () => { const p = await api.invoke('dialog:file', [{ name: 'LUT 3D', extensions: ['cube'] }]); if (!p) return; try { look.lut = p; await state.player?.setLut(await api.invoke('lut:read', p)); live(); render(); } catch (e) { toast('LUT no válida: ' + e.message); } } }, look.lut ? 'Cambiar LUT…' : 'Cargar LUT .cube…'),
      look.lut ? h('button', { class: 'btn', onclick: () => { look.lut = null; state.player?.setLut(null); live(); render(); } }, 'Quitar LUT') : '', look.lut ? h('span', { class: 'mono mut', title: look.lut }, look.lut.split(/[\\/]/).pop()) : ''),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn', onclick: async () => { const r = await askForm('Guardar look en la biblioteca', [{ key: 'name', label: 'Nombre' }]); if (r?.name) { await api.invoke('looks:save', { name: r.name, cdl: look.cdl, lut: look.lut }); render(); } } }, 'Guardar look'),
      h('button', { class: 'btn', onclick: async () => { const r = await api.invoke('looks:importCdl'); toast(`CDL: ${r.applied} aplicados a clips, ${r.saved} guardados en la biblioteca`); render(); } }, 'Importar CDL'),
      h('button', { class: 'btn', onclick: async () => { const f = await api.invoke('export:ccc', ids); if (f) toast('CCC guardado'); } }, 'Exportar CCC')),
    h('div', { class: 'mut', style: 'margin:8px 0 2px' }, 'Looks guardados'), looksBox,
    h('div', { class: 'mut', style: 'margin:12px 0 2px' }, 'Transformación de imagen'),
    h('div', { class: 'row' }, sel1('Desqueeze', [[1, '1.0×'], [1.25, '1.25×'], [1.33, '1.33×'], [1.5, '1.5×'], [1.8, '1.8×'], [2, '2.0×']], tr.desqueeze || 1, (v) => { tr.desqueeze = Number(v); liveTr(); }),
      sel1('Espejo', [['', 'Ninguno'], ['h', 'Horizontal'], ['v', 'Vertical'], ['hv', 'Ambos']], tr.flip, (v) => { tr.flip = v || undefined; liveTr(); }),
      sel1('Rotar', [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']], tr.rotate || 0, (v) => { tr.rotate = Number(v) || undefined; liveTr(); })),
    h('div', { class: 'row', style: 'margin-top:6px' }, cs('x', 'Crop X'), cs('y', 'Crop Y'), cs('w', 'Ancho'), cs('h', 'Alto')));
  return h('details', { style: 'margin-top:12px', open: !!(one?.look || one?.transform) }, h('summary', { style: 'cursor:pointer;color:var(--mut);text-transform:uppercase;letter-spacing:.07em;font-size:12px;font-weight:600' }, 'Color y transformación'), body);
}

/* ---------- COMPARAR (cuadricula y cortina) ---------- */
views.compare = async function viewCompare() {
  const clips = (await api.invoke('library:clips', {})).filter((c) => c.kind === 'video');
  const st = state.cmp || (state.cmp = { a: clips[0]?.id, b: clips[1]?.id, mode: 'grid', wipe: 50 });
  main.append(h('h1', {}, 'Comparar'), h('div', { class: 'sub' }, 'Dos clips en cuadrícula o con cortina, con su look aplicado. Los dos se reproducen sincronizados.'));
  if (clips.length < 2) return main.append(h('div', { class: 'empty' }, 'Necesitas al menos dos clips de vídeo en la biblioteca.'));
  const pick = (key) => h('select', { onchange: (e) => { st[key] = e.target.value; render(); } }, ...clips.map((c) => h('option', { value: c.id, selected: st[key] === c.id }, c.name)));
  const stage = h('div', { class: 'card', style: 'padding:8px' }); const hostA = h('div'), hostB = h('div');
  main.append(h('div', { class: 'row' }, h('label', { class: 'f' }, 'A', pick('a')), h('label', { class: 'f' }, 'B', pick('b')),
    h('label', { class: 'f' }, 'Modo', h('select', { onchange: (e) => { st.mode = e.target.value; render(); } }, h('option', { value: 'grid', selected: st.mode === 'grid' }, 'Cuadrícula'), h('option', { value: 'wipe', selected: st.mode === 'wipe' }, 'Cortina')))), stage);
  const ca = clips.find((c) => c.id === st.a), cb = clips.find((c) => c.id === st.b);
  const mk = async (host, c) => { const s = await api.invoke('playback:source', c.id); const p = new CinePlayer(host, { fps: c.meta?.fps }); p.controls.style.display = 'none'; p.load(s.url); p.setLook(c.look); p.setTransform(c.transform || {}); if (c.look?.lut) p.setLut(await api.invoke('lut:read', c.look.lut)); return p; };
  stage.append(h('div', { class: 'mut' }, 'Preparando…'));
  const [pa, pb] = await Promise.all([mk(hostA, ca), mk(hostB, cb)]);
  if (st.mode === 'grid') stage.replaceChildren(h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' }, h('div', {}, hostA, h('div', { class: 'mut' }, 'A · ' + ca.name)), h('div', {}, hostB, h('div', { class: 'mut' }, 'B · ' + cb.name))));
  else {
    const wrap = h('div', { style: 'position:relative' }); hostB.style.cssText = `position:absolute;inset:0;clip-path:inset(0 0 0 ${st.wipe}%)`;
    const line = h('div', { style: `position:absolute;top:0;bottom:0;left:${st.wipe}%;width:2px;background:#ffd33d;pointer-events:none` });
    wrap.append(hostA, hostB, line);
    stage.replaceChildren(wrap, h('input', { type: 'range', min: 0, max: 100, value: st.wipe, style: 'width:100%;margin-top:6px;accent-color:#ffd33d', oninput: (e) => { st.wipe = e.target.value; hostB.style.clipPath = `inset(0 0 0 ${st.wipe}%)`; line.style.left = st.wipe + '%'; } }), h('div', { class: 'mut' }, `A · ${ca.name}   |   B · ${cb.name}`));
  }
  [pa, pb].forEach((p) => (p.video.muted = true)); pa.video.muted = false;
  const seek = h('input', { type: 'range', min: 0, max: 1000, value: 0, style: 'flex:1;accent-color:#4c8dff', oninput: (e) => { const d = Math.min(pa.video.duration || 0, pb.video.duration || 0); pa.video.currentTime = pb.video.currentTime = (e.target.value / 1000) * d; } });
  pa.video.addEventListener('timeupdate', () => { if (pa.video.duration) seek.value = (pa.video.currentTime / pa.video.duration) * 1000; if (Math.abs(pb.video.currentTime - pa.video.currentTime) > 0.15) pb.video.currentTime = pa.video.currentTime; });
  stage.append(h('div', { class: 'row', style: 'margin-top:8px;flex-wrap:nowrap' }, h('button', { class: 'btn', onclick: () => { if (pa.video.paused) { pa.video.play(); pb.video.play(); } else { pa.video.pause(); pb.video.pause(); } } }, '▶ / ⏸'), seek));
};

/* ---------- AUDIO ---------- */
views.audio = async function viewAudio() {
  const A = state.audio || (state.audio = { folder: '', files: [], matches: [], method: 'auto', busy: false });
  const nSel = state.lib.sel.size;
  main.append(h('h1', {}, 'Audio'), h('div', { class: 'sub' }, 'Sincroniza audio externo con los clips por timecode (BWF) o por forma de onda.'),
    h('div', { class: 'card col' },
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const [p] = await api.invoke('dialog:folder', false); if (!p) return; A.folder = p; A.busy = true; render(); A.files = await api.invoke('audio:scan', p); A.matches = []; A.busy = false; render(); } }, 'Carpeta de audio…'), h('span', { class: 'mono mut' }, A.folder ? `${A.folder} · ${A.files.length} ficheros` : 'sin seleccionar')),
      h('div', { class: 'row' }, h('label', { class: 'f' }, 'Método', h('select', { onchange: (e) => (A.method = e.target.value) }, ...[['auto', 'Automático (timecode y, si no, forma de onda)'], ['timecode', 'Solo timecode'], ['waveform', 'Solo forma de onda']].map(([v, l]) => h('option', { value: v, selected: A.method === v }, l)))),
        h('span', { class: 'mut' }, nSel ? `${nSel} clips seleccionados en Biblioteca` : 'Se usarán todos los clips de vídeo')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', disabled: !A.files.length || A.busy, onclick: async () => { A.busy = true; render(); try { A.matches = await api.invoke('audio:match', [...state.lib.sel], A.files, A.method); } catch (e) { toast('Error: ' + e.message); } A.busy = false; render(); } }, A.busy ? 'Analizando…' : 'Buscar coincidencias'),
        h('button', { class: 'btn', disabled: !A.matches.length, onclick: async () => { try { const out = await api.invoke('audio:render', A.matches); toast(`${out.length} clips sincronizados`); api.invoke('shell:reveal', out[0]); } catch (e) { toast('Error: ' + e.message); } } }, 'Renderizar sincronizados'))));
  if (A.matches.length) main.append(h('h2', {}, 'Coincidencias'), h('div', { class: 'card', style: 'padding:0' }, h('table', {}, h('thead', {}, h('tr', {}, ...['Clip', 'Audio', 'Método', 'Desfase', 'Confianza'].map((x) => h('th', {}, x)))),
    h('tbody', {}, ...A.matches.map((m) => h('tr', {}, h('td', {}, m.clipName), h('td', { class: 'mono' }, m.audio.split(/[\\/]/).pop()), h('td', {}, m.method === 'timecode' ? 'Timecode' : 'Forma de onda'), h('td', {}, `${m.offset.toFixed(2)} s`), h('td', {}, m.confidence != null ? Math.round(m.confidence * 100) + ' %' : '—')))))));
};

/* ---------- INTERCAMBIO ---------- */
views.exchange = async function viewExchange() {
  const X = state.exch || (state.exch = { fps: 25, file: '', data: null, match: 'name', key: '', mapping: {}, result: null });
  const ids = [...state.lib.sel];
  const exp = (label, ch) => h('button', { class: 'btn', onclick: async () => { try { const f = await api.invoke(ch, ids, X.fps); if (f) toast('Guardado: ' + f); } catch (e) { toast('Error: ' + e.message); } } }, label);
  main.append(h('h1', {}, 'Intercambio'), h('div', { class: 'sub' }, 'Exporta clips y metadatos a montaje, o importa metadatos desde hojas de rodaje.'),
    h('h2', {}, 'Exportar'), h('div', { class: 'card col' },
      h('div', { class: 'row' }, h('label', { class: 'f', style: 'width:110px' }, 'FPS secuencia', h('input', { type: 'number', value: X.fps, oninput: (e) => (X.fps = Number(e.target.value) || 25) })), h('span', { class: 'mut' }, ids.length ? `${ids.length} clips seleccionados` : 'Todos los clips')),
      h('div', { class: 'row' }, exp('Avid ALE', 'export:ale'), exp('Premiere / FCP7 XML', 'export:fcp7'), exp('Final Cut Pro X / Resolve (FCPXML)', 'export:fcpxml'), exp('CDL (.ccc)', 'export:ccc'), exp('EDL', 'export:edl'), exp('CSV', 'export:csv'))),
    h('h2', {}, 'Importar metadatos'), h('div', { class: 'card col' },
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const p = await api.invoke('dialog:file', [{ name: 'CSV / ALE', extensions: ['csv', 'txt', 'ale', 'tsv'] }]); if (!p) return; try { X.file = p; X.data = await api.invoke('import:parse', p); X.mapping = X.data.mapping; X.key = X.data.columns[0]; X.result = null; render(); } catch (e) { toast('Error: ' + e.message); } } }, 'Elegir fichero…'), h('span', { class: 'mono mut' }, X.file || 'sin seleccionar'))));
  if (X.data) {
    const fields = [['', '(ignorar)'], ['scene', 'Escena'], ['shot', 'Plano'], ['take', 'Toma'], ['camera', 'Cámara'], ['notes', 'Notas'], ['flag', 'Marca'], ['reel', 'Reel'], ...state.lib.fields.map((f) => [f, f + ' (personalizado)'])];
    main.append(h('div', { class: 'card col', style: 'margin-top:10px' }, h('div', { class: 'row' },
      h('label', { class: 'f' }, 'Emparejar por', h('select', { onchange: (e) => (X.match = e.target.value) }, ...[['name', 'Nombre de clip'], ['timecode', 'Timecode de inicio'], ['sst', 'Escena/Plano/Toma']].map(([v, l]) => h('option', { value: v, selected: X.match === v }, l)))),
      h('label', { class: 'f' }, 'Columna clave', h('select', { onchange: (e) => (X.key = e.target.value) }, ...X.data.columns.map((c) => h('option', { value: c, selected: X.key === c }, c))))),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Columna'), h('th', {}, 'Ejemplo'), h('th', {}, 'Campo destino'))),
        h('tbody', {}, ...X.data.columns.map((c) => h('tr', {}, h('td', {}, c), h('td', { class: 'mut' }, X.data.rows[0]?.[c] ?? ''), h('td', {}, h('select', { onchange: (e) => (X.mapping[c] = e.target.value) }, ...fields.map(([v, l]) => h('option', { value: v, selected: (X.mapping[c] || '') === v }, l)))))))),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { X.result = await api.invoke('import:apply', X.data.rows, { match: X.match, keyColumn: X.key, mapping: X.mapping }); toast(`${X.result.updated} clips actualizados`); render(); } }, 'Importar'),
        X.result ? h('span', {}, `${X.result.updated} actualizados`, X.result.unmatched.length ? h('span', { class: 'warn' }, ` · sin coincidencia: ${X.result.unmatched.slice(0, 6).join(', ')}${X.result.unmatched.length > 6 ? '…' : ''}`) : '') : '')));
  }
};

/* ---------- ARCHIVO: ASC MHL, relink, secuencias, subida ---------- */
views.archive = async function viewArchive() {
  const R = state.arch || (state.arch = { root: '', res: null, seal: null, relinkRoots: [], relink: null, seqRoot: '', seq: null, prefix: '', up: null });
  const folderBtn = (label, key, after) => h('button', { class: 'btn', onclick: async () => { const [p] = await api.invoke('dialog:folder', false); if (p) { R[key] = p; after?.(); render(); } } }, label);
  main.append(h('h1', {}, 'Archivo'), h('div', { class: 'sub' }, 'Sellado ASC MHL con historial, relink de ficheros movidos, secuencias de imagen y subida a S3.'),
    h('h2', {}, 'Sello ASC MHL'), h('div', { class: 'card col' },
      h('div', { class: 'row' }, folderBtn('Carpeta…', 'root'), h('span', { class: 'mono mut' }, R.root || 'sin seleccionar')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', disabled: !R.root, onclick: async () => { const r = await api.invoke('mhl:seal', R.root, ['xxh64']); R.seal = r; R.res = null; toast(r.ok ? `Generación ${r.generation} creada (${r.files} ficheros, ${r.new} nuevos)` : 'No se sella: hay ficheros alterados o ausentes'); render(); } }, 'Sellar / nueva generación'),
        h('button', { class: 'btn', disabled: !R.root, onclick: async () => { try { R.res = await api.invoke('mhl:verify', R.root); R.seal = null; } catch (e) { toast(e.message.replace(/^Error invoking.*?: /, '')); } render(); } }, 'Verificar contra historial'))));
  if (R.seal && !R.seal.ok) main.append(h('div', { class: 'card bad', style: 'margin-top:8px' }, 'No se creó la generación. ', ...(R.seal.mismatches || []).map((m) => h('div', {}, `Alterado: ${m.rel}`)), ...(R.seal.missing || []).map((m) => h('div', {}, `Falta: ${m}`))));
  if (R.res) main.append(h('div', { class: 'card', style: 'margin-top:8px;padding:0' }, h('div', { style: 'padding:10px 14px' }, h('b', { class: R.res.ok ? 'ok' : 'bad' }, R.res.ok ? `Todo correcto (generación ${R.res.generation})` : 'Hay problemas'), R.res.chainOk ? '' : h('span', { class: 'bad' }, ` · cadena alterada: ${R.res.chainBad.join(', ')}`)),
    h('table', {}, h('tbody', {}, ...R.res.results.filter((r) => r.status !== 'ok').map((r) => h('tr', {}, h('td', {}, r.rel), h('td', { class: 'bad' }, r.status)))))));
  main.append(h('h2', {}, 'Relink'), h('div', { class: 'card col' },
    h('div', { class: 'list' }, ...R.relinkRoots.map((p, i) => h('div', { class: 'item' }, h('span', {}, p), h('button', { class: 'x', onclick: () => { R.relinkRoots.splice(i, 1); render(); } }, '×')))),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { R.relinkRoots.push(...(await api.invoke('dialog:folder', true))); render(); } }, 'Añadir carpeta de búsqueda…'),
      h('button', { class: 'btn primary', disabled: !R.relinkRoots.length, onclick: async () => { R.relink = await api.invoke('relink:run', R.relinkRoots); toast(`${R.relink.relinked.length} clips reenlazados, ${R.relink.notFound.length} no encontrados`); render(); } }, 'Reenlazar clips perdidos')),
    R.relink ? h('div', {}, `${R.relink.relinked.length} reenlazados`, R.relink.relinked.some((x) => x.ambiguous) ? h('span', { class: 'warn' }, ' (alguno con varios candidatos; se eligió el que coincide en hash)') : '', ` · ${R.relink.notFound.length} sin encontrar`) : ''));
  main.append(h('h2', {}, 'Secuencias de imagen'), h('div', { class: 'card col' },
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const [p] = await api.invoke('dialog:folder', false); if (p) { R.seqRoot = p; R.seq = await api.invoke('sequences:detect', p); render(); } } }, 'Analizar carpeta…'), h('span', { class: 'mono mut' }, R.seqRoot || 'sin seleccionar')),
    R.seq ? h('table', {}, h('tbody', {}, ...R.seq.sequences.map((s) => h('tr', {}, h('td', { class: 'mono' }, s.pattern), h('td', {}, `${s.first}–${s.last} (${s.count} fotogramas)`), h('td', { class: s.gaps.length ? 'bad' : 'ok' }, s.gaps.length ? `faltan ${s.gaps.length}: ${s.gaps.slice(0, 6).join(', ')}${s.gaps.length > 6 ? '…' : ''}` : 'completa'))), ...(R.seq.singles.length ? [h('tr', {}, h('td', { colspan: 3, class: 'mut' }, `${R.seq.singles.length} ficheros sueltos`))] : []))) : ''));
  main.append(h('h2', {}, 'Subir a S3'), h('div', { class: 'card col' },
    h('div', { class: 'row' }, h('label', { class: 'f', style: 'flex:1' }, 'Prefijo en el bucket', h('input', { type: 'text', value: R.prefix, placeholder: 'dailies/dia01', oninput: (e) => (R.prefix = e.target.value) })),
      h('button', { class: 'btn primary', style: 'align-self:end', disabled: !state.lib.sel.size, onclick: async () => { try { R.up = await api.invoke('upload:clips', [...state.lib.sel], R.prefix); toast(`${R.up.length} ficheros subidos`); } catch (e) { toast('Error: ' + e.message); } render(); } }, `Subir ${state.lib.sel.size || 0} clips seleccionados`)),
    h('div', { id: 'uploadBar' }), h('div', { class: 'mut' }, 'Configura endpoint, bucket y claves en Ajustes. Funciona con AWS S3 y servicios compatibles.')));
};
api.on('upload:progress', (e) => { const b = $('#uploadBar'); if (b) b.replaceChildren(h('div', { class: 'mut' }, `${e.file} (${e.i + 1}/${e.n})`), h('div', { class: 'bar' }, h('i', { style: `transform:scaleX(${e.p})` }))); });

/* ---------- AJUSTES ---------- */
views.settings = async function viewSettings() {
  const S = await api.invoke('settings:get'); const projects = await api.invoke('project:list'); const wfs = await api.invoke('workflows:list');
  const s3 = S.s3 || {}; const v = { slack: S.slack || '', endpoint: s3.endpoint || 'https://s3.eu-west-1.amazonaws.com', region: s3.region || 'eu-west-1', bucket: s3.bucket || '', accessKey: s3.accessKey || '', secretKey: '' };
  const inp = (label, key, type = 'text', ph = '') => h('label', { class: 'f', style: 'flex:1;min-width:200px' }, label, h('input', { type, value: v[key], placeholder: ph, oninput: (e) => (v[key] = e.target.value) }));
  main.append(h('h1', {}, 'Ajustes'),
    h('h2', {}, 'Proyecto'), h('div', { class: 'card row' }, h('label', { class: 'f' }, 'Proyecto activo', h('select', { onchange: async (e) => { await api.invoke('project:switch', e.target.value); state.lib.sel.clear(); toast('Proyecto cambiado'); render(); } }, ...projects.map((p) => h('option', { value: p.id, selected: p.id === S.project }, p.name)))),
      h('button', { class: 'btn', style: 'align-self:end', onclick: async () => { await newProject(); } }, 'Nuevo proyecto…'),
      h('button', { class: 'btn', style: 'align-self:end', onclick: async () => { const f = await api.invoke('archive:export'); if (f) toast('Archivo guardado'); } }, 'Exportar biblioteca…'),
      h('button', { class: 'btn', style: 'align-self:end', onclick: async () => { try { const r = await api.invoke('archive:import'); if (r) { toast(`${r.clips} clips importados`); render(); } } catch (e) { toast('Error: ' + e.message); } } }, 'Importar biblioteca…')),
    h('h2', {}, 'Avisos (Slack)'), h('div', { class: 'card row' }, inp('URL del webhook entrante', 'slack', 'text', 'https://hooks.slack.com/services/…'),
      h('button', { class: 'btn', style: 'align-self:end', onclick: async () => { await api.invoke('settings:set', { slack: v.slack }); try { await api.invoke('slack:test'); toast('Aviso de prueba enviado'); } catch (e) { toast('Error: ' + e.message); } } }, 'Guardar y probar')),
    h('h2', {}, 'Subida S3'), h('div', { class: 'card col' }, h('div', { class: 'row' }, inp('Endpoint', 'endpoint'), inp('Región', 'region'), inp('Bucket', 'bucket')), h('div', { class: 'row' }, inp('Access key', 'accessKey'), inp('Secret key', 'secretKey', 'password', s3.hasSecret ? '(guardada, deja vacío para mantenerla)' : '')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { await api.invoke('settings:set', { slack: v.slack, s3: { endpoint: v.endpoint, region: v.region, bucket: v.bucket, accessKey: v.accessKey, secretKey: v.secretKey } }); toast('Ajustes guardados'); render(); } }, 'Guardar'),
        h('span', { class: 'mut' }, S.encrypted ? 'La clave se guarda cifrada con el almacén del sistema.' : 'Aviso: el sistema no ofrece cifrado; la clave se guarda solo ofuscada.'))),
    h('h2', {}, 'Workflows guardados'), h('div', { class: 'card' }, wfs.length ? h('div', { class: 'list' }, ...wfs.map((w) => h('div', { class: 'item' }, h('span', {}, w.name), h('button', { class: 'x', 'aria-label': 'Borrar', onclick: async () => { await api.invoke('workflows:remove', w.name); render(); } }, '×')))) : h('span', { class: 'mut' }, 'Guarda uno desde la pestaña Offload.')),
    h('h2', {}, 'Atajos de teclado'), shortcutsEditor());
};

/* ---------- atajos de teclado configurables ---------- */
const DEFAULT_KEYS = { good: 'g', bad: 'b', hold: 'h', clear: '0', r1: '1', r2: '2', r3: '3', r4: '4', r5: '5', next: 'ArrowDown', prev: 'ArrowUp' };
const KEY_LABELS = { good: 'Marcar como bueno', bad: 'Marcar como malo', hold: 'Marcar como pendiente', clear: 'Quitar marca', r1: '1 estrella', r2: '2 estrellas', r3: '3 estrellas', r4: '4 estrellas', r5: '5 estrellas', next: 'Clip siguiente', prev: 'Clip anterior' };
const loadKeys = () => { try { return { ...DEFAULT_KEYS, ...JSON.parse(localStorage.getItem('cine.keys') || '{}') }; } catch { return { ...DEFAULT_KEYS }; } };
function shortcutsEditor() {
  const keys = loadKeys();
  return h('div', { class: 'card' }, h('table', {}, h('tbody', {}, ...Object.entries(KEY_LABELS).map(([id, label]) => h('tr', {}, h('td', {}, label), h('td', {}, h('button', { class: 'btn mono', onclick: (e) => {
    const b = e.target; b.textContent = 'pulsa una tecla…';
    const fn = (ev) => { ev.preventDefault(); ev.stopPropagation(); document.removeEventListener('keydown', fn, true); keys[id] = ev.key; try { localStorage.setItem('cine.keys', JSON.stringify(keys)); } catch { /* sin storage */ } b.textContent = ev.key; };
    document.addEventListener('keydown', fn, true);
  } }, keys[id])))))), h('button', { class: 'btn', style: 'margin-top:8px', onclick: () => { try { localStorage.removeItem('cine.keys'); } catch { /* */ } render(); } }, 'Restaurar por defecto'));
}
document.addEventListener('keydown', async (e) => {
  if (state.view !== 'library' || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return;
  const keys = loadKeys(); const id = Object.keys(keys).find((k) => keys[k] === e.key); if (!id) return;
  const L = state.lib, sel = [...L.sel];
  if (id === 'next' || id === 'prev') { e.preventDefault(); const i = L.clips.findIndex((c) => c.id === L.last_id || L.sel.has(c.id)); const j = Math.min(L.clips.length - 1, Math.max(0, i + (id === 'next' ? 1 : -1))); const c = L.clips[j]; if (c) { L.sel = new Set([c.id]); L.last = j; L.last_id = c.id; drawClips($('#clipGrid')); drawInspector(); } return; }
  if (!sel.length) return;
  const patch = { good: { flag: 'good' }, bad: { flag: 'bad' }, hold: { flag: 'hold' }, clear: { flag: '', rating: 0 }, r1: { rating: 1 }, r2: { rating: 2 }, r3: { rating: 3 }, r4: { rating: 4 }, r5: { rating: 5 } }[id];
  if (patch) { await api.invoke('library:bulk', sel, patch); refreshClips(); }
});
