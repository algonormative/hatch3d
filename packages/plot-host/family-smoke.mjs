import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(root, '../..');
const temp = mkdtempSync(join(tmpdir(), 'plot-family-pack-'));
const run = (file, args, cwd) => execFileSync(file, args, { cwd, stdio: 'pipe', encoding: 'utf8', timeout: 60_000 });
const pack = directory => {
  const [result] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp, directory], temp));
  return join(temp, result.filename);
};
const open = async (cli, entry, cwd) => {
  const child = spawn(process.execPath, [cli, 'open', entry, '--out', join(cwd, 'pins')], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  let readyTimer;
  try {
    const url = await new Promise((resolveUrl, rejectUrl) => {
      let output = '';
      readyTimer = setTimeout(() => rejectUrl(new Error('Viewer did not announce its URL within 10 seconds')), 10_000);
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('\n')) {
          try { resolveUrl(JSON.parse(output.slice(0, output.indexOf('\n'))).url); }
          catch (error) { rejectUrl(error); }
        }
      });
      child.once('error', rejectUrl);
      child.once('exit', code => rejectUrl(new Error(`Viewer exited ${code}: ${output}`)));
    });
    const page = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    assert.equal(page.status, 200);
    assert((await page.text()).includes('viewer.js'));
    const metadata = await fetch(new URL('/api/metadata', url), { signal: AbortSignal.timeout(10_000) });
    assert.equal(metadata.status, 200);
    return await metadata.json();
  } finally {
    clearTimeout(readyTimer);
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, 2_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
};
try {
  const core = pack(join(checkout, 'packages/plot-core'));
  const host = pack(root);
  const installed = join(checkout, 'node_modules');
  const deps = ['@resvg/resvg-js', 'pngjs', 'tsx', 'esbuild', 'get-tsconfig', 'resolve-pkg-maps', 'three', 'simplex-noise', 'typescript', '@types/three', '@dimforge/rapier3d-compat', '@tweenjs/tween.js', '@types/stats.js', '@types/webxr', '@webgpu/types', 'fflate', 'meshoptimizer'];
  for (const name of ['@resvg/resvg-js', 'esbuild']) {
    const manifest = JSON.parse(readFileSync(join(installed, name, 'package.json'), 'utf8'));
    const native = Object.keys(manifest.optionalDependencies ?? {}).filter(candidate => existsSync(join(installed, candidate)));
    assert.equal(native.length, 1, `Expected one native runtime for ${name}`);
    deps.push(...native);
  }
  const archives = deps.map(name => pack(join(installed, name)));
  const consumers = [];
  for (const name of ['plot-family-starter', 'plot-family-mixed']) {
    const consumer = join(temp, name);
    cpSync(join(checkout, 'examples', name), consumer, { recursive: true });
    run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--prefix', consumer, core, host, ...archives], temp);
    for (const toolkit of ['plot-core', 'plot-host']) {
      assert(!lstatSync(join(consumer, 'node_modules/@hatch3d', toolkit)).isSymbolicLink(), 'Toolkit package resolves to source checkout');
    }
    run(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json'], consumer);
    const cli = join(consumer, 'node_modules/@hatch3d/plot-host/dist/cli.js');
    const entry = join(consumer, 'family/sketch.ts');
    const meta = JSON.parse(run(process.execPath, [cli, 'inspect', entry], consumer));
    assert.equal((await open(cli, entry, consumer)).name, meta.name);
    const output = join(consumer, 'output/default');
    const request = join(consumer, 'family/requests/default.json');
    const summary = JSON.parse(run(process.execPath, [cli, 'render', entry, '--config', request, '--out', output], consumer));
    assert.equal(summary.identity.length, 64);
    const result = JSON.parse(readFileSync(join(output, 'result.json'), 'utf8'));
    assert.equal(summary.identity, result.identity);
    assert.equal(readFileSync(join(output, 'render.svg'), 'utf8'), result.svg);
    consumers.push({ name, consumer, result, meta });
  }
  const mixed = consumers.find(item => item.name === 'plot-family-mixed');
  const originalOutput = join(temp, 'original');
  const originalRequest = join(checkout, 'examples/plot-family-mixed/family/requests/default.json');
  run(process.execPath, ['--import', 'tsx', 'cli/sketch.ts', 'render', 'sketches/hatch3d-3d/sketch.ts', '--config', originalRequest, '--out', originalOutput], checkout);
  const original = JSON.parse(readFileSync(join(originalOutput, 'result.json'), 'utf8'));
  for (const key of ['identity', 'svg', 'parts', 'finishing', 'stats']) assert.deepEqual(mixed.result[key], original[key], `Mixed copy changed ${key}`);
  assert.deepEqual(mixed.result.metadata.pens, original.metadata.pens, 'Mixed copy changed ordered pen layers');
  assert.equal(mixed.result.identity, 'a3025e56f4072aab7c080c759c60b87c17529bc8e676de6ca34275ea2b036ab2', 'Original migration baseline drifted');
  console.log('Packed starter and mixed family install/render/open passed outside checkout; mixed paths, SVG, layers, finishing and identity match original.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
