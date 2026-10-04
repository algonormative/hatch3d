import type { Vec2 } from './model.ts';

/** World domain in metres; its aspect matches the abstract Tabloid target. */
export const WORLD = Object.freeze({ width: 48, height: 78 });
/** Fin plate thickness in the `span` layout, deliberately thinner than a grid cell. */
export const FIN_THICKNESS = 0.15;
/** The quiet core's centre in world metres (the page centre) and the members' keep-out radius around it. */
export const CORE_CENTER: Vec2 = Object.freeze({ x: WORLD.width / 2, y: WORLD.height / 2 });
export const CORE_KEEP_OUT = 8.6;

export type LayoutId = 'span' | 'orbit' | 'colonnade' | 'portal' | 'ring' | 'sun';
export type MemberKind = 'slab' | 'pier' | 'fin' | 'box' | 'wedge' | 'rail' | 'plate' | 'radial' | 'ray' | 'arc' | 'spike';

/** An architectural member. It is both a solid in the simulation and a drawn outline. */
export interface StructureMember {
  /** Simulation id, `solid-<name>`. */
  id: string;
  name: string;
  kind: MemberKind;
  /** Physical pen the member is drawn in. */
  pen: string;
  /** World metres; convex simple polygon. */
  polygon: Vec2[];
  /** Interior hatch direction in art space, radians. */
  hatchAngle: number;
  /** Multiplier on the structure hatch pitch (1 = the `hatchPitch` control). */
  pitch: number;
  /** A second, sparser hatch set crossing the first. */
  cross: boolean;
  /** Hatch pitch compresses across the member, giving a tonal ramp. */
  tonal: boolean;
  /**
   * World-metre polylines drawn instead of outline plus hatch (rays, ring strokes, filaments). The
   * polygon is still the simulation solid. Such members never overlap one another.
   */
  strokes?: Vec2[][];
  /**
   * false: drawn only. The marks exist on paper but the member is not a solid in the simulation, so it
   * does not block the weather (an artistic departure). Absent means solid.
   */
  solid?: boolean;
}

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
const snap = (v: number): number => Math.round(v * 20) / 20;

/**
 * `span`: members enter from the left and right frame edges and stop short of the
 * middle, leaving a missing span of about fourteen metres.
 */
export function spanLayout(random: () => number): StructureMember[] {
  const jitter = (amount: number): number => snap((random() - 0.5) * 2 * amount);
  const W = WORLD.width;
  const members: StructureMember[] = [];
  const add = (name: string, kind: MemberKind, pen: string, polygon: Vec2[], hatchAngle: number): void => {
    members.push({ id: `solid-${name}`, name, kind, pen, polygon, hatchAngle, pitch: 1, cross: false, tonal: false });
  };
  const aEnd = 16.4 + jitter(1.2);
  const aY = 12 + jitter(1.5);
  add('deck-a', 'slab', 'carbon', rect(-2, aY, aEnd, aY + 4.4), 0.9);
  const bStart = 32 + jitter(1.2);
  const bY = 34 + jitter(1.5);
  add('deck-b', 'slab', 'carbon', rect(bStart, bY, W + 2, bY + 4.6), -0.9);
  const cEnd = 13.5 + jitter(1.5);
  const cY = 63 + jitter(1.5);
  add('deck-c', 'slab', 'carbon', rect(-2, cY, cEnd, cY + 3.6), 0.9);
  const pierAX = aEnd - 6.2 + jitter(0.6);
  add('pier-a', 'pier', 'ultramarine', rect(pierAX, aY + 4.4, pierAX + 3.2, aY + 33), -0.9);
  const pierBX = bStart + 5.4 + jitter(0.6);
  add('pier-b', 'pier', 'ultramarine', rect(pierBX, bY + 4.6, pierBX + 3.2, bY + 38), 0.9);
  const finX = 24.6 + jitter(0.6);
  const finY = 46 + jitter(1);
  add('fin', 'fin', 'violet', rect(finX, finY, finX + FIN_THICKNESS, finY + 17.5), 0.9);
  return members;
}

// ----------------------------------------------------------------- orbit

/** Oriented box: `len` along `angle`, `wid` across. */
function orientedBox(cx: number, cy: number, len: number, wid: number, angle: number): Vec2[] {
  return taper(cx, cy, len, wid, wid, angle);
}

