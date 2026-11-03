const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const { runOffload, verifyFolder } = require('./engine/offload');
const { writeMhl, parseMhl } = require('./engine/mhl');
const { expand } = require('./engine/wildcards');
const { Store } = require('./engine/store');
const { Library } = require('./engine/library');
const media = require('./engine/media');
const report = require('./engine/report');
const color = require('./engine/color');
const exportsM = require('./engine/exports');
const importer = require('./engine/importer');
const ascmhl = require('./engine/ascmhl');
const s3 = require('./engine/s3');
const tools = require('./engine/tools');

let appState; // ajustes globales: proyecto actual, looks, workflows, Slack, S3
const projectFile = (name) => (name === 'Default' ? path.join(app.getPath('userData'), 'library.json') : path.join(app.getPath('userData'), 'projects', `${name.replace(/[^\w .-]/g, '_')}.json`));
function openProject(name) {
  lib = new Library(new Store(projectFile(name)), path.join(app.getPath('userData'), 'thumbs'));
  appState.set('project', name);
}
const encSecret = (s) => (safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : 'raw:' + Buffer.from(s).toString('base64'));
const decSecret = (s) => (!s ? '' : s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : Buffer.from(s.slice(4), 'base64').toString());
function getS3() { const c = appState.get('s3'); return c ? { ...c, secretKey: decSecret(c.secretEnc) } : null; }
async function uploadPaths(paths, prefix = '') {
  const cfg = getS3(); if (!cfg) throw new Error('Configura S3 en Ajustes');
  const out = [];
  for (let i = 0; i < paths.length; i++) {
    const key = [prefix.replace(/^\/|\/$/g, ''), path.basename(paths[i])].filter(Boolean).join('/');
    send('upload:progress', { file: path.basename(paths[i]), i, n: paths.length, p: 0 });
    out.push(await s3.uploadFile({ ...cfg, key, file: paths[i], onProgress: (p) => send('upload:progress', { file: path.basename(paths[i]), i, n: paths.length, p }) }));
  }
  return out;
}

protocol.registerSchemesAsPrivileged([{ scheme: 'cine', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true } }]);

let win, lib, settings;
const running = new Map(); // jobId -> AbortController
const send = (ch, payload) => win && !win.isDestroyed() && win.webContents.send(ch, payload);

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 1100, minHeight: 700, backgroundColor: '#0f1115',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function listVolumes() {
  const out = [];
  if (process.platform === 'darwin') {
    try { for (const n of fs.readdirSync('/Volumes')) out.push({ name: n, path: path.join('/Volumes', n) }); } catch { /* */ }
  } else if (process.platform === 'win32') {
    for (const l of 'DEFGHIJKLMNOPQRSTUVWXYZ') { const p = `${l}:\\`; if (fs.existsSync(p)) out.push({ name: p, path: p }); }
  } else {
    for (const base of ['/media', '/mnt', '/run/media']) try { for (const n of fs.readdirSync(base)) out.push({ name: n, path: path.join(base, n) }); } catch { /* */ }
  }
  return out;
}

async function renderPdf(html, outFile) {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const pdf = await w.webContents.printToPDF({ pageSize: 'A4', landscape: true, printBackground: true });
  w.destroy();
  await fsp.writeFile(outFile, pdf);
  return outFile;
}

/* ---- informes: configuraciones guardadas (varias), generacion y workflow ---- */
const DEFAULT_REPORTS = [
  { id: 'volume', name: 'Volumen / checksums', type: 'volume', format: 'pdf', dark: false, title: '', scope: 'job', columns: [] },
  { id: 'shooting_day', name: 'Día de rodaje', type: 'shooting_day', format: 'pdf', dark: false, title: '', scope: 'job', columns: [] },
  { id: 'clips', name: 'Lista de clips', type: 'clips', format: 'pdf', dark: false, title: '', scope: 'job', columns: [] },
  { id: 'thumbnails', name: 'Miniaturas', type: 'thumbnails', format: 'pdf', dark: false, title: '', scope: 'job', columns: [] },
  { id: 'contact_print', name: 'Contact print', type: 'contact_print', format: 'pdf', dark: false, title: '', scope: 'job', columns: [] },
];
function reportPresets() {
  let l = appState.get('reportPresets');
  if (!Array.isArray(l) || !l.length) { l = DEFAULT_REPORTS.map((r) => ({ ...r })); appState.set('reportPresets', l); }
  return l;
}

async function makeReport(type, { clipIds, jobIds, project, day, format = 'html', dark = false, outDir, title, columns, name }) {
  const clips = clipIds?.length ? clipIds.map((i) => lib.clips[i]).filter(Boolean) : Object.values(lib.clips);
  const jobs = jobIds?.length ? lib.listJobs().filter((j) => jobIds.includes(j.id)) : lib.listJobs();
  const info = lib.getProject();
  const html = report.build(type, { clips, jobs, project: info?.name || project, day, dark, projectInfo: info, title, columns, customFields: lib.store.get('customFields') || [] });
  const dir = outDir || path.join(app.getPath('documents'), 'Cinestack Reports');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const base = path.join(dir, `${(name || type).replace(/[^\w .-]/g, '_')}_${stamp}`);
  if (format === 'pdf') return renderPdf(html, base + '.pdf');
  await fsp.writeFile(base + '.html', html);
  return base + '.html';
}

/** Genera un informe desde una configuracion guardada. `scopeIds`: clips del job o de la seleccion; si no hay, todos. */
function makeReportFromPreset(p, { scopeIds, jobIds, outDir, day } = {}) {
  const useIds = p.scope === 'all' ? null : scopeIds;
  return makeReport(p.type, { clipIds: useIds, jobIds: p.scope === 'all' ? null : jobIds, day, format: p.format, dark: p.dark, outDir, title: p.title, columns: p.columns, name: p.name });
}

