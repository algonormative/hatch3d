import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { mapFinishingAssetMetadata, resolveFinishing, validateSketch, resolveParams, finalParts, svgFor, publishRenderTarget, renderTargetAdopted, targetPage } from '../../packages/plot-core/src/index.ts';
import type { RenderTarget } from '../../packages/plot-core/src/index.ts';
import { loadRasterAssets } from './raster.ts';
import { resolveMacroParams } from '../../packages/plot-core/src/index.ts';
import type { Diagnostic, FinishingOptions, FormatOptions, Params, RenderResult, SketchMetadata } from '../../src/sketch/types.ts';

/** `withholdTarget`: render without publishing the target (the retry for a sketch that is not page-aware). */
type Request = { mode: 'inspect' | 'render'; entry: string; params?: Params; seed?: number; finishing?: FinishingOptions; format?: FormatOptions; withholdTarget?: boolean };
type Reply = { ok: true; value: SketchMetadata | RenderResult } | { ok: false; error: { name: string; message: string } };

/** The sketch is not page-aware, but modules it loaded adopted the published target. */
class WithholdTarget extends Error {}
function randomStream(seed: number, partId: string): () => number {
  const digest = createHash('sha256').update(`${seed}\0${partId}`).digest();
  let state = digest.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const quantize = (n: number): number => Math.round(n * 1000) / 1000;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function checkFormat(format: unknown): asserts format is FormatOptions | undefined {
  if (format === undefined) return;
  assert(object(format) && Object.keys(format).length <= 32, 'Format options must be an object of at most 32 entries');
  for (const [key, value] of Object.entries(format)) {
    assert(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key), `Invalid format option name: ${key}`);
    assert(typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 256), `Format option ${key} must be a boolean, finite number or short string`);
  }
}

/** What the module graph may read while it loads: the requested page (when it is well formed) and format options. */
function targetOf(request: Request): RenderTarget | undefined {
  if (request.mode !== 'render' || request.withholdTarget) return undefined;
  const page = request.finishing?.page;
  const target: RenderTarget = {
    ...(object(page) && positive(page.width) && positive(page.height) ? { page: structuredClone(page) } : {}),
    ...(request.format ? { format: request.format } : {}),
  };
  return target.page || target.format ? target : undefined;
}

