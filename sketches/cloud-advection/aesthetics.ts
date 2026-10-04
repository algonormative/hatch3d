/**
 * Aesthetic proxy metrics for the Prescribed Weather study.
 *
 * Pure, deterministic functions over rendered parts (final page millimetres,
 * after finishing). No I/O. The score at the bottom is a PROXY FOR SHORTLISTING
 * ONLY: it encodes the owner's stated focus (contours not noise, architecture
 * dissolving into weather at the frame, a quiet held centre, legible change
 * across steps 0/30/60 while each frame stays calm, plottable restraint). It
 * cannot see composition, and the bands below were calibrated against a handful
 * of default renders. Humans choose; the score only decides what is worth
 * looking at.
 */

export interface Pt { x: number; y: number }
export interface FramePart { id: string; pen: string; paths: Pt[][]; diagnostic?: boolean }
export interface Rect { xMin: number; yMin: number; xMax: number; yMax: number }
export interface Core { x: number; y: number; r: number }
export interface FrameGeometry { content: Rect; core: Core }
export interface FrameInput {
  parts: FramePart[];
  geometry: FrameGeometry;
  /** params.cloudHatchPitch (mm): the rope threshold is a fraction of it. */
  cloudHatchPitch: number;
}

/** Tunable measurement constants. */
export const MEASURE = {
  /** Cloud paths are resampled at (at most) this spacing, mm. */
  resampleMm: 0.5,
  /** Nearest-neighbour search radius and cap, mm. */
  neighbourMm: 3,
  /** A sample is "roped" when its nearest other-path distance is below this fraction of the hatch pitch. */
  ropeFraction: 0.45,
  /** Width of the band inside the content perimeter used for frame contact, mm. */
  frameBandMm: 12,
  /** The band is split into this many equal-length perimeter segments. */
  frameSegments: 64,
  /** A segment counts as touched by cloud when it holds at least this much cloud ink, mm. */
  frameMinInkMm: 1,
  /** Annulus around the core used for the halo measure, in core radii. */
  haloOuter: 1.6,
  /** Occupancy cell for frame-to-frame change, mm. */
  occupancyCellMm: 20,
  /** Occupancy cell for the coherence component count, mm. */
  coherenceCellMm: 8,
  /** Fixed reference ink density for coreHalo, metres of cloud ink per m2 of annulus. */
  haloReference: 40,
} as const;

/** Hard feasibility limits. */
export const LIMITS = {
  maxPoints: 60_000,
  maxRopeIndex: 0.12,
  minFrameContact: 0.2,
  maxCoreHalo: 1.5,
  /** No near-blank frames: cloud ink metres per m2 of content. */
  minFill: 15,
} as const;

/**
 * Desirability bands, (zero0, one0, one1, zero1): the desirability is 0 at or
 * beyond the outer edges, 1 between the inner edges, linear in between. One-sided
 * "lower is better" metrics use -Infinity for the low pair. Retune here.
 *
 * Calibration notes (configs/orbit-step-30.json with markStyle contours):
 * - fill: the old default measures 171 / 93 / 39 m of cloud ink per m2 at steps
 *   0/30/60 and 56k / 31k / 16k points (the 60k cap sits near fill 180). Bands:
 *   0 at <= 20, full 35-70, 0 at >= 130; hard floor 15 (no near-blank frames).
 * - ropeIndex: hard limit 0.12; desirability runs 1 at 0 down to 0 at 0.3 so it
 *   still discriminates among infeasible candidates. The old default sits at
 *   0.85 / 0.47 / 0.30 (median nearest contour 0.9 mm on a 2 mm pitch).
 * - coreHalo: absolute (see coreHalo()); hard limit 1.5, full <= 0.3 (search-2
 *   found no candidate under 0.6: step 0 starts with weather everywhere).
 * - spacingCV: after minimum-spacing culling every candidate measures 0.26-0.34;
 *   the band is full <= 0.2, 0 at 0.4 so that spread still discriminates.
 * - largestShare: ink of the largest 8 mm component over total ink; full >= 0.35,
 *   0 at <= 0.1 (a frame of scattered specks).
 * - change (20 mm cells, Jaccard distance): measured on search-1 candidates,
 *   the same weather 30 -> 31 steps is 0.04-0.07 (frozen), 30 -> 60 is 0.33-0.61
 *   and 30 -> 45 is 0.27-0.66 (shifted, legible), while step-30 frames of
 *   different candidates (unrelated weather) are 0.61-0.86. So full 0.25-0.5,
 *   0 below 0.1 (frozen) and at >= 0.75 (unrelated).
 * - coherence: connected components of the 8 mm occupancy grid; full <= 6,
 *   0 at >= 25.
 */
