import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../src/occlusion.ts';
import { clipPolylineToRect } from '../../src/utils/clip.ts';

type Ink = 'carbon' | 'ultramarine' | 'vermilion' | 'acid' | 'violet' | 'cyan' | 'coral' | 'gold';
type PagePoint = { x: number; y: number };
type Stroke = { pen: Ink; points: THREE.Vector3[]; light?: 'ribbon' | 'ray' };
type Face = [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];

const PAGE = { width: 297, height: 420 };
const ART = { xMin: 18, xMax: 279, yMin: 76, yMax: 357 };
const PIXELS_PER_MM = 2;
const VIEW_WIDTH = PAGE.width * PIXELS_PER_MM;
const VIEW_HEIGHT = PAGE.height * PIXELS_PER_MM;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'cyan', 'coral', 'gold'];
const LIGHT_INKS: Ink[] = ['cyan', 'coral', 'gold'];
type LightBounds = { xMin: number; xMax: number; yMin: number; yMax: number };

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
    const warp = numeric(ctx, 'routeWarp', 0, -38, 38);
    this.chirality = variation() < 0.5 ? -1 : 1;
    this.bend = { x: 144 + warp + this.chirality * (10 + variation() * 10), y: 206 + warp * 0.36 + this.chirality * (8 + variation() * 10) };
    const gapWidth = numeric(ctx, 'gapWidth', 0.28, 0.12, 0.48);
    const gapCenter = 0.49 + (variation() - 0.5) * 0.08;
    this.leftGap = gapCenter - gapWidth / 2;
    this.rightGap = gapCenter + gapWidth / 2;
    this.width = numeric(ctx, 'beamWidth', 25, 10, 48);
    this.portalScale = numeric(ctx, 'portalScale', 1.15, 0.35, 2.2);
    this.hatchPitch = numeric(ctx, 'hatchPitch', 1.35, 0.5, 4.2);
    this.branchReach = numeric(ctx, 'branchReach', 1, 0.25, 2);
    this.branchCount = Math.round(numeric(ctx, 'branchCount', 6, 0, 15));
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
      [0.1, 0.72], [0.17, 0.95], [this.leftGap - 0.02, 1.28], [this.leftGap, 1.2],
      [this.rightGap, 1.28], [this.rightGap + 0.04, 0.88], [0.85, 1.35], [0.96, 0.98],
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

