import * as THREE from "three";
import type { ProjectedPoint } from "../projection";

/** The bottom-up RGBA8 format consumed by splitPolylineByDepth. */
export interface PackedDepthBuffer {
  depthData: Uint8Array;
  width: number;
  height: number;
}

export type DepthProvider = (
  geometries: THREE.BufferGeometry[],
  camera: THREE.Camera,
  width: number,
  height: number,
) => PackedDepthBuffer;

type ClipVertex = [number, number, number, number];
type ScreenVertex = { x: number; y: number; z: number };
const MAX_PIXELS = 4_194_304;
const MAX_TRIANGLES = 1_000_000;
const MAX_FRAGMENTS = 100_000_000;
const EPSILON = 1e-10;

// OpenGL clip volume: -w <= x,y,z <= w. Clipping in homogeneous space
// prevents vertices behind the eye from reversing or exploding on divide.
const PLANES: ((v: ClipVertex) => number)[] = [
  v => v[3] + v[0], v => v[3] - v[0],
  v => v[3] + v[1], v => v[3] - v[1],
  v => v[3] + v[2], v => v[3] - v[2],
];

function clipTriangle(a: ClipVertex, b: ClipVertex, c: ClipVertex): ClipVertex[] {
  let polygon = [a, b, c];
  for (const plane of PLANES) {
    const input = polygon;
    polygon = [];
    if (input.length === 0) break;
    for (let i = 0; i < input.length; i++) {
      const from = input[i];
      const to = input[(i + 1) % input.length];
      const da = plane(from);
      const db = plane(to);
      const insideA = da >= 0;
      const insideB = db >= 0;
      if (insideA !== insideB) {
        const t = da / (da - db);
        polygon.push([
          from[0] + (to[0] - from[0]) * t,
          from[1] + (to[1] - from[1]) * t,
          from[2] + (to[2] - from[2]) * t,
          from[3] + (to[3] - from[3]) * t,
        ]);
      }
      if (insideB) polygon.push(to);
    }
  }
  return polygon;
}

function edge(a: ScreenVertex, b: ScreenVertex, x: number, y: number): number {
  return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
}

/** Deterministic software depth for executable sketches and headless renders. */
export const renderDepthBufferCPU: DepthProvider = (geometries, camera, width, height) => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_PIXELS) {
    throw new RangeError("CPU depth dimensions exceed the pixel budget");
  }
  const pixelCount = width * height;
  const depthData = new Uint8Array(pixelCount * 4);
  const depths = new Float64Array(pixelCount);
  depths.fill(Infinity);

  camera.updateMatrixWorld();
  const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const e = matrix.elements;
  const project = (x: number, y: number, z: number): ClipVertex => [
    e[0] * x + e[4] * y + e[8] * z + e[12],
    e[1] * x + e[5] * y + e[9] * z + e[13],
    e[2] * x + e[6] * y + e[10] * z + e[14],
    e[3] * x + e[7] * y + e[11] * z + e[15],
  ];
  const screen = (v: ClipVertex): ScreenVertex => ({
    x: (v[0] / v[3] * 0.5 + 0.5) * width,
    y: (v[1] / v[3] * 0.5 + 0.5) * height,
    z: v[2] / v[3],
  });

  let triangleCount = 0;
  let fragmentCount = 0;
  const rasterize = (a: ScreenVertex, b: ScreenVertex, c: ScreenVertex) => {
    const area = edge(a, b, c.x, c.y);
    if (!Number.isFinite(area) || Math.abs(area) < EPSILON) return;
    const minX = Math.max(0, Math.ceil(Math.min(a.x, b.x, c.x) - 0.5));
    const maxX = Math.min(width - 1, Math.floor(Math.max(a.x, b.x, c.x) - 0.5));
    const minY = Math.max(0, Math.ceil(Math.min(a.y, b.y, c.y) - 0.5));
    const maxY = Math.min(height - 1, Math.floor(Math.max(a.y, b.y, c.y) - 0.5));
    if (maxX < minX || maxY < minY) return;
    fragmentCount += (maxX - minX + 1) * (maxY - minY + 1);
    if (fragmentCount > MAX_FRAGMENTS) throw new RangeError("CPU depth fragment budget exceeded");
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const wa = edge(b, c, px, py) / area;
        const wb = edge(c, a, px, py) / area;
        const wc = 1 - wa - wb;
        if (wa < -EPSILON || wb < -EPSILON || wc < -EPSILON) continue;
        // Window depth is affine in screen space; interpolating clip z or
        // dividing the interpolated vertex depths again gives wrong order.
        const depth = Math.min(1, Math.max(0, (wa * a.z + wb * b.z + wc * c.z) * 0.5 + 0.5));
        const idx = y * width + x;
        if (depth >= depths[idx]) continue;
        depths[idx] = depth;
        const high = Math.floor(depth * 255);
        const low = Math.floor((depth * 255 - high) * 255);
        depthData[idx * 4] = high;
        depthData[idx * 4 + 1] = low;
        depthData[idx * 4 + 2] = Math.floor(depth * 255);
        depthData[idx * 4 + 3] = 255;
      }
    }
  };

  for (const geometry of geometries) {
    const positions = geometry.getAttribute("position");
    if (!positions || positions.itemSize < 3) throw new TypeError("CPU depth geometry needs 3D positions");
    const index = geometry.getIndex();
    const count = index ? index.count : positions.count;
    if (count % 3 !== 0) throw new RangeError("CPU depth geometry is not triangulated");
    triangleCount += count / 3;
    if (triangleCount > MAX_TRIANGLES) throw new RangeError("CPU depth triangle budget exceeded");
    const vertex = (i: number): ClipVertex => {
      const at = index ? index.getX(i) : i;
      if (!Number.isSafeInteger(at) || at < 0 || at >= positions.count) throw new RangeError("CPU depth index out of bounds");
      const x = positions.getX(at), y = positions.getY(at), z = positions.getZ(at);
      if (![x, y, z].every(Number.isFinite)) throw new RangeError("CPU depth position is not finite");
      const v = project(x, y, z);
      if (!v.every(Number.isFinite)) throw new RangeError("CPU depth clip coordinate is not finite");
      return v;
    };
    for (let i = 0; i < count; i += 3) {
      const clipped = clipTriangle(vertex(i), vertex(i + 1), vertex(i + 2));
      if (clipped.length < 3) continue;
      for (let j = 1; j < clipped.length - 1; j++) {
        const trio = [clipped[0], clipped[j], clipped[j + 1]];
        if (trio.some(v => v[3] <= 0)) continue;
        rasterize(screen(trio[0]), screen(trio[1]), screen(trio[2]));
      }
    }
  }
  return { depthData, width, height };
};

