/**
 * Finalize a stack of sketch renders for the plotter: palette → balanced placement → vpype preparation.
 *
 *   node --import tsx cli/finalize.ts run <stack.json> [--only name,name] [--palette id] [--params '{"sloganCount":1}'] [--merge]
 *   node --import tsx cli/finalize.ts serve <stack.json> [--port 8796]
 *
 * The palette is applied through finishing (paper + pen colors), so the canonical render records it.
 * Placement moves only the artwork layers so their bounds sit centered inside the border's inner line.
 * vpype (Python, on PATH) merges, sorts, reloops and simplifies per layer; numbered layer labels,
 * pen ids and pass counts are restored onto the prepared SVG because vpype drops data-* attributes.
 * Nothing here talks to a plotter: the output is files only.
 */
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderSvgPng } from './sketch/export-png.ts';
import type { Control, Page, Pen } from '../src/sketch/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface Piece { name: string; sketch: string; seed: number; params?: Record<string, unknown>; title?: string }
export interface VpypeOptions { mergeTolerance: number; simplifyTolerance: number; minLength: number; reloop: boolean; sort: boolean }
export interface FinalizeOptions {
  palette: Palette;
  /** Center the artwork inside the border: vertical only, both axes, or leave it where the sketch put it. */
  center: 'vertical' | 'both' | 'none';
  /** Put layers that share an ink color on one layer, so the plot needs fewer pen changes. */
  mergeSameColor: boolean;
  vpype: VpypeOptions;
}
export interface Stack { title?: string; out: string; border?: Record<string, unknown>; pieces: Piece[]; defaults?: Partial<FinalizeOptions> & { palette?: string } }
/** A palette assigns inks by pen order (structure, body, interruption, event, joining, ...) plus a paper color. */
export interface Palette { id: string; label: string; paper: string; inks: string[]; note?: string }

export const PALETTES: Palette[] = [
  { id: 'phase-garden', label: 'Phase Garden', paper: '#f4f0e6', inks: ['#22282c', '#3c49aa', '#d04b3c', '#a5a938', '#776090', '#6b8491', '#a48b8c', '#a69d84'], note: 'The original five inks on warm stock.' },
  { id: 'carbon', label: 'Carbon only', paper: '#f4f0e6', inks: ['#22282c', '#22282c', '#22282c', '#22282c', '#22282c', '#22282c', '#22282c', '#22282c'], note: 'One black pen. Merge gives a single layer.' },
  { id: 'two-tone', label: 'Carbon + ultramarine', paper: '#f4f0e6', inks: ['#22282c', '#3c49aa', '#3c49aa', '#22282c', '#3c49aa', '#3c49aa', '#22282c', '#22282c'], note: 'Two pens: structure black, everything living blue.' },
  { id: 'cyanotype', label: 'Cyanotype', paper: '#f3f1ea', inks: ['#16324f', '#2f6690', '#3a7ca5', '#81c3d7', '#1f4e79', '#3a7ca5', '#81c3d7', '#2f6690'], note: 'Prussian blues, darkest for structure.' },
  { id: 'sepia', label: 'Sepia drafting', paper: '#f5efe3', inks: ['#3b2a1e', '#7a4b2a', '#b5542d', '#a88b4a', '#5d4a66', '#7a4b2a', '#b5542d', '#a88b4a'], note: 'Brown inks, rust accents.' },
  { id: 'riso', label: 'Riso brights', paper: '#f7f5ef', inks: ['#1d1d1b', '#0078bf', '#ff48b0', '#ffb511', '#00a95c', '#0078bf', '#ff48b0', '#ffb511'], note: 'Fluorescent pink and yellow accents.' },
  { id: 'night', label: 'Night stock', paper: '#17181a', inks: ['#f2f0ea', '#9fb4ff', '#ff8a70', '#e4d27a', '#c7a8f0', '#9fb4ff', '#ff8a70', '#e4d27a'], note: 'Gel pens on black paper.' },
  { id: 'blueprint', label: 'Blueprint', paper: '#1d3b6e', inks: ['#f4f4ef', '#cfe0ff', '#ffd6c9', '#f4f4ef', '#cfe0ff', '#cfe0ff', '#ffd6c9', '#f4f4ef'], note: 'White pens on blue stock.' },
];

