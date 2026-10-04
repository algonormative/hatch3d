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
  version: '1.0.0',
  backend: 'ts-cpu-semi-lagrangian-rk2-bilinear',
  backendVersion: '1.0.0',
});

export const SNAPSHOT_SCHEMA = 'hatch3d.cloud-advection.snapshot.v1';

/**
 * Hard bounds that keep a render bounded. `maxDiffusionSubsteps` caps the
 * explicit-diffusion substeps per step; `maxWork` caps
 * cells × steps × max(1, substeps) for one advance/simulate call.
 */
export const LIMITS = Object.freeze({
  maxCells: 100_000,
  maxSteps: 240,
  maxDiffusionSubsteps: 16,
  maxWork: 60_000_000,
});

/**
 * Domain edge behavior, declared per study and covered by tests.
 * - `open`: backtraces leaving the domain read zero concentration (clean
 *   inflow); concentration carried across an edge leaves the budget.
 * - `closed`: domain edges are walls — nothing is transported across them,
 *   inflow is zero (a backtrace that would cross an edge reads zero), and
 *   anything carried into an edge is absorbed. Interpolation never reads
 *   outside the grid. There is no conservation guarantee.
 */
export type BoundaryMode = 'open' | 'closed';

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