async function execute(request: Request): Promise<SketchMetadata | RenderResult> {
  const started = performance.now();
  const entry = resolve(request.entry);
  checkFormat(request.format);
  // Published before the import, so modules that lay themselves out on load see the page (see render-target.ts).
  const published = targetOf(request);
  if (published) publishRenderTarget(published);
  const imported = await import(pathToFileURL(entry).href);
  const sketch = validateSketch(imported.default);
  if (!sketch.pageAware && renderTargetAdopted()) throw new WithholdTarget(`${sketch.name} is not page-aware, but modules it loads shaped themselves to the requested page`);
  // A page-aware sketch draws on the requested page, and its finishing resolves against that page, so the page
  // itself adds no rescale. Any other sketch draws on its declared page and finishing fits it onto the request.
  let finishing = request.mode === 'render' && request.finishing !== undefined ? resolveFinishing(sketch.page, sketch.pens, request.finishing) : undefined;
  const page = sketch.pageAware && finishing && request.finishing?.page ? targetPage(sketch.page, request.finishing.page) : sketch.page;
  if (finishing && page !== sketch.page) finishing = resolveFinishing(page, sketch.pens, request.finishing);
  const { assets, metadata: assetMetadata } = await loadRasterAssets(entry, sketch.assets ?? {}, sketch.page.paper);
  const metadata: SketchMetadata = { name: sketch.name, page: { ...sketch.page }, pens: sketch.pens.map((p) => ({ ...p })), controls: sketch.controls.map((c) => ({ ...c, ...(c.showWhen ? { showWhen: { ...c.showWhen } } : {}), ...(c.type === 'select' ? { options: [...c.options], ...(c.optionLabels ? { optionLabels: { ...c.optionLabels } } : {}) } : {}) })), assets: assetMetadata, ...(sketch.navigators === undefined ? {} : { navigators: sketch.navigators.map(navigator => structuredClone(navigator)) }), ...(sketch.macros === undefined ? {} : { macros: sketch.macros.map(macro => ({ ...macro, targets: macro.targets.map(target => ({ ...target })) })) }) };
  if (request.mode === 'inspect') return metadata;
  if (finishing) {
    metadata.page = { ...finishing.page };
    if (request.finishing?.page) metadata.sourcePage = { ...sketch.page };
    metadata.pens = finishing.pens;
    metadata.assets = mapFinishingAssetMetadata(assetMetadata, finishing);
  }
  const params = resolveParams(sketch.controls, request.params);
  const effectiveParams = sketch.macros?.length ? resolveMacroParams(sketch.controls, params, sketch.macros) : undefined;
  const seed = request.seed ?? 0;
  assert(Number.isSafeInteger(seed) && seed >= 0, 'Seed must be a nonnegative safe integer');
  const parts = finalParts(await sketch.draw({ params: effectiveParams ?? params, seed, assets, page: { ...page }, random: (id: string) => { assert(nonempty(id), 'Random stream id must be nonempty'); return randomStream(seed, id); } }), sketch, finishing, seed);
  const svg = svgFor(metadata, parts);
  let pathCount = 0; let pointCount = 0; let lengthMm = 0;
  for (const part of parts) if (!part.diagnostic) for (const path of part.paths) {
    pathCount++; pointCount += path.length;
    for (let i = 1; i < path.length; i++) lengthMm += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  const diagnostics: Diagnostic[] = [];
  if (pathCount > 100_000) diagnostics.push({ level: 'warning', code: 'many_paths', message: `${pathCount} paths may be expensive to plot` });
  const format = request.format;
  const identity = createHash('sha256').update(JSON.stringify({ metadata, params, ...(effectiveParams ? { effectiveParams } : {}), seed, parts, svg, ...(finishing ? { finishing: request.finishing } : {}), ...(format ? { format } : {}) })).digest('hex');
  return { schemaVersion: 1, metadata, ...(finishing ? { finishing: request.finishing } : {}), ...(format ? { format } : {}), params, ...(effectiveParams ? { effectiveParams } : {}), seed, parts, svg, identity, diagnostics, stats: { pathCount, pointCount, lengthMm: quantize(lengthMm), partCount: parts.filter((part) => !part.diagnostic).length }, durationMs: quantize(performance.now() - started) };
}

/**
 * Render in a fresh process with nothing published. Module state cannot be unloaded, so a sketch that is not
 * page-aware, but whose modules shaped themselves to the requested page, is drawn again by a child of this
 * process: it keeps its declared page and finishing fits it onto the request, exactly as before.
 */
function withoutTarget(request: Request): Promise<Reply> {
  const child = fork(fileURLToPath(import.meta.url), [], { execArgv: process.execArgv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  return new Promise<Reply>((done) => {
    const fail = (message: string) => done({ ok: false, error: { name: 'Error', message } });
    child.once('message', (reply: Reply) => done(reply));
    child.once('error', (error) => fail(error.message));
    child.once('exit', (code, signal) => fail(`Render process exited (${signal ?? code})`));
    child.send({ ...request, withholdTarget: true }, (error) => { if (error) fail(error.message); });
  }).finally(() => child.kill('SIGKILL'));
}

const replyFor = (error: unknown): Reply => ({ ok: false, error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } });

process.on('message', (message: Request) => {
  void execute(message).then((value): Reply | Promise<Reply> => ({ ok: true, value }),
    (error: unknown) => error instanceof WithholdTarget && !message.withholdTarget ? withoutTarget(message) : replyFor(error))
    .then((reply) => process.send?.(reply));
});
