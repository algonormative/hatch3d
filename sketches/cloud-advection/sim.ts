/**
 * Prescribed-flow passive advection core (see model.ts for the contract).
 *
 * Pure TypeScript, deterministic, no I/O. The velocity field is steady, so the
 * RK2 backtrace and the wall-aware interpolation weights of every fluid cell
 * are computed once per domain (a "stencil") and reused for every step; a step
 * is then an indexed gather plus optional conservative diffusion.
 *
 * Solid polygon edges block transport as geometry (segment tests against an
 * edge bucket grid), never through the raster mask, so walls thinner than a
 * cell still stop mass. A blocked backtrace reads zero: solids and closed
 * domain edges are perfect absorbers and the air behind them is clean.
 * Edges lying outside the domain rectangle are still bucketed and still block;
 * in open mode that only matters for a wall within one cell of the edge, since
 * traces that end farther out read zero anyway.
 */
import { LIMITS, MODEL, SNAPSHOT_SCHEMA } from './model.ts';
import type { ActiveVortex, CloudSnapshot, CloudStudyConfig, EddyDrift, SnapshotHashes, Vec2, WeatherFront } from './model.ts';

// ---------------------------------------------------------------- hashing

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
const BYTE_BIG: bigint[] = Array.from({ length: 256 }, (_, i) => BigInt(i));

function fnv1a64(bytes: Uint8Array): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BYTE_BIG[bytes[i]];
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

function canonical(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new RangeError(`${path} must be finite`);
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => canonical(v, `${path}[${i}]`)).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        if (obj[key] === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${canonical(obj[key], `${path}.${key}`)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`${path} has unsupported type ${typeof value}`);
  }
}

/** Canonical JSON (sorted object keys) hashed with FNV-1a 64 → 16 hex chars. */
export function stableHash(value: unknown): string {
  return fnv1a64(new TextEncoder().encode(canonical(value, '$')));
}

/** FNV-1a 64 over the exact little-endian Float64 bytes. */
export function hashFloat64(values: ArrayLike<number>): string {
  const n = values.length;
  const view = new DataView(new ArrayBuffer(n * 8));
  for (let i = 0; i < n; i++) view.setFloat64(i * 8, values[i], true);
  return fnv1a64(new Uint8Array(view.buffer));
}

export function configHashes(config: CloudStudyConfig): SnapshotHashes {
  const geometry = stableHash({
    domain: config.domain,
    solids: config.solids,
    source: { center: config.source.center, radii: config.source.radii },
  });
  const transform = stableHash(config.transforms);
  const simulation = stableHash({
    settings: config.settings,
    wind: config.wind,
    vortices: config.vortices,
    front: config.front, // omitted from the canonical form when absent
    eddyDrift: driftOf(config) === 'fixed' ? undefined : config.eddyDrift, // fixed (or absent) is never hashed
    eddyTrain: config.eddyTrain, // omitted from the canonical form when absent
    source: {
      amplitude: config.source.amplitude,
      noiseScale: config.source.noiseScale,
      seed: config.source.seed,
    },
    model: MODEL,
  });
  return { geometry, transform, simulation, stateKey: stableHash({ geometry, transform, simulation }) };
}

// --------------------------------------------------------------- velocity

/** Flat vortex field for fast velocity evaluation (same arithmetic as the kernel in the docs). */
interface VField { n: number; x: Float64Array; y: Float64Array; gam: Float64Array; core2: Float64Array }

function toField(vs: ReadonlyArray<ActiveVortex>): VField {
  const n = vs.length;
  const f: VField = { n, x: new Float64Array(n), y: new Float64Array(n), gam: new Float64Array(n), core2: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    f.x[i] = vs[i].center.x;
    f.y[i] = vs[i].center.y;
    f.gam[i] = vs[i].circulation / (2 * Math.PI);
    f.core2[i] = vs[i].coreRadius * vs[i].coreRadius;
  }
  return f;
}

/** wind + Σ regularized vortices of `f`; writes into `out`. */
function velocityInto(wx: number, wy: number, f: VField, px: number, py: number, out: Vec2): void {
  let vx = wx;
  let vy = wy;
  for (let i = 0; i < f.n; i++) {
    const dx = px - f.x[i];
    const dy = py - f.y[i];
    const k = f.gam[i] / (dx * dx + dy * dy + f.core2[i]);
    vx += k * -dy;
    vy += k * dx;
  }
  out.x = vx;
  out.y = vy;
}

/** Velocity (m/s) for the INITIAL vortex layout (static vortices plus any train eddy spawned at step 0). */
export function velocityAt(config: CloudStudyConfig, p: Vec2): Vec2 {
  return velocityAtTime(config, initialVortices(config), p);
}

/**
 * Velocity (m/s) for an active vortex list, e.g. `snapshot.vortices` or
 * `vortexStateAt(config, step)`. Note the density backtrace of a step uses the
 * midpoint centres of that step, see EddyDrift.
 */
export function velocityAtTime(config: CloudStudyConfig, vortices: ReadonlyArray<ActiveVortex>, p: Vec2): Vec2 {
  const out = { x: 0, y: 0 };
  velocityInto(config.wind.velocity.x, config.wind.velocity.y, toField(vortices), p.x, p.y, out);
  return out;
}

function driftOf(config: CloudStudyConfig): EddyDrift {
  return config.eddyDrift ?? 'fixed';
}

const isMoving = (config: CloudStudyConfig): boolean =>
  driftOf(config) !== 'fixed' && (config.vortices.length > 0 || config.eddyTrain !== undefined);

const copyVortex = (v: ActiveVortex): ActiveVortex => ({
  key: v.key, center: { x: v.center.x, y: v.center.y }, circulation: v.circulation, coreRadius: v.coreRadius,
});

// ------------------------------------------------------------- eddy train

export interface TrainSpawn {
  /** Spawn index k (key `train-<k>`). */
  index: number;
  /** Step at which the eddy first exists in the state. */
  step: number;
  center: Vec2;
  /** Signed circulation. */
  circulation: number;
}

/** Upwind edge: most negative outward-normal · wind; ties in the order left, right, top, bottom. */
function upwindEdge(wind: Vec2): 'left' | 'right' | 'top' | 'bottom' {
  const dots: Array<['left' | 'right' | 'top' | 'bottom', number]> = [
    ['left', -wind.x], ['right', wind.x], ['top', -wind.y], ['bottom', wind.y],
  ];
  let best = dots[0];
  for (const d of dots) if (d[1] < best[1]) best = d;
  return best[0];
}

function trainSchedule(config: CloudStudyConfig): TrainSpawn[] {
  const t = config.eddyTrain;
  if (!t) return [];
  const { origin, size } = config.domain;
  const edge = upwindEdge(config.wind.velocity);
  const out: TrainSpawn[] = [];
  for (let k = 0; ; k++) {
    const J = t.timingJitter;
    const jitter = J === 0 ? 0 : Math.min(2 * J, Math.floor(hashNoise(t.seed, k, 0x51) * (2 * J + 1))) - J;
    const step = t.firstStep + k * t.period + jitter;
    if (step > LIMITS.maxSteps) break;
    const r = 2 * hashNoise(t.seed, k, 0x77) - 1;
    const sign = t.alternate && k % 2 === 1 ? -1 : 1;
    let center: Vec2;
    if (edge === 'left' || edge === 'right') {
      const y = origin.y + size.y / 2 + t.lateralJitter * r * (size.y / 2);
      center = { x: edge === 'left' ? origin.x - t.coreRadius : origin.x + size.x + t.coreRadius, y };
    } else {
      const x = origin.x + size.x / 2 + t.lateralJitter * r * (size.x / 2);
      center = { x, y: edge === 'top' ? origin.y - t.coreRadius : origin.y + size.y + t.coreRadius };
    }
    out.push({ index: k, step, center, circulation: sign * t.circulation });
  }
  return out;
}

