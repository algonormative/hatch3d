import { plyControl, renderPly } from '../../src/sketch/assembly.ts';
import { INKS, PAPERS, inkOnTrial, inkPen } from '../../src/sketch/materials.ts';
import { measureStrokeText, strokeText } from '../../src/sketch/stroke-text.ts';
import type { AssemblySpec, Control, Cut, Cuts, Part, Pen, PlySpec, Point, Sketch } from '../../src/sketch/types.ts';

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
/**
 * Each sheet's inks, in plot order (R12: the pens Nick has). Black: the two Signo broads and the Moonlight 10s, the
 * first six (the triptych's) swatched in window G1 and the rest below the black's font test; the last five are on trial.
 */
const BLACK_INKS = ['gold', 'silver', 'fluoro-pink', 'fluoro-orange', 'fluoro-green', 'fluoro-yellow', 'fluoro-vermilion', 'gel-red', 'gel-rose', 'gel-purple', 'gel-blue', 'gel-teal'];
const G1_SWATCHES = 6;
const GOLD_INKS = ['black', 'carbon', 'gold', 'ultramarine', 'violet']; // the Micron 08 and 01 blacks; the last three on trial
const WHITE_INKS = ['carbon', 'black', 'ultramarine', 'violet', 'silver', 'fluoro-pink', 'fluoro-orange']; // the four Microns; the last three on trial
/** The inks the triptych draws in on white (Lodestone R's white sheet): the white's spacing, marks and crossing tests, for want of room for all eight. */
const TRIPTYCH_WHITE_INKS = ['carbon', 'ultramarine', 'fluoro-pink'];

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
export const DEFAULT_DATE = '2026-10-15';

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
const text = (s: string, x: number, top: number, h: number, face: 'sans' | 'script' = FACE.face): Point[][] => strokeText(s, x, top, { face, height: h });
const textWidth = (s: string, h: number, face: 'sans' | 'script' = FACE.face): number => measureStrokeText(s, { face, height: h });
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
    gold: [{ id: 'g1', label: 'G1', rings: [ring(G1)] }, ...cutLadder()],
    white: [
      { id: 'w1', label: 'W1', rings: [ring(W1)] },
      { id: 'w2', label: 'W2', rings: [ring(W2)] },
      ...VARIANTS.map((v) => ({ id: v.id, ...(v.label ? { label: v.label } : {}), guide: v.guide, rings: [ring(v.area)] })),
      { id: 'ml', label: 'LADDER', rings: [ring(LADDER_WINDOW)] },
    ],
  };
}

// ── Swatches ─────────────────────────────────────────────────────────

/**
 * What every test labels its ink with, in the ink itself (R12): the physical pen as its barrel names it, its nominal
 * line width where the maker gives one, and "(trial)" where the ink is only on trial on this paper, so a photo of the
 * sheet says which pen drew which line. An ink with no pen yet is labelled with its id.
 */
export function penLabel(ink: string, paperId: string): string {
  const { pen, nominal } = INKS[ink];
  return `${pen ?? ink}${nominal ? ` ${String(nominal)}mm` : ''}${inkOnTrial(ink, paperId) ? ' (trial)' : ''}`;
}

export const SWATCH = { patch: { w: 22, h: 12, pitch: 0.6 }, gap: 3, strip: { h: 3, pitch: 0.3 }, label: 2, labelRise: 4.5, rowPitch: 19 };

/**
 * One ink on one paper, its patch's top-left corner at (x, y): a 22 x 12 mm hatch patch at 0.6 mm pitch; beside it a
 * single line, a dashed line and a 3 mm tall hatch strip at 0.3 mm pitch; above it the pen's label (`penLabel`) in
 * stroke text. All in the ink itself.
 */
