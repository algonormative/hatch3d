# Sketch lab

A browser tuning page for any sketch, for publishing as a Claude artifact (or serving from any static host):

```bash
npm run sketch -- lab sketches/breach-triptych/upward-erasure/sketch.ts --seed 1 --out .sketch-output/upward-erasure-lab
```

It writes `index.html` (the page, titled with the sketch's name; `--title` overrides, `--seed` sets the seed it opens at) and `worker.js` (the sketch and `cli/sketch/lab/runtime.ts` bundled for the browser). Publish `index.html` with `worker.js` beside it. As a Claude artifact, declare the capabilities `db`, `user` and `downloads`: saved sets live in the artifact's database, in the collection `presets` (`name`, `params`, `seed`, `createdAt`), and exports are offered through downloads.

The page builds its controls from `sketch.controls` (sliders, toggles, selects and text, with their groups and `showWhen`; `expensive` controls are marked slow). An assembly shows the assembled piece, each ply's paper less its own cuts, bottom to top, onlays as their footprints, and each sheet alone with its cuts dashed. "Drift" steps any slider after every redraw. Exports: each sheet's SVG as the sketch draws it (no finishing), and the parameters as JSON.

The worker draws with the CLI's random streams (SHA-256 of `seed\0id`, then mulberry32; `src/__tests__/sketch-lab.test.ts` checks them against `cli/sketch/child.ts`'s), so a set saved from the page renders the same through `npm run sketch -- render --params` and the finalize stack. The worker keeps the sketch module loaded between requests: a sketch that caches a costly stage at module level, keyed by the parameters that shape it, redraws the rest quickly (Upward Erasure keeps its head, and its world across plies).

The page reads no files and sends nothing anywhere but the artifact's own database and downloads.