export type Band = readonly [zero0: number, one0: number, one1: number, zero1: number];
export const BANDS: Record<string, Band> = {
  ropeIndex: [-Infinity, -Infinity, 0, 0.3],
  spacingCV: [-Infinity, -Infinity, 0.2, 0.4],
  frameContact: [LIMITS.minFrameContact, 0.35, 0.8, 1.15],
  coreHalo: [-Infinity, -Infinity, 0.3, LIMITS.maxCoreHalo],
  concealment: [0, 0.15, 0.45, 0.8],
  balance: [0.6, 0.92, Infinity, Infinity],
  fill: [20, 35, 70, 130],
  coherence: [-Infinity, -Infinity, 6, 25],
  largestShare: [0.1, 0.35, Infinity, Infinity],
  change: [0.1, 0.25, 0.5, 0.75],
};
/** Floor applied to each desirability before the geometric mean so one zero does not erase the ranking among the rest. */
export const DESIRABILITY_FLOOR = 0.01;

export function bandDesirability(band: Band, value: number): number {
  const [z0, o0, o1, z1] = band;
  if (!Number.isFinite(value)) return 0;
  if (value <= z0 || value >= z1) return 0;
  if (value >= o0 && value <= o1) return 1;
  if (value < o0) return (value - z0) / (o0 - z0);
  return (z1 - value) / (z1 - o1);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

interface FinishingLike { scale: number; offsetX: number; offsetY: number; contentRect: Rect }

/**
 * The content rectangle after finishing, and the quiet core in final page
 * coordinates: the core is authored in source page mm (page centre plus
 * coreX/coreY), then mapped through the finishing scale and offset exactly as
 * the sketch test does.
 */
export function frameGeometry(page: { width: number; height: number }, finishing: FinishingLike, params: Record<string, unknown>): FrameGeometry {
  const num = (id: string, fallback: number) => (typeof params[id] === 'number' ? params[id] as number : fallback);
  const cx = page.width / 2 + num('coreX', 0);
  const cy = page.height / 2 + num('coreY', 0);
  return {
    content: { ...finishing.contentRect },
    core: {
      x: cx * finishing.scale + finishing.offsetX,
      y: cy * finishing.scale + finishing.offsetY,
      r: num('coreRadius', 34) * finishing.scale,
    },
  };
}

const isCloud = (part: FramePart) => part.id.startsWith('cloud-') && !part.diagnostic;
const isStructure = (part: FramePart) => part.id.startsWith('structure-') && !part.diagnostic;

export function pathLength(path: Pt[]): number {
  let length = 0;
  for (let i = 1; i < path.length; i++) length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return length;
}

const inkMm = (parts: FramePart[], pick: (p: FramePart) => boolean) =>
  parts.filter(pick).reduce((sum, part) => sum + part.paths.reduce((s, path) => s + pathLength(path), 0), 0);

/** Structure ink in metres (the off-state reference for concealment uses this too). */
export const structureInkM = (parts: FramePart[]): number => inkMm(parts, isStructure) / 1000;
export const cloudInkM = (parts: FramePart[]): number => inkMm(parts, isCloud) / 1000;

export interface Sample { x: number; y: number; path: number; weight: number }

/**
 * Resample paths into equal sub-intervals no longer than `stepMm`; each sample sits at
 * the middle of its sub-interval and carries that sub-interval's length as its weight,
 * so weights sum to the exact path length.
 */
export function resamplePaths(paths: Pt[][], stepMm: number = MEASURE.resampleMm): Sample[] {
  const samples: Sample[] = [];
  paths.forEach((path, index) => {
    const total = pathLength(path);
    if (!(total > 0)) return;
    const n = Math.max(1, Math.ceil(total / stepMm));
    const step = total / n;
    let seg = 1;
    let segStart = 0;
    let segLen = Math.hypot(path[1].x - path[0].x, path[1].y - path[0].y);
    for (let i = 0; i < n; i++) {
      const target = (i + 0.5) * step;
      while (seg < path.length - 1 && segStart + segLen < target) {
        segStart += segLen;
        seg++;
        segLen = Math.hypot(path[seg].x - path[seg - 1].x, path[seg].y - path[seg - 1].y);
      }
      const t = segLen > 0 ? Math.min(1, Math.max(0, (target - segStart) / segLen)) : 0;
      const a = path[seg - 1], b = path[seg];
      samples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, path: index, weight: step });
    }
  });
  return samples;
}

