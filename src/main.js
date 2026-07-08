// main.js — app glue: scene management, UI panels, interaction, particle sim.
import * as P from './physics.js';
import { Scene, defaultSource, buildSource, sourceExtent, MATERIALS } from './sources.js';
import { Renderer, View } from './render.js';

const scene = new Scene();
const view = new View();
const canvas = document.getElementById('view');
const renderer = new Renderer(canvas, scene, view);

let selectedId = null;
let probe = null;           // last probed world point
let aimDir = [1, 0];        // launch aim: in-plane unit vector [u, v] (screen: +u right, +v up)
const particles = [];       // { x, v, q, mass, trail:[], color, alive }
let simRunning = false;
const FIELD_LEN = 22;       // px — the small field-direction arrow
const AIM_LEN = 48;         // px — the longer red shooter line
// Draw a line with a filled arrowhead from (x0,y0) to (x1,y1).
function drawArrow(ctx, x0, y0, x1, y1, color, w, head) {
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath(); ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(a - 0.5), y1 - head * Math.sin(a - 0.5));
  ctx.lineTo(x1 - head * Math.cos(a + 0.5), y1 - head * Math.sin(a + 0.5));
  ctx.closePath(); ctx.fill(); ctx.lineCap = 'butt';
}

// ---- field unit display ------------------------------------------------
const UNITS = { T: 1, mT: 1e3, µT: 1e6, G: 1e4, mG: 1e7 };
let fieldUnit = 'mT';
function fmtField(teslas) {
  const val = teslas * UNITS[fieldUnit];
  const a = Math.abs(val);
  const digits = a >= 100 ? 1 : a >= 1 ? 2 : 3;
  return `${val.toFixed(digits)} ${fieldUnit}`;
}

// ---- canvas sizing -----------------------------------------------------
// Setting canvas.width/height clears the bitmap, so only do it when the size
// actually changed.  On mobile, hiding/showing the URL bar fires a resize event
// without changing the canvas size — re-clearing there caused a black flash.
let lastW = 0, lastH = 0, lastDpr = 0;
function resize() {
  const wrap = canvas.parentElement;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (w === lastW && h === lastH && dpr === lastDpr) return false;
  lastW = w; lastH = h; lastDpr = dpr;
  view.W = w; view.H = h;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  renderer.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return true;
}
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!resize()) return;                 // size unchanged (e.g. mobile scroll) → no repaint
  requestFrame();                        // blit cached layer at once (avoids a blank frame)
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (renderer.grid) invalidateField(); }, 120);
});

// ---- draw loop ---------------------------------------------------------
// The expensive field layers are rendered to an offscreen canvas only when the
// scene, view or visible layers change; each frame just blits that cached layer
// and draws lightweight overlays (sources, particles, probe).
// A single coalescing rAF loop: many invalidations within one frame collapse to
// at most one field recompute, so dragging/zooming stay smooth.
let gridDirty = false, layersDirty = false, frameQueued = false;
function tick() {
  frameQueued = false;
  if (gridDirty) { renderer.computeGrid(); renderer.renderField(); gridDirty = layersDirty = false; }
  else if (layersDirty) { renderer.renderField(); layersDirty = false; }
  if (simRunning) simStep();
  draw();
  if (simRunning) requestFrame();   // keep animating while the sim runs
}
function requestFrame() { if (!frameQueued) { frameQueued = true; requestAnimationFrame(tick); } }
function draw() {
  renderer.clear();
  renderer.blitField();
  renderer.drawSources(selectedId);
  drawParticles();
  drawProbe();
  drawLegend();
}
function requestDraw() { requestFrame(); }
function invalidateField() { gridDirty = true; updateForceTile(); requestFrame(); }
function invalidateLayers() { layersDirty = true; requestFrame(); }

