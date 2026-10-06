import type * as THREE from 'three';
import type { Part, Point } from '../../src/sketch/types.ts';
import { projectPolylinesClipped, type ProjectedPoint } from '../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, type PackedDepthBuffer } from '../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../src/occlusion.ts';
import { pathLength, simplify } from './page.ts';

/** The strokes-to-parts pipeline the Breach sketches share. */

/** Shortest plotted path, in millimetres: ordinary marks and exact (lettering) marks. */
export const MIN_LENGTH_MM = 0.5;
export const MIN_EXACT_LENGTH_MM = 0.05;

/** Scale a run of points (for example depth pixels to page millimetres). */
export const scalePoints = (run: Point[], sx: number, sy: number): Point[] => run.map(p => ({ x: p.x * sx, y: p.y * sy }));

/**
 * Paths gathered under `${group}-${ink}` keys, reduced and length-filtered as they come in, then
 * emitted as Parts in a fixed group × ink order.
 */
export class PartBuckets {
  private readonly buckets = new Map<string, Point[][]>();

  /** `min` is the default shortest ordinary path; call sites override it per path. */
  constructor(private readonly min = MIN_LENGTH_MM) {}

  /**
   * Add a path. Unless `exact` (glyph curves, flat marks: every point kept) it is first simplified.
   * Paths of one point, or no longer than `min` (default: the constructor's, or 0.05 mm when exact),
   * are dropped. Returns whether the path was kept.
   */
  add(key: string, path: Point[], exact = false, min?: number): boolean {
    const reduced = exact ? path : simplify(path);
    if (reduced.length > 1 && pathLength(reduced) > (min ?? (exact ? MIN_EXACT_LENGTH_MM : this.min))) {
      if (!this.buckets.has(key)) this.buckets.set(key, []);
      this.buckets.get(key)!.push(reduced);
      return true;
    }
    return false;
  }

  get(key: string): Point[][] | undefined { return this.buckets.get(key); }

  /** Non-empty buckets as parts, ordered by `groups` then `inks`; the pen is the ink. */
  toParts(groups: readonly string[], inks: readonly string[]): Part[] {
    const parts: Part[] = [];
    for (const group of groups) for (const ink of inks) {
      const paths = this.buckets.get(`${group}-${ink}`);
      if (paths?.length) parts.push({ id: `${group}-${ink}`, pen: ink, paths });
    }
    return parts;
  }
}

export interface ProjectEnv {
  view: THREE.Camera;
  /** The depth pass the strokes are tested against. */
  depth: PackedDepthBuffer;
  /** Depth-buffer size in pixels. */
  width: number;
  height: number;
  /** Depth bias for the visibility test. */
  bias?: number;
}

export interface ProjectHooks<S> {
  /** Cut a clipped piece into the pieces to keep (for example round slogan bands); default: as is. */
  pieces?: (piece: ProjectedPoint[], stroke: S, index: number) => ProjectedPoint[][];
  /** Whether this stroke is hidden-line tested against the depth pass; default: yes. */
  hidden?: (stroke: S) => boolean;
  /**
   * Called once per projected polyline: `index` is the stroke's index in the input, `whole` the
   * polyline before any clipping. Returns the receiver for that polyline's depth-visible runs,
   * called once per clipped piece, in depth pixels. (Per-polyline state, like a seeded scratch
   * stream, lives in the closure.)
   */
  begin: (stroke: S, index: number, whole: ProjectedPoint[]) => (runs: ProjectedPoint[][]) => void;
}

/**
 * Project strokes through the camera and walk them as depth-visible runs: project and clip to the
 * depth viewport, cut each piece with `pieces`, densify, and split by the depth pass (unless the
 * stroke is not `hidden`). What happens to each run is the caller's.
 */
export function projectStrokes<S extends { points: THREE.Vector3[] }>(strokes: S[], env: ProjectEnv, hooks: ProjectHooks<S>): void {
  const projection = projectPolylinesClipped(strokes.map(s => s.points), env.view, env.width, env.height);
  const bias = env.bias ?? 0.0014;
  for (let i = 0; i < projection.polylines.length; i++) {
    const index = projection.sourceIndices[i];
    const stroke = strokes[index];
    const whole = projection.polylines[i];
    const receive = hooks.begin(stroke, index, whole);
    const test = hooks.hidden ? hooks.hidden(stroke) : true;
    const clipped = clipProjectedPolyline(whole, env.width, env.height);
    for (const piece of hooks.pieces ? clipped.flatMap(c => hooks.pieces!(c, stroke, index)) : clipped) {
      const dense = densifyProjectedPolyline(piece);
      receive(test ? splitPolylineByDepth(dense, env.depth, bias).visible : [dense]);
    }
  }
}
