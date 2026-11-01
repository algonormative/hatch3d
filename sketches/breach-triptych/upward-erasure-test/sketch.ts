import type { Control, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { inRegion } from '../../../packages/plot-core/src/region.ts';
import { clipToRect, type Rect } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { traceMask } from '../../kit/outline.ts';
import { rect, stripeFill } from '../lodestone-cuts.ts';
import { pens, sheets, spec } from '../upward-erasure/sketch.ts';
import { CONTROLS, erasure } from '../upward-erasure/world.ts';

/**
 * Upward Erasure's test sheet (vault-l9j56): before the full 11 x 17 sheets, an A4 pair (black over gold-yellow, cut
 * as the piece is) that proves the inks and the cutting on a window of the real drawing, `TEST.w` x `TEST.h` mm from
 * (`testX`, `testY`) on the full sheet (by default round the nose and the visor: plates, seams, the nose over the
 * visor, the pink line, the glitch's first pieces), and a strip below it for `plotter widths`:
 *
 * - four silver hatch patches at 0.8, 0.95, 1.1 and 1.3 mm (left to right), each with a gold seam down its middle;
 * - a fluoro pink line under them;
 * - two windows onto the gold, hatched in Micron 08 black at 0.8 and 1.2 mm (left, right).
 *
 * Every parameter of the piece applies; the test window is the piece's, moved onto the A4 sheet.
 */

const PAGE = { width: 210, height: 297, margin: 11 };
const TEST = { w: 120, h: 160, at: { x: (PAGE.width - 120) / 2, y: 22 } };
const PATCH = { y: 200, h: 16, w: 36, xs: [20, 64, 108, 152], pitches: [0.8, 0.95, 1.1, 1.3] };

const controls: Control[] = [
  plyControl(spec),
  { type: 'slider', id: 'testX', label: 'Test window left edge on the full sheet', default: 125, min: 11, max: 148, step: 1, units: 'mm', group: 'Test' },
  { type: 'slider', id: 'testY', label: 'Test window top edge on the full sheet', default: 95, min: 11, max: 260, step: 1, units: 'mm', group: 'Test' },
  ...CONTROLS,
];

function draw(ctx: SketchContext): Part[] {
  const from: Rect = { x0: n(ctx, 'testX', 125, 11, 148), y0: n(ctx, 'testY', 95, 11, 260), x1: 0, y1: 0 };
  from.x1 = from.x0 + TEST.w; from.y1 = from.y0 + TEST.h;
  const dx = TEST.at.x - from.x0, dy = TEST.at.y - from.y0;
  const move = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  const e = erasure(ctx);
  const art = sheets(e);
  const moved = (parts: Part[]) => parts.map(part => ({ ...part, paths: part.paths.flatMap(path => clipToRect(path, from)).map(path => path.map(move)) })).filter(part => part.paths.length);

  // The windows: the piece's, within the test window, moved; and the strip's two onto the gold.
  const strip = [rect(20, 240, 98, 252), rect(112, 240, 190, 252)];
  const placed: Rect = { x0: TEST.at.x, y0: TEST.at.y, x1: TEST.at.x + TEST.w, y1: TEST.at.y + TEST.h };
  const inWindow = (p: Point) => p.x > placed.x0 && p.x < placed.x1 && p.y > placed.y0 && p.y < placed.y1 && inRegion({ x: p.x - dx, y: p.y - dy }, { rings: e.window });
  const window = traceMask(inWindow, { x0: placed.x0, x1: placed.x1, y0: placed.y0, y1: placed.y1 }, 0.25, { simplify: 0.08, minRadius: 1.2, minArea: 6 });

  // The strip.
  const silver: Point[][] = [], gold: Point[][] = [], pink: Point[][] = [[{ x: 20, y: 226 }, { x: 188, y: 226 }]];
  PATCH.xs.forEach((x, i) => {
    silver.push(...stripeFill(rect(x, PATCH.y, x + PATCH.w, PATCH.y + PATCH.h), Math.PI / 4, PATCH.pitches[i], 0));
    gold.push([{ x: x + PATCH.w / 2, y: PATCH.y - 2 }, { x: x + PATCH.w / 2, y: PATCH.y + PATCH.h + 2 }]);
  });
  const under = strip.flatMap((r, i) => stripeFill(r, -Math.PI / 4, i ? 1.2 : 0.8, 3));

  return renderPly(spec, { ...ctx, page: PAGE }, pens, {
    cuts: { black: [{ id: 'windows', rings: [...window, ...strip], label: 'W' }] },
    art: {
      black: [...moved(art.black), { id: 'strip-silver', pen: 'silver', paths: silver }, { id: 'strip-gold', pen: 'gold', paths: gold }, { id: 'strip-pink', pen: 'fluoro-pink', paths: pink }],
      gold: [...moved(art.gold), { id: 'strip-black', pen: 'black', paths: under }],
    },
  });
}

const sketch: Sketch = {
  name: 'Breach / Lodestone: Upward Erasure test sheet',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls,
  assembly: spec,
  draw,
};

export default sketch;
