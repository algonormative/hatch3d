import type { AssemblySpec, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { thinRanked } from '../../kit/density.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, insideRing, keepAlong, pathLength } from '../../kit/page.ts';
import { ALONGSIDE_DEG, FILL_OVER, LINE_PITCH, LODESTONE_ASSEMBLY } from '../lodestone-world.ts';
import { ART, PAGE, PAPER, pensOf } from '../world.ts';
import { gpuMesher } from '../../kit/sculpt-gpu.ts';
import { CONTROLS, cpuMesher, erasure, panelStripes, previewHeadStage, type Erasure, type HeadStage, type Pen, type Seen } from './world.ts';

/**
 * Upward Erasure (a Lodestone study, after the character concept of 2026-10-21): see `./world.ts`. Two sheets, as
 * Lodestone L: the gold-yellow behind (Micron 08 black where it shows), the black in front (silver, gold and fluoro
 * pink gels), cut with the bar, the shirt and collar, and some of the crown's slices.
 */

const plies = [
  { id: 'gold', paper: PAPER.gold, pens: ['black'], cutInk: 'black' },
  { id: 'black', paper: PAPER.black, pens: ['silver', 'gold', 'fluoro-pink'], cutInk: 'silver' },
];
export const spec: AssemblySpec = { ...LODESTONE_ASSEMBLY, plies };
const pens = pensOf(['silver', 'gold', 'fluoro-pink', 'black']);

type Item = Seen & { piece: Point[] };

/** Lines of one sheet kept apart at the pens' pitch (outlines first, then seams and creases, then hatch), by pen. */
function thinned(items: Item[], pitch: number, skip = false): Map<string, Point[][]> {
  const out = new Map<string, Point[][]>();
  // A draft keeps every line (it is on screen for a moment, until the full frame replaces it).
  if (skip) { for (const i of items) if (pathLength(i.piece) >= 0.6) { const l = out.get(i.pen) ?? []; l.push(i.piece); out.set(i.pen, l); } return out; }
  for (const { item, runs } of thinRanked(items, pitch, { angle: ALONGSIDE_DEG })) for (const r of runs) if (pathLength(r) >= 0.6) { const l = out.get(item.pen) ?? []; l.push(r); out.set(item.pen, l); }
  return out;
}

/** The two sheets' art. */
export function sheets(e: Erasure, options: { thin?: boolean } = {}): { black: Part[]; gold: Part[] } {
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
  const under = thinned(gold.flatMap(i => keepAlong(i.piece, p => !byReadout(p), 0.15).map(piece => ({ ...i, piece }))), LINE_PITCH.gel, options.thin === false);
  if (e.slogan.gold.length) under.set('black', [...(under.get('black') ?? []), ...e.slogan.gold]);
  return {
    black: [...lines].map(([pen, paths]) => ({ id: `black-${pen}`, pen, paths })),
    gold: [...under].map(([pen, paths]) => ({ id: `gold-${pen}`, pen, paths })),
  };
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
  return [{ ply: 'gold', parts: art.gold, cuts: [] }, { ply: 'black', parts: art.black, cuts: e.window }];
}

function draw(ctx: SketchContext): Part[] {
  const { e, art } = world(ctx);
  const parts = renderPly(spec, ctx, pens, { cuts: { black: [{ id: 'windows', rings: e.window, label: 'W' }] }, art });
  return [...parts, ...landmarks(e)];
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
