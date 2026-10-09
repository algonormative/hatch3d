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
 * byte-identical. That holds for tabloid with its 18 mm margin, which every print uses: a tabloid page with
 * another margin lays the card out from that margin, like any other page, and makes no byte-identity promise.
 *
 * **Other pages** follow tabloid's proportions under one scale `s`. `fit: 'height'` (the default) keeps the
 * vertical framing and crops the sides, so `s` is the page height ratio; `fit: 'width'` keeps the whole width,
 * so `s` is the width ratio and the camera's field of view widens. The card's outer edge sits on the page
 * margin (as tabloid's does at 18 mm; without one, tabloid's 18 mm scaled by the smaller ratio), and the bands
 * scale by `s`. Three kinds of millimetre follow three rules:
 *   - layout (positions and sizes) scales with the card: `layoutX`, `layoutY` (measured from the art window's
 *     centre line and the horizon), `layoutLength`;
 *   - tolerance (what a pen can hold) stays in real millimetres, but never below the pen floor: `tolerance`;
 *   - knockout halos are layout with a floor: `halo` is `max(0.5, s × halo)`.
 * World-unit pitches tuned on tabloid are multiplied by `PITCH_SCALE` (`1 / s`) to hold their on-paper pitch.
 *
 * **Porting a card.** Every helper is the identity at tabloid (`S` is 1 there too), so a ported card's tabloid
 * render stays byte-identical. Write each tabloid literal through the rule for its kind:
 *   - a place in the scene (a 3D anchor picked on the page, a cull bound): the tabloid page position through
 *     `layoutX` / `layoutY`, e.g. `layoutY(TABLOID_CARD.y1 - 32)`, `layoutX(TABLOID_CARD.x0 - 40)`. The scene then
 *     keeps its world (same anchors, same seeded layout) and scales by `S`; `fit: 'height'` crops its sides;
 *   - an offset from the horizon or a band edge: `HORIZON_Y + layoutLength(22)`, `CARD.y1 - layoutLength(6)`;
 *   - a flat mark placed in the window: fractions of `CARD`, as before; its size `layoutLength(18)`;
 *   - a pitch, gap, dash or minimum length, a lettering size: real millimetres, `tolerance(0.62)` where it could
 *     fall under the pen floor; a knockout halo: `halo(2.2)`;
 *   - a count that is really density: `scaledCount(80, 24)` (by the window's area), `scaledCount(80, 24, 'length')`
 *     (by `S`, for things spaced along a length that scales with the card, like rays round a sun); to keep that many
 *     of a seeded set, `evenlyKept(i, kept / total)` on each one's seeded index;
 *   - a feature smaller than `MIN_FEATURE` millimetres on paper (0 at tabloid): draw it as an outline or a single
 *     line, or drop it;
 *   - a page length fed to a gradient tuned on tabloid: back in tabloid millimetres as `length / S`.
 * The phrase: where `PHRASE` is `band` the card draws no words in the art and passes its phrase to `cardFrame`. A title
 * (`titleEnabled`) is lettered in the art with the phrase, so where the phrase leaves the art (`band`, `none`) the
 * card carries no title; the band has no room for one.
 * Check the result against the card's tabloid print with the density probe: `denserThan` in `kit/density.ts`, or
 * `npm run -s density -- small/result.json --against tabloid/result.json`. The Fool is the worked example.
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
  /** Smallest feature drawn as a shape, in millimetres on paper: 0 at tabloid, where the print keeps all it has. */
  minFeature: number;
  phrase: PhrasePlacement;
}

/** Smallest cap height the lettering pen keeps legible, in millimetres. */
export const LEGIBLE_MM = 1.6;
/** Smallest feature a format other than tabloid draws as a shape, in millimetres on paper. */
const FEATURE_MM = 1;
/** The finest depth raster any format uses, in millimetres per pixel. */
const RASTER_MM = 0.25;
/** The CPU depth buffer's pixel budget (`MAX_PIXELS` in src/sketch/depth-buffer.ts). */
const RASTER_BUDGET = 4_194_304;
const ART_PENS = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'] as const;

