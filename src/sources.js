// sources.js — user-facing field sources built on the verified physics core.
// Each source carries a world position + orientation and type-specific params.
// buildSource() precomputes caches (rotation matrix, world-space wire segments);
// sourceField() returns { B, E } in tesla / (V/m) at a world point.
import * as P from './physics.js';

// Typical remanence Br [T] by magnet material / NdFeB grade.
export const MATERIALS = {
  'N35 (NdFeB)': 1.17,
  'N42 (NdFeB)': 1.30,
  'N48 (NdFeB)': 1.40,
  'N52 (NdFeB)': 1.45,
  'SmCo':        1.05,
  'Alnico':      1.25,
  'Ferrite/Ceramic': 0.40,
};

let _id = 1;
export const nextId = () => _id++;

// Default parameter sets. Lengths in millimetres in the UI; converted to metres
// on build. Everything here is in UI units (mm, A, degrees) except noted.
export function defaultSource(type) {
  const base = {
    id: nextId(), type, name: '', visible: true,
    pos: [0, 0, 0],            // mm
    rot: [0, 0, 0],            // yaw,pitch,roll in degrees
    color: pickColor(),
  };
  switch (type) {
    case 'magnet':   return { ...base, name: 'Bar magnet',    size: [10, 10, 20], Br: 1.30 };
    case 'cylinder': return { ...base, name: 'Disc magnet',   dia: 12, len: 6,   Br: 1.30, seg: 48 };
    case 'sphere':   return { ...base, name: 'Sphere magnet', dia: 12, Br: 1.30 };
    case 'coil':     return { ...base, name: 'Electromagnet', dia: 20, len: 30,  turns: 200, current: 2.0, core: 1 };
    case 'loop':     return { ...base, name: 'Current loop',  dia: 20, current: 10 };
    case 'wire':     return { ...base, name: 'Straight wire', len: 60, current: 20 };
    case 'dipole':   return { ...base, name: 'Dipole',        moment: 0.05 };
    case 'charge':   return { ...base, name: 'Moving charge', q: -1, vel: [0, 0, 1e6], speedScale: 1 };
    default: throw new Error('unknown source type ' + type);
  }
}

const PALETTE = ['#e6483d', '#2f8fe0', '#37b36b', '#e0952f', '#9b5de5', '#e05f9e', '#20c4c4', '#8a8f98'];
let _cix = 0;
function pickColor() { return PALETTE[(_cix++) % PALETTE.length]; }

const mm = (v) => v / 1000;      // mm -> m
const deg = (v) => v * Math.PI / 180;

// Build world-space caches. Call whenever pos/rot/params change.
export function buildSource(s) {
  const R = P.eulerToMatrix(deg(s.rot[0]), deg(s.rot[1]), deg(s.rot[2]));
  const origin = [mm(s.pos[0]), mm(s.pos[1]), mm(s.pos[2])];
  s._R = R;
  s._origin = origin;
  s._segments = null;   // straight-wire filaments: [{ pts:[world…], I }]
  s._loops = null;      // circular loops in LOCAL frame: [{ z, I }] with radius s._loopR
  s._loopR = 0;

  const toWorld = (local) => P.vadd(origin, P.matVec(R, local));

  // Circular current sources (loop / electromagnet / cylinder magnet) are
  // modelled as one or more coaxial circular loops evaluated with the exact
  // elliptic-integral formula — far faster and more accurate than polygonising
  // each turn into Biot–Savart segments.
  if (s.type === 'loop') {
    s._loopR = mm(s.dia) / 2;
    s._loops = [{ z: 0, I: s.current }];
  } else if (s.type === 'coil') {
    // Electromagnet: stack of loops whose total ampere-turns (turns × current)
    // is preserved. Elliptic loops are cheap, so we can use plenty of them.
    const L = mm(s.len);
    const samples = Math.max(4, Math.min(40, s.turns));
    const Iloop = s.current * s.turns / samples * (s.core || 1);
    s._loopR = mm(s.dia) / 2;
    s._loops = [];
    for (let i = 0; i < samples; i++) s._loops.push({ z: -L / 2 + L * (i + 0.5) / samples, I: Iloop });
  } else if (s.type === 'cylinder') {
    // Uniformly magnetised cylinder ≡ solenoid of bound surface current K = M.
    // Each slice of height dz carries current M·dz (azimuthal).
    const L = mm(s.len);
    const M = s.Br / P.MU0;                 // magnetisation [A/m]
    const samples = Math.max(6, Math.min(48, s.seg));
    const Iloop = M * (L / samples);
    s._loopR = mm(s.dia) / 2;
    s._loops = [];
    for (let i = 0; i < samples; i++) s._loops.push({ z: -L / 2 + L * (i + 0.5) / samples, I: Iloop });
  } else if (s.type === 'wire') {
    const L = mm(s.len);
    s._segments = [{ pts: [toWorld([0, 0, -L / 2]), toWorld([0, 0, L / 2])], I: s.current }];
  }
  return s;
}