// ---- probe overlay -----------------------------------------------------
// Keep the probe pin (and its shooter reach) inside the viewport, so panning or
// zooming never loses it — it slides along the edge instead of vanishing.
function clampProbe() {
  if (!probe) return;
  const m = (AIM_LEN + 14) / view.scale;         // world-space margin for pin + shooter
  const cu = view.center[0], cv = view.center[1], hu = view.spanU / 2, hv = view.spanV / 2;
  let u = probe[view.uAxis], v = probe[view.vAxis];
  u = hu > m ? Math.min(cu + hu - m, Math.max(cu - hu + m, u)) : cu;
  v = hv > m ? Math.min(cv + hv - m, Math.max(cv - hv + m, v)) : cv;
  probe = view.worldFromUV(u, v);
}
function drawProbe() {
  if (!probe) return;
  clampProbe();
  const ctx = renderer.ctx;
  const s = view.toScreen(probe);
  const B = scene.B(probe);
  const comp = view.planeComps(B);
  const mag = P.vlen(B);
  const m2 = Math.hypot(comp.u, comp.v) || 1;
  // Small amber arrow: the field direction here — informational.
  if (mag > 0) {
    const ex = s[0] + comp.u / m2 * FIELD_LEN, ey = s[1] - comp.v / m2 * FIELD_LEN;
    drawArrow(ctx, s[0], s[1], ex, ey, '#ffd24a', 2, 5);
  }
  // Longer red line with a draggable tip (no arrowhead): the launch aim. It
  // stays where you turn it — the particle fires along this direction.
  const tip = [s[0] + aimDir[0] * AIM_LEN, s[1] - aimDir[1] * AIM_LEN];
  ctx.strokeStyle = '#ff4d4d'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(tip[0], tip[1]); ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = '#ff4d4d'; ctx.beginPath(); ctx.arc(tip[0], tip[1], 4.5, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(tip[0], tip[1], 4.5, 0, 7); ctx.stroke();
  // draggable pin: outer ring + centre dot (large enough to grab on touch)
  ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(s[0], s[1], 9, 0, 7); ctx.stroke();
  ctx.fillStyle = '#ffd24a'; ctx.beginPath(); ctx.arc(s[0], s[1], 2.5, 0, 7); ctx.fill();
  const u = UNITS[fieldUnit], dp = Math.abs(mag * u) >= 100 ? 0 : 1;
  document.getElementById('probeReadout').innerHTML =
    `<div><b>|B|</b> ${fmtField(mag)}</div>` +
    `<div>${(B[0] * u).toFixed(dp)}, ${(B[1] * u).toFixed(dp)}, ${(B[2] * u).toFixed(dp)} ${fieldUnit}</div>`;
}

// ---- legend ------------------------------------------------------------
function drawLegend() {
  const ctx = renderer.ctx;
  if (!renderer.grid || !renderer.opts.heatmap) return;
  const w = Math.min(150, view.W - 24), h = 9;
  // self-contained panel, clamped inside the canvas so it can't be clipped
  const pad = 8, panelW = w + pad * 2, panelH = h + 30;
  const px = Math.max(6, view.W - panelW - 10);
  const py = Math.max(6, view.H - panelH - 10);
  const x = px + pad, gy = py + 18;
  ctx.fillStyle = 'rgba(10,12,18,0.66)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(px, py, panelW, panelH, 6);
  else ctx.rect(px, py, panelW, panelH);          // Safari ≤ 15 has no roundRect
  ctx.fill();
  ctx.fillStyle = '#cdd3dd'; ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('|B| (log)', x, py + 12);
  const grad = ctx.createLinearGradient(x, 0, x + w, 0);
  for (let i = 0; i <= 10; i++) grad.addColorStop(i / 10, viridisCss(i / 10));
  ctx.fillStyle = grad; ctx.fillRect(x, gy, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.strokeRect(x, gy, w, h);
  ctx.fillStyle = '#cdd3dd'; ctx.textBaseline = 'top';
  ctx.fillText(fmtFieldShort(Math.pow(10, renderer.range.min)), x, gy + h + 2);
  ctx.textAlign = 'right';
  ctx.fillText(fmtFieldShort(Math.pow(10, renderer.range.max)) + ' ' + fieldUnit, x + w, gy + h + 2);
}
function fmtFieldShort(t) { const v = t * UNITS[fieldUnit]; return v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toPrecision(2); }
import { viridis } from './render.js';
function viridisCss(t) { const c = viridis(t); return `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`; }

// ---- particle simulation ----------------------------------------------
let simDt = 5e-11;          // s per step
let stepsPerFrame = 40;
function drawParticles() {
  const ctx = renderer.ctx;
  for (const p of particles) {
    ctx.strokeStyle = p.color; ctx.lineWidth = 1.6; ctx.beginPath();
    for (let i = 0; i < p.trail.length; i++) {
      const s = view.toScreen(p.trail[i]);
      i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]);
    }
    ctx.stroke();
    if (p.alive) {
      const s = view.toScreen(p.x);
      ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(s[0], s[1], 4, 0, 7); ctx.fill();
    }
  }
}
function simStep() {
  const fieldFn = (x) => scene.EB(x);
  const frameTime = simDt * stepsPerFrame;         // sim-seconds advanced per frame
  const trailGap = view.spanU * 0.004;
  const cw = view.worldFromUV(view.center[0], view.center[1]);  // cull relative to the view, not the origin
  for (const p of particles) {
    if (!p.alive) continue;
    let tacc = 0, sub = 0;
    while (tacc < frameTime && sub < 6000) {
      // Adaptive step: keep dt ≤ gyro-period/24 so the Boris orbit stays
      // accurate even in strong fields (where a fixed dt would under-resolve
      // the gyration and the trajectory would be wrong).
      const bmag = P.vlen(scene.B(p.x));
      const gyroT = bmag > 0 ? (2 * Math.PI * p.mass) / (Math.abs(p.q) * bmag) : Infinity;
      let dt = Math.min(simDt, gyroT / 24, frameTime - tacc);
      if (!(dt > 0)) break;
      const r = P.borisStep(p.x, p.v, p.q, p.mass, dt, fieldFn);
      p.x = r.x; p.v = r.v; tacc += dt; sub++;
      const last = p.trail[p.trail.length - 1];
      if (!last || Math.hypot(p.x[0] - last[0], p.x[1] - last[1], p.x[2] - last[2]) > trailGap) p.trail.push(p.x);
      if (P.vlen(P.vsub(p.x, cw)) > view.spanU * 6) { p.alive = false; break; }
    }
    if (p.trail.length > 6000) p.trail.splice(0, p.trail.length - 6000);
  }
  updateParticleReadout();
}
function startSim() {
  document.getElementById('pauseSim').textContent = 'Pause';
  if (!simRunning) { simRunning = true; requestFrame(); }
}
function updateParticleReadout() {
  const p = particles[particles.length - 1];
  if (!p) return;
  const speed = P.vlen(p.v);
  const KE = 0.5 * p.mass * speed * speed;
  const eV = KE / P.QE;
  const { E, B } = scene.EB(p.x);
  const F = P.lorentzForce(p.q, p.v, E, B);
  document.getElementById('partReadout').innerHTML =
    `<div><b>KE</b> ${eV > 1e3 ? (eV / 1e3).toFixed(1) + ' keV' : eV.toFixed(0) + ' eV'}</div>` +
    `<div><b>v</b> ${speed.toExponential(1)} m/s (${(speed / P.C0 * 100).toFixed(1)}% c)</div>` +
    `<div><b>F</b> ${fmtMag(P.vlen(F), 'N')}</div>`;
}

