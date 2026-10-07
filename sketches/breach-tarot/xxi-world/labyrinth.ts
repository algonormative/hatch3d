/**
 * The Chartres labyrinth as a plan. Eleven circuits wind round a centre in four quadrants. The turns
 * are stacked on the four axes, and two lanes run up the entrance axis. The path order is read off
 * the labyrinth laid in the nave of Chartres Cathedral around 1200: it enters left of the axis,
 * straight to the fifth circuit, sweeps out to the edge and back, and reaches the centre from the
 * seventh. Every turn is derived from that order, so the walls are the path's own.
 *
 * Plan coordinates: X runs to the right and Y toward the entrance (the viewer). Angles are measured
 * from +X toward +Y. Circuits run 1 (outermost) to 11, and wall j lies between circuits j and j + 1,
 * so wall 0 is the rim and wall 11 rings the centre.
 */
export type Quadrant = 'LL' | 'UL' | 'UR' | 'LR';
export type Axis = 'B' | 'L' | 'T' | 'R';
export type P2 = { x: number; y: number };

/** The path through the 44 arcs, in walking order: quadrant (near-left, far-left, far-right, near-right) and circuit. */
export const CHARTRES: readonly (readonly [Quadrant, number])[] = [
  ['LL', 5], ['LL', 6], ['LL', 11], ['UL', 11], ['UL', 10], ['LL', 10], ['LL', 9], ['LL', 8], ['LL', 7],
  ['UL', 7], ['UL', 8], ['UL', 9], ['UR', 9], ['UR', 10], ['UR', 11], ['LR', 11], ['LR', 10], ['LR', 9], ['LR', 8],
  ['UR', 8], ['UR', 7], ['UR', 6], ['UL', 6], ['UL', 5], ['UL', 4], ['LL', 4], ['LL', 3], ['LL', 2], ['LL', 1],
  ['UL', 1], ['UL', 2], ['UL', 3], ['UR', 3], ['UR', 4], ['UR', 5], ['LR', 5], ['LR', 4], ['LR', 3], ['LR', 2],
  ['UR', 2], ['UR', 1], ['LR', 1], ['LR', 6], ['LR', 7],
];

export const CIRCUITS = 11;
const AXES_OF: Record<Quadrant, [Axis, Axis]> = { LL: ['B', 'L'], UL: ['L', 'T'], UR: ['T', 'R'], LR: ['R', 'B'] };
const AXIS_ANGLE: Record<Axis, number> = { R: 0, B: Math.PI / 2, L: Math.PI, T: 1.5 * Math.PI };

/** How the path leaves or enters an arc at an axis. */
export type Join =
  | { kind: 'straight' }
  | { kind: 'turn'; wall: number }
  | { kind: 'lane' };

export interface Arc { q: Quadrant; k: number; from: Axis; to: Axis; start: Join; end: Join }

/**
 * Walk the order and name every join. A step to the same circuit in the next quadrant goes straight
 * through their shared axis. A step to the next circuit in the same quadrant turns round the tongue of
 * the wall between them. Any other step runs along an entrance lane. Throws if the order is not a
 * single path through all 44 arcs.
 */
export function arcs(order = CHARTRES): Arc[] {
  const out: Arc[] = [];
  const seen = new Set<string>();
  let at: Axis = 'B';
  let start: Join = { kind: 'lane' };
  order.forEach(([q, k], i) => {
    const id = `${q}${k}`;
    if (seen.has(id)) throw new Error(`labyrinth: ${id} walked twice`);
    seen.add(id);
    const [a, b] = AXES_OF[q];
    if (at !== a && at !== b) throw new Error(`labyrinth: ${id} does not touch axis ${at}`);
    const to = at === a ? b : a;
    const next = order[i + 1];
    let end: Join = { kind: 'lane' };
    if (next) {
      const [nq, nk] = next;
      if (nq === q && Math.abs(nk - k) === 1) end = { kind: 'turn', wall: Math.min(k, nk) };
      else if (nq !== q && nk === k) {
        if (!AXES_OF[nq].includes(to)) throw new Error(`labyrinth: ${id} → ${nq}${nk} crosses no shared axis`);
        end = { kind: 'straight' };
      } else if (nq !== q || to !== 'B') throw new Error(`labyrinth: ${id} → ${nq}${nk} is no move`);
    }
    out.push({ q, k, from: at, to, start, end });
    start = end;
    at = to;
  });
  if (seen.size !== 4 * CIRCUITS) throw new Error(`labyrinth: ${seen.size} arcs walked, not ${4 * CIRCUITS}`);
  if (at !== 'B') throw new Error('labyrinth: the path does not end on the entrance axis');
  return out;
}

