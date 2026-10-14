import { validId } from './ids.js';
import { clipToRegion, distanceToRings, inRegion, offsetRing, ringsSimple, signedArea } from './region.js';
import type { Region } from './region.js';
import { measureStrokeText, strokeFaceSupports, strokeText } from './stroke-text.js';
import type { AssemblySpec, Box, Control, Cut, Cuts, Page, Part, Pen, Point, SketchContext } from './types.js';

/**
 * Assembly: one artwork made from several plies, the physical sheets of different paper (see `AssemblySpec`).
 *
 * Each ply is plotted as its own SVG job, then knife-cut: a window cut in an upper ply shows the ply below. A sketch
 * draws the whole world on every render and a select control picks the ply this render is; `renderPly` then clips the
 * art to what that ply shows and adds the cut guides, plotted on the front of the ply inside the waste.
 *
 * Three opt-in extensions: a `part` cut is cut out and kept, so the art survives on both sides of its line; an
 * `onlay` ply is a kept piece glued on top (its outline is a `footprint` cut), which the plies below see around and
 * which the ply directly below gets placement marks for; and `world.sealed` art is deliberately hidden under paper,
 * clipped only by its own ply's cuts.
 */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

/** The cuts of one ply; a ply with no entry has none. */
const cutsOf = (cuts: Cuts, ply: string): Cut[] => (Object.prototype.hasOwnProperty.call(cuts, ply) ? cuts[ply] : []);
const boxRing = (box: Box): Point[] => [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y }, { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }];
const closed = (ring: Point[]): Point[] => {
  const copy = ring.map((p) => ({ x: p.x, y: p.y }));
  const first = ring[0], last = ring[ring.length - 1];
  return ring.length > 0 && (first.x !== last.x || first.y !== last.y) ? [...copy, { x: first.x, y: first.y }] : copy;
};

// ── The control and the spec ─────────────────────────────────────────

/** The select control that picks the ply a render is: options are the ply ids bottom to top, the default is the top ply. */
export function plyControl(spec: AssemblySpec, label = 'Ply'): Control {
  assert(Array.isArray(spec.plies) && spec.plies.length > 0, 'Assembly needs at least one ply');
  const options = spec.plies.map((ply) => ply.id);
  return { type: 'select', id: spec.control, label, default: options[options.length - 1], options };
}

/** Throws when the assembly is malformed or names a pen or control the sketch does not declare. */
export function validateAssemblySpec(spec: AssemblySpec, pens: Pen[], controls: Control[]): void {
  assert(isObject(spec), 'Sketch assembly must be an object');
  assert(validId(spec.control), 'Assembly control must be a safe id');
  assert(Array.isArray(spec.plies) && spec.plies.length > 0, 'Assembly needs at least one ply');
  const penIds = new Set(pens.map((pen) => pen.id));
  const declared = (id: unknown, what: string) => {
    assert(validId(id), `Assembly ${what} must be a safe id`);
    assert(penIds.has(id), `Assembly ${what} ${id} is not a declared pen`);
  };
  const plyIds = new Set<string>();
  for (const ply of spec.plies) {
    assert(isObject(ply) && validId(ply.id), 'Each assembly ply needs a safe id');
    assert(!plyIds.has(ply.id), `Duplicate ply id: ${ply.id}`);
    plyIds.add(ply.id);
    assert(isObject(ply.paper) && validId(ply.paper.id) && nonempty(ply.paper.color), `Ply ${ply.id} needs a paper with a safe id and a color`);
    assert(Array.isArray(ply.pens), `Ply ${ply.id} pens must be an array`);
    for (const pen of ply.pens) declared(pen, `ply ${ply.id} pen`);
    declared(ply.cutInk, `ply ${ply.id} cutInk`);
    assert(ply.bleed === undefined || (finite(ply.bleed) && ply.bleed >= 0), `Ply ${ply.id} bleed must be nonnegative`);
    assert(ply.lift === undefined || finite(ply.lift), `Ply ${ply.id} lift must be a finite number`);
    assert(ply.onlay === undefined || (isObject(ply.onlay) && nonempty(ply.onlay.from)), `Ply ${ply.id} onlay needs a nonempty from naming its source`);
  }
  declared(spec.cutPen, 'cutPen');
  assert(finite(spec.margin) && spec.margin > 0, 'Assembly margin must be greater than 0');
  assert(finite(spec.bleed) && spec.bleed >= 0, 'Assembly bleed must not be negative');
  const control = controls.find((c) => c.id === spec.control);
  assert(control?.type === 'select', `Assembly control ${spec.control} must be a select control of the sketch`);
  const ids = spec.plies.map((ply) => ply.id);
  assert(control.options.length === ids.length && control.options.every((option, i) => option === ids[i]),
    `Assembly control ${spec.control} options must be the ply ids, bottom to top: ${ids.join(', ')}`);
  if (spec.signature !== undefined) {
    const sig = spec.signature;
    assert(isObject(sig) && validId(sig.ply) && plyIds.has(sig.ply), `Assembly signature ply ${String(isObject(sig) ? sig.ply : sig)} is not a ply of the assembly`);
    assert(!spec.plies.find((ply) => ply.id === sig.ply)?.onlay, `Assembly signature ply ${sig.ply} is an onlay, which cannot carry a signature`);
    declared(sig.pen, 'signature pen');
    assert(isObject(sig.box) && finite(sig.box.x) && finite(sig.box.y) && finite(sig.box.width) && finite(sig.box.height) && sig.box.width > 0 && sig.box.height > 0, 'Assembly signature box must have a positive size');
  }
}

