# Executable sketches

A sketch is an ordinary TypeScript module with one default `Sketch` object. Page and path coordinates, margins, and pen widths are millimeters from the top-left of the page. The runner starts a fresh Node process for every render, so changes to local imports appear on the next render. Seed defaults to `0` and each named `ctx.random(partId)` stream is repeatable.

For an independent external family, copy [`examples/plot-family-starter`](../examples/plot-family-starter/README.md) and install the private packed core and host packages using its exact commands. The copied mixed-study fixture is [`examples/plot-family-mixed`](../examples/plot-family-mixed/README.md). Each `open` command serves only that entry and its family controls.

Existing hatch3d 2D and 3D compositions can be used through the [Sketch adapters](sketch-hatch3d.md), with runnable examples and physical pen parts.

For slider groups, composition navigators, and sketch macros, see [Sketch controls and composition navigation](sketch-controls.md).

```ts
import type { Sketch } from '../../src/sketch/types.ts';

const sketch: Sketch = {
  name: 'Lines',
  page: { width: 210, height: 148, margin: 12, paper: '#ffffff' },
  pens: [{ id: 'ink', color: '#222222', width: 0.3 }],
  controls: [{ type: 'slider', id: 'gap', label: 'Gap', default: 5, min: 1, max: 10, step: 1, units: 'mm' }],
  draw(ctx) {
    return [{ id: 'lines', pen: 'ink', paths: [
      [{ x: 12, y: 12 }, { x: 198, y: 12 + Number(ctx.params.gap) }],
    ] }];
  },
};
export default sketch;
```

Adjust the import path for the sketch's location. Local helpers and existing pure primitives, such as `src/patch/region-hatch.ts` and `src/operators/silhouette-knockout.ts`, can be imported directly. Sketch code clips region and hole geometry; the runner clips final paths to the page margin. `boundary` stores authored region polygons for later preservation checks. Parts marked `diagnostic: true` are returned for inspection and omitted from the canonical SVG.

From the repository root:

```bash
npm run sketch -- inspect sketches/civic-weather/sketch.ts
npm run sketch -- open sketches/civic-weather/sketch.ts
npm run sketch -- open sketches/civic-weather/sketch.ts --plotprep /absolute/path/to/plotprep
npm run sketch -- render sketches/civic-weather/sketch.ts --config sketches/civic-weather/candidate-a.json --out sketch-output/civic-a
npm run sketch -- render sketches/civic-weather/sketch.ts --params '{"foregroundPitch":2.6}' --seed 41
npm run sketch -- render sketches/civic-weather/sketch.ts --finishing '@sketches/civic-weather/finishing.json' --png-theme paper --png-scale 6
npm run sketch:typecheck
```

`open` prints a local URL for controls, source reload, overlay, part inspection, and A/B pins. `--port N` selects its port; `--out directory` sets its pin location. The Pin button saves an immutable SVG, PNG, and `result.json` under `.sketch-output/<sketch-directory>/pins/` by default. It saves the current successful render only. `render` writes `render.svg`, `render.png`, and a direct `RenderResult` in `result.json`; without `--out`, it uses `sketch-output/<entry-name>/`. SVG and PNG come from the same final paths. Command results print JSON to stdout; errors print JSON to stderr and exit nonzero.

The local viewer can add an optional **Upload to plotter queue** button with `FEED_API_URL=https://your-feed-api.example FEED_API_TOKEN=... npm run sketch -- open sketches/civic-weather/sketch.ts --plotter-upload`. Both the flag and server-side environment settings are required. No upload request occurs when the server starts or the page loads; clicking the enabled button uploads only that tab's current successful render. A stale control, source change, or render error disables the action. The server sends the canonical SVG bytes and a paper-theme PNG preview from the same render to the Feed image endpoints, then adds the queue row under an ID stable across retries. Its config records the page, pen layers and pass counts, parameters, seed, and finishing. The token stays in the local Node process. Upload only creates a queue item: importing it into a plotter server and starting a multi-pen job with pen swaps are separate steps. The hosted Hatch3d app keeps SVG and PNG export but has no print-queue upload or browser credential.

`--plotprep /absolute/path/to/plotprep` enables optional local native SVG preparation. The executable is separate from the Node packages. After a successful render, **Prepare current SVG** can sort and reverse travel, merge nearby paths, or simplify geometry. The viewer shows the canonical and prepared pages side by side, with path and pen-up travel measurements; select **Source SVG** or **Prepared SVG** before exporting, pinning, or uploading. The selected PNG comes from that same SVG at the requested paper theme and scale. A prepared pin retains the canonical `art.svg` and result, plus `prepared.svg`, `preparation.json`, and its selected preview. A prepared upload sends both SVGs and records their hashes for the plotter server. Changing source code, a statically imported helper, declared assets, controls, finishing, or preparation settings invalidates the derivative before another action. Native preparation never changes the canonical result or checkpoint; the source-change guard covers the resolved static import graph and declared assets, not arbitrary runtime file reads. To combine with the optional queue action, pass both `--plotprep` and `--plotter-upload`.

