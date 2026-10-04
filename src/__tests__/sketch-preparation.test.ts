// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { RenderResult } from '../sketch/types.ts';

const runner = vi.hoisted(() => ({ inspectSketch: vi.fn(), renderSketch: vi.fn() }));
vi.mock('../../cli/sketch/runner.js', () => runner);
import { startSketchServer, type SketchServer } from '../../cli/sketch/server.ts';
import { preparedQueueId } from '../../cli/sketch/plugins/plotter-upload.ts';
import { renderSvgPng } from '../../cli/sketch/export-png.ts';
import { prepareRender } from '../../cli/sketch/preparation.ts';
import { sourceStamp } from '../../cli/sketch/source-stamp.ts';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/plotprep');
const sourceSvg = await readFile(join(fixtureDir, 'cleanup-input.svg'), 'utf8');
const preparedSvg = await readFile(join(fixtureDir, 'cleanup-prepared.svg'));
const result: RenderResult = {
  schemaVersion: 1,
  metadata: { name: 'Visible cleanup', page: { width: 30, height: 20, paper: '#ffffff' },
    pens: [{ id: 'ink', color: '#000', width: 0.3, passes: 1 }], controls: [], assets: {} },
  params: {}, seed: 7, parts: [{ id: 'trace', pen: 'ink', paths: [
    [{ x: 1, y: 10 }, { x: 10, y: 10 }], [{ x: 11, y: 10 }, { x: 20, y: 10 }],
  ] }], svg: sourceSvg, identity: 'cleanup-current', diagnostics: [],
  stats: { pathCount: 2, pointCount: 4, lengthMm: 18, partCount: 1 }, durationMs: 1,
};

const version = { schema_version: 1, engine: { name: 'plotprep', version: '0.1.0', vsvg_revision: 'b02060a761e9f0d177293fd7a6f01dd2a28ddae7' } };

async function stubBinary(dir: string, slow = false): Promise<string> {
  const script = join(dir, slow ? 'plotprep-slow' : 'plotprep-stub');
  await writeFile(script, `#!/usr/bin/env node
const fs=require('node:fs');
const mode=process.argv[2];
if(mode==='version'){console.log(${JSON.stringify(JSON.stringify(version))});process.exit(0)}
if(${slow} && mode==='prepare') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);
const r=JSON.parse(fs.readFileSync(${JSON.stringify(join(fixtureDir, 'cleanup-report.json'))},'utf8'));
r.source.path='input.svg';
if(mode==='inspect'){
 r.prepared=null;
 r.operations.cleanup={enabled:false,merge_scope:null,merge_tolerance_mm:null,result:null,simplify_tolerance_mm:null};
 r.operations.sort={enabled:false,allow_reverse:false,result:null,objective_before_mm:r.geometry.normalized.pen_up_mm,objective_after_mm:r.geometry.normalized.pen_up_mm};
 r.geometry.after_cleanup=r.geometry.normalized;r.geometry.output=r.geometry.normalized;
 r.pass_weighted.after_cleanup=r.pass_weighted.before;r.pass_weighted.output=r.pass_weighted.before;
 r.travel.after_cleanup_mm=r.travel.before_mm;r.travel.after_mm=r.travel.before_mm;
 for(const p of r.pens)p.path_count_after=p.path_count_before;
 for(const p of r.travel.pens){p.after_cleanup_mm=p.before_mm;p.after_mm=p.before_mm;p.pass_weighted_after_mm=p.pass_weighted_before_mm}
}else{fs.copyFileSync(${JSON.stringify(join(fixtureDir, 'cleanup-prepared.svg'))},'prepared.svg');r.prepared.path='prepared.svg'}
fs.writeFileSync(mode+'.json',JSON.stringify(r));
`);
  await chmod(script, 0o700);
  return script;
}

let temporary: string;
let entry: string;
let helper: string;
let pins: string;
let server: SketchServer;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(new URL(path, server.url), {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const get = (path: string) => fetch(new URL(path, server.url));

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'sketch-preparation-'));
  await mkdir(join(temporary, 'source'));
  helper = join(temporary, 'shared.ts');
  entry = join(temporary, 'source/sketch.ts');
  pins = join(temporary, 'pins');
  await writeFile(helper, 'export const size = 2;\n');
  await writeFile(entry, "import { size } from '../shared.ts'; export default { size };\n");
  runner.inspectSketch.mockReset().mockResolvedValue(result.metadata);
  runner.renderSketch.mockReset().mockResolvedValue(result);
});
afterEach(async () => {
  if (server) await server.close();
  await rm(temporary, { recursive: true, force: true });
  server = undefined as unknown as SketchServer;
});

