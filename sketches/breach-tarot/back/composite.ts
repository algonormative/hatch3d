import * as THREE from 'three';
import type { Point, SketchContext } from '../../../src/sketch/types.ts';
import { CARD, FRAME, MIN_SPACING } from '../../kit/format.ts';
import { densify, insideRing, segDist } from '../../kit/page.ts';
import { clamp, n, smooth } from '../../kit/params.ts';
import { facetStrokes } from '../../kit/slabs.ts';
import type { Ink } from '../../kit/types.ts';
import type { HalfBack } from './geometry.ts';
import { box, faceOnPage, faceSeen, faces, FLOOR, hidden, obliqueView, seenEdges, visibleRuns } from './solids.ts';

/**
 * The `composite` back: every element of the deck in one emblem, the same either way up.
 *
 *   - **The labyrinth** is a through-labyrinth, the walk in at the head and out at the foot: concentric walls in carbon
 *     with a wall on the axis at head and foot, each circuit walked down one side and back up the next, so the walk
 *     from the head fills the right-hand half and its turn, from the foot, the left. Its walls grow heavier toward the
 *     heart, a line more every other ring: **value as line density**, darkest at the centre.
 *   - **The helix** walks it, in its native inks (strand a's acid spine and strand b's vermilion line, rungs in
 *     ultramarine and violet by turns), from the gate at the head to the heart, and, turned, from the heart out to the
 *     foot: the walk in is the walk out.
 *   - **The heart** is ruled dark, carbon and ultramarine by turns, round **a flat mark**: the Star's eight points,
 *     knocked out of it in paper.
 *   - **The gates**, at head and foot, are **slab architecture hatched by light** (the kit's `facetStrokes`, in an
 *     architect's oblique, lit from in front so the fronts stay paper and the undersides and flanks take the hatch):
 *     courses of slab stepping out from the card's end toward the labyrinth, so gates and labyrinth make one lozenge.
 *     The helix comes down through a breach in the first and last course and passes behind the one between. Where a
 *     mark passes behind another, it stops short with paper round the one in front: **the knockout**, everywhere.
 *
 * It is drawn as its top half (the head's gate, the right-hand walk, the upper heart) and turned.
 */

type P = Point;
const add = (a: P, b: P, k = 1): P => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

/** Points along a page polyline no more than `step` apart (the kit's `densify`). */
const resample = (path: P[], step: number): P[] => densify(path, step);

/** A path's corners rounded: a moving average `window` samples either side, the ends held, `passes` times. */
function rounded(path: P[], window: number, passes: number): P[] {
  let pts = path;
  for (let pass = 0; pass < passes; pass++) {
    pts = pts.map((p, i) => {
      const k = Math.min(window, i, pts.length - 1 - i);
      if (k === 0) return p;
      let x = 0, y = 0;
      for (let j = i - k; j <= i + k; j++) { x += pts[j].x; y += pts[j].y; }
      return { x: x / (2 * k + 1), y: y / (2 * k + 1) };
    });
  }
  return pts;
}

/**
 * The distance from `p` to a finely sampled path, looking only at the samples within `limit` (plus a millimetre) of it:
 * Infinity when none is that near.
 */
function nearest(path: P[], p: P, limit: number): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (Math.abs(a.x - p.x) > limit + 1 && Math.abs(b.x - p.x) > limit + 1) continue;
    if (Math.abs(a.y - p.y) > limit + 1 && Math.abs(b.y - p.y) > limit + 1) continue;
    best = Math.min(best, segDist(p, a, b));
  }
  return best;
}

/** Runs of a page path whose points a test keeps, the path first resampled `step` apart. */
function kept(path: P[], keep: (p: P) => boolean, step = 0.1): P[][] {
  const out: P[][] = [];
  let run: P[] = [];
  for (const p of resample(path, step)) {
    if (keep(p)) run.push(p);
    else { if (run.length > 1) out.push(run); run = []; }
  }
  if (run.length > 1) out.push(run);
  return out;
}

