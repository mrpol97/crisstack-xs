// Operaciones de carpetas y clips de la biblioteca que se reflejan en el disco (Finder / Explorador):
// renombrar carpetas, crear subcarpetas, mover clips entre carpetas, renombrar ficheros y eliminar (a la papelera).
// Funcionan sobre un objeto Library; `trashFn(ruta)` mueve a la papelera del sistema (en la app: shell.trashItem).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { volumeOf } = require('./library');

const BAD = /[\\/:*?"<>|\u0000-\u001f]/;
function validName(n) {
  const s = String(n ?? '').trim();
  if (!s || s === '.' || s === '..' || BAD.test(s) || s.length > 200 || /[. ]$/.test(s)) throw new Error('Nombre no válido: no puede estar vacío, acabar en punto o espacio, ni llevar / \\ : * ? " < > |');
  return s;
}
const norm = (p) => path.resolve(p);
const same = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());
const under = (p, dir) => { const a = norm(p), b = norm(dir); return same(a, b) || (process.platform === 'linux' ? a : a.toLowerCase()).startsWith((process.platform === 'linux' ? b : b.toLowerCase()) + path.sep); };
const swap = (p, from, to) => path.join(norm(to), norm(p).slice(norm(from).length));
const exists = (p) => fsp.access(p).then(() => true, () => false);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** Carpeta del disco que corresponde a una carpeta de la biblioteca, o null si no se puede saber con seguridad. */
function binDir(lib, id) {
  const bin = lib.bins[id]; if (!bin) return null;
  const ok = (d) => d && same(path.basename(d), bin.name) && isDir(d);
  if (ok(bin.dir)) return bin.dir;
  const own = new Set(Object.values(lib.clips).filter((c) => c.bin === id && c.path).map((c) => path.dirname(norm(c.path))));
  if (own.size === 1 && ok([...own][0])) { bin.dir = [...own][0]; return bin.dir; }
  const ds = new Set(Object.values(lib.bins).filter((b) => b.parent === id).map((k) => binDir(lib, k.id)).filter(Boolean).map((d) => path.dirname(d)));
  if (ds.size === 1 && ok([...ds][0])) { bin.dir = [...ds][0]; return bin.dir; }
  return null;
}
const dupName = (lib, parent, name, except) => Object.values(lib.bins).some((b) => b.id !== except && (b.parent || null) === (parent || null) && b.name.toLowerCase() === name.toLowerCase());
const NO_DISK = 'Esta carpeta no se corresponde con una carpeta del disco (o el disco no está conectado), así que solo se puede cambiar en la biblioteca.';

async function renameBin(lib, id, name, { disk = true } = {}) {
  const bin = lib.bins[id]; if (!bin) throw new Error('Carpeta no encontrada');
  const nn = validName(name); if (nn === bin.name) return { renamed: false };
  if (dupName(lib, bin.parent, nn, id)) throw new Error('Ya hay una carpeta con ese nombre en el mismo sitio');
  let from = null, to = null;
  if (disk) {
    from = binDir(lib, id); if (!from) throw new Error(NO_DISK);
    to = path.join(path.dirname(from), nn);
    if (!same(from, to) && await exists(to)) throw new Error(`Ya existe «${nn}» en ${path.dirname(from)}`);
    await fsp.rename(from, to);
  }
  const ids = lib.descendants(id); let clips = 0;
  bin.name = nn;
  if (disk) {
    for (const b of Object.values(lib.bins)) if (ids.has(b.id) && b.dir && under(b.dir, from)) b.dir = swap(b.dir, from, to);
    for (const c of Object.values(lib.clips)) {
      if (!ids.has(c.bin)) continue; clips++;
      if (c.path && under(c.path, from)) c.path = swap(c.path, from, to);
      if (c.proxy && under(c.proxy, from)) c.proxy = swap(c.proxy, from, to);
      for (const cp of c.copies || []) if (cp.path && under(cp.path, from)) cp.path = swap(cp.path, from, to);
    }
    bin.dir = to;
  }
  lib.store.save(); return { renamed: true, from, to, clips };
}

async function createBin(lib, parentId, name, { disk = true } = {}) {
  const nn = validName(name);
  if (parentId && !lib.bins[parentId]) throw new Error('Carpeta no encontrada');
  if (dupName(lib, parentId, nn)) throw new Error('Ya hay una carpeta con ese nombre en el mismo sitio');
  let dir = null;
  if (disk) {
    if (!parentId) throw new Error('Para crear una carpeta en el disco, elige antes la carpeta de la biblioteca donde va. En la raíz solo se puede crear dentro de la biblioteca.');
    const pd = binDir(lib, parentId); if (!pd) throw new Error(NO_DISK);
    dir = path.join(pd, nn); if (await exists(dir)) throw new Error(`Ya existe «${nn}» en ${pd}`);
    await fsp.mkdir(dir);
  }
  const chain = []; for (let b = parentId && lib.bins[parentId]; b; b = b.parent && lib.bins[b.parent]) chain.unshift(b.name);
  const bin = lib.ensureBinPath([...chain, nn], dir ? { dir } : {});
  return bin;
}