/** Every spawn of the config's eddy train through LIMITS.maxSteps, in spawn order (empty without a train). */
export function eddyTrainSpawns(config: CloudStudyConfig): TrainSpawn[] {
  validateConfig(config);
  return trainSchedule(config).map((s) => ({ ...s, center: { ...s.center } }));
}

const staticVortices = (config: CloudStudyConfig): ActiveVortex[] => config.vortices.map((v) => ({
  key: v.id, center: { x: v.center.x, y: v.center.y }, circulation: v.circulation, coreRadius: v.coreRadius,
}));

const spawnVortex = (sp: TrainSpawn, coreRadius: number): ActiveVortex => ({
  key: `train-${sp.index}`, center: { x: sp.center.x, y: sp.center.y }, circulation: sp.circulation, coreRadius,
});

function initialVortices(config: CloudStudyConfig, schedule: TrainSpawn[] = trainSchedule(config)): ActiveVortex[] {
  const out = staticVortices(config);
  const train = config.eddyTrain;
  if (train) for (const sp of schedule) if (sp.step === 0) out.push(spawnVortex(sp, train.coreRadius));
  return out;
}

/** One RK2 (midpoint) step of every active vortex at the fixed dt. */
function stepVortices(config: CloudStudyConfig, vs: ReadonlyArray<ActiveVortex>): ActiveVortex[] {
  const { dt } = config.settings;
  const U = config.wind.velocity;
  const kirchhoff = driftOf(config) === 'kirchhoff';
  const f = toField(vs);
  const m = vs.length;
  const velocities = (xs: number[], ys: number[]): Vec2[] => xs.map((cx, i) => {
    let vx = U.x;
    let vy = U.y;
    if (kirchhoff) {
      for (let k = 0; k < m; k++) {
        if (k === i) continue; // no self-induction
        const dx = cx - xs[k];
        const dy = ys[i] - ys[k];
        const kk = f.gam[k] / (dx * dx + dy * dy + f.core2[k]);
        vx += kk * -dy;
        vy += kk * dx;
      }
    }
    return { x: vx, y: vy };
  });
  const xs = vs.map((v) => v.center.x);
  const ys = vs.map((v) => v.center.y);
  const k1 = velocities(xs, ys);
  const k2 = velocities(xs.map((x, i) => x + 0.5 * dt * k1[i].x), ys.map((y, i) => y + 0.5 * dt * k1[i].y));
  return vs.map((v, i) => ({
    key: v.key, circulation: v.circulation, coreRadius: v.coreRadius,
    center: { x: xs[i] + dt * k2[i].x, y: ys[i] + dt * k2[i].y },
  }));
}

/**
 * State transition n → n+1: move all eddies (RK2), remove train eddies beyond
 * removeMargin, then spawn the eddy scheduled for step n+1 (evicting the oldest
 * train eddy at maxActive). `mid` is the midpoint layout the backtrace uses.
 */
function advanceState(
  config: CloudStudyConfig, schedule: TrainSpawn[], active: ReadonlyArray<ActiveVortex>, n: number,
): { next: ActiveVortex[]; mid: ActiveVortex[] } {
  const moved = stepVortices(config, active);
  const mid = active.map((v, i) => ({
    key: v.key, circulation: v.circulation, coreRadius: v.coreRadius,
    center: { x: 0.5 * (v.center.x + moved[i].center.x), y: 0.5 * (v.center.y + moved[i].center.y) },
  }));
  const train = config.eddyTrain;
  if (!train) return { next: moved, mid };
  const S = config.vortices.length;
  const { origin, size } = config.domain;
  const x1 = origin.x + size.x;
  const y1 = origin.y + size.y;
  let next = moved.filter((v, i) => {
    if (i < S) return true; // static vortices are never removed
    const dx = Math.max(origin.x - v.center.x, 0, v.center.x - x1);
    const dy = Math.max(origin.y - v.center.y, 0, v.center.y - y1);
    return Math.hypot(dx, dy) <= train.removeMargin;
  });
  const spawn = schedule.find((sp) => sp.step === n + 1);
  if (spawn) {
    if (next.length - S >= train.maxActive) next = [...next.slice(0, S), ...next.slice(S + 1)];
    next.push(spawnVortex(spawn, train.coreRadius));
  }
  return { next, mid };
}

/**
 * Active vortex list at an integer step: a deterministic replay of the same
 * transition the stepper uses, so it is bitwise equal to a snapshot's list.
 */
export function vortexStateAt(config: CloudStudyConfig, step: number): ActiveVortex[] {
  validateConfig(config);
  if (!Number.isInteger(step) || step < 0 || step > LIMITS.maxSteps) {
    throw new RangeError(`step must be an integer in [0, ${LIMITS.maxSteps}]`);
  }
  const schedule = trainSchedule(config);
  let active = initialVortices(config, schedule);
  if (!isMoving(config)) return active;
  for (let n = 0; n < step; n++) active = advanceState(config, schedule, active, n).next;
  return active;
}

// ------------------------------------------------------------ weather front

/** 3-octave seeded value-noise sum, normalized to [0, 1]. */
function fbm(seed: number, x: number, y: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < 3; o++) {
    sum += amp * valueNoise(seed + o * 0x153e, x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

const DEFAULT_FRONT_SOFTNESS = 0.12;

/** The static upstream pattern W(x, y). */
function frontField(f: WeatherFront, x: number, y: number): number {
  const v = fbm(f.seed, x / f.scale, y / f.scale);
  const soft = f.softness ?? DEFAULT_FRONT_SOFTNESS;
  return f.amplitude * smoothstep(1 - f.coverage - soft, 1 - f.coverage + soft, v) + 0;
}

/**
 * Upstream cloud field at world point p and time timeS: W(p − wind·timeS), the
 * frozen pattern carried rigidly by the uniform wind (vortices do not move it).
 * Returns 0 for a config without a front.
 */
export function frontAt(config: CloudStudyConfig, p: Vec2, timeS: number): number {
  if (!config.front) return 0;
  finite('p.x', p.x);
  finite('p.y', p.y);
  finite('timeS', timeS);
  return frontField(config.front, p.x - config.wind.velocity.x * timeS, p.y - config.wind.velocity.y * timeS);
}

// ----------------------------------------------------------------- domain

export interface CloudDomain {
  readonly config: CloudStudyConfig;
  readonly hashes: SnapshotHashes;
  readonly cols: number;
  readonly rows: number;
  readonly spacing: number;
  readonly cellArea: number;
  /** 1 where the cell center is inside any solid polygon (even-odd per polygon). */
  readonly solid: Uint8Array;
  /**
   * Smallest t in [0, 1] where segment a→b crosses a solid polygon edge (or
   * leaves the domain rectangle when the boundary is `closed`); null if none.
   */
  segmentBlocked(a: Vec2, b: Vec2): number | null;
}

interface Internals {
  ox: number;
  oy: number;
  h: number;
  cols: number;
  rows: number;
  closed: boolean;
  inflow: boolean;
  front?: WeatherFront;
  windX: number;
  windY: number;
  x1: number;
  y1: number;
  /** Per edge: cx, cy, sx, sy (start and direction vector). */
  edges: Float64Array;
  nEdges: number;
  bucketSize: number;
  nbx: number;
  nby: number;
  bucketStart: Int32Array;
  bucketEdges: Int32Array;
  /** (cols+1)·(rows+1) squares between four cell centers; 1 if a solid edge touches it. */
  dualHasEdge: Uint8Array;
  solid: Uint8Array;
  engine?: Engine;
}

const INTERNALS = new WeakMap<CloudDomain, Internals>();
const HIT_EPS = 1e-12;
const SNAP = 1e-9;
const DIFFUSION_CFL = 0.2;

export class SnapshotMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotMismatchError';
  }
}

