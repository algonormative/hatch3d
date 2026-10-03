# Hatch3d compositions in executable sketches

`src/sketch/hatch3d.ts` adapts existing composition definitions into ordinary `Sketch` modules. It calls the original 2D `generate` function or the original 3D `layers` function through `runPipeline`; it does not introduce a new composition format. The examples are [`sketches/hatch3d-2d/sketch.ts`](../sketches/hatch3d-2d/sketch.ts) and [`sketches/hatch3d-3d/sketch.ts`](../sketches/hatch3d-3d/sketch.ts).

```bash
npm run sketch -- inspect sketches/hatch3d-2d/sketch.ts
npm run sketch -- render sketches/hatch3d-2d/sketch.ts --seed 5 --out .sketch-output/hatch3d-2d
npm run sketch -- open sketches/hatch3d-3d/sketch.ts
npm run sketch -- render sketches/hatch3d-3d/sketch.ts --out .sketch-output/hatch3d-3d
```

The factory outputs a normal `Sketch` with declared page, pens, controls, and `draw(ctx)`. `createHatch3d2DLayer()` returns a smaller bundle with `controls`, `pen`, optional `assets`, and `draw(ctx)` for sketches that combine existing 2D algorithms with hand-authored parts. A 3D factory can include one paper-space 2D composition via `paper`; that part has a separate pen and is emitted after the 3D solids. Paper paths are independent ink on the page and do not occlude the solids.

Control IDs are namespaced as `<prefix>__control__<key>`, `<prefix>__macro__<key>`, `<prefix>__hatchgroup__<group>__<field>`, `<prefix>__view__<field>`, and `<prefix>__transform__<field>`. Legacy XY values become X and Y sliders, then a tuple before generation. Macros use the existing `resolveValues` behavior. `showWhen` gates are rewritten to the prefixed ID; select labels and original control groups are retained. Hatch group override toggles expose family, count, samples, and angle for each declared group. Disabled overrides inherit the global hatch settings. The Sketch seed is passed to the 3D hatch pipeline. For a seeded 2D generator, set `seedValueKey` to its numeric legacy seed field; the Sketch seed is added to that field's resolved value, so both `--seed` and its control affect output.

Legacy image controls require `assets` and an explicit `imageBindings` entry from control key to declared Sketch asset ID. The adapter passes the loaded brightness grid as the original `ImageSource` shape. It does not apply the legacy UI's `sampleSize` resampling; use an appropriately sized PNG when that distinction matters. An unbound image control throws when constructing the sketch.

The 2D placement controls pan in millimeters, scale uniformly, and rotate around the page center. Internal composition coordinates fit uniformly and are centered in the printable content area. The runner then clips final paths to the declared page margin. Physical pen widths are supplied by the Sketch `Pen` declarations.

The 3D adapter exposes the hatch family/count/samples/angle, camera projection/distance/theta/phi/pan, CPU depth occlusion/resolution/bias, and a mesh diagnostic. All solids from one legacy 3D composition are passed together through a single depth run, so its rings/connector can hide one another. Requested CPU occlusion throws on provider failure. Mesh paths are returned as `diagnostic: true`, available for inspection and preview but excluded from final SVG and plot statistics. The legacy 3D renderer's `hiddenMode: ghost`, depth-width bands, and silhouette style groups are not exposed: ghost opacity and SVG dashes do not represent separate physical plotter strokes, and the current adapter emits the 3D composition as one pen part. A composition's surface layers cannot be assigned different pens through this adapter. Multiple independent 3D compositions are not cross-occluded.

The legacy pipeline rounds SVG hatch coordinates to two decimal places in canvas coordinates (mesh diagnostics to one) before the adapter converts them to millimeters. For precise geometry preservation, use the original generator or hatch functions directly in a Sketch instead of this compatibility path.
