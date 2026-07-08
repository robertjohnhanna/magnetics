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

The optional **core (µ)** factor on electromagnets is a simple linear multiplier
standing in for a high-permeability core. It is the one deliberate approximation
in the source models (it ignores demagnetising factors and saturation); leave it
at 1 for an air-core coil, which is exact.

## Point dipole and moving charges

- **Point dipole**: B(r) = (μ₀/4π)[3r̂(m·r̂) − m]/r³.
- **Moving point charge**: E = kq r̂/r², B = (μ₀/4π) q **v**×r̂/r²
  (the point-charge Biot–Savart law, valid for v ≪ c).

## Forces and torques — exact, no dipole approximation

The net force and torque on the selected body from all *other* sources is
computed by integrating the **actual** force density over the body, using
B_ext (the field of the other sources only) — never the point-dipole/far-field
approximation. It is valid at any separation, including nearly-touching magnets,
as long as the bodies don't interpenetrate.

- **Currents (coil / loop / wire):** the Lorentz force on the conductor,
  F = ∮ I dl × B_ext, integrated along the wire.
- **Magnets (bar / cylinder / sphere):** the force on the bound magnetic surface
  charge, F = ∮ σ B_ext dA with σ = M·n̂ (Amperian/Gilbert surface integral).
- **Point dipole:** F = ∇(m·B_ext), which is exact for an ideal dipole.
- **Moving charge:** F = q(E_ext + v × B_ext).

Torque is accumulated as τ = ∮ (r − r₀) × dF over the same elements. Verified
against the analytic dipole–dipole force in the far field (agreement to ~0.01 %),
Newton's third law (|F_AB + F_BA| ≈ 0 to machine precision), zero net force in a
uniform field (with the correct nonzero torque), and the correct sign of the
force between parallel current loops.

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

A particle that flies into a **solid magnet body** (bar, disc/cylinder or
sphere) is **stopped/absorbed** at the point of impact — the magnet is a fixed
laboratory object, so it takes up the particle's momentum without visibly
recoiling. Open current sources (coils, loops, wires) are not solid barriers, so
a particle still spirals freely through a solenoid's bore.

## Visualisation caveats

- The canvas shows a **2-D slice** through the 3-D scene. Streamlines trace the
  **in-plane projection** of **B**; where the field leaves the plane the probe
  reports the true out-of-plane component separately.
- The heatmap is **log-scaled** |B| and clamped to ~6 decades so a single hot
  cell next to a source doesn't wash out the rest.
- Idealised magnets have sharp edges, so the field formally diverges exactly on
  an edge line (real magnets are slightly rounded). Points off the edges are
  finite and accurate.
