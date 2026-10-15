import type { Control, Cut, Point, SketchContext } from '../../src/sketch/types.ts';
import { TRIM, convexHull } from './world.ts';

/**
 * Lodestone's cut sets, as data: each scheme lists, per panel, simple shapes cut from one sheet to show the sheet
 * beneath (black under C's gold and R's white, gold under L's black), each placed from the panel's own anchors (the
 * poles, the grip, the sleeve, the head, where the strands come in, R's floor). The bar cut from L is not here: every
 * scheme keeps it. The angular set (the default) has no arcs or circles. `cutScheme` picks the set; the mockups `k1` to `k4` (vault active/breach-triptych/lodestone-cuts)
 * are approximated in the shapes this tooling cuts, so a pick can be swapped in.
 */

export type CutSchemeId = 'tie' | 'angular' | 'field' | 'r3' | 'k1' | 'k2' | 'k3' | 'k4';
const SCHEMES: CutSchemeId[] = ['tie', 'angular', 'field', 'r3', 'k1', 'k2', 'k3', 'k4'];

export const CUT_CONTROL: Control = {
  type: 'select', id: 'cutScheme', label: 'Cut set (shapes showing the sheet beneath)', default: 'tie', options: SCHEMES,
  optionLabels: {
    tie: 'Tie (R6): angular; in L the tie (or the shirt about it, `lCut`) and the corner; C and R as angular',
    angular: 'Angular (R5): no arcs or circles; a suit plane and a corner in L; black behind C\'s sleeve; a tilted square behind R\'s head, a band where the strands come in, a floor in perspective',
    field: 'Field: a suit plane and a corner in L; a pole disc, an arc at the other pole and the pull\'s wedge in C; a head disc and an arc where the strands come in in R',
    r3: 'R3: only the bar and the floor disc',
    k1: 'k1: an open ring round C\'s south pole, a crescent behind R\'s head',
    k2: 'k2: discs at both poles, a tall slot behind R\'s head, L\'s corner',
    k3: 'k3: crescents over and under C\'s bar, a disc behind R\'s head',
    k4: 'k4: a pole disc and a wedge at the hand in C, a disc behind R\'s head, L\'s corner',
  },
  group: 'Cuts',
};
export const cutSchemeOf = (ctx: SketchContext): CutSchemeId => (SCHEMES.includes(ctx.params.cutScheme as CutSchemeId) ? ctx.params.cutScheme as CutSchemeId : 'tie');
/** R's floor: the disc (R1 to R4's schemes) or, in the angular sets, a square on the ground seen corner-on. */
export const floorKind = (ctx: SketchContext): 'disc' | 'square' => (['angular', 'tie'].includes(cutSchemeOf(ctx)) ? 'square' : 'disc');

export const LCUT_CONTROL: Control = {
  type: 'select', id: 'lCut', label: 'L, in the tie cut set: what is cut from the suit\'s front', default: 'tie', options: ['tie', 'shirt'],
  optionLabels: { tie: 'The tie: gold, its stripes drawn on it in black', shirt: 'The shirt about the tie: gold, with shirt stripes in black; the tie stays black, held at its knot and tip' },
  group: 'Cuts',
};

// ── Shapes (page millimetres; angles in radians, y down) ────────────

const TAU = Math.PI * 2;
const at = (c: Point, r: number, a: number): Point => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });

export const disc = (c: Point, r: number, n = 72): Point[] => Array.from({ length: n }, (_, i) => at(c, r, TAU * i / n));

/** An annular sector: radii r0 to r1 about `c`, from angle a0 to a1. */
export function arcBand(c: Point, r0: number, r1: number, a0: number, a1: number, n = 48): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= n; i++) out.push(at(c, r1, a0 + (a1 - a0) * i / n));
  for (let i = n; i >= 0; i--) out.push(at(c, r0, a0 + (a1 - a0) * i / n));
  return out;
}

