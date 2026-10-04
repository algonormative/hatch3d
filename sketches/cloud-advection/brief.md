# Prescribed Weather

Architectural members enter from the left and right edges of the frame and stop short of the middle, leaving a missing span. A large bank of smoke starts against the right frame edge, riding over the right deck. A prescribed wind carries it left across the page, a pair of eddies curl it, and it finally lands on the left pier and wraps round its end. The cloud is drawn as plotted contour wisps in one cool pen, and where it is dense it conceals the structure behind it. The center stays quiet. Steps 0, 30 and 60 are three moments of one simulation: the bank sits on the right deck, crosses the upper middle, and ends against the left pier with a clean wake beyond it.

This is a new study beside Load Bearing Silence. It reuses that sketch's grammar (named pens, contour wisps from `hatchAtmosphere`, path cutting from `maskAtmospherePaths`) and does not change it.

## Physical model

A passive scalar, concentration `c` (dimensionless, one unit is the source peak), is carried by a **prescribed** velocity field: a uniform wind plus regularized point vortices, `v = Γ/(2π) · perp(r) / (|r|² + core²)`. There is no momentum equation, so this is not weather or measured cloud. Transport is semi-Lagrangian: RK2 backtrace of each cell center, bilinear interpolation of the old field. A backtrace that is blocked (by a solid or a closed edge) reads zero. Optional isotropic diffusion (`dispersion`, m²/s; exactly zero turns it off). Units are metres and seconds; y grows downward like page millimetres. The domain is 48 m × 78 m on a 0.4 m grid (120 × 195 cells) with a fixed `dt` of 0.5 s, so step 30 is 15 s and step 60 is 30 s. Before finishing, the domain maps onto the Tabloid poster target at 5.074 page mm per metre (`transforms.worldToPage`); the double-border finishing pass then enlarges the art by about 1.9%, so the plotted scale is about 5.17 mm per metre. An independent probe matched solid corners in the rendered output to this chain within 0.001 mm.

The initial condition is one smooth, seeded, billowed ellipse of smoke (`smoke-source`); there is no continuous emission. The simulation is deterministic: its state key hashes the geometry, transforms, and simulation settings, and a snapshot resumes only under an equal key. Snapshots are JSON; `evidence.ts` proves that parsing step 30 and advancing 30 more steps reproduces step 60 byte for byte.

The sim lives in `sim.ts`; `model.ts` is the type contract. Simulation region ids (`wind`, `smoke-source`, `eddy-a`, `eddy-b`, `solid-*`) are independent of the physical pen part ids (`cloud-<pen>`, `structure-<member>`).

## Structure

Three heavy deck slabs, two piers, and one fin plate 0.15 m thick, thinner than a grid cell. Each member is a solid polygon in the simulation and an outline plus interior hatch on paper. Positions vary slightly with the seed through the named `structure` stream. The fin is thin on purpose: it must still stop transport. It covers no cell center, so it stops transport through exact segment tests against its polygon edges, not through the raster mask.

## Approximations

- **Solids are perfect absorbers in an undeflected flow.** There is no pressure projection, so the wind goes straight through where a real flow would go around. A solid face removes the scalar that meets it, and a blocked backtrace reads zero, so the air behind a member is a clean wake with no concentration. Solid polygon edges block as geometry, not through the raster mask, so the 0.15 m fin (thinner than a 0.4 m cell) still stops transport. Absorption is a strong sink: a cloud that meets a long face is mostly consumed there, which is why the default bank is large and its path crosses open air before it meets a member.
- **Not exactly mass-conserving.** Semi-Lagrangian interpolation smooths and can shift mass slightly; mass is removed by solid absorption and, on an open boundary, by outflow. The budget is reported rather than hidden: `numerics.json` carries the per-step series and each render's diagnostic part id carries `relativeDrift`.
- **Boundary.** `open` (default): a backtrace that leaves the domain reads zero, so clean air flows in and carried concentration leaves the budget. `closed`: the edges are perfect absorbers like the solids (clean lee, nothing re-enters). The choice is declared in the config and tested in the sim.
- Vortices are prescribed point vortices of fixed strength; they do not interact or decay. `eddy-b` is a weaker counter-rotating partner mirrored through the domain center.
- Diffusion (default 0.1 m²/s) and the grid are coarse by design: 0.4 m cells are about 2 mm of page, and semi-Lagrangian interpolation adds its own numerical diffusion.

