// physics.js — core electromagnetism, SI units throughout.
// Length: metres, B: tesla, current: amps, charge: coulomb, mass: kg.
//
// All field routines return B in tesla at a point given in metres.
// Sources compose linearly (superposition), so the total field of a scene is
// just the sum of the fields of its members.

export const MU0  = 4e-7 * Math.PI;        // vacuum permeability  [T·m/A]
export const EPS0 = 8.8541878128e-12;      // vacuum permittivity  [F/m]
export const QE   = 1.602176634e-19;       // elementary charge    [C]
export const ME   = 9.1093837015e-31;      // electron mass        [kg]
export const MP   = 1.67262192369e-27;     // proton mass          [kg]
export const C0   = 299792458;             // speed of light       [m/s]
export const KE   = 1 / (4 * Math.PI * EPS0); // Coulomb constant  [N·m²/C²]

// ---------------------------------------------------------------------------
// Minimal 3-vector helpers.  Vectors are plain [x, y, z] arrays.
// ---------------------------------------------------------------------------
export const vadd   = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub   = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vdot   = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const vlen  = (a) => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const vzero = () => [0, 0, 0];

// ---------------------------------------------------------------------------
// Rotations.  Orientation is stored as intrinsic Z-Y-X Euler angles (radians):
// yaw (about z), pitch (about y), roll (about x).  These helpers convert between
// world and a body's local frame.
// ---------------------------------------------------------------------------
export function eulerToMatrix(yaw, pitch, roll) {
  const cy = Math.cos(yaw),   sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll),  sr = Math.sin(roll);
  // R = Rz(yaw) · Ry(pitch) · Rx(roll)
  return [
    [cy * cp,  cy * sp * sr - sy * cr,  cy * sp * cr + sy * sr],
    [sy * cp,  sy * sp * sr + cy * cr,  sy * sp * cr - cy * sr],
    [-sp,      cp * sr,                 cp * cr],
  ];
}
export function matVec(M, v) {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}
export function matTVec(M, v) { // transpose (inverse for rotations) times vector
  return [
    M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2],
    M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2],
    M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2],
  ];
}

// ---------------------------------------------------------------------------
// Uniformly magnetised cuboid — exact analytical field.
//
// A permanent magnet is modelled as a rectangular block with uniform
// magnetic polarisation J = μ0·M (tesla).  The field is derived from the
// magnetic surface-charge (Coulombian) model and is exact everywhere outside
// the magnet body.  Reference form: Yang / Camacho–Sosa; identical to the
// closed form used by magpylib.
//
// This routine handles polarisation along the local +z axis; a general
// polarisation direction is obtained by superposing axis-permuted calls.
//
//   p    : field point in the magnet's local frame [m]
//   half : [a, b, c] half-dimensions of the block   [m]
//   Jz   : polarisation along local z               [T]
// ---------------------------------------------------------------------------
export function cuboidFieldZ(p, half, Jz) {
  const [x, y, z] = p;
  const [a, b, c] = half;
  let Bx = 0, By = 0, Bz = 0;
  for (let i = 0; i < 2; i++) {
    const X = x - (2 * i - 1) * a;           // X0 = x+a, X1 = x-a
    for (let j = 0; j < 2; j++) {
      const Y = y - (2 * j - 1) * b;
      for (let k = 0; k < 2; k++) {
        const Z = z - (2 * k - 1) * c;
        const R = Math.hypot(X, Y, Z) || 1e-30;
        const s = ((i + j + k) & 1) ? -1 : 1;
        Bx += s * Math.log(R + Y);
        By += s * Math.log(R + X);
        Bz -= s * Math.atan2(X * Y, Z * R);
      }
    }
  }
  const k0 = Jz / (4 * Math.PI);
  return [k0 * Bx, k0 * By, k0 * Bz];
}

// General cuboid with arbitrary local polarisation vector Jloc = [Jx, Jy, Jz].
// Each Cartesian component contributes via the z-formula applied on a permuted
// axis ordering, then mapped back to local axes.
export function cuboidFieldLocal(pLoc, half, Jloc) {
  const [a, b, c] = half;
  const [x, y, z] = pLoc;
  const [Jx, Jy, Jz] = Jloc;
  let B = [0, 0, 0];
  if (Jz !== 0) {
    B = vadd(B, cuboidFieldZ([x, y, z], [a, b, c], Jz));
  }
  if (Jx !== 0) {
    // Treat local x as the magnetisation axis: map (x,y,z)->(y,z,x), half->(b,c,a)
    const b2 = cuboidFieldZ([y, z, x], [b, c, a], Jx);
    B = vadd(B, [b2[2], b2[0], b2[1]]); // map result axes back
  }
  if (Jy !== 0) {
    // Local y as magnetisation axis: map (x,y,z)->(z,x,y), half->(c,a,b)
    const b2 = cuboidFieldZ([z, x, y], [c, a, b], Jy);
    B = vadd(B, [b2[1], b2[2], b2[0]]);
  }
  return B;
}

