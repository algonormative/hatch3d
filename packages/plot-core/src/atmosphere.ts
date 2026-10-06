/** Deterministic, pen-only cloud banks and partial polyline visibility. */

export interface Point { x: number; y: number }
export interface Bounds { xMin: number; xMax: number; yMin: number; yMax: number }

export interface AtmosphereOptions {
  bounds: Bounds;
  seed: number;
  /** 0 is clear; 1 gives the strongest obscuration of distant structure. */
  depth: number;
  /** Cloud feature size in the same units as the input coordinates. */
  scale: number;
  center?: Point;
  /** Radius of a soft, ink-free opening around center. */
  clearRadius?: number;
}

export type AtmosphereField = ((point: Point) => number) & {
  readonly scale?: number;
  readonly bounds?: Bounds;
  readonly seed?: number;
};

export interface MaskAtmosphereOptions {
  /** 0 preserves the original path arrays exactly; 1 applies the full field. */
  amount: number;
  /** Additional near-to-far attenuation, 0 clear to 1 strongest. Default 1. */
  depth?: number;
  sampleStep?: number;
  minLength?: number;
}

export interface HatchAtmosphereOptions {
  /** Approximate physical separation of neighboring cloud contour levels. */
  spacing: number;
  /** Preferred wisp tangent and break-field orientation, in radians. */
  angle: number;
  sampleStep?: number;
  minLength?: number;
}

