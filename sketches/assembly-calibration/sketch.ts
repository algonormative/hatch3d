import { plyControl, renderPly } from '../../src/sketch/assembly.ts';
import { PAPERS, inkOnTrial, inkPen } from '../../src/sketch/materials.ts';
import { measureStrokeText, strokeText } from '../../src/sketch/stroke-text.ts';
import type { AssemblySpec, Control, Cuts, Part, Pen, PlySpec, Point, Sketch } from '../../src/sketch/types.ts';

/**
 * Assembly calibration: three sheets (black, gold-yellow and white paper) that are plotted, knife-cut, trimmed at the
 * crop marks, stacked and glued, to measure what the Breach triptych needs before it is drawn: real line widths per ink
 * per paper, how legible the cut guides are, how close art can sit to a knife cut (the margin), how far lower art must
 * run under an upper edge (the bleed), and how far apart the sheets register, read to 0.1 mm with verniers.
 *
 * Everything is placed in page millimetres on one tabloid sheet (279.4 x 431.8, margin 11). Assembled, the sheet shows
 * the gold paper through two big windows cut in the white one (W1, upper left; W2, upper right), the black paper
 * through a window cut in the gold inside W2 (G1), and white paper in the lower half. See `notes.json` for how Nick plots,
 * cuts and reads it, and `README.md` for the layout.
 */

// ── Materials and plies ──────────────────────────────────────────────

const paper = (id: keyof typeof PAPERS) => ({ id: PAPERS[id].id, color: PAPERS[id].color });
const BLACK_INKS = ['gold', 'silver', 'fluoro-pink', 'fluoro-orange', 'fluoro-green', 'fluoro-yellow'];
const GOLD_INKS = ['black', 'gold']; // gold is on trial on gold-yellow paper
const WHITE_INKS = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'silver', 'fluoro-pink', 'fluoro-orange']; // the last three are on trial

const plies: PlySpec[] = [
  { id: 'black', paper: paper('black'), pens: BLACK_INKS, cutInk: 'silver' },
  { id: 'gold', paper: paper('gold-yellow'), pens: GOLD_INKS, cutInk: 'black' },
  { id: 'white', paper: paper('white'), pens: WHITE_INKS, cutInk: 'carbon' },
];

/** `margin` is small so the margin ladder is drawn as designed, and `bleed` large so the bleed ladder is not clipped. */
export const spec: AssemblySpec = { control: 'ply', cutPen: 'cut', margin: 0.3, bleed: 5, plies };

const CUT_PEN: Pen = { id: 'cut', color: '#1c1c1e', width: 0.35 }; // inked as each ply's cut ink by finishing
const penIds = [...new Set([...WHITE_INKS, ...GOLD_INKS, ...BLACK_INKS])];
export const pens: Pen[] = [...penIds.map(inkPen), CUT_PEN];

export const PAGE = { width: 279.4, height: 431.8, margin: 11 };
export const DEFAULT_DATE = '2026-10-14';

// ── Geometry helpers ─────────────────────────────────────────────────

export interface Rect { x0: number; y0: number; x1: number; y1: number }
const P = (x: number, y: number): Point => ({ x, y });
const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const line = (x0: number, y0: number, x1: number, y1: number): Point[] => [P(r4(x0), r4(y0)), P(r4(x1), r4(y1))];
export const ring = (r: Rect): Point[] => [P(r.x0, r.y0), P(r.x1, r.y0), P(r.x1, r.y1), P(r.x0, r.y1)];
const box = (x0: number, y0: number, w: number, h: number): Rect => ({ x0, y0, x1: x0 + w, y1: y0 + h });

/** Horizontal hatch of a `w` x `h` patch at `pitch`, the first line half a pitch in, laid as a serpentine. */
export function hatch(x0: number, y0: number, w: number, h: number, pitch: number): Point[][] {
  const n = Math.floor(h / pitch + 1e-6);
  return Array.from({ length: n }, (_, i) => (i % 2 ? line(x0 + w, y0 + (i + 0.5) * pitch, x0, y0 + (i + 0.5) * pitch) : line(x0, y0 + (i + 0.5) * pitch, x0 + w, y0 + (i + 0.5) * pitch)));
}

