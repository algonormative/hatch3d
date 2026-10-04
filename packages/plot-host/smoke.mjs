import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(root, '../..');
const temp = mkdtempSync(join(tmpdir(), 'plot-host-pack-'));
const consumer = join(temp, 'consumer');
const run = (file, args, cwd) => execFileSync(file, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
const pack = (directory) => {
  const [result] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp, directory], temp));
  return join(temp, result.filename);
};
const api = async (url, path, body) => {
  const response = await fetch(new URL(path, url), body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return response;
};
try {
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  const core = pack(join(checkout, 'packages/plot-core'));
  const host = pack(root);
  const installed = join(checkout, 'node_modules');
  const deps = ['@resvg/resvg-js', 'pngjs', 'tsx', 'esbuild', 'get-tsconfig', 'resolve-pkg-maps', 'typescript', '@types/node', 'undici-types'];
  for (const name of ['@resvg/resvg-js', 'esbuild']) {
    const manifest = JSON.parse(readFileSync(join(installed, name, 'package.json'), 'utf8'));
    const native = Object.keys(manifest.optionalDependencies ?? {}).filter(candidate => existsSync(join(installed, candidate)));
    assert.equal(native.length, 1, `Expected one installed native runtime for ${name}`);
    deps.push(...native);
  }
  const archives = deps.map(name => pack(join(installed, name)));
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--prefix', consumer, core, host, ...archives], temp);
  const packageRoot = join(consumer, 'node_modules/@hatch3d/plot-host');
  const packed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(packed.bin['plot-sketch'], './dist/cli.js');
  for (const asset of ['child.js', 'errors.d.ts', 'viewer.html', 'viewer.js', 'viewer.css', 'viewer-state.js', 'control-values.js', 'control-geometry.js', 'plugins/plotter-upload-view.js']) {
    assert(existsSync(join(packageRoot, 'dist', asset)), `Missing packed asset ${asset}`);
  }
  for (const source of ['cli.js', 'child.js', 'index.js']) {
    const code = readFileSync(join(packageRoot, 'dist', source), 'utf8');
    assert(!/\/Users\/chronick-mbp|(?:from|import\()\s*['"]\.\.\/\.\.\//.test(code), `${source} leaks checkout imports`);
  }
  const sketchDir = join(consumer, 'study');
  await mkdir(sketchDir);
  await writeFile(join(sketchDir, 'helper.ts'), 'export const base = 20;\n');
  await writeFile(join(sketchDir, 'sketch.ts'), `import { strokeText } from '@hatch3d/plot-core';
import { base } from './helper.ts';
export default {
  name: 'Outside Study', page: { width: 100, height: 100, margin: 10, paper: '#ffffff' },
  pens: [{ id: 'ink', color: '#111111', width: 0.3 }],
  controls: [{ type: 'slider', id: 'offset', label: 'Offset', min: 0, max: 10, step: 1, default: 1 }],
  draw(ctx) { return [{ id: 'letters', pen: 'ink', paths: strokeText('A', base + ctx.params.offset, 20, { height: 10 }) }]; },
};\n`);
  const entry = join(sketchDir, 'sketch.ts');
  const cli = join(packageRoot, 'dist/cli.js');
  const metadata = JSON.parse(run(process.execPath, [cli, 'inspect', entry], consumer));
  assert.equal(metadata.name, 'Outside Study');
  const out = join(consumer, 'rendered');
  const rendered = JSON.parse(run(process.execPath, [cli, 'render', entry, '--out', out], consumer));
  assert.equal(rendered.identity.length, 64);
  assert.equal(readFileSync(rendered.svg, 'utf8'), JSON.parse(readFileSync(rendered.result, 'utf8')).svg);
  assert.equal(readFileSync(rendered.png).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await writeFile(join(consumer, 'consumer.ts'), `import type { Sketch } from '@hatch3d/plot-core';
import { inspectSketch, renderSketch, startSketchServer, pngOptions, exportSketchPng, SketchRunnerError } from '@hatch3d/plot-host';
declare const sketch: Sketch;
const parsed = pngOptions('paper', 6);
const host = startSketchServer({ entry: 'sketch.ts', plotterUpload: { baseUrl: 'https://feed.example', token: 'local', timeoutMs: 1000, fetchImpl: fetch } });
const result = renderSketch({ entry: 'sketch.ts', signal: new AbortController().signal });
declare const runnerError: SketchRunnerError;
void [sketch, runnerError.code, parsed, host, inspectSketch({ entry: 'sketch.ts' }), result.then(item => exportSketchPng(item, 'paper', 6))];
`);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES2023', 'DOM'], types: ['node'], strict: true, noEmit: true, skipLibCheck: false }, include: ['consumer.ts'] }));
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], consumer);
  const { inspectSketch, renderSketch, startSketchServer, SketchRunnerError } = await import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
  assert.equal((await inspectSketch({ entry })).name, 'Outside Study');
  const first = await renderSketch({ entry });
  assert.equal(first.identity, rendered.identity);
  await writeFile(join(sketchDir, 'helper.ts'), 'export const base = 25;\n');
  const changed = await renderSketch({ entry });
  assert.notEqual(changed.identity, first.identity, 'fresh child did not reload a transitive import');
  await writeFile(join(sketchDir, 'hang.ts'), `export default { name:'Hang', page:{width:100,height:100,margin:10}, pens:[{id:'ink',color:'#000',width:0.3}], controls:[], draw(){for(;;) {}} };`);
  await assert.rejects(renderSketch({ entry: join(sketchDir, 'hang.ts'), timeoutMs: 200 }), error => error instanceof SketchRunnerError && error.code === 'timeout');
  const controller = new AbortController();
  const aborted = renderSketch({ entry: join(sketchDir, 'hang.ts'), timeoutMs: 5_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(aborted, error => error instanceof SketchRunnerError && error.code === 'aborted');
  const previousCwd = process.cwd();
  process.chdir(sketchDir);
  try {
    const defaultServer = await startSketchServer({ entry });
    await defaultServer.close();
    assert(existsSync(join(consumer, '.sketch-output/study/pins')), 'Default pins should live outside the sketch source');
    assert(!existsSync(join(sketchDir, '.sketch-output')), 'Default pins must not enter sketch source');
  } finally { process.chdir(previousCwd); }
  const cliServer = spawn(process.execPath, [cli, 'open', entry, '--out', join(consumer, 'cli-pins')], { cwd: consumer, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const cliUrl = await new Promise((resolveUrl, rejectUrl) => {
      let output = '';
      cliServer.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('\n')) {
          try { resolveUrl(JSON.parse(output.slice(0, output.indexOf('\n'))).url); }
          catch (error) { rejectUrl(error); }
        }
      });
      cliServer.once('error', rejectUrl);
      cliServer.once('exit', code => rejectUrl(new Error(`CLI open exited ${code}: ${output}`)));
    });
    assert.equal((await api(cliUrl, '/')).status, 200);
    assert.equal((await api(cliUrl, '/control-values.js')).status, 200);
  } finally {
    cliServer.kill('SIGTERM');
    await new Promise(resolve => cliServer.once('exit', resolve));
  }
  const server = await startSketchServer({ entry, outputDir: join(consumer, 'pins') });
  try {
    for (const [route, token] of [['/', 'viewer.js'], ['/viewer.js', 'viewer-state.js'], ['/viewer.css', 'font'], ['/control-values.js', 'resolveMacroParams'], ['/control-geometry.js', 'normalize'], ['/api/metadata', 'Outside Study']]) {
      const response = await api(server.url, route);
      assert.equal(response.status, 200, route);
      assert((await response.text()).includes(token), route);
    }
    const response = await api(server.url, '/api/render', { requestId: 1, params: { offset: 3 }, seed: 2 });
    assert.equal(response.status, 200);
    const { result } = await response.json();
    const svg = await api(server.url, `/api/export.svg?identity=${result.identity}`);
    assert.equal(svg.status, 200);
    assert.equal(await svg.text(), result.svg);
    const png = await api(server.url, `/api/export.png?identity=${result.identity}&scale=1`);
    assert.equal(png.status, 200);
    assert.equal(Buffer.from(await png.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const pin = await api(server.url, '/api/pins', { identity: result.identity });
    assert.equal(pin.status, 201);
    const { pinId } = await pin.json();
    assert.equal((await api(server.url, `/api/pins/${pinId}/svg`)).status, 200);
    await writeFile(join(sketchDir, 'helper.ts'), 'export const base = 30;\n');
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal((await api(server.url, `/api/export.svg?identity=${result.identity}`)).status, 409);
    const updated = await api(server.url, '/api/render', { requestId: 2, params: { offset: 3 }, seed: 2 });
    assert.equal(updated.status, 200);
    assert.notEqual((await updated.json()).result.identity, result.identity);
  } finally { await server.close(); }
  let uploadCalls = 0;
  const optional = await startSketchServer({ entry, outputDir: join(consumer, 'optional-pins'), plotterUpload: { baseUrl: 'https://feed.example', token: 'local', fetchImpl: async () => { uploadCalls++; throw new Error('unexpected upload'); } } });
  try {
    const page = await api(optional.url, '/');
    assert.equal(page.status, 200);
    assert((await page.text()).includes('/plotter-upload-view.js'));
    assert.equal((await api(optional.url, '/plotter-upload-view.js')).status, 200);
    assert.equal(uploadCalls, 0);
  } finally { await optional.close(); }
  console.log('Packed external host inspect/render/open, assets, exports, pins, reload, stale guard, abort, timeout, and optional upload gating passed.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
