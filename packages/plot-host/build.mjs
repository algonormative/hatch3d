import { build } from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(root, '../..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'plugins'), { recursive: true });
const coreAlias = { name: 'public-core', setup(builder) {
  builder.onResolve({ filter: /packages\/plot-core\/src\/index\.ts$/ }, () => ({ path: '@hatch3d/plot-core', external: true }));
} };
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', plugins: [coreAlias], logLevel: 'warning' };
for (const [source, name] of [
  ['src/index.ts', 'index.js'],
  ['../../cli/sketch.ts', 'cli.js'],
  ['../../cli/sketch/child.ts', 'child.js'],
]) {
  await build({ ...common, entryPoints: [join(root, source)], outfile: join(dist, name), banner: name === 'cli.js' ? { js: '#!/usr/bin/env node' } : undefined });
}
chmodSync(join(dist, 'cli.js'), 0o755);
for (const file of ['viewer.html', 'viewer.css', 'viewer.js', 'viewer-state.js', 'radar-view.js', 'navigator-view.js', 'spatial-view.js', 'svg-controls.js']) {
  copyFileSync(join(checkout, 'cli/sketch', file), join(dist, file));
}
copyFileSync(join(checkout, 'cli/sketch/plugins/plotter-upload-view.js'), join(dist, 'plugins/plotter-upload-view.js'));
for (const file of ['control-values.js', 'control-geometry.js']) {
  copyFileSync(join(checkout, 'packages/plot-core/src', file), join(dist, file));
}
execFileSync(resolve(checkout, 'node_modules/.bin/tsc'), ['--project', join(root, 'tsconfig.json')], { stdio: 'inherit' });
copyFileSync(join(dist, 'types/packages/plot-host/src/index.d.ts'), join(dist, 'index.d.ts'));
copyFileSync(join(dist, 'types/packages/plot-host/src/errors.d.ts'), join(dist, 'errors.d.ts'));
rmSync(join(dist, 'types'), { recursive: true, force: true });
