import type { Part, Point } from '../../src/sketch/types.ts';
import { measureStrokeText, strokeText, type StrokeFace } from '../../src/sketch/stroke-text.ts';
import { clipToRect, type Rect } from '../kit/page.ts';
import { CARD, FRAME, PHRASE } from '../kit/format.ts';

/**
 * The Breach Tarot card. A numeral band at the top and a name band at the bottom, both in the Breach
 * Cathedral face, frame the art window between them. The card rect, the bands, the frame's lettering and
 * the set's shared horizon come from the format (`kit/format.ts`). At tabloid that is one card per
 * 11 × 17 sheet, and every card shares HORIZON_Y, so any three cards laid side by side make one landscape.
 * Where the format puts the phrase in the band (`PHRASE` is `band`), the frame sets it under the name.
 */
export { CARD, HORIZON_Y } from '../kit/format.ts';

const centred = (text: string, cy: number, height: number, tracking: number): Point[][] => {
  const style = { face: 'cathedral' as const, height, tracking };
  const width = measureStrokeText(text, style);
  return strokeText(text, (CARD.x0 + CARD.x1) / 2 - width / 2, cy - height / 2, style);
};

/**
 * The card's phrase, for the band: its text, face and pen. A card's `sloganSettings(ctx)` fits as it is; an empty
 * text, or a count of 0, sets nothing.
 */
export interface CardPhrase { text: string; face?: StrokeFace; count?: number; pen?: string }

export interface FrameOptions {
  /** The frame's pen (rules, numeral and name). Default carbon. */
  pen?: string;
  /** The phrase, set in the bottom band when the format puts it there; ignored otherwise. */
  phrase?: CardPhrase;
}

/** Room either side of the band phrase, as a fraction of the card's width. */
const PHRASE_INSET = 0.06;

/**
 * Numeral above, name below, each between a pair of fine rules. When the format puts the phrase in the band
 * (`PHRASE` is `band`) and the card passes one, the name moves up and the phrase is set once beneath it, centred,
 * in the lettering pen at `FRAME.phraseHeight`, as its own part (`card-phrase`). A phrase too long for the card at
 * that height is tracked tighter, then set smaller to fit.
 */
export function cardFrame(numeral: string, name: string, options: FrameOptions = {}): Part[] {
  const pen = options.pen ?? 'carbon';
  const { rule: gap, numeral: above, name: below, phraseHeight } = FRAME;
  const rule = (y: number): Point[] => [{ x: CARD.x0, y }, { x: CARD.x1, y }];
  const paths: Point[][] = [
    rule(CARD.y0), rule(CARD.y0 - gap), rule(CARD.y1), rule(CARD.y1 + gap),
    ...centred(numeral, (CARD.top + CARD.y0 - gap) / 2, above.height, above.tracking),
  ];
  const phrase = PHRASE === 'band' && options.phrase && options.phrase.count !== 0 ? options.phrase.text.trim() : '';
  if (!phrase) {
    paths.push(...centred(name, (CARD.y1 + gap + CARD.bottom) / 2, below.height, below.tracking));
    return [{ id: 'card-frame', pen, paths }];
  }
  // The phrase's style: the face's own tracking, tightened, then the height reduced, until it fits the card.
  const room = (CARD.x1 - CARD.x0) * (1 - 2 * PHRASE_INSET);
  const face = options.phrase!.face ?? 'cathedral';
  let style: { face: StrokeFace; height: number; tracking?: number } = { face, height: phraseHeight };
  if (measureStrokeText(phrase, style) > room) {
    // Cathedral tracks in grid units (an eighth of the cap height), 2.3 by default; the Hershey faces from 0.
    const tight = face === 'cathedral' ? { ...style, tracking: 1.2 } : style;
    const width = measureStrokeText(phrase, tight);
    style = width > room ? { ...tight, height: phraseHeight * room / width } : tight;
  }
  // Name above, phrase below; the pair, from the name's cap line to the phrase's descenders, centred in the band.
  const lead = 0.5 * style.height, descender = 3 / 8 * style.height;
  const block = below.height + lead + style.height + descender;
  const top = (CARD.y1 + gap + CARD.bottom) / 2 - block / 2;
  paths.push(...centred(name, top + below.height / 2, below.height, below.tracking));
  const width = measureStrokeText(phrase, style);
  const set = strokeText(phrase, (CARD.x0 + CARD.x1) / 2 - width / 2, top + below.height + lead, style);
  return [{ id: 'card-frame', pen, paths }, { id: 'card-phrase', pen: options.phrase!.pen ?? 'lettering', paths: set }];
}

/** A page polyline clipped to the art window (or another box). */
export const clipWindow = (points: Point[], box: Rect = CARD): Point[][] => clipToRect(points, box);
