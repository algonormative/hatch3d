import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { clipPolylineToRect } from '../../src/utils/clip.ts';
import { loadRasterAssets } from './raster.ts';
import type { AssetDeclaration, Control, Diagnostic, Page, Params, Part, Pen, Point, RenderResult, Sketch, SketchMetadata } from '../../src/sketch/types.ts';

type Request = { mode: 'inspect' | 'render'; entry: string; params?: Params; seed?: number };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

function validateSketch(value: unknown): Sketch {
  assert(object(value), 'Sketch default export must be an object');
  assert(nonempty(value.name), 'Sketch name must be nonempty');
  assert(object(value.page), 'Sketch page is required');
  const page = value.page as unknown as Page;
  assert(finite(page.width) && page.width > 0 && finite(page.height) && page.height > 0, 'Page width and height must be positive finite millimeters');
  assert(Math.round(page.width * 1000) > 0 && Math.round(page.height * 1000) > 0, 'Page dimensions must survive millimeter quantization');
  assert(page.margin === undefined || (finite(page.margin) && page.margin >= 0 && page.margin * 2 < Math.min(page.width, page.height)), 'Page margin must fit the page');
  assert(page.paper === undefined || nonempty(page.paper), 'Page paper must be a color string');
  assert(Array.isArray(value.pens) && value.pens.length > 0, 'Sketch needs at least one pen');
  const penIds = new Set<string>();
  for (const pen of value.pens as Pen[]) {
    assert(object(pen) && validId(pen.id) && nonempty(pen.color) && finite(pen.width) && Math.round(pen.width * 1000) > 0, 'Each pen needs a safe id, color, and width of at least 0.001 mm');
    assert(!penIds.has(pen.id), `Duplicate pen id: ${pen.id}`);
    penIds.add(pen.id);
  }
  assert(Array.isArray(value.controls), 'Sketch controls must be an array');
  const controlIds = new Set<string>();
  for (const control of value.controls as Control[]) {
    assert(object(control) && validId(control.id) && nonempty(control.label), 'Each control needs a safe id and label');
    assert(!controlIds.has(control.id), `Duplicate control id: ${control.id}`);
    controlIds.add(control.id);
    assert(control.units === undefined || typeof control.units === 'string', `Invalid units for ${control.id}`);
    assert(control.expensive === undefined || typeof control.expensive === 'boolean', `Invalid expensive flag for ${control.id}`);
    if (control.type === 'slider') {
      assert(finite(control.min) && finite(control.max) && finite(control.step) && control.min <= control.max && control.step > 0, `Invalid slider range: ${control.id}`);
      validateControlValue(control, control.default);
    } else if (control.type === 'toggle') {
      validateControlValue(control, control.default);
    } else if (control.type === 'select') {
      assert(Array.isArray(control.options) && control.options.length > 0 && control.options.every(nonempty) && new Set(control.options).size === control.options.length, `Invalid select options: ${control.id}`);
      validateControlValue(control, control.default);
    } else {
      throw new Error(`Unknown control type: ${String((control as { type: unknown }).type)}`);
    }
  }
  assert(value.assets === undefined || object(value.assets), 'Sketch assets must be a record');
  for (const [id, asset] of Object.entries((value.assets ?? {}) as Record<string, AssetDeclaration>)) {
    assert(validId(id) && object(asset) && nonempty(asset.path) && (asset.fit === 'contain' || asset.fit === 'cover'), `Invalid asset: ${id}`);
    assert(object(asset.box) && finite(asset.box.x) && finite(asset.box.y) && finite(asset.box.width) && finite(asset.box.height) && asset.box.width > 0 && asset.box.height > 0, `Invalid asset box: ${id}`);
  }
  assert(typeof value.draw === 'function', 'Sketch draw(ctx) must be a function');
  return value as unknown as Sketch;
}

function validateControlValue(control: Control, value: unknown): void {
  if (control.type === 'slider') {
    assert(finite(value) && value >= control.min && value <= control.max, `Invalid value for slider ${control.id}`);
    const steps = (value - control.min) / control.step;
    assert(Math.abs(steps - Math.round(steps)) < 1e-7, `Value for slider ${control.id} does not align to step`);
  } else if (control.type === 'toggle') {
    assert(typeof value === 'boolean', `Invalid value for toggle ${control.id}`);
  } else {
    assert(typeof value === 'string' && control.options.includes(value), `Invalid value for select ${control.id}`);
  }
}

function resolveParams(controls: Control[], supplied: unknown): Params {
  assert(supplied === undefined || object(supplied), 'Parameters must be a JSON object');
  const provided = supplied ?? {};
  const ids = new Set(controls.map((c) => c.id));
  for (const id of Object.keys(provided)) assert(ids.has(id), `Unknown parameter: ${id}`);
  const params: Params = {};
  for (const control of controls) {
    const value = Object.prototype.hasOwnProperty.call(provided, control.id) ? provided[control.id] : control.default;
    validateControlValue(control, value);
    params[control.id] = value as number | boolean | string;
  }
  return params;
}

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

const quantize = (n: number): number => Math.round(n * 1000) / 1000;
function validatePoints(paths: unknown, label: string, min: number): asserts paths is Point[][] {
  assert(Array.isArray(paths), `${label} must be an array of paths`);
  for (const path of paths) {
    assert(Array.isArray(path) && path.length >= min, `${label} path needs at least ${min} points`);
    for (const point of path) assert(object(point) && finite(point.x) && finite(point.y), `${label} contains a non-finite point`);
  }
}

