const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, safeStorage, powerSaveBlocker, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const { runOffload, verifyFolder } = require('./engine/offload');
const { compareFolders, archiveExisting } = require('./engine/sync');
const speed = require('./engine/speed');
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
const filters = require('./engine/filters');
const libops = require('./engine/libops');
const rawdec = require('./engine/rawdec');
const { LutLibrary } = require('./engine/lutlib');
const crypto = require('node:crypto');

let appState; // ajustes globales: proyecto actual, looks, workflows, Slack, S3
const projectFile = (name) => (name === 'Default' ? path.join(app.getPath('userData'), 'library.json') : path.join(app.getPath('userData'), 'projects', `${name.replace(/[^\w .-]/g, '_')}.json`));
function openProject(name) {
  lib = new Library(new Store(projectFile(name)), path.join(app.getPath('userData'), 'thumbs'));
  lib.raw = rawReg; // decodificadores RAW nativos (si hay)
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

let win, lib, settings, luts, rawReg;
const running = new Map(); // jobId -> AbortController
const send = (ch, payload) => win && !win.isDestroyed() && win.webContents.send(ch, payload);

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 1100, minHeight: 700, backgroundColor: '#0f1115',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }, // la interfaz no se frena aunque la ventana este oculta o tapada
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Cerrar la ventana NO detiene un traspaso: la copia sigue en segundo plano. Salir de la app (Cmd+Q) si pregunta, ver before-quit.
  win.on('close', (e) => {
    if (forceQuit || !isBusy() || process.env.CINESTACK_SELFTEST) return;
    e.preventDefault();
    if (process.platform === 'darwin') win.hide(); else win.minimize();
    if (!bgNoticeShown) { bgNoticeShown = true; notify('El traspaso sigue en segundo plano. Te aviso al terminar; para verlo, abre la app desde el Dock.'); }
  });
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
  { id: 'transfer', name: 'Velocidad del traspaso', type: 'transfer', format: 'pdf', dark: false, title: '', scope: 'job', columns: [] },
  { id: 'clips', name: 'Lista de clips', type: 'clips', format: 'pdf', dark: false, title: '', scope: 'job', columns: [] },
  { id: 'thumbnails', name: 'Miniaturas', type: 'thumbnails', format: 'pdf', dark: false, title: '', scope: 'job', columns: [] },
  { id: 'contact_print', name: 'Contact print', type: 'contact_print', format: 'pdf', dark: false, title: '', scope: 'job', columns: [] },
];
function reportPresets() {
  let l = appState.get('reportPresets');
  if (!Array.isArray(l) || !l.length) { l = DEFAULT_REPORTS.map((r) => ({ ...r })); appState.set('reportPresets', l); }
  else if (!l.some((p) => p.type === 'transfer')) { l = [...l, { ...DEFAULT_REPORTS.find((r) => r.id === 'transfer') }]; appState.set('reportPresets', l); } // v0.8: informe de velocidad para quien ya tenia informes guardados
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

/* ---- trabajo en segundo plano: no dormir mientras se copia, y avisar al cerrar ---- */
let workDepth = 0, psbId = null, forceQuit = false, quitAsking = false, bgNoticeShown = false, cancelRequested = false;
const isBusy = () => workDepth > 0 || running.size > 0;
function workBegin() {
  if (workDepth++ === 0 && psbId == null) { try { psbId = powerSaveBlocker.start('prevent-app-suspension'); } catch { /* */ } } // evita que el Mac se duerma o que App Nap frene la copia
}
function notify(body) {
  if (process.env.CINESTACK_SELFTEST || !Notification.isSupported()) return;
  try { new Notification({ title: 'CrisStack XS', body }).show(); } catch { /* */ }
}
function workEnd(doneMsg) {
  workDepth = Math.max(0, workDepth - 1);
  if (workDepth > 0) return;
  if (psbId != null) { try { if (powerSaveBlocker.isStarted(psbId)) powerSaveBlocker.stop(psbId); } catch { /* */ } psbId = null; }
  if (doneMsg && win && !win.isDestroyed() && (!win.isVisible() || win.isMinimized() || !win.isFocused())) notify(doneMsg);
}
const MAX_PARALLEL_JOBS = 3;

/* ---- workflow de offload ---- */
async function startWorkflow(cfg) {
  workBegin();
  let results = [];
  try { results = await runWorkflow(cfg); return results; } finally {
    const bad = results.filter((r) => r.error || (r.job && !r.job.ok)).length;
    workEnd(bad ? `Traspaso terminado con ${bad} ${bad === 1 ? 'problema' : 'problemas'}: abre la app para verlo` : 'Traspaso terminado y verificado');
  }
}

async function runWorkflow(cfg) {
  // cfg: { sources:[{path,type:'camera'|'sound'|'folder',dests?:[destino]}], destinations[], template, soundTemplate, project, camera, day, algos[], verify, mhl, ascmhl, rename, script,
  //        reports:[idDeConfiguracion], transcode:{preset,height,lut,burnTimecode,burnName,text,applyLooks,s3,dir,metaFields,keepTimecode}|null }
  // Cada origen puede ir a todos los destinos o solo a algunos (dests). El tipo «folder» copia la carpeta tal cual, sin plantilla.
  const results = [];
  const info = lib.getProject();
  if (info?.name) cfg.project = info.name; // el proyecto activo manda sobre lo que haya escrito el formulario
  cancelRequested = false;
  const allDests = cfg.destinations || [];

  // 1) normalizar origenes: cada carpeta es un job; los ficheros sueltos se agrupan por tipo y destinos
  const defs = []; const loose = new Map();
  for (const s of (cfg.sources || []).map((x) => (typeof x === 'string' ? { path: x, type: 'camera' } : x))) {
    const type = s.type === 'sound' ? 'sound' : s.type === 'folder' ? 'folder' : 'camera';
    const dests = Array.isArray(s.dests) ? s.dests.filter((d) => allDests.includes(d)) : allDests.slice();
    const st = await fsp.stat(s.path).catch(() => null);
    if (!st) { defs.push({ type, dests: [], error: `No existe: ${s.path}`, reel: path.basename(s.path) }); continue; }
    if (!dests.length) { defs.push({ type, dests: [], error: `«${path.basename(s.path)}» no tiene ningún destino marcado`, reel: path.basename(s.path) }); continue; }
    if (st.isFile()) {
      const k = `${type}|${dests.join('|')}`;
      if (!loose.has(k)) loose.set(k, { type, dests, paths: [] });
      loose.get(k).paths.push(s.path);
    } else defs.push({ type, dests, paths: [s.path], reel: path.basename(s.path.replace(/[\\/]+$/, '')) || s.path, source: s.path });
  }
  for (const g of loose.values()) {
    const dirs = new Set(g.paths.map((p) => path.dirname(p)));
    defs.push({ type: g.type, dests: g.dests, paths: g.paths, reel: dirs.size === 1 ? path.basename([...dirs][0]) || 'Sueltos' : 'Sueltos', source: [...dirs][0], loose: true });
  }

  const presets = reportPresets();
  const reportIds = (cfg.reports || (cfg.report ? [cfg.report.type] : [])).filter(Boolean);
  const picked = reportIds.map((id) => presets.find((p) => p.id === id)).filter(Boolean);

  const runDef = async (def, i) => {
    const reel = def.reel; const dests = def.dests; const asIs = def.type === 'folder';
    const key = `${Date.now()}-${i}`;
    const steps = [{ id: 'copy', label: cfg.verify === false ? 'Copiar' : 'Copiar y verificar' }];
    if (cfg.mhl) steps.push({ id: 'mhl', label: 'Lista MHL' });
    if (cfg.ascmhl) steps.push({ id: 'ascmhl', label: 'Sello ASC MHL' });
    if (!asIs) steps.push({ id: 'register', label: 'Registrar en la biblioteca' });
    if (picked.length && !asIs) steps.push({ id: 'reports', label: picked.length === 1 ? 'Informe' : `${picked.length} informes` });
    if (cfg.transcode && !asIs) steps.push({ id: 'transcode', label: 'Transcodificar' });
    send('job:start', { key, source: def.source || reel, reel, type: def.type, loose: !!def.loose, files: def.paths?.length, index: i, total: defs.length, steps, destinations: dests });
    const step = (id, status, extra = {}) => send('job:step', { key, step: id, status, ...extra });
    if (def.error) { send('job:done', { key, ok: false, error: def.error }); results.push({ error: def.error }); return; }

    const template = def.type === 'sound' ? (cfg.soundTemplate || '{project}/Dia_{day}/Sonido/{reel}') : (cfg.template || '{reel}');
    const folderName = asIs ? reel : expand(template, { project: cfg.project, day: cfg.day, camera: cfg.camera, reel, source: def.source, counter: i + 1, type: def.type });
    const ac = new AbortController();
    running.set(key, ac);
    try {
      step('copy', 'run');
      const job = await runOffload({
        sources: def.paths, destinations: dests, folderName, algos: cfg.algos, verify: cfg.verify, signal: ac.signal,
        rename: asIs ? undefined : tools.makeRenamer(cfg.rename, { reel, camera: cfg.camera, project: cfg.project }),
        onProgress: (p) => send('job:progress', { key, ...p }),
      });
      step('copy', job.ok ? 'done' : 'error', { failures: job.failures });
      job.reel = reel; job.project = cfg.project; job.day = cfg.day; job.camera = cfg.camera; job.operator = info?.dit || info?.dataManager || ''; job.volume = reel; job.sourceType = def.type;
      const post = []; const folders = [];
      for (let d = 0; d < dests.length; d++) folders.push({ label: dests.length > 1 ? `Destino ${d + 1}` : 'Carpeta copiada', path: path.join(dests[d], folderName) });
      if (cfg.mhl) { step('mhl', 'run'); for (const d of dests) post.push(await writeMhl(job, d, `${folderName.replace(/[\\/]/g, '_')}_${job.id}`)); step('mhl', 'done'); }
      if (cfg.ascmhl && job.ok) { step('ascmhl', 'run'); for (const d of dests) { const r = await ascmhl.seal(path.join(d, folderName), { algos: cfg.algos }); if (r.ok) post.push(r.file); } step('ascmhl', 'done'); }
      else if (cfg.ascmhl) step('ascmhl', 'skip');
      if (appState.get('slack')) tools.notifySlack(appState.get('slack'), job).catch((e) => send('transcode:error', { error: 'Slack: ' + e.message }));
      if (cfg.script && job.ok) { // paso post: script del usuario con variables de entorno
        const { spawn } = require('node:child_process');
        spawn(cfg.script, [], { shell: true, env: { ...process.env, CINESTACK_REEL: reel, CINESTACK_DEST: path.join(dests[0], folderName), CINESTACK_OK: '1' }, stdio: 'ignore', detached: true }).unref();
      }
      let clips = [];
      if (!asIs) {
        step('register', 'run');
        clips = (await lib.registerJob(job, { project: cfg.project, reel, camera: cfg.camera, day: cfg.day }, (c) => send('library:clip', c))).clips;
        step('register', 'done');
      }
      lib.addJob(job);
      if (picked.length && !asIs) {
        step('reports', 'run');
        const reportDir = path.join(dests[0], folderName + '_report');
        for (const p of picked) { try { post.push(await makeReportFromPreset(p, { scopeIds: clips.map((c) => c.id), jobIds: [job.id], outDir: reportDir, day: cfg.day })); } catch (e) { send('transcode:error', { error: `Informe «${p.name}»: ${e.message}` }); } }
        folders.push({ label: 'Informes', path: reportDir });
        step('reports', 'done');
      }
      if (cfg.transcode && !asIs && job.ok) {
        const tcDir = cfg.transcode.dir || path.join(app.getPath('documents'), 'Cinestack Transcodes');
        folders.push({ label: 'Transcodes', path: tcDir });
        step('transcode', 'run');
        await new Promise((r) => setTimeout(r, 300)); // esperamos al ffprobe para conocer la duracion
        runTranscodes(clips.filter((c) => c.kind === 'video').map((c) => c.id), cfg.transcode).then(() => step('transcode', 'done')).catch((e) => { step('transcode', 'error'); send('transcode:error', { error: e.message }); });
      } else if (cfg.transcode && !asIs) step('transcode', 'skip');
      send('job:done', { key, ok: job.ok, failures: job.failures, post, folders, files: job.fileCount, bytes: job.totalBytes, jobId: job.id, seconds: job.seconds, perDest: job.perDest });
      results.push({ job: { id: job.id, ok: job.ok, failures: job.failures, fileCount: job.fileCount }, post, folders });
    } catch (e) {
      send('job:done', { key, ok: false, error: e.message });
      results.push({ error: e.message });
      if (e.message === 'Cancelado') cancelRequested = true;
    } finally { running.delete(key); }
  };

  // 2) ejecutar: los trabajos que van a destinos distintos se hacen a la vez; los que comparten un destino, uno detras de otro
  const queue = defs.map((d, i) => ({ d, i }));
  const busyDests = new Set(); const active = new Set();
  while (queue.length || active.size) {
    if (cancelRequested) queue.length = 0;
    for (let q = 0; q < queue.length && active.size < MAX_PARALLEL_JOBS;) {
      const { d, i } = queue[q];
      if (d.dests.some((x) => busyDests.has(x))) { q++; continue; }
      queue.splice(q, 1);
      d.dests.forEach((x) => busyDests.add(x));
      const p = runDef(d, i).catch((e) => { results.push({ error: e.message }); }).finally(() => { d.dests.forEach((x) => busyDests.delete(x)); active.delete(p); });
      active.add(p);
    }
    if (active.size) await Promise.race(active);
  }
  return results;
}

/** Comparar y copiar lo nuevo entre dos carpetas (con checksum). */
async function syncCopy(a, b, rels, { algos, replace } = {}) {
  const { list, kept, dir: versionsDir } = await archiveExisting(b, rels || [], { replace }); // lo que se reemplaza se guarda antes en _CrisStack_versiones
  workBegin();
  const ac = new AbortController(); running.set('sync-copy', ac);
  try {
    const job = await runOffload({ sources: [a], destinations: [b], flat: true, include: new Set(list), algos: algos?.length ? algos : ['xxh64'], verify: true, signal: ac.signal, onProgress: (p) => send('sync:progress', { kind: 'copy', ...p }) });
    job.reel = path.basename(b.replace(/[\\/]+$/, '')) || b; job.volume = job.reel; job.sourceType = 'sync'; job.project = lib.getProject()?.name || '';
    lib.addJob(job);
    return { ok: job.ok, failures: job.failures, files: job.fileCount, bytes: job.totalBytes, seconds: job.seconds, id: job.id, skipped: (rels || []).length - list.length, kept, versionsDir };
  } finally { running.delete('sync-copy'); workEnd('Copia entre carpetas terminada'); }
}
async function syncCompare(a, b, o = {}) {
  workBegin();
  const ac = new AbortController(); running.set('sync-cmp', ac);
  try { return await compareFolders(a, b, { ...o, signal: ac.signal, onProgress: (p) => send('sync:progress', { kind: 'compare', ...p }) }); } finally { running.delete('sync-cmp'); workEnd(); }
}

async function runTranscodes(ids, t) {
  workBegin();
  try { return await runTranscodesInner(ids, t); } finally { workEnd(); }
}
async function runTranscodesInner(ids, t) {
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
    if (c.meta?.decodable === false && !mediaSource(c)) { item.error = NO_DEC(c); results.push(item); send('transcode:done', item); continue; }
    if (!mediaSource(c)) { item.error = `No se encuentra el fichero original (${c.path}). Conecta el disco o usa Archivo → Relink.`; results.push(item); send('transcode:done', item); continue; }
    if (!c.meta) { try { c.meta = await media.probe(mediaSource(c)); } catch (e) { item.error = 'No se pudo leer el clip: ' + e.message; results.push(item); send('transcode:done', item); continue; } }
    const out = path.join(outDir, c.reel || 'clips', path.basename(c.name, path.extname(c.name)) + preset.ext);
    const ac = new AbortController(); const key = `tc-${id}`; running.set(key, ac);
    send('transcode:start', { id, name: c.name });
    try {
      const lookLuts = t.applyLooks === false ? [] : await color.buildFfmpegLooks(c.look, path.join(app.getPath('temp'), 'cinestack-cubes'));
      if (t.lut) lookLuts.push(t.lut);
      const tr = c.transform || {};
      await media.transcode(mediaSource(c) || c.path, out, { ...t, luts: lookLuts, overlays: t.overlays ? filters.resolveOverlays(t.overlays, filters.clipContext(c, info)) : undefined, crop: tr.crop, desqueeze: tr.desqueeze, flip: tr.flip, rotate: tr.rotate, duration: c.meta.duration, fps: c.meta.fps, startTimecode: c.meta.timecode, signal: ac.signal, onProgress: (p) => send('transcode:progress', { id, p }),
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

/** Fichero real de un clip: el suyo, o una de sus copias si el original ya no esta (disco desconectado, movido, borrado). */
function clipFile(c) {
  if (!c) return null;
  if (c.path && fs.existsSync(c.path)) return c.path;
  return (c.copies || []).map((x) => x.path).find((p) => p && fs.existsSync(p)) || null;
}

const NO_DEC = (c) => c.meta?.rawNative
  ? `«${c.name}» (${c.meta.codecLabel}) se lee con el decodificador RAW nativo, pero la reproducción y la transcodificación en tiempo real todavía no usan ese decodificador. Para verlo con sus ajustes de cámara (ISO, balance de blancos…) usa el «Visor RAW» del inspector, fotograma a fotograma. Si vinculas un proxy se podrá reproducir, pero un proxy NO es la decodificación RAW.`
  : `«${c.name}» es ${c.meta?.codecLabel || 'un formato sin decodificador'}: la app no incluye el decodificador del fabricante (hace falta su SDK) y no puede reproducirlo ni transcodificarlo directamente.${c.meta?.rawReason ? ' Decodificador nativo: ' + c.meta.rawReason : ''} Vincula un proxy del clip (el que genera la cámara, o uno que saques con DaVinci Resolve o el software del fabricante) con «Vincular proxy…» y se usará para verlo, sacar miniaturas y transcodificar. Ojo: un proxy no es la decodificación RAW original.`;
function mediaSource(c) {
  if (!c) return null;
  if (c.meta?.decodable === false) return c.proxy && fs.existsSync(c.proxy) ? c.proxy : null;
  return clipFile(c);
}

const proxyCache = new Map();
async function playbackSource(id) {
  const c = lib.clips[id];
  if (!c) throw new Error('Clip no encontrado');
  const src = mediaSource(c);
  if (!src && c.meta?.decodable === false) throw new Error(NO_DEC(c));
  if (!src) throw new Error(`No se encuentra el fichero de «${c.name}» (${c.path}). Puede que el disco esté desconectado o que lo hayas movido o borrado. Conecta el disco, usa Archivo → Relink, o quita el clip de la biblioteca.`);
  const codec = src === clipFile(c) ? c.meta?.codec : (await media.probe(src).catch(() => ({}))).codec;
  const direct = ['h264', 'vp9', 'vp8', 'av1'].includes(codec) && /\.(mp4|mov|m4v|webm)$/i.test(src);
  if (direct) return { url: `cine://media/${id}`, proxy: false };
  const out = path.join(app.getPath('userData'), 'proxies', `${id}.mp4`);
  if (!fs.existsSync(out)) {
    if (!proxyCache.has(id)) proxyCache.set(id, media.transcode(src, out, { preset: 'h264_dailies', height: 540, duration: c.meta?.duration, onProgress: (p) => send('proxy:progress', { id, p }) }).finally(() => proxyCache.delete(id)));
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
  h('job:cancel', () => { cancelRequested = true; for (const ac of running.values()) ac.abort(); });
  h('work:busy', () => isBusy());
  h('jobs:speed', (id) => { const j = (lib.listJobs() || []).find((x) => x.id === id); return j ? { svg: speed.chartSvg(j, { dark: true }), stats: speed.stats(j), hasSamples: !!j.samples?.length } : null; });
  h('sync:compare', (a, b, o) => syncCompare(a, b, o));
  h('sync:copy', (a, b, rels, o) => syncCopy(a, b, rels, o));
  h('sync:cancel', () => { for (const k of ['sync-cmp', 'sync-copy']) running.get(k)?.abort(); });
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
  h('shell:openExternal', (u) => { if (!/^https:\/\//.test(String(u))) throw new Error('Solo se abren enlaces https'); return shell.openExternal(u); });
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
    const src = mediaSource(c); if (!src) throw new Error(c.meta?.decodable === false ? NO_DEC(c) : `No se encuentra el fichero original (${c.path}). Conecta el disco o usa Archivo → Relink.`);
    const meta = c.meta || await media.probe(src);
    const luts = t.applyLooks === false ? [] : await color.buildFfmpegLooks(c.look, path.join(app.getPath('temp'), 'cinestack-cubes'));
    if (t.lut) luts.push(t.lut);
    const tr = c.transform || {}; const fps = meta.fps || 25;
    const at = time ?? Math.min(1, (meta.duration || 2) / 2);
    const startTc = meta.timecode ? exportsM.framesToTc(exportsM.tcToFrames(meta.timecode, fps) + Math.round(at * fps), fps) : undefined; // -ss reinicia la cuenta: se suma el desplazamiento
    return media.previewFrame(src, { ...t, luts, overlays: t.overlays ? filters.resolveOverlays(t.overlays, filters.clipContext(c, lib.getProject())) : undefined, crop: tr.crop, desqueeze: tr.desqueeze, flip: tr.flip, rotate: tr.rotate, fps, startTimecode: startTc, time: at });
  });
  // informes: varias configuraciones guardadas, exportables e importables
  h('reports:list', () => reportPresets());
  h('reports:save', (p) => {
    const list = reportPresets(); const id = p.id || ('r' + Date.now().toString(36));
    const next = { id, name: String(p.name || 'Informe').slice(0, 80), type: p.type, format: p.format === 'html' ? 'html' : 'pdf', dark: !!p.dark, title: String(p.title || '').slice(0, 120), scope: ['job', 'all', 'selection'].includes(p.scope) ? p.scope : 'all', columns: Array.isArray(p.columns) ? p.columns : [] };
    if (!['volume', 'shooting_day', 'clips', 'thumbnails', 'contact_print', 'transfer'].includes(next.type)) throw new Error('Tipo de informe no válido');
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
      if (!['volume', 'shooting_day', 'clips', 'thumbnails', 'contact_print', 'transfer'].includes(p.type)) continue;
      const id = list.some((x) => x.id === p.id) ? 'r' + Date.now().toString(36) + n : (p.id || 'r' + Date.now().toString(36) + n);
      list.push({ id, name: String(p.name || 'Informe').slice(0, 80), type: p.type, format: p.format === 'html' ? 'html' : 'pdf', dark: !!p.dark, title: String(p.title || '').slice(0, 120), scope: ['job', 'all', 'selection'].includes(p.scope) ? p.scope : 'all', columns: Array.isArray(p.columns) ? p.columns : [] }); n++;
    }
    appState.set('reportPresets', list); return n;
  });
  h('transform:set', (ids, tr) => lib.bulkUpdate(ids, { transform: tr }));
  h('lut:read', async (p) => { const c = color.parseCube(await fsp.readFile(p, 'utf8')); return { size: c.size, data: c.data }; });
  // biblioteca de LUTs guardadas
  const cubesDir = () => path.join(app.getPath('temp'), 'cinestack-cubes');
  const dropCubes = (list) => Promise.all((list || []).filter((l) => l.startsWith(cubesDir())).map((l) => fsp.rm(l, { force: true })));
  h('luts:list', () => luts.list());
  h('luts:import', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'LUT (.cube)', extensions: ['cube'] }] });
    return r.canceled ? null : luts.addMany(r.filePaths);
  });
  h('luts:importFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : luts.addFolder(r.filePaths[0]);
  });
  h('luts:importPaths', (files) => luts.addMany(files));
  h('luts:remove', (id) => luts.remove(id));
  h('luts:rename', (id, name) => luts.rename(id, name));
  h('library:checkMissing', () => Object.values(lib.clips).filter((c) => c.path && !clipFile(c)).map((c) => ({ id: c.id, name: c.name, path: c.path })));
  // decodificadores RAW nativos: estado por fabricante, informacion del clip y visor fotograma a fotograma
  const rawOpen = new Map(); // clipId -> { rc, timer }
  const rawRelease = (id) => { const o = rawOpen.get(id); if (o) { clearTimeout(o.timer); o.rc.close(); rawOpen.delete(id); } };
  const rawClip = async (id) => {
    const c = lib.clips[id]; if (!c || c.kind !== 'video') throw new Error('Elige un clip de vídeo');
    let o = rawOpen.get(id);
    if (!o) { const rc = await rawReg.open(c.path, { format: c.meta?.rawFormat }); o = { rc }; rawOpen.set(id, o); }
    clearTimeout(o.timer); o.timer = setTimeout(() => rawRelease(id), 30000); o.timer.unref?.();
    return o.rc;
  };
  h('raw:status', async () => ({ dirs: rawReg.dirs, formats: await rawReg.status() }));
  h('raw:openFolder', async () => { const d = rawReg.dirs[0]; await fsp.mkdir(d, { recursive: true }); return shell.openPath(d); });
  h('raw:info', async (id) => (await rawClip(id)).info());
  h('raw:frame', async (id, index, settings) => {
    const rc = await rawClip(id); const info = rc.info();
    const fr = await rc.frame(Math.max(0, Math.min((info.frames || 1) - 1, Math.round(Number(index) || 0))), settings || {});
    const jpg = await rawdec.frameToJpeg(fr, { maxWidth: 960 });
    return { img: 'data:image/jpeg;base64,' + jpg.toString('base64'), width: fr.width, height: fr.height, bitDepth: fr.bitDepth, layout: fr.layout, gpuUsed: fr.gpuUsed, applied: fr.settingsApplied, notApplied: fr.notApplied, unsupported: fr.unsupported, info };
  });
  h('raw:release', (id) => rawRelease(id));
  // proxy vinculado a un RAW sin decodificador
  h('clip:linkProxy', async (id, file) => {
    if (file === undefined) { const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Vídeo proxy', extensions: ['mp4', 'mov', 'm4v', 'mxf', 'mkv'] }] }); if (r.canceled) return null; file = r.filePaths[0]; }
    return lib.linkProxy(id, file || null);
  });
  // carpetas y clips: renombrar, crear, mover y eliminar, con opcion de reflejarlo en el disco (Finder / Explorador)
  const trashFn = (p) => shell.trashItem(p);
  h('bin:info', (id) => { const d = libops.binDir(lib, id); return { dir: d }; });
  h('bin:rename', (id, name, disk) => libops.renameBin(lib, id, name, { disk: !!disk }));
  h('bin:create', async (parent, name, disk) => { const b = await libops.createBin(lib, parent || null, name, { disk: !!disk }); return { id: b.id, name: b.name, dir: b.dir || null }; });
  h('bin:remove', (id, trash) => libops.removeBin(lib, id, { trash: !!trash, trashFn }));
  h('clips:move', (ids, bin, disk) => libops.moveClips(lib, ids, bin, { disk: !!disk }));
  h('clip:rename', async (id, name, disk) => { const c = await libops.renameClip(lib, id, name, { disk: !!disk }); return { id: c.id, name: c.name, path: c.path }; });
  h('clips:remove', (ids, trash) => libops.removeClips(lib, ids, { trash: !!trash, trashFn }));
  h('library:remove', (ids) => { let n = 0; for (const id of ids || []) if (lib.clips[id]) { delete lib.clips[id]; n++; } lib.store.save(); return n; });

  // stills por escena: se guardan con el look del clip y quedan agrupados por escena
  const stillsRoot = () => path.join(app.getPath('documents'), 'CrisStack Stills');
  const seg = (s) => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 60);
  const stillThumbDir = () => path.join(app.getPath('userData'), 'stills-thumbs');
  h('stills:list', () => lib.listStills());
  h('stills:capture', async ({ clipId, t, format = 'jpeg', note = '', scene }) => {
    const c = lib.clips[clipId]; if (!c || c.kind !== 'video') throw new Error('Elige un clip de vídeo');
    const src = mediaSource(c); if (!src) throw new Error(c.meta?.decodable === false ? NO_DEC(c) : `No se encuentra el fichero de «${c.name}»`);
    const preset = media.STILL_PRESETS[format] ? format : 'jpeg';
    const fps = c.meta?.fps || 25; const at = Math.max(0, Number(t) || 0);
    const info = lib.getProject();
    const sceneName = String(scene ?? c.scene ?? '').trim();
    const tc = c.meta?.timecode ? exportsM.framesToTc(exportsM.tcToFrames(c.meta.timecode, fps) + Math.round(at * fps), fps) : '';
    const look = await color.buildFfmpegLooks(c.look, cubesDir()); const tr = c.transform || {};
    const dir = path.join(stillsRoot(), seg(info?.name || 'Proyecto'), sceneName ? `Escena_${seg(sceneName)}` : 'Sin_escena');
    const name = [sceneName && `Esc${seg(sceneName)}`, c.shot && `Pl${seg(c.shot)}`, c.take && `T${seg(c.take)}`, seg(path.basename(c.name, path.extname(c.name))), (tc || `${Math.round(at * 1000)}ms`).replace(/[:;]/g, '-')].filter(Boolean).join('_');
    let file = path.join(dir, name + media.STILL_PRESETS[preset].ext);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${name}_${i}${media.STILL_PRESETS[preset].ext}`);
    try { await media.exportStill(src, file, { time: at, preset, luts: look, crop: tr.crop, desqueeze: tr.desqueeze, flip: tr.flip, rotate: tr.rotate }); } finally { await dropCubes(look); }
    const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const thumb = path.join(stillThumbDir(), id + '.jpg'); await fsp.mkdir(stillThumbDir(), { recursive: true });
    await media.run(media.FFMPEG, ['-v', 'error', '-y', '-i', file, '-vf', 'scale=480:-2', '-frames:v', '1', '-q:v', '5', thumb]);
    return lib.addStill({ id, clipId, clipName: c.name, scene: sceneName, shot: c.shot || '', take: c.take || '', camera: c.camera || '', reel: c.reel || '', t: at, tc, note: String(note || '').slice(0, 500), file, thumb, format: preset, look: c.look?.lut ? path.basename(c.look.lut) : '', created: new Date().toISOString() });
  });
  h('stills:update', (id, patch) => lib.updateStill(id, patch));
  h('stills:remove', async (id, deleteFile) => {
    const s = lib.removeStill(id); if (!s) return false;
    await fsp.rm(s.thumb, { force: true }).catch(() => {});
    if (deleteFile) await fsp.rm(s.file, { force: true }).catch(() => {});
    return true;
  });
  h('stills:strip', async (clipId, count = 12) => {
    const c = lib.clips[clipId]; if (!c || c.kind !== 'video') throw new Error('Elige un clip de vídeo');
    const src = mediaSource(c); if (!src) throw new Error(c.meta?.decodable === false ? NO_DEC(c) : 'No se encuentra el fichero del clip');
    const look = await color.buildFfmpegLooks(c.look, cubesDir()); const tr = c.transform || {};
    try { return await media.filmstrip(src, { count, duration: c.meta?.duration || 1, luts: look, crop: tr.crop, desqueeze: tr.desqueeze, flip: tr.flip, rotate: tr.rotate }); } finally { await dropCubes(look); }
  });
  h('stills:report', async ({ scene, format = 'pdf', dark = false }) => {
    const all = lib.listStills(); const list = scene === undefined || scene === null || scene === '__all__' ? all : all.filter((s) => (s.scene || '') === scene);
    if (!list.length) throw new Error('No hay stills que incluir en el informe');
    const thumbs = {}; for (const s of list) { try { thumbs[s.id] = 'data:image/jpeg;base64,' + (await fsp.readFile(s.thumb)).toString('base64'); } catch { /* sin miniatura */ } }
    const info = lib.getProject();
    const html = report.buildStills(list, { projectInfo: info, dark, thumbs, title: scene && scene !== '__all__' ? `Stills · escena ${scene}` : 'Stills por escena' });
    const dir = path.join(stillsRoot(), seg(info?.name || 'Proyecto')); await fsp.mkdir(dir, { recursive: true });
    const base = path.join(dir, `Stills_${scene && scene !== '__all__' ? 'Esc' + seg(scene) : 'todas'}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
    if (format === 'html') { await fsp.writeFile(base + '.html', html); return base + '.html'; }
    return renderPdf(html, base + '.pdf');
  });

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
  h('thumb:set', async (id, t) => { // elige el momento que se ve como miniatura del clip
    const c = lib.clips[id]; const src = mediaSource(c); if (!src) throw new Error(c.meta?.decodable === false ? NO_DEC(c) : 'No se encuentra el fichero del clip');
    c.thumb = await media.thumbnail(src, path.join(app.getPath('userData'), 'thumbs', `${id}.jpg`), t); c.thumbAt = Number(t) || 0; c.thumbRev = (c.thumbRev || 0) + 1; lib.store.save(); return c.thumb;
  });
  h('still:export', async (id, t, preset) => {
    const c = lib.clips[id]; const tr = c.transform || {};
    const luts = await color.buildFfmpegLooks(c.look, path.join(app.getPath('temp'), 'cinestack-cubes'));
    const dir = path.join(app.getPath('documents'), 'Cinestack Stills'); const ext = media.STILL_PRESETS[preset || 'jpeg'].ext;
    return media.exportStill(mediaSource(c) || c.path, path.join(dir, `${path.basename(c.name, path.extname(c.name))}_${Math.round(t * 1000)}${ext}`), { time: t, preset, luts, crop: tr.crop, desqueeze: tr.desqueeze, flip: tr.flip, rotate: tr.rotate });
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

/* ---- miniaturas con el look del clip (LUT, CDL, recorte, giro): se generan una vez a partir de la miniatura y se guardan ---- */
const hasVisibleLook = (c) => !!(c.look?.lut || (c.look?.cdl && !color.isIdentity(c.look.cdl)) || (c.transform && (c.transform.crop || (c.transform.desqueeze && c.transform.desqueeze !== 1) || c.transform.flip || c.transform.rotate)));
let lookSlots = 0; const lookWaiters = [];
async function withLookSlot(fn) {
  while (lookSlots >= 3) await new Promise((r) => lookWaiters.push(r));
  lookSlots++;
  try { return await fn(); } finally { lookSlots--; lookWaiters.shift()?.(); }
}
const stillThumbs = (ud) => path.join(ud, 'stills-thumbs');
const lookInflight = new Map();
async function lookedThumb(c, base) {
  if (!hasVisibleLook(c) || !fs.existsSync(base)) return base;
  const lutStamp = c.look?.lut ? await fsp.stat(c.look.lut).then((s) => `${s.mtimeMs}:${s.size}`, () => 'missing') : '';
  const key = crypto.createHash('sha1').update(JSON.stringify([c.look, c.transform, lutStamp, (await fsp.stat(base)).mtimeMs])).digest('hex').slice(0, 10);
  const dir = path.join(path.dirname(base), 'looks'); const out = path.join(dir, `${c.id}_${key}.jpg`);
  if (fs.existsSync(out)) return out;
  if (!lookInflight.has(out)) {
    lookInflight.set(out, withLookSlot(async () => {
      const cubes = path.join(app.getPath('temp'), 'cinestack-cubes'); const list = await color.buildFfmpegLooks(c.look, cubes); const tr = c.transform || {};
      try {
        await media.lookThumb(base, out, { luts: list, crop: tr.crop, desqueeze: tr.desqueeze, flip: tr.flip, rotate: tr.rotate });
        for (const f of await fsp.readdir(dir).catch(() => [])) if (f.startsWith(c.id + '_') && f !== path.basename(out)) fsp.rm(path.join(dir, f), { force: true }).catch(() => {}); // versiones antiguas
      } finally { for (const l of list) if (l.startsWith(cubes)) fsp.rm(l, { force: true }).catch(() => {}); }
    }).catch(() => null).finally(() => lookInflight.delete(out)));
  }
  await lookInflight.get(out);
  return fs.existsSync(out) ? out : base;
}


app.whenReady().then(() => {
  const ud = app.getPath('userData');
  appState = new Store(path.join(ud, 'app-settings.json'), { project: 'Default', looks: [], workflows: [], slack: '', s3: null });
  rawReg = new rawdec.RawRegistry({ dirs: [path.join(ud, 'raw-helpers'), path.join(process.resourcesPath || '', 'raw')] });
  openProject(appState.get('project'));
  settings = lib.store;
  luts = new LutLibrary(path.join(ud, 'luts'), appState);

  protocol.handle('cine', async (req) => {
    const u = new URL(req.url);
    const id = u.pathname.replace(/^\//, '');
    let file;
    if (u.host === 'thumb') {
      const cid = id.replace(/[^\w.-]/g, '').replace(/\.jpg$/, '');
      const base = path.join(ud, 'thumbs', cid + '.jpg');
      file = u.searchParams.get('look') === '1' && lib.clips[cid] ? await lookedThumb(lib.clips[cid], base) : base;
    } else if (u.host === 'still') file = path.join(stillThumbs(ud), id.replace(/[^\w.-]/g, '').replace(/\.jpg$/, '') + '.jpg');
    else if (u.host === 'stillfull') file = lib.listStills().find((s) => s.id === id)?.file;
    else if (u.host === 'clip' || u.host === 'media') file = mediaSource(lib.clips[id]);
    else if (u.host === 'proxy') file = path.join(ud, 'proxies', id.replace(/[^\w.-]/g, '') + '.mp4');
    if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    const r = await net.fetch(pathToFileURL(file).toString(), { headers: req.headers });
    const headers = new Headers(r.headers); headers.set('Access-Control-Allow-Origin', '*'); // necesario para subir el video a una textura WebGL
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
  });

  registerIpc();
  registerIpc2();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
// Salir de la app con un traspaso en curso: se pregunta antes de interrumpirlo.
app.on('before-quit', (e) => {
  if (forceQuit || process.env.CINESTACK_SELFTEST || !isBusy()) return;
  e.preventDefault();
  if (quitAsking) return;
  quitAsking = true;
  if (win && !win.isDestroyed()) { win.show(); if (win.isMinimized()) win.restore(); }
  dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'warning', buttons: ['Seguir copiando', 'Finalizar el traspaso y salir'], defaultId: 0, cancelId: 0, title: 'Traspaso en curso',
    message: 'Hay un traspaso en curso. ¿Seguro que quieres finalizarlo?',
    detail: 'Si sales ahora, la copia se interrumpe: los ficheros que estaban a medias se borran de los destinos y habrá que repetirla. Puedes usar «Comparar y copiar lo nuevo» para continuar solo con lo que falte.',
  }).then(async (r) => {
    quitAsking = false;
    if (r.response !== 1) return;
    forceQuit = true; cancelRequested = true;
    for (const ac of running.values()) ac.abort();
    const t0 = Date.now();
    while (isBusy() && Date.now() - t0 < 8000) await new Promise((res) => setTimeout(res, 100)); // da tiempo a borrar las copias a medias
    app.quit();
  });
});

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
    await js(`[...document.querySelectorAll('#inspector .btn')].find((b)=>b.textContent==='Reproducir').click()`); await wait(1500);
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

    // ===================== v0.5 =====================
    await js(`go('library')`); await wait(900);
    const centerOf = (sel) => js(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]})()`);
    const mouse = async (type, x, y, extra = {}) => { win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, ...extra }); await wait(25); };
    const clickAt = async (sel) => { const [x, y] = await centerOf(sel); await mouse('mouseDown', x, y); await mouse('mouseUp', x, y); await wait(500); };
    const dragBy = async (x, y, dx, dy) => { await mouse('mouseDown', x, y); for (let i = 1; i <= 8; i++) await mouse('mouseMove', x + (dx * i) / 8, y + (dy * i) / 8, { modifiers: ['leftButtonDown'] }); await mouse('mouseUp', x + dx, y + dy); await wait(400); };

    // 1) botones QC y Ajustes: fuera de la zona de arrastre y con clic real
    step('v05 botones', await js(`(()=>{const out={};for(const sel of ['#qcBtn','[data-view=settings]']){const b=document.querySelector(sel);const r=b.getBoundingClientRect();const at=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);out[sel]={region:getComputedStyle(b).getPropertyValue('-webkit-app-region'),encima:at===b||b.contains(at),texto:b.textContent.trim()};}return out;})()`));
    await clickAt('#qcBtn'); step('v05 clic en Modo revision', await js(`document.body.classList.contains('qc')`)); await shot('q0-modo-revision'); await clickAt('#qcBtn');
    await clickAt('[data-view=settings]'); step('v05 clic en Ajustes', await js(`state.view`)); await shot('q0-ajustes'); await js(`go('library')`); await wait(700);

    // 2) reproducir un clip cuyo fichero ya no existe: mensaje claro y opcion de quitarlo
    const ghost = lib.newClip({ rel: 'FANTASMA.mov', abs: '/no/existe/FANTASMA.mov', kind: 'video', size: 1 }, lib.listBins()[0], { path: '/no/existe/FANTASMA.mov', meta: { codec: 'prores' } });
    lib.store.data.clips[ghost.id] = ghost; lib.store.save();
    step('v05 playback sin fichero', await js(`api.invoke('playback:source', ${JSON.stringify(ghost.id)}).then(()=>'SIN ERROR', (e)=>e.message)`));
    await js(`state.lib.bin=null; state.lib.mode='grid'; render()`); await wait(900);
    await js(`(()=>{const c=state.lib.clips.find((x)=>x.name==='FANTASMA.mov'); state.lib.sel=new Set([c.id]); drawInspector(); return play(c);})()`); await wait(900);
    step('v05 error en el reproductor', await js(`document.querySelector('#player')?.innerText.split(String.fromCharCode(10)).join(' | ')`));
    await js(`api.invoke('library:remove', [${JSON.stringify(ghost.id)}])`);

    // 3) LUTs guardadas (incluye una 1D)
    const oneD = path.join(outDir, 'curva1d.cube'); fs.writeFileSync(oneD, 'LUT_1D_SIZE 4\n0 0 0\n0.3 0.3 0.3\n0.6 0.6 0.6\n1 1 1\n');
    const lutImp = await js(`api.invoke('luts:importPaths', ${JSON.stringify([lutFile, oneD, path.join(outDir, 'no-existe.cube')])})`);
    step('v05 LUTs guardadas', { nuevas: lutImp.added.length, ya: lutImp.duplicates.length, errores: lutImp.errors.length, lista: (await js(`api.invoke('luts:list')`)).map((l) => `${l.name} ${l.size}${l.converted ? ' (de 1D)' : ''}`) });
    const a001 = Object.values(lib.clips).find((c) => c.name === 'A001.mp4');
    lib.updateClip(a001.id, { scene: '12', shot: 'B', take: '3' });
    await js(`state.lib.bin=null; state.lib.mode='grid'; render()`); await wait(900);
    await js(`(()=>{const c=state.lib.clips.find((x)=>x.name==='A001.mp4'); state.lib.sel=new Set([c.id]); drawClips($('#clipGrid')); drawInspector();})()`); await wait(900);
    await js(`document.querySelector('#inspector details summary')?.click()`); await wait(400);
    step('v05 selector de LUT', await js(`[...document.querySelectorAll('#inspector .lutfield option')].map((o)=>o.textContent)`));

    { const libLut = (await js(`api.invoke('luts:list')`)).find((l) => l.name === 'curva1d');
      await js(`(()=>{const s=document.querySelector('#inspector .lutfield select'); s.value=${JSON.stringify(libLut.file)}; s.dispatchEvent(new Event('change'));})()`); await wait(2200);
      step('v05 elegir una LUT guardada (1D convertida)', { lut: path.basename(lib.clips[a001.id].look?.lut || ''), esLaDeLaBiblioteca: lib.clips[a001.id].look?.lut === libLut.file, errores: await js('window.__errs') }); }
    // 4) miniaturas con el look
    const getBuf = async (u) => Buffer.from(await (await net.fetch(u)).arrayBuffer());
    const plainB = await getBuf(`cine://thumb/${a001.id}`), lookB = await getBuf(`cine://thumb/${a001.id}?look=1&k=x`);
    step('v05 miniatura con look', { sinLook: plainB.length, conLook: lookB.length, distintas: !plainB.equals(lookB), clipTieneLUT: !!lib.clips[a001.id].look?.lut, imgsConLook: await js(`[...document.querySelectorAll('.clip img')].filter((i)=>i.src.includes('look=1')).length`) });
    await shot('q4-miniaturas-con-look');

    // 5) paneles flotantes: separar, mover con el raton real, acoplar
    await js(`setFloat('color', true); setFloat('player', true)`); await wait(900);
    await js(`play(state.lib.clips.find((c)=>c.name==='A001.mp4'))`); await wait(2500);
    step('v05 paneles flotantes', await js(`[...document.querySelectorAll('.fpanel')].map((e)=>{const r=e.getBoundingClientRect();return {k:e.dataset.fp,x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),dentro:r.right<=innerWidth+1&&r.bottom<=innerHeight+1,canvas:!!e.querySelector('canvas'),sliders:e.querySelectorAll('input[type=range]').length}})`));
    await shot('q1-paneles-flotantes');
    { const [x, y] = await centerOf('.fpanel[data-fp=color] .fphead b'); await dragBy(x, y, -260, 90); }
    step('v05 panel movido con el raton', await js(`(()=>{const r=document.querySelector('.fpanel[data-fp=color]').getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),guardado:JSON.parse(localStorage.getItem('cine.float')).color}})()`));
    await shot('q1b-flotante-movido');
    await js(`setFloat('color', false); setFloat('player', false)`); await wait(600);
    step('v05 paneles acoplados', await js(`({ flotantes: document.querySelectorAll('.fpanel').length, enInspector: !!document.querySelector('#inspector .dockpanel') })`));

    // 6) textos en pantalla: varios, con datos del clip, arrastrables sobre la previsualizacion
    await js(`(()=>{const t=state.transcode;t.overlays=[newOverlay('tc'),newOverlay('name'),newOverlay('text',{text:'Esc {scene} · Toma {take} — BORRADOR',x:0.5,y:0.5,size:5,color:'yellow'})];t.res='540';go('transcode');})()`); await wait(1200);
    await js(`[...document.querySelectorAll('.tcgrid button')].find((b)=>b.textContent.includes('Actualizar previsualización'))?.click()`); await wait(3800);
    step('v05 recuadros de texto', await js(`({ recuadros: document.querySelectorAll('.prevbox .ovh').length, filas: document.querySelectorAll('.ovrow').length, imagen: !!document.querySelector('.prevbox img'), error: document.querySelector('.prevbox .bad')?.innerText })`));
    const before = await js(`document.querySelector('.prevbox img').src.length`);
    { const [x, y] = await js(`(()=>{const e=[...document.querySelectorAll('.prevbox .ovh')].pop();const r=e.getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]})()`); await dragBy(x, y, -160, -90); }
    await wait(3500);
    step('v05 texto arrastrado', await js(`({ textos: state.transcode.overlays.map((o)=>[o.kind,+o.x.toFixed(2),+o.y.toFixed(2)]), lista: [...document.querySelectorAll('.ovrow')].pop().querySelector('select').value, imagenNueva: document.querySelector('.prevbox img').src.length !== ${before} })`));
    await shot('q2-transcode-textos');
    // el texto con datos del clip llega al fichero final
    const tcOut5 = path.join(outDir, 'TC_V05');
    const tcRes = await runTranscodes([a001.id], { preset: 'h264_dailies', height: 360, dir: tcOut5, overlays: [{ kind: 'tc', x: 0.5, y: 0.93, size: 3.6 }, { kind: 'text', text: 'Esc {scene} Toma {take}', x: 0.2, y: 0.2, size: 5, color: 'yellow' }], metaFields: [] });
    step('v05 transcode con textos', { salidas: tcRes.map((f) => [path.basename(f), fs.statSync(f).size]) });

    // 7) espacio de stills por escena
    await js(`state.st=null; state.lib.sel=new Set([${JSON.stringify(a001.id)}]); go('stills')`); await wait(3500);
    step('v05 stills vista', await js(`({ reproductor: !!document.querySelector('#main canvas'), tira: document.querySelectorAll('.fsframe').length, escena: document.querySelector('#main select').value, titulo: document.querySelector('#main h1').innerText })`));
    for (const i of [2, 8]) { await js(`document.querySelectorAll('.fsframe')[${i}]?.click()`); await wait(800); await js(`[...document.querySelectorAll('#main button')].find((b)=>b.textContent.includes('Guardar still')).click()`); await wait(2600); }
    await js(`[...document.querySelectorAll('#main button')].find((b)=>b.textContent.includes('Usar como miniatura')).click()`); await wait(1500);
    const sl = await js(`api.invoke('stills:list')`);
    step('v05 stills guardados', { galeria: await js(`document.querySelectorAll('.stcard').length`), lista: sl.map((s) => [s.scene, s.shot, s.take, s.tc, fs.existsSync(s.file), fs.existsSync(s.thumb), path.basename(s.file)]), miniaturaEn: lib.clips[a001.id].thumbAt });
    await shot('q3-stills');
    const pdf = await js(`api.invoke('stills:report', { scene: '12', format: 'pdf' })`); step('v05 informe de stills', { pdf: path.basename(pdf), kb: Math.round(fs.statSync(pdf).size / 1024) });
    // 8) el atajo del reproductor de la biblioteca guarda en la escena
    await js(`go('library')`); await wait(900);

    // ===================== v0.6 =====================
    await js(`state.lib.bin=null; state.lib.mode='grid'; state.playerClipId=null; go('library')`); await wait(1000);
    // 1) recorte: sliders coherentes y boton de restablecer
    await js(`(()=>{const c=state.lib.clips.find((x)=>x.name==='A001.mp4'); state.lib.sel=new Set([c.id]); drawClips($('#clipGrid')); drawInspector();})()`); await wait(700);
    await js(`document.querySelector('#inspector details summary')?.click()`); await wait(300);
    const setRange = (label, v) => js(`(()=>{const l=[...document.querySelectorAll('#inspector label.f')].find((x)=>x.firstChild.textContent==='${label}');const i=l.querySelector('input');i.value=${v};i.dispatchEvent(new Event('input',{bubbles:true}));return [i.min,i.max,i.value]})()`);
    step('v06 recorte ancho', await setRange('Ancho', 0.4)); step('v06 recorte X (max limitado por el ancho)', await setRange('Recorte X', 0.9)); await wait(1200);
    step('v06 recorte guardado', lib.clips[a001.id].transform?.crop);
    await js(`[...document.querySelectorAll('#inspector button')].find((b)=>b.textContent==='Restablecer recorte').click()`); await wait(1200);
    step('v06 recorte restablecido', { crop: lib.clips[a001.id].transform?.crop ?? null, sliders: await js(`[...document.querySelectorAll('#inspector label.f input[type=range]')].slice(-4).map((i)=>[i.min,i.max,i.value].join('/'))`) });

    // 2) RAW sin decodificador: .braw con proxy al lado y otro sin proxy
    const rawDir = path.join(outDir, 'RAW_A001.RDC'); fs.mkdirSync(path.join(rawDir, 'Sub'), { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'A001_C010.braw'), Buffer.alloc(8192, 3)); fs.writeFileSync(path.join(rawDir, 'A001_C011.braw'), Buffer.alloc(8192, 5));
    spawnSync(media.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(rawDir, 'Sub', 'A001_C010_proxy.mp4')]);
    await lib.importFolder(rawDir, {}, (c) => send('library:clip', c)); await wait(4500);
    const rawA = Object.values(lib.clips).find((c) => c.name === 'A001_C010.braw'), rawB = Object.values(lib.clips).find((c) => c.name === 'A001_C011.braw');
    step('v06 RAW registrados', { conProxy: [rawA.meta?.codec, rawA.meta?.decodable, !!rawA.proxy, !!rawA.thumb, rawA.meta?.width], sinProxy: [rawB.meta?.codec, rawB.meta?.decodable, !!rawB.proxy, !!rawB.thumb] });
    step('v06 reproducir RAW con proxy', await js(`api.invoke('playback:source', ${JSON.stringify(rawA.id)}).then((s)=>s.url.split('/').slice(0,3).join('/'), (e)=>e.message)`));
    step('v06 reproducir RAW sin proxy', (await js(`api.invoke('playback:source', ${JSON.stringify(rawB.id)}).then(()=>'SIN ERROR', (e)=>e.message)`)).slice(0, 160));
    await js(`state.lib.bin=null; state.lib.mode='grid'; render()`); await wait(1200);
    await js(`(()=>{const c=state.lib.clips.find((x)=>x.name==='A001_C011.braw'); state.lib.sel=new Set([c.id]); drawClips($('#clipGrid')); drawInspector(); return play(c);})()`); await wait(900);
    step('v06 mensaje y boton de proxy', await js(`({ texto: document.querySelector('#player')?.innerText.slice(0,80), boton: [...document.querySelectorAll('#player button')].map((b)=>b.textContent) })`));
    await shot('r1-raw-sin-decodificador');
    const lk = await js(`api.invoke('clip:linkProxy', ${JSON.stringify(rawB.id)}, ${JSON.stringify(path.join(rawDir, 'Sub', 'A001_C010_proxy.mp4'))}).then((c)=>[!!c.proxy,c.meta.width])`);
    step('v06 proxy vinculado a mano', lk);
    const tr6 = await runTranscodes([rawA.id], { preset: 'h264_dailies', height: 180, dir: path.join(outDir, 'TC_RAW') });
    step('v06 transcode de RAW via proxy', tr6.map((f) => [path.basename(f), fs.statSync(f).size]));

    // 3) carpetas y clips en disco: menu, renombrar, nueva subcarpeta, arrastrar y soltar, edicion en bloque, quitar
    const fo = path.join(outDir, 'ESTRUCTURA', 'Rodaje'); for (const [d, n] of [['Dia1/CamA', 'X001.mp4'], ['Dia1/CamA', 'X002.mp4'], ['Dia1/CamB', 'Y001.mp4']]) { fs.mkdirSync(path.join(fo, d), { recursive: true }); spawnSync(media.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(fo, d, n)]); }
    await lib.importFolder(fo, {}, (c) => send('library:clip', c)); await wait(3500);
    await js(`state.lib.bin=null; state.lib.mode='list'; render()`); await wait(1200);
    const binOf = (n) => Object.values(lib.bins).find((b) => b.name === n && lib.bins[b.parent]?.name !== 'x');
    // clic derecho REAL y boton ⋯ REAL sobre una carpeta del arbol (el menu debe verse y ser pulsable)
    { const rowSel = '.tree .trow:nth-of-type(8)';
      const rc = await js(`(()=>{const r=[...document.querySelectorAll('.tree .trow')].find((b)=>b.querySelector('.tname')?.textContent==='Dia1');const q=r.getBoundingClientRect();return [Math.round(q.left+60),Math.round(q.top+q.height/2),Math.round(q.right-14)]})()`);
      await mouse('mouseMove', rc[0], rc[1], {}); await mouse('mouseDown', rc[0], rc[1], { button: 'right' }); await mouse('mouseUp', rc[0], rc[1], { button: 'right' }); await wait(500);
      step('v06b clic derecho real', await js(`(()=>{const m=document.querySelector('.ctxmenu');if(!m)return null;const q=m.getBoundingClientRect();const at=document.elementFromPoint(q.left+q.width/2,q.top+12);return {rect:[q.left,q.top,q.width,q.height].map(Math.round),win:[innerWidth,innerHeight],pos:getComputedStyle(m).position,items:[...m.querySelectorAll('button')].map((b)=>b.textContent),visible:q.width>0&&q.height>0&&q.right<=innerWidth&&q.bottom<=innerHeight,pulsable:!!at&&m.contains(at)}})()`));
      await shot('r2b-menu-clic-derecho-real');
      await mouse('mouseDown', 20, 600); await mouse('mouseUp', 20, 600); await wait(300);
      step('v06b menu se cierra al pulsar fuera', await js(`!document.querySelector('.ctxmenu')`));
      const dots = await js(`(()=>{const r=[...document.querySelectorAll('.tree .trow')].find((b)=>b.querySelector('.tname')?.textContent==='Dia1');const d=r.querySelector('.rowmenu').getBoundingClientRect();return [Math.round(d.left+d.width/2),Math.round(d.top+d.height/2)]})()`);
      await mouse('mouseMove', dots[0], dots[1], {}); await mouse('mouseDown', dots[0], dots[1]); await mouse('mouseUp', dots[0], dots[1]); await wait(600);
      step('v06b boton ⋯ real', await js(`document.querySelector('dialog[open]')?.innerText.split(String.fromCharCode(10)).slice(0,3).join(' | ') || null`));
      await shot('r2c-dialogo-carpeta');
      await js(`document.querySelector('dialog[open]')?.querySelector('button:last-child')?.click(); [...document.querySelectorAll('dialog[open] button')].find((b)=>b.textContent==='Cerrar')?.click()`); await wait(300);
      step('v06b boton Carpeta… de la barra', await js(`(()=>{state.lib.bin=state.lib.bins.find((b)=>b.name==='Dia1').id;render();return true})()`)); await wait(1200);
      step('v06b barra', await js(`[...document.querySelectorAll('.center button')].map((b)=>b.textContent).filter((t)=>/Carpeta/.test(t))`));
      await js(`state.lib.bin=null; render()`); await wait(1000); }
    await js(`(()=>{const r=[...document.querySelectorAll('.tree .trow')].find((b)=>b.querySelector('.tname')?.textContent==='Dia1'); r.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:200,clientY:300}));})()`); await wait(400);
    step('v06 menu de carpeta', await js(`[...document.querySelectorAll('.ctxmenu button')].map((b)=>b.textContent)`)); await shot('r2-menu-carpeta');
    await js(`[...document.querySelectorAll('.ctxmenu button')].find((b)=>b.textContent.startsWith('Renombrar')).click()`); await wait(600);
    await js(`(()=>{const d=document.querySelector('dialog[open]');const i=d.querySelector('input[type=text]');i.value='Jornada_1';[...d.querySelectorAll('button')].find((b)=>b.textContent==='Renombrar').click();})()`); await wait(1500);
    step('v06 carpeta renombrada en disco', { dia1: fs.existsSync(path.join(fo, 'Dia1')), dia_01: fs.existsSync(path.join(fo, 'Jornada_1', 'CamA', 'X001.mp4')), clip: Object.values(lib.clips).find((c) => c.name === 'X001.mp4').path.replace(outDir, '') });
    await js(`(()=>{const r=[...document.querySelectorAll('.tree .trow')].find((b)=>b.querySelector('.tname')?.textContent==='Jornada_1');r.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:200,clientY:300}));})()`); await wait(300);
    await js(`[...document.querySelectorAll('.ctxmenu button')].find((b)=>b.textContent.startsWith('Nueva subcarpeta')).click()`); await wait(600);
    await js(`(()=>{const d=document.querySelector('dialog[open]');d.querySelector('input[type=text]').value='Descartes';[...d.querySelectorAll('button')].find((b)=>b.textContent==='Crear').click();})()`); await wait(1500);
    step('v06 subcarpeta creada', [fs.existsSync(path.join(fo, 'Jornada_1', 'Descartes')), await js(`document.querySelector('dialog[open] .bad')?.innerText || null`)]);
    // arrastrar dos clips de la lista a la carpeta Descartes
    await js(`state.lib.bin=null; render()`); await wait(1200);
    await js(`(()=>{const dt=new DataTransfer();state.lib.sel=new Set(state.lib.clips.filter((c)=>/^(X002|Y001)/.test(c.name)).map((c)=>c.id));const idx=state.lib.clips.findIndex((x)=>x.name==='X002.mp4');const rows=document.querySelectorAll('#clipGrid tbody tr');rows[idx].dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));const t=[...document.querySelectorAll('.tree .trow')].find((b)=>b.querySelector('.tname')?.textContent==='Descartes');t.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));t.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));})()`); await wait(900);
    step('v06 dialogo de mover', await js(`document.querySelector('dialog[open]')?.innerText.split(String.fromCharCode(10)).slice(0,5).join(' | ')`)); await shot('r3-mover-clips');
    await js(`[...document.querySelector('dialog[open]').querySelectorAll('button')].find((b)=>b.textContent==='Mover').click()`); await wait(1800);
    step('v06 clips movidos en disco', { descartes: fs.readdirSync(path.join(fo, 'Jornada_1', 'Descartes')), camA: fs.readdirSync(path.join(fo, 'Jornada_1', 'CamA')) });
    // edicion en bloque de los clips seleccionados
    await js(`state.lib.bin=null; render()`); await wait(1000);
    await js(`(()=>{state.lib.sel=new Set(state.lib.clips.filter((c)=>/^(X001|X002|Y001)/.test(c.name)).map((c)=>c.id));drawClips($('#clipGrid'));drawInspector();bulkEditUI([...state.lib.sel]);})()`); await wait(700);
    await js(`(()=>{const d=document.querySelector('dialog[open]');const ins=d.querySelectorAll('input[type=text]');const set=(i,v)=>{ins[i].value=v;ins[i].dispatchEvent(new Event('input',{bubbles:true}));};set(0,'12');set(1,'C');set(3,'A-CAM');set(4,'R07');})()`); await shot('r4-edicion-en-bloque');
    await js(`[...document.querySelector('dialog[open]').querySelectorAll('button')].find((b)=>b.textContent==='Aplicar a todos').click()`); await wait(1200);
    step('v06 edicion en bloque', ['X001.mp4', 'X002.mp4', 'Y001.mp4'].map((n) => { const c = Object.values(lib.clips).find((x) => x.name === n); return [n, c.scene, c.shot, c.take, c.camera, c.reel].join('/'); }));
    // renombrar un fichero y quitarlo a la papelera de pruebas no se prueba aqui (shell.trashItem tocaria la papelera real): se cubre en los tests del motor
    const rn6 = await js(`api.invoke('clip:rename', ${JSON.stringify(Object.values(lib.clips).find((c) => c.name === 'Y001.mp4').id)}, 'PLANO_B', true)`);
    step('v06 clip renombrado', { nombre: rn6.name, enDisco: fs.existsSync(rn6.path) });
    await js(`state.lib.sel=new Set(); state.lib.mode='grid'; render()`); await wait(1200);
    await shot('r5-biblioteca-v06');
    // ===================== v0.7: decodificadores RAW =====================
    step('v07 RAW sin decodificador', { formato: rawA.meta?.rawFormat, deteccion: rawA.meta?.rawDetect, nativo: !!rawA.meta?.rawNative, estado: rawA.meta?.rawState });
    await js(`state.lib.bin=null; state.lib.mode='grid'; render()`); await wait(1000);
    await js(`(()=>{const c=state.lib.clips.find((x)=>x.name==='A001_C011.braw'); state.lib.sel=new Set([c.id]); drawClips($('#clipGrid')); drawInspector();})()`); await wait(700);
    step('v07 filas de informacion RAW', await js(`[...document.querySelectorAll('#inspector table tr')].map((r)=>r.innerText.replace(/\\s+/g,' ')).filter((t)=>/RAW|Decodificador/.test(t))`));
    await js(`go('settings')`); await wait(1500);
    step('v07 ajustes: decodificadores RAW', await js(`[...document.querySelectorAll('.rawrow > summary')].map((s)=>s.innerText.replace(/\\s+/g,' '))`));
    await js(`document.querySelectorAll('.rawrow')[0].open=true; document.querySelectorAll('.rawrow')[1].open=true; document.querySelector('.rawrow').scrollIntoView({block:'start'})`); await wait(500); await shot('s1-ajustes-raw');
    // con un decodificador (de prueba) instalado
    process.env.ELECTRON_RUN_AS_NODE = '1';
    rawReg.overrides = { braw: { cmd: process.execPath, args: [path.join(__dirname, '..', '..', 'test', 'fixtures', 'fake-raw-helper.js')] } }; rawReg.hellos.clear();
    const nat = path.join(outDir, 'RAW_NATIVO'); fs.mkdirSync(nat, { recursive: true }); fs.writeFileSync(path.join(nat, 'B001_C001.braw'), Buffer.alloc(4096, 4));
    await lib.importFolder(nat, {}, (c) => send('library:clip', c)); await wait(3500);
    const rn = Object.values(lib.clips).find((c) => c.name === 'B001_C001.braw');
    step('v07 RAW con decodificador', { nativo: rn.meta.rawNative, res: [rn.meta.width, rn.meta.height], bits: rn.meta.bitDepth, camara: rn.meta.camera?.model, sensor: rn.meta.rawSensor?.bayer, thumb: !!rn.thumb && fs.existsSync(rn.thumb) });
    step('v07 reproducir RAW nativo', (await js(`api.invoke('playback:source', ${JSON.stringify(rn.id)}).then(()=>'SIN ERROR', (e)=>e.message)`)).slice(0, 190));
    await js(`go('library'); state.lib.bin=null; state.lib.mode='grid'; render()`); await wait(1500);
    await js(`(()=>{const c=state.lib.clips.find((x)=>x.name==='B001_C001.braw'); state.lib.sel=new Set([c.id]); drawClips($('#clipGrid')); drawInspector();})()`); await wait(800);
    await js(`document.querySelector('.rawviewer summary').click()`); await wait(2500);
    const v1 = await js(`document.querySelector('.rawviewer img')?.src.length`);
    step('v07 visor RAW', await js(`({ controles: [...document.querySelectorAll('.rawviewer label')].map((l)=>l.firstChild.textContent.trim()), img: !!document.querySelector('.rawviewer img'), mensaje: document.querySelector('.rawviewer .mut:last-child')?.previousSibling?.innerText || null })`));
    await js(`(()=>{const i=[...document.querySelectorAll('.rawviewer label')].find((l)=>l.firstChild.textContent.trim()==='ISO').querySelector('input');i.value='6400';i.dispatchEvent(new Event('input',{bubbles:true}));const q=[...document.querySelectorAll('.rawviewer label')].find((l)=>l.firstChild.textContent.trim()==='Calidad de debayer').querySelector('select');q.value='half';q.dispatchEvent(new Event('change',{bubbles:true}));})()`); await wait(2200);
    step('v07 visor: ajustes enviados', await js(`({ cambioLaImagen: document.querySelector('.rawviewer img').src.length !== ${v1}, avisos: [...document.querySelectorAll('.rawviewer .warn')].map((w)=>w.innerText) })`));
    await js(`document.querySelector('.rawviewer').scrollIntoView({block:'start'})`); await wait(400); await shot('s2-visor-raw');
    rawReg.overrides = {}; rawReg.hellos.clear(); delete process.env.ELECTRON_RUN_AS_NODE;

    // ===================== v0.8: destinos por origen, carpeta tal cual, trabajos en paralelo, comparar carpetas, velocidad =====================
    const v8 = path.join(outDir, 'V08'); await fsp.mkdir(v8, { recursive: true });
    const mkf = async (p, n) => { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, crypto.randomBytes(n)); };
    const sA = path.join(v8, 'TARJETA_A'), sB = path.join(v8, 'CARPETA_B'), sC = path.join(v8, 'SONIDO_C');
    await mkf(path.join(sA, 'A001.bin'), 6 * 1024 * 1024); await mkf(path.join(sB, 'docs', 'nota.txt'), 2000); await mkf(path.join(sC, 'S001.wav'), 3 * 1024 * 1024);
    const D1 = path.join(v8, 'DISCO1'), D2 = path.join(v8, 'DISCO2');
    let maxRunning = 0; const poll = setInterval(() => { maxRunning = Math.max(maxRunning, running.size); }, 15);
    const res8 = await startWorkflow({ sources: [{ path: sA, type: 'camera', dests: [D1] }, { path: sB, type: 'folder' }, { path: sC, type: 'sound', dests: [D2] }], destinations: [D1, D2], template: '{reel}', soundTemplate: '{reel}', project: 'V8', camera: 'A', day: 1, algos: ['xxh64'], verify: true, mhl: false });
    clearInterval(poll);
    step('v08 destinos por origen', {
      A_en_D1: fs.existsSync(path.join(D1, 'TARJETA_A', 'A001.bin')), A_en_D2: fs.existsSync(path.join(D2, 'TARJETA_A')),
      tal_cual_D1: fs.existsSync(path.join(D1, 'CARPETA_B', 'docs', 'nota.txt')), tal_cual_D2: fs.existsSync(path.join(D2, 'CARPETA_B', 'docs', 'nota.txt')),
      C_en_D2: fs.existsSync(path.join(D2, 'SONIDO_C', 'S001.wav')), C_en_D1: fs.existsSync(path.join(D1, 'SONIDO_C')),
      trabajos_ok: res8.length === 3 && res8.every((r) => r.job?.ok), enParalelo: maxRunning, tiposEnHistorial: lib.listJobs().slice(0, 3).map((j) => j.sourceType).sort(), muestras: lib.listJobs()[0].samples?.length >= 1 });
    await js(`state.offload.mode='offload'; state.offload.sources=[{path:${JSON.stringify(sA)},type:'camera'},{path:${JSON.stringify(sB)},type:'folder',dests:[${JSON.stringify(D1)}]}]; state.offload.destinations=[${JSON.stringify(D1)},${JSON.stringify(D2)}]; go('offload')`); await wait(1300);
    step('v08 UI offload', await js(`({ modos: [...document.querySelectorAll('.segs .seg')].map((b)=>b.innerText), tipos: [...document.querySelectorAll('.srcitem select')].map((s)=>s.value), chips: [...document.querySelectorAll('.srcdests')].map((d)=>[...d.querySelectorAll('input')].map((i)=>i.checked)), opcionesTipo: [...document.querySelector('.srcitem select').options].map((o)=>o.text) })`));
    await shot('t1-offload-destinos');
    const sa = path.join(v8, 'SYNC_A'), sb = path.join(v8, 'SYNC_B');
    await mkf(path.join(sa, 'uno.bin'), 100000); await mkf(path.join(sa, 'dir', 'dos.bin'), 200000); await mkf(path.join(sa, 'ya.bin'), 1000); await fsp.mkdir(sb, { recursive: true }); await fsp.copyFile(path.join(sa, 'ya.bin'), path.join(sb, 'ya.bin'));
    await js(`state.offload.mode='sync'; Object.assign(syncState(), {a:${JSON.stringify(sa)}, b:${JSON.stringify(sb)}, res:null, msg:''}); render()`); await wait(1000);
    await js(`[...document.querySelectorAll('.syncbox .btn.primary')].find((b)=>/Comparar/.test(b.innerText)).click()`); await wait(1800);
    step('v08 comparar carpetas', await js(`({ nuevos: syncState().res?.onlyA.map((f)=>f.rel), iguales: syncState().res?.same.length, botones: [...document.querySelectorAll('.syncbox .btn.primary')].map((b)=>b.innerText) })`));
    await shot('t2-comparar-carpetas');
    await js(`[...document.querySelectorAll('.syncbox .btn.primary')].find((b)=>/Copiar/.test(b.innerText)).click()`); await wait(4000);
    step('v08 copiar lo nuevo', { uno: fs.existsSync(path.join(sb, 'uno.bin')), dos: fs.existsSync(path.join(sb, 'dir', 'dos.bin')), despues: await js(`({ nuevos: syncState().res?.onlyA.length, iguales: syncState().res?.same.length, msg: syncState().msg })`) });
    // un traspaso largo (600 MB a dos destinos) para tener una grafica de velocidad real
    const gDir = path.join(v8, 'GRANDE'); await fsp.mkdir(gDir, { recursive: true });
    { const fd = await fsp.open(path.join(gDir, 'G001.bin'), 'w'); const blk = crypto.randomBytes(8 * 1024 * 1024); for (let i = 0; i < 75; i++) await fd.write(blk); await fd.close(); }
    const big8 = await startWorkflow({ sources: [{ path: gDir, type: 'folder' }], destinations: [path.join(v8, 'G_D1'), path.join(v8, 'G_D2')], algos: ['xxh64'], verify: true, mhl: false });
    const bigJob = lib.listJobs()[0];
    step('v08 traspaso largo', { ok: big8[0]?.job?.ok, segundos: bigJob.seconds, muestras: bigJob.samples?.length, destinos: bigJob.perDest?.map((d) => [d.copiedBytes, d.verifiedBytes]) });
    await js(`go('jobs')`); await wait(1000);
    step('v08 trabajos: botones', await js(`[...document.querySelectorAll('#main table button')].map((b)=>b.innerText).slice(0,4)`));
    await js(`[...document.querySelectorAll('#main table button')].find((b)=>b.innerText==='Velocidad').click()`); await wait(1000);
    step('v08 ventana de velocidad', await js(`({ titulo: document.querySelector('dialog b')?.innerText, filas: document.querySelectorAll('dialog tbody tr').length, svg: !!document.querySelector('dialog svg'), lineas: document.querySelectorAll('dialog svg polyline').length, mensaje: document.querySelector('dialog .speedchart')?.innerText || document.querySelector('dialog .warn')?.innerText || '' })`));
    await shot('t3-velocidad');
    await js(`document.querySelector('dialog .btn.primary').click()`); await wait(400);
    const lastJob = lib.listJobs()[0];
    const trf = await js(`api.invoke('report:make', 'transfer', { jobIds: [${JSON.stringify(lastJob.id)}], format: 'html', outDir: ${JSON.stringify(v8)} })`);
    step('v08 informe de velocidad', { existe: fs.existsSync(trf), contiene: /Velocidad del traspaso/.test(fs.readFileSync(trf, 'utf8')), enLista: (await js(`api.invoke('reports:list')`)).some((r) => r.type === 'transfer') });
    step('v08 sin trabajo pendiente', { ocupado: isBusy(), bloqueador: psbId });

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