function finite(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function positive(name: string, value: number): void {
  finite(name, value);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function vec(name: string, v: Vec2): void {
  finite(`${name}.x`, v.x);
  finite(`${name}.y`, v.y);
}

/** Explicit-diffusion substeps for stability (0 when diffusion is off). Rejects unbounded work. */
function diffusionSubsteps(settings: { dt: number; diffusivity: number }, h: number): number {
  if (settings.diffusivity === 0) return 0;
  const raw = (settings.diffusivity * settings.dt) / (h * h) / DIFFUSION_CFL;
  if (!Number.isFinite(raw) || Math.ceil(raw) > LIMITS.maxDiffusionSubsteps) {
    throw new RangeError(
      `diffusion needs ${Number.isFinite(raw) ? Math.ceil(raw) : 'unbounded'} substeps per step, above the limit of ${LIMITS.maxDiffusionSubsteps}; reduce diffusivity or dt`,
    );
  }
  return Math.max(1, Math.ceil(raw));
}

/** Total gather/diffusion work for `steps` steps, rejected before any is done. */
function checkWork(domain: CloudDomain, steps: number): void {
  const substeps = diffusionSubsteps(domain.config.settings, domain.spacing);
  // A drifting-eddy step rebuilds the backtrace stencil: about five gathers' worth of work per cell (measured,
  // and it runs alongside the diffusion substeps), so it counts as at least five updates per cell-step.
  const perCellStep = Math.max(1, substeps, isMoving(domain.config) ? 5 : 0);
  const work = domain.cols * domain.rows * steps * perCellStep;
  if (work > LIMITS.maxWork) {
    throw new RangeError(`${steps} steps on ${domain.cols * domain.rows} cells needs ${work} cell updates, above the limit of ${LIMITS.maxWork}`);
  }
}

function validateConfig(config: CloudStudyConfig): void {
  const { domain, transforms, settings, wind, vortices, source, solids } = config;
  vec('domain.origin', domain.origin);
  vec('domain.size', domain.size);
  positive('domain.size.x', domain.size.x);
  positive('domain.size.y', domain.size.y);
  const g = transforms.worldToGrid;
  vec('worldToGrid.origin', g.origin);
  positive('worldToGrid.spacing', g.spacing);
  for (const key of ['cols', 'rows'] as const) {
    finite(`worldToGrid.${key}`, g[key]);
    if (!Number.isInteger(g[key]) || g[key] < 1) throw new RangeError(`worldToGrid.${key} must be a positive integer`);
  }
  if (g.cols * g.rows > LIMITS.maxCells) {
    throw new RangeError(`grid has ${g.cols * g.rows} cells, above the limit of ${LIMITS.maxCells}`);
  }
  if (Math.abs(g.cols * g.spacing - domain.size.x) > 1e-9 * domain.size.x ||
      Math.abs(g.rows * g.spacing - domain.size.y) > 1e-9 * domain.size.y) {
    throw new RangeError('grid does not cover the domain: cols·spacing and rows·spacing must equal domain.size');
  }
  if (Math.abs(g.origin.x - domain.origin.x) > 1e-9 * domain.size.x ||
      Math.abs(g.origin.y - domain.origin.y) > 1e-9 * domain.size.y) {
    throw new RangeError('worldToGrid.origin must equal domain.origin');
  }
  positive('worldToPage.scale', transforms.worldToPage.scale);
  vec('worldToPage.offset', transforms.worldToPage.offset);
  positive('settings.dt', settings.dt);
  finite('settings.diffusivity', settings.diffusivity);
  if (settings.diffusivity < 0) throw new RangeError('settings.diffusivity must be nonnegative');
  diffusionSubsteps(settings, g.spacing);
  if (settings.boundary !== 'open' && settings.boundary !== 'closed' && settings.boundary !== 'inflow') {
    throw new RangeError("settings.boundary must be 'open', 'closed' or 'inflow'");
  }
  if (config.eddyTrain) {
    const t = config.eddyTrain;
    if (driftOf(config) === 'fixed') throw new RangeError("eddyTrain requires eddyDrift 'wind' or 'kirchhoff'");
    const int = (name: string, v: number, min: number): void => {
      finite(name, v);
      if (!Number.isInteger(v) || v < min) throw new RangeError(`${name} must be an integer >= ${min}`);
    };
    int('eddyTrain.period', t.period, 1);
    int('eddyTrain.firstStep', t.firstStep, 0);
    int('eddyTrain.timingJitter', t.timingJitter, 0);
    if (2 * t.timingJitter >= t.period) throw new RangeError('eddyTrain.timingJitter must satisfy 2·timingJitter < period (spawns never reorder)');
    if (t.firstStep < t.timingJitter) throw new RangeError('eddyTrain.firstStep must be >= timingJitter');
    finite('eddyTrain.circulation', t.circulation);
    if (t.circulation <= 0) throw new RangeError('eddyTrain.circulation is a magnitude and must be positive');
    positive('eddyTrain.coreRadius', t.coreRadius);
    finite('eddyTrain.lateralJitter', t.lateralJitter);
    if (t.lateralJitter < 0 || t.lateralJitter > 1) throw new RangeError('eddyTrain.lateralJitter must be in [0, 1]');
    finite('eddyTrain.seed', t.seed);
    if (!Number.isInteger(t.seed) || t.seed < 0 || t.seed > 0xffffffff) throw new RangeError('eddyTrain.seed must be a uint32');
    finite('eddyTrain.removeMargin', t.removeMargin);
    if (t.removeMargin < 0) throw new RangeError('eddyTrain.removeMargin must be nonnegative');
    int('eddyTrain.maxActive', t.maxActive, 1);
    if (t.maxActive > LIMITS.maxTrainEddies) throw new RangeError(`eddyTrain.maxActive must be <= ${LIMITS.maxTrainEddies}`);
    if (typeof t.alternate !== 'boolean') throw new RangeError('eddyTrain.alternate must be a boolean');
    if (config.vortices.some((v) => v.id.startsWith('train-'))) throw new RangeError("static vortex ids must not start with 'train-'");
  }
  if (config.eddyDrift !== undefined && config.eddyDrift !== 'fixed' && config.eddyDrift !== 'wind' && config.eddyDrift !== 'kirchhoff') {
    throw new RangeError("eddyDrift must be 'fixed', 'wind' or 'kirchhoff'");
  }
  if (settings.boundary === 'inflow' && !config.front) {
    throw new RangeError("settings.boundary 'inflow' requires config.front");
  }
  if (config.front) {
    const f = config.front;
    finite('front.amplitude', f.amplitude);
    if (f.amplitude < 0) throw new RangeError('front.amplitude must be nonnegative');
    positive('front.scale', f.scale);
    finite('front.coverage', f.coverage);
    if (f.coverage < 0 || f.coverage > 1) throw new RangeError('front.coverage must be in [0, 1]');
    finite('front.seed', f.seed);
    if (!Number.isInteger(f.seed) || f.seed < 0 || f.seed > 0xffffffff) throw new RangeError('front.seed must be a uint32');
    if (typeof f.fillInterior !== 'boolean') throw new RangeError('front.fillInterior must be a boolean');
    if (f.softness !== undefined) {
      finite('front.softness', f.softness);
      if (f.softness < 0.02 || f.softness > 0.5) throw new RangeError('front.softness must be in [0.02, 0.5]');
    }
  }
  vec('wind.velocity', wind.velocity);
  vortices.forEach((v, i) => {
    vec(`vortices[${i}].center`, v.center);
    finite(`vortices[${i}].circulation`, v.circulation);
    positive(`vortices[${i}].coreRadius`, v.coreRadius);
  });
  vec('source.center', source.center);
  vec('source.radii', source.radii);
  positive('source.radii.x', source.radii.x);
  positive('source.radii.y', source.radii.y);
  finite('source.amplitude', source.amplitude);
  if (source.amplitude < 0) throw new RangeError('source.amplitude must be nonnegative');
  positive('source.noiseScale', source.noiseScale);
  finite('source.seed', source.seed);
  if (!Number.isInteger(source.seed) || source.seed < 0 || source.seed > 0xffffffff) {
    throw new RangeError('source.seed must be a uint32');
  }
  solids.forEach((s, i) => {
    if (s.polygon.length < 3) throw new RangeError(`solids[${i}].polygon needs at least 3 vertices`);
    s.polygon.forEach((p, k) => vec(`solids[${i}].polygon[${k}]`, p));
  });
}

function segHitsRect(
  ax: number, ay: number, bx: number, by: number,
  x0: number, y0: number, x1: number, y1: number,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) {
      if (q[k] < 0) return false;
    } else {
      const r = q[k] / p[k];
      if (p[k] < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return true;
}

/** Smallest t in [0,1] where a→b meets a solid edge, or Infinity. */
function firstSolidHit(n: Internals, ax: number, ay: number, bx: number, by: number): number {
  if (n.nEdges === 0) return Infinity;
  const { ox, oy, bucketSize, nbx, nby, edges, bucketStart, bucketEdges } = n;
  const rx = bx - ax;
  const ry = by - ay;
  const bx0 = Math.min(nbx - 1, Math.max(0, Math.floor((Math.min(ax, bx) - ox) / bucketSize)));
  const bx1 = Math.min(nbx - 1, Math.max(0, Math.floor((Math.max(ax, bx) - ox) / bucketSize)));
  const by0 = Math.min(nby - 1, Math.max(0, Math.floor((Math.min(ay, by) - oy) / bucketSize)));
  const by1 = Math.min(nby - 1, Math.max(0, Math.floor((Math.max(ay, by) - oy) / bucketSize)));
  let best = Infinity;
  for (let jb = by0; jb <= by1; jb++) {
    for (let ib = bx0; ib <= bx1; ib++) {
      const b = jb * nbx + ib;
      for (let k = bucketStart[b]; k < bucketStart[b + 1]; k++) {
        const e = bucketEdges[k] * 4;
        const cx = edges[e];
        const cy = edges[e + 1];
        const sx = edges[e + 2];
        const sy = edges[e + 3];
        const denom = rx * sy - ry * sx;
        if (denom === 0) continue;
        const qx = cx - ax;
        const qy = cy - ay;
        const t = (qx * sy - qy * sx) / denom;
        if (t < -HIT_EPS || t > 1 + HIT_EPS || t >= best) continue;
        const u = (qx * ry - qy * rx) / denom;
        if (u < -HIT_EPS || u > 1 + HIT_EPS) continue;
        best = t;
      }
    }
  }
  return best === Infinity ? Infinity : Math.min(1, Math.max(0, best));
}

/** Parameter where a→b leaves the closed-mode domain rectangle, or Infinity. */
function firstDomainExit(n: Internals, ax: number, ay: number, bx: number, by: number): number {
  const { ox, oy, x1, y1 } = n;
  if (ax < ox || ax > x1 || ay < oy || ay > y1) return 0;
  let best = Infinity;
  const dx = bx - ax;
  const dy = by - ay;
  if (bx > x1) best = Math.min(best, (x1 - ax) / dx);
  else if (bx < ox) best = Math.min(best, (ox - ax) / dx);
  if (by > y1) best = Math.min(best, (y1 - ay) / dy);
  else if (by < oy) best = Math.min(best, (oy - ay) / dy);
  return best;
}

function firstBlock(n: Internals, ax: number, ay: number, bx: number, by: number): number {
  let t = firstSolidHit(n, ax, ay, bx, by);
  if (n.closed) t = Math.min(t, firstDomainExit(n, ax, ay, bx, by));
  return t;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Validates the config, then keeps a frozen deep copy of it: later mutation of
 * the caller's object cannot desync `domain.config` from `domain.hashes`.
 */
export function buildDomain(input: CloudStudyConfig): CloudDomain {
  validateConfig(input);
  const config = deepFreeze(structuredClone(input));
  const hashes = configHashes(config); // also rejects non-finite values anywhere in the config
  const { cols, rows, spacing: h } = config.transforms.worldToGrid;
  const ox = config.transforms.worldToGrid.origin.x;
  const oy = config.transforms.worldToGrid.origin.y;
  const N = cols * rows;

  // Edges (every polygon closed back to its first vertex).
  let nEdges = 0;
  for (const s of config.solids) nEdges += s.polygon.length;
  const edges = new Float64Array(nEdges * 4);
  const bboxes = new Float64Array(nEdges * 4); // minx, miny, maxx, maxy
  {
    let e = 0;
    for (const s of config.solids) {
      const poly = s.polygon;
      for (let k = 0; k < poly.length; k++, e++) {
        const a = poly[k];
        const b = poly[(k + 1) % poly.length];
        edges[e * 4] = a.x;
        edges[e * 4 + 1] = a.y;
        edges[e * 4 + 2] = b.x - a.x;
        edges[e * 4 + 3] = b.y - a.y;
        bboxes[e * 4] = Math.min(a.x, b.x);
        bboxes[e * 4 + 1] = Math.min(a.y, b.y);
        bboxes[e * 4 + 2] = Math.max(a.x, b.x);
        bboxes[e * 4 + 3] = Math.max(a.y, b.y);
      }
    }
  }

  // Bucket grid (CSR). Edges are assigned by bounding box, clamped to the domain.
  const bucketSize = 2 * h;
  const nbx = Math.max(1, Math.ceil(cols * h / bucketSize));
  const nby = Math.max(1, Math.ceil(rows * h / bucketSize));
  const clampB = (v: number, n: number): number => Math.min(n - 1, Math.max(0, Math.floor(v)));
  const counts = new Int32Array(nbx * nby + 1);
  const forBuckets = (e: number, fn: (b: number) => void): void => {
    const i0 = clampB((bboxes[e * 4] - ox) / bucketSize, nbx);
    const i1 = clampB((bboxes[e * 4 + 2] - ox) / bucketSize, nbx);
    const j0 = clampB((bboxes[e * 4 + 1] - oy) / bucketSize, nby);
    const j1 = clampB((bboxes[e * 4 + 3] - oy) / bucketSize, nby);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * nbx + i);
  };
  for (let e = 0; e < nEdges; e++) forBuckets(e, (b) => { counts[b + 1]++; });
  for (let b = 0; b < nbx * nby; b++) counts[b + 1] += counts[b];
  const bucketStart = counts;
  const fill = new Int32Array(nbx * nby);
  const bucketEdges = new Int32Array(bucketStart[nbx * nby]);
  for (let e = 0; e < nEdges; e++) {
    forBuckets(e, (b) => { bucketEdges[bucketStart[b] + fill[b]++] = e; });
  }

  // Dual squares (between four adjacent cell centers) that any solid edge touches.
  const dualCols = cols + 1;
  const dualHasEdge = new Uint8Array(dualCols * (rows + 1));
  const pad = 1e-6 * h;
  for (let e = 0; e < nEdges; e++) {
    const gxMin = (bboxes[e * 4] - ox) / h - 0.5;
    const gxMax = (bboxes[e * 4 + 2] - ox) / h - 0.5;
    const gyMin = (bboxes[e * 4 + 1] - oy) / h - 0.5;
    const gyMax = (bboxes[e * 4 + 3] - oy) / h - 0.5;
    const i0 = Math.max(-1, Math.floor(gxMin - SNAP));
    const i1 = Math.min(cols - 1, Math.floor(gxMax + SNAP));
    const j0 = Math.max(-1, Math.floor(gyMin - SNAP));
    const j1 = Math.min(rows - 1, Math.floor(gyMax + SNAP));
    const ax = edges[e * 4];
    const ay = edges[e * 4 + 1];
    const bx = ax + edges[e * 4 + 2];
    const by = ay + edges[e * 4 + 3];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = (i + 1) + (j + 1) * dualCols;
        if (dualHasEdge[idx]) continue;
        const x0 = ox + (i + 0.5) * h - pad;
        const y0 = oy + (j + 0.5) * h - pad;
        if (segHitsRect(ax, ay, bx, by, x0, y0, x0 + h + 2 * pad, y0 + h + 2 * pad)) dualHasEdge[idx] = 1;
      }
    }
  }

  // Solid raster: cell center inside any polygon (even-odd per polygon).
  const solid = new Uint8Array(N);
  for (const s of config.solids) {
    const poly = s.polygon;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const i0 = Math.max(0, Math.floor((minX - ox) / h - 0.5));
    const i1 = Math.min(cols - 1, Math.ceil((maxX - ox) / h - 0.5));
    const j0 = Math.max(0, Math.floor((minY - oy) / h - 0.5));
    const j1 = Math.min(rows - 1, Math.ceil((maxY - oy) / h - 0.5));
    for (let j = j0; j <= j1; j++) {
      const py = oy + (j + 0.5) * h;
      for (let i = i0; i <= i1; i++) {
        const px = ox + (i + 0.5) * h;
        let inside = false;
        for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
          const a = poly[k];
          const b = poly[m];
          if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
            inside = !inside;
          }
        }
        if (inside) solid[j * cols + i] = 1;
      }
    }
  }

  const internals: Internals = {
    ox, oy, h, cols, rows,
    closed: config.settings.boundary === 'closed',
    inflow: config.settings.boundary === 'inflow',
    front: config.front,
    windX: config.wind.velocity.x,
    windY: config.wind.velocity.y,
    x1: ox + cols * h,
    y1: oy + rows * h,
    edges, nEdges, bucketSize, nbx, nby, bucketStart, bucketEdges, dualHasEdge, solid,
  };
  const domain: CloudDomain = {
    config, hashes, cols, rows, spacing: h, cellArea: h * h, solid,
    segmentBlocked(a: Vec2, b: Vec2): number | null {
      const t = firstBlock(internals, a.x, a.y, b.x, b.y);
      return t === Infinity ? null : Math.min(1, Math.max(0, t));
    },
  };
  INTERNALS.set(domain, internals);
  return domain;
}

