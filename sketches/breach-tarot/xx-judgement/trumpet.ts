import * as THREE from 'three';
import type { SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh } from '../../../src/projection.ts';
import { helixStrands, strandPoint, type HelixStroke, type Strand } from '../../kit/helix.ts';
import { clamp, n } from '../../kit/params.ts';
import { atPage } from '../../kit/perspective.ts';
import { densityPitch } from '../../kit/slabs.ts';
import type { Ink } from '../../kit/types.ts';
import { CARD } from '../card.ts';

/**
 * The trumpet: the helix comes in from near the top-left corner as a thin cord and flares as it comes
 * down toward the plain, opening into a bell over it. Built `S` times the size and brought back (the
 * kit's wiggles are fixed in world units), laid past the bell's mouth and cut square there so the
 * mouth is a clean ring, and started far outside the sheet so the kit's pinched ends never show.
 *
 * The kit's helix spaces its laminations by how the straight, unbent strand looks to the camera, which
 * means nothing for a ribbon that is ten times wider at the mouth than at the throat. Here the spacing
 * is measured on the bent ribbon as it lands on the sheet, so the bell is as finely laminated as the cord.
 */
const S = 3;
const BARS = 16;
const SUB = 6;

export interface Trumpet {
  strokes: HelixStroke[];
  meshes: THREE.BufferGeometry[];
  /** The axis, in world units, from the thin end to the mouth. */
  curve: THREE.CatmullRomCurve3;
  /** Arc-length fraction of the whole curve at which the mouth is cut. */
  mouthU: number;
  /** The helix's outer radius (all strands) at arc-length fraction u. */
  radiusAt: (u: number) => number;
  mouth: { centre: THREE.Vector3; axis: THREE.Vector3; radius: number };
}

/**
 * Page positions (mm) and distances along the eye's ray for the axis: in from the top-left corner, a
 * long easy curve, then hooking down so the mouth faces the plain. The last two points run on past the mouth.
 */
function controls(ctx: SketchContext): { page: { x: number; y: number }; dist: number }[] {
  const mx = n(ctx, 'mouthX', 178, 120, 250), my = n(ctx, 'mouthY', 172, 100, 230), md = n(ctx, 'mouthDist', 230, 100, 260);
  const sx = n(ctx, 'enterX', 34, 18, 120);
  const out: { page: { x: number; y: number }; dist: number }[] = [
    { page: { x: sx - 30, y: CARD.y0 - 70 }, dist: 400 },
    { page: { x: sx - 14, y: CARD.y0 - 28 }, dist: 380 },
    { page: { x: sx, y: CARD.y0 }, dist: 362 },
  ];
  // A cubic from the top edge to the mouth: heading right and down at first, hooking to straight down at the mouth.
  const hook = n(ctx, 'hook', 0.8, 0, 1);
  const dx = mx - sx, dy = my - CARD.y0;
  const p1 = { x: sx + dx * 0.55, y: CARD.y0 + dy * 0.12 }, p2 = { x: mx - dx * (0.3 - 0.4 * hook), y: my - dy * (0.2 + 0.4 * hook) };
  const bez = (t: number, a: number, b: number, c: number, d: number) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
  // Nearer as it comes down, but less so toward the end, so the mouth looks down and a little at us.
  const near = [[0, 1], [0.14, 0.93], [0.28, 0.8], [0.42, 0.64], [0.56, 0.46], [0.7, 0.3], [0.82, 0.17], [0.92, 0.07], [1, 0]] as const;
  for (const [t, g] of near.slice(1)) {
    out.push({ page: { x: bez(t, sx, p1.x, p2.x, mx), y: bez(t, CARD.y0, p1.y, p2.y, my) }, dist: md + (362 - md) * g });
  }
  // Past the mouth: carry on the same way.
  const last = out[out.length - 1], prev = out[out.length - 2];
  for (const k of [1, 2]) {
    out.push({ page: { x: last.page.x + (last.page.x - prev.page.x) * 0.9 * k, y: last.page.y + (last.page.y - prev.page.y) * 0.9 * k }, dist: last.dist + (last.dist - prev.dist) * 0.9 * k });
  }
  return out;
}

