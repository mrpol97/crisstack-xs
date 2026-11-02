// Subida a S3 y compatibles (AWS, Wasabi, R2, MinIO...) con firma AWS SigV4 implementada con crypto de Node.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');

const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split('/').map(enc).join('/');

/** Devuelve las cabeceras firmadas (incluye Authorization). headers: {nombre: valor} sin host/x-amz-*. */
function signRequest({ method, host, path: p, query = {}, headers = {}, payloadHash, region, service = 's3', accessKey, secretKey, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const h = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v).trim();
  const names = Object.keys(h).sort();
  const canonHeaders = names.map((n) => `${n}:${h[n]}\n`).join('');
  const canonQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonical = [method, p, canonQuery, canonHeaders, names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return { headers: h, signature, canonical };
}

async function fileSha256(file) {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file)) h.update(c);
  return h.digest('hex');
}

/**
 * cfg: { endpoint: 'https://s3.eu-west-1.amazonaws.com' | 'http://127.0.0.1:9000', region, bucket, accessKey, secretKey, key, file, onProgress }
 * Usa path-style (/bucket/key) que funciona en todos los S3 compatibles.
 */
async function uploadFile(cfg) {
  const url = new URL(cfg.endpoint); const isHttps = url.protocol === 'https:';
  const st = await fsp.stat(cfg.file);
  const p = '/' + encPath(`${cfg.bucket}/${cfg.key}`);
  const payloadHash = isHttps ? 'UNSIGNED-PAYLOAD' : await fileSha256(cfg.file);
  const { headers } = signRequest({ method: 'PUT', host: url.host, path: p, headers: { 'content-length': st.size, 'content-type': cfg.contentType || 'application/octet-stream' }, payloadHash, region: cfg.region || 'us-east-1', accessKey: cfg.accessKey, secretKey: cfg.secretKey });
  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request({ method: 'PUT', hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: p, headers }, (res) => {
      let body = ''; res.on('data', (d) => (body += d));
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve({ status: res.statusCode, etag: res.headers.etag, key: cfg.key }) : reject(new Error(`S3 ${res.statusCode}: ${body.slice(0, 300)}`))));
    });
    req.on('error', reject);
    let sent = 0; const rs = fs.createReadStream(cfg.file);
    rs.on('data', (c) => { sent += c.length; cfg.onProgress?.(sent / st.size); });
    rs.pipe(req);
  });
}

module.exports = { signRequest, uploadFile };
