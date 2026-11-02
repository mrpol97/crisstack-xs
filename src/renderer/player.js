'use strict';
/* Reproductor WebGL2: CDL + LUT 3D en tiempo real, color falso, zebra, clipping, peaking, scopes y lineas de encuadre. */
const FRAG = `#version 300 es
precision highp float; precision highp sampler3D;
uniform sampler2D uTex; uniform sampler3D uLut; uniform float uLutSize; uniform bool uUseLut;
uniform vec3 uSlope, uOffset, uPower; uniform float uSat; uniform vec2 uTexel; uniform float uTime;
uniform int uFalse, uZebra, uClip, uPeak;
in vec2 vUv; out vec4 o;
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main(){
  vec3 c = texture(uTex, vUv).rgb;
  c = pow(clamp(c * uSlope + uOffset, 0.0, 1.0), uPower);
  float l0 = luma(c); c = clamp(vec3(l0) + (c - vec3(l0)) * uSat, 0.0, 1.0);
  if (uUseLut) c = texture(uLut, c * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize).rgb;
  float y = luma(c);
  if (uPeak == 1) {
    float g = abs(luma(texture(uTex, vUv + vec2(uTexel.x, 0.)).rgb) - luma(texture(uTex, vUv - vec2(uTexel.x, 0.)).rgb))
            + abs(luma(texture(uTex, vUv + vec2(0., uTexel.y)).rgb) - luma(texture(uTex, vUv - vec2(0., uTexel.y)).rgb));
    if (g > 0.14) c = vec3(0.1, 1.0, 0.35);
  }
  if (uFalse == 1) {
    c = y < 0.02 ? vec3(0.45, 0.0, 0.65) : y < 0.10 ? vec3(0.0, 0.1, 0.9) : y < 0.38 ? vec3(vec3(y) * vec3(0.8, 0.9, 1.0))
      : y < 0.46 ? vec3(0.0, 0.75, 0.3) : y < 0.97 ? vec3(y * 0.85) : y < 0.995 ? vec3(1.0, 0.9, 0.0) : vec3(1.0, 0.0, 0.0);
  }
  if (uClip == 1) { float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)); if (mx > 0.995) c = vec3(1.0, 0.0, 0.0); else if (mn < 0.005) c = vec3(0.0, 0.2, 1.0); }
  if (uZebra == 1 && y > 0.94 && mod(floor((gl_FragCoord.x + gl_FragCoord.y + uTime * 24.0) / 7.0), 2.0) < 1.0) c = vec3(0.0);
  o = vec4(c, 1.0);
}`;
const VERT = `#version 300 es
out vec2 vUv; void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vUv = vec2(p.x, 1.0 - p.y); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const FRAME_LINES = [['', 'Sin líneas'], ['2.39', '2.39:1'], ['2.0', '2:1'], ['1.85', '1.85:1'], ['1.7778', '16:9'], ['1.3333', '4:3'], ['1', '1:1'], ['0.5625', '9:16']];
const fmtT = (s) => { if (!isFinite(s)) return '0:00'; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

class CinePlayer {
  constructor(host, opts = {}) {
    this.host = host; this.fx = { false: 0, zebra: 0, clip: 0, peak: 0 }; this.look = { cdl: { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 }, lut: null };
    this.scopesOn = false; this.fps = opts.fps || 25;
    this.video = Object.assign(document.createElement('video'), { muted: false, playsInline: true, crossOrigin: 'anonymous' });
    this.canvas = document.createElement('canvas'); this.canvas.style.cssText = 'width:100%;display:block;background:#000';
    this.stage = document.createElement('div'); this.stage.style.cssText = 'position:relative;overflow:hidden;background:#000;border-radius:7px;display:flex;align-items:center;justify-content:center';
    this.inner = document.createElement('div'); this.inner.style.cssText = 'position:relative;width:100%;transform-origin:center';
    this.lines = document.createElement('div'); this.lines.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:none;align-items:center;justify-content:center';
    this.box = document.createElement('div'); this.lines.append(this.box);
    this.video.style.display = 'none'; this.inner.append(this.canvas, this.lines, this.video); this.stage.append(this.inner);
    this.controls = this.buildControls(); this.scopes = this.buildScopes();
    host.replaceChildren(this.stage, this.controls, this.scopes);
    this.initGL(); this.bindVideo();
    // al insertarse en el DOM o cambiar de tamaño, el buffer puede quedar vacio: redibuja
    if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(() => requestAnimationFrame(() => this.draw())); this.ro.observe(this.stage); }
    this.keyHandler = (e) => this.onKey(e); document.addEventListener('keydown', this.keyHandler);
  }

  buildControls() {
    const bar = document.createElement('div'); bar.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:6px';
    const row1 = document.createElement('div'); row1.style.cssText = 'display:flex;gap:8px;align-items:center';
    const btn = (label, title, fn, cls = 'btn') => { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.title = title; b.style.padding = '4px 9px'; b.onclick = fn; return b; };
    this.playBtn = btn('▶', 'Reproducir / pausa (K o espacio)', () => this.toggle());
    this.seek = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 1000, value: 0 }); this.seek.style.cssText = 'flex:1;accent-color:#4c8dff';
    this.seek.oninput = () => { if (this.video.duration) this.video.currentTime = (this.seek.value / 1000) * this.video.duration; };
    this.time = document.createElement('span'); this.time.className = 'mono mut'; this.time.textContent = '0:00 / 0:00';
    row1.append(this.playBtn, this.seek, this.time);
    const row2 = document.createElement('div'); row2.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;align-items:center';
    const tog = (label, key, title) => { const b = btn(label, title, () => { this.fx[key] = this.fx[key] ? 0 : 1; b.style.borderColor = this.fx[key] ? '#4c8dff' : ''; this.draw(); }); return b; };
    const sel = Object.assign(document.createElement('select'), { title: 'Líneas de encuadre' }); sel.style.padding = '3px';
    for (const [v, l] of FRAME_LINES) sel.append(new Option(l, v)); sel.onchange = () => this.setFrameLines(sel.value);
    const sc = btn('Scopes', 'Waveform, histograma y vectorscopio', () => { this.scopesOn = !this.scopesOn; this.scopes.style.display = this.scopesOn ? 'grid' : 'none'; sc.style.borderColor = this.scopesOn ? '#4c8dff' : ''; this.drawScopes(); });
    row2.append(tog('Color falso', 'false', 'Exposición por colores'), tog('Zebra', 'zebra', 'Zebra sobre 94 %'), tog('Clipping', 'clip', 'Rojo = recorte de luces, azul = sombras'), tog('Peaking', 'peak', 'Ayuda de foco'), sel, sc,
      btn('⤢', 'Pantalla completa', () => (document.fullscreenElement ? document.exitFullscreen() : this.host.requestFullscreen())), btn('⟲ Fotograma', 'Guardar still con el look aplicado', () => this.onStill?.(this.video.currentTime)),
      btn('Miniatura', 'Usar este fotograma como miniatura', () => this.onThumb?.(this.video.currentTime)));
    bar.append(row1, row2); return bar;
  }

  buildScopes() {
    const g = document.createElement('div'); g.style.cssText = 'display:none;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px';
    const mk = (title) => { const w = document.createElement('div'); const c = document.createElement('canvas'); c.width = 256; c.height = 128; c.style.cssText = 'width:100%;background:#050607;border:1px solid #262b36;border-radius:5px;display:block'; const t = document.createElement('div'); t.className = 'mut'; t.style.fontSize = '10px'; t.textContent = title; w.append(c, t); g.append(w); return c.getContext('2d'); };
    this.wf = mk('Waveform'); this.hist = mk('Histograma'); this.vs = mk('Vectorscopio'); this.tmp = document.createElement('canvas'); this.tmp.width = 160; this.tmp.height = 90; this.tctx = this.tmp.getContext('2d', { willReadFrequently: true });
    return g;
  }

  initGL() {
    const gl = this.gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
    if (!gl) { this.glError = 'WebGL2 no disponible'; return; }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = this.prog = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p); this.u = (n) => gl.getUniformLocation(p, n);
    this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.lutTex = gl.createTexture(); gl.uniform1i(this.u('uTex'), 0); gl.uniform1i(this.u('uLut'), 1);
    this.glOk = true;
  }

  bindVideo() {
    const v = this.video;
    v.addEventListener('loadedmetadata', () => { const w = Math.min(v.videoWidth, 1920), h = Math.round(w * v.videoHeight / v.videoWidth); this.canvas.width = w; this.canvas.height = h; this.canvas.style.aspectRatio = `${w}/${h}`; this.draw(); });
    v.addEventListener('seeked', () => this.draw());
    v.addEventListener('loadeddata', () => { // un video en pausa a veces no tiene aun el primer fotograma presentado: reintenta
      this.draw(); v.requestVideoFrameCallback?.(() => this.draw()); setTimeout(() => this.draw(), 150); setTimeout(() => this.draw(), 600);
      if (v.paused && v.currentTime === 0) v.currentTime = 0.001;
    });
    v.addEventListener('play', () => { this.playBtn.textContent = '⏸'; this.loop(); }); v.addEventListener('pause', () => { this.playBtn.textContent = '▶'; this.draw(); });
    v.addEventListener('timeupdate', () => { if (v.duration) this.seek.value = (v.currentTime / v.duration) * 1000; this.time.textContent = `${fmtT(v.currentTime)} / ${fmtT(v.duration)}`; });
  }
  loop() { if (this.video.paused || this.destroyed) return; this.draw(); (this.video.requestVideoFrameCallback ? (f) => this.video.requestVideoFrameCallback(f) : requestAnimationFrame)(() => this.loop()); }

  load(url) { this.video.src = url; this.video.load(); return this; }
  toggle() { this.video.paused ? this.video.play() : this.video.pause(); }
  onKey(e) {
    if (!this.host.isConnected) return this.destroy();
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && e.key !== ' ') return;
    const v = this.video, fr = 1 / this.fps;
    const k = { k: () => this.toggle(), ' ': () => this.toggle(), l: () => { v.playbackRate = Math.min(8, (v.paused ? 0 : v.playbackRate) + 1); v.play(); }, j: () => { v.playbackRate = 1; v.currentTime = Math.max(0, v.currentTime - 5); }, ArrowRight: () => (v.currentTime += fr), ArrowLeft: () => (v.currentTime -= fr) }[e.key];
    if (k && !(e.target.tagName === 'INPUT' && e.key === ' ')) { e.preventDefault(); k(); }
  }

  setLook(look) { this.look = { cdl: look?.cdl || this.look.cdl, lut: look?.lut || null }; this.draw(); }
  async setLut(lutData) { // {size, data(Float32Array rgb)} o null
    const gl = this.gl; this.lutSize = 0; if (!gl || !lutData) { this.useLut = false; return this.draw(); }
    const n = lutData.size, rgba = new Uint8Array(n * n * n * 4);
    for (let i = 0; i < n ** 3; i++) { rgba[i * 4] = Math.round(Math.min(1, Math.max(0, lutData.data[i * 3])) * 255); rgba[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, lutData.data[i * 3 + 1])) * 255); rgba[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, lutData.data[i * 3 + 2])) * 255); rgba[i * 4 + 3] = 255; }
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, n, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba); gl.activeTexture(gl.TEXTURE0);
    this.lutSize = n; this.useLut = true; this.draw();
  }
  setTransform(t = {}) {
    const parts = [];
    if (t.desqueeze && t.desqueeze !== 1) parts.push(`scaleX(${t.desqueeze})`);
    if (t.flip === 'h' || t.flip === 'hv') parts.push('scaleX(-1)'); if (t.flip === 'v' || t.flip === 'hv') parts.push('scaleY(-1)');
    if (t.rotate) parts.push(`rotate(${t.rotate}deg)`);
    this.inner.style.transform = parts.join(' ');
    const c = t.crop; this.inner.style.clipPath = c ? `inset(${c.y * 100}% ${(1 - c.x - c.w) * 100}% ${(1 - c.y - c.h) * 100}% ${c.x * 100}%)` : '';
  }
  setFrameLines(ratio) {
    if (!ratio) { this.lines.style.display = 'none'; return; }
    this.lines.style.display = 'flex';
    this.box.style.cssText = `aspect-ratio:${ratio};max-width:100%;max-height:100%;width:${Number(ratio) >= this.canvas.width / this.canvas.height ? '100%' : 'auto'};height:${Number(ratio) >= this.canvas.width / this.canvas.height ? 'auto' : '100%'};box-shadow:0 0 0 9999px rgba(0,0,0,.55);outline:2px solid #ffd33d`;
  }

  draw() {
    const gl = this.gl, v = this.video; if (!this.glOk || v.readyState < 2) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    const c = this.look.cdl, u = this.u;
    gl.uniform3fv(u('uSlope'), c.slope); gl.uniform3fv(u('uOffset'), c.offset); gl.uniform3fv(u('uPower'), c.power); gl.uniform1f(u('uSat'), c.sat);
    gl.uniform1i(u('uUseLut'), this.useLut ? 1 : 0); gl.uniform1f(u('uLutSize'), this.lutSize || 2);
    gl.uniform2f(u('uTexel'), 1 / this.canvas.width, 1 / this.canvas.height); gl.uniform1f(u('uTime'), v.currentTime);
    gl.uniform1i(u('uFalse'), this.fx.false); gl.uniform1i(u('uZebra'), this.fx.zebra); gl.uniform1i(u('uClip'), this.fx.clip); gl.uniform1i(u('uPeak'), this.fx.peak);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const now = performance.now(); if (this.scopesOn && now - (this.lastScope || 0) > 100) { this.lastScope = now; this.drawScopes(); }
  }

  drawScopes() {
    if (!this.scopesOn || !this.glOk) return;
    this.tctx.drawImage(this.canvas, 0, 0, 160, 90); const d = this.tctx.getImageData(0, 0, 160, 90).data;
    const W = 256, H = 128; for (const c of [this.wf, this.hist, this.vs]) { c.fillStyle = '#050607'; c.fillRect(0, 0, W, H); }
    this.wf.fillStyle = 'rgba(80,255,140,.30)'; const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
    this.vs.strokeStyle = '#2a3140'; this.vs.beginPath(); this.vs.arc(64 + 64, 64, 56, 0, 7); this.vs.stroke(); this.vs.fillStyle = 'rgba(120,200,255,.55)';
    for (let y = 0; y < 90; y++) for (let x = 0; x < 160; x++) {
      const i = (y * 160 + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2], l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      this.wf.fillRect(Math.floor(x * W / 160), H - 1 - Math.floor(l / 255 * (H - 1)), 2, 1);
      hr[r]++; hg[g]++; hb[b]++;
      const cb = (b - l) / 255 / 1.8556, cr = (r - l) / 255 / 1.5748; this.vs.fillRect(128 + cb * 2 * 56, 64 - cr * 2 * 56, 1.5, 1.5);
    }
    const mx = Math.max(...hr, ...hg, ...hb) || 1; this.hist.globalCompositeOperation = 'lighter';
    for (const [h, col] of [[hr, '#f55'], [hg, '#5f5'], [hb, '#58f']]) { this.hist.fillStyle = col; for (let i = 0; i < 256; i++) this.hist.fillRect(i, H - (h[i] / mx) * (H - 4), 1, (h[i] / mx) * (H - 4)); }
    this.hist.globalCompositeOperation = 'source-over';
  }

  destroy() { this.destroyed = true; this.ro?.disconnect(); document.removeEventListener('keydown', this.keyHandler); this.video.pause(); this.video.removeAttribute('src'); }
}
window.CinePlayer = CinePlayer;
