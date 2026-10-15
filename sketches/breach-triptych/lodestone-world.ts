import * as THREE from 'three';
import type { Control, Cut, Point, SketchContext } from '../../src/sketch/types.ts';
import { measureStrokeText, strokeTextOnPath } from '../../src/sketch/stroke-text.ts';
import { clipToRect } from '../kit/page.ts';
import { solid, type Slab } from '../kit/slabs.ts';
import { CONTROLS, PAGE, TRIM, lintelFootprint, lintelRect, type LintelBar } from './world.ts';
import { footprintOf } from '../kit/assembly.ts';
import type { Ink } from '../kit/types.ts';
import { CUT_CONTROL } from './lodestone-cuts.ts';
import { n } from '../kit/params.ts';

/**
 * The Breach triptych "Lodestone": the world its three panels share, on top of Lintel's (`world.ts`: the bust, its
 * censor bar and the eye height). The agent takes the censor bar off its eyes and sets it down (L); the bar is a magnet,
 * and everything near it swings into line (C); a kneeling figure takes the field's lines into its hands and grounds
 * them (R). The hole in L and the magnet in C sit at one height; the field lines leave C's right edge at the heights
 * where R's strands come in.
 */

/** The bust's controls, as Lintel's (L draws the bust; C and R recompute its bar from them). */
const BUST_IDS = ['scale', 'density', 'slack', 'elbow', 'gaze', 'fov', 'fitMargin', 'eyeAt', 'reach', 'value', 'impression', 'glare', 'slabMm', 'barPitch', 'holeBar'];

/** Every Lodestone panel declares these, so one params object draws all three. */
export const LODESTONE_CONTROLS: Control[] = [
  ...CONTROLS.filter(c => BUST_IDS.includes(c.id)),
  { type: 'slider', id: 'hangGap', label: 'Gap between the hung panels (the field runs on across it; 0 is R5\'s panels edge to edge)', default: 76.2, min: 0, max: 101.6, step: 0.1, units: 'mm', group: 'Magnet' },
  { type: 'select', id: 'reachFor', label: 'What the fist reaches for (bar slipping)', default: 'middle', options: ['middle', 'end'],
    optionLabels: { middle: 'The bar\'s middle, from below near the sheet\'s middle, at a slight angle', end: 'Its raised right end (R5)' }, group: 'Magnet' },
  { type: 'select', id: 'barPose', label: 'Where C\'s bar lies', default: 'slipping', options: ['slipping', 'r4'],
    optionLabels: { slipping: 'Slipping: near the middle, tilted steeply, just out of the reaching hand\'s grasp', r4: 'R4: level at the eye height of L\'s hole' }, group: 'Magnet' },
  { type: 'slider', id: 'fieldLines', label: 'Field lines leaving each pole', default: 26, min: 8, max: 48, step: 1, group: 'Magnet' },
  { type: 'slider', id: 'filings', label: 'Filings (candidates, thousands)', default: 9, min: 0, max: 30, step: 0.5, group: 'Magnet' },
  { type: 'slider', id: 'handX', label: 'Hand: where it hangs over the bar (0 its left end, 1 its right)', default: 0.68, min: 0, max: 1, step: 0.01, group: 'Magnet' },
  { type: 'toggle', id: 'handPull', label: 'The hand grips and pulls the field lines (a small opposite pole); else it has let go (R1)', default: true, group: 'Magnet' },
  { type: 'slider', id: 'sleeveLength', label: 'Gripping hand from the bottom: the sleeve from the bottom trim to the cuff', default: 150, min: 60, max: 300, step: 5, units: 'mm', group: 'Magnet' },
  { type: 'select', id: 'handFrom', label: 'Where the gripping hand comes in', default: 'bottom', options: ['bottom', 'top'],
    optionLabels: { bottom: 'From the bottom edge, pulling lines down from under the bar', top: 'From the top edge (R2)' }, group: 'Magnet' },
  { type: 'select', id: 'fist', label: 'The gripping hand', default: 'slabs', options: ['slabs', 'clean'],
    optionLabels: { slabs: 'Slabs: palm, curled finger segments and thumb (R2)', clean: 'Clean: a squared fist, fingers folded in right angles in one row' }, group: 'Magnet' },
  { type: 'slider', id: 'pullStrength', label: 'The hand\'s pole, against the bar\'s', default: 0.3, min: 0.05, max: 0.8, step: 0.01, group: 'Magnet' },
  { type: 'select', id: 'ribbonBleed', label: 'How L\'s ribbon becomes the field', default: 'progressive', options: ['progressive', 'split', 'off'],
    optionLabels: { progressive: 'Progressive: it loosens turn by turn and unravels into field lines flowing overhead', split: 'Split (R3): it comes apart at one point into field lines', off: 'Off (R2): one line' }, group: 'Magnet' },
  { type: 'toggle', id: 'ribbonField', label: 'L\'s ribbon follows the field toward the near pole (else R1\'s path)', default: true, group: 'Magnet' },
  { type: 'toggle', id: 'figureField', label: 'R\'s figure pulled by the field toward the centre (else R1)', default: true, group: 'Ground' },
  { type: 'select', id: 'figure', label: 'R\'s figure', default: 'r1', options: ['r1', 'clean'],
    optionLabels: { r1: 'R1: the kit agent, flowing limbs, helix-coil head', clean: 'Clean: straight faceted limbs, stacked-ring head' }, group: 'Ground' },
  { type: 'slider', id: 'kneelTurn', label: 'Kneeling figure: turn toward the centre', default: 50, min: 0, max: 80, step: 1, units: '°', group: 'Ground' },
  { type: 'toggle', id: 'groundRings', label: 'Ground rings in silver on the black disc (else bare; under groundFx rings)', default: true, group: 'Ground' },
  { type: 'select', id: 'groundFx', label: 'What the field does in the ground (on R\'s black sheet)', default: 'pulse', options: ['pulse', 'interference', 'rings'],
    optionLabels: { interference: 'Interference: two ring families, from where the strands land and from the disc\'s centre, crossing into moiré', pulse: 'Pulse: rings spreading from where the strands land, filings pointing into the ground between them', rings: 'Rings (R1 to R3): three silver rings' }, group: 'Ground' },
  CUT_CONTROL,
];

// ── The magnet and its field ─────────────────────────────────────────

/** The bar as C carries it: level, centred across the sheet, at the eye height (Lintel's lintel placement). */
export const magnetRect = (bar: LintelBar) => lintelRect(bar);

