# Borrowed Orbits

An eight-pen Tabloid study in gravitational displacement. Particles start on exact drawn circles about an apparent centre with the circular velocity that centre would give, but the real, hidden mass sits elsewhere, so the trails precess, stretch, fall in or escape. An optional hidden perturber passes through during the run. The masses are never drawn; the pen draws trails, the exact guide circles, and a few forbidden solids that end trajectories. The [brief](brief.md) states the model, the approximations and the departures.

- `model.ts` is the contract, `sim.ts` the deterministic restricted N-body leapfrog with resumable snapshots.
- `layout.ts` builds the guides and the forbidden layouts (`bars`, `arc`, `gate`); `study.ts` builds the world (48 m x 78 m, dt 0.1 s), the masses, the seeded particles and the page mapping.
- `extract.ts` turns a position history into trails (simplified, tapered into dashes, clipped, optionally thinned), guides and forbidden outline and hatch; `sketch.ts` is the Hatch3D sketch.

From the Hatch3D repository root, render the pilots (steps 300, 600, 900 at the defaults, and the off state):

```bash
for id in pilot-early pilot-mid pilot-late pilot-off; do
  npm run sketch -- render sketches/borrowed-orbits/sketch.ts --config sketches/borrowed-orbits/configs/$id.json --out .sketch-output/borrowed-orbits/pilot/${id#pilot-}
done
npm run sketch -- open sketches/borrowed-orbits/sketch.ts
```

Checks: `npx vitest run src/__tests__/borrowed-orbits-sim.test.ts src/__tests__/borrowed-orbits-sketch.test.ts`.

## Plates

`plates.ts` is a second sketch, Orbit Plates: three plates of clean, integrated orbital systems drawn as lines only (orbits, small exact circles for bodies, small crosses for Lagrange points, short ticks for burns; no text, no arrows). The `plate` select chooses `hohmann` (circular orbits with integrated Hohmann transfers and scheduled burns), `lagrange` (restricted three-body in the rotating frame, with zero-velocity curves) or `threebody` (figure-eight, butterfly I, moth I, yin-yang Ia). The first-round sketch above is untouched. See "Plates: Orbit Plates" in the [brief](brief.md) for the SI scales and the catalog verification.

- `plates-study.ts` sets up each plate (SI scales, initial conditions, scheduled impulses, the chained runs for long periods); `plates-extract.ts` draws it; `lagrange.ts` and `contour.ts` hold the drawn-only references (Lagrange points, Jacobi field, marching-squares contours).

```bash
for id in hohmann lagrange lagrange-off threebody-figure8 threebody-butterfly threebody-moth threebody-yinyang; do
  npm run sketch -- render sketches/borrowed-orbits/plates.ts --config sketches/borrowed-orbits/configs/plate-$id.json --out .sketch-output/borrowed-orbits/plates/$id
done
```

Checks: `npx vitest run src/__tests__/borrowed-orbits-plates.test.ts`.
