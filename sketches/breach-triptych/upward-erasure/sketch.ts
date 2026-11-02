import type { AssemblySpec, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { thinRanked } from '../../kit/density.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, insideRing, keepAlong, pathLength } from '../../kit/page.ts';
import { distanceToRings } from '../../../src/sketch/region.ts';
import { ALONGSIDE_DEG, FILL_OVER, LINE_PITCH, LODESTONE_ASSEMBLY } from '../lodestone-world.ts';
import { ART, PAGE, PAPER, pensOf } from '../world.ts';
import { gpuMesher } from '../../kit/sculpt-gpu.ts';
import { CONTROLS, cpuMesher, erasure, FILL_PITCH, frameRings, panelStripes, previewHeadStage, type Erasure, type HeadStage, type Pen, type Seen } from './world.ts';

/**
 * Upward Erasure (a Lodestone study, after the character concept of 2026-10-21): see `./world.ts`. Two sheets, as
 * Lodestone L: the gold-yellow behind (Micron 08 black where it shows), the black in front (silver, gold and fluoro
 * pink gels, and copper when the lapels take it; the lapels' silver may be a layer of its own), cut with the bar, the shirt and collar, and some of the crown's
 * slices. The small slices' fill, when there is one, is a gold layer of its own (`gold-fill`) drawn before the cut
 * guides, so the guides lie on it; the gold-yellow may take one behind them in the same gel, so a cut a little off its
 * line still opens onto gold.
 */

const plies = [
  { id: 'gold', paper: PAPER.gold, pens: ['gold-fill', 'black'], cutInk: 'black' },
  { id: 'black', paper: PAPER.black, pens: ['silver', 'silver-lapels', 'gold', 'gold-fill', 'copper', 'fluoro-pink'], cutInk: 'silver' },
];
export const spec: AssemblySpec = { ...LODESTONE_ASSEMBLY, plies };
/** In plotting order: each pen's own layer right after its line work (the lapels' silver, the gold's fill), still in the holder. */
export const pens = pensOf(['silver', 'silver-lapels', 'gold', 'gold-fill', 'copper', 'fluoro-pink', 'black']);

type Item = Seen & { piece: Point[] };

/** Lines of one sheet kept apart at the pens' pitch (outlines first, then seams and creases, then hatch), by pen. */
function thinned(items: Item[], pitch: number, skip = false): Map<string, Point[][]> {
  const out = new Map<string, Point[][]>();
  // A draft keeps every line (it is on screen for a moment, until the full frame replaces it).
  if (skip) { for (const i of items) if (pathLength(i.piece) >= 0.6) { const l = out.get(i.pen) ?? []; l.push(i.piece); out.set(i.pen, l); } return out; }
  for (const { item, runs } of thinRanked(items, pitch, { angle: ALONGSIDE_DEG })) for (const r of runs) if (pathLength(r) >= 0.6) { const l = out.get(item.pen) ?? []; l.push(r); out.set(item.pen, l); }
  return out;
}

/**
 * The two sheets' art, and the fill of the black's small windows on each (drawn over and under them, so outside
 * `renderPly`'s clip).
 */
export function sheets(e: Erasure, options: { thin?: boolean } = {}): { black: Part[]; gold: Part[]; fill: Part[]; fillBehind: Part[] } {
  const black: Item[] = [], gold: Item[] = [];
  /** Keep the pieces of `s` that pass `test`, each point moved by `move`, into a sheet's list (in `pen`). */
  const keep = (into: Item[], s: Seen, test: (p: Point) => boolean, move?: (p: Point) => Point, pen: Pen = s.pen) => {
    for (const piece of keepAlong(s.piece, test, 0.15)) {
      const moved = move ? piece.map(move) : piece;
      for (const inside of clipToRect(moved, ART)) if (pathLength(inside) >= 0.6) into.push({ ...s, pen, piece: inside });
    }
  };
  const inBox = (u0: number, u1: number, v0: number, v1: number) => (p: Point) => { const b = e.toBar(p); return b.u >= u0 && b.u <= u1 && b.v >= v0 && b.v <= v1; };
  const shift = (du: number, dv: number) => (p: Point) => { const b = e.toBar(p); return e.toPage(b.u + du, b.v + dv); };
  // The spill keeps off the nose and mouth (it would scramble the face's one profile): only behind them along the visor.
  const noseU = e.toBar(e.page.noseTip).u, faceSide = Math.sign(noseU - e.toBar(e.page.eyes[0]).u) || 1;
  const spillable = (p: Point) => (noseU - e.toBar(p).u) * faceSide > 30;
  const spilled = (p: Point) => { const v = e.toBar(p).v; return spillable(p) && e.spill.some(b => v >= b.v0 && v < b.v1); };
  for (const s of e.head) {
    // The piece's extent in the visor's frame: a band or a cell it does not reach cannot take any of it (the frame is
    // affine, so a polyline stays within its vertices' extent), and is skipped without testing its points.
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of s.piece) { const b = e.toBar(p); u0 = Math.min(u0, b.u); u1 = Math.max(u1, b.u); v0 = Math.min(v0, b.v); v1 = Math.max(v1, b.v); }
    const reaches = (bu0: number, bu1: number, bv0: number, bv1: number) => u1 >= bu0 && u0 <= bu1 && v1 >= bv0 && v0 <= bv1;
    // On the black: the head where the glitch leaves it, the bands below the visor drawn shifted along it.
    keep(black, s, p => !e.bySuit(p) && !e.erased(p) && !spilled(p));
    for (const b of e.spill) if (reaches(-Infinity, Infinity, b.v0, b.v1)) keep(black, s, p => !e.bySuit(p) && spillable(p) && inBox(-1e9, 1e9, b.v0, b.v1)(p), shift(b.du, 0));
    if (s.pen === 'fluoro-pink') continue;
    // On the gold, in black ink: the eyes behind the visor in shifted bands, the head smeared up the gold columns, and
    // the pieces lifted onto the gold. On the black, the pieces lifted there.
    for (const b of e.visorBands) if (reaches(-Infinity, Infinity, b.v0, b.v1)) keep(gold, s, inBox(-1e9, 1e9, b.v0, b.v1), shift(b.du, 0), 'black');
    for (const c of e.cells) {
      if (c.kind === 'base') continue;
      const box: [number, number, number, number] = c.kind === 'rise' ? [c.u0 + 0.6, c.u1 - 0.6, c.v0, c.v1 - c.dv] : [c.u0 + 0.6, c.u1 - 0.6, c.v0 + 0.6, c.v1 - 0.6];
      if (!reaches(...box)) continue;
      keep(c.kind === 'black' ? black : gold, s, inBox(...box), shift(0, c.dv), c.kind === 'black' ? s.pen : 'black');
    }
  }
  for (const c of e.cells) if (c.kind === 'black') {
    const r = [e.toPage(c.u0, c.v0 + c.dv), e.toPage(c.u1, c.v0 + c.dv), e.toPage(c.u1, c.v1 + c.dv), e.toPage(c.u0, c.v1 + c.dv)];
    black.push({ pen: 'gold', rank: 0, id: 'frame', piece: [...r, r[0]] });
  }
  for (const st of e.streaks) for (const piece of clipToRect(st, ART)) gold.push({ pen: 'black', rank: 1, id: 'streak', piece });
  const grow = spec.bleed + FILL_OVER;
  for (const p of e.panels) for (const piece of panelStripes(p, p.window ? grow : 0)) (p.window ? gold : black).push({ pen: p.pen, rank: 2, id: p.id, piece });
  for (const l of e.suitLines) for (const piece of clipToRect(l.path, ART)) black.push({ pen: l.pen, rank: 0, id: 'suit-line', piece });
  for (const r of e.ribbons) for (const piece of clipToRect(r.path, ART)) black.push({ pen: r.pen, rank: 1, id: 'ribbon', piece });

  // The slogans keep their own lines: what else would cross them is cleared round their letters, and they are never thinned.
  const byText = (rings: Point[][]) => {
    if (!rings.length) return () => false;
    const xs = rings.flat().map(q => q.x), ys = rings.flat().map(q => q.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    return (p: Point) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && rings.some(r => insideRing(r, p));
  };
  const byRising = byText(e.slogan.clearBlack), byReadout = byText(e.slogan.clearGold);
  const pink = [...black.filter(i => i.pen === 'fluoro-pink').flatMap(i => keepAlong(i.piece, p => !byRising(p), 0.15)), ...(e.slogan.pen === 'fluoro-pink' ? e.slogan.black : [])];
  const byPink = glyphMask(pink, 0.9, 6, PAGE);
  const lines = thinned(black.filter(i => i.pen !== 'fluoro-pink').flatMap(i => keepAlong(i.piece, p => !byPink(p) && !byRising(p), 0.15).map(piece => ({ ...i, piece }))), LINE_PITCH.gel, options.thin === false);
  lines.set('fluoro-pink', pink);
  if (e.slogan.pen !== 'fluoro-pink' && e.slogan.black.length) lines.set(e.slogan.pen, [...(lines.get(e.slogan.pen) ?? []), ...e.slogan.black]);
  // The small windows' fill: the black's other lines give way to it, a clean pitch clear of its outline.
  if (e.fill) giveWay(lines, e.fill.outline);
  // The frame: the black's art held inside it, then its gold and silver bands (never thinned).
  if (e.frame) {
    const inner = e.frame.inner;
    for (const [pen, paths] of lines) lines.set(pen, paths.flatMap(path => clipToRect(path, inner)).filter(path => pathLength(path) >= 0.6));
    for (const band of e.frame.bands) lines.set(band.pen, [...(lines.get(band.pen) ?? []), ...frameRings(e.frame, band, LINE_PITCH.gel + 0.05)]);
  }
  const under = thinned(gold.flatMap(i => keepAlong(i.piece, p => !byReadout(p), 0.15).map(piece => ({ ...i, piece }))), LINE_PITCH.gel, options.thin === false);
  if (e.slogan.gold.length) under.set('black', [...(under.get('black') ?? []), ...e.slogan.gold]);
  if (e.fill?.behind) giveWay(under, e.fill.behind.outline);
  return {
    black: [...lines].map(([pen, paths]) => ({ id: `black-${pen}`, pen, paths })),
    gold: [...under].map(([pen, paths]) => ({ id: `gold-${pen}`, pen, paths })),
    fill: e.fill ? [{ id: 'black-gold-fill', pen: 'gold-fill', paths: [...e.fill.outline, ...e.fill.hatch] }] : [],
    fillBehind: e.fill?.behind ? [{ id: 'gold-gold-fill', pen: 'gold-fill', paths: [...e.fill.behind.outline, ...e.fill.behind.hatch] }] : [],
  };
}

/** A sheet's lines (by pen) cleared off a fill: inside its `outline` and a clean pitch round it. */
function giveWay(lines: Map<string, Point[][]>, outline: Point[][]): void {
  const boxes = outline.map(r => { const xs = r.map(q => q.x), ys = r.map(q => q.y); return { x0: Math.min(...xs) - FILL_PITCH, x1: Math.max(...xs) + FILL_PITCH, y0: Math.min(...ys) - FILL_PITCH, y1: Math.max(...ys) + FILL_PITCH }; });
  const near = (p: Point) => boxes.some(b => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1);
  // A path is tested along its length only where its box meets a fill's (a long segment can cross one between vertices).
  const meets = (path: Point[]) => {
    const xs = path.map(q => q.x), ys = path.map(q => q.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    return boxes.some(b => x1 >= b.x0 && x0 <= b.x1 && y1 >= b.y0 && y0 <= b.y1);
  };
  const byFill = (p: Point) => near(p) && (outline.some(r => insideRing(r, p)) || distanceToRings(p, outline) < FILL_PITCH);
  for (const [pen, paths] of lines) lines.set(pen, paths.flatMap(path => (meets(path) ? keepAlong(path, p => !byFill(p), 0.15) : [path])).filter(path => pathLength(path) >= 0.6));
}

/**
 * The world for the last parameters drawn, whichever ply: a host that keeps the module loaded (the sketch lab draws
 * every ply in turn) builds it once.
 */
let lastWorld: { key: string; e: Erasure; art: ReturnType<typeof sheets> } | undefined;
function world(ctx: SketchContext, stage?: HeadStage, quality?: 'draft' | 'full'): { e: Erasure; art: ReturnType<typeof sheets> } {
  const key = JSON.stringify([quality ?? 'plot', ctx.seed, Object.entries(ctx.params).filter(([k]) => k !== spec.control).sort(([a], [b]) => (a < b ? -1 : 1))]);
  if (lastWorld?.key !== key) { const e = erasure(ctx, stage, { preview: quality !== undefined }); lastWorld = { key, e, art: sheets(e, { thin: quality !== 'draft' }) }; }
  return lastWorld;
}

/**
 * The sketch lab's preview (`cli/sketch/lab/runtime.ts`): each sheet's art unclipped and the black's windows, the head
 * meshed on the GPU where there is one, a `draft` coarser still (exports still draw through `draw`, exactly).
 */
export async function labSheets(ctx: SketchContext, quality: 'draft' | 'full' = 'full'): Promise<{ ply: string; parts: Part[]; cuts: Point[][] }[]> {
  const mesher = (await gpuMesher()) ?? cpuMesher;
  const { e, art } = world(ctx, await previewHeadStage(ctx, mesher, quality === 'draft'), quality);
  return [{ ply: 'gold', parts: [...art.gold, ...art.fillBehind], cuts: [] }, { ply: 'black', parts: [...art.black, ...art.fill], cuts: e.window }];
}

function draw(ctx: SketchContext): Part[] {
  const { e, art } = world(ctx);
  const parts = renderPly(spec, ctx, pens, { cuts: { black: [{ id: 'windows', rings: e.window, label: 'W' }] }, art: { black: art.black, gold: art.gold } });
  // The fill covers its windows (they may be left uncut), so it joins the black after renderPly's clip to its windows;
  // the fill behind them reaches past what they show, so it joins the gold after the clip too.
  const ply = ctx.params[spec.control];
  return [...parts, ...(ply === 'black' ? art.fill : ply === 'gold' ? art.fillBehind : []), ...landmarks(e)];
}

/**
 * Named page points for the readability crops (`cli/sketch/crops.ts`): diagnostic, so the SVG never carries them. Paths
 * need two points, so each is the point and a hair beside it; readers take the first.
 */
function landmarks(e: Erasure): Part[] {
  const { noseTip, chin, eyes } = e.page;
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const at: Record<string, Point> = { nose: noseTip, eyes: mid(eyes[0], eyes[1]), mouth: mid(noseTip, chin), chin };
  return Object.entries(at).map(([name, p]) => ({ id: `landmark-${name}`, pen: 'cut', paths: [[{ x: p.x, y: p.y }, { x: p.x + 0.01, y: p.y }]], diagnostic: true }));
}

const sketch: Sketch = {
  name: 'Breach / Lodestone: Upward Erasure',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls: [plyControl(spec), ...CONTROLS],
  assembly: spec,
  draw,
};

export default sketch;