// Field of a single source at world point Q -> { B:[3], E:[3] }.
export function sourceField(s, Q) {
  if (!s.visible) return { B: [0, 0, 0], E: [0, 0, 0] };
  let B = [0, 0, 0], E = [0, 0, 0];

  if (s.type === 'magnet') {
    // Transform to local frame, evaluate exact cuboid, rotate B back.
    const qLoc = P.matTVec(s._R, P.vsub(Q, s._origin));
    const half = [mm(s.size[0]) / 2, mm(s.size[1]) / 2, mm(s.size[2]) / 2];
    const bLoc = P.cuboidFieldLocal(qLoc, half, [0, 0, s.Br]); // magnetised along local +z
    B = P.matVec(s._R, bLoc);
  } else if (s.type === 'sphere') {
    // Uniformly magnetised sphere: EXACTLY a point dipole outside, and a
    // uniform field (2/3)·J inside.  Both closed-form, no approximation.
    const R = mm(s.dia) / 2;
    if (P.vlen(P.vsub(Q, s._origin)) >= R) {
      const mmag = (s.Br / P.MU0) * (4 / 3) * Math.PI * R * R * R;
      B = P.dipoleField(P.matVec(s._R, [0, 0, mmag]), s._origin, Q);
    } else {
      B = P.matVec(s._R, [0, 0, (2 / 3) * s.Br]);
    }
  } else if (s.type === 'dipole') {
    const m = P.matVec(s._R, [0, 0, s.moment]); // moment along local +z
    B = P.dipoleField(m, s._origin, Q);
  } else if (s.type === 'charge') {
    const vel = P.matVec(s._R, s.vel.map((c) => c * (s.speedScale || 1)));
    const q = s.q * P.QE;
    const f = P.movingChargeField(q, s._origin, vel, Q);
    B = f.B; E = f.E;
  } else if (s._loops) {
    // Coaxial circular loops (loop / coil / cylinder) — evaluate each in the
    // source's local frame with the exact elliptic-integral solution.
    const q = P.matTVec(s._R, P.vsub(Q, s._origin));
    const a = s._loopR;
    let bx = 0, by = 0, bz = 0;
    for (const lp of s._loops) {
      const bl = P.circularLoopField(a, lp.I, q[0], q[1], q[2] - lp.z);
      bx += bl[0]; by += bl[1]; bz += bl[2];
    }
    B = P.matVec(s._R, [bx, by, bz]);
  } else if (s._segments) {
    for (const seg of s._segments) B = P.vadd(B, P.polylineField(seg.pts, seg.I, Q));
  }
  return { B, E };
}

// ---------------------------------------------------------------------------
// Scene: a collection of sources.  Provides total field and particle field fn.
// ---------------------------------------------------------------------------
export class Scene {
  constructor() { this.sources = []; }
  add(s) { this.sources.push(buildSource(s)); return s; }
  remove(id) { this.sources = this.sources.filter((s) => s.id !== id); }
  get(id) { return this.sources.find((s) => s.id === id); }
  rebuild() { this.sources.forEach(buildSource); }