const MAX_SAMPLES = 1_000_000;
const MAX_LINES = 20_000;
const MAX_POINTS = 1_000_000;
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function finite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function positive(name: string, value: number): void {
  finite(name, value);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function unit(name: string, value: number): void {
  finite(name, value);
  if (value < 0 || value > 1) throw new RangeError(`${name} must be in [0, 1]`);
}

function checkBounds(bounds: Bounds): void {
  for (const key of ['xMin', 'xMax', 'yMin', 'yMax'] as const) finite(`bounds.${key}`, bounds[key]);
  if (bounds.xMax <= bounds.xMin || bounds.yMax <= bounds.yMin) {
    throw new RangeError('bounds must have positive width and height');
  }
  if (Math.max(...Object.values(bounds).map(Math.abs)) > 1e9 ||
      bounds.xMax - bounds.xMin < 1e-6 || bounds.yMax - bounds.yMin < 1e-6) {
    throw new RangeError('bounds exceed supported coordinate range');
  }
}

function checkPoint(point: Point): void {
  finite('point.x', point.x);
  finite('point.y', point.y);
}

function hash(seed: number, x: number, y: number): number {
  let h = (seed | 0) ^ Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

function noise(seed: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const tx = smoothstep(0, 1, x - ix);
  const ty = smoothstep(0, 1, y - iy);
  const a = hash(seed, ix, iy);
  const b = hash(seed, ix + 1, iy);
  const c = hash(seed, ix, iy + 1);
  const d = hash(seed, ix + 1, iy + 1);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** A reproducible cloud bank strongest near the page edges, with a soft clear opening. */
export function createAtmosphere(options: AtmosphereOptions): AtmosphereField {
  const { seed, depth, scale, clearRadius = 0 } = options;
  checkBounds(options.bounds);
  finite('seed', seed);
  unit('depth', depth);
  positive('scale', scale);
  if (scale < 1e-6 || scale > 1e9) throw new RangeError('scale exceeds supported coordinate range');
  finite('clearRadius', clearRadius);
  if (clearRadius < 0 || clearRadius > 1e9) throw new RangeError('clearRadius exceeds supported coordinate range');
  const bounds = Object.freeze({ ...options.bounds });
  const sourceCenter = options.center ?? {
    x: (bounds.xMin + bounds.xMax) / 2,
    y: (bounds.yMin + bounds.yMax) / 2,
  };
  checkPoint(sourceCenter);
  if (Math.abs(sourceCenter.x) > 1e9 || Math.abs(sourceCenter.y) > 1e9) {
    throw new RangeError('center exceeds supported coordinate range');
  }
  const center = { ...sourceCenter };
  const width = bounds.xMax - bounds.xMin;
  const height = bounds.yMax - bounds.yMin;
  const shortSide = Math.min(width, height);
  const reach = Math.min(Math.max(scale * 2.5, shortSide * 0.3), shortSide * 0.48);
  const offsetSeed = Math.trunc(seed);
  const field = ((point: Point): number => {
    checkPoint(point);
    if (depth === 0 || point.x < bounds.xMin || point.x > bounds.xMax ||
        point.y < bounds.yMin || point.y > bounds.yMax) return 0;
    const x = point.x / scale;
    const y = point.y / scale;
    const broad = noise(offsetSeed, x * 0.47, y * 0.47);
    const medium = noise(offsetSeed + 0x153e, x * 1.07, y * 1.07);
    const fine = noise(offsetSeed + 0x4b97, x * 2.1, y * 2.1);
    const edgeDistance = Math.min(
      point.x - bounds.xMin, bounds.xMax - point.x,
      point.y - bounds.yMin, bounds.yMax - point.y,
    );
    const warpedDistance = edgeDistance + (broad - 0.5) * scale * 1.5;
    const bank = 1 - smoothstep(0, reach, warpedDistance);
    const texture = smoothstep(0.16, 0.84, broad * 0.57 + medium * 0.32 + fine * 0.11);
    const radius = Math.hypot(point.x - center.x, point.y - center.y);
    const clear = clearRadius > 0 ? smoothstep(clearRadius * 0.45, clearRadius * 1.35, radius) : 1;
    return clamp01(depth * bank * (0.35 + 0.65 * texture) * clear);
  }) as AtmosphereField;
  return Object.assign(field, { scale, bounds, seed: offsetSeed });
}

function fieldValue(field: AtmosphereField, point: Point): number {
  const value = field(point);
  unit('field value', value);
  return value;
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function length(points: Point[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return sum;
}

function append(current: Point[], point: Point): void {
  const last = current[current.length - 1];
  if (!last || last.x !== point.x || last.y !== point.y) current.push(point);
}

function crossing(a: Point, b: Point, aVisible: boolean, visible: (p: Point) => boolean): Point {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (visible(lerp(a, b, mid)) === aVisible) lo = mid;
    else hi = mid;
  }
  return lerp(a, b, (lo + hi) / 2);
}

/** Cut each path into independently routable visible runs; never draw a bridge over fog. */
export function maskAtmospherePaths(
  paths: Point[][],
  field: AtmosphereField,
  options: MaskAtmosphereOptions,
): Point[][] {
  unit('amount', options.amount);
  const depth = options.depth ?? 1;
  unit('depth', depth);
  if (options.amount === 0 || depth === 0) return paths;
  const step = options.sampleStep ?? (field.scale ? field.scale / 6 : 1);
  positive('sampleStep', step);
  const minLength = options.minLength ?? 0;
  finite('minLength', minLength);
  if (minLength < 0) throw new RangeError('minLength must be nonnegative');
  const strength = options.amount * depth;
  // The contour starts near field=1, then advances through attenuated banks.
  // Square-root easing keeps midrange controls useful without an abrupt jump
  // from the exact amount=0 identity case.
  const concealThreshold = 1 - 0.98 * Math.sqrt(strength);
  const visible = (p: Point): boolean => fieldValue(field, p) < concealThreshold;
  const result: Point[][] = [];
  let samples = 0;
  let outputPoints = 0;
  const emit = (run: Point[]): void => {
    if (run.length < 2 || length(run) < minLength) return;
    outputPoints += run.length;
    if (outputPoints > MAX_POINTS) throw new RangeError('atmosphere output point limit exceeded');
    result.push(run);
  };
  for (const path of paths) {
    if (path.length < 2) continue;
    if (path.length > MAX_POINTS) throw new RangeError('atmosphere input point limit exceeded');
    for (const p of path) checkPoint(p);
    const closed = path[0].x === path[path.length - 1].x && path[0].y === path[path.length - 1].y;
    const pathRuns: Point[][] = [];
    let run: Point[] = [];
    let anyHidden = false;
    let prev = path[0];
    let prevVisible = visible(prev);
    if (prevVisible) append(run, prev);
    else anyHidden = true;
    for (let i = 1; i < path.length; i++) {
      const end = path[i];
      const distance = Math.hypot(end.x - prev.x, end.y - prev.y);
      const count = Math.max(1, Math.ceil(distance / step));
      samples += count;
      if (!Number.isFinite(samples) || samples > MAX_SAMPLES) throw new RangeError('atmosphere sample limit exceeded');
      for (let j = 1; j <= count; j++) {
        const next = lerp(prev, end, j / count);
        const nextVisible = visible(next);
        if (prevVisible && nextVisible) append(run, next);
        else if (prevVisible && !nextVisible) {
          anyHidden = true;
          append(run, crossing(lerp(prev, end, (j - 1) / count), next, true, visible));
          if (run.length >= 2) pathRuns.push(run);
          run = [];
        } else if (!prevVisible && nextVisible) {
          const prior = lerp(prev, end, (j - 1) / count);
          run = [crossing(prior, next, false, visible)];
          append(run, next);
        } else anyHidden = true;
        prevVisible = nextVisible;
      }
      prev = end;
    }
    if (!anyHidden) {
      emit(path);
      continue;
    }
    if (run.length >= 2) pathRuns.push(run);
    if (closed && pathRuns.length > 1 && visible(path[0])) {
      const first = pathRuns.shift()!;
      const last = pathRuns.pop()!;
      pathRuns.unshift([...last, ...first.slice(1)]);
    }
    for (const part of pathRuns) emit(part);
  }
  return result;
}

/**
 * Trace a few cloud-density contours and break them into short, curved pen
 * wisps. Dense cloud interiors remain paper-white; marks follow billowed
 * shoulders instead of forming a regular screen of straight hatch lines.
 */
export function hatchAtmosphere(
  bounds: Bounds,
  field: AtmosphereField,
  options: HatchAtmosphereOptions,
): Point[][] {
  checkBounds(bounds);
  positive('spacing', options.spacing);
  finite('angle', options.angle);
  const featureScale = field.scale ?? Math.min(bounds.xMax - bounds.xMin, bounds.yMax - bounds.yMin) / 4;
  positive('field scale', featureScale);
  const step = options.sampleStep ?? Math.max(options.spacing * 0.35, featureScale / 20);
  positive('sampleStep', step);
  const minLength = options.minLength ?? options.spacing * 0.75;
  finite('minLength', minLength);
  if (minLength < 0) throw new RangeError('minLength must be nonnegative');

  const width = bounds.xMax - bounds.xMin;
  const height = bounds.yMax - bounds.yMin;
  const cols = Math.max(1, Math.ceil(width / step));
  const rows = Math.max(1, Math.ceil(height / step));
  const nodeCount = (cols + 1) * (rows + 1);
  if (!Number.isSafeInteger(nodeCount) || nodeCount > 500_000) {
    throw new RangeError('atmosphere hatch grid limit exceeded');
  }
  const dx = width / cols;
  const dy = height / rows;
  const at = (row: number, col: number): number => row * (cols + 1) + col;
  const values = new Float64Array(nodeCount);
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) {
      values[at(row, col)] = fieldValue(field, {
        x: bounds.xMin + col * dx, y: bounds.yMin + row * dy,
      });
    }
  }

  const levelStep = Math.max(0.015, Math.min(0.18, options.spacing / featureScale * 0.65));
  const levelCount = Math.floor((0.68 - 0.2) / levelStep) + 1;
  if (rows * cols * levelCount > 2_000_000) {
    throw new RangeError('atmosphere hatch contour work limit exceeded');
  }
  const levels = Array.from({ length: levelCount }, (_, i) => 0.2 + i * levelStep);
  const result: Point[][] = [];
  let outputPoints = 0;
  const gapScale = Math.max(featureScale, options.spacing * 3);
  const cos = Math.cos(options.angle);
  const sin = Math.sin(options.angle);
  const seed = field.seed ?? 0;

  const emitWisps = (contour: Point[], level: number): void => {
    if (contour.length < 2) return;
    let run: Point[] = [];
    const emit = (): void => {
      if (run.length >= 2 && length(run) >= minLength) {
        outputPoints += run.length;
        if (outputPoints > MAX_POINTS || result.length >= MAX_LINES) {
          throw new RangeError('atmosphere hatch output limit exceeded');
        }
        result.push(run);
      }
      run = [];
    };
    const middleWeight = 1 - Math.min(1, Math.abs(level - 0.42) / 0.27);
    for (let i = 0; i < contour.length; i++) {
      const p = contour[i];
      const before = contour[Math.max(0, i - 1)];
      const after = contour[Math.min(contour.length - 1, i + 1)];
      const vx = after.x - before.x;
      const vy = after.y - before.y;
      const tangentLength = Math.hypot(vx, vy);
      const alignment = tangentLength > 0 ? Math.abs((vx * cos + vy * sin) / tangentLength) : 0;
      const u = (p.x * cos + p.y * sin) / gapScale;
      const v = (-p.x * sin + p.y * cos) / gapScale;
      const gapField = noise(seed + 0x527d, u * 0.9, v * 0.9);
      const keep = alignment > 0.13 && gapField > 0.48 - 0.16 * middleWeight;
      if (keep) append(run, p);
      else emit();
    }
    emit();
  };

  for (const level of levels) {
    // Each contour crossing has one stable grid-edge id shared by adjoining
    // cells, so marching-square segments join without coordinate rounding.
    const horizontalCount = (rows + 1) * cols;
    const horizontal = (row: number, col: number): number => row * cols + col;
    const vertical = (row: number, col: number): number => horizontalCount + row * (cols + 1) + col;
    const points = new Map<number, Point>();
    const adjacency = new Map<number, number[]>();
    const connect = (a: number, b: number): void => {
      const adjacentA = adjacency.get(a) ?? [];
      adjacentA.push(b);
      adjacency.set(a, adjacentA);
      const adjacentB = adjacency.get(b) ?? [];
      adjacentB.push(a);
      adjacency.set(b, adjacentB);
    };
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = bounds.xMin + col * dx;
        const y = bounds.yMin + row * dy;
        const corners = [
          { p: { x, y }, v: values[at(row, col)] },
          { p: { x: x + dx, y }, v: values[at(row, col + 1)] },
          { p: { x: x + dx, y: y + dy }, v: values[at(row + 1, col + 1)] },
          { p: { x, y: y + dy }, v: values[at(row + 1, col)] },
        ];
        const edgeCorners = [[0, 1], [1, 2], [2, 3], [3, 0]];
        const edgeIds = [horizontal(row, col), vertical(row, col + 1),
          horizontal(row + 1, col), vertical(row, col)];
        const crossings: number[] = [];
        for (let edge = 0; edge < 4; edge++) {
          const [a, b] = edgeCorners[edge];
          if ((corners[a].v >= level) === (corners[b].v >= level)) continue;
          const id = edgeIds[edge];
          if (!points.has(id)) {
            const t = (level - corners[a].v) / (corners[b].v - corners[a].v);
            points.set(id, lerp(corners[a].p, corners[b].p, t));
          }
          crossings.push(edge);
        }
        if (crossings.length === 2) connect(edgeIds[crossings[0]], edgeIds[crossings[1]]);
        else if (crossings.length === 4) {
          const centerHigh = corners.reduce((sum, corner) => sum + corner.v, 0) / 4 >= level;
          const topLeftHigh = corners[0].v >= level;
          const pairs = centerHigh === topLeftHigh ? [[0, 1], [2, 3]] : [[0, 3], [1, 2]];
          for (const [a, b] of pairs) connect(edgeIds[a], edgeIds[b]);
        }
      }
    }

    const visited = new Set<number>();
    const pairKey = (a: number, b: number): number => Math.min(a, b) * 1_000_000 + Math.max(a, b);
    const trace = (start: number): void => {
      const contour: Point[] = [];
      let current = start;
      let previous = -1;
      while (true) {
        contour.push(points.get(current)!);
        const next = adjacency.get(current)?.find((candidate) =>
          candidate !== previous && !visited.has(pairKey(current, candidate)));
        if (next === undefined) break;
        visited.add(pairKey(current, next));
        previous = current;
        current = next;
        if (contour.length > MAX_POINTS) throw new RangeError('atmosphere hatch contour limit exceeded');
      }
      emitWisps(contour, level);
    };
    for (const [id, neighbors] of adjacency) {
      if (neighbors.length === 1 && !visited.has(pairKey(id, neighbors[0]))) trace(id);
    }
    for (const [id, neighbors] of adjacency) {
      if (neighbors.some((next) => !visited.has(pairKey(id, next)))) trace(id);
    }
  }
  return result;
}