// ---------------------------------------------------------------------------
// UI construction
// ---------------------------------------------------------------------------
const paramDefs = {
  magnet: [
    ['Material', 'material'],
    ['Br (T)', 'Br', 0.1, 1.6, 0.01],
    ['W (mm)', 'size.0', 1, 100, 0.5],
    ['H (mm)', 'size.1', 1, 100, 0.5],
    ['L / axis (mm)', 'size.2', 1, 100, 0.5],
  ],
  cylinder: [
    ['Material', 'material'],
    ['Br (T)', 'Br', 0.1, 1.6, 0.01],
    ['Dia (mm)', 'dia', 1, 100, 0.5],
    ['Len (mm)', 'len', 1, 100, 0.5],
  ],
  sphere: [
    ['Material', 'material'],
    ['Br (T)', 'Br', 0.1, 1.6, 0.01],
    ['Dia (mm)', 'dia', 1, 100, 0.5],
  ],
  coil: [
    ['Dia (mm)', 'dia', 2, 120, 0.5],
    ['Len (mm)', 'len', 1, 200, 0.5],
    ['Turns', 'turns', 1, 5000, 1],
    ['Current (A)', 'current', -50, 50, 0.1],
    ['Core (µ)', 'core', 1, 5000, 1],
  ],
  loop: [
    ['Dia (mm)', 'dia', 2, 120, 0.5],
    ['Current (A)', 'current', -200, 200, 0.5],
  ],
  wire: [
    ['Len (mm)', 'len', 5, 400, 1],
    ['Current (A)', 'current', -500, 500, 1],
  ],
  dipole: [
    ['Moment (A·m²)', 'moment', -1, 1, 0.001],
  ],
  charge: [
    ['Charge (e)', 'q', -5, 5, 1],
    ['Vel X (m/s)', 'vel.0', -3e7, 3e7, 1e5],
    ['Vel Y (m/s)', 'vel.1', -3e7, 3e7, 1e5],
    ['Vel Z (m/s)', 'vel.2', -3e7, 3e7, 1e5],
  ],
};
const commonDefs = [
  ['X (mm)', 'pos.0', -80, 80, 0.5],
  ['Y (mm)', 'pos.1', -80, 80, 0.5],
  ['Z (mm)', 'pos.2', -80, 80, 0.5],
  ['Yaw °', 'rot.0', -180, 180, 1],
  ['Pitch °', 'rot.1', -180, 180, 1],
  ['Roll °', 'rot.2', -180, 180, 1],
];

