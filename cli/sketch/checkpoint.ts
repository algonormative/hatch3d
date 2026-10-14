import { createHash, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { FinishingOptions, FormatOptions, Params, RenderResult } from '../../src/sketch/types.ts';
import { createExternalCheckpoint, findExternalProject, fingerprintExternalProject, fingerprintInstalledTree, readBounded, replayExternalCheckpoint, sourceFiles as externalSourceFiles, type ExternalCheckpointManifest } from './checkpoint-external.ts';
import { inspectSketch } from './runner.ts';

const git = promisify(execFile);
const MANIFEST = 'checkpoint.json';
const VERSION = 1;
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

interface SourceFile { path: string; sha256: string }
export interface CheckpointManifest {
  version: 1;
  createdAt: string;
  originRepo: string;
  revision: string;
  sketchDir: string;
  entry: string;
  nodeVersion: string;
  lockSha256: string;
  sourceFiles: SourceFile[];
  params: Params;
  seed: number;
  finishing?: FinishingOptions;
  format?: FormatOptions;
  identity: string;
  canonicalSvgSha256: string;
}
export interface CreatedCheckpoint { path: string; manifest: CheckpointManifest | ExternalCheckpointManifest }
export interface CreateCheckpointOptions { entry: string; result: RenderResult; outputDir: string }
export interface ReplayCheckpointOptions { checkpoint: string; repoRoot?: string }
export interface SketchInputFingerprint { kind: 'external' | 'repository'; fingerprint: string; sourceSha256: string; dependencySha256: string; revision?: string; toolkit?: { core: string; host: string } }

function within(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalTarget(path: string): Promise<string> {
  let current = resolve(path);
  const absent: string[] = [];
  for (;;) {
    try { return join(await realpath(current), ...absent.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      absent.push(basename(current));
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function safeRelative(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && path.split(/[\\/]/).every(part => part !== '..' && part !== '' && part !== '.');
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await git('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function checkedRepo(entry: string): Promise<{ root: string; revision: string; sketchDir: string; relativeEntry: string }> {
  const absoluteEntry = resolve(entry);
  const root = await realpath(await gitOut(dirname(absoluteEntry), ['rev-parse', '--show-toplevel']));
  const sketchRoot = await realpath(dirname(absoluteEntry));
  if (!within(root, sketchRoot) || sketchRoot === root) throw new Error('Sketch must be in its own directory inside the Git repository');
  const actualEntry = await realpath(absoluteEntry);
  if ((await lstat(absoluteEntry)).isSymbolicLink() || !within(sketchRoot, actualEntry)) throw new Error('Sketch entry is a symlink or escapes its directory');
  const sketchDir = relative(root, sketchRoot);
  const relativeEntry = relative(sketchRoot, actualEntry);
  if (!safeRelative(sketchDir) || !safeRelative(relativeEntry)) throw new Error('Invalid sketch location');
  const revision = await gitOut(root, ['rev-parse', 'HEAD']);
  await gitOut(root, ['cat-file', '-e', `${revision}^{commit}`]);
  return { root, revision, sketchDir, relativeEntry };
}

function statusPaths(porcelain: string): string[] {
  const tokens = porcelain.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < tokens.length && tokens[i]; i++) {
    const record = tokens[i];
    paths.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) paths.push(tokens[++i]);
  }
  return paths;
}

async function requireCleanShared(root: string, sketchRoot: string): Promise<void> {
  const { stdout } = await git('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const dirty = statusPaths(stdout).filter(path => !within(sketchRoot, resolve(root, path)));
  if (dirty.length) throw new Error(`Shared source/config outside sketch is dirty or untracked: ${dirty.slice(0, 6).join(', ')}`);
}

async function collectFiles(root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Escaping or unsupported symlink in sketch: ${relative(root, full)}`);
      if (entry.name === '.git') throw new Error('Embedded Git directories are unsupported in a sketch checkpoint');
      if (info.isDirectory()) await visit(full);
      else if (info.isFile()) files.push({ path: relative(root, full).split(sep).join('/'), sha256: sha256(await readFile(full)) });
      else throw new Error(`Unsupported sketch input: ${relative(root, full)}`);
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function declarationsStayLocal(entry: string, sketchRoot: string, result: RenderResult): void {
  for (const [id, asset] of Object.entries(result.metadata.assets ?? {})) {
    const path = resolve(dirname(entry), asset.path);
    if (!within(sketchRoot, path)) throw new Error(`Asset ${id} escapes sketch directory: ${asset.path}`);
  }
}

async function declaredAssetsInFiles(entry: string, sourceRoot: string, files: { path: string }[], timeoutMs: number): Promise<void> {
  const metadata = await inspectSketch({ entry, timeoutMs });
  const captured = new Set(files.map(file => resolve(sourceRoot, file.path)));
  for (const [id, asset] of Object.entries(metadata.assets ?? {})) {
    const path = resolve(dirname(entry), asset.path);
    if (!within(sourceRoot, path) || !captured.has(path)) throw new Error(`Declared asset ${id} escapes or is missing from source family: ${asset.path}`);
  }
}

function verifyResult(result: RenderResult): void {
  if (result?.schemaVersion !== 1 || typeof result.svg !== 'string' || !result.svg.startsWith('<svg') || !Number.isSafeInteger(result.seed) || !result.metadata || !result.identity) {
    throw new Error('Checkpoint requires a successful render result');
  }
}

/** Capture local source bytes, then regenerate from the capture before publishing. */
async function createCheckpointV1({ entry, result, outputDir }: CreateCheckpointOptions): Promise<CreatedCheckpoint> {
  verifyResult(result);
  const { root, revision, sketchDir, relativeEntry } = await checkedRepo(entry);
  const sketchRoot = join(root, sketchDir);
  const absoluteOutput = await canonicalTarget(outputDir);
  if (within(sketchRoot, absoluteOutput)) throw new Error('Checkpoint output cannot be inside the captured sketch directory');
  await requireCleanShared(root, sketchRoot);
  const actualEntry = join(sketchRoot, relativeEntry);
  declarationsStayLocal(actualEntry, sketchRoot, result);
  const sourceFiles = await collectFiles(sketchRoot);
  const assetFiles = Object.entries(result.metadata.assets ?? {}).map(([id, asset]) => ({ id, path: relative(sketchRoot, resolve(dirname(actualEntry), asset.path)).split(sep).join('/') }));
  for (const asset of assetFiles) if (!sourceFiles.some(file => file.path === asset.path)) throw new Error(`Declared asset ${asset.id} is missing from sketch capture`);
  const lock = await readFile(join(root, 'package-lock.json'));
  const manifest: CheckpointManifest = {
    version: VERSION, createdAt: new Date().toISOString(), originRepo: root, revision,
    sketchDir: sketchDir.split(sep).join('/'), entry: relativeEntry.split(sep).join('/'),
    nodeVersion: process.version, lockSha256: sha256(lock), sourceFiles,
    params: { ...result.params }, seed: result.seed,
    ...(result.finishing === undefined ? {} : { finishing: structuredClone(result.finishing) }),
    ...(result.format === undefined ? {} : { format: structuredClone(result.format) }),
    identity: result.identity,
    canonicalSvgSha256: sha256(result.svg),
  };
  await mkdir(absoluteOutput, { recursive: true });
  const id = `checkpoint-${manifest.createdAt.replace(/[-:.]/g, '')}-${randomUUID()}`;
  const pending = join(absoluteOutput, `.${id}.pending`);
  const final = join(absoluteOutput, id);
  await mkdir(pending); // Exclusive; a failed capture never overwrites an existing checkpoint.
  try {
    await cp(sketchRoot, join(pending, 'source'), { recursive: true, dereference: false, errorOnExist: true, force: false });
    await writeFile(join(pending, 'package-lock.json'), lock, { flag: 'wx' });
    await writeFile(join(pending, 'canonical.svg'), result.svg, { flag: 'wx' });
    await writeFile(join(pending, MANIFEST), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    // A stale preview paired with newer source is rejected here, before the directory is published.
    const regenerated = await replayCheckpointV1({ checkpoint: pending, repoRoot: root });
    if (regenerated.identity !== result.identity || regenerated.svg !== result.svg) throw new Error('Captured source does not reproduce the supplied render identity');
    await rename(pending, final);
    return { path: final, manifest };
  } catch (error) {
    await rm(pending, { recursive: true, force: true });
    throw error;
  }
}

async function loadManifest(checkpoint: string): Promise<CheckpointManifest> {
  const value = JSON.parse(await readFile(join(checkpoint, MANIFEST), 'utf8')) as CheckpointManifest;
  if (value?.version !== VERSION || !safeRelative(value.sketchDir) || !safeRelative(value.entry) || !/^[0-9a-f]{40}$/.test(value.revision) || !Array.isArray(value.sourceFiles) ||
    (value.finishing !== undefined && (typeof value.finishing !== 'object' || value.finishing === null || Array.isArray(value.finishing))) ||
    (value.format !== undefined && (typeof value.format !== 'object' || value.format === null || Array.isArray(value.format)))) {
    throw new Error('Invalid checkpoint manifest');
  }
  return value;
}

async function verifyCapture(checkpoint: string, manifest: CheckpointManifest): Promise<void> {
  const lock = await readFile(join(checkpoint, 'package-lock.json'));
  if (sha256(lock) !== manifest.lockSha256) throw new Error('Captured dependency lockfile changed');
  const svg = await readFile(join(checkpoint, 'canonical.svg'), 'utf8');
  if (sha256(svg) !== manifest.canonicalSvgSha256) throw new Error('Canonical SVG changed');
  const files = await collectFiles(join(checkpoint, 'source'));
  if (JSON.stringify(files) !== JSON.stringify(manifest.sourceFiles)) throw new Error('Captured sketch source bytes changed');
}

async function renderCaptured(root: string, entry: string, params: Params, seed: number, finishing?: FinishingOptions, format?: FormatOptions): Promise<RenderResult> {
  return await new Promise<RenderResult>((resolveResult, rejectResult) => {
    let settled = false;
    let child: ChildProcess | undefined;
    const finish = (error?: Error, result?: RenderResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child && child.exitCode === null) child.kill('SIGKILL');
      if (error) rejectResult(error);
      else if (result) resolveResult(result);
      else rejectResult(new Error('Captured render produced no result'));
    };
    const timer = setTimeout(() => finish(new Error('Captured render timed out')), 15000);
    // One timer covers both attempts: a sketch that is not page-aware is rendered again with the target withheld.
    const start = (withholdTarget: boolean) => {
      const current = fork(join(root, 'cli/sketch/child.ts'), [], { cwd: root, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      child = current;
      const live = () => !settled && child === current;
      let stderr = '';
      current.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
      current.on('message', (message: unknown) => {
        if (!live()) return;
        const reply = message as { ok?: boolean; retry?: string; value?: RenderResult; error?: { message?: string } };
        if (reply.ok && reply.value?.schemaVersion === 1) finish(undefined, reply.value);
        else if (reply.retry === 'withholdTarget' && !withholdTarget) { current.kill('SIGKILL'); start(true); }
        else finish(new Error(`Captured render failed: ${reply.error?.message ?? 'invalid response'}`));
      });
      current.on('error', error => { if (live()) finish(error); });
      current.on('exit', code => { if (live()) finish(new Error(`Captured runner exited ${code}: ${stderr.slice(-1000)}`)); });
      current.send({ mode: 'render', entry, params, seed, ...(finishing === undefined ? {} : { finishing }), ...(format === undefined ? {} : { format }), ...(withholdTarget ? { withholdTarget } : {}) },
        error => { if (error && live()) finish(error); });
    };
    start(false);
  });
}

/** Replay the captured sketch against its recorded local Git revision. */
async function replayCheckpointV1({ checkpoint, repoRoot }: ReplayCheckpointOptions): Promise<RenderResult> {
  const directory = resolve(checkpoint);
  const manifest = await loadManifest(directory);
  await verifyCapture(directory, manifest);
  if (process.version !== manifest.nodeVersion) throw new Error(`Node runtime mismatch: captured ${manifest.nodeVersion}, current ${process.version}`);
  const origin = await realpath(resolve(repoRoot ?? manifest.originRepo));
  await gitOut(origin, ['cat-file', '-e', `${manifest.revision}^{commit}`]);
  const liveLock = await readFile(join(origin, 'package-lock.json'));
  if (sha256(liveLock) !== manifest.lockSha256) throw new Error('Installed workspace lockfile differs from checkpoint');
  const isolated = join(tmpdir(), `hatch3d-replay-${randomUUID()}`);
  // The checkout is separate from the active worktree; only captured source is overlaid.
  try {
    await gitOut(origin, ['clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', origin, isolated]);
    await gitOut(isolated, ['checkout', '--quiet', '--detach', manifest.revision]);
    const checkedLock = await readFile(join(isolated, 'package-lock.json'));
    if (sha256(checkedLock) !== manifest.lockSha256) throw new Error('Recorded revision has a different dependency lockfile');
    const sourceTarget = join(isolated, manifest.sketchDir);
    if (!within(isolated, sourceTarget)) throw new Error('Sketch path escapes isolated checkout');
    await rm(sourceTarget, { recursive: true, force: true });
    await mkdir(dirname(sourceTarget), { recursive: true });
    await cp(join(directory, 'source'), sourceTarget, { recursive: true, dereference: false });
    await symlink(join(origin, 'node_modules'), join(isolated, 'node_modules'), 'dir');
    const entry = join(sourceTarget, manifest.entry);
    if (!within(sourceTarget, entry)) throw new Error('Entrypoint escapes captured sketch');
    const result = await renderCaptured(isolated, entry, manifest.params, manifest.seed, manifest.finishing, manifest.format);
    if (sha256(result.svg) !== manifest.canonicalSvgSha256 || result.identity !== manifest.identity) {
      throw new Error('Checkpoint replay differs from canonical SVG or render identity');
    }
    return result;
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}

/** Capture the legacy in-repository format or an installed external family. */
export async function createCheckpoint(options: CreateCheckpointOptions): Promise<CreatedCheckpoint> {
  const external = await findExternalProject(options.entry);
  return external ? createExternalCheckpoint(external, options.result, options.outputDir) : createCheckpointV1(options);
}

/** Version dispatch keeps v1 replay independent of external package resolution. */
export async function replayCheckpoint(options: ReplayCheckpointOptions): Promise<RenderResult> {
  const value: unknown = JSON.parse((await readBounded(join(resolve(options.checkpoint), MANIFEST), 16 * 1024 * 1024)).toString('utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('Invalid checkpoint manifest');
  const version = (value as { version?: unknown }).version;
  if (version === 1) return replayCheckpointV1(options);
  if (version === 2) return replayExternalCheckpoint(options.checkpoint);
  throw new Error(`Unsupported checkpoint version ${String(version)}`);
}

/** Reuse the checkpoint source boundaries to key and guard experiment batches. */
export async function fingerprintSketchInputs(entry: string, outputDir: string, timeoutMs = 10_000): Promise<SketchInputFingerprint> {
  const external = await findExternalProject(entry);
  const target = await canonicalTarget(outputDir);
  const runtimeModule = await realpath(fileURLToPath(import.meta.url));
  if (external) {
    if (within(external.familyRoot, target)) throw new Error('Experiment output cannot be inside the captured family directory');
    const installedHost = join(external.root, 'node_modules/@hatch3d/plot-host');
    if (!within(installedHost, runtimeModule)) throw new Error('External experiment must run from this project’s installed @hatch3d/plot-host; use its plot-sketch bin or package API');
    const snapshot = await fingerprintExternalProject(external);
    const files = await externalSourceFiles(external.familyRoot);
    if (sha256(JSON.stringify(files)) !== snapshot.sourceSha256) throw new Error('External source changed during fingerprinting');
    await declaredAssetsInFiles(external.entry, external.familyRoot, files, timeoutMs);
    if (sha256(JSON.stringify(await externalSourceFiles(external.familyRoot))) !== snapshot.sourceSha256) throw new Error('External source changed during asset inspection');
    return { kind: 'external', ...snapshot };
  }
  const checked = await checkedRepo(entry);
  const sketchRoot = join(checked.root, checked.sketchDir);
  if (within(sketchRoot, target)) throw new Error('Experiment output cannot be inside the sketch directory');
  if (runtimeModule !== join(checked.root, 'cli/sketch/checkpoint.ts')) throw new Error('In-repository experiment must run from the Hatch3D source checkout CLI/API');
  await requireCleanShared(checked.root, sketchRoot);
  const files = await collectFiles(sketchRoot);
  await declaredAssetsInFiles(join(sketchRoot, checked.relativeEntry), sketchRoot, files, timeoutMs);
  if (JSON.stringify(await collectFiles(sketchRoot)) !== JSON.stringify(files)) throw new Error('Sketch source changed during asset inspection');
  const lock = await readFile(join(checked.root, 'package-lock.json'));
  const sourceSha256 = sha256(JSON.stringify(files));
  const dependencySha256 = sha256(`${sha256(lock)}\0${await fingerprintInstalledTree(join(checked.root, 'node_modules'))}`);
  return { kind: 'repository', revision: checked.revision, sourceSha256, dependencySha256,
    fingerprint: sha256(JSON.stringify({ revision: checked.revision, sourceSha256, dependencySha256, node: process.version,
      platform: process.platform, arch: process.arch })) };
}
