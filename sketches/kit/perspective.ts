import * as THREE from 'three';
import type { Point } from '../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../phase-garden/poster.ts';
import { PAGE, TABLOID_HORIZON_Y, TABLOID_RASTER, fitFov } from './format.ts';

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
  /**
   * Whether the field of view follows the format's fit (default). `false` keeps it as given: for a camera in
   * tabloid's frame (tabloid's page, raster and horizon), which lays out a seeded world exactly as the print does.
   */
  fit?: boolean;
}

/**
 * A perspective camera looking level at the horizon, view-offset vertically so that horizon lands on
 * `horizonY` on the page: every card of a set built this way shares one horizon line. The field of view
 * follows the format's fit (unchanged at tabloid and for `fit: 'height'`) unless `fit` is false.
 */
export function horizonCamera(spec: HorizonCameraSpec): THREE.PerspectiveCamera {
  const { width: W, height: H } = spec.depth;
  const mmY = spec.page.height / H;
  const view = new THREE.PerspectiveCamera(spec.fit === false ? spec.fov : fitFov(spec.fov), W / H, spec.near ?? 0.5, spec.far);
  view.position.set(...spec.eye);
  view.lookAt(...spec.target);
  view.setViewOffset(W, H, 0, -(spec.horizonY - spec.page.height / 2) / mmY, W, H);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
}

/** A level camera in tabloid's frame: where it stands and looks, and its lens. */
export interface FrameCameraSpec {
  /** Vertical field of view, degrees: kept as given, whatever the fit. */
  fov: number;
  /** Eye height above the ground, world units. The camera stands at the origin and looks level, down -z. */
  eye: number;
  near?: number;
  far: number;
  /** The depth raster; default `TABLOID_RASTER`. */
  depth?: { width: number; height: number };
}

/**
 * A card's camera in tabloid's frame: tabloid's page, depth raster and horizon, and its field of view whatever the fit.
 * A card lays its seeded world out with it, so every size and fit builds the same world, to the bit, and draws it with
 * its own camera (`horizonCamera` on the format's page). The two are the same camera at tabloid. Positions picked on
 * the page (`onGround`, `atPage`, `pageOf`) are then tabloid's, and take `TABLOID_PAGE`.
 */
export function tabloidFrameCamera(spec: FrameCameraSpec): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: spec.fov, eye: [0, spec.eye, 0], target: [0, spec.eye, -100], near: spec.near, far: spec.far,
    page: TABLOID_PAGE, depth: spec.depth ?? TABLOID_RASTER, horizonY: TABLOID_HORIZON_Y, fit: false,
  });
}

/**
 * A copy of `view` for a depth raster `m` times finer each way (`W * m` by `H * m`): the same projection, its view
 * offset scaled with the raster. Fit its depth range (`fitDepthRange`) without touching the card's own camera. Test a
 * small subject against a finer raster with `fineDepth` (kit/strokes.ts).
 */
export function oversampledView(view: THREE.PerspectiveCamera, m: number): THREE.PerspectiveCamera {
  const finer = view.clone();
  const o = view.view;
  if (m !== 1 && o) finer.setViewOffset(o.fullWidth * m, o.fullHeight * m, o.offsetX * m, o.offsetY * m, o.width * m, o.height * m);
  return finer;
}

/** Where a world point lands on the page, in millimetres. */
export function pageOf(view: THREE.Camera, world: THREE.Vector3, page: PageSize = PAGE): Point {
  const q = world.clone().project(view);
  return { x: (q.x * 0.5 + 0.5) * page.width, y: (-q.y * 0.5 + 0.5) * page.height };
}

/** The unprojected point on the ray through page position `p` (not normalised, mid-frustum). */
function rayPoint(view: THREE.Camera, p: Point, page: PageSize): THREE.Vector3 {
  return new THREE.Vector3(p.x / page.width * 2 - 1, -(p.y / page.height * 2 - 1), 0.5).unproject(view);
}

/** The world point at page position `p`, `dist` units from the eye along its ray. */
export function atPage(view: THREE.Camera, p: Point, dist: number, page: PageSize = PAGE): THREE.Vector3 {
  return view.position.clone().addScaledVector(rayPoint(view, p, page).sub(view.position).normalize(), dist);
}

/** The point where the ray through page position `p` meets the ground plane, y = 0. */
export function onGround(view: THREE.Camera, p: Point, page: PageSize = PAGE): THREE.Vector3 {
  const dir = rayPoint(view, p, page).sub(view.position);
  return view.position.clone().addScaledVector(dir, -view.position.y / dir.y);
}

/**
 * Fit the camera's near and far planes snugly round the scene's geometry, with `slack` either side
 * (a fraction of each distance). The hidden-line test's bias is a fixed step of window depth, so a
 * near plane far short of the scene spreads that step over tens or hundreds of world units: small
 * blocks then show their back edges through their own faces. Fitting the range keeps it under a unit.
 */
export function fitDepthRange(view: THREE.PerspectiveCamera, geometries: THREE.BufferGeometry[], slack = 0.1): void {
  view.updateMatrixWorld();
  const inverse = view.matrixWorldInverse;
  let lo = Infinity, hi = 0;
  const centre = new THREE.Vector3();
  for (const g of geometries) {
    if (!g.boundingSphere) g.computeBoundingSphere();
    const sphere = g.boundingSphere!;
    const depth = -centre.copy(sphere.center).applyMatrix4(inverse).z;
    lo = Math.min(lo, depth - sphere.radius);
    hi = Math.max(hi, depth + sphere.radius);
  }
  if (!Number.isFinite(lo)) return;
  view.near = Math.max(0.5, lo * (1 - slack));
  view.far = Math.max(view.near + 1, hi * (1 + slack));
  view.updateProjectionMatrix();
}