export const DEFAULT_OPTIONS: Omit<FinalizeOptions, 'palette'> = {
  center: 'vertical', mergeSameColor: true,
  vpype: { mergeTolerance: 0.4, simplifyTolerance: 0.03, minLength: 0.3, reloop: true, sort: true },
};

const MM_PER_PX = 25.4 / 96;
const DRAW_MM_S = 60, TRAVEL_MM_S = 200, SWAP_S = 60;
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function fail(message: string): never { throw new Error(message); }

async function loadSketch(entry: string): Promise<{ page: Page; pens: Pen[]; controls: Control[] }> {
  const mod = await import(pathToFileURL(resolve(ROOT, entry)).href);
  const sketch = mod.default;
  if (!sketch?.page || !Array.isArray(sketch.pens)) fail(`${entry} does not export a sketch with page and pens`);
  return { page: sketch.page, pens: sketch.pens, controls: sketch.controls ?? [] };
}

/** Overrides may only name controls the sketch declares, so a typo can't silently do nothing. */
function withOverrides(piece: Piece, controls: Control[], overrides: Record<string, unknown>): Record<string, unknown> {
  const ids = new Set(controls.map(c => c.id));
  for (const key of Object.keys(overrides)) if (!ids.has(key)) fail(`${piece.name} has no control named ${key}`);
  return { ...piece.params, ...overrides };
}

