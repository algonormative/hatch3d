import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const common = { bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', packages: 'external', logLevel: 'warning' };
for (const name of ['index', 'planar']) {
  await build({ ...common, entryPoints: [join(root, 'src', `${name}.ts`)], outfile: join(dist, `${name}.js`) });
}
await build({ ...common, entryPoints: [join(root, 'src/spatial.ts')], outfile: join(dist, 'spatial.js'), plugins: [{ name: 'cpu-spatial', setup(build) {
  build.onResolve({ filter: /wasm-pipeline$/ }, () => ({ path: join(root, 'src/spatial-wasm-shim.ts') }));
} }] });
execFileSync(resolve(root, '../../node_modules/.bin/tsc'), ['--project', join(root, 'tsconfig.json')], { stdio: 'inherit' });
copyFileSync(join(dist, 'spatial-api.d.ts'), join(dist, 'spatial.d.ts'));
for (const name of ['control-values', 'control-geometry']) copyFileSync(join(root, 'src', `${name}.d.ts`), join(dist, `${name}.d.ts`));