const cloudSamples = (parts: FramePart[]): Sample[] => {
  const paths: Pt[][] = [];
  for (const part of parts) if (isCloud(part)) for (const path of part.paths) paths.push(path);
  return resamplePaths(paths);
};

// ---------------------------------------------------------------------------
// Rope index and spacing
// ---------------------------------------------------------------------------

/**
 * For each cloud sample, the distance to the nearest sample on a DIFFERENT cloud
 * path (spatial hash, search radius `neighbourMm`; no neighbour reads as the cap).
 * `ropeIndex` is the length-weighted fraction of samples closer than
 * `ropeFraction * cloudHatchPitch`: contour levels bunching into a rope.
 * `spacingCV` is the weighted coefficient of variation of those distances
 * (cap included): lower means evenly spaced sweeps.
 */
export function ropeAndSpacing(samples: Sample[], cloudHatchPitch: number): { ropeIndex: number; spacingCV: number } {
  if (samples.length === 0) return { ropeIndex: 0, spacingCV: 0 };
  const cap = MEASURE.neighbourMm;
  const cell = cap;
  const grid = new Map<number, number[]>();
  const keyOf = (ix: number, iy: number) => (ix + 32768) * 65536 + (iy + 32768);
  samples.forEach((s, i) => {
    const key = keyOf(Math.floor(s.x / cell), Math.floor(s.y / cell));
    const bucket = grid.get(key);
    if (bucket) bucket.push(i); else grid.set(key, [i]);
  });
  const threshold = MEASURE.ropeFraction * cloudHatchPitch;
  let weightSum = 0, ropeWeight = 0, mean = 0;
  const distances = new Float64Array(samples.length);
  samples.forEach((s, i) => {
    const ix = Math.floor(s.x / cell), iy = Math.floor(s.y / cell);
    let best: number = cap;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const bucket = grid.get(keyOf(ix + dx, iy + dy));
      if (!bucket) continue;
      for (const j of bucket) {
        if (samples[j].path === s.path) continue;
        const d = Math.hypot(samples[j].x - s.x, samples[j].y - s.y);
        if (d < best) best = d;
      }
    }
    distances[i] = best;
    weightSum += s.weight;
    mean += s.weight * best;
    if (best < threshold) ropeWeight += s.weight;
  });
  mean /= weightSum;
  let variance = 0;
  samples.forEach((s, i) => { variance += s.weight * (distances[i] - mean) ** 2; });
  variance /= weightSum;
  return { ropeIndex: ropeWeight / weightSum, spacingCV: mean > 0 ? Math.sqrt(variance) / mean : 0 };
}

// ---------------------------------------------------------------------------
// Frame contact, core halo, balance, fill
// ---------------------------------------------------------------------------

/** Arc-length coordinate (0..perimeter) of the nearest content side for a point, and its distance inward. */
function perimeterPosition(p: Pt, r: Rect): { s: number; inward: number } {
  const w = r.xMax - r.xMin, h = r.yMax - r.yMin;
  const dTop = p.y - r.yMin, dRight = r.xMax - p.x, dBottom = r.yMax - p.y, dLeft = p.x - r.xMin;
  const inward = Math.min(dTop, dRight, dBottom, dLeft);
  if (inward === dTop) return { s: Math.min(w, Math.max(0, p.x - r.xMin)), inward };
  if (inward === dRight) return { s: w + Math.min(h, Math.max(0, p.y - r.yMin)), inward };
  if (inward === dBottom) return { s: w + h + Math.min(w, Math.max(0, r.xMax - p.x)), inward };
  return { s: 2 * w + h + Math.min(h, Math.max(0, r.yMax - p.y)), inward };
}

