import type { Cut, Part, Point } from '../../src/sketch/types.ts';
import type { Ink } from './types.ts';

/**
 * Helpers that let a Breach scene feed an assembly (`renderPly`): a scene's parts are `${group}-${ink}` with the pen
 * set to the kit's ink role (`carbon`, `ultramarine`, ...), and an assembly draws with physical pens per ply, so the
 * scene's parts have to be sent to the plies that draw them and re-inked with the ply's own pens. The censor bar
 * (`hatchedBar`'s quad) and a part glued on as an onlay are cuts of the assembly.
 */

/**
 * What one ply draws of a scene. `groups` are the part-id groups drawn on this ply: the part id less its `-<ink>`
 * suffix, so 'shadow-beam' and 'shadow' are two groups. `inks` maps each kit ink role the ply draws to the physical
 * pen id (the ink's catalog id) that draws it there.
 */
export interface PlyRoute { groups: string[]; inks: Partial<Record<Ink, string>> }

/** The group of a scene part: its id less the `-<ink>` suffix, which must be the part's pen. */
function groupOf(part: Part): string {
  const suffix = `-${part.pen}`;
  if (!part.id.endsWith(suffix) || part.id.length === suffix.length) throw new Error(`part ${part.id} is not named <group>-<ink> for its pen ${part.pen}`);
  return part.id.slice(0, -suffix.length);
}

/**
 * Sorts a scene's parts into the plies that draw them: `routes` is by ply id, and the result is the world's `art`
 * (one list per ply, in the scene's own order, every ply of `routes` present even when empty). Each part goes to the one
 * ply whose route claims its group, with its pen changed from the kit ink to the ply's physical pen for that ink; the
 * part's id is kept, so the kit's ids stay unique on a ply even when two inks share a pen.
 *
 * Throws, naming the part, rather than drop or guess: when no route claims the part's group, when more than one does
 * (it would be drawn twice), when the part's ink has no pen on the ply that claims it, or when its id is not
 * `<group>-<pen>`.
 */
export function routeParts(parts: Part[], routes: Record<string, PlyRoute>): Record<string, Part[]> {
  const art: Record<string, Part[]> = Object.fromEntries(Object.keys(routes).map((ply) => [ply, []]));
  for (const part of parts) {
    const group = groupOf(part);
    const plies = Object.keys(routes).filter((ply) => routes[ply].groups.includes(group));
    if (plies.length === 0) throw new Error(`part ${part.id}: its group ${group} is drawn on no ply (routes: ${Object.keys(routes).join(', ')})`);
    if (plies.length > 1) throw new Error(`part ${part.id}: its group ${group} is claimed by more than one ply (${plies.join(', ')})`);
    const ply = plies[0];
    const pen = Object.prototype.hasOwnProperty.call(routes[ply].inks, part.pen) ? routes[ply].inks[part.pen as Ink] : undefined;
    if (!pen) throw new Error(`part ${part.id}: ink ${part.pen} has no pen on ply ${ply} (it has ${Object.keys(routes[ply].inks).join(', ') || 'none'})`);
    art[ply].push({ ...part, pen });
  }
  return art;
}

/**
 * A censor bar as a cut: the quad that `hatchedBar` returns (a window cut through the ply, `waste`, or a piece cut out
 * and kept, `part`). The ring is a copy.
 */
export function barCut(id: string, quad: Point[], kind: 'waste' | 'part' = 'waste'): Cut {
  if (!Array.isArray(quad) || quad.length < 3 || quad.some((p) => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) throw new Error(`bar ${id}: the quad needs at least three finite points`);
  return { id, kind, rings: [quad.map((p) => ({ x: p.x, y: p.y }))] };
}

/** The area centroid of a polygon, or the mean of its vertices when it has no area. */
function centroid(ring: Point[]): Point {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j].x * ring[i].y - ring[i].x * ring[j].y;
    area += cross;
    cx += (ring[j].x + ring[i].x) * cross;
    cy += (ring[j].y + ring[i].y) * cross;
  }
  if (Math.abs(area) < 1e-9) return { x: ring.reduce((s, p) => s + p.x, 0) / ring.length, y: ring.reduce((s, p) => s + p.y, 0) / ring.length };
  return { x: cx / (3 * area), y: cy / (3 * area) };
}

/**
 * Where a part is glued on, as the onlay ply's footprint: the part's rings turned `rotate` degrees about the centroid
 * of its outer (first) ring, then moved by (`dx`, `dy`) millimetres. Positive `rotate` turns +x toward +y, which is
 * clockwise on the page (y points down), as SVG's `rotate()` does. The vertices keep their order and count, so the
 * footprint is congruent to the part by construction, which is what finalize checks (a rigid fit, Kabsch, with the
 * residual near zero). The result is a `footprint` cut with the part's id.
 */
export function footprintOf(cut: Cut, transform: { dx: number; dy: number; rotate: number }): Cut {
  const { dx, dy, rotate } = transform;
  if (![dx, dy, rotate].every(Number.isFinite)) throw new Error(`footprint of ${cut.id}: dx, dy and rotate must be finite numbers`);
  if (!Array.isArray(cut.rings) || cut.rings.length === 0 || cut.rings.some((ring) => !Array.isArray(ring) || ring.length < 3)) throw new Error(`footprint of ${cut.id}: the cut needs rings of at least three points`);
  const about = centroid(cut.rings[0]);
  const angle = (rotate * Math.PI) / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const move = (p: Point): Point => ({
    x: about.x + cos * (p.x - about.x) - sin * (p.y - about.y) + dx,
    y: about.y + sin * (p.x - about.x) + cos * (p.y - about.y) + dy,
  });
  return { id: cut.id, kind: 'footprint', rings: cut.rings.map((ring) => ring.map(move)) };
}
