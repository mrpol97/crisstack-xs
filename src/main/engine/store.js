// Almacen JSON simple y atomico (sin dependencias nativas).
const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(file, initial = {}) {
    this.file = file;
    this.data = initial;
    try { this.data = { ...initial, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* nuevo */ }
  }
  get(key) { return this.data[key]; }
  set(key, value) { this.data[key] = value; this.save(); }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
