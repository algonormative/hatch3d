# External control panel example

This tiny browser family mounts `@hatch3d/plot-core/controls` outside the Hatch3D viewer. It uses the packed control CSS and a static import map; no React or bundler is required.

```bash
npm run plot-core:build
mkdir -p /tmp/plot-control-packs
npm pack ./packages/plot-core --pack-destination /tmp/plot-control-packs
cp -R examples/plot-controls-panel /tmp/my-control-panel
cd /tmp/my-control-panel
npm install /tmp/plot-control-packs/hatch3d-plot-core-0.1.0.tgz
python3 -m http.server 4173
```

Open `http://localhost:4173`. The example owns its parameters and drawing; the package owns control DOM, navigator interaction, and its styles. Changes redraw the example, while the expensive contour slider redraws on release. Call `panel.update({ params })` after external parameter changes and `panel.dispose()` when unmounting.
