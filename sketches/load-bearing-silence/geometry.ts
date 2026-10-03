import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../src/occlusion.ts';
import { clipPolylineToRect } from '../../src/utils/clip.ts';

type Ink = 'carbon' | 'ultramarine' | 'vermilion' | 'acid' | 'violet';
type PagePoint = { x: number; y: number };
type Stroke = { pen: Ink; points: THREE.Vector3[] };
type Face = [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];

const PAGE = { width: 297, height: 420 };
const ART = { xMin: 18, xMax: 279, yMin: 76, yMax: 357 };
const PIXELS_PER_MM = 2;
const VIEW_WIDTH = PAGE.width * PIXELS_PER_MM;
const VIEW_HEIGHT = PAGE.height * PIXELS_PER_MM;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const between = (a: PagePoint, b: PagePoint, t: number): PagePoint => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });

function numeric(ctx: SketchContext, id: string, fallback: number, low: number, high: number): number {
  const value = ctx.params[id];
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, low, high) : fallback;
}

/** Route geometry is evaluated once and shared by solids, scores, portals, and missing-end cuts. */
class BridgeRoute {
  readonly leftGap: number;
  readonly rightGap: number;
  readonly width: number;
  readonly portalScale: number;
  readonly hatchPitch: number;
  readonly branchReach: number;
  readonly branchCount: number;
  readonly branchOffset: PagePoint;
  readonly shift: THREE.Vector3;
  readonly start: PagePoint;
  readonly bend: PagePoint;
  readonly end: PagePoint;
  readonly chirality: number;

  constructor(ctx: SketchContext) {
    const variation = ctx.random('bridge-route');
    this.start = { x: 38 + 7 * variation(), y: 323 + 8 * variation() };
    this.end = { x: 252 + 8 * variation(), y: 113 + 8 * variation() };
    const warp = numeric(ctx, 'routeWarp', 0, -16, 16);
    this.chirality = variation() < 0.5 ? -1 : 1;
    this.bend = { x: 144 + warp + this.chirality * (10 + variation() * 10), y: 206 + warp * 0.36 + this.chirality * (8 + variation() * 10) };
    const gapWidth = numeric(ctx, 'gapWidth', 0.26, 0.18, 0.34);
    const gapCenter = 0.49 + (variation() - 0.5) * 0.08;
    this.leftGap = gapCenter - gapWidth / 2;
    this.rightGap = gapCenter + gapWidth / 2;
    this.width = numeric(ctx, 'beamWidth', 24, 18, 30);
    this.portalScale = numeric(ctx, 'portalScale', 1, 0.7, 1.3);
    this.hatchPitch = numeric(ctx, 'hatchPitch', 1.45, 0.85, 2.3);
    this.branchReach = numeric(ctx, 'branchReach', 1, 0.65, 1.35);
    this.branchCount = Math.round(numeric(ctx, 'branchCount', 6, 4, 9));
    this.branchOffset = {
      x: numeric(ctx, 'branchRootX', 0, -14, 14),
      y: numeric(ctx, 'branchRootY', 0, -14, 14),
    };
    this.shift = new THREE.Vector3(
      numeric(ctx, 'worldX', 0, -12, 12),
      numeric(ctx, 'worldY', 0, -12, 12),
      numeric(ctx, 'worldZ', 0, -10, 10),
    );
  }

  center(t: number): PagePoint {
    const u = 1 - t;
    return {
      x: u * u * this.start.x + 2 * u * t * this.bend.x + t * t * this.end.x,
      y: u * u * this.start.y + 2 * u * t * this.bend.y + t * t * this.end.y,
    };
  }

  normal(t: number): PagePoint {
    const dx = 2 * (1 - t) * (this.bend.x - this.start.x) + 2 * t * (this.end.x - this.bend.x);
    const dy = 2 * (1 - t) * (this.bend.y - this.start.y) + 2 * t * (this.end.y - this.bend.y);
    const length = Math.hypot(dx, dy);
    return { x: -dy / length, y: dx / length };
  }

