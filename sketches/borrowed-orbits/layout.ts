import type { Vec2 } from './model.ts';

/** World domain in metres; its aspect matches the abstract Tabloid target (same as Prescribed Weather). */
export const WORLD = Object.freeze({ width: 48, height: 78 });

/**
 * Gap in metres between a drawn forbidden region and the capture polygon the simulation uses. Trails end
 * exactly on the capture polygon, so this is the visible clearance between a trail's end and the drawn
 * outline (0.1 m is about 0.5 page mm). A fixed length, not a page distance: geometry never depends on the
 * poster mode.
 */
export const FORBIDDEN_CLEARANCE_M = 0.1;

export type ForbiddenLayoutId = 'none' | 'bars' | 'arc' | 'gate';
export type ForbiddenKind = 'bar' | 'arc' | 'slab';

/** The exact architecture the pen draws: concentric circles about the apparent centre. Never physics. */
export interface GuideSet { centre: Vec2; radii: number[] }

/**
 * A precise forbidden solid. `polygon` is what the pen draws; `capture` is the same shape with its side lengths
 * grown by FORBIDDEN_CLEARANCE_M per side (not a Euclidean offset: the clearance is 0.1 m along edges and up to
 * about 0.15 m at corners and arc ends) and is what the simulation and the guide cut use.
 */
export interface ForbiddenMember {
  /** Simulation id, `forbidden-<name>`. */
  id: string;
  name: string;
  kind: ForbiddenKind;
  /** World metres. */
  polygon: Vec2[];
  capture: Vec2[];
  /** Convex members hide earlier convex members they overlap (hidden-line removal in draw order). */
  convex: boolean;
}

/** `count` circles about `centre`, radii evenly spaced from `inner` to `outer` (one circle sits at the midpoint of a single-guide request). */
export function guideRadii(count: number, inner: number, outer: number): number[] {
  const n = Math.max(1, Math.round(count));
  if (n === 1) return [(inner + outer) / 2];
  return Array.from({ length: n }, (_, i) => inner + ((outer - inner) * i) / (n - 1));
}

/** The middle guide radius, which the orbit period control is defined at. */
export function middleRadius(inner: number, outer: number): number {
  return (inner + outer) / 2;
}

const q = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Oriented rectangle: `len` along `angle`, `wid` across, centred at (cx, cy). Counter-clockwise on a y-up page. */
function orientedRect(cx: number, cy: number, len: number, wid: number, angle: number): Vec2[] {
  const c = Math.cos(angle), s = Math.sin(angle);
  const at = (u: number, v: number): Vec2 => ({ x: q(cx + u * c - v * s), y: q(cy + u * s + v * c) });
  return [at(-len / 2, -wid / 2), at(len / 2, -wid / 2), at(len / 2, wid / 2), at(-len / 2, wid / 2)];
}

/** Annular sector about `centre`, angles in radians, as a closed simple polygon (outer arc, then inner arc back). */
function annularSector(centre: Vec2, rIn: number, rOut: number, a0: number, a1: number): Vec2[] {
  // Chord error of the polygon stays under 0.01 m (about 0.05 page mm) on the outer arc.
  const step = 2 * Math.acos(Math.max(0, 1 - 0.01 / rOut));
  const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) / step));
  const at = (r: number, a: number): Vec2 => ({ x: q(centre.x + r * Math.cos(a)), y: q(centre.y + r * Math.sin(a)) });
  const outer = Array.from({ length: n + 1 }, (_, i) => at(rOut, a0 + ((a1 - a0) * i) / n));
  const inner = Array.from({ length: n + 1 }, (_, i) => at(rIn, a0 + ((a1 - a0) * i) / n)).reverse();
  return [...outer, ...inner];
}

const pad = (name: string, k: number): string => `${name}${String(k + 1).padStart(2, '0')}`;

/**
 * `bars`: `count` thin radial bars, each lying between two neighbouring guide rings and clear of both.
 * Angles follow the golden-angle sequence from a seeded phase, so any prefix is well spread and raising
 * `count` only adds bars; the ring gap and the bar length are seeded per bar. Every bar draws its three
 * values whatever the count, in index order, so the stream stays aligned.
 */
