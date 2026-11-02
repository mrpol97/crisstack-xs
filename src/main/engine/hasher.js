// Hash en streaming con varios algoritmos a la vez (una sola lectura del fichero).
const crypto = require('node:crypto');

const NODE_ALGOS = ['md5', 'sha1', 'sha256'];
let xxhashApi = null;

async function loadXxhash() {
  if (!xxhashApi) {
    const mod = await import('xxhash-wasm');
    xxhashApi = await (mod.default || mod)();
  }
  return xxhashApi;
}

/**
 * Crea un hasher incremental. algos: ['xxh64','md5','sha1','sha256']
 * Devuelve { update(buf), digest() -> {algo: hex} }
 */
async function createHasher(algos) {
  const nodeHashes = {};
  let xxh = null;
  for (const a of algos) {
    if (NODE_ALGOS.includes(a)) nodeHashes[a] = crypto.createHash(a);
    else if (a === 'xxh64') xxh = (await loadXxhash()).create64();
    else throw new Error(`Algoritmo no soportado: ${a}`);
  }
  return {
    update(buf) {
      for (const h of Object.values(nodeHashes)) h.update(buf);
      if (xxh) xxh.update(buf);
    },
    digest() {
      const out = {};
      for (const [a, h] of Object.entries(nodeHashes)) out[a] = h.digest('hex');
      if (xxh) out.xxh64 = xxh.digest().toString(16).padStart(16, '0');
      return out;
    },
  };
}

module.exports = { createHasher, ALGOS: ['xxh64', ...NODE_ALGOS] };