it('keeps source and prepared bytes separate through preview, PNG, pin, and stubbed queue upload', async () => {
  const calls: Array<{ url: string; body: BodyInit | null }> = [];
  const fakeFetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), body: options?.body ?? null });
    const id = String(url).endsWith('/print-queue') ? JSON.parse(options!.body as string).id : 'image';
    return new Response(JSON.stringify({ ok: true, id }), { status: 201 });
  }) as unknown as typeof fetch;
  server = await startSketchServer({ entry, outputDir: pins, plotprepExecutable: await stubBinary(temporary),
    plotterUpload: { baseUrl: 'https://queue.example', token: 'stub-token', fetchImpl: fakeFetch } });
  const renderResponse = await post('/api/render', { requestId: 1 });
  expect(renderResponse.status).toBe(200);
  const preparedResponse = await post('/api/preparation', { identity: result.identity,
    operations: { sort: true, allowReverse: false, mergeToleranceMm: 1.1, mergeScope: 'named-parts' } });
  expect(preparedResponse.status).toBe(200);
  const { preparation } = await preparedResponse.json();
  expect(preparation.sourceIdentity).toBe(result.identity);
  expect(preparation.sourceReport.geometry.normalized.paths).toBe(2);
  expect(preparation.report.geometry.output.paths).toBe(1);
  const selection = `identity=${result.identity}&artifact=prepared&preparedKey=${preparation.key}`;
  expect(Buffer.from(await (await get(`/api/preparation.svg?identity=${result.identity}&preparedKey=${preparation.key}`)).arrayBuffer())).toEqual(preparedSvg);
  expect(await (await get(`/api/export.svg?identity=${result.identity}`)).text()).toBe(sourceSvg);
  expect(Buffer.from(await (await get(`/api/export.svg?${selection}`)).arrayBuffer())).toEqual(preparedSvg);
  const png = PNG.sync.read(Buffer.from(await (await get(`/api/export.png?${selection}&theme=paper&scale=6`)).arrayBuffer()));
  expect([png.width, png.height]).toEqual([180, 120]);
  const gap = (60 * png.width + 63) * 4;
  expect(PNG.sync.read(renderSvgPng(sourceSvg, result.metadata.page, 'paper', 6)).data[gap]).toBe(255);
  expect(png.data[gap]).toBe(0);

  const pinResponse = await post('/api/pins', { identity: result.identity, artifact: 'prepared', preparedKey: preparation.key });
  expect(pinResponse.status).toBe(201);
  const { pinId } = await pinResponse.json();
  expect((await readdir(join(pins, pinId))).sort()).toEqual(['art.svg', 'preparation.json', 'prepared.svg', 'preview.png', 'result.json']);
  expect(await readFile(join(pins, pinId, 'art.svg'), 'utf8')).toBe(sourceSvg);
  expect(await readFile(join(pins, pinId, 'prepared.svg'))).toEqual(preparedSvg);
  const stored = JSON.parse(await readFile(join(pins, pinId, 'result.json'), 'utf8'));
  expect(stored.result.identity).toBe(result.identity);
  expect(stored.result.svg).toBe(sourceSvg);
  expect(stored.preparation.preparedSha256).toBe(preparation.preparedSha256);
  const listed = await (await get('/api/pins')).json();
  expect(listed[0].stats.pathCount).toBe(1);
  expect(listed[0].canonicalStats.pathCount).toBe(2);
  expect(Buffer.from(await (await get(`/api/pins/${pinId}/svg`)).arrayBuffer())).toEqual(preparedSvg);

  const origin = new URL(server.url).origin;
  const uploadResponse = await post('/api/plugins/plotter-upload', { identity: result.identity, artifact: 'prepared', preparedKey: preparation.key },
    { origin, 'x-sketch-action': 'plotter-upload' });
  expect(uploadResponse.status).toBe(201);
  expect(calls).toHaveLength(4);
  const queued = JSON.parse(calls[3].body as string);
  expect(queued.id).toMatch(/^hatch3d-prepared-[0-9a-f]{64}$/);
  const config = JSON.parse(queued.config);
  expect(config.identity).toBe(result.identity);
  expect(config.preparation).toEqual({ schema_version: 1, source_svg_key: `plotter/${queued.id}-source.svg`,
    source_sha256: preparation.sourceSha256, prepared_sha256: preparation.preparedSha256 });
  expect(config.stats.pathCount).toBe(1);
  expect(new TextDecoder().decode(calls[0].body as Uint8Array)).toBe(sourceSvg);
  expect(Buffer.from(calls[1].body as Uint8Array)).toEqual(preparedSvg);
  expect(PNG.sync.read(Buffer.from(calls[2].body as Uint8Array)).data[gap]).toBe(0);
  expect(preparedQueueId(result, { sourceSha256: preparation.sourceSha256, preparedSha256: preparation.preparedSha256 } as never)).toBe(queued.id);

  await writeFile(join(pins, pinId, 'prepared.svg'), '<svg/>');
  expect(await (await get('/api/pins')).json()).toEqual([]);
  expect((await get(`/api/pins/${pinId}/svg`)).status).toBe(400);
});