/**
 * A magnet in C's page frame: its bar, its charges, and `poles`, small poles off the bar (the gripping hand), each a
 * charge `q` at a point that field lines end in within `r` mm.
 */
export interface Magnet {
  /** The bar's rectangle, level, about its centre; `pose` turns it there. */
  rect: { x0: number; x1: number; y0: number; y1: number };
  /** The bar's turn about the centre of `rect` (radians, +x toward +y, clockwise on the page); none when level. */
  pose?: { cx: number; cy: number; angle: number };
  charges: { x: number; y: number; q: number }[];
  poles: { x: number; y: number; q: number; r: number }[];
  /** The gap between the hung panels (mm): the field runs on across it, empty wall. 0 when absent. */
  gap?: number;
}

/** A point of the bar's own (level) frame on the page, and back. The identity for a level bar. */
export function barToPage(m: Pick<Magnet, 'pose'>, p: Point): Point {
  if (!m.pose || m.pose.angle === 0) return p;
  const { cx, cy, angle } = m.pose, c = Math.cos(angle), s = Math.sin(angle);
  return { x: cx + c * (p.x - cx) - s * (p.y - cy), y: cy + s * (p.x - cx) + c * (p.y - cy) };
}
export function pageToBar(m: Pick<Magnet, 'pose'>, p: Point): Point {
  if (!m.pose || m.pose.angle === 0) return p;
  const { cx, cy, angle } = m.pose, c = Math.cos(angle), s = Math.sin(angle);
  return { x: cx + c * (p.x - cx) + s * (p.y - cy), y: cy - s * (p.x - cx) + c * (p.y - cy) };
}

/**
 * Where C's bar lies (`barPose`): R4's, level at the eye height of L's hole; or slipping (the default), its centre near
 * the middle of the sheet and turned SLIP.deg (the same way as on L, more steeply), its right end just out of the
 * reaching hand's grasp. The eye-height alignment with L's hole is given up for it.
 */
export const SLIP = { dx: -10, y: 0.47, deg: -28 };
export const barSlipping = (ctx?: SketchContext): boolean => !!ctx && ctx.params.barPose !== 'r4';
export function barPose(bar: LintelBar, ctx?: SketchContext): { rect: Magnet['rect']; pose?: Magnet['pose'] } {
  const level = magnetRect(bar);
  if (!barSlipping(ctx)) return { rect: level };
  const cx = PAGE.width / 2 + SLIP.dx, cy = SLIP.y * PAGE.height, hl = (level.x1 - level.x0) / 2, hh = (level.y1 - level.y0) / 2;
  return { rect: { x0: cx - hl, x1: cx + hl, y0: cy - hh, y1: cy + hh }, pose: { cx, cy, angle: SLIP.deg * Math.PI / 180 } };
}
/** C's onlay footprint: L's bar placed by `barPose` (footprintOf the part cut: congruent by construction). */
export function barFootprint(bar: LintelBar, ctx?: SketchContext): Cut {
  const { rect, pose } = barPose(bar, ctx);
  if (!pose) return lintelFootprint(bar);
  return footprintOf(bar.cut, { dx: (rect.x0 + rect.x1) / 2 - bar.centre.x, dy: (rect.y0 + rect.y1) / 2 - bar.centre.y, rotate: SLIP.deg - THREE.MathUtils.radToDeg(bar.tilt) });
}

/**
 * The bar magnetised along its length: a sheet of charge on each end face, north (+) on the left. With `ctx` and the
 * `handPull` control on, the gripping hand is a small south pole (`pullStrength` of the bar's) at `gripPoint`; with
 * the bar slipping, the fist reaches toward the bar's right end and closes just short of it, and being a south pole
 * like that end, it pushes it away.
 */
export function magnet(bar: LintelBar, ctx?: SketchContext): Magnet {
  const { rect, pose } = barPose(bar, ctx);
  const frame = { pose };
  const charges: Magnet['charges'] = [];
  const K = 9, inset = 0.04 * (rect.x1 - rect.x0);
  for (let i = 0; i < K; i++) {
    const y = rect.y0 + (rect.y1 - rect.y0) * (i + 0.5) / K;
    charges.push({ ...barToPage(frame, { x: rect.x0 + inset, y }), q: 1 / K }, { ...barToPage(frame, { x: rect.x1 - inset, y }), q: -1 / K });
  }
  const poles: Magnet['poles'] = [];
  if (ctx && ctx.params.handPull !== false) {
    // The hand is a small magnet of its own: its south pole in the fist, its north up the arm, off the top of the sheet,
    // so it pulls lines into the grip without turning the whole far field (a lone pole would draw lines in from all round).
    const g = pose ? reachPoint({ rect, pose }, ctx) : gripPoint(ctx, rect), q = n(ctx, 'pullStrength', 0.3, 0.05, 0.8);
    const arm = handFromBottom(ctx) ? { x: g.x + ARM.x, y: TRIM.y1 + ARM_OFF } : { x: g.x + ARM.x, y: g.y + ARM.y };
    poles.push({ ...g, q: -q, r: GRIP_R }, { ...arm, q, r: GRIP_R });
    for (const pole of poles) charges.push({ x: pole.x, y: pole.y, q: pole.q });
  }
  const gap = ctx ? n(ctx, 'hangGap', 76.2, 0, 101.6) : 0;
  const made: Magnet = pose ? { rect, pose, charges, poles } : { rect, charges, poles };
  if (gap > 0) made.gap = gap;
  return made;
}

/** The slipping bar's right end (the middle of its end face) on the page. */
export const barEnd = (m: Pick<Magnet, 'rect' | 'pose'>): Point => barToPage(m, { x: m.rect.x1, y: (m.rect.y0 + m.rect.y1) / 2 });
/** The middle of the slipping bar's lower edge on the page. */
export const barUnder = (m: Pick<Magnet, 'rect' | 'pose'>): Point => barToPage(m, { x: (m.rect.x0 + m.rect.x1) / 2, y: m.rect.y1 });
/** Whether the fist reaches for the bar's middle (`reachFor`, the default) rather than its right end (R5). */
export const reachesMiddle = (ctx?: SketchContext): boolean => !ctx || ctx.params.reachFor !== 'end';
/** What the fist reaches for: the bar's lower edge's middle, or its right end. */
export const reachTarget = (m: Pick<Magnet, 'rect' | 'pose'>, ctx?: SketchContext): Point => (reachesMiddle(ctx) ? barUnder(m) : barEnd(m));
/** R5: from the right end, this far right and down; to the middle, this far out from the lower edge, square to the bar (mm). */
const REACH = { x: 14, y: 34 }, REACH_UNDER = 30;
/** Where the reaching fist closes, just short of what it reaches for. */
export const reachPoint = (m: Pick<Magnet, 'rect' | 'pose'>, ctx?: SketchContext): Point => {
  if (!reachesMiddle(ctx)) { const e = barEnd(m); return { x: e.x + REACH.x, y: e.y + REACH.y }; }
  const u = barUnder(m), a = m.pose?.angle ?? 0;
  return { x: u.x - Math.sin(a) * REACH_UNDER, y: u.y + Math.cos(a) * REACH_UNDER };
};

