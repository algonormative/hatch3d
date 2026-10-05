/**
 * Orbit Plates: simulation setup for the three plates (Hohmann transfer, restricted three-body Lagrange system,
 * periodic three-body choreographies). Everything that moves is integrated by sim.ts through the OrbitStudyConfig
 * contract (MODEL 1.2.0: `substeps`, `impulses`). Analytic geometry appears only as drawn-only references
 * (Lagrange points, zero-velocity curves), in lagrange.ts.
 *
 * SI scales (all plates use G = 6.6743e-11, y grows downward like page millimetres, the world domain is the
 * 48 m x 78 m of the first round and every system sits at its centre):
 *   hohmann    dt 1 s, central mass 1.0e9 kg pinned, outer orbit 16 m (period ~1556 s = steps), 8 substeps.
 *   lagrange   dt 1 s, separation a = 12 m, binary period 40 s (40 steps), total mass 6.39e11 kg, 24 substeps.
 *   threebody  length unit L0 = 4 m, mass unit m0 = 1e11 kg (each body), time unit tau0 = sqrt(L0^3 / (G m0)) = 3.097 s,
 *              so a catalog entry in G = m = 1 units maps by x -> L0 x, v -> (L0 / tau0) v, t -> tau0 t. One period
 *              is exactly 2400 steps (dt = T tau0 / 2400), 64 substeps.
 */
import type { Point, SketchContext } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, posterArtTransform } from '../phase-garden/poster.ts';
import { WORLD } from './layout.ts';
import { G, LIMITS } from './model.ts';
import type { Attractor, History, Impulse, OrbitStudyConfig, ParticleInit, Vec2 } from './model.ts';
import { lagrangePoints, librationMode } from './lagrange.ts';
import { orbitConfig, solveLibration } from './libration.ts';
import type { BinarySetup, SolvedOrbit } from './libration.ts';
import { circularSpeed, numeric } from './study.ts';

export const PLATES = ['hohmann', 'lagrange', 'threebody'] as const;
export type PlateId = (typeof PLATES)[number];
export type PosterFit = ReturnType<typeof posterArtTransform>;
export interface Rect { xMin: number; xMax: number; yMin: number; yMax: number }

/** Where every system sits in the world. */
export const CENTRE: Vec2 = Object.freeze({ x: WORLD.width / 2, y: WORLD.height / 2 });
/** The simulation records `transforms.worldToPage` as a nominal constant: each plate fits its own drawing to the poster, so the mapping is not part of the simulation identity. */
export const NOMINAL_WORLD_TO_PAGE = Object.freeze({ scale: 5, offset: Object.freeze({ x: 0, y: 0 }) });

// ------------------------------------------------------------------ catalog

export interface Choreography {
  id: string;
  label: string;
  /** Initial conditions in G = m = 1 units: positions, velocities (zero total momentum, barycentre at the origin). */
  positions: Vec2[];
  velocities: Vec2[];
  period: number;
  /**
   * Recorded segments: one period is drawn from `segments` consecutive runs of 2400 recorded steps (the simulation limit),
   * each resumed exactly from the previous one, so the drawn vertices are `segments` times closer in time. Chosen per entry
   * so that every vertex stays within 0.02 page mm of the chord of its neighbours at the close encounters.
   */
  segments: number;
  source: string;
}

const free = (p1: number, p2: number): { positions: Vec2[]; velocities: Vec2[] } => ({
  positions: [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }],
  velocities: [{ x: p1, y: p2 }, { x: p1, y: p2 }, { x: -2 * p1, y: -2 * p2 }],
});

/**
 * Catalog. Figure-eight: Chenciner & Montgomery (2000), initial conditions of Simo's numerical solution
 * (x1 = -x2 = (0.97000436, -0.24308753), x3 = 0, v3 = (-0.93240737, -0.86473146), v1 = v2 = -v3/2), T = 6.32591398.
 * Butterfly I and moth I: Suvakov & Dmitrasinovic, PRL 110, 114301 (2013), free-fall form x1 = (-1, 0), x2 = (1, 0),
 * x3 = 0, v1 = v2 = (p1, p2), v3 = -2 (p1, p2). The published five-digit values (butterfly I 0.30689, 0.12551,
 * T 6.2356; moth I 0.46444, 0.39606, T 14.8939) return with an error of 1.8e-3 and 3.6e-4 under an independent RK4
 * integration, so the values below are those published ones refined by Gauss-Newton shooting on (p1, p2, T)
 * (residual 2e-6, 1e-11 and 7e-8): the same orbits to 5-6 digits. The closure error measured in the sim is in the brief.
 */