/** Broken satellites share one center but differ in orbit, shear, and depth. */
function orbitalFragments(route: BridgeRoute, ctx: SketchContext, view: THREE.OrthographicCamera, meshes: THREE.BufferGeometry[], strokes: Stroke[]): void {
  const random = ctx.random('orbital-topology');
  const middle = (route.leftGap + route.rightGap) / 2;
  const center = route.center(middle);
  const anchor = route.point(middle, 0, 14).project(view);
  const centerProjection = { x: (anchor.x * 0.5 + 0.5) * PAGE.width, y: (-anchor.y * 0.5 + 0.5) * PAGE.height };
  const onPlane = (x: number, y: number) => new THREE.Vector3(x / PAGE.width * 2 - 1, 1 - y / PAGE.height * 2, anchor.z).unproject(view);
  const orbitShift = onPlane(centerProjection.x + numeric(ctx, 'singularityX', 0, -12, 12),
    centerProjection.y + numeric(ctx, 'singularityY', 0, -12, 12)).sub(onPlane(centerProjection.x, centerProjection.y));
  const fragmentation = numeric(ctx, 'orbitalFragmentation', 0.52, 0, 1);
  const irregularity = numeric(ctx, 'structuralIrregularity', 0.48, 0, 1);
  const density = numeric(ctx, 'structureDensity', 0.55, 0, 1);
  const palette = numeric(ctx, 'paletteVariation', 0.55, 0, 1);
  const count = Math.round(2 + density * 9 + fragmentation * 5);
  const phase = random() * Math.PI * 2;
  const point = (x: number, y: number, z: number) => route.pagePoint({ x, y }, z).add(orbitShift);
  for (let i = 0; i < count; i++) {
    const angle = phase + (i + (random() - 0.5) * irregularity * 0.8) * Math.PI * 2 / count;
    const radius = 43 + 31 * random() + 13 * fragmentation;
    const x = center.x + Math.cos(angle) * radius;
    const y = center.y + Math.sin(angle) * radius;
    const tangent = angle + Math.PI / 2 + (random() - 0.5) * irregularity * 1.5;
    const radial = angle + (random() - 0.5) * 0.6;
    const length = 13 + random() * (18 + 24 * density);
    const width = 3.8 + random() * (4 + 7 * density);
    const tx = Math.cos(tangent), ty = Math.sin(tangent);
    const nx = Math.cos(radial), ny = Math.sin(radial);
    const shear = (random() - 0.5) * irregularity * 11;
    const z = -9 + random() * 23;
    const face: Face = [
      point(x - tx * length / 2 - nx * width / 2, y - ty * length / 2 - ny * width / 2, z),
      point(x + tx * length / 2 - nx * width / 2 + shear, y + ty * length / 2 - ny * width / 2, z + 2),
      point(x + tx * length / 2 + nx * width / 2 + shear, y + ty * length / 2 + ny * width / 2, z + 2),
      point(x - tx * length / 2 + nx * width / 2, y - ty * length / 2 + ny * width / 2, z),
    ];
    const pen: Ink = random() < palette * 0.55 ? LIGHT_INKS[Math.floor(random() * LIGHT_INKS.length)] : i % 3 === 0 ? 'vermilion' : 'ultramarine';
    faceDrawing(meshes, strokes, face, pen, Math.round(5 + density * 13));
    if (i % 3 !== 1) {
      const thickness = 3 + random() * (3 + density * 7);
      faceDrawing(meshes, strokes, [face[1], face[2], face[2].clone().add(new THREE.Vector3(0, 0, -thickness)),
        face[1].clone().add(new THREE.Vector3(0, 0, -thickness))], i % 2 ? 'carbon' : pen, 3 + Math.round(density * 5));
    }
    // Interrupted orbit inscriptions make each slab face the same absent load.
    const arcRadius = radius + width * 1.7;
    const span = (0.20 + random() * 0.28) * (0.6 + density * 0.7);
    for (let rail = 0; rail < Math.round(1 + density * 4); rail++) {
      const rr = arcRadius + rail * 1.05;
      const points = Array.from({ length: 13 }, (_, k) => {
        const a = angle + (k / 12 - 0.5) * span;
        return point(center.x + Math.cos(a) * rr, center.y + Math.sin(a) * rr, z + 0.4);
      });
      stroke(strokes, rail % 3 === 0 && palette > 0.25 ? LIGHT_INKS[i % 3] : 'carbon', points);
    }
  }
}

/** Extend only the outer end of a light path toward the safe authored envelope. */
function extendLight(point: PagePoint, center: PagePoint, bounds: LightBounds, reach: number, progress: number): PagePoint {
  const dx = point.x - center.x, dy = point.y - center.y;
  const tx = Math.abs(dx) < 1e-9 ? Infinity : ((dx > 0 ? bounds.xMax : bounds.xMin) - center.x) / dx;
  const ty = Math.abs(dy) < 1e-9 ? Infinity : ((dy > 0 ? bounds.yMax : bounds.yMin) - center.y) / dy;
  const t = Math.min(tx, ty);
  if (!Number.isFinite(t) || t <= 0) return point;
  const eased = reach * progress * progress * progress;
  return { x: lerp(point.x, center.x + dx * t, eased), y: lerp(point.y, center.y + dy * t, eased) };
}

/** A seeded, smooth two-dimensional field leaves related gaps across neighboring rails. */
export function gapField(ctx: SketchContext, scale: number): (point: PagePoint) => number {
  const seed = Math.floor(ctx.random('silence-gap-field')() * 0xffffffff);
  const size = lerp(10, 42, scale);
  const hash = (x: number, y: number) => {
    let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + seed) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 0xffffffff;
  };
  return point => {
    const x = point.x / size, y = point.y / size;
    const ix = Math.floor(x), iy = Math.floor(y);
    const sx = (x - ix) ** 2 * (3 - 2 * (x - ix));
    const sy = (y - iy) ** 2 * (3 - 2 * (y - iy));
    return lerp(lerp(hash(ix, iy), hash(ix + 1, iy), sx),
      lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), sx), sy);
  };
}