/** How far above the bar the gripping hand's pole sits (mm), and the radius field lines end in round it. */
const GRIP_RISE = 30, GRIP_R = 3;
/**
 * From the fist's pole to the hand's other pole, up the arm off the top of the sheet (mm, R2's hand from the top); from
 * the bottom the other pole is down the arm, ARM_OFF below the bottom trim.
 */
const ARM = { x: 12, y: -115 }, ARM_OFF = 40;
/** Whether the gripping hand comes in from the bottom edge (`handFrom`, the default) rather than the top. */
export const handFromBottom = (ctx: SketchContext): boolean => ctx.params.handFrom !== 'top';
/** Where the gripping hand closes: at `handX` of the bar's length, GRIP_RISE above it (from the top), or from the bottom at the top of a sleeve `sleeveLength` long. */
export function gripPoint(ctx: SketchContext, rect: Magnet['rect']): Point {
  const x = rect.x0 + (rect.x1 - rect.x0) * n(ctx, 'handX', 0.68, 0, 1);
  if (!handFromBottom(ctx)) return { x, y: rect.y0 - GRIP_RISE };
  // From the bottom the sleeve runs `sleeveLength` up from the bottom trim to the cuff, and the fist closes FIST_MM
  // above the cuff (but never nearer the bar than GRIP_RISE).
  return { x, y: Math.max(rect.y1 + GRIP_RISE, TRIM.y1 - n(ctx, 'sleeveLength', 150, 60, 300) - FIST_MM) };
}
/** From the cuff to the middle of the closed fist, on the sheet (mm). */
export const FIST_MM = 56;

// ── One field across the triptych ────────────────────────────────────

/**
 * The three panels side by side in one frame: C's page frame, L's shifted one trimmed panel to the left and R's one to
 * the right, the trims meeting (no hanging gap, as Lintel's thread heights: what leaves one panel's edge enters the
 * next at the same height). `toC` takes a panel's page point into C's frame, where the magnet is.
 */
export const HANG_GAP = 0;
/** The magnet's hanging gap (`hangGap`), 0 for R5's panels edge to edge. */
export const gapOf = (m: Pick<Magnet, 'gap'>): number => m.gap ?? HANG_GAP;
const PANEL_W = TRIM.x1 - TRIM.x0;
export type Panel = 'l' | 'c' | 'r';
export const toC = (panel: Panel, p: Point, gap = HANG_GAP): Point => ({ x: p.x + (panel === 'l' ? -1 : panel === 'r' ? 1 : 0) * (PANEL_W + gap), y: p.y });
/** The field at a page point of a panel, the panels hung `m.gap` apart. */
export const fieldIn = (m: Magnet, panel: Panel, p: Point): Point => fieldAt(m, toC(panel, p, gapOf(m)));

/**
 * L's ribbon pulled by the magnet: from the crown of the bust's coil it sets out up and to the right (R1's way), and the
 * field takes it over within about `pull` mm, turning it along the field line toward the north pole, the bar's near end
 * in C, until it leaves L's right edge. Its twist tightens where the field is strong (`ribbonPitch`).
 */
export function ribbonPath(crown: Point, m: Magnet, pull = 90): Point[] {
  const d0 = { x: 22 / Math.hypot(22, 14), y: -14 / Math.hypot(22, 14) };
  const pts: Point[] = [crown];
  let p = crown;
  for (let s = 0; s < 900 && p.x < TRIM.x1 + 6 && p.y > TRIM.y0 - 20 && p.y < TRIM.y1 + 20; s += 0.5) {
    const B = fieldIn(m, 'l', p), l = Math.hypot(B.x, B.y) || 1;
    const w = 1 - Math.exp(-s / pull);
    const dx = d0.x * (1 - w) - (B.x / l) * w, dy = d0.y * (1 - w) - (B.y / l) * w, dl = Math.hypot(dx, dy) || 1;
    p = { x: p.x + 0.5 * dx / dl, y: p.y + 0.5 * dy / dl };
    pts.push(p);
  }
  return pts;
}

/** The twist's pitch along L's ribbon, as a multiple of the base: shorter where the field is strong (against its strength at L's right edge, at the bar's height). */
export function ribbonPitch(m: Magnet, bar: LintelBar): (p: Point) => number {
  const ref = Math.hypot(...Object.values(fieldIn(m, 'l', { x: TRIM.x1, y: (m.rect.y0 + m.rect.y1) / 2 })) as [number, number]);
  void bar;
  return p => Math.max(0.45, Math.min(1.6, (Math.hypot(...Object.values(fieldIn(m, 'l', p)) as [number, number]) / ref) ** -0.4));
}

/** A flat ribbon's twist (the cosine `flatRibbon` scales its width by) at each point of a path, its pitch varying as `pitchAt`. */
export function ribbonTwist(path: Point[], pitch: number, phase0: number, pitchAt: (p: Point) => number): number[] {
  let phase = phase0;
  return path.map((p, i) => {
    if (i) phase += 2 * Math.PI * Math.hypot(p.x - path[i - 1].x, p.y - path[i - 1].y) / (pitch * pitchAt(p));
    return Math.cos(phase);
  });
}

/** Where L's ribbon starts to unravel: this far (mm, along the sheet) before L's right edge, at the widest point of its twist nearby. */
const PEEL_MM = 72, PEEL_SEARCH = 12;
/** The ribbon's lines that peel off as field lines: their place across it (-1 to 1, as `flatRibbon` draws them) and ink. */
const PEELS: [number, Ink][] = [[-1, 'vermilion'], [-1 / 3, 'ultramarine'], [0, 'acid'], [1 / 3, 'ultramarine'], [1, 'vermilion']];