## Artistic departures

- **The quiet core is an extraction mask, not physics.** The simulation knows nothing about it. After contour extraction every cloud mark inside the core circle (page mm, offset from the page center) is cut exactly along the circle. Moving or resizing the core never changes simulation state.
- **One field for contours, concealment, and visibility.** Fluid concentration is spread into solid cells by neighbor averaging on a copy of the snapshot, so the field passes smoothly through members (inside a solid the raw density is zero, which would stack every contour level on each face). That one field, `clamp01(c / referenceDensity)`, is contoured into cloud wisps, conceals members, and decides where a member counts as visible.
- **Obscured members read as behind the cloud.** The 2D model has no depth. Members are cut where the field is at least `1 - 0.98·sqrt(obscure)`, the same threshold `maskAtmospherePaths` uses; `obscure` 0 returns the members exactly as authored.
- **Cloud never draws over a visible member.** Cloud marks are cut inside a member wherever it is visible, and within 0.6 page mm of any visible outline run, so no wisp touches a visible outline. Interior hatch ends at a concealment boundary are not given that clearance: a wisp can end within about 0.05 mm of one, which a 0.25 mm pen will touch, though no wisp crosses drawn structure. Where the member is concealed the cloud may cross it, which is the cloud-in-front reading and uses the same rule as the concealment, not a second one. With `obscure` 0 every member is always visible and the cloud stays fully outside.
- **The fixed concentration to contour mapping.** `referenceDensity` is a declared constant (default 0.8; the step-0 peak at the default settings is 0.83), not computed per frame, so a thinning cloud loses inner bands rather than being rescaled: dilution shows. Which contour levels become wisps, their spacing, and the gaps that break them are drawing choices inherited from `hatchAtmosphere`.
- The cloud's densest interior (above the 0.68 level) stays paper; only the shoulders and inner bands are inked.
- A cloud mark and a member may both be absent where the cloud is dense: that is partial vanishing, not an error.

## Controls

`step` (0–120) and the Simulation group (`windX/Y`, `eddyX/Y`, `eddyCirculation`, `eddyCore`, `dispersion`, `boundary`, `sourceX/Y/Size`) change the simulation. The Marks group (`referenceDensity`, `cloudHatchPitch`, `cloudPen`, `obscure`, `coreRadius/X/Y`) and Structure `hatchPitch` only re-extract marks from the same snapshot. `cloudEnabled` off draws the structure as authored and does not run the simulation. Navigators: radar `weather` (turbulence, drift, obscure), xy `wind`, xy `eddy`, xy `quiet-core`, xyz `source`. `turbulence` drives eddy circulation, core, and dispersion; `drift` drives the wind. Hatch spacing and feature scale are final page mm before the finishing pass; a double border at `inset: 12` enlarges the poster art by about 1.9%, and the quiet-core radius is measured before that pass too. `dispersion` stops at 0.7 m²/s so that, with `turbulence` adding up to 0.3, diffusion stays within the 16-substep limit.

## Run

```bash
npm run sketch -- render sketches/cloud-advection/sketch.ts --config sketches/cloud-advection/configs/step-30.json --out .sketch-output/cloud-advection/step-30
npx tsx sketches/cloud-advection/evidence.ts .sketch-output/cloud-advection/evidence
```

The four configs (`off`, `step-00`, `step-30`, `step-60`) share seed 211, the abstract poster mode, the same page mapping and mark threshold, and every parameter except `step` (and `cloudEnabled: false` for `off`). These are design studies; pen density and registration still need a test plot.
