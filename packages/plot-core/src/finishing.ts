import { filterByProjectedDensityIndices } from './density.js';
import { clipPolylineToRect, type Rect } from './clip.js';
import { DOUBLE_BORDER_INSET, generateBorderPolylines } from './page-finishing.js';
import type { AssetMetadata, Box, FinishingOptions, Page, Part, Pen, Point } from './types.js';

const MAX_PAGE_MM = 10_000;
const MAX_DENSITY_CELLS = 2_000_000;
const MAX_DENSITY_SAMPLES = 5_000_000;
const MAX_PASSES = 100;
const BORDER_ID = 'finishing-border';
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function onlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) assert(allowed.includes(key), `Unknown ${label} key: ${key}`);
}
function checkPage(page: Page, label: string): void {
  assert(finite(page.width) && page.width > 0 && page.width <= MAX_PAGE_MM && finite(page.height) && page.height > 0 && page.height <= MAX_PAGE_MM, `${label} width and height must be positive finite millimeters at most ${MAX_PAGE_MM}`);
  assert(Math.round(page.width * 1000) > 0 && Math.round(page.height * 1000) > 0, `${label} dimensions must survive millimeter quantization`);
  assert(page.margin === undefined || (finite(page.margin) && page.margin >= 0 && page.margin * 2 < Math.min(page.width, page.height)), `${label} margin must fit the page`);
  assert(page.paper === undefined || (typeof page.paper === 'string' && page.paper.trim().length > 0), `${label} paper must be a color string`);
}
function checkPasses(value: unknown, label: string): asserts value is number {
  assert(Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PASSES, `${label} passes must be an integer from 1 to ${MAX_PASSES}`);
}

export interface ResolvedFinishing {
  options: FinishingOptions;
  sourcePage: Page;
  page: Page;
  pens: Pen[];
  border?: FinishingOptions['border'];
  density?: FinishingOptions['density'];
  scale: number;
  offsetX: number;
  offsetY: number;
  sourceRect: Rect;
  contentRect: Rect;
}