it('invalidates a prepared derivative when an imported helper changes without a new render', async () => {
  const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: 'unexpected' }), { status: 201 })) as unknown as typeof fetch;
  server = await startSketchServer({ entry, outputDir: pins, plotprepExecutable: await stubBinary(temporary),
    plotterUpload: { baseUrl: 'https://queue.example', token: 'stub-token', fetchImpl: fakeFetch } });
  await new Promise(resolve => setTimeout(resolve, 180));
  const initial = await post('/api/render', { requestId: 1 });
  expect(initial.status, await initial.text()).toBe(200);
  const preparedResponse = await post('/api/preparation', { identity: result.identity,
    operations: { sort: true, allowReverse: false, mergeToleranceMm: 1.1, mergeScope: 'named-parts' } });
  expect(preparedResponse.status).toBe(200);
  const { preparation } = await preparedResponse.json();
  await writeFile(helper, 'export const size = 5;\n');
  expect((await get(`/api/export.svg?identity=${result.identity}&artifact=prepared&preparedKey=${preparation.key}`)).status).toBe(409);
  expect((await post('/api/pins', { identity: result.identity, artifact: 'prepared', preparedKey: preparation.key })).status).toBe(409);
  expect((await post('/api/plugins/plotter-upload', { identity: result.identity, artifact: 'prepared', preparedKey: preparation.key },
    { origin: new URL(server.url).origin, 'x-sketch-action': 'plotter-upload' })).status).toBe(409);
  expect(fakeFetch).not.toHaveBeenCalled();
});

it('rejects a late native result after a newer render and keeps the source selected', async () => {
  server = await startSketchServer({ entry, outputDir: pins, plotprepExecutable: await stubBinary(temporary, true) });
  expect((await post('/api/render', { requestId: 1 })).status).toBe(200);
  const pending = post('/api/preparation', { identity: result.identity,
    operations: { sort: true, allowReverse: false, mergeToleranceMm: 1.1, mergeScope: 'named-parts' } });
  await new Promise(resolve => setTimeout(resolve, 120));
  runner.renderSketch.mockResolvedValue({ ...result, identity: 'newer' });
  const newer = await post('/api/render', { requestId: 2 });
  expect(newer.status, await newer.clone().text()).toBe(200);
  expect((await pending).status).toBe(409);
  expect((await get('/api/export.svg?identity=newer')).status).toBe(200);
  expect((await get('/api/export.svg?identity=newer&artifact=prepared&preparedKey=' + 'a'.repeat(64))).status).toBe(400);
});

it('keeps native preparation disabled until explicitly opted in and reports missing engines clearly', async () => {
  server = await startSketchServer({ entry, outputDir: pins });
  expect((await get('/api/finishing-options')).status).toBe(200);
  expect((await (await get('/api/finishing-options')).json()).preparationEnabled).toBe(false);
  expect((await post('/api/preparation', { identity: result.identity, operations: {} })).status).toBe(404);
  await server.close();
  server = await startSketchServer({ entry, outputDir: pins, plotprepExecutable: join(temporary, 'missing-plotprep') });
  expect((await post('/api/render', { requestId: 1 })).status).toBe(200);
  const response = await post('/api/preparation', { identity: result.identity, operations: {} });
  expect(response.status).toBe(503);
  expect((await response.json()).error).toMatch(/Native plotprep unavailable.*--plotprep/);
});

it('tracks a bare imported package’s bytes and package manifest', async () => {
  const packageRoot = join(temporary, 'node_modules/helper');
  await mkdir(packageRoot, { recursive: true });
  const manifest = join(packageRoot, 'package.json');
  const implementation = join(packageRoot, 'index.js');
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(manifest, JSON.stringify({ name: 'helper', type: 'module', exports: './index.js' }));
  await writeFile(implementation, 'export const value=1;\n');
  await writeFile(entry, "import { value } from 'helper'; export default { value };\n");
  const first = await sourceStamp(entry, {});
  await writeFile(implementation, 'export const value=5;\n');
  const second = await sourceStamp(entry, {});
  expect(second).not.toBe(first);
  await writeFile(manifest, JSON.stringify({ name: 'helper', type: 'module', exports: './index.js', custom: 'changed' }));
  expect(await sourceStamp(entry, {})).not.toBe(second);
});

it('follows the Node runtime branch when a package also offers a bundler condition', async () => {
  const packageRoot = join(temporary, 'node_modules/helper');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'helper', type: 'module',
    exports: { module: './bundler.js', default: './runtime.js' } }));
  await writeFile(join(packageRoot, 'bundler.js'), 'export const value=42;\n');
  const runtime = join(packageRoot, 'runtime.js');
  await writeFile(runtime, 'export const value=1;\n');
  await writeFile(entry, "import { value } from 'helper'; export default { value };\n");
  const first = await sourceStamp(entry, {});
  await writeFile(runtime, 'export const value=5;\n');
  expect(await sourceStamp(entry, {})).not.toBe(first);
});

it('accepts native millimeter rounding and semantic short hex for the canonical plan', async () => {
  const binary = await stubBinary(temporary);
  const fractional = { ...result, metadata: { ...result.metadata, page: { ...result.metadata.page, width: 30.0004, height: 20.0004 },
    pens: [{ id: 'ink', color: '#000', width: 0.3004, passes: 1 }] } };
  const prepared = await prepareRender(fractional, binary, { sort: true, allowReverse: false, mergeToleranceMm: 1.1, mergeScope: 'named-parts' });
  expect(prepared.report.geometry.output.paths).toBe(1);
});
