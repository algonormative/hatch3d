import * as THREE from 'three';
import type { Point, SketchContext } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { solid, type Slab } from '../../kit/slabs.ts';
import { n } from '../../kit/params.ts';
import { horizonCamera } from '../../kit/perspective.ts';
import { HORIZON_Y } from '../card.ts';

/**
 * The camera and the mountain of IX The Hermit. The camera sits on the plain at the Fool's eye
 * level, looking level at the horizon; the peak stands far off, so its whole height rises above
 * that eye line and its foot lies just under it.
 */
export const W = 1118, H = 1728;
export const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
export const EYE = 6;

export function hermitCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 40, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 4000,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/** Page-millimetre arithmetic for the level camera: the focal length in mm and the world <-> page maps. */
export interface Scale {
  f: number;
  /** Page millimetres per world unit for something at a point's depth. */
  mmPerUnit: (p: THREE.Vector3) => number;
  /** The world point `d` units straight ahead of the eye that lands on page position `p`. */
  at: (p: Point, d: number) => THREE.Vector3;
}

export function scaleOf(view: THREE.PerspectiveCamera): Scale {
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  return {
    f,
    mmPerUnit: p => f / Math.max(1, view.position.z - p.z),
    at: (p, d) => new THREE.Vector3((p.x - TABLOID_PAGE.width / 2) * d / f, EYE + (HORIZON_Y - p.y) * d / f, -d),
  };
}

export interface Peak {
  slabs: Slab[];
  /** The summit slab, the one the hermit stands on, and the broken chunk resting on its back corner. */
  capstone: Slab;
  chunk: Slab;
  /** The middle of the capstone's top face. */
  summit: THREE.Vector3;
  /** Plan directions: along the ridge toward the cliff (right, near) and across it toward the eye. */
  along: THREE.Vector3;
  across: THREE.Vector3;
}

/**
 * The mountain: columns of rough slabs on a grid laid along a ridge that runs diagonally into the
 * picture. From the summit the ridge falls away to the left and back in a long stair of lower and
 * lower columns, and ends to the right in a short cliff. Each column is a stack of uneven slabs a
 * little askew, topped to the height the profile asks for.
 */
export function buildPeak(ctx: SketchContext, sc: Scale): Peak {
  const layout = ctx.random('hermit-layout');
  const variety = n(ctx, 'variety', 1, 0, 2);
  const jit = () => (layout() - 0.5) * 2 * variety;
  const sx = n(ctx, 'summitX', 192, 120, 235) + jit() * 12;
  const sy = n(ctx, 'summitY', 136, 100, 170) + jit() * 6;
  const phi = THREE.MathUtils.degToRad(n(ctx, 'turn', 30, 0, 60) + jit() * 8);
  const dist = n(ctx, 'peakDistance', 250, 150, 450) * (1 + 0.05 * jit());
  const summit = sc.at({ x: sx, y: sy }, dist);
  const along = new THREE.Vector3(Math.cos(phi), 0, Math.sin(phi));
  const across = new THREE.Vector3(-Math.sin(phi), 0, Math.cos(phi));
  const rng = ctx.random('hermit-peak');

  const cs = n(ctx, 'slabWidth', 11, 8, 28), ch = n(ctx, 'slabHeight', 4.6, 3, 10);
  const kg = Math.max(3, Math.round(n(ctx, 'ridge', 108, 40, 220) / cs));
  const cliff = [0.4];
  const rowWidth = n(ctx, 'breadth', 27, 14, 70) * 2 / 3;
  const rise = summit.y;
  const slabs: Slab[] = [];

  // The capstone: one broad slab on top of the tallest column.
  const capLen = cs * 0.88, capDep = rowWidth * 1.2, capH = ch * 1.05;
  const capstone = solid(summit.x, summit.y - capH / 2, summit.z, capLen, capH - 0.12, capDep, 0, 'stack');
  capstone.ry = -phi + (rng() - 0.5) * 0.14;

  // Rows across the ridge: the middle one is the spine, the one toward the eye a lower terrace, the one behind a shoulder.
  const dip = THREE.MathUtils.degToRad(n(ctx, 'dip', 16, 0, 25));
  const rows: [number, number][] = [[0, 1], [1, 0.55], [-1, 0.45]];
  const FRONT_FROM = Math.round(n(ctx, 'terraceFrom', 0, 0, 6));
  for (let k = -cliff.length; k < kg; k++) for (const [j, rowHeight] of rows) {
    // The cliff to the right is the spine alone; the stair to the left falls away steeply from the summit and flattens at the foot.
    if (k < 0 && j !== 0) continue;
    // The back shoulder only starts a little down the stair, so the summit stands at the cliff's edge.
    if (j === -1 && k < 2) continue;
    // The terrace toward the eye comes and goes.
    if (j === 1 && (k < FRONT_FROM || rng() < 0.25)) continue;
    const s = (k + (rng() - 0.5) * 0.12) * cs;
    const profile = k < 0 ? cliff[-k - 1] : 1 - 0.96 * (k / (kg + 0.6)) ** n(ctx, 'profile', 1.1, 0.8, 2.4);
    // No column stands higher than the summit's neighbours should: the capstone is the top.
    let top = Math.min(rise * 0.93, rise * profile * rowHeight * (0.84 + 0.32 * rng()));
    if (k === 0 && j === 0) top = summit.y - capH;
    if (top < 1.5) continue;
    const heights: number[] = [];
    let sum = 0;
    while (sum < top - 0.5) { const c = ch * (0.55 + 1.0 * rng()); heights.push(c); sum += c; }
    const fit = top / sum;
    let y = 0;
    const colDip = dip * (0.8 + 0.4 * rng());
    for (const [course, raw] of heights.entries()) {
      const h = raw * fit;
      const len = cs * (0.6 + 0.24 * rng()), dep = rowWidth * (0.76 + 0.14 * rng());
      const slip = (rng() - 0.5) * 0.12 * cs, slipAcross = (rng() - 0.5) * 0.08 * rowWidth;
      const at = new THREE.Vector3(summit.x, 0, summit.z).addScaledVector(along, -(s + slip)).addScaledVector(across, j * rowWidth + slipAcross);
      const sl = solid(at.x, y + h / 2, at.z, len, Math.max(0.3, h - 0.12), dep, slabs.length, 'stack');
      sl.ry = -phi + (rng() - 0.5) * 0.06;
      sl.rx = (rng() - 0.5) * 0.08;
      // Every slab in a column dips with the ridge, rising toward the cliff, a hair off its neighbours in the stack (so none cuts into the next);
      // the courses under the capstone lie flat, for it to sit on.
      sl.rz = k === 0 && j === 0 && course >= heights.length - 2 ? 0 : colDip + (rng() - 0.5) * 0.03;
      slabs.push(sl);
      y += h;
    }
  }
  slabs.push(capstone);
  // A chunk of broken stone rests on the back corner of the capstone, askew, so the summit is a rough slab and not a moulding.
  const chunk = solid(summit.x, summit.y + 0.3 * ch + 0.2, summit.z, 0.3 * cs, 0.6 * ch, 0.35 * rowWidth, slabs.length, 'stack');
  const chunkAt = new THREE.Vector3(summit.x, 0, summit.z).addScaledVector(along, 0.24 * cs).addScaledVector(across, -0.3 * rowWidth);
  chunk.x = chunkAt.x; chunk.z = chunkAt.z;
  chunk.ry = -phi + 0.35; chunk.rz = 0.1;
  slabs.push(chunk);
  return { slabs, capstone, chunk, summit, along, across };
}