export const CATALOG: Record<string, Choreography> = {
  'figure-eight': {
    id: 'figure-eight', label: 'Figure-eight', period: 6.32591398, segments: 1,
    positions: [{ x: 0.97000436, y: -0.24308753 }, { x: -0.97000436, y: 0.24308753 }, { x: 0, y: 0 }],
    velocities: [{ x: 0.466203685, y: 0.43236573 }, { x: 0.466203685, y: 0.43236573 }, { x: -0.93240737, y: -0.86473146 }],
    source: 'Chenciner and Montgomery 2000',
  },
  butterfly: { id: 'butterfly', label: 'Butterfly I', period: 6.234652214, segments: 16, ...free(0.306890725, 0.125507223), source: 'Suvakov and Dmitrasinovic 2013, refined' },
  'yin-yang': { id: 'yin-yang', label: 'Yin-yang Ia', period: 17.328833039, segments: 32, ...free(0.513938525, 0.30473592), source: 'Suvakov and Dmitrasinovic 2013, refined' },
  moth: { id: 'moth', label: 'Moth I', period: 14.894305175, segments: 4, ...free(0.464445173, 0.396060015), source: 'Suvakov and Dmitrasinovic 2013, refined' },
};

// ------------------------------------------------------------------ plans

export interface HohmannHop {
  fromOrbit: number;
  toOrbit: number;
  /** Particle indices. */
  transfer: number;
  sourcePlanet: number;
  targetPlanet: number;
  departStep: number;
  arriveStep: number;
  dv1: Vec2;
  dv2: Vec2;
  rFrom: number;
  rTo: number;
}
export interface HohmannPlan {
  centre: Vec2;
  radii: number[];
  /** Whole steps in one period of each circle (the radii are snapped to them). */
  periodSteps: number[];
  /** Particle index of each circular orbit. */
  orbitParticles: number[];
  hops: HohmannHop[];
}
/** A libration orbit to integrate: its start position in the rotating frame (normalized) and the velocity guess shooting starts from. */
export interface LagrangeOrbit {
  kind: 'tadpole' | 'horseshoe';
  near: 'L4' | 'L5' | 'L3';
  /** Radial offset of the start from the unit circle, units of a. */
  offset: number;
  xi: number;
  eta: number;
  guess: { u: number; v: number };
  /** Period to fall back on if the trial integration finds no return, s. */
  fallbackPeriodS: number;
}
export interface LagrangePlan {
  mu: number;
  /** Separation, m. */
  a: number;
  /** Binary angular velocity, rad/s. */
  omega: number;
  bary: Vec2;
  binary: BinarySetup;
  orbits: LagrangeOrbit[];
}
/** The integrated plate: one history per run (a Lagrange plate has one per orbit, each with its own step) and the solved libration orbits. */
export interface PlateRun { histories: History[]; solved: SolvedOrbit[] }
export interface ThreebodyPlan { entry: Choreography; length: number; time: number; /** Recorded steps in one period (segments x 2400). */ steps: number; segments: number }

export interface PlateMarks {
  rotation: number;
  autoOrient: boolean;
  margin: number;
  bodyRadius: number;
  crossSize: number;
  orbitPen: string;
  highlightPen: string;
  referencePen: string;
  // hohmann
  showTransfers: boolean;
  showPlanets: boolean;
  tickScale: number;
  // lagrange
  showPoints: boolean;
  zvcMode: 'off' | 'necks' | 'critical';
  zvcCount: number;
  orbitBoundaries: boolean;
  // threebody
  bodies: 'all' | 'first';
  bodyPhase: number;
}

