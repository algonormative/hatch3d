# Executable sketches

A sketch is an ordinary TypeScript module with one default `Sketch` object. Page and path coordinates, margins, and pen widths are millimeters from the top-left of the page. The runner starts a fresh Node process for every render, so changes to local imports appear on the next render. Seed defaults to `0` and each named `ctx.random(partId)` stream is repeatable.

Existing hatch3d 2D and 3D compositions can be used through the [Sketch adapters](sketch-hatch3d.md), with runnable examples and physical pen parts.

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
npm run sketch -- render sketches/civic-weather/sketch.ts --config sketches/civic-weather/candidate-a.json --out sketch-output/civic-a
npm run sketch -- render sketches/civic-weather/sketch.ts --params '{"foregroundPitch":2.6}' --seed 41
npm run sketch -- render sketches/civic-weather/sketch.ts --finishing '@sketches/civic-weather/finishing.json' --png-theme paper --png-scale 6
npm run sketch:typecheck
```

`open` prints a local URL for controls, source reload, overlay, part inspection, and A/B pins. `--port N` selects its port; `--out directory` sets its pin location. The Pin button saves an immutable SVG, PNG, and `result.json` under `.sketch-output/<sketch-directory>/pins/` by default. It saves the current successful render only. `render` writes `render.svg`, `render.png`, and a direct `RenderResult` in `result.json`; without `--out`, it uses `sketch-output/<entry-name>/`. SVG and PNG come from the same final paths. Command results print JSON to stdout; errors print JSON to stderr and exit nonzero.

`--params` accepts an inline JSON control map or `@path/to/params.json`. `--finishing` accepts an inline JSON object or `@path/to/finishing.json`. A saved `--config path/to/request.json` may contain only `params`, `seed`, and `finishing`; for example `{"seed":41,"params":{"gap":5},"finishing":{"page":{"width":210,"height":148,"margin":12,"paper":"#f4ede0"},"border":{"style":"double","pen":"ink"},"pens":{"ink":{"width":0.4,"color":"#222222","passes":2}},"density":{"maxDensity":4,"cellSize":5}}}`. Do not combine `--config` with `--params`, `--seed`, or `--finishing`. The runner validates finishing against the sketch; pen IDs must name declared pens. Finishing changes the physical page, border, ink settings, and density of the canonical SVG and is recorded with the render result.

`render` and `replay` accept `--png-theme paper|light|dark` and `--png-scale 1|2|3|4|6|8`. The default is paper at 6 pixels per millimeter, close to the former 150 DPI render. Paper uses the selected paper color and actual inks. Light uses white with actual inks. Dark uses `#2a2a2f` and lightens neutral black ink; colored inks remain colored. PNG themes affect presentation only: `render.svg`, its physical colors, and its identity stay canonical. Exports are limited to 32 million pixels. `inspect` accepts `--timeout MS`; `render` accepts `--timeout MS`; both default to 30 seconds.

Use the saved result to capture a recoverable version or compare nominated parts:

```bash
npm run sketch -- checkpoint sketches/civic-weather/sketch.ts --result sketch-output/civic-a/result.json --out .sketch-output/checkpoints
npm run sketch -- replay .sketch-output/checkpoints/checkpoint-YYYYMMDDTHHMMSSZ-UUID --out sketch-output/replay
npm run sketch -- compare sketch-output/civic-a/result.json --after sketch-output/civic-b/result.json --parts arcade,tower --boundaries arcade,tower
```

`checkpoint --result` accepts either a direct render `result.json` or a pin's `result.json` wrapper. It copies the whole sketch directory and declared assets, records the Git revision, dependency lockfile, and finishing request, and verifies the captured source reproduces the supplied SVG before publishing the checkpoint. Shared source and runtime configuration outside the sketch must be clean at that revision. `replay` renders the capture in an isolated checkout and writes the same three output files; it fails on a byte or environment mismatch. `compare` asserts final paths, page, and pen settings including effective pass counts for `--parts`; `--boundaries` separately asserts saved region polygons. It prints `{ "ok": false, "changes": [...] }` and exits `2` on a conflict. These commands never prompt for confirmation.

The checkpoint limits and programmatic APIs are in [sketch-checkpoints.md](sketch-checkpoints.md). The first study and its decisions are in [the Civic weather brief](../sketches/civic-weather/brief.md).
