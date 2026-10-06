import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { exportSketchPng } from '../../cli/sketch/export-png.ts';
import { main } from '../../cli/sketch.ts';
import type { RenderResult } from '../sketch/types.ts';

const runner = vi.hoisted(() => ({ inspectSketch: vi.fn(), renderSketch: vi.fn() }));
vi.mock('../../cli/sketch/runner.js', () => ({ ...runner, SketchRunnerError: class extends Error {
  constructor(public code: string, message: string) { super(message); }
} }));
vi.mock('../../cli/sketch/source-stamp.js', () => ({
  sourceStamp: vi.fn(async (entry: string) => (await import('node:fs/promises')).readFile(entry, 'utf8')),
}));
import { startSketchServer, type SketchServer } from '../../cli/sketch/server.ts';

const result: RenderResult = {
  schemaVersion: 1,
  metadata: { name: 'Ink test', page: { width: 10, height: 8, paper: '#f2e9dc' }, pens: [
    { id: 'black', color: '#222222', width: 1 }, { id: 'red', color: '#ff0000', width: 1 },
  ], controls: [], assets: {} },
  params: {}, seed: 0, parts: [], identity: 'current', diagnostics: [],
  stats: { pathCount: 2, pointCount: 4, lengthMm: 16, partCount: 2 }, durationMs: 1,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="8mm" viewBox="0 0 10 8"><path d="M1 2 H9" stroke="#222222" stroke-width="1"/><path d="M1 5 H9" stroke="#ff0000" stroke-width="1"/></svg>',
};

function pixel(bytes: Buffer, x: number, y: number): number[] {
  const png = PNG.sync.read(bytes);
  const offset = (y * png.width + x) * 4;
  return [...png.data.subarray(offset, offset + 3)];
}

describe('PNG finishing presentation', () => {
  it('uses exact pixels per millimeter, paper stock, and presentation themes without changing SVG', () => {
    const original = result.svg;
    const paper = exportSketchPng(result, 'paper', 4);
    const light = exportSketchPng(result, 'light', 4);
    const dark = exportSketchPng(result, 'dark', 4);
    expect(PNG.sync.read(paper)).toMatchObject({ width: 40, height: 32 });
    expect(pixel(paper, 0, 0)).toEqual([242, 233, 220]);
    expect(pixel(light, 0, 0)).toEqual([255, 255, 255]);
    expect(pixel(dark, 0, 0)).toEqual([42, 42, 47]);
    expect(pixel(paper, 20, 8)).toEqual([34, 34, 34]);
    expect(pixel(dark, 20, 8)).toEqual([232, 230, 225]);
    expect(pixel(dark, 20, 20)).toEqual([255, 0, 0]);
    expect(result.svg).toBe(original);
  });

  it('rejects unsupported scales and oversize sheets before raster allocation', () => {
    expect(() => exportSketchPng(result, 'paper', 5)).toThrow(/scale/);
    const huge = structuredClone(result);
    huge.metadata.page = { width: 1000, height: 1000 };
    expect(() => exportSketchPng(huge, 'paper', 8)).toThrow(/32 million pixel/);
  });
});

