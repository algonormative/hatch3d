import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../src/occlusion.ts';

/** The camera, depth raster, and returned paths share the same 2 px/mm map. */
const PAGE_WIDTH = 420;
const PAGE_HEIGHT = 297;
const VIEW_WIDTH = PAGE_WIDTH * 2;
const VIEW_HEIGHT = PAGE_HEIGHT * 2;
const HALO_PIXELS = 2;
const PENS = ['carbon', 'cobalt', 'lagoon', 'ember', 'brass'] as const;
type FoldPen = typeof PENS[number];

type FoldSpec = {
  id: number;
  x: number;
  y: number;
  z: number;
  angle: number;
  length: number;
  width: number;
  rise: number;
  panels: number;
  curl: number;
  skew: number;
  phase: number;
  twist: number;
};

type Stroke3D = { pen: FoldPen; points: THREE.Vector3[] };
type ClusterLayout = { rotation: number; mirror: number; splay: number; shear: number };

function clusterLayout(ctx: SketchContext): ClusterLayout {
  const random = ctx.random('fold-cluster');
  return {
    rotation: (random() - 0.5) * 1.05,
    mirror: random() < 0.5 ? -1 : 1,
    splay: 0.82 + random() * 0.31,
    shear: (random() - 0.5) * 0.42,
  };
}

export interface FoldStats {
  /** One count per pixel-sampled projected segment, before and after depth removal. */
  candidateSegments: number;
  visibleSegments: number;
  hiddenSegments: number;
  occupiedPixels: number;
  foldCount: number;
}

export interface FoldDrawing {
  parts: Part[];
  /** Page millimeters; includes a one-millimeter halo for 2D field traces. */
  occludes: (x: number, y: number) => boolean;
  stats: FoldStats;
}

const ANCHORS = [
  { x: -1.25, y: 0.3, angle: -0.17, size: 1.12 },
  { x: 3.45, y: 2.05, angle: 0.69, size: 0.81 },
  { x: -4.0, y: -2.35, angle: -0.77, size: 0.73 },
  { x: 3.0, y: -2.65, angle: 0.24, size: 0.67 },
  { x: -0.3, y: 3.5, angle: 1.31, size: 0.57 },
  { x: -5.2, y: 2.05, angle: 0.21, size: 0.52 },
  { x: 0.4, y: -4.0, angle: -0.53, size: 0.47 },
] as const;

function numeric(ctx: SketchContext, id: string, fallback: number, min: number, max: number): number {
  const value = ctx.params[id];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value)) : fallback;
}

function makeSpec(ctx: SketchContext, id: number, global: THREE.Vector3, cluster: ClusterLayout, foldScale: number, foldTwist: number): FoldSpec {
  const anchor = ANCHORS[id];
  const layout = ctx.random(`fold-layout-${id}`);
  const shape = ctx.random(`fold-shape-${id}`);
  const size = anchor.size * foldScale * (0.82 + 0.36 * shape());
  const ax = cluster.mirror * anchor.x * cluster.splay;
  const ay = anchor.y + cluster.shear * ax;
  const ca = Math.cos(cluster.rotation), sa = Math.sin(cluster.rotation);
  return {
    id,
    x: ax * ca - ay * sa + global.x + (layout() - 0.5) * 1.48,
    y: ax * sa + ay * ca + global.y + (layout() - 0.5) * 1.25,
    z: global.z + (layout() - 0.5) * 0.58,
    angle: cluster.rotation + (cluster.mirror < 0 ? Math.PI - anchor.angle : anchor.angle) + (layout() - 0.5) * 0.68,
    length: 6.35 * size * (0.88 + 0.24 * shape()),
    width: 2.7 * size * (0.80 + shape() * 0.4),
    rise: 1.6 * size * (0.85 + shape() * 0.3),
    panels: 5 + Math.floor(shape() * 3),
    curl: (shape() - 0.5) * 0.8,
    skew: (shape() - 0.5) * 0.38,
    phase: shape() * Math.PI * 2,
    twist: foldTwist * (0.8 + shape() * 0.4),
  };
}

