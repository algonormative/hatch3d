import type { FormatOptions, Page } from '../../src/sketch/types.ts';
import { adoptRenderTarget, renderTarget, targetPage } from '../../src/sketch/render-target.ts';
import { TABLOID_PAGE, TALL_ART } from '../phase-garden/poster.ts';

/**
 * The format a Breach card is drawn at: its page and everything laid out from it (the card rect, the bands and
 * horizon, the frame's lettering, the depth raster), the scale against tabloid, the pens and their spacing
 * floor, and where the phrase goes.
 *
 * **Where the page comes from.** The cards are page-aware sketches, rendered one per process. The render
 * process publishes the requested page (`finishing.page`) and format options (`--format`) as the render target
 * before it imports the sketch, and this module reads them once, when it loads; see
 * `packages/plot-core/src/render-target.ts`. Everything here is therefore fixed for the life of the process,
 * so the cards' module-level constants (`CARD`, `W`, `MM_X`, ...) can be computed from it. Without a target
 * (tests importing a card, `inspect`) the format is tabloid. A format other than the tabloid preset adopts the
 * target, so a sketch that is not page-aware but loads the kit is re-rendered with nothing published.
 *
 * **Tabloid is the authored format.** Its preset holds the existing constant objects (`TABLOID_PAGE`, the
 * card rect, the horizon), and every helper below returns its input unchanged there, so tabloid renders stay
 * byte-identical.
 *
 * **Other pages** follow tabloid's proportions under one scale `s`. `fit: 'height'` (the default) keeps the
 * vertical framing and crops the sides, so `s` is the page height ratio; `fit: 'width'` keeps the whole width,
 * so `s` is the width ratio and the camera's field of view widens. The card's outer margin is tabloid's 18 mm
 * scaled by the smaller ratio, the bands by `s`. Three kinds of millimetre follow three rules:
 *   - layout (positions and sizes) scales with the card: `layoutX`, `layoutY` (measured from the art window's
 *     centre line and the horizon), `layoutLength`;
 *   - tolerance (what a pen can hold) stays in real millimetres, but never below the pen floor: `tolerance`;
 *   - knockout halos are layout with a floor: `halo` is `max(0.5, s × halo)`.
 * World-unit pitches tuned on tabloid are multiplied by `PITCH_SCALE` (`1 / s`) to hold their on-paper pitch.
 */

export type Fit = 'height' | 'width';
/** Where the card's phrase goes: in the scene, set in the bottom band under the name, or left out. */
export type PhrasePlacement = 'art' | 'band' | 'none';

/** The card on the page: the outer rect (`x0`, `x1`, `top`, `bottom`) and the art window between the bands (`y0`, `y1`). */
export interface CardRect { readonly x0: number; readonly x1: number; readonly top: number; readonly bottom: number; readonly y0: number; readonly y1: number }
export interface Lettering { height: number; tracking: number }
export interface FormatPen { id: string; width: number }

export interface Format {
  /** `tabloid`, or the page size as `WxH` in millimetres. */
  name: string;
  /** Tabloid-sized: the authored layout, where every helper is the identity. */
  tabloid: boolean;
  page: Page;
  fit: Fit;
  /** Layout scale against tabloid. */
  s: number;
  /** Multiplier for world-unit pitches tuned on tabloid: `1 / s`. */
  pitchScale: number;
  /** Page millimetres here per tabloid millimetre, per axis, for measurements taken in tabloid's frame. */
  sheet: { x: number; y: number };
  card: CardRect;
  horizonY: number;
  /** The frame: the gap between each band's pair of rules, the numeral above, the name below, and the phrase's cap height when it sits in the band. */
  frame: { rule: number; numeral: Lettering; name: Lettering; phraseHeight: number };
  pens: FormatPen[];
  /** Closest two parallel strokes may sit on the paper: twice the widest art pen. */
  minSpacing: number;
  phrase: PhrasePlacement;
}

/** Smallest cap height the lettering pen keeps legible, in millimetres. */
export const LEGIBLE_MM = 1.6;
/** The finest depth raster any format uses, in millimetres per pixel. */
const RASTER_MM = 0.25;
const ART_PENS = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'] as const;