  // Total magnetic field [T] at world point Q.
  B(Q) {
    let b = [0, 0, 0];
    for (const s of this.sources) b = P.vadd(b, sourceField(s, Q).B);
    return b;
  }
  // Total { E, B } — E only from charges.
  EB(Q) {
    let E = [0, 0, 0], B = [0, 0, 0];
    for (const s of this.sources) {
      const f = sourceField(s, Q);
      B = P.vadd(B, f.B); E = P.vadd(E, f.E);
    }
    return { E, B };
  }

  // Exact net force [N] and torque [N·m] on a source from all *other* sources.
  // No dipole approximation: the real Lorentz/Ampère force is integrated over the
  // body's equivalent currents (F = ∮ I dl×B_ext) for coils/loops/wires, and over
  // its bound magnetic surface charge (F = ∮ σ B_ext dA, σ = M·n̂) for magnets —
  // always using B_ext, the field from the OTHER sources only. Valid whenever the
  // bodies don't interpenetrate.
  forceTorque(target) { return forceOn(this, target); }
}

// True if world point q lies inside the solid magnetised body of source s.
function bodyContains(s, q) {
  if (s.type === 'sphere') return P.vlen(P.vsub(q, s._origin)) < mm(s.dia) / 2;
  if (s.type === 'magnet') {
    const l = P.matTVec(s._R, P.vsub(q, s._origin));
    return Math.abs(l[0]) < mm(s.size[0]) / 2 && Math.abs(l[1]) < mm(s.size[1]) / 2 && Math.abs(l[2]) < mm(s.size[2]) / 2;
  }
  if (s.type === 'cylinder') {
    const l = P.matTVec(s._R, P.vsub(q, s._origin));
    return Math.hypot(l[0], l[1]) < mm(s.dia) / 2 && Math.abs(l[2]) < mm(s.len) / 2;
  }
  return false;
}

// Oriented bounding box for a solid body (sphere/cylinder treated as their
// enclosing box — conservative, which is the safe direction for refusing).
function obbOf(s) {
  let he;
  if (s.type === 'magnet') he = [mm(s.size[0]) / 2, mm(s.size[1]) / 2, mm(s.size[2]) / 2];
  else if (s.type === 'sphere') { const r = mm(s.dia) / 2; he = [r, r, r]; }
  else if (s.type === 'cylinder') { const r = mm(s.dia) / 2; he = [r, r, mm(s.len) / 2]; }
  else return null;
  const R = s._R;
  const ax = [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]];
  return { c: s._origin, he, ax };
}
// Exact oriented-box overlap via the Separating Axis Theorem.
function bodiesOverlap(sa, sb) {
  const a = obbOf(sa), b = obbOf(sb);
  if (!a || !b) return false;
  const T = P.vsub(b.c, a.c);
  const axes = [a.ax[0], a.ax[1], a.ax[2], b.ax[0], b.ax[1], b.ax[2]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const cr = P.vcross(a.ax[i], b.ax[j]);
    if (P.vlen(cr) > 1e-9) axes.push(P.vnorm(cr));
  }
  for (const L of axes) {
    let ra = 0, rb = 0;
    for (let i = 0; i < 3; i++) { ra += a.he[i] * Math.abs(P.vdot(a.ax[i], L)); rb += b.he[i] * Math.abs(P.vdot(b.ax[i], L)); }
    if (Math.abs(P.vdot(T, L)) > ra + rb + 1e-9) return false;   // a separating axis exists → no overlap
  }
  return true;
}

