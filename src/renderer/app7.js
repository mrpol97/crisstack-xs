'use strict';
/* v0.7: decodificadores RAW nativos (estado por fabricante en Ajustes) y Visor RAW fotograma a fotograma con los ajustes de camara. */

const RAW_STATE = { ready: ['Listo', 'ok'], 'no-helper': ['Sin decodificador instalado', 'warn'], 'helper-error': ['Error del decodificador', 'bad'] };
const RAW_ACCESS = { clickthrough: 'Descarga con registro y aceptando la licencia', application: 'Solicitud a la empresa (programa de partners)', system: 'Lo aporta el sistema operativo', unknown: 'Sin determinar (hay que pedirlo al fabricante)' };

/** Tarjeta de Ajustes: que decodificadores RAW hay, cuales no y por que, con el acceso y la licencia de cada SDK. */
async function rawSection() {
  let st; try { st = await api.invoke('raw:status'); } catch (e) { return h('div', { class: 'bad' }, errText(e)); }
  const rows = st.formats.map((f) => {
    const [label, cls] = RAW_STATE[f.state] || [f.state, 'mut'];
    return h('details', { class: 'rawrow' }, h('summary', {}, h('b', {}, f.name), h('span', { class: 'mut' }, ` · ${f.vendor}`), h('span', { class: cls, style: 'margin-left:auto' }, label)),
      h('div', { class: 'col', style: 'gap:6px;padding:8px 2px 4px' },
        h('div', {}, f.reason),
        h('div', { class: 'mut' }, `SDK: ${f.sdk.name} · versión ${f.sdk.version}`), h('div', { class: 'mut' }, `Cómo se consigue: ${RAW_ACCESS[f.sdk.access] || f.sdk.access}`),
        h('div', { class: 'mut' }, `Plataformas: ${f.sdk.platforms.join(', ')} · Aceleración: ${f.sdk.gpu.length ? f.sdk.gpu.join(', ') : 'sin determinar'}`),
        h('div', {}, h('b', {}, 'Redistribución en una aplicación comercial: '), f.sdk.redistribution),
        f.helper ? h('div', { class: 'mut' }, `Decodificador: ${f.helper.path} · controles: ${Object.keys(f.helper.capabilities || {}).join(', ') || 'ninguno declarado'}`) : '',
        h('div', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.invoke('shell:openExternal', f.sdk.url).catch(() => toast(f.sdk.url)); } }, f.sdk.url))));
  });
  return h('div', {}, h('h2', {}, 'Decodificadores RAW'),
    h('div', { class: 'card col' },
      h('div', { class: 'mut' }, 'Cada fabricante se decodifica con su SDK oficial en un programa aparte («decodificador»), para no mezclar licencias y que un fallo del SDK no tumbe la app. Si no hay decodificador para un formato, la app lo dice y NO lo convierte en silencio a otro formato con pérdida: un proxy solo se usa si tú lo vinculas, y se marca como proxy. Más detalle y estudio de licencias: docs/RAW-decodificadores.md.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => api.invoke('raw:openFolder') }, 'Abrir la carpeta de decodificadores'), h('span', { class: 'mono mut' }, st.dirs[0])),
      ...rows));
}