/* ---- workflow de offload ---- */
async function startWorkflow(cfg) {
  // cfg: { sources:[{path,type:'camera'|'sound'}], destinations[], template, soundTemplate, project, camera, day, algos[], verify, mhl, ascmhl, rename, script,
  //        reports:[idDeConfiguracion], transcode:{preset,height,lut,burnTimecode,burnName,text,applyLooks,s3,dir,metaFields,keepTimecode}|null }
  const results = [];
  const info = lib.getProject();
  if (info?.name) cfg.project = info.name; // el proyecto activo manda sobre lo que haya escrito el formulario

  // 1) normalizar origenes: cada carpeta es un job; los ficheros sueltos se agrupan por tipo (camara / sonido)
  const defs = []; const loose = { camera: [], sound: [] };
  for (const s of (cfg.sources || []).map((x) => (typeof x === 'string' ? { path: x, type: 'camera' } : x))) {
    const type = s.type === 'sound' ? 'sound' : 'camera';
    const st = await fsp.stat(s.path).catch(() => null);
    if (!st) { defs.push({ type, error: `No existe: ${s.path}`, reel: path.basename(s.path) }); continue; }
    if (st.isFile()) loose[type].push(s.path);
    else defs.push({ type, paths: [s.path], reel: path.basename(s.path.replace(/[\\/]+$/, '')) || s.path, source: s.path });
  }
  for (const type of ['camera', 'sound']) {
    if (!loose[type].length) continue;
    const dirs = new Set(loose[type].map((p) => path.dirname(p)));
    defs.push({ type, paths: loose[type], reel: dirs.size === 1 ? path.basename([...dirs][0]) || 'Sueltos' : 'Sueltos', source: [...dirs][0], loose: true });
  }

  const presets = reportPresets();
  const reportIds = (cfg.reports || (cfg.report ? [cfg.report.type] : [])).filter(Boolean);
  const picked = reportIds.map((id) => presets.find((p) => p.id === id)).filter(Boolean);

  for (let i = 0; i < defs.length; i++) {
    const def = defs[i]; const reel = def.reel;
    const key = `${Date.now()}-${i}`;
    const steps = [{ id: 'copy', label: cfg.verify === false ? 'Copiar' : 'Copiar y verificar' }];
    if (cfg.mhl) steps.push({ id: 'mhl', label: 'Lista MHL' });
    if (cfg.ascmhl) steps.push({ id: 'ascmhl', label: 'Sello ASC MHL' });
    steps.push({ id: 'register', label: 'Registrar en la biblioteca' });
    if (picked.length) steps.push({ id: 'reports', label: picked.length === 1 ? 'Informe' : `${picked.length} informes` });
    if (cfg.transcode) steps.push({ id: 'transcode', label: 'Transcodificar' });
    send('job:start', { key, source: def.source || reel, reel, type: def.type, loose: !!def.loose, files: def.paths?.length, index: i, total: defs.length, steps });
    const step = (id, status, extra = {}) => send('job:step', { key, step: id, status, ...extra });
    if (def.error) { send('job:done', { key, ok: false, error: def.error }); results.push({ error: def.error }); continue; }

    const template = def.type === 'sound' ? (cfg.soundTemplate || '{project}/Dia_{day}/Sonido/{reel}') : (cfg.template || '{reel}');
    const folderName = expand(template, { project: cfg.project, day: cfg.day, camera: cfg.camera, reel, source: def.source, counter: i + 1, type: def.type });
    const ac = new AbortController();
    running.set(key, ac);
    try {
      step('copy', 'run');
      const job = await runOffload({
        sources: def.paths, destinations: cfg.destinations, folderName, algos: cfg.algos, verify: cfg.verify, signal: ac.signal,
        rename: tools.makeRenamer(cfg.rename, { reel, camera: cfg.camera, project: cfg.project }),
        onProgress: (p) => send('job:progress', { key, ...p }),
      });
      step('copy', job.ok ? 'done' : 'error', { failures: job.failures });
      job.reel = reel; job.project = cfg.project; job.day = cfg.day; job.camera = cfg.camera; job.operator = info?.dit || info?.dataManager || ''; job.volume = reel; job.sourceType = def.type;
      const post = []; const folders = [];
      for (let d = 0; d < cfg.destinations.length; d++) folders.push({ label: cfg.destinations.length > 1 ? `Destino ${d + 1}` : 'Carpeta copiada', path: path.join(cfg.destinations[d], folderName) });
      if (cfg.mhl) { step('mhl', 'run'); for (const d of cfg.destinations) post.push(await writeMhl(job, d, `${folderName.replace(/[\\/]/g, '_')}_${job.id}`)); step('mhl', 'done'); }
      if (cfg.ascmhl && job.ok) { step('ascmhl', 'run'); for (const d of cfg.destinations) { const r = await ascmhl.seal(path.join(d, folderName), { algos: cfg.algos }); if (r.ok) post.push(r.file); } step('ascmhl', 'done'); }
      else if (cfg.ascmhl) step('ascmhl', 'skip');
      if (appState.get('slack')) tools.notifySlack(appState.get('slack'), job).catch((e) => send('transcode:error', { error: 'Slack: ' + e.message }));
      if (cfg.script && job.ok) { // paso post: script del usuario con variables de entorno
        const { spawn } = require('node:child_process');
        spawn(cfg.script, [], { shell: true, env: { ...process.env, CINESTACK_REEL: reel, CINESTACK_DEST: path.join(cfg.destinations[0], folderName), CINESTACK_OK: '1' }, stdio: 'ignore', detached: true }).unref();
      }
      step('register', 'run');
      const { clips } = await lib.registerJob(job, { project: cfg.project, reel, camera: cfg.camera, day: cfg.day }, (c) => send('library:clip', c));
      lib.addJob(job);
      step('register', 'done');
      if (picked.length) {
        step('reports', 'run');
        const reportDir = path.join(cfg.destinations[0], folderName + '_report');
        for (const p of picked) { try { post.push(await makeReportFromPreset(p, { scopeIds: clips.map((c) => c.id), jobIds: [job.id], outDir: reportDir, day: cfg.day })); } catch (e) { send('transcode:error', { error: `Informe «${p.name}»: ${e.message}` }); } }
        folders.push({ label: 'Informes', path: reportDir });
        step('reports', 'done');
      }
      let tcDir = null;
      if (cfg.transcode && job.ok) {
        tcDir = cfg.transcode.dir || path.join(app.getPath('documents'), 'Cinestack Transcodes');
        folders.push({ label: 'Transcodes', path: tcDir });
        step('transcode', 'run');
        await new Promise((r) => setTimeout(r, 300)); // esperamos al ffprobe para conocer la duracion
        runTranscodes(clips.filter((c) => c.kind === 'video').map((c) => c.id), cfg.transcode).then(() => step('transcode', 'done')).catch((e) => { step('transcode', 'error'); send('transcode:error', { error: e.message }); });
      } else if (cfg.transcode) step('transcode', 'skip');
      send('job:done', { key, ok: job.ok, failures: job.failures, post, folders, files: job.fileCount, bytes: job.totalBytes });
      results.push({ job: { id: job.id, ok: job.ok, failures: job.failures, fileCount: job.fileCount }, post, folders });
    } catch (e) {
      send('job:done', { key, ok: false, error: e.message });
      results.push({ error: e.message });
      if (e.message === 'Cancelado') break;
    } finally { running.delete(key); }
  }
  return results;
}

async function runTranscodes(ids, t) {
  const preset = media.PRESETS[t.preset];
  const outDir = t.dir || path.join(app.getPath('documents'), 'Cinestack Transcodes');
  const outputs = [];
  const results = [];
  const logFile = path.join(app.getPath('userData'), 'transcode.log');
  const info = lib.getProject();
  await fsp.mkdir(outDir, { recursive: true }).catch(() => {}); // la carpeta existe ya para poder abrirla desde el acceso rapido
  for (const id of ids) {
    const c = lib.clips[id];
    if (!c) continue;
    const item = { id, name: c.name };
    if (c.kind !== 'video') { item.error = 'Solo se pueden transcodificar clips de vídeo'; results.push(item); send('transcode:done', item); continue; }
    if (!(await fsp.access(c.path).then(() => true, () => false))) { item.error = `No se encuentra el fichero original (${c.path}). Usa Archivo → Relink.`; results.push(item); send('transcode:done', item); continue; }
    if (!c.meta) { try { c.meta = await media.probe(c.path); } catch (e) { item.error = 'No se pudo leer el clip: ' + e.message; results.push(item); send('transcode:done', item); continue; } }
    const out = path.join(outDir, c.reel || 'clips', path.basename(c.name, path.extname(c.name)) + preset.ext);
    const ac = new AbortController(); const key = `tc-${id}`; running.set(key, ac);
    send('transcode:start', { id, name: c.name });
    try {
      const luts = t.applyLooks === false ? [] : await color.buildFfmpegLooks(c.look, path.join(app.getPath('temp'), 'cinestack-cubes'));
      if (t.lut) luts.push(t.lut);
      const tr = c.transform || {};
      await media.transcode(c.path, out, { ...t, luts, crop: tr.crop, desqueeze: tr.desqueeze, flip: tr.flip, rotate: tr.rotate, duration: c.meta.duration, fps: c.meta.fps, startTimecode: c.meta.timecode, signal: ac.signal, onProgress: (p) => send('transcode:progress', { id, p }),
        metadata: t.metaFields?.length ? tools.buildClipMetadata(c, info, t.metaFields) : undefined, timecodeOut: t.keepTimecode !== false ? c.meta.timecode : undefined });
      const size = (await fsp.stat(out)).size;
      const reg = await lib.registerTranscode(c, out, preset.label, (cl) => send('library:clip', cl)); // aparece en la carpeta "Transcodes" con su informacion
      outputs.push(out); Object.assign(item, { out, size, clipId: reg.id });
      send('transcode:done', item);
    } catch (e) {
      item.error = e.message; send('transcode:done', item);
      fsp.appendFile(logFile, `[${new Date().toISOString()}] ${c.name} -> ${preset.label}: ${e.message}\n`).catch(() => {});
    } finally { running.delete(key); }
    results.push(item);
  }
  send('transcode:summary', { results, logFile, outDir });
  if (t.s3 && outputs.length) { try { await uploadPaths(outputs, t.s3prefix || ''); send('transcode:done', { id: 'upload', out: `${outputs.length} ficheros subidos a S3` }); } catch (e) { send('transcode:error', { error: e.message }); } }
  return outputs;
}

