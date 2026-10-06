/**
 * Aesthetic proxy metrics for the Borrowed Orbits study.
 *
 * Pure, deterministic functions over rendered parts (final page millimetres, after finishing). The score is a
 * PROXY FOR SHORTLISTING ONLY. It encodes the thesis: trails that begin on exact drawn circles but do not obey
 * them (neither a still drawing nor unrelated to the guides), a visible event (kinks), trajectories that end
 * abruptly at forbidden regions and captures, and restraint (no stacked ropes, no blank frames, no point flood).
 * It cannot see composition. The bands were calibrated on the pilot renders; humans choose.
 *
 * Ledger against sketches/cloud-advection/aesthetics.ts:
 * - IMPORTED UNCHANGED: `resamplePaths`, `ropeAndSpacing` (rope index: samples whose nearest OTHER path is closer
 *   than a fraction of a pitch; here a stacked-trail detector), `frameContact`, `balance`, `componentStats`,
 *   `occupancy` and `jaccardDistance` (frame-to-frame change), `bandDesirability`, `DESIRABILITY_FLOOR`,
 *   `BANDS.change`, `pathLength`, `latinHypercube`, and the `Band`, `Pt`, `Rect`, `Sample` types.
 * - IMPORTED WITH A SHIM: `occupancy` only reads parts whose id starts with `cloud-` or `streak-`, so trails are
 *   handed to it renamed `cloud-trails` (see `asCloud`). Taking a prefix list, as `isCloudPart` already does, would
 *   remove the shim.
 * - COPIED AND ADAPTED: `score` and the profile table (cloud's is typed to cloud's FrameMetrics keys and PER_FRAME
 *   list, and its hard limits, ropeIndex 0.12 and frameContact 0.2, are wrong for trails), `LIMITS`, the band table
 *   (new metrics, recalibrated ranges), and the geometry helper (cloud's `frameGeometry` knows the quiet core, this
 *   one knows the guide rings).
 * - NEW: `guideAdherence`, `kinkiness`, `escapeShare`, `breakCount`.
 */
import { mapFinishingPoint } from '../../packages/plot-core/src/index.ts';
import {
  BANDS, DESIRABILITY_FLOOR, balance, bandDesirability, componentStats, frameContact, jaccardDistance, occupancy, pathLength,
  resamplePaths, ropeAndSpacing,
} from '../cloud-advection/aesthetics.ts';
import type { Band, FramePart, Pt, Rect, Sample } from '../cloud-advection/aesthetics.ts';
import { STATUS_CODE } from './model.ts';
import type { OrbitSnapshot } from './model.ts';
import type { OrbitStudy } from './study.ts';

export { jaccardDistance, occupancy };
export type { FramePart, Rect };

/** Tunable measurement constants. */
export const MEASURE = {
  /** A trail sample is "on a guide" within this many page mm of a drawn guide circle. */
  guideBandMm: 1.5,
  /** Pitch the rope detector measures against: a sample is roped when another trail is within 0.45 of it. */
  ropePitchMm: 2,
  /** Paths shorter than this are ignored by the shape metrics (dash fragments say nothing about curvature). */
  minShapeLengthMm: 10,
  /** Kink: the heading changes by at least this much between the chords 2.5 mm before and after a point. */
  kinkRadians: 0.5,
  kinkWindowSamples: 5,
  /** Straight escaping run: heading changes under this over ±8 mm, outside the outermost guide, moving away from the centre. */
  straightRadians: 0.05,
  straightWindowSamples: 16,
} as const;

/** Hard feasibility limits: no near-empty frame, no point flood. */
export const LIMITS = { maxPoints: 60_000, minFill: 15 } as const;

/**
 * Desirability bands (zero0, one0, one1, zero1), as in the cloud study. Calibrated on the pilot renders at steps
 * 300 / 600 / 900 (see the header of each band).
 */
export const TRAIL_BANDS: Record<string, Band> = {
  /** Stacked ropes: many borrowed orbits share a path. Lower is better. Pilot frames measure 0.25-0.7 untreated (trailMinSpacing 0), so the zero sits at 0.85. */
  ropeIndex: [-Infinity, -Infinity, 0.3, 0.85],
  /** Trails reaching the frame edge, as perimeter coverage. Some, not a flood. */
  frameContact: [0.02, 0.12, 0.6, 1],
  /** Ink spread over the page's eight outer cells. */
  balance: [0.4, 0.8, Infinity, Infinity],
  /** Trail ink metres per m2 of content. */
  fill: [20, 60, 200, 380],
  /** Share of ink within ±1.5 mm of a guide: too high is a still drawing, too low and the guides read as unrelated. */
  guideAdherence: [0.02, 0.08, 0.4, 0.8],
  /** Trails that end at a forbidden region or a capture inside the frame: pilot windows measure 27-135 because borrowed orbits fall in readily. */
  breakCount: [0, 10, 80, 250],
  /** Share of long paths with a sharp curvature event: a crude proxy for the perturber's visible event. Pilot mid at step 600 measures 0.028 with the perturber and 0 without. */
  kinkiness: [0, 0.01, 0.15, 0.4],
  /** Share of ink in straight escaping runs: some escape is the point, a page of straight lines is not. */
  escapeShare: [-Infinity, -Infinity, 0.2, 0.6],
  change: BANDS.change,
};