/** Per axis: the circuits that pass straight through, and the walls whose tongues the path turns round (on either side). */
export function axisTable(list = arcs()): Record<Axis, { straight: Set<number>; turns: Map<Quadrant, Set<number>>; lanes: Map<Quadrant, Set<number>> }> {
  const table = Object.fromEntries((['B', 'L', 'T', 'R'] as Axis[]).map(a => [a, { straight: new Set<number>(), turns: new Map<Quadrant, Set<number>>(), lanes: new Map<Quadrant, Set<number>>() }])) as ReturnType<typeof axisTable>;
  const add = (m: Map<Quadrant, Set<number>>, q: Quadrant, v: number) => { if (!m.has(q)) m.set(q, new Set()); m.get(q)!.add(v); };
  for (const a of list) {
    for (const [axis, join] of [[a.from, a.start], [a.to, a.end]] as const) {
      if (join.kind === 'straight') table[axis].straight.add(a.k);
      else if (join.kind === 'turn') add(table[axis].turns, a.q, join.wall);
      else add(table[axis].lanes, a.q, a.k);
    }
  }
  return table;
}

export interface Plan {
  /** Pitch of a circuit (path and wall) and the radius of the centre. */
  pitch: number;
  centre: number;
  /** Radius of wall j. */
  wall: (j: number) => number;
  /** Wall centrelines, ring arcs and straight runs, as plan polylines. */
  walls: P2[][];
  /** The ring walls as angle spans: wall j stands from angle a0 to a1 (a1 may pass 2π). */
  rings: { j: number; a0: number; a1: number }[];
  /** The walk, from outside the entrance to the middle of the centre: one unbroken polyline. */
  walk: P2[];
  /** Where each circuit's centreline is, by circuit, for placing things on the path. */
  lane: (k: number) => number;
}

/**
 * The labyrinth at a given pitch and centre radius (Chartres: a centre about 3.4 pitches across the
 * radius). Turn tongues stop `tongue` short of their axis, a path's width by default.
 */