const execFileAsync = promisify(execFile);
async function renderSource(piece: Piece, request: object, dir: string): Promise<string> {
  mkdirSync(join(dir, 'source'), { recursive: true });
  const requestPath = join(dir, 'request.json');
  writeFileSync(requestPath, JSON.stringify(request, null, 2));
  try {
    await execFileAsync(process.execPath, ['--import', 'tsx', join(ROOT, 'cli/sketch.ts'), 'render', resolve(ROOT, piece.sketch), '--config', requestPath, '--out', join(dir, 'source')],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    fail(`render failed for ${piece.name}: ${((e.stdout ?? '') + (e.stderr ?? '') || e.message).trim().slice(-400)}`);
  }
  return join(dir, 'source', 'render.svg');
}

/** Render only (no vpype), for previews: the page recolors layers itself. */
export async function previewPiece(stack: Stack, piece: Piece, palette: Palette, overrides: Record<string, unknown>, dir: string): Promise<string> {
  const { page, pens, controls } = await loadSketch(piece.sketch);
  const request = { seed: piece.seed, params: withOverrides(piece, controls, overrides), finishing: finishingFor(stack, page, pens, palette) };
  return readFileSync(await renderSource(piece, request, dir), 'utf8');
}

function finishingFor(stack: Stack, page: Page, pens: Pen[], palette: Palette) {
  return {
    ...(stack.border ? { border: stack.border } : {}),
    page: { width: page.width, height: page.height, margin: page.margin ?? 18, paper: palette.paper },
    pens: Object.fromEntries(pens.map((pen, i) => [pen.id, { color: palette.inks[i % palette.inks.length] }])),
  };
}

interface Layer { index: number; label: string; color: string; attrs: Record<string, string>; bounds: Bounds | null }
interface Bounds { x0: number; y0: number; x1: number; y1: number }

/** Read numbered layer groups and the bounds of their path coordinates (sketch SVGs use absolute M/L in mm). */
export function readLayers(svg: string): Layer[] {
  const layers: Layer[] = [];
  const parts = svg.split(/(?=<g\b[^>]*inkscape:groupmode="layer")/).slice(1);
  for (const part of parts) {
    const open = /^<g\b([^>]*)>/.exec(part)?.[1] ?? '';
    const attrs: Record<string, string> = {};
    for (const m of open.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
    const label = attrs['inkscape:label'] ?? '';
    const index = Number(/^(\d+)/.exec(label)?.[1]);
    let b: Bounds | null = null;
    for (const m of part.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) {
      const x = Number(m[1]), y = Number(m[2]);
      b = b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
    }
    layers.push({ index, label, color: attrs.stroke ?? '#000000', attrs, bounds: b });
  }
  return layers;
}

const isBorder = (l: Layer) => /finishing-border$/.test(l.label);
function union(bs: (Bounds | null)[]): Bounds | null {
  return bs.reduce<Bounds | null>((a, b) => !b ? a : !a ? { ...b } : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }, null);
}

/** Offset (mm) that centers the art bounds inside the area it may occupy. */
export function placementOffset(layers: Layer[], page: Page, stack: Stack, center: FinalizeOptions['center']): { dx: number; dy: number; art: Bounds | null; area: Bounds } {
  const art = union(layers.filter(l => !isBorder(l)).map(l => l.bounds));
  const border = stack.border as { inset?: number; contentGap?: number; style?: string } | undefined;
  // Mirrors finishing's content inset: the border's inner line plus half its 0.25 mm stroke.
  const inner = border ? (border.inset ?? 12) + (border.style === 'double' ? 2 : 0) + (border.contentGap ?? 6) + 0.25 : page.margin ?? 18;
  const area = { x0: inner, y0: inner, x1: page.width - inner, y1: page.height - inner };
  if (!art || center === 'none') return { dx: 0, dy: 0, art, area };
  const dy = (area.y0 + area.y1) / 2 - (art.y0 + art.y1) / 2;
  const dx = center === 'both' ? (area.x0 + area.x1) / 2 - (art.x0 + art.x1) / 2 : 0;
  return { dx: Math.round(dx * 1000) / 1000, dy: Math.round(dy * 1000) / 1000, art, area };
}

function vpype(args: string[]): string {
  const run = spawnSync('vpype', args, { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (run.error) fail(`vpype is not available on PATH: ${run.error.message}`);
  if (run.status !== 0) fail(`vpype failed (${run.status}): ${run.stderr.trim().split('\n').slice(-3).join(' ')}`);
  return run.stdout;
}

export interface LayerStats { layer: number; label: string; color: string; passes: number; paths: number; drawMm: number; travelMm: number; minutes: number }
export function parseStat(text: string): Omit<LayerStats, 'label' | 'color' | 'passes' | 'minutes'>[] {
  const out: Omit<LayerStats, 'label' | 'color' | 'passes' | 'minutes'>[] = [];
  for (const block of text.split(/\n(?=Layer \d+)/).slice(1)) {
    const num = (name: string) => Number(new RegExp(`${name}:\\s*([\\d.]+)`).exec(block)?.[1] ?? 0);
    out.push({ layer: Number(/^Layer (\d+)/.exec(block)![1]), paths: num('Path count'), drawMm: num('Length') * MM_PER_PX, travelMm: num('Pen-up length') * MM_PER_PX });
  }
  return out;
}

/**
 * Re-emit vpype's geometry in the sketch SVG grammar that plotter-server accepts: the canonical root tag,
 * one canonical layer tag per layer (label, pen id, passes, stroke, width), and plain <path d> in millimetres.
 * vpype writes px units, <line>/<polyline>/<polygon>, metadata and style attributes, which the server rejects.
 */
export function toSketchGrammar(vpypeSvg: string, sourceSvg: string, plan: Map<number, { label: string; penId?: string; passes: number }>): string {
  const root = /<svg\b[^>]*>/.exec(sourceSvg)?.[0] ?? fail('Source SVG has no root');
  const sourceTags = new Map<number, string>();
  for (const m of sourceSvg.matchAll(/<g\b[^>]*inkscape:groupmode="layer"[^>]*>/g)) {
    const n = Number(/inkscape:label="(\d+)-/.exec(m[0])?.[1]);
    if (Number.isFinite(n)) sourceTags.set(n, m[0]);
  }
  const mm = (v: string) => String(Math.round(Number(v) * MM_PER_PX * 1000) / 1000);
  const pairs = (points: string) => points.trim().split(/\s+/).map(pair => pair.split(',').map(mm).join(','));
  const layers: string[] = [];
  for (const part of vpypeSvg.split(/(?=<g\b[^>]*inkscape:groupmode="layer")/).slice(1)) {
    const n = Number(/id="layer(\d+)"/.exec(part)?.[1]);
    const meta = plan.get(n);
    const tag = sourceTags.get(n);
    if (!meta || !tag) fail(`Prepared layer ${n} has no source layer`);
    const body = part.slice(0, part.indexOf('</g>'));
    const paths: string[] = [];
    for (const el of body.matchAll(/<(polyline|polygon|line|path)\b([^>]*)\/?>/g)) {
      const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(el[2])?.[1] ?? '';
      let pts: string[];
      if (el[1] === 'line') pts = [`${mm(attr('x1'))},${mm(attr('y1'))}`, `${mm(attr('x2'))},${mm(attr('y2'))}`];
      else if (el[1] === 'path') fail('Unexpected <path> in vpype output; extend toSketchGrammar before using it');
      else { pts = pairs(attr('points')); if (el[1] === 'polygon') pts.push(pts[0]); }
      paths.push(`<path d="M${pts.join('L')}"/>`);
    }
    const open = tag.replace(/inkscape:label="[^"]*"/, `inkscape:label="${meta.label}"`).replace(/data-passes="[^"]*"/, `data-passes="${meta.passes}"`);
    layers.push(`${open}\n${paths.join('\n')}\n</g>`);
  }
  return `${root}\n${layers.join('\n')}\n</svg>\n`;
}

/**
 * plotter-server's sketch queue config (format hatch3d-sketch-v1), as the viewer's upload plugin writes it:
 * page and pens must match the prepared SVG's units and layers, which the server checks on import.
 */
export function serverConfig(resultPath: string, sourceSvg: string, report: PieceReport): Record<string, unknown> {
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { identity: string; metadata: { name: string; page: Page; pens: (Pen & { passes?: number })[] }; params: unknown; effectiveParams?: unknown; seed: number; finishing?: unknown };
  const partsByPen = new Map<string, string[]>();
  for (const layer of sourceSvg.split(/(?=<g\b[^>]*inkscape:groupmode="layer")/).slice(1)) {
    const pen = /data-pen-id="([^"]*)"/.exec(layer)?.[1];
    if (pen) partsByPen.set(pen, [...layer.matchAll(/data-part-id="([^"]*)"/g)].map(m => m[1]));
  }
  return {
    format: 'hatch3d-sketch-v1', identity: result.identity, composition: 'sketch', presetName: `${report.title} · seed ${report.seed}`,
    page: result.metadata.page, pens: result.metadata.pens,
    layers: result.metadata.pens.map(pen => ({ id: pen.id, color: pen.color, width: pen.width, passes: pen.passes ?? 1, parts: partsByPen.get(pen.id) ?? [] })),
    params: result.params, ...(result.effectiveParams ? { effectiveParams: result.effectiveParams } : {}), seed: result.seed,
    ...(result.finishing ? { finishing: result.finishing } : {}),
    stats: { pathCount: report.layers.reduce((t, l) => t + l.paths, 0), lengthMm: Math.round(report.layers.reduce((t, l) => t + l.drawMm, 0)) },
    preparation: { schema_version: 1, tool: 'hatch3d finalize (python vpype)', source_sha256: report.sourceSha256, prepared_sha256: report.preparedSha256 },
  };
}

export interface PieceReport {
  name: string; title: string; seed: number; palette: string; paper: string; offset: { dx: number; dy: number };
  margins: { top: number; bottom: number } | null; layers: LayerStats[]; pens: number; minutes: number;
  /** Same numbered layers, labels and passes as the canonical source, so plotter-server's pen-plan check can pass. */
  serverCompatible: boolean;
  files: { source: string; sourcePng: string; prepared: string; preparedPng: string }; sourceSha256: string; preparedSha256: string;
}

export async function finalizePiece(stack: Stack, piece: Piece, options: FinalizeOptions, overrides: Record<string, unknown> = {}): Promise<PieceReport> {
  const { page, pens, controls } = await loadSketch(piece.sketch);
  if (options.palette.inks.length < pens.length) fail(`Palette ${options.palette.id} has ${options.palette.inks.length} inks for ${pens.length} pens`);
  const dir = resolve(ROOT, stack.out, slug(piece.name));
  const request = { seed: piece.seed, params: withOverrides(piece, controls, overrides), finishing: finishingFor(stack, page, pens, options.palette) };
  const sourcePath = await renderSource(piece, request, dir);
  const source = readFileSync(sourcePath, 'utf8');
  const layers = readLayers(source);
  const finalPage: Page = { ...page, paper: options.palette.paper };
  const { dx, dy, art, area } = placementOffset(layers, finalPage, stack, options.center);

  // Merge layers that share a color into the lowest-numbered one; the border joins its ink's layer too.
  // Same ink, same pass count and same width only: merging must not change how any stroke is drawn.
  const byColor = new Map<string, Layer[]>();
  for (const l of layers) {
    const key = [l.color.toLowerCase(), l.attrs['data-passes'] ?? '1', l.attrs['stroke-width'] ?? ''].join('|');
    byColor.set(key, [...(byColor.get(key) ?? []), l]);
  }
  const moves: string[][] = [];
  const plan = new Map<number, { label: string; penId?: string; passes: number }>();
  for (const group of byColor.values()) {
    const sorted = [...group].sort((a, b) => a.index - b.index);
    const keep = sorted[0];
    const merged = options.mergeSameColor ? sorted : [keep];
    if (options.mergeSameColor && sorted.length > 1) moves.push(['lmove', sorted.slice(1).map(l => l.index).join(','), String(keep.index)]);
    const names = merged.map(l => l.label.replace(/^\d+-/, ''));
    plan.set(keep.index, { label: `${keep.index}-${names.join('+')}`, penId: keep.attrs['data-pen-id'], passes: Number(keep.attrs['data-passes'] ?? 1) });
    if (!options.mergeSameColor) for (const l of sorted.slice(1)) plan.set(l.index, { label: l.label, penId: l.attrs['data-pen-id'], passes: Number(l.attrs['data-passes'] ?? 1) });
  }
  const artLayers = layers.filter(l => !isBorder(l)).map(l => l.index).join(',');
  const preparedPath = join(dir, 'plot-ready.svg');
  const v = options.vpype;
  const args = ['read', sourcePath,
    ...(dx || dy ? ['translate', '-l', artLayers, '--', `${dx}mm`, `${dy}mm`] : []),
    ...moves.flat(),
    'linemerge', '--tolerance', `${v.mergeTolerance}mm`,
    ...(v.sort ? ['linesort'] : []),
    ...(v.reloop ? ['reloop'] : []),
    'linesimplify', '--tolerance', `${v.simplifyTolerance}mm`,
    'filter', '--min-length', `${v.minLength}mm`,
    'write', '--page-size', `${page.width}mmx${page.height}mm`, preparedPath];
  vpype(args);
  const prepared = toSketchGrammar(readFileSync(preparedPath, 'utf8'), source, plan);
  writeFileSync(preparedPath, prepared);
  const stats = parseStat(vpype(['read', preparedPath, 'stat']));
  const layerStats: LayerStats[] = stats.map(s => {
    const meta = plan.get(s.layer);
    const color = layers.find(l => l.index === s.layer)?.color ?? '#000000';
    const passes = meta?.passes ?? 1;
    return { ...s, label: meta?.label ?? `${s.layer}`, color, passes, minutes: passes * 1.1 * (s.drawMm / DRAW_MM_S + s.travelMm / TRAVEL_MM_S) / 60 };
  });
  const minutes = layerStats.reduce((t, l) => t + l.minutes, 0) + Math.max(0, layerStats.length - 1) * SWAP_S / 60;
  writeFileSync(join(dir, 'plot-ready.png'), renderSvgPng(prepared, finalPage, 'paper', 3));
  const after = art ? { y0: art.y0 + dy, y1: art.y1 + dy } : null;
  const report: PieceReport = {
    name: piece.name, title: piece.title ?? piece.name, seed: piece.seed, palette: options.palette.id, paper: options.palette.paper,
    offset: { dx, dy }, margins: after ? { top: +(after.y0 - area.y0).toFixed(2), bottom: +(area.y1 - after.y1).toFixed(2) } : null,
    layers: layerStats, pens: layerStats.length, minutes: Math.round(minutes), serverCompatible: moves.length === 0,
    files: { source: relative(ROOT, sourcePath), sourcePng: relative(ROOT, join(dir, 'source', 'render.png')), prepared: relative(ROOT, preparedPath), preparedPng: relative(ROOT, join(dir, 'plot-ready.png')) },
    sourceSha256: sha256(source), preparedSha256: sha256(prepared),
  };
  if (report.serverCompatible) writeFileSync(join(dir, 'config.json'), JSON.stringify(serverConfig(join(dir, 'source', 'result.json'), source, report), null, 2));
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ ...report, options, overrides, vpypeArgs: args.map(a => a.startsWith(ROOT) ? relative(ROOT, a) : a) }, null, 2));
  return report;
}