const PER_FRAME = ['ropeIndex', 'frameContact', 'balance', 'fill', 'guideAdherence', 'breakCount', 'kinkiness', 'escapeShare'] as const;
export type MetricId = (typeof PER_FRAME)[number];

export interface TrailGeometry {
  content: Rect;
  /** Apparent centre in final page mm. */
  centre: Pt;
  /** Guide radii in final page mm. */
  radiiMm: number[];
}

/** The content rectangle and the guide rings in final page coordinates, mapped exactly as the sketch and the runner do. */
export function trailGeometry(study: OrbitStudy, finishing: Parameters<typeof mapFinishingPoint>[1]): TrailGeometry {
  const wtp = study.config.transforms.worldToPage;
  const c = study.guides.centre;
  const centre = mapFinishingPoint({ x: wtp.offset.x + wtp.scale * c.x, y: wtp.offset.y + wtp.scale * c.y }, finishing);
  return {
    content: { ...finishing.contentRect },
    centre,
    radiiMm: study.guides.radii.map(r => r * wtp.scale * finishing.scale),
  };
}

const trailPaths = (parts: FramePart[]): Pt[][] => parts.filter(p => p.id === 'trails').flatMap(p => p.paths);
/** Trails renamed so the cloud study's `occupancy` reads them. */
const asCloud = (parts: FramePart[]): FramePart[] => [{ id: 'cloud-trails', pen: 'x', paths: trailPaths(parts) }];

/** Share of trail ink within ±MEASURE.guideBandMm of any drawn guide circle (the circles are exact, so this is analytic). */
export function guideAdherence(samples: Sample[], geometry: TrailGeometry): number {
  let total = 0, near = 0;
  for (const s of samples) {
    total += s.weight;
    const d = Math.hypot(s.x - geometry.centre.x, s.y - geometry.centre.y);
    if (geometry.radiiMm.some(r => Math.abs(d - r) <= MEASURE.guideBandMm)) near += s.weight;
  }
  return total > 0 ? near / total : 0;
}

/** Consecutive samples grouped by path index; only paths long enough to have a shape. */
function longRuns(samples: Sample[]): Sample[][] {
  const runs: Sample[][] = [];
  let current: Sample[] = [];
  for (const s of samples) {
    if (current.length && current[0].path !== s.path) { runs.push(current); current = []; }
    current.push(s);
  }
  if (current.length) runs.push(current);
  return runs.filter(run => run.reduce((n, s) => n + s.weight, 0) >= MEASURE.minShapeLengthMm);
}

const turn = (a: Pt, b: Pt, c: Pt): number => {
  const u = { x: b.x - a.x, y: b.y - a.y }, v = { x: c.x - b.x, y: c.y - b.y };
  const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
  if (lu === 0 || lv === 0) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / (lu * lv))));
};

/** Share of long paths that contain a sharp turn (heading change ≥ MEASURE.kinkRadians over a 2.5 mm window each side). */
export function kinkiness(samples: Sample[]): number {
  const runs = longRuns(samples);
  if (runs.length === 0) return 0;
  const w = MEASURE.kinkWindowSamples;
  const kinked = runs.filter(run => {
    for (let i = w; i + w < run.length; i++) if (turn(run[i - w], run[i], run[i + w]) >= MEASURE.kinkRadians) return true;
    return false;
  });
  return kinked.length / runs.length;
}

/** Share of trail ink in straight runs outside the outermost guide that are heading away from the centre. */
export function escapeShare(samples: Sample[], geometry: TrailGeometry): number {
  const total = samples.reduce((n, s) => n + s.weight, 0);
  if (!(total > 0)) return 0;
  const outer = Math.max(...geometry.radiiMm);
  const w = MEASURE.straightWindowSamples;
  const dist = (s: Sample): number => Math.hypot(s.x - geometry.centre.x, s.y - geometry.centre.y);
  let straight = 0;
  for (const run of longRuns(samples)) {
    for (let i = w; i + w < run.length; i++) {
      if (dist(run[i]) > outer && dist(run[i + w]) > dist(run[i - w]) && turn(run[i - w], run[i], run[i + w]) < MEASURE.straightRadians) straight += run[i].weight;
    }
  }
  return Math.min(1, straight / total);
}

