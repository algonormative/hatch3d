/**
 * Borrowed Orbits simulation core (see model.ts for the contract).
 *
 * Pure TypeScript, deterministic, no I/O. A fixed-step kick–drift–kick
 * leapfrog advances every body together. Force is explicit: the acceleration of
 * a body is `forceOn(...) / mass`, and velocity changes only by a·dt/2 kicks;
 * position changes only by v·dt drifts. Nothing sets a velocity from position.
 *
 * Step n → n+1, for all bodies at once:
 *   1. a_n from the positions at step n (attractors at their step-n positions);
 *   2. kick   v += a_n·dt/2;
 *   3. drift  x += v·dt (a straight segment for every particle);
 *   4. capture / escape tests on each particle's drift segment;
 *   5. a_{n+1} from the step-(n+1) positions;
 *   6. kick   v += a_{n+1}·dt/2.
 * Within one advance call a_{n+1} of step n is reused as a_n of step n+1. It is
 * the same pure function of the same bits, so this is bitwise identical to
 * recomputing it from stored positions, which is what a resume from a snapshot
 * does (accelerations are never stored).
 *
 * Substeps: with settings.substeps = S > 1 a recorded step runs S KDK substeps of dt/S; every substep
 * is a full step above (its own drift segment is swept for capture and escape). Snapshots, history and
 * stoppedAt stay in recorded-step units. S absent or 1 runs exactly the single-step code with the same bits.
 * Impulses are applied to the synchronized velocities at the end of the recorded step they name (or to the
 * initial state at step 0), before the snapshot; accelerations depend only on positions, so the carried a_n
 * stays valid across a burn.
 *
 * Choices where model.ts is silent or loose (all reported to the owner):
 * - Attractor capture is the ENTRY point of the capture disc, not the segment's closest
 *   approach: an infall through the centre is captured at the radius. The test sweeps the
 *   RELATIVE segment: the particle's drift minus the attractor's displacement over the
 *   step (both straight; the attractor drifts at its half-kicked velocity) against a disc
 *   fixed at the attractor's step-n position, earliest entry wins, and the capture point is
 *   the particle's absolute position at that time. A moving attractor cannot tunnel
 *   through a particle. A particle already inside the disc at the start of the step is
 *   captured where it stands.
 * - Boundaries are CLOSED: a particle on a forbidden polygon's boundary (any edge or corner) is
 *   inside it and is captured at step 0; a segment that merely touches a polygon boundary
 *   (including one running along an edge line into a corner) crosses it. The domain
 *   rectangle is closed the other way round: on its edge is inside (free), and
 *   in `absorb` mode a start on any of the four edges stays free until it drifts out.
 * - `open` escape happens where the drift segment crosses the escape threshold (the
 *   rectangle grown by escapeMargin, a rounded rectangle), not at the segment end, unless a
 *   capture hit comes at or before that point along the segment (ties go to the capture).
 * - Step-0 state: a particle that starts inside a forbidden polygon, inside an
 *   attractor's capture disc, outside the rectangle in `absorb` mode, or farther
 *   than escapeMargin outside it in `open` mode is stopped at step 0 in place
 *   (reasons forbidden, attractor, edge; escaped), in that precedence.
 * - Softening: the force on any body from attractor j uses ε_j (the source).
 *   The attractor pair potential in the energy budget uses ε² = (ε_i² + ε_j²)/2,
 *   which equals ε² when the two are equal; momentum is exactly conserved (up
 *   to rounding) only for equal softenings.
 * - `hidden` and nothing else of the attractor list is excluded from the
 *   simulation hash (hidden is diagnostics only and never alters the physics).
 * - The work bound steps × (P·A + A² + P·E) counts every particle for every step, stopped
 *   or not (conservative: stopped particles cost no force evaluations or edge tests).
 * - `stateHash` follows the documented byte order exactly and does not include
 *   the step number, so two snapshots at different steps of a fully stopped
 *   system share a hash; compare `step` as well.
 * - Negative zero is normalized to +0 in snapshots (JSON cannot carry it).
 */
import { G, LIMITS, MODEL, REASON_CODE, SNAPSHOT_SCHEMA, STATUS_CODE } from './model.ts';
import type {
  EnergyBudget, History, Impulse, OrbitSnapshot, OrbitStudyConfig, SnapshotHashes, Vec2,
} from './model.ts';
import { hashFloat64, stableHash } from '../cloud-advection/sim.ts';

export class SnapshotMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotMismatchError';
  }
}

// -------------------------------------------------------------- validation

