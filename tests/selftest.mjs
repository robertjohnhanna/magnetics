// Physics verification. Checks each field routine against independent,
// analytically-known limits and Maxwell constraints (∇·B=0, ∇×B=0 in free space).
import {
  MU0, cuboidFieldZ, cuboidFieldLocal, segmentField, polylineField,
  dipoleField, vadd, vsub, vscale, vlen, vcross,
} from '../src/physics.js';

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}  ${extra}`); }
}
function rel(a, b) { return Math.abs(a - b) / (Math.abs(b) + 1e-30); }

// Numerical divergence & curl of a vector field fn(x)->[bx,by,bz] at point p.
function divergence(fn, p, h) {
  let d = 0;
  for (let i = 0; i < 3; i++) {
    const pp = p.slice(); pp[i] += h;
    const pm = p.slice(); pm[i] -= h;
    d += (fn(pp)[i] - fn(pm)[i]) / (2 * h);
  }
  return d;
}
function curl(fn, p, h) {
  const d = (i, j) => {
    const pp = p.slice(); pp[j] += h;
    const pm = p.slice(); pm[j] -= h;
    return (fn(pp)[i] - fn(pm)[i]) / (2 * h);
  };
  return [d(2, 1) - d(1, 2), d(0, 2) - d(2, 0), d(1, 0) - d(0, 1)];
}

console.log('\n== Cuboid permanent magnet ==');
{
  const half = [0.01, 0.015, 0.02];    // 20 x 30 x 40 mm block
  const J = 1.32;                       // ~N42 remanence [T]
  const fn = (p) => cuboidFieldZ(p, half, J);

  // 1. On-axis symmetry: Bx=By=0 on the +z axis.
  const onAxis = fn([0, 0, 0.1]);
  check('on-axis Bx≈0', Math.abs(onAxis[0]) < 1e-9, onAxis[0]);
  check('on-axis By≈0', Math.abs(onAxis[1]) < 1e-9, onAxis[1]);
  check('on-axis Bz>0 above +z pole', onAxis[2] > 0, onAxis[2]);

  // 2. Far-field dipole limit on axis:  Bz -> 4abcJ/(π R³)
  const R = 1.0;                        // 1 m ≫ magnet size
  const b = fn([0, 0, R]);
  const [a, bb, c] = half;
  const dipoleBz = 4 * a * bb * c * J / (Math.PI * R * R * R);
  check('far-field matches dipole (on axis)', rel(b[2], dipoleBz) < 1e-3,
        `got ${b[2].toExponential(4)} want ${dipoleBz.toExponential(4)}`);

  // 3. Maxwell: ∇·B = 0 and ∇×B = 0 at several external points.
  const pts = [[0.05, 0, 0.05], [0.03, 0.04, 0.06], [0.1, -0.05, 0.02], [0, 0.08, -0.03]];
  let maxDiv = 0, maxCurl = 0;
  const scale = vlen(fn([0.05, 0, 0.05]));
  for (const p of pts) {
    maxDiv = Math.max(maxDiv, Math.abs(divergence(fn, p, 1e-5)));
    maxCurl = Math.max(maxCurl, vlen(curl(fn, p, 1e-5)));
  }
  // Compare against a characteristic |B|/length scale (~ scale / 0.01 m).
  const ref = scale / 0.01;
  check('∇·B ≈ 0 outside magnet', maxDiv / ref < 1e-4, `div/ref=${(maxDiv/ref).toExponential(2)}`);
  check('∇×B ≈ 0 outside magnet', maxCurl / ref < 1e-4, `curl/ref=${(maxCurl/ref).toExponential(2)}`);
}

console.log('\n== Cuboid: arbitrary magnetisation direction ==');
{
  // A block magnetised along local x should give, on the +x axis, the same
  // pattern the z-version gives on the +z axis (rotational relabelling).
  const half = [0.02, 0.01, 0.01];
  const J = 1.0;
  const bx = cuboidFieldLocal([0.1, 0, 0], half, [J, 0, 0]);
  check('x-magnetised: on x-axis field is axial', Math.abs(bx[1]) < 1e-9 && Math.abs(bx[2]) < 1e-9, bx.toString());
  check('x-magnetised: axial component > 0', bx[0] > 0, bx[0]);
  // curl-free check for a diagonal magnetisation
  const fn = (p) => cuboidFieldLocal(p, half, [0.6, 0.6, 0.6]);
  const cl = vlen(curl(fn, [0.05, 0.04, 0.03], 1e-5));
  const ref = vlen(fn([0.05, 0.04, 0.03])) / 0.01;
  check('diagonal magnetisation curl-free', cl / ref < 1e-3, `curl/ref=${(cl/ref).toExponential(2)}`);
}

console.log('\n== Straight current segment (Biot–Savart) ==');
{
  // Long segment approximates an infinite wire: B = μ0 I /(2π d).
  const I = 10;
  const P1 = [0, 0, -1e6], P2 = [0, 0, 1e6];
  const d = 0.05;
  const b = segmentField(P1, P2, I, [d, 0, 0]);
  const expect = MU0 * I / (2 * Math.PI * d);
  check('infinite-wire magnitude', rel(vlen(b), expect) < 1e-4, `${vlen(b)} vs ${expect}`);
  check('infinite-wire direction +y (RH rule)', b[1] > 0 && Math.abs(b[0]) < 1e-12 && Math.abs(b[2]) < 1e-12, b.toString());
}

console.log('\n== Circular loop from segments (on-axis) ==');
{
  // Discretise a loop of radius Rr carrying I, compare on-axis to the exact
  // formula  Bz = μ0 I Rr² / (2 (Rr²+z²)^{3/2}).
  const Rr = 0.05, I = 3, N = 512, z = 0.08;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = (2 * Math.PI * i) / N;
    pts.push([Rr * Math.cos(t), Rr * Math.sin(t), 0]);
  }
  const b = polylineField(pts, I, [0, 0, z]);
  const expect = MU0 * I * Rr * Rr / (2 * Math.pow(Rr * Rr + z * z, 1.5));
  check('loop on-axis Bz', rel(b[2], expect) < 1e-4, `${b[2]} vs ${expect}`);
  check('loop on-axis transverse ≈ 0', Math.abs(b[0]) < 1e-9 && Math.abs(b[1]) < 1e-9, b.toString());
}

console.log('\n== Circular loop — elliptic-integral form ==');
{
  const Rr = 0.05, I = 3;
  // on-axis vs closed form
  for (const z of [0.01, 0.08, 0.2]) {
    const b = circularLoopField(Rr, I, 0, 0, z);
    const exp = MU0 * I * Rr * Rr / (2 * Math.pow(Rr * Rr + z * z, 1.5));
    check(`loop on-axis Bz (z=${z})`, rel(b[2], exp) < 1e-6, `${b[2]} vs ${exp}`);
  }
  // off-axis vs a 1024-segment Biot–Savart loop (independent method)
  const N = 1024, pts = [];
  for (let i = 0; i <= N; i++) { const t = 2 * Math.PI * i / N; pts.push([Rr * Math.cos(t), Rr * Math.sin(t), 0]); }
  for (const Q of [[0.03, 0, 0.02], [0.06, 0.01, -0.03], [0.02, 0.02, 0.05]]) {
    const bE = circularLoopField(Rr, I, Q[0], Q[1], Q[2]);
    const bS = polylineField(pts, I, Q);
    check(`loop off-axis matches segments @${Q}`, vlen(vsub(bE, bS)) / vlen(bS) < 2e-3,
          `E=${bE.map((v)=>v.toExponential(2))} S=${bS.map((v)=>v.toExponential(2))}`);
  }
}
import { circularLoopField } from '../src/physics.js';

console.log('\n== Point dipole ==');
{
  // On-axis (moment along z): Bz = μ0/(2π) m / r³ ; transverse plane: -μ0/(4π) m/r³.
  const m = [0, 0, 1.5];
  const r = 0.3;
  const onAxis = dipoleField(m, [0, 0, 0], [0, 0, r]);
  const expAxis = MU0 / (2 * Math.PI) * 1.5 / (r * r * r);
  check('dipole on-axis Bz', rel(onAxis[2], expAxis) < 1e-9, `${onAxis[2]} vs ${expAxis}`);
  const equator = dipoleField(m, [0, 0, 0], [r, 0, 0]);
  const expEq = -MU0 / (4 * Math.PI) * 1.5 / (r * r * r);
  check('dipole equatorial Bz', rel(equator[2], expEq) < 1e-9, `${equator[2]} vs ${expEq}`);
}

console.log('\n== Boris pusher (charged particle) ==');
{
  // Electron in a uniform B = B ẑ.  Expect a circle of radius r = m v /(q B),
  // constant speed, and angular frequency ω = qB/m.
  const QE = 1.602176634e-19, ME = 9.1093837015e-31;
  const B = 0.01, v0 = 1e6;
  const rTheory = ME * v0 / (QE * B);
  const fieldFn = () => ({ E: [0, 0, 0], B: [0, 0, B] });
  let x = [0, 0, 0], v = [v0, 0, 0];
  const dt = 1e-12;
  let maxR = 0, minSpeed = Infinity, maxSpeed = 0;
  for (let n = 0; n < 20000; n++) {
    const r = borisStep(x, v, -QE, ME, dt, fieldFn);
    x = r.x; v = r.v;
    maxR = Math.max(maxR, Math.hypot(x[0], x[1]));
    const sp = vlen(v); minSpeed = Math.min(minSpeed, sp); maxSpeed = Math.max(maxSpeed, sp);
  }
  // diameter ≈ 2 r; maxR reached is the diameter since it starts at the edge
  check('gyro-radius matches m v /(qB)', rel(maxR, 2 * rTheory) < 2e-3, `maxR=${maxR} 2r=${2 * rTheory}`);
  check('speed conserved (magnetic force does no work)', (maxSpeed - minSpeed) / v0 < 1e-6,
        `Δv/v=${((maxSpeed - minSpeed) / v0).toExponential(2)}`);
}
import { borisStep } from '../src/physics.js';

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
