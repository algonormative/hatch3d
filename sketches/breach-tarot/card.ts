import type { Part, Point } from '../../src/sketch/types.ts';
import { measureStrokeText, strokeText } from '../../src/sketch/stroke-text.ts';
import { TALL_ART } from '../phase-garden/poster.ts';
import { clipToRect, type Rect } from '../kit/page.ts';

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

/** A page polyline clipped to the art window (or another box). */
export const clipWindow = (points: Point[], box: Rect = CARD): Point[][] => clipToRect(points, box);