describe('finishing transport', () => {
  let temporary: string;
  let server: SketchServer;
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'sketch-finishing-transport-'));
    const entry = join(temporary, 'source/sketch.ts');
    await mkdir(join(temporary, 'source'));
    await writeFile(entry, 'export default {}');
    runner.inspectSketch.mockReset().mockResolvedValue(result.metadata);
    runner.renderSketch.mockReset().mockResolvedValue(result);
    server = await startSketchServer({ entry, outputDir: join(temporary, 'pins') });
    // Some filesystem backends deliver the initial source write after watch() starts.
    await new Promise(resolve => setTimeout(resolve, 180));
  });
  afterEach(async () => { await server.close(); await rm(temporary, { recursive: true, force: true }); });

  const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('publishes options and forwards finishing while rejecting extra request keys', async () => {
    const options = await (await fetch(new URL('/api/finishing-options', server.url))).json();
    expect(options.pngScales).toEqual([1, 2, 3, 4, 6, 8]);
    expect(options.paperSizes).toHaveProperty('a4');
    expect(options.borderStyles).toHaveProperty('double');
    const finishing = { border: { style: 'double', pen: 'black', inset: 12, contentGap: 6 }, pens: { black: { passes: 2 } } };
    const response = await post(new URL('/api/render', server.url).href, { requestId: 1, params: {}, finishing });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(runner.renderSketch).toHaveBeenCalledWith(expect.objectContaining({ finishing }));
    expect((await post(new URL('/api/render', server.url).href, { requestId: 2, params: {}, typo: true })).status).toBe(400);
    expect(runner.renderSketch).toHaveBeenCalledTimes(1);
  });

  it('exports only the current identity and validates theme and scale', async () => {
    const endpoint = (identity: string, query = '') => new URL(`/api/export.png?identity=${identity}${query}`, server.url);
    expect((await fetch(endpoint('current'))).status).toBe(409);
    const rendered = await post(new URL('/api/render', server.url).href, { requestId: 1 });
    expect(rendered.status, await rendered.clone().text()).toBe(200);
    const exported = await fetch(endpoint('current', '&theme=dark&scale=4'));
    expect(exported.status).toBe(200);
    expect(exported.headers.get('cache-control')).toBe('no-store');
    expect(exported.headers.get('content-disposition')).toContain('ink-test-dark-4x.png');
    expect(PNG.sync.read(Buffer.from(await exported.arrayBuffer()))).toMatchObject({ width: 40, height: 32 });
    expect((await fetch(endpoint('old'))).status).toBe(409);
    expect((await fetch(endpoint('current', '&theme=sepia'))).status).toBe(400);
    expect((await fetch(endpoint('current', '&scale=5'))).status).toBe(400);
    runner.renderSketch.mockRejectedValueOnce(new Error('bad geometry'));
    expect((await post(new URL('/api/render', server.url).href, { requestId: 2 })).status).toBe(422);
    expect((await fetch(endpoint('current'))).status).toBe(409);
  });
});

describe('CLI finishing request', () => {
  let temporary: string;
  beforeEach(async () => { temporary = await mkdtemp(join(tmpdir(), 'sketch-finishing-cli-')); runner.renderSketch.mockReset().mockResolvedValue(result); });
  afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

  it('reads finishing JSON and saved config, and keeps their conflict explicit', async () => {
    const entry = join(temporary, 'sketch.ts');
    const output = join(temporary, 'out');
    await writeFile(entry, 'export default {}');
    const finishing = { page: { width: 12, height: 8 }, border: { style: 'simple', pen: 'black', inset: 1, contentGap: 1 }, pens: { black: { width: 0.5 } } };
    const file = join(temporary, 'finishing.json');
    await writeFile(file, JSON.stringify(finishing));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main(['render', entry, '--finishing', `@${file}`, '--png-theme', 'light', '--png-scale', '2', '--out', output]);
      expect(runner.renderSketch).toHaveBeenCalledWith(expect.objectContaining({ finishing }));
      expect(PNG.sync.read(await readFile(join(output, 'render.png')))).toMatchObject({ width: 20, height: 16 });
      const config = join(temporary, 'request.json');
      await writeFile(config, JSON.stringify({ finishing, seed: 7, params: {} }));
      await main(['render', entry, '--config', config, '--out', output]);
      expect(runner.renderSketch).toHaveBeenCalledWith(expect.objectContaining({ finishing, seed: 7 }));
      await expect(main(['render', entry, '--config', config, '--finishing', '{}'])).rejects.toThrow(/cannot be combined/);
      await expect(main(['render', entry, '--finishing', '[]'])).rejects.toThrow(/JSON object/);
      await expect(main(['render', entry, '--unknown', 'x'])).rejects.toThrow(/Unknown or repeated/);
      const completed = runner.renderSketch.mock.calls.length;
      await expect(main(['render', entry, '--png-scale', '5'])).rejects.toThrow(/PNG scale/);
      expect(runner.renderSketch).toHaveBeenCalledTimes(completed);
    } finally { log.mockRestore(); }
  });
});
