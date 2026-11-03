// Biblioteca de LUTs guardadas: cada .cube que se importa se copia una vez a la carpeta de la app y queda disponible
// en todos los selectores, sin volver a buscarlo en el Finder. Las LUT 1D se convierten a 3D al importarlas.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const color = require('./color');

const safeName = (s) => String(s).replace(/[^\w.\- ()áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 60) || 'lut';

class LutLibrary {
  /** store: objeto con get(clave) y set(clave, valor) (el almacen de ajustes de la app). */
  constructor(dir, store) { this.dir = dir; this.store = store; }

  list() { return (this.store.get('luts') || []).filter((l) => fs.existsSync(l.file)); }

  async add(file) {
    const raw = await fsp.readFile(file, 'utf8');
    if (raw.length > 60 * 1024 * 1024) throw new Error('La LUT es demasiado grande');
    const norm = color.normalizeCube(raw); // lanza un error legible si el fichero no es una LUT valida
    const id = crypto.createHash('sha1').update(norm.text).digest('hex').slice(0, 10);
    const all = this.store.get('luts') || [];
    const known = all.find((l) => l.id === id && fs.existsSync(l.file));
    if (known) return { ...known, duplicate: true };
    const name = safeName(path.basename(file, path.extname(file)));
    const dest = path.join(this.dir, `${name}__${id}.cube`);
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(dest, norm.text);
    const entry = { id, name, file: dest, size: norm.size, converted: norm.converted, added: new Date().toISOString() };
    this.store.set('luts', [...all.filter((l) => l.id !== id), entry]);
    return entry;
  }

  /** Importa varias; las que fallan no frenan a las demas. */
  async addMany(files) {
    const added = [], duplicates = [], errors = [];
    for (const f of files) {
      try { const e = await this.add(f); (e.duplicate ? duplicates : added).push(e); } catch (e) { errors.push({ file: f, error: e.message }); }
    }
    return { added, duplicates, errors };
  }

  /** Todas las .cube de una carpeta y sus subcarpetas. */
  async addFolder(root, { maxFiles = 500, maxDepth = 6 } = {}) {
    const found = [];
    const walk = async (dir, depth) => {
      if (depth > maxDepth || found.length >= maxFiles) return;
      let items = []; try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        if (found.length >= maxFiles) return;
        const p = path.join(dir, it.name);
        if (it.isDirectory()) await walk(p, depth + 1); else if (/\.cube$/i.test(it.name)) found.push(p);
      }
    };
    await walk(root, 0);
    return { ...(await this.addMany(found)), scanned: found.length };
  }

  remove(id) { this.store.set('luts', (this.store.get('luts') || []).filter((l) => l.id !== id)); }
  rename(id, name) { this.store.set('luts', (this.store.get('luts') || []).map((l) => (l.id === id ? { ...l, name: safeName(name) } : l))); }
}

module.exports = { LutLibrary };
