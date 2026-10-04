# Mixed study migration fixture

From the Hatch3D checkout, make a copied project and install local tarballs (these private packages are not in a registry):

```bash
npm run plot-host:build
mkdir -p /tmp/plot-toolkit-packs
npm pack ./packages/plot-core --pack-destination /tmp/plot-toolkit-packs
npm pack ./packages/plot-host --pack-destination /tmp/plot-toolkit-packs
cp -R examples/plot-family-mixed /tmp/my-plot-family
cd /tmp/my-plot-family
npm install /tmp/plot-toolkit-packs/hatch3d-plot-core-0.1.0.tgz /tmp/plot-toolkit-packs/hatch3d-plot-host-0.1.0.tgz
npm run typecheck
npm run render
npm run open
```

The install resolves declared third-party dependencies. `npm run open` starts a local Node viewer for this entry; close it with Ctrl-C. Output, pins and installed dependencies are ignored by this family project.

A self-contained copy of `sketches/hatch3d-3d`, using only public `@hatch3d/plot-core/spatial` and `@hatch3d/plot-core/planar` types plus the `@hatch3d/plot-host` CLI. The family files own the double-ring and spirograph definitions. No Hatch3D checkout import is used at runtime.

Use `npm run inspect`, `npm run render`, or `npm run open`; `open` launches this entry's local view directly. Output and pins remain outside `family/`. `family/requests/default.json` is the exact migration comparison request. The package smoke installs a copy outside this checkout and checks exact paths, ordered layers and finishing against the untouched original.
