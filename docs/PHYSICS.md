# Physics notes

Everything here is computed from first principles in **SI units** (metres, tesla,
amperes, coulombs, kilograms). Fields obey superposition, so the total field of a
scene is the exact sum of its members' fields. The engine lives in
[`src/physics.js`](../src/physics.js) and every routine below is checked against
an independent analytical limit in [`tests/selftest.mjs`](../tests/selftest.mjs)
(run `npm test`).

## Constants

| symbol | value | meaning |
|---|---|---|
| μ₀ | 4π×10⁻⁷ T·m/A | vacuum permeability |
| ε₀ | 8.854×10⁻¹² F/m | vacuum permittivity |
| e  | 1.602×10⁻¹⁹ C | elementary charge |
| mₑ | 9.109×10⁻³¹ kg | electron mass |
| m_p | 1.673×10⁻²⁷ kg | proton mass |

## Permanent magnets — exact uniformly-magnetised cuboid

A bar magnet is modelled as a rectangular block with uniform magnetic
polarisation **J** = μ₀**M** (tesla). Using the magnetic surface-charge
(Coulombian) model, the field is known in closed form and is **exact everywhere
outside the magnet body** (Yang; Camacho & Sosa 2013 — the same solution used by
[magpylib](https://magpylib.readthedocs.io)). For polarisation J along local *z*
and half-dimensions (a, b, c), with r_{ijk} the distance to each of the 8 corners:

```
Bx = (J/4π) Σ (−1)^{i+j+k} ln(r + Y_j)
By = (J/4π) Σ (−1)^{i+j+k} ln(r + X_i)
Bz = −(J/4π) Σ (−1)^{i+j+k} atan2(X_i·Y_j , Z_k·r)
```

Arbitrary magnetisation directions are handled by superposing the three
axis-permuted components. The remanence **Br** you enter (e.g. 1.30 T for grade
N42 NdFeB) *is* the polarisation magnitude. Verified against: the ∇·B = 0 and
∇×B = 0 Maxwell constraints outside the magnet, and the point-dipole far-field
limit B_z → 4abcJ/(πR³) on axis.

## Sphere magnet — exact, everywhere

A uniformly-magnetised sphere is one of the few bodies whose field is closed-form
*inside and out*:

- **Outside** it is **exactly** a point dipole with moment **m** = **M**·V,
  V = 4⁄3 πR³.
- **Inside** the field is perfectly uniform, **B** = ⅔**J** (with **J** = μ₀**M**).

No discretisation, no approximation. The two expressions agree at the pole
(⅔J on both sides), which the app shows as a continuous field across the surface.
`src/sources.js` picks the interior or exterior form by comparing the probe
distance to the radius.

## Currents — Biot–Savart for finite segments

Any wire is broken into straight segments; each contributes the **exact**
Biot–Savart field of a finite filament carrying current *I* from **P₁** to **P₂**:

```
B = (μ₀I)/(4π d) · (cosθ₁ − cosθ₂) · n̂
```

where *d* is the perpendicular distance to the line, θ are the angles subtended
at the endpoints, and **n̂** is the right-hand-rule direction. A **straight
wire** is a single such segment (verified against the infinite-wire limit
B = μ₀I/(2πd)).

**Circular loops** use a faster, exact route. The field of a circular current
loop is known in closed form via the complete elliptic integrals K and E
(evaluated by the arithmetic–geometric mean). One evaluation replaces dozens of
Biot–Savart segments — much faster *and* exact. This drives:

- **Current loop** — a single loop. Verified against the on-axis formula
  B_z = μ₀IR²/2(R²+z²)^{3/2} and, off-axis, against a 1024-segment Biot–Savart
  loop.
- **Electromagnet (solenoid)** — a stack of coaxial loops whose total
  ampere-turns (turns × current) is preserved. Verified against μ₀nI at the
  centre of a long solenoid.
- **Cylinder / disc magnet** — a uniformly-magnetised cylinder is *exactly*
  equivalent to a solenoid carrying bound surface current K = M = Br/μ₀, so it
  is a stack of loops, each slice of height dz carrying M·dz.

The optional **core µ factor** on electromagnets is a simple linear multiplier
standing in for a high-permeability core; it is an approximation (it ignores
demagnetising factors and saturation) and is labelled as such in the UI.

## Point dipole and moving charges

- **Point dipole**: B(r) = (μ₀/4π)[3r̂(m·r̂) − m]/r³.
- **Moving point charge**: E = kq r̂/r², B = (μ₀/4π) q **v**×r̂/r²
  (the point-charge Biot–Savart law, valid for v ≪ c).

## Forces and torques

For a selected magnet/coil/dipole the app reports the net force and torque from
all *other* sources using the point-dipole relations evaluated at the body
centre:

```
τ = m × B_ext        F = ∇(m · B_ext)
```

with the magnetic moment m = (Br/μ₀)·V for a magnet, or I·N·A for a coil. This is
**exact for well-separated bodies** and an approximation when two magnets nearly
touch (where higher multipoles matter). The gradient is taken numerically.

## Continuous work & conservation of energy

A magnet in a static field has potential energy U = −**m**·**B**, and the force
on it is F = ∇(**m**·**B**) = −∇U — a *conservative* field. The net work done
over any closed path is therefore

```
W_cycle = ∮ F·dl = −∮ ∇U·dl = 0
```

exactly, for every static arrangement of magnets and steady currents. You can
extract energy *once* (two magnets snapping together releases ΔU), but restoring
the configuration costs the same ΔU, so there is **no net continuous work** — no
magnetostatic "free energy" or perpetual motion.

The **Continuous work** tile makes this measurable: it carries a small test
magnet (modelled as freely aligning with **B**, the best case for extraction,
U = −m|B|) once around a closed loop centred on the probe and numerically sums
∮F·dl. The result is ~0 to numerical precision, displayed next to the one-stroke
energy ΔU = m·(|B|max − |B|min) for contrast. A layout that produced net cyclic
work would show a nonzero integral here; none can, because the field is a
gradient. (Continuous power is only possible with *time-varying* fields —
induction/generators — which take in as much work as they deliver.)

**Validity and safeguards.** The theorem only holds where the test magnet stays
in **free space**. *Inside* solid magnetised material the field is discontinuous
(bound-current surfaces carry ∇×B ≠ 0) and the scenario is unphysical, so the
integral there converges to a spurious nonzero value. The tool therefore
**refuses** any loop whose path enters a magnet/sphere/cylinder body (the loop is
drawn red and the tile says so) instead of reporting a false result. Near a
current filament the integral is real but slow to converge, so the tile also
evaluates at two resolutions and reports **"under-resolved — refine"** if they
disagree. Only when the path is clean and converged does it report the (≈ 0)
cyclic work — with the one-stroke ΔU shown alongside to prove real forces are
present but net to zero. This makes the check a genuine test, not a rubber stamp:
it will not hand back "0" for a path where the number would be meaningless.

## Charged-particle dynamics — Boris pusher

Particles move under the full Lorentz force **F = q(E + v×B)**. Integration uses
the **Boris pusher**, the standard phase-space-conserving scheme for charged
particles in electromagnetic fields: a half electric kick, an exact rotation in
the magnetic field, then a second half electric kick. It conserves energy for
purely magnetic fields (the magnetic force does no work), so orbits stay closed
over long runs. Verified against the analytic gyro-radius r = mv/(qB) and
speed conservation.

The integration step is **adaptive**: each sub-step is capped at
dt ≤ T_gyro⁄24 where T_gyro = 2πm/(qB) is the local gyro-period. This keeps the
orbit resolved (and therefore accurate) even close to a strong magnet, where a
fixed step would otherwise be larger than a full gyration. Motion is
non-relativistic (valid for the v ≪ c speeds used here).

## Visualisation caveats

- The canvas shows a **2-D slice** through the 3-D scene. Streamlines trace the
  **in-plane projection** of **B**; where the field leaves the plane the probe
  reports the true out-of-plane component separately.
- The heatmap is **log-scaled** |B| and clamped to ~6 decades so a single hot
  cell next to a source doesn't wash out the rest.
- Idealised magnets have sharp edges, so the field formally diverges exactly on
  an edge line (real magnets are slightly rounded). Points off the edges are
  finite and accurate.
