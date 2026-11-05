import type { Params, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { strokeText } from '../../../src/sketch/stroke-text.ts';
import { inRegion } from '../../../packages/plot-core/src/region.ts';
import { traceMask } from '../../kit/outline.ts';
import { clipToRect, type Rect } from '../../kit/page.ts';
import { rect } from '../lodestone-cuts.ts';
import { bundle, FUSE_MM } from '../ka-trace/patterns.ts';
import { pens, spec } from '../ka-trace/sketch.ts';
import starts from '../ka-trace/starts.json';
import { forTheKnife, world, type World } from '../ka-trace/world.ts';

/**
 * Kawaii Aggro's test sheet: before any full sheet, an A4 pair (black over magenta, cut as the piece is) that proves
 * Micron 08 on magenta and the fused lines. Six windows of the real drawings, moved onto the A4 sheet, and a strip:
 *
 * - A: Profile's visor and slogan;
 * - B, C: Profile's field lines at the two weights still in the running, around the collar points;
 * - D, E: the scales on Column, the pleats on Profile;
 * - F: Close's hidden face, the finest line work on the magenta;
 * - G: how close passes must run to fuse (each bar is passes that far apart, labelled, for `plotter widths` too),
 *   then both tapers alone at their full width, then one single line.
 */

const PAGE = { width: 210, height: 297, margin: 11 };
const START: Record<string, Params> = Object.fromEntries(starts.starts.map(s => [s.id, s.params as Params]));

interface Crop { id: string; label: string; start: string; from: Point; at: Rect; square?: boolean }
const box = (x: number, y: number, w: number, h: number): Rect => ({ x0: x, y0: y, x1: x + w, y1: y + h });
const CROPS: Crop[] = [
  { id: 'a', label: 'A  VISOR AND SLOGAN', start: 'profile', from: { x: 88, y: 116 }, at: box(15, 20, 180, 36), square: true },
  { id: 'b', label: 'B  FIELD LINES C, 3 MM', start: 'profile-c', from: { x: 45, y: 195 }, at: box(15, 64, 88, 90), square: true },
  { id: 'c', label: 'C  FIELD LINES E, 5 MM', start: 'profile-e', from: { x: 45, y: 195 }, at: box(107, 64, 88, 90), square: true },
  { id: 'd', label: 'D  SCALES', start: 'column', from: { x: 110, y: 180 }, at: box(15, 162, 44, 56), square: true },
  { id: 'e', label: 'E  PLEATS', start: 'profile', from: { x: 60, y: 290 }, at: box(63, 162, 44, 56), square: true },
  { id: 'f', label: 'F  HIDDEN FACE', start: 'close', from: { x: 175, y: 128 }, at: box(111, 162, 84, 56) },
];
const STRIP = box(15, 226, 180, 30);
const BARS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.66, 0.8, 0.95];
const LABEL = { face: 'sans', height: 2.6 } as const;

let made: { seed: number; worlds: Map<string, World> } | undefined;
function worldOf(ctx: SketchContext, start: string): World {
  if (made?.seed !== ctx.seed) made = { seed: ctx.seed, worlds: new Map() };
  let w = made.worlds.get(start);
  if (!w) { w = world({ ...ctx, params: { ...ctx.params, ...START[start] } }, true, false); made.worlds.set(start, w); }
  return w;
}

/** The strip's ink, all of it on the magenta. */
function strip(): Part[] {
  const { x0, y0, x1 } = STRIP, bars: Point[][] = [], tapers: Point[][] = [], text: Point[][] = [];
  BARS.forEach((apart, i) => {
    const x = x0 + 2 + i * 17.6;
    for (let y = y0 + 2; y <= y0 + 8 + 1e-6; y += apart) bars.push([{ x, y }, { x: x + 15, y }]);
    text.push(...strokeText(apart.toFixed(2), x + 2, y0 + 9.6, LABEL));
  });
  const swell = (a: number, b: number, width: number) => bundle([{ x: a, y: y0 + 19 }, { x: b, y: y0 + 19 }], width, 1);
  tapers.push(...swell(x0 + 2, x0 + 86, 3), ...swell(x0 + 92, x1 - 2, 5));
  const single: Point[][] = [[{ x: x0 + 2, y: y0 + 26 }, { x: x1 - 2, y: y0 + 26 }]];
  return [{ id: 'strip-bars', pen: 'black', paths: bars }, { id: 'strip-tapers', pen: 'black', paths: tapers }, { id: 'strip-single', pen: 'black', paths: single }, { id: 'strip-text', pen: 'black', paths: text }];
}

function draw(ctx: SketchContext): Part[] {
  const rings: Point[][] = [rect(STRIP.x0, STRIP.y0, STRIP.x1, STRIP.y1)], black: Part[] = [], magenta: Part[] = strip(), labels: Point[][] = [];
  for (const c of CROPS) {
    const w = worldOf(ctx, c.start), dx = c.at.x0 - c.from.x, dy = c.at.y0 - c.from.y;
    const from: Rect = { x0: c.from.x, y0: c.from.y, x1: c.at.x1 - dx, y1: c.at.y1 - dy };
    const inside = (p: Point) => inRegion({ x: p.x - dx, y: p.y - dy }, { rings: w.windows });
    rings.push(...forTheKnife(traceMask(inside, c.at, 0.25, { simplify: 0.08, minRadius: 0.85, minArea: 7, square: c.square })));
    const moved = (parts: Part[]) => parts.map(part => ({ ...part, id: `${c.id}-${part.id}`, paths: part.paths.flatMap(path => clipToRect(path, from)).map(path => path.map(p => ({ x: p.x + dx, y: p.y + dy }))) })).filter(part => part.paths.length);
    black.push(...moved(w.art.black));
    magenta.push(...moved(w.art.magenta));
    labels.push(...strokeText(c.label, c.at.x0, c.at.y0 - 4.2, LABEL));
  }
  labels.push(...strokeText('G  PASSES THIS FAR APART (MM); C AND E ALONE; ONE LINE', STRIP.x0, STRIP.y0 - 4.2, LABEL));
  labels.push(...strokeText(`KAWAII AGGRO TEST SHEET. MICRON 08 ON MAGENTA, FUSED AT ${FUSE_MM} MM.`, STRIP.x0, STRIP.y1 + 6, LABEL));
  black.push({ id: 'labels', pen: 'silver', paths: labels });
  return renderPly(spec, { ...ctx, page: PAGE }, pens, { cuts: { black: [{ id: 'windows', rings, label: 'W' }] }, art: { black, magenta } });
}

const sketch: Sketch = {
  name: 'Breach / Kawaii Aggro: test sheet',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls: [plyControl(spec)],
  assembly: spec,
  draw,
};

export default sketch;
