// ASC MHL (v2.0): historial por generaciones en <carpeta>/ascmhl/ con cadena ascmhl_chain.xml.
// Cada generacion registra hash por fichero con action="original" (primera vez) o "verified" (coincide con la anterior).
// Los ficheros .mhl se enlazan en la cadena con su identificador C4 (SMPTE ST 2114: sha512 -> base58).
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { walk, hashFile } = require('./offload');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function c4(buf) {
  let n = BigInt('0x' + crypto.createHash('sha512').update(buf).digest('hex')); let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  return 'c4' + s.padStart(88, '1');
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const DIR = 'ascmhl';

async function readGenerations(root) {
  let names = [];
  try { names = (await fsp.readdir(path.join(root, DIR))).filter((f) => /^\d{4}_.*\.mhl$/.test(f)).sort(); } catch { /* sin historial */ }
  const gens = [];
  for (const n of names) {
    const xml = await fsp.readFile(path.join(root, DIR, n), 'utf8');
    const files = {};
    for (const m of xml.matchAll(/<hash>\s*<path size="(\d+)"[^>]*>([\s\S]*?)<\/path>([\s\S]*?)<\/hash>/g)) {
      const hashes = {};
      for (const h of m[3].matchAll(/<(xxh64|md5|sha1|sha256)\b[^>]*>([0-9a-f]+)<\/\1>/g)) hashes[h[1]] = h[2];
      files[m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')] = { size: Number(m[1]), hashes };
    }
    gens.push({ name: n, nr: Number(n.slice(0, 4)), files });
  }
  return gens;
}

/** Crea una nueva generacion. Devuelve {generation, file, files: n, mismatches: [...], new: n}. No sobrescribe nada si hay discrepancias. */
async function seal(root, { algos = ['xxh64'], tool = 'Cinestack' } = {}) {
  const gens = await readGenerations(root); const prev = gens.at(-1);
  const all = (await walk(root)).filter((f) => !f.rel.split(path.sep)[0].startsWith(DIR));
  const mismatches = []; const entries = []; let created = 0;
  for (const f of all) {
    const h = await hashFile(f.abs, algos);
    const old = prev?.files[f.rel.split(path.sep).join('/')];
    let action = 'original';
    if (old) {
      const common = algos.filter((a) => old.hashes[a]);
      const bad = common.filter((a) => old.hashes[a] !== h[a]);
      if (bad.length) mismatches.push({ rel: f.rel, algos: bad });
      else if (common.length) action = 'verified';
    }
    if (!old) created++;
    entries.push({ f, h, action });
  }
  const missing = prev ? Object.keys(prev.files).filter((p) => !all.some((f) => f.rel.split(path.sep).join('/') === p)) : [];
  if (mismatches.length || missing.length) return { ok: false, mismatches, missing };
  const nr = (prev?.nr || 0) + 1; const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
  const name = `${String(nr).padStart(4, '0')}_${path.basename(root)}_${stamp}.mhl`;
  const hashesXml = entries.map(({ f, h, action }) => `    <hash>\n      <path size="${f.size}" lastmodificationdate="${iso(f.mtime)}">${esc(f.rel.split(path.sep).join('/'))}</path>\n${Object.entries(h).map(([a, v]) => `      <${a} action="${action}" hashdate="${iso(now)}">${v}</${a}>`).join('\n')}\n    </hash>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<hashlist version="2.0" xmlns="urn:ASC:MHL:v2.0">\n  <creatorinfo>\n    <creationdate>${iso(now)}</creationdate>\n    <hostname>${esc(os.hostname())}</hostname>\n    <tool version="0.1">${esc(tool)}</tool>\n  </creatorinfo>\n  <processinfo>\n    <process>${nr === 1 ? 'in-place' : 'in-place'}</process>\n    <ignore><pattern>.DS_Store</pattern><pattern>ascmhl</pattern></ignore>\n  </processinfo>\n  <hashes>\n${hashesXml}\n  </hashes>\n</hashlist>\n`;
  await fsp.mkdir(path.join(root, DIR), { recursive: true });
  await fsp.writeFile(path.join(root, DIR, name), xml);
  const refs = [];
  for (const g of [...gens.map((g) => g.name), name]) refs.push(`  <hashlist sequencenr="${Number(g.slice(0, 4))}">\n    <path>${esc(g)}</path>\n    <c4>${c4(await fsp.readFile(path.join(root, DIR, g)))}</c4>\n  </hashlist>`);
  await fsp.writeFile(path.join(root, DIR, 'ascmhl_chain.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<ascmhldirectory xmlns="urn:ASC:MHL:DIRECTORY:v2.0">\n${refs.join('\n')}\n</ascmhldirectory>\n`);
  return { ok: true, generation: nr, file: path.join(root, DIR, name), files: entries.length, new: created, mismatches: [], missing: [] };
}

/** Verifica la carpeta contra la ultima generacion y comprueba la integridad de la cadena. */
async function verify(root) {
  const gens = await readGenerations(root);
  if (!gens.length) throw new Error('La carpeta no tiene historial ascmhl');
  const chain = await fsp.readFile(path.join(root, DIR, 'ascmhl_chain.xml'), 'utf8').catch(() => '');
  const chainBad = [];
  for (const m of chain.matchAll(/<path>([^<]+)<\/path>\s*<c4>([^<]+)<\/c4>/g)) {
    const actual = c4(await fsp.readFile(path.join(root, DIR, m[1])).catch(() => Buffer.alloc(0)));
    if (actual !== m[2]) chainBad.push(m[1]);
  }
  const last = gens.at(-1); const results = [];
  for (const [rel, e] of Object.entries(last.files)) {
    const algos = Object.keys(e.hashes);
    try {
      const h = await hashFile(path.join(root, rel), algos);
      const bad = algos.filter((a) => h[a] !== e.hashes[a]);
      results.push({ rel, status: bad.length ? 'MISMATCH' : 'ok' });
    } catch (err) { results.push({ rel, status: err.code === 'ENOENT' ? 'MISSING' : 'ERROR' }); }
  }
  const known = new Set(Object.keys(last.files));
  for (const f of await walk(root)) { const r = f.rel.split(path.sep).join('/'); if (!r.startsWith(DIR + '/') && !known.has(r)) results.push({ rel: r, status: 'NEW' }); }
  return { generation: last.nr, chainOk: chainBad.length === 0, chainBad, results, ok: chainBad.length === 0 && results.every((r) => r.status === 'ok') };
}

module.exports = { seal, verify, c4, readGenerations };
