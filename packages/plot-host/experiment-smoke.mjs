import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temp = mkdtempSync(join(tmpdir(), 'plot-experiment-pack-'));
const run = (file, args, cwd) => execFileSync(file, args, { cwd, stdio: 'pipe', encoding: 'utf8', timeout: 60_000 });
const pack = directory => {
  const [result] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp, directory], temp));
  return join(temp, result.filename);
};
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const fail = (file, args, cwd, pattern) => {
  assert.throws(() => run(file, args, cwd), error => pattern.test(String(error.stderr || error.message)));
};

try {
  const core = pack(join(checkout, 'packages/plot-core'));
  const host = pack(join(checkout, 'packages/plot-host'));
  const installed = join(checkout, 'node_modules');
  const deps = ['@resvg/resvg-js', 'pngjs', 'tsx', 'esbuild', 'get-tsconfig', 'resolve-pkg-maps'];
  for (const name of ['@resvg/resvg-js', 'esbuild']) {
    const manifest = load(join(installed, name, 'package.json'));
    const native = Object.keys(manifest.optionalDependencies ?? {}).filter(candidate => existsSync(join(installed, candidate)));
    assert.equal(native.length, 1);
    deps.push(native[0]);
  }
  const archives = deps.map(name => pack(join(installed, name)));
  const consumer = join(temp, 'family-project');
  cpSync(join(checkout, 'examples/plot-family-starter'), consumer, { recursive: true });
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', core, host, ...archives], consumer);
  const cli = join(consumer, 'node_modules/@hatch3d/plot-host/dist/cli.js');
  const matrix = join(consumer, 'experiments/matched-regimes.json');
  const proof = join(checkout, '.sketch-output/extraction-proof');
  const invoke = output => JSON.parse(run(process.execPath, [cli, 'experiment', matrix, '--out', output], consumer));

  const first = invoke(proof);
  assert.equal(first.successes, 3);
  let manifest = load(first.manifest);
  assert.equal(manifest.status, 'complete');
  assert.deepEqual(manifest.candidates.map(candidate => candidate.regimeId), ['open', 'balanced', 'dense']);
  for (const candidate of manifest.candidates) {
    assert.equal(candidate.status, 'success');
    assert.equal(load(join(proof, candidate.artifacts.result)).identity, candidate.identity);
    assert(readFileSync(join(proof, candidate.artifacts.svg), 'utf8').startsWith('<svg'));
    assert.equal(readFileSync(join(proof, candidate.artifacts.png)).subarray(1, 4).toString('ascii'), 'PNG');
  }
  const sheet = readFileSync(first.contactSheet, 'utf8');
  for (const label of ['open', 'balanced', 'dense']) assert(sheet.includes(label));
  assert(sheet.includes('no ranking'));
  for (const candidate of manifest.candidates) {
    assert(sheet.includes(`href="${candidate.artifacts.png}"`));
    assert(sheet.includes(`href="${candidate.artifacts.svg}"`));
    assert(sheet.includes(`href="${candidate.artifacts.result}"`));
  }
  writeFileSync(join(proof, 'proof-command.txt'), 'From Hatch3D: npm run plot-experiment:smoke\nThis command packs and installs the local toolkit into a temporary independent family, then writes this matched three-regime contact sheet.\n');

  invoke(proof);
  manifest = load(join(proof, 'manifest.json'));
  assert(manifest.candidates.every(candidate => candidate.reused === true));
  const damaged = manifest.candidates[0];
  writeFileSync(join(proof, damaged.artifacts.svg), '<svg>corrupt</svg>');
  invoke(proof);
  manifest = load(join(proof, 'manifest.json'));
  assert.equal(manifest.candidates[0].reused, undefined);
  assert(manifest.candidates.slice(1).every(candidate => candidate.reused === true));
  assert.notEqual(readFileSync(join(proof, manifest.candidates[0].artifacts.svg), 'utf8'), '<svg>corrupt</svg>');

  const entry = join(consumer, 'family/sketch.ts');
  const helper = join(consumer, 'family/geometry.ts');
  const originalEntry = readFileSync(entry, 'utf8');
  const originalHelper = readFileSync(helper, 'utf8');
  try {
    const failedOutput = join(temp, 'failed');
    const successfulBeforeFailure = invoke(failedOutput);
    const oldPreview = load(successfulBeforeFailure.manifest).candidates[1].artifacts.png;
    writeFileSync(entry, originalEntry.replace('draw(ctx) {', 'draw(ctx) { if (Number(ctx.params.spacing) === 10) throw new Error("<failed render>");'));
    invoke(failedOutput);
    const failed = load(join(failedOutput, 'manifest.json'));
    assert.deepEqual(failed.candidates.map(candidate => candidate.status), ['success', 'failed', 'success']);
    assert.equal(failed.candidates[1].artifacts, undefined);
    const failedSheet = readFileSync(join(failedOutput, 'contact-sheet.html'), 'utf8');
    assert(failedSheet.includes('&lt;failed render&gt;'));
    assert(!failedSheet.includes(oldPreview));

    writeFileSync(entry, `import { appendFileSync } from 'node:fs';\n${originalEntry.replace('draw(ctx) {', `draw(ctx) { appendFileSync(${JSON.stringify(helper)}, '\\n// changed during render');`)}`);
    const mutatingOutput = join(temp, 'mutating');
    fail(process.execPath, [cli, 'experiment', matrix, '--out', mutatingOutput], consumer, /inputs changed during render/i);
    const stale = load(join(mutatingOutput, 'manifest.json'));
    assert.equal(stale.status, 'stopped');
    assert.equal(stale.candidates[0].status, 'stale');
    assert.equal(stale.candidates[0].artifacts, undefined);
  } finally { writeFileSync(entry, originalEntry); writeFileSync(helper, originalHelper); }

  const escapedAsset = originalEntry.replace("path: 'assets/reference.png'", "path: '../shared.png'");
  writeFileSync(entry, escapedAsset);
  writeFileSync(join(consumer, 'shared.png'), readFileSync(join(consumer, 'family/assets/reference.png')));
  try {
    fail(process.execPath, [cli, 'experiment', matrix, '--out', join(temp, 'escaped-asset')], consumer, /Declared asset.*escapes/i);
  } finally { writeFileSync(entry, originalEntry); rmSync(join(consumer, 'shared.png'), { force: true }); }

  const API = await import(pathToFileURL(join(consumer, 'node_modules/@hatch3d/plot-host/dist/index.js')).href);
  const parsed = load(matrix);
  await assert.rejects(API.runExperimentBatch({ matrix: { ...parsed, sources: [{ id: 'a--b', entry: '../family/sketch.ts' }, { id: 'a', entry: '../family/sketch.ts' }], regimes: [{ id: 'c', params: {} }, { id: 'b--c', params: {} }] },
    baseDir: dirname(matrix), outputDir: join(temp, 'collision') }), /consecutive hyphens/);
  const cloned = structuredClone(parsed);
  const clonedOutput = join(temp, 'cloned');
  const promise = API.runExperimentBatch({ matrix: cloned, baseDir: dirname(matrix), outputDir: clonedOutput });
  cloned.regimes[0].params.spacing = 4;
  const clonedManifest = await promise;
  assert.equal(clonedManifest.candidates[0].request.params.spacing, 14);

  const variantEntry = join(consumer, 'family/sketch-variant.ts');
  writeFileSync(variantEntry, originalEntry.replace("name: 'Crossing field'", "name: 'Crossing field / variant'")
    .replace('Number(ctx.params.drift))', 'Number(ctx.params.drift) + 1)'));
  const variants = { sources: [{ id: 'base', entry: '../family/sketch.ts' }, { id: 'variant', entry: '../family/sketch-variant.ts' }],
    regimes: [{ id: 'matched', params: { spacing: 10, drift: 3 } }], seeds: [7] };
  const variantManifest = await API.runExperimentBatch({ matrix: variants, baseDir: dirname(matrix), outputDir: join(temp, 'variants') });
  assert.equal(variantManifest.candidates.length, 2);
  assert.notEqual(variantManifest.candidates[0].identity, variantManifest.candidates[1].identity);

  const lockedOutput = join(temp, 'locked');
  cpSync(proof, lockedOutput, { recursive: true });
  writeFileSync(join(lockedOutput, '.experiment.lock'), 'other writer\n');
  fail(process.execPath, [cli, 'experiment', matrix, '--out', lockedOutput], consumer, /already in use/i);
  assert.equal(readFileSync(join(lockedOutput, '.experiment.lock'), 'utf8'), 'other writer\n');

  const aborted = new AbortController();
  aborted.abort();
  const cancelledOutput = join(temp, 'cancelled');
  await assert.rejects(API.runExperimentBatch({ matrix: parsed, baseDir: dirname(matrix), outputDir: cancelledOutput, signal: aborted.signal }), /cancelled/i);
  assert.equal(load(join(cancelledOutput, 'manifest.json')).status, 'stopped');
  assert(!existsSync(join(cancelledOutput, '.experiment.lock')));
  console.log(`Packed experiment matrix, resume/corruption, failure, mutation, asset boundary, ID collision, input clone, exclusive lock and cancellation passed. Contact sheet: ${join(proof, 'contact-sheet.html')}`);
} finally { rmSync(temp, { recursive: true, force: true }); }