export interface Bleed { ribbon: Point[]; strands: { ink: Ink; path: Point[] }[] }

/**
 * L's ribbon bleeding into the field: it follows `ribbonPath` until about PEEL_MM before L's right edge, where it comes
 * apart. Its edges, spine and two laminations each go on from where they lie across the ribbon at that point, splayed a
 * little apart, and the field takes each over within about `pull` mm, along its own field line toward C's north pole:
 * the ribbon unravels into field lines, which leave L's right edge at their own heights.
 */
export function ribbonBleed(crown: Point, m: Magnet, bar: LintelBar, o: { width: number; pitch: number }, pull = 34): Bleed {
  const full = ribbonPath(crown, m);
  const twist = ribbonTwist(full, o.pitch, 0, ribbonPitch(m, bar));
  // The peel: the widest twist within PEEL_SEARCH of the point PEEL_MM before the edge.
  let target = full.findIndex(p => p.x > TRIM.x1 - PEEL_MM);
  if (target < 2) target = Math.max(2, Math.floor(full.length / 2));
  let i0 = target;
  for (let i = Math.max(2, target - PEEL_SEARCH * 2); i < Math.min(full.length - 1, target + PEEL_SEARCH * 2); i++) if (Math.abs(twist[i]) > Math.abs(twist[i0])) i0 = i;
  const a = full[i0 - 1], b = full[i0], d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const t0 = { x: (b.x - a.x) / d, y: (b.y - a.y) / d }, nrm = { x: -t0.y, y: t0.x };
  const half = o.width / 2, sign = Math.sign(twist[i0]) || 1;
  const strands = PEELS.map(([v, ink]) => {
    const theta = 0.95 * v * sign;
    const d0 = { x: t0.x * Math.cos(theta) + nrm.x * Math.sin(theta), y: t0.y * Math.cos(theta) + nrm.y * Math.sin(theta) };
    let p = { x: b.x + nrm.x * v * half * twist[i0], y: b.y + nrm.y * v * half * twist[i0] };
    const path: Point[] = [p];
    for (let s = 0; s < 600 && p.x < TRIM.x1 + 6 && p.y > TRIM.y0 - 20 && p.y < TRIM.y1 + 20; s += 0.5) {
      const B = fieldIn(m, 'l', p), l = Math.hypot(B.x, B.y) || 1, w = 1 - Math.exp(-s / pull);
      const dx = d0.x * (1 - w) - (B.x / l) * w, dy = d0.y * (1 - w) - (B.y / l) * w, dl = Math.hypot(dx, dy) || 1;
      p = { x: p.x + 0.5 * dx / dl, y: p.y + 0.5 * dy / dl };
      path.push(p);
    }
    return { ink, path };
  });
  return { ribbon: full.slice(0, i0 + 1), strands };
}

/** The lines L's ribbon unravels into: their place across it (-1 to 1) and ink (the kit's helix inks: edges, laminations, spine). */
const UNRAVEL: [number, Ink][] = [[-1, 'vermilion'], [-2 / 3, 'violet'], [-1 / 3, 'ultramarine'], [0, 'acid'], [1 / 3, 'ultramarine'], [2 / 3, 'violet'], [1, 'vermilion']];
/** Along the ribbon (mm): where it starts to loosen, where it has come apart into separate lines, and how far they then spread (times its half width). */
const LOOSEN = { from: 40, to: 190, spread: 3.2 };
/** Steered (panels hung apart), how far before L's edge the ribbon reaches the level height and runs on level (mm). */
const STEER_IN = 25;

export interface Unravel extends Bleed {
  /** The twist's pitch multiple at each point of `ribbon` (by identity), for `flatRibbon`'s `pitchAt`. */
  pitchAt: (p: Point) => number;
  /** Ribs across the loosening ribbon, thinning out as it comes apart. */
  ribs: Point[][];
}

const smoothstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * L's ribbon unravelling progressively into the field. From the crown of the bust's coil it rises and arcs overhead
 * (its heading turning from steeply up to level over its first 110 mm, kept under the top trim), while the field takes
 * it over toward C's north pole. From LOOSEN.from to LOOSEN.to along it, it loosens: its twist slackens (the pitch
 * growing fourfold), and its edges, laminations and spine drift apart a little more each turn until they are seven
 * separate lines spread evenly across LOOSEN.spread of its half width; from there each goes on as a field line of its
 * own toward the north pole, and leaves L's right edge at its own height (C carries each on from there).
 */