export function composite(ctx: SketchContext, half: HalfBack): void {
  const c: P = { x: (CARD.x0 + CARD.x1) / 2, y: (CARD.top + CARD.bottom) / 2 };
  const turn = (p: P): P => ({ x: 2 * c.x - p.x, y: 2 * c.y - p.y });
  const cw = CARD.x1 - CARD.x0;
  const gap = MIN_SPACING;

  // ---- The labyrinth's plan.
  const inset = FRAME.rule + Math.max(2 * MIN_SPACING, 0.04 * cw);
  const R0 = Math.min(n(ctx, 'mazeSize', 0.43, 0.3, 0.47) * cw, cw / 2 - inset);
  const circuits = Math.round(n(ctx, 'circuits', 4, 3, 6));
  const Rh = 0.3 * R0;
  const step = (R0 - Rh) / circuits;
  const ring = (k: number) => R0 - k * step;
  // The walk's straight runs (in at the mouth, across each ring, into the heart) keep this far right of the axis.
  const dx = 0.5 * step;
  const gapHalf = Math.min(0.36 * step, dx - Math.max(gap, 0.12 * step));
  const mid = (j: number) => ring(j - 1) - step / 2;

  // ---- The heart's star: eight points, long and short by turns, the long ones on the axes.
  const starR = 0.8 * Rh;
  const tip = (k: number): P => { const a = -Math.PI / 2 + k * Math.PI / 4, r = k % 2 ? 0.55 * starR : starR; return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }; };
  const valley = (k: number): P => { const a = -Math.PI / 2 + (k + 0.5) * Math.PI / 4, r = 0.2 * starR; return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }; };
  const star: P[] = [];
  for (let k = 0; k < 8; k++) star.push(tip(k), valley(k));
  const nearStar = (p: P, by: number) => insideRing(star, p) || nearest([...star, star[0]], p, by) < by;

  // ---- The walk, from the head to the heart: down to the mouth, round each circuit's right half, in through each ring.
  const head = CARD.top + FRAME.rule + 2 * gap;
  const walkPts: P[] = [{ x: c.x + dx, y: head }];
  for (let j = 1; j <= circuits; j++) {
    const r = mid(j), a = Math.acos(dx / r);
    const down = j % 2 === 1;
    const arc = Array.from({ length: 121 }, (_, i) => {
      const t = down ? -a + (2 * a) * i / 120 : a - (2 * a) * i / 120;
      return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) };
    });
    walkPts.push(...arc);
  }
  // Into the heart, to the star's halo on the line of the walk's last straight run.
  const enterTop = circuits % 2 === 0;
  const stopAt = starR + 2.2 * gap;
  walkPts.push({ x: c.x + dx, y: c.y + (enterTop ? -1 : 1) * Math.sqrt(Math.max(0, stopAt * stopAt - dx * dx)) });
  const walk = rounded(resample(walkPts, 0.15), 8, 2);
  const walkTurned = walk.map(turn);

  // The thread's measures.
  const amp = Math.min(0.18 * step, 0.85), period = Math.max(3.4 * amp + 1.4, 2.8);
  const band = amp + gap;

  // ---- The gate: courses of slab stepping out from the head toward the labyrinth, so the gates and the labyrinth
  // between them make one lozenge. The thread comes down through a breach in every other course and passes behind the
  // ones between. World x and y are page millimetres from the card's centre; z comes toward the eye.
  const view = obliqueView(-0.42, -0.5);
  const top = head - c.y + 1.5 * gap, bottom = -R0 - 2.5 * gap;
  const zone = bottom - top;
  const courses = 3;
  const course = Math.min(0.16 * zone, 0.065 * cw), deep = 1.1 * course;
  const widest = Math.min(0.78 * cw, cw - 2 * inset - 2);
  const breach = band + 2.5 * gap;
  const slabs: ReturnType<typeof box>[] = [];
  for (let i = 0; i < courses; i++) {
    const f = i / (courses - 1);
    const w = widest * (0.4 + 0.6 * f), y = top + course / 2 + f * (zone - course - 3 * gap);
    if (i % 2 === 0) {
      // Broken by the breach round the thread's line.
      slabs.push(box((-w / 2 + dx - breach) / 2, y, 0, dx - breach + w / 2, course, deep, 0.9));
      slabs.push(box((dx + breach + w / 2) / 2, y, 0, w / 2 - dx - breach, course, deep, 0.9));
    } else slabs.push(box(0, y, 2.5, w, course, deep, 1));
  }
  const thread = (p: P) => new THREE.Vector3(p.x - c.x, p.y - c.y, 0);
  const light = new THREE.Vector3(-0.3, 0.55, 0.78).normalize();
  const pad = 1.2 * gap;
  // The thread's band, either way up: marks behind it give way.
  const nearThread = (p: P) => nearest(walk, p, band + gap) < band + gap || nearest(walkTurned, p, band + gap) < band + gap;

  for (const s of slabs) {
    const keep = (w: THREE.Vector3) => !hidden(slabs, view, w, pad, s);
    for (const edge of seenEdges(s, view)) for (const run of visibleRuns(edge, view, keep, 0.1)) half.add('gate', 'carbon', run);
    for (const [fi, face] of faces(s).entries()) {
      if (!faceSeen(view, face)) continue;
      const size = faceOnPage(view, face);
      // A face too narrow to hold a ring and a field reads as a speck of hatch: its outline carries it.
      if (size.width < 2 * FLOOR.feature) continue;
      // Held on paper: the facet hatch's floor (0.072 world units at pitch 1) at the pen floor, on the face's tighter axis.
      const pitch = MIN_SPACING / 0.072 / Math.min(size.su, size.sv);
      const eye = face.centre.clone().addScaledVector(view.toward(face.centre), 1e5);
      for (const stroke of facetStrokes(s, light, eye, false, pitch)) {
        if (stroke.family !== 'hatch' || stroke.face !== fi) continue;
        for (const run of visibleRuns(stroke.points, view, keep, 0.1)) half.add('gate', stroke.ink, run);
      }
    }
  }
  // Where the thread passes behind a slab, it is hidden, with paper round the slab.
  const threadKeep = (p: P) => !hidden(slabs, view, thread(p), pad);

  // ---- The walls: each ring's right half, broken where the walk crosses it, heavier toward the heart.
  const lines = (k: number) => 1 + Math.floor(k / 2), wallPitch = 1.2 * gap;
  for (let k = 0; k <= circuits; k++) {
    const r = ring(k), atTop = k % 2 === 0;
    for (let l = 0; l < lines(k); l++) {
      const rr = r + (l - (lines(k) - 1) / 2) * wallPitch;
      const pts = Array.from({ length: 361 }, (_, i) => { const t = -Math.PI / 2 + Math.PI * i / 360; return { x: c.x + rr * Math.cos(t), y: c.y + rr * Math.sin(t) }; });
      const open = (p: P) => Math.abs(p.x - (c.x + dx)) < gapHalf && (atTop ? p.y < c.y : p.y > c.y);
      for (const run of kept(pts, p => !open(p))) half.add('labyrinth', 'carbon', run);
    }
  }
  // The wall on the axis, from the rim to the heart.
  half.add('labyrinth', 'carbon', [{ x: c.x, y: c.y - R0 }, { x: c.x, y: c.y - Rh }]);

  // ---- The heart, ruled dark round the star, the walk either way up given room.
  const rule = 1.25 * gap, field = Rh - (lines(circuits) - 1) / 2 * wallPitch - 1.6 * gap;
  for (let k = 0; (k + 0.5) * rule < field; k++) {
    const y = c.y - (k + 0.5) * rule, w = Math.sqrt(field ** 2 - (y - c.y) ** 2);
    if (!(w > 0)) continue;
    const ink: Ink = k % 3 === 2 ? 'ultramarine' : 'carbon';
    for (const run of kept([{ x: c.x - w, y }, { x: c.x + w, y }], p => !nearStar(p, 1.6 * gap) && !nearThread(p), 0.08)) half.add('heart', ink, run);
  }
  // The star: its outline from the valley before the top point round to the valley before the bottom one, and its ridges.
  half.add('star', 'carbon', [valley(7), ...[0, 1, 2, 3].flatMap(k => [tip(k), valley(k)])]);
  for (let k = 0; k < 4; k++) {
    const t = tip(k), a = -Math.PI / 2 + k * Math.PI / 4, r0 = 0.12 * starR;
    half.add('star', 'acid', [{ x: c.x + r0 * Math.cos(a), y: c.y + r0 * Math.sin(a) }, add(t, { x: c.x - t.x, y: c.y - t.y }, 0.12)]);
  }

  // ---- The thread along the walk.
  threadAlong(half, walk, {
    amp: (s, total) => amp * smooth(0, 3 * period, s) * clamp((total - s) / (2.5 * period), 0, 1) ** 0.7,
    period, gap,
    keep: threadKeep,
  });
}