const proxyCache = new Map();
async function playbackSource(id) {
  const c = lib.clips[id];
  if (!c) throw new Error('Clip no encontrado');
  const direct = ['h264', 'vp9', 'vp8', 'av1'].includes(c.meta?.codec) && /\.(mp4|mov|m4v|webm)$/i.test(c.path);
  if (direct) return { url: `cine://clip/${id}`, proxy: false };
  const out = path.join(app.getPath('userData'), 'proxies', `${id}.mp4`);
  if (!fs.existsSync(out)) {
    if (!proxyCache.has(id)) proxyCache.set(id, media.transcode(c.path, out, { preset: 'h264_dailies', height: 540, duration: c.meta?.duration, onProgress: (p) => send('proxy:progress', { id, p }) }).finally(() => proxyCache.delete(id)));
    await proxyCache.get(id);
  }
  return { url: `cine://proxy/${id}`, proxy: true };
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => fn(...a));
  h('dialog:folder', async (multi) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', ...(multi ? ['multiSelections'] : []), 'createDirectory'] });
    return r.canceled ? [] : r.filePaths;
  });
  h('dialog:files', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: 'Ficheros sueltos' });
    return r.canceled ? [] : r.filePaths;
  });
  h('dialog:file', async (filters) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0];
  });
  h('volumes:list', () => listVolumes());
  h('wildcards:preview', (tpl, ctx) => expand(tpl, ctx));
  h('workflow:start', (cfg) => startWorkflow(cfg));
  h('job:cancel', () => { for (const ac of running.values()) ac.abort(); });
  h('jobs:list', () => lib.listJobs());
  h('library:bins', () => lib.listBins());
  h('library:clips', (q) => lib.listClips(q));
  h('library:update', (id, patch) => lib.updateClip(id, patch));
  h('library:bulk', (ids, patch) => lib.bulkUpdate(ids, patch));
  h('library:smart:list', () => lib.store.get('smartFolders'));
  h('library:smart:add', (sf) => lib.addSmartFolder(sf));
  h('library:smart:remove', (id) => lib.removeSmartFolder(id));
  h('library:fields:list', () => lib.store.get('customFields'));
  h('library:fields:add', (n) => lib.addCustomField(n));
  h('presets:list', () => Object.entries(media.PRESETS).map(([id, p]) => ({ id, label: p.label })));
  h('transcode:start', (ids, t) => runTranscodes(ids, t));
  h('playback:source', (id) => playbackSource(id));
  h('report:make', (type, opts) => makeReport(type, opts));
  h('export:csv', async (ids) => {
    const clips = ids?.length ? ids.map((i) => lib.clips[i]) : Object.values(lib.clips);
    const r = await dialog.showSaveDialog(win, { defaultPath: 'clips.csv' });
    if (r.canceled) return null; await fsp.writeFile(r.filePath, report.toCsv(clips)); return r.filePath;
  });
  h('export:edl', async (ids, fps) => {
    const clips = (ids?.length ? ids.map((i) => lib.clips[i]) : Object.values(lib.clips));
    const r = await dialog.showSaveDialog(win, { defaultPath: 'clips.edl' });
    if (r.canceled) return null; await fsp.writeFile(r.filePath, report.toEdl(clips, 'CINESTACK', fps || 25)); return r.filePath;
  });
  h('verify:folder', async (root, mhlFile, algos) => {
    const xml = await fsp.readFile(mhlFile, 'utf8');
    let entries = parseMhl(xml);
    // El MHL guarda "carpeta/rel"; si root es la propia carpeta, recortamos el primer segmento.
    const first = entries[0]?.rel.split('/')[0];
    if (first && path.basename(root) === first) entries = entries.map((e) => ({ ...e, rel: e.rel.split('/').slice(1).join('/') }));
    const use = (algos?.length ? algos : Object.keys(entries[0]?.hashes || { xxh64: 1 })).filter((a) => entries.every((e) => e.hashes[a]));
    return verifyFolder(root, entries, use, (p) => send('verify:progress', p));
  });
  h('shell:reveal', (p) => shell.showItemInFolder(p));
  h('shell:open', (p) => shell.openPath(p));
}