function getPath(o, path) { const k = path.split('.'); let v = o; for (const p of k) v = v[isNaN(p) ? p : +p]; return v; }
function setPath(o, path, val) { const k = path.split('.'); let v = o; for (let i = 0; i < k.length - 1; i++) v = v[isNaN(k[i]) ? k[i] : +k[i]]; const last = k[k.length - 1]; v[isNaN(last) ? last : +last] = val; }

function buildInspector() {
  const el = document.getElementById('inspector');
  el.innerHTML = '';
  const s = scene.get(selectedId);
  if (!s) { el.innerHTML = '<p class="hint">Select an object</p>'; updateForceTile(); return; }

  const addRow = (label, path, min, max, step) => {
    const row = document.createElement('label'); row.className = 'row';
    const val = getPath(s, path);
    // keep unit strings like (mm), (T), (A·m²), (µ) in their true case —
    // the label text itself is uppercased by CSS
    const m = label.match(/^(.*?)\s*\((.+)\)$/);
    row.innerHTML = m ? `<span>${m[1]} <span class="lc">(${m[2]})</span></span>` : `<span>${label}</span>`;
    const input = document.createElement('input');
    input.type = 'number'; input.value = val; input.step = step; input.min = min; input.max = max;
    input.addEventListener('input', () => {
      let n = parseFloat(input.value); if (isNaN(n)) return;
      setPath(s, path, n); buildSource(s); invalidateField();
    });
    if (min !== undefined) {
      const rng = document.createElement('input');
      rng.type = 'range'; rng.min = min; rng.max = max; rng.step = step; rng.value = val;
      rng.addEventListener('input', () => { setPath(s, path, parseFloat(rng.value)); input.value = rng.value; buildSource(s); invalidateField(); });
      input.addEventListener('input', () => { rng.value = input.value; });
      row.appendChild(input); row.appendChild(rng);
    } else { row.appendChild(input); }
    el.appendChild(row);
  };

  for (const def of (paramDefs[s.type] || [])) {
    if (def[1] === 'material') {
      const row = document.createElement('label'); row.className = 'row';
      row.innerHTML = `<span>${def[0]}</span>`;
      const sel = document.createElement('select'); sel.id = 'matSel';
      for (const name of Object.keys(MATERIALS)) sel.innerHTML += `<option value="${MATERIALS[name]}">${name}</option>`;
      sel.value = String(nearestMaterial(s.Br));
      sel.addEventListener('change', () => { s.Br = parseFloat(sel.value); buildSource(s); buildInspector(); invalidateField(); });
      row.appendChild(sel); el.appendChild(row);
      continue;
    }
    addRow(...def);
  }
  const hr = document.createElement('hr'); el.appendChild(hr);
  for (const def of commonDefs) addRow(...def);
  updateForceTile();
}

