# Hatched atmosphere

`@hatch3d/plot-core` exposes a deterministic, pen-only atmosphere treatment for
2D polylines. It pairs one scalar cloud field with two operations: cutting
structures into visible runs and tracing sparse contour wisps on cloud shoulders.
There is no SVG opacity, raster mask, or per-path random draw.

```ts
import {
  createAtmosphere, maskAtmospherePaths, hatchAtmosphere,
} from '@hatch3d/plot-core';

const bounds = { xMin: 0, yMin: 0, xMax: 279.4, yMax: 431.8 };
const field = createAtmosphere({
  bounds, seed: 211, depth: 0.7, scale: 24,
  center: { x: 140, y: 205 }, clearRadius: 30,
});
const visible = maskAtmospherePaths(structurePaths, field, {
  amount: 0.65, sampleStep: 2, minLength: 0.5,
});
const cloudInk = hatchAtmosphere(bounds, field, {
  spacing: 3.5, angle: Math.PI / 5,
});
```

All coordinates, scale, spacing, radius, sample step, and minimum length use
the caller's coordinate unit (millimeters for a physical Sketch). `depth`
means 0 clear to 1 strongest far-field obscuration; `amount` sets how far
the mask contour advances into the cloud. Optional mask `depth` multiplies
that advance and defaults to 1. `amount: 0` returns the original path arrays
without resampling. The same seeded field gives neighboring structure a
coherent disappearance pattern and locates curved cloud marks at its
mid-density edges. `angle` is a preferred wisp tangent and break-field
orientation in radians, while `spacing` controls approximate contour
separation. High-density cloud cores remain mostly paper-white.

The mask subdivides long segments, refines visibility crossings, and emits
separate pen-up paths around concealed intervals. Feed it already projected,
depth-occluded polylines. Apply any artistic core or light exclusions when
choosing which paths enter the mask. The hatches are real, broken polylines;
put them on a chosen physical pen. Callers choose the final printable bounds
and can clip the resulting geometry to a page margin as usual. Invalid or
nonfinite inputs and pathological sampling requests fail with `RangeError`
instead of silently exhausting memory.