/** A crescent: the disc (c1, r1) less the disc (c2, r2), the two circles crossing. */
export function lune(c1: Point, r1: number, c2: Point, r2: number, n = 64): Point[] {
  const dx = c2.x - c1.x, dy = c2.y - c1.y, d = Math.hypot(dx, dy);
  // Where the circles cross, as angles about each centre.
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const base = Math.atan2(dy, dx), spread1 = Math.atan2(h, a), spread2 = Math.atan2(h, a - d);
  const out: Point[] = [];
  // The outer arc of circle 1, away from circle 2, then back along circle 2's arc inside circle 1.
  const s1 = base + spread1, e1 = base - spread1 + TAU;
  for (let i = 0; i <= n; i++) out.push(at(c1, r1, s1 + (e1 - s1) * i / n));
  // Back along circle 2 the short way round, through the side facing circle 1's centre.
  const s2 = base - spread2, e2 = base + spread2 - TAU;
  for (let i = 1; i < n; i++) out.push(at(c2, r2, s2 + (e2 - s2) * i / n));
  return out;
}

export const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

/** A polygon clipped to the trim (Sutherland–Hodgman), so a shape may run off the edge of the finished panel. */
export function clipToTrim(poly: Point[], r = TRIM): Point[] {
  const edges: [(p: Point) => boolean, (a: Point, b: Point) => Point][] = [
    [p => p.x >= r.x0, (a, b) => ({ x: r.x0, y: a.y + (b.y - a.y) * (r.x0 - a.x) / (b.x - a.x) })],
    [p => p.x <= r.x1, (a, b) => ({ x: r.x1, y: a.y + (b.y - a.y) * (r.x1 - a.x) / (b.x - a.x) })],
    [p => p.y >= r.y0, (a, b) => ({ x: a.x + (b.x - a.x) * (r.y0 - a.y) / (b.y - a.y), y: r.y0 })],
    [p => p.y <= r.y1, (a, b) => ({ x: a.x + (b.x - a.x) * (r.y1 - a.y) / (b.y - a.y), y: r.y1 })],
  ];
  let out = poly;
  for (const [inside, cross] of edges) {
    const input = out; out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i + input.length - 1) % input.length], b = input[i];
      if (inside(b)) { if (!inside(a)) out.push(cross(a, b)); out.push(b); } else if (inside(a)) out.push(cross(a, b));
    }
  }
  return out;
}

// ── Anchors and schemes ──────────────────────────────────────────────

/** L: the suit plane picked for a cut, the tie, and the shirt either side of the tie (page outlines), on the black sheet over the gold. */
export interface LAnchors { facet: Point[]; tie?: Point[]; shirt?: Point[][] }
/** C: the bar (level) and its poles, where the gripping hand closes, and the sleeve's page points, on the gold sheet over the black. */
export interface CAnchors { rect: { x0: number; x1: number; y0: number; y1: number }; grip: Point; sleeve: Point[] }
/**
 * R: the head (its page centre and radius, after the field's pull), the gather point at the hands, the heights the
 * strands come in at, and the floor's outline (`floorKind`), cut in every scheme.
 */
export interface RAnchors { head: Point; headR: number; gather: Point; entries: number[]; floor: Point[] }

const deg = (d: number) => d * Math.PI / 180;
const poles = (a: CAnchors) => { const cy = (a.rect.y0 + a.rect.y1) / 2; return { north: { x: a.rect.x0, y: cy }, south: { x: a.rect.x1, y: cy }, cy }; };

/** L's corner: a wedge out of the bottom-left corner of the trim. */
const corner = (): Point[] => [{ x: TRIM.x0, y: TRIM.y1 - 74 }, { x: TRIM.x0, y: TRIM.y1 }, { x: TRIM.x0 + 52, y: TRIM.y1 }];

