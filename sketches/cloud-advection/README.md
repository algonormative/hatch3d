# Prescribed Weather

An eight-pen Tabloid study: heavy architectural members continue toward the frame and are partly hidden by cloud that is advected through a prescribed wind and eddy field, with a quiet core left clear. The [brief](brief.md) states the physical model, its approximations, and where the drawing departs from the physics. The cloud is a passive scalar carried by prescribed flow; it is not weather. Members absorb it and leave a clean wake, but the flow does not bend around them.

- `model.ts` is the shared type contract and `sim.ts` the deterministic semi-Lagrangian solver with resumable JSON snapshots.
- `layout.ts` holds the six structure layouts (`span`, `orbit`, `colonnade`, `portal`, `ring`, `sun`); `study.ts` builds the world (48 m × 78 m, 0.4 m grid), the structure, and the page mapping.
- `extract.ts` turns one snapshot into plotter paths (contour wisps and flow streaks) with a fixed concentration mapping; `sketch.ts` is the Hatch3D sketch.
- `evidence.ts` writes the snapshots and `numerics.json` (mass drift, resume equality, mark-only invariance) next to the renders.

From the Hatch3D repository root:

The chosen edition is `configs/edition-{early,mid,late,off}.json`: the sun layout against an inflow weather front with an eddy train (kirchhoff drift), weather seed 20, steps 116, 149 and 182. The `weather-a-*`, `weather-b-*` and `orbit-*` configs are earlier candidates, and the original `off`/`step-*` configs keep the first `span` pilot.

```bash
for id in edition-early edition-mid edition-late edition-off; do
  npm run sketch -- render sketches/cloud-advection/sketch.ts --config sketches/cloud-advection/configs/$id.json --out .sketch-output/cloud-advection/$id
done
npx tsx sketches/cloud-advection/evidence.ts .sketch-output/cloud-advection/evidence
npm run sketch -- open sketches/cloud-advection/sketch.ts
```

Checks: `npx vitest run src/__tests__/cloud-advection-sim.test.ts src/__tests__/cloud-advection-sketch.test.ts`.