  /** A compressed root, heavy rupture shoulders, and alternating cantilevers break the rectangular outline. */
  halfWidth(t: number): number {
    const profile: [number, number][] = [
      [0.1, 0.72], [0.17, 0.95], [0.23, 1.28], [0.27, 0.84], [this.leftGap, 1.2],
      [this.rightGap, 1.28], [0.71, 0.88], [0.78, 1.35], [0.85, 0.78], [0.96, 0.98],
    ];
    for (let index = 1; index < profile.length; index++) {
      if (t > profile[index][0]) continue;
      const [at0, width0] = profile[index - 1];
      const [at1, width1] = profile[index];
      return this.width * 0.5 * lerp(width0, width1, clamp((t - at0) / (at1 - at0), 0, 1));
    }
    return this.width * 0.5 * profile[profile.length - 1][1];
  }

  point(t: number, width: number, depth: number): THREE.Vector3 {
    const center = this.center(t);
    const normal = this.normal(t);
    return this.pagePoint({ x: center.x + normal.x * width, y: center.y + normal.y * width }, depth);
  }

  pagePoint(point: PagePoint, depth: number): THREE.Vector3 {
    return new THREE.Vector3(point.x - PAGE.width / 2 + this.shift.x, PAGE.height / 2 - point.y + this.shift.y, depth + this.shift.z);
  }
}

function quadMesh(face: Face): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const vertices = face.flatMap(vertex => [vertex.x, vertex.y, vertex.z]);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

function bilinear(face: Face, u: number, v: number, lift = 0): THREE.Vector3 {
  const [a, b, c, d] = face;
  return a.clone().multiplyScalar((1 - u) * (1 - v))
    .addScaledVector(b, u * (1 - v)).addScaledVector(c, u * v).addScaledVector(d, (1 - u) * v)
    .add(new THREE.Vector3(0, 0, lift));
}

function stroke(strokes: Stroke[], pen: Ink, points: THREE.Vector3[]): void {
  if (points.length >= 2) strokes.push({ pen, points });
}

function faceDrawing(meshes: THREE.BufferGeometry[], strokes: Stroke[], face: Face, pen: Ink, hatchCount: number, border = true): void {
  meshes.push(quadMesh(face));
  if (border) {
    for (let side = 0; side < 4; side++) stroke(strokes, 'carbon', [face[side], face[(side + 1) % 4]]);
  }
  for (let index = 1; index <= hatchCount; index++) {
    const u = index / (hatchCount + 1);
    const sway = index % 2 === 0 ? 0.025 : -0.025;
    stroke(strokes, pen, [bilinear(face, clamp(u - sway, 0, 1), 0.015, 0.06), bilinear(face, clamp(u + sway, 0, 1), 0.985, 0.06)]);
  }
}

function deckSegment(route: BridgeRoute, meshes: THREE.BufferGeometry[], strokes: Stroke[], from: number, to: number, index: number): void {
  const nearHalf = route.halfWidth(from), farHalf = route.halfWidth(to);
  const top: Face = [route.point(from, -nearHalf, 6), route.point(to, -farHalf, 6), route.point(to, farHalf, 6), route.point(from, nearHalf, 6)];
  const sectionLength = Math.hypot(route.center(to).x - route.center(from).x, route.center(to).y - route.center(from).y);
  faceDrawing(meshes, strokes, top, index % 3 === 0 ? 'carbon' : 'ultramarine', Math.max(5, Math.round(sectionLength / route.hatchPitch)));
  for (const side of [-1, 1]) {
    const outer: Face = [
      route.point(from, side * nearHalf, -15), route.point(to, side * farHalf, -15),
      route.point(to, side * farHalf, 6), route.point(from, side * nearHalf, 6),
    ];
    faceDrawing(meshes, strokes, outer, index % 2 === 0 ? 'violet' : 'carbon', Math.max(5, Math.round(sectionLength / (route.hatchPitch * 1.1))));
    const rail = Array.from({ length: 7 }, (_, sample) => {
      const t = lerp(from, to, sample / 6);
      return route.point(t, side * (route.halfWidth(t) + 2.2), 11);
    });
    stroke(strokes, 'ultramarine', rail);
    for (const t of [from, to]) stroke(strokes, 'carbon', [route.point(t, side * route.halfWidth(t), -15), route.point(t, side * (route.halfWidth(t) + 2.2), 11)]);
  }
  // Heavy internal webbing remains legible against the fine hatch rhythm.
  stroke(strokes, index % 3 === 1 ? 'vermilion' : 'carbon', [route.point(from, -nearHalf + 2, 6.1), route.point(to, farHalf - 2, 6.1)]);
  stroke(strokes, 'carbon', [route.point(from, nearHalf - 2, 6.1), route.point(to, -farHalf + 2, 6.1)]);
}

