// Biblioteca: ficha de proyecto, carpetas (bins) en arbol, clips, metadatos, campos personalizados y carpetas inteligentes.
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const media = require('./media');
const rawdec = require('./rawdec');
const { walk } = require('./offload');

const uid = () => crypto.randomBytes(6).toString('hex');

const PROJECT_FIELDS = ['name', 'director', 'cinematographer', 'cameraAssistant', 'cameraAssistant2', 'dit', 'dataManager', 'soundMixer', 'scriptSupervisor', 'producer', 'production', 'location', 'copyright'];
const MAX_LOGO = 1.5 * 1024 * 1024;

function fieldValue(clip, field) {
  if (field in clip) return clip[field];
  if (clip.meta && field in clip.meta) return clip.meta[field];
  if (clip.cam && field in clip.cam) return clip.cam[field];
  if (clip.custom && field in clip.custom) return clip.custom[field];
  return undefined;
}

function matchRule(clip, rule) {
  const v = fieldValue(clip, rule.field);
  const s = String(v ?? '').toLowerCase();
  const t = String(rule.value ?? '').toLowerCase();
  switch (rule.op) {
    case 'contains': return s.includes(t);
    case 'not_contains': return !s.includes(t);
    case 'eq': return s === t;
    case 'neq': return s !== t;
    case 'gt': return Number(v) > Number(rule.value);
    case 'lt': return Number(v) < Number(rule.value);
    case 'empty': return s === '';
    case 'not_empty': return s !== '';
    default: return false;
  }
}

function matchSmart(clip, smart) {
  const rules = smart.rules || [];
  if (!rules.length) return true;
  return smart.match === 'any' ? rules.some((r) => matchRule(clip, r)) : rules.every((r) => matchRule(clip, r));
}

/** Nombre del volumen de un fichero: /Volumes/XXX en Mac, letra de unidad en Windows. */
function volumeOf(p) {
  const m = /^\/Volumes\/([^/]+)/.exec(p.replace(/\\/g, '/'));
  if (m) return m[1];
  const root = path.parse(p).root;
  return root && root !== '/' ? root.replace(/[\\/]+$/, '') : 'Disco interno';
}

class Library {
  constructor(store, thumbDir) {
    this.store = store;
    this.thumbDir = thumbDir;
    for (const [k, v] of [['clips', {}], ['bins', {}], ['smartFolders', []], ['customFields', []], ['jobs', []], ['stills', []]]) if (!store.get(k)) store.set(k, v);
  }

  get clips() { return this.store.get('clips'); }
  get bins() { return this.store.get('bins'); }

  /* ---------- ficha de proyecto ---------- */
  getProject() { return this.store.get('project') || null; }
  setProject(info = {}) {
    const cur = this.getProject() || { created: new Date().toISOString() };
    const next = { ...cur };
    for (const k of PROJECT_FIELDS) if (k in info) next[k] = String(info[k] ?? '').trim();
    if ('logo' in info) {
      if (info.logo && info.logo.length > MAX_LOGO * 1.4) throw new Error('El logo es demasiado grande (máximo 1,5 MB)');
      next.logo = info.logo || '';
    }
    if (!next.name) throw new Error('El proyecto necesita un nombre');
    this.store.set('project', next);
    return next;
  }

  /* ---------- carpetas (bins) en arbol ---------- */
  descendants(binId) {
    const out = new Set([binId]); let grew = true;
    while (grew) { grew = false; for (const b of Object.values(this.bins)) if (b.parent && out.has(b.parent) && !out.has(b.id)) { out.add(b.id); grew = true; } }
    return out;
  }

  /** Crea (si no existe) la cadena de carpetas y devuelve la mas profunda. `extra` solo se aplica a la ultima. */
  ensureBinPath(segments, extra = {}) {
    let parent = null, bin = null; const segs = segments.filter(Boolean);
    segs.forEach((name, i) => {
      bin = Object.values(this.bins).find((b) => b.name === name && (b.parent || null) === parent);
      if (!bin) { bin = { id: uid(), name, parent, created: new Date().toISOString(), ...(i === segs.length - 1 ? extra : {}) }; this.store.data.bins[bin.id] = bin; }
      else if (i === segs.length - 1 && Object.keys(extra).length) Object.assign(bin, extra);
      parent = bin.id;
    });
    this.store.save();
    return bin;
  }
  upsertBin(name, extra = {}) { return this.ensureBinPath([name], extra); }

