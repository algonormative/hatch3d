/**
 * Study-local contract for the prescribed-flow cloud advection pilot.
 *
 * Physical model: a passive scalar (dimensionless concentration) carried by a
 * PRESCRIBED velocity field — uniform wind plus regularized point vortices —
 * with optional isotropic diffusion. Solids block transport but do not deflect
 * the flow (no pressure projection). This is not Navier–Stokes, weather, or a
 * measured cloud. Units: world metres (m), seconds (s), y grows downward to
 * match page millimetres.
 *
 * Simulation region IDs (`wind`, `smoke-source`, `solid-*`, `eddy-*`) are
 * independent of physical pen `Part` IDs.
 */

export interface Vec2 { x: number; y: number }

export const MODEL = Object.freeze({
  id: 'prescribed-passive-advection',
  version: '1.3.0',
  backend: 'ts-cpu-semi-lagrangian-rk2-bilinear',
  backendVersion: '1.3.0',
});

export const SNAPSHOT_SCHEMA = 'hatch3d.cloud-advection.snapshot.v3';

/**
 * Hard bounds that keep a render bounded. `maxDiffusionSubsteps` caps the
 * explicit-diffusion substeps per step; `maxWork` caps
 * cells × steps × max(1, substeps, 5 when eddies drift) for one advance/simulate call.
 */
export const LIMITS = Object.freeze({
  maxCells: 100_000,
  maxSteps: 240,
  maxDiffusionSubsteps: 16,
  // Hard cap on `eddyTrain.maxActive`.
  maxTrainEddies: 12,
  // The art grid (23,400 cells) at 240 steps and the 16-substep cap is 89.9M.
  maxWork: 90_000_000,
});

/**
 * Domain edge behavior, declared per study and covered by tests.
 * - `open`: backtraces leaving the domain read zero concentration (clean
 *   inflow); concentration carried across an edge leaves the budget.
 * - `closed`: domain edges are walls — nothing is transported across them,
 *   inflow is zero (a backtrace that would cross an edge reads zero), and
 *   anything carried into an edge is absorbed. Interpolation never reads
 *   outside the grid. There is no conservation guarantee.
 * - `inflow`: like `open` for outflow, but weather arrives from outside the
 *   frame. Anything the domain reads from beyond an edge — a backtrace that
 *   leaves the domain, interpolation corners outside the grid, diffusion ghost
 *   cells — reads the frozen upstream field of `config.front` at the time of
 *   the field being sampled (`step · dt`), instead of zero. Requires `front`.
 *   Solids still absorb: a backtrace blocked by a solid reads zero.
 */
/**
 * How vortex centres move (`CloudStudyConfig.eddyDrift`, absent = `fixed`).
 * - `fixed`: centres never move; the velocity field is steady.
 * - `wind`: every centre is carried by the uniform wind.
 * - `kirchhoff`: every centre moves with the wind plus the velocity induced at
 *   its position by every OTHER vortex (same regularized kernel as the flow;
 *   self-induction excluded) — classic point-vortex dynamics.
 *
 * Centres advance once per step by RK2 (midpoint) at the fixed dt, before the
 * density backtrace of that step. The backtrace from step n to n+1 uses the
 * velocity field at time t_n + dt/2: uniform wind plus vortices located at the
 * midpoint ½(c_n + c_{n+1}) of that step's centre motion (both RK2 stages of the
 * backtrace see that same field). Solids do not affect vortex motion (no image
 * vortices — an approximation), and a vortex that leaves the domain keeps moving
 * and still contributes. Snapshots carry the active vortex list (`vortices`).
 */
export type EddyDrift = 'fixed' | 'wind' | 'kirchhoff';

