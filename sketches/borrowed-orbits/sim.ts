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
 * Choices where model.ts is silent or loose (all reported to the owner):
 * - Attractor capture is the ENTRY point of the capture disc along the drift
 *   segment (distance exactly captureRadius), not the segment's closest
 *   approach: an infall through the centre is captured at the radius, and a
 *   particle that merely starts inside the disc is captured where it stands.
 *   The disc sits at the attractor's midpoint position for the step.
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
 * - The work bound counts every particle for every step, stopped or not
 *   (conservative: stopped particles cost no force evaluations).
 * - `stateHash` follows the documented byte order exactly and does not include
 *   the step number, so two snapshots at different steps of a fully stopped
 *   system share a hash; compare `step` as well.
 * - Negative zero is normalized to +0 in snapshots (JSON cannot carry it).
 */
import { G, LIMITS, MODEL, REASON_CODE, SNAPSHOT_SCHEMA, STATUS_CODE } from './model.ts';
import type {
  EnergyBudget, History, OrbitSnapshot, OrbitStudyConfig, SnapshotHashes, Vec2,
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

/** Force evaluations for `steps` steps: steps × (particles × attractors + attractors²). */
function checkWork(config: OrbitStudyConfig, steps: number): void {
  if (steps > LIMITS.maxSteps) throw new RangeError(`${steps} steps is above the limit of ${LIMITS.maxSteps}`);
  const P = config.particles.length;
  const A = config.attractors.length;
  const work = steps * (P * A + A * A);
  if (work > LIMITS.maxWork) {
    throw new RangeError(`${steps} steps of ${P} particles and ${A} attractors needs ${work} force evaluations, above the limit of ${LIMITS.maxWork}`);
  }
}

// ----------------------------------------------------------------- hashing

export function configHashes(config: OrbitStudyConfig): SnapshotHashes {
  const geometry = stableHash({ domain: config.domain, forbidden: config.forbidden });
  const transform = stableHash(config.transforms);
  const simulation = stableHash({
    settings: config.settings,
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
  dt: number;
  particleMass: number;
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
  // Scratch: attractor positions at the start of the step.
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

function pointInPolygon(poly: Vec2[], x: number, y: number): boolean {
  let inside = false;
  for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
    const a = poly[k];
    const b = poly[m];
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
  return st;
}

// ------------------------------------------------------------ capture sweep

const HIT_EPS = 1e-12;

// Result of sweep(): parameter along the segment, reason code, and capture point.
const SWEEP = { t: Infinity, reason: 0, x: 0, y: 0 };

/**
 * Earliest capture of the straight drift segment (x0,y0)→(x1,y1) while the
 * attractors sit at (mx, my) (their midpoint positions for the step). Ties
 * resolve forbidden, then attractor, then edge. Fills SWEEP.
 */
function sweep(
  p: Prep, mx: Float64Array, my: Float64Array, x0: number, y0: number, x1: number, y1: number,
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
    if (denom === 0) continue; // parallel: a grazing pass does not cross
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

  // Attractor capture discs: entry point of the segment.
  const A = rx * rx + ry * ry;
  for (let j = 0; j < p.nA; j++) {
    const R = p.captureR[j];
    const ex = x0 - mx[j];
    const ey = y0 - my[j];
    const C = ex * ex + ey * ey - R * R;
    let t: number;
    if (C <= 0) t = 0;
    else {
      if (A === 0) continue;
      const B = ex * rx + ey * ry;
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

  // Domain edge (absorb): where the segment leaves the rectangle.
  if (p.absorb) {
    let t = Infinity;
    if (x1 > p.xMax) t = Math.min(t, (p.xMax - x0) / rx);
    else if (x1 < p.xMin) t = Math.min(t, (p.xMin - x0) / rx);
    if (y1 > p.yMax) t = Math.min(t, (p.yMax - y0) / ry);
    else if (y1 < p.yMin) t = Math.min(t, (p.yMin - y0) / ry);
    if (t !== Infinity) {
      t = Math.min(1, Math.max(0, t));
      if (t < best) {
        best = t;
        reason = REASON_CODE.edge;
      }
    }
  }

  SWEEP.t = best;
  SWEEP.reason = reason;
  if (reason === REASON_CODE.none) return;
  let cx = x0 + best * rx;
  let cy = y0 + best * ry;
  if (reason === REASON_CODE.edge) { // land exactly on the rectangle boundary
    cx = Math.min(p.xMax, Math.max(p.xMin, cx));
    cy = Math.min(p.yMax, Math.max(p.yMin, cy));
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

/** One kick–drift–kick step. Requires st.pax/pay/aax/aay to hold a_n for the current positions. */
function stepOnce(p: Prep, st: State): void {
  const dt = p.dt;
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
  // Attractor midpoint positions for this step (reuse ox/oy as the midpoints).
  for (let j = 0; j < p.nA; j++) {
    st.ox[j] = 0.5 * (st.ox[j] + st.ax[j]);
    st.oy[j] = 0.5 * (st.oy[j] + st.ay[j]);
  }
  for (let i = 0; i < p.nP; i++) {
    if (st.status[i] !== STATUS_CODE.free) continue;
    st.vx[i] += st.pax[i] * half;
    st.vy[i] += st.pay[i] * half;
    const x0 = st.px[i];
    const y0 = st.py[i];
    const x1 = x0 + st.vx[i] * dt;
    const y1 = y0 + st.vy[i] * dt;
    sweep(p, st.ox, st.oy, x0, y0, x1, y1);
    if (SWEEP.reason !== REASON_CODE.none) {
      st.px[i] = SWEEP.x;
      st.py[i] = SWEEP.y;
      stop(st, i, STATUS_CODE.captured, SWEEP.reason, n + 1);
    } else {
      st.px[i] = x1;
      st.py[i] = y1;
      if (!p.absorb && distanceOutside(p, x1, y1) > p.escapeMargin) {
        stop(st, i, STATUS_CODE.escaped, REASON_CODE.none, n + 1);
      }
    }
  }
  st.step = n + 1;

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
    stepOnce(p, st);
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