/** Tabloid's card: one card per 11 × 17 sheet, bands 24 mm deep above and below the art window. Tabloid literals are authored in its frame. */
export const TABLOID_CARD: CardRect = {
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
  pens: pensOf(0.25, 0.13), minSpacing: 0.5, minFeature: 0, phrase: 'art',
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
 * `pen` (art pen width, mm) and `letteringPen` (mm). A tabloid page with its 18 mm margin (or none) and no
 * option that changes anything returns `TABLOID_FORMAT` itself. The card's outer edge sits on the page margin.
 */
export function formatFor(page: Page, options: FormatOptions = {}): Format {
  for (const key of Object.keys(options)) if (!['fit', 'phrase', 'pen', 'letteringPen'].includes(key)) throw new Error(`Unknown format option: ${key}`);
  const tabloid = sameSize(page, TABLOID_PAGE) && (page.margin === undefined || page.margin === TABLOID_PAGE.margin);
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
  const m = page.margin ?? TABLOID_CARD.x0 * Math.min(sw, sh);
  const band = (TABLOID_CARD.y0 - TABLOID_CARD.top) * s;
  const card: CardRect = { x0: m, x1: page.width - m, top: m, bottom: page.height - m, y0: m + band, y1: page.height - m - band };
  if (!(card.x1 > card.x0 && card.y1 > card.y0)) {
    throw new Error(`A ${page.width} × ${page.height} mm page with a ${m} mm margin leaves no room for the card's ${band.toFixed(2)} mm bands and an art window`);
  }
  // Tracking is in the face's grid units, which already scale with the cap height.
  const sized = (base: Lettering): Lettering => ({ height: Math.max(LEGIBLE_MM, base.height * s), tracking: base.tracking });
  const frame = TABLOID_FORMAT.frame;
  return {
    name: `${page.width}x${page.height}`, tabloid: false, page, fit, s, pitchScale: 1 / s, sheet: { x: sw, y: sh },
    card, horizonY: card.y0 + 0.6 * (card.y1 - card.y0),
    // The band's double rule scales with the card, but stays far enough apart to print as two lines.
    frame: { rule: Math.max(frame.rule * s, 1.5 * minSpacing), numeral: sized(frame.numeral), name: sized(frame.name), phraseHeight: LEGIBLE_MM },
    pens, minSpacing, minFeature: FEATURE_MM, phrase,
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
/**
 * Smallest feature this format draws as a shape, in millimetres on paper: anything smaller is drawn as an outline or
 * a single line, or dropped. 0 at tabloid, so a card's gate on it is a no-op there.
 */
export const MIN_FEATURE: number = FORMAT.minFeature;
export const PHRASE: PhrasePlacement = FORMAT.phrase;

export interface Raster { W: number; H: number; MM_X: number; MM_Y: number }

/**
 * A card's depth raster on a format's page. Tabloid keeps the card's own size exactly. Any other page is held at
 * 0.25 mm per pixel, or the card's own finer pitch, with the page's aspect, but never so fine that the largest
 * raster the card builds from it (`oversample` times each side) passes the depth buffer's pixel budget.
 */
export function rasterFor(format: Format, tabloidW: number, tabloidH: number, oversample = 1): Raster {
  const page = format.page;
  if (format.tabloid) return { W: tabloidW, H: tabloidH, MM_X: page.width / tabloidW, MM_Y: page.height / tabloidH };
  const finest = Math.max(1 / RASTER_MM, tabloidH / TABLOID_PAGE.height);
  const budget = Math.sqrt(RASTER_BUDGET / (page.width * page.height)) / oversample;
  const aspect = page.width / page.height;
  const fits = (h: number) => (Math.round(h * aspect) * oversample) * (h * oversample) <= RASTER_BUDGET;
  const skew = (h: number) => Math.abs(Math.round(h * aspect) / h - aspect);
  let H = Math.ceil(page.height * Math.min(finest, budget));
  while (!fits(H)) H--;
  // The camera's aspect is the raster's, so take the height (up to 5% finer, within budget) whose width keeps the
  // page's aspect most nearly: page x then matches `layoutX`, and a cull tested on the page keeps tabloid's choices.
  const first = H;
  for (let h = first + 1; skew(H) > 0 && h <= first * 1.05 && fits(h); h++) if (skew(h) < skew(H)) H = h;
  const W = Math.round(H * aspect);
  return { W, H, MM_X: page.width / W, MM_Y: page.height / H };
}

/** This process's depth raster for a card whose tabloid raster is `tabloidW × tabloidH` (see `rasterFor`). */
export const depthRaster = (tabloidW: number, tabloidH: number, oversample = 1): Raster => rasterFor(FORMAT, tabloidW, tabloidH, oversample);

const identity = FORMAT.tabloid;
const TABLOID_CENTRE_X = TABLOID_PAGE.width / 2;
/** Tabloid's horizon, in tabloid page millimetres: the line `layoutY` measures from. */
export const TABLOID_HORIZON_Y: number = TABLOID_FORMAT.horizonY;
const windowArea = (card: CardRect) => (card.x1 - card.x0) * (card.y1 - card.y0);
/** The art window's area against tabloid's (1 at tabloid). */
export const AREA: number = identity ? 1 : windowArea(CARD) / windowArea(TABLOID_CARD);
/** A layout length authored in tabloid millimetres. */
export const layoutLength = (mm: number): number => identity ? mm : mm * S;
/** A page x authored on tabloid, measured from the art window's centre line. */
export const layoutX = (x: number): number => identity ? x : PAGE.width / 2 + (x - TABLOID_CENTRE_X) * S;
/** A page y authored on tabloid, measured from the horizon. */
export const layoutY = (y: number): number => identity ? y : HORIZON_Y + (y - TABLOID_FORMAT.horizonY) * S;
/**
 * A tolerance in real millimetres, never below the pen floor (by default the format's minimum spacing). At tabloid
 * with its own pens it is the identity; a `pen` option on a tabloid page sets the floor there too.
 */
export const tolerance = (mm: number, floor = MIN_SPACING): number => identity && MIN_SPACING === TABLOID_FORMAT.minSpacing ? mm : Math.max(mm, floor);
/** A knockout halo authored in tabloid millimetres: scaled with the card, never under 0.5 mm. */
export const halo = (mm: number): number => identity ? mm : Math.max(0.5, S * mm);
/**
 * A count tuned on tabloid that is really a density (stars, fragments, ticks, rays): scaled by the art window's
 * area (`per: 'area'`), or by `S` for things spaced along a length that scales with the card (`per: 'length'`,
 * e.g. rays round a sun), rounded, and never under `floor`, which keeps the card's character. `n` itself at tabloid.
 */
export function scaledCount(n: number, floor: number, per: 'area' | 'length' = 'area'): number {
  return identity ? n : Math.max(floor, Math.round(n * (per === 'area' ? AREA : S)));
}
const GOLDEN = (Math.sqrt(5) - 1) / 2;
/**
 * Whether the `index`-th of a seeded set is among an even spread of a `keep` fraction of it (all of it at 1 or
 * more). Key it on an index the seeded world fixes (an item's place in its generation, not in a list filtered by
 * size), and the kept sets nest: a smaller card keeps a subset of what a larger one shows. With `scaledCount`:
 * `evenlyKept(i, scaledCount(total, floor) / total)`.
 */
export const evenlyKept = (index: number, keep: number): boolean => keep >= 1 || (index * GOLDEN) % 1 < keep;
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
