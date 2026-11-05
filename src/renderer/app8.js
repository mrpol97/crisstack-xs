'use strict';
/* v0.8: comparar dos carpetas (A = origen, B = destino), ver que hay de nuevo y copiarlo con checksum y verificacion. */

const SYNC_SHOW = 300; // filas que se dibujan; la seleccion cubre tambien las que no caben

function syncState() {
  const o = state.offload;
  return o.sync || (o.sync = { a: '', b: '', hash: false, replace: false, res: null, busy: '', prog: null, pick: new Set(), pickDiff: new Set(), msg: '', t0: 0 });
}

api.on('sync:progress', (e) => {
  const S = syncState();
  S.prog = e;
  if (!S.t0) S.t0 = Date.now();
  S.draw?.();
});

function syncPanel() {
  const S = syncState();
  const box = h('div', { class: 'syncbox' });
  const nested = (a, b) => { const n = (p) => p.replace(/[\\/]+$/, '').toLowerCase(); const x = n(a), y = n(b); return x === y || y.startsWith(x + '/') || y.startsWith(x + '\\'); };
  const pickFolder = async (key) => { const [p] = await api.invoke('dialog:folder', false); if (p) { S[key] = p; S.res = null; S.msg = ''; S.draw(); } };

  const compare = async (keepMsg) => {
    S.busy = 'compare'; if (keepMsg !== true) S.msg = ''; S.res = null; S.prog = null; S.t0 = Date.now(); S.draw();
    try {
      const r = await api.invoke('sync:compare', S.a, S.b, { hash: S.hash });
      S.res = r; S.pick = new Set(r.onlyA.map((f) => f.rel)); S.pickDiff = new Set(r.differ.map((f) => f.rel));
    } catch (e) { S.msg = /Cancelado/.test(errText(e)) ? 'Comparación cancelada.' : 'No se pudo comparar: ' + errText(e); }
    S.busy = ''; S.prog = null; S.draw();
  };
  const copy = async () => {
    const rels = [...S.pick, ...(S.replace ? S.pickDiff : [])];
    if (!rels.length) return;
    if (S.replace && S.pickDiff.size) {
      const ok = await modal({ title: 'Reemplazar ficheros distintos', danger: true, ok: 'Reemplazar y copiar', body: [h('div', {}, `Se van a reemplazar ${S.pickDiff.size} ${S.pickDiff.size === 1 ? 'fichero' : 'ficheros'} de la carpeta B con la versión de A.`), h('div', { class: 'mut' }, 'La versión actual de cada uno no se borra: se guarda antes en la carpeta «_CrisStack_versiones» dentro de B.'), h('div', { class: 'mono mut' }, S.b)] });
      if (!ok) return;
    }
    S.busy = 'copy'; S.msg = ''; S.prog = null; S.t0 = Date.now(); S.draw();
    try {
      const r = await api.invoke('sync:copy', S.a, S.b, rels, { replace: S.replace, algos: state.offload.algos });
      S.msg = r.ok ? `Copiados y verificados ${r.files} ${r.files === 1 ? 'fichero' : 'ficheros'} (${fmtBytes(r.bytes)}) en ${fmtClock(r.seconds)}.${r.kept ? ` Las ${r.kept} versiones anteriores de B se guardaron en ${r.versionsDir}.` : ''}` : `Terminó con ${r.failures} fallos de copia o verificación: revisa los destinos.`;
      S.ok = r.ok; toast(S.msg);
    } catch (e) { S.msg = /Cancelado/.test(errText(e)) ? 'Copia cancelada: los ficheros a medias se han borrado.' : 'Error: ' + errText(e); S.ok = false; }
    S.busy = ''; S.prog = null;
    await compare(true); // vuelve a comparar para ver que ya no queda nada nuevo
  };

  const stat = (n, label, cls = '') => h('div', { class: 'chip stat' + (cls ? ' ' + cls : ''), style: 'flex-direction:column;align-items:flex-start;min-width:120px' }, h('b', { style: 'font-size:18px' }, String(n)), h('span', { class: 'mut' }, label));
  const fileList = (title, items, pick, withBoxes) => {
    if (!items.length) return '';
    const rows = items.slice(0, SYNC_SHOW).map((f) => h('label', { class: 'syncrow', title: f.rel },
      withBoxes ? h('input', { type: 'checkbox', checked: pick.has(f.rel), onchange: (e) => { e.target.checked ? pick.add(f.rel) : pick.delete(f.rel); S.draw(); } }) : '', h('span', { class: 'mono grow' }, f.rel), h('span', { class: 'mut' }, fmtBytes(f.size))));
    return h('details', { open: withBoxes && items.length <= 60 }, h('summary', { class: 'tcsum' }, `${title} (${items.length})`),
      withBoxes ? h('div', { class: 'row', style: 'margin:6px 0' }, h('button', { class: 'btn', onclick: () => { items.forEach((f) => pick.add(f.rel)); S.draw(); } }, 'Marcar todos'), h('button', { class: 'btn', onclick: () => { pick.clear(); S.draw(); } }, 'Ninguno')) : '',
      h('div', { class: 'synclist' }, ...rows, items.length > SYNC_SHOW ? h('div', { class: 'mut' }, `…y ${items.length - SYNC_SHOW} más${withBoxes ? ' (siguen marcados los que estaban marcados)' : ''}`) : ''));
  };

  S.draw = () => {
    if (!box.isConnected && box.__mounted) return; // la pestaña ya no esta
    box.__mounted = true;
    const busy = !!S.busy; const same = S.a && S.b && nested(S.a, S.b);
    const nodes = [];
    nodes.push(h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Carpeta A · origen'), h('div', { class: 'mono mut', title: S.a }, S.a || 'Sin elegir'), h('button', { class: 'btn', disabled: busy, onclick: () => pickFolder('a') }, 'Elegir carpeta A…')),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Carpeta B · destino'), h('div', { class: 'mono mut', title: S.b }, S.b || 'Sin elegir'), h('div', { class: 'row' }, h('button', { class: 'btn', disabled: busy, onclick: () => pickFolder('b') }, 'Elegir carpeta B…'), h('button', { class: 'btn', disabled: busy || !S.a || !S.b, title: 'Cambiar el sentido: copiar de B a A', onclick: () => { [S.a, S.b] = [S.b, S.a]; S.res = null; S.draw(); } }, '⇄ Intercambiar')))));
    nodes.push(h('div', { class: 'card col', style: 'margin-top:10px' },
      h('div', { class: 'chips' },
        h('label', { class: 'chip', title: 'Lee los dos ficheros y compara su checksum cuando tienen el mismo tamaño. Es lo único que garantiza que el contenido es igual.' }, h('input', { type: 'checkbox', checked: S.hash, disabled: busy, onchange: (e) => { S.hash = e.target.checked; S.res = null; S.draw(); } }), 'Comparar por checksum (más lento, más seguro)'),
        h('label', { class: 'chip', title: 'Si un fichero existe en las dos carpetas pero es distinto, se reemplaza en B (la versión anterior se guarda en _CrisStack_versiones). Pide confirmación.' }, h('input', { type: 'checkbox', checked: S.replace, disabled: busy, onchange: (e) => { S.replace = e.target.checked; S.draw(); } }), 'Reemplazar también los distintos')),
      h('div', { class: 'mut' }, 'Sin checksum se comparan nombre, tamaño y fecha: es rápido, pero un fichero con el mismo tamaño y fecha distinta sale como «fecha distinta» y no se copia. Lo que se copia siempre se verifica con checksum.'),
      same ? h('div', { class: 'bad' }, 'Las carpetas son la misma o una está dentro de la otra: elige dos carpetas distintas.') : '',
      h('div', { class: 'row' }, h('button', { class: 'btn primary', disabled: busy || !S.a || !S.b || same, onclick: () => compare() }, S.busy === 'compare' ? 'Comparando…' : 'Comparar'),
        h('button', { class: 'btn danger', disabled: !busy, onclick: () => api.invoke('sync:cancel') }, 'Cancelar'))));
    if (busy && S.prog) {
      const p = S.prog; const el = Math.max(1, (Date.now() - S.t0) / 1000);
      const pct = p.totalBytes ? Math.min(100, (p.doneBytes / p.totalBytes) * 100) : 0;
      nodes.push(h('div', { class: 'card', style: 'margin-top:10px' }, h('b', {}, S.busy === 'compare' ? 'Leyendo para comparar por checksum' : (p.phase === 'verify' ? 'Verificando lo copiado' : 'Copiando lo nuevo')), p.current ? h('span', { class: 'mono', title: p.current }, ' · ' + p.current) : '',
        h('div', { class: 'bar', style: 'margin:8px 0' }, h('i', { style: `transform:scaleX(${pct / 100})` })), h('div', { class: 'mut' }, `${fmtBytes(p.doneBytes || 0)} de ${fmtBytes(p.totalBytes || 0)} · ${fmtBytes((p.doneBytes || 0) / el)}/s · transcurrido ${fmtClock(el)}`)));
    } else if (busy) nodes.push(h('div', { class: 'card mut', style: 'margin-top:10px' }, S.busy === 'compare' ? 'Recorriendo las dos carpetas…' : 'Preparando la copia…'));
    if (S.msg) nodes.push(h('div', { class: 'card ' + (S.ok === false || /No se pudo|Error|fallos|cancel/i.test(S.msg) ? 'bad' : 'ok'), style: 'margin-top:10px' }, S.msg));
    const r = S.res;
    if (r) {
      const nNew = S.pick.size, nDiff = S.replace ? S.pickDiff.size : 0;
      const bytes = r.onlyA.filter((f) => S.pick.has(f.rel)).reduce((s, f) => s + f.size, 0) + (S.replace ? r.differ.filter((f) => S.pickDiff.has(f.rel)).reduce((s, f) => s + f.size, 0) : 0);
      nodes.push(h('h2', {}, 'Resultado'));
      nodes.push(h('div', { class: 'chips' }, stat(r.onlyA.length, `nuevos en A (${fmtBytes(r.bytesNew)})`, r.onlyA.length ? 'warn' : ''), stat(r.differ.length, 'distintos en las dos', r.differ.length ? 'warn' : ''),
        r.hashed ? '' : stat(r.dateOnly.length, 'misma medida, fecha distinta'), stat(r.onlyB.length, 'solo en B'), stat(r.same.length, 'iguales', 'ok')));
      nodes.push(h('div', { class: 'row', style: 'margin:10px 0' },
        h('button', { class: 'btn primary', disabled: busy || (!nNew && !nDiff), onclick: copy }, nNew || nDiff ? `Copiar ${nNew + nDiff} ${nNew + nDiff === 1 ? 'fichero' : 'ficheros'} (${fmtBytes(bytes)}) de A a B con verificación` : 'No hay nada que copiar'),
        !r.onlyA.length && !r.differ.length ? h('span', { class: 'ok' }, 'B ya tiene todo lo de A.') : ''));
      nodes.push(fileList('Nuevos en A: se copian los marcados', r.onlyA, S.pick, true));
      nodes.push(fileList('Distintos' + (S.replace ? ': se reemplazan los marcados' : ' (no se tocan; activa «Reemplazar» para copiarlos)'), r.differ.map((f) => ({ ...f, size: f.size })), S.pickDiff, S.replace));
      if (!r.hashed) nodes.push(fileList('Misma medida y fecha distinta (usa el checksum para saber si cambian)', r.dateOnly, new Set(), false));
      nodes.push(fileList('Solo en B (no se tocan)', r.onlyB, new Set(), false));
    }
    box.replaceChildren(...nodes);
  };
  S.draw();
  return box;
}

