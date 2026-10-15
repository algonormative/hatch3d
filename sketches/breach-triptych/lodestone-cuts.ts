import type { Control, Cut, Point, SketchContext } from '../../src/sketch/types.ts';
import { TRIM } from './world.ts';

/**
 * Lodestone's cut sets, as data: each scheme lists, per panel, simple shapes cut from one sheet to show the sheet
 * beneath (black under C's gold and R's white, gold under L's black), each placed from the panel's own anchors (the
 * poles, the grip, the head, where the strands come in). The bar cut from L and R's floor disc are not here: every
 * scheme keeps them. `cutScheme` picks the set; the mockups `k1` to `k4` (vault active/breach-triptych/lodestone-cuts)
 * are approximated in the shapes this tooling cuts, so a pick can be swapped in.
 */

export type CutSchemeId = 'field' | 'r3' | 'k1' | 'k2' | 'k3' | 'k4';
const SCHEMES: CutSchemeId[] = ['field', 'r3', 'k1', 'k2', 'k3', 'k4'];

export const CUT_CONTROL: Control = {
  type: 'select', id: 'cutScheme', label: 'Cut set (shapes showing the sheet beneath)', default: 'field', options: SCHEMES,
  optionLabels: {
    field: 'Field: a suit plane and a corner in L; a pole disc, an arc at the other pole and the pull\'s wedge in C; a head disc and an arc where the strands come in in R',
    r3: 'R3: only the bar and the floor disc',
    k1: 'k1: an open ring round C\'s south pole, a crescent behind R\'s head',
    k2: 'k2: discs at both poles, a tall slot behind R\'s head, L\'s corner',
    k3: 'k3: crescents over and under C\'s bar, a disc behind R\'s head',
    k4: 'k4: a pole disc and a wedge at the hand in C, a disc behind R\'s head, L\'s corner',
  },
  group: 'Cuts',
};
export const cutSchemeOf = (ctx: SketchContext): CutSchemeId => (SCHEMES.includes(ctx.params.cutScheme as CutSchemeId) ? ctx.params.cutScheme as CutSchemeId : 'field');

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
  const s2 = base - spread2, e2 = base + spread2;
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

/** L: the suit plane picked for a cut (its page outline), on the black sheet over the gold. */
export interface LAnchors { facet: Point[] }
/** C: the bar (level) and its poles, and where the gripping hand closes, on the gold sheet over the black. */
export interface CAnchors { rect: { x0: number; x1: number; y0: number; y1: number }; grip: Point }
/** R: the head (its page centre and radius, after the field's pull), the gather point at the hands, and the heights the strands come in at. */
export interface RAnchors { head: Point; headR: number; gather: Point; entries: number[] }

const deg = (d: number) => d * Math.PI / 180;
const poles = (a: CAnchors) => { const cy = (a.rect.y0 + a.rect.y1) / 2; return { north: { x: a.rect.x0, y: cy }, south: { x: a.rect.x1, y: cy }, cy }; };

/** L's corner: a wedge out of the bottom-left corner of the trim. */
const corner = (): Point[] => [{ x: TRIM.x0, y: TRIM.y1 - 74 }, { x: TRIM.x0, y: TRIM.y1 }, { x: TRIM.x0 + 52, y: TRIM.y1 }];

const L: Record<CutSchemeId, (a: LAnchors) => Cut[]> = {
  field: a => [{ id: 'suit', label: 'SUIT', rings: [clipToTrim(a.facet)] }, { id: 'corner', label: 'CORNER', rings: [corner()] }],
  r3: () => [],
  k1: () => [],
  k2: () => [{ id: 'corner', label: 'CORNER', rings: [corner()] }],
  k3: () => [],
  k4: () => [{ id: 'corner', label: 'CORNER', rings: [corner()] }],
};

/** C's pull: a wedge from just over the fist up to under the bar, where the gripped lines converge. */
const pullWedge = (a: CAnchors, width = 44): Point[] => [{ x: a.grip.x - width / 2, y: a.rect.y1 + 9 }, { x: a.grip.x + width / 2, y: a.rect.y1 + 9 }, { x: a.grip.x, y: a.grip.y - 16 }];

const C: Record<CutSchemeId, (a: CAnchors) => Cut[]> = {
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
      { id: 'over', label: 'OVER', rings: [lune({ x: mid, y: a.rect.y0 - 22 }, 0.55 * w, { x: mid, y: a.rect.y0 + 4 }, 0.55 * w)] },
      { id: 'under', label: 'UNDER', rings: [lune({ x: mid, y: a.rect.y1 + 26 }, 0.55 * w, { x: mid, y: a.rect.y1 }, 0.55 * w)] },
    ];
  },
  k4: a => { const { south } = poles(a); return [{ id: 'south', label: 'S', rings: [disc({ x: south.x + 15, y: south.y }, 12)] }, { id: 'pull', label: 'PULL', rings: [pullWedge(a, 30)] }]; },
};

/** R's arc where the strands come in: an annular sector about the gather point, across the strands' way in. */
function entryArc(a: RAnchors): Point[] {
  const r0 = 0.6 * (a.gather.x - TRIM.x0), angle = (y: number) => Math.atan2(y - a.gather.y, TRIM.x0 - a.gather.x);
  const ys = a.entries.filter(y => Math.abs(angle(y) - Math.PI) < deg(55) || Math.abs(angle(y) + Math.PI) < deg(55));
  const as = ys.map(y => { const t = angle(y); return t < 0 ? t + TAU : t; });
  const a0 = Math.max(deg(140), Math.min(...as) - deg(5)), a1 = Math.min(deg(215), Math.max(...as) + deg(5));
  return arcBand(a.gather, r0, r0 + 9, a0, a1);
}

const R: Record<CutSchemeId, (a: RAnchors) => Cut[]> = {
  field: a => [{ id: 'head', label: 'HEAD', rings: [disc(a.head, 1.2 * a.headR)] }, { id: 'entry', label: 'IN', rings: [entryArc(a)] }],
  r3: () => [],
  k1: a => [{ id: 'head', label: 'HEAD', rings: [clipToTrim(lune({ x: a.head.x + 0.5 * a.headR, y: a.head.y - 0.2 * a.headR }, 1.5 * a.headR, { x: a.head.x + 0.05 * a.headR, y: a.head.y }, 1.4 * a.headR))] }],
  k2: a => [{ id: 'slot', label: 'SLOT', rings: [rect(a.head.x - 14, Math.max(TRIM.y0 + 14, a.head.y - 1.8 * a.headR), a.head.x + 14, a.head.y + 3.2 * a.headR)] }],
  k3: a => [{ id: 'head', label: 'HEAD', rings: [disc(a.head, 1.2 * a.headR)] }],
  k4: a => [{ id: 'head', label: 'HEAD', rings: [disc(a.head, 1.2 * a.headR)] }],
};

/** The scheme's cuts for a panel (the bar and R's floor disc are the panels' own, in every scheme). */
export const lCuts = (ctx: SketchContext, a: LAnchors): Cut[] => L[cutSchemeOf(ctx)](a);
export const cCuts = (ctx: SketchContext, a: CAnchors): Cut[] => C[cutSchemeOf(ctx)](a);
export const rCuts = (ctx: SketchContext, a: RAnchors): Cut[] => R[cutSchemeOf(ctx)](a);
