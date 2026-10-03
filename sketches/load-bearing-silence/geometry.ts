import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../src/occlusion.ts';
import { clipPolylineToRect } from '../../src/utils/clip.ts';

type Ink = 'carbon' | 'ultramarine' | 'vermilion' | 'acid' | 'violet';
type PagePoint = { x: number; y: number };
type Stroke = { pen: Ink; points: THREE.Vector3[]; light?: boolean };
type Face = [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];

const PAGE = { width: 297, height: 420 };
const ART = { xMin: 18, xMax: 279, yMin: 76, yMax: 357 };
const PIXELS_PER_MM = 2;
const VIEW_WIDTH = PAGE.width * PIXELS_PER_MM;
const VIEW_HEIGHT = PAGE.height * PIXELS_PER_MM;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const cubic = (a: PagePoint, b: PagePoint, c: PagePoint, d: PagePoint, t: number): PagePoint => {
  const u = 1 - t;
  return { x: u*u*u*a.x + 3*u*u*t*b.x + 3*u*t*t*c.x + t*t*t*d.x,
    y: u*u*u*a.y + 3*u*u*t*b.y + 3*u*t*t*c.y + t*t*t*d.y };
};

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
  const ribbon = (start: PagePoint, angle: number, length: number, halfWidth: number, curvature: number, daughter: boolean): PagePoint => {
    const direction = (turn: number) => ({ x: Math.cos(angle + turn), y: Math.sin(angle + turn) });
    const first = direction(-curvature * 1.2), middle = direction(curvature * 1.55), last = direction(-curvature * 0.25);
    const controlA = { x: start.x + first.x * length * 0.36, y: start.y + first.y * length * 0.36 };
    const controlB = { x: start.x + middle.x * length * 0.81, y: start.y + middle.y * length * 0.81 };
    const end = { x: start.x + last.x * length, y: start.y + last.y * length };
    const divisions = 40;
    const section: { left: PagePoint; right: PagePoint; center: PagePoint; depth: number }[] = [];
    for (let index = 0; index <= divisions; index++) {
      const u = index / divisions;
      const center = cubic(start, controlA, controlB, end, u);
      const before = cubic(start, controlA, controlB, end, Math.max(0, u - 0.004));
      const after = cubic(start, controlA, controlB, end, Math.min(1, u + 0.004));
      const dx = after.x - before.x, dy = after.y - before.y;
      const norm = Math.max(0.00001, Math.hypot(dx, dy));
      const breadth = Math.max(0.2, halfWidth * Math.pow(Math.sin(Math.PI * (0.045 + u * 0.955)), 0.8));
      const nx = -dy / norm, ny = dx / norm;
      const depth = -11 + 8 * u + 1.4 * Math.sin(u * Math.PI);
      section.push({ center, depth,
        left: { x: center.x - nx * breadth, y: center.y - ny * breadth },
        right: { x: center.x + nx * breadth, y: center.y + ny * breadth } });
    }
    for (let index = 0; index < divisions; index++) {
      const a = section[index], b = section[index + 1];
      meshes.push(quadMesh([
        route.pagePoint(a.left, a.depth), route.pagePoint(b.left, b.depth),
        route.pagePoint(b.right, b.depth), route.pagePoint(a.right, a.depth),
      ]));
    }
    for (const side of ['left', 'right'] as const) {
      stroke(strokes, daughter ? 'violet' : 'carbon', section.map(item => route.pagePoint(item[side], item.depth + 0.27)));
    }
    const contourCount = daughter ? 11 : 30;
    for (let contour = 1; contour <= contourCount; contour++) {
      const fraction = contour / (contourCount + 1);
      const pen: Ink = daughter ? 'acid' : contour % 5 === 0 ? 'violet' : 'ultramarine';
      stroke(strokes, pen, section.map(item => route.pagePoint({
        x: lerp(item.left.x, item.right.x, fraction), y: lerp(item.left.y, item.right.y, fraction),
      }, item.depth + 0.3)));
    }
    for (let mark = 1; mark <= 5; mark++) {
      const index = Math.round(mark * divisions / 6);
      const item = section[index];
      stroke(strokes, daughter ? 'violet' : 'acid', [route.pagePoint(item.left, item.depth + 0.32), route.pagePoint(item.center, item.depth + 0.34), route.pagePoint(item.right, item.depth + 0.32)]);
    }
    return cubic(start, controlA, controlB, end, 0.62);
  };
  for (let group = 0; group < route.branchCount; group++) {
    const fan = group / Math.max(1, route.branchCount - 1);
    const t = lerp(0.15, route.leftGap - 0.025, fan) + (random() - 0.5) * 0.014;
    const center = route.center(t), normal = route.normal(t);
    const start = {
      x: center.x + normal.x * (route.halfWidth(t) + 1) + route.branchOffset.x,
      y: center.y + normal.y * (route.halfWidth(t) + 1) + route.branchOffset.y,
    };
    const angle = Math.atan2(normal.y, normal.x) + (fan - 0.5) * 0.9 + (random() - 0.5) * 0.16;
    const length = (53 + fan * 26 + random() * 10) * route.branchReach;
    const width = (8 + random() * 3) * (group % 3 === 1 ? 1.2 : 1);
    const curvature = route.chirality * (group % 2 === 0 ? 1 : -1) * (0.32 + random() * 0.22);
    const offshoot = ribbon(start, angle, length, width, curvature, false);
    if (group % 2 === 1) ribbon(offshoot, angle - 0.35 * route.chirality, length * 0.5, width * 0.48, -curvature * 1.2, true);
  }
}

