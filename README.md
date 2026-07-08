# ⌁ Magnetics — magnetic field lab

An interactive, **physics-accurate** magnetic field simulator that runs entirely
in the browser. Build a scene from permanent magnets, electromagnets, current
loops, wires, dipoles and moving charges; see the field as a heat-map, streamlines
and a vector quiver; drag a probe to read the exact **B** vector anywhere; read
forces and torques; and launch electrons or protons to watch them move under the
real Lorentz force.

No installation, no accounts, no lab equipment — just open the page. Works on
desktop and touch devices.

👉 **[Live demo](https://robertjohnhanna.github.io/magnetics/)**

## Why it's trustworthy

The field engine is not a toy approximation. It uses the same closed-form
solutions as professional tools, and every routine is checked against an
independent analytical limit:

- **Permanent magnets** — exact field of a uniformly-magnetised block, validated
  against Maxwell's equations (∇·B = 0, ∇×B = 0) and the dipole far field.
- **Sphere magnets** — exact everywhere: a point dipole outside, a uniform ⅔·J
  inside, continuous across the surface.
- **All currents** — exact finite-segment Biot–Savart (wires, loops, solenoids),
  validated against the infinite-wire and on-axis-loop formulas and μ₀nI.
- **Cylinder / disc magnets** — modelled as their exact bound-current equivalent.
- **Charged particles** — a Boris pusher with adaptive, gyro-resolved stepping,
  validated against the analytic gyro-radius and energy conservation.

Run the checks yourself:

```bash
npm test        # 17 physics assertions, all from first principles
```

Full derivations, formulas and references: **[docs/PHYSICS.md](docs/PHYSICS.md)**.

## What you can do

| Feature | Notes |
|---|---|
| Permanent magnets | **bar** (cuboid), **disc/cylinder**, and **sphere**; set size, remanence Br by material grade (N35–N52, SmCo, ferrite…), position and full 3-axis orientation |
| Electromagnets | solenoids with turns, current, geometry and an optional core-µ factor |
| Current loops & straight wires | any current, including reversed |
| Point dipoles & moving charges | ideal dipole; a moving charge produces both **E** and **B** |
| Field visualisation | log-scaled \|B\| heat-map, field-line streamlines, a scientific vector quiver (length + brightness encode strength), and a reference grid |
| Slice control | view the XZ / XY / YZ plane at any offset through the 3-D scene |
| Field probe | drag the ⊕ pin to read the full 3-D **B** vector, in T / mT / µT / G / mG |
| Force & torque | dipole-model net force and torque on the selected body |
| Particle lab | launch electrons or protons at a chosen speed; real-time, adaptive Boris integration; live speed, kinetic energy and force readout |
| Scenarios | one-click presets: two magnets, solenoid, Helmholtz coils, horseshoe, wire + compass field, cyclotron orbit |

## Using it

The **canvas** is in the centre. Data read-outs and the particle/layer controls
are on the left; the source palette, object list and parameter inspector are on
the right. (On a phone the canvas becomes the hero and the panels stack below.)

**Interaction**

- **Drag an object** to move it in the view plane; **drag empty space** to pan.
- **Scroll** or **pinch** to zoom (zoom is centred on the cursor / pinch point);
  the on-canvas buttons do **＋ / − / Fit / reset**. **Fit** frames the actual
  size of the objects.
- **Drag the ⊕ probe pin** anywhere to read **B** at that point (mouse or touch).
- With an object selected: **arrow keys** nudge it (Shift = ×5, snaps to the grid
  when **Snap** is on), **Delete** removes it.
- Add sources from the palette; tune every parameter in the inspector; toggle
  visibility or delete from the object list.

## Running locally

It's plain static files (ES modules) — serve the folder over HTTP:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` via `file://` won't work: browsers block ES-module imports
on that protocol.)

## Hosting on GitHub Pages

1. Push to GitHub (this repo).
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Pick the branch and the `/ (root)` folder, then save.
4. The site appears at `https://<user>.github.io/magnetics/` within a minute.

There is no build step; the files are served as-is.

## Project layout

```
index.html          page markup + panel layout
styles.css          styling (incl. responsive / mobile layout)
src/physics.js      SI-unit field engine — vectors, magnets, Biot–Savart, Boris
src/sources.js      user objects + Scene (fields, force/torque, magnetic moments)
src/render.js       canvas visualisation (heat-map, streamlines, quiver, glyphs)
src/main.js         UI, interaction, scene state, particle simulation
tests/selftest.mjs  physics verification (npm test)
docs/PHYSICS.md     derivations, formulas, references
```

## Accuracy & limits

The honest list is in [docs/PHYSICS.md](docs/PHYSICS.md#visualisation-caveats).
In short: fields are exact for the idealised sources; the force/torque read-out
uses the dipole approximation (exact when bodies are well separated); the
electromagnet core-µ factor is a deliberately simple linear stand-in; particle
motion is non-relativistic; and the display is a 2-D slice of a fully 3-D
calculation.

## License

MIT.