export function forceOn(scene, target) {
  const others = scene.sources.filter((s) => s !== target && s.visible);
  if (!others.length) return { F: [0, 0, 0], tau: [0, 0, 0], valid: true, hasExternal: false };
  // interpenetrating bodies → force is undefined; refuse rather than report garbage
  for (const o of others) if (bodiesOverlap(target, o)) return { F: [0, 0, 0], tau: [0, 0, 0], valid: false, hasExternal: true };
  const c = target._origin, R = target._R;
  const Bext = (q) => { let b = [0, 0, 0]; for (const s of others) b = P.vadd(b, sourceField(s, q).B); return b; };
  const Eext = (q) => { let e = [0, 0, 0]; for (const s of others) e = P.vadd(e, sourceField(s, q).E); return e; };
  let F = [0, 0, 0], tau = [0, 0, 0], valid = true, Fabs = 0, tauAbs = 0;
  const local = (loc) => P.vadd(c, P.matVec(R, loc));          // local (m) -> world
  const inOther = (q) => { for (const s of others) if (bodyContains(s, q)) return true; return false; };
  // Also accumulate the sum of contribution magnitudes; the ratio |net|/Σ|dF|
  // tells us when a result is a genuine value vs. numerical cancellation to zero.
  const add = (r, dF) => {
    F = P.vadd(F, dF); Fabs += P.vlen(dF);
    const t = P.vcross(P.vsub(r, c), dF); tau = P.vadd(tau, t); tauAbs += P.vlen(t);
  };

  if (target.type === 'magnet') {
    // Bound surface charge σ = M·n̂ lives on the two faces ⟂ magnetisation (local z).
    const M = target.Br / P.MU0;
    const a = mm(target.size[0]) / 2, b = mm(target.size[1]) / 2, cc = mm(target.size[2]) / 2;
    const nx = 12, ny = 12, dA = (2 * a / nx) * (2 * b / ny);
    for (const [zf, sgn] of [[cc, 1], [-cc, -1]]) {
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const r = local([-a + (i + 0.5) * (2 * a / nx), -b + (j + 0.5) * (2 * b / ny), zf]);
        if (inOther(r)) valid = false;
        add(r, P.vscale(Bext(r), sgn * M * dA));
      }
    }
  } else if (target.type === 'cylinder') {
    const M = target.Br / P.MU0, rad = mm(target.dia) / 2, hl = mm(target.len) / 2;
    const nr = 8, nth = 24;
    for (const [zf, sgn] of [[hl, 1], [-hl, -1]]) {
      for (let ir = 0; ir < nr; ir++) for (let it = 0; it < nth; it++) {
        const rr = rad * (ir + 0.5) / nr, th = 2 * Math.PI * (it + 0.5) / nth;
        const dA = (rad / nr) * rr * (2 * Math.PI / nth);
        const r = local([rr * Math.cos(th), rr * Math.sin(th), zf]);
        if (inOther(r)) valid = false;
        add(r, P.vscale(Bext(r), sgn * M * dA));
      }
    }
  } else if (target.type === 'sphere') {
    const M = target.Br / P.MU0, rad = mm(target.dia) / 2;
    const nth = 18, nph = 28;
    for (let it = 0; it < nth; it++) for (let ip = 0; ip < nph; ip++) {
      const th = Math.PI * (it + 0.5) / nth, ph = 2 * Math.PI * (ip + 0.5) / nph;
      const dA = rad * rad * Math.sin(th) * (Math.PI / nth) * (2 * Math.PI / nph);
      const n = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
      const r = local(P.vscale(n, rad));
      if (inOther(r)) valid = false;
      add(r, P.vscale(Bext(r), M * Math.cos(th) * dA));   // σ = M·n̂ = M cosθ
    }
  } else if (target._loops) {
    const a = target._loopR, nseg = 60;
    for (const lp of target._loops) {
      for (let k = 0; k < nseg; k++) {
        const t0 = 2 * Math.PI * k / nseg, t1 = 2 * Math.PI * (k + 1) / nseg, tm = (t0 + t1) / 2;
        const dl = P.vsub(P.matVec(R, [a * Math.cos(t1), a * Math.sin(t1), lp.z]),
                          P.matVec(R, [a * Math.cos(t0), a * Math.sin(t0), lp.z]));
        const r = local([a * Math.cos(tm), a * Math.sin(tm), lp.z]);
        if (inOther(r)) valid = false;
        add(r, P.vscale(P.vcross(dl, Bext(r)), lp.I));     // dF = I dl × B_ext
      }
    }
  } else if (target._segments) {
    for (const seg of target._segments) {
      const A = seg.pts[0], Bp = seg.pts[1], nseg = 40;
      const lerp = (t) => [A[0] + (Bp[0] - A[0]) * t, A[1] + (Bp[1] - A[1]) * t, A[2] + (Bp[2] - A[2]) * t];
      for (let k = 0; k < nseg; k++) {
        const dl = P.vsub(lerp((k + 1) / nseg), lerp(k / nseg));
        const r = lerp((k + 0.5) / nseg);
        if (inOther(r)) valid = false;
        add(r, P.vscale(P.vcross(dl, Bext(r)), seg.I));
      }
    }
  } else if (target.type === 'dipole') {
    // ideal point dipole: force = ∇(m·B_ext) is exact here
    const m = P.matVec(R, [0, 0, target.moment]);
    const h = 5e-5;
    for (let i = 0; i < 3; i++) {
      const pp = c.slice(), pm = c.slice(); pp[i] += h; pm[i] -= h;
      F[i] = (P.vdot(m, Bext(pp)) - P.vdot(m, Bext(pm))) / (2 * h);
    }
    tau = P.vcross(m, Bext(c));
    Fabs = P.vlen(F); tauAbs = P.vlen(tau);   // direct values, not summed
    if (inOther(c)) valid = false;
  } else if (target.type === 'charge') {
    const q = target.q * P.QE, vel = P.matVec(R, target.vel.map((v) => v * (target.speedScale || 1)));
    F = P.vscale(P.vadd(Eext(c), P.vcross(vel, Bext(c))), q);
    Fabs = P.vlen(F);
  }
  return { F, tau, valid, hasExternal: true, Fabs, tauAbs };
}