// ── The visible region of a ply ──────────────────────────────────────

/** The region terms of a ply's own cuts. */
function cutTerms(spec: AssemblySpec, cuts: Cuts, ply: string): Region[] {
  const terms: Region[] = [];
  for (const cut of cutsOf(cuts, ply)) {
    const kind = cut.kind ?? 'waste';
    if (kind === 'footprint') continue; // an onlay's outline is where the piece lands, not a cut in the ply
    // A window's paper is thrown away, so art is kept off it and its edge; a part is kept, so only the edge band goes.
    terms.push(kind === 'part'
      ? { not: { near: cut.rings, distance: spec.margin } }
      : { not: { or: [{ rings: cut.rings }, { near: cut.rings, distance: spec.margin }] } });
  }
  return terms;
}

/** The signature box, kept clear of art on the signing ply. */
const signatureTerm = (spec: AssemblySpec, ply: string): Region[] => (spec.signature?.ply === ply ? [{ not: { rings: [boxRing(spec.signature.box)] } }] : []);

/** Where a ply's art may be whatever sits above it: off its own cuts, and clear of its signature box. */
const ownRegion = (spec: AssemblySpec, cuts: Cuts, ply: string): Region => ({ and: [...cutTerms(spec, cuts, ply), ...signatureTerm(spec, ply)] });

/**
 * Where ply `ply` may carry art: on kept paper, at least `margin` from its own cuts, and only where it is seen
 * through the window of every ply above it, each window grown by that ply's bleed (so the art runs a little under
 * the upper ply's edge and a misregistered cut still shows ink). The signing ply also keeps the signature box clear.
 * An upper ply with no cuts shows nothing of the ply below.
 *
 * Part cuts: art is kept on both sides of a part cut of its own ply (only the `margin` band along the line goes), and
 * the plies below see through a part cut exactly as through a window. Onlay plies above: the piece covers its
 * footprint, so lower art shows outside the footprint, or within the onlay's bleed of its edge so a piece placed
 * slightly off never shows a gap.
 */
export function plyRegion(spec: AssemblySpec, cuts: Cuts, ply: string): Region {
  const index = spec.plies.findIndex((p) => p.id === ply);
  assert(index >= 0, `Unknown ply: ${ply}`);
  const parts: Region[] = [];
  parts.push(...cutTerms(spec, cuts, ply));
  for (const above of spec.plies.slice(index + 1)) {
    const bleed = above.bleed ?? spec.bleed;
    if (above.onlay) {
      for (const cut of cutsOf(cuts, above.id)) if (cut.kind === 'footprint') parts.push({ or: [{ not: { rings: cut.rings } }, { near: cut.rings, distance: bleed }] });
    } else {
      parts.push({ or: cutsOf(cuts, above.id).map((cut): Region => ({ or: [{ rings: cut.rings }, { near: cut.rings, distance: bleed }] })) });
    }
  }
  parts.push(...signatureTerm(spec, ply));
  return { and: parts };
}

// ── Checking cuts ────────────────────────────────────────────────────

/** The step of the grid that looks for the greatest inscribed clearance, millimetres. */
const GRID = 0.5;
/**
 * After the grid, the best sample is refined: a finer grid over the neighbourhood of the best point, then a finer
 * one again, each `[step, half-width]` in millimetres. A coarse grid under-measures a window whose roomiest point
 * falls between samples (a diamond), and would reject one that is wide enough.
 */
const REFINE: [number, number][] = [[0.05, 0.5], [0.005, 0.05]];
/** A refinement step must beat the best by this much, so a plateau does not drift the point about. */
const REFINE_GAIN = 1e-12;
/** Windows whose greatest inscribed clearance is under this are narrower than 3 mm and cannot be cut or marked. */
const MIN_CLEARANCE = 1.5;
/** The guard around the lone X that stands in when the lattice has no room, and the shortest X worth drawing. */
const LONE_GUARD = 0.5;
const MIN_MARK = 1.5;
/** The longest label the stroke text face will set. */
const MAX_LABEL = 256;

/**
 * The least inscribed clearance a window needs to be marked when its guides are inked `penWidth` wide: the lone X
 * is `2 × (clearance − penWidth / 2 − LONE_GUARD)` long and must be at least `MIN_MARK`. Never under `MIN_CLEARANCE`,
 * so a window is nowhere less than 3 mm wide whatever the pen.
 */
const windowClearance = (penWidth: number): number => Math.max(MIN_CLEARANCE, MIN_MARK / 2 + penWidth / 2 + LONE_GUARD);

interface Bounds { x0: number; y0: number; x1: number; y1: number }
function boundsOf(paths: Point[][]): Bounds | undefined {
  let b: Bounds | undefined;
  for (const path of paths) for (const p of path) {
    b = b ? { x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x), y1: Math.max(b.y1, p.y) } : { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }
  return b;
}

