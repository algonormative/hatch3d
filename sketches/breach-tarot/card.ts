import type { Part, Point } from '../../src/sketch/types.ts';
import { measureStrokeText, strokeText } from '../../src/sketch/stroke-text.ts';
import { TALL_ART } from '../phase-garden/poster.ts';

/**
 * The Breach Tarot card: one card per 11 × 17 sheet. A numeral band at the top and a name band
 * at the bottom, both in the Breach Cathedral face, frame the art window between them.
 * Every card shares HORIZON_Y, so any three cards laid side by side make one landscape.
 */
export const CARD = {
  x0: TALL_ART.x, x1: TALL_ART.x + TALL_ART.width,
  top: TALL_ART.y, bottom: TALL_ART.y + TALL_ART.height,
  /** The art window, between the two bands. */
  y0: TALL_ART.y + 24, y1: TALL_ART.y + TALL_ART.height - 24,
} as const;
/** The set's shared horizon, in page millimetres: 60% of the way down the art window. */
export const HORIZON_Y = CARD.y0 + 0.6 * (CARD.y1 - CARD.y0);

const centred = (text: string, cy: number, height: number, tracking: number): Point[][] => {
  const style = { face: 'cathedral' as const, height, tracking };
  const width = measureStrokeText(text, style);
  return strokeText(text, (CARD.x0 + CARD.x1) / 2 - width / 2, cy - height / 2, style);
};

/** Numeral above, name below, each between a pair of fine rules. */
export function cardFrame(numeral: string, name: string, pen = 'carbon'): Part[] {
  const rule = (y: number): Point[] => [{ x: CARD.x0, y }, { x: CARD.x1, y }];
  const paths: Point[][] = [
    rule(CARD.y0), rule(CARD.y0 - 1.2), rule(CARD.y1), rule(CARD.y1 + 1.2),
    ...centred(numeral, (CARD.top + CARD.y0 - 1.2) / 2, 8, 2.2),
    ...centred(name, (CARD.y1 + 1.2 + CARD.bottom) / 2, 6.5, 3.2),
  ];
  return [{ id: 'card-frame', pen, paths }];
}

/** Liang–Barsky clip of a page polyline to the art window. */
export function clipWindow(points: Point[], box = CARD): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  const flush = () => { if (run.length >= 2) runs.push(run); run = []; };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    let enter = 0, exit = 1;
    for (const [p, q] of [[-dx, a.x - box.x0], [dx, box.x1 - a.x], [-dy, a.y - box.y0], [dy, box.y1 - a.y]]) {
      if (p === 0) { if (q < 0) { enter = 1; exit = 0; break; } }
      else { const t = q / p; if (p < 0) enter = Math.max(enter, t); else exit = Math.min(exit, t); }
    }
    if (enter > exit) { flush(); continue; }
    const at = (t: number): Point => ({ x: a.x + dx * t, y: a.y + dy * t });
    const start = at(enter), end = at(exit);
    if (run.length && (Math.hypot(run[run.length - 1].x - start.x, run[run.length - 1].y - start.y) > 0.001 || enter > 0)) flush();
    if (!run.length) run.push(start);
    run.push(end);
    if (exit < 1) flush();
  }
  flush();
  return runs;
}