function cutAt(points: THREE.Vector3[], centre: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3[][] {
  const side = (p: THREE.Vector3) => p.clone().sub(centre).dot(axis);
  const runs: THREE.Vector3[][] = [];
  let run: THREE.Vector3[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i], sp = side(p);
    if (sp <= 0) { run.push(p); continue; }
    if (i > 0 && side(points[i - 1]) <= 0) {
      const a = points[i - 1], sa = side(a);
      run.push(a.clone().lerp(p, sa / (sa - sp)));
    }
    if (run.length > 1) runs.push(run);
    run = [];
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * One strand's strokes, laid on the curve: its two edges, laminations spaced `minMm` or more apart on
 * the sheet (thinned by powers of two where the ribbon narrows, so surviving lines stay continuous),
 * cross ribs and leading-edge pulses, as the kit lays them.
 */
function strandStrokes(ctx: SketchContext, s: Strand, bend: (p: THREE.Vector3) => THREE.Vector3, view: THREE.Camera, density: number, minMm: number, tMax: number): HelixStroke[] {
  const out: HelixStroke[] = [];
  const group: HelixStroke['group'] = s.id === 'a' ? 'strand-a' : 'strand-b';
  const rng = ctx.random(`horn-${s.id}`);
  const at = (t: number, v: number) => {
    const q = bend(strandPoint(s, t, v)).project(view);
    return { x: q.x * 139.7, y: q.y * 215.9 };
  };
  const trace = (ink: Ink, count: number, fn: (t: number) => THREE.Vector3): HelixStroke => ({ ink, group, points: Array.from({ length: count + 1 }, (_, i) => bend(fn(i / count))) });
  for (const v of [-1, 1]) out.push(trace('vermilion', 1200, t => strandPoint(s, t * tMax, v)));
  // Lines across the ribbon: enough that its widest stretch holds them `minMm` apart.
  let widest = 0;
  for (let i = 0; i <= 60; i++) { const a = at(i / 60, -1), b = at(i / 60, 1); widest = Math.max(widest, Math.hypot(a.x - b.x, a.y - b.y)); }
  const contours = clamp(Math.round(widest * 0.975 / minMm), 8, 400);
  const stride = (start: number, end: number) => {
    let spacing = Infinity;
    for (let i = 0; i <= 6; i++) {
      const t = start + (end - start) * i / 6;
      const a = at(t, -1), b = at(t, 1);
      const t0 = at(Math.max(0, t - 0.002), 0), t1 = at(Math.min(1, t + 0.002), 0);
      const tx = t1.x - t0.x, ty = t1.y - t0.y, tl = Math.hypot(tx, ty) || 1;
      const perp = Math.abs(((b.x - a.x) * ty - (b.y - a.y) * tx) / tl);
      spacing = Math.min(spacing, perp * (1.95 / contours) / 2);
    }
    let k = 1;
    while (spacing * k < minMm && k < 64) k *= 2;
    return k;
  };
  for (let bar = 0; bar < BARS; bar++) {
    const start = bar / BARS + 0.0015, end = (bar + 1) / BARS - 0.0015;
    if (start >= tMax) break;
    const strides = Array.from({ length: SUB }, (_, q) => stride(start + (end - start) * q / SUB, start + (end - start) * (q + 1) / SUB));
    for (let j = 0; j < contours; j++) {
      if (bar % 2 === 1 && j % 17 === 0) continue;
      const v = -0.975 + 1.95 * (j + 0.5) / contours;
      const ink: Ink = j % 13 === 0 ? 'vermilion' : s.id === 'a' ? (j % 4 === 0 ? 'violet' : 'ultramarine') : 'violet';
      let q = 0;
      while (q < SUB) {
        const keep = (k: number) => j % k === 0;
        if (!keep(strides[q])) { q++; continue; }
        let r = q;
        while (r + 1 < SUB && keep(strides[r + 1])) r++;
        const a0 = start + (end - start) * q / SUB, a1 = Math.min(tMax, start + (end - start) * (r + 1) / SUB);
        if (a0 >= tMax) { q = r + 1; continue; }
        out.push(trace(ink, 12 * (r - q + 1), t => strandPoint(s, a0 + (a1 - a0) * t, v)));
        q = r + 1;
      }
    }
  }
  if (s.id === 'a') out.push(trace('acid', 1200, t => strandPoint(s, t * tMax, 0)));
  const ribs = Math.round(densityPitch(density, 40, 120, 170));
  let last: { x: number; y: number } | null = null;
  for (let i = 0; i <= ribs; i++) {
    const u = i / ribs;
    if (u > tMax) break;
    if (rng() < 0.1 * (Math.floor(i / 8) % 2 ? 1.0 : 0.42)) continue;
    const here = at(u, 0);
    // Across a ribbon that wide a rib is a stray chord: ribs belong to the cord.
    const a = at(u, -1), b = at(u, 1);
    if (Math.hypot(a.x - b.x, a.y - b.y) > 14) continue;
    if (last && Math.hypot(here.x - last.x, here.y - last.y) < 1.6) continue;
    last = here;
    const ink: Ink = s.id === 'a'
      ? (i % 8 === 0 ? 'acid' : i % 3 === 0 ? 'violet' : i % 4 === 0 ? 'vermilion' : 'ultramarine')
      : (i % 8 === 0 ? 'vermilion' : i % 3 === 0 ? 'ultramarine' : 'violet');
    out.push(trace(ink, 14, t => strandPoint(s, u, -0.96 + t * 1.92)));
  }
  return out;
}

export function trumpet(ctx: SketchContext, view: THREE.PerspectiveCamera): Trumpet {
  const pts = controls(ctx).map(c => atPage(view, c.page, c.dist));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const mouthPoint = pts[pts.length - 3];
  // The mouth sits at the arc length nearest the control point that names it.
  let mouthU = 0.8, best = Infinity;
  for (let i = 0; i <= 800; i++) {
    const d = curve.getPointAt(i / 800).distanceToSquared(mouthPoint);
    if (d < best) { best = d; mouthU = i / 800; }
  }
  const flare = n(ctx, 'flare', 2.6, 1, 6), bell = n(ctx, 'bell', 13, 2, 20), growth = n(ctx, 'growth', 0.1, 0, 1);
  const r0 = n(ctx, 'thread', 2.2, 0.8, 5);
  const pitch = n(ctx, 'pitch', 11, 4, 60);
  const sv = view.clone();
  sv.position.multiplyScalar(S); sv.near *= S; sv.far *= S;
  sv.updateProjectionMatrix(); sv.updateMatrixWorld(true);
  const big = new THREE.CatmullRomCurve3(pts.map(p => p.clone().multiplyScalar(S)), false, 'centripetal');
  const start = big.getPointAt(0), length = big.getLength();
  const frames = big.computeFrenetFrames(400, false);
  const STEPS = 400;
  // A horn's profile: it widens slowly along the tube, then flares fast over the last stretch to the mouth,
  // easing a little at the lip so the last turn does not open out into a tail.
  const width = (s: number) => { const x = Math.min(1, Math.max(0, s) / mouthU); return 1 + (bell - 1) * x ** flare * (1.5 - 0.5 * x ** 3); };
  // The strands are built with uniform turns; u is sent to the curve fraction where the turns so far,
  // at a pitch growing with the width (to the power `growth`), reach that share of the whole.
  const turnsTo: number[] = [0];
  for (let i = 1; i <= STEPS; i++) turnsTo.push(turnsTo[i - 1] + 1 / (STEPS * width((i - 0.5) / STEPS) ** growth));
  const curveAt = (u: number): number => {
    const want = u * turnsTo[STEPS];
    let lo = 0, hi = STEPS;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (turnsTo[mid] < want) lo = mid; else hi = mid; }
    const span = turnsTo[hi] - turnsTo[lo];
    return (lo + (span > 0 ? (want - turnsTo[lo]) / span : 0)) / STEPS;
  };
  // The strands run only as far as the mouth (a hair past it, for the square cut): strands laid on the
  // extension beyond it curl back across the cutting plane and leave stray arcs.
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (curveAt(mid) < mouthU) lo = mid; else hi = mid; }
  const tMax = Math.min(1, hi + 0.004);
  const template = helixStrands({ ...ctx, params: { ...ctx.params, helixTurns: 1.6, shellTwist: 0.2 } });
  const strands: Strand[] = template.map((st, i) => ({
    ...st, x: start.x, y: start.y, z: start.z, y0: 0, y1: length, radius: r0 * S * (1 + 0.35 * i), depth: 1, width: r0 * 0.9 * S - 0.1 * i,
    swell: 0, centre: -1e3, turns: length / (pitch * S) * turnsTo[STEPS],
  }));
  const bend = (p: THREE.Vector3): THREE.Vector3 => {
    const u = clamp((p.y - start.y) / length, 0, 1);
    const s = curveAt(u), scale = width(s);
    const k = Math.min(STEPS, Math.round(s * STEPS));
    return big.getPointAt(s).addScaledVector(frames.normals[k], (p.x - start.x) * scale).addScaledVector(frames.binormals[k], (p.z - start.z - 0.25) * scale);
  };
  const centre = big.getPointAt(mouthU), axis = big.getTangentAt(mouthU).normalize();
  const strokes: HelixStroke[] = [];
  const minMm = n(ctx, 'laminaeMm', 1.1, 0.55, 4), density = n(ctx, 'ribs', 0.35, 0, 1);
  for (const st of strands) for (const h of strandStrokes(ctx, st, bend, sv, density, minMm, tMax)) {
    for (const run of cutAt(h.points, centre, axis)) strokes.push({ ...h, points: run.map(p => p.clone().multiplyScalar(1 / S)) });
  }
  const meshes = strands.map(st => {
    const g = buildSurfaceMesh((u, v) => bend(strandPoint(st, u * tMax, 2 * v - 1)), {}, 480, 8);
    const pos = g.getAttribute('position'), index = g.getIndex()!;
    const kept: number[] = [];
    const vv = new THREE.Vector3();
    const inside = (k: number) => vv.fromBufferAttribute(pos, k).sub(centre).dot(axis) <= 0;
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
      if (inside(a) && inside(b) && inside(c)) kept.push(a, b, c);
    }
    g.setIndex(kept);
    g.scale(1 / S, 1 / S, 1 / S);
    g.computeBoundingSphere();
    return g;
  });
  const radiusAt = (u: number) => r0 * 1.45 * width(u);
  return { strokes, meshes, curve, mouthU, radiusAt, mouth: { centre: centre.clone().multiplyScalar(1 / S), axis, radius: radiusAt(mouthU) } };
}