const L: Record<CutSchemeId, (a: LAnchors, ctx: SketchContext) => Cut[]> = {
  tie: (a, ctx) => [
    ...(ctx.params.lCut === 'shirt' ? (a.shirt ?? []).map((ring, k) => ({ id: `shirt${k ? 'r' : 'l'}`, label: 'SHIRT', rings: [clipToTrim(ring)] })) : [{ id: 'tie', label: 'TIE', rings: [clipToTrim(a.tie ?? [])] }]),
    { id: 'corner', label: 'CORNER', rings: [corner()] },
  ],
  angular: a => [{ id: 'suit', label: 'SUIT', rings: [clipToTrim(a.facet)] }, { id: 'corner', label: 'CORNER', rings: [corner()] }],
  field: a => [{ id: 'suit', label: 'SUIT', rings: [clipToTrim(a.facet)] }, { id: 'corner', label: 'CORNER', rings: [corner()] }],
  r3: () => [],
  k1: () => [],
  k2: () => [{ id: 'corner', label: 'CORNER', rings: [corner()] }],
  k3: () => [],
  k4: () => [{ id: 'corner', label: 'CORNER', rings: [corner()] }],
};

/** C's pull: a wedge from just over the fist up to under the bar, where the gripped lines converge. */
const pullWedge = (a: CAnchors, width = 44): Point[] => [{ x: a.grip.x - width / 2, y: a.rect.y1 + 9 }, { x: a.grip.x + width / 2, y: a.rect.y1 + 9 }, { x: a.grip.x, y: a.grip.y - 16 }];

/**
 * Black behind C's sleeve: the sleeve's outline grown by `margin` (its points pushed out eight ways, then their convex
 * hull, so the corners are cut square-ish, never round), cut to the trim.
 */
function sleeveBand(sleeve: Point[], margin = 9): Point[] {
  const grown = sleeve.flatMap(p => Array.from({ length: 8 }, (_, k) => at(p, margin, TAU * (k + 0.5) / 8)));
  return clipToTrim(convexHull(grown));
}

const C: Record<CutSchemeId, (a: CAnchors) => Cut[]> = {
  tie: a => [{ id: 'sleeve', label: 'SLEEVE', rings: [sleeveBand(a.sleeve)] }],
  angular: a => [{ id: 'sleeve', label: 'SLEEVE', rings: [sleeveBand(a.sleeve)] }],
  field: a => {
    const { north, south } = poles(a);
    return [
      { id: 'north', label: 'N', rings: [disc({ x: north.x - 12, y: north.y }, 9)] },
      { id: 'south', label: 'S', rings: [arcBand(south, 24, 33, deg(-68), deg(68))] },
      { id: 'pull', label: 'PULL', rings: [pullWedge(a)] },
    ];
  },
  r3: () => [],
  k1: a => { const { south } = poles(a); return [{ id: 'south', label: 'S', rings: [arcBand({ x: south.x + 6, y: south.y }, 13, 21, deg(-100), deg(100))] }]; },
  k2: a => {
    const { north, south } = poles(a);
    return [{ id: 'north', label: 'N', rings: [disc({ x: north.x - 11, y: north.y }, 8)] }, { id: 'south', label: 'S', rings: [disc({ x: south.x + 11, y: south.y }, 8)] }];
  },
  k3: a => {
    const mid = (a.rect.x0 + a.rect.x1) / 2, w = a.rect.x1 - a.rect.x0;
    return [
      // An arch over the bar and a bowl under it, each a crescent 18 mm thick, horns just clear of the bar's ends.
      { id: 'over', label: 'OVER', rings: [clipToTrim(lune({ x: mid, y: a.rect.y0 - 12 }, 0.45 * w, { x: mid, y: a.rect.y0 + 6 }, 0.45 * w))] },
      { id: 'under', label: 'UNDER', rings: [clipToTrim(lune({ x: mid, y: a.rect.y1 + 12 }, 0.45 * w, { x: mid, y: a.rect.y1 - 6 }, 0.45 * w))] },
    ];
  },
  k4: a => { const { south } = poles(a); return [{ id: 'south', label: 'S', rings: [disc({ x: south.x + 15, y: south.y }, 12)] }, { id: 'pull', label: 'PULL', rings: [pullWedge(a, 30)] }]; },
};

