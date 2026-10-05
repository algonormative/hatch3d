/**
 * Periodic libration orbits of the restricted three-body problem, found by shooting with the simulation.
 *
 * A particle released near L4, L5 or the L3 side with a plausible velocity (the guiding-centre start: the circular Keplerian
 * orbit about the barycentre) still carries a short-period epicycle superimposed on the slow libration, and one libration
 * later it is not where it started: the line wiggles and does not close. The epicycle and the libration are incommensurate,
 * so only an exact periodic orbit closes. Those exist (the long-period family and the horseshoe family); this module finds
 * the one through a given start point by Gauss-Newton on (u, v, T), the initial rotating-frame velocity and the period,
 * with the residual the change of the rotating-frame state (x, y, u, v) after T. Every residual is evaluated by running the
 * simulation (sim.ts, inertial frame), so the drawn orbit is the integrated one; the shooting only chooses its start.
 *
 * Units: positions in the separation a, velocities in a times the binary's angular velocity.
 */
import type { Attractor, History, OrbitStudyConfig, ParticleInit, Vec2 } from './model.ts';

export interface BinarySetup {
  mu: number;
  /** Separation, m. */
  a: number;
  /** Binary angular velocity, rad/s. */
  omega: number;
  bary: Vec2;
  attractors: Attractor[];
}

export type Runner = (config: OrbitStudyConfig, from: number, to: number) => History;

/** A rotating-frame state in normalized units. */
export interface RotatingState { xi: number; eta: number; u: number; v: number }

export interface SolvedOrbit {
  /** Initial rotating-frame velocity of the periodic orbit, normalized. */
  u: number;
  v: number;
  /** Period, s. */
  periodS: number;
  /** Recorded steps in one period; dt = period / steps. */
  steps: number;
  substeps: number;
  /** Size of the rotating-frame state change after one period (normalized). */
  residual: number;
  iterations: number;
  /** false: shooting did not converge and the start velocity is the guess. */
  converged: boolean;
}

const STEPS = 2400;
const TRIAL_DT = 1;
const TRIAL_SUBSTEPS = 32;
/** Substep length bound, s: about 1/200 of the binary's rotation. */
const SUBSTEP_S = 0.03;

const substepsFor = (dt: number): number => Math.max(8, Math.min(64, Math.ceil(dt / SUBSTEP_S)));

/** The configuration of the binary plus one particle at a rotating-frame state (t = 0: the rotating and inertial frames coincide). */
export function orbitConfig(binary: BinarySetup, state: RotatingState, dt: number, substeps: number): OrbitStudyConfig {
  const { a, omega, bary } = binary;
  const particle: ParticleInit = {
    position: { x: bary.x + a * state.xi, y: bary.y + a * state.eta },
    velocity: { x: a * omega * (state.u - state.eta), y: a * omega * (state.v + state.xi) },
  };
  return {
    domain: { origin: { x: 0, y: 0 }, size: { x: 48, y: 78 } },
    transforms: { worldToPage: { scale: 5, offset: { x: 0, y: 0 } } },
    settings: { dt, substeps, boundary: 'open', escapeMargin: 1000 },
    attractors: binary.attractors.map(m => ({ ...m, position: { ...m.position }, velocity: { ...m.velocity } })),
    forbidden: [], particleMass: 1, particles: [particle],
  };
}

/** Frame of the binary at one record: barycentre, angle of the line from primary to secondary, and its instantaneous rate. */
function frame(masses: number[], p: Vec2[], v: Vec2[]): { bary: Vec2; vBary: Vec2; angle: number; rate: number } {
  const total = masses[0] + masses[1];
  const dx = p[1].x - p[0].x, dy = p[1].y - p[0].y, dvx = v[1].x - v[0].x, dvy = v[1].y - v[0].y;
  return {
    bary: { x: (masses[0] * p[0].x + masses[1] * p[1].x) / total, y: (masses[0] * p[0].y + masses[1] * p[1].y) / total },
    vBary: { x: (masses[0] * v[0].x + masses[1] * v[1].x) / total, y: (masses[0] * v[0].y + masses[1] * v[1].y) / total },
    angle: Math.atan2(dy, dx),
    rate: (dx * dvy - dy * dvx) / (dx * dx + dy * dy),
  };
}

/** Normalized rotating-frame state of particle 0 at the end of a history (from the synchronized final snapshot). */
export function finalRotatingState(binary: BinarySetup, h: History): RotatingState {
  const f = h.final;
  const masses = binary.attractors.map(m => m.mass);
  const fr = frame(masses, f.attractors.map(m => m.position), f.attractors.map(m => m.velocity));
  const c = Math.cos(-fr.angle), s = Math.sin(-fr.angle);
  const x = f.px[0] - fr.bary.x, y = f.py[0] - fr.bary.y;
  const wx = f.vx[0] - fr.vBary.x, wy = f.vy[0] - fr.vBary.y;
  const rx = x * c - y * s, ry = x * s + y * c;
  // v_rot = R(-theta)(v - V_bary) - omega_b z x r, with z x r = (-ry, rx).
  const ux = wx * c - wy * s + fr.rate * ry, uy = wx * s + wy * c - fr.rate * rx;
  const unit = binary.a * binary.omega;
  return { xi: rx / binary.a, eta: ry / binary.a, u: ux / unit, v: uy / unit };
}

