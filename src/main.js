// main.js — app glue: scene management, UI panels, interaction, particle sim.
import * as P from './physics.js';
import { Scene, defaultSource, buildSource, momentOf, MATERIALS } from './sources.js';
import { Renderer, View } from './render.js';

const scene = new Scene();
const view = new View();
const canvas = document.getElementById('view');
const renderer = new Renderer(canvas, scene, view);

let selectedId = null;
let probe = null;           // last probed world point
const particles = [];       // { x, v, q, mass, trail:[], color, alive }
let simRunning = false;

// ---- field unit display ------------------------------------------------
const UNITS = { T: 1, mT: 1e3, µT: 1e6, G: 1e4, mG: 1e7 };
let fieldUnit = 'mT';
function fmtField(teslas) {
  const val = teslas * UNITS[fieldUnit];
  const a = Math.abs(val);
  const digits = a >= 100 ? 1 : a >= 1 ? 2 : 3;
  return `${val.toFixed(digits)} ${fieldUnit}`;
}
function fmtVec(v, unitScale, unit, d = 2) {
  return `(${(v[0] * unitScale).toFixed(d)}, ${(v[1] * unitScale).toFixed(d)}, ${(v[2] * unitScale).toFixed(d)}) ${unit}`;
}

// ---- canvas sizing -----------------------------------------------------
function resize() {
  const wrap = canvas.parentElement;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = wrap.clientWidth, h = wrap.clientHeight;
  view.W = w; view.H = h;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  renderer.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
let resizeTimer = null;
window.addEventListener('resize', () => {
  resize();
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
function invalidateField() { gridDirty = true; requestFrame(); }
function invalidateLayers() { layersDirty = true; requestFrame(); }

// ---- probe overlay -----------------------------------------------------
function drawProbe() {
  if (!probe) return;
  const ctx = renderer.ctx;
  const s = view.toScreen(probe);
  const B = scene.B(probe);
  const comp = view.planeComps(B);
  const mag = P.vlen(B);
  ctx.strokeStyle = '#ffd24a'; ctx.fillStyle = '#ffd24a'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(s[0], s[1], 4, 0, 7); ctx.stroke();
  // in-plane B arrow (fixed pixel length)
  const m2 = Math.hypot(comp.u, comp.v) || 1;
  const len = 34;
  const ex = s[0] + comp.u / m2 * len, ey = s[1] - comp.v / m2 * len;
  ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(ex, ey); ctx.stroke();
  document.getElementById('probeReadout').innerHTML =
    `<b>|B|</b> ${fmtField(mag)}<br>` +
    `<b>B</b> = (${fmtField(B[0])}, ${fmtField(B[1])}, ${fmtField(B[2])})<br>` +
    `in-plane ${fmtField(Math.hypot(comp.u, comp.v))} · out-of-plane ${fmtField(comp.n)}`;
}

// ---- legend ------------------------------------------------------------
function drawLegend() {
  const ctx = renderer.ctx;
  if (!renderer.grid || !renderer.opts.heatmap) return;
  const x = view.W - 168, y = view.H - 46, w = 150, h = 10;
  const grad = ctx.createLinearGradient(x, 0, x + w, 0);
  for (let i = 0; i <= 10; i++) {
    const c = renderer.grid ? viridisCss(i / 10) : '#000';
    grad.addColorStop(i / 10, c);
  }
  ctx.fillStyle = grad; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#cdd3dd'; ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(fmtFieldShort(Math.pow(10, renderer.range.min)), x, y + h + 2);
  ctx.textAlign = 'right';
  ctx.fillText(fmtFieldShort(Math.pow(10, renderer.range.max)), x + w, y + h + 2);
  ctx.textAlign = 'center';
  ctx.fillText('|B| (log)', x + w / 2, y - 12);
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
  for (const p of particles) {
    if (!p.alive) continue;
    for (let k = 0; k < stepsPerFrame; k++) {
      const r = P.borisStep(p.x, p.v, p.q, p.mass, simDt, fieldFn);
      p.x = r.x; p.v = r.v;
      if (k % 4 === 0) p.trail.push(p.x);
      if (P.vlen(p.x) > view.spanU * 6) { p.alive = false; break; }
    }
    if (p.trail.length > 4000) p.trail.splice(0, p.trail.length - 4000);
  }
  updateParticleReadout();
}
function startSim() { if (!simRunning) { simRunning = true; requestFrame(); } }
function updateParticleReadout() {
  const p = particles[particles.length - 1];
  if (!p) return;
  const speed = P.vlen(p.v);
  const KE = 0.5 * p.mass * speed * speed;
  const eV = KE / P.QE;
  const { E, B } = scene.EB(p.x);
  const F = P.lorentzForce(p.q, p.v, E, B);
  document.getElementById('partReadout').innerHTML =
    `speed ${speed.toExponential(3)} m/s (${(speed / P.C0 * 100).toFixed(2)}% c)<br>` +
    `KE ${eV > 1e3 ? (eV / 1e3).toFixed(2) + ' keV' : eV.toFixed(1) + ' eV'}<br>` +
    `B here ${fmtField(P.vlen(B))} · |F| ${P.vlen(F).toExponential(2)} N`;
}

// ---------------------------------------------------------------------------
// UI construction
// ---------------------------------------------------------------------------
const paramDefs = {
  magnet: [
    ['Material', 'material'],
    ['Remanence Br (T)', 'Br', 0.1, 1.6, 0.01],
    ['Size X (mm)', 'size.0', 1, 100, 0.5],
    ['Size Y (mm)', 'size.1', 1, 100, 0.5],
    ['Size Z / axis (mm)', 'size.2', 1, 100, 0.5],
  ],
  cylinder: [
    ['Material', 'material'],
    ['Remanence Br (T)', 'Br', 0.1, 1.6, 0.01],
    ['Diameter (mm)', 'dia', 1, 100, 0.5],
    ['Length (mm)', 'len', 1, 100, 0.5],
  ],
  coil: [
    ['Diameter (mm)', 'dia', 2, 120, 0.5],
    ['Length (mm)', 'len', 1, 200, 0.5],
    ['Turns', 'turns', 1, 5000, 1],
    ['Current (A)', 'current', -50, 50, 0.1],
    ['Core µ factor (approx)', 'core', 1, 5000, 1],
  ],
  loop: [
    ['Diameter (mm)', 'dia', 2, 120, 0.5],
    ['Current (A)', 'current', -200, 200, 0.5],
  ],
  wire: [
    ['Length (mm)', 'len', 5, 400, 1],
    ['Current (A)', 'current', -500, 500, 1],
  ],
  dipole: [
    ['Moment m (A·m²)', 'moment', -1, 1, 0.001],
  ],
  charge: [
    ['Charge (e)', 'q', -5, 5, 1],
    ['Velocity X (m/s)', 'vel.0', -3e7, 3e7, 1e5],
    ['Velocity Y (m/s)', 'vel.1', -3e7, 3e7, 1e5],
    ['Velocity Z (m/s)', 'vel.2', -3e7, 3e7, 1e5],
  ],
};
const commonDefs = [
  ['Pos X (mm)', 'pos.0', -80, 80, 0.5],
  ['Pos Y (mm)', 'pos.1', -80, 80, 0.5],
  ['Pos Z (mm)', 'pos.2', -80, 80, 0.5],
  ['Yaw ° (about Z)', 'rot.0', -180, 180, 1],
  ['Pitch ° (about Y)', 'rot.1', -180, 180, 1],
  ['Roll ° (about X)', 'rot.2', -180, 180, 1],
];

function getPath(o, path) { const k = path.split('.'); let v = o; for (const p of k) v = v[isNaN(p) ? p : +p]; return v; }
function setPath(o, path, val) { const k = path.split('.'); let v = o; for (let i = 0; i < k.length - 1; i++) v = v[isNaN(k[i]) ? k[i] : +k[i]]; const last = k[k.length - 1]; v[isNaN(last) ? last : +last] = val; }

function buildInspector() {
  const el = document.getElementById('inspector');
  el.innerHTML = '';
  const s = scene.get(selectedId);
  if (!s) { el.innerHTML = '<p class="hint">Select an object to edit its parameters, or add one above.</p>'; return; }

  const title = document.createElement('div'); title.className = 'insp-title';
  title.innerHTML = `<span class="dot" style="background:${s.color}"></span>` +
    `<input id="nm" value="${s.name}"> <button id="del" class="danger">✕</button>`;
  el.appendChild(title);
  title.querySelector('#nm').addEventListener('input', (e) => { s.name = e.target.value; buildList(); });
  title.querySelector('#del').addEventListener('click', () => { scene.remove(s.id); selectedId = null; buildList(); buildInspector(); invalidateField(); });

  const addRow = (label, path, min, max, step) => {
    const row = document.createElement('label'); row.className = 'row';
    const val = getPath(s, path);
    row.innerHTML = `<span>${label}</span>`;
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
      const sel = document.createElement('select');
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

  // force / torque readout
  if (momentOf(s)) {
    const ft = scene.forceTorque(s);
    if (ft) {
      const info = document.createElement('div'); info.className = 'ft';
      info.innerHTML =
        `<b>Net force</b> ${P.vlen(ft.F).toExponential(2)} N ${fmtVec(ft.F, 1, 'N', 2)}<br>` +
        `<b>Torque</b> ${P.vlen(ft.tau).toExponential(2)} N·m<br>` +
        `<b>Moment</b> ${P.vlen(ft.moment).toExponential(2)} A·m² · <b>B here</b> ${fmtField(P.vlen(ft.Bext))}` +
        `<div class="hint">Dipole approximation — exact for well-separated bodies.</div>`;
      el.appendChild(info);
    }
  }
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
      `<button class="vis">${s.visible ? '👁' : '∅'}</button>`;
    row.querySelector('.onm').addEventListener('click', () => { selectedId = s.id; buildList(); buildInspector(); requestDraw(); });
    row.querySelector('.vis').addEventListener('click', (e) => { e.stopPropagation(); s.visible = !s.visible; buildList(); invalidateField(); });
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
  'XZ (side, slice Y)': [0, 2, 1],
  'XY (top, slice Z)':  [0, 1, 2],
  'YZ (front, slice X)':[1, 2, 0],
};
const planeSel = document.getElementById('planeSel');
for (const name of Object.keys(planes)) planeSel.innerHTML += `<option>${name}</option>`;
planeSel.addEventListener('change', () => {
  const [u, v, n] = planes[planeSel.value]; view.uAxis = u; view.vAxis = v; view.nAxis = n;
  document.getElementById('axU').textContent = view.axisLabel(u);
  document.getElementById('axV').textContent = view.axisLabel(v);
  invalidateField();
});
const sliceInput = document.getElementById('sliceInput');
sliceInput.addEventListener('input', () => { view.slice = parseFloat(sliceInput.value) / 1000; invalidateField(); });
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
  const pts = scene.sources.filter((s) => s.visible).map((s) => s._origin);
  if (!pts.length) return;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const p of pts) {
    uMin = Math.min(uMin, p[view.uAxis]); uMax = Math.max(uMax, p[view.uAxis]);
    vMin = Math.min(vMin, p[view.vAxis]); vMax = Math.max(vMax, p[view.vAxis]);
  }
  view.center = [(uMin + uMax) / 2, (vMin + vMax) / 2];
  const span = Math.max(uMax - uMin, (vMax - vMin) * view.W / view.H, 0.02) * 1.8 + 0.04;
  view.spanU = Math.max(0.02, Math.min(4, span));
  invalidateField();
}

let dragMode = null, dragStart = null, dragObjStart = null, probeHover = null;
canvas.addEventListener('mousedown', (e) => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const hit = pickSource(sx, sy);
  if (hit && !e.shiftKey) {
    if (hit.id !== selectedId) { selectedId = hit.id; buildList(); buildInspector(); }
    dragMode = 'obj'; dragStart = [sx, sy]; dragObjStart = hit.pos.slice();
    canvas.style.cursor = 'grabbing';
  } else if (e.shiftKey) {
    probe = view.toWorld(sx, sy); requestDraw();
  } else {
    dragMode = 'pan'; dragStart = [sx, sy, view.center[0], view.center[1]];
    canvas.style.cursor = 'grabbing';
  }
});
window.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (dragMode === 'pan') {
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
  } else {
    // hover probe (cheap: reuse cached field layer)
    probeHover = view.toWorld(sx, sy); probe = probeHover; requestDraw();
    canvas.style.cursor = pickSource(sx, sy) ? 'grab' : 'crosshair';
  }
});
window.addEventListener('mouseup', () => {
  if (dragMode === 'obj') buildInspector();          // sync numeric fields once
  dragMode = null; canvas.style.cursor = 'crosshair';
});

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
  buildList(); buildInspector(); invalidateField();
});