/** Tabloid's card: one card per 11 × 17 sheet, bands 24 mm deep above and below the art window. */
const TABLOID_CARD: CardRect = {
  x0: TALL_ART.x, x1: TALL_ART.x + TALL_ART.width,
  top: TALL_ART.y, bottom: TALL_ART.y + TALL_ART.height,
  y0: TALL_ART.y + 24, y1: TALL_ART.y + TALL_ART.height - 24,
} as const;

const pensOf = (art: number, lettering: number): FormatPen[] => [...ART_PENS.map(id => ({ id, width: art })), { id: 'lettering', width: lettering }];

export const TABLOID_FORMAT: Format = {
  name: 'tabloid', tabloid: true, page: TABLOID_PAGE, fit: 'height', s: 1, pitchScale: 1, sheet: { x: 1, y: 1 },
  card: TABLOID_CARD,
  horizonY: TABLOID_CARD.y0 + 0.6 * (TABLOID_CARD.y1 - TABLOID_CARD.y0),
  frame: { rule: 1.2, numeral: { height: 8, tracking: 2.2 }, name: { height: 6.5, tracking: 3.2 }, phraseHeight: 2.2 },
  pens: pensOf(0.25, 0.13), minSpacing: 0.5, phrase: 'art',
};

const sameSize = (a: { width: number; height: number }, b: { width: number; height: number }) => a.width === b.width && a.height === b.height;

function choice<T extends string>(options: FormatOptions, key: string, allowed: readonly T[]): T | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new Error(`Format option ${key} must be one of ${allowed.join(', ')}`);
  return value as T;
}
function width(options: FormatOptions, key: string): number | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !(value > 0 && value <= 2)) throw new Error(`Format option ${key} must be a pen width in millimetres, above 0 and at most 2`);
  return value;
}

/**
 * The format for a page and options. Options: `fit` (`height` | `width`), `phrase` (`art` | `band` | `none`),
 * `pen` (art pen width, mm) and `letteringPen` (mm). A tabloid-sized page with no option that changes anything
 * returns `TABLOID_FORMAT` itself.
 */
export function formatFor(page: Page, options: FormatOptions = {}): Format {
  for (const key of Object.keys(options)) if (!['fit', 'phrase', 'pen', 'letteringPen'].includes(key)) throw new Error(`Unknown format option: ${key}`);
  const tabloid = sameSize(page, TABLOID_PAGE);
  const fit = choice(options, 'fit', ['height', 'width'] as const) ?? 'height';
  const phrase = choice(options, 'phrase', ['art', 'band', 'none'] as const) ?? (tabloid ? 'art' : 'band');
  const artPen = width(options, 'pen') ?? 0.25;
  const letteringPen = width(options, 'letteringPen') ?? 0.13;
  const pens = pensOf(artPen, letteringPen);
  const minSpacing = 2 * artPen;
  if (tabloid) {
    const preset = TABLOID_FORMAT;
    return phrase === preset.phrase && artPen === 0.25 && letteringPen === 0.13 ? preset : { ...preset, phrase, pens, minSpacing };
  }
  const sw = page.width / TABLOID_PAGE.width, sh = page.height / TABLOID_PAGE.height;
  const s = fit === 'width' ? sw : sh;
  const m = TABLOID_CARD.x0 * Math.min(sw, sh);
  const band = (TABLOID_CARD.y0 - TABLOID_CARD.top) * s;
  const card: CardRect = { x0: m, x1: page.width - m, top: m, bottom: page.height - m, y0: m + band, y1: page.height - m - band };
  if (!(card.x1 > card.x0 && card.y1 > card.y0)) throw new Error(`Page ${page.width} × ${page.height} mm leaves no art window`);
  const sized = (base: Lettering): Lettering => {
    const height = Math.max(LEGIBLE_MM, base.height * s);
    return { height, tracking: base.tracking * height / base.height };
  };
  const frame = TABLOID_FORMAT.frame;
  return {
    name: `${page.width}x${page.height}`, tabloid: false, page, fit, s, pitchScale: 1 / s, sheet: { x: sw, y: sh },
    card, horizonY: card.y0 + 0.6 * (card.y1 - card.y0),
    frame: { rule: frame.rule * s, numeral: sized(frame.numeral), name: sized(frame.name), phraseHeight: LEGIBLE_MM },
    pens, minSpacing, phrase,
  };
}