  /** Carpetas con estadisticas propias y acumuladas (incluyen descendientes). */
  listBins() {
    const own = {};
    const zero = () => ({ clips: 0, size: 0, video: 0, audio: 0, still: 0, duration: 0 });
    for (const c of Object.values(this.clips)) {
      const s = own[c.bin] || (own[c.bin] = zero());
      s.clips++; s.size += c.size || 0; s[c.kind] = (s[c.kind] || 0) + 1; s.duration += c.meta?.duration || 0;
    }
    const total = {};
    for (const b of Object.values(this.bins)) total[b.id] = zero();
    for (const [id, s] of Object.entries(own)) {
      let cur = this.bins[id]; const seen = new Set();
      while (cur && !seen.has(cur.id)) { seen.add(cur.id); const t = total[cur.id]; for (const k of Object.keys(s)) t[k] += s[k]; cur = cur.parent ? this.bins[cur.parent] : null; }
    }
    return Object.values(this.bins).map((b) => ({ ...b, count: total[b.id].clips, own: own[b.id]?.clips || 0, stats: total[b.id] })).sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  }

  listClips({ bin, smartId, search, recursive = true } = {}) {
    let clips = Object.values(this.clips);
    if (bin) { const ids = recursive ? this.descendants(bin) : new Set([bin]); clips = clips.filter((c) => ids.has(c.bin)); }
    if (smartId) {
      const sf = this.store.get('smartFolders').find((s) => s.id === smartId);
      if (sf) clips = clips.filter((c) => matchSmart(c, sf));
    }
    if (search) {
      const q = search.toLowerCase();
      clips = clips.filter((c) => [c.name, c.scene, c.shot, c.notes, c.reel, c.camera, c.shotId].some((x) => String(x ?? '').toLowerCase().includes(q)));
    }
    return clips.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  }

  updateClip(id, patch) {
    const c = this.clips[id];
    if (!c) throw new Error('Clip no encontrado');
    const allowed = ['scene', 'shot', 'take', 'camera', 'reel', 'flag', 'rating', 'color', 'notes', 'name', 'custom', 'cam', 'bin', 'look', 'transform', 'shotId'];
    for (const k of Object.keys(patch)) if (allowed.includes(k)) c[k] = (k === 'custom' || k === 'cam') ? { ...c[k], ...patch[k] } : patch[k];
    this.store.save();
    return c;
  }
  bulkUpdate(ids, patch) { return ids.map((id) => this.updateClip(id, patch)); }

  addSmartFolder(sf) {
    const folder = { id: uid(), name: sf.name, match: sf.match || 'all', rules: sf.rules || [] };
    this.store.data.smartFolders.push(folder);
    this.store.save();
    return folder;
  }
  removeSmartFolder(id) {
    this.store.data.smartFolders = this.store.data.smartFolders.filter((s) => s.id !== id);
    this.store.save();
  }
  addCustomField(name) {
    const f = String(name).trim();
    if (f && !this.store.data.customFields.includes(f)) { this.store.data.customFields.push(f); this.store.save(); }
    return this.store.data.customFields;
  }

  newClip(f, bin, extra) {
    return {
      id: uid(), bin: bin.id, name: path.basename(f.rel || f.abs), kind: f.kind, size: f.size, relPath: f.rel, hashes: null, verified: 'imported',
      reel: '', camera: '', scene: '', shot: '', take: '', shotId: '', flag: '', rating: 0, color: '', notes: '', custom: {}, cam: {}, meta: null, thumb: null,
      copies: [], volume: '', added: new Date().toISOString(), ...extra,
    };
  }

  /** ffprobe + miniatura en segundo plano; no bloquea la interfaz. */
  analyze(clips, onClip) {
    (async () => {
      for (const clip of clips) {
        if (clip.kind !== 'video' && clip.kind !== 'audio') continue;
        try {
          clip.meta = await media.probe(clip.path);
          if (clip.kind === 'video') await this.makeThumb(clip);
        } catch (e) { clip.metaError = e.message; if (clip.kind === 'video' && !clip.thumb) { try { clip.thumb = await media.placeholderThumb(path.join(this.thumbDir, `${clip.id}.jpg`), 'No se pudo leer', 'sin vista previa'); } catch { /* sin miniatura */ } } }
        this.store.save();
        onClip?.(clip);
      }
    })();
  }