/** Trapezoid along `angle`: width `w0` at the back, `w1` at the front (0 gives a triangle). */
function taper(cx: number, cy: number, len: number, w0: number, w1: number, angle: number): Vec2[] {
  const c = Math.cos(angle), s = Math.sin(angle);
  const q = (v: number): number => Math.round(v * 1000) / 1000;
  const at = (u: number, v: number): Vec2 => ({ x: q(cx + u * c - v * s), y: q(cy + u * s + v * c) });
  const pts = [at(-len / 2, -w0 / 2), at(len / 2, -w1 / 2)];
  if (w1 > 0) pts.push(at(len / 2, w1 / 2));
  pts.push(at(-len / 2, w0 / 2));
  return pts;
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const sq = dx * dx + dy * dy;
  const t = sq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / sq));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function inside(ring: Vec2[], p: Vec2): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** Distance from `p` to a polygon (0 when inside). */
export function distanceToPolygon(ring: Vec2[], p: Vec2): number {
  if (inside(ring, p)) return 0;
  return Math.min(...ring.map((a, i) => distanceToSegment(p, a, ring[(i + 1) % ring.length])));
}

const PEN_WEIGHTS: [string, number][] = [
  ['carbon', 0.42], ['ultramarine', 0.28], ['vermilion', 0.09], ['violet', 0.08], ['acid', 0.05], ['coral', 0.04], ['gold', 0.04],
];

/** Group sizes at density 0 and 1. A member's identity never depends on the density; only how many of each group are kept. */
const ORBIT_COUNTS = { clusterA: [10, 22], clusterB: [10, 22], satellite: [6, 12], radial: [5, 8], rail: [3, 6] } as const;
const RADIAL_SLOTS = 8;
/** Slot order that keeps any prefix of radials spread around the core. */
const RADIAL_ORDER = [0, 4, 2, 6, 1, 5, 3, 7];
export const ORBIT_MAX_MEMBERS = 22 + 22 + 12 + 8 + 6;

/**
 * `orbit`: two large clusters and a satellite of rotated members around the quiet core,
 * long members that radiate out through the frame edge, and a few free rails. Every
 * member keeps `CORE_KEEP_OUT` metres clear of the core.
 *
 * `density` (0..1) only chooses how many members of each group are kept: the full
 * candidate list is always generated in the same order from `random`, then a prefix of
 * each group is taken, so raising the density adds members and never moves the others.
 */
