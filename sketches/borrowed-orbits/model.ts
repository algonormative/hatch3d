/**
 * Study-local contract for the Borrowed Orbits gravity study.
 *
 * Physical model: Newtonian gravity between point masses, Plummer-softened,
 * integrated with a fixed-step kick–drift–kick leapfrog. Two kinds of body:
 *
 * - ATTRACTORS (`mass-*`) carry mass and exert force. A `dynamic` attractor
 *   also responds to every other attractor; a fixed one never moves.
 * - TEST PARTICLES (`particle-<i>`) carry a small mass and respond to every
 *   attractor, but exert no force on anything (the restricted N-body
 *   approximation: their self-gravity and their pull on the attractors are
 *   neglected).
 *
 * Force is explicit and is divided by mass: on a body of mass m at x, the
 * attractor j of mass M_j at y_j exerts
 *
 *   F = G · M_j · m · (y_j − x) / (|y_j − x|² + ε_j²)^{3/2}   [N = kg·m/s²]
 *   a = F / m                                                   [m/s²]
 *
 * where ε_j is attractor j's softening length. This is not the prescribed
 * velocity field of the cloud study: nothing here sets a velocity directly.
 * Velocity changes only by a·dt, position only by v·dt.
 *
 * Units: metres (m), seconds (s), kilograms (kg), newtons (N). y grows
 * downward to match page millimetres. G is the real constant; attractor
 * masses are of order 10¹¹–10¹² kg (a small mountain), so orbits of tens of
 * metres take tens of seconds. That choice of scale is an artistic departure;
 * the law is not.
 *
 * Simulation region IDs (`mass-*`, `forbidden-*`, `particle-*`) are
 * independent of physical pen `Part` IDs.
 */

export interface Vec2 { x: number; y: number }

/** Newtonian constant of gravitation, m³·kg⁻¹·s⁻² (CODATA 2018). */
export const G = 6.6743e-11;

export const MODEL = Object.freeze({
  id: 'softened-newtonian-restricted-nbody',
  version: '1.0.0',
  backend: 'ts-cpu-kdk-leapfrog',
  backendVersion: '1.0.0',
});

export const SNAPSHOT_SCHEMA = 'hatch3d.borrowed-orbits.snapshot.v1';

/**
 * Hard bounds that keep a render bounded. `maxWork` caps
 * steps × (particles × attractors + attractors²) force evaluations for one
 * advance/simulate/history call.
 */
export const LIMITS = Object.freeze({
  maxSteps: 2400,
  maxParticles: 4000,
  maxAttractors: 16,
  maxForbidden: 64,
  maxWork: 200_000_000,
});

/**
 * Domain edge behaviour, declared per study and covered by tests.
 * - `open`: particles that leave the domain keep integrating and may return.
 *   Extraction clips trails to the frame. A particle farther than
 *   `settings.escapeMargin` metres outside the domain rectangle (Euclidean
 *   distance to the rectangle) becomes `escaped` and stops integrating.
 * - `absorb`: the domain edge is a capture boundary. A particle whose drift
 *   segment of a step crosses the rectangle is `captured` at the crossing
 *   point (reason `edge`).
 * Attractors are never stopped by edges or forbidden regions.
 */
export type BoundaryMode = 'open' | 'absorb';

export interface Attractor {
  id: string; // `mass-*`
  kind: 'attractor';
  mass: number; // kg, > 0
  position: Vec2; // m, at step 0
  velocity: Vec2; // m/s, at step 0
  softening: number; // m, ε > 0
  /** A particle whose drift segment comes within this distance of the attractor is captured (reason `attractor`). m, ≥ 0. */
  captureRadius: number;
  /** Responds to the other attractors; false = pinned in place (velocity must be 0). */
  dynamic: boolean;
  /** Drawn by the sketch? Borrowed Orbits keeps attractors hidden; the flag is for diagnostics only. */
  hidden: boolean;
}

/**
 * Static capture region. Polygon vertices in metres; may be thinner than one
 * step of particle travel. A particle whose drift segment crosses the polygon
 * boundary, or that starts inside it, is captured at the first crossing
 * (reason `forbidden`). Capture is a swept-segment test against every edge:
 * leapfrog drifts in a straight line, so the test is exact for the
 * integrator's own path and nothing tunnels.
 */
export interface ForbiddenRegion { id: string /* `forbidden-*` */; kind: 'forbidden'; polygon: Vec2[] }

export interface WorldDomain { origin: Vec2; size: Vec2 /* m */ }

/** World → page is a uniform scale (mm per m) plus page offset (mm). No grid in this study. */
export interface Transforms {
  worldToPage: { scale: number /* mm per m */; offset: Vec2 /* mm */ };
}

export interface SimulationSettings {
  dt: number; // s, fixed
  boundary: BoundaryMode;
  /** m beyond the domain rectangle at which an `open` particle escapes. */
  escapeMargin: number;
}

/**
 * Seeded test-particle initial state. The sketch generates these from the
 * `dynamics` stream; the sim only consumes them. Every particle has the same
 * mass `particleMass` (kg); its value cancels in a = F/m and is kept so the
 * force is explicit and testable.
 */
