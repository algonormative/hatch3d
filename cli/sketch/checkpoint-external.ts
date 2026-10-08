import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { FinishingOptions, FormatOptions, Params, RenderResult } from '../../src/sketch/types.ts';

const run = promisify(execFile);
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const integrity = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const MAX_SOURCE_FILES = 256;
const MAX_SOURCE_DIRS = 256;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_PACKAGES = 128;
const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_ARCHIVE_BYTES = 160 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_CANONICAL_BYTES = 40 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'output', 'pins', '.sketch-output', 'dist']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.md', '.yaml', '.yml', '.txt']);
const packageName = (nodePath: string): string | undefined => /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(nodePath)?.[1];
const validNodePath = (path: string) => /^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(path);
const safeFamilyDir = (path: string) => safeRel(path) && !['dependencies', 'node_modules', 'source', '.npm-cache', 'package.json', 'package-lock.json'].includes(path.split('/')[0]);
const within = (base: string, path: string) => { const rel = relative(base, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const safeRel = (path: string) => path.length > 0 && !isAbsolute(path) && path.split(/[\\/]/).every(part => part !== '..' && part !== '.' && part !== '');
const json = (bytes: Buffer, label: string): Record<string, unknown> => { try { const value: unknown = JSON.parse(bytes.toString('utf8')); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* message below */ } throw new Error(`Invalid ${label} JSON`); };
export async function readBounded(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error(`Checkpoint file is not a bounded regular file: ${path}`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw new Error(`Checkpoint file exceeds size limit: ${path}`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (total !== info.size) throw new Error(`Checkpoint file changed while reading: ${path}`);
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
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

export interface ExternalSourceFile { path: string; sha256: string; bytes: number }
export interface ExternalArchive { nodePath: string; name: string; version: string; file: string; sha256: string; integrity: string; expandedBytes: number }
export interface ExternalCheckpointManifest {
  version: 2; kind: 'external'; createdAt: string; projectName: string; familyDir: string; entry: string;
  nodeVersion: string; npmVersion: string; platform: string; arch: string;
  packageSha256: string; lockSha256: string; replayPackageSha256: string; replayLockSha256: string;
  sourceFiles: ExternalSourceFile[]; archives: ExternalArchive[];
  toolkit: { core: string; host: string };
  params: Params; seed: number; finishing?: FinishingOptions; format?: FormatOptions; identity: string; canonicalSvgSha256: string;
}
export interface ExternalProject { root: string; familyRoot: string; entry: string; familyDir: string; relativeEntry: string; pkg: Record<string, unknown>; packageBytes: Buffer; lockBytes: Buffer }

export async function findExternalProject(entry: string): Promise<ExternalProject | null> {
  const actualEntry = await realpath(resolve(entry));
  if ((await lstat(resolve(entry))).isSymbolicLink()) throw new Error('External sketch entry may not be a symlink');
  const familyRoot = dirname(actualEntry);
  let current = familyRoot;
  for (;;) {
    try {
      const packageBytes = await readBounded(join(current, 'package.json'), MAX_DOCUMENT_BYTES);
      const pkg = json(packageBytes, 'project package');
      const deps = pkg.dependencies as Record<string, unknown> | undefined;
      if (deps && typeof deps['@hatch3d/plot-core'] === 'string' && typeof deps['@hatch3d/plot-host'] === 'string') {
        const lockBytes = await readBounded(join(current, 'package-lock.json'), MAX_DOCUMENT_BYTES).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('External project requires package-lock.json (npm lockfile v3)'); throw error; });
        const root = await realpath(current);
        if (root === familyRoot) throw new Error('External sketch must live in its own family directory beneath the package root');
        const familyDir = relative(root, familyRoot);
        const relativeEntry = relative(familyRoot, actualEntry);
        if (!safeFamilyDir(familyDir.split(sep).join('/')) || !safeRel(relativeEntry)) throw new Error('Invalid external family entry path');
        if (pkg.type !== 'module') throw new Error('External project package.json must declare "type": "module"');
        return { root, familyRoot, entry: actualEntry, familyDir: familyDir.split(sep).join('/'), relativeEntry: relativeEntry.split(sep).join('/'), pkg, packageBytes, lockBytes };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function sourceFiles(root: string): Promise<ExternalSourceFile[]> {
  if (!(await lstat(root)).isDirectory()) throw new Error('External family source must be a real directory');
  const files: ExternalSourceFile[] = [];
  let bytes = 0;
  let directories = 0;
  async function visit(dir: string): Promise<void> {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      const rel = relative(root, full).split(sep).join('/');
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Unsupported symlink in family source: ${rel}`);
      if (info.isDirectory()) {
        if (SKIP_DIRS.has(item.name)) continue;
        if (item.name.startsWith('.') || /(?:secret|credential|token|private)/i.test(item.name)) throw new Error(`Unsupported family source directory: ${rel}`);
        if (++directories > MAX_SOURCE_DIRS) throw new Error('External family has more than 256 source directories');
        await visit(full);
        continue;
      }
      if (!info.isFile()) throw new Error(`Unsupported family input: ${rel}`);
      if (/(^|\/)(?:\.env(?:\.|$)|[^/]*(?:secret|credential|token|private)[^/]*)/i.test(rel)) throw new Error(`Sensitive family file is not checkpointable: ${rel}`);
      const extension = `.${item.name.split('.').at(-1)}`.toLowerCase();
      if (!SOURCE_EXTENSIONS.has(extension) || item.name.startsWith('.') || ['package.json', 'package-lock.json', 'tsconfig.json'].includes(item.name)) throw new Error(`Unsupported family source file: ${rel}`);
      bytes += info.size;
      if (bytes > MAX_SOURCE_BYTES) throw new Error('External family source exceeds 20 MiB');
      if (files.length >= MAX_SOURCE_FILES) throw new Error('External family has more than 256 source files');
      files.push({ path: rel, sha256: hash(await readBounded(full, MAX_SOURCE_BYTES)), bytes: info.size });
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function directDeps(pkg: Record<string, unknown>): Set<string> {
  const deps = pkg.dependencies;
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) throw new Error('External project requires declared runtime dependencies');
  for (const [kind, values] of Object.entries(pkg)) if (['dependencies', 'devDependencies', 'optionalDependencies'].includes(kind) && values && typeof values === 'object') {
    for (const spec of Object.values(values as Record<string, unknown>)) if (typeof spec !== 'string' || /^(?:workspace:|link:)/.test(spec) || (/^file:/.test(spec) && !/\.tgz$/.test(spec))) throw new Error(`Unsupported ${kind} dependency; use a lockfile and package tarballs`);
  }
  return new Set(Object.keys(deps as Record<string, unknown>));
}

async function auditImports(project: ExternalProject, captured: ExternalSourceFile[]): Promise<void> {
  const deps = directDeps(project.pkg);
  const familyRoot = await realpath(project.familyRoot);
  const entry = await realpath(project.entry);
  if (!within(familyRoot, entry)) throw new Error('External entry escapes captured family');
  const sourceSet = new Set(captured.map(file => resolve(familyRoot, file.path)));
  const { build, transform } = await import('esbuild');
  for (const file of captured.filter(item => /\.[cm]?[jt]sx?$/.test(item.path))) {
    const source = (await readBounded(join(familyRoot, file.path), MAX_SOURCE_BYTES)).toString('utf8');
    // Transform parses syntax and removes comments before the conservative dynamic-resolution scan.
    // In particular, import /* comment */ (target) must not escape this check.
    const loader = file.path.endsWith('.tsx') ? 'tsx' : file.path.endsWith('.ts') ? 'ts' : 'js';
    const normalized = (await transform(source, { loader, format: 'esm', target: 'node20' })).code;
    if (/\bimport\s*\(|\brequire\s*\(|\bcreateRequire\b/.test(normalized)) throw new Error(`Dynamic import/require is unsupported in external checkpoint source: ${file.path}`);
  }
  await build({ entryPoints: [entry], absWorkingDir: familyRoot, bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', plugins: [{ name: 'family-boundary', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'entry-point') return undefined;
      const spec = args.path;
      if (spec.startsWith('file:') || isAbsolute(spec)) throw new Error(`Absolute/file import is unsupported: ${spec}`);
      if (spec.startsWith('.')) {
        if (!within(familyRoot, resolve(args.resolveDir, spec))) throw new Error(`Import escapes family source: ${spec}`);
      } else if (!spec.startsWith('node:')) {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!deps.has(name)) throw new Error(`Import ${spec} is not a declared runtime dependency`);
      }
      return undefined;
    });
  } }] }).then(result => {
    for (const input of Object.keys(result.metafile?.inputs ?? {})) {
      const path = resolve(familyRoot, input);
      if (!within(familyRoot, path) || !sourceSet.has(path)) throw new Error(`Imported source is outside captured family: ${input}`);
    }
  });
}

function lockGraph(lock: Record<string, unknown>): Record<string, Record<string, unknown>> {
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) throw new Error('External checkpoint supports npm package-lock v3 only');
  const packages = lock.packages as Record<string, Record<string, unknown>>;
  if (!packages['']) throw new Error('Lockfile lacks project root');
  if (Object.keys(packages).length > MAX_PACKAGES + 64) throw new Error('Dependency lock graph is too large');
  for (const [path, info] of Object.entries(packages)) {
    if (path === '') continue;
    if (!safeRel(path) || !validNodePath(path) || !info || typeof info !== 'object' || info.link || (typeof info.version !== 'string' && info.optional !== true)) throw new Error(`Unsupported lock node: ${path}`);
    if (typeof info.resolved === 'string' && (/^(?:workspace:|link:)/.test(info.resolved) || (/^file:/.test(info.resolved) && !/\.tgz$/.test(info.resolved)))) throw new Error(`Workspace/link/directory dependency is unsupported: ${path}`);
  }
  return packages;
}

export async function installedNodes(project: ExternalProject, lock: Record<string, unknown>): Promise<{ nodePath: string; name: string; version: string; dir: string }[]> {
  const packages = lockGraph(lock);
  const canonicalRoot = await realpath(project.root);
  const nodes: { nodePath: string; name: string; version: string; dir: string }[] = [];
  for (const [nodePath, info] of Object.entries(packages)) {
    if (!nodePath) continue;
    const dir = join(project.root, nodePath);
    let actual: string;
    try { actual = await realpath(dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (info.optional === true || info.dev === true)) continue;
      throw new Error(`Locked dependency is missing at ${nodePath}`);
    }
    if (actual !== join(canonicalRoot, nodePath) || (await lstat(dir)).isSymbolicLink()) throw new Error(`Symlinked dependency is unsupported: ${nodePath}`);
    const manifest = json(await readFile(join(dir, 'package.json')), `installed ${nodePath}`);
    const name = packageName(nodePath)!;
    if (manifest.name !== name || manifest.version !== info.version || (info.name !== undefined && info.name !== name)) throw new Error(`Installed dependency differs from lock at ${nodePath}`);
    nodes.push({ nodePath, name, version: info.version as string, dir });
  }
  if (nodes.length > MAX_PACKAGES) throw new Error('More than 128 installed dependencies are unsupported');
  const expectedPaths = new Set(nodes.map(node => node.nodePath));
  async function inventory(nodeModules: string): Promise<void> {
    let names;
    try { names = await readdir(join(project.root, nodeModules), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const item of names) {
      if (item.name.startsWith('.')) continue;
      const child = `${nodeModules}/${item.name}`;
      if (item.name.startsWith('@')) {
        if (!item.isDirectory()) throw new Error(`Unsupported installed dependency scope: ${child}`);
        for (const scoped of await readdir(join(project.root, child), { withFileTypes: true })) {
          const nodePath = `${child}/${scoped.name}`;
          if (!scoped.isDirectory() || !expectedPaths.has(nodePath)) throw new Error(`Unexpected installed dependency: ${nodePath}`);
          await inventory(`${nodePath}/node_modules`);
        }
      } else {
        if (!item.isDirectory() || !expectedPaths.has(child)) throw new Error(`Unexpected installed dependency: ${child}`);
        await inventory(`${child}/node_modules`);
      }
    }
  }
  await inventory('node_modules');
  for (const name of ['@hatch3d/plot-core', '@hatch3d/plot-host']) if (!nodes.some(node => node.name === name)) throw new Error(`Required toolkit package ${name} is missing`);
  for (const name of ['@resvg/resvg-js', 'esbuild']) {
    const dir = join(project.root, 'node_modules', name);
    const manifest = json(await readFile(join(dir, 'package.json')), name);
    const optional = manifest.optionalDependencies as Record<string, unknown> | undefined;
    if (!optional || !Object.keys(optional).some(candidate => nodes.some(node => node.name === candidate && candidate.includes(`${process.platform}-${process.arch}`)))) {
      throw new Error(`Required native optional package for ${name} on ${process.platform}/${process.arch} is missing`);
    }
  }
  return nodes;
}

/** A bounded digest of the same installed source/dependency closure used by v2 capture. */
export async function fingerprintExternalProject(project: ExternalProject): Promise<{ sourceSha256: string; dependencySha256: string; fingerprint: string; toolkit: { core: string; host: string } }> {
  const files = await sourceFiles(project.familyRoot);
  await auditImports(project, files);
  const packageBytes = await readBounded(join(project.root, 'package.json'), MAX_DOCUMENT_BYTES);
  const lockBytes = await readBounded(join(project.root, 'package-lock.json'), MAX_DOCUMENT_BYTES);
  const lock = json(lockBytes, 'project lock');
  const nodes = await installedNodes(project, lock);
  const digest = createHash('sha256');
  let count = 0, bytes = 0;
  async function visit(root: string, dir: string): Promise<void> {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === 'node_modules') continue; // Nested lock nodes are visited under their own full path.
      const full = join(dir, item.name);
      const rel = relative(root, full).split(sep).join('/');
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Symlinked installed dependency input is unsupported: ${full}`);
      if (info.isDirectory()) { await visit(root, full); continue; }
      if (!info.isFile()) throw new Error(`Unsupported installed dependency input: ${full}`);
      if (++count > 20_000 || (bytes += info.size) > MAX_EXPANDED_BYTES) throw new Error('Installed dependency source exceeds fingerprint limits');
      digest.update(`${rel}\0${info.mode}\0${info.size}\0`);
      digest.update(hash(await readBounded(full, MAX_EXPANDED_BYTES)));
    }
  }
  for (const node of nodes.sort((a, b) => a.nodePath.localeCompare(b.nodePath))) {
    digest.update(`${node.nodePath}\0${node.name}\0${node.version}\0`);
    await visit(node.dir, node.dir);
  }
  const sourceSha256 = hash(JSON.stringify(files));
  const dependencySha256 = digest.digest('hex');
  const toolkit = { core: nodes.find(node => node.name === '@hatch3d/plot-core')!.version,
    host: nodes.find(node => node.name === '@hatch3d/plot-host')!.version };
  return { sourceSha256, dependencySha256, fingerprint: hash(JSON.stringify({ sourceSha256, dependencySha256,
    packageSha256: hash(packageBytes), lockSha256: hash(lockBytes), toolkit, node: process.version, platform: process.platform, arch: process.arch })), toolkit };
}

/** The source-checkout host executes from its installed root dependency tree, including dev loaders. */
export async function fingerprintInstalledTree(root: string): Promise<string> {
  const actualRoot = await realpath(root);
  if (!(await lstat(root)).isDirectory()) throw new Error('Installed dependency tree must be a real directory');
  const digest = createHash('sha256');
  let count = 0, bytes = 0;
  async function visit(dir: string): Promise<void> {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, item.name);
      const rel = relative(root, full).split(sep).join('/');
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        const target = await realpath(full);
        if (!within(actualRoot, target)) throw new Error(`Installed dependency symlink escapes tree: ${rel}`);
        digest.update(`${rel}\0link\0${await readlink(full)}\0`);
        continue;
      }
      if (info.isDirectory()) { await visit(full); continue; }
      if (!info.isFile()) throw new Error(`Unsupported installed dependency input: ${rel}`);
      if (++count > 30_000 || (bytes += info.size) > 512 * 1024 * 1024) throw new Error('Installed dependency tree exceeds fingerprint limits');
      digest.update(`${rel}\0${info.mode}\0${info.size}\0`);
      digest.update(hash(await readBounded(full, 256 * 1024 * 1024)));
    }
  }
  await visit(root);
  return digest.digest('hex');
}

function expandedTar(bytes: Buffer, expectedName: string, expectedVersion: string): number {
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_BYTES + 1024 });
  let offset = 0, total = 0, entries = 0;
  let packageManifest: Record<string, unknown> | undefined;
  while (offset + 512 <= tar.length) {
    const head = tar.subarray(offset, offset + 512);
    if (head.every(byte => byte === 0)) break;
    const name = head.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(head.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
    const type = head[156];
    if (!name.startsWith('package/') || !safeRel(name.slice('package/'.length).replace(/\/$/, '')) || !Number.isSafeInteger(size) || size < 0 || ![0, 48, 53].includes(type) || (type === 53 && size !== 0) || offset + 512 + size > tar.length) throw new Error('Unsafe dependency tarball entry');
    total += size;
    if (total > MAX_EXPANDED_BYTES || ++entries > 20_000) throw new Error('Dependency tarball expands beyond checkpoint limits');
    if (name === 'package/package.json') {
      if (packageManifest) throw new Error('Duplicate dependency package manifest');
      packageManifest = json(tar.subarray(offset + 512, offset + 512 + size), 'dependency package');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (packageManifest?.name !== expectedName || packageManifest.version !== expectedVersion) throw new Error(`Dependency archive identity differs: ${expectedName}@${expectedVersion}`);
  return total;
}

function rewritePackage(original: Record<string, unknown>, archives: ExternalArchive[]): Record<string, unknown> {
  const clone = structuredClone(original);
  for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = clone[kind] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) if (spec.startsWith('file:')) {
      const match = archives.find(archive => archive.nodePath === `node_modules/${name}`);
      if (!match) throw new Error(`Local package ${name} is unavailable for offline replay`);
      deps[name] = `file:dependencies/${match.file}`;
    }
  }
  return clone;
}
function replayDocuments(pkg: Record<string, unknown>, lock: Record<string, unknown>, archives: ExternalArchive[]): { pkg: Buffer; lock: Buffer } {
  const replayPkg = rewritePackage(pkg, archives);
  const replayLock = structuredClone(lock);
  const packages = lockGraph(replayLock);
  for (const archive of archives) {
    const node = packages[archive.nodePath];
    if (!node || packageName(archive.nodePath) !== archive.name || node.version !== archive.version) throw new Error(`Archive does not match lock node ${archive.nodePath}`);
    node.resolved = `file:dependencies/${archive.file}`;
    node.integrity = archive.integrity;
  }
  packages[''].dependencies = replayPkg.dependencies;
  packages[''].devDependencies = replayPkg.devDependencies;
  packages[''].optionalDependencies = replayPkg.optionalDependencies;
  return { pkg: Buffer.from(JSON.stringify(replayPkg, null, 2) + '\n'), lock: Buffer.from(JSON.stringify(replayLock, null, 2) + '\n') };
}

async function npmVersion(): Promise<string> { const result = await run('npm', ['--version'], { timeout: 10_000 }); return result.stdout.trim(); }
async function npmCommand(cwd: string, args: string[], cache: string): Promise<string> {
  const emptyConfig = join(cwd, '.empty-user-npmrc');
  const emptyGlobal = join(cwd, '.empty-global-npmrc');
  await writeFile(emptyConfig, '');
  await writeFile(emptyGlobal, '');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key) && key !== 'NODE_OPTIONS'));
  const env = { ...inherited, npm_config_cache: cache, npm_config_userconfig: emptyConfig, npm_config_globalconfig: emptyGlobal,
    npm_config_registry: 'http://127.0.0.1:9/', npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
  try { const result = await run('npm', args, { cwd, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }); return result.stdout; }
  catch (error) { throw new Error(`Offline npm ${args[0]} failed: ${(error as Error).message.slice(0, 1200)}`); }
  finally { await rm(emptyConfig, { force: true }); await rm(emptyGlobal, { force: true }); }
}

