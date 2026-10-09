import * as THREE from 'three';
import type { SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh } from '../../../src/projection.ts';
import { helixStrands, strandPoint, strandStrokes } from '../../kit/helix.ts';
import { clamp, smooth } from '../../kit/params.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import type { Stroke } from '../../kit/types.ts';

/**
 * The lovers' strands: one strand of the kit's twin helix from each tower top, each a thin ribbon
 * along its own smooth arc, meeting and winding round each other as the full double helix. Built
 * from the kit's own strand (`helixStrands`, `strandStrokes`, `strandPoint`), one strand of the pair
 * per tower, in its native inks.
 */

/** How finely a strand's spine is sampled, in world units. */
const SPINE_STEP = 0.05;

/**
 * A strand's centre line: a lead-in from a tower top, then the tail the two lead-ins share. Sampled
 * evenly in arc length, with parallel-transport frames carried back from the end of the tail so both
 * strands see the same frame wherever their paths coincide. Without a tail it is the lead-in alone. `scale`
 * builds it larger, to be scaled back.
 */
export class Spine {
  readonly pts: THREE.Vector3[];
  readonly arc: number[];
  readonly tangent: THREE.Vector3[];
  readonly normal: THREE.Vector3[];
  readonly length: number;
  /** Arc length at which the lead-in ends and the shared tail begins. */
  readonly join: number;
  constructor(leadCurve: THREE.Curve<THREE.Vector3>, tailCurve: THREE.Curve<THREE.Vector3> | null, scale: number) {
    const a = leadCurve.getSpacedPoints(Math.ceil(leadCurve.getLength() / SPINE_STEP));
    const b = tailCurve ? tailCurve.getSpacedPoints(Math.ceil(tailCurve.getLength() / SPINE_STEP)) : [a[a.length - 1]];
    this.pts = [...a, ...b.slice(1)].map(p => p.multiplyScalar(scale));
    this.arc = [0];
    for (let i = 1; i < this.pts.length; i++) this.arc.push(this.arc[i - 1] + this.pts[i].distanceTo(this.pts[i - 1]));
    this.length = this.arc[this.arc.length - 1];
    this.join = this.arc[a.length - 1];
    const m = this.pts.length;
    this.tangent = this.pts.map((_, i) => this.pts[Math.min(m - 1, i + 1)].clone().sub(this.pts[Math.max(0, i - 1)]).normalize());
    this.normal = new Array<THREE.Vector3>(m);
    const x = new THREE.Vector3(1, 0, 0);
    this.normal[m - 1] = x.clone().addScaledVector(this.tangent[m - 1], -x.dot(this.tangent[m - 1])).normalize();
    for (let i = m - 2; i >= 0; i--) {
      const q = new THREE.Quaternion().setFromUnitVectors(this.tangent[i + 1], this.tangent[i]);
      const nm = this.normal[i + 1].clone().applyQuaternion(q);
      this.normal[i] = nm.addScaledVector(this.tangent[i], -nm.dot(this.tangent[i])).normalize();
    }
  }
  private index(s: number): [number, number] {
    const target = clamp(s, 0, this.length);
    let lo = 0, hi = this.arc.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (this.arc[mid] <= target) lo = mid; else hi = mid; }
    const span = this.arc[hi] - this.arc[lo];
    return [lo, span > 0 ? (target - this.arc[lo]) / span : 0];
  }
  at(s: number): THREE.Vector3 {
    const [i, t] = this.index(s);
    return this.pts[i].clone().lerp(this.pts[i + 1], t);
  }
  /** The frame at arc length `s`: a normal and a binormal (tangent × normal, as the kit's Frenet frames give). */
  frame(s: number): { normal: THREE.Vector3; binormal: THREE.Vector3 } {
    const [i, t] = this.index(s);
    const tangent = this.tangent[i].clone().lerp(this.tangent[i + 1], t).normalize();
    const nm = this.normal[i].clone().lerp(this.normal[i + 1], t);
    nm.addScaledVector(tangent, -nm.dot(tangent)).normalize();
    return { normal: nm, binormal: new THREE.Vector3().crossVectors(tangent, nm) };
  }
}