function internalsOf(domain: CloudDomain): Internals {
  const n = INTERNALS.get(domain);
  if (!n) throw new TypeError('domain was not created by buildDomain');
  return n;
}

// ------------------------------------------------- wall-aware interpolation

interface GhostOut { n: number; x: Float64Array; y: Float64Array; w: Float64Array }
const newGhost = (): GhostOut => ({ n: 0, x: new Float64Array(4), y: new Float64Array(4), w: new Float64Array(4) });

/**
 * Fill up to four (cell, weight) pairs approximating the density at q.
 * Weights are normalized over contributing corners. When no corner can
 * contribute, the cell containing q is used if it is fluid and reachable from
 * q without crossing a solid edge; otherwise the value is 0. Every value read
 * is therefore reachable from q on the same side of every wall. Returns the
 * pair count; zero pairs means the value is 0 (ghost inflow or nothing visible).
 */
function sampleStencil(
  n: Internals, qx: number, qy: number,
  idxOut: Int32Array, wOut: Float64Array, ghost: GhostOut | null = null,
): number {
  if (ghost) ghost.n = 0;
  const { ox, oy, h, cols, rows, closed, solid, nEdges, dualHasEdge } = n;
  const gx = (qx - ox) / h - 0.5;
  const gy = (qy - oy) / h - 0.5;
  let i0 = Math.floor(gx);
  let fx = gx - i0;
  if (fx < SNAP) fx = 0;
  else if (fx > 1 - SNAP) { i0++; fx = 0; }
  let j0 = Math.floor(gy);
  let fy = gy - j0;
  if (fy < SNAP) fy = 0;
  else if (fy > 1 - SNAP) { j0++; fy = 0; }
  const dualIdx = (i0 + 1) + (j0 + 1) * (cols + 1);
  const dualInRange = i0 >= -1 && i0 <= cols - 1 && j0 >= -1 && j0 <= rows - 1;

  let count = 0;
  let wsum = 0;
  for (let k = 0; k < 4; k++) {
    const di = k & 1;
    const dj = k >> 1;
    const w = (di ? fx : 1 - fx) * (dj ? fy : 1 - fy);
    if (!(w > 0)) continue;
    const ci = i0 + di;
    const cj = j0 + dj;
    if (ci < 0 || ci >= cols || cj < 0 || cj >= rows) {
      if (!closed) {
        wsum += w; // open: zero-valued ghost corner keeps its weight
        if (ghost) { // inflow: the ghost corner reads the upstream field at its world position
          ghost.x[ghost.n] = ox + (ci + 0.5) * h;
          ghost.y[ghost.n] = oy + (cj + 0.5) * h;
          ghost.w[ghost.n] = w;
          ghost.n++;
        }
      }
      continue;
    }
    const idx = cj * cols + ci;
    if (solid[idx]) continue;
    if (nEdges > 0 && dualInRange && dualHasEdge[dualIdx] &&
        firstSolidHit(n, qx, qy, ox + (ci + 0.5) * h, oy + (cj + 0.5) * h) !== Infinity) continue;
    idxOut[count] = idx;
    wOut[count] = w;
    count++;
    wsum += w;
  }
  if (count > 0) {
    for (let k = 0; k < count; k++) wOut[k] /= wsum;
    if (ghost) for (let k = 0; k < ghost.n; k++) ghost.w[k] /= wsum;
    return count;
  }
  if (wsum > 0) { // only ghost corners contributed: value 0 (or their upstream values)
    if (ghost) for (let k = 0; k < ghost.n; k++) ghost.w[k] /= wsum;
    return 0;
  }

  const ci = Math.floor((qx - ox) / h);
  const cj = Math.floor((qy - oy) / h);
  if (ci >= 0 && ci < cols && cj >= 0 && cj < rows) {
    const idx = cj * cols + ci;
    if (!solid[idx] &&
        firstSolidHit(n, qx, qy, ox + (ci + 0.5) * h, oy + (cj + 0.5) * h) === Infinity) {
      idxOut[0] = idx;
      wOut[0] = 1;
      return 1;
    }
  }
  return 0;
}

