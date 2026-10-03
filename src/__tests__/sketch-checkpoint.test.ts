import { afterEach, describe, expect, it } from 'vitest';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCheckpoint, replayCheckpoint } from '../../cli/sketch/checkpoint.ts';
import { comparePreserved } from '../../cli/sketch/preserve.ts';
import type { RenderResult } from '../sketch/types.ts';

const exec = promisify(execFile);
const project = resolve(import.meta.dirname, '../..');
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function command(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', args, { cwd });
}

async function fixture(): Promise<{ root: string; entry: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hatch3d-checkpoint-test-'));
  temporary.push(root);
  for (const file of ['package.json', 'package-lock.json', 'cli/sketch/child.ts', 'cli/sketch/raster.ts', 'src/sketch/types.ts', 'src/utils/clip.ts']) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await cp(join(project, file), join(root, file));
  }
  const entry = join(root, 'sketches/study/sketch.ts');
  await mkdir(join(root, 'sketches/study'), { recursive: true });
  await writeFile(entry, `export default {
    name: 'Checkpoint fixture', page: { width: 20, height: 20, margin: 2 },
    pens: [{ id: 'p', color: '#222222', width: 0.3 }], controls: [],
    draw() { return [{ id: 'line', pen: 'p', paths: [[{x:3,y:8},{x:17,y:8}]], boundary: [[{x:2,y:2},{x:18,y:2},{x:18,y:18},{x:2,y:18}]] }]; }
  };`);
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, '.gitignore'), 'node_modules\nartifacts/\n');
  await command(root, 'init', '-q');
  await command(root, 'config', 'user.email', 'fixture@example.invalid');
  await command(root, 'config', 'user.name', 'Fixture');
  await command(root, 'add', '.gitignore', 'package.json', 'package-lock.json', 'cli', 'src', 'sketches');
  await command(root, 'commit', '-q', '-m', 'fixture');
  return { root, entry, output: join(root, 'artifacts') };
}

async function rendered(entry: string): Promise<RenderResult> {
  const child = fork(join(project, 'cli/sketch/child.ts'), [], {
    cwd: project, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  return new Promise((resolveResult, rejectResult) => {
    let response: RenderResult | undefined;
    let failure: Error | undefined;
    child.on('message', (message: unknown) => {
      const reply = message as { ok?: boolean; value?: RenderResult; error?: { message?: string } };
      if (reply.ok && reply.value) response = reply.value;
      else failure = new Error(reply.error?.message ?? 'Render failed');
      child.kill();
    });
    child.on('exit', () => failure ? rejectResult(failure) : response ? resolveResult(response) : rejectResult(new Error('Render exited without result')));
    child.send({ mode: 'render', entry, seed: 7 });
  });
}

describe('source checkpoint', () => {
  it('replays copied source after the active sketch changes', async () => {
    const { root, entry, output } = await fixture();
    const first = await rendered(entry);
    const saved = await createCheckpoint({ entry, result: first, outputDir: output });
    await writeFile(entry, (await readFile(entry, 'utf8')).replace('y:8', 'y:9'));
    const replay = await replayCheckpoint({ checkpoint: saved.path, repoRoot: root });
    expect(replay.svg).toBe(first.svg);
    expect(replay.identity).toBe(first.identity);
  }, 30000);

  it('rejects a stale render after the source changed', async () => {
    const { entry, output } = await fixture();
    const old = await rendered(entry);
    await writeFile(entry, (await readFile(entry, 'utf8')).replace('y:8', 'y:9'));
    await expect(createCheckpoint({ entry, result: old, outputDir: output })).rejects.toThrow(/replay differs|does not reproduce/);
  }, 30000);

  it('rejects dirty shared code and unsupported source or output paths', async () => {
    const { root, entry, output } = await fixture();
    const result = await rendered(entry);
    await writeFile(join(root, 'src/shared.ts'), 'export const dirty = true;');
    await expect(createCheckpoint({ entry, result, outputDir: output })).rejects.toThrow(/Shared source/);
    await rm(join(root, 'src/shared.ts'));
    await symlink('/tmp/not-a-captured-input', join(root, 'sketches/study/external'));
    await expect(createCheckpoint({ entry, result, outputDir: output })).rejects.toThrow(/symlink/);
    await rm(join(root, 'sketches/study/external'));
    await expect(createCheckpoint({ entry, result, outputDir: join(root, 'sketches/study/output') })).rejects.toThrow(/inside the captured/);
    const escaped = structuredClone(result);
    escaped.metadata.assets.outside = { path: '../../../elsewhere.png', box: { x: 0, y: 0, width: 20, height: 20 }, fit: 'contain', dataUrl: '', width: 1, height: 1 };
    await expect(createCheckpoint({ entry, result: escaped, outputDir: output })).rejects.toThrow(/escapes sketch/);
  }, 30000);

  it('rejects a missing declared asset and missing recorded revision', async () => {
    const { entry, output } = await fixture();
    const result = await rendered(entry);
    const missing = structuredClone(result);
    missing.metadata.assets.missing = { path: 'missing.png', box: { x: 0, y: 0, width: 20, height: 20 }, fit: 'contain', dataUrl: '', width: 1, height: 1 };
    await expect(createCheckpoint({ entry, result: missing, outputDir: output })).rejects.toThrow(/missing from sketch capture/);
    const saved = await createCheckpoint({ entry, result, outputDir: output });
    const manifestPath = join(saved.path, 'checkpoint.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { revision: string };
    manifest.revision = '0'.repeat(40);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(replayCheckpoint({ checkpoint: saved.path })).rejects.toThrow();
  }, 30000);
});

describe('preservation', () => {
  it('passes unchanged nominated paths and boundary despite an unrelated part edit', async () => {
    const { entry } = await fixture();
    const first = await rendered(entry);
    const after = structuredClone(first);
    after.parts.push({ id: 'new', pen: 'p', paths: [[{ x: 4, y: 4 }, { x: 8, y: 4 }]] });
    expect(comparePreserved(first, after, { parts: ['line'], boundaries: ['line'] })).toEqual({ ok: true, changes: [] });
  }, 30000);

  it('reports final paths, boundary, pen, and page changes independently', async () => {
    const { entry } = await fixture();
    const first = await rendered(entry);
    const after = structuredClone(first);
    after.parts[0].paths[0][1].y = 9;
    after.parts[0].boundary![0][0].x = 3;
    after.metadata.pens[0].width = 0.5;
    after.metadata.page.width = 21;
    const comparison = comparePreserved(first, after, { parts: ['line'], boundaries: ['line'] });
    expect(comparison.ok).toBe(false);
    expect(comparison.changes.map(change => change.scope).sort()).toEqual(['boundary', 'page', 'part', 'pen']);
  }, 30000);
});
