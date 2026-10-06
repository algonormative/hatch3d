// Forked from sketches/load-bearing-silence/geometry.ts (left untouched). The
// span variant authors in Tabloid page millimetres, routes the broken bridge
// corner to corner along the long diagonal, and keeps a larger empty core.
import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../src/occlusion.ts';
import { clipPolylineToRect } from '../../src/utils/clip.ts';
import { createAtmosphere, hatchAtmosphere, maskAtmospherePaths } from '../../packages/plot-core/src/atmosphere.ts';

export type Ink = 'carbon' | 'ultramarine' | 'vermilion' | 'acid' | 'violet' | 'cyan' | 'coral' | 'gold';
type PagePoint = { x: number; y: number };
type Stroke = { pen: Ink; points: THREE.Vector3[]; light?: 'ribbon' | 'ray' };
type Face = [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];

/** Tabloid sheet; the art window is the TALL_ART envelope in page millimetres. */
export const PAGE = { width: 279.4, height: 431.8 };
export const ART = { xMin: 18, xMax: 261.4, yMin: 18, yMax: 413.8 };
const PIXELS_PER_MM = 2;
export const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'cyan', 'coral', 'gold'];
const LIGHT_INKS: Ink[] = ['cyan', 'coral', 'gold'];
export type LightBounds = { xMin: number; xMax: number; yMin: number; yMax: number };
type Viewport = { width: number; height: number; offsetX: number; offsetY: number };

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const VIEWPORT: Viewport = { width: PAGE.width, height: PAGE.height, offsetX: 0, offsetY: 0 };
const pageFromNdc = (point: THREE.Vector3, viewport: Viewport): PagePoint => ({
  x: (point.x * 0.5 + 0.5) * viewport.width - viewport.offsetX,
  y: (-point.y * 0.5 + 0.5) * viewport.height - viewport.offsetY,
});
const planeFromPage = (point: PagePoint, depth: number, view: THREE.OrthographicCamera, viewport: Viewport): THREE.Vector3 =>
  new THREE.Vector3((point.x + viewport.offsetX) / viewport.width * 2 - 1,
    1 - (point.y + viewport.offsetY) / viewport.height * 2, depth).unproject(view);
const cubic = (a: PagePoint, b: PagePoint, c: PagePoint, d: PagePoint, t: number): PagePoint => {
  const u = 1 - t;
  return { x: u*u*u*a.x + 3*u*u*t*b.x + 3*u*t*t*c.x + t*t*t*d.x,
    y: u*u*u*a.y + 3*u*u*t*b.y + 3*u*t*t*c.y + t*t*t*d.y };
};

function numeric(ctx: SketchContext, id: string, fallback: number, low: number, high: number): number {
  const value = ctx.params[id];
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, low, high) : fallback;
}

/** Where a projected page point lands on the world z = height plane (the camera is orthographic). */
function authoredFromProjected(point: PagePoint, view: THREE.OrthographicCamera, height = 0): PagePoint {
  const nx = point.x / VIEWPORT.width * 2 - 1, ny = 1 - point.y / VIEWPORT.height * 2;
  const near = new THREE.Vector3(nx, ny, -1).unproject(view);
  const far = new THREE.Vector3(nx, ny, 1).unproject(view);
  const world = near.lerp(far, (height - near.z) / (far.z - near.z));
  return { x: world.x + PAGE.width / 2, y: PAGE.height / 2 - world.y };
}

/** Route geometry is evaluated once and shared by solids, portals, and missing-end cuts. */
class BridgeRoute {
  readonly leftGap: number;
  readonly rightGap: number;
  readonly width: number;
  readonly mass: number;
  readonly deckBottom: number;
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
  /** Projected corner anchors, for tests and diagnostics. */
  readonly projectedStart: PagePoint;
  readonly projectedEnd: PagePoint;

