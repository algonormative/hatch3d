import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { mapFinishingAssetMetadata, resolveFinishing } from '../../src/sketch/finishing.ts';
import { validateSketch, resolveParams, finalParts } from '../../packages/plot-core/src/validation.ts';
import { svgFor } from '../../packages/plot-core/src/svg.ts';
import { loadRasterAssets } from './raster.ts';
import { resolveMacroParams } from '../../src/sketch/control-values.js';
import type { Diagnostic, FinishingOptions, Params, RenderResult, SketchMetadata } from '../../src/sketch/types.ts';

type Request = { mode: 'inspect' | 'render'; entry: string; params?: Params; seed?: number; finishing?: FinishingOptions };
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

async function execute(request: Request): Promise<SketchMetadata | RenderResult> {
  const started = performance.now();
  const entry = resolve(request.entry);
  const imported = await import(pathToFileURL(entry).href);
  const sketch = validateSketch(imported.default);
  const finishing = request.mode === 'render' && request.finishing !== undefined ? resolveFinishing(sketch.page, sketch.pens, request.finishing) : undefined;
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
  const parts = finalParts(await sketch.draw({ params: effectiveParams ?? params, seed, assets, random: (id: string) => { assert(nonempty(id), 'Random stream id must be nonempty'); return randomStream(seed, id); } }), sketch, finishing, seed);
  const svg = svgFor(metadata, parts);
  let pathCount = 0; let pointCount = 0; let lengthMm = 0;
  for (const part of parts) if (!part.diagnostic) for (const path of part.paths) {
    pathCount++; pointCount += path.length;
    for (let i = 1; i < path.length; i++) lengthMm += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  const diagnostics: Diagnostic[] = [];
  if (pathCount > 100_000) diagnostics.push({ level: 'warning', code: 'many_paths', message: `${pathCount} paths may be expensive to plot` });
  const identity = createHash('sha256').update(JSON.stringify({ metadata, params, ...(effectiveParams ? { effectiveParams } : {}), seed, parts, svg, ...(finishing ? { finishing: request.finishing } : {}) })).digest('hex');
  return { schemaVersion: 1, metadata, ...(finishing ? { finishing: request.finishing } : {}), params, ...(effectiveParams ? { effectiveParams } : {}), seed, parts, svg, identity, diagnostics, stats: { pathCount, pointCount, lengthMm: quantize(lengthMm), partCount: parts.filter((part) => !part.diagnostic).length }, durationMs: quantize(performance.now() - started) };
}

process.on('message', (message: Request) => {
  void execute(message).then((value) => process.send?.({ ok: true, value }), (error: unknown) => process.send?.({ ok: false, error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } }));
});