export function resolveOptions(stack: Stack, override: Partial<Omit<FinalizeOptions, 'palette'>> & { palette?: Palette | string } = {}): FinalizeOptions {
  const pick = override.palette ?? stack.defaults?.palette ?? 'phase-garden';
  const palette = typeof pick === 'string' ? PALETTES.find(p => p.id === pick) ?? fail(`Unknown palette ${pick}`) : pick;
  if (!/^#[0-9a-f]{6}$/i.test(palette.paper) || !palette.inks.length || palette.inks.some(c => !/^#[0-9a-f]{6}$/i.test(c))) fail('Palette colors must be #rrggbb');
  const d = stack.defaults ?? {};
  return {
    palette,
    center: override.center ?? d.center ?? DEFAULT_OPTIONS.center,
    mergeSameColor: override.mergeSameColor ?? d.mergeSameColor ?? DEFAULT_OPTIONS.mergeSameColor,
    vpype: { ...DEFAULT_OPTIONS.vpype, ...d.vpype, ...override.vpype },
  };
}

function loadStack(path: string): Stack {
  const stack = JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as Stack;
  if (!stack.out || !Array.isArray(stack.pieces) || !stack.pieces.length) fail('Stack needs out and pieces');
  const names = new Set<string>();
  for (const p of stack.pieces) {
    if (!p.name || !p.sketch || !Number.isSafeInteger(p.seed)) fail('Each piece needs name, sketch and an integer seed');
    if (names.has(slug(p.name))) fail(`Duplicate piece ${p.name}`);
    names.add(slug(p.name));
  }
  return stack;
}

const TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.html': 'text/html; charset=utf-8' };

async function serve(stackPath: string, port: number) {
  const stack = loadStack(stackPath);
  const outRoot = resolve(ROOT, stack.out);
  const ui = readFileSync(join(ROOT, 'cli/finalize/ui.html'), 'utf8');
  // Preview renders in the default palette; the page recolors layers live. Variants are keyed by their overrides.
  const basePalette = resolveOptions(stack).palette;
  const pieceInfo = new Map<string, { pens: Pen[]; controls: Control[] }>();
  for (const piece of stack.pieces) pieceInfo.set(slug(piece.name), await loadSketch(piece.sketch));
  const variants = new Map<string, Map<string, string>>();
  const variantKey = (overrides: Record<string, unknown>) => sha256(JSON.stringify(Object.keys(overrides).sort().map(k => [k, overrides[k]]))).slice(0, 12);
  async function renderVariant(overrides: Record<string, unknown>, slugs: string[]): Promise<{ key: string; svgs: Record<string, string> }> {
    const key = variantKey(overrides);
    const cache = variants.get(key) ?? new Map<string, string>();
    variants.set(key, cache);
    const todo = stack.pieces.filter(p => slugs.includes(slug(p.name)) && !cache.has(slug(p.name)));
    for (let i = 0; i < todo.length; i += 3) {
      await Promise.all(todo.slice(i, i + 3).map(async piece => {
        cache.set(slug(piece.name), await previewPiece(stack, piece, basePalette, overrides, resolve(ROOT, stack.out, '_preview', key, slug(piece.name))));
      }));
    }
    return { key, svgs: Object.fromEntries(slugs.filter(s => cache.has(s)).map(s => [s, cache.get(s)!])) };
  }
  await renderVariant({}, stack.pieces.map(p => slug(p.name)));
  console.log(`previews ready: ${stack.pieces.length} pieces`);
  // Slogan controls are offered only when every piece declares them.
  const sloganControls = stack.pieces.every(p => pieceInfo.get(slug(p.name))!.controls.some(c => c.group === 'Slogan'))
    ? pieceInfo.get(slug(stack.pieces[0].name))!.controls.filter(c => c.group === 'Slogan') : [];
  let busy = false;
  const readJson = async (req: AsyncIterable<unknown>) => {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 1 << 20) fail('Request too large'); }
    return JSON.parse(body);
  };
  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (code: number, body: string | Buffer, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(200, ui, TYPES['.html']);
      if (req.method === 'GET' && url.pathname === '/api/stack') {
        return send(200, JSON.stringify({ title: stack.title ?? 'Finalize', palettes: PALETTES, defaults: resolveOptions(stack), borderPen: (stack.border as { pen?: string } | undefined)?.pen ?? null, sloganControls,
          pieces: stack.pieces.map(p => ({ ...p, slug: slug(p.name), pens: pieceInfo.get(slug(p.name))!.pens })) }));
      }
      const preview = /^\/api\/preview\/([a-z0-9-]+)\.svg$/.exec(url.pathname);
      const base = variants.get(variantKey({}));
      if (req.method === 'GET' && preview && base?.has(preview[1])) return send(200, base.get(preview[1])!, TYPES['.svg']);
      if (req.method === 'GET' && url.pathname.startsWith('/out/')) {
        const file = resolve(outRoot, decodeURIComponent(url.pathname.slice(5)));
        if (!file.startsWith(outRoot + '/') || !existsSync(file)) return send(404, '{"error":"not found"}');
        return send(200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
      }
      if (req.method === 'POST' && (url.pathname === '/api/finalize' || url.pathname === '/api/preview')) {
        if (busy) return send(409, JSON.stringify({ error: 'Another run is already in progress' }));
        // Local-only tool: refuse cross-site form posts.
        if (!String(req.headers['content-type']).startsWith('application/json') || (req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(req.headers.origin))) {
          return send(403, JSON.stringify({ error: 'JSON from this page only' }));
        }
        busy = true;
        try {
          const input = await readJson(req) as { pieces: string[]; params?: Record<string, unknown>; palette: Palette; center: FinalizeOptions['center']; mergeSameColor: boolean; vpype: Partial<VpypeOptions> };
          const overrides = input.params && typeof input.params === 'object' ? input.params : {};
          if (url.pathname === '/api/preview') return send(200, JSON.stringify(await renderVariant(overrides, input.pieces ?? [])));
          const options = resolveOptions(stack, { palette: input.palette, center: input.center, mergeSameColor: input.mergeSameColor, vpype: input.vpype as VpypeOptions });
          const chosen = stack.pieces.filter(p => input.pieces.includes(slug(p.name)));
          if (!chosen.length) return send(400, '{"error":"no pieces selected"}');
          const reports = [];
          for (const piece of chosen) reports.push(await finalizePiece(stack, piece, options, overrides));
          return send(200, JSON.stringify({ reports: reports.map(r => ({ ...r, url: `/out/${slug(r.name)}/` })) }));
        } finally { busy = false; }
      }
      send(404, '{"error":"not found"}');
    } catch (error) {
      send(500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }).listen(port, '127.0.0.1', () => console.log(`finalize: http://127.0.0.1:${port}/  (stack ${stackPath}, output ${relative(ROOT, outRoot)})`));
}

async function main(argv: string[]) {
  const [command, stackPath, ...rest] = argv;
  const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (!stackPath || (command !== 'run' && command !== 'serve')) fail('Usage: finalize.ts <run|serve> <stack.json> [--only a,b] [--palette id] [--params json] [--merge] [--port 8796]');
  if (command === 'serve') return serve(stackPath, Number(flag('port') ?? 8796));
  const stack = loadStack(stackPath);
  const only = flag('only')?.split(',').map(slug);
  const options = resolveOptions(stack, { ...(flag('palette') ? { palette: flag('palette') } : {}), ...(rest.includes('--merge') ? { mergeSameColor: true } : {}) });
  const overrides = flag('params') ? JSON.parse(flag('params')!) as Record<string, unknown> : {};
  for (const piece of stack.pieces.filter(p => !only || only.includes(slug(p.name)))) {
    const r = await finalizePiece(stack, piece, options, overrides);
    console.log(JSON.stringify({ name: r.name, palette: r.palette, offset: r.offset, margins: r.margins, pens: r.pens, minutes: r.minutes, serverCompatible: r.serverCompatible, prepared: r.files.prepared }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exit(1); });
}