function dashed(x0: number, y: number, length: number, on = 2, off = 1.2): Point[][] {
  const out: Point[][] = [];
  for (let x = 0; x < length - 1e-9; x += on + off) out.push(line(x0 + x, y, x0 + Math.min(x + on, length), y));
  return out;
}

const FACE = { face: 'sans' as const };
/** Stroke text with its top edge at `top` (cap height `h`; descenders hang below), its left edge at `x`. */
const text = (s: string, x: number, top: number, h: number): Point[][] => strokeText(s, x, top, { ...FACE, height: h });
const textWidth = (s: string, h: number): number => measureStrokeText(s, { ...FACE, height: h });
const centered = (s: string, cx: number, top: number, h: number): Point[][] => text(s, cx - textWidth(s, h) / 2, top, h);
const rightAligned = (s: string, right: number, top: number, h: number): Point[][] => text(s, right - textWidth(s, h), top, h);

/** A line from `a` to `b` with an arrowhead at `b`. */
function arrow(a: Point, b: Point, head = 1.3): Point[][] {
  const angle = Math.atan2(b.y - a.y, b.x - a.x), spread = (28 * Math.PI) / 180;
  const barb = (s: number) => [P(r4(b.x - head * Math.cos(angle + s * spread)), r4(b.y - head * Math.sin(angle + s * spread))), b];
  return [[a, b], barb(1), barb(-1)];
}

// ── The page ─────────────────────────────────────────────────────────

/** Big windows cut in the white ply, and the window cut in the gold ply inside W2 (all page millimetres). */
export const W1 = box(20, 20, 115, 180);
export const W2 = box(155, 20, 105, 180);
export const G1 = box(167, 32, 81, 156);
/** The four guide variants, 44 x 24 mm each, and the window the margin ladder is drawn beside, all in the white ply's lower half. */
const VARIANT = { w: 44, h: 24, y: 218 };
export const VARIANTS = [
  { id: 'va', caption: 'A  pitch 12  size 4', label: 'CUT A', guide: { pitch: 12, size: 4 } },
  { id: 'vb', caption: 'B  pitch 8  size 3', label: 'CUT B', guide: { pitch: 8, size: 3 } },
  { id: 'vc', caption: 'C  pitch 16  size 6', label: 'CUT C', guide: { pitch: 16, size: 6 } },
  { id: 'vd', caption: 'D  no label', label: undefined, guide: { label: false } },
].map((v, i) => ({ ...v, area: box(20 + i * 50, VARIANT.y, VARIANT.w, VARIANT.h) }));
export const LADDER_WINDOW = box(220, VARIANT.y, 38, VARIANT.h);
/** The hatched boxes sealed under paper, and where the white captions sit. */
export const GHOST_SILVER = box(20, 262, 40, 25);
export const GHOST_BLACK = box(100, 262, 40, 25);

export function cuts(): Cuts {
  return {
    gold: [{ id: 'g1', label: 'G1', rings: [ring(G1)] }],
    white: [
      { id: 'w1', label: 'W1', rings: [ring(W1)] },
      { id: 'w2', label: 'W2', rings: [ring(W2)] },
      ...VARIANTS.map((v) => ({ id: v.id, ...(v.label ? { label: v.label } : {}), guide: v.guide, rings: [ring(v.area)] })),
      { id: 'ml', label: 'LADDER', rings: [ring(LADDER_WINDOW)] },
    ],
  };
}

// ── Swatches ─────────────────────────────────────────────────────────

export const SWATCH = { patch: { w: 22, h: 12, pitch: 0.6 }, gap: 3, strip: { h: 3, pitch: 0.3 }, label: 2.5, labelRise: 4.5, rowPitch: 19 };

/**
 * One ink on one paper, its patch's top-left corner at (x, y): a 22 x 12 mm hatch patch at 0.6 mm pitch; beside it a
 * single line, a dashed line and a 3 mm tall hatch strip at 0.3 mm pitch; above it the ink id in stroke text, marked
 * "(trial)" when the ink is only on trial on this paper. All in the ink itself.
 */