export interface PlateStudy {
  plate: PlateId;
  config: OrbitStudyConfig;
  /** Recorded steps to integrate (history 0..steps). */
  steps: number;
  /** false: draw the analytic references only and never call the simulation. */
  integrate: boolean;
  marks: PlateMarks;
  fit: PosterFit;
  /** The poster content rectangle in art coordinates. */
  frame: Rect;
  hohmann?: HohmannPlan;
  lagrange?: LagrangePlan;
  threebody?: ThreebodyPlan;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;
const attractor = (id: string, mass: number, position: Vec2, velocity: Vec2, softening: number, dynamic: boolean): Attractor =>
  ({ id, kind: 'attractor', mass, position, velocity, softening, captureRadius: 0, dynamic, hidden: true });
const domain = { origin: { x: 0, y: 0 }, size: { x: WORLD.width, y: WORLD.height } } as const;
const baseConfig = (dt: number, substeps: number, attractors: Attractor[], particles: ParticleInit[], impulses: Impulse[]): OrbitStudyConfig => ({
  domain: { origin: { ...domain.origin }, size: { ...domain.size } },
  transforms: { worldToPage: { scale: NOMINAL_WORLD_TO_PAGE.scale, offset: { ...NOMINAL_WORLD_TO_PAGE.offset } } },
  // Open edges with a margin no plate reaches: nothing escapes, nothing is captured (capture radii are 0).
  settings: { dt, substeps, boundary: 'open', escapeMargin: 1000 },
  attractors, forbidden: [], particleMass: 1, particles,
  ...(impulses.length ? { impulses } : {}),
});

// ------------------------------------------------------------------ Hohmann

export const HOHMANN = Object.freeze({ dt: 1, centralMass: 1e9, outerRadius: 16, substeps: 8, softening: 1e-3 });

export function hohmannSetup(opts: { orbitCount: number; spacing: number; chain: boolean; hop: number; stagger: number; phase: number; departStep: number }): { config: OrbitStudyConfig; plan: HohmannPlan; steps: number } {
  const { dt, centralMass, outerRadius, substeps, softening } = HOHMANN;
  const gm = G * centralMass;
  const n = opts.orbitCount;
  const radii: number[] = [];
  const periodSteps: number[] = [];
  for (let k = 0; k < n; k++) {
    const raw = outerRadius * Math.pow(opts.spacing, k - (n - 1));
    // Snap to a whole number of steps per period, so each circle closes on itself by construction.
    const steps = Math.max(8, Math.round((2 * Math.PI * Math.sqrt(raw ** 3 / gm)) / dt));
    periodSteps.push(steps);
    radii.push(Math.cbrt(gm * ((steps * dt) / (2 * Math.PI)) ** 2));
  }
  const omega = periodSteps.map(s => (2 * Math.PI) / (s * dt));
  const at = (r: number, theta: number): Vec2 => ({ x: CENTRE.x + r * Math.cos(theta), y: CENTRE.y + r * Math.sin(theta) });
  const tangent = (theta: number): Vec2 => ({ x: -Math.sin(theta), y: Math.cos(theta) });
  const circular = (r: number, theta: number): ParticleInit => {
    const v = circularSpeed(centralMass, r, softening), t = tangent(theta);
    return { position: at(r, theta), velocity: { x: v * t.x, y: v * t.y } };
  };
  const phase0 = rad(opts.phase);
  const particles: ParticleInit[] = radii.map(r => circular(r, phase0));
  const orbitParticles = radii.map((_r, k) => k);
  const impulses: Impulse[] = [];
  const hops: HohmannHop[] = [];
  const list = opts.chain ? Array.from({ length: n - 1 }, (_v, k) => k) : [Math.min(n - 2, Math.max(0, opts.hop))];
  list.forEach((k, order) => {
    const r1 = radii[k], r2 = radii[k + 1];
    const theta = phase0 + rad(opts.stagger) * order;
    const d = opts.departStep;
    const a = (r1 + r2) / 2;
    const arrive = d + Math.max(1, Math.round((Math.PI * Math.sqrt(a ** 3 / gm)) / dt));
    const t1 = tangent(theta), t2 = tangent(theta + Math.PI);
    const vc1 = circularSpeed(centralMass, r1, softening), vc2 = circularSpeed(centralMass, r2, softening);
    // Vis-viva speeds on the transfer ellipse at its two apsides; the burns are the differences to the circular speeds.
    const dv1 = Math.sqrt(gm * (2 / r1 - 1 / a)) - vc1;
    const dv2 = vc2 - Math.sqrt(gm * (2 / r2 - 1 / a));
    const transfer = particles.length;
    particles.push(circular(r1, theta - omega[k] * d * dt));
    const sourcePlanet = particles.length;
    particles.push(circular(r1, theta - omega[k] * d * dt));
    const targetPlanet = particles.length;
    particles.push(circular(r2, theta + Math.PI - omega[k + 1] * arrive * dt));
    impulses.push({ particle: transfer, step: d, dv: { x: dv1 * t1.x, y: dv1 * t1.y } });
    impulses.push({ particle: transfer, step: arrive, dv: { x: dv2 * t2.x, y: dv2 * t2.y } });
    hops.push({
      fromOrbit: k, toOrbit: k + 1, transfer, sourcePlanet, targetPlanet, departStep: d, arriveStep: arrive,
      dv1: { x: dv1 * t1.x, y: dv1 * t1.y }, dv2: { x: dv2 * t2.x, y: dv2 * t2.y }, rFrom: r1, rTo: r2,
    });
  });
  const steps = Math.min(LIMITS.maxSteps, Math.max(periodSteps[n - 1], ...hops.map(h => h.arriveStep)));
  const config = baseConfig(dt, substeps, [attractor('mass-central', centralMass, { ...CENTRE }, { x: 0, y: 0 }, softening, false)], particles, impulses);
  return { config, plan: { centre: { ...CENTRE }, radii, periodSteps, orbitParticles, hops }, steps };
}

// ------------------------------------------------------------------ Lagrange

export const LAGRANGE = Object.freeze({ dt: 0.5, separation: 12, binaryPeriodSteps: 80, substeps: 16, softening: 1e-4 });

/** Total mass of the binary: Omega^2 a^3 / G with Omega = 2 pi / (80 dt) = 2 pi / 40 s. */
export const lagrangeTotalMass = (): number => {
  const omega = (2 * Math.PI) / (LAGRANGE.binaryPeriodSteps * LAGRANGE.dt);
  return (omega * omega * LAGRANGE.separation ** 3) / G;
};

/**
 * The libration orbits of a Lagrange plate. Each starts on the circle of radius 1 + offset about the barycentre, at the angle
 * of L4 or L5 (tadpoles; offsets `amplitude`, 2 `amplitude`, ... nested on both sides) or opposite the secondary (the horseshoe),
 * with the circular Keplerian velocity about the barycentre as the guess. `runPlate` then shoots the exactly periodic orbit
 * through each start (libration.ts), so each closes and carries no epicycle. The simulation configuration returned here
 * (the binary and the guess particles at the nominal step) only identifies the plate: its stateKey depends on the sim controls.
 */
export function lagrangeSetup(opts: { mu: number; tadpoles: number; amplitude: number; horseshoe: boolean; horseshoeOffset: number }): { config: OrbitStudyConfig; plan: LagrangePlan; steps: number } {
  const { dt, separation: a, binaryPeriodSteps, substeps, softening } = LAGRANGE;
  const mu = opts.mu;
  const omega = (2 * Math.PI) / (binaryPeriodSteps * dt);
  const total = lagrangeTotalMass();
  const bary = { ...CENTRE };
  const attractors = [
    attractor('mass-primary', (1 - mu) * total, { x: bary.x - mu * a, y: bary.y }, { x: 0, y: -mu * a * omega }, softening, true),
    attractor('mass-secondary', mu * total, { x: bary.x + (1 - mu) * a, y: bary.y }, { x: 0, y: (1 - mu) * a * omega }, softening, true),
  ];
  const points = lagrangePoints(mu);
  const phi4 = Math.atan2(points.L4.y, points.L4.x);
  const orbits: LagrangeOrbit[] = [];
  const add = (kind: LagrangeOrbit['kind'], near: LagrangeOrbit['near'], offset: number, phi: number, fallbackPeriodS: number): void => {
    const r = 1 + offset;
    const xi = r * Math.cos(phi), eta = r * Math.sin(phi);
    // Circular Kepler orbit about the barycentre (total mass 1, unit radius): inertial speed r^-1/2, counter-clockwise; rotating velocity subtracts the frame's rotation.
    const speed = Math.sqrt(1 / r);
    const u = (-speed * eta) / r + eta, v = (speed * xi) / r - xi;
    orbits.push({ kind, near, offset, xi, eta, guess: { u, v }, fallbackPeriodS });
  };
  const tadpolePeriod = (2 * Math.PI) / librationMode(mu, 1).omega / omega;
  for (let k = 0; k < opts.tadpoles; k++) {
    add('tadpole', 'L4', opts.amplitude * (k + 1), phi4, tadpolePeriod);
    add('tadpole', 'L5', opts.amplitude * (k + 1), -phi4, tadpolePeriod);
  }
  if (opts.horseshoe) add('horseshoe', 'L3', opts.horseshoeOffset, Math.PI, 30 * (2 * Math.PI) / omega);
  const binary: BinarySetup = { mu, a, omega, bary, attractors };
  // Identity configuration: the binary and every guess start at the nominal step.
  const particles = orbits.map(o => orbitConfig(binary, { xi: o.xi, eta: o.eta, u: o.guess.u, v: o.guess.v }, dt, substeps).particles[0]);
  return { config: baseConfig(dt, substeps, attractors, particles, []), plan: { mu, a, omega, bary, binary, orbits }, steps: LIMITS.maxSteps };
}

// ------------------------------------------------------------------ three-body

export const THREEBODY = Object.freeze({ length: 4, mass: 1e11, segmentSteps: 2400, substeps: 64, softening: 4e-6 });

export function threebodySetup(entryId: string): { config: OrbitStudyConfig; plan: ThreebodyPlan; steps: number } {
  const entry = CATALOG[entryId] ?? CATALOG['figure-eight'];
  const { length: L0, mass, segmentSteps, substeps, softening } = THREEBODY;
  const tau = Math.sqrt(L0 ** 3 / (G * mass));
  const v0 = L0 / tau;
  const attractors = entry.positions.map((p, i) => attractor(`mass-body${i + 1}`, mass, { x: CENTRE.x + L0 * p.x, y: CENTRE.y + L0 * p.y },
    { x: v0 * entry.velocities[i].x, y: v0 * entry.velocities[i].y }, softening, true));
  const steps = segmentSteps * entry.segments;
  const config = baseConfig((entry.period * tau) / steps, substeps, attractors, [], []);
  return { config, plan: { entry, length: L0, time: tau, steps, segments: entry.segments }, steps: segmentSteps };
}

// ------------------------------------------------------------------ build

const pick = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => options.find(o => o === value) ?? fallback;
const penId = (ctx: SketchContext, id: string, fallback: string): string => (typeof ctx.params[id] === 'string' ? (ctx.params[id] as string) : fallback);

export function buildPlate(ctx: SketchContext): PlateStudy {
  const fit = posterArtTransform(ctx, TABLOID_PAGE);
  const { target } = fit;
  const t0 = fit.inverse({ x: target.x, y: target.y }), t1 = fit.inverse({ x: target.x + target.width, y: target.y + target.height });
  const frame: Rect = { xMin: Math.min(t0.x, t1.x), xMax: Math.max(t0.x, t1.x), yMin: Math.min(t0.y, t1.y), yMax: Math.max(t0.y, t1.y) };
  const plate = pick(ctx.params.plate, PLATES, 'hohmann');
  const marks: PlateMarks = {
    rotation: numeric(ctx, 'rotation', 0, -180, 180),
    autoOrient: ctx.params.autoOrient !== false,
    margin: numeric(ctx, 'plateMargin', 0.08, 0.03, 0.3),
    bodyRadius: numeric(ctx, 'bodyRadius', 1.6, 0.4, 5),
    crossSize: numeric(ctx, 'crossSize', 2.4, 0.8, 8),
    orbitPen: penId(ctx, 'orbitPen', 'carbon'),
    highlightPen: penId(ctx, 'highlightPen', 'vermilion'),
    referencePen: penId(ctx, 'referencePen', 'cyan'),
    showTransfers: ctx.params.showTransfers !== false,
    showPlanets: ctx.params.showPlanets !== false,
    tickScale: numeric(ctx, 'tickScale', 1200, 100, 6000),
    showPoints: ctx.params.showPoints !== false,
    zvcMode: pick(ctx.params.zvcMode, ['off', 'necks', 'critical'] as const, 'necks'),
    zvcCount: Math.round(numeric(ctx, 'zvcCount', 2, 2, 4)),
    orbitBoundaries: ctx.params.orbitBoundaries === true,
    bodies: pick(ctx.params.bodies, ['all', 'first'] as const, 'all'),
    bodyPhase: numeric(ctx, 'bodyPhase', 0, 0, 1),
  };
  const integrate = ctx.params.orbitsEnabled !== false;
  const base = { plate, integrate, marks, fit, frame };
  if (plate === 'lagrange') {
    const s = lagrangeSetup({
      mu: numeric(ctx, 'massRatio', 0.001, 0.001, 0.038),
      tadpoles: Math.round(numeric(ctx, 'tadpoleCount', 3, 0, 3)),
      amplitude: numeric(ctx, 'tadpoleAmplitude', 0.013, 0.005, 0.015),
      horseshoe: ctx.params.horseshoe !== false,
      horseshoeOffset: numeric(ctx, 'horseshoeOffset', 0.03, 0.01, 0.04),
    });
    return { ...base, config: s.config, steps: s.steps, lagrange: s.plan };
  }
  if (plate === 'threebody') {
    const s = threebodySetup(typeof ctx.params.choreography === 'string' ? ctx.params.choreography : 'figure-eight');
    return { ...base, config: s.config, steps: s.plan.steps, threebody: s.plan };
  }
  const count = Math.round(numeric(ctx, 'orbitCount', 4, 2, 6));
  const s = hohmannSetup({
    orbitCount: count, spacing: numeric(ctx, 'spacing', 1.32, 1.15, 1.5), chain: ctx.params.transferMode !== 'single',
    hop: Math.round(numeric(ctx, 'transferIndex', 0, 0, 4)), stagger: numeric(ctx, 'stagger', 70, 0, 180),
    phase: numeric(ctx, 'hohmannPhase', 20, -180, 180), departStep: Math.round(numeric(ctx, 'departureStep', 0, 0, 600)),
  });
  return { ...base, config: s.config, steps: s.steps, hohmann: s.plan };
}

/**
 * Integrate a plate. Hohmann: one history. Three-body: one history, joined from consecutive runs when the period is longer than
 * one run's step limit (each run resumes from the exact final state of the previous one: the state is synchronized at a step
 * boundary, so the chain is the same computation as one long run; `final` carries the last snapshot with the hashes of the
 * first run, the identity of the whole integration). Lagrange: one history per libration orbit, each integrated for exactly one
 * period at its own step (libration.ts shoots the periodic orbit through the start), cached by its inputs.
 */
export function runPlate(study: PlateStudy, run: (config: OrbitStudyConfig, from: number, to: number) => History): PlateRun {
  if (study.lagrange) {
    const plan = study.lagrange;
    const histories: History[] = [];
    const solved: SolvedOrbit[] = [];
    for (const orbit of plan.orbits) {
      const key = JSON.stringify([plan.mu, plan.a, plan.omega, orbit.xi, orbit.eta, orbit.guess]);
      let hit = shot.get(key);
      if (!hit) { hit = solveLibration(plan.binary, orbit.xi, orbit.eta, orbit.guess, orbit.fallbackPeriodS, run); shot.set(key, hit); }
      histories.push(hit.history);
      solved.push(hit.solved);
    }
    return { histories, solved };
  }
  const segments = study.threebody?.segments ?? 1;
  if (segments === 1) return { histories: [run(study.config, 0, study.steps)], solved: [] };
  const per = study.steps / segments;
  const xs: Float64Array[] = [], ys: Float64Array[] = [], ax: Float64Array[] = [], ay: Float64Array[] = [];
  let config = study.config;
  let firstHashes: History['final']['hashes'] | null = null;
  let last: History | null = null;
  for (let k = 0; k < segments; k++) {
    const h = run(config, 0, per);
    firstHashes ??= h.final.hashes;
    // Drop the duplicated boundary record of every segment after the first.
    for (let i = k === 0 ? 0 : 1; i < h.xs.length; i++) { xs.push(h.xs[i]); ys.push(h.ys[i]); ax.push(h.ax[i]); ay.push(h.ay[i]); }
    last = h;
    config = { ...config, attractors: config.attractors.map((a, i) => ({ ...a, position: { ...h.final.attractors[i].position }, velocity: { ...h.final.attractors[i].velocity } })) };
  }
  return { histories: [{ fromStep: 0, toStep: study.steps, xs, ys, ax, ay, final: { ...last!.final, step: study.steps, hashes: firstHashes! } }], solved: [] };
}

const shot = new Map<string, ReturnType<typeof solveLibration>>();

/** Page-mm point to art coordinates, for the poster fit. */
export const pageToArt = (fit: PosterFit, p: Point): Point => fit.inverse(p);