async function renderPacked(root: string, entry: string, params: Params, seed: number, finishing?: FinishingOptions, format?: FormatOptions): Promise<RenderResult> {
  const childFile = join(root, 'node_modules/@hatch3d/plot-host/dist/child.js');
  const require = createRequire(join(root, 'node_modules/@hatch3d/plot-host/package.json'));
  let loader: string;
  try { loader = require.resolve('tsx'); }
  catch { throw new Error('Captured TypeScript loader tsx is unavailable'); }
  const { fork } = await import('node:child_process');
  const child = fork(childFile, [], { cwd: root, execArgv: ['--import', loader], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
  return await new Promise<RenderResult>((resolveResult, rejectResult) => {
    let settled = false;
    const finish = (error?: Error, result?: RenderResult) => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); if (error) rejectResult(error); else if (result) resolveResult(result); else rejectResult(new Error('External replay produced no result')); };
    const timer = setTimeout(() => finish(new Error('External replay render timed out')), 15_000);
    child.on('message', (message: unknown) => { const reply = message as { ok?: boolean; value?: RenderResult; error?: { message?: string } }; if (reply.ok && reply.value?.schemaVersion === 1) finish(undefined, reply.value); else finish(new Error(`External replay render failed: ${reply.error?.message ?? 'invalid response'}`)); });
    child.on('error', error => finish(error));
    child.on('exit', code => finish(new Error(`External replay child exited ${code}: ${stderr}`)));
    child.send({ mode: 'render', entry, params, seed, ...(finishing === undefined ? {} : { finishing }), ...(format === undefined ? {} : { format }) }, error => { if (error) finish(error); });
  });
}