export function orbitLayout(random: () => number, density = 0.6): StructureMember[] {
  const d = Math.max(0, Math.min(1, density));
  const keep = (range: readonly [number, number]): number => Math.round(range[0] + (range[1] - range[0]) * d);
  const range = (a: number, b: number): number => a + (b - a) * random();
  const pickPen = (): string => {
    let r = random();
    for (const [pen, w] of PEN_WEIGHTS) { r -= w; if (r <= 0) return pen; }
    return 'carbon';
  };
  const clear = (ring: Vec2[]): boolean => distanceToPolygon(ring, CORE_CENTER) >= CORE_KEEP_OUT;
  const onPage = (ring: Vec2[]): boolean => ring.some(p => p.x > -1 && p.x < WORLD.width + 1 && p.y > -1 && p.y < WORLD.height + 1);
  type Draft = Omit<StructureMember, 'id' | 'name'>;

  const cluster = (center: Vec2, axis: number, count: number, spread: number): Draft[] => {
    const out: Draft[] = [];
    const ax = { x: Math.cos(axis), y: Math.sin(axis) };
    const px = { x: -ax.y, y: ax.x };
    for (let n = 0; n < count; n++) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const along = (random() - 0.5) * 2 * spread * 1.25;
        const across = (random() - 0.5) * 2 * spread * 0.7;
        const cx = center.x + ax.x * along + px.x * across;
        const cy = center.y + ax.y * along + px.y * across;
        const angle = axis + (random() - 0.5) * 0.55 + (random() < 0.22 ? Math.PI / 2 : 0);
        const roll = random();
        let kind: MemberKind;
        let polygon: Vec2[];
        if (roll < 0.5) { kind = 'box'; polygon = orientedBox(cx, cy, range(3.5, 11), range(1.1, 4), angle); }
        else if (roll < 0.68) { kind = 'wedge'; polygon = taper(cx, cy, range(4, 10), range(1.6, 4), range(0, 1), angle); }
        else if (roll < 0.84) { kind = 'rail'; polygon = orientedBox(cx, cy, range(6, 13), range(0.15, 0.35), angle); }
        else { kind = 'plate'; const s = range(1.8, 4.2); polygon = orientedBox(cx, cy, s, s * range(0.8, 1.2), angle); }
        if (!clear(polygon) || !onPage(polygon)) continue;
        const rail = kind === 'rail';
        // Hatch along the member, across it as rungs, or on the diagonal.
        const hatchAngle = angle + [0.62, -0.62, Math.PI / 2, 0.2][Math.floor(random() * 4)];
        const pen = rail ? (random() < 0.5 ? 'violet' : 'vermilion') : pickPen();
        out.push({ kind, polygon, pen, hatchAngle, pitch: rail ? 2.6 : range(0.55, 1.6), cross: !rail && random() < 0.16, tonal: !rail && random() < 0.18 });
        break;
      }
    }
    return out;
  };
  // Two large clusters on opposite sides of the core, one small satellite.
  const sign = random() < 0.5 ? 1 : -1;
  const clusterA = cluster({ x: 24 + 12 * sign + range(-1.5, 1.5), y: 39 - 15 + range(-2, 2) }, -0.95 * sign + range(-0.2, 0.2), ORBIT_COUNTS.clusterA[1], 4.8);
  const clusterB = cluster({ x: 24 - 12 * sign + range(-1.5, 1.5), y: 39 + 15 + range(-2, 2) }, -0.95 * sign + range(-0.2, 0.2), ORBIT_COUNTS.clusterB[1], 4.8);
  const upper = random() < 0.5;
  const satellite = cluster({ x: 24 + (upper ? 14 : -14) * sign + range(-1, 1), y: 39 + (upper ? 27 : -27) + range(-2, 2) }, 0.5 * sign + range(-0.3, 0.3), ORBIT_COUNTS.satellite[1], 3.8);

  // Long members that radiate from just outside the core and run out through the frame edge.
  const phase = random() * Math.PI * 2;
  const radials: Draft[] = [];
  for (const slot of RADIAL_ORDER) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const phi = phase + (Math.PI * 2 * slot) / RADIAL_SLOTS + range(-0.22, 0.22);
      const dir = { x: Math.cos(phi), y: Math.sin(phi) };
      // Distance along the ray to leave the domain rectangle.
      const tx = dir.x > 0 ? (WORLD.width - CORE_CENTER.x) / dir.x : dir.x < 0 ? -CORE_CENTER.x / dir.x : Infinity;
      const ty = dir.y > 0 ? (WORLD.height - CORE_CENTER.y) / dir.y : dir.y < 0 ? -CORE_CENTER.y / dir.y : Infinity;
      const r0 = CORE_KEEP_OUT + range(1.2, 4.5);
      const r1 = Math.min(tx, ty) + 3;
      if (r1 - r0 < 8) continue;
      const w0 = random() < 0.2 ? range(0.18, 0.5) : range(1.2, 3.4);
      const w1 = w0 * range(0.3, 1.1);
      const mid = (r0 + r1) / 2;
      const polygon = taper(CORE_CENTER.x + dir.x * mid, CORE_CENTER.y + dir.y * mid, r1 - r0, w0, w1, phi);
      if (!clear(polygon)) continue;
      const thin = w0 < 0.6;
      radials.push({
        kind: 'radial', polygon, pen: thin ? 'violet' : random() < 0.6 ? 'carbon' : 'ultramarine',
        hatchAngle: phi + (random() < 0.5 ? Math.PI / 2 : 0.5), pitch: thin ? 3 : range(1, 1.8),
        cross: !thin && random() < 0.2, tonal: !thin && random() < 0.3,
      });
      break;
    }
  }
  // A few free rails bridging between the clusters (some thinner than a grid cell).
  const rails: Draft[] = [];
  for (let n = 0; n < ORBIT_COUNTS.rail[1]; n++) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const polygon = orientedBox(range(8, 40), range(10, 68), range(7, 15), range(0.15, 0.3), range(0, Math.PI));
      if (!clear(polygon) || !onPage(polygon)) continue;
      rails.push({ kind: 'rail', polygon, pen: n % 2 ? 'violet' : 'vermilion', hatchAngle: Math.PI / 2 + range(-0.3, 0.3), pitch: 2.6, cross: false, tonal: false });
      break;
    }
  }
  const members: StructureMember[] = [];
  const take = (prefix: string, drafts: Draft[], count: number): void => {
    drafts.slice(0, count).forEach((draft, i) => {
      const name = `${prefix}${String(i + 1).padStart(2, '0')}`;
      members.push({ id: `solid-${name}`, name, ...draft });
    });
  };
  take('a', clusterA, keep(ORBIT_COUNTS.clusterA));
  take('b', clusterB, keep(ORBIT_COUNTS.clusterB));
  take('c', satellite, keep(ORBIT_COUNTS.satellite));
  take('r', radials, keep(ORBIT_COUNTS.radial));
  take('f', rails, keep(ORBIT_COUNTS.rail));
  return members;
}

