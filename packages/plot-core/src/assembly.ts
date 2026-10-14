import { validId } from './ids.js';
import { clipToRegion, distanceToRings, inRegion, offsetRing, ringsSimple, signedArea } from './region.js';
import type { Region } from './region.js';
import { measureStrokeText, strokeText } from './stroke-text.js';
import type { AssemblySpec, Box, Control, Cut, Cuts, Page, Part, Pen, Point, SketchContext } from './types.js';

/**
 * Assembly: one artwork made from several plies, the physical sheets of different paper (see `AssemblySpec`).
 *
 * Each ply is plotted as its own SVG job, then knife-cut: a window cut in an upper ply shows the ply below. A sketch
 * draws the whole world on every render and a select control picks the ply this render is; `renderPly` then clips the
 * art to what that ply shows and adds the cut guides, plotted on the front of the ply inside the waste.
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
    declared(sig.pen, 'signature pen');
    assert(isObject(sig.box) && finite(sig.box.x) && finite(sig.box.y) && finite(sig.box.width) && finite(sig.box.height) && sig.box.width > 0 && sig.box.height > 0, 'Assembly signature box must have a positive size');
  }
}

// ── The visible region of a ply ──────────────────────────────────────

/**
 * Where ply `ply` may carry art: on kept paper, at least `margin` from its own cuts, and only where it is seen
 * through the window of every ply above it, each window grown by that ply's bleed (so the art runs a little under
 * the upper ply's edge and a misregistered cut still shows ink). The signing ply also keeps the signature box clear.
 * An upper ply with no cuts shows nothing of the ply below.
 */
export function plyRegion(spec: AssemblySpec, cuts: Cuts, ply: string): Region {
  const index = spec.plies.findIndex((p) => p.id === ply);
  assert(index >= 0, `Unknown ply: ${ply}`);
  const parts: Region[] = [];
  for (const cut of cutsOf(cuts, ply)) parts.push({ not: { or: [{ rings: cut.rings }, { near: cut.rings, distance: spec.margin }] } });
  for (const above of spec.plies.slice(index + 1)) {
    const bleed = above.bleed ?? spec.bleed;
    parts.push({ or: cutsOf(cuts, above.id).map((cut): Region => ({ or: [{ rings: cut.rings }, { near: cut.rings, distance: bleed }] })) });
  }
  if (spec.signature?.ply === ply) parts.push({ not: { rings: [boxRing(spec.signature.box)] } });
  return { and: parts };
}

// ── Checking cuts ────────────────────────────────────────────────────

/** The step of the grid that looks for the greatest inscribed clearance, millimetres. */
const GRID = 0.5;
/** Windows whose greatest inscribed clearance is under this are narrower than 3 mm and cannot be cut or marked. */
const MIN_CLEARANCE = 1.5;

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
 * its bounding box; the first of equals wins. With `atLeast`, stops at the first point that clears it.
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
  return best;
}

const ringCrosses = (a: Point[], b: Point[]): boolean => !ringsSimple([a, b]);
const insideRing = (p: Point, ring: Point[]): boolean => inRegion(p, { rings: [ring] });

/**
 * Checks every cut of the assembly against the page. Throws, listing every problem, when a ring is not a simple
 * polygon, two rings of one cut cross, two cuts on one ply cross or nest, a vertex lies outside the page margin, a cut
 * id is unsafe or repeated, or a cut's waste is nowhere 3 mm wide (its greatest inscribed clearance is under
 * 1.5 mm, sampled on a 0.5 mm grid). Returns the warnings: a cut with a hole inside its waste (kept paper that comes
 * away loose, unless it is a shaped ply), and a lower ply fully hidden by an upper ply with no cuts.
 */