// Force/torque data tile (right panel), kept current on any scene change.
// auto-scaled magnitude formatter, e.g. 12.3 mN, 4.56 µN·m
function fmtMag(x, unit) {
  const a = Math.abs(x);
  if (a === 0) return `0 ${unit}`;
  const p = [[1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'], [1e-18, 'a']];
  for (const [scale, pre] of p) { if (a >= scale || scale === 1e-18) { const v = x / scale; return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${pre}${unit}`; } }
}
// 8-way in-plane direction arrow; ⊙/⊗ when the vector points out of / into the view plane
function dirArrow(vec) {
  const c = view.planeComps(vec), ip = Math.hypot(c.u, c.v);
  if (ip === 0 && c.n === 0) return '';
  if (Math.abs(c.n) > ip) return c.n > 0 ? '⊙' : '⊗';
  const arr = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
  return arr[((Math.round(Math.atan2(c.v, c.u) / (Math.PI / 4)) % 8) + 8) % 8];
}
function updateForceTile() {
  const el = document.getElementById('forceReadout');
  const s = scene.get(selectedId);
  if (!s) { el.textContent = 'Select an object'; return; }
  const ft = scene.forceTorque(s);
  if (!ft || !ft.hasExternal) { el.innerHTML = '<div>Net force needs</div><div class="hint">a second source</div>'; return; }
  if (!ft.valid) { el.innerHTML = '<div>Objects overlap</div><div class="hint">separate to read force</div>'; return; }
  // A net result far below the sum of contribution magnitudes is numerical
  // cancellation to zero, not a measurement — show "≈ 0" rather than noise.
  const Fm = P.vlen(ft.F), tauM = P.vlen(ft.tau);
  const fZero = ft.Fabs > 0 && Fm / ft.Fabs < 1e-7;
  const tZero = ft.tauAbs > 0 && tauM / ft.tauAbs < 1e-7;
  el.innerHTML =
    `<div><b>F</b> ${fZero ? '≈ 0 N' : fmtMag(Fm, 'N') + ' ' + dirArrow(ft.F)}</div>` +
    `<div><b>τ</b> ${tZero ? '≈ 0 N·m' : fmtMag(tauM, 'N·m')}</div>`;
}
function nearestMaterial(Br) {
  let best = 1.30, bd = 1e9;
  for (const v of Object.values(MATERIALS)) { const d = Math.abs(v - Br); if (d < bd) { bd = d; best = v; } }
  return best;
}

function buildList() {
  const el = document.getElementById('objlist'); el.innerHTML = '';
  for (const s of scene.sources) {
    const row = document.createElement('div');
    row.className = 'obj' + (s.id === selectedId ? ' sel' : '');
    row.innerHTML = `<span class="dot" style="background:${s.color}"></span><span class="onm">${s.name}</span>` +
      `<button class="vis" title="Show/hide">${s.visible ? '👁' : '∅'}</button>` +
      `<button class="del" title="Delete">✕</button>`;
    row.querySelector('.onm').addEventListener('click', () => { selectedId = s.id; buildList(); buildInspector(); requestDraw(); });
    row.querySelector('.vis').addEventListener('click', (e) => { e.stopPropagation(); s.visible = !s.visible; buildList(); invalidateField(); });
    row.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation(); scene.remove(s.id);
      if (selectedId === s.id) selectedId = null;
      buildList(); buildInspector(); invalidateField();
    });
    el.appendChild(row);
  }
}

// ---- add-object buttons ------------------------------------------------
document.querySelectorAll('[data-add]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const s = defaultSource(btn.dataset.add);
    scene.add(s); selectedId = s.id; buildList(); buildInspector(); invalidateField();
  });
});

// ---- layer toggles -----------------------------------------------------
function bindToggle(id, key) {
  const el = document.getElementById(id);
  el.checked = renderer.opts[key];
  el.addEventListener('change', () => { renderer.opts[key] = el.checked; invalidateLayers(); });
}
bindToggle('tglHeat', 'heatmap'); bindToggle('tglLines', 'lines');
bindToggle('tglVec', 'vectors'); bindToggle('tglGrid', 'grid');

// ---- view controls -----------------------------------------------------
const planes = {
  'XZ · side': [0, 2, 1],
  'XY · top':  [0, 1, 2],
  'YZ · front':[1, 2, 0],
};
const planeSel = document.getElementById('planeSel');
for (const name of Object.keys(planes)) planeSel.innerHTML += `<option value="${name}">${name.toUpperCase()}</option>`;
planeSel.addEventListener('change', () => {
  const [u, v, n] = planes[planeSel.value]; view.uAxis = u; view.vAxis = v; view.nAxis = n;
  document.getElementById('axU').textContent = view.axisLabel(u);
  document.getElementById('axV').textContent = view.axisLabel(v);
  invalidateField();
});
const sliceInput = document.getElementById('sliceInput');
sliceInput.addEventListener('input', () => {
  const v = parseFloat(sliceInput.value);
  if (!isFinite(v)) return;               // empty/partial input must not poison the field with NaN
  view.slice = v / 1000; invalidateField();
});
const unitSel = document.getElementById('unitSel');
for (const u of Object.keys(UNITS)) unitSel.innerHTML += `<option>${u}</option>`;
unitSel.value = fieldUnit;
unitSel.addEventListener('change', () => { fieldUnit = unitSel.value; requestDraw(); });

// ---- snap, pan & zoom --------------------------------------------------
let snap = false, snapStep = 5;               // mm
const maybeSnap = (v) => snap ? Math.round(v / snapStep) * snapStep : v;
const snapChk = document.getElementById('snapChk');
snapChk.addEventListener('change', () => { snap = snapChk.checked; });
document.getElementById('snapStep').addEventListener('change', (e) => { snapStep = Math.max(0.5, parseFloat(e.target.value) || 5); });

function zoomBy(factor, sx, sy) {
  // keep the world point under (sx,sy) fixed while zooming
  const before = (sx !== undefined) ? view.toWorld(sx, sy) : null;
  view.spanU = Math.max(0.004, Math.min(4, view.spanU * factor));
  if (before) {
    const after = view.toWorld(sx, sy);
    view.center[0] += before[view.uAxis] - after[view.uAxis];
    view.center[1] += before[view.vAxis] - after[view.vAxis];
  }
  invalidateField();
}
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomBy(Math.exp(e.deltaY * 0.0012), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

// on-canvas zoom / fit controls
document.getElementById('zoomIn').addEventListener('click', () => zoomBy(1 / 1.3, view.W / 2, view.H / 2));
document.getElementById('zoomOut').addEventListener('click', () => zoomBy(1.3, view.W / 2, view.H / 2));
document.getElementById('zoomReset').addEventListener('click', () => { view.spanU = 0.16; view.center = [0, 0]; invalidateField(); });
document.getElementById('zoomFit').addEventListener('click', fitView);
function fitView() {
  const vis = scene.sources.filter((s) => s.visible);
  if (!vis.length) return;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const s of vis) {
    const e = sourceExtent(s), o = s._origin;
    uMin = Math.min(uMin, o[view.uAxis] - e); uMax = Math.max(uMax, o[view.uAxis] + e);
    vMin = Math.min(vMin, o[view.vAxis] - e); vMax = Math.max(vMax, o[view.vAxis] + e);
  }
  view.center = [(uMin + uMax) / 2, (vMin + vMax) / 2];
  const span = Math.max(uMax - uMin, (vMax - vMin) * view.W / view.H, 0.006) * 1.5;
  view.spanU = Math.max(0.008, Math.min(4, span));
  invalidateField();
}

// Pointer events unify mouse / touch / pen. A single pointer drags whatever is
// under it — the ⊕ field-probe pin, a source object, or (on empty space) the
// view (pan). Two pointers pinch-zoom. The wheel and zoom buttons also zoom.
let dragMode = null, dragStart = null, dragObjStart = null;
const pointers = new Map();
let pinch = null;
const localXY = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
const nearProbe = (sx, sy) => { if (!probe) return false; const p = view.toScreen(probe); return Math.hypot(p[0] - sx, p[1] - sy) < 20; };
const aimTipScreen = () => { if (!probe) return null; const p = view.toScreen(probe); return [p[0] + aimDir[0] * AIM_LEN, p[1] - aimDir[1] * AIM_LEN]; };
const nearAimTip = (sx, sy) => { const t = aimTipScreen(); return t && Math.hypot(t[0] - sx, t[1] - sy) < 16; };
// Point the aim from the probe pin toward a screen position (unit vector, +v up).
function setAimTo(sx, sy) {
  const p = view.toScreen(probe);
  const du = sx - p[0], dv = -(sy - p[1]), L = Math.hypot(du, dv) || 1;
  aimDir = [du / L, dv / L];
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const [sx, sy] = localXY(e); pointers.set(e.pointerId, [sx, sy]);
  if (pointers.size === 2) {                       // begin pinch
    const p = [...pointers.values()];
    pinch = { dist: Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) || 1, span: view.spanU };
    dragMode = null; return;
  }
  if (nearAimTip(sx, sy)) {                         // grab the red shooter tip
    dragMode = 'aim'; setAimTo(sx, sy); canvas.style.cursor = 'grabbing'; requestDraw(); return;
  }
  if (nearProbe(sx, sy)) {                          // grab the field-probe pin
    dragMode = 'probe'; canvas.style.cursor = 'grabbing'; return;
  }
  const hit = pickSource(sx, sy);
  if (hit) {
    if (hit.id !== selectedId) { selectedId = hit.id; buildList(); buildInspector(); requestDraw(); }
    dragMode = 'obj'; dragStart = [sx, sy]; dragObjStart = hit.pos.slice();
    canvas.style.cursor = 'grabbing';
  } else {
    // clicking empty space clears the selection (inspector + ring)
    if (selectedId !== null) { selectedId = null; buildList(); buildInspector(); requestDraw(); }
    dragMode = 'pan'; dragStart = [sx, sy, view.center[0], view.center[1]];
    canvas.style.cursor = 'grabbing';
  }
});
canvas.addEventListener('pointermove', (e) => {
  const [sx, sy] = localXY(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [sx, sy]);
  if (pinch && pointers.size >= 2) {
    const p = [...pointers.values()];
    const dist = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) || 1;
    const mx = (p[0][0] + p[1][0]) / 2, my = (p[0][1] + p[1][1]) / 2;
    const before = view.toWorld(mx, my);
    view.spanU = Math.max(0.004, Math.min(4, pinch.span * pinch.dist / dist));
    const after = view.toWorld(mx, my);
    view.center[0] += before[view.uAxis] - after[view.uAxis];
    view.center[1] += before[view.vAxis] - after[view.vAxis];
    invalidateField(); return;
  }
  if (dragMode === 'aim') {
    setAimTo(sx, sy); requestDraw();
  } else if (dragMode === 'probe') {
    probe = view.toWorld(sx, sy); requestDraw();
  } else if (dragMode === 'pan') {
    view.center[0] = dragStart[2] - (sx - dragStart[0]) / view.scale;
    view.center[1] = dragStart[3] + (sy - dragStart[1]) / view.scale;
    invalidateField();
  } else if (dragMode === 'obj') {
    const s = scene.get(selectedId); if (!s) return;
    const du = (sx - dragStart[0]) / view.scale * 1000;   // mm
    const dv = -(sy - dragStart[1]) / view.scale * 1000;
    s.pos[view.uAxis] = maybeSnap(dragObjStart[view.uAxis] + du);
    s.pos[view.vAxis] = maybeSnap(dragObjStart[view.vAxis] + dv);
    buildSource(s); invalidateField();               // inspector refreshed on drop
  } else if (e.pointerType === 'mouse') {
    // idle hover: cursor feedback only — the probe pin is moved by dragging it
    canvas.style.cursor = nearAimTip(sx, sy) || nearProbe(sx, sy) || pickSource(sx, sy) ? 'grab' : 'crosshair';
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) {
    if (dragMode === 'obj') buildInspector();        // sync numeric fields once
    dragMode = null; canvas.style.cursor = 'crosshair';
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// keyboard: arrow keys nudge the selected object, Delete/Backspace removes it
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  const s = scene.get(selectedId); if (!s) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    scene.remove(s.id); selectedId = null; buildList(); buildInspector(); invalidateField();
    e.preventDefault(); return;
  }
  const step = (snap ? snapStep : 1) * (e.shiftKey ? 5 : 1);
  const move = { ArrowLeft: [view.uAxis, -step], ArrowRight: [view.uAxis, step],
                 ArrowUp: [view.vAxis, step], ArrowDown: [view.vAxis, -step] }[e.key];
  if (!move) return;
  s.pos[move[0]] += move[1];
  buildSource(s); buildInspector(); invalidateField();
  e.preventDefault();
});

// clear-all button
document.getElementById('clearAll').addEventListener('click', () => {
  scene.sources = []; selectedId = null; particles.length = 0; simRunning = false;
  document.getElementById('pauseSim').textContent = 'Pause';
  document.getElementById('partReadout').textContent = 'Launch a particle';
  buildList(); buildInspector(); invalidateField();
});

// Hit-test in screen space: a click anywhere within an object's projected
// footprint selects it (min 14 px so tiny objects stay grabbable). Front-most
// (last-added) object wins.
function pickSource(sx, sy) {
  for (let i = scene.sources.length - 1; i >= 0; i--) {
    const s = scene.sources[i]; if (!s.visible) continue;
    const p = view.toScreen(s._origin);
    const r = Math.max(14, sourceExtent(s) * view.scale);
    if (Math.hypot(p[0] - sx, p[1] - sy) < r) return s;
  }
  return null;
}

// ---- particle panel ----------------------------------------------------
// Launch from the field-probe pin, along the red shooter aim (which stays where
// the user turned it). Falls back to the left of the view when the probe is unset.
function launchParticle() {
  const type = document.getElementById('pType').value;
  const q = type === 'proton' ? P.QE : -P.QE;
  const mass = type === 'proton' ? P.MP : P.ME;
  const speed = Math.abs(parseFloat(document.getElementById('pSpeed').value)) || 3e6;
  const pos = probe ? probe.slice() : view.worldFromUV(view.center[0] - view.spanU * 0.4, view.center[1]);
  const dir = [0, 0, 0]; dir[view.uAxis] = aimDir[0]; dir[view.vAxis] = aimDir[1];
  const vel = dir.map((c) => c * speed);
  particles.push({ x: pos, v: vel, q, mass, trail: [pos.slice()], color: q < 0 ? '#4aa3ff' : '#ff7a4a', alive: true });
  startSim();
}
document.getElementById('launch').addEventListener('click', launchParticle);
document.getElementById('clearParts').addEventListener('click', () => {
  particles.length = 0; simRunning = false;
  document.getElementById('pauseSim').textContent = 'Pause';
  document.getElementById('partReadout').textContent = 'Launch a particle'; requestDraw();
});
document.getElementById('pauseSim').addEventListener('click', (e) => {
  simRunning = !simRunning; e.target.textContent = simRunning ? 'Pause' : 'Resume';
  if (simRunning) requestFrame();
});

// ---- presets / scenarios ----------------------------------------------
const presets = {
  'Two bar magnets': () => {
    scene.sources = [];
    const a = defaultSource('magnet'); a.name = 'Magnet A'; a.pos = [-20, 0, 0]; a.rot = [0, 90, 0];
    const b = defaultSource('magnet'); b.name = 'Magnet B'; b.pos = [20, 0, 0]; b.rot = [0, 90, 0];
    scene.add(a); scene.add(b); view.spanU = 0.14;
  },
  'Solenoid electromagnet': () => {
    scene.sources = [];
    const c = defaultSource('coil'); c.name = 'Solenoid'; c.len = 60; c.dia = 24; c.turns = 400; c.current = 3;
    scene.add(c); view.spanU = 0.16;
  },
  'Helmholtz coils': () => {
    scene.sources = [];
    const r = 30;
    const a = defaultSource('loop'); a.name = 'Coil 1'; a.dia = 2 * r; a.current = 20; a.pos = [0, 0, -r / 2];
    const b = defaultSource('loop'); b.name = 'Coil 2'; b.dia = 2 * r; b.current = 20; b.pos = [0, 0, r / 2];
    scene.add(a); scene.add(b); view.spanU = 0.12;
  },
  'Horseshoe (two magnets)': () => {
    scene.sources = [];
    const a = defaultSource('magnet'); a.name = 'N pole'; a.pos = [-12, 0, 10]; a.size = [8, 8, 24]; a.rot = [0, 0, 0];
    const b = defaultSource('magnet'); b.name = 'S pole'; b.pos = [12, 0, 10]; b.size = [8, 8, 24]; b.rot = [0, 180, 0];
    scene.add(a); scene.add(b); view.spanU = 0.12;
  },
  'Wire + compass field': () => {
    scene.sources = [];
    const w = defaultSource('wire'); w.name = 'Wire'; w.len = 120; w.current = 60; w.rot = [0, 0, 0];
    scene.add(w); view.spanU = 0.12;
    planeSel.value = 'XY · top'; planeSel.dispatchEvent(new Event('change'));
  },
  'Cyclotron orbit (e⁻ in B)': () => {
    // Coil axis along Z ⇒ B along Z inside.  View the XY plane (from above,
    // perpendicular to B) so the electron's circular gyration is seen face-on.
    scene.sources = [];
    const c = defaultSource('coil'); c.name = 'Field coil'; c.len = 100; c.dia = 100; c.turns = 120; c.current = 4;
    scene.add(c); view.spanU = 0.11;
    planeSel.value = 'XY · top'; planeSel.dispatchEvent(new Event('change'));
    document.getElementById('pType').value = 'electron';
    document.getElementById('pSpeed').value = 2.5e7;
  },
};
const presetSel = document.getElementById('presetSel');
presetSel.innerHTML = '<option value="">SCENARIO…</option>';
for (const name of Object.keys(presets)) presetSel.innerHTML += `<option value="${name}">${name.toUpperCase()}</option>`;
presetSel.addEventListener('change', () => {
  if (!presets[presetSel.value]) return;
  particles.length = 0; simRunning = false;
  document.getElementById('pauseSim').textContent = 'Pause';
  presets[presetSel.value]();
  scene.rebuild(); selectedId = scene.sources[0] ? scene.sources[0].id : null;
  presetSel.value = ''; buildList(); buildInspector(); invalidateField();
});

// ---- init --------------------------------------------------------------
function init() {
  resize();
  // start with a single, strongest-grade sphere magnet
  const s = defaultSource('sphere'); s.name = 'Sphere'; s.Br = 1.45; s.dia = 20;
  scene.add(s); view.spanU = 0.12;
  selectedId = s.id;
  // snap on @1mm; field lines off, arrows on
  snap = true; snapStep = 1;
  snapChk.checked = true; document.getElementById('snapStep').value = 1;
  document.getElementById('tglLines').checked = renderer.opts.lines;
  document.getElementById('tglVec').checked = renderer.opts.vectors;
  document.getElementById('axU').textContent = view.axisLabel(view.uAxis);
  document.getElementById('axV').textContent = view.axisLabel(view.vAxis);
  // place the draggable field-probe pin where it's visible
  probe = view.worldFromUV(view.center[0] + view.spanU * 0.3, view.center[1]);
  buildList(); buildInspector();
  invalidateField();
}
init();