export function swatch(ink: string, paperId: string, x: number, y: number): Part {
  const { patch, gap, strip } = SWATCH;
  const col = x + patch.w + gap;
  const label = `${ink}${inkOnTrial(ink, paperId) ? ' (trial)' : ''}`;
  return {
    id: `swatch-${ink}`, pen: ink,
    paths: [
      ...hatch(x, y, patch.w, patch.h, patch.pitch),
      line(col, y + 1.5, col + patch.w, y + 1.5),
      ...dashed(col, y + 5, patch.w),
      ...hatch(col, y + 8, patch.w, strip.h, strip.pitch),
      ...text(label, x, y - SWATCH.labelRise, SWATCH.label),
    ],
  };
}

const title = (ply: PlySpec, date: string, seed: number, pen: string, x: number, y: number): Part => ({
  id: `title-${ply.id}`, pen,
  paths: [
    ...text('assembly calibration', x, y, 2.5),
    ...text(`ply ${ply.id} | ${ply.paper.id} paper`, x, y + 4.5, 2.5),
    ...text(`${date} | seed ${seed}`, x, y + 9, 2.5),
  ],
});

// ── Ladders ──────────────────────────────────────────────────────────

export const BLEED_OFFSETS = [-1, -0.5, 0, 0.5, 1, 2, 3];
/** The margin ladder's offsets from the cut line, and the length steps (millimetres) of its stair. */
export const MARGIN_OFFSETS = [0.5, 1.0, 1.5, 2.0];
const LADDER_STEP = 7;

/**
 * Seven lines running toward a horizontal window edge (at y = `edge`) from inside the window, ending `BLEED_OFFSETS`
 * mm past it (negative: short of it, so they visibly stop inside the window), each labelled inside the window.
 */
export function bleedLadder(pen: string, x0: number, edge: number, pitch: number, id: string): Part {
  const length = 12, h = 2.0;
  const paths: Point[][] = [];
  BLEED_OFFSETS.forEach((offset, i) => {
    const x = x0 + i * pitch;
    paths.push(line(x, edge - length, x, edge + offset));
    paths.push(...centered(String(offset), x, edge - length - 1.5 - h, h));
  });
  return { id, pen, paths };
}

/**
 * Four lines parallel to a horizontal window edge (y = `edge`), on the kept paper at `MARGIN_OFFSETS` mm from it
 * (`side` 1: below the edge, -1: above), a stair of lengths from `x0` so each end carries its offset beyond the band.
 */
export function marginLadder(pen: string, x0: number, edge: number, side: 1 | -1, id: string): Part {
  const h = 2.0;
  const paths: Point[][] = [];
  MARGIN_OFFSETS.forEach((offset, i) => {
    const end = x0 + (MARGIN_OFFSETS.length - i) * LADDER_STEP;
    paths.push(line(x0, edge + side * offset, end, edge + side * offset));
    const top = side === 1 ? edge + 2.0 + 1.5 : edge - 2.0 - 1.5 - h;
    paths.push(...centered(offset.toFixed(1), end, top, h));
  });
  return { id, pen, paths };
}

// ── Verniers ─────────────────────────────────────────────────────────

/** Tick lengths on the visible side of an edge, and how far the main scale runs under the upper paper, millimetres. */
export const TICK = { short: 4, long: 6, under: 4, gap: 0.31 };
export const MAIN_PITCH = 1;
export const VERNIER_PITCH = 0.9;

export interface Vernier {
  /** The main scale, 21 ticks at 1.00 mm, on the lower ply (sealed: it runs under the upper paper). */
  main: Point[][];
  /** Its labels, on the lower ply, in the window. */
  mainLabels: Point[][];
  /** The vernier scale, 11 ticks at 0.90 mm, on the upper ply's paper, starting at the edge. */
  scale: Point[][];
  /** Its labels, on the upper ply. */
  scaleLabels: Point[][];
}

