// Biblioteca de clips: bins, metadatos, campos personalizados y carpetas inteligentes.
const path = require('node:path');
const crypto = require('node:crypto');
const media = require('./media');

const uid = () => crypto.randomBytes(6).toString('hex');

const BASE_FIELDS = ['name', 'bin', 'kind', 'codec', 'width', 'height', 'fps', 'duration', 'size', 'scene', 'shot', 'take', 'camera', 'reel', 'flag', 'rating', 'color', 'notes', 'verified', 'timecode'];

function fieldValue(clip, field) {
  if (field in clip) return clip[field];
  if (clip.meta && field in clip.meta) return clip.meta[field];
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

class Library {
  constructor(store, thumbDir) {
    this.store = store;
    this.thumbDir = thumbDir;
    if (!store.get('clips')) store.set('clips', {});
    if (!store.get('bins')) store.set('bins', {});
    if (!store.get('smartFolders')) store.set('smartFolders', []);
    if (!store.get('customFields')) store.set('customFields', []);
    if (!store.get('jobs')) store.set('jobs', []);
  }

  get clips() { return this.store.get('clips'); }
  get bins() { return this.store.get('bins'); }

  listClips({ bin, smartId, search } = {}) {
    let clips = Object.values(this.clips);
    if (bin) clips = clips.filter((c) => c.bin === bin);
    if (smartId) {
      const sf = this.store.get('smartFolders').find((s) => s.id === smartId);
      if (sf) clips = clips.filter((c) => matchSmart(c, sf));
    }
    if (search) {
      const q = search.toLowerCase();
      clips = clips.filter((c) => [c.name, c.scene, c.shot, c.notes, c.reel, c.camera].some((x) => String(x ?? '').toLowerCase().includes(q)));
    }
    return clips.sort((a, b) => a.name.localeCompare(b.name));
  }

  listBins() {
    const counts = {};
    for (const c of Object.values(this.clips)) counts[c.bin] = (counts[c.bin] || 0) + 1;
    return Object.values(this.bins).map((b) => ({ ...b, count: counts[b.id] || 0 })).sort((a, b) => a.name.localeCompare(b.name));
  }

  upsertBin(name, extra = {}) {
    const existing = Object.values(this.bins).find((b) => b.name === name);
    if (existing) return existing;
    const bin = { id: uid(), name, created: new Date().toISOString(), ...extra };
    this.store.data.bins[bin.id] = bin;
    this.store.save();
    return bin;
  }

  updateClip(id, patch) {
    const c = this.clips[id];
    if (!c) throw new Error('Clip no encontrado');
    const allowed = ['scene', 'shot', 'take', 'camera', 'reel', 'flag', 'rating', 'color', 'notes', 'name', 'custom', 'bin', 'look', 'transform', 'shotId'];
    for (const k of Object.keys(patch)) if (allowed.includes(k)) c[k] = k === 'custom' ? { ...c.custom, ...patch.custom } : patch[k];
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

  /** Registra los ficheros de un job (primer destino) como clips. Analiza con ffprobe en segundo plano. */
  async registerJob(job, { project, reel, camera, day } = {}, onClip) {
    const bin = this.upsertBin(reel || path.basename(job.sources[0] || 'Bin'), { project, camera, day, jobId: job.id });
    const dest = job.destinations[0];
    const added = [];
    for (const f of job.files) {
      const d = f.dests?.[0];
      if (!d) continue;
      const kind = media.kindOf(f.rel);
      if (!kind) continue;
      const clip = {
        id: uid(), bin: bin.id, name: path.basename(f.rel), path: d.path, relPath: f.rel, kind, size: f.size,
        hashes: f.hashes, verified: d.status, jobId: job.id, reel: bin.name, camera: camera || '', scene: '', shot: '', take: '',
        flag: '', rating: 0, color: '', notes: '', custom: {}, meta: null, thumb: null, added: new Date().toISOString(),
      };
      this.store.data.clips[clip.id] = clip;
      added.push(clip);
    }
    this.store.save();
    // analisis perezoso: no bloquea la UI
    (async () => {
      for (const clip of added) {
        if (clip.kind !== 'video') continue;
        try {
          clip.meta = await media.probe(clip.path);
          const at = Math.min(1, (clip.meta.duration || 1) / 2);
          const out = path.join(this.thumbDir, `${clip.id}.jpg`);
          clip.thumb = await media.thumbnail(clip.path, out, at);
        } catch (e) { clip.metaError = e.message; }
        this.store.save();
        onClip?.(clip);
      }
    })();
    return { bin, clips: added };
  }

  addJob(job) {
    const slim = { ...job, files: job.files.map((f) => ({ rel: f.rel, size: f.size, mtime: f.mtime, hashes: f.hashes, dests: f.dests, error: f.error })) };
    this.store.data.jobs.unshift(slim);
    this.store.data.jobs = this.store.data.jobs.slice(0, 500);
    this.store.save();
  }
  listJobs() { return this.store.get('jobs'); }
}

module.exports = { Library, matchSmart, matchRule, BASE_FIELDS };
