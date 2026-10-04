# @hatch3d/plot-core

Private local package for executable pen-plotter sketches. Version `0.1.0` records the first extraction boundary. Build with `npm run build --prefix packages/plot-core`; this produces a local `dist/` for packing or installation. It is not published. The current Hatch3D sketch runner still imports the tracked package source so checkpoint replay does not require a prebuilt library. Runner, CLI, viewer, PNG export, and external checkpoint installation are separate host work.

## Entry points

- `@hatch3d/plot-core` — `Sketch`, `RenderResult`, metadata and physical types; validation, parameter and part normalization, canonical SVG assembly, finishing, stroke fonts, native macro values and navigator math. This import contains no React, Three.js, WebGL, or Node API.
- `@hatch3d/plot-core/planar` — legacy Hatch3D 2D composition adapter and 2D layer helper. The adapter converts canvas coordinates to millimeters and gives the layer named controls and a pen. This import has the same lightweight dependency boundary as core.
- `@hatch3d/plot-core/spatial` — optional legacy Hatch3D 3D composition adapter bundled with its CPU depth pipeline. Install compatible `three` and `simplex-noise` peers to use it; TypeScript consumers also need `@types/three`. It creates one solids pen part, and can add a separate paper-space 2D pen; it does not generally style or cross-occlude independent physical ink parts.
- `@hatch3d/plot-core/controls` — optional browser DOM panel for scalar controls, groups, conditions, macros, and radar/XY/XYZ editors. It is absent from the core index and does not touch `document` at import time. Pair it with `@hatch3d/plot-core/controls.css`; the stylesheet scopes rules to mounted panel hosts.

```ts
import type { Sketch } from '@hatch3d/plot-core';
import { strokeText } from '@hatch3d/plot-core';

const sketch: Sketch = {
  name: 'Tiny label',
  page: { width: 210, height: 148, margin: 12 },
  pens: [{ id: 'black', color: '#202020', width: 0.3, passes: 1 }],
  controls: [],
  draw: () => [{ id: 'label', pen: 'black', paths: strokeText('A', 25, 25, { height: 8 }) }],
};
export default sketch;
```

All page, point, stroke-width, border, inset, gap and finishing dimensions are **millimeters**. The origin is the top-left of the physical page: X grows right and Y grows down. `Part.paths` are polylines with at least two finite points; each part has a stable ID and references one declared pen. `boundary` is preservation metadata and is not drawn. `diagnostic` parts remain in results but are omitted from canonical SVG and plot statistics. Controls retain declaration order and values must match their type, slider range and step lattice. Macro resolution passes effective values to `draw` while the requested values stay in `RenderResult.params`.

`validateSketch`, `resolveParams`, `finalParts`, `resolveFinishing`, `svgFor`, and the font/control functions are public, deterministic operations. `finalParts` clips to the page margin without finishing, or applies the resolved finishing transform, density and border. `svgFor(metadata, parts)` emits the canonical SVG: physical `mm` dimensions, matching viewBox, one numbered Inkscape layer per pen, `data-pen-id`, `data-passes`, and named part groups. Paths use rounded caps/joins and 0.001 mm coordinate quantization. Keep pen order and part order stable when exact SVG identity matters.

`RenderResult.identity` and named seeded streams are assigned by the Node runner child, outside this browser-safe core. The child hashes the ordered metadata/params/seed/parts/SVG payload with SHA-256 and seeds each named stream from SHA-256(seed, part ID). The core contract describes the result; it does not claim a browser hash implementation. The local runner also loads raster assets and measures output. `fixtures/legacy-renders.json` freezes pre-extraction identities, SVG hashes, parts and statistics for 2D, multi-pen, lettering with frame, and shared occlusion examples.

## Browser control panel

```ts
import { mountControlPanel } from '@hatch3d/plot-core/controls';
import '@hatch3d/plot-core/controls.css';

let params = Object.fromEntries(sketch.controls.map(control => [control.id, control.default]));
const panel = mountControlPanel({
  controlsHost: document.querySelector('#controls')!,
  navigatorsHost: document.querySelector('#navigators')!,
  controls: sketch.controls,
  navigators: sketch.navigators,
  macros: sketch.macros,
  params,
  onChange(patch, { expensive }) {
    params = { ...params, ...patch };
    if (!expensive) render(params);
  },
  onCommit() { render(params); },
});
```

`params` are caller-owned canonical values. `panel.update({ params })` synchronizes external changes without emitting callbacks or replacing active DOM; `update({ controls, navigators, macros, params })` rebuilds on source changes and retains focus when possible. `panel.reset(group?)` cancels active gestures and emits one full defaults patch with `{ expensive: false }`, even when the values are unchanged or the patch is empty; it does not call `onCommit`. `cancel()` abandons active pointer gestures, and `dispose()` removes owned DOM and listeners. Expensive sliders and navigator gestures report changes immediately but call `onCommit` on release or keyboard commit. Pass two distinct host elements per panel; multiple instances keep their own IDs and state. The independent [control-panel example](../../examples/plot-controls-panel/README.md) mounts the same entry from a packed dependency.
