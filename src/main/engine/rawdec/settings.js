// Ajustes de decodificacion RAW (ISO, balance de blancos, espacio de color, gamma, calidad de debayer, escala, profundidad de bits, GPU).
// Cada decodificador declara en `hello` que controles admite (capabilities). Aqui se validan los valores y se separan los que el
// SDK no ofrece: nunca se envian ni se simulan en silencio; se devuelven en `unsupported` para que la interfaz lo diga.

const NUM = { iso: 'iso', kelvin: 'kelvin', tint: 'tint' };
const STR = ['colorSpace', 'gamma', 'quality', 'gpu'];

/** settings: {iso, kelvin, tint, colorSpace, gamma, quality, scale, bitDepth, gpu} (cada campo opcional; undefined/null = como se grabó). */
function normalize(settings = {}, caps = {}) {
  const send = {}; const unsupported = [];
  const want = (k) => settings[k] !== undefined && settings[k] !== null && settings[k] !== '';
  for (const k of Object.keys(NUM)) {
    if (!want(k)) continue;
    const c = caps[k]; if (!c) { unsupported.push(k); continue; }
    const v = Number(settings[k]); if (!Number.isFinite(v)) throw new Error(`Valor no válido para ${k}: ${settings[k]}`);
    if ((c.min !== undefined && v < c.min) || (c.max !== undefined && v > c.max)) throw new Error(`${k} fuera de rango (${c.min}–${c.max}): ${v}`);
    send[k] = v;
  }
  for (const k of STR) {
    if (!want(k)) continue;
    const list = caps[k === 'colorSpace' ? 'colorSpaces' : k === 'gamma' ? 'gammas' : k === 'quality' ? 'quality' : 'gpu'];
    if (!list || !list.length) { unsupported.push(k); continue; }
    if (!list.includes(settings[k])) throw new Error(`${k} no admitido por este decodificador: «${settings[k]}». Admitidos: ${list.join(', ')}`);
    send[k] = settings[k];
  }
  if (want('scale')) { if (!caps.scale?.length) unsupported.push('scale'); else if (!caps.scale.includes(Number(settings.scale))) throw new Error(`escala no admitida: ${settings.scale} (admitidas: ${caps.scale.join(', ')})`); else send.scale = Number(settings.scale); }
  if (want('bitDepth')) { if (!caps.bitDepths?.length) unsupported.push('bitDepth'); else if (!caps.bitDepths.includes(Number(settings.bitDepth))) throw new Error(`profundidad no admitida: ${settings.bitDepth} (admitidas: ${caps.bitDepths.join(', ')})`); else send.bitDepth = Number(settings.bitDepth); }
  return { send, unsupported };
}

module.exports = { normalize };