// Magnetic moment [A·m²] of a source (for force/torque), or null if N/A.
export function momentOf(s) {
  if (s.type === 'magnet') {
    const V = mm(s.size[0]) * mm(s.size[1]) * mm(s.size[2]);
    const m = s.Br / P.MU0 * V;
    return P.matVec(s._R, [0, 0, m]);
  }
  if (s.type === 'cylinder') {
    const r = mm(s.dia) / 2, V = Math.PI * r * r * mm(s.len);
    const m = s.Br / P.MU0 * V;
    return P.matVec(s._R, [0, 0, m]);
  }
  if (s.type === 'sphere') {
    const R = mm(s.dia) / 2, V = (4 / 3) * Math.PI * R * R * R;
    return P.matVec(s._R, [0, 0, s.Br / P.MU0 * V]);
  }
  if (s.type === 'dipole') return P.matVec(s._R, [0, 0, s.moment]);
  if (s.type === 'loop') {
    const r = mm(s.dia) / 2;
    return P.matVec(s._R, [0, 0, s.current * Math.PI * r * r]);
  }
  if (s.type === 'coil') {
    const r = mm(s.dia) / 2;
    return P.matVec(s._R, [0, 0, s.current * s.turns * Math.PI * r * r]);
  }
  return null;
}

// Approximate physical half-extent of a source [m] — its bounding-sphere radius
// about the centre. Used for click hit-testing, the selection highlight, and Fit.
export function sourceExtent(s) {
  switch (s.type) {
    case 'magnet':   return 0.5 * Math.hypot(mm(s.size[0]), mm(s.size[1]), mm(s.size[2]));
    case 'sphere':   return mm(s.dia) / 2;
    case 'cylinder':
    case 'coil':     return Math.max(mm(s.dia) / 2, mm(s.len) / 2);
    case 'loop':     return mm(s.dia) / 2;
    case 'wire':     return mm(s.len) / 2;
    default:         return 0.006;  // dipole / charge — small point marker
  }
}