function buttress(route: BridgeRoute, meshes: THREE.BufferGeometry[], strokes: Stroke[], t: number, side: number, reach: number, length: number, rise: number): void {
  const from = t - length * 0.5, to = t + length * 0.5;
  const near = route.halfWidth(from), far = route.halfWidth(to);
  const ledge: Face = [
    route.point(from, side * near, rise), route.point(to, side * far, rise),
    route.point(to + 0.012, side * (far + reach), rise + 2), route.point(from + 0.012, side * (near + reach), rise + 2),
  ];
  faceDrawing(meshes, strokes, ledge, 'carbon', Math.max(8, Math.round(length * 250)));
  const underside: Face = [
    route.point(from + 0.012, side * (near + reach), -18), route.point(to + 0.012, side * (far + reach), -18),
    route.point(to + 0.012, side * (far + reach), rise + 2), route.point(from + 0.012, side * (near + reach), rise + 2),
  ];
  faceDrawing(meshes, strokes, underside, 'ultramarine', Math.max(7, Math.round(length * 190)));
  stroke(strokes, 'vermilion', [route.point(from, side * near, rise + 0.2), route.point(to + 0.012, side * (far + reach), rise + 2.2)]);
  for (const at of [from, to]) {
    stroke(strokes, 'carbon', [route.point(at, side * route.halfWidth(at), -15), route.point(at + 0.012, side * (route.halfWidth(at) + reach), rise + 2)]);
  }
}

function portal(route: BridgeRoute, meshes: THREE.BufferGeometry[], strokes: Stroke[], t: number, index: number, variation: number): void {
  const side = index % 3 === 0 ? -1 : 1;
  const outer = route.halfWidth(t) + 17 * route.portalScale + variation * 10;
  const inner = route.halfWidth(t) + 3;
  const front = t - (0.026 + variation * 0.012);
  const back = t + (0.042 + variation * 0.01);
  const z = 19 + variation * 18 + (index % 2) * 5;
  // High asymmetric cheek, occasional opposing fragment, and an incomplete lintel.
  faceDrawing(meshes, strokes, [
    route.point(front, side * outer, z), route.point(back, side * outer * 0.88, z + 5),
    route.point(back, side * inner, z + 5), route.point(front, side * inner, z),
  ], index % 3 === 0 ? 'vermilion' : 'carbon', 12);
  faceDrawing(meshes, strokes, [
    route.point(back - 0.012, -side * inner, z - 3), route.point(back + 0.005, -side * inner, z - 3),
    route.point(back + 0.005, side * outer * 0.7, z + 4), route.point(back - 0.012, side * outer * 0.7, z + 4),
  ], index % 2 === 0 ? 'acid' : 'ultramarine', 7);
  if (index % 3 !== 1) {
    const remote = outer + 5 + variation * 5;
    faceDrawing(meshes, strokes, [
      route.point(front - 0.014, -side * remote, z - 11), route.point(front + 0.008, -side * remote, z - 11),
      route.point(back + 0.012, -side * (remote - 5), z + 2), route.point(back - 0.008, -side * (remote - 5), z + 2),
    ], 'violet', 7);
  }
  for (const at of [front, back]) {
    stroke(strokes, 'carbon', [route.point(at, side * inner, -15), route.point(at, side * outer, z)]);
  }
}

function brokenEnd(route: BridgeRoute, meshes: THREE.BufferGeometry[], strokes: Stroke[], t: number, towardGap: number): void {
  const half = route.halfWidth(t);
  const cut: Face = [route.point(t, -half, -15), route.point(t, half, -15), route.point(t, half, 6), route.point(t, -half, 6)];
  faceDrawing(meshes, strokes, cut, 'vermilion', 13);
  for (let tooth = 0; tooth < 7; tooth++) {
    const w = lerp(-half + 2, half - 2, tooth / 6);
    const reach = 0.006 + 0.006 * (tooth % 3);
    stroke(strokes, tooth % 2 ? 'acid' : 'vermilion', [route.point(t, w, 6.3), route.point(t + towardGap * reach, w * 1.07, 8.4)]);
  }
}