export interface ParticleInit { position: Vec2; velocity: Vec2 }

/** Everything that defines simulation state. Any change invalidates snapshots. */
export interface OrbitStudyConfig {
  domain: WorldDomain;
  transforms: Transforms;
  settings: SimulationSettings;
  attractors: Attractor[];
  forbidden: ForbiddenRegion[];
  particleMass: number; // kg, > 0
  particles: ParticleInit[];
}

export interface SnapshotHashes {
  /** domain, forbidden regions. */
  geometry: string;
  /** worldToPage. */
  transform: string;
  /** settings, attractors, particleMass, particles, G, model + backend. */
  simulation: string;
  /** Hash of the three above; a snapshot only resumes under an equal key. */
  stateKey: string;
}

export type ParticleStatus = 'free' | 'captured' | 'escaped';
export type CaptureReason = 'forbidden' | 'attractor' | 'edge';

/** Status codes as stored in snapshots (`status` array). */
export const STATUS_CODE = Object.freeze({ free: 0, captured: 1, escaped: 2 } as const);
export const REASON_CODE = Object.freeze({ none: 0, forbidden: 1, attractor: 2, edge: 3 } as const);

/**
 * Energy bookkeeping. Specific energy (J/kg) of each free particle in the
 * field of the attractors at their current positions, summed over free
 * particles. With fixed attractors this is conserved by the exact dynamics;
 * leapfrog keeps its error bounded and oscillating. With dynamic attractors it
 * is not a conserved quantity (the field is time-dependent). Diagnostic only.
 */
export interface EnergyBudget {
  /** Σ over free particles of ½|v|² − Σ_j G·M_j / sqrt(r_j² + ε_j²), J/kg. */
  particleSpecific: number;
  /** Kinetic + softened pair potential of the attractors alone, J. Conserved up to integration error. */
  attractorTotal: number;
  /** Σ M·v of the attractors, kg·m/s. Conserved exactly up to rounding when no attractor is pinned. */
  attractorMomentum: Vec2;
}

/** Immutable, JSON-serializable state at one integer step. */
export interface OrbitSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  model: typeof MODEL;
  hashes: SnapshotHashes;
  step: number;
  timeS: number; // step · dt
  /** Attractor states in config order. */
  attractors: { id: string; position: Vec2; velocity: Vec2 }[];
  /** Particle state, struct-of-arrays, index = particle index. Positions m, velocities m/s. */
  px: number[];
  py: number[];
  vx: number[];
  vy: number[];
  /** STATUS_CODE per particle. A captured or escaped particle keeps its final position and zero velocity. */
  status: number[];
  /** REASON_CODE per particle (0 while free or escaped). */
  reason: number[];
  /** Step at which the particle stopped (−1 while free). */
  stoppedAt: number[];
  /** Hash of the exact Float64 bytes of attractor states then px, py, vx, vy, then status, reason, stoppedAt. */
  stateHash: string;
  energy: EnergyBudget;
}

/**
 * Position history for trail extraction: positions of every particle at
 * every step in [fromStep, toStep], inclusive. A stopped particle's entries
 * after `stoppedAt` repeat its stop position; consumers read `stoppedAt`
 * from the final snapshot to end the trail there.
 */
export interface History {
  fromStep: number;
  toStep: number;
  /** xs[k][i] = x of particle i at step fromStep + k. */
  xs: Float64Array[];
  ys: Float64Array[];
  /** Attractor positions per step, same indexing: ax[k][j]. */
  ax: Float64Array[];
  ay: Float64Array[];
  final: OrbitSnapshot;
}

/**
 * Sim API (implemented in sim.ts). Throwing RangeError on invalid config or
 * when a call exceeds LIMITS; SnapshotMismatchError when resuming under a
 * different stateKey.
 *
 *   configHashes(config): SnapshotHashes
 *   accelerationAt(config, attractorPositions, p): Vec2       // m/s², Σ F/m over attractors
 *   forceOn(config, attractorPositions, p, mass): Vec2         // N
 *   initialSnapshot(config): OrbitSnapshot
 *   advance(config, snapshot, steps): OrbitSnapshot            // integer steps ≥ 0
 *   simulate(config, steps: number[]): OrbitSnapshot[]          // ascending unique steps
 *   history(config, fromStep, toStep): History                  // single pass from step 0
 *   serializeSnapshot(s): string ; parseSnapshot(config, json): OrbitSnapshot
 */

/**
 * Mark-extraction settings. These never enter simulation hashes: changing
 * them re-extracts marks from an identical history.
 */
export interface MarkSettings {
  trailPen: string;
  structurePen: string; // forbidden regions
  guidePen: string; // drawn-only orbit guides
  /** Trail window length in steps, ending at the print step. */
  trailSteps: number;
  /** 0 = solid trails; 1 = the oldest part of each trail breaks into short dashes, fading toward its tail. */
  taper: number;
  /** Seed for dash phase jitter (named stream `trail-dashes`). */
  dashSeed: number;
}
