// Genera y lee listas de hashes (formato MHL v1 simple, compatible con herramientas DIT habituales).
const path = require('node:path');
const fsp = require('node:fs/promises');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildMhl(job, creatorName = 'Cinestack') {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<hashlist version="1.1">',
    '  <creatorinfo>',
    `    <name>${esc(job.operator || process.env.USERNAME || process.env.USER || 'user')}</name>`,
    `    <username>${esc(process.env.USERNAME || process.env.USER || 'user')}</username>`,
    `    <hostname>${esc(require('node:os').hostname())}</hostname>`,
    `    <tool>${esc(creatorName)}</tool>`,
    `    <startdate>${job.started}</startdate>`,
    `    <finishdate>${job.finished}</finishdate>`,
    '  </creatorinfo>',
  ];
  for (const f of job.files) {
    if (!f.hashes) continue;
    lines.push('  <hash>');
    lines.push(`    <file>${esc(f.rel.split(path.sep).join('/'))}</file>`);
    lines.push(`    <size>${f.size}</size>`);
    lines.push(`    <lastmodificationdate>${new Date(f.mtime).toISOString()}</lastmodificationdate>`);
    const tag = { xxh64: 'xxhash64be', md5: 'md5', sha1: 'sha1', sha256: 'sha256' };
    for (const [a, v] of Object.entries(f.hashes)) {
      lines.push(`    <${tag[a]}>${v}</${tag[a]}>`);
    }
    lines.push(`    <hashdate>${job.finished}</hashdate>`);
    lines.push('  </hash>');
  }
  lines.push('</hashlist>', '');
  return lines.join('\n');
}

function parseMhl(xml) {
  const entries = [];
  const tagToAlgo = { xxhash64be: 'xxh64', xxhash64: 'xxh64', md5: 'md5', sha1: 'sha1', sha256: 'sha256' };
  for (const m of xml.matchAll(/<hash>([\s\S]*?)<\/hash>/g)) {
    const body = m[1];
    const file = /<file>([\s\S]*?)<\/file>/.exec(body)?.[1];
    if (!file) continue;
    const size = Number(/<size>(\d+)<\/size>/.exec(body)?.[1] || 0);
    const hashes = {};
    for (const [tag, algo] of Object.entries(tagToAlgo)) {
      const v = new RegExp(`<${tag}>([0-9a-fA-F]+)</${tag}>`).exec(body)?.[1];
      if (v) hashes[algo] = v.toLowerCase();
    }
    entries.push({
      rel: file.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'),
      size,
      hashes,
    });
  }
  return entries;
}

async function writeMhl(job, destDir, name) {
  const file = path.join(destDir, `${name}.mhl`);
  await fsp.writeFile(file, buildMhl(job), 'utf8');
  return file;
}

module.exports = { buildMhl, parseMhl, writeMhl };