// ------------------------------------------------- symmetric layouts
// No seeded jitter anywhere below: the geometry is a pure function of its arguments, computed
// exactly (no rounding), so mirror and rotation symmetry hold to floating-point precision.

type Draft = Omit<StructureMember, 'id' | 'name'>;
const member = (name: string, draft: Draft): StructureMember => ({ id: `solid-${name}`, name, ...draft });
const SYM_PITCH = 1;
const MIRROR_X = CORE_CENTER.x;
const mirror = (ring: Vec2[]): Vec2[] => ring.map(p => ({ x: 2 * MIRROR_X - p.x, y: p.y })).reverse();
const box = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const rotateAbout = (ring: Vec2[], by: number): Vec2[] => {
  const c = Math.cos(by), s = Math.sin(by);
  return ring.map(p => ({ x: CORE_CENTER.x + (p.x - CORE_CENTER.x) * c - (p.y - CORE_CENTER.y) * s, y: CORE_CENTER.y + (p.x - CORE_CENTER.x) * s + (p.y - CORE_CENTER.y) * c }));
};

/**
 * `colonnade`: two facing rows of identical horizontal slabs, exactly equally spaced across the page and
 * perpendicular to a mostly downward wind, so the wakes behind the slabs become stripes and the gaps
 * between them channel the weather. The middle of each row is left open around the quiet core.
 * `density` picks the column count: 4 below 0.34, 6 below 0.67, else 8.
 */
export function colonnadeLayout(density = 0.6): StructureMember[] {
  const columns = density < 0.34 ? 4 : density < 0.67 ? 6 : 8;
  const pitch = WORLD.width / columns;
  const length = pitch * 0.7;
  const thick = 2.2;
  const members: StructureMember[] = [];
  const rows: [string, number, string][] = [['u', CORE_CENTER.y - 16, 'carbon'], ['l', CORE_CENTER.y + 16, 'ultramarine']];
  for (const [prefix, y, pen] of rows) {
    for (let k = 0; k < columns; k++) {
      const cx = pitch * (k + 0.5);
      // Keep the core and the middle of the row clear.
      const ring = box(cx - length / 2, y - thick / 2, cx + length / 2, y + thick / 2);
      if (distanceToPolygon(ring, CORE_CENTER) < CORE_KEEP_OUT) continue;
      members.push(member(`${prefix}${String(k + 1).padStart(2, '0')}`, { kind: 'slab', polygon: ring, pen, hatchAngle: Math.PI / 4, pitch: SYM_PITCH, cross: false, tonal: false }));
    }
  }
  return members;
}

/**
 * `portal`: a mirror-symmetric gate. Two identical massive piers either side of the core, a lintel above,
 * two identical thin sills below, and three pairs of identical long rails running to the frame.
 */
