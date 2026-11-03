// Exportacion de metadatos a sistemas de montaje: Avid ALE, FCP7/Premiere xmeml, FCPXML (FCP X / Resolve), CCC.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const color = require('./color');

const x = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tcToFrames = (tc, fps) => { const [h, m, s, f] = (tc || '00:00:00:00').split(/[:;]/).map(Number); const r = Math.round(fps); return ((h * 60 + m) * 60 + s) * r + (f || 0); };
const framesToTc = (n, fps) => { const r = Math.round(fps); const f = n % r, s = Math.floor(n / r) % 60, m = Math.floor(n / (r * 60)) % 60, h = Math.floor(n / (r * 3600)); return [h, m, s, f].map((v) => String(v).padStart(2, '0')).join(':'); };
const clipFps = (c, d = 25) => c.meta?.fps || d;
const clipFrames = (c) => Math.max(1, Math.round((c.meta?.duration || 0) * clipFps(c)));

function toAle(clips, fps = 25, customFields = []) {
  const cols = ['Name', 'Tracks', 'Start', 'End', 'Duration', 'Tape', 'Source File', 'Scene', 'Shoot', 'Take', 'Camera', 'Comments', 'Flag', 'ASC_SOP', 'ASC_SAT', 'Shot', 'ShotID', 'ISO', 'WB', 'Shutter', 'Lens', ...customFields];
  const head = ['Heading', 'FIELD_DELIM\tTABS', 'VIDEO_FORMAT\t1080', 'AUDIO_FORMAT\t48khz', `FPS\t${fps}`, '', 'Column', cols.join('\t'), '', 'Data'];
  const rows = clips.filter((c) => c.kind === 'video').map((c) => {
    const f = clipFps(c, fps), s = tcToFrames(c.meta?.timecode, f), n = clipFrames(c), cdl = c.look?.cdl;
    const sop = cdl ? `(${cdl.slope.join(' ')})(${cdl.offset.join(' ')})(${cdl.power.join(' ')})` : '';
    return [c.name.replace(/\.[^.]+$/, ''), c.meta?.audioTracks ? 'VA1A2' : 'V', c.meta?.timecode || '00:00:00:00', framesToTc(s + n, f), framesToTc(n, f), c.reel || '', c.name, c.scene, '', c.take, c.camera, (c.notes || '').replace(/[\t\r\n]+/g, ' '), c.flag, sop, cdl ? cdl.sat : '', c.shot || '', c.shotId || '', c.cam?.iso ?? c.meta?.camera?.iso ?? '', c.cam?.wb ?? c.meta?.camera?.wb ?? '', c.cam?.shutter ?? c.meta?.camera?.shutter ?? '', c.cam?.lens ?? c.meta?.camera?.lens ?? '', ...customFields.map((k) => String(c.custom?.[k] ?? '').replace(/[\t\r\n]+/g, ' '))].join('\t');
  });
  return [...head, ...rows, ''].join('\n');
}

function toFcp7Xml(clips, name = 'Cinestack', fps = 25) {
  const vids = clips.filter((c) => c.kind === 'video'); const r = Math.round(fps);
  let rec = 0;
  const items = vids.map((c, i) => {
    const n = clipFrames(c), s = tcToFrames(c.meta?.timecode, clipFps(c, fps)), st = rec; rec += n;
    return `<clipitem id="clipitem-${i + 1}"><name>${x(c.name)}</name><duration>${n}</duration><rate><timebase>${r}</timebase><ntsc>FALSE</ntsc></rate><start>${st}</start><end>${st + n}</end><in>0</in><out>${n}</out>
<file id="file-${i + 1}"><name>${x(c.name)}</name><pathurl>${x(pathToFileURL(c.path).href)}</pathurl><rate><timebase>${r}</timebase><ntsc>FALSE</ntsc></rate><duration>${n}</duration><timecode><rate><timebase>${r}</timebase></rate><string>${x(c.meta?.timecode || '00:00:00:00')}</string><frame>${s}</frame><displayformat>NDF</displayformat></timecode><media><video><samplecharacteristics><width>${c.meta?.width || 1920}</width><height>${c.meta?.height || 1080}</height></samplecharacteristics></video></media></file>
<logginginfo><scene>${x(c.scene)}</scene><shottake>${x(c.take)}</shottake><lognote>${x(c.notes)}</lognote></logginginfo></clipitem>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><sequence><name>${x(name)}</name><duration>${rec}</duration><rate><timebase>${r}</timebase><ntsc>FALSE</ntsc></rate><media><video><track>\n${items}\n</track></video></media></sequence></xmeml>\n`;
}

function toFcpxml(clips, name = 'Cinestack', fps = 25) {
  const vids = clips.filter((c) => c.kind === 'video'); const r = Math.round(fps);
  const t = (frames) => `${frames}/${r}s`;
  const dim = vids[0]?.meta || {};
  let rec = 0;
  const assets = vids.map((c, i) => `<asset id="a${i + 1}" name="${x(c.name)}" start="${t(tcToFrames(c.meta?.timecode, clipFps(c, fps)))}" duration="${t(clipFrames(c))}" hasVideo="1" hasAudio="${c.meta?.audioTracks ? 1 : 0}" format="r1"><media-rep kind="original-media" src="${x(pathToFileURL(c.path).href)}"/></asset>`).join('\n');
  const spine = vids.map((c, i) => {
    const n = clipFrames(c), st = tcToFrames(c.meta?.timecode, clipFps(c, fps)), off = rec; rec += n;
    const kw = [c.flag === 'good' ? `<keyword start="${t(st)}" duration="${t(n)}" value="Good"/>` : '', c.scene ? `<note>${x([c.scene, c.shot, c.take, c.notes].filter(Boolean).join(' / '))}</note>` : ''].join('');
    return `<asset-clip ref="a${i + 1}" name="${x(c.name)}" offset="${t(off)}" start="${t(st)}" duration="${t(n)}" format="r1">${kw}</asset-clip>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.9"><resources><format id="r1" name="FFVideoFormat${dim.height || 1080}p${r}" frameDuration="1/${r}s" width="${dim.width || 1920}" height="${dim.height || 1080}"/>\n${assets}\n</resources><library><event name="${x(name)}"><project name="${x(name)}"><sequence format="r1" duration="${t(rec)}"><spine>\n${spine}\n</spine></sequence></project></event></library></fcpxml>\n`;
}

function toCcc(clips) {
  return color.writeCcc(clips.filter((c) => c.look?.cdl).map((c) => ({ id: c.name.replace(/\.[^.]+$/, ''), cdl: c.look.cdl })));
}

module.exports = { toAle, toFcp7Xml, toFcpxml, toCcc, tcToFrames, framesToTc };
