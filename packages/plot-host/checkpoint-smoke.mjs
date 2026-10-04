import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCheckpoint, replayCheckpoint } from '../../cli/sketch/checkpoint.ts';
import { findExternalProject, installedNodes } from '../../cli/sketch/checkpoint-external.ts';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temp = mkdtempSync(join(tmpdir(), 'plot-checkpoint-pack-'));
const run = (file, args, cwd) => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
const pack = directory => {
  const [result] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp, directory], temp));
  return join(temp, result.filename);
};
const rejected = async (work, pattern) => {
  await assert.rejects(work, pattern);
};

try {
  const core = pack(join(checkout, 'packages/plot-core'));
  const host = pack(join(checkout, 'packages/plot-host'));
  const installed = join(checkout, 'node_modules');
  const deps = ['@resvg/resvg-js', 'pngjs', 'tsx', 'esbuild', 'get-tsconfig', 'resolve-pkg-maps'];
  for (const name of ['@resvg/resvg-js', 'esbuild']) {
    const manifest = JSON.parse(readFileSync(join(installed, name, 'package.json'), 'utf8'));
    const native = Object.keys(manifest.optionalDependencies ?? {}).filter(candidate => existsSync(join(installed, candidate)));
    assert.equal(native.length, 1, `Expected exactly one native runtime for ${name}`);
    deps.push(native[0]);
  }
  const archives = deps.map(name => pack(join(installed, name)));
  const consumer = join(temp, 'family-project');
  cpSync(join(checkout, 'examples/plot-family-starter'), consumer, { recursive: true });
  const packagePath = join(consumer, 'package.json');
  const originalPackage = JSON.parse(readFileSync(packagePath, 'utf8'));
  const sentinel = join(temp, 'lifecycle-ran');
  originalPackage.scripts = { postinstall: `node -e 'require("fs").writeFileSync(${JSON.stringify(sentinel)},"yes")'` };
  writeFileSync(packagePath, `${JSON.stringify(originalPackage, null, 2)}\n`);
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', core, host, ...archives], consumer);
  assert(!existsSync(sentinel), 'Original install executed a lifecycle script');
  const cli = join(consumer, 'node_modules/@hatch3d/plot-host/dist/cli.js');
  const entry = join(consumer, 'family/sketch.ts');
  const output = join(temp, 'render');
  run(process.execPath, [cli, 'render', entry, '--out', output], consumer);
  const result = JSON.parse(readFileSync(join(output, 'result.json'), 'utf8'));
  const checkpoints = join(temp, 'checkpoints');
  const saved = await createCheckpoint({ entry, result, outputDir: checkpoints });
  assert.equal(saved.manifest.version, 2);
  assert.equal(saved.manifest.identity, result.identity);
  assert(saved.manifest.archives.some(archive => archive.name === '@hatch3d/plot-host'));
  assert(saved.manifest.archives.some(archive => archive.name.includes(`${process.platform}-${process.arch}`)));
  assert(!existsSync(sentinel), 'Checkpoint capture executed a lifecycle script');
  const packedCapture = JSON.parse(run(process.execPath, [cli, 'checkpoint', entry, '--result', join(output, 'result.json'), '--out', checkpoints], consumer));
  assert.equal(packedCapture.version, 2);
  const cliReplayOutput = join(temp, 'cli-replay');
  const packedReplay = JSON.parse(run(process.execPath, [cli, 'replay', packedCapture.checkpoint, '--out', cliReplayOutput], consumer));
  assert.equal(packedReplay.identity, result.identity);
  assert.equal(readFileSync(join(cliReplayOutput, 'render.svg'), 'utf8'), result.svg);

  const moved = join(temp, 'family-project-moved');
  renameSync(consumer, moved);
  try {
    const replayed = await replayCheckpoint({ checkpoint: saved.path });
    assert.equal(replayed.svg, result.svg);
    assert.equal(replayed.identity, result.identity);
    assert(!existsSync(sentinel), 'Checkpoint replay executed a lifecycle script');
  } finally { renameSync(moved, consumer); }

  // A lock node's full npm installation path, rather than its name alone, identifies its version.
  const leafV1 = join(consumer, 'node_modules/fixture-leaf');
  const parent = join(consumer, 'node_modules/fixture-parent');
  const leafV2 = join(parent, 'node_modules/fixture-leaf');
  try {
    for (const [directory, name, version] of [[leafV1, 'fixture-leaf', '1.0.0'], [parent, 'fixture-parent', '1.0.0'], [leafV2, 'fixture-leaf', '2.0.0']]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version }));
    }
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/fixture-leaf'] = { version: '1.0.0' };
    lock.packages['node_modules/fixture-parent'] = { version: '1.0.0' };
    lock.packages['node_modules/fixture-parent/node_modules/fixture-leaf'] = { version: '2.0.0' };
    const project = await findExternalProject(entry);
    const inspected = await installedNodes(project, lock);
    assert.equal(inspected.find(node => node.nodePath === 'node_modules/fixture-leaf').version, '1.0.0');
    assert.equal(inspected.find(node => node.nodePath === 'node_modules/fixture-parent/node_modules/fixture-leaf').version, '2.0.0');
  } finally { rmSync(parent, { recursive: true, force: true }); rmSync(leafV1, { recursive: true, force: true }); }

  const dependency = saved.manifest.archives[0];
  const archivePath = join(saved.path, 'dependencies', dependency.file);
  const originalArchive = readFileSync(archivePath);
  try {
    writeFileSync(archivePath, Buffer.from('corrupt archive'));
    await rejected(() => replayCheckpoint({ checkpoint: saved.path }), /archive corrupt/i);
  } finally { writeFileSync(archivePath, originalArchive); }
  const lockPath = join(saved.path, 'replay-package-lock.json');
  const originalLock = readFileSync(lockPath);
  try {
    writeFileSync(lockPath, Buffer.from('{}'));
    await rejected(() => replayCheckpoint({ checkpoint: saved.path }), /captured package or dependency lock changed/i);
  } finally { writeFileSync(lockPath, originalLock); }
  const capturedEntry = join(saved.path, 'source/sketch.ts');
  const capturedManifestPath = join(saved.path, 'checkpoint.json');
  const capturedBytes = readFileSync(capturedEntry);
  const capturedManifest = readFileSync(capturedManifestPath);
  try {
    const altered = Buffer.from(`const target = '/private/tmp/outside-family.js'; import /* comment */ (target);\n${capturedBytes}`);
    writeFileSync(capturedEntry, altered);
    const manifest = JSON.parse(capturedManifest.toString('utf8'));
    const sourceFile = manifest.sourceFiles.find(file => file.path === 'sketch.ts');
    sourceFile.bytes = altered.length;
    sourceFile.sha256 = createHash('sha256').update(altered).digest('hex');
    writeFileSync(capturedManifestPath, JSON.stringify(manifest));
    await rejected(() => replayCheckpoint({ checkpoint: saved.path }), /dynamic import\/require is unsupported/i);
  } finally { writeFileSync(capturedEntry, capturedBytes); writeFileSync(capturedManifestPath, capturedManifest); }
  try {
    writeFileSync(capturedManifestPath, Buffer.alloc(16 * 1024 * 1024 + 1));
    await rejected(() => replayCheckpoint({ checkpoint: saved.path }), /bounded regular file|size limit/i);
  } finally { writeFileSync(capturedManifestPath, capturedManifest); }

  const originalEntry = readFileSync(entry, 'utf8');
  try {
    writeFileSync(entry, `import '/private/tmp/outside-family.js';\n${originalEntry}`);
    await rejected(() => createCheckpoint({ entry, result, outputDir: checkpoints }), /absolute\/file import is unsupported/i);
    writeFileSync(entry, `const target = '/private/tmp/outside-family.js'; import /* comment */ (target);\n${originalEntry}`);
    await rejected(() => createCheckpoint({ entry, result, outputDir: checkpoints }), /dynamic import\/require is unsupported/i);
    writeFileSync(entry, originalEntry.replace('Number(ctx.params.drift))', 'Number(ctx.params.drift) + 1)'));
    await rejected(() => createCheckpoint({ entry, result, outputDir: checkpoints }), /does not reproduce|replay differs/i);
  } finally { writeFileSync(entry, originalEntry); }
  const assetPath = join(consumer, 'family/assets/reference.png');
  const originalAsset = readFileSync(assetPath);
  try {
    rmSync(assetPath);
    await rejected(() => createCheckpoint({ entry, result, outputDir: checkpoints }), /declared asset.*missing/i);
  } finally { writeFileSync(assetPath, originalAsset); }
  const oversized = join(consumer, 'family/oversized.json');
  try {
    writeFileSync(oversized, Buffer.alloc(20 * 1024 * 1024 + 1));
    await rejected(() => createCheckpoint({ entry, result, outputDir: checkpoints }), /family source exceeds 20 MiB/i);
  } finally { rmSync(oversized, { force: true }); }
  await rejected(() => createCheckpoint({ entry, result, outputDir: join(consumer, 'family/pins') }), /output cannot be inside/i);

  rmSync(join(consumer, 'node_modules', deps.find(name => name.startsWith('@resvg/resvg-js-'))), { recursive: true, force: true });
  await rejected(() => createCheckpoint({ entry, result, outputDir: checkpoints }), /locked dependency is missing|native optional package.*missing/i);
  console.log('External v2 capture/replay, moved origin, nested duplicate versions, offline lifecycle guard, corruption, captured-tree import audit, size caps, source and asset boundaries, stale render, output alias, and native optional probes passed.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