/** Visor RAW de un clip con decodificador nativo: fotograma a fotograma con ISO, balance de blancos, espacio de color, gamma y calidad. */
function rawViewer(c) {
  const m = c.meta || {}; const all = state.rawv || (state.rawv = {});
  const S = all[c.id] || (all[c.id] = { frame: Math.floor((m.rawFrames || 1) / 2), iso: '', kelvin: '', tint: '', quality: '', colorSpace: '', gamma: '' });
  const box = h('div', { class: 'col', style: 'gap:8px;margin-top:8px' }); let caps = null, info = null, timer = null;
  const img = h('div', { class: 'prevbox' }, h('div', { class: 'mut' }, 'Abre el visor para decodificar un fotograma…')); const msg = h('div', { class: 'mut' });
  const refresh = async () => {
    img.replaceChildren(h('div', { class: 'mut' }, 'Decodificando…'));
    const settings = {}; for (const k of ['iso', 'kelvin', 'tint']) if (S[k] !== '') settings[k] = Number(S[k]); for (const k of ['quality', 'colorSpace', 'gamma']) if (S[k]) settings[k] = S[k];
    try {
      const r = await api.invoke('raw:frame', c.id, S.frame, settings);
      img.replaceChildren(h('img', { src: r.img, alt: 'Fotograma RAW decodificado' }));
      const bits = [`${r.width}×${r.height}`, `${r.bitDepth} bits`, `GPU/CPU: ${r.gpuUsed}`];
      msg.replaceChildren(h('div', {}, bits.join(' · ')), r.notApplied.length ? h('div', { class: 'warn' }, `El SDK no aplicó: ${r.notApplied.join(', ')}.`) : '', r.unsupported.length ? h('div', { class: 'warn' }, `Este SDK no ofrece: ${r.unsupported.join(', ')}.`) : '',
        h('div', { class: 'mut' }, 'Vista de 8 bits de un fotograma decodificado de 16: los valores se muestran tal cual salen del SDK, sin conversión de color añadida.'));
    } catch (e) { img.replaceChildren(h('div', { class: 'bad' }, errText(e))); msg.textContent = ''; }
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 350); };
  const num = (label, key, ph, c2) => h('label', { class: 'f', style: 'width:96px' }, label, h('input', { type: 'number', value: S[key], placeholder: ph, min: c2?.min, max: c2?.max, oninput: (e) => { S[key] = e.target.value; later(); } }));
  const sel = (label, key, list) => list?.length ? h('label', { class: 'f' }, label, h('select', { onchange: (e) => { S[key] = e.target.value; later(); } }, h('option', { value: '' }, 'Como se grabó'), ...list.map((v) => h('option', { value: v, selected: S[key] === v }, v)))) : '';
  const det = h('details', { class: 'rawviewer', style: 'margin-top:12px' }, h('summary', { style: 'cursor:pointer;color:var(--mut);text-transform:uppercase;letter-spacing:.07em;font-size:12px;font-weight:600' }, 'Visor RAW (decodificación nativa)'), box);
  det.addEventListener('toggle', async () => {
    if (!det.open || info) return;
    try { info = await api.invoke('raw:info', c.id); } catch (e) { return box.replaceChildren(h('div', { class: 'bad' }, errText(e))); }
    caps = info.capabilities || {}; const a = info.asShot || {};
    box.replaceChildren(
      h('div', { class: 'mut' }, `${info.sdk?.name || 'SDK'} ${info.sdk?.version || ''} · ${info.frames || '?'} fotogramas`),
      h('label', { class: 'f' }, `Fotograma ${S.frame}`, h('input', { type: 'range', min: 0, max: Math.max(0, (info.frames || 1) - 1), value: S.frame, oninput: (e) => { S.frame = Number(e.target.value); e.target.parentNode.firstChild.textContent = `Fotograma ${S.frame}`; later(); } })),
      h('div', { class: 'row' }, num('ISO', 'iso', a.iso ?? 'como se grabó', caps.iso), num('Kelvin', 'kelvin', a.kelvin ?? 'como se grabó', caps.kelvin), caps.tint ? num('Tinte', 'tint', a.tint ?? 0, caps.tint) : ''),
      h('div', { class: 'row' }, sel('Espacio de color', 'colorSpace', caps.colorSpaces), sel('Gamma', 'gamma', caps.gammas), sel('Calidad de debayer', 'quality', caps.quality)),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { Object.assign(S, { iso: '', kelvin: '', tint: '', quality: '', colorSpace: '', gamma: '' }); refresh(); } }, 'Como se grabó')),
      img, msg);
    refresh();
  });
  return det;
}