  constructor(ctx: SketchContext, view: THREE.OrthographicCamera) {
    const variation = ctx.random('span-route');
    // Corner to corner on the projected page, overshooting the frame so the remnants press into it.
    const angle = numeric(ctx, 'spanAngle', 0, -14, 14) * Math.PI / 180;
    const pivot = { x: (ART.xMin + ART.xMax) / 2, y: (ART.yMin + ART.yMax) / 2 };
    const rotate = (p: PagePoint): PagePoint => {
      const dx = p.x - pivot.x, dy = p.y - pivot.y;
      return { x: pivot.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: pivot.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
    };
    const start = rotate({ x: ART.xMin - 6 + 10 * variation(), y: ART.yMax + 14 - 12 * variation() });
    const end = rotate({ x: ART.xMax + 6 - 10 * variation(), y: ART.yMin - 14 + 12 * variation() });
    this.chirality = variation() < 0.5 ? -1 : 1;
    const warp = numeric(ctx, 'routeWarp', 0, -40, 40);
    const along = { x: end.x - start.x, y: end.y - start.y };
    const length = Math.hypot(along.x, along.y);
    const perp = { x: -along.y / length, y: along.x / length };
    // A quadratic control offset of 2k bows the midpoint by k.
    const bow = 2 * (this.chirality * (10 + variation() * 16) + warp);
    const bend = { x: (start.x + end.x) / 2 + perp.x * bow, y: (start.y + end.y) / 2 + perp.y * bow };
    this.projectedStart = start;
    this.projectedEnd = end;
    this.start = authoredFromProjected(start, view);
    this.bend = authoredFromProjected(bend, view);
    this.end = authoredFromProjected(end, view);
    const gapWidth = numeric(ctx, 'gapWidth', 0.18, 0.12, 0.36);
    const gapCenter = 0.5 + (variation() - 0.5) * 0.06;
    this.leftGap = gapCenter - gapWidth / 2;
    this.rightGap = gapCenter + gapWidth / 2;
    this.mass = numeric(ctx, 'remnantMass', 0.7, 0, 1);
    this.width = numeric(ctx, 'beamWidth', 42, 20, 64);
    this.deckBottom = -15 - 16 * this.mass;
    this.portalScale = numeric(ctx, 'portalScale', 1.3, 0.5, 2.4) * (0.75 + 0.6 * this.mass);
    this.hatchPitch = numeric(ctx, 'hatchPitch', 0.9, 0.6, 3);
    this.branchReach = numeric(ctx, 'branchReach', 1.1, 0.4, 2.2);
    this.branchCount = Math.round(numeric(ctx, 'branchCount', 2, 0, 8));
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

  /** Authored length of the route between two stations, in millimetres. */
  span(from: number, to: number): number {
    let total = 0;
    let last = this.center(from);
    for (let i = 1; i <= 12; i++) {
      const next = this.center(lerp(from, to, i / 12));
      total += Math.hypot(next.x - last.x, next.y - last.y);
      last = next;
    }
    return total;
  }

  normal(t: number): PagePoint {
    const dx = 2 * (1 - t) * (this.bend.x - this.start.x) + 2 * t * (this.end.x - this.bend.x);
    const dy = 2 * (1 - t) * (this.bend.y - this.start.y) + 2 * t * (this.end.y - this.bend.y);
    const length = Math.hypot(dx, dy);
    return { x: -dy / length, y: dx / length };
  }

  /** Heavy rupture shoulders and swollen outer piers break the rectangular outline. */
  halfWidth(t: number): number {
    const profile: [number, number][] = [
      [0, 1.05], [0.12, 0.86], [0.24, 1.08], [this.leftGap - 0.03, 1.3], [this.leftGap, 1.16],
      [this.rightGap, 1.3], [this.rightGap + 0.05, 0.9], [0.8, 1.22], [0.9, 0.92], [1, 1.04],
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

/** Hatch count for a pitch measured along the face's u edge (a→b), capped for very long faces. */
function pitchCount(face: Face, pitch: number, minimum = 4): number {
  const along = Math.max(face[0].distanceTo(face[1]), face[3].distanceTo(face[2]));
  return clamp(Math.round(along / pitch), minimum, 160);
}

function faceDrawing(meshes: THREE.BufferGeometry[], strokes: Stroke[], face: Face, pen: Ink, hatchCount: number, border = true): void {
  meshes.push(quadMesh(face));
  if (border) {
    for (let side = 0; side < 4; side++) stroke(strokes, 'carbon', [face[side], face[(side + 1) % 4]]);
  }
  // Alternating sway keeps the zig-zag rhythm, scaled to the pitch so neighbours never close below half a pitch.
  const sway = 0.22 / (hatchCount + 1);
  for (let index = 1; index <= hatchCount; index++) {
    const u = index / (hatchCount + 1);
    const lean = index % 2 === 0 ? sway : -sway;
    stroke(strokes, pen, [bilinear(face, clamp(u - lean, 0, 1), 0.015, 0.06), bilinear(face, clamp(u + lean, 0, 1), 0.985, 0.06)]);
  }
}

function deckSegment(route: BridgeRoute, meshes: THREE.BufferGeometry[], strokes: Stroke[], from: number, to: number, index: number, hot = false): void {
  const nearHalf = route.halfWidth(from), farHalf = route.halfWidth(to);
  const top: Face = [route.point(from, -nearHalf, 6), route.point(to, -farHalf, 6), route.point(to, farHalf, 6), route.point(from, nearHalf, 6)];
  const sectionLength = route.span(from, to);
  // The shoulders that face the missing span run hot: vermilion hatch at the fracture, nowhere else.
  faceDrawing(meshes, strokes, top, hot ? 'vermilion' : index % 3 === 1 ? 'ultramarine' : 'carbon', Math.max(5, Math.round(sectionLength / route.hatchPitch)));
  const bottom = route.deckBottom;
  for (const side of [-1, 1]) {
    const outer: Face = [
      route.point(from, side * nearHalf, bottom), route.point(to, side * farHalf, bottom),
      route.point(to, side * farHalf, 6), route.point(from, side * nearHalf, 6),
    ];
    faceDrawing(meshes, strokes, outer, index % 3 === 0 ? 'violet' : 'carbon', Math.max(5, Math.round(sectionLength / (route.hatchPitch * 1.1))));
    const rail = Array.from({ length: 7 }, (_, sample) => {
      const t = lerp(from, to, sample / 6);
      return route.point(t, side * (route.halfWidth(t) + 2.6), 12);
    });
    stroke(strokes, 'ultramarine', rail);
    for (const t of [from, to]) stroke(strokes, 'carbon', [route.point(t, side * route.halfWidth(t), bottom), route.point(t, side * (route.halfWidth(t) + 2.6), 12)]);
  }
  // Heavy internal webbing remains legible against the fine hatch rhythm.
  stroke(strokes, index % 3 === 1 ? 'vermilion' : 'carbon', [route.point(from, -nearHalf + 2, 6.1), route.point(to, farHalf - 2, 6.1)]);
  stroke(strokes, 'carbon', [route.point(from, nearHalf - 2, 6.1), route.point(to, -farHalf + 2, 6.1)]);
}

function buttress(route: BridgeRoute, meshes: THREE.BufferGeometry[], strokes: Stroke[], t: number, side: number, reach: number, length: number, rise: number): void {
  const from = t - length * 0.5, to = t + length * 0.5;
  const near = route.halfWidth(from), far = route.halfWidth(to);
  const lean = 0.012;
  const ledge: Face = [
    route.point(from, side * near, rise), route.point(to, side * far, rise),
    route.point(to + lean, side * (far + reach), rise + 2), route.point(from + lean, side * (near + reach), rise + 2),
  ];
  faceDrawing(meshes, strokes, ledge, 'carbon', pitchCount(ledge, route.hatchPitch, 8));
  const underside: Face = [
    route.point(from + lean, side * (near + reach), route.deckBottom - 4), route.point(to + lean, side * (far + reach), route.deckBottom - 4),
    route.point(to + lean, side * (far + reach), rise + 2), route.point(from + lean, side * (near + reach), rise + 2),
  ];
  faceDrawing(meshes, strokes, underside, 'ultramarine', pitchCount(underside, route.hatchPitch * 1.2, 7));
  stroke(strokes, 'vermilion', [route.point(from, side * near, rise + 0.2), route.point(to + lean, side * (far + reach), rise + 2.2)]);
  for (const at of [from, to]) {
    stroke(strokes, 'carbon', [route.point(at, side * route.halfWidth(at), route.deckBottom), route.point(at + lean, side * (route.halfWidth(at) + reach), rise + 2)]);
  }
}

function portal(route: BridgeRoute, meshes: THREE.BufferGeometry[], strokes: Stroke[], t: number, index: number, variation: number): void {
  const side = index % 3 === 0 ? -1 : 1;
  const outer = route.halfWidth(t) + (17 + variation * 10) * route.portalScale;
  const inner = route.halfWidth(t) + 3;
  const front = t - (0.018 + variation * 0.008);
  const back = t + (0.026 + variation * 0.008);
  const z = (19 + variation * 18 + (index % 2) * 5) * (0.8 + 0.5 * route.mass);
  const pitch = route.hatchPitch * 1.25;
  // High asymmetric cheek, occasional opposing fragment, and an incomplete lintel.
  const cheek: Face = [
    route.point(front, side * outer, z), route.point(back, side * outer * 0.88, z + 5),
    route.point(back, side * inner, z + 5), route.point(front, side * inner, z),
  ];
  faceDrawing(meshes, strokes, cheek, index % 3 === 0 ? 'vermilion' : 'carbon', pitchCount(cheek, pitch, 10));
  const lintel: Face = [
    route.point(back - 0.008, -side * inner, z - 3), route.point(back + 0.004, -side * inner, z - 3),
    route.point(back + 0.004, side * outer * 0.7, z + 4), route.point(back - 0.008, side * outer * 0.7, z + 4),
  ];
  faceDrawing(meshes, strokes, lintel, index % 2 === 0 ? 'acid' : 'ultramarine', pitchCount(lintel, pitch, 6));
  if (index % 3 !== 1) {
    const remote = outer + 5 + variation * 5;
    const fragment: Face = [
      route.point(front - 0.01, -side * remote, z - 11), route.point(front + 0.006, -side * remote, z - 11),
      route.point(back + 0.008, -side * (remote - 5), z + 2), route.point(back - 0.006, -side * (remote - 5), z + 2),
    ];
    faceDrawing(meshes, strokes, fragment, 'violet', pitchCount(fragment, pitch, 6));
  }
  for (const at of [front, back]) {
    stroke(strokes, 'carbon', [route.point(at, side * inner, route.deckBottom), route.point(at, side * outer, z)]);
  }
}

function brokenEnd(route: BridgeRoute, meshes: THREE.BufferGeometry[], strokes: Stroke[], t: number, towardGap: number): void {
  const half = route.halfWidth(t);
  const cut: Face = [route.point(t, -half, route.deckBottom), route.point(t, half, route.deckBottom), route.point(t, half, 6), route.point(t, -half, 6)];
  faceDrawing(meshes, strokes, cut, 'vermilion', pitchCount(cut, route.hatchPitch * 1.6, 13));
  const teeth = 9;
  for (let tooth = 0; tooth < teeth; tooth++) {
    const w = lerp(-half + 2, half - 2, tooth / (teeth - 1));
    const reach = 0.004 + 0.004 * (tooth % 3);
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
    const divisions = 48;
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
      const depth = route.deckBottom + 4 + 8 * u + 1.4 * Math.sin(u * Math.PI);
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
    // Contour count follows width so lamellae stay near a 1 mm pitch at the widest point.
    const contourCount = Math.max(6, Math.round(2 * halfWidth / (daughter ? 1.5 : 1.05)));
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
    const t = lerp(0.16, route.leftGap - 0.06, fan) + (random() - 0.5) * 0.014;
    const center = route.center(t), normal = route.normal(t);
    const start = {
      x: center.x + normal.x * (route.halfWidth(t) + 1) + route.branchOffset.x,
      y: center.y + normal.y * (route.halfWidth(t) + 1) + route.branchOffset.y,
    };
    const angle = Math.atan2(normal.y, normal.x) + (fan - 0.5) * 0.9 + (random() - 0.5) * 0.16;
    const length = (70 + fan * 34 + random() * 14) * route.branchReach;
    const width = (11 + random() * 4) * (group % 3 === 1 ? 1.2 : 1);
    const curvature = route.chirality * (group % 2 === 0 ? 1 : -1) * (0.32 + random() * 0.22);
    const offshoot = ribbon(start, angle, length, width, curvature, false);
    if (group % 2 === 1) ribbon(offshoot, angle - 0.35 * route.chirality, length * 0.5, width * 0.48, -curvature * 1.2, true);
  }
}

/** Few, large broken satellites share the missing span's center but differ in orbit, shear, and depth. */
function orbitalFragments(route: BridgeRoute, ctx: SketchContext, view: THREE.OrthographicCamera, meshes: THREE.BufferGeometry[], strokes: Stroke[], coreRadius: number): void {
  const random = ctx.random('orbital-topology');
  const middle = (route.leftGap + route.rightGap) / 2;
  const center = route.center(middle);
  const anchor = route.point(middle, 0, 14).project(view);
  const centerProjection = pageFromNdc(anchor, VIEWPORT);
  const onPlane = (x: number, y: number) => planeFromPage({ x, y }, anchor.z, view, VIEWPORT);
  const orbitShift = onPlane(centerProjection.x + numeric(ctx, 'singularityX', 0, -16, 16),
    centerProjection.y + numeric(ctx, 'singularityY', 0, -16, 16)).sub(onPlane(centerProjection.x, centerProjection.y));
  const fragmentation = numeric(ctx, 'orbitalFragmentation', 0.4, 0, 1);
  const irregularity = numeric(ctx, 'structuralIrregularity', 0.45, 0, 1);
  const density = numeric(ctx, 'structureDensity', 0.5, 0, 1);
  const palette = numeric(ctx, 'paletteVariation', 0.5, 0, 1);
  const pitch = route.hatchPitch * 1.3;
  const count = Math.round(2 + density * 4 + fragmentation * 3);
  const phase = random() * Math.PI * 2;
  const point = (x: number, y: number, z: number) => route.pagePoint({ x, y }, z).add(orbitShift);
  for (let i = 0; i < count; i++) {
    const angle = phase + (i + (random() - 0.5) * irregularity * 0.8) * Math.PI * 2 / count;
    // Authored radius is divided by the worst-case foreshortening so slabs stay clear of the projected core.
    const radius = (coreRadius + 10 + 22 * random() + 14 * fragmentation) / 0.8;
    const x = center.x + Math.cos(angle) * radius;
    const y = center.y + Math.sin(angle) * radius;
    const tangent = angle + Math.PI / 2 + (random() - 0.5) * irregularity * 1.5;
    const radial = angle + (random() - 0.5) * 0.6;
    const length = 22 + random() * (24 + 34 * density);
    const width = 6 + random() * (6 + 10 * density);
    const tx = Math.cos(tangent), ty = Math.sin(tangent);
    const nx = Math.cos(radial), ny = Math.sin(radial);
    const shear = (random() - 0.5) * irregularity * 14;
    const z = -9 + random() * 23;
    const face: Face = [
      point(x - tx * length / 2 - nx * width / 2, y - ty * length / 2 - ny * width / 2, z),
      point(x + tx * length / 2 - nx * width / 2 + shear, y + ty * length / 2 - ny * width / 2, z + 2),
      point(x + tx * length / 2 + nx * width / 2 + shear, y + ty * length / 2 + ny * width / 2, z + 2),
      point(x - tx * length / 2 + nx * width / 2, y - ty * length / 2 + ny * width / 2, z),
    ];
    const pen: Ink = random() < palette * 0.55 ? LIGHT_INKS[Math.floor(random() * LIGHT_INKS.length)] : i % 3 === 0 ? 'vermilion' : 'ultramarine';
    faceDrawing(meshes, strokes, face, pen, pitchCount(face, pitch, 6));
    if (i % 3 !== 1) {
      const thickness = 4 + random() * (4 + density * 9);
      const edge: Face = [face[1], face[2], face[2].clone().add(new THREE.Vector3(0, 0, -thickness)),
        face[1].clone().add(new THREE.Vector3(0, 0, -thickness))];
      faceDrawing(meshes, strokes, edge, i % 2 ? 'carbon' : pen, pitchCount(edge, pitch, 3));
    }
    // Interrupted orbit inscriptions make each slab face the same absent load.
    const arcRadius = radius + width * 1.4;
    const span = (0.18 + random() * 0.24) * (0.6 + density * 0.7);
    for (let rail = 0; rail < Math.round(2 + density * 3); rail++) {
      const rr = arcRadius + rail * 1.2;
      const points = Array.from({ length: 25 }, (_, k) => {
        const a = angle + (k / 24 - 0.5) * span;
        return point(center.x + Math.cos(a) * rr, center.y + Math.sin(a) * rr, z + 0.4);
      });
      stroke(strokes, rail % 3 === 0 && palette > 0.25 ? LIGHT_INKS[i % 3] : 'carbon', points);
    }
  }
}

/** Extend only the outer end of a light path toward the frame. */
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
  const size = lerp(10, 48, scale);
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
function lightGeometry(route: BridgeRoute, ctx: SketchContext, view: THREE.OrthographicCamera, strokes: Stroke[], bounds: LightBounds, coreRadius: number): PagePoint {
  const middle = (route.leftGap + route.rightGap) / 2;
  const anchor = route.point(middle, 0, 14).project(view);
  const projected = pageFromNdc(anchor, VIEWPORT);
  const center = { x: projected.x + numeric(ctx, 'singularityX', 0, -16, 16),
    y: projected.y + numeric(ctx, 'singularityY', 0, -16, 16) };
  const onPlane = (point: PagePoint) => planeFromPage(point, anchor.z, view, VIEWPORT);
  const random = ctx.random('silence-ribbon');
  const amount = numeric(ctx, 'lightRibbons', 0.62, 0, 1);
  const power = numeric(ctx, 'singularityPower', 0.7, 0, 1);
  const palette = numeric(ctx, 'paletteVariation', 0.5, 0, 1);
  const rails = ctx.params.ribbonEnabled === false || amount <= 0 ? 0 : Math.round(2 + amount * (25 + 47 * power));
  const width = numeric(ctx, 'ribbonWidth', 26, 6, 56);
  const bend = numeric(ctx, 'ribbonBend', 36, -100, 100);
  const pinch = numeric(ctx, 'ribbonPinch', 0.55, 0, 0.92);
  const extent = numeric(ctx, 'ribbonExtent', 150, 60, 220);
  const irregularity = numeric(ctx, 'lightIrregularity', 0.45, 0, 1);
  const sharedDrift = (random() - 0.5) * irregularity * 14;
  const twist = (random() - 0.5) * irregularity * 0.24;
  const kinks = [random() * 2 - 1, random() * 2 - 1];
  const shade = numeric(ctx, 'ribbonShade', 0.7, 0, 1);
  const gapAmount = numeric(ctx, 'lightGapAmount', 0.32, 0, 1);
  const noise = gapField(ctx, numeric(ctx, 'lightGapScale', 0.6, 0, 1));
  const ribbonTone = ctx.random('silence-ribbon-tone');
  const ribbonInk = ctx.random('silence-ribbon-ink');
  const ribbonReach = numeric(ctx, 'ribbonEdgeReach', 0.6, 0, 1);
  // The sheet parts around the core like flow around a pier: rails keep their order and
  // spacing, and the two bundles are pushed apart by a smooth bump centred on the void.
  const pier = (coreRadius + 2.5) / 0.95;
  for (let rail = 0; rail < rails; rail++) {
    const uniformLane = rails === 1 ? 0 : (rail / (rails - 1) - 0.5) * 2;
    const lane = uniformLane * (1 - 0.38 * shade * (1 - Math.abs(uniformLane)));
    if (ribbonTone() < shade * 0.72 * Math.abs(uniformLane) ** 1.5) continue;
    const side = rail < (rails - 1) / 2 ? -1 : 1;
    const points: PagePoint[] = [];
    for (let sample = 0; sample <= 320; sample++) {
      const u = sample / 320;
      const t = lerp(-1, 1, u);
      const along = t * extent * 1.262;
      // The lens widens the minimum breadth so parted rails still keep a plotted gap of ~0.5 mm.
      const breadth = Math.max(width * (1 - pinch * (1 - Math.abs(t))), 0.55 * (rails - 1));
      const calm = 1 - Math.exp(-((along / (1.6 * pier)) ** 2));
      const field = calm * (bend * Math.sin(Math.PI * t) + sharedDrift * t + irregularity * 11 *
        (kinks[0] * Math.sin(2 * Math.PI * t) + kinks[1] * Math.sin(3 * Math.PI * t) * 0.4));
      const lensed = side * pier * Math.exp(-((along / (1.1 * pier)) ** 2));
      const displaced = lane * breadth + field + lane * twist * extent * t + lensed;
      const x = center.x + t * extent * 0.77 + displaced * 0.79;
      const y = center.y + t * extent - displaced * 0.61;
      points.push(extendLight({ x, y }, center, bounds, ribbonReach, Math.abs(t)));
    }
    const pick = ribbonInk();
    const pen: Ink = pick < 1 - palette * 0.18 ? 'cyan' : pick < 1 - palette * 0.07 ? 'coral' : 'gold';
    for (const run of lightRuns(points, gapAmount, noise)) strokes.push({ pen, points: run.map(onPlane), light: 'ribbon' });
  }

  const rayCount = ctx.params.raysEnabled === false ? 0 : Math.round(numeric(ctx, 'rayCount', 96, 0, 160));
  const rayLength = numeric(ctx, 'rayLength', 170, 20, 260);
  const raySpread = numeric(ctx, 'raySpread', 300, 25, 360) * Math.PI / 180;
  const rayCurve = numeric(ctx, 'rayCurve', 0.2, -1.5, 1.5);
  const rayDensity = numeric(ctx, 'rayDensity', 0.7, 0, 1);
  const rayRandom = ctx.random('silence-rays');
  const rayReach = numeric(ctx, 'rayEdgeReach', 0.85, 0, 1);
  const fanCount = Math.max(2, Math.round(2 + 4 * irregularity));
  const fans = Array.from({ length: fanCount }, (_, i) => ({
    angle: -Math.PI * 0.75 + (i + 0.5) / fanCount * raySpread + (rayRandom() - 0.5) * 0.4,
    strength: 0.18 + rayRandom() * 0.82,
    width: 0.3 + rayRandom() * (0.3 + irregularity * 0.3),
  }));
  const members = Array.from({ length: rayCount }, () => Math.floor(rayRandom() * fans.length));
  const sizes = fans.map((_, f) => members.filter(m => m === f).length);
  const seen = fans.map(() => 0);
  // Rays are stratified across their fan's width, so a fan reads as a deliberate spread rather than clumps.
  const rays = members.map(f => {
    const fan = fans[f];
    const slot = (seen[f]++ + 0.5 + (rayRandom() - 0.5) * 0.5) / sizes[f];
    return {
      angle: fan.angle + (slot - 0.5) * fan.width,
      inner: coreRadius + 3 + rayRandom() * 16,
      length: rayLength * (0.45 + (0.35 + 0.6 * rayDensity) * rayRandom()) * (0.6 + power * 0.6) * (0.5 + 0.5 * fan.strength),
      curvature: rayCurve * (0.6 + rayRandom() * 0.8) + (rayRandom() - 0.5) * irregularity * 0.55,
      pick: rayRandom(),
    };
  });
  // A ray that crowds its angular neighbour starts further out, so converging fans stay ~0.6 mm apart.
  const wrap = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  for (const [index, ray] of rays.entries()) {
    let nearest = Infinity;
    for (const [other, neighbour] of rays.entries()) {
      if (other === index) continue;
      const d = Math.abs(wrap(neighbour.angle) - wrap(ray.angle));
      nearest = Math.min(nearest, d, 2 * Math.PI - d);
    }
    if (nearest < Infinity) ray.inner = Math.max(ray.inner, 0.6 / Math.max(nearest, 1e-6));
  }
  for (const ray of rays) {
    if (ray.inner > coreRadius + 3 + ray.length * 0.6) continue;
    const direction = { x: Math.cos(ray.angle), y: Math.sin(ray.angle) };
    const normal = { x: -direction.y, y: direction.x };
    const points: PagePoint[] = [];
    for (let sample = 0; sample <= 100; sample++) {
      const u = sample / 100;
      const radius = ray.inner + ray.length * u;
      const curve = ray.curvature * ray.length * u * u * 0.44;
      points.push(extendLight({ x: center.x + direction.x * radius + normal.x * curve,
        y: center.y + direction.y * radius + normal.y * curve }, center, bounds, rayReach, u));
    }
    const pen: Ink = ray.pick < 1 - palette * 0.22 ? 'cyan' : ray.pick < 1 - palette * 0.08 ? 'coral' : 'gold';
    for (const run of lightRuns(points, gapAmount, noise)) strokes.push({ pen, points: run.map(onPlane), light: 'ray' });
  }
  return center;
}

function camera(viewport: Viewport): THREE.OrthographicCamera {
  const view = new THREE.OrthographicCamera(-viewport.width / 2, viewport.width / 2,
    viewport.height / 2, -viewport.height / 2, 0.1, 1000);
  view.position.set(185, -135, 330);
  view.lookAt(0, 0, 0);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
}

export function pathLength(path: Point[]): number {
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

/** Remove every part of a polyline that enters the disc, cutting exactly at the circle. */
export function clipOutsideDisc(path: Point[], center: Point, radius: number): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  const inside = (p: Point) => Math.hypot(p.x - center.x, p.y - center.y) < radius;
  if (!inside(path[0])) run.push(path[0]);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const fx = a.x - center.x, fy = a.y - center.y;
    const qa = dx * dx + dy * dy, qb = 2 * (fx * dx + fy * dy), qc = fx * fx + fy * fy - radius * radius;
    const disc = qb * qb - 4 * qa * qc;
    if (qa < 1e-12 || disc <= 0) {
      if (!inside(b)) run.push(b);
      continue;
    }
    const root = Math.sqrt(disc);
    const t0 = (-qb - root) / (2 * qa), t1 = (-qb + root) / (2 * qa);
    const at = (t: number) => ({ x: a.x + dx * t, y: a.y + dy * t });
    if (t1 <= 0 || t0 >= 1) { run.push(b); continue; }
    if (t0 > 0) run.push(at(t0));
    if (run.length >= 2) runs.push(run);
    run = [];
    if (t1 < 1) run.push(at(t1), b);
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

export interface BridgeStats {
  candidateSegments: number; visibleSegments: number; hiddenSegments: number; meshCount: number;
  gap: [number, number]; projectedGapCenter: Point; projectedSingularityCenter: Point;
  coreRadius: number; projectedRouteStart: Point; projectedRouteEnd: Point;
}
export interface BridgeDrawing { parts: Part[]; stats: BridgeStats }

/** One software depth pass handles every solid bridge member before line classification. */
export function drawSpan(ctx: SketchContext, lightBounds: LightBounds = ART): BridgeDrawing {
  const view = camera(VIEWPORT);
  const route = new BridgeRoute(ctx, view);
  const coreRadius = numeric(ctx, 'coreRadius', 30, 14, 44);
  const meshes: THREE.BufferGeometry[] = [];
  const strokes: Stroke[] = [];
  const spans: [number, number][] = [[0, route.leftGap], [route.rightGap, 1]];
  let moduleIndex = 0;
  const portalVariation = ctx.random('portal-arrangement');
  for (const [spanIndex, [from, to]] of spans.entries()) {
    const sections = Math.max(4, Math.round(route.span(from, to) / 17));
    for (let index = 0; index < sections; index++) {
      const hot = spanIndex === 0 ? index === sections - 1 : index === 0;
      deckSegment(route, meshes, strokes, lerp(from, to, index / sections), lerp(from, to, (index + 1) / sections), moduleIndex++, hot);
    }
    // Portals sit on the visible inner stretch of each remnant, away from the clipped outer ends.
    const inner: [number, number] = spanIndex === 0 ? [0.14, to - 0.05] : [from + 0.05, 0.86];
    const frames = 2;
    for (let index = 0; index < frames; index++) {
      const station = lerp(inner[0], inner[1], (index + 0.13 + 0.18 * portalVariation()) / frames);
      portal(route, meshes, strokes, station, moduleIndex++, portalVariation());
    }
    const reach = (15 + portalVariation() * 12) * (0.7 + 0.9 * route.mass);
    buttress(route, meshes, strokes, lerp(inner[0], inner[1], spanIndex === 0 ? 0.62 : 0.2), spanIndex === 0 ? -1 : 1, reach, 0.05, 14 + portalVariation() * 9);
    if (spanIndex === 1) buttress(route, meshes, strokes, lerp(inner[0], inner[1], 0.74), -1, (10 + portalVariation() * 8) * (0.7 + 0.9 * route.mass), 0.04, 18);
  }
  brokenEnd(route, meshes, strokes, route.leftGap, 1);
  brokenEnd(route, meshes, strokes, route.rightGap, -1);
  branches(route, ctx, meshes, strokes);
  const viewWidth = Math.round(VIEWPORT.width * PIXELS_PER_MM);
  const viewHeight = Math.round(VIEWPORT.height * PIXELS_PER_MM);
  orbitalFragments(route, ctx, view, meshes, strokes, coreRadius);
  const center = lightGeometry(route, ctx, view, strokes, lightBounds, coreRadius);
  const fogCoverage = numeric(ctx, 'fogCoverage', 0.4, 0, 1);
  const fogDepth = numeric(ctx, 'fogDepth', 0.5, 0, 1);
  const fogEnabled = ctx.params.fogEnabled === true && fogCoverage > 0 && fogDepth > 0;
  const atmosphere = fogEnabled ? createAtmosphere({ bounds: lightBounds,
    seed: Math.floor(ctx.random('bridge-atmosphere')() * 0xffffffff), depth: fogDepth,
    scale: lerp(16, 42, numeric(ctx, 'fogScale', 0.6, 0, 1)),
    center, clearRadius: coreRadius + 14 }) : null;
  const cameraForward = new THREE.Vector3();
  const strokeDepths = new Map<Stroke, number>();
  if (atmosphere) {
    view.getWorldDirection(cameraForward);
    for (const source of strokes) {
      if (source.light) continue;
      const distance = source.points.reduce((sum, point) =>
        sum + point.clone().sub(view.position).dot(cameraForward), 0) / source.points.length;
      strokeDepths.set(source, distance);
    }
  }
  const nearDepth = atmosphere ? Math.min(...strokeDepths.values()) : 0;
  const farDepth = atmosphere ? Math.max(...strokeDepths.values()) : 1;
  try {
    const midpoint = route.point((route.leftGap + route.rightGap) / 2, 0, 6).project(view);
    const projectedGapCenter = pageFromNdc(midpoint, VIEWPORT);
    const depth = renderDepthBufferCPU(meshes, view, viewWidth, viewHeight);
    const projection = projectPolylinesClipped(strokes.map(item => item.points), view, viewWidth, viewHeight);
    const pathsByPen = new Map<Ink, Point[][]>(INKS.map(pen => [pen, []]));
    const ribbonByPen = new Map<Ink, Point[][]>(INKS.map(pen => [pen, []]));
    const rayByPen = new Map<Ink, Point[][]>(INKS.map(pen => [pen, []]));
    // Every mark is cut at the core circle, so the void is guaranteed open paper.
    const emit = (destination: Map<Ink, Point[][]>, pen: Ink, path: Point[]) => {
      for (const piece of clipOutsideDisc(path, center, coreRadius)) {
        if (pathLength(piece) >= 0.55) destination.get(pen)!.push(economical(piece));
      }
    };
    let candidateSegments = 0;
    let visibleSegments = 0;
    for (let index = 0; index < projection.polylines.length; index++) {
      const source = strokes[projection.sourceIndices[index]];
      const pen = source.pen;
      for (const clipped of clipProjectedPolyline(projection.polylines[index], viewWidth, viewHeight)) {
        const dense = densifyProjectedPolyline(clipped);
        candidateSegments += dense.length - 1;
        const visibleRuns = ctx.params.occlusion === false ? [dense] : splitPolylineByDepth(dense, depth, 0.0012).visible;
        for (const visible of visibleRuns) {
          visibleSegments += visible.length - 1;
          const page = visible.map(point => ({ x: point.x / PIXELS_PER_MM, y: point.y / PIXELS_PER_MM }));
          for (const bounded of clipPolylineToRect(page, source.light ? lightBounds : ART)) {
            if (pathLength(bounded) < 0.55) continue;
            const destination = source.light === 'ribbon' ? ribbonByPen : source.light === 'ray' ? rayByPen : pathsByPen;
            if (!atmosphere || source.light) emit(destination, pen, bounded);
            else {
              const far = farDepth > nearDepth ? clamp((strokeDepths.get(source)! - nearDepth) / (farDepth - nearDepth), 0, 1) : 0.5;
              const visibleFog = maskAtmospherePaths([bounded], atmosphere,
                { amount: fogCoverage, depth: 0.38 + 0.18 * far, sampleStep: 1.4, minLength: 0.55 });
              for (const piece of visibleFog) emit(destination, pen, piece);
            }
          }
        }
      }
    }
    // Light beyond the page-sized depth viewport (lettered mode widens the bounds) has no occluder.
    const outside = [
      { xMin: lightBounds.xMin, xMax: lightBounds.xMax, yMin: lightBounds.yMin, yMax: 0 },
      { xMin: lightBounds.xMin, xMax: lightBounds.xMax, yMin: VIEWPORT.height - 1 / PIXELS_PER_MM, yMax: lightBounds.yMax },
      { xMin: lightBounds.xMin, xMax: 0, yMin: 0, yMax: VIEWPORT.height },
      { xMin: VIEWPORT.width - 1 / PIXELS_PER_MM, xMax: lightBounds.xMax, yMin: 0, yMax: VIEWPORT.height },
    ].filter(rect => rect.xMax > rect.xMin && rect.yMax > rect.yMin);
    for (const source of strokes) {
      if (!source.light) continue;
      const page = source.points.map(point => pageFromNdc(point.clone().project(view), VIEWPORT));
      const destination = source.light === 'ribbon' ? ribbonByPen : rayByPen;
      for (const strip of outside) for (const bounded of clipPolylineToRect(page, strip)) emit(destination, source.pen, bounded);
    }
    const fog = atmosphere ? hatchAtmosphere(lightBounds, atmosphere, { spacing: numeric(ctx, 'fogHatchPitch', 3.6, 1.2, 6),
      angle: -0.38, minLength: 1.2 }) : [];
    const fogByPen = new Map<Ink, Point[][]>([['cyan', []]]);
    for (const path of fog) emit(fogByPen, 'cyan', path);
    const parts: Part[] = [
      ...INKS.map(pen => ({ id: `bridge-${pen}`, pen, paths: pathsByPen.get(pen)! })),
      ...LIGHT_INKS.map(pen => ({ id: `ribbon-${pen}`, pen, paths: ribbonByPen.get(pen)! })),
      ...LIGHT_INKS.map(pen => ({ id: `ray-${pen}`, pen, paths: rayByPen.get(pen)! })),
      ...(atmosphere ? [{ id: 'fog-cyan', pen: 'cyan' as Ink, paths: fogByPen.get('cyan')! }] : []),
    ];
    return { parts, stats: { candidateSegments, visibleSegments, hiddenSegments: candidateSegments - visibleSegments,
      meshCount: meshes.length, gap: [route.leftGap, route.rightGap], projectedGapCenter,
      projectedSingularityCenter: center, coreRadius,
      projectedRouteStart: route.projectedStart, projectedRouteEnd: route.projectedEnd } };
  } finally {
    for (const mesh of meshes) mesh.dispose();
  }
}