/** A single piece of bent sheet: a continuous centerline, sharp pleats, and twisted width vector. */
function surface(spec: FoldSpec, u: number, v: number): THREE.Vector3 {
  const t = Math.max(0, Math.min(1, u)) * spec.panels;
  const panel = Math.min(spec.panels - 1, Math.floor(t));
  const local = t - panel;
  const pleat = panel % 2 === 0 ? local : 1 - local;
  const x = (u - 0.5) * spec.length;
  const meander = 0.28 * Math.sin(Math.PI * 2 * u + spec.phase) + spec.curl * (u - 0.5) ** 2;
  const width = spec.width * (0.91 + 0.09 * Math.sin(Math.PI * 2 * u + spec.phase * 0.6));
  const angle = spec.twist * (0.73 * Math.sin(Math.PI * (2 * u - 0.24) + spec.phase) + 0.52 * (u - 0.5));
  const crown = 0.12 * spec.rise * (1 - v * v);
  const localX = x + spec.skew * v * Math.sin(Math.PI * u);
  const localY = meander + v * width * 0.5 * Math.cos(angle);
  const localZ = 0.28 + spec.rise * pleat + v * width * 0.5 * Math.sin(angle) + crown;
  const ca = Math.cos(spec.angle), sa = Math.sin(spec.angle);
  return new THREE.Vector3(
    spec.x + localX * ca - localY * sa,
    spec.y + localX * sa + localY * ca,
    spec.z + localZ,
  );
}

function trace(spec: FoldSpec, pen: FoldPen, count: number, at: (t: number) => [number, number]): Stroke3D {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= count; i++) {
    const [u, v] = at(i / count);
    points.push(surface(spec, u, v));
  }
  return { pen, points };
}

function makeStrokes(spec: FoldSpec): Stroke3D[] {
  const strokes: Stroke3D[] = [];
  const along = spec.panels * 12;
  // Continuous dark edges and end cuts make the sheet read as one object.
  for (const v of [-1, 1]) strokes.push(trace(spec, 'carbon', along, t => [t, v]));
  for (const u of [0, 1]) strokes.push(trace(spec, 'carbon', 12, t => [u, 2 * t - 1]));
  for (let k = 1; k < spec.panels; k++) {
    strokes.push(trace(spec, 'cobalt', 12, t => [k / spec.panels, 2 * t - 1]));
  }
  // Each pleat has a fine transverse grain. Alternate faces get oblique
  // shadow scores; their slope changes with the three-dimensional twist.
  for (let k = 0; k < spec.panels; k++) {
    for (let j = 1; j <= 8; j++) {
      const u = (k + j / 9) / spec.panels;
      strokes.push(trace(spec, j === 4 ? 'brass' : 'lagoon', 10, t => [u, -0.93 + 1.86 * t]));
    }
    if (k % 2 === 1) {
      for (let j = 1; j <= 4; j++) {
        strokes.push(trace(spec, 'ember', 11, t => [
          (k + (j + 0.27 * (2 * t - 1)) / 5) / spec.panels,
          -0.83 + 1.66 * t,
        ]));
      }
    }
  }
  // A sparse seam follows the middle of the dominant sheet and marks its
  // curvature without filling every face with ink.
  if (spec.id === 0) strokes.push(trace(spec, 'brass', along, t => [t, 0]));
  return strokes;
}

function camera(): THREE.OrthographicCamera {
  const halfWidth = 9.75;
  const halfHeight = halfWidth * PAGE_HEIGHT / PAGE_WIDTH;
  const view = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0.1, 80);
  view.up.set(0, 0, 1);
  view.position.set(5.2, -7.2, 15.5);
  view.lookAt(0, 0, 0);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
}

function lengthMm(path: Point[]): number {
  let length = 0;
  for (let i = 1; i < path.length; i++) {
    length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  return length;
}

function toPage(points: { x: number; y: number }[]): Point[] {
  const page = points.map(p => ({ x: p.x * 0.5, y: p.y * 0.5 }));
  if (page.length < 2 || lengthMm(page) < 0.9) return [];
  // The depth decision is made at pixel spacing. Afterward, discard nearly
  // collinear submillimeter samples so the plotted SVG stays economical.
  const reduced: Point[] = [page[0]];
  for (let i = 1; i < page.length - 1; i++) {
    const p = page[i], last = reduced[reduced.length - 1], next = page[i + 1];
    const span = Math.hypot(p.x - last.x, p.y - last.y);
    const cross = Math.abs((p.x - last.x) * (next.y - p.y) - (p.y - last.y) * (next.x - p.x));
    if (span >= 1.2 || cross > 0.18) reduced.push(p);
  }
  reduced.push(page[page.length - 1]);
  return reduced.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) ? reduced : [];
}