/** Rotating-frame positions (normalized) of particle 0 at every record of a history. */
export function rotatingPath(binary: BinarySetup, h: History): Vec2[] {
  const masses = binary.attractors.map(m => m.mass);
  const total = masses[0] + masses[1];
  return h.xs.map((_xs, k) => {
    const p1 = { x: h.ax[k][0], y: h.ay[k][0] }, p2 = { x: h.ax[k][1], y: h.ay[k][1] };
    const bx = (masses[0] * p1.x + masses[1] * p2.x) / total, by = (masses[0] * p1.y + masses[1] * p2.y) / total;
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const c = Math.cos(-angle), s = Math.sin(-angle);
    const dx = h.xs[k][0] - bx, dy = h.ys[k][0] - by;
    return { x: (dx * c - dy * s) / binary.a, y: (dx * s + dy * c) / binary.a };
  });
}

/**
 * First return of the polar angle (about the barycentre, unwrapped, relative to its start) to zero with the sign of its
 * initial rate, after it has left the neighbourhood of zero: one libration of a tadpole, one full cycle of a horseshoe.
 * Returns the time in seconds, linearly interpolated, or null.
 */
export function returnTime(path: Vec2[], dt: number): number | null {
  const angle: number[] = [];
  let previous = Math.atan2(path[0].y, path[0].x), unwrapped = 0;
  angle.push(0);
  for (let k = 1; k < path.length; k++) {
    let d = Math.atan2(path[k].y, path[k].x) - previous;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    unwrapped += d;
    previous += d;
    angle.push(unwrapped);
  }
  const lookahead = Math.min(12, angle.length - 1);
  const rate0 = Math.sign(angle[lookahead] - angle[0]) || 1;
  let left = 0;
  for (let k = 1; k < angle.length; k++) {
    left = Math.max(left, Math.abs(angle[k - 1]));
    if (left < 0.02) continue;
    // Crossing zero in the direction of the initial rate.
    if (angle[k - 1] * rate0 < 0 && angle[k] * rate0 >= 0) return (k - 1 + (0 - angle[k - 1]) / (angle[k] - angle[k - 1])) * dt;
  }
  return null;
}

function solve3(A: number[][], b: number[]): number[] {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r;
    [m[i], m[p]] = [m[p], m[i]];
    for (let r = i + 1; r < 3; r++) {
      const k = m[r][i] / m[i][i];
      for (let c = i; c < 4; c++) m[r][c] -= k * m[i][c];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let sum = m[i][3];
    for (let c = i + 1; c < 3; c++) sum -= m[i][c] * x[c];
    x[i] = sum / m[i][i];
  }
  return x;
}

/**
 * Shoot the periodic orbit through the rotating-frame position (xi, eta): from a guess velocity and the period found by a
 * trial integration, Gauss-Newton on (u, v, T) until the rotating-frame state returns. Returns the solution and the final
 * integrated history (2400 records of one period), or the guess if the shooting does not converge.
 */
export function solveLibration(binary: BinarySetup, xi: number, eta: number, guess: { u: number; v: number }, fallbackPeriodS: number, run: Runner): { solved: SolvedOrbit; history: History } {
  // 1. Period guess: a trial integration at 1 s steps (2400 s covers a tadpole and a horseshoe at the mass ratios used).
  const trial = run(orbitConfig(binary, { xi, eta, ...guess }, TRIAL_DT, TRIAL_SUBSTEPS), 0, STEPS);
  const found = returnTime(rotatingPath(binary, trial), TRIAL_DT);
  let period = found ?? fallbackPeriodS;
  let u = guess.u, v = guess.v;
  const evaluate = (uu: number, vv: number, T: number): { r: number[]; history: History } => {
    const dt = T / STEPS;
    const history = run(orbitConfig(binary, { xi, eta, u: uu, v: vv }, dt, substepsFor(dt)), 0, STEPS);
    const end = finalRotatingState(binary, history);
    return { r: [end.xi - xi, end.eta - eta, end.u - uu, end.v - vv], history };
  };
  const norm = (r: number[]): number => Math.hypot(...r);
  let current = evaluate(u, v, period);
  let iterations = 0;
  for (; iterations < 14 && norm(current.r) > 1e-5; iterations++) {
    const steps = [1e-6, 1e-6, 1e-5 * period];
    const columns: number[][] = [];
    for (let k = 0; k < 3; k++) {
      const q = [u, v, period];
      q[k] += steps[k];
      const e = evaluate(q[0], q[1], q[2]);
      columns.push(e.r.map((value, i) => (value - current.r[i]) / steps[k]));
    }
    const A = [0, 1, 2].map(i => [0, 1, 2].map(j => columns[i].reduce((s, value, k) => s + value * columns[j][k], 0)));
    const b = [0, 1, 2].map(i => -columns[i].reduce((s, value, k) => s + value * current.r[k], 0));
    const d = solve3(A, b);
    if (!d.every(Number.isFinite)) break;
    // Damped step: halve until the residual falls.
    let scale = 1, next = current;
    for (let tries = 0; tries < 6; tries++) {
      next = evaluate(u + scale * d[0], v + scale * d[1], period + scale * d[2]);
      if (norm(next.r) < norm(current.r)) break;
      scale /= 2;
    }
    if (!(norm(next.r) < norm(current.r))) break;
    u += scale * d[0]; v += scale * d[1]; period += scale * d[2];
    current = next;
  }
  const residual = norm(current.r);
  const converged = residual < 1e-5;
  const dt = period / STEPS;
  return { solved: { u, v, periodS: period, steps: STEPS, substeps: substepsFor(dt), residual, iterations, converged }, history: current.history };
}