export function swatch(ink: string, paperId: string, x: number, y: number): Part {
  const { patch, gap, strip } = SWATCH;
  const col = x + patch.w + gap;
  const label = penLabel(ink, paperId);
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

// ── Font test ────────────────────────────────────────────────────────

/**
 * The font test: the stroke faces the triptych writes in (Hershey sans; and script) at the sizes worth trying, the
 * triptych's phrase words being 2.6 mm (cap height). One cell per ink, `FONT_CELL` wide and tall: the pen's label
 * (`penLabel`), then "line" in sans at each of `FONT_SIZES` left to right on one
 * baseline, the same in script, and the phrase at 2.6 mm in sans. All in the ink itself.
 */
export const FONT_SIZES = [1.5, 2, 2.6, 3.5, 5];
export const FONT_CELL = { w: 50, h: 21, gap: 1.8, sample: 'line', phrase: 'everything falls into line' };
export function fontCell(ink: string, paperId: string, x: number, y: number): Part {
  const paths: Point[][] = [...text(penLabel(ink, paperId), x, y, 2)];
  (['sans', 'script'] as const).forEach((face, row) => {
    const base = y + 8.5 + row * 6; // (R12) a millimetre lower, clear of the longer pen label above
    let cx = x;
    for (const h of FONT_SIZES) { paths.push(...text(FONT_CELL.sample, cx, base - h, h, face)); cx += textWidth(FONT_CELL.sample, h, face) + FONT_CELL.gap; }
  });
  paths.push(...text(FONT_CELL.phrase, x, y + 16.3, 2.6));
  return { id: `font-${ink}`, pen: ink, paths };
}

/** A sheet's font test: a header in the sheet's own ink, then its inks' cells two to a row from (x, y). */
function fontTest(inks: string[], paperId: string, pen: string, x: number, y: number, note?: string): Part[] {
  const lines = ['font test: "line" in sans, then script, at 1.5 2.0 2.6 3.5 5 mm;', 'the phrase in sans at 2.6 mm (the triptych\'s size)', ...(note ? [note] : [])];
  const header: Part = { id: 'font-header', pen, paths: lines.flatMap((l, i) => text(l, x, y + 3.5 * i, 2)) };
  const top = y + 3.5 * lines.length + 2;
  return [header, ...inks.map((ink, i) => fontCell(ink, paperId, x + (i % 2) * (FONT_CELL.w + 6), top + Math.floor(i / 2) * FONT_CELL.h))];
}
/** Where each sheet's font test sits: the gold's in W1 below its swatches, the white's in the lower half's right side,
 * the black's below G1 (sealed: hidden once assembled, as G1 has no room, so it is read before gluing). */
export const FONT_AT = { black: P(158, 197), gold: P(28, 106), white: P(158, 296) };

// ── Test blocks (R11): spacing, marks, crossings, cuts, the paper edge ──

/** Small stroke text for the blocks' labels and rungs, millimetres. */
const SMALL = 1.5;
const squareRing = (cx: number, cy: number, half: number): Point[] => [P(r4(cx - half), r4(cy - half)), P(r4(cx + half), r4(cy - half)), P(r4(cx + half), r4(cy + half)), P(r4(cx - half), r4(cy + half)), P(r4(cx - half), r4(cy - half))];
const circle = (cx: number, cy: number, r: number, n = Math.max(24, Math.ceil(r * 24))): Point[] => Array.from({ length: n + 1 }, (_, i) => P(r4(cx + r * Math.cos((2 * Math.PI * i) / n)), r4(cy + r * Math.sin((2 * Math.PI * i) / n))));

/**
 * The spacing and emphasis ladder: per ink a row of 5 x 5 mm hatch patches at `SPACINGS` (centre to centre), then a 3 mm
 * square outlined twice at each of `EMPHASIS_SPACINGS`, then three times: the tightest that stays separate is the
 * pitch the art can use for hatch and for doubled and tripled outlines. `SPACING_ROW`: the columns' x offsets.
 */
export const SPACINGS = [0.4, 0.5, 0.55, 0.66, 0.8, 1.0];
export const EMPHASIS_SPACINGS = [0.6, 0.7, 0.8, 1.0, 1.2];
export const SPACING_ROW = { h: 11, patch: 5, cell: 6.5, doubles: 41, triples: 75.5, tripleCell: 8.5, square: 3, w: 118 };
export function spacingRow(ink: string, paperId: string, x: number, y: number): Part {
  const top = y + 2.8, paths: Point[][] = [...text(penLabel(ink, paperId), x, y, SMALL)];
  SPACINGS.forEach((pitch, i) => paths.push(...hatch(x + i * SPACING_ROW.cell, top, SPACING_ROW.patch, SPACING_ROW.patch, pitch)));
  for (const [x0, cell, lines] of [[SPACING_ROW.doubles, SPACING_ROW.cell, 2], [SPACING_ROW.triples, SPACING_ROW.tripleCell, 3]]) {
    EMPHASIS_SPACINGS.forEach((pitch, i) => {
      for (let k = 0; k < lines; k++) paths.push(squareRing(x + x0 + i * cell + cell / 2, top + 4, SPACING_ROW.square / 2 + k * pitch));
    });
  }
  return { id: `spacing-${ink}`, pen: ink, paths };
}
function spacingLadder(inks: string[], paperId: string, pen: string, x: number, y: number): Part[] {
  const fmt = (v: number) => v.toFixed(2).replace(/^0/, '');
  const header: Part = { id: 'spacing-header', pen, paths: [
    ...text('spacing (mm): hatch; double; triple', x, y, SMALL),
    ...SPACINGS.flatMap((v, i) => text(fmt(v), x + i * SPACING_ROW.cell, y + 2.6, 1.2)),
    ...EMPHASIS_SPACINGS.flatMap((v, i) => text(v.toFixed(1), x + SPACING_ROW.doubles + i * SPACING_ROW.cell + 1.2, y + 2.6, 1.2)),
    ...EMPHASIS_SPACINGS.flatMap((v, i) => text(v.toFixed(1), x + SPACING_ROW.triples + i * SPACING_ROW.tripleCell + 2, y + 2.6, 1.2)),
  ] };
  return [header, ...inks.map((ink, i) => spacingRow(ink, paperId, x, y + 5 + i * SPACING_ROW.h))];
}

/**
 * Dots, dashes and tight curves: per ink, dashes `DASHES` mm on (the gap the same), one row each; a row of
 * dots, three each of the strokes `DOTS` mm long; crosses `CROSSES` mm across (the cosmos's star
 * sizes); circles of radius `CIRCLES`; a spiral from 1 to 4 mm radius (2 to 8 mm across). The pen's label to the left.
 * Dots: see `DOTS`.
 */
export const DASHES = [0.3, 0.5, 1.0, 1.6];
export const CROSSES = [0.8, 1.2, 1.6];
export const CIRCLES = [0.5, 1, 2, 4];
/**
 * The dots' lengths. A zero-length stroke never reaches the plotter (the render's clipping drops it), nor does any
 * under 0.3 mm (finalize's `filter --min-length 0.3mm`): the dots are the shortest strokes that do, and a little longer.
 */
export const DOTS = [0.3, 0.35, 0.4];
export const MARKS_ROW = { h: 9.5, label: 40, dashes: 16, dots: 9, w: 119 };
export function marksRow(ink: string, paperId: string, x: number, y: number): Part {
  const paths: Point[][] = [...text(penLabel(ink, paperId), x, y + 3.5, SMALL)];
  let cx = x + MARKS_ROW.label;
  DASHES.forEach((d, i) => paths.push(...dashed(cx, y + 0.6 + i * 1.9, MARKS_ROW.dashes, d, d)));
  cx += MARKS_ROW.dashes + 3;
  for (let i = 0; i < MARKS_ROW.dots; i++) { const q = P(r4(cx + i * 2), r4(y + 4.2)), d = DOTS[Math.floor(i / 3)]; paths.push([q, P(r4(q.x + d), q.y)]); }
  cx += 2 * (MARKS_ROW.dots - 1) + 3;
  for (const size of CROSSES) { const c = cx + size / 2; paths.push(line(c - size / 2, y + 4.2, c + size / 2, y + 4.2), line(c, y + 4.2 - size / 2, c, y + 4.2 + size / 2)); cx += size + 1.6; }
  cx += 1.4;
  for (const r of CIRCLES) { paths.push(circle(cx + r, y + 4.2, r)); cx += 2 * r + 1.5; }
  cx += 1.5;
  const spiral: Point[] = [];
  for (let i = 0; i <= 360; i++) { const t = i / 360, a = 3 * 2 * Math.PI * t, r = 1 + 3 * t; spiral.push(P(r4(cx + 4 + r * Math.cos(a)), r4(y + 4.2 + r * Math.sin(a)))); }
  paths.push(spiral);
  return { id: `marks-${ink}`, pen: ink, paths };
}
function marksLadder(inks: string[], paperId: string, pen: string, x: number, y: number): Part[] {
  const header: Part = { id: 'marks-header', pen, paths: text('left to right: dashes .3 .5 1 1.6 on (gap the same); dots .3 .35 .4 long; crosses .8 1.2 1.6; circles r .5 1 2 4; spiral 2-8 mm', x, y, 1.2) };
  return [header, ...inks.map((ink, i) => marksRow(ink, paperId, x, y + 2.5 + i * MARKS_ROW.h))];
}

/**
 * Ink crossings: each ordered pair of `inks` crossing in the middle of a cell, the row's ink across, the column's ink
 * down, so every pair crosses twice (once each way), and each crossing shows the later pen in the plot order over the
 * earlier pen's ink. The rows are labelled with the pens (`penLabel`), the columns numbered as the rows; the grid starts
 * just right of the longest row label.
 */
export const CROSSING_CELL = 7;
export function crossings(inks: string[], paperId: string, pen: string, x: number, y: number): Part[] {
  const rowLabels = inks.map((ink, i) => `${i + 1} ${penLabel(ink, paperId)}`);
  const left = x + Math.max(...rowLabels.map((label) => textWidth(label, 1.2))) + 2, top = y + 3, c = CROSSING_CELL, arm = c / 2 - 0.6;
  const labels: Part = { id: 'crossings-labels', pen, paths: [
    ...text('crossings: row ink across, column ink down', x, y - 2.5, SMALL),
    ...rowLabels.flatMap((label, i) => [...text(label, x, top + i * c + c / 2 - 0.6, 1.2), ...centered(String(i + 1), left + i * c + c / 2, y, 1.2)]),
  ] };
  const parts: Part[] = [labels];
  inks.forEach((ink, i) => {
    const across: Point[][] = [], down: Point[][] = [];
    inks.forEach((_, j) => {
      if (i === j) return;
      const cx = left + j * c + c / 2, cy = top + i * c + c / 2;
      across.push(line(cx - arm, cy, cx + arm, cy));
      const dx = left + i * c + c / 2, dy = top + j * c + c / 2;
      down.push(line(dx, dy - arm, dx, dy + arm));
    });
    parts.push({ id: `crossings-${ink}`, pen: ink, paths: [...across, ...down] });
  });
  return parts;
}

/**
 * The cut ladder (gold sheet, in what the white hides): waste windows with guides that probe the knife: wedges whose
 * tips close to `WEDGES` degrees (8 mm bases), slots `SLOTS` mm wide and 30 long, three windows round a kept island held
 * by one bridge `BRIDGES` mm wide (as the shirt cut holds L's tie at its knot and tip), and a notch open to the bottom
 * trim. Each is at least 3 mm wide somewhere, as `validateCuts` asks, so the tooling cuts all of them as they are.
 */
export const WEDGES = [60, 45, 30, 20];
export const SLOTS = [3, 4, 5, 6];
export const BRIDGES = [2, 3, 4];
export const LADDER_AT = P(22, 300);
export const NOTCH = box(100, 412.8, 10, 8);
export function cutLadder(): Cut[] {
  const { x, y } = LADDER_AT, out: Cut[] = [];
  WEDGES.forEach((deg, i) => {
    const h = 4 / Math.tan((deg * Math.PI) / 360), cx = x + 4 + i * 16, base = y + 35;
    out.push({ id: `wedge-${deg}`, rings: [[P(cx - 4, base), P(cx + 4, base), P(r4(cx), r4(base - h))]] });
  });
  let sx = x + 70;
  for (const w of SLOTS) { out.push({ id: `slot-${w}`, rings: [ring(box(sx, y + 5, w, 30))] }); sx += w + 4; }
  BRIDGES.forEach((b, i) => {
    const ox = x + i * 28, oy = y + 50, o = 18, isl = 8, ix0 = ox + (o - isl) / 2, iy0 = oy + (o - isl) / 2, my = oy + o / 2;
    // One ring: round the outside, in along the bridge's top edge, round the island backwards, out along its bottom edge.
    out.push({ id: `bridge-${b}`, rings: [[
      P(ox, oy), P(ox + o, oy), P(ox + o, my - b / 2), P(ix0 + isl, my - b / 2), P(ix0 + isl, iy0), P(ix0, iy0), P(ix0, iy0 + isl),
      P(ix0 + isl, iy0 + isl), P(ix0 + isl, my + b / 2), P(ox + o, my + b / 2), P(ox + o, oy + o), P(ox, oy + o),
    ].map((q) => P(r4(q.x), r4(q.y)))] });
  });
  out.push({ id: 'notch', rings: [ring(NOTCH)] });
  return out;
}
function cutLadderLabels(pen: string): Part {
  const { x, y } = LADDER_AT;
  return { id: 'knife-ladder-labels', pen, paths: [
    ...text('cut ladder: wedge tips (deg), slots (mm wide), bridges (mm), a notch open to the trim', x, y - 3, SMALL),
    ...WEDGES.flatMap((deg, i) => centered(String(deg), x + 4 + i * 16, y + 37, SMALL)),
    ...SLOTS.reduce<{ at: number; paths: Point[][] }>((acc, w) => ({ at: acc.at + w + 4, paths: [...acc.paths, ...centered(String(w), acc.at + w / 2, y + 37, SMALL)] }), { at: x + 70, paths: [] }).paths,
    ...BRIDGES.flatMap((b, i) => centered(`bridge ${b}`, x + i * 28 + 9, y + 70, SMALL)),
    ...centered('notch', NOTCH.x0 + 5, NOTCH.y0 - 3, SMALL),
  ] };
}

/**
 * Edge rulers: at the middle of each side, four short lines parallel to the paper's edge, 12, 13, 14 and 16 mm from it
 * (1, 2, 3 and 5 mm inside the crop line: the finishing clips all art to the crop line, so nothing can be drawn in
 * the margin itself), each labelled with its distance from the paper edge. Measured from the real paper edge with a
 * rule, the difference is how far the plot landed from where it was placed.
 */
export const EDGE_DISTANCES = [12, 13, 14, 16];
export function edgeRulers(pen: string, id: string): Part {
  const W = PAGE.width, H = PAGE.height, mx = W / 2 - 3, my = H / 2 - 3, len = 6, paths: Point[][] = [];
  EDGE_DISTANCES.forEach((d, k) => {
    paths.push(line(mx, d, mx + len, d), ...text(String(d), mx + len + 1 + k * 3, d - 0.6, 1.2));
    paths.push(line(mx, H - d, mx + len, H - d), ...rightAligned(String(d), mx - 1 - k * 3, H - d - 0.6, 1.2));
    paths.push(line(d, my, d, my + len), ...text(String(d), d - 0.6, my + len + 1 + k * 2, 1.2));
    paths.push(line(W - d, my, W - d, my + len), ...rightAligned(String(d), W - d + 0.6, my - 2.2 - k * 2, 1.2));
  });
  paths.push(...text('mm from the paper edge', mx + len + 14, 12, 1.2));
  return { id, pen, paths };
}

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

/**
 * The swatch positions: gold sheet's inside W1 (two columns, filled row by row), black's first `G1_SWATCHES` inside G1
 * (one column) and the rest below its font test (sealed, two columns), white's in the lower half (two columns).
 */
const GOLD_SWATCH_AT = [P(28, 50), P(82, 50)];
const BLACK_SWATCH_AT = P(173, 58.5);
const BLACK_TRIAL_SWATCH_AT = [P(158, 344), P(213, 344)];
const WHITE_SWATCH_AT = [P(20, 310), P(92, 310)];
const WHITE_TITLE_AT = P(20, 398);

/** The vernier pairs: white over gold at W1, gold over black at G1, each on a bottom edge (x) and a right edge (y). */
const W_X = vernier('x', W1.y1, 112), W_Y = vernier('y', W1.x1, 110);
const G_X = vernier('x', G1.y1, 234), G_Y = vernier('y', G1.x1, 110);

/** The whole artwork of the sheet: every ply's art and sealed art, and the cuts. The same on every render. */
export function buildWorld(date: string, seed: number): World {
  const [black, gold, white] = plies;
  const stack = (ply: PlySpec, inks: string[], at: Point[]) => inks.map((ink, i) => swatch(ink, ply.paper.id, at[i].x, at[i].y));
  const g1Inks = BLACK_INKS.slice(0, G1_SWATCHES), trialInks = BLACK_INKS.slice(G1_SWATCHES);
  const blackSwatches = stack(black, g1Inks, g1Inks.map((_, i) => P(BLACK_SWATCH_AT.x, BLACK_SWATCH_AT.y + i * SWATCH.rowPitch)));
  const blackTrialSwatches = stack(black, trialInks, trialInks.map((_, i) => P(BLACK_TRIAL_SWATCH_AT[i % 2].x, BLACK_TRIAL_SWATCH_AT[0].y + Math.floor(i / 2) * SWATCH.rowPitch)));
  const goldSwatches = stack(gold, GOLD_INKS, GOLD_INKS.map((_, i) => P(GOLD_SWATCH_AT[i % 2].x, GOLD_SWATCH_AT[0].y + Math.floor(i / 2) * SWATCH.rowPitch)));
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
        ...fontTest(GOLD_INKS, gold.paper.id, 'black', FONT_AT.gold.x, FONT_AT.gold.y),
        marginLadder('black', 172, G1.y0, -1, 'margin-gold'),
        part('vernier-w-x-main-labels', 'black', W_X.mainLabels),
        part('vernier-w-y-main-labels', 'black', W_Y.mainLabels),
        part('vernier-g-x-scale', 'black', G_X.scale, G_X.scaleLabels),
        part('vernier-g-y-scale', 'black', G_Y.scale, G_Y.scaleLabels),
      ],
      white: [
        title(white, date, seed, 'carbon', WHITE_TITLE_AT.x, WHITE_TITLE_AT.y),
        ...whiteSwatches,
        ...fontTest(WHITE_INKS, white.paper.id, 'carbon', FONT_AT.white.x, FONT_AT.white.y),
        ...spacingLadder(TRIPTYCH_WHITE_INKS, white.paper.id, 'carbon', 147, 256.5),
        ...marksLadder(TRIPTYCH_WHITE_INKS, white.paper.id, 'carbon', 147, 389.5),
        ...crossings(TRIPTYCH_WHITE_INKS, white.paper.id, 'carbon', 80, 394),
        edgeRulers('carbon', 'edge-white'),
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
        // (R11) The test blocks, under the gold and white papers: read on the loose sheet before gluing. (R12) With
        // twelve inks: the crossings above the ghost box, the marks below it, the trial swatches below the font test.
        ...fontTest(BLACK_INKS, black.paper.id, 'silver', FONT_AT.black.x, FONT_AT.black.y, 'hidden once glued: read it before gluing'),
        ...spacingLadder(BLACK_INKS, black.paper.id, 'silver', 20, 20),
        ...crossings(BLACK_INKS, black.paper.id, 'silver', 20, 162),
        ...marksLadder(BLACK_INKS, black.paper.id, 'silver', 20, 292),
        ...blackTrialSwatches,
        edgeRulers('silver', 'edge-black'),
      ],
      gold: [
        part('vernier-w-x-main', 'black', W_X.main),
        part('vernier-w-y-main', 'black', W_Y.main),
        part('ghost-black', 'black', hatch(GHOST_BLACK.x0, GHOST_BLACK.y0, GHOST_BLACK.x1 - GHOST_BLACK.x0, GHOST_BLACK.y1 - GHOST_BLACK.y0, 0.4)),
        // (R11) The test blocks, under the white paper, and the cut ladder's labels: read on the loose sheet.
        ...spacingLadder(GOLD_INKS, gold.paper.id, 'black', 145, 250),
        ...marksLadder(GOLD_INKS, gold.paper.id, 'black', 145, 314),
        cutLadderLabels('black'),
        edgeRulers('black', 'edge-gold'),
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