/**
 * Eddy train (`CloudStudyConfig.eddyTrain`): a deterministic stream of vortices
 * released upwind so the flow stays alive for the whole window. Requires
 * `eddyDrift` to be `wind` or `kirchhoff` (RangeError with `fixed`). Exact rules:
 *
 * - SPAWN. The k-th eddy (k = 0, 1, 2, …) exists in the state at step
 *   s_k = firstStep + k·period + j_k, where j_k is a seeded integer in
 *   [−timingJitter, +timingJitter] (0 when timingJitter = 0). Validation
 *   guarantees 2·timingJitter < period and firstStep ≥ timingJitter, so spawn
 *   steps strictly increase and are never reordered or clamped. A spawn at step
 *   s is part of the snapshot at step s (a spawn at step 0 is in the initial
 *   state) and first moves in the step s → s+1.
 * - PLACEMENT. The upwind edge is the edge whose outward normal has the most
 *   negative dot product with the uniform wind (left (−1,0), right (+1,0),
 *   top (0,−1), bottom (0,+1); ties and zero wind resolve in that order, so x
 *   edges win ties). The eddy centre sits one coreRadius beyond that edge, at
 *   the edge midpoint plus a seeded offset in ±lateralJitter · (edge length / 2).
 * - SIGN. circulation is a magnitude: eddy k gets −circulation when `alternate`
 *   and k is odd, otherwise +circulation.
 * - MOTION. Train eddies move exactly like the config's static vortices (same
 *   `eddyDrift`, and under `kirchhoff` they all induce one another).
 * - REMOVAL. At the end of step n → n+1 (after all centres have moved), a train
 *   eddy whose centre is farther than `removeMargin` m outside the domain
 *   rectangle (Euclidean distance to the rectangle) is removed. Static vortices
 *   are never removed. A removed eddy still took part in that step's backtrace.
 *   Keep removeMargin ≥ coreRadius, or fresh eddies that move outward vanish at once.
 * - CAP. `maxActive` (1 … LIMITS.maxTrainEddies) caps ACTIVE TRAIN eddies. If a
 *   spawn would exceed it, the oldest active train eddy (lowest k) is removed
 *   first. Removal by margin happens before spawning within a step.
 * - ORDER. The active list is always: static vortices in config order, then
 *   train eddies by ascending k.
 * - RANDOMNESS. Lateral offset and timing jitter come from the seeded integer
 *   hash (`seed`, k); no Math.random.
 */
export interface EddyTrain {
  id: 'eddy-train';
  period: number; // steps, integer >= 1
  firstStep: number; // integer >= 0
  circulation: number; // m^2/s, magnitude (> 0)
  coreRadius: number; // m
  alternate: boolean;
  lateralJitter: number; // 0..1 fraction of the upwind edge half-span
  timingJitter: number; // integer steps, 0 = exact period
  seed: number; // uint32
  removeMargin: number; // m
  maxActive: number; // integer 1..LIMITS.maxTrainEddies
}

/** One vortex of the active list at a step (static `eddy-*` id, or `train-<k>`). */
export interface ActiveVortex {
  key: string;
  center: Vec2; // m
  circulation: number; // m^2/s, signed
  coreRadius: number; // m
}

export type BoundaryMode = 'open' | 'closed' | 'inflow';

/**
 * Frozen upstream cloud field (Taylor's frozen-turbulence assumption): a fixed
 * pattern W(x, y) carried rigidly by the UNIFORM wind only. Vortices do not
 * carry it — they act on concentration inside the domain, never on the far
 * field.
 *
 *   W(x, y) = amplitude · smoothstep(1 − coverage − softness, 1 − coverage + softness,
 *                                    fbm(seed, x / scale, y / scale))   (softness default 0.12)
 *
 * `fbm` is a 3-octave seeded value-noise sum normalized to [0, 1]. The field
 * at world point p and time t is W(p − wind.velocity · t). Required when the
 * boundary mode is `inflow`; hashed into the simulation component whenever
 * present. With `fillInterior`, step 0 starts every fluid cell at
 * max(source value, W(p)) so the weather is already present; solid cells stay 0.
 */
export interface WeatherFront {
  id: 'weather-front';
  kind: 'frozen-field';
  amplitude: number; // peak concentration of the far field
  scale: number; // m, bank size
  coverage: number; // 0..1, fraction of sky that is cloud
  seed: number; // uint32
  fillInterior: boolean;
  /**
   * Half-width of the smoothstep band, in fbm units, valid in [0.02, 0.5].
   * Absent means 0.12 and is omitted from hashes, so configs written before
   * this field keep their hashes. Larger values soften bank edges (a smaller
   * peak gradient of W); present values are hashed in the simulation component.
   */
  softness?: number;
}

export interface UniformWind { id: 'wind'; kind: 'uniform-wind'; velocity: Vec2 /* m/s */ }

/** Regularized point vortex: v = Γ/(2π) · perp(r) / (|r|² + core²). */
export interface Vortex {
  id: string; // `eddy-*`
  kind: 'vortex';
  center: Vec2; // m
  circulation: number; // m²/s, positive = clockwise on the y-down page
  coreRadius: number; // m, > 0
}