/* ---------- velocidad de un traspaso: grafica y estadisticas por destino ---------- */
async function showSpeed(jobId, title) {
  const r = await api.invoke('jobs:speed', jobId);
  if (!r) return toast('No se encuentra ese traspaso');
  const chart = h('div', { class: 'speedchart' }); chart.innerHTML = r.hasSamples ? r.svg : '';
  const s = r.stats;
  const rows = s.perDest.map((d, i) => h('tr', {}, h('td', { title: d.path }, `Destino ${i + 1}`), h('td', {}, fmtBytes(d.copiedBytes)), h('td', {}, fmtBytes(d.verifiedBytes)), h('td', {}, fmtBytes(d.avg) + '/s'), h('td', {}, fmtBytes(d.peak) + '/s'), h('td', { class: d.errors ? 'bad' : 'ok' }, String(d.errors || 0))));
  await modal({ title: `Velocidad del traspaso · ${title || ''}`, ok: 'Cerrar', cancel: null, body: [
    r.hasSamples ? h('div', { class: 'chips' }, h('span', { class: 'chip' }, `Media global ${fmtBytes(s.overall)}/s`), h('span', { class: 'chip' }, `Máxima ${fmtBytes(s.peak)}/s`), h('span', { class: 'chip' }, `Mínima ${fmtBytes(s.min)}/s`), h('span', { class: 'chip' }, `Duración ${fmtClock(s.seconds)}`)) : h('div', { class: 'warn' }, 'Este traspaso es anterior a la v0.8 y no guardó muestras de velocidad.'),
    chart,
    h('table', {}, h('thead', {}, h('tr', {}, ...['Destino', 'Escrito', 'Releído', 'Media', 'Máxima', 'Errores'].map((x) => h('th', {}, x)))), h('tbody', {}, ...rows)),
    h('div', { class: 'mut' }, 'La línea blanca es el total (lectura del origen más relecturas de verificación); cada color es un destino. La zona sombreada es la verificación.'),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: async () => { const f = await api.invoke('report:make', 'transfer', { jobIds: [jobId], format: 'pdf' }); toast('Informe: ' + f); api.invoke('shell:reveal', f); } }, 'Guardar informe PDF de velocidad')),
  ] });
}
