// Importacion de metadatos desde CSV / ALE (MovieSlate, ZoeLog, ScriptE, LockitNetwork, hojas de camara...).
function detectDelim(line) {
  const counts = { '\t': 0, ';': 0, ',': 0 };
  let q = false; for (const ch of line) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const delim = detectDelim(text.split(/\r?\n/, 1)[0] || '');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((c) => c !== '')) rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((c) => c !== '')) rows.push(row); }
  const [head, ...rest] = rows;
  return { columns: head || [], rows: rest.map((r) => Object.fromEntries((head || []).map((h, i) => [h.trim(), (r[i] ?? '').trim()]))) };
}

function parseAle(text) {
  const lines = text.split(/\r?\n/); const ci = lines.findIndex((l) => l.trim() === 'Column'); const di = lines.findIndex((l) => l.trim() === 'Data');
  if (ci < 0 || di < 0) throw new Error('No parece un fichero ALE');
  const columns = lines[ci + 1].split('\t').map((s) => s.trim());
  const rows = lines.slice(di + 1).filter((l) => l.trim()).map((l) => { const c = l.split('\t'); return Object.fromEntries(columns.map((h, i) => [h, (c[i] ?? '').trim()])); });
  return { columns, rows };
}

const FIELD_ALIASES = {
  scene: ['scene', 'escena', 'sc'], shot: ['shot', 'plano', 'slate'], take: ['take', 'toma', 'tk'], camera: ['camera', 'cam', 'camara', 'cámara'],
  notes: ['notes', 'notas', 'comments', 'comment', 'description', 'descripcion'], flag: ['flag', 'circle', 'status'], reel: ['reel', 'tape', 'roll', 'mag'],
};

/** Sugiere un mapeo de columnas -> campos por nombre. */
function suggestMapping(columns) {
  const map = {};
  for (const col of columns) for (const [field, names] of Object.entries(FIELD_ALIASES)) if (names.includes(col.toLowerCase())) map[col] = field;
  return map;
}

const base = (s) => String(s || '').replace(/\.[^.]+$/, '').toLowerCase();

/**
 * match: 'name' (nombre sin extension) | 'timecode' (TC de inicio) | 'sst' (escena+plano+toma)
 * keyColumn: columna del fichero que se compara. mapping: {columna: campo}. Los campos fuera de la lista base van a custom.
 */
function applyRows(clips, rows, { match = 'name', keyColumn, mapping = {} }) {
  const updates = []; const unmatched = [];
  for (const row of rows) {
    const key = String(row[keyColumn] ?? '').trim();
    let hit = [];
    if (match === 'name') hit = clips.filter((c) => base(c.name) === base(key) || c.name.toLowerCase() === key.toLowerCase());
    else if (match === 'timecode') hit = clips.filter((c) => c.meta?.timecode && c.meta.timecode.replace(/;/g, ':') === key.replace(/;/g, ':'));
    else if (match === 'sst') hit = clips.filter((c) => [c.scene, c.shot, c.take].join('/') === key);
    if (!hit.length) { unmatched.push(key); continue; }
    const patch = {};
    for (const [col, field] of Object.entries(mapping)) {
      if (!field || row[col] == null || row[col] === '') continue;
      if (['scene', 'shot', 'take', 'camera', 'notes', 'flag', 'reel', 'color'].includes(field)) patch[field] = row[col];
      else patch.custom = { ...(patch.custom || {}), [field]: row[col] };
    }
    for (const c of hit) updates.push({ id: c.id, patch });
  }
  return { updates, unmatched };
}

module.exports = { parseCsv, parseAle, suggestMapping, applyRows };