export function barsLayout(random: () => number, guides: GuideSet, count: number): ForbiddenMember[] {
  const gaps = Math.max(1, guides.radii.length - 1);
  const phase = random();
  const members: ForbiddenMember[] = [];
  const width = 0.5;
  for (let k = 0; k < Math.max(0, Math.round(count)); k++) {
    const dGap = random(), dLen = random(), dShift = random();
    if (guides.radii.length < 2) continue;
    const g = Math.min(gaps - 1, Math.floor(dGap * gaps));
    const r0 = guides.radii[g], r1 = guides.radii[g + 1];
    const gap = r1 - r0;
    const length = gap * (0.5 + 0.4 * dLen);
    // The centre moves inside the room the gap leaves, never touching a ring.
    const room = (gap - length) / 2 - 0.1 * gap;
    const rc = (r0 + r1) / 2 + (2 * dShift - 1) * Math.max(0, room);
    const angle = 2 * Math.PI * ((phase + k * 0.6180339887498949) % 1);
    const cx = guides.centre.x + rc * Math.cos(angle), cy = guides.centre.y + rc * Math.sin(angle);
    const c = FORBIDDEN_CLEARANCE_M;
    members.push({
      id: `forbidden-${pad('bar', k)}`, name: pad('bar', k), kind: 'bar', convex: true,
      polygon: orientedRect(cx, cy, length, width, angle),
      capture: orientedRect(cx, cy, length + 2 * c, width + 2 * c, angle),
    });
  }
  return members;
}

/**
 * `arc`: one thick circular-arc band. Its circle is not about the apparent centre: the centre line passes a
 * seeded distance from it, bulging away, so the band cuts across the guide field like a curved wall.
 */
export function arcLayout(random: () => number, guides: GuideSet): ForbiddenMember[] {
  const inner = guides.radii[0], outer = guides.radii[guides.radii.length - 1];
  const dDirection = random(), dOffset = random(), dRadius = random();
  const phi = 2 * Math.PI * dDirection;
  const offset = inner + (outer - inner) * (0.2 + 0.4 * dOffset);
  const radius = outer * (1 + 0.4 * dRadius);
  const half = (0.8 * outer) / radius;
  const thick = 2.4;
  // The circle's centre sits behind the band, so the nearest point of the centre line to the apparent centre is `offset` away.
  const behind = radius - offset;
  const q0 = { x: guides.centre.x - behind * Math.cos(phi), y: guides.centre.y - behind * Math.sin(phi) };
  const c = FORBIDDEN_CLEARANCE_M;
  const rIn = radius - thick / 2, rOut = radius + thick / 2;
  return [{
    id: 'forbidden-arc01', name: 'arc01', kind: 'arc', convex: false,
    polygon: annularSector(q0, rIn, rOut, phi - half, phi + half),
    capture: annularSector(q0, rIn - c, rOut + c, phi - half - c / rIn, phi + half + c / rIn),
  }];
}

/**
 * `gate`: two identical slabs mirror-symmetric about the vertical axis through the apparent centre, a
 * middle guide-radius to either side. Exact: no seeded values.
 */
export function gateLayout(guides: GuideSet): ForbiddenMember[] {
  const inner = guides.radii[0], outer = guides.radii[guides.radii.length - 1];
  const x = (inner + outer) / 2;
  const height = 1.7 * outer;
  const width = 1.4;
  const c = FORBIDDEN_CLEARANCE_M;
  const slab = (side: 'l' | 'r'): ForbiddenMember => {
    const sign = side === 'l' ? -1 : 1;
    return {
      id: `forbidden-slab-${side}`, name: `slab-${side}`, kind: 'slab', convex: true,
      polygon: orientedRect(guides.centre.x + sign * x, guides.centre.y, height, width, Math.PI / 2),
      capture: orientedRect(guides.centre.x + sign * x, guides.centre.y, height + 2 * c, width + 2 * c, Math.PI / 2),
    };
  };
  return [slab('l'), slab('r')];
}

export function buildForbidden(random: () => number, layout: ForbiddenLayoutId, guides: GuideSet, count: number): ForbiddenMember[] {
  switch (layout) {
    case 'bars': return barsLayout(random, guides, count);
    case 'arc': return arcLayout(random, guides);
    case 'gate': return gateLayout(guides);
    default: return [];
  }
}

/** Polygon point test (even-odd). */
export function pointInPolygon(ring: Vec2[], p: Vec2): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