export function chartresPlan(pitch: number, centre = 3.44 * pitch, tongue = pitch): Plan {
  const list = arcs();
  const table = axisTable(list);
  const wall = (j: number) => centre + (CIRCUITS - j) * pitch;
  const lane = (k: number) => wall(k) + pitch / 2;
  const half = pitch / 2;
  /** Angle on a circle of radius r where it crosses X = c on the near side. */
  const near = (c: number, r: number) => Math.acos(c / r);
  const arcPts = (r: number, a0: number, a1: number, step = 0.8): P2[] => {
    const nSeg = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / step));
    return Array.from({ length: nSeg + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / nSeg; return { x: r * Math.cos(a), y: r * Math.sin(a) }; });
  };

  // Ring walls: each wall's circle less its gaps, as angle intervals in [0, 2π).
  const walls: P2[][] = [];
  const rings: Plan['rings'] = [];
  for (let j = 0; j <= CIRCUITS; j++) {
    const r = wall(j);
    const gaps: [number, number][] = [];
    const lo = near(pitch, r), mid = Math.PI / 2, hi = near(-pitch, r);
    if (j === 0) gaps.push([mid, hi]);
    else if (j === CIRCUITS) gaps.push([lo, mid]);
    else {
      // The lanes cut every ring between the rim and the centre, except where a lane is closed
      // across: wall 5 ends the entry lane, wall 6 the outward run on the right.
      let g0 = lo, g1 = hi;
      if (j === 5) g1 = mid;
      if (j === 6) g0 = mid;
      // Tongues stop short of the lane walls where the path turns round them.
      if (table.B.turns.get('LL')?.has(j)) g1 = Math.max(g1, hi + tongue / r);
      if (table.B.turns.get('LR')?.has(j)) g0 = Math.min(g0, lo - tongue / r);
      gaps.push([g0, g1]);
      // The quadrants either side of each axis, in increasing angle (the right axis sits at 2π).
      const sides: Record<'L' | 'T' | 'R', [Quadrant, Quadrant]> = { L: ['LL', 'UL'], T: ['UL', 'UR'], R: ['UR', 'LR'] };
      for (const axis of ['L', 'T', 'R'] as const) {
        const a = axis === 'R' ? 2 * Math.PI : AXIS_ANGLE[axis];
        const [before, after] = sides[axis];
        let s0 = a, s1 = a;
        if (table[axis].turns.get(before)?.has(j)) s0 = a - tongue / r;
        if (table[axis].turns.get(after)?.has(j)) s1 = a + tongue / r;
        if (s1 > s0) gaps.push([s0, s1]);
      }
    }
    for (const [a0, a1] of keepIntervals(gaps)) { walls.push(arcPts(r, a0, a1)); rings.push({ j, a0, a1 }); }
  }

  // Straight walls along the axes, closing each axis where the path does not cross it.
  const ray = (a: number, r0: number, r1: number): P2[] => [{ x: r0 * Math.cos(a), y: r0 * Math.sin(a) }, { x: r1 * Math.cos(a), y: r1 * Math.sin(a) }];
  const runs = (ks: number[]): [number, number][] => {
    const out: [number, number][] = [];
    for (const k of ks.sort((a, b) => a - b)) {
      const last = out[out.length - 1];
      if (last && last[1] === k - 1) last[1] = k; else out.push([k, k]);
    }
    return out;
  };
  for (const axis of ['L', 'T', 'R'] as Axis[]) {
    const closed = Array.from({ length: CIRCUITS }, (_, i) => i + 1).filter(k => !table[axis].straight.has(k));
    for (const [k0, k1] of runs(closed)) walls.push(ray(AXIS_ANGLE[axis], wall(k1), wall(k0 - 1)));
  }
  // The entrance axis: a divider between the two lanes, and each lane's outer wall wherever its
  // quadrant's circuits do not open onto it.
  const yAt = (c: number, r: number) => Math.sqrt(r * r - c * c);
  walls.push([{ x: 0, y: wall(CIRCUITS) }, { x: 0, y: wall(0) }]);
  for (const [q, c] of [['LL', -pitch], ['LR', pitch]] as const) {
    const open = table.B.lanes.get(q) ?? new Set<number>();
    const closed = Array.from({ length: CIRCUITS }, (_, i) => i + 1).filter(k => !open.has(k));
    for (const [k0, k1] of runs(closed)) walls.push([{ x: c, y: yAt(c, wall(k1)) }, { x: c, y: yAt(c, wall(k0 - 1)) }]);
  }

  // The walk.
  const walk: P2[] = [];
  const push = (pts: P2[]) => { for (const p of pts) { const last = walk[walk.length - 1]; if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) walk.push(p); } };
  /** The angle where an arc on circuit k meets its join at an axis, seen from quadrant q. */
  const endAngle = (q: Quadrant, k: number, axis: Axis, join: Join): number => {
    const a = axis === 'R' ? (q === 'UR' ? 2 * Math.PI : 0) : AXIS_ANGLE[axis];
    const towardAxis = Math.sign(a - quadrantMid(q));
    if (join.kind === 'straight') return a;
    if (join.kind === 'lane') return near(q === 'LL' ? -half : half, lane(k));
    const r = wall(join.wall);
    if (axis === 'B') return q === 'LL' ? near(-pitch, r) + tongue / r : near(pitch, r) - tongue / r;
    return a - towardAxis * tongue / r;
  };
  push([{ x: -half, y: wall(0) + 1.5 * pitch }]);
  list.forEach((arc, i) => {
    const r = lane(arc.k);
    const a0 = endAngle(arc.q, arc.k, arc.from, arc.start), a1 = endAngle(arc.q, arc.k, arc.to, arc.end);
    push(arcPts(r, a0, a1));
    const next = list[i + 1];
    if (arc.end.kind === 'turn' && next) {
      // Round the tongue's tip: a half circle from this circuit's centreline to the next one's.
      const tip = wall(arc.end.wall);
      const c = { x: tip * Math.cos(a1), y: tip * Math.sin(a1) };
      const radial = { x: Math.cos(a1), y: Math.sin(a1) };
      const axisA = arc.to === 'R' ? (arc.q === 'UR' ? 2 * Math.PI : 0) : AXIS_ANGLE[arc.to];
      const dir = Math.sign(axisA - quadrantMid(arc.q)) || 1;
      const tangent = { x: -Math.sin(a1) * dir, y: Math.cos(a1) * dir };
      const from = arc.k > arc.end.wall ? -1 : 1;
      push(Array.from({ length: 13 }, (_, s) => {
        const psi = Math.PI * s / 12;
        const u = from * Math.cos(psi), v = Math.sin(psi);
        return { x: c.x + half * (u * radial.x + v * tangent.x), y: c.y + half * (u * radial.y + v * tangent.y) };
      }));
    }
  });
  // From the seventh circuit up the right lane into the centre.
  push([{ x: half, y: wall(CIRCUITS) - 0.6 * pitch }, { x: 0, y: 0 }]);
  return { pitch, centre, wall, walls, rings, walk, lane };
}

function quadrantMid(q: Quadrant): number {
  return { LR: Math.PI / 4, LL: 0.75 * Math.PI, UL: 1.25 * Math.PI, UR: 1.75 * Math.PI }[q];
}

/** The parts of [0, 2π) outside the given gaps (each gap may run past 2π). */
function keepIntervals(gaps: [number, number][]): [number, number][] {
  const TAU = 2 * Math.PI;
  const norm: [number, number][] = [];
  for (const [a, b] of gaps) {
    if (b <= a) continue;
    const s = ((a % TAU) + TAU) % TAU, e = s + (b - a);
    if (e > TAU) { norm.push([s, TAU], [0, e - TAU]); } else norm.push([s, e]);
  }
  norm.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const g of norm) { const last = merged[merged.length - 1]; if (last && g[0] <= last[1]) last[1] = Math.max(last[1], g[1]); else merged.push([...g]); }
  const keep: [number, number][] = [];
  let at = 0;
  for (const [a, b] of merged) { if (a > at) keep.push([at, a]); at = Math.max(at, b); }
  if (at < TAU) keep.push([at, TAU]);
  // Join the run that wraps through angle 0.
  if (keep.length > 1 && keep[0][0] === 0 && keep[keep.length - 1][1] === TAU) {
    const first = keep.shift()!;
    keep[keep.length - 1] = [keep[keep.length - 1][0], TAU + first[1]];
  }
  return keep;
}
