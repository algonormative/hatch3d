import type { AssemblySpec, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { thinRanked } from '../../kit/density.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, keepAlong, pathLength } from '../../kit/page.ts';
import { rect } from '../lodestone-cuts.ts';
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
  const assembled = e.slices.length > 0;
  const inCrown = (p: Point) => assembled && e.slices.some(sl => p.x >= sl.x0 && p.x <= sl.x1) && p.y < e.barTop(p.x) + 4;
  const inBase = (p: Point) => e.slices.some(sl => p.x >= sl.x0 && p.x <= sl.x1 && sl.windows.some(w => w.kind === 'base' && p.y >= w.y0 && p.y <= w.y1));
  const black: Item[] = [], gold: Item[] = [];
  const keep = (into: Item[], s: Seen, test: (p: Point) => boolean, dy = 0, pen: Pen = s.pen) => {
    for (const piece of keepAlong(s.piece, test, 0.15)) {
      const moved = dy ? piece.map(p => ({ x: p.x, y: p.y - dy })) : piece;
      for (const inside of clipToRect(moved, ART)) if (pathLength(inside) >= 0.6) into.push({ ...s, pen, piece: inside });
    }
  };
  for (const s of e.head) {
    keep(black, s, p => !e.bySuit(p) && (!inCrown(p) || inBase(p)));
    // The lifted pieces: drawn again higher, on the black or (in black ink) on the gold through a window.
    for (const sl of e.slices) for (const w of sl.windows) {
      if (w.kind === 'base' || s.pen === 'fluoro-pink') continue;
      keep(w.kind === 'gold' ? gold : black, s, p => p.x >= sl.x0 + 0.6 && p.x <= sl.x1 - 0.6 && p.y >= w.y0 + 0.6 && p.y <= w.y1 - 0.6, w.dy, w.kind === 'gold' ? 'black' : s.pen);
    }
  }
  // Each piece lifted on the black framed in gold.
  for (const sl of e.slices) for (const w of sl.windows) if (w.kind === 'black') {
    const r = rect(sl.x0, w.y0 - w.dy, sl.x1, w.y1 - w.dy);
    black.push({ pen: 'gold', rank: 0, id: 'frame', piece: [...r, r[0]] });
  }
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

function draw(ctx: SketchContext): Part[] {
  const e = erasure(ctx);
  return renderPly(spec, ctx, pens, { cuts: { black: [{ id: 'windows', rings: e.window, label: 'W' }] }, art: sheets(e) });
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
