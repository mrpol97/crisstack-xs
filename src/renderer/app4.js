'use strict';
/* v0.4: offload (origenes camara/sonido y ficheros sueltos, varios informes, progreso con pasos y tiempo estimado, accesos a carpetas),
   ajustes de transcode compartidos con previsualizacion e informes configurables. */
const FILE_MANAGER = /Mac/i.test(navigator.platform) ? 'Finder' : 'el Explorador';
const DEFAULT_TEMPLATE = '{project}/Dia_{day}/Camara_{camera}/{reel}';
const DEFAULT_SOUND_TEMPLATE = '{project}/Dia_{day}/Sonido/{reel}';
const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/* ---------- tiempos ---------- */
const fmtClock = (s) => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60), x = s % 60; return `${m}:${String(x).padStart(2, '0')}`; };
function fmtEta(sec) {
  if (!isFinite(sec) || sec < 0) return 'calculando…';
  if (sec < 10) return 'unos segundos';
  if (sec < 60) return `${Math.round(sec / 5) * 5} s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  if (m < 60) return `${m} min${m < 10 ? ` ${String(s).padStart(2, '0')} s` : ''}`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/* ---------- ajustes de transcode (compartidos por Offload y Transcodificar) ---------- */
const TC_RES = [['', 'Original'], ['2160', '2160p (4K UHD)'], ['1440', '1440p'], ['1080', '1080p (Full HD)'], ['720', '720p (HD)'], ['540', '540p'], ['360', '360p'], ['custom', 'Personalizada…']];
const TC_POS = [['bottom-left', 'Abajo izquierda'], ['bottom-center', 'Abajo centro'], ['bottom-right', 'Abajo derecha'], ['top-left', 'Arriba izquierda'], ['top-center', 'Arriba centro'], ['top-right', 'Arriba derecha'], ['center', 'Centro']];
const META_OPTS = [['project', 'Proyecto'], ['production', 'Productora'], ['director', 'Director'], ['cinematographer', 'Dir. fotografía'], ['dit', 'DIT'], ['dataManager', 'Data manager'], ['copyright', 'Copyright'],
  ['scene', 'Escena'], ['shot', 'Plano'], ['take', 'Toma'], ['camera', 'Cámara'], ['reel', 'Reel'], ['shotId', 'ShotID'], ['notes', 'Notas'], ['flag', 'Marca'], ['rating', 'Valoración'], ['iso', 'ISO'], ['wb', 'WB'], ['lens', 'Lente'], ['shutter', 'Shutter']];
const newTc = () => ({ preset: 'prores_proxy', res: '', height: '', lut: '', burnTimecode: false, burnName: false, textOn: false, text: '', textPos: 'bottom-left', textSize: 26, applyLooks: true, keepTimecode: true, s3: false, s3prefix: '', dir: '', metaFields: ['project', 'scene', 'shot', 'take', 'camera', 'reel', 'shotId', 'notes'] });
function tcCfg(t) {
  const height = t.res === 'custom' ? (Number(t.height) || undefined) : t.res ? Number(t.res) : undefined;
  return { preset: t.preset, height, lut: t.lut || undefined, burnTimecode: !!t.burnTimecode, burnName: !!t.burnName,
    text: t.textOn && String(t.text).trim() ? { value: String(t.text).trim(), pos: t.textPos, size: Number(t.textSize) || 26 } : undefined,
    applyLooks: t.applyLooks !== false, keepTimecode: t.keepTimecode !== false, s3: !!t.s3, s3prefix: t.s3prefix || '', dir: t.dir || undefined, metaFields: [...(t.metaFields || [])] };
}

/** Panel de ajustes. t: objeto de ajustes (se modifica); presets: [{id,label}]; custom: nombres de campos propios; onChange: cambios que redibujan; onTouch: cualquier cambio. */
function tcPanel(t, { presets, custom = [], onChange, onTouch }) {
  const touch = () => onTouch?.();
  const chip = (label, key, title = '') => h('label', { class: 'chip', title }, h('input', { type: 'checkbox', checked: !!t[key], onchange: (e) => { t[key] = e.target.checked; touch(); if (['textOn', 's3'].includes(key)) onChange?.(); } }), label);
  const sel = (label, opts, val, fn, w = '') => h('label', { class: 'f', style: w ? `width:${w}` : '' }, label, h('select', { onchange: (e) => { fn(e.target.value); touch(); } }, ...opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val ?? '') }, l))));
  const metaAll = [...META_OPTS, ...custom.map((n) => ['custom:' + n, n + ' (propio)'])];
  const metaChip = ([id, label]) => h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: t.metaFields.includes(id), onchange: (e) => { t.metaFields = e.target.checked ? [...new Set([...t.metaFields, id])] : t.metaFields.filter((x) => x !== id); touch(); } }), label);
  return h('div', { class: 'tcpanel' },
    h('div', { class: 'row' },
      sel('Formato', presets.map((p) => [p.id, p.label]), t.preset, (v) => (t.preset = v), '220px'),
      sel('Píxeles (altura)', TC_RES, t.res, (v) => { t.res = v; onChange?.(); }, '190px'),
      t.res === 'custom' ? h('label', { class: 'f', style: 'width:110px' }, 'Altura px', h('input', { type: 'number', min: 64, step: 2, value: t.height, placeholder: '1080', oninput: (e) => { t.height = e.target.value; touch(); } })) : ''),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { class: 'btn', onclick: async () => { const p = await api.invoke('dialog:file', [{ name: 'LUT 3D', extensions: ['cube'] }]); if (p) { t.lut = p; touch(); onChange?.(); } } }, t.lut ? 'Cambiar LUT…' : 'Añadir LUT .cube…'),
      t.lut ? h('span', { class: 'mono mut', title: t.lut }, t.lut.split(/[\\/]/).pop()) : h('span', { class: 'mut' }, 'Sin LUT extra (los looks de cada clip se aplican aparte)'),
      t.lut ? h('button', { class: 'btn', onclick: () => { t.lut = ''; touch(); onChange?.(); } }, 'Quitar') : ''),
    h('div', { class: 'chips', style: 'margin-top:10px' },
      chip('Timecode quemado', 'burnTimecode'), chip('Nombre del clip quemado', 'burnName'), chip('Texto libre quemado', 'textOn', 'Escribe un texto que se imprime sobre la imagen'),
      chip('Aplicar looks y transformaciones', 'applyLooks', 'Aplica el CDL, la LUT y el recorte/giro de cada clip'), chip('Conservar el timecode del original', 'keepTimecode'), chip('Subir a S3', 's3')),
    t.textOn ? h('div', { class: 'row', style: 'margin-top:8px' },
      h('label', { class: 'f', style: 'flex:1;min-width:220px' }, 'Texto', h('input', { type: 'text', value: t.text, placeholder: 'p. ej. COPIA DE TRABAJO — NO DISTRIBUIR', oninput: (e) => { t.text = e.target.value; touch(); } })),
      sel('Posición', TC_POS, t.textPos, (v) => (t.textPos = v), '170px'),
      sel('Tamaño', [['36', 'Pequeño'], ['26', 'Medio'], ['18', 'Grande']], String(t.textSize), (v) => (t.textSize = Number(v)), '120px')) : '',
    t.s3 ? h('label', { class: 'f', style: 'margin-top:8px;max-width:360px' }, 'Prefijo en el bucket S3', h('input', { type: 'text', value: t.s3prefix, placeholder: 'dailies/dia01', oninput: (e) => { t.s3prefix = e.target.value; touch(); } })) : '',
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { class: 'btn', onclick: async () => { const [p] = await api.invoke('dialog:folder', false); if (p) { t.dir = p; touch(); onChange?.(); } } }, 'Carpeta de salida…'),
      h('span', { class: 'mono mut', title: t.dir || '' }, t.dir || 'Predeterminada: Documentos/Cinestack Transcodes'),
      t.dir ? h('button', { class: 'btn', onclick: () => { t.dir = ''; touch(); onChange?.(); } }, 'Predeterminada') : ''),
    h('details', { style: 'margin-top:12px', open: true }, h('summary', { class: 'tcsum' }, 'Ajustes de transcode · metadatos a transportar'),
      h('div', { class: 'mut', style: 'margin:6px 0' }, 'Se escriben dentro del fichero transcodificado (MOV/MP4). Marca los datos del clip y del proyecto que quieres llevar.'),
      h('div', { class: 'chips' }, ...metaAll.map(metaChip)),
      h('div', { class: 'row', style: 'margin-top:6px' },
        h('button', { class: 'btn', onclick: () => { t.metaFields = metaAll.map(([id]) => id); touch(); onChange?.(); } }, 'Todos'), h('button', { class: 'btn', onclick: () => { t.metaFields = []; touch(); onChange?.(); } }, 'Ninguno'))));
}

/* ---------- OFFLOAD ---------- */
async function viewOffload2() {
  const o = state.offload;
  if (o.template === '{project}/Dia_{day}/{camera}_{reel}' || !o.template) o.template = DEFAULT_TEMPLATE;
  o.soundTemplate = o.soundTemplate || DEFAULT_SOUND_TEMPLATE; o.reports = Array.isArray(o.reports) ? o.reports : []; o.tc = o.tc || newTc(); o.tc.metaFields = o.tc.metaFields || newTc().metaFields;
  o.sources = o.sources.map((s) => (typeof s === 'string' ? { path: s, type: 'camera' } : s));
  const [vols, presets, wfs, P, reps, fields] = await Promise.all([api.invoke('volumes:list'), api.invoke('presets:list'), api.invoke('workflows:list'), api.invoke('project:get'), api.invoke('reports:list'), api.invoke('library:fields:list')]);
  const pinfo = P.info; if (pinfo?.name) o.project = pinfo.name;
  o.reports = o.reports.filter((id) => reps.some((r) => r.id === id));

  const isFile = (s) => s.isFile;
  const srcList = h('div', { class: 'list' }, ...(o.sources.length ? o.sources.map((s, i) => h('div', { class: 'item srcitem' },
    h('span', { class: 'ficon', 'aria-hidden': 'true' }, isFile(s) ? '▫' : '▤'), h('span', { title: s.path, class: 'grow' }, s.path),
    h('select', { 'aria-label': 'Tipo de origen', onchange: (e) => { s.type = e.target.value; render(); } }, h('option', { value: 'camera', selected: s.type !== 'sound' }, 'Cámara'), h('option', { value: 'sound', selected: s.type === 'sound' }, 'Sonido')),
    h('button', { class: 'x', 'aria-label': 'Quitar', onclick: () => { o.sources.splice(i, 1); render(); } }, '×'))) : [h('div', { class: 'mut' }, 'Añade una tarjeta, una carpeta o ficheros sueltos. Indica si es de cámara o de sonido.')]));
  const addSources = (paths, isF) => { for (const p of paths) if (!o.sources.some((s) => s.path === p)) o.sources.push({ path: p, type: 'camera', isFile: isF }); render(); };
  const dstList = h('div', { class: 'list' }, ...(o.destinations.length ? o.destinations.map((p, i) => h('div', { class: 'item' }, h('span', { title: p }, p), h('button', { class: 'x', 'aria-label': 'Quitar', onclick: () => { o.destinations.splice(i, 1); render(); } }, '×'))) : [h('div', { class: 'mut' }, 'Añade al menos un destino. Con varios destinos se hace backup redundante.')]));
  const algo = (id, label) => h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: o.algos.includes(id), onchange: (e) => { o.algos = e.target.checked ? [...new Set([...o.algos, id])] : o.algos.filter((x) => x !== id); if (!o.algos.length) { o.algos = ['xxh64']; render(); } } }), label);
  const ctx = { project: o.project, day: o.day, camera: o.camera, source: o.sources.find((s) => s.type !== 'sound')?.path || 'A001' };
  const prevCam = h('div', { class: 'mono mut' }), prevSnd = h('div', { class: 'mono mut' });
  const upd = async () => {
    prevCam.textContent = 'Cámara → ' + await api.invoke('wildcards:preview', o.template, { ...ctx, type: 'camera' });
    prevSnd.textContent = 'Sonido → ' + await api.invoke('wildcards:preview', o.soundTemplate, { ...ctx, source: o.sources.find((s) => s.type === 'sound')?.path || 'SD001', type: 'sound' });
  };
  const tin = (label, key, flex = '2') => h('label', { class: 'f', style: `flex:${flex};min-width:260px` }, label, h('input', { type: 'text', value: o[key], oninput: (e) => { o[key] = e.target.value; upd(); } }));
  const repChips = reps.map((r) => h('label', { class: 'chip', title: `${r.type} · ${r.format.toUpperCase()}` }, h('input', { type: 'checkbox', checked: o.reports.includes(r.id), onchange: (e) => { o.reports = e.target.checked ? [...new Set([...o.reports, r.id])] : o.reports.filter((x) => x !== r.id); } }), r.name));
  const ready = o.sources.length && o.destinations.length && !o.running;

  main.append(h('p', { class: 'mut', style: 'margin-top:0' }, 'Copia con checksum a varios destinos a la vez y verifica releyendo cada copia.'),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Origen'), srcList,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => addSources(await api.invoke('dialog:folder', true), false) }, 'Añadir carpeta…'),
          h('button', { class: 'btn', onclick: async () => addSources(await api.invoke('dialog:files'), true) }, 'Añadir ficheros sueltos…'),
          ...vols.slice(0, 6).map((v) => h('button', { class: 'btn', title: v.path, onclick: () => addSources([v.path], false) }, v.name)))),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Destinos'), dstList,
        h('button', { class: 'btn', onclick: async () => { o.destinations.push(...(await api.invoke('dialog:folder', true))); render(); } }, 'Añadir destino…'))),
    h('h2', {}, 'Estructura de carpetas'),
    h('div', { class: 'card col' },
      h('div', { class: 'row' }, tin('Plantilla para cámara', 'template'), tin('Plantilla para sonido', 'soundTemplate'),
        h('label', { class: 'f', style: 'width:90px' }, 'Cámara', h('input', { type: 'text', value: o.camera, oninput: (e) => { o.camera = e.target.value; upd(); } })),
        h('label', { class: 'f', style: 'width:80px' }, 'Día', h('input', { type: 'number', min: 1, value: o.day, oninput: (e) => { o.day = Number(e.target.value); upd(); } }))),
      prevCam, prevSnd,
      pinfo?.name ? h('div', { class: 'projlink' }, h('b', {}, 'Proyecto: '), pinfo.name, ...[['production', ''], ['director', 'Dir. '], ['dit', 'DIT ']].filter(([k]) => pinfo[k]).map(([k, p]) => h('span', { class: 'mut' }, ` · ${p}${pinfo[k]}`)), h('span', { class: 'mut' }, ' — sale en informes y en la lista MHL.'), h('button', { class: 'btn', style: 'margin-left:8px', onclick: async () => { await editProject(); render(); } }, 'Editar'))
        : h('div', { class: 'projlink warn' }, 'Aún no hay proyecto. ', h('button', { class: 'btn', onclick: newProject }, 'Crear proyecto'), ' para enlazar nombre, equipo y logo.'),
      h('div', { class: 'mut' }, 'Comodines: {project} {day} {camera} {type} {reel} {card} {volume} {date} {yyyy} {mm} {dd} {time} {counter}. Los orígenes de tipo Sonido usan la plantilla de sonido: así Día 1 queda con su carpeta de cámara y su carpeta de sonido.')),
    h('h2', {}, 'Verificación y post-pasos'),
    h('div', { class: 'card col' },
      h('div', { class: 'chips' }, algo('xxh64', 'XXH64'), algo('md5', 'MD5'), algo('sha1', 'SHA-1'), algo('sha256', 'SHA-256'),
        h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: o.verify, onchange: (e) => (o.verify = e.target.checked) }), 'Releer y verificar destinos'),
        h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: o.mhl, onchange: (e) => (o.mhl = e.target.checked) }), 'Escribir lista MHL'),
        h('label', { class: 'chip', title: 'Historial ASC MHL en cada carpeta de destino' }, h('input', { type: 'checkbox', checked: o.ascmhl, onchange: (e) => (o.ascmhl = e.target.checked) }), 'Sellar con ASC MHL')),
      h('div', { class: 'row' },
        h('label', { class: 'f', style: 'flex:1;min-width:240px' }, 'Renombrar ficheros al copiar (opcional)', h('input', { type: 'text', value: o.rename, placeholder: '{reel}_{counter:3}  ·  {name} {ext} {reel} {camera} {project} {counter:N} {date}', oninput: (e) => (o.rename = e.target.value) })),
        h('label', { class: 'f', style: 'flex:1;min-width:240px' }, 'Script al terminar (opcional)', h('input', { type: 'text', value: o.script, placeholder: 'Variables: CINESTACK_REEL, CINESTACK_DEST', oninput: (e) => (o.script = e.target.value) })))),
    h('h2', {}, 'Informes al terminar'),
    h('div', { class: 'card col' }, h('div', { class: 'mut' }, 'Marca todos los que quieras: se generan uno detrás de otro con los clips de esta copia.'), h('div', { class: 'chips' }, ...repChips),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => go('reports') }, 'Crear o editar informes…'))),
    h('h2', {}, 'Transcodificar al terminar'),
    h('div', { class: 'card col' },
      h('label', { class: 'chip', style: 'align-self:flex-start' }, h('input', { type: 'checkbox', checked: !!o.tcOn, onchange: (e) => { o.tcOn = e.target.checked; render(); } }), 'Transcodificar los clips de vídeo al terminar la copia'),
      o.tcOn ? tcPanel(o.tc, { presets, custom: fields, onChange: render }) : h('div', { class: 'mut' }, 'Al activarlo verás aquí las opciones: formato, píxeles, LUT, timecode y nombre quemados, texto, looks, S3, carpeta de salida y metadatos.')),
    h('div', { class: 'card col', style: 'margin-top:10px' }, h('div', { class: 'row' },
      h('label', { class: 'f' }, 'Workflow guardado', h('select', { id: 'wfSel' }, h('option', { value: '' }, '—'), ...wfs.map((w) => h('option', { value: w.name }, w.name)))),
      h('button', { class: 'btn', style: 'align-self:end', onclick: () => { const w = wfs.find((x) => x.name === $('#wfSel').value); if (w) { Object.assign(o, w.cfg, { running: false }); render(); toast('Workflow cargado'); } } }, 'Cargar'),
      h('button', { class: 'btn', style: 'align-self:end', onclick: async () => { const r = await askForm('Guardar workflow', [{ key: 'n', label: 'Nombre' }]); if (r?.n) { const { sources, running, ...cfg } = o; await api.invoke('workflows:save', { name: r.n, cfg: JSON.parse(JSON.stringify(cfg)) }); toast('Workflow guardado'); render(); } } }, 'Guardar actual'))),
    h('div', { class: 'row', style: 'margin-top:16px' },
      h('button', { class: 'btn primary', disabled: !ready, onclick: startOffload }, o.running ? 'En curso…' : 'Iniciar offload'),
      h('button', { class: 'btn danger', disabled: !o.running, onclick: () => api.invoke('job:cancel') }, 'Cancelar'),
      !o.sources.length || !o.destinations.length ? h('span', { class: 'mut' }, 'Falta ' + [!o.sources.length && 'un origen', !o.destinations.length && 'un destino'].filter(Boolean).join(' y ') + '.') : ''),
    h('div', { id: 'progress', style: 'margin-top:16px' }));
  upd(); renderProgress();
}

async function startOffload() {
  const o = state.offload; o.running = true; state.jobs = state.progress = {}; render();
  const cfg = { sources: o.sources.map((s) => ({ path: s.path, type: s.type })), destinations: o.destinations, template: o.template, soundTemplate: o.soundTemplate, project: o.project, camera: o.camera, day: o.day,
    algos: o.algos, verify: o.verify, mhl: o.mhl, ascmhl: o.ascmhl, rename: o.rename || undefined, script: o.script || undefined, reports: o.reports, transcode: o.tcOn ? tcCfg(o.tc) : null };
  try { await api.invoke('workflow:start', cfg); } catch (e) { toast('Error: ' + errText(e)); }
  o.running = false; if (state.view === 'offload') { const keep = state.progress; await render(); state.jobs = state.progress = keep; renderProgress(); }
}

/* ---------- progreso: pasos, fichero actual, velocidad y tiempo estimado ---------- */
let renderTimer = null;
const scheduleRender = () => { if (renderTimer) return; renderTimer = setTimeout(() => { renderTimer = null; if (state.view === 'offload') renderProgress(); }, 150); };
const STEP_ICON = { done: '✓', run: '●', error: '✖', skip: '–', pending: '○' };

api.on('job:start', (e) => {
  state.jobs = state.progress; state.progress[e.key] = { key: e.key, reel: e.reel, type: e.type, loose: e.loose, nfiles: e.files, index: e.index, total: e.total, pct: 0, label: `${e.reel}: preparando`, done: false,
    steps: (e.steps || []).map((s) => ({ ...s, status: 'pending' })), t0: Date.now(), lastT: Date.now(), lastBytes: 0, speed: 0 };
  runningCount++; updateBadge(); scheduleRender();
});
api.on('job:step', (e) => { const j = state.progress[e.key]; const s = j?.steps.find((x) => x.id === e.step); if (s) s.status = e.status; scheduleRender(); });
api.on('job:progress', (e) => {
  const j = state.progress[e.key]; if (!j) return;
  Object.assign(j, { phase: e.phase, current: e.current, fileIndex: e.fileIndex, files: e.files, dest: e.dest, destCount: e.destCount, doneBytes: e.doneBytes, totalBytes: e.totalBytes, verify: e.verify });
  j.pct = e.totalBytes ? (e.doneBytes / e.totalBytes) * 100 : 100;
  const now = Date.now(); const dt = (now - j.lastT) / 1000;
  if (dt >= 0.5) { const inst = (e.doneBytes - j.lastBytes) / dt; j.speed = j.speed ? j.speed * 0.7 + inst * 0.3 : inst; j.lastT = now; j.lastBytes = e.doneBytes; } // velocidad suavizada
  j.eta = j.speed > 0 ? (e.totalBytes - e.doneBytes) / j.speed : NaN;
  const what = e.phase === 'verify' ? (e.destCount > 1 ? `Verificando destino ${e.dest} de ${e.destCount}` : 'Verificando la copia') : 'Copiando';
  j.label = `${j.reel}: ${what} (${Math.round(j.pct)} %)`;
  drawJobsBar(); scheduleRender();
});
api.on('job:done', (e) => {
  const j = state.progress[e.key] || (state.progress[e.key] = { key: e.key, steps: [] });
  Object.assign(j, { pct: 100, done: true, ok: e.ok, folders: e.folders || [], post: e.post || [], failures: e.failures, error: e.error, elapsed: (Date.now() - (j.t0 || Date.now())) / 1000, files: e.files ?? j.files, bytes: e.bytes });
  j.label = e.ok ? 'Copiado y verificado' : (e.error || `${e.failures} fallos de verificación`);
  runningCount = Math.max(0, runningCount - 1); updateBadge();
  toast(e.ok ? `Offload de ${j.reel || 'la tarjeta'} completado y verificado` : `Offload con problemas: ${j.label}`);
  if (state.view === 'library') refreshClips();
  scheduleRender();
});

function jobCard(j) {
  const pending = j.steps.filter((s) => s.status === 'pending' || s.status === 'run');
  const head = h('div', { class: 'row', style: 'justify-content:space-between;flex-wrap:nowrap' },
    h('div', { class: 'jtitle' }, h('b', {}, j.reel || 'Offload'), h('span', { class: 'badge2' }, j.type === 'sound' ? 'Sonido' : 'Cámara'), j.loose ? h('span', { class: 'badge2' }, `${j.nfiles || ''} ficheros sueltos`) : '', j.total > 1 ? h('span', { class: 'mut' }, ` · trabajo ${j.index + 1} de ${j.total}`) : ''),
    h('span', { class: j.done ? (j.ok ? 'ok' : 'bad') : 'mut' }, j.done ? (j.ok ? 'Terminado' : 'Con problemas') : `${Math.round(j.pct)} %`));
  const stepsEl = h('div', { class: 'steps', role: 'list' }, ...j.steps.map((s) => h('span', { class: `step st-${s.status}`, role: 'listitem', title: s.label }, h('i', { 'aria-hidden': 'true' }, STEP_ICON[s.status]), s.label)));
  const bar = h('div', { class: 'bar', style: 'margin:8px 0' }, h('i', { style: `transform:scaleX(${(j.pct || 0) / 100})` }));
  let detail;
  if (!j.done) {
    const what = j.phase === 'verify' ? (j.destCount > 1 ? `Verificando destino ${j.dest} de ${j.destCount}` : 'Verificando la copia') : j.phase === 'copy' ? (j.destCount > 1 ? `Copiando a ${j.destCount} destinos a la vez` : 'Copiando') : 'Preparando';
    detail = h('div', { class: 'jdetail' },
      h('div', {}, h('b', {}, what), j.current ? h('span', { class: 'mono', title: j.current }, ' · ' + j.current) : ''),
      h('div', { class: 'mut' }, [j.files ? `Fichero ${j.fileIndex || 1} de ${j.files}` : '', j.totalBytes ? `${fmtBytes(j.doneBytes || 0)} de ${fmtBytes(j.totalBytes)}${j.verify ? ' (copia + verificación)' : ''}` : '',
        j.speed ? `${fmtBytes(j.speed)}/s` : '', `transcurrido ${fmtClock((Date.now() - j.t0) / 1000)}`, pending.length && j.speed ? `faltan ≈ ${fmtEta(j.eta)}` : 'calculando el tiempo restante…'].filter(Boolean).join(' · ')));
  } else {
    detail = h('div', { class: 'jdetail' },
      h('div', { class: j.ok ? 'ok' : 'bad' }, j.ok ? `Todo copiado y verificado en ${fmtClock(j.elapsed)}${j.files ? ` · ${j.files} ${j.files === 1 ? 'fichero' : 'ficheros'}` : ''}${j.bytes ? ` · ${fmtBytes(j.bytes)}` : ''}` : (j.error || `${j.failures} ficheros no coinciden con el original`)),
      j.folders?.length ? h('div', { class: 'folderlinks' }, h('span', { class: 'mut' }, `Abrir en ${FILE_MANAGER}:`), ...j.folders.map((f) => h('button', { class: 'btn', title: f.path, onclick: () => api.invoke('shell:open', f.path).then((r) => r && toast('No se pudo abrir: ' + r)) }, f.label))) : '');
  }
  return h('div', { class: 'card jobcard', style: 'margin-bottom:10px' }, head, stepsEl, bar, detail);
}
function renderProgress() {
  const box = $('#progress'); if (!box) return;
  const jobs = Object.values(state.progress).filter((j) => j.steps).slice(-8);
  jobs.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0)); // lo que se esta copiando ahora, primero
  box.replaceChildren(...jobs.map(jobCard));
}

/* ---------- TRANSCODIFICAR (con previsualizacion) ---------- */
async function viewTranscode2() {
  const t = state.transcode; if (!t.metaFields) Object.assign(t, { ...newTc(), ...t, metaFields: newTc().metaFields });
  const [presets, fields, clips] = await Promise.all([api.invoke('presets:list'), api.invoke('library:fields:list'), api.invoke('library:clips', {})]);
  const videos = clips.filter((c) => c.kind === 'video');
  const ids = state.lib.sel.size ? [...state.lib.sel].filter((id) => videos.some((v) => v.id === id)) : videos.map((c) => c.id);
  const pv = state.tcPrev || (state.tcPrev = { clipId: null, pos: 0.5, img: '', busy: false, err: '' });
  if (!videos.some((c) => c.id === pv.clipId)) pv.clipId = (ids[0] || videos[0]?.id) ?? null;

  const imgBox = h('div', { class: 'prevbox' });
  const drawPrev = () => imgBox.replaceChildren(pv.busy ? h('div', { class: 'mut' }, 'Generando previsualización…') : pv.err ? h('div', { class: 'bad' }, pv.err) : pv.img ? h('img', { src: pv.img, alt: 'Previsualización del transcode' }) : h('div', { class: 'mut' }, videos.length ? 'Pulsa «Actualizar previsualización» para ver cómo quedará con los ajustes elegidos.' : 'Importa o copia algún clip de vídeo para previsualizar.'));
  let timer = null;
  const refreshPrev = async () => {
    const c = videos.find((v) => v.id === pv.clipId); if (!c) return; pv.busy = true; pv.err = ''; drawPrev();
    try { pv.img = await api.invoke('transcode:preview', c.id, tcCfg(t), Math.max(0, (c.meta?.duration || 2) * pv.pos - 0.05)); } catch (e) { pv.err = errText(e); pv.img = ''; }
    pv.busy = false; drawPrev();
  };
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => { if (pv.img) refreshPrev(); }, 700); }; // si ya hay imagen, se actualiza sola al cambiar ajustes

  main.append(h('p', { class: 'mut', style: 'margin-top:0' }, `Se transcodificarán ${ids.length} ${ids.length === 1 ? 'clip' : 'clips'} de vídeo${state.lib.sel.size ? ' seleccionados' : ' (toda la biblioteca)'}.`),
    h('div', { class: 'tcgrid' },
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Ajustes de transcode'), tcPanel(t, { presets, custom: fields, onChange: render, onTouch: touch }),
        h('div', { class: 'row', style: 'margin-top:14px' },
          h('button', { class: 'btn primary', disabled: !ids.length, onclick: () => { state.tcResults = null; api.invoke('transcode:start', ids, tcCfg(t)); toast('Transcodificación en cola: sigue el progreso en la barra inferior'); } }, 'Iniciar transcodificación'),
          h('button', { class: 'btn', disabled: ids.length < 2, title: 'Une los clips en un solo fichero', onclick: async () => { try { toast('Creando clip combinado…'); const f = await api.invoke('combine:run', ids, t.preset, tcCfg(t).height); toast('Clip combinado: ' + f); api.invoke('shell:reveal', f); } catch (e) { toast('Error: ' + errText(e)); } } }, 'Unir en un clip'))),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Previsualización'),
        videos.length ? h('div', { class: 'row' },
          h('label', { class: 'f', style: 'flex:1;min-width:180px' }, 'Clip', h('select', { onchange: (e) => { pv.clipId = e.target.value; pv.img = ''; pv.err = ''; drawPrev(); } }, ...videos.map((c) => h('option', { value: c.id, selected: c.id === pv.clipId }, c.name)))),
          h('label', { class: 'f', style: 'flex:1;min-width:140px' }, 'Momento del clip', h('input', { type: 'range', min: 0, max: 100, value: Math.round(pv.pos * 100), oninput: (e) => { pv.pos = e.target.value / 100; clearTimeout(timer); timer = setTimeout(refreshPrev, 400); } }))) : '',
        imgBox, h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn', disabled: !videos.length, onclick: refreshPrev }, 'Actualizar previsualización'),
          h('span', { class: 'mut' }, 'Aplica LUT, looks, recorte/giro, tamaño y los textos quemados.')))));
  drawPrev();
  if (state.tcResults?.length) main.append(h('h2', {}, 'Último resultado'), h('div', { class: 'card', style: 'padding:0' }, h('table', {}, h('thead', {}, h('tr', {}, ...['Clip', 'Resultado', 'Tamaño', 'Fichero'].map((x) => h('th', {}, x)))),
    h('tbody', {}, ...state.tcResults.map((r) => h('tr', {}, h('td', {}, r.name), h('td', { class: r.error ? 'bad' : 'ok' }, r.error ? r.error : 'Correcto'), h('td', {}, r.size ? fmtBytes(r.size) : '—'), h('td', { class: 'mono mut', style: 'word-break:break-all' }, r.out || '—')))))),
    h('div', { class: 'row', style: 'margin-top:8px' }, state.tcOutDir ? h('button', { class: 'btn', onclick: () => api.invoke('shell:open', state.tcOutDir) }, `Abrir carpeta de salida en ${FILE_MANAGER}`) : '',
      state.tcResults.some((r) => r.error) ? h('span', { class: 'mut' }, 'Registro de errores: ' + state.tcLog) : ''));
}

/* ---------- INFORMES: varias configuraciones guardadas ---------- */
const REPORT_TYPES = [['volume', 'Volumen / checksums'], ['shooting_day', 'Día de rodaje'], ['clips', 'Lista de clips'], ['thumbnails', 'Miniaturas'], ['contact_print', 'Contact print']];
const REPORT_COLS = [['name', 'Clip'], ['reel', 'Reel'], ['camera', 'Cámara'], ['scene', 'Escena'], ['shot', 'Plano'], ['take', 'Toma'], ['shotId', 'ShotID'], ['format', 'Formato'], ['codec', 'Códec'], ['fps', 'FPS'], ['tcStart', 'TC inicio'], ['duration', 'Duración'], ['size', 'Tamaño'],
  ['rating', 'Valoración'], ['flag', 'Marca'], ['status', 'Estado'], ['iso', 'ISO'], ['wb', 'WB'], ['lens', 'Lente'], ['shutter', 'Shutter'], ['volume', 'Volumen'], ['backups', 'Backups'], ['notes', 'Notas']];

async function viewReports2() {
  const R = state.rep2 || (state.rep2 = { sel: null, checked: new Set() });
  const [list, fields] = await Promise.all([api.invoke('reports:list'), api.invoke('library:fields:list')]);
  if (!list.some((r) => r.id === R.sel)) R.sel = list[0]?.id ?? null;
  const cur = list.find((r) => r.id === R.sel);
  const draft = R.draft && R.draft.id === R.sel ? R.draft : (R.draft = cur ? JSON.parse(JSON.stringify(cur)) : null);
  const selIds = [...state.lib.sel];
  const run = async (ids) => { try { const files = await api.invoke('reports:run', ids, selIds); toast(`${files.length} ${files.length === 1 ? 'informe generado' : 'informes generados'}`); if (files[0]) api.invoke('shell:reveal', files[0]); } catch (e) { toast('Error: ' + errText(e)); } };

  const listEl = h('div', { class: 'rlist' }, ...list.map((r) => h('div', { class: 'ritem' + (r.id === R.sel ? ' active' : '') },
    h('input', { type: 'checkbox', 'aria-label': 'Incluir ' + r.name, checked: R.checked.has(r.id), onchange: (e) => (e.target.checked ? R.checked.add(r.id) : R.checked.delete(r.id)) }),
    h('button', { class: 'rname', onclick: () => { R.sel = r.id; R.draft = null; render(); } }, h('b', {}, r.name), h('span', { class: 'mut' }, `${(REPORT_TYPES.find((t) => t[0] === r.type) || [])[1] || r.type} · ${r.format.toUpperCase()}`)))));
  const editor = draft ? h('div', { class: 'col', style: 'gap:10px' },
    h('div', { class: 'row' },
      h('label', { class: 'f', style: 'flex:1;min-width:200px' }, 'Nombre de esta configuración', h('input', { type: 'text', value: draft.name, oninput: (e) => (draft.name = e.target.value) })),
      h('label', { class: 'f' }, 'Tipo', h('select', { onchange: (e) => { draft.type = e.target.value; render(); } }, ...REPORT_TYPES.map(([v, l]) => h('option', { value: v, selected: draft.type === v }, l)))),
      h('label', { class: 'f' }, 'Formato', h('select', { onchange: (e) => (draft.format = e.target.value) }, h('option', { value: 'pdf', selected: draft.format === 'pdf' }, 'PDF'), h('option', { value: 'html', selected: draft.format === 'html' }, 'HTML'))),
      h('label', { class: 'f' }, 'Tema', h('select', { onchange: (e) => (draft.dark = e.target.value === 'dark') }, h('option', { value: 'light', selected: !draft.dark }, 'Claro'), h('option', { value: 'dark', selected: !!draft.dark }, 'Oscuro')))),
    h('div', { class: 'row' },
      h('label', { class: 'f', style: 'flex:1;min-width:200px' }, 'Título (opcional)', h('input', { type: 'text', value: draft.title, placeholder: 'Si lo dejas vacío se usa el título estándar', oninput: (e) => (draft.title = e.target.value) })),
      h('label', { class: 'f' }, 'Clips que incluye', h('select', { onchange: (e) => (draft.scope = e.target.value) }, ...[['all', 'Toda la biblioteca'], ['selection', 'Los seleccionados en Biblioteca'], ['job', 'Solo los de cada offload (al terminar)']].map(([v, l]) => h('option', { value: v, selected: draft.scope === v }, l))))),
    draft.type === 'clips' ? h('div', {}, h('div', { class: 'mut', style: 'margin-bottom:4px' }, 'Columnas de la lista (si no marcas ninguna se usa la tabla estándar). Incluye tus columnas propias.'),
      h('div', { class: 'chips' }, ...[...REPORT_COLS, ...fields.map((f) => ['custom:' + f, f + ' (propia)'])].map(([id, l]) => h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: draft.columns.includes(id), onchange: (e) => { draft.columns = e.target.checked ? [...draft.columns, id] : draft.columns.filter((x) => x !== id); } }), l)))) : '',
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => { try { const s = await api.invoke('reports:save', draft); R.sel = s.id; R.draft = null; toast('Configuración guardada'); render(); } catch (e) { toast('Error: ' + errText(e)); } } }, 'Guardar'),
      h('button', { class: 'btn', onclick: async () => { const copy = { ...JSON.parse(JSON.stringify(draft)), id: undefined, name: draft.name + ' (copia)' }; const s = await api.invoke('reports:save', copy); R.sel = s.id; R.draft = null; toast('Duplicado'); render(); } }, 'Guardar como nuevo'),
      h('button', { class: 'btn', onclick: async () => { await api.invoke('reports:save', draft); R.draft = null; await run([draft.id]); render(); } }, 'Generar ahora'),
      h('button', { class: 'btn danger', onclick: async () => { await api.invoke('reports:remove', draft.id); R.draft = null; R.sel = null; render(); } }, 'Eliminar'))) : h('div', { class: 'empty' }, 'No hay configuraciones. Crea una con «Nuevo informe».');

  main.append(h('p', { class: 'mut', style: 'margin-top:0' }, 'Crea todos los informes que necesites, guarda su configuración y exporta o importa las configuraciones. Las que marques aquí se pueden generar de una vez, y en Offload se eligen los que salen al terminar.'),
    h('div', { class: 'row', style: 'margin-bottom:10px' },
      h('button', { class: 'btn primary', onclick: async () => { const s = await api.invoke('reports:save', { name: 'Informe nuevo', type: 'clips', format: 'pdf', scope: 'all', columns: [] }); R.sel = s.id; R.draft = null; render(); } }, 'Nuevo informe'),
      h('button', { class: 'btn', disabled: !R.checked.size, onclick: () => run([...R.checked]) }, R.checked.size ? `Generar ${R.checked.size} seleccionados` : 'Generar seleccionados'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', onclick: async () => { const f = await api.invoke('reports:export', R.checked.size ? [...R.checked] : []); if (f) toast('Configuración exportada'); } }, R.checked.size ? 'Exportar marcados…' : 'Exportar configuración…'),
      h('button', { class: 'btn', onclick: async () => { try { const n = await api.invoke('reports:import'); if (n != null) { toast(`${n} configuraciones importadas`); render(); } } catch (e) { toast('Error: ' + errText(e)); } } }, 'Importar configuración…')),
    h('div', { class: 'rgrid' }, h('div', { class: 'card' }, listEl), h('div', { class: 'card' }, editor)),
    h('div', { class: 'mut', style: 'margin-top:8px' }, selIds.length ? `Alcance «seleccionados»: ${selIds.length} clips de la biblioteca.` : 'Alcance «seleccionados»: no hay clips seleccionados en la biblioteca; se usará toda.'));
}

/* ---------- eventos de transcode: carpeta de salida ---------- */
api.on('transcode:summary', (e) => { state.tcOutDir = e.outDir; });

/* ---------- enganche en la aplicacion ---------- */
views.offload = viewOffload2; views.transcode = viewTranscode2; views.reports = viewReports2;