  /**
   * Miniatura de un clip. Si el codec no se puede decodificar (RAW de camara...) se usa su proxy, y si no hay, una miniatura generica
   * con el nombre del formato. Tambien rellena los datos que falten (duracion, resolucion) desde el proxy.
   */
  async makeThumb(clip) {
    const out = path.join(this.thumbDir, `${clip.id}.jpg`);
    clip.thumbRev = (clip.thumbRev || 0) + 1; // cambia la direccion de la miniatura para que la interfaz no use la antigua
    let src = clip.path;
    if (clip.meta?.decodable === false) {
      // formato RAW: se identifica y, si hay decodificador nativo instalado, se lee con el SDK del fabricante (nunca se convierte en silencio)
      const det = rawdec.detectFormat(clip.path);
      if (det.id) {
        clip.meta.rawFormat = det.id; clip.meta.rawDetect = { confidence: det.confidence, evidence: det.evidence };
        clip.meta.codecLabel = rawdec.FORMATS[det.id].name; clip.meta.codec = clip.meta.codecLabel;
        if (this.raw && await this.nativeRaw(clip, det, out)) return clip.thumb;
      }
      if (!clip.proxy || !(await fsp.access(clip.proxy).then(() => true, () => false))) clip.proxy = (await media.findProxy(clip.path)) || undefined;
      if (!clip.proxy) { clip.thumb = await media.placeholderThumb(out, clip.meta.codecLabel || 'RAW', 'sin decodificador · vincula un proxy'); return clip.thumb; }
      src = clip.proxy;
      try { const pm = await media.probe(src); for (const k of ['duration', 'width', 'height', 'fps', 'timecode']) if (!clip.meta[k] && pm[k]) clip.meta[k] = pm[k]; } catch { /* el proxy no se pudo leer */ }
    }
    try { clip.thumb = await media.thumbnail(src, out, Math.min(1, (clip.meta?.duration || 1) / 2)); }
    catch (e) { clip.thumb = await media.placeholderThumb(out, clip.meta?.codecLabel || 'Sin vista previa', 'no se pudo extraer un fotograma'); clip.meta = { ...(clip.meta || {}), thumbError: e.message }; }
    return clip.thumb;
  }

  /** Lectura nativa de un clip RAW con su decodificador: datos reales (resolucion, profundidad, camara, sensor) y miniatura decodificada. */
  async nativeRaw(clip, det, out) {
    let rc;
    try { rc = await this.raw.open(clip.path, { format: det.id }); }
    catch (e) { clip.meta.rawState = e.state || 'error'; clip.meta.rawReason = e.reason || e.message; return false; }
    try {
      const info = rc.info(); const m = clip.meta;
      Object.assign(m, { rawNative: true, rawState: 'ready', rawReason: undefined, width: info.width, height: info.height, fps: info.fps, bitDepth: info.bitDepth, timecode: info.timecode || m.timecode,
        duration: info.duration || (info.frames && info.fps ? info.frames / info.fps : m.duration), camera: { ...(m.camera || {}), ...(info.camera || {}) }, rawSensor: info.sensor, rawAsShot: info.asShot, rawSdk: info.sdk, rawGpu: info.gpu, rawFrames: info.frames });
      const fr = await rc.frame(Math.floor((info.frames || 1) / 2), {});
      await fsp.mkdir(path.dirname(out), { recursive: true }); await fsp.writeFile(out, await rawdec.frameToJpeg(fr, { maxWidth: 320 }));
      clip.thumb = out; return true;
    } catch (e) { clip.meta.rawState = 'error'; clip.meta.rawReason = e.message; return false; }
    finally { rc.close(); }
  }

  /** Vincula (o quita, con file=null) un proxy a un clip y rehace su miniatura. */
  async linkProxy(id, file) {
    const c = this.clips[id]; if (!c) throw new Error('Clip no encontrado');
    if (file) { await fsp.access(file); c.proxy = file; } else delete c.proxy;
    if (c.kind === 'video') await this.makeThumb(c);
    this.store.save(); return c;
  }

  /** Registra los ficheros de un job (primer destino). Las carpetas se crean segun la ruta copiada. */
  async registerJob(job, { project, reel, camera, day } = {}, onClip) {
    const added = []; let firstBin = null;
    for (const f of job.files) {
      const d = f.dests?.[0];
      if (!d) continue;
      const kind = media.kindOf(f.rel);
      if (!kind) continue;
      const segs = path.dirname(f.rel).split(/[\\/]/).filter((x) => x && x !== '.');
      const bin = this.ensureBinPath(segs.length ? segs : [reel || 'Offload'], { project, camera, day, jobId: job.id });
      firstBin = firstBin || bin;
      added.push(this.newClip({ rel: f.rel, kind, size: f.size }, bin, {
        path: d.path, hashes: f.hashes, verified: d.status, jobId: job.id, reel: reel || bin.name, camera: camera || '',
        volume: job.volume || path.basename((job.sources[0] || '').replace(/[\\/]+$/, '')) || volumeOf(job.sources[0] || ''),
        copies: f.dests.map((x) => ({ path: x.path, status: x.status })),
      }));
    }
    for (const c of added) this.store.data.clips[c.id] = c;
    this.store.save();
    this.analyze(added, onClip);
    return { bin: firstBin, clips: added };
  }