export function ribbonUnravel(crown: Point, m: Magnet, bar: LintelBar, o: { width: number; pitch: number }): Unravel {
  const half = o.width / 2, base = ribbonPitch(m, bar), step = 0.5;
  const dirTo = (a: number) => ({ x: Math.cos(a), y: Math.sin(a) });
  const toNorth = (p: Point) => { const B = fieldIn(m, 'l', p), l = Math.hypot(B.x, B.y) || 1; return { x: -B.x / l, y: -B.y / l }; };
  // With the panels hung apart, the ribbon is steered, after its arc overhead, down to the height where the field
  // crosses the gap level (`seamLevel`) and runs on level to L's edge, the field taking it over there: its lines then
  // cross the gap near level, and drift least if the panels are hung a little nearer or farther.
  const steer = gapOf(m) > 0 ? seamLevel(m) : undefined;
  // The centreline, stepped until it is fully the field's.
  const c: Point[] = [crown], ss: number[] = [0];
  let p = crown, levelled = false;
  for (let s = 0; (steer === undefined ? s < LOOSEN.to + 40 : s < 900) && p.x < TRIM.x1 + 6; s += step) {
    let design = dirTo(THREE.MathUtils.degToRad(-65 + 70 * smoothstep(0, 110, s)));
    if (steer !== undefined) {
      // After the arc, down toward the level height STEER_IN before the edge; once there, level on to the edge.
      const tx = TRIM.x1 - STEER_IN - p.x, ty = steer - p.y, tl = Math.hypot(tx, ty) || 1, k = smoothstep(90, 150, s);
      if (tl < 3 || p.x >= TRIM.x1 - STEER_IN) levelled = true;
      design = levelled ? { x: 1, y: 0 } : { x: design.x * (1 - k) + k * tx / tl, y: design.y * (1 - k) + k * ty / tl };
    }
    const w = steer === undefined ? smoothstep(60, LOOSEN.to - 10, s) : smoothstep(STEER_IN, 0, TRIM.x1 - p.x), f = toNorth(p);
    const dx = design.x * (1 - w) + f.x * w;
    let dy = design.y * (1 - w) + f.y * w;
    // Kept under the top trim: near it the heading bends level.
    if (p.y < TRIM.y0 + 16 && dy < 0) dy *= Math.max(0, (p.y - TRIM.y0 - 9) / 7);
    const l = Math.hypot(dx, dy) || 1;
    p = { x: p.x + step * dx / l, y: p.y + step * dy / l };
    c.push(p); ss.push(s + step);
  }
  // Steered, it has come apart by 12 mm before L's edge; else by LOOSEN.to along it.
  const iTo = steer === undefined ? c.length - 1 : Math.max(1, c.findIndex(q => q.x >= TRIM.x1 - 12));
  const loosenTo = steer === undefined ? LOOSEN.to : ss[iTo];
  const u = ss.map(s => smoothstep(LOOSEN.from, loosenTo, s));
  const mul = new Map<Point, number>();
  let phase = 0;
  const cosPhase = c.map((q, i) => {
    const k = base(q) * (1 + 3 * u[i]);
    mul.set(q, k);
    if (i) phase += 2 * Math.PI * step / (o.pitch * k);
    return Math.cos(phase);
  });
  const normal = c.map((_, i) => { const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)], d = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: -(b.y - a.y) / d, y: (b.x - a.x) / d }; });
  const offset = (i: number, v: number) => v * half * ((1 - u[i]) * cosPhase[i] + u[i] * LOOSEN.spread);
  const at = (i: number, v: number): Point => ({ x: c[i].x + normal[i].x * offset(i, v), y: c[i].y + normal[i].y * offset(i, v) });
  const iA = ss.findIndex(s => s >= LOOSEN.from), iB = iTo;
  const strands = UNRAVEL.map(([v, ink]) => {
    const path: Point[] = [];
    for (let i = iA; i <= iB; i++) path.push(at(i, v));
    // Then a field line of its own, to past L's right edge.
    let q = path[path.length - 1];
    for (let n = 0; n < 1600 && q.x < TRIM.x1 + 6 && q.y > TRIM.y0 - 30 && q.y < TRIM.y1 + 30; n++) { const f = toNorth(q); q = { x: q.x + step * f.x, y: q.y + step * f.y }; path.push(q); }
    return { ink, path };
  });
  // Ribs across the loosening ribbon, edge to edge, ever further apart, gone by the time it is half undone.
  const ribs: Point[][] = [];
  let next = ss[iA];
  for (let i = iA; i <= iB; i++) {
    if (u[i] > 0.5 || ss[i] < next) continue;
    next = ss[i] + 2.4 * (1 + 6 * u[i]);
    if (Math.abs(offset(i, 1)) * 2 < 1.2) continue;
    ribs.push([at(i, -1), at(i, 1)]);
  }
  return { ribbon: c.slice(0, iA + 1), strands, ribs, pitchAt: q => mul.get(q) ?? base(q) };
}

/**
 * The height (page y) where the field crosses the gap between L and C level: at the gap's middle, of the heights where
 * the field points on toward the north pole (rightward), the one where it is most nearly level, the nearest the
 * north pole's height among near-equals.
 */
export function seamLevel(m: Magnet): number {
  const x = TRIM.x1 + gapOf(m) / 2, north = barToPage(m, { x: m.rect.x0, y: (m.rect.y0 + m.rect.y1) / 2 });
  let best = north.y, score = Infinity;
  for (let y = TRIM.y0 + 40; y <= TRIM.y1 - 40; y += 0.5) {
    const B = fieldIn(m, 'l', { x, y });
    if (B.x >= 0) continue;
    const v = Math.abs(B.y / B.x) + 0.002 * Math.abs(y - north.y);
    if (v < score) { score = v; best = y; }
  }
  return best;
}

/** The lines L's ribbon becomes, by `ribbonBleed` (with `ribbonField` on): the progressive unravel, R3's split, or R2's one line. */
export function ribbonLines(ctx: SketchContext, crown: Point, m: Magnet, bar: LintelBar, o: { width: number; pitch: number }): Point[][] {
  const mode = String(ctx.params.ribbonBleed);
  if (mode === 'off') return [ribbonPath(crown, m)];
  if (mode === 'split') return ribbonBleed(crown, m, bar, o).strands.map(st => st.path);
  return ribbonUnravel(crown, m, bar, o).strands.map(st => st.path);
}

/** Where a page path crosses x = `x` (its first crossing), or undefined. */
export function crossingY(path: Point[], x: number): number | undefined {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if ((a.x - x) * (b.x - x) <= 0 && a.x !== b.x) return a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
  }
  return undefined;
}

/** The field line through a point of C, traced against the field into the north pole (the line L's ribbon becomes in C). */
export const lineToNorth = (m: Magnet, p: Point): Point[] => follow(m, p, -1).points;

/**
 * A pull on R's figure toward C: a page point moved along the field there (into the bar's south end, toward the
 * centre panel) by up to `amount` mm, scaled by `weight` (0 at the ground, 1 at the crown of the head).
 */
export function fieldPull(m: Magnet, amount: number, weight: (p: Point) => number): (p: Point) => Point {
  return p => {
    const w = weight(p);
    if (w <= 0) return p;
    const B = fieldIn(m, 'r', p), l = Math.hypot(B.x, B.y) || 1;
    return { x: p.x + amount * w * B.x / l, y: p.y + amount * w * B.y / l };
  };
}

/** The field at a page point (a 1/r² law, as of a three-dimensional bar seen in its plane). */
export function fieldAt(m: Magnet, p: Point): Point {
  let x = 0, y = 0;
  for (const c of m.charges) {
    const dx = p.x - c.x, dy = p.y - c.y, r2 = dx * dx + dy * dy + 0.25, r3 = r2 * Math.sqrt(r2);
    x += c.q * dx / r3; y += c.q * dy / r3;
  }
  return { x, y };
}

const inRect = (r: Magnet['rect'], p: Point, grow = 0) => p.x > r.x0 - grow && p.x < r.x1 + grow && p.y > r.y0 - grow && p.y < r.y1 + grow;
/** How far the field lines are followed off the sheet before they are let go (mm), beyond the hanging gap. */
const ROAM = 90;
/** How far a field line runs under the bar before it stops (mm): the assembly's bleed. */
const UNDER = 2;