/**
 * Wall-aware bilinear sample; the same rule the advection step uses. Reads 0
 * where nothing is visible. In `inflow` mode, pass `timeS` (the snapshot time)
 * so corners — or the whole point — outside the grid read the upstream field
 * as the step does; without it they read 0 like `open`.
 */
export function sampleDensity(domain: CloudDomain, density: ArrayLike<number>, p: Vec2, timeS?: number): number {
  const n = internalsOf(domain);
  if (density.length !== domain.cols * domain.rows) throw new RangeError('density length does not match the grid');
  finite('p.x', p.x);
  finite('p.y', p.y);
  const front = n.inflow && timeS !== undefined ? n.front : undefined;
  if (front) {
    finite('timeS', timeS as number);
    if (p.x < n.ox || p.x > n.x1 || p.y < n.oy || p.y > n.y1) {
      return frontField(front, p.x - n.windX * (timeS as number), p.y - n.windY * (timeS as number));
    }
  }
  const idx = new Int32Array(4);
  const w = new Float64Array(4);
  const ghost = front ? newGhost() : null;
  const count = sampleStencil(n, p.x, p.y, idx, w, ghost);
  let s = 0;
  for (let k = 0; k < count; k++) s += w[k] * density[idx[k]];
  if (front && ghost) {
    const t = timeS as number;
    for (let k = 0; k < ghost.n; k++) s += ghost.w[k] * frontField(front, ghost.x[k] - n.windX * t, ghost.y[k] - n.windY * t);
  }
  return s + 0;
}

