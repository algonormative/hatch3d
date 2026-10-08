import * as THREE from 'three';
import type { SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh } from '../../../src/projection.ts';
import { helixStrands, strandPoint, strandStrokes, type HelixStroke, type Strand } from '../../kit/helix.ts';
import { clamp } from '../../kit/params.ts';

/**
 * The twin helix with a path of its own for each strand. The two strands ride the same arc through
 * the middle, but at each end they part: one goes into the vessel's mouth (hidden behind its near
 * wall) and the other spills over the rim and hangs. Built as the kit's `helixAlong` builds a
 * helix (the kit's strands, bent onto a curve), with the workarounds the Chariot found:
 *  - the kit pinches a strand's ends, so each strand is laid on a curve that runs on past both
 *    ends (straight on) and only the middle stretch of its run is kept;
 *  - the kit opens every third bar of laminations (a rest): the run is placed so that the kept
 *    stretch lies between two rests, and the rest-free centre is set on the bar between them;
 *  - the kit spaces laminations by how the upright strand looks to the camera it is given, which
 *    means nothing once it is bent, so it is given a stand-in camera.
 * Strands are built `S` times the size and brought back, because the kit's wiggles are fixed in
 * world units. Width and pitch both follow `scaleAt`, so the helix keeps its proportions as it
 * swings from far to near.
 */
export interface StrandPlan {
  /** Which of the template's two strands this is (0 is the one with the acid centre line). */
  index: 0 | 1;
  /** Its centre line from start to end, in world units. */
  points: THREE.Vector3[];
  /** Index of the point both strands pass through: their phases are matched there. */
  ref: number;
  /** Narrow the ribbon to a thread over the last stretch at the start / the end. */
  tipStart: boolean;
  tipEnd: boolean;
}

export interface TwinSpec {
  radius: number; width: number; pitch: number; spread: number; narrow: number;
  twist: number; density: number;
  /** How much larger than at the near end the helix is at a world point (width and pitch together). */
  scaleAt: (p: THREE.Vector3) => number;
  /** Length of a narrowing tip, world units at scale 1. */
  tip: number;
  /** How wide the stand-in camera sees the ribbon, in page millimetres: wider means denser laminations. */
  lamination: number;
  S: number;
}

const STEPS = 600;
/** The share of the strand's run kept: between the rests that fall on bars 4 and 10 of the kit's 16. */
const KEEP_FROM = 0.32, KEEP_TO = 0.615;

const polylineLength = (pts: THREE.Vector3[]) => pts.reduce((a, p, i) => a + (i ? p.distanceTo(pts[i - 1]) : 0), 0);