/** One field line from `start`, followed along the field (`dir` 1) or against it (-1) until it reaches a pole, enters the bar or leaves the roam. */
function follow(m: Magnet, start: Point, dir: 1 | -1, step = 0.6): { points: Point[]; ended: 'pole' | 'hand' | 'away' } {
  const at = (p: Point) => { const f = fieldAt(m, p), l = Math.hypot(f.x, f.y) || 1; return { x: dir * f.x / l, y: dir * f.y / l }; };
  const pts: Point[] = [start];
  let p = start;
  for (let i = 0; i < 6000; i++) {
    const k1 = at(p), k2 = at({ x: p.x + k1.x * step / 2, y: p.y + k1.y * step / 2 }), k3 = at({ x: p.x + k2.x * step / 2, y: p.y + k2.y * step / 2 }), k4 = at({ x: p.x + k3.x * step, y: p.y + k3.y * step });
    p = { x: p.x + step * (k1.x + 2 * k2.x + 2 * k3.x + k4.x) / 6, y: p.y + step * (k1.y + 2 * k2.y + 2 * k3.y + k4.y) / 6 };
    pts.push(p);
    // Into the bar by the assembly's bleed, so a bar glued a little off never shows a gap at the pole.
    if (inRect(m.rect, pageToBar(m, p), -UNDER)) return { points: pts, ended: 'pole' };
    if (m.poles.some(q => Math.hypot(p.x - q.x, p.y - q.y) < q.r)) return { points: pts, ended: 'hand' };
    const roam = ROAM + gapOf(m);
    if (p.x < TRIM.x0 - roam || p.x > TRIM.x1 + roam || p.y < TRIM.y0 - roam || p.y > TRIM.y1 + roam) return { points: pts, ended: 'away' };
  }
  return { points: pts, ended: 'away' };
}

/**
 * The field lines: `count` lines leave the north end at equal steps of the flux through a contour hugging it (along
 * the top and bottom edges from a third of the way in, and round the end face, 1.5 mm out), so they crowd where the
 * field is strong and spread with distance, as the flux does; each is followed to the south end or off the sheet.
 * Lines that leave the sheet have their mirror twins drawn from the south end, which closes the picture.
 */
export function fieldLines(m: Magnet, count: number): Point[][] {
  const { rect } = m, L = rect.x1 - rect.x0, mid = (rect.x0 + rect.x1) / 2, g = 1.5;
  // The contour round one end (`side` -1 the north end on the left, 1 the south on the right): along the top from a
  // third of the way in to the end, down the end face, back along the bottom.
  const contour = (side: -1 | 1): Point[] => {
    const end = side < 0 ? rect.x0 - g : rect.x1 + g, inner = side < 0 ? rect.x0 + 0.34 * L : rect.x1 - 0.34 * L;
    return [{ x: inner, y: rect.y0 - g }, { x: end, y: rect.y0 - g }, { x: end, y: rect.y1 + g }, { x: inner, y: rect.y1 + g }].map(q => barToPage(m, q));
  };
  /** Points along a polyline, each with the flux crossing its share of it against its normal (`sign` -1) or along it (1). */
  const fluxAlong = (corners: Point[], sign: 1 | -1, closed = false): { p: Point; flux: number }[] => {
    const out: { p: Point; flux: number }[] = [];
    const segs = closed ? corners.length : corners.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = corners[i], b = corners[(i + 1) % corners.length], len = Math.hypot(b.x - a.x, b.y - a.y), N = Math.ceil(len / 0.25);
      const nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
      for (let k = 0; k < N; k++) {
        const p = { x: a.x + (b.x - a.x) * (k + 0.5) / N, y: a.y + (b.y - a.y) * (k + 0.5) / N };
        const f = fieldAt(m, p);
        out.push({ p, flux: Math.max(0, sign * (f.x * nx + f.y * ny)) * len / N });
      }
    }
    return out;
  };
  /** Seeds at equal steps of flux along the samples, each the middle of its step: the k-th where the flux passes `at(k)`. */
  const seeds = (samples: { p: Point; flux: number }[], at: (k: number) => number): Point[] => {
    const out: Point[] = [];
    let acc = 0, k = 0;
    for (const q of samples) { acc += q.flux; while (acc >= at(k)) { out.push(q.p); k++; } }
    return out;
  };
  const north = fluxAlong(contour(-1), -1);
  const total = north.reduce((t, q) => t + q.flux, 0), perLine = total / count;
  const step = (k: number) => k < count ? (k + 0.5) / count * total : Infinity;
  const out: Point[][] = [];
  const both = (p: Point) => { const fwd = follow(m, p, 1), back = follow(m, p, -1); return { line: [...back.points.reverse(), ...fwd.points.slice(1)], fwd, back }; };
  if (m.poles.length === 0) {
    // R1: one seed per flux step round the north end; a line that leaves the sheet gets its mirror twin from the south.
    for (const p of seeds(north, step)) {
      const { line, fwd } = both(p);
      out.push(line);
      if (fwd.ended === 'away') out.push(fwd.points.map(q => { const b = pageToBar(m, q); return barToPage(m, { x: 2 * mid - b.x, y: b.y }); }));
    }
    return out;
  }
  // With poles off the bar the picture is no longer symmetric: every line from the north end is traced, then the lines
  // that come into the south end and into the fist from elsewhere (far away, or the hand's own north up the arm),
  // seeded at the same flux per line and traced back.
  for (const p of seeds(north, step)) out.push(both(p).line);
  // A line arriving at the south end or the fist is drawn unless it came from the bar's north end (drawn already).
  const arrivals = (samples: { p: Point; flux: number }[]) => {
    for (const p of seeds(samples, k => (k + 0.5) * perLine)) { const r = both(p); if (r.back.ended !== 'pole') out.push(r.line); }
  };
  arrivals(fluxAlong(contour(1), -1));
  for (const pole of m.poles.filter(q => q.q < 0)) {
    const ring = Array.from({ length: 48 }, (_, i) => ({ x: pole.x + (pole.r + 1.5) * Math.cos(2 * Math.PI * i / 48), y: pole.y + (pole.r + 1.5) * Math.sin(2 * Math.PI * i / 48) }));
    arrivals(fluxAlong(ring, -1, true));
  }
  return out;
}

