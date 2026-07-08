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
    case 'coil':     return { ...base, name: 'Electromagnet', dia: 20, len: 30,  turns: 200, current: 2.0, seg: 28, core: 1 };
    case 'loop':     return { ...base, name: 'Current loop',  dia: 20, current: 10, seg: 96 };
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

  // Net force [N] and torque [N·m] on a source from all *other* sources,
  // using the point-dipole approximation evaluated at the body centre.
  // Exact for well-separated bodies; approximate when magnets nearly touch.
  forceTorque(target) {
    const m = momentOf(target);
    if (!m) return null;
    const r0 = target._origin;
    // External field and its gradient at the body centre (finite difference).
    const others = this.sources.filter((s) => s !== target && s.visible);
    const Bext = (Q) => {
      let b = [0, 0, 0];
      for (const s of others) b = P.vadd(b, sourceField(s, Q).B);
      return b;
    };
    const B0 = Bext(r0);
    const h = 1e-4;
    // F = ∇(m·B).  Torque τ = m × B.
    const F = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const pp = r0.slice(); pp[i] += h;
      const pm = r0.slice(); pm[i] -= h;
      F[i] = (P.vdot(m, Bext(pp)) - P.vdot(m, Bext(pm))) / (2 * h);
    }
    const tau = P.vcross(m, B0);
    return { F, tau, Bext: B0, moment: m };
  }
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