/**
 * Trails that visibly end at a forbidden region or a capture: particles that stopped inside [fromStep, snapshot.step]
 * by a forbidden region, an attractor or the absorbing edge, with the stop point inside the poster frame.
 * Escapes (a particle leaving far outside) are not breaks.
 */
export function breakCount(study: OrbitStudy, snapshot: OrbitSnapshot, fromStep: number): number {
  const f = study.frame;
  let n = 0;
  for (let i = 0; i < snapshot.status.length; i++) {
    if (snapshot.status[i] !== STATUS_CODE.captured || snapshot.stoppedAt[i] < fromStep) continue;
    const p = study.worldToArt({ x: snapshot.px[i], y: snapshot.py[i] });
    if (p.x >= f.xMin && p.x <= f.xMax && p.y >= f.yMin && p.y <= f.yMax) n++;
  }
  return n;
}

export interface TrailMetrics {
  inkM: number;
  points: number;
  ropeIndex: number;
  frameContact: number;
  balance: number;
  /** Trail ink metres per square metre of content. */
  fill: number;
  coherence: number;
  largestShare: number;
  guideAdherence: number;
  breakCount: number;
  kinkiness: number;
  escapeShare: number;
}

export interface FrameInput { parts: FramePart[]; geometry: TrailGeometry; breaks: number }

export function frameMetrics(input: FrameInput): TrailMetrics {
  const paths = trailPaths(input.parts);
  const samples = resamplePaths(paths);
  const { content } = input.geometry;
  const area = ((content.xMax - content.xMin) * (content.yMax - content.yMin)) / 1e6;
  const ink = paths.reduce((n, p) => n + pathLength(p), 0) / 1000;
  return {
    inkM: ink,
    points: input.parts.filter(p => !p.diagnostic).reduce((n, p) => n + p.paths.reduce((m, path) => m + path.length, 0), 0),
    ropeIndex: ropeAndSpacing(samples, MEASURE.ropePitchMm).ropeIndex,
    frameContact: frameContact(samples, content),
    balance: balance(samples, content),
    fill: area > 0 ? ink / area : 0,
    ...componentStats(samples, content),
    guideAdherence: guideAdherence(samples, input.geometry),
    breakCount: input.breaks,
    kinkiness: kinkiness(samples),
    escapeShare: escapeShare(samples, input.geometry),
  };
}

/** Occupancy of a frame's trail ink, for frame-to-frame change. */
export const trailOccupancy = (parts: FramePart[], content: Rect): Set<number> => occupancy(asCloud(parts), content);

export interface SearchMetrics { frames: TrailMetrics[]; change01: number; change12: number }
export interface Score { feasible: boolean; violations: string[]; desirability: number; parts: Record<string, number> }

/**
 * Hard constraints first (each frame: points <= 60k, fill >= 15 so no frame is near-empty), then the desirability: the
 * geometric mean over frames and metrics of the band desirabilities, floored so one zero does not erase the ranking.
 */
export function score(metrics: SearchMetrics): Score {
  const violations: string[] = [];
  metrics.frames.forEach((frame, i) => {
    if (frame.points > LIMITS.maxPoints) violations.push(`frame ${i}: points ${frame.points} > ${LIMITS.maxPoints}`);
    if (frame.fill < LIMITS.minFill) violations.push(`frame ${i}: fill ${frame.fill.toFixed(1)} < ${LIMITS.minFill}`);
  });
  const floor = (d: number): number => Math.max(DESIRABILITY_FLOOR, d);
  const parts: Record<string, number> = {};
  for (const id of PER_FRAME) {
    const logs = metrics.frames.map(frame => Math.log(floor(bandDesirability(TRAIL_BANDS[id], frame[id]))));
    parts[id] = Math.exp(logs.reduce((a, b) => a + b, 0) / Math.max(1, logs.length));
  }
  parts.change01 = floor(bandDesirability(TRAIL_BANDS.change, metrics.change01));
  parts.change12 = floor(bandDesirability(TRAIL_BANDS.change, metrics.change12));
  const values = Object.values(parts);
  return { feasible: violations.length === 0, violations, desirability: Math.exp(values.reduce((s, v) => s + Math.log(v), 0) / values.length), parts };
}