interface AlongSpec {
  amp: (s: number, total: number) => number;
  period: number;
  gap: number;
  keep: (p: P) => boolean;
}

/**
 * A thin twin helix along a page path, as the deck draws a narrow one: strand a's acid spine and strand b's vermilion
 * line winding round it, the strand behind giving way where they cross, rungs at the broad of each half turn in
 * ultramarine and violet by turns.
 */
function threadAlong(half: HalfBack, path: P[], spec: AlongSpec): void {
  const pts = resample(path, 0.06);
  const s: number[] = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + dist(pts[i - 1], pts[i]));
  const total = s[s.length - 1];
  const normal = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
    const l = dist(a, b) || 1;
    return { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
  });
  const at = (strand: number, i: number) => {
    const ph = 2 * Math.PI * s[i] / spec.period, sign = strand === 0 ? 1 : -1;
    const off = sign * spec.amp(s[i], total) * Math.sin(ph);
    return { p: add(pts[i], normal[i], off), z: sign * Math.cos(ph), off };
  };
  for (let strand = 0; strand < 2; strand++) {
    const run: P[][] = [];
    let cur: P[] = [];
    for (let i = 0; i < pts.length; i++) {
      const me = at(strand, i), other = at(1 - strand, i);
      const behind = me.z < other.z && Math.abs(me.off - other.off) < spec.gap;
      if (!behind && spec.keep(me.p)) cur.push(me.p);
      else { if (cur.length > 1) run.push(cur); cur = []; }
    }
    if (cur.length > 1) run.push(cur);
    for (const r of run) half.add('thread', strand === 0 ? 'acid' : 'vermilion', r);
  }
  // Rungs at the broad of each half turn.
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    const want = (m + 0.5) * spec.period / 2;
    if (s[i] < want) continue;
    m++;
    const a = at(0, i), b = at(1, i);
    const spanW = Math.abs(a.off - b.off);
    if (spanW < 2 * spec.gap + 0.4 * MIN_SPACING) continue;
    const nrm = normal[i], back = 0.7 * spec.gap * Math.sign(b.off - a.off);
    const ends = [add(a.p, nrm, back), add(b.p, nrm, -back)];
    if (ends.every(spec.keep)) half.add('thread', m % 2 ? 'violet' : 'ultramarine', ends);
  }
}
