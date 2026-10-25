import type { AssemblySpec, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { thinRanked } from '../../kit/density.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, keepAlong, pathLength } from '../../kit/page.ts';
import { ALONGSIDE_DEG, FILL_OVER, LINE_PITCH, LODESTONE_ASSEMBLY } from '../lodestone-world.ts';
import { ART, PAGE, PAPER, pensOf } from '../world.ts';
import { CONTROLS, erasure, panelStripes, type Erasure, type Pen, type Seen } from './world.ts';

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
function thinned(items: Item[], pitch: number): Map<string, Point[][]> {
  const out = new Map<string, Point[][]>();
  for (const { item, runs } of thinRanked(items, pitch, { angle: ALONGSIDE_DEG })) for (const r of runs) if (pathLength(r) >= 0.6) { const l = out.get(item.pen) ?? []; l.push(r); out.set(item.pen, l); }
  return out;
}

/** The two sheets' art. */
export function sheets(e: Erasure): { black: Part[]; gold: Part[] } {
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
    // On the black: the head where the glitch leaves it, the bands below the visor drawn shifted along it.
    keep(black, s, p => !e.bySuit(p) && !e.erased(p) && !spilled(p));
    for (const b of e.spill) keep(black, s, p => !e.bySuit(p) && spillable(p) && inBox(-1e9, 1e9, b.v0, b.v1)(p), shift(b.du, 0));
    if (s.pen === 'fluoro-pink') continue;
    // On the gold, in black ink: the eyes behind the visor in shifted bands, the head smeared up the gold columns, and
    // the pieces lifted onto the gold. On the black, the pieces lifted there.
    for (const b of e.visorBands) keep(gold, s, inBox(-1e9, 1e9, b.v0, b.v1), shift(b.du, 0), 'black');
    for (const c of e.cells) {
      if (c.kind === 'base') continue;
      const from = c.kind === 'rise' ? inBox(c.u0 + 0.6, c.u1 - 0.6, c.v0, c.v1 - c.dv) : inBox(c.u0 + 0.6, c.u1 - 0.6, c.v0 + 0.6, c.v1 - 0.6);
      keep(c.kind === 'black' ? black : gold, s, from, shift(0, c.dv), c.kind === 'black' ? s.pen : 'black');
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

  const pink = black.filter(i => i.pen === 'fluoro-pink').map(i => i.piece);
  const byPink = glyphMask(pink, 0.9, 6, PAGE);
  const lines = thinned(black.filter(i => i.pen !== 'fluoro-pink').flatMap(i => keepAlong(i.piece, p => !byPink(p), 0.15).map(piece => ({ ...i, piece }))), LINE_PITCH.gel);
  lines.set('fluoro-pink', pink);
  const under = thinned(gold, LINE_PITCH.gel);
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
function draw(ctx: SketchContext): Part[] {
  const key = JSON.stringify([ctx.seed, Object.entries(ctx.params).filter(([k]) => k !== spec.control).sort(([a], [b]) => (a < b ? -1 : 1))]);
  if (lastWorld?.key !== key) { const e = erasure(ctx); lastWorld = { key, e, art: sheets(e) }; }
  const { e, art } = lastWorld;
  return renderPly(spec, ctx, pens, { cuts: { black: [{ id: 'windows', rings: e.window, label: 'W' }] }, art });
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
