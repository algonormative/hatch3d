import type { AssemblySpec, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { thinRanked } from '../../kit/density.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, insideRing, keepAlong, pathLength } from '../../kit/page.ts';
import { ALONGSIDE_DEG, FILL_OVER, LINE_PITCH, LODESTONE_ASSEMBLY } from '../lodestone-world.ts';
import { ART, PAGE, PAPER, pensOf } from '../world.ts';
import { gpuMesher } from '../../kit/sculpt-gpu.ts';
import { CONTROLS, cpuMesher, METALLIC, panelStripes, previewHeadStage, scene, type HeadStage, type Pen, type Scene, type Seen } from './world.ts';

/**
 * Kawaii Aggro (a fork of Upward Erasure): see `./world.ts`. Two sheets, as Upward Erasure: the gold-yellow behind
 * (Micron 08 black where it shows), the black in front (silver, gold, fluoro pink and the metallic pink), cut with the
 * glitch's gold blocks, the shirt and the collar.
 */

const plies = [
  { id: 'gold', paper: PAPER.gold, pens: ['black'], cutInk: 'black' },
  { id: 'black', paper: PAPER.black, pens: ['silver', 'gold', 'fluoro-pink', METALLIC], cutInk: 'silver' },
];
export const spec: AssemblySpec = { ...LODESTONE_ASSEMBLY, plies };
const pens = pensOf(['silver', 'gold', 'fluoro-pink', METALLIC, 'black']);

type Item = Seen & { piece: Point[] };
/** The accent pens: fills and accents in them are drawn as they are, never thinned. */
const ACCENT: Pen[] = ['fluoro-pink', METALLIC];

function thinned(items: Item[], pitch: number, skip = false): Map<string, Point[][]> {
  const out = new Map<string, Point[][]>();
  if (skip) { for (const i of items) if (pathLength(i.piece) >= 0.6) { const l = out.get(i.pen) ?? []; l.push(i.piece); out.set(i.pen, l); } return out; }
  for (const { item, runs } of thinRanked(items, pitch, { angle: ALONGSIDE_DEG })) for (const r of runs) if (pathLength(r) >= 0.6) { const l = out.get(item.pen) ?? []; l.push(r); out.set(item.pen, l); }
  return out;
}

/** The two sheets' art. */
export function sheets(s: Scene, options: { thin?: boolean } = {}): { black: Part[]; gold: Part[] } {
  const vOf = (p: Point) => s.toBar(p).v;
  const o = s.toPage(0, 0), d1 = s.toPage(1, 0), dir = { x: d1.x - o.x, y: d1.y - o.y };
  const sliceOfV = (v: number) => {
    let lo = 0, hi = s.slices.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s.slices[m].v0 <= v) lo = m; else hi = m - 1; }
    return lo;
  };
  /**
   * A piece through the slices: cut exactly where it crosses a slice's edge, each part moved along the visor by its
   * slice's shift; parts in a gap are taken out.
   */
  const sliced = (piece: Point[]): Point[][] => {
    const out: Point[][] = [];
    let k = sliceOfV(vOf(piece[0])), part: Point[] = [piece[0]];
    const flush = () => {
      const sl = s.slices[k];
      if (part.length >= 2 && !sl.gap) out.push(sl.du ? part.map(p => ({ x: p.x + dir.x * sl.du, y: p.y + dir.y * sl.du })) : part);
    };
    for (let i = 1; i < piece.length; i++) {
      const a = piece[i - 1], b = piece[i], va = vOf(a), vb = vOf(b), kb = sliceOfV(vb);
      while (k !== kb) {
        const up = kb > k, edge = up ? s.slices[k + 1].v0 : s.slices[k].v0;
        const t = (edge - va) / (vb - va), q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        part.push(q); flush();
        k += up ? 1 : -1; part = [q];
      }
      part.push(b);
    }
    flush();
    return out;
  };
  // Blocks and the visor and the bow clear what is under them; each test reads only pieces that reach them.
  const bars = s.blocks.map(b => b);
  const extent = (piece: Point[]) => {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of piece) { const q = s.toBar(p); u0 = Math.min(u0, q.u); u1 = Math.max(u1, q.u); v0 = Math.min(v0, q.v); v1 = Math.max(v1, q.v); }
    return { u0, u1, v0, v1 };
  };
  const reaches = (e: ReturnType<typeof extent>, b: { u0: number; u1: number; v0: number; v1: number }) => e.u1 >= b.u0 && e.u0 <= b.u1 && e.v1 >= b.v0 && e.v0 <= b.v1;
  const visorBox = s.visor.length ? extent(s.visor) : undefined;
  const bowBox = s.bow.length ? extent(s.bow.flat()) : undefined;
  /** Keep the parts of `piece` that `test` passes, if it reaches `box` at all; else the whole piece. */
  const clearing = (piece: Point[], box: ReturnType<typeof extent> | undefined, inside: (p: Point) => boolean): Point[][] =>
    box && reaches(extent(piece), box) ? keepAlong(piece, p => !inside(p), 0.15) : [piece];
  const clearBlocks = (piece: Point[]): Point[][] => {
    const e = extent(piece), hit = bars.filter(b => reaches(e, b));
    return hit.length ? keepAlong(piece, p => { const q = s.toBar(p); return !hit.some(b => q.u >= b.u0 && q.u <= b.u1 && q.v >= b.v0 && q.v <= b.v1); }, 0.15) : [piece];
  };
  const inVisor = (p: Point) => insideRing(s.visor, p) && !s.onNose(p);
  const inBow = (p: Point) => s.bow.some(r => insideRing(r, p));

  // The figure, before the blocks: the head (less what the visor and the bow cover), the suit, the visor: all slid by
  // the slices.
  const figure: Item[] = [], under: Item[] = [];
  const add = (into: Item[], it: Omit<Item, 'piece'>, piece: Point[]) => { for (const part of sliced(piece)) for (const q of clipToRect(part, ART)) if (pathLength(q) >= 0.3) into.push({ ...it, piece: q }); };
  for (const h of s.head) for (const a of clearing(h.piece, visorBox, inVisor)) for (const b of clearing(a, bowBox, inBow)) add(figure, h, b);
  const grow = spec.bleed + FILL_OVER;
  for (const p of s.panels) {
    const bowPart = p.id.startsWith('bow') || p.id.startsWith('tail') || p.id === 'knot';
    for (const piece of panelStripes(p, p.window ? grow : 0)) for (const b of bowPart || p.window ? [piece] : clearing(piece, bowBox, inBow)) add(p.window ? under : figure, { pen: p.pen, rank: 2, id: p.id }, b);
  }
  for (const l of s.suitLines) for (const b of l.pen === METALLIC && s.bow.some(r => r.every(q => l.path.includes(q))) ? [l.path] : clearing(l.path, bowBox, inBow)) add(figure, { pen: l.pen, rank: 0, id: 'suit-line' }, b);
  for (const r of s.visorRows) add(figure, { pen: 'fluoro-pink', rank: 0, id: 'visor' }, r);
  for (const r of s.eyePixels) add(figure, { pen: 'silver', rank: 0, id: 'eye' }, r);
  if (s.visor.length) add(figure, { pen: METALLIC, rank: 0, id: 'visor-edge' }, s.visor);

  // The blocks: the drawing under them cleared; echoes carry the drawing from elsewhere into them (on the gold for a
  // gold block, in black ink).
  const black: Item[] = [], gold: Item[] = [];
  for (const it of figure) for (const piece of clearBlocks(it.piece)) black.push({ ...it, piece });
  for (const it of under) for (const piece of clearBlocks(it.piece)) gold.push({ ...it, piece });
  for (const b of s.blocks) {
    if (!b.echo) continue;
    const src = { u0: b.u0 - b.du, u1: b.u1 - b.du, v0: b.v0 - b.dv, v1: b.v1 - b.dv };
    const move = (p: Point) => { const q = s.toBar(p); return s.toPage(q.u + b.du, q.v + b.dv); };
    const inSrc = (p: Point) => { const q = s.toBar(p); return q.u >= src.u0 + 0.5 && q.u <= src.u1 - 0.5 && q.v >= src.v0 + 0.5 && q.v <= src.v1 - 0.5; };
    for (const it of figure) {
      if (!reaches(extent(it.piece), src)) continue;
      for (const piece of keepAlong(it.piece, inSrc, 0.15)) (b.kind === 'gold' ? gold : black).push({ ...it, pen: b.kind === 'gold' ? 'black' : it.pen, piece: piece.map(move) });
    }
  }
  for (const a of s.accents) for (const piece of clipToRect(a.path, ART)) black.push({ pen: a.pen, rank: a.fill ? 0 : 1, id: a.fill ? 'fill' : 'accent', piece });

  // Accent pens are never thinned; the other lines keep clear of them.
  const accents = black.filter(i => ACCENT.includes(i.pen) || i.id === 'eye');
  const byAccent = glyphMask(accents.map(i => i.piece), 0.6, 6, PAGE);
  const lines = thinned(black.filter(i => !ACCENT.includes(i.pen) && i.id !== 'eye').flatMap(i => keepAlong(i.piece, p => !byAccent(p), 0.15).map(piece => ({ ...i, piece }))), LINE_PITCH.gel, options.thin === false);
  for (const i of accents) if (pathLength(i.piece) >= 0.3) { const l = lines.get(i.pen) ?? []; l.push(i.piece); lines.set(i.pen, l); }
  const back = thinned(gold, LINE_PITCH.gel, options.thin === false);
  return {
    black: [...lines].map(([pen, paths]) => ({ id: `black-${pen}`, pen, paths })),
    gold: [...back].map(([pen, paths]) => ({ id: `gold-${pen}`, pen, paths })),
  };
}

