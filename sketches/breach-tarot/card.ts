import type { Part, Point } from '../../src/sketch/types.ts';
import { measureStrokeText, strokeText } from '../../src/sketch/stroke-text.ts';
import { clipToRect, type Rect } from '../kit/page.ts';
import { CARD, FRAME } from '../kit/format.ts';

/**
 * The Breach Tarot card. A numeral band at the top and a name band at the bottom, both in the Breach
 * Cathedral face, frame the art window between them. The card rect, the bands, the frame's lettering and
 * the set's shared horizon come from the format (`kit/format.ts`). At tabloid that is one card per
 * 11 × 17 sheet, and every card shares HORIZON_Y, so any three cards laid side by side make one landscape.
 */
export { CARD, HORIZON_Y } from '../kit/format.ts';

const centred = (text: string, cy: number, height: number, tracking: number): Point[][] => {
  const style = { face: 'cathedral' as const, height, tracking };
  const width = measureStrokeText(text, style);
  return strokeText(text, (CARD.x0 + CARD.x1) / 2 - width / 2, cy - height / 2, style);
};

/** Numeral above, name below, each between a pair of fine rules. */
export function cardFrame(numeral: string, name: string, pen = 'carbon'): Part[] {
  const { rule: gap, numeral: above, name: below } = FRAME;
  const rule = (y: number): Point[] => [{ x: CARD.x0, y }, { x: CARD.x1, y }];
  const paths: Point[][] = [
    rule(CARD.y0), rule(CARD.y0 - gap), rule(CARD.y1), rule(CARD.y1 + gap),
    ...centred(numeral, (CARD.top + CARD.y0 - gap) / 2, above.height, above.tracking),
    ...centred(name, (CARD.y1 + gap + CARD.bottom) / 2, below.height, below.tracking),
  ];
  return [{ id: 'card-frame', pen, paths }];
}

/** A page polyline clipped to the art window (or another box). */
export const clipWindow = (points: Point[], box: Rect = CARD): Point[][] => clipToRect(points, box);
