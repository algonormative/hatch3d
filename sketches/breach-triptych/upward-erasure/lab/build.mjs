// Build the Upward Erasure lab: the worker bundle and the page, into `out` (default .sketch-output/upward-erasure-lab).
// node sketches/breach-triptych/upward-erasure/lab/build.mjs [out]
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, '../../../../.sketch-output/upward-erasure-lab'));
mkdirSync(out, { recursive: true });
await build({ entryPoints: [join(here, 'worker.ts')], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', minify: true, outfile: join(out, 'worker.js'), logLevel: 'warning' });
copyFileSync(join(here, 'page.html'), join(out, 'page.html'));
console.log(out);