/**
 * Fraction of `frameSegments` equal-length perimeter segments of a `frameBandMm`
 * band inside the content rectangle that hold cloud ink. Corner squares belong to
 * whichever side is nearest, so this is a perimeter coverage measure, not an area one.
 */
export function frameContact(samples: Sample[], content: Rect): number {
  const w = content.xMax - content.xMin, h = content.yMax - content.yMin;
  const perimeter = 2 * (w + h);
  const ink = new Float64Array(MEASURE.frameSegments);
  for (const sample of samples) {
    const { s, inward } = perimeterPosition(sample, content);
    if (inward > MEASURE.frameBandMm) continue;
    const index = Math.min(MEASURE.frameSegments - 1, Math.floor((s / perimeter) * MEASURE.frameSegments));
    ink[index] += sample.weight;
  }
  let touched = 0;
  for (const value of ink) if (value >= MEASURE.frameMinInkMm) touched++;
  return touched / MEASURE.frameSegments;
}

/** Area (mm²) of the annulus [rIn, rOut] around (cx, cy) that lies inside `content`, by 1 mm cell centres. */
function annulusArea(core: Core, rOut: number, content: Rect): number {
  const x0 = Math.max(content.xMin, Math.floor(core.x - rOut)), x1 = Math.min(content.xMax, Math.ceil(core.x + rOut));
  const y0 = Math.max(content.yMin, Math.floor(core.y - rOut)), y1 = Math.min(content.yMax, Math.ceil(core.y + rOut));
  let cells = 0;
  for (let x = x0 + 0.5; x < x1; x += 1) for (let y = y0 + 0.5; y < y1; y += 1) {
    const d = Math.hypot(x - core.x, y - core.y);
    if (d >= core.r && d <= rOut) cells++;
  }
  return cells;
}

/**
 * Absolute halo density: cloud ink (metres) per m2 of the annulus
 * [coreR, haloOuter * coreR] (clipped to the content rectangle), divided by a FIXED
 * reference of `haloReference` (40) m/m2. It is deliberately not relative to the
 * frame's own fill, so sparse frames are not penalised by a ratio artefact: 0 is a
 * clear annulus, 1 is as inked as a busy page. Zero for no core or no cloud.
 */
export function coreHalo(samples: Sample[], geometry: FrameGeometry): number {
  const { core, content } = geometry;
  const total = samples.reduce((sum, s) => sum + s.weight, 0);
  if (!(core.r > 0) || !(total > 0)) return 0;
  const rOut = MEASURE.haloOuter * core.r;
  const area = annulusArea(core, rOut, content);
  if (!(area > 0)) return 0;
  let inside = 0;
  for (const s of samples) {
    const d = Math.hypot(s.x - core.x, s.y - core.y);
    if (d >= core.r && d <= rOut) inside += s.weight;
  }
  // mm of ink per mm2 of area, times 1000, is metres per m2.
  return ((inside / area) * 1000) / MEASURE.haloReference;
}

/**
 * Normalized Shannon entropy of cloud ink over the 3x3 grid of the content
 * rectangle excluding the centre cell (8 cells): 1 is perfectly even, 0 is all in one cell or no ink.
 */
export function balance(samples: Sample[], content: Rect): number {
  const w = content.xMax - content.xMin, h = content.yMax - content.yMin;
  const cells = new Float64Array(9);
  for (const s of samples) {
    const cx = Math.min(2, Math.max(0, Math.floor((3 * (s.x - content.xMin)) / w)));
    const cy = Math.min(2, Math.max(0, Math.floor((3 * (s.y - content.yMin)) / h)));
    cells[cy * 3 + cx] += s.weight;
  }
  cells[4] = 0;
  const total = cells.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return 0;
  let entropy = 0;
  for (const value of cells) if (value > 0) { const p = value / total; entropy -= p * Math.log(p); }
  return entropy / Math.log(8);
}