// ----------------------------------------------------------------- engine

/**
 * Inflow only: per affected cell, up to four upstream reads (world position,
 * weight, stride 4 per entry). A backtrace that leaves the domain is one read
 * of weight 1 at q.
 */
interface GhostList { cell: number[]; count: number[]; x: number[]; y: number[]; w: number[] }

interface Stencil {
  /** 4 entries per cell; unused slots point at the cell itself with weight 0. */
  idx: Int32Array;
  w: Float64Array;
  ghost?: GhostList;
}

interface Engine {
  /** Diffusion faces: east / south face of cell c is open. Present only if diffusivity > 0. */
  openE?: Uint8Array;
  openS?: Uint8Array;
  substeps: number;
  kappa: number;
  /** Backtrace stencil for the initial (fixed) vortex layout; built lazily. */
  fixed?: Stencil;
}

function newStencil(N: number, inflow: boolean): Stencil {
  return {
    idx: new Int32Array(N * 4),
    w: new Float64Array(N * 4),
    ghost: inflow ? { cell: [], count: [], x: [], y: [], w: [] } : undefined,
  };
}

/**
 * Backtrace + wall-aware interpolation weights of every fluid cell for the
 * velocity field `field` (steady within the step).
 */
function fillStencil(n: Internals, config: CloudStudyConfig, field: VField, st: Stencil): void {
  const { dt } = config.settings;
  const { cols, rows, h, solid, ox, oy } = n;
  const { idx, w, ghost } = st;
  const si = new Int32Array(4);
  const sw = new Float64Array(4);
  const gs = newGhost();
  const v1 = { x: 0, y: 0 };
  const v2 = { x: 0, y: 0 };
  if (ghost) { ghost.cell.length = 0; ghost.count.length = 0; ghost.x.length = 0; ghost.y.length = 0; ghost.w.length = 0; }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = j * cols + i;
      for (let k = 0; k < 4; k++) idx[c * 4 + k] = c;
      if (solid[c]) continue;
      const px = ox + (i + 0.5) * h;
      const py = oy + (j + 0.5) * h;
      velocityInto(n.windX, n.windY, field, px, py, v1);
      velocityInto(n.windX, n.windY, field, px - 0.5 * dt * v1.x, py - 0.5 * dt * v1.y, v2);
      const dx = -dt * v2.x;
      const dy = -dt * v2.y;
      const qx = px + dx;
      const qy = py + dy;
      // A blocked backtrace reads 0 (absorbing wall, clean air behind it).
      let count = 0;
      if (firstBlock(n, px, py, qx, qy) === Infinity) {
        if (ghost && (qx < ox || qx > n.x1 || qy < oy || qy > n.y1)) {
          // Left the domain: read the upstream field at q itself.
          ghost.cell.push(c); ghost.count.push(1); ghost.x.push(qx, 0, 0, 0); ghost.y.push(qy, 0, 0, 0); ghost.w.push(1, 0, 0, 0);
        } else {
          count = sampleStencil(n, qx, qy, si, sw, ghost ? gs : null);
          if (ghost && gs.n > 0) {
            ghost.cell.push(c); ghost.count.push(gs.n);
            for (let k = 0; k < 4; k++) { ghost.x.push(gs.x[k]); ghost.y.push(gs.y[k]); ghost.w.push(k < gs.n ? gs.w[k] : 0); }
          }
        }
      }
      for (let k = 0; k < count; k++) {
        idx[c * 4 + k] = si[k];
        w[c * 4 + k] = sw[k];
      }
      for (let k = count; k < 4; k++) w[c * 4 + k] = 0;
    }
  }
}

function getEngine(domain: CloudDomain): Engine {
  const n = internalsOf(domain);
  if (n.engine) return n.engine;
  const { config } = domain;
  const { dt, diffusivity } = config.settings;
  const { cols, rows, h, solid, ox, oy } = n;
  const N = cols * rows;
  let openE: Uint8Array | undefined;
  let openS: Uint8Array | undefined;
  let substeps = 0;
  let kappa = 0;
  if (diffusivity > 0) {
    openE = new Uint8Array(N);
    openS = new Uint8Array(N);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const c = j * cols + i;
        if (solid[c]) continue;
        const cx = ox + (i + 0.5) * h;
        const cy = oy + (j + 0.5) * h;
        if (i + 1 < cols && !solid[c + 1] && firstSolidHit(n, cx, cy, cx + h, cy) === Infinity) openE[c] = 1;
        if (j + 1 < rows && !solid[c + cols] && firstSolidHit(n, cx, cy, cx, cy + h) === Infinity) openS[c] = 1;
      }
    }
    substeps = diffusionSubsteps(config.settings, h);
    kappa = (diffusivity * (dt / substeps)) / (h * h);
  }
  n.engine = { openE, openS, substeps, kappa };
  return n.engine;
}

function getFixedStencil(domain: CloudDomain, engine: Engine): Stencil {
  if (engine.fixed) return engine.fixed;
  const n = internalsOf(domain);
  const { config } = domain;
  const st = newStencil(n.cols * n.rows, n.inflow);
  fillStencil(n, config, toField(staticVortices(config)), st);
  engine.fixed = st;
  return st;
}

function massSum(density: ArrayLike<number>, cellArea: number): number {
  let s = 0;
  for (let i = 0; i < density.length; i++) s += density[i];
  return s * cellArea;
}