`--params` accepts an inline JSON control map or `@path/to/params.json`. `--finishing` accepts an inline JSON object or `@path/to/finishing.json`. A saved `--config path/to/request.json` may contain only `params`, `seed`, `finishing`, and `format`; for example `{"seed":41,"params":{"gap":5},"finishing":{"page":{"width":210,"height":148,"margin":12,"paper":"#f4ede0"},"border":{"style":"double","pen":"ink","inset":12,"contentGap":6},"pens":{"ink":{"width":0.4,"color":"#222222","passes":2}},"density":{"maxDensity":4,"cellSize":5}}}`. Do not combine `--config` with `--params`, `--seed`, `--finishing`, `--page`, or `--format`. The runner validates finishing against the sketch; pen IDs must name declared pens. Finishing changes the physical page, border, ink settings, and density of the canonical SVG and is recorded with the render result.

**Page-aware sketches.** By default `finishing.page` fits the drawing uniformly onto the requested sheet: geometry shrinks, pitches and pen tolerances with it. A sketch that sets `pageAware: true` instead draws on the requested page: `ctx.page` is `finishing.page` over the declared page, and finishing resolves against that page, so the page adds no rescale (a border's content gap still fits the art inside the border, as it does at the declared page). When the request gives no margin, the declared margin scales with the page by the smaller axis ratio (`targetPage`). `--page WxH[,margin]` on `render` is shorthand for `finishing.page`'s width, height and margin, e.g. `--page 70x120`. The flag is static and stays out of the metadata, so a page-aware sketch rendered without `finishing.page`, or with one equal to its declared page, keeps its identity. Modules that lay themselves out when they load (a format module) read the requested page, and `--format '{"fit":"width"}'` options, through the render target (`src/sketch/render-target.ts`): the render process publishes it before importing the sketch. Format options are recorded in the result, and in its identity, only when given. A sketch that is not page-aware but loads such a module is rendered again in a fresh process with nothing published, so it keeps its own page.

`border.inset` sets the outer border centerline's distance from the paper edge. `border.contentGap` reserves clear paper between the innermost border stroke and artwork strokes; the source composition is fitted inside that area. Both values are millimeters. Double borders include the second line's inset, `border.lineGap` (2 mm unless set); ticked and crop-mark borders require enough outer inset to keep their full stroke on the sheet. The viewer starts a newly selected border at 12 mm inset and 6 mm artwork gap. Existing finishing requests and checkpoints without these fields retain their prior page-margin geometry and identity.

`render` and `replay` accept `--png-theme paper|light|dark` and `--png-scale 1|2|3|4|6|8`. The default is paper at 6 pixels per millimeter, close to the former 150 DPI render. Paper uses the selected paper color and actual inks. Light uses white with actual inks. Dark uses `#2a2a2f` and lightens neutral black ink; colored inks remain colored. PNG themes affect presentation only: `render.svg`, its physical colors, and its identity stay canonical. Exports are limited to 32 million pixels. `inspect` accepts `--timeout MS`; `render` accepts `--timeout MS`; both default to 30 seconds.

Use the saved result to capture a recoverable version or compare nominated parts:

```bash
npm run sketch -- checkpoint sketches/civic-weather/sketch.ts --result sketch-output/civic-a/result.json --out .sketch-output/checkpoints
npm run sketch -- replay .sketch-output/checkpoints/checkpoint-YYYYMMDDTHHMMSSZ-UUID --out sketch-output/replay
npm run sketch -- compare sketch-output/civic-a/result.json --after sketch-output/civic-b/result.json --parts arcade,tower --boundaries arcade,tower
```

`checkpoint --result` accepts either a direct render `result.json` or a pin's `result.json` wrapper. In-repository studies retain checkpoint version 1: capture the sketch directory, Git revision, lockfile, and finishing request, then replay in an isolated checkout. Installed external families use version 2: capture the family source and declared assets, exact request, package and lock bytes, and installed toolkit/dependency tarballs. An offline isolated install must reproduce the SVG and identity before publication; replay no longer needs the original family project, but requires the recorded Node/npm versions and platform architecture. Both formats fail on source, dependency, or environment mismatch. `compare` asserts final paths, page, and pen settings including effective pass counts for `--parts`; `--boundaries` separately asserts saved region polygons. It prints `{ "ok": false, "changes": [...] }` and exits `2` on a conflict. These commands never prompt for confirmation.

The checkpoint limits and programmatic APIs are in [sketch-checkpoints.md](sketch-checkpoints.md). In a copied, installed family project, run `./node_modules/.bin/plot-sketch experiment experiments/matched-regimes.json --out output/matched-regimes`. The [experiment contract](sketch-experiments.md) covers limits, fingerprints, resume, and the labeled contact sheet. The first study and its decisions are in [the Civic weather brief](../sketches/civic-weather/brief.md).