export interface FrameMetrics {
  cloudInkM: number;
  structureInkM: number;
  points: number;
  ropeIndex: number;
  spacingCV: number;
  frameContact: number;
  coreHalo: number;
  /** 1 - structure ink / off-state structure ink. */
  concealment: number;
  balance: number;
  /** Cloud ink metres per square metre of content area. */
  fill: number;
  /** Number of 8-connected components of the 8 mm cloud occupancy grid: fewer, larger systems read as weather. */
  coherence: number;
  /** Cloud ink in the largest 8 mm occupancy component over total cloud ink (0 with no ink). */
  largestShare: number;
}

/**
 * Metrics for one frame. `offStructureInkM` is the structure ink of the same
 * params rendered with cloudEnabled false (nothing concealed).
 */
export function frameMetrics(input: FrameInput, offStructureInkM: number): FrameMetrics {
  const samples = cloudSamples(input.parts);
  const { content } = input.geometry;
  const area = ((content.xMax - content.xMin) * (content.yMax - content.yMin)) / 1e6;
  const structure = structureInkM(input.parts);
  const cloud = cloudInkM(input.parts);
  const points = input.parts.filter(p => !p.diagnostic).reduce((n, p) => n + p.paths.reduce((m, path) => m + path.length, 0), 0);
  return {
    cloudInkM: cloud,
    structureInkM: structure,
    points,
    ...ropeAndSpacing(samples, input.cloudHatchPitch),
    frameContact: frameContact(samples, content),
    coreHalo: coreHalo(samples, input.geometry),
    concealment: offStructureInkM > 0 ? 1 - structure / offStructureInkM : 0,
    balance: balance(samples, content),
    fill: area > 0 ? cloud / area : 0,
    ...componentStats(samples, content),
  };
}

// ---------------------------------------------------------------------------
// Change between frames
// ---------------------------------------------------------------------------

/** Occupied cells (keys ix * 65536 + iy over the content rect) of the cloud ink; default cell is `occupancyCellMm`. */
export function occupancy(parts: FramePart[], content: Rect, cell: number = MEASURE.occupancyCellMm): Set<number> {
  const grid = new Set<number>();
  for (const s of cloudSamples(parts)) {
    grid.add(Math.floor((s.x - content.xMin) / cell) * 65536 + Math.floor((s.y - content.yMin) / cell));
  }
  return grid;
}

/** Label the 8-connected components of an occupancy set (see `occupancy`): key -> component index. */
/** Label the 8-connected components of an occupancy set: key -> component index. */
export function componentLabels(grid: Set<number>): { labels: Map<number, number>; count: number } {
  const labels = new Map<number, number>();
  let count = 0;
  for (const start of grid) {
    if (labels.has(start)) continue;
    labels.set(start, count);
    const stack = [start];
    while (stack.length) {
      const key = stack.pop()!;
      const ix = Math.floor(key / 65536), iy = key - ix * 65536;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const next = (ix + dx) * 65536 + (iy + dy);
        if (grid.has(next) && !labels.has(next)) { labels.set(next, count); stack.push(next); }
      }
    }
    count++;
  }
  return { labels, count };
}

/** Number of 8-connected components in an occupancy set. */
export const connectedComponents = (grid: Set<number>): number => componentLabels(grid).count;

/**
 * `coherence`: number of 8-connected components of the `coherenceCellMm` occupancy
 * grid of the cloud samples. `largestShare`: cloud ink inside the largest component
 * over total cloud ink. Fewer, larger systems read as weather; many specks read as noise.
 */
export function componentStats(samples: Sample[], content: Rect): { coherence: number; largestShare: number } {
  const cell = MEASURE.coherenceCellMm;
  const keyOf = (s: Sample) => Math.floor((s.x - content.xMin) / cell) * 65536 + Math.floor((s.y - content.yMin) / cell);
  const grid = new Set<number>();
  for (const s of samples) grid.add(keyOf(s));
  const { labels, count } = componentLabels(grid);
  const ink = new Float64Array(count);
  let total = 0;
  for (const s of samples) { ink[labels.get(keyOf(s))!] += s.weight; total += s.weight; }
  return { coherence: count, largestShare: total > 0 ? Math.max(0, ...ink) / total : 0 };
}