async function verifyArchiveDirectory(checkpoint: string, manifest: ExternalCheckpointManifest): Promise<void> {
  const dir = join(checkpoint, 'dependencies');
  if (!(await lstat(dir)).isDirectory()) throw new Error('Dependency archive directory is not a real directory');
  if (new Set(manifest.archives.map(archive => archive.nodePath)).size !== manifest.archives.length) throw new Error('Duplicate dependency lock node archive');
  const expected = manifest.archives.map(archive => archive.file).sort();
  const actual = (await readdir(dir)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Dependency archive set changed');
  let compressed = 0, expanded = 0;
  for (const archive of manifest.archives) {
    if (!/^\d{3}\.tgz$/.test(archive.file) || !safeRel(archive.nodePath) || packageName(archive.nodePath) !== archive.name) throw new Error('Invalid archive manifest entry');
    const bytes = await readBounded(join(dir, archive.file), MAX_ARCHIVE_BYTES);
    compressed += bytes.length;
    if (bytes.length > MAX_ARCHIVE_BYTES || compressed > MAX_TOTAL_ARCHIVE_BYTES || hash(bytes) !== archive.sha256 || integrity(bytes) !== archive.integrity) throw new Error(`Dependency archive corrupt: ${archive.nodePath}`);
    const actualExpanded = expandedTar(bytes, archive.name, archive.version);
    if (actualExpanded !== archive.expandedBytes) throw new Error(`Dependency archive size changed: ${archive.nodePath}`);
    expanded += actualExpanded;
    if (expanded > MAX_EXPANDED_BYTES) throw new Error('Expanded dependency archives exceed checkpoint limit');
  }
}

function validateManifest(value: unknown): ExternalCheckpointManifest {
  const m = value as ExternalCheckpointManifest;
  if (!m || m.version !== 2 || m.kind !== 'external' || !safeFamilyDir(m.familyDir) || !safeRel(m.entry) || !Array.isArray(m.sourceFiles) || !Array.isArray(m.archives) || m.archives.length > MAX_PACKAGES || !/^[a-f0-9]{64}$/.test(m.identity) || typeof m.nodeVersion !== 'string' || typeof m.npmVersion !== 'string') throw new Error('Invalid external checkpoint manifest');
  return m;
}

async function verifyExternal(checkpoint: string, manifest: ExternalCheckpointManifest, sourceRoot = join(checkpoint, 'source')): Promise<{ pkg: Record<string, unknown>; lock: Record<string, unknown> }> {
  if (manifest.nodeVersion !== process.version || manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.npmVersion !== await npmVersion()) throw new Error(`External replay runtime mismatch: requires Node ${manifest.nodeVersion}, npm ${manifest.npmVersion}, ${manifest.platform}/${manifest.arch}`);
  const packageBytes = await readBounded(join(checkpoint, 'package.json'), MAX_DOCUMENT_BYTES);
  const lockBytes = await readBounded(join(checkpoint, 'package-lock.json'), MAX_DOCUMENT_BYTES);
  const replayPackage = await readBounded(join(checkpoint, 'replay-package.json'), MAX_DOCUMENT_BYTES);
  const replayLock = await readBounded(join(checkpoint, 'replay-package-lock.json'), MAX_DOCUMENT_BYTES);
  if (hash(packageBytes) !== manifest.packageSha256 || hash(lockBytes) !== manifest.lockSha256 || hash(replayPackage) !== manifest.replayPackageSha256 || hash(replayLock) !== manifest.replayLockSha256) throw new Error('Captured package or dependency lock changed');
  const pkg = json(packageBytes, 'captured package');
  const lock = json(lockBytes, 'captured dependency lock');
  const expected = replayDocuments(pkg, lock, manifest.archives);
  if (!expected.pkg.equals(replayPackage) || !expected.lock.equals(replayLock)) throw new Error('Replay lock does not match captured dependency graph');
  const files = await sourceFiles(sourceRoot);
  if (JSON.stringify(files) !== JSON.stringify(manifest.sourceFiles)) throw new Error('Captured family source bytes changed');
  await auditImports({ root: checkpoint, familyRoot: sourceRoot, entry: join(sourceRoot, manifest.entry), familyDir: manifest.familyDir,
    relativeEntry: manifest.entry, pkg, packageBytes, lockBytes }, files);
  if (hash(await readBounded(join(checkpoint, 'canonical.svg'), MAX_CANONICAL_BYTES)) !== manifest.canonicalSvgSha256) throw new Error('Canonical SVG changed');
  await verifyArchiveDirectory(checkpoint, manifest);
  return { pkg, lock };
}

export async function replayExternalCheckpoint(checkpoint: string): Promise<RenderResult> {
  const directory = resolve(checkpoint);
  const manifest = validateManifest(json(await readBounded(join(directory, 'checkpoint.json'), MAX_DOCUMENT_BYTES), 'external checkpoint manifest'));
  await verifyExternal(directory, manifest);
  const isolated = join(tmpdir(), `plot-external-replay-${randomUUID()}`);
  try {
    await mkdir(isolated);
    await cp(join(directory, 'source'), join(isolated, manifest.familyDir), { recursive: true, dereference: false });
    await cp(join(directory, 'dependencies'), join(isolated, 'dependencies'), { recursive: true, dereference: false });
    for (const file of ['package.json', 'package-lock.json', 'replay-package.json', 'replay-package-lock.json', 'canonical.svg']) await cp(join(directory, file), join(isolated, file));
    await verifyExternal(isolated, manifest, join(isolated, manifest.familyDir));
    await cp(join(isolated, 'replay-package.json'), join(isolated, 'package.json'));
    await cp(join(isolated, 'replay-package-lock.json'), join(isolated, 'package-lock.json'));
    const cache = join(isolated, '.npm-cache');
    await npmCommand(isolated, ['ci', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], cache);
    const project: ExternalProject = { root: isolated, familyRoot: join(isolated, manifest.familyDir), entry: join(isolated, manifest.familyDir, manifest.entry), familyDir: manifest.familyDir, relativeEntry: manifest.entry, pkg: json(await readFile(join(isolated, 'package.json')), 'replay package'), packageBytes: Buffer.alloc(0), lockBytes: Buffer.alloc(0) };
    const installed = await installedNodes(project, json(await readFile(join(isolated, 'package-lock.json')), 'replay lock'));
    const originalLock = json(await readBounded(join(isolated, 'replay-package-lock.json'), MAX_DOCUMENT_BYTES), 'replay lock');
    const originalPackages = lockGraph(originalLock);
    const expected = manifest.archives.filter(archive => originalPackages[archive.nodePath]?.dev !== true);
    for (const archive of expected) if (!installed.some(node => node.nodePath === archive.nodePath && node.name === archive.name && node.version === archive.version)) throw new Error(`Replayed dependency missing or moved: ${archive.nodePath}`);
    for (const node of installed) if (!manifest.archives.some(archive => archive.nodePath === node.nodePath && archive.name === node.name && archive.version === node.version)) throw new Error(`Replayed dependency lacks captured archive: ${node.nodePath}`);
    const result = await renderPacked(isolated, project.entry, manifest.params, manifest.seed, manifest.finishing, manifest.format);
    if (result.identity !== manifest.identity || hash(result.svg) !== manifest.canonicalSvgSha256) throw new Error('External checkpoint replay differs from canonical SVG or render identity');
    return result;
  } finally { await rm(isolated, { recursive: true, force: true }); }
}

export async function createExternalCheckpoint(project: ExternalProject, result: RenderResult, outputDir: string): Promise<{ path: string; manifest: ExternalCheckpointManifest }> {
  if (result.schemaVersion !== 1 || typeof result.svg !== 'string' || !result.svg.startsWith('<svg') || Buffer.byteLength(result.svg) > MAX_CANONICAL_BYTES) throw new Error('Checkpoint requires a successful render result below 40 MiB');
  const output = await canonicalTarget(outputDir);
  if (within(project.familyRoot, output)) throw new Error('Checkpoint output cannot be inside the captured family directory');
  const captured = await sourceFiles(project.familyRoot);
  if (!captured.some(file => file.path === project.relativeEntry)) throw new Error('External sketch entry is not captured');
  for (const [id, asset] of Object.entries(result.metadata.assets ?? {})) {
    const path = resolve(dirname(project.entry), asset.path);
    if (!within(project.familyRoot, path) || !captured.some(file => resolve(project.familyRoot, file.path) === path)) throw new Error(`Declared asset ${id} escapes or is missing from family source`);
  }
  await auditImports(project, captured);
  const lock = json(project.lockBytes, 'project lock');
  const nodes = await installedNodes(project, lock);
  const id = `checkpoint-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID()}`;
  await mkdir(output, { recursive: true });
  const pending = join(output, `.${id}.pending`), final = join(output, id);
  await mkdir(join(pending, 'dependencies'), { recursive: true });
  try {
    const archives: ExternalArchive[] = [];
    let compressed = 0, expanded = 0;
    for (const [index, node] of nodes.entries()) {
      const packed = JSON.parse(await npmCommand(pending, ['pack', '--json', '--ignore-scripts', '--pack-destination', join(pending, 'dependencies'), node.dir], join(pending, '.npm-cache'))) as { filename: string }[];
      if (packed.length !== 1) throw new Error(`Could not pack dependency ${node.nodePath}`);
      const originalFile = join(pending, 'dependencies', packed[0].filename);
      const bytes = await readBounded(originalFile, MAX_ARCHIVE_BYTES);
      compressed += bytes.length; expanded += expandedTar(bytes, node.name, node.version);
      if (bytes.length > MAX_ARCHIVE_BYTES || compressed > MAX_TOTAL_ARCHIVE_BYTES || expanded > MAX_EXPANDED_BYTES) throw new Error('Dependency archives exceed checkpoint size limits');
      const file = `${String(index).padStart(3, '0')}.tgz`;
      await rename(originalFile, join(pending, 'dependencies', file));
      archives.push({ nodePath: node.nodePath, name: node.name, version: node.version, file, sha256: hash(bytes), integrity: integrity(bytes), expandedBytes: expandedTar(bytes, node.name, node.version) });
    }
    await rm(join(pending, '.npm-cache'), { recursive: true, force: true });
    const replay = replayDocuments(project.pkg, lock, archives);
    await cp(project.familyRoot, join(pending, 'source'), { recursive: true, dereference: false, filter: path => path === project.familyRoot || !SKIP_DIRS.has(basename(path)) });
    if (JSON.stringify(await sourceFiles(join(pending, 'source'))) !== JSON.stringify(captured)) throw new Error('Captured source bytes changed during copy');
    await auditImports({ ...project, familyRoot: join(pending, 'source'), entry: join(pending, 'source', project.relativeEntry) }, captured);
    await writeFile(join(pending, 'package.json'), project.packageBytes, { flag: 'wx' });
    await writeFile(join(pending, 'package-lock.json'), project.lockBytes, { flag: 'wx' });
    await writeFile(join(pending, 'replay-package.json'), replay.pkg, { flag: 'wx' });
    await writeFile(join(pending, 'replay-package-lock.json'), replay.lock, { flag: 'wx' });
    await writeFile(join(pending, 'canonical.svg'), result.svg, { flag: 'wx' });
    const manifest: ExternalCheckpointManifest = { version: 2, kind: 'external', createdAt: new Date().toISOString(), projectName: String(project.pkg.name ?? ''), familyDir: project.familyDir, entry: project.relativeEntry,
      nodeVersion: process.version, npmVersion: await npmVersion(), platform: process.platform, arch: process.arch,
      packageSha256: hash(project.packageBytes), lockSha256: hash(project.lockBytes), replayPackageSha256: hash(replay.pkg), replayLockSha256: hash(replay.lock), sourceFiles: captured, archives,
      toolkit: { core: nodes.find(node => node.name === '@hatch3d/plot-core')!.version, host: nodes.find(node => node.name === '@hatch3d/plot-host')!.version },
      params: structuredClone(result.params), seed: result.seed, ...(result.finishing === undefined ? {} : { finishing: structuredClone(result.finishing) }), ...(result.format === undefined ? {} : { format: structuredClone(result.format) }), identity: result.identity, canonicalSvgSha256: hash(result.svg) };
    await writeFile(join(pending, 'checkpoint.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    const regenerated = await replayExternalCheckpoint(pending);
    if (regenerated.identity !== result.identity || regenerated.svg !== result.svg) throw new Error('Captured external source does not reproduce the supplied render identity');
    if (JSON.stringify(await sourceFiles(project.familyRoot)) !== JSON.stringify(captured) || hash(await readFile(join(project.root, 'package.json'))) !== manifest.packageSha256 || hash(await readFile(join(project.root, 'package-lock.json'))) !== manifest.lockSha256) throw new Error('External source or dependency manifest changed during capture');
    await rename(pending, final);
    return { path: final, manifest };
  } catch (error) { await rm(pending, { recursive: true, force: true }); throw error; }
}