  /** Importa ficheros ya existentes (sin copiarlos) conservando la estructura de carpetas. */
  async importFolder(root, opts = {}, onClip) {
    const camera = opts.camera || "";
    const files = await walk(root);
    const known = new Set(Object.values(this.clips).map((c) => c.path));
    const base = path.basename(root.replace(/[\\/]+$/, '')) || root;
    const added = []; let skipped = 0, dup = 0;
    const only = opts.only ? new Set(opts.only) : null;
    for (const f of files) {
      if (only && !only.has(f.abs)) continue;
      const kind = media.kindOf(f.abs);
      if (!kind) { skipped++; continue; }
      if (known.has(f.abs)) { dup++; continue; }
      const segs = [base, ...path.dirname(f.rel).split(/[\\/]/).filter((x) => x && x !== '.')];
      const bin = this.ensureBinPath(segs, { imported: true });
      added.push(this.newClip({ rel: f.rel, abs: f.abs, kind, size: f.size }, bin, { path: f.abs, name: path.basename(f.abs), reel: bin.name, camera, volume: volumeOf(f.abs), copies: [{ path: f.abs, status: 'original' }] }));
    }
    for (const c of added) this.store.data.clips[c.id] = c;
    this.store.save();
    this.analyze(added, onClip);
    return { imported: added.length, skipped, duplicates: dup, clips: added };
  }

  /** Registra salidas de transcode en la carpeta "Transcodes". */
  async registerTranscode(srcClip, outFile, preset, onClip) {
    const st = await require('node:fs/promises').stat(outFile);
    const prev = Object.values(this.clips).find((c) => c.path === outFile);
    if (prev) { prev.size = st.size; prev.meta = null; prev.thumb = null; prev.derivedFrom = srcClip?.id || prev.derivedFrom; this.store.save(); this.analyze([prev], onClip); return prev; }
    const bin = this.ensureBinPath(['Transcodes', preset || 'Salida'], { transcodes: true });
    const kind = media.kindOf(outFile) || 'video';
    const clip = this.newClip({ rel: path.basename(outFile), abs: outFile, kind, size: st.size }, bin, {
      path: outFile, reel: srcClip?.reel || '', camera: srcClip?.camera || '', scene: srcClip?.scene || '', shot: srcClip?.shot || '', take: srcClip?.take || '',
      shotId: srcClip?.shotId || '', volume: volumeOf(outFile), verified: 'transcode', derivedFrom: srcClip?.id || null, copies: [{ path: outFile, status: 'original' }],
    });
    this.store.data.clips[clip.id] = clip; this.store.save();
    this.analyze([clip], onClip);
    return clip;
  }

  /* ---------- stills guardados por escena ---------- */
  listStills() { return this.store.get('stills') || []; }
  addStill(rec) { this.store.data.stills = [...this.listStills(), rec]; this.store.save(); return rec; }
  updateStill(id, patch) {
    const s = this.listStills().find((x) => x.id === id); if (!s) throw new Error('Still no encontrado');
    for (const k of ['scene', 'note', 'label']) if (k in patch) s[k] = String(patch[k] ?? '').slice(0, 500);
    this.store.save(); return s;
  }
  removeStill(id) {
    const s = this.listStills().find((x) => x.id === id);
    this.store.data.stills = this.listStills().filter((x) => x.id !== id); this.store.save();
    return s || null;
  }

  addJob(job) {
    const slim = { ...job, files: job.files.map((f) => ({ rel: f.rel, size: f.size, mtime: f.mtime, hashes: f.hashes, dests: f.dests, error: f.error })) };
    this.store.data.jobs.unshift(slim);
    this.store.data.jobs = this.store.data.jobs.slice(0, 500);
    this.store.save();
  }
  listJobs() { return this.store.get('jobs'); }
}

module.exports = { Library, matchSmart, matchRule, PROJECT_FIELDS, volumeOf };