/** Jaccard distance between occupancy sets: 0 identical (or both empty), 1 disjoint. */
export function jaccardDistance(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let both = 0;
  for (const key of a) if (b.has(key)) both++;
  return 1 - both / (a.size + b.size - both);
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

export interface SearchMetrics {
  /** One entry per frame, in time order (frameStart, frameStart + frameDelta, frameStart + 2 frameDelta). */
  frames: FrameMetrics[];
  change01: number;
  change12: number;
}

export interface Score {
  feasible: boolean;
  violations: string[];
  /** Geometric mean of the per-metric desirabilities in [0, 1]; computed whether or not feasible. */
  desirability: number;
  /** Per-metric desirability (geometric mean over frames for per-frame metrics). */
  parts: Record<string, number>;
}

const PER_FRAME: (keyof FrameMetrics)[] = ['ropeIndex', 'spacingCV', 'frameContact', 'coreHalo', 'concealment', 'balance', 'fill', 'coherence', 'largestShare'];

/**
 * Hard constraints first (each frame: points <= 60k, ropeIndex <= 0.12, frameContact >= 0.2,
 * fill >= 15, coreHalo <= 1.5), then the desirability. A proxy for shortlisting; humans choose.
 */
export function score(metrics: SearchMetrics): Score {
  const violations: string[] = [];
  metrics.frames.forEach((frame, i) => {
    if (frame.points > LIMITS.maxPoints) violations.push(`frame ${i}: points ${frame.points} > ${LIMITS.maxPoints}`);
    if (frame.ropeIndex > LIMITS.maxRopeIndex) violations.push(`frame ${i}: ropeIndex ${frame.ropeIndex.toFixed(3)} > ${LIMITS.maxRopeIndex}`);
    if (frame.frameContact < LIMITS.minFrameContact) violations.push(`frame ${i}: frameContact ${frame.frameContact.toFixed(3)} < ${LIMITS.minFrameContact}`);
    if (frame.fill < LIMITS.minFill) violations.push(`frame ${i}: fill ${frame.fill.toFixed(1)} < ${LIMITS.minFill}`);
    if (frame.coreHalo > LIMITS.maxCoreHalo) violations.push(`frame ${i}: coreHalo ${frame.coreHalo.toFixed(3)} > ${LIMITS.maxCoreHalo}`);
  });
  const floor = (d: number) => Math.max(DESIRABILITY_FLOOR, d);
  const parts: Record<string, number> = {};
  for (const id of PER_FRAME) {
    const logs = metrics.frames.map(frame => Math.log(floor(bandDesirability(BANDS[id], frame[id] as number))));
    parts[id] = Math.exp(logs.reduce((a, b) => a + b, 0) / Math.max(1, logs.length));
  }
  parts.change01 = floor(bandDesirability(BANDS.change, metrics.change01));
  parts.change12 = floor(bandDesirability(BANDS.change, metrics.change12));
  const values = Object.values(parts);
  const desirability = Math.exp(values.reduce((sum, v) => sum + Math.log(v), 0) / values.length);
  return { feasible: violations.length === 0, violations, desirability, parts };
}

// ---------------------------------------------------------------------------
// Seeded Latin hypercube (pure; used by explore.ts)
// ---------------------------------------------------------------------------

/** Small seeded PRNG (mulberry32) returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `n` points in [0, 1)^dims. Each dimension is stratified: sample i of that
 * dimension falls in stratum perm[i] (a seeded permutation of 0..n-1), jittered
 * inside the stratum. Deterministic for a given (n, dims, seed).
 */
export function latinHypercube(n: number, dims: number, seed: number): number[][] {
  const random = seededRandom(seed);
  const points: number[][] = Array.from({ length: n }, () => new Array<number>(dims).fill(0));
  for (let d = 0; d < dims; d++) {
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    for (let i = 0; i < n; i++) points[i][d] = (perm[i] + random()) / n;
  }
  return points;
}