/** Validate and resolve physical finishing. Call after sketch schema validation, before draw(). */
export function resolveFinishing(sourcePage: Page, sourcePens: Pen[], input: unknown): ResolvedFinishing {
  assert(object(input), 'Finishing must be an object');
  onlyKeys(input, ['page', 'border', 'pens', 'density'], 'finishing');
  checkPage(sourcePage, 'Source page');
  const options = input as FinishingOptions;
  let page: Page = { ...sourcePage };
  if (input.page !== undefined) {
    assert(object(input.page), 'Finishing page must be an object');
    onlyKeys(input.page, ['width', 'height', 'margin', 'paper'], 'finishing page');
    assert(input.page.width !== undefined && input.page.height !== undefined, 'Finishing page needs width and height');
    page = {
      ...sourcePage,
      width: input.page.width as number,
      height: input.page.height as number,
      ...(input.page.margin === undefined ? {} : { margin: input.page.margin as number }),
      ...(input.page.paper === undefined ? {} : { paper: input.page.paper as string }),
    };
  }
  checkPage(page, 'Finishing page');
  let border: FinishingOptions['border'];
  if (input.border !== undefined) {
    assert(object(input.border), 'Finishing border must be an object');
    onlyKeys(input.border, ['style', 'pen', 'inset', 'contentGap'], 'finishing border');
    assert(typeof input.border.style === 'string' && ['simple', 'double', 'ticked', 'cropmarks'].includes(input.border.style), 'Unknown finishing border style');
    const borderPen = input.border.pen;
    assert(typeof borderPen === 'string' && sourcePens.some((p) => p.id === borderPen), 'Finishing border pen must reference a declared pen');
    assert(input.border.inset === undefined || (finite(input.border.inset) && input.border.inset >= 0), 'Finishing border inset must be nonnegative finite millimeters');
    assert(input.border.contentGap === undefined || (finite(input.border.contentGap) && input.border.contentGap >= 0), 'Finishing border contentGap must be nonnegative finite millimeters');
    assert(!sourcePens.some((p) => p.id === BORDER_ID), `Border pen id collision: ${BORDER_ID}`);
    border = input.border as NonNullable<FinishingOptions['border']>;
  }
  assert(input.pens === undefined || object(input.pens), 'Finishing pens must be an object');
  const penOverrides = (input.pens ?? {}) as Record<string, unknown>;
  for (const [id, value] of Object.entries(penOverrides)) {
    assert(sourcePens.some((p) => p.id === id), `Unknown finishing pen: ${id}`);
    assert(object(value), `Finishing pen ${id} must be an object`);
    onlyKeys(value, ['color', 'width', 'passes'], `finishing pen ${id}`);
    if (value.color !== undefined) assert(typeof value.color === 'string' && value.color.trim().length > 0, `Finishing pen ${id} color must be nonempty`);
    if (value.width !== undefined) assert(finite(value.width) && Math.round(value.width * 1000) > 0 && value.width <= MAX_PAGE_MM, `Finishing pen ${id} width must be positive finite millimeters`);
    if (value.passes !== undefined) checkPasses(value.passes, `Finishing pen ${id}`);
  }
  const pens = sourcePens.map((pen) => {
    const overrides = penOverrides[pen.id] as Record<string, unknown> | undefined;
    return {
      ...pen,
      ...(overrides?.color === undefined ? {} : { color: overrides.color as string }),
      ...(overrides?.width === undefined ? {} : { width: overrides.width as number }),
      ...(overrides?.passes === undefined ? {} : { passes: overrides.passes as number }),
    };
  });
  if (border) pens.push({ ...pens.find((p) => p.id === border.pen)!, id: BORDER_ID });
  let density: FinishingOptions['density'];
  if (input.density !== undefined) {
    assert(object(input.density), 'Finishing density must be an object');
    onlyKeys(input.density, ['maxDensity', 'cellSize'], 'finishing density');
    assert(finite(input.density.maxDensity) && input.density.maxDensity > 0, 'Finishing maxDensity must be positive and finite');
    assert(finite(input.density.cellSize) && input.density.cellSize > 0, 'Finishing cellSize must be positive finite millimeters');
    const cols = Math.ceil(page.width / input.density.cellSize);
    const rows = Math.ceil(page.height / input.density.cellSize);
    assert(Number.isSafeInteger(cols * rows) && cols * rows <= MAX_DENSITY_CELLS, `Finishing density grid exceeds ${MAX_DENSITY_CELLS} cells`);
    density = input.density as NonNullable<FinishingOptions['density']>;
  }
  const sourceMargin = sourcePage.margin ?? 0;
  const margin = page.margin ?? 0;
  const legacyInnerInset = border?.style === 'double' ? DOUBLE_BORDER_INSET : 0;
  const explicitBorderSpacing = border !== undefined && (border.inset !== undefined || border.contentGap !== undefined);
  let borderInset = margin;
  let contentInset = margin + legacyInnerInset;
  if (explicitBorderSpacing && border) {
    borderInset = border.inset ?? margin;
    const borderWidth = pens.find(pen => pen.id === BORDER_ID)!.width;
    const contentWidth = Math.max(...pens.filter(pen => pen.id !== BORDER_ID).map(pen => pen.width));
    const outsideReach = border.style === 'cropmarks' ? 10 : border.style === 'ticked' ? 2 : 0;
    assert(borderInset >= outsideReach + borderWidth / 2, 'Finishing border inset cannot contain the full border stroke on the paper');
    contentInset = borderInset + legacyInnerInset + (border.contentGap ?? 0) + (borderWidth + contentWidth) / 2;
  }
  assert(2 * contentInset < Math.min(page.width, page.height), explicitBorderSpacing
    ? 'Finishing border and content gap leave no printable content area'
    : 'Double border leaves no printable content area');
  const sourceW = sourcePage.width - 2 * sourceMargin;
  const sourceH = sourcePage.height - 2 * sourceMargin;
  const targetMargin = explicitBorderSpacing ? contentInset : margin;
  const targetW = page.width - 2 * targetMargin;
  const targetH = page.height - 2 * targetMargin;
  const scale = Math.min(targetW / sourceW, targetH / sourceH);
  assert(finite(scale) && scale > 0, 'Finishing page fit is invalid');
  const offsetX = targetMargin + (targetW - sourceW * scale) / 2 - sourceMargin * scale;
  const offsetY = targetMargin + (targetH - sourceH * scale) / 2 - sourceMargin * scale;
  return {
    options, sourcePage: { ...sourcePage }, page, pens, border, density, scale, offsetX, offsetY,
    sourceRect: { xMin: sourceMargin, yMin: sourceMargin, xMax: sourcePage.width - sourceMargin, yMax: sourcePage.height - sourceMargin },
    contentRect: { xMin: contentInset, yMin: contentInset, xMax: page.width - contentInset, yMax: page.height - contentInset },
  };
}

export const quantizeMm = (n: number): number => Math.round(n * 1000) / 1000;
export function mapFinishingPoint(point: Point, finishing: ResolvedFinishing): Point {
  return { x: point.x * finishing.scale + finishing.offsetX, y: point.y * finishing.scale + finishing.offsetY };
}
export function mapFinishingBox(box: Box, finishing: ResolvedFinishing): Box {
  const corner = mapFinishingPoint(box, finishing);
  return { x: quantizeMm(corner.x), y: quantizeMm(corner.y), width: quantizeMm(box.width * finishing.scale), height: quantizeMm(box.height * finishing.scale) };
}
/** Only display metadata moves. Raster assets passed to draw() keep authored sampling coordinates. */
export function mapFinishingAssetMetadata(assets: Record<string, AssetMetadata>, finishing: ResolvedFinishing): Record<string, AssetMetadata> {
  return Object.fromEntries(Object.entries(assets).map(([id, asset]) => [id, { ...asset, box: mapFinishingBox(asset.box, finishing) }]));
}

