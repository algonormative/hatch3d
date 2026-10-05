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