export function validateCuts(spec: AssemblySpec, cuts: Cuts, page: Page): string[] {
  const errors: string[] = [];
  const warnings: string[] = [];
  const margin = page.margin ?? 0;
  const plyIds = new Set(spec.plies.map((ply) => ply.id));
  for (const id of Object.keys(cuts)) if (!plyIds.has(id)) errors.push(`Cuts name an unknown ply: ${id}`);
  const partIds = new Set<string>();
  for (const ply of spec.plies) {
    const list = cutsOf(cuts, ply.id);
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
      if (!Array.isArray(cut.rings) || cut.rings.length === 0) { errors.push(`${where}: a cut needs at least one ring`); continue; }
      const malformed = cut.rings.findIndex((ring) => !Array.isArray(ring) || ring.length < 3 || ring.some((p) => !isObject(p) || !finite(p.x) || !finite(p.y)));
      if (malformed >= 0) { errors.push(`${where}: ring ${malformed} needs at least three finite points`); continue; }
      let sound = true;
      cut.rings.forEach((ring, i) => { if (!ringsSimple([ring])) { errors.push(`${where}: ring ${i} intersects itself`); sound = false; } });
      if (sound) for (let i = 0; i < cut.rings.length; i++) for (let j = i + 1; j < cut.rings.length; j++) {
        if (ringCrosses(cut.rings[i], cut.rings[j])) { errors.push(`${where}: rings ${i} and ${j} cross`); sound = false; }
      }
      const outside = cut.rings.flat().find((p) => p.x < margin - 1e-6 || p.x > page.width - margin + 1e-6 || p.y < margin - 1e-6 || p.y > page.height - margin + 1e-6);
      if (outside) errors.push(`${where}: vertex (${outside.x}, ${outside.y}) is outside the ${margin} mm page margin`);
      if (!sound) continue;
      usable.push(cut);
      const best = greatestClearance(cut.rings, MIN_CLEARANCE - 1e-9);
      if (!best || best.clearance < MIN_CLEARANCE - 1e-9) {
        errors.push(`${where}: the window is nowhere 3 mm wide (greatest inscribed clearance ${(best?.clearance ?? 0).toFixed(2)} mm, under ${MIN_CLEARANCE} mm)`);
      }
      const hole = cut.rings.some((ring, i) => cut.rings.some((other, j) => i !== j && insideRing(ring[0], other)));
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

/** The guard around the lone X that stands in when the lattice has no room, and the shortest X worth drawing. */
const LONE_GUARD = 0.75;
const MIN_MARK = 1.5;

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
 *   - X marks on a lattice anchored at the centre of the waste's bounding box, each clear of the cut by its reach, the
 *     pen and a guard; if none fits, one X at the point of greatest clearance, shrunk to fit;
 *   - a label in Hershey sans, in the first height that fits clear of the cut, with the X marks under it left out.
 * Throws when the outline is finer than the pen or no X fits. Returns one part, `cut-<id>`, whose boundary is the rings.
 */
export function cutGuides(cut: Cut, pen: string, o: GuideOptions): Part {
  assert(finite(o.penWidth) && o.penWidth > 0 && finite(o.pitch) && o.pitch > 0 && finite(o.size) && o.size > 0 && finite(o.guard) && o.guard >= 0
    && Number.isInteger(o.maxMarks) && o.maxMarks >= 1 && Array.isArray(o.heights) && o.heights.every((h) => finite(h) && h > 0), `cut ${cut.id}: invalid guide options`);
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

  // X marks. Each X is two strokes of length `size`, but the clearance is budgeted for the half-diagonal of the
  // size × size square the X sits in, which is farther than the strokes reach.
  const bounds = boundsOf(rings)!;
  const centre = { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 };
  const reach = (size: number) => size / Math.SQRT2 + half;
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
    const fit = best ? (best.clearance - half - LONE_GUARD) * Math.SQRT2 : 0;
    if (!best || fit < MIN_MARK) throw new Error(`cut ${cut.id}: no room for an X mark`);
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

// ── Rendering one ply ────────────────────────────────────────────────

/**
 * The parts of the ply this render is (`ctx.params[spec.control]`): the ply's art clipped to what it shows, the guides
 * of each of its cuts on `spec.cutPen`, and diagnostics. The diagnostics, one per cut of every ply (`asm-<ply>-<cut>`)
 * and one for the signature box (`asm-signature`), ride in `result.json` so tools can check that every ply drew the
 * same world. Throws for an unknown ply or art in a pen the ply does not carry.
 */
export function renderPly(spec: AssemblySpec, ctx: Pick<SketchContext, 'params'>, pens: Pen[],
  world: { cuts: Cuts; art: Record<string, Part[]> }, guide?: Partial<GuideOptions>): Part[] {
  const id = String(ctx.params[spec.control]);
  const ply = spec.plies.find((p) => p.id === id);
  assert(ply, `Unknown ply: ${id}`);
  const region = plyRegion(spec, world.cuts, ply.id);
  const parts: Part[] = [];
  for (const part of Object.prototype.hasOwnProperty.call(world.art, ply.id) ? world.art[ply.id] : []) {
    assert(ply.pens.includes(part.pen), `Part ${part.id} is drawn in pen ${part.pen}, which ply ${ply.id} does not carry`);
    const paths = clipToRegion(part.paths, region);
    if (paths.length > 0) parts.push({ ...part, paths });
  }
  const ink = pens.find((pen) => pen.id === ply.cutInk);
  assert(ink, `Ply ${ply.id} cutInk ${ply.cutInk} is not a declared pen`);
  for (const cut of cutsOf(world.cuts, ply.id)) parts.push(cutGuides(cut, spec.cutPen, { ...GUIDE_DEFAULTS, ...guide, penWidth: ink.width }));
  for (const q of spec.plies) for (const cut of cutsOf(world.cuts, q.id)) {
    parts.push({ id: `asm-${q.id}-${cut.id}`, pen: spec.cutPen, paths: cut.rings.map(closed), diagnostic: true });
  }
  if (spec.signature) parts.push({ id: 'asm-signature', pen: spec.cutPen, paths: [closed(boxRing(spec.signature.box))], diagnostic: true });
  return parts;
}