function cleanPaths(paths: Point[][], label: string): Point[][] {
  const result = paths.map((path) => path.map((p) => ({ x: quantizeMm(p.x), y: quantizeMm(p.y) })))
    .filter((path) => path.some((p, i) => i > 0 && (p.x !== path[i - 1].x || p.y !== path[i - 1].y)));
  for (const path of result) for (const point of path) assert(finite(point.x) && finite(point.y), `${label} overflowed while finishing`);
  return result;
}

/** Points for density analysis only: visit each grid cell crossed by a segment. */
function densitySamples(path: Point[], cellSize: number, budget: { used: number }): Point[] {
  const samples: Point[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]; const b = path[i];
    const dx = b.x - a.x; const dy = b.y - a.y;
    const crossings: number[] = [0, 1];
    const addCrossings = (start: number, delta: number) => {
      if (delta === 0) return;
      const low = Math.floor(Math.min(start, start + delta) / cellSize) + 1;
      const high = Math.ceil(Math.max(start, start + delta) / cellSize) - 1;
      assert(high - low + 1 + budget.used <= MAX_DENSITY_SAMPLES, `Finishing density traversal exceeds ${MAX_DENSITY_SAMPLES} samples`);
      for (let line = low; line <= high; line++) crossings.push((line * cellSize - start) / delta);
    };
    addCrossings(a.x, dx);
    addCrossings(a.y, dy);
    crossings.sort((x, y) => x - y);
    budget.used += crossings.length;
    assert(budget.used <= MAX_DENSITY_SAMPLES, `Finishing density traversal exceeds ${MAX_DENSITY_SAMPLES} samples`);
    for (let j = 1; j < crossings.length; j++) {
      const t = (crossings[j - 1] + crossings[j]) / 2;
      samples.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    }
    samples.push(b);
  }
  return samples;
}

/** Transform validated raw parts, crop content, filter globally, and append a real border layer. */
export function applyFinishing(rawParts: Part[], finishing: ResolvedFinishing, seed: number): Part[] {
  if (finishing.border) assert(!rawParts.some((part) => part.id === BORDER_ID), `Border part id collision: ${BORDER_ID}`);
  const parts = rawParts.map((part) => {
    const paths = cleanPaths(part.paths.flatMap((path) => clipPolylineToRect(path, finishing.sourceRect))
      .map((path) => path.map((point) => mapFinishingPoint(point, finishing)))
      .flatMap((path) => clipPolylineToRect(path, finishing.contentRect)), `Part ${part.id}`);
    const boundary = part.boundary?.map((ring) => ring.map((p) => mapFinishingPoint(p, finishing)).map((p) => ({ x: quantizeMm(p.x), y: quantizeMm(p.y) })));
    if (boundary) for (const ring of boundary) for (const p of ring) assert(finite(p.x) && finite(p.y), `Boundary ${part.id} overflowed while finishing`);
    return { ...part, paths, ...(boundary === undefined ? {} : { boundary }) };
  });
  if (finishing.density) {
    const refs: { part: number; path: number }[] = [];
    const analysis: Point[][] = [];
    const budget = { used: 0 };
    for (let part = 0; part < parts.length; part++) {
      if (parts[part].diagnostic) continue;
      for (let path = 0; path < parts[part].paths.length; path++) {
        refs.push({ part, path });
        analysis.push(densitySamples(parts[part].paths[path], finishing.density.cellSize, budget));
      }
    }
    assert(analysis.length <= 65_535, 'Finishing density supports at most 65535 content paths');
    const indices = filterByProjectedDensityIndices(analysis, { ...finishing.density, width: finishing.page.width, height: finishing.page.height, seed });
    const keep = new Set(indices.map((i) => `${refs[i].part}:${refs[i].path}`));
    for (let part = 0; part < parts.length; part++) {
      if (!parts[part].diagnostic) parts[part].paths = parts[part].paths.filter((_path, path) => keep.has(`${part}:${path}`));
    }
  }
  if (finishing.border) {
    const sheet: Rect = { xMin: 0, yMin: 0, xMax: finishing.page.width, yMax: finishing.page.height };
    const paths = cleanPaths(generateBorderPolylines(finishing.border.style, finishing.page.width, finishing.page.height, finishing.border.inset ?? finishing.page.margin ?? 0)
      .flatMap((path) => clipPolylineToRect(path, sheet)), 'Finishing border');
    parts.push({ id: BORDER_ID, pen: BORDER_ID, paths });
  }
  return parts;
}