function registerIpc2() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => fn(...a));
  const pick = (ids) => (ids?.length ? ids.map((i) => lib.clips[i]).filter(Boolean) : Object.values(lib.clips));
  const saveText = async (name, text) => { const r = await dialog.showSaveDialog(win, { defaultPath: name }); if (r.canceled) return null; await fsp.writeFile(r.filePath, text); return r.filePath; };

  // color y looks
  h('looks:list', () => appState.get('looks'));
  h('looks:save', (look) => { const l = { id: Date.now().toString(36), name: look.name, cdl: look.cdl, lut: look.lut || null }; appState.set('looks', [...appState.get('looks'), l]); return l; });
  h('looks:remove', (id) => appState.set('looks', appState.get('looks').filter((l) => l.id !== id)));
  h('look:set', (ids, look) => lib.bulkUpdate(ids, { look }));
  // LUT en bloque: a una seleccion, a una carpeta (con subcarpetas) o a toda la biblioteca. El CDL de cada clip se conserva para el ajuste fino.
  h('look:applyLut', (target, lut) => {
    const ids = target.ids?.length ? target.ids : target.bin ? lib.listClips({ bin: target.bin }).map((c) => c.id) : Object.keys(lib.clips);
    let n = 0;
    for (const id of ids) { const c = lib.clips[id]; if (!c || c.kind !== 'video') continue; lib.updateClip(id, { look: { ...(c.look || {}), cdl: c.look?.cdl || color.IDENTITY(), lut: lut || null } }); n++; }
    return n;
  });
  // previsualizacion del transcode: un fotograma con los mismos filtros que se aplicaran
  h('transcode:preview', async (id, t, time) => {
    const c = lib.clips[id]; if (!c || c.kind !== 'video') throw new Error('Elige un clip de vídeo para previsualizar');
    if (!(await fsp.access(c.path).then(() => true, () => false))) throw new Error('No se encuentra el fichero original');
    const meta = c.meta || await media.probe(c.path);
    const luts = t.applyLooks === false ? [] : await color.buildFfmpegLooks(c.look, path.join(app.getPath('temp'), 'cinestack-cubes'));
    if (t.lut) luts.push(t.lut);
    const tr = c.transform || {}; const fps = meta.fps || 25;
    const at = time ?? Math.min(1, (meta.duration || 2) / 2);
    const startTc = meta.timecode ? exportsM.framesToTc(exportsM.tcToFrames(meta.timecode, fps) + Math.round(at * fps), fps) : undefined; // -ss reinicia la cuenta: se suma el desplazamiento
    return media.previewFrame(c.path, { ...t, luts, crop: tr.crop, desqueeze: tr.desqueeze, flip: tr.flip, rotate: tr.rotate, fps, startTimecode: startTc, time: at });
  });
  // informes: varias configuraciones guardadas, exportables e importables
  h('reports:list', () => reportPresets());
  h('reports:save', (p) => {
    const list = reportPresets(); const id = p.id || ('r' + Date.now().toString(36));
    const next = { id, name: String(p.name || 'Informe').slice(0, 80), type: p.type, format: p.format === 'html' ? 'html' : 'pdf', dark: !!p.dark, title: String(p.title || '').slice(0, 120), scope: ['job', 'all', 'selection'].includes(p.scope) ? p.scope : 'all', columns: Array.isArray(p.columns) ? p.columns : [] };
    if (!['volume', 'shooting_day', 'clips', 'thumbnails', 'contact_print'].includes(next.type)) throw new Error('Tipo de informe no válido');
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list[i] = next; else list.push(next);
    appState.set('reportPresets', list); return next;
  });
  h('reports:remove', (id) => { appState.set('reportPresets', reportPresets().filter((x) => x.id !== id)); });
  h('reports:run', async (ids, scopeIds) => {
    const out = []; const list = reportPresets();
    for (const id of ids) { const p = list.find((x) => x.id === id); if (p) out.push(await makeReportFromPreset({ ...p, scope: p.scope === 'selection' && !scopeIds?.length ? 'all' : p.scope }, { scopeIds })); }
    return out;
  });
  h('reports:export', async (ids) => {
    const list = reportPresets().filter((p) => !ids?.length || ids.includes(p.id));
    return saveText('informes-crisstack.json', JSON.stringify({ app: 'crisstack-xs', kind: 'report-presets', version: 1, presets: list }, null, 2));
  });
  h('reports:import', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Configuración de informes', extensions: ['json'] }] }); if (r.canceled) return null;
    const data = JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8'));
    if (data.kind !== 'report-presets' || !Array.isArray(data.presets)) throw new Error('Este fichero no es una configuración de informes de CrisStack XS');
    const list = reportPresets(); let n = 0;
    for (const p of data.presets) {
      if (!['volume', 'shooting_day', 'clips', 'thumbnails', 'contact_print'].includes(p.type)) continue;
      const id = list.some((x) => x.id === p.id) ? 'r' + Date.now().toString(36) + n : (p.id || 'r' + Date.now().toString(36) + n);
      list.push({ id, name: String(p.name || 'Informe').slice(0, 80), type: p.type, format: p.format === 'html' ? 'html' : 'pdf', dark: !!p.dark, title: String(p.title || '').slice(0, 120), scope: ['job', 'all', 'selection'].includes(p.scope) ? p.scope : 'all', columns: Array.isArray(p.columns) ? p.columns : [] }); n++;
    }
    appState.set('reportPresets', list); return n;
  });
  h('transform:set', (ids, tr) => lib.bulkUpdate(ids, { transform: tr }));
  h('lut:read', async (p) => { const c = color.parseCube(await fsp.readFile(p, 'utf8')); return { size: c.size, data: c.data }; });
  h('looks:importCdl', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'ASC CDL', extensions: ['cdl', 'cc', 'ccc'] }] });
    if (r.canceled) return { applied: 0, saved: 0 };
    const items = color.parseCdlXml(await fsp.readFile(r.filePaths[0], 'utf8')); let applied = 0;
    for (const it of items) {
      const clip = Object.values(lib.clips).find((c) => c.name.replace(/\.[^.]+$/, '') === it.id);
      if (clip) { lib.updateClip(clip.id, { look: { ...(clip.look || {}), cdl: it.cdl } }); applied++; }
      else appState.set('looks', [...appState.get('looks'), { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: it.id, cdl: it.cdl, lut: null }]);
    }
    return { applied, saved: items.length - applied };
  });
  h('thumb:set', async (id, t) => { const c = lib.clips[id]; c.thumb = await media.thumbnail(c.path, path.join(app.getPath('userData'), 'thumbs', `${id}.jpg`), t); lib.store.save(); return c.thumb; });
  h('still:export', async (id, t, preset) => {
    const c = lib.clips[id]; const tr = c.transform || {};
    const luts = await color.buildFfmpegLooks(c.look, path.join(app.getPath('temp'), 'cinestack-cubes'));
    const dir = path.join(app.getPath('documents'), 'Cinestack Stills'); const ext = media.STILL_PRESETS[preset || 'jpeg'].ext;
    return media.exportStill(c.path, path.join(dir, `${path.basename(c.name, path.extname(c.name))}_${Math.round(t * 1000)}${ext}`), { time: t, preset, luts, crop: tr.crop, desqueeze: tr.desqueeze, flip: tr.flip, rotate: tr.rotate });
  });
  h('combine:run', async (ids, preset, height) => {
    const files = pick(ids).filter((c) => c.kind === 'video').map((c) => c.path); if (files.length < 2) throw new Error('Selecciona al menos 2 clips');
    return media.combineClips(files, path.join(app.getPath('documents'), 'Cinestack Transcodes', `combinado_${Date.now()}${media.PRESETS[preset].ext}`), { preset, height });
  });

  // intercambio
  h('export:ale', (ids, fps) => saveText('clips.ale', exportsM.toAle(pick(ids), fps || 25, lib.store.get('customFields') || [])));
  h('export:fcp7', (ids, fps) => saveText('clips.xml', exportsM.toFcp7Xml(pick(ids), 'Cinestack', fps || 25)));
  h('export:fcpxml', (ids, fps) => saveText('clips.fcpxml', exportsM.toFcpxml(pick(ids), 'Cinestack', fps || 25)));
  h('export:ccc', (ids) => saveText('looks.ccc', exportsM.toCcc(pick(ids))));
  h('import:parse', async (file) => {
    const text = await fsp.readFile(file, 'utf8'); const r = /\.ale$/i.test(file) ? importer.parseAle(text) : importer.parseCsv(text);
    return { columns: r.columns, rows: r.rows, mapping: importer.suggestMapping(r.columns) };
  });
  h('import:apply', (rows, opts) => {
    const { updates, unmatched } = importer.applyRows(Object.values(lib.clips), rows, opts);
    for (const u of updates) lib.updateClip(u.id, u.patch);
    return { updated: updates.length, unmatched };
  });

  // integridad / archivo
  h('mhl:seal', (root, algos) => ascmhl.seal(root, { algos: algos?.length ? algos : ['xxh64'] }));
  h('mhl:verify', (root) => ascmhl.verify(root));
  h('relink:run', async (roots) => {
    const r = await tools.relink(Object.values(lib.clips), roots);
    for (const x of r.relinked) lib.clips[x.id].path = x.to; lib.store.save(); return r;
  });
  h('sequences:detect', async (folder) => { const files = await require('./engine/offload').walk(folder); return tools.detectSequences(files.map((f) => f.rel)); });
  h('upload:clips', (ids, prefix) => uploadPaths(pick(ids).map((c) => c.path), prefix));
  h('upload:paths', (paths, prefix) => uploadPaths(paths, prefix));

  // ajustes, workflows, proyectos
  h('settings:get', () => ({ slack: appState.get('slack'), s3: appState.get('s3') ? { ...appState.get('s3'), secretEnc: undefined, hasSecret: true } : null, encrypted: safeStorage.isEncryptionAvailable(), project: appState.get('project') }));
  h('settings:set', ({ slack, s3: c }) => {
    if (slack !== undefined) appState.set('slack', slack);
    if (c) { const old = appState.get('s3') || {}; appState.set('s3', { endpoint: c.endpoint, region: c.region, bucket: c.bucket, accessKey: c.accessKey, secretEnc: c.secretKey ? encSecret(c.secretKey) : old.secretEnc }); }
  });
  h('slack:test', () => tools.postJson(appState.get('slack'), { text: 'Cinestack: aviso de prueba' }));
  h('workflows:list', () => appState.get('workflows'));
  h('workflows:save', (w) => { appState.set('workflows', [...appState.get('workflows').filter((x) => x.name !== w.name), w]); });
  h('workflows:remove', (name) => appState.set('workflows', appState.get('workflows').filter((x) => x.name !== name)));
  // proyectos: cada uno es un fichero con su biblioteca y su ficha (equipo, logo, copyright)
  h('project:list', async () => {
    const dir = path.join(app.getPath('userData'), 'projects');
    const ids = ['Default', ...(await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))];
    const out = [];
    for (const id of ids) {
      let name = id === 'Default' ? 'Sin título' : id;
      try { const d = JSON.parse(await fsp.readFile(projectFile(id), 'utf8')); if (d.project?.name) name = d.project.name; } catch { /* aun no existe */ }
      out.push({ id, name });
    }
    return out;
  });
  h('project:switch', async (id) => { await fsp.mkdir(path.join(app.getPath('userData'), 'projects'), { recursive: true }); openProject(id); });
  h('project:get', () => ({ id: appState.get('project'), info: lib.getProject() }));
  h('project:update', (info) => lib.setProject(info));
  h('project:create', async (info) => {
    const name = String(info?.name || '').trim(); if (!name) throw new Error('El proyecto necesita un nombre');
    const dir = path.join(app.getPath('userData'), 'projects'); await fsp.mkdir(dir, { recursive: true });
    const base = name.replace(/[^\w .-]/g, '_').slice(0, 60) || 'Proyecto'; let id = base, n = 2;
    while (id === 'Default' || await fsp.access(projectFile(id)).then(() => true, () => false)) id = `${base} ${n++}`;
    openProject(id); lib.setProject(info);
    return { id };
  });
  h('logo:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Imagen', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp'] }] });
    if (r.canceled) return null;
    const f = r.filePaths[0]; const st = await fsp.stat(f); if (st.size > 1.5 * 1024 * 1024) throw new Error('El logo es demasiado grande (máximo 1,5 MB)');
    const ext = path.extname(f).slice(1).toLowerCase(); const mime = ext === 'svg' ? 'svg+xml' : ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${(await fsp.readFile(f)).toString('base64')}`;
  });
  // importar ficheros existentes sin copiarlos (mantienen su estructura de carpetas)
  h('import:folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'], title: 'Importar carpetas a la biblioteca' });
    if (r.canceled) return null;
    const total = { imported: 0, skipped: 0, duplicates: 0 };
    for (const root of r.filePaths) { const x = await lib.importFolder(root, {}, (c) => send('library:clip', c)); for (const k of Object.keys(total)) total[k] += x[k]; }
    return total;
  });
  h('import:files', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: 'Importar ficheros a la biblioteca' });
    if (r.canceled) return null;
    const byDir = new Map(); for (const f of r.filePaths) (byDir.get(path.dirname(f)) || byDir.set(path.dirname(f), []).get(path.dirname(f))).push(f);
    const total = { imported: 0, skipped: 0, duplicates: 0 };
    for (const [dir, files] of byDir) { const x = await lib.importFolder(dir, { only: files }, (c) => send('library:clip', c)); for (const k of Object.keys(total)) total[k] += x[k]; }
    return total;
  });
  h('export:text', (name, text) => saveText(name, text));
  h('archive:export', async () => {
    const r = await dialog.showSaveDialog(win, { defaultPath: `cinestack-${appState.get('project')}.cinestack.json` }); if (r.canceled) return null;
    await fsp.writeFile(r.filePath, JSON.stringify({ app: 'cinestack', version: 1, project: appState.get('project'), library: lib.store.data, looks: appState.get('looks'), workflows: appState.get('workflows') }, null, 2)); return r.filePath;
  });
  h('archive:import', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Cinestack', extensions: ['json'] }] }); if (r.canceled) return null;
    const a = JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8')); if (a.app !== 'cinestack') throw new Error('No es un archivo de Cinestack');
    const d = lib.store.data; Object.assign(d.bins, a.library.bins); Object.assign(d.clips, a.library.clips);
    for (const s of a.library.smartFolders || []) if (!d.smartFolders.some((x) => x.id === s.id)) d.smartFolders.push(s);
    d.customFields = [...new Set([...d.customFields, ...(a.library.customFields || [])])]; lib.store.save();
    appState.set('looks', [...appState.get('looks'), ...(a.looks || []).filter((l) => !appState.get('looks').some((x) => x.id === l.id))]);
    appState.set('workflows', [...appState.get('workflows'), ...(a.workflows || []).filter((w) => !appState.get('workflows').some((x) => x.name === w.name))]);
    return { clips: Object.keys(a.library.clips).length };
  });
}

app.whenReady().then(() => {
  const ud = app.getPath('userData');
  appState = new Store(path.join(ud, 'app-settings.json'), { project: 'Default', looks: [], workflows: [], slack: '', s3: null });
  openProject(appState.get('project'));
  settings = lib.store;

  protocol.handle('cine', async (req) => {
    const u = new URL(req.url);
    const id = u.pathname.replace(/^\//, '');
    let file;
    if (u.host === 'thumb') file = path.join(ud, 'thumbs', id.replace(/[^\w.-]/g, '') + (id.endsWith('.jpg') ? '' : '.jpg'));
    else if (u.host === 'clip') file = lib.clips[id]?.path;
    else if (u.host === 'proxy') file = path.join(ud, 'proxies', id.replace(/[^\w.-]/g, '') + '.mp4');
    if (!file) return new Response('not found', { status: 404 });
    const r = await net.fetch(pathToFileURL(file).toString(), { headers: req.headers });
    const headers = new Headers(r.headers); headers.set('Access-Control-Allow-Origin', '*'); // necesario para subir el video a una textura WebGL
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
  });

  registerIpc();
  registerIpc2();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());

/* ---- Autoprueba de extremo a extremo: CINESTACK_SELFTEST=<carpeta de salida> electron . ---- */
async function selftest(outDir) {
  const { spawnSync } = require('node:child_process');
  const log = []; const step = (n, v) => { log.push([n, v]); console.log('[selftest]', n, JSON.stringify(v)); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { throw new Error(`JS fallo: ${code.slice(0, 90)} -> ${e.message}`); });
  const shot = async (name) => { // capturePage puede fallar de forma puntual si el compositor se reinicia: se reintenta
    for (let i = 0; i < 4; i++) { try { win.show(); const img = await win.webContents.capturePage(); await fsp.writeFile(path.join(outDir, name + '.png'), img.toPNG()); return; } catch (e) { step('captura fallida', [name, i, String(e.message)]); await wait(700); } }
  };
  win.webContents.on('console-message', (_e, level, msg, line, src) => step('renderer-console', [level, msg, line, path.basename(src || '')]));
  try {
    win.webContents.reload(); await wait(1500);
    step('api', await js(`typeof window.cinestack + ' ' + JSON.stringify(window.__errs)`));
    const card = path.join(outDir, 'CARD_A001'); await fsp.mkdir(card, { recursive: true });
    const gen = (f, extra) => spawnSync(media.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', ...extra, path.join(card, f)]);
    step('gen h264', gen('A001C001.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']).status);
    step('gen prores', gen('A001C002.mov', ['-timecode', '10:00:00:00', '-c:v', 'prores_ks', '-profile:v', '3', '-c:a', 'pcm_s16le', '-ar', '48000']).status);
    await wait(500);
    const dests = [path.join(outDir, 'BACKUP1'), path.join(outDir, 'BACKUP2')];
    const res = await startWorkflow({ sources: [card], destinations: dests, template: '{project}/Dia_{day}/{camera}_{reel}', project: 'Peli', camera: 'A', day: 1, algos: ['xxh64', 'md5'], verify: true, mhl: true, ascmhl: true, rename: '{reel}_{counter:2}', report: { type: 'shooting_day', format: 'pdf' }, transcode: { preset: 'h264_dailies', height: 360, burnTimecode: true, burnName: true, dir: path.join(outDir, 'TRANSCODES') } });
    step('workflow', res.map((r) => r.job || r.error));
    step('post files', res[0].post);
    step('pdf size', (await fsp.stat(res[0].post.find((p) => p.endsWith('.pdf')))).size);
    await wait(6000); // ffprobe + miniaturas + transcodes en segundo plano
    const tc = await fsp.readdir(path.join(outDir, 'TRANSCODES', 'CARD_A001')).catch(() => []);
    step('transcodes', tc);
    // verifica la carpeta copiada contra el MHL escrito
    const mhl = res[0].post.find((p) => p.endsWith('.mhl'));
    const root = path.join(dests[1], 'Peli', 'Dia_01', 'A_CARD_A001');
    // UI
    await js(`document.querySelector('[data-view=jobs]').click()`); await wait(500); await shot('1-jobs');
    await js(`document.querySelector('[data-view=library]').click()`); await wait(800); await shot('2-library');
    await js(`document.querySelector('.clip').click()`); await wait(300);
    await js(`document.querySelectorAll('.clip')[1].dispatchEvent(new MouseEvent('click',{ctrlKey:true,bubbles:true}))`); await wait(300);
    step('selected', await js(`document.querySelectorAll('.clip.sel').length`));
    await js(`document.querySelector('.clip').click()`); await wait(200);
    await js(`document.querySelector('#inspector .btn').click()`); await wait(1500);
    step('video ready', await js(`(()=>{const v=document.querySelector('#player video');return v?{rs:v.readyState,dur:v.duration,err:v.error&&v.error.code}:null})()`));
    await shot('3-library-player');
    // --- reproductor WebGL: medir pixeles reales con CDL y color falso ---
    const avg = `(()=>{const p=state.player;const t=document.createElement('canvas');t.width=64;t.height=36;const c=t.getContext('2d');c.drawImage(p.canvas,0,0,64,36);const d=c.getImageData(0,0,64,36).data;let s=0;for(let i=0;i<d.length;i+=4)s+=d[i]+d[i+1]+d[i+2];return Math.round(s/(d.length/4*3));})()`;
    step('gl ok', await js(`!!state.player && state.player.glOk && !state.player.glError`));
    await js(`(()=>{state.player.video.pause();state.player.video.currentTime=1;})()`); await wait(700);
    const base = await js(avg); step('gl base luma', base);
    await js(`(()=>{state.player.setLook({cdl:{slope:[0.5,0.5,0.5],offset:[0,0,0],power:[1,1,1],sat:1}});})()`); await wait(300);
    const dark = await js(avg); step('gl slope 0.5', dark);
    await js(`(()=>{state.player.setLook({cdl:{slope:[1,1,1],offset:[0,0,0],power:[1,1,1],sat:0}});})()`); await wait(300);
    step('gl sat 0', await js(`(()=>{const p=state.player;const t=document.createElement('canvas');t.width=64;t.height=36;const c=t.getContext('2d');c.drawImage(p.canvas,0,0,64,36);const d=c.getImageData(0,0,64,36).data;let m=0;for(let i=0;i<d.length;i+=4)m=Math.max(m,Math.abs(d[i]-d[i+1]),Math.abs(d[i+1]-d[i+2]));return m;})()`));
    await js(`(()=>{state.player.setLook({cdl:{slope:[1,1,1],offset:[0,0,0],power:[1,1,1],sat:1}});state.player.fx.false=1;state.player.draw();})()`); await wait(300);
    step('gl false color', await js(avg)); await js(`(()=>{state.player.fx.false=0;state.player.scopesOn=true;state.player.scopes.style.display='grid';state.player.draw();})()`); await wait(400);
    step('scopes pintados', await js(`(()=>{const d=state.player.wf.getImageData(0,0,256,128).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i+1]>40)n++;return n;})()`));
    await js(`(()=>{state.player.setFrameLines('2.39');})()`); await wait(300); await shot('3b-player-fx');
    step('color panel', await js(`!!document.querySelector('#inspector details') && document.querySelectorAll('#inspector details input[type=range]').length`));
    await js(`document.querySelector('#inspector details summary').click()`); await wait(400); await shot('3c-color-panel');
    // --- vistas nuevas ---
    for (const v of ['exchange', 'archive', 'settings', 'reports', 'offload', 'verify']) {
      await js(`document.querySelector('[data-view=${v}]').click()`); await wait(v === 'compare' ? 2500 : 900); await shot('v-' + v);
      if (v === 'compare') step('compare diag', await js(`[...document.querySelectorAll('#main video')].map((v,i)=>{const c=[...document.querySelectorAll('#main canvas')].filter((k)=>k.width>512)[i];const t=document.createElement('canvas');t.width=32;t.height=18;const x=t.getContext('2d');x.drawImage(c,0,0,32,18);const d=x.getImageData(0,0,32,18).data;let s=0;for(let k=0;k<d.length;k+=4)s+=d[k]+d[k+1]+d[k+2];return {rs:v.readyState,err:v.error&&v.error.code,t:v.currentTime,w:c.width,h:c.height,luma:Math.round(s/(d.length/4*3))};})`));
    }
    step('ui errors', await js(`window.__errs||[]`));
    step('clips con rename', Object.values(lib.clips).map((c) => c.name));
    const hist = await ascmhl.verify(path.join(dests[0], 'Peli', 'Dia_01', 'A_CARD_A001'));
    step('ascmhl verify', { ok: hist.ok, gen: hist.generation, n: hist.results.length });

    // --- v0.3: proyecto con ficha, importar carpetas, tres vistas, edicion de celdas, transcode ---
    await js(`go('library')`); await wait(600);
    js(`newProject()`); await wait(700); await shot('n0-proyecto');
    await js(`(()=>{const d=document.querySelector('dialog.pform');const set=(i,v)=>{const el=d.querySelectorAll('input[type=text]')[i];el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(0,'Mi Peli');set(1,'Ana Directora');set(2,'Luis DoP');set(5,'Pol DIT');set(10,'Productora Test');set(11,'Barcelona');set(12,'© 2026 Productora Test');d.querySelector('button[type=submit]').click();})()`);
    await wait(1500);
    const pj = await js(`api.invoke('project:get')`); step('project', { id: pj.id, name: pj.info?.name, director: pj.info?.director, dit: pj.info?.dit, production: pj.info?.production });
    step('project list', await js(`api.invoke('project:list')`));
    const imp = path.join(outDir, 'IMPORT');
    const mk = (rel, extra) => { const f = path.join(imp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); return spawnSync(media.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=2', ...extra, f]).status; };
    step('mk clips', [mk('Dia 1/CamA/A001.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']), mk('Dia 1/CamA/A002.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']), mk('Dia 2/CamB/B001.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'])]);
    fs.mkdirSync(path.join(imp, 'Dia 1', 'Sonido'), { recursive: true });
    step('mk wav', spawnSync(media.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', path.join(imp, 'Dia 1', 'Sonido', 'toma1.wav')]).status);
    fs.writeFileSync(path.join(imp, 'notas.txt'), 'no es medio');
    const ir = await lib.importFolder(imp, {}, (c) => send('library:clip', c));
    step('import', { imported: ir.imported, skipped: ir.skipped, duplicates: ir.duplicates });
    step('reimport (sin duplicar)', (await lib.importFolder(imp, {}, () => {})).duplicates);
    await wait(4500);
    const bins = lib.listBins(); const nm = (id) => bins.find((b) => b.id === id)?.name;
    step('bins', bins.map((b) => `${b.parent ? nm(b.parent) + ' > ' : ''}${b.name} [${b.count} clips, ${b.own} propios]`));
    await js(`state.lib.bin=null; go('library'); render()`); await wait(900);
    step('tree rows', await js(`[...document.querySelectorAll('.tree .trow .tname')].map((e) => e.textContent)`));
    await js(`document.querySelectorAll('.segs .seg')[0].click()`); await wait(900);
    step('list cols/rows', await js(`({ cols: document.querySelectorAll('.ltable thead th').length, rows: document.querySelectorAll('.ltable tbody tr').length, headers: [...document.querySelectorAll('.ltable thead th')].map((t) => t.textContent.trim()).filter(Boolean) })`));
    await shot('n1-lista');
    // editar celda ISO: doble clic -> escribir -> Enter
    await js(`(()=>{const idx=[...document.querySelectorAll('.ltable thead th')].findIndex((t)=>t.textContent.includes('ISO (clip)'));const td=document.querySelector('.ltable tbody tr').children[idx];td.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));const i=td.querySelector('input');i.value='800';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`); await wait(900);
    step('ISO editado', Object.values(lib.clips).filter((c) => c.cam?.iso === '800').map((c) => c.name));
    // columna propia
    await js(`api.invoke('library:fields:add', 'Lente prestada')`); await js(`(()=>{const ids=JSON.parse(localStorage.getItem('cine.cols')||'null')||DEFAULT_COLS;localStorage.setItem('cine.cols',JSON.stringify([...ids,'custom:Lente prestada']));})()`); await js(`render()`); await wait(900);
    step('columna propia visible', await js(`[...document.querySelectorAll('.ltable thead th')].some((t)=>t.textContent.includes('Lente prestada'))`));
    await js(`document.querySelectorAll('.segs .seg')[2].click()`); await wait(900);
    step('folders cards', await js(`[...document.querySelectorAll('.fcard')].map((c)=>c.innerText.replace(/\\n+/g,' | '))`)); await shot('n2-carpetas');
    await js(`document.querySelectorAll('.fcard')[0].click()`); await wait(900);
    step('folders dentro', await js(`[...document.querySelectorAll('.fcard')].map((c)=>c.innerText.replace(/\\n+/g,' | '))`));
    await js(`document.querySelectorAll('.segs .seg')[1].click()`); await wait(900); await shot('n3-miniaturas');
    step('miniaturas', await js(`document.querySelectorAll('.clip').length`));
    // enlace con offload
    await js(`go('offload')`); await wait(900);
    step('offload enlazado', await js(`({ input: document.querySelector('#main input[disabled]')?.value, linea: document.querySelector('.projlink')?.innerText })`)); await shot('n4-offload-proyecto');
    // informe con ficha de proyecto
    const rep = await makeReport('clips', { project: 'x', format: 'html' }); const rh = fs.readFileSync(rep, 'utf8');
    step('informe ficha', { productora: rh.includes('Productora Test'), director: rh.includes('Ana Directora'), copyright: rh.includes('© 2026 Productora Test'), dit: rh.includes('Pol DIT') });
    // transcode OK + fallo controlado
    const vid = Object.values(lib.clips).find((c) => c.name === 'A001.mp4'); const wav = Object.values(lib.clips).find((c) => c.name === 'toma1.wav');
    const outs = await runTranscodes([vid.id, wav.id], { preset: 'prores_proxy', dir: path.join(outDir, 'TC2') }); await wait(2500);
    const reg = Object.values(lib.clips).find((c) => c.verified === 'transcode');
    step('transcode', { outputs: outs.length, registrado: reg && { name: reg.name, size: reg.size, codec: reg.meta?.codec, bin: lib.bins[reg.bin]?.name } });
    step('transcode resultados UI', await js(`state.tcResults && state.tcResults.map((r)=>({n:r.name,err:r.error||null,size:r.size||0}))`));
    step('sin parciales', fs.readdirSync(path.join(outDir, 'TC2', vid.reel || 'clips')).filter((n) => n.includes('.partial')));
    await js(`go('transcode')`); await wait(900); await shot('n5-transcode');

    // --- v0.4: camara + sonido + sueltos, varios informes, transcode con metadatos y texto, LUT en bloque, comparar en biblioteca ---
    const mkv = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); return spawnSync(media.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-shortest', '-timecode', '10:00:00:00', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]).status; };
    const camB = path.join(outDir, 'CARD_B'), snd = path.join(outDir, 'SND_1'), looseDir = path.join(outDir, 'SUELTOS');
    step('mk v0.4', [mkv(path.join(camB, 'B001.mp4')), mkv(path.join(looseDir, 'S1.mp4')), mkv(path.join(looseDir, 'S2.mp4'))]);
    fs.mkdirSync(snd, { recursive: true }); spawnSync(media.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=2', path.join(snd, 'AUDIO1.wav')]);
    const cap = []; const origSend = win.webContents.send.bind(win.webContents);
    const dst3 = path.join(outDir, 'BACKUP3'), tc3 = path.join(outDir, 'TC3');
    const res3 = await startWorkflow({
      sources: [{ path: camB, type: 'camera' }, { path: snd, type: 'sound' }, { path: path.join(looseDir, 'S1.mp4'), type: 'camera' }, { path: path.join(looseDir, 'S2.mp4'), type: 'camera' }],
      destinations: [dst3], template: '{project}/Dia_{day}/Camara_{camera}/{reel}', soundTemplate: '{project}/Dia_{day}/Sonido/{reel}', project: 'x', camera: 'A', day: 1, algos: ['xxh64'], verify: true, mhl: true,
      reports: ['volume', 'clips'], transcode: { preset: 'h264_dailies', height: 360, burnTimecode: true, burnName: true, text: { value: 'PRUEBA 123', pos: 'top-center', size: 26 }, keepTimecode: true, metaFields: ['project', 'director', 'scene', 'notes'], dir: tc3 },
    });
    step('workflow v0.4', res3.map((r) => (r.job ? { ok: r.job.ok, n: r.job.fileCount, folders: (r.folders || []).map((f) => f.label), informes: r.post.filter((p) => /\.(pdf|html)$/.test(p)).length } : r.error)));
    const treeOf = (d) => { const o = []; const w = (x, rel) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { if (e.isDirectory()) w(path.join(x, e.name), rel + e.name + '/'); else if (!/\.(mhl|pdf|html)$/.test(e.name)) o.push(rel + e.name); } }; w(d, ''); return o.sort(); };
    step('estructura BACKUP3', treeOf(dst3).filter((p) => !p.includes('_report')));
    await wait(7000);
    const tcOut = path.join(tc3, 'CARD_B', 'B001.mp4');
    const tci = fs.existsSync(tcOut) ? await media.probe(tcOut) : null;
    step('transcode v0.4', { existe: fs.existsSync(tcOut), height: tci?.height, tc: tci?.timecode, project: tci?.tags?.project, director: tci?.tags?.director, title: tci?.tags?.title });
    step('pasos en la UI', await js(`Object.values(state.progress).filter((j)=>j.steps).map((j)=>({reel:j.reel,type:j.type,loose:!!j.loose,steps:j.steps.map((s)=>s.id+':'+s.status).join(' '),folders:(j.folders||[]).length,ok:j.ok,speed:typeof j.speed}))`));
    await js(`go('offload')`); await wait(900);
    step('tarjetas de progreso', await js(`({ cards: document.querySelectorAll('.jobcard').length, steps: document.querySelectorAll('.jobcard .step').length, links: [...document.querySelectorAll('.folderlinks button')].map((b)=>b.textContent) })`));
    await js(`document.querySelector('#progress')?.scrollIntoView({block:'start'})`); await wait(500);
    await shot('p1-offload-progreso');
    step('offload UI', await js(`({ origenes: !!document.querySelector('.srcitem') , plantillas: document.querySelectorAll('#main .mono').length, informes: [...document.querySelectorAll('#main .chip')].map((c)=>c.textContent.trim()).filter((x)=>/volumen|clips|rodaje|miniaturas|contact/i.test(x)) })`));
    // previsualizacion del transcode
    const vclip = Object.values(lib.clips).find((c) => c.name === 'A001.mp4');
    const prevImg = await js(`api.invoke('transcode:preview', ${JSON.stringify(vclip.id)}, ${JSON.stringify({ preset: 'prores_proxy', res: '', height: 360, burnTimecode: true, burnName: true, textOn: true, text: { value: 'BORRADOR', pos: 'center', size: 18 }, applyLooks: true })}, 0.5)`);
    step('preview', { ok: /^data:image\/jpeg;base64,/.test(prevImg), kb: Math.round(prevImg.length / 1400) });
    // LUT en bloque + ajuste por clip
    const lutFile = path.join(outDir, 'media.cube'); fs.writeFileSync(lutFile, color.cdlToCube({ slope: [0.5, 0.5, 0.5], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 }, 17));
    const bin = lib.listBins().find((b) => b.name === 'Dia 1' && lib.listBins().find((x) => x.id === b.parent)?.name === 'IMPORT');
    const nLut = await js(`api.invoke('look:applyLut', ${JSON.stringify({ bin: bin.id })}, ${JSON.stringify(lutFile)})`);
    step('LUT a carpeta', { aplicada: nLut, clips: lib.listClips({ bin: bin.id }).filter((c) => c.kind === 'video').map((c) => !!c.look?.lut) });
    await js(`state.lib.bin=null; state.lib.mode='grid'; state.playerClipId=null; go('library'); render()`); await wait(900);
    await js(`(()=>{const c=state.lib.clips.find((x)=>x.name==='A001.mp4'); state.lib.sel=new Set([c.id]); drawClips($('#clipGrid')); drawInspector(); return play(c);})()`); await wait(2500);
    await js(`(()=>{const p=state.player;p.video.pause();p.video.currentTime=1;})()`); await wait(800);
    const lum = `(()=>{const p=state.player;const t=document.createElement('canvas');t.width=64;t.height=36;const c=t.getContext('2d');c.drawImage(p.canvas,0,0,64,36);const d=c.getImageData(0,0,64,36).data;let s=0;for(let i=0;i<d.length;i+=4)s+=d[i]+d[i+1]+d[i+2];return Math.round(s/(d.length/4*3));})()`;
    const withLut = await js(lum);
    await js(`(()=>{const p=state.player;const l=state.lib.clips.find((x)=>x.name==='A001.mp4').look;p.setLook({cdl:{slope:[0.8,0.8,0.8],offset:[0,0,0],power:[1,1,1],sat:1},lut:l.lut,order:'lut-first'});})()`); await wait(400);
    const withFine = await js(lum);
    step('color LUT + ajuste', { conLUT: withLut, conAjuste: withFine, esperadoLUT: '≈63 (127×0.5)', esperadoAjuste: '≈50 (63×0.8)' });
    // comparar dentro de la biblioteca
    await js(`state.lib.mode='compare'; state.lib.sel=new Set(); render()`); await wait(3500);
    step('comparar en biblioteca', await js(`({ grid: !!document.querySelector('.cmpgrid'), canvases: [...document.querySelectorAll('#clipGrid canvas')].filter((c)=>c.width>512).length, seleccion: state.lib.sel.size })`));
    await shot('p2-comparar-biblioteca');
    await js(`state.lib.mode='grid'; render()`); await wait(900);
    step('sin navegacion audio/comparar', await js(`[...document.querySelectorAll('#top [data-view]')].map((b)=>b.dataset.view)`));
    // informes: guardar varias configuraciones y generarlas
    const rp = await js(`api.invoke('reports:save', ${JSON.stringify({ name: 'Mi lista de clips', type: 'clips', format: 'html', scope: 'all', title: 'Lista para producción', columns: ['name', 'reel', 'iso', 'custom:Lente prestada'] })})`);
    const rp2 = await js(`api.invoke('reports:save', ${JSON.stringify({ name: 'Volumen oscuro', type: 'volume', format: 'html', dark: true, scope: 'all' })})`);
    const files = await js(`api.invoke('reports:run', ${JSON.stringify([rp.id, rp2.id])}, [])`);
    const rhtml = files.map((f) => fs.readFileSync(f, 'utf8'));
    step('informes múltiples', { generados: files.length, titulo: rhtml[0].includes('Lista para producción'), columnas: rhtml[0].includes('<th>ISO</th>') && rhtml[0].includes('<th>Lente prestada</th>'), oscuro: rhtml[1].includes('#14161a'), total: (await js(`api.invoke('reports:list')`)).length });
    await js(`go('reports')`); await wait(900); await shot('p3-informes');
    await js(`go('transcode')`); await wait(900);
    await js(`document.querySelector('.tcgrid .btn:not(.primary)').click()`); await wait(300);
    await js(`[...document.querySelectorAll('.tcgrid button')].find((b)=>b.textContent.includes('Actualizar previsualización'))?.click()`); await wait(3500);
    step('transcode UI', await js(`({ ajustes: document.querySelectorAll('.tcpanel').length, meta: document.querySelectorAll('.tcpanel details .chip').length, previsualizacion: !!document.querySelector('.prevbox img') })`));
    await shot('p4-transcode-ajustes');
    // progreso en vivo: una copia grande con varios hashes y dos destinos para poder ver fichero, paso, velocidad y tiempo restante
    const bigDir = path.join(outDir, "CARD_GRANDE"); fs.mkdirSync(bigDir, { recursive: true });
    { const chunk = require("node:crypto").randomBytes(8 * 1024 * 1024); const fd = fs.openSync(path.join(bigDir, "A009C001_GRANDE.mov"), "w"); for (let i = 0; i < 40; i++) fs.writeSync(fd, chunk); fs.closeSync(fd); } // 320 MB
    await js(`go("offload")`); await wait(600);
    const bigRun = startWorkflow({ sources: [{ path: bigDir, type: "camera" }], destinations: [path.join(outDir, "BIG1"), path.join(outDir, "BIG2")], template: "{project}/Dia_{day}/Camara_{camera}/{reel}", project: "x", camera: "A", day: 1, algos: ["md5", "sha1", "sha256", "xxh64"], verify: true, mhl: false, reports: ["volume"] });
    await wait(2200);
    await js(`document.querySelector("#progress")?.scrollIntoView({block:"start"})`); await wait(300);
    step("progreso en vivo", await js(`(()=>{const c=document.querySelector(".jobcard:last-child")||document.querySelector(".jobcard");return c?{texto:c.querySelector(".jdetail")?.innerText.split(String.fromCharCode(10)).join(" | "),pasos:[...c.querySelectorAll(".step")].map((s)=>s.className.replace("step ","")+":"+s.textContent.trim()),pct:c.querySelector(".bar i")?.style.transform}:null})()`));
    await shot("p5-progreso-en-vivo");
    await bigRun; await wait(600);
    step("progreso final", await js(`document.querySelector(".jobcard .jdetail")?.innerText.split(String.fromCharCode(10)).join(" | ")`));

    await js(`go('library')`); await wait(900);
    step('mhl exists', !!mhl && fs.existsSync(mhl));
    step('root exists', fs.existsSync(root));
    await fsp.writeFile(path.join(outDir, 'selftest.json'), JSON.stringify(log, null, 2));
    app.exit(0);
  } catch (e) { console.error('[selftest] FALLO', e); await fsp.writeFile(path.join(outDir, 'selftest.json'), JSON.stringify([...log, ['ERROR', String(e.stack)]], null, 2)); app.exit(1); }
}
if (process.env.CINESTACK_SELFTEST) {
  app.setPath('userData', path.join(process.env.CINESTACK_SELFTEST, 'userdata'));
  app.whenReady().then(() => win.webContents.once('did-finish-load', () => setTimeout(() => selftest(process.env.CINESTACK_SELFTEST), 500)));
}

module.exports = { startWorkflow };