/** R's arc where the strands come in: an annular sector about the gather point, across the strands' way in. */
function entryArc(a: Pick<RAnchors, 'gather' | 'entries'>): Point[] {
  const r0 = 0.6 * (a.gather.x - TRIM.x0), angle = (y: number) => Math.atan2(y - a.gather.y, TRIM.x0 - a.gather.x);
  const ys = a.entries.filter(y => Math.abs(angle(y) - Math.PI) < deg(55) || Math.abs(angle(y) + Math.PI) < deg(55));
  const as = ys.map(y => { const t = angle(y); return t < 0 ? t + TAU : t; });
  const a0 = Math.max(deg(140), Math.min(...as) - deg(5)), a1 = Math.min(deg(215), Math.max(...as) + deg(5));
  return arcBand(a.gather, r0, r0 + 9, a0, a1);
}

/** The angular set's shape behind R's head: a square tilted 15 degrees, its half diagonal 1.3 times the head's radius. */
const headSquare = (a: RAnchors): Point[] => [0, 1, 2, 3].map(k => at(a.head, 1.3 * a.headR, deg(15 + 90 * k)));
/** The angular set's band where the strands come in: the corners of `entryArc`'s sector, joined straight. */
export function entryBand(a: Pick<RAnchors, 'gather' | 'entries'>): Point[] {
  const arc = entryArc(a), n = arc.length / 2;
  return [arc[0], arc[n - 1], arc[n], arc[2 * n - 1]];
}
const floorCut = (a: RAnchors): Cut => ({ id: 'disc', label: 'DISC', rings: [a.floor] });

const R: Record<CutSchemeId, (a: RAnchors) => Cut[]> = {
  tie: a => [{ id: 'floor', label: 'FLOOR', rings: [a.floor] }, { id: 'head', label: 'HEAD', rings: [headSquare(a)] }, { id: 'entry', label: 'IN', rings: [entryBand(a)] }],
  angular: a => [{ id: 'floor', label: 'FLOOR', rings: [a.floor] }, { id: 'head', label: 'HEAD', rings: [headSquare(a)] }, { id: 'entry', label: 'IN', rings: [entryBand(a)] }],
  field: a => [floorCut(a), { id: 'head', label: 'HEAD', rings: [disc(a.head, 1.2 * a.headR)] }, { id: 'entry', label: 'IN', rings: [entryArc(a)] }],
  r3: a => [floorCut(a)],
  k1: a => [floorCut(a), { id: 'head', label: 'HEAD', rings: [clipToTrim(lune({ x: a.head.x + 0.5 * a.headR, y: a.head.y - 0.2 * a.headR }, 1.5 * a.headR, { x: a.head.x + 0.05 * a.headR, y: a.head.y }, 1.4 * a.headR))] }],
  k2: a => [floorCut(a), { id: 'slot', label: 'SLOT', rings: [rect(a.head.x - 14, Math.max(TRIM.y0 + 14, a.head.y - 1.8 * a.headR), a.head.x + 14, a.head.y + 3.2 * a.headR)] }],
  k3: a => [floorCut(a), { id: 'head', label: 'HEAD', rings: [disc(a.head, 1.2 * a.headR)] }],
  k4: a => [floorCut(a), { id: 'head', label: 'HEAD', rings: [disc(a.head, 1.2 * a.headR)] }],
};

/** The scheme's cuts for a panel (L's bar is the panel's own, in every scheme; R's floor is in every R set). */
export const lCuts = (ctx: SketchContext, a: LAnchors): Cut[] => L[cutSchemeOf(ctx)](a, ctx);
export const cCuts = (ctx: SketchContext, a: CAnchors): Cut[] => C[cutSchemeOf(ctx)](a);
export const rCuts = (ctx: SketchContext, a: RAnchors): Cut[] => R[cutSchemeOf(ctx)](a);
