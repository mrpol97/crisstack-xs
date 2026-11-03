// Genera docs/CrisStack-XS-Guia.pdf a partir de docs/guia.html con capturas de docs/img/<nombre>.png
// Uso: npx electron scripts/make-guide.js
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(async () => {
  process.on('unhandledRejection', (e) => { console.error(e); app.exit(1); });
  const docs = path.join(__dirname, '..', 'docs');
  let html = fs.readFileSync(path.join(docs, 'guia.html'), 'utf8');
  html = html.replace(/<img src="img\/([\w-]+)\.png"/g, (m, name) => {
    const f = path.join(docs, 'img', name + '.png');
    if (!fs.existsSync(f)) { console.warn('Falta captura:', name); return m; }
    const img = nativeImage.createFromPath(f); const { width } = img.getSize();
    const small = width > 1300 ? img.resize({ width: 1300, quality: 'best' }) : img;
    return `<img src="data:image/jpeg;base64,${small.toJPEG(84).toString('base64')}"`;
  });
  const win = new BrowserWindow({ show: false, width: 900, height: 1200 });
  const tmpHtml = path.join(require('node:os').tmpdir(), 'crisstack-guia.html'); fs.writeFileSync(tmpHtml, html); // un data: URL no admite tantas imagenes
  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 600));
  const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="font:8px Helvetica,Arial;color:#888;width:100%;text-align:center">CrisStack XS · Guía rápida · <span class="pageNumber"></span>/<span class="totalPages"></span></div>' });
  const out = path.join(docs, 'CrisStack-XS-Guia.pdf');
  fs.writeFileSync(out, pdf);
  console.log('PDF generado:', out, pdf.length, 'bytes');
  app.quit();
});