function advanceDomain(domain: CloudDomain, snapshot: CloudSnapshot, steps: number): CloudSnapshot {
  const n = internalsOf(domain);
  const engine = getEngine(domain);
  const { cols, rows, solid, closed } = n;
  const N = cols * rows;
  const { openE, openS, substeps, kappa } = engine;
  const { front, windX, windY, ox, oy, h } = n;
  const { config } = domain;
  const dt = config.settings.dt;
  const moving = isMoving(config);
  const schedule = trainSchedule(config);
  let active: ActiveVortex[] = snapshot.vortices.map(copyVortex);
  // Fixed eddies: one stencil for the whole run. Drifting eddies: rebuilt every step from the midpoint centres.
  const scratch = moving ? newStencil(N, n.inflow) : null;
  let st = moving ? (scratch as Stencil) : getFixedStencil(domain, engine);
  let cur = Float64Array.from(snapshot.density);
  let nxt = new Float64Array(N);
  // Inflow diffusion: upstream values in the ghost cells just outside each edge (per step, fixed across substeps).
  const diffGhost = n.inflow && front && openE
    ? { l: new Float64Array(rows), r: new Float64Array(rows), t: new Float64Array(cols), b: new Float64Array(cols) }
    : null;

  for (let s = 0; s < steps; s++) {
    const tOld = (snapshot.step + s) * dt; // time of the field being sampled
    if (moving && scratch) {
      const { next, mid } = advanceState(config, schedule, active, snapshot.step + s);
      fillStencil(n, config, toField(mid), scratch);
      st = scratch;
      active = next;
    }
    const { idx, w, ghost } = st;

    for (let c = 0; c < N; c++) {
      if (solid[c]) { nxt[c] = 0; continue; }
      const b = c * 4;
      nxt[c] = (w[b] * cur[idx[b]] + w[b + 1] * cur[idx[b + 1]] +
        w[b + 2] * cur[idx[b + 2]] + w[b + 3] * cur[idx[b + 3]]) + 0;
    }
    if (ghost && front) {
      const sx = windX * tOld;
      const sy = windY * tOld;
      for (let e = 0; e < ghost.cell.length; e++) {
        const c = ghost.cell[e];
        let v = nxt[c];
        for (let k = 0; k < ghost.count[e]; k++) {
          v += ghost.w[e * 4 + k] * frontField(front, ghost.x[e * 4 + k] - sx, ghost.y[e * 4 + k] - sy);
        }
        nxt[c] = v + 0;
      }
    }
    [cur, nxt] = [nxt, cur];

    if (diffGhost && front) {
      const sx = windX * tOld;
      const sy = windY * tOld;
      for (let j = 0; j < rows; j++) {
        const y = oy + (j + 0.5) * h - sy;
        diffGhost.l[j] = frontField(front, ox - 0.5 * h - sx, y);
        diffGhost.r[j] = frontField(front, ox + (cols + 0.5) * h - sx, y);
      }
      for (let i = 0; i < cols; i++) {
        const x = ox + (i + 0.5) * h - sx;
        diffGhost.t[i] = frontField(front, x, oy - 0.5 * h - sy);
        diffGhost.b[i] = frontField(front, x, oy + (rows + 0.5) * h - sy);
      }
    }

    if (openE && openS) {
      for (let sub = 0; sub < substeps; sub++) {
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const c = j * cols + i;
            if (solid[c]) { nxt[c] = 0; continue; }
            const a = cur[c];
            let acc = 0;
            if (i + 1 < cols) { if (openE[c]) acc += cur[c + 1] - a; } else if (!closed) acc += (diffGhost ? diffGhost.r[j] : 0) - a;
            if (i > 0) { if (openE[c - 1]) acc += cur[c - 1] - a; } else if (!closed) acc += (diffGhost ? diffGhost.l[j] : 0) - a;
            if (j + 1 < rows) { if (openS[c]) acc += cur[c + cols] - a; } else if (!closed) acc += (diffGhost ? diffGhost.b[i] : 0) - a;
            if (j > 0) { if (openS[c - cols]) acc += cur[c - cols] - a; } else if (!closed) acc += (diffGhost ? diffGhost.t[i] : 0) - a;
            nxt[c] = a + kappa * acc + 0;
          }
        }
        [cur, nxt] = [nxt, cur];
      }
    }
  }

  return makeSnapshot(domain, Array.from(cur), snapshot.step + steps, snapshot.mass.initial, active);
}

// ------------------------------------------------------- initial condition

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function hashNoise(seed: number, x: number, y: number): number {
  let h = (seed | 0) ^ Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

function valueNoise(seed: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const tx = smoothstep(0, 1, x - ix);
  const ty = smoothstep(0, 1, y - iy);
  const a = hashNoise(seed, ix, iy);
  const b = hashNoise(seed, ix + 1, iy);
  const c = hashNoise(seed, ix, iy + 1);
  const d = hashNoise(seed, ix + 1, iy + 1);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

function makeSnapshot(domain: CloudDomain, density: number[], step: number, initialMass: number, vortices: ReadonlyArray<ActiveVortex>): CloudSnapshot {
  const current = massSum(density, domain.cellArea);
  const drift = current - initialMass;
  return {
    schema: SNAPSHOT_SCHEMA,
    model: MODEL,
    hashes: { ...domain.hashes },
    step,
    timeS: step * domain.config.settings.dt,
    grid: { cols: domain.cols, rows: domain.rows, spacing: domain.spacing },
    density,
    densityHash: hashFloat64(density),
    mass: {
      initial: initialMass,
      current,
      drift,
      relativeDrift: initialMass === 0 ? 0 : drift / initialMass,
    },
    vortices: vortices.map(copyVortex),
  };
}

export function initialSnapshot(config: CloudStudyConfig): CloudSnapshot {
  return initialFromDomain(buildDomain(config));
}

function initialFromDomain(domain: CloudDomain): CloudSnapshot {
  const n = internalsOf(domain);
  const { source, front } = domain.config;
  const density = new Array<number>(domain.cols * domain.rows).fill(0);
  for (let j = 0; j < domain.rows; j++) {
    const y = n.oy + (j + 0.5) * n.h;
    for (let i = 0; i < domain.cols; i++) {
      const c = j * domain.cols + i;
      if (domain.solid[c]) continue;
      const x = n.ox + (i + 0.5) * n.h;
      const r = Math.hypot((x - source.center.x) / source.radii.x, (y - source.center.y) / source.radii.y);
      const falloff = 1 - smoothstep(0, 1, r);
      let value = 0;
      if (falloff > 0) {
        const billow = 0.55 + 0.45 * valueNoise(source.seed, x / source.noiseScale, y / source.noiseScale);
        value = source.amplitude * falloff * billow + 0;
      }
      if (front?.fillInterior) value = Math.max(value, frontField(front, x, y));
      density[c] = value;
    }
  }
  return makeSnapshot(domain, density, 0, massSum(density, domain.cellArea), initialVortices(domain.config));
}

// ---------------------------------------------------------------- stepping

function checkSteps(name: string, steps: number): void {
  if (!Number.isInteger(steps) || steps < 0) throw new RangeError(`${name} must be a nonnegative integer`);
}

const closeTo = (a: number, b: number, rel: number): boolean =>
  Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));