/**
 * The point of the waste (even-odd area of `rings`) farthest from any ring edge, on a grid anchored at the corner of
 * its bounding box, then refined around the best sample (see `REFINE`); the first of equals wins. With `atLeast`,
 * stops at the first point that clears it.
 */
function greatestClearance(rings: Point[][], atLeast = Infinity): { point: Point; clearance: number } | undefined {
  const b = boundsOf(rings);
  if (!b) return undefined;
  const waste: Region = { rings };
  const step = Math.max(GRID, Math.sqrt(((b.x1 - b.x0) * (b.y1 - b.y0)) / 1e6));
  let best: { point: Point; clearance: number } | undefined;
  for (let j = 0, y = b.y0; y <= b.y1 + 1e-9; y = b.y0 + ++j * step) {
    for (let i = 0, x = b.x0; x <= b.x1 + 1e-9; x = b.x0 + ++i * step) {
      const p = { x, y };
      if (!inRegion(p, waste)) continue;
      const clearance = distanceToRings(p, rings);
      if (!best || clearance > best.clearance) best = { point: p, clearance };
      if (best.clearance >= atLeast) return best;
    }
  }
  if (!best) return best;
  for (const [stepSize, halfWidth] of REFINE) {
    const around: Point = best.point, n = Math.round(halfWidth / stepSize);
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
      const p: Point = { x: around.x + i * stepSize, y: around.y + j * stepSize };
      if (!inRegion(p, waste)) continue;
      const clearance = distanceToRings(p, rings);
      if (clearance > best.clearance + REFINE_GAIN) best = { point: p, clearance };
      if (best.clearance >= atLeast) return best;
    }
  }
  return best;
}

const ringCrosses = (a: Point[], b: Point[]): boolean => !ringsSimple([a, b]);
const insideRing = (p: Point, ring: Point[]): boolean => inRegion(p, { rings: [ring] });

/**
 * Checks every cut of the assembly against the page. Throws, listing every problem, when a ring is not a simple
 * polygon, two rings of one cut cross, two cuts on one ply cross or nest, a vertex lies outside the page margin, a cut
 * id is unsafe or repeated, a cut's label has a character the stroke face cannot draw, a cut's area (its window, part
 * or piece) is nowhere 3 mm wide (its greatest inscribed clearance is under 1.5 mm, found on a 0.5 mm grid and refined
 * around the best sample), an onlay ply does not have exactly one footprint cut, or a footprint cut sits on a ply that
 * is not an onlay. Returns the warnings: a window with a hole inside its waste (kept paper that comes away loose,
 * unless it is a shaped ply), and a lower ply fully hidden by an upper ply with no cuts.
 *
 * With `pens`, a window (a `waste` cut) must also be wide enough for `cutGuides` to mark it with the ply's `cutInk`
 * width, which for a wide pen is more than 1.5 mm of clearance: every window this accepts can be marked. Without
 * them 1.5 mm is the floor. The guide options of a window (the defaults, then `guide`, the options the render is given,
 * then the cut's own `guide`) must be ones `cutGuides` can use, and a cut's `guide` names only options it has, so a typo
 * does not silently do nothing. Without a `page` the page-margin check is skipped.
 */