export function twinHelix(ctx: SketchContext, view: THREE.PerspectiveCamera, plans: StrandPlan[], o: TwinSpec): { strokes: HelixStroke[]; meshes: THREE.BufferGeometry[] } {
  const S = o.S;
  const sv = view.clone();
  sv.position.multiplyScalar(S); sv.near *= S; sv.far *= S;
  sv.updateProjectionMatrix(); sv.updateMatrixWorld(true);
  const template = helixStrands({ ...ctx, params: { ...ctx.params, helixTurns: 1.6, shellTwist: o.twist } });
  const strokes: HelixStroke[] = [];
  const meshes: THREE.BufferGeometry[] = [];
  const f = 215.9 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));

  for (const plan of plans) {
    const core = plan.points.map(p => p.clone().multiplyScalar(S));
    const last = core.length - 1;
    const coreLength = polylineLength(core);
    const away0 = core[0].clone().sub(core[1]).normalize();
    const away1 = core[last].clone().sub(core[last - 1]).normalize();
    const nearest = (samples: THREE.Vector3[], p: THREE.Vector3) => {
      let best = 0, bd = Infinity;
      samples.forEach((q, i) => { const d = q.distanceToSquared(p); if (d < bd) { bd = d; best = i; } });
      return best;
    };

    // Lay the run on a curve that carries on straight past both ends, and lengthen those tails
    // until the kept stretch is the stretch between the rests.
    let padA = coreLength, padB = coreLength;
    let curve!: THREE.CatmullRomCurve3, length = 0, turnsTo: number[] = [], samples: THREE.Vector3[] = [], k0 = 0, k1 = 0, kRef = 0;
    for (let pass = 0; pass < 8; pass++) {
      const pts = [
        core[0].clone().addScaledVector(away0, padA), core[0].clone().addScaledVector(away0, padA * 0.55), core[0].clone().addScaledVector(away0, padA * 0.25),
        ...core,
        core[last].clone().addScaledVector(away1, padB * 0.25), core[last].clone().addScaledVector(away1, padB * 0.55), core[last].clone().addScaledVector(away1, padB),
      ];
      curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      curve.arcLengthDivisions = 1200;
      length = curve.getLength();
      samples = curve.getSpacedPoints(STEPS);
      turnsTo = [0];
      for (let i = 1; i <= STEPS; i++) {
        const mid = samples[i].clone().add(samples[i - 1]).multiplyScalar(0.5 / S);
        turnsTo.push(turnsTo[i - 1] + 1 / (STEPS * o.scaleAt(mid)));
      }
      k0 = nearest(samples, core[0]); k1 = nearest(samples, core[last]); kRef = nearest(samples, core[plan.ref]);
      const u0 = turnsTo[k0] / turnsTo[STEPS], u1 = turnsTo[k1] / turnsTo[STEPS];
      if (Math.abs(u0 - KEEP_FROM) < 0.006 && Math.abs(u1 - KEEP_TO) < 0.006) break;
      padA *= clamp(KEEP_FROM / Math.max(u0, 0.02), 0.4, 2.5);
      padB *= clamp((1 - KEEP_TO) / Math.max(1 - u1, 0.02), 0.4, 2.5);
    }
    const frames = curve.computeFrenetFrames(400, false);
    const start = curve.getPointAt(0);
    const total = turnsTo[STEPS];
    const curveAt = (u: number): number => {
      const want = u * total;
      let lo = 0, hi = STEPS;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (turnsTo[mid] < want) lo = mid; else hi = mid; }
      const span = turnsTo[hi] - turnsTo[lo];
      return (lo + (span > 0 ? (want - turnsTo[lo]) / span : 0)) / STEPS;
    };
    const scaleAtS = (s: number) => o.scaleAt(curve.getPointAt(clamp(s, 0, 1)).multiplyScalar(1 / S));

    const base = template[plan.index];
    const turns = length / o.pitch * total;
    const st: Strand = {
      ...base,
      // Both strands are in the template's phase at the shared point.
      theta0: base.theta0 - base.hand * 2 * Math.PI * (length / o.pitch) * turnsTo[kRef],
      x: start.x, y: start.y, z: start.z, y0: 0, y1: length,
      radius: o.radius + o.spread * plan.index, depth: 1, width: o.width - o.narrow * plan.index,
      swell: 0, centre: (7.5 / 16) * length, turns,
    };
    const bend = (p: THREE.Vector3): THREE.Vector3 => {
      const u = clamp((p.y - start.y) / length, 0, 1);
      const s = curveAt(u), scale = scaleAtS(s);
      const k = Math.min(400, Math.round(s * 400));
      return curve.getPointAt(s)
        .addScaledVector(frames.normals[k], (p.x - start.x) * scale)
        .addScaledVector(frames.binormals[k], (p.z - start.z - 0.25) * scale);
    };

    // The kept stretch, as shares of the run, and how the ribbon narrows toward a tip.
    const uA = turnsTo[k0] / total, uB = turnsTo[k1] / total;
    const sA = k0 / STEPS, sB = k1 / STEPS;
    const tipAt = (s: number) => o.tip * S * scaleAtS(s);
    const grip = (u: number): number => {
      const s = curveAt(u);
      const a = plan.tipStart ? clamp(((s - sA) * length) / tipAt(s), 0, 1) ** 0.8 : 1;
      const b = plan.tipEnd ? clamp(((sB - s) * length) / tipAt(s), 0, 1) ** 0.8 : 1;
      return Math.min(a, b);
    };
    const thin = (p: THREE.Vector3, u: number): THREE.Vector3 => {
      const c = strandPoint(st, u, 0);
      return c.addScaledVector(p.clone().sub(c), grip(u));
    };

    // The kit spaces laminations by how the upright strand looks to its camera: a stand-in sees it
    // square on at the distance where the ribbon is `lamination` millimetres wide.
    const spacingView = new THREE.PerspectiveCamera(view.fov, view.aspect, 1, 1e8);
    const mid = start.clone().setY(start.y + length / 2);
    spacingView.position.copy(mid).add(new THREE.Vector3(0, 0, f * 2 * st.width / o.lamination));
    spacingView.lookAt(mid);
    spacingView.updateProjectionMatrix(); spacingView.updateMatrixWorld(true);

    const uOf = (p: THREE.Vector3) => (p.y - start.y) / length;
    for (const h of strandStrokes(st, o.density, 0, ctx, spacingView)) {
      const kept: THREE.Vector3[] = [];
      for (let i = 0; i < h.points.length; i++) {
        const p = h.points[i], u = uOf(p);
        const prev = h.points[i - 1];
        if (u < uA || u > uB) {
          // Leaving the kept stretch: close the stroke on its boundary.
          if (kept.length && prev) { const up = uOf(prev), edge = u > uB ? uB : uA; kept.push(prev.clone().lerp(p, (edge - up) / (u - up))); break; }
          continue;
        }
        if (!kept.length && prev) { const up = uOf(prev), edge = up < uA ? uA : uB; kept.push(prev.clone().lerp(p, (edge - up) / (u - up))); }
        kept.push(p);
      }
      if (kept.length > 1) strokes.push({ ...h, points: kept.map(q => bend(thin(q, clamp(uOf(q), uA, uB))).multiplyScalar(1 / S)) });
    }
    const mesh = buildSurfaceMesh((u, v) => {
      const t = uA + (uB - uA) * u;
      const c = strandPoint(st, t, 0);
      return bend(c.lerp(strandPoint(st, t, 2 * v - 1), grip(t)));
    }, {}, 320, 8);
    mesh.scale(1 / S, 1 / S, 1 / S);
    mesh.computeBoundingSphere();
    meshes.push(mesh);
  }
  return { strokes, meshes };
}