/** Mueve clips a otra carpeta. Con disk=true mueve tambien los ficheros (solo dentro del mismo disco). */
async function moveClips(lib, ids, targetId, { disk = true } = {}) {
  const target = lib.bins[targetId]; if (!target) throw new Error('Carpeta de destino no encontrada');
  const tdir = disk ? binDir(lib, targetId) : null;
  if (disk && !tdir) throw new Error(NO_DISK);
  const out = { moved: 0, skipped: [] };
  for (const id of ids) {
    const c = lib.clips[id]; if (!c) continue;
    if (disk && c.path) {
      const src = norm(c.path);
      if (!(await exists(src))) { out.skipped.push({ name: c.name, reason: 'su fichero no está en su sitio' }); continue; }
      if (!same(path.dirname(src), tdir)) {
        const dest = path.join(tdir, path.basename(src));
        if (await exists(dest)) { out.skipped.push({ name: c.name, reason: 'ya hay un fichero con ese nombre en la carpeta de destino' }); continue; }
        try { await fsp.rename(src, dest); }
        catch (e) { out.skipped.push({ name: c.name, reason: e.code === 'EXDEV' ? 'está en otro disco: para pasarlo a otro disco usa un Offload (copia verificada)' : e.message }); continue; }
        if (c.copies?.[0] && same(norm(c.copies[0].path), src)) c.copies[0].path = dest;
        c.path = dest; c.volume = volumeOf(dest);
      }
    }
    c.bin = targetId; out.moved++;
  }
  lib.store.save(); return out;
}

async function renameClip(lib, id, name, { disk = true } = {}) {
  const c = lib.clips[id]; if (!c) throw new Error('Clip no encontrado');
  let nn = validName(name); const ext = path.extname(c.name);
  if (ext && !path.extname(nn)) nn += ext; // si no escribes la extension se conserva la del fichero
  if (nn === c.name) return c;
  if (disk && c.path) {
    const src = norm(c.path); if (!(await exists(src))) throw new Error('El fichero no está en su sitio: no se puede renombrar en el disco');
    const dest = path.join(path.dirname(src), nn);
    if (!same(src, dest) && await exists(dest)) throw new Error(`Ya existe un fichero llamado «${nn}» en esa carpeta`);
    await fsp.rename(src, dest);
    if (c.copies?.[0] && same(norm(c.copies[0].path), src)) c.copies[0].path = dest;
    c.path = dest; if (c.relPath) c.relPath = path.join(path.dirname(c.relPath), nn);
  }
  c.name = nn; lib.store.save(); return c;
}

async function removeClips(lib, ids, { trash = false, trashFn } = {}) {
  const out = { removed: 0, trashed: 0, errors: [] };
  for (const id of ids) {
    const c = lib.clips[id]; if (!c) continue;
    if (trash && c.path && await exists(c.path)) {
      if (!trashFn) throw new Error('No hay papelera disponible');
      try { await trashFn(c.path); out.trashed++; } catch (e) { out.errors.push({ name: c.name, error: e.message }); continue; }
    }
    delete lib.clips[id]; out.removed++;
  }
  lib.store.save(); return out;
}

/** Elimina una carpeta con sus subcarpetas y clips de la biblioteca; con trash=true la carpeta del disco va a la papelera. */
async function removeBin(lib, id, { trash = false, trashFn } = {}) {
  if (!lib.bins[id]) throw new Error('Carpeta no encontrada');
  const ids = lib.descendants(id);
  let dir = null;
  if (trash) {
    dir = binDir(lib, id); if (!dir) throw new Error(NO_DISK);
    const root = path.parse(norm(dir)).root;
    if (same(norm(dir), root) || same(norm(dir), os.homedir()) || norm(dir).split(path.sep).filter(Boolean).length < 2) throw new Error('Por seguridad no se envía a la papelera una carpeta tan general');
    if (!trashFn) throw new Error('No hay papelera disponible');
    await trashFn(dir);
  }
  let clips = 0;
  for (const c of Object.values(lib.clips)) if (ids.has(c.bin)) { delete lib.clips[c.id]; clips++; }
  for (const b of ids) delete lib.bins[b];
  lib.store.save(); return { bins: ids.size, clips, trashed: dir };
}

module.exports = { validName, binDir, renameBin, createBin, moveClips, renameClip, removeClips, removeBin };