function pickSource(sx, sy) {
  for (let i = scene.sources.length - 1; i >= 0; i--) {
    const s = scene.sources[i]; if (!s.visible) continue;
    const p = view.toScreen(s._origin);
    if (Math.hypot(p[0] - sx, p[1] - sy) < 22) return s;
  }
  return null;
}

// ---- particle panel ----------------------------------------------------
function launchParticle() {
  const type = document.getElementById('pType').value;
  let q, mass;
  if (type === 'electron') { q = -P.QE; mass = P.ME; }
  else if (type === 'proton') { q = P.QE; mass = P.MP; }
  else { q = parseFloat(document.getElementById('pQ').value) * P.QE; mass = parseFloat(document.getElementById('pM').value) * P.ME; }
  const pos = ['pX', 'pY', 'pZ'].map((id) => parseFloat(document.getElementById(id).value) / 1000);
  const vel = ['pVX', 'pVY', 'pVZ'].map((id) => parseFloat(document.getElementById(id).value));
  particles.push({ x: pos, v: vel, q, mass, trail: [pos.slice()], color: q < 0 ? '#4aa3ff' : '#ff7a4a', alive: true });
  startSim();
}
document.getElementById('launch').addEventListener('click', launchParticle);
document.getElementById('clearParts').addEventListener('click', () => { particles.length = 0; simRunning = false; requestDraw(); });
document.getElementById('pauseSim').addEventListener('click', (e) => {
  simRunning = !simRunning; e.target.textContent = simRunning ? 'Pause' : 'Resume';
  if (simRunning) requestFrame();
});
document.getElementById('simSpeed').addEventListener('input', (e) => { simDt = Math.pow(10, parseFloat(e.target.value)); document.getElementById('dtLabel').textContent = simDt.toExponential(1) + ' s'; });

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
    planeSel.value = 'XY (top, slice Z)'; planeSel.dispatchEvent(new Event('change'));
  },
  'Cyclotron orbit (e⁻ in B)': () => {
    // Coil axis along Z ⇒ B along Z inside.  View the XY plane (from above,
    // perpendicular to B) so the electron's circular gyration is seen face-on.
    scene.sources = [];
    const c = defaultSource('coil'); c.name = 'Field coil'; c.len = 100; c.dia = 100; c.turns = 120; c.current = 4;
    scene.add(c); view.spanU = 0.11;
    planeSel.value = 'XY (top, slice Z)'; planeSel.dispatchEvent(new Event('change'));
    document.getElementById('pType').value = 'electron';
    document.getElementById('pX').value = 0; document.getElementById('pY').value = 0; document.getElementById('pZ').value = 0;
    document.getElementById('pVX').value = 0; document.getElementById('pVY').value = 2.5e7; document.getElementById('pVZ').value = 0;
  },
};
const presetSel = document.getElementById('presetSel');
presetSel.innerHTML = '<option value="">Load scenario…</option>';
for (const name of Object.keys(presets)) presetSel.innerHTML += `<option>${name}</option>`;
presetSel.addEventListener('change', () => {
  if (!presets[presetSel.value]) return;
  particles.length = 0; simRunning = false;
  presets[presetSel.value]();
  scene.rebuild(); selectedId = scene.sources[0] ? scene.sources[0].id : null;
  presetSel.value = ''; buildList(); buildInspector(); invalidateField();
});

// ---- init --------------------------------------------------------------
function init() {
  resize();
  presets['Two bar magnets'](); scene.rebuild();
  selectedId = scene.sources[0].id;
  document.getElementById('axU').textContent = view.axisLabel(view.uAxis);
  document.getElementById('axV').textContent = view.axisLabel(view.vAxis);
  buildList(); buildInspector();
  invalidateField();
}
init();
