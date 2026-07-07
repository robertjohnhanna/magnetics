# ⌁ Magnetics — magnetic field lab

An interactive, **physics-accurate** magnetic field simulator that runs entirely
in the browser. Build scenes from permanent magnets, electromagnets, current
loops, wires, dipoles and moving charges; see the field as a heatmap, field
lines and vectors; probe the exact **B** vector anywhere; read forces and
torques; and launch electrons/protons to watch them move under the real Lorentz
force.

No installation, no accounts, no lab equipment — just open the page.

👉 **[Live demo](https://robertjohnhanna.github.io/magnetics/)** (enable GitHub
Pages, see below)

## Why it's trustworthy

The field engine is not a toy approximation. It uses the same closed-form
solutions as professional tools and every routine is checked against an
independent analytical limit:

- **Permanent magnets** — exact field of a uniformly-magnetised block, validated
  against Maxwell's equations (∇·B = 0, ∇×B = 0) and the dipole far field.
- **All currents** — exact finite-segment Biot–Savart (wires, loops, solenoids),
  validated against the infinite-wire and on-axis-loop formulas and μ₀nI.
- **Cylinder magnets** — modelled as their exact bound-current equivalent.
- **Charged particles** — a Boris pusher, validated against the analytic
  gyro-radius and energy conservation.

Run the checks yourself:

```bash
npm test        # 17 physics assertions, all from first principles
```

Full derivations and references: **[docs/PHYSICS.md](docs/PHYSICS.md)**.

## What you can do

| Feature | Notes |
|---|---|
| Multiple permanent magnets | bar (cuboid) and disc/cylinder; set size, remanence Br by material grade (N35–N52, SmCo, ferrite…), position and 3-axis orientation |
| Electromagnets | solenoids with turns, current, geometry, optional core factor |
| Current loops & straight wires | any current, incl. reversed |
| Point dipoles & moving charges | ideal dipole; a charge with velocity produces both **E** and **B** |
| Field visualisation | log-scaled \|B\| heatmap, field-line streamlines, vector glyphs, grid |
| Slice control | view XY / XZ / YZ planes at any offset |
| Field probe | hover or Shift-click to read the full 3-D **B** vector, in T / mT / µT / G |
| Force & torque | dipole-model net force and torque on the selected body |
| Particle lab | launch electrons, protons or a custom q/m; real-time Boris integration; live speed, kinetic energy and force readout |
| Scenarios | one-click presets: two magnets, solenoid, Helmholtz coils, wire field, cyclotron orbit |

### Controls

- **Drag** an object to move it in the view plane · **scroll** to zoom · **drag
  empty space** to pan · **Shift-click** to pin a field probe.
- Add sources from the left panel; edit every parameter in the right-hand
  inspector.

## Running locally

It's plain static files (ES modules) — serve the folder over HTTP:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` via `file://` won't work because browsers block ES-module
imports on that protocol.)

## Hosting on GitHub Pages

1. Push to GitHub (this repo).
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Pick the branch and `/ (root)` folder, save.
4. The site appears at `https://<user>.github.io/magnetics/` within a minute.

There is no build step; the files are served as-is.

## Project layout

```
index.html          page + layout
styles.css          styling
src/physics.js      SI-unit field engine (verified)
src/sources.js      user objects + scene (force/torque, moments)
src/render.js       canvas visualisation (heatmap, field lines, glyphs)
src/main.js         UI, interaction, particle simulation
tests/selftest.mjs  physics verification (npm test)
docs/PHYSICS.md     derivations, formulas, references
```

## Accuracy & limits

Read [docs/PHYSICS.md](docs/PHYSICS.md#visualisation-caveats) for the honest
list. Short version: fields are exact for the idealised sources; the force/torque
readout uses the dipole approximation (exact when bodies are well separated); the
electromagnet core factor is a deliberately simple linear stand-in; and the
display is a 2-D slice of a fully 3-D calculation.

## License

MIT.