/** Draw all sheets against one depth pass, including each other's hidden faces. */
export function drawFolds(ctx: SketchContext): FoldDrawing {
  const count = Math.round(numeric(ctx, 'foldCount', 4, 2, 7));
  const global = new THREE.Vector3(
    numeric(ctx, 'foldX', 0, -1, 1),
    numeric(ctx, 'foldY', 0, -1, 1),
    numeric(ctx, 'foldZ', 0, -1, 1),
  );
  const scale = numeric(ctx, 'foldScale', 1, 0.6, 1.35);
  const twist = numeric(ctx, 'foldTwist', 0.55, 0, 1);
  const removeHidden = ctx.params.occlusion !== false;
  const cluster = clusterLayout(ctx);
  const specs = Array.from({ length: count }, (_, id) => makeSpec(ctx, id, global, cluster, scale, twist));
  const geometries: THREE.BufferGeometry[] = [];
  const view = camera();
  try {
    for (const spec of specs) {
      const fn = (u: number, v: number) => surface(spec, u, 2 * v - 1);
      geometries.push(buildSurfaceMesh(fn, {}, spec.panels * 18, 12));
    }
    const depth = renderDepthBufferCPU(geometries, view, VIEW_WIDTH, VIEW_HEIGHT);
    let occupiedPixels = 0;
    for (let i = 3; i < depth.depthData.length; i += 4) {
      if (depth.depthData[i] >= 128) occupiedPixels++;
    }
    const strokes = specs.flatMap(makeStrokes);
    const projected = projectPolylinesClipped(strokes.map(s => s.points), view, VIEW_WIDTH, VIEW_HEIGHT);
    const pathsByPen = new Map<FoldPen, Point[][]>(PENS.map(pen => [pen, []]));
    let candidateSegments = 0;
    let visibleSegments = 0;
    for (let i = 0; i < projected.polylines.length; i++) {
      const stroke = strokes[projected.sourceIndices[i]];
      for (const clipped of clipProjectedPolyline(projected.polylines[i], VIEW_WIDTH, VIEW_HEIGHT)) {
        const dense = densifyProjectedPolyline(clipped);
        candidateSegments += Math.max(0, dense.length - 1);
        const runs = removeHidden ? splitPolylineByDepth(dense, depth, 0.0012).visible : [dense];
        for (const run of runs) {
          const page = toPage(run);
          if (page.length < 2) continue;
          visibleSegments += Math.max(0, run.length - 1);
          pathsByPen.get(stroke.pen)!.push(page);
        }
      }
    }
    const occludes = (xMm: number, yMm: number): boolean => {
      if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) return false;
      const px = Math.round(xMm * 2);
      const py = VIEW_HEIGHT - 1 - Math.round(yMm * 2); // packed rows are bottom-up
      for (let dy = -HALO_PIXELS; dy <= HALO_PIXELS; dy++) {
        const row = py + dy;
        if (row < 0 || row >= VIEW_HEIGHT) continue;
        for (let dx = -HALO_PIXELS; dx <= HALO_PIXELS; dx++) {
          const col = px + dx;
          if (col < 0 || col >= VIEW_WIDTH) continue;
          if (depth.depthData[(row * VIEW_WIDTH + col) * 4 + 3] >= 128) return true;
        }
      }
      return false;
    };
    const parts: Part[] = PENS.map(pen => ({ id: `fold-${pen}`, pen, paths: pathsByPen.get(pen)! }));
    return {
      parts,
      occludes,
      stats: { candidateSegments, visibleSegments, hiddenSegments: candidateSegments - visibleSegments, occupiedPixels, foldCount: count },
    };
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}