export function validateCuts(spec: AssemblySpec, cuts: Cuts, page: Page | undefined, pens?: Pen[], guide?: Partial<GuideOptions>): string[] {
  const errors: string[] = [];
  const warnings: string[] = [];
  const margin = page?.margin ?? 0;
  const plyIds = new Set(spec.plies.map((ply) => ply.id));
  for (const id of Object.keys(cuts)) if (!plyIds.has(id)) errors.push(`Cuts name an unknown ply: ${id}`);
  const partIds = new Set<string>();
  for (const ply of spec.plies) {
    const list = cutsOf(cuts, ply.id);
    if (ply.onlay && list.length !== 1) errors.push(`ply ${ply.id} is an onlay and needs exactly one footprint cut (it has ${list.length})`);
    const usable: Cut[] = [];
    const seen = new Set<string>();
    for (const cut of list) {
      const where = `ply ${ply.id} cut ${String(cut?.id)}`;
      if (!isObject(cut) || !validId(cut.id)) { errors.push(`${where}: a cut needs a safe id`); continue; }
      if (seen.has(cut.id)) { errors.push(`${where}: duplicate cut id`); continue; }
      seen.add(cut.id);
      const partId = `asm-${ply.id}-${cut.id}`;
      if (partIds.has(partId)) errors.push(`${where}: the diagnostic part id ${partId} is already taken`);
      partIds.add(partId);
      if (cut.label !== undefined) {
        const chars = typeof cut.label === 'string' ? [...cut.label] : undefined;
        const unsupported = chars?.find((char) => !strokeFaceSupports(char, 'sans'));
        if (!chars) errors.push(`${where}: label must be a string`);
        else if (chars.length > MAX_LABEL) errors.push(`${where}: label is longer than ${MAX_LABEL} characters`);
        else if (unsupported !== undefined) errors.push(`${where}: label has unsupported character U+${unsupported.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
      }
      const kind = cut.kind ?? 'waste';
      if (kind !== 'waste' && kind !== 'part' && kind !== 'footprint') { errors.push(`${where}: unknown cut kind ${String(kind)}`); continue; }
      if (kind === 'footprint' && !ply.onlay) errors.push(`${where}: a footprint cut belongs on an onlay ply`);
      if (ply.onlay && kind !== 'footprint') errors.push(`${where}: an onlay ply carries only its footprint, not a ${kind} cut`);
      if (!Array.isArray(cut.rings) || cut.rings.length === 0) { errors.push(`${where}: a cut needs at least one ring`); continue; }
      const malformed = cut.rings.findIndex((ring) => !Array.isArray(ring) || ring.length < 3 || ring.some((p) => !isObject(p) || !finite(p.x) || !finite(p.y)));
      if (malformed >= 0) { errors.push(`${where}: ring ${malformed} needs at least three finite points`); continue; }
      let sound = true;
      cut.rings.forEach((ring, i) => { if (!ringsSimple([ring])) { errors.push(`${where}: ring ${i} intersects itself`); sound = false; } });
      if (sound) for (let i = 0; i < cut.rings.length; i++) for (let j = i + 1; j < cut.rings.length; j++) {
        if (ringCrosses(cut.rings[i], cut.rings[j])) { errors.push(`${where}: rings ${i} and ${j} cross`); sound = false; }
      }
      const outside = page ? cut.rings.flat().find((p) => p.x < margin - 1e-6 || p.x > page.width - margin + 1e-6 || p.y < margin - 1e-6 || p.y > page.height - margin + 1e-6) : undefined;
      if (outside) errors.push(`${where}: vertex (${outside.x}, ${outside.y}) is outside the ${margin} mm page margin`);
      if (!sound) continue;
      usable.push(cut);
      const inkWidth = pens?.find((pen) => pen.id === ply.cutInk)?.width;
      if (kind === 'waste') {
        // The options this window is drawn with (see `guideFor`) must be ones `cutGuides` can use, whatever the pen.
        const own = cut.guide as unknown;
        const unknown = isObject(own) ? Object.keys(own).filter((key) => !GUIDE_KEYS.includes(key)) : [];
        if (own !== undefined && !isObject(own)) errors.push(`${where}: guide must be an object of guide options`);
        else if (unknown.length > 0) errors.push(`${where}: guide has unknown option ${unknown.join(', ')}${unknown.includes('penWidth') ? ' (the pen width is the cut ink\'s)' : ''}`);
        else {
          const bad = guideProblems(guideFor(cut, guide, 1));
          if (bad.length > 0) errors.push(`${where}: invalid guide options (${bad.join(', ')})`);
        }
      }
      const need = kind === 'waste' && finite(inkWidth) && inkWidth > 0 ? windowClearance(inkWidth) : MIN_CLEARANCE;
      const best = greatestClearance(cut.rings, need - 1e-9);
      if (!best || best.clearance < need - 1e-9) {
        errors.push(`${where}: the ${kind === 'part' ? 'part' : kind === 'footprint' ? 'piece' : 'window'} is nowhere ${Number((2 * need).toFixed(2))} mm wide (greatest inscribed clearance ${(best?.clearance ?? 0).toFixed(2)} mm, under ${Number(need.toFixed(3))} mm)`);
      }
      const hole = kind === 'waste' && cut.rings.some((ring, i) => cut.rings.some((other, j) => i !== j && insideRing(ring[0], other)));
      if (hole) warnings.push(`${where}: a hole inside the waste leaves kept paper that will come away loose, unless this is a shaped ply`);
    }
    for (let a = 0; a < usable.length; a++) for (let b = a + 1; b < usable.length; b++) {
      let crossed = false, nested = false;
      for (const ra of usable[a].rings) for (const rb of usable[b].rings) {
        if (ringCrosses(ra, rb)) crossed = true;
        else if (insideRing(ra[0], rb) || insideRing(rb[0], ra)) nested = true;
      }
      if (crossed) errors.push(`ply ${ply.id}: cuts ${usable[a].id} and ${usable[b].id} cross`);
      else if (nested) errors.push(`ply ${ply.id}: cuts ${usable[a].id} and ${usable[b].id} nest`);
    }
  }
  spec.plies.forEach((ply, index) => {
    const blocker = spec.plies.slice(index + 1).find((above) => cutsOf(cuts, above.id).length === 0);
    if (blocker) warnings.push(`ply ${ply.id} is fully hidden: ply ${blocker.id} above it has no cuts`);
  });
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return warnings;
}

// ── Cut guides ───────────────────────────────────────────────────────

/**
 * Sizes of a cut's guides, in millimetres. `penWidth` is the guide ink's line width. X marks sit on a lattice of
 * `pitch`, are `size` long and keep `guard` clear of the cut; the pitch grows (×1.25) until at most `maxMarks` marks
 * fit. `label` is the text (`true`: the cut's label, else `CUT <id>`; `false`: none), set in the first of `heights`
 * (cap heights) that fits with `guard` to spare.
 */
export interface GuideOptions { penWidth: number; pitch: number; size: number; guard: number; label: string | boolean; heights: number[]; maxMarks: number }
export const GUIDE_DEFAULTS: Omit<GuideOptions, 'penWidth'> = { pitch: 12, size: 4, guard: 2, label: true, heights: [5, 3.5, 2.5], maxMarks: 80 };

const GUIDE_KEYS = Object.keys(GUIDE_DEFAULTS);

/**
 * The guide options one cut is drawn with: the defaults, then the options the render was given, then the cut's own
 * `guide`, then the ply's cut ink width (never overridable).
 */
const guideFor = (cut: Cut, global: Partial<GuideOptions> | undefined, penWidth: number): GuideOptions => ({ ...GUIDE_DEFAULTS, ...global, ...cut.guide, penWidth });

/** The options (all but the pen width) that `cutGuides` cannot use, by name; empty when it can. */
function guideProblems(o: Omit<GuideOptions, 'penWidth'>): string[] {
  const bad: string[] = [];
  if (!(finite(o.pitch) && o.pitch > 0)) bad.push('pitch');
  if (!(finite(o.size) && o.size > 0)) bad.push('size');
  if (!(finite(o.guard) && o.guard >= 0)) bad.push('guard');
  if (!(Number.isInteger(o.maxMarks) && o.maxMarks >= 1)) bad.push('maxMarks');
  if (!(Array.isArray(o.heights) && o.heights.every((h) => finite(h) && h > 0))) bad.push('heights');
  const text = o.label;
  if (!(typeof text === 'boolean' || (typeof text === 'string' && [...text].length <= MAX_LABEL && [...text].every((char) => strokeFaceSupports(char, 'sans'))))) bad.push('label');
  return bad;
}

function boxMeets(a: Bounds, b: Bounds): boolean { return !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1); }

/** Does the segment ab touch the box (Liang-Barsky)? */
function segmentHitsBox(a: Point, b: Point, box: Bounds): boolean {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - box.x0], [dx, box.x1 - a.x], [-dy, a.y - box.y0], [dy, box.y1 - a.y]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

/** Distance from an axis-aligned box to the nearest ring edge; 0 when any edge touches the box. */
function distanceBoxToRings(box: Bounds, rings: Point[][]): number {
  let best = Infinity;
  const corners = [{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x1, y: box.y1 }, { x: box.x0, y: box.y1 }];
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (segmentHitsBox(ring[j], ring[i], box)) return 0;
      const p = ring[i];
      best = Math.min(best, Math.hypot(Math.max(box.x0 - p.x, 0, p.x - box.x1), Math.max(box.y0 - p.y, 0, p.y - box.y1)));
    }
  }
  for (const corner of corners) best = Math.min(best, distanceToRings(corner, rings));
  return best;
}

/**
 * Guides for one cut, plotted on the front of the ply inside the waste (the even-odd area of the cut's rings):
 *   - an outline of every ring, a pen width's half inside the waste, so the ink just touches the line to cut along;
 *   - X marks on a lattice anchored at the centre of the waste's bounding box, each an X of two strokes of length
 *     `size`, so its ink reaches half of `size` and half a pen width from its centre, and that plus the guard clear of
 *     the cut; if none fits, one X at the point of greatest clearance, shrunk to fit (its ink 0.5 mm clear of the cut);
 *   - a label in Hershey sans, in the first height that fits clear of the cut, with the X marks under it left out.
 * Throws when the outline is finer than the pen or no X fits. Returns one part, `cut-<id>`, whose boundary is the rings.
 *
 * A `part` cut is kept, not thrown away: its guide is the boundary ring itself, closed, with no inset, no X marks and
 * no label. A `footprint` has no guides.
 */
export function cutGuides(cut: Cut, pen: string, o: GuideOptions): Part {
  const kind = cut.kind ?? 'waste';
  assert(kind !== 'footprint', `cut ${cut.id}: a footprint is where an onlay lands and has no guides`);
  if (kind === 'part') {
    // The knife cuts down the middle of the line and half of it stays on each side, so the ring itself is drawn, uninset.
    return { id: `cut-${cut.id}`, pen, paths: cut.rings.map(closed), boundary: cut.rings.map((ring) => ring.map((p) => ({ x: p.x, y: p.y }))) };
  }
  assert(finite(o.penWidth) && o.penWidth > 0 && guideProblems(o).length === 0, `cut ${cut.id}: invalid guide options`);
  const rings = cut.rings;
  const waste: Region = { rings };
  const half = o.penWidth / 2;
  const paths: Point[][] = [];

  // Outline: each ring offset by half a pen width towards the waste, which lies on whichever side of its edge tests inside.
  const outlines = rings.map((ring) => {
    let a = ring[ring.length - 1], b = ring[0], longest = -1;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const length = Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y);
      if (length > longest) { longest = length; a = ring[j]; b = ring[i]; }
    }
    assert(longest > 0, `cut ${cut.id}: a ring has no length`);
    const orient = signedArea(ring) >= 0 ? 1 : -1;
    const nx = (orient * (b.y - a.y)) / longest, ny = (-orient * (b.x - a.x)) / longest; // outward normal
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const wasteOut = inRegion({ x: mx + 1e-3 * nx, y: my + 1e-3 * ny }, waste);
    const wasteIn = inRegion({ x: mx - 1e-3 * nx, y: my - 1e-3 * ny }, waste);
    assert(wasteOut !== wasteIn, `cut ${cut.id}: a ring edge does not border the waste`);
    return offsetRing(ring, wasteOut ? half : -half);
  });
  const finer = () => new Error(`cut ${cut.id}: feature finer than the guide pen`);
  if (!ringsSimple(outlines)) throw finer();
  for (const outline of outlines) for (const v of outline) if (!(distanceToRings(v, rings) >= half - 1e-6 && inRegion(v, waste))) throw finer();
  for (const outline of outlines) paths.push(closed(outline));

  // X marks. Each X is two diagonal strokes of length `size` crossing at its centre, so every point of it is within
  // `size / 2` of the centre, and its ink within that plus half a pen width.
  const bounds = boundsOf(rings)!;
  const centre = { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 };
  const reach = (size: number) => size / 2 + half;
  const latticeAt = (pitch: number): Point[] => {
    const out: Point[] = [];
    const nx = Math.ceil((bounds.x1 - centre.x) / pitch), ny = Math.ceil((bounds.y1 - centre.y) / pitch);
    for (let j = -ny; j <= ny; j++) for (let i = -nx; i <= nx; i++) {
      const p = { x: centre.x + i * pitch, y: centre.y + j * pitch };
      if (inRegion(p, waste)) out.push(p);
    }
    return out;
  };
  let pitch = o.pitch;
  let lattice = latticeAt(pitch);
  let marks = lattice.filter((p) => distanceToRings(p, rings) >= reach(o.size) + o.guard);
  while (marks.length > o.maxMarks) { pitch *= 1.25; lattice = latticeAt(pitch); marks = lattice.filter((p) => distanceToRings(p, rings) >= reach(o.size) + o.guard); }
  let size = o.size;
  const best = greatestClearance(rings);
  if (marks.length === 0) {
    // The disc of radius `clearance` about the point is all waste, so an X of length `fit` (reach `fit / 2`) leaves
    // its ink `LONE_GUARD` clear of the cut. The tolerance covers a window `validateCuts` took at its exact minimum.
    const fit = best ? 2 * (best.clearance - half - LONE_GUARD) : 0;
    if (!best || fit < MIN_MARK - 1e-8) throw new Error(`cut ${cut.id}: no room for an X mark`);
    size = Math.min(o.size, fit);
    marks = [best.point];
  }
  const markBox = (c: Point): Bounds => ({ x0: c.x - size / (2 * Math.SQRT2), y0: c.y - size / (2 * Math.SQRT2), x1: c.x + size / (2 * Math.SQRT2), y1: c.y + size / (2 * Math.SQRT2) });

  // Label: the first height and place where its padded box is inside the waste, `guard` clear of the cut, and at
  // least one X survives. Candidates: the point of greatest clearance, then the lattice points, roomiest first.
  let label: Point[][] = [];
  const text = o.label === false ? '' : typeof o.label === 'string' ? o.label : (cut.label ?? `CUT ${cut.id}`);
  if (text.length > 0 && best) {
    const roomy = lattice.map((p, i) => ({ p, i, clearance: distanceToRings(p, rings) })).sort((a, b) => b.clearance - a.clearance || a.i - b.i).map((c) => c.p);
    const candidates = [best.point, ...roomy];
    search: for (const height of o.heights) {
      const glyphs = strokeText(text, 0, 0, { face: 'sans', height });
      const tb = boundsOf(glyphs);
      if (!tb) continue;
      // The text box: the laid-out width (every glyph's advance) joined with the ink, so the box covers all of it.
      const box = { x0: Math.min(0, tb.x0), x1: Math.max(measureStrokeText(text, { face: 'sans', height }), tb.x1), y0: tb.y0, y1: tb.y1 };
      const width = box.x1 - box.x0, tall = box.y1 - box.y0;
      for (const c of candidates) {
        const padded: Bounds = { x0: c.x - width / 2 - o.guard, y0: c.y - tall / 2 - o.guard, x1: c.x + width / 2 + o.guard, y1: c.y + tall / 2 + o.guard };
        if (!inRegion(c, waste) || distanceBoxToRings(padded, rings) < o.guard) continue;
        if (!marks.some((m) => !boxMeets(markBox(m), padded))) continue;
        marks = marks.filter((m) => !boxMeets(markBox(m), padded));
        const dx = c.x - (box.x0 + box.x1) / 2, dy = c.y - (box.y0 + box.y1) / 2;
        label = glyphs.map((path) => path.map((p) => ({ x: p.x + dx, y: p.y + dy })));
        break search;
      }
    }
  }

  const h = size / (2 * Math.SQRT2);
  for (const c of marks) {
    paths.push([{ x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y + h }]);
    paths.push([{ x: c.x - h, y: c.y + h }, { x: c.x + h, y: c.y - h }]);
  }
  paths.push(...label);
  return { id: `cut-${cut.id}`, pen, paths, boundary: rings.map((ring) => ring.map((p) => ({ x: p.x, y: p.y }))) };
}

// ── Placement marks ──────────────────────────────────────────────────

/** Corner ticks have arms this long, and sit this far inside the footprint's edges, millimetres. */
const TICK_ARM = 3;
const TICK_INSET = 1.5;
/** Vertices of a footprint sharper than this get a tick. */
const TICK_ANGLE = (170 * Math.PI) / 180;

/** The ring without a closing repeat or consecutive duplicate points. */
function distinctPoints(ring: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of ring) if (!out.length || p.x !== out[out.length - 1].x || p.y !== out[out.length - 1].y) out.push(p);
  while (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) out.pop();
  return out;
}

/**
 * Small L-shaped corner ticks that show where an onlay lands: one at each vertex of its footprint whose interior angle
 * is under 170 degrees, with 3 mm arms along the footprint's edges, inset 1.5 mm so the piece covers them. A footprint
 * with fewer than two such vertices (a smooth blob) gets ticks at the corners of its bounding box instead, pulled to
 * the nearest point of the outline and inside. Every tick is clipped to the part of the footprint at least 1.5 mm from
 * its edge, so a short edge or a thin piece shortens a tick rather than letting it out.
 */
function placementTicks(rings: Point[][]): Point[][] {
  const polys = rings.map(distinctPoints).filter((ring) => ring.length >= 3);
  const area: Region = { rings: polys };
  const ticks: Point[][] = [];
  polys.forEach((ring, r) => {
    // The piece lies inside a ring nested an even number of rings deep, and outside a hole.
    const depth = polys.filter((other, o) => o !== r && insideRing(ring[0], other)).length;
    const counterClockwise = signedArea(ring) >= 0;
    ring.forEach((v, i) => {
      const prev = ring[(i + ring.length - 1) % ring.length], next = ring[(i + 1) % ring.length];
      const ul = Math.hypot(next.x - v.x, next.y - v.y), wl = Math.hypot(prev.x - v.x, prev.y - v.y);
      const u = { x: (next.x - v.x) / ul, y: (next.y - v.y) / ul }, w = { x: (prev.x - v.x) / wl, y: (prev.y - v.y) / wl };
      // The angle inside the ring, from the edge to the next vertex round to the edge from the previous one.
      let inner = Math.atan2(u.x * w.y - u.y * w.x, u.x * w.x + u.y * w.y);
      if (!counterClockwise) inner = -inner;
      if (inner < 0) inner += 2 * Math.PI;
      const piece = depth % 2 === 0 ? inner : 2 * Math.PI - inner;
      if (!(piece < TICK_ANGLE)) return;
      const sum = { x: u.x + w.x, y: u.y + w.y }, sl = Math.hypot(sum.x, sum.y);
      const sign = (inner < Math.PI ? 1 : -1) * (depth % 2 === 0 ? 1 : -1); // the bisector that points into the piece
      const reach = TICK_INSET / Math.sin(piece / 2);
      const c = { x: v.x + (sign * sum.x / sl) * reach, y: v.y + (sign * sum.y / sl) * reach };
      ticks.push([{ x: c.x + u.x * TICK_ARM, y: c.y + u.y * TICK_ARM }, c, { x: c.x + w.x * TICK_ARM, y: c.y + w.y * TICK_ARM }]);
    });
  });
  if (ticks.length < 2) {
    ticks.length = 0;
    const b = boundsOf(polys);
    if (b) for (const [kx, ky] of [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]) {
      // The nearest point of the outline to the bounding-box corner, then in towards the box's centre until it is 1.5 mm
      // from every edge (found by walking, then bisecting, so a curved outline gets the exact inset).
      let q: Point | undefined, best = Infinity;
      for (const ring of polys) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], e = ring[i], dx = e.x - a.x, dy = e.y - a.y;
        const t = Math.max(0, Math.min(1, ((kx - a.x) * dx + (ky - a.y) * dy) / (dx * dx + dy * dy)));
        const p = { x: a.x + dx * t, y: a.y + dy * t }, d = Math.hypot(kx - p.x, ky - p.y);
        if (d < best) { best = d; q = p; }
      }
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      const span = Math.hypot(cx - q!.x, cy - q!.y);
      if (!(span > 0)) continue;
      const at = (t: number): Point => ({ x: q!.x + ((cx - q!.x) / span) * t, y: q!.y + ((cy - q!.y) / span) * t });
      const clear = (t: number) => inRegion(at(t), area) && distanceToRings(at(t), polys) >= TICK_INSET;
      let lo = 0, hi = 0;
      while (hi <= span && !clear(hi)) { lo = hi; hi += 0.25; }
      if (hi > span) continue;
      for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (clear(mid)) hi = mid; else lo = mid; }
      const c = at(hi);
      ticks.push([{ x: c.x + (cx >= kx ? TICK_ARM : -TICK_ARM), y: c.y }, c, { x: c.x, y: c.y + (cy >= ky ? TICK_ARM : -TICK_ARM) }]);
    }
  }
  // Tolerance of 1e-6 mm so a tick exactly one inset from the edge is kept.
  return clipToRegion(ticks, { and: [area, { not: { near: polys, distance: TICK_INSET - 1e-6 } }] });
}

// ── Rendering one ply ────────────────────────────────────────────────

/** Part ids `renderPly` makes for itself: the guides, the placement marks and the diagnostics. */
const RESERVED_PREFIXES = ['asm-', 'cut-', 'place-'];

/**
 * The parts of the ply this render is (`ctx.params[spec.control]`): the ply's art clipped to what it shows, its sealed
 * art, the guides of each of its cuts on `spec.cutPen`, placement marks when an onlay sits directly above it, and
 * diagnostics. The diagnostics, one per cut of every ply (`asm-<ply>-<cut>`, footprints included) and one for the
 * signature box (`asm-signature`), ride in `result.json` so tools can check that every ply drew the same world.
 *
 * `world.sealed[ply]` is art that is meant to be hidden under paper (such as a word under an onlay): it is clipped only
 * by its own ply's cuts and signature, never by the plies above. The placement marks `place-<onlay>` are the same:
 * they sit under the piece on purpose, so the onlay does not clip them.
 *
 * The world is checked first, so every ply of one world is accepted or refused alike: the cuts with `validateCuts`
 * (including the page margin when `ctx.page` is known, and the guide pen widths), the art and sealed art for keys that
 * are not plies and part ids that start with `asm-`, `cut-` or `place-` (the ids renderPly makes for itself), and the
 * signature box for lying inside the page.
 *
 * Throws for an unknown ply, for an onlay ply (it is plotted and cut elsewhere), for a world that fails those checks,
 * or art in a pen the ply does not carry.
 */
export function renderPly(spec: AssemblySpec, ctx: Pick<SketchContext, 'params' | 'page'>, pens: Pen[],
  world: { cuts: Cuts; art: Record<string, Part[]>; sealed?: Record<string, Part[]> }, guide?: Partial<GuideOptions>): Part[] {
  const id = String(ctx.params[spec.control]);
  const index = spec.plies.findIndex((p) => p.id === id);
  assert(index >= 0, `Unknown ply: ${id}`);
  const ply = spec.plies[index];
  assert(!ply.onlay, `ply ${ply.id} is an onlay, plotted and cut on ${ply.onlay?.from}`);
  validateCuts(spec, world.cuts, ctx.page, pens, guide);
  const plyIds = new Set(spec.plies.map((p) => p.id));
  for (const [name, art] of [['art', world.art], ['sealed art', world.sealed]] as const) {
    if (!art) continue;
    for (const key of Object.keys(art)) {
      assert(plyIds.has(key), `World ${name} names an unknown ply: ${key}`);
      assert(Array.isArray(art[key]), `World ${name} for ply ${key} must be an array of parts`);
      for (const part of art[key]) {
        const reserved = RESERVED_PREFIXES.find((prefix) => String(part?.id).startsWith(prefix));
        assert(!reserved, `World ${name} part ${String(part?.id)} uses the reserved id prefix ${reserved}`);
      }
    }
  }
  const signature = spec.signature?.box;
  if (ctx.page && signature) {
    assert(signature.x >= 0 && signature.y >= 0 && signature.x + signature.width <= ctx.page.width && signature.y + signature.height <= ctx.page.height,
      `Assembly signature box lies outside the ${ctx.page.width} x ${ctx.page.height} mm page`);
  }
  const parts: Part[] = [];
  const pool = (art: Record<string, Part[]> | undefined, region: Region) => {
    for (const part of art && Object.prototype.hasOwnProperty.call(art, ply.id) ? art[ply.id] : []) {
      assert(ply.pens.includes(part.pen), `Part ${part.id} is drawn in pen ${part.pen}, which ply ${ply.id} does not carry`);
      const paths = clipToRegion(part.paths, region);
      if (paths.length > 0) parts.push({ ...part, paths });
    }
  };
  pool(world.art, plyRegion(spec, world.cuts, ply.id));
  pool(world.sealed, ownRegion(spec, world.cuts, ply.id));
  const ink = pens.find((pen) => pen.id === ply.cutInk);
  assert(ink, `Ply ${ply.id} cutInk ${ply.cutInk} is not a declared pen`);
  for (const cut of cutsOf(world.cuts, ply.id)) parts.push(cutGuides(cut, spec.cutPen, guideFor(cut, guide, ink.width)));
  // The ply directly below an onlay shows where the piece lands. The line is drawn in cutPen, which the host inks as
  // this ply's cutInk; the marks are not clipped, being under the onlay by design.
  const above = spec.plies[index + 1];
  if (above?.onlay) {
    const footprint = cutsOf(world.cuts, above.id).filter((cut) => cut.kind === 'footprint').flatMap((cut) => cut.rings);
    const marks = placementTicks(footprint);
    if (marks.length > 0) parts.push({ id: `place-${above.id}`, pen: spec.cutPen, paths: marks });
  }
  for (const q of spec.plies) for (const cut of cutsOf(world.cuts, q.id)) {
    parts.push({ id: `asm-${q.id}-${cut.id}`, pen: spec.cutPen, paths: cut.rings.map(closed), diagnostic: true });
  }
  if (spec.signature) parts.push({ id: 'asm-signature', pen: spec.cutPen, paths: [closed(boxRing(spec.signature.box))], diagnostic: true });
  return parts;
}