export function portalLayout(): StructureMember[] {
  const members: StructureMember[] = [];
  const leftPier = box(MIRROR_X - 15, CORE_CENTER.y - 16, MIRROR_X - 10, CORE_CENTER.y + 16);
  const pair = (name: string, ring: Vec2[], pen: string, hatchAngle: number): void => {
    members.push(member(`${name}-l`, { kind: 'pier', polygon: ring, pen, hatchAngle, pitch: SYM_PITCH, cross: false, tonal: false }));
    members.push(member(`${name}-r`, { kind: 'pier', polygon: mirror(ring), pen, hatchAngle: Math.PI - hatchAngle, pitch: SYM_PITCH, cross: false, tonal: false }));
  };
  pair('pier', leftPier, 'carbon', Math.PI / 4);
  members.push(member('lintel', { kind: 'slab', polygon: box(MIRROR_X - 19, CORE_CENTER.y - 22, MIRROR_X + 19, CORE_CENTER.y - 16), pen: 'carbon', hatchAngle: Math.PI / 2, pitch: SYM_PITCH, cross: false, tonal: false }));
  pair('sill', box(MIRROR_X - 15, CORE_CENTER.y + 20, MIRROR_X - 4, CORE_CENTER.y + 21), 'ultramarine', Math.PI / 2);
  // Long rails: horizontal from each pier to the frame, and vertical from the lintel to the top frame.
  for (const [k, dy] of [-9, 0, 9].entries()) pair(`rail${k + 1}`, box(-2, CORE_CENTER.y + dy - 0.15, MIRROR_X - 15, CORE_CENTER.y + dy + 0.15), 'ultramarine', Math.PI / 2);
  pair('mast', box(MIRROR_X - 17, -2, MIRROR_X - 16.6, CORE_CENTER.y - 22), 'ultramarine', Math.PI / 2);
  return members;
}

/**
 * `ring`: `count` identical radial slabs in exact rotational symmetry about the core, inner ends at a
 * fixed radius, plus `count` identical thin tangent rails around them (the outer ring segments).
 */
export function ringLayout(count = 8): StructureMember[] {
  const n = Math.max(4, Math.min(12, Math.round(count)));
  const inner = 12.5, length = 15, width = 2.6;
  const slab = box(CORE_CENTER.x + inner, CORE_CENTER.y - width / 2, CORE_CENTER.x + inner + length, CORE_CENTER.y + width / 2);
  const outerR = inner + length + 4.5;
  const chord = 2 * outerR * Math.tan(Math.PI / n) * 0.78;
  const rail = box(CORE_CENTER.x + outerR - 0.15, CORE_CENTER.y - chord / 2, CORE_CENTER.x + outerR + 0.15, CORE_CENTER.y + chord / 2);
  const members: StructureMember[] = [];
  for (let k = 0; k < n; k++) {
    const by = (2 * Math.PI * k) / n;
    members.push(member(`s${String(k + 1).padStart(2, '0')}`, { kind: 'slab', polygon: rotateAbout(slab, by), pen: 'carbon', hatchAngle: by + Math.PI / 2, pitch: SYM_PITCH, cross: false, tonal: false }));
  }
  for (let k = 0; k < n; k++) {
    const by = (2 * Math.PI * k) / n;
    members.push(member(`t${String(k + 1).padStart(2, '0')}`, { kind: 'rail', polygon: rotateAbout(rail, by), pen: 'ultramarine', hatchAngle: by, pitch: SYM_PITCH * 2.4, cross: false, tonal: false }));
  }
  return members;
}

// ------------------------------------------------------------------ sun

export interface SunOptions {
  /** Ray count, even (alternating long and short rays). */
  rays: number;
  /** Inner radius of the rays in metres. */
  inner: number;
  /** Outer radius of the long rays in metres. */
  reach: number;
  /** Short ray length as a fraction of the long ray length (0..1). */
  alternate: number;
  /** Concentric ring bands, 0..3. */
  rings: number;
  /** Ring bands are solids in the simulation when true; drawn-only otherwise (the corona is always drawn-only). */
  solidRings?: boolean;
  /** 0 = exact rotational symmetry; above 0, seeded perturbation. */
  noise: number;
  /** Named stream `sun-noise`. Every draw is made whatever the noise, so the noise control only scales values. */
  random: () => number;
}

const SUN_ACCENT = 'vermilion';
/** Spacing of the parallel strokes in a ray and in a ring band, metres (about 1.5 mm of page). */
const SUN_STROKE = 0.3;
const SUN_BAND = 0.9;
const SUN_SPIKE_WIDTH = 0.15;
const SUN_SPIKE_LENGTH = 3.4;
const SUN_MARGIN = 0.35;
/** Fraction of each sector between two rays that a ring arc covers; the rest is open for the weather. */
const SUN_RING_FILL = 0.5;