/**
 * Iron filings: short dashes along the field, packed at the poles and thinning with distance. Candidate points are
 * thrown over the sheet and kept with a chance that grows with the field's strength, never closer than `gap` mm to one
 * kept before; each is a dash 1.4 to 2.6 mm long along the field there.
 */
export function filings(ctx: SketchContext, m: Magnet, candidates: number, keepOut: (p: Point) => boolean): Point[][] {
  const rng = ctx.random('lodestone-filings');
  const ref = Math.hypot(...Object.values(fieldAt(m, barToPage(m, { x: m.rect.x0 - 6, y: (m.rect.y0 + m.rect.y1) / 2 }))) as [number, number]);
  const cells = new Map<string, Point[]>();
  const GAP = 0.85, key = (x: number, y: number) => `${Math.floor(x / GAP)},${Math.floor(y / GAP)}`;
  const near = (p: Point) => { for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of cells.get(`${Math.floor(p.x / GAP) + i},${Math.floor(p.y / GAP) + j}`) ?? []) if (Math.hypot(q.x - p.x, q.y - p.y) < GAP) return true; return false; };
  const out: Point[][] = [];
  for (let i = 0; i < candidates; i++) {
    const p = { x: TRIM.x0 + (TRIM.x1 - TRIM.x0) * rng(), y: TRIM.y0 + (TRIM.y1 - TRIM.y0) * rng() };
    if (inRect(m.rect, pageToBar(m, p), 0.9) || keepOut(p)) { rng(); continue; }
    const f = fieldAt(m, p), s = Math.hypot(f.x, f.y);
    if (rng() > Math.min(1, 2.4 * (s / ref) ** 0.85)) continue;
    if (near(p)) continue;
    const len = 1.4 + 1.2 * rng(), ux = f.x / s, uy = f.y / s;
    out.push([{ x: p.x - ux * len / 2, y: p.y - uy * len / 2 }, { x: p.x + ux * len / 2, y: p.y + uy * len / 2 }]);
    const c = cells.get(key(p.x, p.y)); if (c) c.push(p); else cells.set(key(p.x, p.y), [p]);
  }
  return out;
}

/**
 * Where the field lines reach R's left trim edge, top to bottom, with the slope there (dy/dx): R's strands come in at
 * these heights. The panels hang `gap` apart (C's frame: R's left trim at C's right trim plus the gap), and the field
 * runs on across it. With a gap, lines crossing near level are preferred (they drift least when the panels are hung
 * a little nearer or farther): those steeper than MAX_SLOPE are left out while enough others remain. At most `most`,
 * spread over the crossings, none closer than `spacing` mm to the last.
 */
const MAX_SLOPE = 0.45;
export function rightExits(lines: Point[][], most = 7, spacing = 9, gap = 0): { y: number; slope: number }[] {
  const x = TRIM.x1 + gap;
  let found: { y: number; slope: number }[] = [];
  for (const line of lines) for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    if ((a.x - x) * (b.x - x) <= 0 && a.x !== b.x) {
      const y = a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
      if (y > TRIM.y0 + 25 && y < TRIM.y1 - 60) found.push({ y, slope: (b.y - a.y) / (b.x - a.x) });
    }
  }
  if (gap > 0) { const level = found.filter(e => Math.abs(e.slope) <= MAX_SLOPE); if (level.length >= 5) found = level; }
  found.sort((a, b) => a.y - b.y);
  const kept: { y: number; slope: number }[] = [];
  for (const e of found) if (!kept.length || e.y - kept[kept.length - 1].y >= spacing) kept.push(e);
  if (kept.length <= most) return kept;
  return Array.from({ length: most }, (_, i) => kept[Math.round(i * (kept.length - 1) / (most - 1))]);
}

/**
 * The lines that carry C's field into R across the gap: SEAM_LINES field lines through R's left edge (hung the gap
 * away), SEAM_STEP mm apart about the height where the field crosses it level (the nearest the south pole's height), each followed
 * both ways. They are drawn in C with the rest of the field (`withSeamLines`), and R's strands come in where they reach
 * R's left edge: near level, they drift least if the panels are hung a little nearer or farther.
 */
const SEAM_LINES = 7, SEAM_STEP = 6;
export function seamLines(m: Magnet): Point[][] {
  const x = TRIM.x1 + gapOf(m), south = barToPage(m, { x: m.rect.x1, y: (m.rect.y0 + m.rect.y1) / 2 });
  let level = south.y, score = Infinity;
  for (let y = TRIM.y0 + 60; y <= TRIM.y1 - 100; y += 0.5) {
    const B = fieldAt(m, { x, y }), v = Math.abs(B.y / (B.x || 1e-12)) + 0.002 * Math.abs(y - south.y);
    if (v < score) { score = v; level = y; }
  }
  return Array.from({ length: SEAM_LINES }, (_, k) => {
    const p = { x, y: level + (k - (SEAM_LINES - 1) / 2) * SEAM_STEP };
    const fwd = follow(m, p, 1), back = follow(m, p, -1);
    return [...back.points.reverse(), ...fwd.points.slice(1)];
  });
}

/** C's field lines with the seam lines added, less any line that comes within 2.5 mm of a seam line at C's right edge. */
export function withSeamLines(m: Magnet, lines: Point[][]): Point[][] {
  if (!gapOf(m)) return lines;
  const seams = seamLines(m), at = seams.map(l => crossingY(l, TRIM.x1)).filter((y): y is number => y !== undefined);
  return [...lines.filter(l => { const y = crossingY(l, TRIM.x1); return y === undefined || at.every(a => Math.abs(a - y) > 2.5); }), ...seams];
}

/** Where R's strands come in, with the slope there: the seam lines' heights at R's left edge (panels hung apart), else `rightExits` (R5). */
export function rEntries(m: Magnet, lines: Point[][]): { y: number; slope: number }[] {
  if (!gapOf(m)) return rightExits(lines);
  return rightExits(seamLines(m), SEAM_LINES, 0.1, gapOf(m));
}

/** A word along a page line (a field line or a strand), `offset` mm to its side, starting `from` mm along it. */
export function wordAlong(word: string, line: Point[], from: number, height: number, offset: number): Point[][] {
  const guide: Point[] = [];
  let s = 0;
  for (let i = 1; i < line.length && s < from + 6 * height * word.length; i++) {
    s += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
    if (s >= from) guide.push(line[i]);
  }
  if (guide.length < 2) return [];
  // Where the line runs out (off the sheet, into a pole) before the word fits, there is no room for it here.
  let length = 0;
  for (let i = 1; i < guide.length; i++) length += Math.hypot(guide[i].x - guide[i - 1].x, guide[i].y - guide[i - 1].y);
  if (length < measureStrokeText(word, { face: 'sans', height }) + 0.5) return [];
  return strokeTextOnPath(word, guide, { face: 'sans', height, align: 'start', normalOffset: offset });
}