/**
 * A vernier across the window edge `edge` (the window lies on the smaller side of it, the upper paper on the larger),
 * reading the sheets' registration along `axis`: `x` for a horizontal edge (y = `edge`) and the ticks, which stand
 * across it, spread along x; `y` for a vertical edge (x = `edge`) and the ticks spread along y. The zero ticks of both
 * scales sit at `at` along the axis and line up when registration is perfect; the main scale runs 10 mm each way, the
 * vernier 9 mm from zero in the + direction (right for x, down for y). A displacement of d mm of the upper sheet in the
 * + direction moves the vernier ticks to at + d + 0.9 k, and the tick k that lines up with main tick j gives
 * d = j - 0.9 k.
 */
export function vernier(axis: 'x' | 'y', edge: number, at: number): Vernier {
  const pt = (along: number, across: number): Point => (axis === 'x' ? P(r4(along), r4(across)) : P(r4(across), r4(along)));
  const longTick = (i: number) => i % 5 === 0;
  const main: Point[][] = [];
  for (let j = -10; j <= 10; j++) main.push([pt(at + j * MAIN_PITCH, edge - (longTick(j) ? TICK.long : TICK.short)), pt(at + j * MAIN_PITCH, edge + TICK.under)]);
  const scale: Point[][] = [];
  for (let k = 0; k <= 10; k++) scale.push([pt(at + k * VERNIER_PITCH, edge + TICK.gap), pt(at + k * VERNIER_PITCH, edge + TICK.gap + (longTick(k) ? TICK.long : TICK.short))]);
  const h = 2.5;
  if (axis === 'x') {
    return {
      main, scale,
      mainLabels: [...centered('0', at, edge - 10, h), ...centered('x', at - 14, edge - 5.25, h)],
      scaleLabels: [...centered('0', at, edge + 7.8, h), ...arrow(P(at + 12, edge + 3), P(at + 18, edge + 3)), ...centered('+', at + 20.5, edge + 1.75, h)],
    };
  }
  return {
    main, scale,
    mainLabels: [...rightAligned('0', edge - 7.5, at - 1.25, h), ...centered('y', edge - 4, at - 15.25, h)],
    scaleLabels: [...text('0', edge + 7.8, at - 1.25, h), ...arrow(P(edge + 3, at + 12), P(edge + 3, at + 18)), ...centered('+', edge + 3, at + 19.5, h)],
  };
}

// ── The world ────────────────────────────────────────────────────────

export interface World { cuts: Cuts; art: Record<string, Part[]>; sealed: Record<string, Part[]> }

/** The swatch positions: gold sheet's inside W1, black's inside G1 (one column), white's in the lower half (two columns). */
const GOLD_SWATCH_AT = P(28, 60);
const BLACK_SWATCH_AT = P(173, 58.5);
const WHITE_SWATCH_AT = [P(20, 310), P(110, 310)];
const WHITE_TITLE_AT = P(20, 398);

/** The vernier pairs: white over gold at W1, gold over black at G1, each on a bottom edge (x) and a right edge (y). */
const W_X = vernier('x', W1.y1, 112), W_Y = vernier('y', W1.x1, 110);
const G_X = vernier('x', G1.y1, 234), G_Y = vernier('y', G1.x1, 110);

