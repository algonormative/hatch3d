# Sketch lab

A browser tuning page for any sketch, for publishing as a Claude artifact (or serving from any static host):

```bash
npm run sketch -- lab sketches/breach-triptych/upward-erasure/sketch.ts --seed 1 --out .sketch-output/upward-erasure-lab
```

It writes `index.html` (the page, titled with the sketch's name; `--title` overrides, `--seed` sets the seed it opens at; `--starts` and `--brief` are below) and `worker.js` (the sketch and `cli/sketch/lab/runtime.ts` bundled for the browser). Publish `index.html` with `worker.js` beside it. As a Claude artifact, declare the capabilities `db`, `user` and `downloads`: saved sets live in the artifact's database, in the collection `presets` (`name`, `params`, `seed`, `createdAt`), and exports are offered through downloads.

The page builds its controls from `sketch.controls` (sliders, toggles, selects and text, with their groups and `showWhen`; `expensive` controls are marked slow). An assembly shows the assembled piece, each ply's paper less its own cuts, bottom to top, onlays as their footprints, and each sheet alone with its cuts dashed. "Drift" steps any slider after every redraw. Exports: each sheet's SVG as the sketch draws it (no finishing), and the parameters as JSON.

**Browse** shows a grid of sets, drawn by a few workers of their own. Each set opens in the Piece tab, can be saved, or can seed a new batch ("More like this"):

- **Picks:** the sketch's named sets (`--starts`), then the saved ones.
- **Seeds:** the current set at a run of seeds.
- **One setting:** one control across its range, or every option of a select.
- **Generate:** a batch around the current set: about half of the visible sliders in the ticked groups each move by a random amount, a little, more or a lot, and optionally a new seed each. A hidden control (one whose `showWhen` is not met) is left alone.

Every set in a grid, and the current one in the Piece tab, is then **checked for the plotter**: the sketch's own `draw` on every sheet, which refuses what a pen or a knife cannot do. The grid says "Plots" (its tooltip has the ink by pen) or "Will not plot" and why. This is the check to trust: a preview from `labSheets` can draw what `draw` then refuses.

"This set, as text" gives the current set as JSON and the commands that render it, and loads a set pasted back in.

`--starts FILE.json` names sets to start from, shipped inside the page, so they need no database:

```json
{
  "starts": [{ "id": "column", "name": "Column", "note": "Scales on the colour.", "seed": 1, "params": { "figure": "slipped" } }],
  "generate": { "groups": ["Plates", "Glitch"] },
  "preview": { "widths": { "black": 0.55 } }
}
```

`generate.groups` are the groups ticked at first (all, without it). `preview.widths` draws a pen at another width in the page only, for a pen whose declared width is narrower than its line on paper, so that passes meant to fuse look fused. With starts, the page opens on Browse.

`--brief FILE.html` adds a tab showing an HTML fragment: the place for what someone needs to pick the work back up. Files it links to are published beside the page.

The worker draws with the CLI's random streams (SHA-256 of `seed\0id`, then mulberry32; `src/__tests__/sketch-lab.test.ts` checks them against `cli/sketch/child.ts`'s), so a set saved from the page renders the same through `npm run sketch -- render --params` and the finalize stack. The worker keeps the sketch module loaded between requests: a sketch that caches a costly stage at module level, keyed by the parameters that shape it, redraws the rest quickly (Upward Erasure keeps its head, and its world across plies).

The page reads no files and sends nothing anywhere but the artifact's own database and downloads.

## Readability crops

The same visual check each design round: a thumbnail of the whole sheet at viewing-distance scale, plus close crops around named page points ("is the nose still a nose at a glance?"). `readabilityCrops` in `cli/sketch/crops.ts` takes a PNG of the sheet, the page (`width`, `height`, `margin`, mm) and `at`, a map of names to page points in mm, and writes `thumb.png` (the whole image scaled to `thumbPx` high, default 240) and `crop-<name>.png` (a square `sizeMm` around the point, default 40, scaled to 600 px wide; beyond the image edge is white). With `trimmed: true` the PNG covers only the page inset by its margin, as `cli/assembly.ts preview` writes `assembled.png`. It returns `{ thumb, crops }` with the file paths.

`landmarksOf(parts)` reads the points from diagnostic parts named `landmark-<name>` (the first point of the first path), so a sketch names its own features: Upward Erasure returns `landmark-nose`, `landmark-eyes`, `landmark-mouth` and `landmark-chin`, which the SVG never carries.

Intended command line (the flags map straight onto the options):

```bash
npm run sketch -- crops <image.png> --page WxH[,margin] [--trimmed] [--result result.json] [--at name=x,y ...] [--size mm] [--out dir]
```

`--result` takes the landmarks from a render's `result.json` (via `landmarksOf`); each `--at` adds or overrides a point.

## A fast preview for assemblies

An assembly's sheets are each drawn through `renderPly`, whose exact clipping is what the plotter needs but the page does not (it clips on the canvas). A sketch module may also export `labSheets(ctx)`, returning each ply's art unclipped and the rings cut from it (`LabSheets` in `cli/sketch/lab/runtime.ts`); the lab then previews from it, and still exports SVGs through `draw`. Upward Erasure's preview redraws its visor and glitch in about 0.8 s this way (against about 4.5 s through `draw`), and the two share one cached world.

## The GPU preview

Where the browser has WebGPU (`navigator.gpu` in the worker), Upward Erasure's preview meshes its head on the GPU (`sketches/kit/sculpt-gpu.ts`): the head's field, recorded as a node tree by the sculpt primitives, is written as a WGSL compute shader (`sculpt-wgsl.ts`) that evaluates the grid and snaps the vertices; surface nets stay on the CPU. The preview then reads its lines' head-or-neck and plate tests from the vertices rather than the field. It is a close likeness in 32-bit floats; exports and saved sets still render through `draw` on the CPU, exactly. Without WebGPU the same preview path meshes on the CPU.

A slow (`expensive`) control draws a draft first (a coarser mesh, no line thinning) and then the full frame. Measured on an Apple M-series GPU: a head change drafts in about 0.8 s and finishes in about 2 s; a visor or glitch change redraws in about 0.6 s.