/** Open, tapering contours imply light travelling through the absent load path. */
function lightRibbons(route: BridgeRoute, ctx: SketchContext, strokes: Stroke[]): void {
  const intensity = numeric(ctx, 'lightRibbons', 0.67, 0, 1);
  const count = Math.round(intensity * 6);
  if (count === 0) return;
  const random = ctx.random('silence-light');
  const middle = (route.leftGap + route.rightGap) / 2;
  const core = route.center(middle);
  const normal = route.normal(middle);
  const tangent = { x: normal.y, y: -normal.x };
  const focusOffset = 2 + random() * 1.1;
  const focus = { x: core.x + normal.x * focusOffset, y: core.y + normal.y * focusOffset };
  for (let index = 0; index < count; index++) {
    const fromLeft = index % 2 === 0;
    const sideIndex = Math.floor(index / 2);
    const lane = sideIndex === 0 ? -1 : sideIndex === 1 ? 1 : 0;
    const t = fromLeft ? route.leftGap - 0.002 : route.rightGap + 0.002;
    const root = route.center(t);
    const rootNormal = route.normal(t);
    const spread = lane * route.halfWidth(t) * 0.42;
    const start = { x: root.x + rootNormal.x * spread, y: root.y + rootNormal.y * spread };
    const approach = fromLeft ? -1 : 1;
    const endOffset = lane * (2.1 + random() * 0.4);
    const coreRadius = 3.2 + random() * 0.45;
    const end = {
      x: focus.x + normal.x * endOffset + approach * tangent.x * coreRadius,
      y: focus.y + normal.y * endOffset + approach * tangent.y * coreRadius,
    };
    const bend = lane * (5.2 + random() * 1.6);
    const controlA = { x: lerp(start.x, end.x, 0.27) + rootNormal.x * bend, y: lerp(start.y, end.y, 0.27) + rootNormal.y * bend };
    // The last quarter turns along the rim instead of striking one common point.
    const curl = 7.5 + random() * 1.3;
    const controlB = {
      x: end.x + approach * tangent.x * curl * 0.38 - normal.x * lane * curl * 0.92,
      y: end.y + approach * tangent.y * curl * 0.38 - normal.y * lane * curl * 0.92,
    };
    const pen: Ink = index % 3 === 0 ? 'acid' : index % 3 === 1 ? 'violet' : 'ultramarine';
    const rootWidth = 1.05 + 0.35 * random();
    for (const edge of [-1, 1]) {
      const points: THREE.Vector3[] = [];
      for (let sample = 0; sample <= 28; sample++) {
        const u = sample / 28;
        const center = cubic(start, controlA, controlB, end, u);
        const before = cubic(start, controlA, controlB, end, Math.max(0, u - 0.004));
        const after = cubic(start, controlA, controlB, end, Math.min(1, u + 0.004));
        const dx = after.x - before.x, dy = after.y - before.y;
        const length = Math.max(0.00001, Math.hypot(dx, dy));
        const width = rootWidth * Math.pow(1 - u, 1.6) + 0.07;
        points.push(route.pagePoint({ x: center.x - edge * dy / length * width, y: center.y + edge * dx / length * width }, 8.5 + 3.5 * u));
      }
      strokes.push({ pen, points, light: true });
    }
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
  lightRibbons(route, ctx, strokes);

  const view = camera();
  try {
    const midpoint = route.point((route.leftGap + route.rightGap) / 2, 0, 6).project(view);
    const projectedGapCenter = { x: (midpoint.x * 0.5 + 0.5) * PAGE.width, y: (-midpoint.y * 0.5 + 0.5) * PAGE.height };
    const depth = renderDepthBufferCPU(meshes, view, VIEW_WIDTH, VIEW_HEIGHT);
    const projection = projectPolylinesClipped(strokes.map(item => item.points), view, VIEW_WIDTH, VIEW_HEIGHT);
    const pathsByPen = new Map<Ink, Point[][]>(INKS.map(pen => [pen, []]));
    const lightByPen = new Map<Ink, Point[][]>(INKS.map(pen => [pen, []]));
    let candidateSegments = 0;
    let visibleSegments = 0;
    for (let index = 0; index < projection.polylines.length; index++) {
      const source = strokes[projection.sourceIndices[index]];
      const pen = source.pen;
      for (const clipped of clipProjectedPolyline(projection.polylines[index], VIEW_WIDTH, VIEW_HEIGHT)) {
        const dense = densifyProjectedPolyline(clipped);
        candidateSegments += dense.length - 1;
        const visibleRuns = ctx.params.occlusion === false ? [dense] : splitPolylineByDepth(dense, depth, 0.0012).visible;
        for (const visible of visibleRuns) {
          visibleSegments += visible.length - 1;
          const page = visible.map(point => ({ x: point.x / PIXELS_PER_MM, y: point.y / PIXELS_PER_MM }));
          for (const bounded of clipPolylineToRect(page, ART)) {
            if (pathLength(bounded) >= 0.55) (source.light ? lightByPen : pathsByPen).get(pen)!.push(economical(bounded));
          }
        }
      }
    }
    const parts: Part[] = [
      ...INKS.map(pen => ({ id: `bridge-${pen}`, pen, paths: pathsByPen.get(pen)! })),
      ...(['ultramarine', 'acid', 'violet'] as Ink[]).map(pen => ({ id: `light-${pen}`, pen, paths: lightByPen.get(pen)! })),
    ];
    return { parts, stats: { candidateSegments, visibleSegments, hiddenSegments: candidateSegments - visibleSegments, meshCount: meshes.length, gap: [route.leftGap, route.rightGap], projectedGapCenter } };
  } finally {
    for (const mesh of meshes) mesh.dispose();
  }
}
