// render.js — 2D canvas visualisation of a slice through the 3D scene.
// The field layers (heatmap, streamlines, glyphs, grid) are expensive, so they
// are rendered once to an offscreen canvas whenever the scene or view changes;
// per-frame drawing (during particle animation) just blits that layer and adds
// lightweight overlays (sources, particles, probe).
import * as P from './physics.js';

// Compact viridis colour ramp (control points), interpolated in sRGB.
const VIRIDIS = [
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
  [31, 158, 137], [53, 183, 121], [110, 206, 88], [181, 222, 43], [253, 231, 37],
];
function viridis(t) {
  t = Math.max(0, Math.min(1, t));
  const x = t * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  const f = x - i, a = VIRIDIS[i], b = VIRIDIS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export class View {
  constructor() {
    this.uAxis = 0; this.vAxis = 2; this.nAxis = 1; // XZ plane, slice along Y
    this.slice = 0;
    this.center = [0, 0];
    this.spanU = 0.16;
    this.W = 800; this.H = 600;
  }
  get scale() { return this.W / this.spanU; }
  toScreen(w) {
    return [this.W / 2 + (w[this.uAxis] - this.center[0]) * this.scale,
            this.H / 2 - (w[this.vAxis] - this.center[1]) * this.scale];
  }
  toWorld(sx, sy) {
    const u = this.center[0] + (sx - this.W / 2) / this.scale;
    const v = this.center[1] - (sy - this.H / 2) / this.scale;
    return this.worldFromUV(u, v);
  }
  worldFromUV(u, v) {
    const w = [0, 0, 0];
    w[this.uAxis] = u; w[this.vAxis] = v; w[this.nAxis] = this.slice;
    return w;
  }
  planeComps(B) { return { u: B[this.uAxis], v: B[this.vAxis], n: B[this.nAxis] }; }
  axisLabel(i) { return ['X', 'Y', 'Z'][i]; }
  get spanV() { return this.spanU * this.H / this.W; }
}

export class Renderer {
  constructor(canvas, scene, view) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scene = scene;
    this.view = view;
    this.grid = null;
    this.heat = null;               // offscreen grid-resolution heatmap
    this.field = document.createElement('canvas'); // offscreen full-res field layer
    this.opts = { heatmap: true, lines: true, vectors: false, grid: true, gridStep: 24 };
    this.range = { min: -6, max: 0 };
  }

  // Sample |B| and in-plane components over a grid.
  computeGrid(cols = 150) {
    const v = this.view;
    const rows = Math.max(2, Math.round(cols * v.H / v.W));
    const mag = new Float32Array(cols * rows);
    const bu = new Float32Array(cols * rows);
    const bv = new Float32Array(cols * rows);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const sx = (i + 0.5) / cols * v.W;
        const sy = (j + 0.5) / rows * v.H;
        const B = this.scene.B(v.toWorld(sx, sy));
        const m = P.vlen(B);
        const idx = j * cols + i;
        mag[idx] = m; bu[idx] = B[v.uAxis]; bv[idx] = B[v.vAxis];
        if (m > 0) { const l = Math.log10(m); if (l < lo) lo = l; if (l > hi) hi = l; }
      }
    }
    if (!isFinite(lo)) { lo = -6; hi = 0; }
    hi = Math.min(hi, 0.5); lo = Math.max(lo, hi - 6);
    this.grid = { cols, rows, mag, bu, bv };
    this.range = { min: lo, max: hi };
    // build heatmap image at grid resolution
    const off = this.heat || (this.heat = document.createElement('canvas'));
    off.width = cols; off.height = rows;
    const octx = off.getContext('2d');
    const img = octx.createImageData(cols, rows);
    const span = (hi - lo) || 1;
    for (let k = 0; k < cols * rows; k++) {
      const m = mag[k];
      const t = m > 0 ? (Math.log10(m) - lo) / span : 0;
      const c = viridis(t);
      img.data[k * 4] = c[0]; img.data[k * 4 + 1] = c[1]; img.data[k * 4 + 2] = c[2]; img.data[k * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
  }

  // Bilinear in-plane field from the cached grid, in world (u,v) coordinates.
  sampleField(u, v) {
    const g = this.grid, view = this.view;
    // world (u,v) -> grid fractional index
    const fx = (view.W / 2 + (u - view.center[0]) * view.scale) / view.W * g.cols - 0.5;
    const fy = (view.H / 2 - (v - view.center[1]) * view.scale) / view.H * g.rows - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 >= g.cols - 1 || y0 >= g.rows - 1) return null;
    const tx = fx - x0, ty = fy - y0;
    const at = (xx, yy, arr) => arr[yy * g.cols + xx];
    const lerp2 = (arr) =>
      (at(x0, y0, arr) * (1 - tx) + at(x0 + 1, y0, arr) * tx) * (1 - ty) +
      (at(x0, y0 + 1, arr) * (1 - tx) + at(x0 + 1, y0 + 1, arr) * tx) * ty;
    return [lerp2(g.bu), lerp2(g.bv)];
  }

  // Render all field layers to the offscreen field canvas.
  renderField() {
    const v = this.view;
    const f = this.field;
    f.width = v.W; f.height = v.H;
    const ctx = f.getContext('2d');
    ctx.clearRect(0, 0, v.W, v.H);
    if (this.opts.heatmap && this.heat) {
      ctx.imageSmoothingEnabled = true; ctx.globalAlpha = 0.95;
      ctx.drawImage(this.heat, 0, 0, v.W, v.H);
      ctx.globalAlpha = 1;
    }
    if (this.opts.grid) this.drawGrid(ctx);
    if (this.opts.lines) this.drawStreamlines(ctx);
    if (this.opts.vectors) this.drawVectors(ctx);
  }

  // Trace an in-plane streamline from a seed on the interpolated grid.
  streamline(u0, v0, dir) {
    const v = this.view, pts = [];
    let u = u0, w = v0;
    const ds = v.spanU / 300;
    const f = (uu, vv) => {
      const s = this.sampleField(uu, vv);
      if (!s) return null;
      const L = Math.hypot(s[0], s[1]);
      if (L < 1e-13) return null;
      return [dir * s[0] / L, dir * s[1] / L];
    };
    for (let step = 0; step < 320; step++) {
      pts.push([u, w]);
      const k1 = f(u, w); if (!k1) break;
      const k2 = f(u + k1[0] * ds / 2, w + k1[1] * ds / 2); if (!k2) break;
      const k3 = f(u + k2[0] * ds / 2, w + k2[1] * ds / 2); if (!k3) break;
      const k4 = f(u + k3[0] * ds, w + k3[1] * ds); if (!k4) break;
      u += ds * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6;
      w += ds * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6;
    }
    return pts;
  }

  drawStreamlines(ctx) {
    const v = this.view;
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = 'rgba(238,240,255,0.5)';
    const seeds = 16;
    for (let a = 0; a < seeds; a++) {
      for (let b = 0; b < seeds; b++) {
        const u0 = v.center[0] - v.spanU / 2 + v.spanU * (a + 0.5) / seeds;
        const v0 = v.center[1] - v.spanV / 2 + v.spanV * (b + 0.5) / seeds;
        for (const dir of [1, -1]) {
          const line = this.streamline(u0, v0, dir);
          if (line.length < 6) continue;
          ctx.beginPath();
          for (let i = 0; i < line.length; i++) {
            const s = v.toScreen(v.worldFromUV(line[i][0], line[i][1]));
            if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]);
          }
          ctx.stroke();
          if (dir === 1 && line.length > 12) this.arrowAt(ctx, line);
        }
      }
    }
  }

  arrowAt(ctx, line) {
    const i = Math.min(9, line.length - 2), v = this.view;
    const a = v.toScreen(v.worldFromUV(line[i][0], line[i][1]));
    const b = v.toScreen(v.worldFromUV(line[i + 1][0], line[i + 1][1]));
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), sz = 5;
    ctx.fillStyle = 'rgba(238,240,255,0.65)';
    ctx.beginPath();
    ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b[0] - sz * Math.cos(ang - 0.4), b[1] - sz * Math.sin(ang - 0.4));
    ctx.lineTo(b[0] - sz * Math.cos(ang + 0.4), b[1] - sz * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill();
  }

  drawVectors(ctx) {
    const v = this.view, step = this.opts.gridStep;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1;
    const span = (this.range.max - this.range.min) || 1;
    for (let sy = step / 2; sy < v.H; sy += step) {
      for (let sx = step / 2; sx < v.W; sx += step) {
        const wpt = v.toWorld(sx, sy);
        const s = this.sampleField(wpt[v.uAxis], wpt[v.vAxis]);
        if (!s) continue;
        const m = Math.hypot(s[0], s[1]);
        if (m < 1e-13) continue;
        const len = step * 0.45 * (0.3 + 0.7 * Math.min(1, (Math.log10(m) - this.range.min) / span));
        const ex = sx + s[0] / m * len, ey = sy - s[1] / m * len;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
        const ang = Math.atan2(ey - sy, ex - sx), hs = 3;
        ctx.beginPath(); ctx.moveTo(ex, ey);
        ctx.lineTo(ex - hs * Math.cos(ang - 0.5), ey - hs * Math.sin(ang - 0.5));
        ctx.lineTo(ex - hs * Math.cos(ang + 0.5), ey - hs * Math.sin(ang + 0.5));
        ctx.closePath(); ctx.fill();
      }
    }
  }

  drawGrid(ctx) {
    const v = this.view;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    const stepM = niceStep(60 / v.scale);
    const u0 = v.center[0] - v.spanU / 2, u1 = v.center[0] + v.spanU / 2;
    const w0 = v.center[1] - v.spanV / 2, w1 = v.center[1] + v.spanV / 2;
    ctx.beginPath();
    for (let u = Math.ceil(u0 / stepM) * stepM; u <= u1; u += stepM) {
      const s0 = v.toScreen(v.worldFromUV(u, w0)), s1 = v.toScreen(v.worldFromUV(u, w1));
      ctx.moveTo(s0[0], s0[1]); ctx.lineTo(s1[0], s1[1]);
    }
    for (let w = Math.ceil(w0 / stepM) * stepM; w <= w1; w += stepM) {
      const s0 = v.toScreen(v.worldFromUV(u0, w)), s1 = v.toScreen(v.worldFromUV(u1, w));
      ctx.moveTo(s0[0], s0[1]); ctx.lineTo(s1[0], s1[1]);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    const o = v.toScreen([0, 0, 0]);
    ctx.beginPath(); ctx.moveTo(0, o[1]); ctx.lineTo(v.W, o[1]); ctx.moveTo(o[0], 0); ctx.lineTo(o[0], v.H); ctx.stroke();
  }

  // ---- overlays (drawn to visible ctx each frame) ----
  blitField() { this.ctx.drawImage(this.field, 0, 0, this.view.W, this.view.H); }

  drawSources(selectedId) {
    const ctx = this.ctx;
    for (const s of this.scene.sources) {
      if (!s.visible) continue;
      const sel = s.id === selectedId;
      ctx.save();
      if (s.type === 'magnet') this.drawMagnet(s, sel);
      else if (s.type === 'cylinder') this.drawCylinder(s, sel);
      else if (s.type === 'coil') this.drawCoil(s, sel);
      else if (s.type === 'loop') this.drawLoop(s, sel);
      else if (s.type === 'wire') this.drawWire(s, sel);
      else if (s.type === 'dipole') this.drawDipole(s, sel);
      else if (s.type === 'charge') this.drawCharge(s, sel);
      ctx.restore();
    }
  }

  localToScreen(s, local) {
    const w = P.vadd(s._origin, P.matVec(s._R, local.map((c) => c / 1000)));
    return this.view.toScreen(w);
  }

  drawMagnet(s, sel) {
    const ctx = this.ctx;
    const [w, h, d] = s.size;
    const corners = [
      [-w / 2, -h / 2, -d / 2], [w / 2, -h / 2, -d / 2], [w / 2, h / 2, -d / 2], [-w / 2, h / 2, -d / 2],
      [-w / 2, -h / 2, d / 2], [w / 2, -h / 2, d / 2], [w / 2, h / 2, d / 2], [-w / 2, h / 2, d / 2],
    ].map((c) => this.localToScreen(s, c));
    const poly = (idx, fill) => {
      ctx.beginPath();
      idx.forEach((i, k) => { const p = corners[i]; k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    };
    ctx.globalAlpha = 0.92;
    poly([0, 1, 2, 3], '#3d6be6');
    poly([4, 5, 6, 7], '#e6483d');
    ctx.globalAlpha = 1;
    ctx.strokeStyle = sel ? '#ffffff' : 'rgba(0,0,0,0.55)'; ctx.lineWidth = sel ? 2 : 1;
    const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    ctx.beginPath();
    for (const [i, j] of edges) { ctx.moveTo(corners[i][0], corners[i][1]); ctx.lineTo(corners[j][0], corners[j][1]); }
    ctx.stroke();
    this.poleLabels(s, d);
  }

  poleLabels(s, d) {
    const ctx = this.ctx;
    const n = this.localToScreen(s, [0, 0, d / 2]);
    const sp = this.localToScreen(s, [0, 0, -d / 2]);
    ctx.fillStyle = '#fff'; ctx.font = '600 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', n[0], n[1]); ctx.fillText('S', sp[0], sp[1]);
  }

  drawCylinder(s, sel) {
    const ctx = this.ctx;
    const r = s.dia / 2, L = s.len;
    const c = [[-r, 0, -L / 2], [r, 0, -L / 2], [r, 0, L / 2], [-r, 0, L / 2]].map((p) => this.localToScreen(s, p));
    ctx.beginPath(); ctx.moveTo(c[0][0], c[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i][0], c[i][1]);
    ctx.closePath();
    const grad = ctx.createLinearGradient(c[0][0], c[0][1], c[3][0], c[3][1]);
    grad.addColorStop(0, '#3d6be6'); grad.addColorStop(1, '#e6483d');
    ctx.fillStyle = grad; ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.55)'; ctx.lineWidth = sel ? 2 : 1; ctx.stroke();
    this.poleLabels(s, L);
  }

  drawCoil(s, sel) {
    const ctx = this.ctx;
    const r = s.dia / 2, L = s.len;
    const turnsShown = Math.min(26, Math.max(4, Math.round(s.turns / 8)));
    ctx.strokeStyle = sel ? '#ffd24a' : '#c98a2a'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= turnsShown; i++) {
      const z = -L / 2 + L * i / turnsShown;
      const left = this.localToScreen(s, [-r, 0, z]);
      const right = this.localToScreen(s, [r, 0, z]);
      ctx.moveTo(left[0], left[1]); ctx.lineTo(right[0], right[1]);
    }
    ctx.stroke();
    const a = this.localToScreen(s, [0, 0, -L / 2 - 3]);
    const b = this.localToScreen(s, [0, 0, L / 2 + 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }

  drawLoop(s, sel) {
    const ctx = this.ctx, r = s.dia / 2;
    const a = this.localToScreen(s, [-r, 0, 0]), b = this.localToScreen(s, [r, 0, 0]);
    ctx.strokeStyle = sel ? '#ffd24a' : '#d99a3a'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 7); ctx.fill(); }
  }

  drawWire(s, sel) {
    const ctx = this.ctx, L = s.len;
    const a = this.localToScreen(s, [0, 0, -L / 2]), b = this.localToScreen(s, [0, 0, L / 2]);
    ctx.strokeStyle = sel ? '#ffd24a' : '#d9a441'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath(); ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b[0] - 8 * Math.cos(ang - 0.4), b[1] - 8 * Math.sin(ang - 0.4));
    ctx.lineTo(b[0] - 8 * Math.cos(ang + 0.4), b[1] - 8 * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill();
  }

  drawDipole(s, sel) {
    const ctx = this.ctx;
    const a = this.localToScreen(s, [0, 0, -6]), b = this.localToScreen(s, [0, 0, 6]);
    ctx.strokeStyle = sel ? '#fff' : '#c04ae0'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath(); ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b[0] - 8 * Math.cos(ang - 0.4), b[1] - 8 * Math.sin(ang - 0.4));
    ctx.lineTo(b[0] - 8 * Math.cos(ang + 0.4), b[1] - 8 * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill();
  }

  drawCharge(s, sel) {
    const ctx = this.ctx;
    const p = this.view.toScreen(s._origin);
    ctx.fillStyle = s.q < 0 ? '#4aa3ff' : '#ff5a4a';
    ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, 7); ctx.fill();
    ctx.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.5)'; ctx.lineWidth = sel ? 2 : 1; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(s.q < 0 ? '−' : '+', p[0], p[1]);
  }

  clear() { this.ctx.fillStyle = '#0b0d12'; this.ctx.fillRect(0, 0, this.view.W, this.view.H); }
}

function niceStep(x) {
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / e;
  const nm = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
  return nm * e;
}

export { viridis };