/** Config-independent integrity problems of a snapshot (null when sound). */
function snapshotBodyProblem(s: CloudSnapshot): string | null {
  if (!Number.isInteger(s.step) || s.step < 0 || s.step > LIMITS.maxSteps) {
    return `step must be an integer in [0, ${LIMITS.maxSteps}]`;
  }
  for (let i = 0; i < s.density.length; i++) {
    const v = s.density[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `density[${i}] must be finite and nonnegative`;
  }
  if (!Array.isArray(s.vortices) || s.vortices.some((v) => !isRecord(v) || typeof v.key !== 'string' ||
      !isRecord(v.center) || typeof v.center.x !== 'number' || typeof v.center.y !== 'number' ||
      !Number.isFinite(v.center.x) || !Number.isFinite(v.center.y) ||
      typeof v.circulation !== 'number' || !Number.isFinite(v.circulation) ||
      typeof v.coreRadius !== 'number' || !Number.isFinite(v.coreRadius) || v.coreRadius <= 0)) {
    return 'vortices must be an array of {key, center {x, y}, circulation, coreRadius} with finite numbers';
  }
  const recomputed = massSum(s.density, s.grid.spacing * s.grid.spacing);
  if (!closeTo(s.mass.current, recomputed, 1e-12)) return 'mass.current does not match the density';
  return null;
}

function assertCompatible(snapshot: CloudSnapshot, domain: CloudDomain): void {
  if (snapshot.schema !== SNAPSHOT_SCHEMA) throw new SnapshotMismatchError(`snapshot schema ${String(snapshot.schema)} is not ${SNAPSHOT_SCHEMA}`);
  for (const key of ['id', 'version', 'backend', 'backendVersion'] as const) {
    if (snapshot.model?.[key] !== MODEL[key]) {
      throw new SnapshotMismatchError(`snapshot model.${key} differs from the current model`);
    }
  }
  if (snapshot.grid?.cols !== domain.cols || snapshot.grid?.rows !== domain.rows || snapshot.grid?.spacing !== domain.spacing) {
    throw new SnapshotMismatchError('snapshot grid differs from the config grid');
  }
  for (const key of ['geometry', 'transform', 'simulation', 'stateKey'] as const) {
    if (snapshot.hashes?.[key] !== domain.hashes[key]) {
      throw new SnapshotMismatchError(`snapshot ${key} hash differs from the config`);
    }
  }
  if (!Array.isArray(snapshot.density) || snapshot.density.length !== domain.cols * domain.rows) {
    throw new SnapshotMismatchError('snapshot density length does not match the grid');
  }
  if (hashFloat64(snapshot.density) !== snapshot.densityHash) {
    throw new SnapshotMismatchError('snapshot density does not match its densityHash');
  }
  const problem = snapshotBodyProblem(snapshot);
  if (problem) throw new SnapshotMismatchError(`snapshot ${problem}`);
  // The vortex list is a deterministic function of the config and step; a forged or stale list is rejected.
  const expected = vortexStateAt(domain.config, snapshot.step);
  const same = snapshot.vortices.length === expected.length && expected.every((e, i) => {
    const v = snapshot.vortices[i];
    return v.key === e.key && v.center.x === e.center.x && v.center.y === e.center.y &&
      v.circulation === e.circulation && v.coreRadius === e.coreRadius;
  });
  if (!same) throw new SnapshotMismatchError('snapshot vortices do not match the config at this step');
  // dt is fixed by the config hash, so timeS is exactly step·dt (the same product the sim stores).
  if (snapshot.timeS !== snapshot.step * domain.config.settings.dt) {
    throw new SnapshotMismatchError('snapshot timeS is not step·dt');
  }
  if (!closeTo(snapshot.mass.initial, initialFromDomain(domain).mass.initial, 1e-12)) {
    throw new SnapshotMismatchError('snapshot mass.initial does not match the config source');
  }
}

export function advance(snapshot: CloudSnapshot, config: CloudStudyConfig, steps: number): CloudSnapshot {
  checkSteps('steps', steps);
  const domain = buildDomain(config);
  assertCompatible(snapshot, domain);
  if (snapshot.step + steps > LIMITS.maxSteps) {
    throw new RangeError(`step ${snapshot.step + steps} exceeds the limit of ${LIMITS.maxSteps}`);
  }
  checkWork(domain, steps);
  return advanceDomain(domain, snapshot, steps);
}

/**
 * Snapshots at the requested steps, returned in ascending order with
 * duplicates removed (not in request order).
 */
export function simulate(config: CloudStudyConfig, steps: number[]): CloudSnapshot[] {
  steps.forEach((s, i) => {
    checkSteps(`steps[${i}]`, s);
    if (s > LIMITS.maxSteps) throw new RangeError(`steps[${i}] exceeds the limit of ${LIMITS.maxSteps}`);
  });
  const wanted = [...new Set(steps)].sort((a, b) => a - b);
  const domain = buildDomain(config);
  checkWork(domain, wanted.length ? wanted[wanted.length - 1] : 0);
  let snap = initialFromDomain(domain);
  const out: CloudSnapshot[] = [];
  for (const target of wanted) {
    if (target > snap.step) snap = advanceDomain(domain, snap, target - snap.step);
    out.push(snap);
  }
  return out;
}

// ----------------------------------------------------------- serialization

export function serializeSnapshot(s: CloudSnapshot): string {
  return JSON.stringify(s);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(message: string): never {
  throw new RangeError(`invalid snapshot: ${message}`);
}

export function parseSnapshot(text: string): CloudSnapshot {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) fail('not an object');
  if (raw.schema !== SNAPSHOT_SCHEMA) fail(`schema must be ${SNAPSHOT_SCHEMA}`);
  const model = raw.model;
  if (!isRecord(model)) fail('model missing');
  for (const key of ['id', 'version', 'backend', 'backendVersion']) {
    if (typeof model[key] !== 'string') fail(`model.${key} must be a string`);
  }
  const hashes = raw.hashes;
  if (!isRecord(hashes)) fail('hashes missing');
  for (const key of ['geometry', 'transform', 'simulation', 'stateKey']) {
    if (typeof hashes[key] !== 'string') fail(`hashes.${key} must be a string`);
  }
  const step = raw.step;
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 0 || step > LIMITS.maxSteps) {
    fail(`step must be an integer in [0, ${LIMITS.maxSteps}]`);
  }
  if (typeof raw.timeS !== 'number' || !Number.isFinite(raw.timeS) || raw.timeS < 0) fail('timeS must be finite and nonnegative');
  const grid = raw.grid;
  if (!isRecord(grid)) fail('grid missing');
  const { cols, rows, spacing } = grid;
  if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 1 ||
      typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1 ||
      typeof spacing !== 'number' || !(spacing > 0) || !Number.isFinite(spacing)) {
    fail('grid must have positive integer cols/rows and positive spacing');
  }
  if (cols * rows > LIMITS.maxCells) fail('grid exceeds the cell limit');
  const density = raw.density;
  if (!Array.isArray(density) || density.length !== cols * rows) fail('density length must equal cols·rows');
  for (let i = 0; i < density.length; i++) {
    if (typeof density[i] !== 'number' || !Number.isFinite(density[i]) || density[i] < 0) {
      fail(`density[${i}] must be finite and nonnegative`);
    }
  }
  if (typeof raw.densityHash !== 'string' || hashFloat64(density as number[]) !== raw.densityHash) {
    fail('density does not match densityHash');
  }
  const mass = raw.mass;
  if (!isRecord(mass)) fail('mass missing');
  for (const key of ['initial', 'current', 'drift', 'relativeDrift']) {
    if (typeof mass[key] !== 'number' || !Number.isFinite(mass[key])) fail(`mass.${key} must be finite`);
  }
  const snapshot = raw as unknown as CloudSnapshot;
  const problem = snapshotBodyProblem(snapshot);
  if (problem) fail(problem);
  return snapshot;
}