/** Clip page paths to the trim. */
export const clipTrim = (paths: Point[][]): Point[][] => paths.flatMap(p => clipToRect(p, TRIM));

// ── Hands ────────────────────────────────────────────────────────────

/** A slab whose own axes are `x` (across), `y` (along) and `z` (through), centred at `c`. */
export function orientedSlab(c: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, w: number, h: number, d: number, beat: number): Slab {
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  const xx = new THREE.Vector3().crossVectors(y, z).normalize();
  const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xx, y.clone().normalize(), z), 'XYZ');
  const sl = solid(c.x, c.y, c.z, w, h, d, beat, 'stub');
  sl.rx = e.x; sl.ry = e.y; sl.rz = e.z;
  return sl;
}

/**
 * A squared fist of slabs: a palm, four fingers side by side in one row, each folded twice at right angles (out from
 * the palm, across, and back in against it), and the thumb laid across the folded fingers. Fewer, cleaner planes than
 * `slabHand` curled shut.
 */
export function squareFist(o: Omit<HandOptions, 'curl' | 'spread'>): Slab[] {
  const s = o.size, along = o.along.clone().normalize(), across = o.across.clone().normalize();
  const palmSide = new THREE.Vector3().crossVectors(along, across).normalize();
  const slabs: Slab[] = [orientedSlab(o.wrist.clone().addScaledVector(along, 0.45 * s), across, along, 0.88 * s, 0.9 * s, 0.3 * s, 0)];
  const w = 0.2 * s, t = 0.21 * s;
  for (let f = 0; f < 4; f++) {
    const side = (f - 1.5) * 0.225 * s;
    const knuckle = o.wrist.clone().addScaledVector(along, 0.9 * s).addScaledVector(across, side);
    // Out along the hand, then folded toward the palm side, then back in against the palm.
    const legs: [THREE.Vector3, number][] = [[along, 0.3 * s], [palmSide, 0.28 * s], [along.clone().negate(), 0.22 * s]];
    let at = knuckle.clone();
    legs.forEach(([dir, len], j) => {
      const x = j === 1 ? across : across;
      slabs.push(orientedSlab(at.clone().addScaledVector(dir, len / 2), x, dir, w, len + 0.04 * s, t, 1 + f * 3 + j));
      at = at.clone().addScaledVector(dir, len);
    });
  }
  // The thumb: from the palm's side, across the front of the folded fingers.
  const base = o.wrist.clone().addScaledVector(along, 0.55 * s).addScaledVector(across, -0.48 * s).addScaledVector(palmSide, 0.22 * s);
  slabs.push(orientedSlab(base.clone().addScaledVector(across, 0.2 * s), across.clone().negate(), across, 0.22 * s, 0.42 * s, 0.2 * s, 20));
  slabs.push(orientedSlab(base.clone().addScaledVector(across, 0.55 * s).addScaledVector(palmSide, 0.08 * s), along, across, 0.2 * s, 0.32 * s, 0.19 * s, 21));
  return slabs;
}

export interface HandOptions {
  /** The wrist, the way the fingers point, and across the back of the hand (thumb side negative). */
  wrist: THREE.Vector3; along: THREE.Vector3; across: THREE.Vector3;
  /** World units of the palm's length; everything scales with it. */
  size: number;
  /** How far each knuckle bends toward the palm side (radians), and how far the fingers fan apart. */
  curl: number; spread: number;
}

/**
 * A faceted hand of slabs: a palm, four fingers of three segments and a thumb of two, each a touch narrower toward the
 * tip. Planes, not a mitten. The palm side is `along × across`.
 */
export function slabHand(o: HandOptions): Slab[] {
  const s = o.size, along = o.along.clone().normalize(), across = o.across.clone().normalize();
  const palmSide = new THREE.Vector3().crossVectors(along, across).normalize();
  const slabs: Slab[] = [];
  slabs.push(orientedSlab(o.wrist.clone().addScaledVector(along, 0.5 * s), across, along, 0.86 * s, s, 0.26 * s, 0));
  const lengths = [0.42, 0.28, 0.22];
  for (let f = 0; f < 4; f++) {
    const fan = o.spread * (f - 1.5);
    let dir = along.clone().applyAxisAngle(palmSide, fan);
    let at = o.wrist.clone().addScaledVector(along, s).addScaledVector(across, (f - 1.5) * 0.22 * s);
    const reach = f === 0 || f === 3 ? 0.86 : 1;
    for (let j = 0; j < 3; j++) {
      dir = dir.clone().applyAxisAngle(new THREE.Vector3().crossVectors(dir, palmSide).normalize(), -o.curl * (j === 0 ? 0.6 : 1));
      const len = lengths[j] * s * reach;
      const x = new THREE.Vector3().crossVectors(palmSide, dir).normalize();
      slabs.push(orientedSlab(at.clone().addScaledVector(dir, len / 2), x, dir, 0.19 * s * (1 - 0.08 * j), len + 0.02 * s, 0.17 * s * (1 - 0.08 * j), 1 + f * 3 + j));
      at = at.clone().addScaledVector(dir, len);
    }
  }
  // The thumb: from the palm's side near the wrist, out and down.
  let dir = along.clone().applyAxisAngle(palmSide, 0.75).applyAxisAngle(across, 0.35);
  let at = o.wrist.clone().addScaledVector(along, 0.3 * s).addScaledVector(across, -0.4 * s);
  for (let j = 0; j < 2; j++) {
    const len = (j === 0 ? 0.42 : 0.32) * s;
    dir = dir.clone().applyAxisAngle(new THREE.Vector3().crossVectors(dir, palmSide).normalize(), -o.curl * 0.7);
    const x = new THREE.Vector3().crossVectors(palmSide, dir).normalize();
    slabs.push(orientedSlab(at.clone().addScaledVector(dir, len / 2), x, dir, 0.22 * s, len, 0.19 * s, 20 + j));
    at = at.clone().addScaledVector(dir, len);
  }
  return slabs;
}