function branches(route: BridgeRoute, ctx: SketchContext, meshes: THREE.BufferGeometry[], strokes: Stroke[]): void {
  const random = ctx.random('branch-growth');
  const recurse = (start: PagePoint, angle: number, length: number, generation: number, group: number): void => {
    const bend = (random() - 0.5) * 0.36;
    const finish = { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
    const mid = between(start, finish, 0.5);
    const curve: PagePoint[] = [start, between(start, mid, 0.5), { x: mid.x + Math.sin(angle) * bend * length, y: mid.y - Math.cos(angle) * bend * length }, between(mid, finish, 0.5), finish];
    const pen: Ink = generation === 0 ? 'carbon' : generation === 1 ? 'violet' : group % 3 === 0 ? 'acid' : 'ultramarine';
    const depth = -11 + generation * 1.1;
    stroke(strokes, pen, curve.map(point => route.pagePoint(point, depth + 0.15)));
    if (generation <= 1) {
      const width = (generation === 0 ? 5.5 : 2.2) * (0.75 + 0.5 * random());
      for (let index = 0; index < curve.length - 1; index++) {
        const a = curve[index], b = curve[index + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        const nx = -dy / distance, ny = dx / distance;
        const wa = width * (1 - index / 5), wb = width * (1 - (index + 1) / 5);
        const ribbon: Face = [
          route.pagePoint({ x: a.x - nx * wa, y: a.y - ny * wa }, depth),
          route.pagePoint({ x: b.x - nx * wb, y: b.y - ny * wb }, depth + 1.2),
          route.pagePoint({ x: b.x + nx * wb, y: b.y + ny * wb }, depth + 1.2),
          route.pagePoint({ x: a.x + nx * wa, y: a.y + ny * wa }, depth),
        ];
        faceDrawing(meshes, strokes, ribbon, generation === 0 ? 'violet' : 'ultramarine', generation === 0 ? 5 : 3, false);
        for (const side of [-1, 1]) stroke(strokes, generation === 0 ? 'carbon' : 'violet', [
          route.pagePoint({ x: a.x + side * nx * wa, y: a.y + side * ny * wa }, depth + 0.2),
          route.pagePoint({ x: b.x + side * nx * wb, y: b.y + side * ny * wb }, depth + 1.4),
        ]);
      }
    }
    if (generation >= 3) return;
    const nextLength = length * (0.47 + 0.12 * random());
    const spread = (0.25 + 0.28 * random()) * (generation % 2 === 0 ? 1 : 0.8);
    recurse(finish, angle - spread, nextLength, generation + 1, group);
    recurse(finish, angle + spread * 0.88, nextLength * 0.88, generation + 1, group);
  };
  for (let group = 0; group < route.branchCount; group++) {
    const fan = group / Math.max(1, route.branchCount - 1);
    const t = lerp(0.135, route.leftGap - 0.025, fan) + (random() - 0.5) * 0.015;
    const center = route.center(t), normal = route.normal(t);
    const start = {
      x: center.x + normal.x * (route.halfWidth(t) + 1) + route.branchOffset.x,
      y: center.y + normal.y * (route.halfWidth(t) + 1) + route.branchOffset.y,
    };
    const angle = Math.atan2(normal.y, normal.x) + (fan - 0.5) * 0.65 + (random() - 0.5) * 0.24;
    const length = (29 + random() * 17) * route.branchReach;
    recurse(start, angle, length, 0, group);
  }
}

function camera(): THREE.OrthographicCamera {
  const view = new THREE.OrthographicCamera(-PAGE.width / 2, PAGE.width / 2, PAGE.height / 2, -PAGE.height / 2, 0.1, 1000);
  view.position.set(185, -135, 330);
  view.lookAt(0, 0, 0);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
}

function pathLength(path: Point[]): number {
  let length = 0;
  for (let index = 1; index < path.length; index++) length += Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y);
  return length;
}

function economical(points: Point[]): Point[] {
  const result = [points[0]];
  for (let index = 1; index < points.length - 1; index++) {
    const last = result[result.length - 1];
    const current = points[index], next = points[index + 1];
    const span = Math.hypot(current.x - last.x, current.y - last.y);
    const cross = Math.abs((current.x - last.x) * (next.y - current.y) - (current.y - last.y) * (next.x - current.x));
    if (span > 1.1 || cross > 0.15) result.push(current);
  }
  result.push(points[points.length - 1]);
  return result;
}

export interface BridgeStats { candidateSegments: number; visibleSegments: number; hiddenSegments: number; meshCount: number; gap: [number, number]; projectedGapCenter: Point }
export interface BridgeDrawing { parts: Part[]; stats: BridgeStats }

/** One software depth pass handles every solid bridge member before line classification. */
export function drawBridge(ctx: SketchContext): BridgeDrawing {
  const route = new BridgeRoute(ctx);
  const meshes: THREE.BufferGeometry[] = [];
  const strokes: Stroke[] = [];
  const spans: [number, number][] = [[0.11, route.leftGap], [route.rightGap, 0.96]];
  let moduleIndex = 0;
  const portalVariation = ctx.random('portal-arrangement');
  for (const [spanIndex, [from, to]] of spans.entries()) {
    const sections = Math.max(4, Math.round((to - from) * 27));
    for (let index = 0; index < sections; index++) {
      deckSegment(route, meshes, strokes, lerp(from, to, index / sections), lerp(from, to, (index + 1) / sections), moduleIndex++);
    }
    const frames = spanIndex === 0 ? 2 : 3;
    for (let index = 0; index < frames; index++) {
      const station = lerp(from + 0.06, to - 0.06, (index + 0.13 + 0.18 * portalVariation()) / frames);
      portal(route, meshes, strokes, station, moduleIndex++, portalVariation());
    }
    buttress(route, meshes, strokes, lerp(from, to, spanIndex === 0 ? 0.58 : 0.17), spanIndex === 0 ? -1 : 1, 15 + portalVariation() * 12, 0.075, 14 + portalVariation() * 9);
    if (spanIndex === 1) buttress(route, meshes, strokes, lerp(from, to, 0.73), -1, 10 + portalVariation() * 8, 0.055, 18);
  }
  brokenEnd(route, meshes, strokes, route.leftGap, 1);
  brokenEnd(route, meshes, strokes, route.rightGap, -1);
  branches(route, ctx, meshes, strokes);

  const view = camera();
  try {
    const midpoint = route.point((route.leftGap + route.rightGap) / 2, 0, 6).project(view);
    const projectedGapCenter = { x: (midpoint.x * 0.5 + 0.5) * PAGE.width, y: (-midpoint.y * 0.5 + 0.5) * PAGE.height };
    const depth = renderDepthBufferCPU(meshes, view, VIEW_WIDTH, VIEW_HEIGHT);
    const projection = projectPolylinesClipped(strokes.map(item => item.points), view, VIEW_WIDTH, VIEW_HEIGHT);
    const pathsByPen = new Map<Ink, Point[][]>(INKS.map(pen => [pen, []]));
    let candidateSegments = 0;
    let visibleSegments = 0;
    for (let index = 0; index < projection.polylines.length; index++) {
      const pen = strokes[projection.sourceIndices[index]].pen;
      for (const clipped of clipProjectedPolyline(projection.polylines[index], VIEW_WIDTH, VIEW_HEIGHT)) {
        const dense = densifyProjectedPolyline(clipped);
        candidateSegments += dense.length - 1;
        const visibleRuns = ctx.params.occlusion === false ? [dense] : splitPolylineByDepth(dense, depth, 0.0012).visible;
        for (const visible of visibleRuns) {
          visibleSegments += visible.length - 1;
          const page = visible.map(point => ({ x: point.x / PIXELS_PER_MM, y: point.y / PIXELS_PER_MM }));
          for (const bounded of clipPolylineToRect(page, ART)) {
            if (pathLength(bounded) >= 0.55) pathsByPen.get(pen)!.push(economical(bounded));
          }
        }
      }
    }
    const parts: Part[] = INKS.map(pen => ({ id: `bridge-${pen}`, pen, paths: pathsByPen.get(pen)! }));
    return { parts, stats: { candidateSegments, visibleSegments, hiddenSegments: candidateSegments - visibleSegments, meshCount: meshes.length, gap: [route.leftGap, route.rightGap], projectedGapCenter } };
  } finally {
    for (const mesh of meshes) mesh.dispose();
  }
}
