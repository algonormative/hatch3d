import * as THREE from 'three';
import type { SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh } from '../../../src/projection.ts';
import { helixStrands, narrowStrands, strandPoint, strandStrokes, type HelixStroke } from '../../kit/helix.ts';
import { clamp } from '../../kit/params.ts';

export interface LeashOptions {
  /** Strand radius round the curve, ribbon width as a share of it, and curve length per turn (world units). */
  radius: number; width: number; pitch: number;
  /** Lamination density, 0..1. */
  density: number;
  /** Build it this many times larger, then scale back: the kit's wiggles are fixed in world units. */
  scale: number;
}

/**
 * One strand of the kit's twin helix laid along a curve as a leash. The helix is two strands of one
 * membrane; the pillar splits it, one strand to each side, so `index` picks which. Built `scale`
 * times the size and brought back, so a thin smooth ribbon does not read as lightning. The strand
 * is the kit's, in its native inks. The lamination spacing is measured by a stand-in camera that
 * sees the unbent strand as it would stand at the curve's start. Off tabloid, a strand narrower on the card than the
 * smallest feature is drawn by its line (`narrowStrands`, in `view`): its edges would print as one blot and its
 * laminations as specks.
 */
export function leashStrand(ctx: SketchContext, view: THREE.PerspectiveCamera, pts: THREE.Vector3[], index: 0 | 1, o: LeashOptions) {
  const S = o.scale;
  const sv = view.clone();
  sv.position.multiplyScalar(S); sv.near *= S; sv.far *= S;
  sv.updateProjectionMatrix(); sv.updateMatrixWorld(true);
  const curve = new THREE.CatmullRomCurve3(pts.map(p => p.clone().multiplyScalar(S)), false, 'centripetal');
  const start = curve.getPointAt(0);
  const length = curve.getLength();
  const frames = curve.computeFrenetFrames(400, false);
  const r = o.radius * S;
  const template = helixStrands({ ...ctx, params: { ...ctx.params, helixTurns: 1.6, shellTwist: 0.35 } });
  // The kit opens every third bar of laminations (a rest) except round its breach `centre`. A
  // leash has no breach, so the centre is parked far off the strand: the rests fall where the kit puts them.
  const st = {
    ...template[index], x: start.x, y: start.y, z: start.z, y0: 0, y1: length, radius: r + r * 0.3 * index, depth: 1,
    width: r * o.width - r * 0.12 * index, swell: 0, centre: -1e3, turns: length / (o.pitch * S),
  };
  const bend = (p: THREE.Vector3): THREE.Vector3 => {
    const u = clamp((p.y - start.y) / length, 0, 1);
    const k = Math.min(400, Math.round(u * 400));
    return curve.getPointAt(u).addScaledVector(frames.normals[k], p.x - start.x).addScaledVector(frames.binormals[k], p.z - start.z - 0.25);
  };
  const strokes: HelixStroke[] = narrowStrands(strandStrokes(st, o.density, 0.2, ctx, sv).map(h => ({ ...h, points: h.points.map(q => bend(q).multiplyScalar(1 / S)) })), view);
  const mesh = buildSurfaceMesh((u, w) => bend(strandPoint(st, u, 2 * w - 1)), {}, 320, 8).scale(1 / S, 1 / S, 1 / S);
  mesh.computeBoundingSphere();
  return { strokes, mesh, length: length / S };
}

/**
 * The leash as a rope: both strands of the twin helix wound together along the one route, at a
 * small radius, so it reads as twisted cord and the slack of its curve is what shows.
 */
export function leashRope(ctx: SketchContext, view: THREE.PerspectiveCamera, pts: THREE.Vector3[], o: LeashOptions) {
  const strands = ([0, 1] as const).map(i => leashStrand(ctx, view, pts, i, o));
  return { strokes: strands.flatMap(s => s.strokes), meshes: strands.map(s => s.mesh), length: strands[0].length };
}
