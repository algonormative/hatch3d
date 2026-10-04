# Independent plot family starter

From the Hatch3D checkout, make a copied project and install local tarballs (these private packages are not in a registry):

```bash
npm run plot-host:build
mkdir -p /tmp/plot-toolkit-packs
npm pack ./packages/plot-core --pack-destination /tmp/plot-toolkit-packs
npm pack ./packages/plot-host --pack-destination /tmp/plot-toolkit-packs
cp -R examples/plot-family-starter /tmp/my-plot-family
cd /tmp/my-plot-family
npm install /tmp/plot-toolkit-packs/hatch3d-plot-core-0.1.0.tgz /tmp/plot-toolkit-packs/hatch3d-plot-host-0.1.0.tgz
npm run typecheck
npm run render
npm run open
```

The install resolves declared third-party dependencies. `npm run open` starts a local Node viewer for this entry; close it with Ctrl-C. Output, pins and installed dependencies are ignored by this family project.

Copy this directory for a new family. Keep the brief, sketch, helper, source assets and named requests together under `family/`; outputs live in `output/` or a separate path. `package.json` declares the private packed toolkit packages by exact version. The included `"type": "module"` supports TypeScript imports of the ESM-only core. Run `npm run inspect`, `npm run render`, or `npm run open` after installation. The view opens this sketch directly, without a universal composition selector.

Edit `family/geometry.ts` and `family/sketch.ts` with an agent or editor, then render a small matched request before a larger sweep. The viewer reloads source imports, supports controls and pins, and exports the canonical full SVG/PNG. Keep the chosen request, source files and SVG identity together; a pin alone does not preserve runnable source. `plot-sketch checkpoint` captures this family and its installed dependencies for isolated replay. The PNG under `assets/` is a reference overlay and remains part of the captured source even if the art does not sample it.

Two explicit experiment matrices live under `experiments/`: three matched spacing regimes at seed 7, and a three-seed sweep at one fixed regime. From this copied project, run `./node_modules/.bin/plot-sketch experiment experiments/matched-regimes.json --out output/matched-regimes` or substitute `experiments/seed-sweep.json`. The command writes an SVG, PNG and result for each candidate, `manifest.json`, and a labeled `contact-sheet.html`. Rerunning an identical matrix validates each artifact hash before reuse. The sheet presents conditions and failures without scoring or selecting the art.

`plot-sketch open` is a local Node server. A static gallery can display exported SVG/PNG; this package does not promise hosted interactive execution of TypeScript or a browser runtime. Local queue upload requires an explicit `--plotter-upload` launch and server-side credentials; it is separate from the portable browser export.
