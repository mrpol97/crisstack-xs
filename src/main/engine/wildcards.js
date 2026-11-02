// Comodines de ruta para carpetas destino, p.ej. "{project}/Day_{day}/{reel}".
const path = require('node:path');

const pad = (n, l = 2) => String(n).padStart(l, '0');

function expand(template, ctx = {}) {
  const now = ctx.date ? new Date(ctx.date) : new Date();
  const vars = {
    project: ctx.project || 'Proyecto',
    day: ctx.day != null ? pad(ctx.day) : '01',
    reel: ctx.reel || (ctx.source ? path.basename(ctx.source) : 'Reel'),
    camera: ctx.camera || 'A',
    card: ctx.card || ctx.reel || (ctx.source ? path.basename(ctx.source) : 'Card'),
    volume: ctx.source ? path.basename(ctx.source) : 'Volume',
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    yyyy: String(now.getFullYear()),
    mm: pad(now.getMonth() + 1),
    dd: pad(now.getDate()),
    time: `${pad(now.getHours())}${pad(now.getMinutes())}`,
    counter: pad(ctx.counter ?? 1, 3),
  };
  return template.replace(/\{(\w+)(?::(\d+))?\}/g, (m, k, w) => {
    if (!(k in vars)) return m;
    return w ? String(vars[k]).padStart(Number(w), '0') : vars[k];
  }).replace(/[<>:"|?*]/g, '_');
}

module.exports = { expand };