/** Initial-condition region; there is no continuous emission in v1. */
export interface SmokeSource {
  id: 'smoke-source';
  kind: 'source';
  center: Vec2; // m
  radii: Vec2; // m, ellipse semi-axes
  amplitude: number; // peak initial concentration (dimensionless)
  noiseScale: number; // m, feature size of seeded billow modulation
  seed: number; // uint32, from the sketch's named `smoke-source` stream
}

/** Static obstacle. Polygon vertices in metres; may be thinner than a cell. */
export interface SolidRegion { id: string /* `solid-*` */; kind: 'solid'; polygon: Vec2[] }

export interface WorldDomain { origin: Vec2; size: Vec2 /* m */ }

/**
 * Ordered transforms. Grid is cell-centered: cell (i, j) has its center at
 * world (origin.x + (i + 0.5)·spacing, origin.y + (j + 0.5)·spacing).
 * World → page is a uniform scale (mm per m) plus page offset (mm).
 */
export interface Transforms {
  worldToGrid: { origin: Vec2; spacing: number /* m per cell */; cols: number; rows: number };
  worldToPage: { scale: number /* mm per m */; offset: Vec2 /* mm */ };
}

export interface SimulationSettings {
  dt: number; // s, fixed
  boundary: BoundaryMode;
  diffusivity: number; // m²/s; 0 disables diffusion exactly
}

/** Everything that defines simulation state. Any change invalidates snapshots. */
export interface CloudStudyConfig {
  domain: WorldDomain;
  transforms: Transforms;
  settings: SimulationSettings;
  wind: UniformWind;
  vortices: Vortex[];
  source: SmokeSource;
  solids: SolidRegion[];
  /** Upstream weather; required for the `inflow` boundary. */
  front?: WeatherFront;
  /** Vortex motion; absent means `fixed` and is omitted from hashes (as is an explicit `fixed`). */
  eddyDrift?: EddyDrift;
  /** Upwind eddy stream; absent is omitted from hashes. Requires a drifting `eddyDrift`. */
  eddyTrain?: EddyTrain;
}

export interface SnapshotHashes {
  /** domain, solids, source geometry. */
  geometry: string;
  /** worldToGrid + worldToPage. */
  transform: string;
  /** settings, wind, vortices, source amplitude/noise/seed, model + backend. */
  simulation: string;
  /** Hash of the three above; a snapshot only resumes under an equal key. */
  stateKey: string;
}

export interface MassBudget {
  /** Σ concentration · cellArea (m²) at step 0. */
  initial: number;
  current: number;
  /**
   * current − initial. Changes through open-edge outflow, absorption at solids
   * and closed edges, and semi-Lagrangian interpolation error (which can be of
   * either sign). Not a conservation check.
   */
  drift: number;
  /** drift / initial (0 when initial is 0). */
  relativeDrift: number;
}

/** Immutable, JSON-serializable state at one integer step. */
export interface CloudSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  model: typeof MODEL;
  hashes: SnapshotHashes;
  step: number;
  timeS: number; // step · dt
  grid: { cols: number; rows: number; spacing: number };
  /** Row-major (j · cols + i) concentration; zero in solid cells. */
  density: number[];
  /** Hash of the exact Float64 bytes of `density`. */
  densityHash: string;
  mass: MassBudget;
  /**
   * Active vortices at this step: the config's static vortices in order (key =
   * their id), then train eddies by ascending spawn index (key `train-<k>`).
   * Centres equal the initial layout while eddies are fixed.
   */
  vortices: ActiveVortex[];
}

/**
 * Mark-extraction settings. These never enter simulation hashes: changing
 * them re-extracts marks from an identical snapshot.
 */
export interface MarkSettings {
  /** Fixed mapping: field = clamp01(concentration / referenceDensity). Same for every step. */
  referenceDensity: number;
  cloudPen: string;
  structurePen: string;
  hatchSpacing: number; // mm
  hatchAngle: number; // radians
  /** Page-mm feature scale handed to the contour hatcher; fixed, not derived from state. */
  featureScale: number;
  /** 0 keeps structure intact; 1 lets dense cloud fully conceal members. */
  obscure: number;
  /** Quiet core: an extraction mask, not a wall. Page mm. */
  core: { center: Vec2; radius: number };
  /** Seed for wisp gap noise (from the sketch's `cloud-wisps` stream). */
  wispSeed: number;
}
