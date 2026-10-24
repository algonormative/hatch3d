import type { AssemblySpec, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { distanceToRings } from '../../../packages/plot-core/src/region.ts';
import { thinRanked } from '../../kit/density.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, keepAlong, pathLength } from '../../kit/page.ts';
import { ALONGSIDE_DEG, LINE_PITCH, LODESTONE_ASSEMBLY } from '../lodestone-world.ts';
import { ART, PAGE, PAPER, pensOf } from '../world.ts';
import { CONTROLS, erasure, panelStripes, type Erasure, type Seen, type WhitePen } from './world.ts';

/**
 * Upward Erasure (a Lodestone study, after the character concept of 2026-10-21): see `./world.ts`. Three sheets, back
 * to front: the white (the drawing), the black (the bust cut out, the crown's slices, silver ribbons), and the
 * gold-yellow pieces glued on top (the bar and its fragments, cut from the sheet `upward-erasure-gold`).
 */

export const plies = [
  { id: 'white', paper: PAPER.white, pens: ['carbon', 'ultramarine', 'fluoro-pink'], cutInk: 'carbon' },
  { id: 'black', paper: PAPER.black, pens: ['silver'], cutInk: 'silver' },
  { id: 'gold', paper: PAPER.gold, pens: [], cutInk: 'black', onlay: { from: 'upward-erasure-gold/gold/pieces' } },
];
export const spec: AssemblySpec = { ...LODESTONE_ASSEMBLY, plies };
const pens = pensOf(['carbon', 'ultramarine', 'fluoro-pink', 'silver', 'black']);

/** The closest two lines of a pen may run alongside (mm): the Micron 01 on white, the Micron 05 blue, the gels. */
const LIMIT: Record<WhitePen, number> = { carbon: LINE_PITCH.micron01, ultramarine: 0.66, 'fluoro-pink': LINE_PITCH.gel };

/** The white sheet's art: the head (its crown's slices drawn where they have been lifted to), the suit over the neck. */
export function whiteArt(e: Erasure): Part[] {
  const assembled = e.slices.length > 0;
  const inCrown = (p: Point) => assembled && e.slices.some(sl => p.x >= sl.x0 && p.x <= sl.x1) && p.y < e.barTop(p.x) + 4;
  const inBase = (p: Point) => e.slices.some(sl => p.x >= sl.x0 && p.x <= sl.x1 && sl.windows.some(w => w.dy === 0 && p.y >= w.y0 && p.y <= w.y1));
  const items: (Seen & { piece: Point[] })[] = [];
  const keep = (s: Seen, test: (p: Point) => boolean, dy = 0) => {
    for (const piece of keepAlong(s.piece, test, 0.15)) {
      const moved = dy ? piece.map(p => ({ x: p.x, y: p.y - dy })) : piece;
      for (const inside of clipToRect(moved, ART)) if (pathLength(inside) >= 0.6) items.push({ ...s, piece: inside });
    }
  };
  // The silhouette where the black's edge is cut along it would show as a broken line beside the edge: left to the cut.
  const byEdge = (p: Point) => distanceToRings(p, e.window) < 0.9;
  for (const s of e.head) {
    keep(s, p => !e.bySuit(p) && (!inCrown(p) || inBase(p)) && (s.id !== 'outline' || !byEdge(p)));
    for (const sl of e.slices) for (const w of sl.windows) if (w.dy) keep(s, p => p.x >= sl.x0 && p.x <= sl.x1 && p.y >= w.y0 && p.y <= w.y1, w.dy);
  }
  const pink = items.filter(i => i.pen === 'fluoro-pink').map(i => i.piece);
  const byPink = glyphMask(pink, 0.7, 6, PAGE);
  const out = new Map<string, Point[][]>();
  const put = (pen: string, path: Point[]) => { const l = out.get(pen) ?? []; l.push(path); out.set(pen, l); };
  for (const p of pink) put('fluoro-pink', p);
  const suitItems = [
    ...e.panels.flatMap(p => panelStripes(p).map(piece => ({ pen: p.pen, rank: 2, id: p.id, piece }))),
    ...e.suitLines.flatMap(l => clipToRect(l.path, ART).flatMap(piece => (l.behind ? keepAlong(piece, p => !e.onHead(p), 0.15) : [piece])).map(piece => ({ pen: l.pen, rank: 0, id: 'suit-line', piece }))),
  ];
  for (const pen of ['carbon', 'ultramarine'] as const) {
    const list = [...items, ...suitItems].filter(s => s.pen === pen).flatMap(s => keepAlong(s.piece, p => !byPink(p), 0.15).map(piece => ({ ...s, piece })));
    for (const { runs } of thinRanked(list, LIMIT[pen], { angle: ALONGSIDE_DEG })) for (const r of runs) if (pathLength(r) >= 0.6) put(pen, r);
  }
  return [...out].map(([pen, paths]) => ({ id: `white-${pen}`, pen, paths }));
}

function draw(ctx: SketchContext): Part[] {
  const e = erasure(ctx);
  const art = {
    white: whiteArt(e),
    black: [{ id: 'ribbons-silver', pen: 'silver', paths: e.ribbons.flatMap(r => clipToRect(r, ART)) }],
  };
  const cuts = {
    black: [{ id: 'bust', rings: e.window, label: 'BUST' }],
    gold: [{ id: 'pieces', kind: 'footprint' as const, rings: [e.bar, ...e.fragments] }],
  };
  return renderPly(spec, ctx, pens, { cuts, art });
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