export interface Ribbon {
  /** Radius the strands wind at in the full helix, ribbon half-width, and length per turn. */
  radius: number; width: number; pitch: number;
  /** Length over which a strand grows from the roof, and over which the helix opens past the meeting point. */
  open: number; flare: number;
  /** The winding radius along the lead-ins, as a share of the full helix's. */
  slim: number;
}

/**
 * How a strand is wound along a spine: its winding radius as a share of the full helix's at each arc
 * length (nothing from the roof, slim while the strands lean in, opening to the full helix just past the
 * meeting point), and its turn rate, which follows the radius so a slim coil winds tighter and keeps its proportions.
 */
export function winding(spine: Spine, o: Ribbon) {
  const length = spine.length;
  const grow = (s: number) => (0.4 + 0.6 * smooth(0, o.open, s)) * (o.slim + (1 - o.slim) * smooth(spine.join - 0.3 * o.flare, spine.join + o.flare, s));
  const STEPS = 600;
  const turnsTo: number[] = [0];
  for (let i = 1; i <= STEPS; i++) turnsTo.push(turnsTo[i - 1] + 1 / (STEPS * (0.8 + 0.2 * grow((i - 0.5) / STEPS * length))));
  /** Which share of the spine's length has been wound by the time `u` of the strand's turns have been laid. */
  const curveAt = (u: number): number => {
    const want = u * turnsTo[STEPS];
    let lo = 0, hi = STEPS;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (turnsTo[mid] < want) lo = mid; else hi = mid; }
    const span = turnsTo[hi] - turnsTo[lo];
    return (lo + (span > 0 ? (want - turnsTo[lo]) / span : 0)) / STEPS;
  };
  /** Turns wound by the meeting point. */
  const joinTurns = (() => {
    const at = spine.join / length * STEPS, i = Math.min(STEPS - 1, Math.floor(at));
    return length / o.pitch * (turnsTo[i] + (turnsTo[i + 1] - turnsTo[i]) * (at - i));
  })();
  return { grow, curveAt, joinTurns, turns: length / o.pitch * turnsTo[STEPS] };
}

export interface Strand { strokes: Stroke[]; mesh: THREE.BufferGeometry }

/**
 * One strand of the kit's twin helix laid along a spine. Built as `helixAlong` builds a strand (upright
 * in its own space, then bent onto the curve), but only strand `which` is kept, and it is turned by
 * `phaseTurns` so that where the two spines share a tail the two strands sit a half turn apart, as in
 * the full helix. The kit's wiggles are fixed in world units, so everything is built `scale` times
 * larger, seen by a camera moved out to match, and scaled back.
 */
export function strand(ctx: SketchContext, bigView: THREE.Camera, spine: Spine, which: 0 | 1, o: Ribbon, phaseTurns: number, scale: number): Strand {
  const start = spine.pts[0];
  const length = spine.length;
  const template = helixStrands({ ...ctx, params: { ...ctx.params, helixTurns: 1.6, shellTwist: 0.08 } });
  const w = winding(spine, o);
  const st = {
    ...template[which], x: start.x, y: start.y, z: start.z, y0: 0, y1: length,
    radius: o.radius + 0.06 * scale * which, depth: 1, width: o.width - 0.03 * scale * which, swell: 0, centre: -1e3, turns: w.turns,
  };
  st.theta0 += st.hand * 2 * Math.PI * phaseTurns;
  const bend = (p: THREE.Vector3): THREE.Vector3 => {
    const s = w.curveAt(clamp((p.y - start.y) / length, 0, 1)) * length;
    const fr = spine.frame(s);
    const k = w.grow(s);
    return spine.at(s).addScaledVector(fr.normal, (p.x - start.x) * k).addScaledVector(fr.binormal, (p.z - start.z - 0.25) * k);
  };
  // Only the wound part is kept: from the meeting point on, where the two strands wind as one helix. Before it, the
  // strand is a thread along the lead-in, and the lead-in is drawn by `leadStrand` as a ribbon.
  const arcOf = (p: THREE.Vector3) => w.curveAt(clamp((p.y - start.y) / length, 0, 1)) * length;
  const strokes: Stroke[] = [];
  for (const h of strandStrokes(st, 0.8, 0.12, ctx, bigView)) {
    let run: THREE.Vector3[] = [];
    const flush = () => { if (run.length > 1) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: run }); run = []; };
    for (const p of h.points) { if (arcOf(p) >= spine.join) run.push(bend(p).multiplyScalar(1 / scale)); else flush(); }
    flush();
  }
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (w.curveAt(mid) * length < spine.join) lo = mid; else hi = mid; }
  const mesh = buildSurfaceMesh((u, v) => bend(strandPoint(st, u, 2 * v - 1)), {}, Math.ceil(640 * (1 - hi)), 8, [hi, 1]).scale(1 / scale, 1 / scale, 1 / scale);
  return { strokes, mesh };
}