function finalParts(raw: unknown, sketch: Sketch): Part[] {
  assert(Array.isArray(raw), 'Sketch draw(ctx) must return an array of parts');
  const ids = new Set<string>();
  const pens = new Set(sketch.pens.map((p) => p.id));
  const margin = sketch.page.margin ?? 0;
  const rect = { xMin: margin, yMin: margin, xMax: sketch.page.width - margin, yMax: sketch.page.height - margin };
  return raw.map((part: Part) => {
    assert(object(part) && validId(part.id) && nonempty(part.pen) && pens.has(part.pen), 'Part needs a unique safe id and declared pen');
    assert(!ids.has(part.id), `Duplicate part id: ${part.id}`); ids.add(part.id);
    assert(part.diagnostic === undefined || typeof part.diagnostic === 'boolean', `Invalid diagnostic flag for ${part.id}`);
    validatePoints(part.paths, `Part ${part.id}`, 2);
    if (part.boundary !== undefined) validatePoints(part.boundary, `Boundary of ${part.id}`, 3);
    let paths = part.paths.flatMap((path) => clipPolylineToRect(path, rect));
    paths = paths.map((path) => path.map((p) => ({ x: quantize(p.x), y: quantize(p.y) }))).filter((path) => path.some((p, i) => i > 0 && (p.x !== path[i - 1].x || p.y !== path[i - 1].y)));
    const boundary = part.boundary?.map((ring) => ring.map((p) => ({ x: quantize(p.x), y: quantize(p.y) })));
    for (const path of [...paths, ...(boundary ?? [])]) for (const point of path) assert(finite(point.x) && finite(point.y), `Part ${part.id} overflowed while clipping or quantizing`);
    return { id: part.id, pen: part.pen, paths, ...(boundary ? { boundary } : {}), ...(part.diagnostic === undefined ? {} : { diagnostic: part.diagnostic }) };
  });
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const num = (n: number): string => String(quantize(n));
function svgFor(metadata: SketchMetadata, parts: Part[]): string {
  const page = metadata.page;
  const lines = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${num(page.width)}mm" height="${num(page.height)}mm" viewBox="0 0 ${num(page.width)} ${num(page.height)}">`];
  for (const [index, pen] of metadata.pens.entries()) {
    lines.push(`<g inkscape:groupmode="layer" inkscape:label="${index + 1}-${esc(pen.id)}" data-pen-id="${esc(pen.id)}" data-passes="1" fill="none" stroke="${esc(pen.color)}" stroke-width="${num(pen.width)}" stroke-linecap="round" stroke-linejoin="round">`);
    for (const part of parts) {
      if (part.pen !== pen.id || part.diagnostic) continue;
      lines.push(`<g data-part-id="${esc(part.id)}">`);
      for (const path of part.paths) lines.push(`<path d="${path.map((p, i) => `${i ? 'L' : 'M'}${num(p.x)},${num(p.y)}`).join('')}"/>`);
      lines.push('</g>');
    }
    lines.push('</g>');
  }
  lines.push('</svg>');
  return lines.join('\n');
}

async function execute(request: Request): Promise<SketchMetadata | RenderResult> {
  const started = performance.now();
  const entry = resolve(request.entry);
  const imported = await import(pathToFileURL(entry).href);
  const sketch = validateSketch(imported.default);
  const { assets, metadata: assetMetadata } = await loadRasterAssets(entry, sketch.assets ?? {}, sketch.page.paper);
  const metadata: SketchMetadata = { name: sketch.name, page: { ...sketch.page }, pens: sketch.pens.map((p) => ({ ...p })), controls: sketch.controls.map((c) => ({ ...c, ...(c.type === 'select' ? { options: [...c.options] } : {}) })), assets: assetMetadata };
  if (request.mode === 'inspect') return metadata;
  const params = resolveParams(sketch.controls, request.params);
  const seed = request.seed ?? 0;
  assert(Number.isSafeInteger(seed) && seed >= 0, 'Seed must be a nonnegative safe integer');
  const parts = finalParts(await sketch.draw({ params, seed, assets, random: (id: string) => { assert(nonempty(id), 'Random stream id must be nonempty'); return randomStream(seed, id); } }), sketch);
  const svg = svgFor(metadata, parts);
  let pathCount = 0; let pointCount = 0; let lengthMm = 0;
  for (const part of parts) if (!part.diagnostic) for (const path of part.paths) {
    pathCount++; pointCount += path.length;
    for (let i = 1; i < path.length; i++) lengthMm += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  const diagnostics: Diagnostic[] = [];
  if (pathCount > 100_000) diagnostics.push({ level: 'warning', code: 'many_paths', message: `${pathCount} paths may be expensive to plot` });
  const identity = createHash('sha256').update(JSON.stringify({ metadata, params, seed, parts, svg })).digest('hex');
  return { schemaVersion: 1, metadata, params, seed, parts, svg, identity, diagnostics, stats: { pathCount, pointCount, lengthMm: quantize(lengthMm), partCount: parts.filter((part) => !part.diagnostic).length }, durationMs: quantize(performance.now() - started) };
}

process.on('message', (message: Request) => {
  void execute(message).then((value) => process.send?.({ ok: true, value }), (error: unknown) => process.send?.({ ok: false, error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } }));
});