export function lightRuns(points: PagePoint[], gapAmount: number, noise: (point: PagePoint) => number): PagePoint[][] {
  if (gapAmount <= 0) return [points];
  const runs: PagePoint[][] = [];
  let run: PagePoint[] = [];
  const threshold = 0.14 + gapAmount * 0.52;
  for (const point of points) {
    if (noise(point) < threshold) {
      if (run.length >= 2) runs.push(run);
      run = [];
    } else run.push(point);
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

/** Image-plane light shares the solid depth pass but never becomes an occluder. */
function lightGeometry(route: BridgeRoute, ctx: SketchContext, view: THREE.OrthographicCamera, strokes: Stroke[], bounds: LightBounds): PagePoint {
  const middle = (route.leftGap + route.rightGap) / 2;
  const anchor = route.point(middle, 0, 14).project(view);
  const center = {
    x: (anchor.x * 0.5 + 0.5) * PAGE.width + numeric(ctx, 'singularityX', 0, -12, 12),
    y: (-anchor.y * 0.5 + 0.5) * PAGE.height + numeric(ctx, 'singularityY', 0, -12, 12),
  };
  const onPlane = (point: PagePoint) => new THREE.Vector3(
    point.x / PAGE.width * 2 - 1, 1 - point.y / PAGE.height * 2, anchor.z,
  ).unproject(view);
  const random = ctx.random('silence-ribbon');
  const amount = numeric(ctx, 'lightRibbons', 0.42, 0, 1);
  const power = numeric(ctx, 'singularityPower', 0.55, 0, 1);
  const palette = numeric(ctx, 'paletteVariation', 0.55, 0, 1);
  const rails = ctx.params.ribbonEnabled === false || amount <= 0 ? 0 : Math.round(2 + amount * (25 + 47 * power));
  const width = numeric(ctx, 'ribbonWidth', 18, 3, 48);
  const bend = numeric(ctx, 'ribbonBend', 32, -85, 85);
  const pinch = numeric(ctx, 'ribbonPinch', 0.55, 0, 0.92);
  const extent = numeric(ctx, 'ribbonExtent', 118, 40, 160);
  const irregularity = numeric(ctx, 'lightIrregularity', 0.48, 0, 1);
  const sharedDrift = (random() - 0.5) * irregularity * 11;
  const twist = (random() - 0.5) * irregularity * 0.24;
  const kinks = [random() * 2 - 1, random() * 2 - 1];
  const shade = numeric(ctx, 'ribbonShade', 0.68, 0, 1);
  const gapAmount = numeric(ctx, 'lightGapAmount', 0.2, 0, 1);
  const noise = gapField(ctx, numeric(ctx, 'lightGapScale', 0.48, 0, 1));
  const ribbonTone = ctx.random('silence-ribbon-tone');
  const ribbonInk = ctx.random('silence-ribbon-ink');
  const ribbonReach = numeric(ctx, 'ribbonEdgeReach', 0.22, 0, 1);
  for (let rail = 0; rail < rails; rail++) {
    const uniformLane = rails === 1 ? 0 : (rail / (rails - 1) - 0.5) * 2;
    const lane = uniformLane * (1 - 0.38 * shade * (1 - Math.abs(uniformLane)));
    if (ribbonTone() < shade * 0.72 * Math.abs(uniformLane) ** 1.5) continue;
    for (const half of [-1, 1]) {
      // Lane-dependent termination preserves an unmarked paper core.
      const coreRadius = 0.045 + Math.abs(lane) * 0.025 + (half === 1 ? 0.009 : 0);
      const points: PagePoint[] = [];
      for (let sample = 0; sample <= 120; sample++) {
        const u = sample / 120;
        const t = half < 0 ? lerp(-1, -coreRadius, u) : lerp(coreRadius, 1, u);
        const breadth = Math.max(width * (1 - pinch * (1 - Math.abs(t))), 0.34 * (rails - 1));
        const field = bend * Math.sin(Math.PI * t) + sharedDrift * t + irregularity * 9 *
          (kinks[0] * Math.sin(2 * Math.PI * t) + kinks[1] * Math.sin(3 * Math.PI * t) * 0.4);
        const displaced = lane * breadth + field + lane * twist * extent * t;
        let x = center.x + t * extent * 0.77 + displaced * 0.79;
        let y = center.y + t * extent - displaced * 0.61;
        // The last quarter of each rail curves around the paper core; each
        // termination lands at a distinct angle instead of on a cut line.
        const curl = clamp((0.28 - Math.abs(t)) / 0.235, 0, 1);
        const eased = curl * curl * (3 - 2 * curl);
        const endAngle = (half < 0 ? -2.38 : 0.76) + lane * (0.68 + irregularity * 0.14);
        const endRadius = 8.5 + Math.abs(lane) * 3.5;
        x = lerp(x, center.x + Math.cos(endAngle) * endRadius, eased);
        y = lerp(y, center.y + Math.sin(endAngle) * endRadius, eased);
        points.push(extendLight({ x, y }, center, bounds, ribbonReach, half < 0 ? 1 - u : u));
      }
      const pick = ribbonInk();
      const pen: Ink = pick < 1 - palette * 0.18 ? 'cyan' : pick < 1 - palette * 0.07 ? 'coral' : 'gold';
      for (const run of lightRuns(points, gapAmount, noise)) strokes.push({ pen, points: run.map(onPlane), light: 'ribbon' });
    }
  }

  const rayCount = ctx.params.raysEnabled === false ? 0 : Math.round(numeric(ctx, 'rayCount', 34, 0, 120));
  const rayLength = numeric(ctx, 'rayLength', 66, 8, 125);
  const raySpread = numeric(ctx, 'raySpread', 310, 25, 360) * Math.PI / 180;
  const rayCurve = numeric(ctx, 'rayCurve', 0.25, -1.5, 1.5);
  const rayDensity = numeric(ctx, 'rayDensity', 0.62, 0, 1);
  const rayRandom = ctx.random('silence-rays');
  const rayReach = numeric(ctx, 'rayEdgeReach', 0.18, 0, 1);
  const fanCount = Math.max(2, Math.round(3 + 4 * irregularity));
  const fans = Array.from({ length: fanCount }, (_, i) => ({
    angle: -Math.PI * 0.75 + (i + 0.5) / fanCount * raySpread + (rayRandom() - 0.5) * 0.4,
    strength: 0.18 + rayRandom() * 0.82,
    width: 0.08 + rayRandom() * (0.18 + irregularity * 0.16),
  }));
  for (let ray = 0; ray < rayCount; ray++) {
    const fan = fans[Math.floor(rayRandom() * fans.length)];
    const angle = fan.angle + (rayRandom() - 0.5) * fan.width;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const normal = { x: -direction.y, y: direction.x };
    const inner = 8 + rayRandom() * 12;
    const length = rayLength * (0.25 + (0.45 + 0.75 * rayDensity) * rayRandom()) *
      (0.55 + power * 0.8) * (0.35 + 0.65 * fan.strength);
    const curvature = rayCurve * (0.6 + rayRandom() * 0.8) + (rayRandom() - 0.5) * irregularity * 0.55;
    const points: PagePoint[] = [];
    for (let sample = 0; sample <= 80; sample++) {
      const u = sample / 80;
      const radius = inner + length * u;
      const curve = curvature * length * u * u * 0.44;
      points.push(extendLight({ x: center.x + direction.x * radius + normal.x * curve,
        y: center.y + direction.y * radius + normal.y * curve }, center, bounds, rayReach, u));
    }
    const pick = rayRandom();
    const pen: Ink = pick < 1 - palette * 0.22 ? 'cyan' : pick < 1 - palette * 0.08 ? 'coral' : 'gold';
    for (const run of lightRuns(points, gapAmount, noise)) strokes.push({ pen, points: run.map(onPlane), light: 'ray' });
  }
  return center;
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

export interface BridgeStats { candidateSegments: number; visibleSegments: number; hiddenSegments: number; meshCount: number; gap: [number, number]; projectedGapCenter: Point; projectedSingularityCenter: Point }
export interface BridgeDrawing { parts: Part[]; stats: BridgeStats }

/** One software depth pass handles every solid bridge member before line classification. */
export function drawBridge(ctx: SketchContext, lightBounds: LightBounds = ART): BridgeDrawing {
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
  orbitalFragments(route, ctx, view, meshes, strokes);
  const projectedSingularityCenter = lightGeometry(route, ctx, view, strokes, lightBounds);
  try {
    const midpoint = route.point((route.leftGap + route.rightGap) / 2, 0, 6).project(view);
    const projectedGapCenter = { x: (midpoint.x * 0.5 + 0.5) * PAGE.width, y: (-midpoint.y * 0.5 + 0.5) * PAGE.height };
    const depth = renderDepthBufferCPU(meshes, view, VIEW_WIDTH, VIEW_HEIGHT);
    const projection = projectPolylinesClipped(strokes.map(item => item.points), view, VIEW_WIDTH, VIEW_HEIGHT);
    const pathsByPen = new Map<Ink, Point[][]>(INKS.map(pen => [pen, []]));
    const ribbonByPen = new Map<Ink, Point[][]>(INKS.map(pen => [pen, []]));
    const rayByPen = new Map<Ink, Point[][]>(INKS.map(pen => [pen, []]));
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
          for (const bounded of clipPolylineToRect(page, source.light ? lightBounds : ART)) {
            if (pathLength(bounded) >= 0.55) {
              const destination = source.light === 'ribbon' ? ribbonByPen : source.light === 'ray' ? rayByPen : pathsByPen;
              destination.get(pen)!.push(economical(bounded));
            }
          }
        }
      }
    }
    // The image-plane light can extend past the depth camera's fixed viewport.
    // There are no structural occluders there; retain those outer fragments so
    // the poster fit and finishing can crop them at the true framed boundary.
    const outside = [
      { xMin: lightBounds.xMin, xMax: lightBounds.xMax, yMin: lightBounds.yMin, yMax: 0 },
      { xMin: lightBounds.xMin, xMax: lightBounds.xMax, yMin: PAGE.height - 1 / PIXELS_PER_MM, yMax: lightBounds.yMax },
      { xMin: lightBounds.xMin, xMax: 0, yMin: 0, yMax: PAGE.height },
      { xMin: PAGE.width - 1 / PIXELS_PER_MM, xMax: lightBounds.xMax, yMin: 0, yMax: PAGE.height },
    ].filter(rect => rect.xMax > rect.xMin && rect.yMax > rect.yMin);
    for (const source of strokes) {
      if (!source.light) continue;
      const page = source.points.map(point => {
        const projected = point.clone().project(view);
        return { x: (projected.x * 0.5 + 0.5) * PAGE.width,
          y: (-projected.y * 0.5 + 0.5) * PAGE.height };
      });
      const destination = source.light === 'ribbon' ? ribbonByPen : rayByPen;
      for (const strip of outside) for (const bounded of clipPolylineToRect(page, strip)) {
        if (pathLength(bounded) >= 0.55) destination.get(source.pen)!.push(economical(bounded));
      }
    }
    const parts: Part[] = [
      ...INKS.map(pen => ({ id: `bridge-${pen}`, pen, paths: pathsByPen.get(pen)! })),
      ...LIGHT_INKS.map(pen => ({ id: `ribbon-${pen}`, pen, paths: ribbonByPen.get(pen)! })),
      ...LIGHT_INKS.map(pen => ({ id: `ray-${pen}`, pen, paths: rayByPen.get(pen)! })),
    ];
    return { parts, stats: { candidateSegments, visibleSegments, hiddenSegments: candidateSegments - visibleSegments, meshCount: meshes.length, gap: [route.leftGap, route.rightGap], projectedGapCenter, projectedSingularityCenter } };
  } finally {
    for (const mesh of meshes) mesh.dispose();
  }
}