/**
 * The roll about its arc that shows the eye the most of a lead ribbon's width: the ribbon's width lies along
 * -sin θ × normal + cos θ × binormal, and this is the θ (of 24) whose narrowest view along the arc is widest. Seen by
 * `bigView`, the world camera in tabloid's frame moved out `scale` times as the spine was built, so every size and fit
 * rolls the ribbon as the print does.
 */
export function leadRoll(bigView: THREE.Camera, spine: Spine, scale: number): number {
  const length = spine.length;
  const aspect = TABLOID_PAGE.width / TABLOID_PAGE.height;
  const seen = (theta: number) => {
    let least = Infinity;
    for (let i = 1; i < 12; i++) {
      const s = length * i / 12, fr = spine.frame(s);
      const wv = fr.normal.clone().multiplyScalar(-Math.sin(theta)).addScaledVector(fr.binormal, Math.cos(theta)).multiplyScalar(0.1 * scale);
      const at = (q: THREE.Vector3) => { const r = q.clone().project(bigView); return { x: r.x * aspect, y: r.y }; };
      const c = spine.at(s), a = at(c.clone().add(wv)), b = at(c.clone().sub(wv)), t0 = at(spine.at(s - 0.01 * length)), t1 = at(spine.at(s + 0.01 * length));
      const tx = t1.x - t0.x, ty = t1.y - t0.y;
      least = Math.min(least, Math.abs((b.x - a.x) * ty - (b.y - a.y) * tx) / (Math.hypot(tx, ty) || 1));
    }
    return least;
  };
  let theta = 0, best = -1;
  for (let i = 0; i < 24; i++) { const th = i / 24 * Math.PI * 2, v = seen(th); if (v > best) { best = v; theta = th; } }
  return theta;
}

/**
 * The lead-in of one lover: a thin flat ribbon along its own smooth arc, from the tower top to the meeting
 * point, in the strand's native inks. It is the same strand of the kit's twin helix, laid on the arc
 * unwound (no turns) with no radius, so it keeps its width and does not coil. It narrows at both ends, and
 * is turned about the arc by `roll` (`leadRoll`) to show the most of its width to the eye.
 */
export function leadStrand(ctx: SketchContext, bigView: THREE.Camera, spine: Spine, which: 0 | 1, width: number, scale: number, roll: number): Strand {
  const start = spine.pts[0];
  const length = spine.length;
  const template = helixStrands({ ...ctx, params: { ...ctx.params, helixTurns: 1.6, shellTwist: 0.08 } });
  const base = { ...template[which], x: start.x, y: start.y, z: start.z, y0: 0, y1: length, radius: 0, depth: 1, width, swell: 0, centre: -1e3, turns: 0.001 };
  const st = { ...base, theta0: roll };
  const bend = (p: THREE.Vector3): THREE.Vector3 => {
    const s = clamp((p.y - start.y) / length, 0, 1) * length;
    const fr = spine.frame(s);
    return spine.at(s).addScaledVector(fr.normal, p.x - start.x).addScaledVector(fr.binormal, p.z - start.z - 0.25);
  };
  const strokes: Stroke[] = strandStrokes(st, 0.8, 0.12, ctx, bigView).map(h => ({ ink: h.ink, group: 'helix', family: 'membrane' as const, points: h.points.map(p => bend(p).multiplyScalar(1 / scale)) }));
  const mesh = buildSurfaceMesh((u, v) => bend(strandPoint(st, u, 2 * v - 1)), {}, 320, 8).scale(1 / scale, 1 / scale, 1 / scale);
  return { strokes, mesh };
}
