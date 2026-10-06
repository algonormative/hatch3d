import * as THREE from 'three';
import type { Point } from '../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../phase-garden/poster.ts';

/** A page size in millimetres. */
export interface PageSize { width: number; height: number }

export interface HorizonCameraSpec {
  fov: number;
  eye: [number, number, number];
  target: [number, number, number];
  near?: number;
  far: number;
  /** The sheet, in millimetres. */
  page: PageSize;
  /** The depth-buffer size in pixels; its aspect matches the page. */
  depth: { width: number; height: number };
  /** Page y, in millimetres, where the horizon (the vanishing line of the ground) falls. */
  horizonY: number;
}

/**
 * A perspective camera looking level at the horizon, view-offset vertically so that horizon lands on
 * `horizonY` on the page: every card of a set built this way shares one horizon line.
 */
export function horizonCamera(spec: HorizonCameraSpec): THREE.PerspectiveCamera {
  const { width: W, height: H } = spec.depth;
  const mmY = spec.page.height / H;
  const view = new THREE.PerspectiveCamera(spec.fov, W / H, spec.near ?? 0.5, spec.far);
  view.position.set(...spec.eye);
  view.lookAt(...spec.target);
  view.setViewOffset(W, H, 0, -(spec.horizonY - spec.page.height / 2) / mmY, W, H);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
}

/** Where a world point lands on the page, in millimetres. */
export function pageOf(view: THREE.Camera, world: THREE.Vector3, page: PageSize = TABLOID_PAGE): Point {
  const q = world.clone().project(view);
  return { x: (q.x * 0.5 + 0.5) * page.width, y: (-q.y * 0.5 + 0.5) * page.height };
}

/** The unprojected point on the ray through page position `p` (not normalised, mid-frustum). */
function rayPoint(view: THREE.Camera, p: Point, page: PageSize): THREE.Vector3 {
  return new THREE.Vector3(p.x / page.width * 2 - 1, -(p.y / page.height * 2 - 1), 0.5).unproject(view);
}

/** The world point at page position `p`, `dist` units from the eye along its ray. */
export function atPage(view: THREE.Camera, p: Point, dist: number, page: PageSize = TABLOID_PAGE): THREE.Vector3 {
  return view.position.clone().addScaledVector(rayPoint(view, p, page).sub(view.position).normalize(), dist);
}

/** The point where the ray through page position `p` meets the ground plane, y = 0. */
export function onGround(view: THREE.Camera, p: Point, page: PageSize = TABLOID_PAGE): THREE.Vector3 {
  const dir = rayPoint(view, p, page).sub(view.position);
  return view.position.clone().addScaledVector(dir, -view.position.y / dir.y);
}