/** The whole artwork of the sheet: every ply's art and sealed art, and the cuts. The same on every render. */
export function buildWorld(date: string, seed: number): World {
  const [black, gold, white] = plies;
  const stack = (ply: PlySpec, inks: string[], at: Point[]) => inks.map((ink, i) => swatch(ink, ply.paper.id, at[i].x, at[i].y));
  const blackSwatches = stack(black, BLACK_INKS, BLACK_INKS.map((_, i) => P(BLACK_SWATCH_AT.x, BLACK_SWATCH_AT.y + i * SWATCH.rowPitch)));
  const goldSwatches = stack(gold, GOLD_INKS, GOLD_INKS.map((_, i) => P(GOLD_SWATCH_AT.x, GOLD_SWATCH_AT.y + i * SWATCH.rowPitch)));
  const whiteSwatches = stack(white, WHITE_INKS, WHITE_INKS.map((_, i) => P(WHITE_SWATCH_AT[Math.floor(i / 4)].x, WHITE_SWATCH_AT[0].y + (i % 4) * 22)));
  const ghostCaption = (id: string, area: Rect): Part => ({ id, pen: 'carbon', paths: centered('is there a ghost here?', (area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2 - 1.1, 2.2) });
  const part = (id: string, pen: string, ...paths: Point[][][]): Part => ({ id, pen, paths: paths.flat() });
  return {
    cuts: cuts(),
    art: {
      black: [
        title(black, date, seed, 'silver', 173, 38),
        ...blackSwatches,
        bleedLadder('silver', 172, G1.y1, 7, 'bleed-black'),
        part('vernier-g-x-main-labels', 'silver', G_X.mainLabels),
        part('vernier-g-y-main-labels', 'silver', G_Y.mainLabels),
      ],
      gold: [
        title(gold, date, seed, 'black', 28, 26),
        ...goldSwatches,
        bleedLadder('black', 28, W1.y1, 9, 'bleed-gold'),
        marginLadder('black', 172, G1.y0, -1, 'margin-gold'),
        part('vernier-w-x-main-labels', 'black', W_X.mainLabels),
        part('vernier-w-y-main-labels', 'black', W_Y.mainLabels),
        part('vernier-g-x-scale', 'black', G_X.scale, G_X.scaleLabels),
        part('vernier-g-y-scale', 'black', G_Y.scale, G_Y.scaleLabels),
      ],
      white: [
        title(white, date, seed, 'carbon', WHITE_TITLE_AT.x, WHITE_TITLE_AT.y),
        ...whiteSwatches,
        ...VARIANTS.map((v) => part(`caption-${v.id}`, 'carbon', text(v.caption, v.area.x0, VARIANT.y + VARIANT.h + 4.5, 2.5))),
        marginLadder('carbon', LADDER_WINDOW.x0 + 2, LADDER_WINDOW.y1, 1, 'margin-white'),
        part('caption-ladder', 'carbon', text('E  margin ladder', LADDER_WINDOW.x0, LADDER_WINDOW.y1 + 12, 2.5)),
        ghostCaption('ghost-caption-silver', GHOST_SILVER),
        ghostCaption('ghost-caption-black', GHOST_BLACK),
        part('vernier-w-x-scale', 'carbon', W_X.scale, W_X.scaleLabels),
        part('vernier-w-y-scale', 'carbon', W_Y.scale, W_Y.scaleLabels),
      ],
    },
    sealed: {
      black: [
        part('vernier-g-x-main', 'silver', G_X.main),
        part('vernier-g-y-main', 'silver', G_Y.main),
        part('ghost-silver', 'silver', hatch(GHOST_SILVER.x0, GHOST_SILVER.y0, GHOST_SILVER.x1 - GHOST_SILVER.x0, GHOST_SILVER.y1 - GHOST_SILVER.y0, 0.4)),
      ],
      gold: [
        part('vernier-w-x-main', 'black', W_X.main),
        part('vernier-w-y-main', 'black', W_Y.main),
        part('ghost-black', 'black', hatch(GHOST_BLACK.x0, GHOST_BLACK.y0, GHOST_BLACK.x1 - GHOST_BLACK.x0, GHOST_BLACK.y1 - GHOST_BLACK.y0, 0.4)),
      ],
    },
  };
}

// ── The sketch ───────────────────────────────────────────────────────

const controls: Control[] = [
  plyControl(spec),
  { type: 'text', id: 'date', label: 'Date on each sheet', default: DEFAULT_DATE, maxLength: 10 },
];

const sketch: Sketch = {
  name: 'Assembly calibration',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls,
  assembly: spec,
  draw(ctx) {
    const page = ctx.page ?? PAGE;
    if (page.width !== PAGE.width || page.height !== PAGE.height || page.margin !== PAGE.margin) {
      throw new Error(`assembly-calibration is laid out for ${PAGE.width} x ${PAGE.height} mm with a ${PAGE.margin} mm margin, not ${page.width} x ${page.height} mm with ${String(page.margin)}`);
    }
    return renderPly(spec, ctx, pens, buildWorld(String(ctx.params.date), ctx.seed));
  },
};

export default sketch;