let lastWorld: { key: string; s: Scene; art: ReturnType<typeof sheets> } | undefined;
function world(ctx: SketchContext, stage?: HeadStage, quality?: 'draft' | 'full'): { s: Scene; art: ReturnType<typeof sheets> } {
  const key = JSON.stringify([quality ?? 'plot', ctx.seed, Object.entries(ctx.params).filter(([k]) => k !== spec.control).sort(([a], [b]) => (a < b ? -1 : 1))]);
  if (lastWorld?.key !== key) { const s = scene(ctx, stage, { preview: quality !== undefined }); lastWorld = { key, s, art: sheets(s, { thin: quality !== 'draft' }) }; }
  return lastWorld;
}

/** The sketch lab's preview: each sheet's art unclipped and the black's windows, the head meshed on the GPU where there is one. */
export async function labSheets(ctx: SketchContext, quality: 'draft' | 'full' = 'full'): Promise<{ ply: string; parts: Part[]; cuts: Point[][] }[]> {
  const mesher = (await gpuMesher()) ?? cpuMesher;
  const { s, art } = world(ctx, await previewHeadStage(ctx, mesher, quality === 'draft'), quality);
  return [{ ply: 'gold', parts: art.gold, cuts: [] }, { ply: 'black', parts: art.black, cuts: s.window }];
}

function draw(ctx: SketchContext): Part[] {
  const { s, art } = world(ctx);
  const parts = renderPly(spec, ctx, pens, { cuts: { black: [{ id: 'windows', rings: s.window, label: 'W' }] }, art });
  return [...parts, ...landmarks(s)];
}

/** Named page points for the readability crops (`cli/sketch/crops.ts`): diagnostic, never in the SVG. */
function landmarks(s: Scene): Part[] {
  const { noseTip, chin, eyes, mouth } = s.page;
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const at: Record<string, Point> = { nose: noseTip, eyes: mid(eyes[0], eyes[1]), mouth, chin };
  return Object.entries(at).map(([name, p]) => ({ id: `landmark-${name}`, pen: 'cut', paths: [[{ x: p.x, y: p.y }, { x: p.x + 0.01, y: p.y }]], diagnostic: true }));
}

const sketch: Sketch = {
  name: 'Breach / Lodestone: Kawaii Aggro',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls: [plyControl(spec), ...CONTROLS],
  assembly: spec,
  draw,
};

export default sketch;