const target = renderTarget();
/** This process's format: from the render target, else tabloid. */
export const FORMAT: Format = target.page || target.format ? formatFor(targetPage(TABLOID_PAGE, target.page), target.format) : TABLOID_FORMAT;
if (FORMAT !== TABLOID_FORMAT) adoptRenderTarget();

export const PAGE: Page = FORMAT.page;
export const CARD: CardRect = FORMAT.card;
/** The set's shared horizon, in page millimetres: 60% of the way down the art window. */
export const HORIZON_Y: number = FORMAT.horizonY;
export const FRAME = FORMAT.frame;
export const FIT: Fit = FORMAT.fit;
export const S: number = FORMAT.s;
export const PITCH_SCALE: number = FORMAT.pitchScale;
export const SHEET = FORMAT.sheet;
export const PENS: readonly FormatPen[] = FORMAT.pens;
export const MIN_SPACING: number = FORMAT.minSpacing;
export const PHRASE: PhrasePlacement = FORMAT.phrase;

/**
 * A card's depth raster. Tabloid keeps the card's own size exactly; any other page is held at 0.25 mm per
 * pixel, or the card's own finer pitch, with the page's aspect.
 */
export function depthRaster(tabloidW: number, tabloidH: number): { W: number; H: number; MM_X: number; MM_Y: number } {
  if (FORMAT.tabloid) return { W: tabloidW, H: tabloidH, MM_X: PAGE.width / tabloidW, MM_Y: PAGE.height / tabloidH };
  const perMm = Math.max(1 / RASTER_MM, tabloidH / TABLOID_PAGE.height);
  const H = Math.ceil(PAGE.height * perMm);
  const W = Math.round(H * PAGE.width / PAGE.height);
  return { W, H, MM_X: PAGE.width / W, MM_Y: PAGE.height / H };
}

const identity = FORMAT.tabloid;
const TABLOID_CENTRE_X = TABLOID_PAGE.width / 2;
/** A layout length authored in tabloid millimetres. */
export const layoutLength = (mm: number): number => identity ? mm : mm * S;
/** A page x authored on tabloid, measured from the art window's centre line. */
export const layoutX = (x: number): number => identity ? x : PAGE.width / 2 + (x - TABLOID_CENTRE_X) * S;
/** A page y authored on tabloid, measured from the horizon. */
export const layoutY = (y: number): number => identity ? y : HORIZON_Y + (y - TABLOID_FORMAT.horizonY) * S;
/** A tolerance in real millimetres, never below the pen floor (by default the format's minimum spacing). */
export const tolerance = (mm: number, floor = MIN_SPACING): number => identity ? mm : Math.max(mm, floor);
/** A knockout halo authored in tabloid millimetres: scaled with the card, never under 0.5 mm. */
export const halo = (mm: number): number => identity ? mm : Math.max(0.5, S * mm);
/** A vertical field of view, in degrees, under the format's fit: unchanged for `height`, widened for `width` so tabloid's width still fits. */
export function fitFov(deg: number): number {
  if (identity || FIT === 'height') return deg;
  const t = Math.tan(deg * Math.PI / 360) * SHEET.y / SHEET.x;
  return Math.atan(t) * 360 / Math.PI;
}

/** Throw unless a card is drawing on the page this module laid out for (`ctx.page`, or the declared page in direct calls). */
export function assertFormatPage(page: { width: number; height: number } | undefined): void {
  const drawn = page ?? TABLOID_PAGE;
  if (!sameSize(drawn, PAGE)) throw new Error(`The card is drawing on ${drawn.width} × ${drawn.height} mm, but its format loaded for ${PAGE.width} × ${PAGE.height} mm`);
}