/** Clip projected lines to the depth viewport before sampling or visibility checks. */
export function clipProjectedPolyline(
  points: ProjectedPoint[], width: number, height: number,
): ProjectedPoint[][] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("Depth viewport dimensions are invalid");
  }
  const runs: ProjectedPoint[][] = [];
  let run: ProjectedPoint[] = [];
  const flush = () => {
    if (run.length >= 2) runs.push(run);
    run = [];
  };
  const lerp = (a: ProjectedPoint, b: ProjectedPoint, t: number): ProjectedPoint => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    depth: a.depth + (b.depth - a.depth) * t,
  });
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1], to = points[i];
    if (![from.x, from.y, from.depth, to.x, to.y, to.depth].every(Number.isFinite)) {
      throw new RangeError("Depth sample coordinate is not finite");
    }
    const dx = to.x - from.x, dy = to.y - from.y, dd = to.depth - from.depth;
    if (![dx, dy, dd].every(Number.isFinite)) {
      throw new RangeError("Depth segment extent is not finite");
    }
    let enter = 0, exit = 1;
    const constraints: [number, number][] = [
      [-dx, from.x], [dx, width - 1 - from.x],
      [-dy, from.y], [dy, height - 1 - from.y],
      [-dd, from.depth], [dd, 1 - from.depth],
    ];
    let inside = true;
    for (const [p, q] of constraints) {
      if (p === 0) {
        if (q < 0) { inside = false; break; }
      } else {
        const t = q / p;
        if (p < 0) enter = Math.max(enter, t);
        else exit = Math.min(exit, t);
        if (enter > exit) { inside = false; break; }
      }
    }
    if (!inside || enter >= exit) { flush(); continue; }
    const start = lerp(from, to, enter);
    const end = lerp(from, to, exit);
    const last = run[run.length - 1];
    if (last && (enter > 0 || Math.abs(last.x - start.x) > 1e-8 ||
      Math.abs(last.y - start.y) > 1e-8 || Math.abs(last.depth - start.depth) > 1e-8)) flush();
    if (run.length === 0) run.push(start);
    run.push(end);
    if (exit < 1) flush();
  }
  flush();
  return runs;
}

/** Sample sparse projected hatch segments at pixel spacing for the explicit backend. */
export function densifyProjectedPolyline(points: ProjectedPoint[]): ProjectedPoint[] {
  if (points.length === 0) return [];
  const sampled: ProjectedPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1], to = points[i];
    const span = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    if (!Number.isFinite(span) || !Number.isFinite(from.depth) || !Number.isFinite(to.depth)) {
      throw new RangeError("Depth sample coordinate is not finite");
    }
    const steps = Math.max(1, Math.ceil(span));
    if (sampled.length + steps > 250_000) throw new RangeError("Depth polyline sample budget exceeded");
    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      sampled.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        depth: from.depth + (to.depth - from.depth) * t,
      });
    }
  }
  return sampled;
}
