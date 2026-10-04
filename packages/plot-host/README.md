# @hatch3d/plot-host

Private local Node host for `@hatch3d/plot-core` sketches. Version 0.1.0 packages the current Hatch3D runner, CLI, and local study viewer. Build the core first, then run `npm run build --prefix packages/plot-host` and `npm run smoke --prefix packages/plot-host`. Neither package is published.

Install both local tarballs in a separate project and set `"type": "module"` in that project's `package.json` for TypeScript sketch imports of the ESM-only core. Import `Sketch` and helpers from `@hatch3d/plot-core`; use `renderSketch`, `inspectSketch`, or `startSketchServer` from `@hatch3d/plot-host`, or run `plot-sketch inspect|render|open path/to/sketch.ts`. The host accepts an absolute or current-directory-relative sketch path. Every render starts a fresh Node child, so source and transitive local imports reload. `open` serves only localhost; `--out` places pins outside the sketch source directory. SVG and PNG exports use the canonical render result.

`plot-sketch open sketch.ts --plotter-upload` is an explicit local option. It also requires `FEED_API_URL` and `FEED_API_TOKEN` in the Node process. The browser receives neither credential. It uploads only after a user action against the current successful render.

`checkpoint` and `replay` remain supported for sketches in the Hatch3D checkout at a retained Git revision. External source replay is a separate extraction step; ordinary external inspect, render, open, pins, and exports do not require the checkout.