function finite(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function positive(name: string, value: number): void {
  finite(name, value);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function vec(name: string, v: Vec2): void {
  if (typeof v !== 'object' || v === null) throw new RangeError(`${name} must be a point`);
  finite(`${name}.x`, v.x);
  finite(`${name}.y`, v.y);
}

export function validateConfig(config: OrbitStudyConfig): void {
  const { domain, transforms, settings, attractors, forbidden, particles } = config;
  vec('domain.origin', domain.origin);
  vec('domain.size', domain.size);
  positive('domain.size.x', domain.size.x);
  positive('domain.size.y', domain.size.y);
  positive('worldToPage.scale', transforms.worldToPage.scale);
  vec('worldToPage.offset', transforms.worldToPage.offset);
  positive('settings.dt', settings.dt);
  if (settings.substeps !== undefined) {
    finite('settings.substeps', settings.substeps);
    if (!Number.isInteger(settings.substeps) || settings.substeps < 1 || settings.substeps > LIMITS.maxSubsteps) {
      throw new RangeError(`settings.substeps must be an integer in [1, ${LIMITS.maxSubsteps}]`);
    }
  }
  if (settings.boundary !== 'open' && settings.boundary !== 'absorb') {
    throw new RangeError("settings.boundary must be 'open' or 'absorb'");
  }
  finite('settings.escapeMargin', settings.escapeMargin);
  if (settings.escapeMargin < 0) throw new RangeError('settings.escapeMargin must be nonnegative');
  positive('particleMass', config.particleMass);
  if (attractors.length > LIMITS.maxAttractors) {
    throw new RangeError(`${attractors.length} attractors is above the limit of ${LIMITS.maxAttractors}`);
  }
  if (forbidden.length > LIMITS.maxForbidden) {
    throw new RangeError(`${forbidden.length} forbidden regions is above the limit of ${LIMITS.maxForbidden}`);
  }
  if (particles.length > LIMITS.maxParticles) {
    throw new RangeError(`${particles.length} particles is above the limit of ${LIMITS.maxParticles}`);
  }
  const impulses = config.impulses ?? [];
  if (!Array.isArray(impulses) || impulses.length > LIMITS.maxImpulses) {
    throw new RangeError(`impulses must be an array of at most ${LIMITS.maxImpulses}`);
  }
  impulses.forEach((m, i) => {
    if (!Number.isInteger(m.particle) || m.particle < 0 || m.particle >= particles.length) {
      throw new RangeError(`impulses[${i}].particle must be an index into particles`);
    }
    if (!Number.isInteger(m.step) || m.step < 0 || m.step > LIMITS.maxSteps) {
      throw new RangeError(`impulses[${i}].step must be an integer in [0, ${LIMITS.maxSteps}]`);
    }
    vec(`impulses[${i}].dv`, m.dv);
  });
  // Several burns at one (particle, step) add: the sum must stay finite (two of 1e308 would overflow to Infinity).
  const burn = new Map<string, Vec2>();
  for (const m of impulses) {
    const key = `${m.particle}:${m.step}`;
    const sum = burn.get(key) ?? { x: 0, y: 0 };
    sum.x += m.dv.x;
    sum.y += m.dv.y;
    burn.set(key, sum);
    if (!Number.isFinite(sum.x) || !Number.isFinite(sum.y)) throw new RangeError(`impulses at particle ${m.particle}, step ${m.step} sum to a non-finite dv`);
  }
  const totalEdges = forbidden.reduce((n, f) => n + (Array.isArray(f.polygon) ? f.polygon.length : 0), 0);
  if (totalEdges > LIMITS.maxForbiddenEdges) {
    throw new RangeError(`${totalEdges} forbidden edges is above the limit of ${LIMITS.maxForbiddenEdges}`);
  }
  attractors.forEach((a, i) => {
    vec(`attractors[${i}].position`, a.position);
    vec(`attractors[${i}].velocity`, a.velocity);
    positive(`attractors[${i}].mass`, a.mass);
    positive(`attractors[${i}].softening`, a.softening);
    finite(`attractors[${i}].captureRadius`, a.captureRadius);
    if (a.captureRadius < 0) throw new RangeError(`attractors[${i}].captureRadius must be nonnegative`);
    if (typeof a.dynamic !== 'boolean') throw new RangeError(`attractors[${i}].dynamic must be a boolean`);
    if (!a.dynamic && (a.velocity.x !== 0 || a.velocity.y !== 0)) {
      throw new RangeError(`attractors[${i}] is pinned and must have zero velocity`);
    }
  });
  forbidden.forEach((f, i) => {
    if (!Array.isArray(f.polygon) || f.polygon.length < 3) {
      throw new RangeError(`forbidden[${i}].polygon needs at least 3 vertices`);
    }
    f.polygon.forEach((p, k) => vec(`forbidden[${i}].polygon[${k}]`, p));
  });
  particles.forEach((p, i) => {
    vec(`particles[${i}].position`, p.position);
    vec(`particles[${i}].velocity`, p.velocity);
  });
}

function checkSteps(name: string, steps: number): void {
  if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 0) {
    throw new RangeError(`${name} must be a nonnegative integer`);
  }
}

/** Work for `steps` steps: steps × substeps × (particles × attractors + attractors² + particles × forbidden edges). */
function checkWork(config: OrbitStudyConfig, steps: number): void {
  if (steps > LIMITS.maxSteps) throw new RangeError(`${steps} steps is above the limit of ${LIMITS.maxSteps}`);
  const P = config.particles.length;
  const A = config.attractors.length;
  const E = config.forbidden.reduce((n, f) => n + f.polygon.length, 0);
  const work = steps * (config.settings.substeps ?? 1) * (P * A + A * A + P * E);
  if (work > LIMITS.maxWork) {
    throw new RangeError(`${steps} steps of ${P} particles, ${A} attractors and ${E} forbidden edges needs ${work} force evaluations and edge tests, above the limit of ${LIMITS.maxWork}`);
  }
}

// ----------------------------------------------------------------- hashing

export function configHashes(config: OrbitStudyConfig): SnapshotHashes {
  const geometry = stableHash({ domain: config.domain, forbidden: config.forbidden });
  const transform = stableHash(config.transforms);
  const simulation = stableHash({
    // substeps 1 and impulses [] are the defaults: absent, 1 and [] hash identically and stay out of the hash.
    settings: { ...config.settings, substeps: (config.settings.substeps ?? 1) > 1 ? config.settings.substeps : undefined },
    impulses: config.impulses && config.impulses.length > 0 ? config.impulses : undefined,
    // `hidden` is a diagnostics flag with no effect on the physics.
    attractors: config.attractors.map(({ hidden: _hidden, ...rest }) => rest),
    particleMass: config.particleMass,
    particles: config.particles,
    G,
    model: MODEL,
  });
  return { geometry, transform, simulation, stateKey: stableHash({ geometry, transform, simulation }) };
}

// ------------------------------------------------------------------- force

/** |F| coefficient: F = coef · (y_j − x). The arithmetic every force goes through. */
const pairCoef = (M: number, m: number, den: number): number => (G * M * m) / (den * Math.sqrt(den));

const FORCE = new Float64Array(2);

/**
 * Σ over attractors (config order, skipping index `skip`) of the force in N on
 * a body of mass m at (x, y). Result in FORCE[0], FORCE[1].
 */
function sumForce(
  mass: Float64Array, eps2: Float64Array, axs: Float64Array, ays: Float64Array,
  x: number, y: number, m: number, skip: number,
): void {
  let fx = 0;
  let fy = 0;
  for (let j = 0; j < mass.length; j++) {
    if (j === skip) continue;
    const dx = axs[j] - x;
    const dy = ays[j] - y;
    const coef = pairCoef(mass[j], m, dx * dx + dy * dy + eps2[j]);
    fx += coef * dx;
    fy += coef * dy;
  }
  FORCE[0] = fx;
  FORCE[1] = fy;
}

function attractorArrays(config: OrbitStudyConfig, positions: Vec2[]) {
  const A = config.attractors.length;
  if (!Array.isArray(positions) || positions.length !== A) {
    throw new RangeError(`attractorPositions must have ${A} entries (config order)`);
  }
  const mass = new Float64Array(A);
  const eps2 = new Float64Array(A);
  const axs = new Float64Array(A);
  const ays = new Float64Array(A);
  config.attractors.forEach((a, j) => {
    vec(`attractorPositions[${j}]`, positions[j]);
    mass[j] = a.mass;
    eps2[j] = a.softening * a.softening;
    axs[j] = positions[j].x;
    ays[j] = positions[j].y;
  });
  return { mass, eps2, axs, ays };
}

/** Force in newtons on a body of `mass` kg at p from the attractors at `attractorPositions` (config order). */
export function forceOn(config: OrbitStudyConfig, attractorPositions: Vec2[], p: Vec2, mass: number): Vec2 {
  vec('p', p);
  positive('mass', mass);
  const a = attractorArrays(config, attractorPositions);
  sumForce(a.mass, a.eps2, a.axs, a.ays, p.x, p.y, mass, -1);
  return { x: FORCE[0], y: FORCE[1] };
}

/** Acceleration in m/s² of a particle at p: forceOn(...) divided by the particle mass. */
export function accelerationAt(config: OrbitStudyConfig, attractorPositions: Vec2[], p: Vec2): Vec2 {
  const m = config.particleMass;
  const f = forceOn(config, attractorPositions, p, m);
  return { x: f.x / m, y: f.y / m };
}

// ------------------------------------------------------------------- state

interface Prep {
  config: OrbitStudyConfig;
  hashes: SnapshotHashes;
  nA: number;
  nP: number;
  mass: Float64Array;
  eps2: Float64Array;
  captureR: Float64Array;
  dynamic: Uint8Array;
  /** Per forbidden edge: start x, y and direction sx, sy. */
  edges: Float64Array;
  nEdges: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  absorb: boolean;
  escapeMargin: number;
  /** Recorded step length (snapshot time unit). */
  dt: number;
  substeps: number;
  /** dt / substeps: the KDK step length (equal to dt bitwise when substeps is 1). */
  dtSub: number;
  /** Impulses grouped by step, config order within a step. */
  impulses: Map<number, Impulse[]>;
  particleMass: number;
}

function groupImpulses(list: Impulse[]): Map<number, Impulse[]> {
  const out = new Map<number, Impulse[]>();
  for (const m of list) {
    const at = out.get(m.step);
    if (at) at.push(m);
    else out.set(m.step, [m]);
  }
  return out;
}

/** Burns scheduled for the synchronized step `step`; stopped particles ignore them. */
function applyImpulses(p: Prep, st: State, step: number): void {
  const list = p.impulses.get(step);
  if (!list) return;
  for (const m of list) {
    if (st.status[m.particle] !== STATUS_CODE.free) continue;
    st.vx[m.particle] += m.dv.x;
    st.vy[m.particle] += m.dv.y;
  }
}

function prepare(config: OrbitStudyConfig): Prep {
  validateConfig(config);
  const hashes = configHashes(config); // also rejects non-finite values anywhere in the config
  const nA = config.attractors.length;
  const mass = new Float64Array(nA);
  const eps2 = new Float64Array(nA);
  const captureR = new Float64Array(nA);
  const dynamic = new Uint8Array(nA);
  config.attractors.forEach((a, j) => {
    mass[j] = a.mass;
    eps2[j] = a.softening * a.softening;
    captureR[j] = a.captureRadius;
    dynamic[j] = a.dynamic ? 1 : 0;
  });
  let nEdges = 0;
  for (const f of config.forbidden) nEdges += f.polygon.length;
  const edges = new Float64Array(nEdges * 4);
  let e = 0;
  for (const f of config.forbidden) {
    const poly = f.polygon;
    for (let k = 0; k < poly.length; k++, e++) {
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      edges[e * 4] = a.x;
      edges[e * 4 + 1] = a.y;
      edges[e * 4 + 2] = b.x - a.x;
      edges[e * 4 + 3] = b.y - a.y;
    }
  }
  const { origin, size } = config.domain;
  return {
    config, hashes, nA, nP: config.particles.length, mass, eps2, captureR, dynamic, edges, nEdges,
    xMin: origin.x, yMin: origin.y, xMax: origin.x + size.x, yMax: origin.y + size.y,
    absorb: config.settings.boundary === 'absorb',
    escapeMargin: config.settings.escapeMargin,
    dt: config.settings.dt,
    substeps: config.settings.substeps ?? 1,
    dtSub: config.settings.dt / (config.settings.substeps ?? 1),
    impulses: groupImpulses(config.impulses ?? []),
    particleMass: config.particleMass,
  };
}

interface State {
  step: number;
  ax: Float64Array;
  ay: Float64Array;
  avx: Float64Array;
  avy: Float64Array;
  px: Float64Array;
  py: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  status: Int8Array;
  reason: Int8Array;
  stoppedAt: Int32Array;
  // Scratch, not part of the state: accelerations at the current positions.
  pax: Float64Array;
  pay: Float64Array;
  aax: Float64Array;
  aay: Float64Array;
  // Scratch: attractor positions at the start of the step (the sweep's fixed disc centres).
  ox: Float64Array;
  oy: Float64Array;
}

function blankState(nA: number, nP: number): State {
  return {
    step: 0,
    ax: new Float64Array(nA), ay: new Float64Array(nA), avx: new Float64Array(nA), avy: new Float64Array(nA),
    px: new Float64Array(nP), py: new Float64Array(nP), vx: new Float64Array(nP), vy: new Float64Array(nP),
    status: new Int8Array(nP), reason: new Int8Array(nP), stoppedAt: new Int32Array(nP).fill(-1),
    pax: new Float64Array(nP), pay: new Float64Array(nP), aax: new Float64Array(nA), aay: new Float64Array(nA),
    ox: new Float64Array(nA), oy: new Float64Array(nA),
  };
}

/** Closed polygon: a point on any edge or corner counts as inside (even-odd rule elsewhere). */
function pointInPolygon(poly: Vec2[], x: number, y: number): boolean {
  const scale = Math.max(1, Math.abs(x), Math.abs(y));
  let inside = false;
  for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
    const a = poly[k];
    const b = poly[m];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const cross = ex * (y - a.y) - ey * (x - a.x);
    const len = Math.sqrt(ex * ex + ey * ey);
    const tol = HIT_EPS * scale;
    if (
      Math.abs(cross) <= tol * len &&
      x >= Math.min(a.x, b.x) - tol && x <= Math.max(a.x, b.x) + tol &&
      y >= Math.min(a.y, b.y) - tol && y <= Math.max(a.y, b.y) + tol
    ) return true;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function stop(st: State, i: number, status: number, reason: number, at: number): void {
  st.status[i] = status;
  st.reason[i] = reason;
  st.stoppedAt[i] = at;
  st.vx[i] = 0;
  st.vy[i] = 0;
}

/** Outside the domain rectangle by this Euclidean distance (0 inside or on the edge). */
function distanceOutside(p: Prep, x: number, y: number): number {
  const dx = Math.max(p.xMin - x, 0, x - p.xMax);
  const dy = Math.max(p.yMin - y, 0, y - p.yMax);
  return Math.sqrt(dx * dx + dy * dy);
}

function initialState(p: Prep): State {
  const { config, nA, nP } = p;
  const st = blankState(nA, nP);
  config.attractors.forEach((a, j) => {
    st.ax[j] = a.position.x;
    st.ay[j] = a.position.y;
    st.avx[j] = a.velocity.x;
    st.avy[j] = a.velocity.y;
  });
  for (let i = 0; i < nP; i++) {
    const { position, velocity } = config.particles[i];
    st.px[i] = position.x;
    st.py[i] = position.y;
    st.vx[i] = velocity.x;
    st.vy[i] = velocity.y;
    if (config.forbidden.some((f) => pointInPolygon(f.polygon, position.x, position.y))) {
      stop(st, i, STATUS_CODE.captured, REASON_CODE.forbidden, 0);
      continue;
    }
    let inDisc = false;
    for (let j = 0; j < nA; j++) {
      const dx = position.x - st.ax[j];
      const dy = position.y - st.ay[j];
      if (dx * dx + dy * dy <= p.captureR[j] * p.captureR[j]) inDisc = true;
    }
    if (inDisc) {
      stop(st, i, STATUS_CODE.captured, REASON_CODE.attractor, 0);
      continue;
    }
    const out = distanceOutside(p, position.x, position.y);
    if (p.absorb && out > 0) stop(st, i, STATUS_CODE.captured, REASON_CODE.edge, 0);
    else if (!p.absorb && out > p.escapeMargin) stop(st, i, STATUS_CODE.escaped, REASON_CODE.none, 0);
  }
  applyImpulses(p, st, 0);
  return st;
}

// ------------------------------------------------------------ capture sweep

const HIT_EPS = 1e-12;

// Result of sweep(): parameter along the segment, reason code, and capture point.
const SWEEP = { t: Infinity, reason: 0, x: 0, y: 0 };

/** Internal reason code for an open-mode escape found by sweep() (not a REASON_CODE). */
const ESCAPE = -1;

/** Largest t in [0,1] with the segment inside the box, or −1 if it never is. */
function boxExit(x0: number, y0: number, rx: number, ry: number, bx0: number, by0: number, bx1: number, by1: number): number {
  let lo = 0;
  let hi = 1;
  const pp = [-rx, rx, -ry, ry];
  const qq = [x0 - bx0, bx1 - x0, y0 - by0, by1 - y0];
  for (let k = 0; k < 4; k++) {
    if (pp[k] === 0) {
      if (qq[k] < 0) return -1;
    } else {
      const r = qq[k] / pp[k];
      if (pp[k] < 0) {
        if (r > hi) return -1;
        if (r > lo) lo = r;
      } else {
        if (r < lo) return -1;
        if (r < hi) hi = r;
      }
    }
  }
  return hi;
}

/** Largest t in [0,1] with the segment inside the disc, or −1 if it never is. */
function discExit(x0: number, y0: number, rx: number, ry: number, cx: number, cy: number, R: number): number {
  const ex = x0 - cx;
  const ey = y0 - cy;
  const A = rx * rx + ry * ry;
  const C = ex * ex + ey * ey - R * R;
  if (A === 0) return C <= 0 ? 1 : -1;
  const B = ex * rx + ey * ry;
  const disc = B * B - A * C;
  if (disc < 0) return -1;
  const root = Math.sqrt(disc);
  const lo = (-B - root) / A;
  const hi = (-B + root) / A;
  if (hi < 0 || lo > 1) return -1;
  return Math.min(1, hi);
}

/**
 * Where the segment leaves the escape region (the domain rectangle grown by escapeMargin, a rounded
 * rectangle), or Infinity if its endpoint is still inside. The region is convex, so a segment that starts
 * inside it stays inside up to one exit parameter: the largest exit over the region's six convex pieces
 * (two boxes and four corner discs).
 */
function escapeParam(p: Prep, x0: number, y0: number, x1: number, y1: number): number {
  const m = p.escapeMargin;
  if (distanceOutside(p, x1, y1) <= m) return Infinity;
  const rx = x1 - x0;
  const ry = y1 - y0;
  const exits = [
    boxExit(x0, y0, rx, ry, p.xMin - m, p.yMin, p.xMax + m, p.yMax),
    boxExit(x0, y0, rx, ry, p.xMin, p.yMin - m, p.xMax, p.yMax + m),
    discExit(x0, y0, rx, ry, p.xMin, p.yMin, m),
    discExit(x0, y0, rx, ry, p.xMax, p.yMin, m),
    discExit(x0, y0, rx, ry, p.xMin, p.yMax, m),
    discExit(x0, y0, rx, ry, p.xMax, p.yMax, m),
  ];
  return Math.min(1, Math.max(0, ...exits));
}

/**
 * Earliest stopping event of the particle's straight drift segment (x0,y0)→(x1,y1) over one step. The
 * attractors move in straight lines too, from (ox, oy) to (nx, ny); the capture disc is swept as the relative
 * segment against a disc fixed at the start position. Ties resolve forbidden, then attractor, then edge, and
 * an open-mode escape only wins if it happens strictly before every capture. Fills SWEEP (reason ESCAPE for
 * an escape; the point is always the particle's absolute position).
 */
function sweep(
  p: Prep, ox: Float64Array, oy: Float64Array, nx: Float64Array, ny: Float64Array,
  x0: number, y0: number, x1: number, y1: number,
): void {
  const rx = x1 - x0;
  const ry = y1 - y0;
  let best = Infinity;
  let reason = REASON_CODE.none as number;

  // Forbidden polygons: every edge, earliest crossing.
  const { edges } = p;
  for (let e = 0; e < p.nEdges; e++) {
    const cx = edges[e * 4];
    const cy = edges[e * 4 + 1];
    const sx = edges[e * 4 + 2];
    const sy = edges[e * 4 + 3];
    const denom = rx * sy - ry * sx;
    if (denom === 0) continue; // parallel: a segment along an edge line is caught at the adjacent edge's corner
    const qx = cx - x0;
    const qy = cy - y0;
    const t = (qx * sy - qy * sx) / denom;
    if (t < -HIT_EPS || t > 1 + HIT_EPS || t >= best) continue;
    const u = (qx * ry - qy * rx) / denom;
    if (u < -HIT_EPS || u > 1 + HIT_EPS) continue;
    best = t;
    reason = REASON_CODE.forbidden;
  }
  if (best !== Infinity) best = Math.min(1, Math.max(0, best));

  // Attractor capture discs: first entry of the relative segment.
  for (let j = 0; j < p.nA; j++) {
    const R = p.captureR[j];
    const ex = x0 - ox[j];
    const ey = y0 - oy[j];
    const sx = rx - (nx[j] - ox[j]);
    const sy = ry - (ny[j] - oy[j]);
    const A = sx * sx + sy * sy;
    const C = ex * ex + ey * ey - R * R;
    let t: number;
    if (C <= 0) t = 0;
    else {
      if (A === 0) continue;
      const B = ex * sx + ey * sy;
      const disc = B * B - A * C;
      if (disc < 0) continue;
      t = (-B - Math.sqrt(disc)) / A;
      if (t < 0 || t > 1) continue;
    }
    if (t < best) {
      best = t;
      reason = REASON_CODE.attractor;
    }
  }

  // Domain edge (absorb): where the segment leaves the rectangle. The axis (or axes) that cross at the earliest
  // t land exactly on the boundary coordinate.
  let snapX = Number.NaN;
  let snapY = Number.NaN;
  if (p.absorb) {
    let tx = Infinity;
    let ty = Infinity;
    let bx = 0;
    let by = 0;
    if (x1 > p.xMax) { tx = (p.xMax - x0) / rx; bx = p.xMax; }
    else if (x1 < p.xMin) { tx = (p.xMin - x0) / rx; bx = p.xMin; }
    if (y1 > p.yMax) { ty = (p.yMax - y0) / ry; by = p.yMax; }
    else if (y1 < p.yMin) { ty = (p.yMin - y0) / ry; by = p.yMin; }
    const t = Math.min(tx, ty);
    if (t !== Infinity) {
      const tc = Math.min(1, Math.max(0, t));
      if (tc < best) {
        best = tc;
        reason = REASON_CODE.edge;
        if (tx <= ty) snapX = bx;
        if (ty <= tx) snapY = by;
      }
    }
  } else {
    // Open: the escape threshold crossing, if strictly before every capture hit.
    const t = escapeParam(p, x0, y0, x1, y1);
    if (t < best) {
      best = t;
      reason = ESCAPE;
    }
  }

  SWEEP.t = best;
  SWEEP.reason = reason;
  if (reason === REASON_CODE.none) return;
  let cx = x0 + best * rx;
  let cy = y0 + best * ry;
  if (reason === REASON_CODE.edge) { // the crossing axis lands exactly on the boundary (x0 + t·rx can be an ulp off)
    if (!Number.isNaN(snapX)) cx = snapX;
    if (!Number.isNaN(snapY)) cy = snapY;
  }
  SWEEP.x = cx;
  SWEEP.y = cy;
}

// -------------------------------------------------------------- integration

/** a = F / m for every free particle and every dynamic attractor at the current positions. */
function computeAcc(p: Prep, st: State): void {
  const { mass, eps2 } = p;
  for (let i = 0; i < p.nP; i++) {
    if (st.status[i] !== STATUS_CODE.free) continue;
    sumForce(mass, eps2, st.ax, st.ay, st.px[i], st.py[i], p.particleMass, -1);
    st.pax[i] = FORCE[0] / p.particleMass;
    st.pay[i] = FORCE[1] / p.particleMass;
  }
  for (let j = 0; j < p.nA; j++) {
    if (!p.dynamic[j]) continue;
    sumForce(mass, eps2, st.ax, st.ay, st.ax[j], st.ay[j], mass[j], j);
    st.aax[j] = FORCE[0] / mass[j];
    st.aay[j] = FORCE[1] / mass[j];
  }
}

/**
 * One kick–drift–kick (sub)step of length dtSub. Requires st.pax/pay/aax/aay to hold a_n for the current
 * positions. st.step is the recorded step in progress and is not advanced here.
 */
function stepOnce(p: Prep, st: State): void {
  const dt = p.dtSub;
  const half = 0.5 * dt;
  const n = st.step;

  // Kick (a_n), then drift. Pinned attractors never move.
  for (let j = 0; j < p.nA; j++) {
    st.ox[j] = st.ax[j];
    st.oy[j] = st.ay[j];
    if (!p.dynamic[j]) continue;
    st.avx[j] += st.aax[j] * half;
    st.avy[j] += st.aay[j] * half;
    st.ax[j] += st.avx[j] * dt;
    st.ay[j] += st.avy[j] * dt;
  }
  for (let i = 0; i < p.nP; i++) {
    if (st.status[i] !== STATUS_CODE.free) continue;
    st.vx[i] += st.pax[i] * half;
    st.vy[i] += st.pay[i] * half;
    const x0 = st.px[i];
    const y0 = st.py[i];
    const x1 = x0 + st.vx[i] * dt;
    const y1 = y0 + st.vy[i] * dt;
    sweep(p, st.ox, st.oy, st.ax, st.ay, x0, y0, x1, y1);
    if (SWEEP.reason === ESCAPE) {
      st.px[i] = SWEEP.x;
      st.py[i] = SWEEP.y;
      stop(st, i, STATUS_CODE.escaped, REASON_CODE.none, n + 1);
    } else if (SWEEP.reason !== REASON_CODE.none) {
      st.px[i] = SWEEP.x;
      st.py[i] = SWEEP.y;
      stop(st, i, STATUS_CODE.captured, SWEEP.reason, n + 1);
    } else {
      st.px[i] = x1;
      st.py[i] = y1;
    }
  }

  // a_{n+1} from the step-(n+1) positions, then the second kick.
  computeAcc(p, st);
  for (let j = 0; j < p.nA; j++) {
    if (!p.dynamic[j]) continue;
    st.avx[j] += st.aax[j] * half;
    st.avy[j] += st.aay[j] * half;
  }
  for (let i = 0; i < p.nP; i++) {
    if (st.status[i] !== STATUS_CODE.free) continue;
    st.vx[i] += st.pax[i] * half;
    st.vy[i] += st.pay[i] * half;
  }
}

function run(p: Prep, st: State, steps: number, onStep?: (st: State) => void): void {
  if (steps === 0) return;
  computeAcc(p, st);
  for (let s = 0; s < steps; s++) {
    for (let k = 0; k < p.substeps; k++) stepOnce(p, st);
    st.step++;
    applyImpulses(p, st, st.step);
    if (onStep) onStep(st);
  }
}

// ---------------------------------------------------------------- snapshots

const norm = (v: number): number => v + 0; // −0 → +0

function energyOf(p: Prep, st: State): EnergyBudget {
  let particleSpecific = 0;
  for (let i = 0; i < p.nP; i++) {
    if (st.status[i] !== STATUS_CODE.free) continue;
    let pot = 0;
    for (let j = 0; j < p.nA; j++) {
      const dx = st.ax[j] - st.px[i];
      const dy = st.ay[j] - st.py[i];
      pot -= (G * p.mass[j]) / Math.sqrt(dx * dx + dy * dy + p.eps2[j]);
    }
    particleSpecific += 0.5 * (st.vx[i] * st.vx[i] + st.vy[i] * st.vy[i]) + pot;
  }
  let attractorTotal = 0;
  let mx = 0;
  let my = 0;
  for (let j = 0; j < p.nA; j++) {
    attractorTotal += 0.5 * p.mass[j] * (st.avx[j] * st.avx[j] + st.avy[j] * st.avy[j]);
    mx += p.mass[j] * st.avx[j];
    my += p.mass[j] * st.avy[j];
    for (let k = j + 1; k < p.nA; k++) {
      const dx = st.ax[k] - st.ax[j];
      const dy = st.ay[k] - st.ay[j];
      const e2 = 0.5 * (p.eps2[j] + p.eps2[k]);
      attractorTotal -= (G * p.mass[j] * p.mass[k]) / Math.sqrt(dx * dx + dy * dy + e2);
    }
  }
  return { particleSpecific, attractorTotal, attractorMomentum: { x: mx, y: my } };
}

/** The documented byte order: attractors (x, y, vx, vy each), then px, py, vx, vy, then status, reason, stoppedAt. */
function stateHashOf(parts: {
  attractors: { position: Vec2; velocity: Vec2 }[];
  px: ArrayLike<number>; py: ArrayLike<number>; vx: ArrayLike<number>; vy: ArrayLike<number>;
  status: ArrayLike<number>; reason: ArrayLike<number>; stoppedAt: ArrayLike<number>;
}): string {
  const flat: number[] = [];
  for (const a of parts.attractors) flat.push(a.position.x, a.position.y, a.velocity.x, a.velocity.y);
  for (const arr of [parts.px, parts.py, parts.vx, parts.vy, parts.status, parts.reason, parts.stoppedAt]) {
    for (let i = 0; i < arr.length; i++) flat.push(arr[i]);
  }
  return hashFloat64(flat);
}

function snapshotOf(p: Prep, st: State): OrbitSnapshot {
  const attractors = p.config.attractors.map((a, j) => ({
    id: a.id,
    position: { x: norm(st.ax[j]), y: norm(st.ay[j]) },
    velocity: { x: norm(st.avx[j]), y: norm(st.avy[j]) },
  }));
  const px = Array.from(st.px, norm);
  const py = Array.from(st.py, norm);
  const vx = Array.from(st.vx, norm);
  const vy = Array.from(st.vy, norm);
  const status = Array.from(st.status);
  const reason = Array.from(st.reason);
  const stoppedAt = Array.from(st.stoppedAt);
  return {
    schema: SNAPSHOT_SCHEMA,
    model: MODEL,
    hashes: { ...p.hashes },
    step: st.step,
    timeS: st.step * p.dt,
    attractors,
    px, py, vx, vy, status, reason, stoppedAt,
    stateHash: stateHashOf({ attractors, px, py, vx, vy, status, reason, stoppedAt }),
    energy: energyOf(p, st),
  };
}

function fail(message: string): never {
  throw new RangeError(`invalid snapshot: ${message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Throws SnapshotMismatchError for a snapshot of another model/config/state, RangeError for a malformed one. */
function checkSnapshot(p: Prep, s: OrbitSnapshot): void {
  if (!isRecord(s)) fail('not an object');
  if (s.schema !== SNAPSHOT_SCHEMA) throw new SnapshotMismatchError(`snapshot schema ${String(s.schema)} is not ${SNAPSHOT_SCHEMA}`);
  for (const key of ['id', 'version', 'backend', 'backendVersion'] as const) {
    if (s.model?.[key] !== MODEL[key]) throw new SnapshotMismatchError(`snapshot model.${key} differs from the current model`);
  }
  for (const key of ['geometry', 'transform', 'simulation', 'stateKey'] as const) {
    if (s.hashes?.[key] !== p.hashes[key]) throw new SnapshotMismatchError(`snapshot ${key} hash differs from the config`);
  }
  if (typeof s.step !== 'number' || !Number.isInteger(s.step) || s.step < 0 || s.step > LIMITS.maxSteps) {
    fail(`step must be an integer in [0, ${LIMITS.maxSteps}]`);
  }
  if (s.timeS !== s.step * p.dt) throw new SnapshotMismatchError('snapshot timeS is not step·dt');
  if (!Array.isArray(s.attractors) || s.attractors.length !== p.nA) {
    throw new SnapshotMismatchError('snapshot attractor count differs from the config');
  }
  s.attractors.forEach((a, j) => {
    if (!isRecord(a) || a.id !== p.config.attractors[j].id) throw new SnapshotMismatchError(`snapshot attractors[${j}] id differs from the config`);
    for (const v of [a.position, a.velocity]) {
      if (!isRecord(v) || !Number.isFinite(v.x) || !Number.isFinite(v.y)) fail(`attractors[${j}] must have finite position and velocity`);
    }
    if (!p.dynamic[j]) {
      const c = p.config.attractors[j];
      if (a.position.x !== c.position.x || a.position.y !== c.position.y || a.velocity.x !== 0 || a.velocity.y !== 0) {
        throw new SnapshotMismatchError(`snapshot pinned attractors[${j}] moved`);
      }
    }
  });
  for (const key of ['px', 'py', 'vx', 'vy', 'status', 'reason', 'stoppedAt'] as const) {
    const arr = s[key];
    if (!Array.isArray(arr) || arr.length !== p.nP) fail(`${key} must have ${p.nP} entries`);
    for (let i = 0; i < arr.length; i++) {
      if (typeof arr[i] !== 'number' || !Number.isFinite(arr[i])) fail(`${key}[${i}] must be finite`);
    }
  }
  for (let i = 0; i < p.nP; i++) {
    const st = s.status[i];
    const free = st === STATUS_CODE.free;
    if (st !== 0 && st !== 1 && st !== 2) fail(`status[${i}] must be 0, 1 or 2`);
    if (![0, 1, 2, 3].includes(s.reason[i])) fail(`reason[${i}] must be 0..3`);
    if (free ? s.stoppedAt[i] !== -1 : !Number.isInteger(s.stoppedAt[i]) || s.stoppedAt[i] < 0 || s.stoppedAt[i] > s.step) {
      fail(`stoppedAt[${i}] is inconsistent with status`);
    }
    if (free && s.reason[i] !== 0) fail(`reason[${i}] must be 0 while free`);
    if (!free && (s.vx[i] !== 0 || s.vy[i] !== 0)) fail(`stopped particle ${i} must have zero velocity`);
  }
  if (stateHashOf(s) !== s.stateHash) throw new SnapshotMismatchError('snapshot state does not match its stateHash');
}

function stateFromSnapshot(p: Prep, s: OrbitSnapshot): State {
  const st = blankState(p.nA, p.nP);
  st.step = s.step;
  s.attractors.forEach((a, j) => {
    st.ax[j] = a.position.x;
    st.ay[j] = a.position.y;
    st.avx[j] = a.velocity.x;
    st.avy[j] = a.velocity.y;
  });
  for (let i = 0; i < p.nP; i++) {
    st.px[i] = s.px[i];
    st.py[i] = s.py[i];
    st.vx[i] = s.vx[i];
    st.vy[i] = s.vy[i];
    st.status[i] = s.status[i];
    st.reason[i] = s.reason[i];
    st.stoppedAt[i] = s.stoppedAt[i];
  }
  return st;
}

// ----------------------------------------------------------------- public

export function initialSnapshot(config: OrbitStudyConfig): OrbitSnapshot {
  const p = prepare(config);
  return snapshotOf(p, initialState(p));
}

export function advance(config: OrbitStudyConfig, snapshot: OrbitSnapshot, steps: number): OrbitSnapshot {
  checkSteps('steps', steps);
  const p = prepare(config);
  checkSnapshot(p, snapshot);
  if (snapshot.step + steps > LIMITS.maxSteps) {
    throw new RangeError(`step ${snapshot.step + steps} exceeds the limit of ${LIMITS.maxSteps}`);
  }
  checkWork(config, steps);
  const st = stateFromSnapshot(p, snapshot);
  run(p, st, steps);
  return snapshotOf(p, st);
}

/** Snapshots at the requested steps, ascending with duplicates removed (not in request order). */
export function simulate(config: OrbitStudyConfig, steps: number[]): OrbitSnapshot[] {
  steps.forEach((s, i) => checkSteps(`steps[${i}]`, s));
  const wanted = [...new Set(steps)].sort((a, b) => a - b);
  const p = prepare(config);
  checkWork(config, wanted.length ? wanted[wanted.length - 1] : 0);
  const st = initialState(p);
  const out: OrbitSnapshot[] = [];
  for (const target of wanted) {
    run(p, st, target - st.step);
    out.push(snapshotOf(p, st));
  }
  return out;
}

/** One pass from step 0 recording every position in [fromStep, toStep], plus the final snapshot at toStep. */
export function history(config: OrbitStudyConfig, fromStep: number, toStep: number): History {
  checkSteps('fromStep', fromStep);
  checkSteps('toStep', toStep);
  if (fromStep > toStep) throw new RangeError('fromStep must not exceed toStep');
  const p = prepare(config);
  checkWork(config, toStep);
  const bytes = (toStep - fromStep + 1) * (p.nP + p.nA) * 16; // x and y Float64 per body per recorded step
  if (bytes > LIMITS.maxHistoryBytes) {
    throw new RangeError(`a history window of ${toStep - fromStep + 1} steps needs ${bytes} bytes, above the limit of ${LIMITS.maxHistoryBytes}; narrow the window`);
  }
  const st = initialState(p);
  const xs: Float64Array[] = [];
  const ys: Float64Array[] = [];
  const ax: Float64Array[] = [];
  const ay: Float64Array[] = [];
  const record = (s: State): void => {
    if (s.step < fromStep) return;
    xs.push(Float64Array.from(s.px));
    ys.push(Float64Array.from(s.py));
    ax.push(Float64Array.from(s.ax));
    ay.push(Float64Array.from(s.ay));
  };
  record(st);
  run(p, st, toStep, record);
  return { fromStep, toStep, xs, ys, ax, ay, final: snapshotOf(p, st) };
}

export function serializeSnapshot(s: OrbitSnapshot): string {
  return JSON.stringify(s);
}

export function parseSnapshot(config: OrbitStudyConfig, json: string): OrbitSnapshot {
  const p = prepare(config);
  const raw: unknown = JSON.parse(json);
  if (!isRecord(raw)) fail('not an object');
  const snapshot = raw as unknown as OrbitSnapshot;
  checkSnapshot(p, snapshot);
  return snapshot;
}