// ---------------------------------------------------------------------------
// Finite straight current segment — exact Biot–Savart.
//
// Current I flows from P1 to P2.  Returns B [T] at field point Q.
// Exact for a straight filament; discretising a coil into many such segments
// reproduces any wire geometry to arbitrary accuracy.
// ---------------------------------------------------------------------------
export function segmentField(P1, P2, I, Q) {
  const a = vsub(Q, P1);          // P1 -> Q
  const bb = vsub(Q, P2);         // P2 -> Q
  const L = vsub(P2, P1);         // current direction
  const Llen = vlen(L);
  if (Llen < 1e-18) return [0, 0, 0];
  const Lhat = vscale(L, 1 / Llen);
  const cr = vcross(Lhat, a);     // perpendicular direction * dperp
  const cr2 = vdot(cr, cr);
  if (cr2 < 1e-30) return [0, 0, 0]; // field point on the wire line
  const dperp = Math.sqrt(cr2);
  const la = vlen(a) || 1e-30;
  const lb = vlen(bb) || 1e-30;
  const cos1 = vdot(Lhat, a) / la;
  const cos2 = vdot(Lhat, bb) / lb;
  const mag = (MU0 * I) / (4 * Math.PI * dperp) * (cos1 - cos2);
  const dir = vscale(cr, 1 / dperp);
  return vscale(dir, mag);
}

// Sum a polyline of segments (open path).  points: array of [x,y,z].
export function polylineField(points, I, Q) {
  let B = [0, 0, 0];
  for (let i = 0; i < points.length - 1; i++) {
    B = vadd(B, segmentField(points[i], points[i + 1], I, Q));
  }
  return B;
}

// ---------------------------------------------------------------------------
// Point magnetic dipole.  m = magnetic moment [A·m²] at origin r0.
//   B(r) = (μ0/4π) [ 3 r̂ (m·r̂) − m ] / r³
// ---------------------------------------------------------------------------
export function dipoleField(m, r0, Q) {
  const r = vsub(Q, r0);
  const rl = vlen(r);
  if (rl < 1e-12) return [0, 0, 0];
  const rhat = vscale(r, 1 / rl);
  const mr = vdot(m, rhat);
  const term = vsub(vscale(rhat, 3 * mr), m);
  return vscale(term, MU0 / (4 * Math.PI) / (rl * rl * rl));
}

// ---------------------------------------------------------------------------
// Fields of a moving point charge (non-relativistic near-field forms).
//   E(r) = k q r̂ / r²
//   B(r) = (μ0/4π) q v × r̂ / r²     (point-charge Biot–Savart)
// Returns { E, B }.
// ---------------------------------------------------------------------------
export function movingChargeField(q, r0, vel, Q) {
  const r = vsub(Q, r0);
  const rl = vlen(r);
  if (rl < 1e-12) return { E: [0, 0, 0], B: [0, 0, 0] };
  const rhat = vscale(r, 1 / rl);
  const inv2 = 1 / (rl * rl);
  const E = vscale(rhat, KE * q * inv2);
  const B = vscale(vcross(vel, rhat), (MU0 / (4 * Math.PI)) * q * inv2);
  return { E, B };
}

// ---------------------------------------------------------------------------
// Lorentz force:  F = q (E + v × B)
// ---------------------------------------------------------------------------
export function lorentzForce(q, vel, E, B) {
  return vscale(vadd(E, vcross(vel, B)), q);
}

// ---------------------------------------------------------------------------
// Boris pusher — the standard, phase-space-conserving integrator for a
// charged particle in static E and B fields.  Advances (x, v) by dt.
// fieldFn(x) must return { E, B } at position x.
// ---------------------------------------------------------------------------
export function borisStep(x, v, q, mass, dt, fieldFn) {
  const { E, B } = fieldFn(x);
  const qmdt2 = (q / mass) * (dt / 2);
  // half electric kick
  const vMinus = vadd(v, vscale(E, qmdt2));
  // magnetic rotation
  const t = vscale(B, qmdt2);
  const t2 = vdot(t, t);
  const sfac = 2 / (1 + t2);
  const vPrime = vadd(vMinus, vcross(vMinus, t));
  const vPlus = vadd(vMinus, vscale(vcross(vPrime, t), sfac));
  // second half electric kick
  const vNew = vadd(vPlus, vscale(E, qmdt2));
  const xNew = vadd(x, vscale(vNew, dt));
  return { x: xNew, v: vNew };
}