/**
 * `sun`: tapered rays radiate from just outside the quiet core, alternating long and short; thin ring
 * bands, broken into arcs between the rays so the weather threads through; and a corona of fine
 * filaments off the outermost band's outer edge. Rays are drawn as lines parallel to the ray axis that end where the
 * wedge narrows below their offset. At noise 0 the layout has exact rotational symmetry (by two ray
 * steps); noise perturbs ray length, angle and taper, ring radius (a smooth low-frequency wobble) and
 * filament length and presence. The rays are solids in the simulation. Ring bands are drawn-only unless
 * `solidRings`; the corona filaments are always drawn-only (glints, not walls). Drawn-only marks are an
 * artistic departure: the weather passes through them.
 */
export function sunLayout(o: SunOptions): StructureMember[] {
  const n = Math.max(12, Math.min(72, Math.round(o.rays / 2) * 2));
  const inner = Math.max(CORE_KEEP_OUT + 1.2, o.inner);
  const reach = Math.max(inner + 6, o.reach);
  const noise = Math.max(0, Math.min(1, o.noise));
  const u = (): number => 2 * o.random() - 1;
  const step = (2 * Math.PI) / n;
  const cx = CORE_CENTER.x, cy = CORE_CENTER.y;
  const members: StructureMember[] = [];
  const pt = (r: number, a: number): Vec2 => ({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  const baseWidth = Math.max(0.3, 0.45 * 2 * Math.PI * inner / n);

  interface Ray { angle: number; length: number; width: number }
  const rays: Ray[] = [];
  for (let k = 0; k < n; k++) {
    const dAngle = u(), dLength = u(), dWidth = u();
    const long = k % 2 === 0;
    const length = (reach - inner) * (long ? 1 : Math.max(0.1, Math.min(1, o.alternate))) * (1 + noise * 0.4 * dLength);
    rays.push({
      angle: step * k + noise * 0.3 * step * dAngle,
      length,
      width: Math.max(0.3, baseWidth * (1 + noise * 0.4 * dWidth)),
    });
  }
  const halfWidthAt = (ray: Ray, r: number): number => {
    const t = (r - inner) / ray.length;
    return t >= 1 ? 0 : (ray.width / 2) * (1 - Math.max(0, t));
  };
  rays.forEach((ray, k) => {
    const dir = { x: Math.cos(ray.angle), y: Math.sin(ray.angle) };
    const perp = { x: -dir.y, y: dir.x };
    const base = pt(inner, ray.angle);
    const tip = pt(inner + ray.length, ray.angle);
    const polygon: Vec2[] = [
      { x: base.x + (perp.x * ray.width) / 2, y: base.y + (perp.y * ray.width) / 2 }, tip,
      { x: base.x - (perp.x * ray.width) / 2, y: base.y - (perp.y * ray.width) / 2 },
    ];
    const strands = 2 * Math.floor(ray.width / (2 * SUN_STROKE)) + 1;
    const strokes: Vec2[][] = [];
    for (let j = 0; j < strands; j++) {
      const v = (j - (strands - 1) / 2) * SUN_STROKE;
      const end = ray.length * (1 - (2 * Math.abs(v)) / ray.width);
      strokes.push([
        { x: base.x + perp.x * v, y: base.y + perp.y * v },
        { x: base.x + perp.x * v + dir.x * end, y: base.y + perp.y * v + dir.y * end },
      ]);
    }
    members.push(member(`ray${String(k + 1).padStart(2, '0')}`, { kind: 'ray', polygon, pen: 'carbon', hatchAngle: 0, pitch: 1, cross: false, tonal: false, strokes }));
  });

  // Ring bands: radii spread between the rays' inner end and the long tips.
  const fractions = [[], [0.5], [0.36, 0.66], [0.26, 0.5, 0.74]][Math.max(0, Math.min(3, Math.round(o.rings)))];
  const harmonics: number[][] = [];
  const spikeDraws: number[][] = [];
  const arcDraws: number[][] = [];
  for (let i = 0; i < 3; i++) {
    harmonics.push([o.random() * 2 * Math.PI, o.random() * 2 * Math.PI]);
    spikeDraws.push(Array.from({ length: n * 3 * 2 }, () => o.random()));
    arcDraws.push(Array.from({ length: n }, () => o.random()));
  }
  fractions.forEach((fraction, ri) => {
    const r0 = inner + (reach - inner) * fraction;
    const radiusAt = (a: number): number =>
      r0 + noise * 0.06 * r0 * (Math.sin(3 * a + harmonics[ri][0]) + 0.5 * Math.sin(5 * a + harmonics[ri][1]));
    // Only the outermost band carries a corona: a filament off an inner band would run into the next band.
    const corona = ri === fractions.length - 1;
    for (let k = 0; k < n; k++) {
      const a = rays[k], b = rays[(k + 1) % n];
      const aEnd = a.angle + Math.atan2(halfWidthAt(a, r0 - SUN_BAND / 2) + SUN_MARGIN, r0);
      let bStart = b.angle - Math.atan2(halfWidthAt(b, r0 - SUN_BAND / 2) + SUN_MARGIN, r0);
      if (k === n - 1) bStart += 2 * Math.PI;
      if (bStart - aEnd < 0.02) continue;
      // The band fills only part of the sector, so the weather can thread between arcs as well as between rays.
      const sector = bStart - aEnd;
      const span = sector * SUN_RING_FILL;
      const shift = noise * 0.2 * sector * (2 * arcDraws[ri][k] - 1);
      const from = aEnd + (sector - span) / 2 + shift;
      const to = from + span;
      const count = Math.max(2, Math.ceil(((to - from) * 180) / Math.PI / 1.5));
      const angles = Array.from({ length: count + 1 }, (_, i) => from + ((to - from) * i) / count);
      const offsets = (d: number): Vec2[] => angles.map(t => pt(radiusAt(t) + d, t));
      const polygon = [...offsets(SUN_BAND / 2), ...offsets(-SUN_BAND / 2).reverse()];
      const strokes = [-SUN_STROKE, 0, SUN_STROKE].map(d => offsets(d));
      const name = `ring${ri + 1}-${String(k + 1).padStart(2, '0')}`;
      members.push(member(name, { kind: 'arc', polygon, pen: SUN_ACCENT, hatchAngle: 0, pitch: 1, cross: false, tonal: false, strokes, solid: o.solidRings === true }));
      if (!corona) continue;
      for (let j = 0; j < 3; j++) {
        const dp = spikeDraws[ri][(k * 3 + j) * 2], dl = spikeDraws[ri][(k * 3 + j) * 2 + 1];
        // Presence and length: all kept at noise 0; noise drops some and varies the rest.
        if (dp < noise * 0.35) continue;
        const t = from + (to - from) * [0.15, 0.5, 0.85][j];
        const length = SUN_SPIKE_LENGTH * (1 + noise * 0.8 * (2 * dl - 1));
        const r1 = radiusAt(t) + SUN_BAND / 2 + 0.05;
        const dir = { x: Math.cos(t), y: Math.sin(t) };
        const perp = { x: -dir.y, y: dir.x };
        const p0 = pt(r1, t), p1 = pt(r1 + length, t);
        const w = SUN_SPIKE_WIDTH / 2;
        const spike: Vec2[] = [
          { x: p0.x + perp.x * w, y: p0.y + perp.y * w }, { x: p1.x + perp.x * w, y: p1.y + perp.y * w },
          { x: p1.x - perp.x * w, y: p1.y - perp.y * w }, { x: p0.x - perp.x * w, y: p0.y - perp.y * w },
        ];
        members.push(member(`spike${ri + 1}-${String(k + 1).padStart(2, '0')}-${j + 1}`, { kind: 'spike', polygon: spike, pen: SUN_ACCENT, hatchAngle: 0, pitch: 1, cross: false, tonal: false, strokes: [[p0, p1]], solid: false }));
      }
    }
  });
  return members;
}

export function buildStructure(random: () => number, layout: LayoutId = 'span', density = 0.6, ringCount = 8, sun?: SunOptions): StructureMember[] {
  switch (layout) {
    case 'orbit': return orbitLayout(random, density);
    case 'colonnade': return colonnadeLayout(density);
    case 'portal': return portalLayout();
    case 'ring': return ringLayout(ringCount);
    case 'sun': return sunLayout(sun ?? { rays: 22, inner: 10.5, reach: 20, alternate: 0.55, rings: 2, noise: 0.15, random });
    default: return spanLayout(random);
  }
}
