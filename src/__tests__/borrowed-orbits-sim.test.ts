import { describe, expect, it, vi } from 'vitest';
import {
  G, LIMITS, REASON_CODE, STATUS_CODE,
  type Attractor, type ForbiddenRegion, type OrbitSnapshot, type OrbitStudyConfig, type ParticleInit, type Vec2,
} from '../../sketches/borrowed-orbits/model.ts';
import {
  SnapshotMismatchError, accelerationAt, advance, configHashes, forceOn, history, initialSnapshot,
  parseSnapshot, serializeSnapshot, simulate, validateConfig,
} from '../../sketches/borrowed-orbits/sim.ts';

interface Opts {
  dt: number;
  boundary: 'open' | 'absorb';
  escapeMargin: number;
  attractors: Attractor[];
  forbidden: ForbiddenRegion[];
  particleMass: number;
  particles: ParticleInit[];
  scale: number;
}

function makeConfig(over: Partial<Opts> = {}): OrbitStudyConfig {
  const o: Opts = {
    dt: 0.1, boundary: 'open', escapeMargin: 1e9, attractors: [], forbidden: [], particleMass: 1, particles: [],
    scale: 3, ...over,
  };
  return {
    domain: { origin: { x: 0, y: 0 }, size: { x: 100, y: 100 } },
    transforms: { worldToPage: { scale: o.scale, offset: { x: 10, y: 20 } } },
    settings: { dt: o.dt, boundary: o.boundary, escapeMargin: o.escapeMargin },
    attractors: o.attractors,
    forbidden: o.forbidden,
    particleMass: o.particleMass,
    particles: o.particles,
  };
}

function att(
  id: string, x: number, y: number, mass: number,
  over: Partial<Pick<Attractor, 'softening' | 'captureRadius' | 'dynamic' | 'velocity'>> = {},
): Attractor {
  return {
    id, kind: 'attractor', mass, position: { x, y }, velocity: { x: 0, y: 0 },
    softening: 1e-3, captureRadius: 0, dynamic: false, hidden: true, ...over,
  };
}

const part = (x: number, y: number, vx: number, vy: number): ParticleInit => ({ position: { x, y }, velocity: { x: vx, y: vy } });

const rect = (id: string, x0: number, y0: number, x1: number, y1: number): ForbiddenRegion => ({
  id, kind: 'forbidden',
  polygon: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
});

/** Deterministic test-local generator (not part of the sim). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const range = (a: number, b: number, step = 1): number[] => {
  const out: number[] = [];
  for (let k = a; k <= b; k += step) out.push(k);
  return out;
};

// SOLID-GM constants used by the analytic fixtures below.
const M_BIG = 1e12; // kg, GM = 66.743 m³/s²
const GM = G * M_BIG;

/** Specific energy of one particle in the field of one pinned attractor at (cx, cy) with softening eps. */
function specificEnergy(s: OrbitSnapshot, i: number, cx: number, cy: number, M: number, eps: number): number {
  const dx = s.px[i] - cx;
  const dy = s.py[i] - cy;
  return 0.5 * (s.vx[i] ** 2 + s.vy[i] ** 2) - (G * M) / Math.sqrt(dx * dx + dy * dy + eps * eps);
}

describe('free flight without attractors', () => {
  it('moves every particle in an exact straight line', () => {
    const rnd = lcg(7);
    const particles = range(0, 19).map(() => part(rnd() * 100, rnd() * 100, rnd() * 4 - 2, rnd() * 4 - 2));
    const dt = 0.05;
    const config = makeConfig({ dt, particles });
    const steps = [0, 100, 777, 2400];
    const snaps = simulate(config, steps);
    let worst = 0;
    snaps.forEach((s) => {
      const t = s.step * dt;
      particles.forEach((p, i) => {
        const ex = p.position.x + p.velocity.x * t;
        const ey = p.position.y + p.velocity.y * t;
        worst = Math.max(worst, Math.abs(s.px[i] - ex) / Math.max(Math.abs(ex), 1), Math.abs(s.py[i] - ey) / Math.max(Math.abs(ey), 1));
        expect(s.vx[i]).toBe(p.velocity.x);
        expect(s.vy[i]).toBe(p.velocity.y);
      });
    });
    // 2400 additions each carry <= 1/2 ulp (1.1e-16 relative): the bound is 2400 · 1.1e-16 ≈ 2.7e-13, inside 1e-12.
    expect(worst).toBeLessThan(1e-12);
  });
});

describe('force and acceleration', () => {
  it('moves a particle by ½·a·dt² and Δv ≈ a·dt after one step, never a velocity field', () => {
    const base = { attractors: [att('mass-0', 50, 50, M_BIG, { softening: 1e-6 })], particles: [part(60, 50, 0, 0)] };
    const r = 10;
    const a0 = GM / (r * r);
    const oneStep = (dt: number): OrbitSnapshot => simulate(makeConfig({ ...base, dt }), [1])[0];
    const s = oneStep(0.1);
    const disp = 60 - s.px[0];
    const expected = 0.5 * a0 * 0.1 ** 2;
    expect(Math.abs(disp - expected) / expected).toBeLessThan(1e-9); // x1 = x0 + (a0·dt/2)·dt exactly
    expect(s.py[0]).toBe(50);
    // Δv = ½·dt·(a(x0) + a(x1)); a(x1) differs from a0 by 2·disp/r ≈ 6.7e-4 relative, so Δv/(a0·dt) − 1 ≈ 3.3e-4.
    const dv = -s.vx[0];
    expect(Math.abs(dv / (a0 * 0.1) - 1)).toBeLessThan(1e-3);
    expect(dv).toBeGreaterThan(0); // toward the mass
    // Halving dt quarters the displacement (a velocity-field misuse would only halve it) and halves Δv.
    const h = oneStep(0.05);
    expect(disp / (60 - h.px[0])).toBeCloseTo(4, 9);
    expect(Math.abs(dv / -h.vx[0] - 2)).toBeLessThan(1e-3);
  });

  it('computes force as mass × acceleration and is independent of the particle mass', () => {
    const attractors = [att('mass-0', 50, 50, M_BIG, { softening: 0.5 }), att('mass-1', 20, 70, 3e11, { softening: 2 })];
    const config = makeConfig({ attractors, particleMass: 4, particles: [part(60, 40, 0.3, -0.2)] });
    const pos: Vec2[] = attractors.map((a) => a.position);
    const p = { x: 60, y: 40 };
    const acc = accelerationAt(config, pos, p);
    const f = forceOn(config, pos, p, 4);
    expect(f.x).toBe(acc.x * 4);
    expect(f.y).toBe(acc.y * 4);
    // Independent evaluation of the documented formula.
    let fx = 0;
    let fy = 0;
    for (const a of attractors) {
      const dx = a.position.x - p.x;
      const dy = a.position.y - p.y;
      const k = (G * a.mass * 4) / (dx * dx + dy * dy + a.softening ** 2) ** 1.5;
      fx += k * dx;
      fy += k * dy;
    }
    expect(Math.abs(f.x - fx) / Math.abs(fx)).toBeLessThan(1e-14);
    expect(Math.abs(f.y - fy) / Math.abs(fy)).toBeLessThan(1e-14);
    const f2 = forceOn(config, pos, p, 8);
    expect(f2.x).toBe(2 * f.x);
    expect(f2.y).toBe(2 * f.y);

    // Doubling the particle mass doubles the force and leaves the trajectory bitwise identical.
    const light = makeConfig({ attractors, particleMass: 2, particles: [part(60, 40, 0.3, -0.2)], dt: 0.05 });
    const heavy = makeConfig({ attractors, particleMass: 4, particles: [part(60, 40, 0.3, -0.2)], dt: 0.05 });
    const a = simulate(light, [400])[0];
    const b = simulate(heavy, [400])[0];
    expect(b.px).toEqual(a.px);
    expect(b.py).toEqual(a.py);
    expect(b.vx).toEqual(a.vx);
    expect(b.vy).toEqual(a.vy);
    expect(forceOn(heavy, pos, p, heavy.particleMass).x).toBe(2 * forceOn(light, pos, p, light.particleMass).x);
  });

  it('follows x0 + v0·t + ½·a·t² in a nearly uniform field', () => {
    // Attractor 1e5 m away: the field varies by ~2·Δx/r ≈ 2e-5 relative over the 1 m run, leapfrog is exact for constant a.
    const attractors = [att('mass-0', 1e5, 0, 1e18, { softening: 1 })];
    const v0 = { x: 0.1, y: 0.05 };
    const dt = 0.1;
    const config = makeConfig({ dt, attractors, particles: [part(50, 50, v0.x, v0.y)] });
    const a = accelerationAt(config, [attractors[0].position], { x: 50, y: 50 });
    const s = simulate(config, [100])[0];
    const t = 100 * dt;
    const ex = 50 + v0.x * t + 0.5 * a.x * t * t;
    const ey = 50 + v0.y * t + 0.5 * a.y * t * t;
    const quad = 0.5 * Math.hypot(a.x, a.y) * t * t;
    expect(Math.abs(s.px[0] - ex)).toBeLessThan(1e-4 * quad);
    expect(Math.abs(s.py[0] - ey)).toBeLessThan(1e-4 * quad);
    expect(Math.abs(s.vx[0] - (v0.x + a.x * t))).toBeLessThan(1e-4 * Math.hypot(a.x, a.y) * t);
  });
});

describe('Kepler orbits around a pinned attractor', () => {
  const T = (a: number): number => 2 * Math.PI * Math.sqrt(a ** 3 / GM);

  it('closes a circular orbit after one period and conserves energy over ten without secular growth', () => {
    const r = 5;
    const eps = 1e-3;
    const period = T(r);
    const stepsPerPeriod = 240;
    const dt = period / stepsPerPeriod;
    const a = (GM * r) / (r * r + eps * eps) ** 1.5; // exact softened radial acceleration at r
    const vc = Math.sqrt(a * r);
    const config = makeConfig({
      dt, attractors: [att('mass-0', 50, 50, M_BIG, { softening: eps })], particles: [part(50 + r, 50, 0, vc)],
    });
    const sample = range(0, 2400, 4);
    const snaps = simulate(config, sample);
    const e0 = specificEnergy(snaps[0], 0, 50, 50, M_BIG, eps);
    const errAt = (s: OrbitSnapshot): number => Math.abs(specificEnergy(s, 0, 50, 50, M_BIG, eps) / e0 - 1);
    const during = (lo: number, hi: number): number => Math.max(...snaps.filter((s) => s.step >= lo * stepsPerPeriod && s.step <= hi * stepsPerPeriod).map(errAt));
    const early = during(0, 2);
    const late = during(8, 10);
    // Closing the orbit: the analytic period is 240 steps. Leapfrog is second order; measured, the phase lag per period
    // is Δφ = (2π/3)(2π/N)² (N steps per period), so the closure distance is r·Δφ ≈ 7.2e-3 m. Check that prediction
    // (±5%) and the second-order scaling (halving dt quarters it), not a loose "near the start".
    const back = snaps.find((s) => s.step === stepsPerPeriod) as OrbitSnapshot;
    const closure = Math.hypot(back.px[0] - (50 + r), back.py[0] - 50);
    const predicted = (r * (2 * Math.PI) / 3) * (2 * Math.PI / stepsPerPeriod) ** 2;
    expect(Math.abs(closure / predicted - 1)).toBeLessThan(0.05);
    const coarseSteps = stepsPerPeriod / 2;
    const coarse = simulate({ ...config, settings: { ...config.settings, dt: period / coarseSteps } }, [coarseSteps])[0];
    const coarseClosure = Math.hypot(coarse.px[0] - (50 + r), coarse.py[0] - 50);
    expect(coarseClosure / closure).toBeGreaterThan(3.8);
    expect(coarseClosure / closure).toBeLessThan(4.2);
    expect(Math.max(early, late)).toBeLessThan(1e-6); // measured 1.2e-7
    // Bounded and oscillating, not secular: the late-window maximum is no bigger than the early one (measured equal to 5 digits).
    expect(late).toBeLessThan(1.01 * early + 1e-12);
    // The reported budget agrees with an independent evaluation.
    expect(snaps[100].energy.particleSpecific).toBeCloseTo(specificEnergy(snaps[100], 0, 50, 50, M_BIG, eps), 9);
  });

  it('keeps energy bounded on an eccentric orbit and the period matches Kepler', () => {
    const aSemi = 5;
    const e = 0.6;
    const ra = aSemi * (1 + e); // 8
    const eps = 1e-3;
    const va = Math.sqrt(GM * (2 / ra - 1 / aSemi));
    const dt = 0.01;
    const config = makeConfig({
      dt, attractors: [att('mass-0', 50, 50, M_BIG, { softening: eps })], particles: [part(50 + ra, 50, 0, va)],
    });
    const h = history(config, 0, 2400);
    const rOf = (k: number): number => Math.hypot(h.xs[k][0] - 50, h.ys[k][0] - 50);
    // First apoapsis return after one period: local maximum of r(t) after the particle left the start.
    let k = 100;
    while (!(rOf(k) > rOf(k - 1) && rOf(k) >= rOf(k + 1))) k++;
    const y0 = rOf(k - 1);
    const y1 = rOf(k);
    const y2 = rOf(k + 1);
    const peak = k + (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2);
    const measured = peak * dt;
    const periodErr = Math.abs(measured / T(aSemi) - 1);
    expect(periodErr).toBeLessThan(1e-4); // measured ~5e-6 at dt = T/860
    // Energy over the whole 2400 steps (2.8 periods, passing a 2 m periapsis three times).
    const snaps = simulate(config, range(0, 2400, 6));
    const e0 = specificEnergy(snaps[0], 0, 50, 50, M_BIG, eps);
    const errs = snaps.map((s) => Math.abs(specificEnergy(s, 0, 50, 50, M_BIG, eps) / e0 - 1));
    const maxErr = Math.max(...errs);
    expect(maxErr).toBeLessThan(1e-3); // measured ~4e-4; periapsis speed 4× apoapsis, ωdt there ≈ 0.18 rad
    // Oscillating, not drifting: the error at the end of the run is no larger than the early peak error.
    const earlyMax = Math.max(...errs.slice(0, 160));
    expect(Math.max(...errs.slice(-160))).toBeLessThan(1.2 * earlyMax + 1e-9);
  });
});

describe('two dynamic attractors', () => {
  it('conserves momentum, moves the centre of mass uniformly and keeps the pair energy bounded', () => {
    const m1 = 2e12;
    const m2 = 1e12;
    const eps = 0.5;
    const mt = m1 + m2;
    const vrel = Math.sqrt((G * mt) / 20);
    const cm = { x: 0.1, y: 0.2 };
    const attractors = [
      att('mass-0', 40, 50, m1, { softening: eps, dynamic: true, velocity: { x: cm.x, y: cm.y - (m2 / mt) * vrel } }),
      att('mass-1', 60, 50, m2, { softening: eps, dynamic: true, velocity: { x: cm.x, y: cm.y + (m1 / mt) * vrel } }),
    ];
    const config = makeConfig({ dt: 0.05, attractors });
    const snaps = simulate(config, range(0, 2400, 8));
    const p0 = snaps[0].energy.attractorMomentum;
    expect(p0.x).toBeCloseTo(mt * cm.x, 3);
    const scale = m1 * Math.hypot(attractors[0].velocity.x, attractors[0].velocity.y) + m2 * Math.hypot(attractors[1].velocity.x, attractors[1].velocity.y);
    let worstP = 0;
    let worstCm = 0;
    let worstE = 0;
    const e0 = snaps[0].energy.attractorTotal;
    const cm0 = { x: (m1 * 40 + m2 * 60) / mt, y: 50 };
    for (const s of snaps) {
      const p = s.energy.attractorMomentum;
      worstP = Math.max(worstP, Math.hypot(p.x - p0.x, p.y - p0.y) / scale);
      const t = s.timeS;
      const cx = (m1 * s.attractors[0].position.x + m2 * s.attractors[1].position.x) / mt;
      const cy = (m1 * s.attractors[0].position.y + m2 * s.attractors[1].position.y) / mt;
      worstCm = Math.max(worstCm, Math.hypot(cx - (cm0.x + cm.x * t), cy - (cm0.y + cm.y * t)));
      worstE = Math.max(worstE, Math.abs(s.energy.attractorTotal / e0 - 1));
    }
    expect(worstP).toBeLessThan(1e-12);
    expect(worstCm).toBeLessThan(1e-9); // m of drift of the centre of mass over 120 s
    expect(worstE).toBeLessThan(1e-6); // measured ~6e-8
    // The pair really moved (so the checks are not vacuous).
    const last = snaps[snaps.length - 1];
    expect(Math.hypot(last.attractors[0].position.x - 40, last.attractors[0].position.y - 50)).toBeGreaterThan(5);
  });

  it('lets a dynamic attractor feel a pinned one and leaves the pinned one in place', () => {
    const attractors = [att('mass-0', 50, 50, M_BIG, { softening: 0.5 }), att('mass-1', 60, 50, 1e9, { softening: 0.5, dynamic: true })];
    const s = simulate(makeConfig({ dt: 0.05, attractors }), [200])[0];
    expect(s.attractors[0].position).toEqual({ x: 50, y: 50 });
    expect(s.attractors[0].velocity).toEqual({ x: 0, y: 0 });
    expect(s.attractors[1].position.x).toBeLessThan(60);
  });
});

describe('capture and no-leak matrix', () => {
  type Wall = { name: string; x0: number; x1: number; speed: number };
  const walls: Wall[] = [
    { name: 'interior', x0: 60, x1: 62, speed: 7 },
    { name: 'touching the domain edge', x0: 95, x1: 100, speed: 7.3 },
    { name: 'thinner than one step', x0: 60, x1: 60.01, speed: 50 },
  ];
  const dt = 0.2;
  // Attractors are 1 kg: their pull on the particle is ~1e-12 m/s², so the path is straight to ~1e-11 m.
  const pinned = (): Attractor[] => [att('mass-0', 40, 55, 1, { captureRadius: 0.5 })];
  const dynamicNearby = (): Attractor[] => [
    att('mass-0', 40, 55, 1, { captureRadius: 0.5 }),
    att('mass-1', 45, 45, 1, { captureRadius: 0.5, dynamic: true, velocity: { x: 1, y: 0.2 } }),
  ];
  const cases: { boundary: 'open' | 'absorb'; wall: Wall; label: string; attractors: () => Attractor[] }[] = [];
  for (const boundary of ['open', 'absorb'] as const) {
    for (const wall of walls) {
      cases.push({ boundary, wall, label: 'pinned', attractors: pinned });
      cases.push({ boundary, wall, label: 'dynamic', attractors: dynamicNearby });
    }
  }
  it.each(cases)('captures at the crossing and never leaks: $boundary, $wall.name, attractor $label', ({ boundary, wall, attractors }) => {
    const x0 = 20;
    const config = makeConfig({
      dt, boundary, escapeMargin: 50, attractors: attractors(), forbidden: [rect('forbidden-0', wall.x0, 40, wall.x1, 60)],
      particles: [part(x0, 50, wall.speed, 0)],
    });
    const h = history(config, 0, 150);
    const f = h.final;
    expect(f.status[0]).toBe(STATUS_CODE.captured);
    expect(f.reason[0]).toBe(REASON_CODE.forbidden);
    const err = Math.hypot(f.px[0] - wall.x0, f.py[0] - 50);
    expect(err).toBeLessThan(1e-9); // measured <= 2.7e-11 (the 1 kg attractors bend the path by ~1e-11 m)
    const tCross = (wall.x0 - x0) / wall.speed;
    expect(f.stoppedAt[0] * dt).toBeGreaterThanOrEqual(tCross - 1e-9);
    expect(f.stoppedAt[0] * dt).toBeLessThan(tCross + dt);
    for (let k = 0; k < h.xs.length; k++) {
      expect(h.xs[k][0]).toBeLessThanOrEqual(wall.x0 + 1e-9); // never on the far side
      if (k >= f.stoppedAt[0]) {
        expect(h.xs[k][0]).toBe(f.px[0]);
        expect(h.ys[k][0]).toBe(f.py[0]);
      }
    }
  });

  it('lets a particle graze parallel to a wall without capture', () => {
    const config = makeConfig({
      dt, forbidden: [rect('forbidden-0', 60, 40, 62, 60)],
      particles: [part(20, 60.0001, 7, 0), part(20, 39.9999, 7, 0), part(61, 70, 0, -3)],
    });
    const f = simulate(config, [100])[0];
    expect(f.status[0]).toBe(STATUS_CODE.free);
    expect(f.status[1]).toBe(STATUS_CODE.free);
    expect(f.px[0]).toBeGreaterThan(60);
    // Third particle drops straight onto the top face: captured there.
    expect(f.status[2]).toBe(STATUS_CODE.captured);
    expect(f.py[2]).toBeCloseTo(60, 9);
  });

  it('captures a particle that starts inside a polygon at step 0 where it stands', () => {
    const config = makeConfig({ forbidden: [rect('forbidden-0', 40, 40, 60, 60)], particles: [part(50, 50, 3, 3), part(10, 10, 0, 0)] });
    const s = initialSnapshot(config);
    expect(s.status).toEqual([STATUS_CODE.captured, STATUS_CODE.free]);
    expect(s.reason[0]).toBe(REASON_CODE.forbidden);
    expect(s.stoppedAt[0]).toBe(0);
    expect([s.px[0], s.py[0], s.vx[0], s.vy[0]]).toEqual([50, 50, 0, 0]);
  });
});

describe('edge modes', () => {
  const eps = 1e-3;
  const aSemi = 5;
  const va = Math.sqrt(GM * (2 / 8 - 1 / aSemi));
  const vp = 4 * va; // periapsis 2 m, apoapsis 8 m
  const orbit = (over: Partial<Opts>): OrbitStudyConfig => makeConfig({
    dt: 0.01, attractors: [att('mass-0', 95, 50, M_BIG, { softening: eps })], particles: [part(93, 50, 0, vp)], ...over,
  });

  it('absorb captures at the exact edge crossing', () => {
    const config = makeConfig({ dt: 0.2, boundary: 'absorb', particles: [part(80, 30, 9, 4), part(20, 50, -9, 0), part(50, 50, 0.5, -11)] });
    const s = simulate(config, [100])[0];
    expect(s.status).toEqual([1, 1, 1]);
    expect(s.reason).toEqual([REASON_CODE.edge, REASON_CODE.edge, REASON_CODE.edge]);
    expect(s.px[0]).toBe(100);
    expect(Math.abs(s.py[0] - (30 + (4 / 9) * 20))).toBeLessThan(1e-9);
    expect(s.px[1]).toBe(0);
    expect(s.py[1]).toBe(50);
    expect(s.py[2]).toBe(0);
    expect(Math.abs(s.px[2] - (50 + (0.5 / 11) * 50))).toBeLessThan(1e-9);
    expect(s.stoppedAt[0]).toBeGreaterThan(0);
  });

  it('absorb captures an orbit that reaches the edge, open lets it leave and return', () => {
    const absorb = simulate(orbit({ boundary: 'absorb' }), [2400])[0];
    expect(absorb.status[0]).toBe(STATUS_CODE.captured);
    expect(absorb.reason[0]).toBe(REASON_CODE.edge);
    expect(absorb.px[0]).toBe(100);

    const open = history(orbit({ boundary: 'open', escapeMargin: 5 }), 0, 2400);
    expect(open.final.status[0]).toBe(STATUS_CODE.free);
    const xs = Array.from(open.xs, (a) => a[0]);
    const kOut = xs.findIndex((x) => x > 100.5);
    expect(kOut).toBeGreaterThan(0);
    const kBack = xs.findIndex((x, k) => k > kOut && x < 100);
    expect(kBack).toBeGreaterThan(kOut); // left the frame and came back
    expect(Math.max(...xs)).toBeGreaterThan(102.5); // apoapsis reaches x = 103
  });

  it('open escapes only beyond escapeMargin and keeps that position', () => {
    const margin = 1;
    const h = history(orbit({ boundary: 'open', escapeMargin: margin }), 0, 2400);
    const f = h.final;
    expect(f.status[0]).toBe(STATUS_CODE.escaped);
    expect(f.reason[0]).toBe(REASON_CODE.none);
    const k = f.stoppedAt[0];
    // Escape happens where the drift crossed the threshold: on the margin line, not at the segment end.
    expect(Math.abs(f.px[0] - 100 - margin)).toBeLessThan(1e-9);
    expect(h.xs[k - 1][0] - 100).toBeLessThanOrEqual(margin); // and not before it
    expect(f.px[0]).toBe(h.xs[k][0]);
    expect(f.vx[0]).toBe(0);
    expect(f.vy[0]).toBe(0);
    expect(h.xs[2400][0]).toBe(f.px[0]);
  });
});

describe('attractor capture radius', () => {
  it('captures a radial infall at captureRadius from the attractor', () => {
    const R = 1;
    const config = makeConfig({
      dt: 0.05, attractors: [att('mass-0', 50, 50, M_BIG, { softening: 0.1, captureRadius: R })], particles: [part(60, 50, 0, 0)],
    });
    const s = simulate(config, [400])[0];
    expect(s.status[0]).toBe(STATUS_CODE.captured);
    expect(s.reason[0]).toBe(REASON_CODE.attractor);
    const d = Math.hypot(s.px[0] - 50, s.py[0] - 50);
    expect(Math.abs(d - R)).toBeLessThan(1e-9);
    expect(s.py[0]).toBe(50);
    expect([s.vx[0], s.vy[0]]).toEqual([0, 0]);
    // Time to fall from 10 m to 1 m is of order sqrt(2·9/a) with a ≈ 0.67..67: a few seconds, not zero.
    expect(s.stoppedAt[0]).toBeGreaterThan(5);
  });

  it('captures a fast fly-by that crosses the disc within one step', () => {
    const config = makeConfig({
      dt: 0.5, attractors: [att('mass-0', 50, 50, 1, { captureRadius: 0.5 })], particles: [part(40, 50.3, 20, 0), part(40, 51, 20, 0)],
    });
    const s = simulate(config, [3])[0];
    expect(s.status).toEqual([STATUS_CODE.captured, STATUS_CODE.free]);
    expect(Math.hypot(s.px[0] - 50, s.py[0] - 50)).toBeCloseTo(0.5, 9);
    expect(s.px[0]).toBeLessThan(50); // entry point, on the near side
  });

  it('breaks ties as forbidden, then attractor, then edge', () => {
    // Particle reaches the polygon face and the attractor disc at the same point x = 60.
    const config = makeConfig({
      dt: 1, boundary: 'absorb', attractors: [att('mass-0', 61, 50, 1, { captureRadius: 1 })],
      forbidden: [rect('forbidden-0', 60, 40, 70, 60)], particles: [part(50, 50, 20, 0)],
    });
    expect(simulate(config, [1])[0].reason[0]).toBe(REASON_CODE.forbidden);
  });
});

describe('determinism, snapshots and resume', () => {
  const rich = (): OrbitStudyConfig => {
    const rnd = lcg(42);
    const particles = range(0, 59).map(() => part(10 + rnd() * 80, 10 + rnd() * 80, rnd() * 2 - 1, rnd() * 2 - 1));
    return makeConfig({
      dt: 0.05, boundary: 'absorb',
      attractors: [
        att('mass-0', 40, 50, 2e12, { softening: 0.8, captureRadius: 0.4, dynamic: true, velocity: { x: 0, y: -0.9 } }),
        att('mass-1', 60, 50, 1e12, { softening: 0.8, captureRadius: 0.4, dynamic: true, velocity: { x: 0, y: 1.8 } }),
        att('mass-2', 50, 80, 5e11, { softening: 1.2, captureRadius: 0.4 }),
      ],
      forbidden: [rect('forbidden-0', 45, 20, 55, 24), rect('forbidden-1', 70, 60, 70.05, 90)],
      particles,
    });
  };

  it('reproduces the same stateHash on repeated runs', () => {
    const a = simulate(rich(), [0, 500, 2400]);
    const b = simulate(rich(), [2400, 500, 0, 500]);
    expect(b.map((s) => s.step)).toEqual([0, 500, 2400]);
    a.forEach((s, k) => expect(b[k].stateHash).toBe(s.stateHash));
    expect(a[0].stateHash).not.toBe(a[2].stateHash);
    expect(a[2].status.some((s) => s === STATUS_CODE.captured)).toBe(true); // the run exercises captures
  });

  it('resumes from a parsed snapshot bit for bit', () => {
    const config = rich();
    const direct = simulate(config, [1200])[0];
    const mid = simulate(config, [377])[0];
    const parsed = parseSnapshot(config, serializeSnapshot(mid));
    expect(parsed.stateHash).toBe(mid.stateHash);
    const resumed = advance(config, parsed, 1200 - 377);
    expect(resumed.stateHash).toBe(direct.stateHash);
    expect(resumed).toEqual(direct);
    // Chunked advance from the initial snapshot agrees too.
    let s = initialSnapshot(config);
    for (let k = 0; k < 4; k++) s = advance(config, s, 300);
    expect(s.stateHash).toBe(direct.stateHash);
  });

  it('rejects snapshots from another config or with tampered state', () => {
    const config = rich();
    const json = serializeSnapshot(simulate(config, [100])[0]);
    const other = rich();
    other.particles[3] = part(11, 11, 0, 0);
    expect(() => parseSnapshot(other, json)).toThrow(SnapshotMismatchError);
    const tampered = JSON.parse(json) as OrbitSnapshot;
    tampered.px[0] += 1e-9;
    expect(() => parseSnapshot(config, JSON.stringify(tampered))).toThrow(SnapshotMismatchError);
    expect(() => advance(other, parseSnapshot(config, json), 5)).toThrow(SnapshotMismatchError);
    expect(() => parseSnapshot(config, '[]')).toThrow(RangeError);
  });

  it('history agrees with simulate bit for bit', () => {
    const config = rich();
    const h = history(config, 100, 400);
    expect(h.fromStep).toBe(100);
    expect(h.toStep).toBe(400);
    expect(h.xs.length).toBe(301);
    expect(h.ax.length).toBe(301);
    const direct = simulate(config, [100, 250, 400]);
    expect(h.final.stateHash).toBe(direct[2].stateHash);
    direct.forEach((s) => {
      const k = s.step - 100;
      s.px.forEach((x, i) => {
        expect(h.xs[k][i] + 0).toBe(x);
        expect(h.ys[k][i] + 0).toBe(s.py[i]);
      });
      s.attractors.forEach((a, j) => {
        expect(h.ax[k][j] + 0).toBe(a.position.x);
        expect(h.ay[k][j] + 0).toBe(a.position.y);
      });
    });
    // A history from step 0 includes the initial positions.
    const h0 = history(config, 0, 3);
    expect(h0.xs.length).toBe(4);
    expect(Array.from(h0.xs[0])).toEqual(config.particles.map((p) => p.position.x));
  });
});

describe('hash scoping', () => {
  const base = (): OrbitStudyConfig => makeConfig({
    attractors: [att('mass-0', 50, 50, M_BIG)], forbidden: [rect('forbidden-0', 10, 10, 20, 20)], particles: [part(30, 30, 1, 0)],
  });

  it('forbidden geometry changes the geometry hash only', () => {
    const a = configHashes(base());
    const c = base();
    c.forbidden = [rect('forbidden-0', 10, 10, 21, 20)];
    const b = configHashes(c);
    expect(b.geometry).not.toBe(a.geometry);
    expect(b.simulation).toBe(a.simulation);
    expect(b.transform).toBe(a.transform);
    expect(b.stateKey).not.toBe(a.stateKey);
  });

  it('particle initial state changes the simulation hash only', () => {
    const a = configHashes(base());
    const c = base();
    c.particles = [part(30, 30, 1, 1e-9)];
    const b = configHashes(c);
    expect(b.simulation).not.toBe(a.simulation);
    expect(b.geometry).toBe(a.geometry);
    expect(b.transform).toBe(a.transform);
    expect(b.stateKey).not.toBe(a.stateKey);
  });

  it('worldToPage changes the transform hash (and stateKey) only', () => {
    const a = configHashes(base());
    const b = configHashes({ ...base(), transforms: { worldToPage: { scale: 3.5, offset: { x: 10, y: 20 } } } });
    expect(b.transform).not.toBe(a.transform);
    expect(b.geometry).toBe(a.geometry);
    expect(b.simulation).toBe(a.simulation);
    expect(b.stateKey).not.toBe(a.stateKey);
  });

  it('the hidden flag never touches the simulation hash, but physics does', () => {
    const a = configHashes(base());
    const c = base();
    c.attractors[0].hidden = false;
    expect(configHashes(c).simulation).toBe(a.simulation);
    c.attractors[0].mass *= 1.5;
    expect(configHashes(c).simulation).not.toBe(a.simulation);
  });
});

describe('every config field reaches the right hash', () => {
  const base = (): OrbitStudyConfig => makeConfig({
    attractors: [
      att('mass-0', 50, 50, M_BIG, { softening: 0.5, captureRadius: 0.2 }),
      att('mass-1', 30, 50, 1e11, { softening: 0.3, dynamic: true, velocity: { x: 0, y: 1 } }),
    ],
    forbidden: [rect('forbidden-0', 10, 10, 20, 20)],
    particles: [part(30, 30, 1, 0)],
  });
  type Which = 'geometry' | 'transform' | 'simulation';
  const cases: [string, Which, (c: OrbitStudyConfig) => void][] = [
    ['domain.origin.x', 'geometry', (c) => { c.domain.origin.x = 1; }],
    ['domain.size.y', 'geometry', (c) => { c.domain.size.y = 120; }],
    ['forbidden polygon vertex', 'geometry', (c) => { c.forbidden[0].polygon[1].y = 11; }],
    ['forbidden id', 'geometry', (c) => { c.forbidden[0].id = 'forbidden-9'; }],
    ['worldToPage.scale', 'transform', (c) => { c.transforms.worldToPage.scale = 4; }],
    ['worldToPage.offset.y', 'transform', (c) => { c.transforms.worldToPage.offset.y = 21; }],
    ['settings.dt', 'simulation', (c) => { c.settings.dt = 0.05; }],
    ['settings.boundary', 'simulation', (c) => { c.settings.boundary = 'absorb'; }],
    ['settings.escapeMargin', 'simulation', (c) => { c.settings.escapeMargin = 7; }],
    ['particleMass', 'simulation', (c) => { c.particleMass = 2; }],
    ['particles[0].position', 'simulation', (c) => { c.particles[0].position.y = 31; }],
    ['particles[0].velocity', 'simulation', (c) => { c.particles[0].velocity.x = 1.5; }],
    ['particle added', 'simulation', (c) => { c.particles.push(part(1, 1, 0, 0)); }],
    ['attractor id', 'simulation', (c) => { c.attractors[0].id = 'mass-9'; }],
    ['attractor mass', 'simulation', (c) => { c.attractors[0].mass *= 2; }],
    ['attractor position', 'simulation', (c) => { c.attractors[0].position.x = 51; }],
    ['attractor velocity (dynamic)', 'simulation', (c) => { c.attractors[1].velocity.y = 2; }],
    ['attractor softening', 'simulation', (c) => { c.attractors[0].softening = 0.6; }],
    ['attractor captureRadius', 'simulation', (c) => { c.attractors[0].captureRadius = 0.3; }],
    ['attractor dynamic flag', 'simulation', (c) => { c.attractors[0].dynamic = true; }],
    ['attractor removed', 'simulation', (c) => { c.attractors.pop(); }],
  ];
  it.each(cases)('%s changes only the %s hash (and stateKey)', (_name, which, mutate) => {
    const a = configHashes(base());
    const c = base();
    mutate(c);
    const b = configHashes(c);
    for (const key of ['geometry', 'transform', 'simulation'] as const) {
      if (key === which) expect(b[key]).not.toBe(a[key]);
      else expect(b[key]).toBe(a[key]);
    }
    expect(b.stateKey).not.toBe(a.stateKey);
  });
});

describe('limits and validation', () => {
  const ok = (): OrbitStudyConfig => makeConfig({ attractors: [att('mass-0', 50, 50, M_BIG)], particles: [part(60, 50, 0, 1)] });
  const mutate = (fn: (c: OrbitStudyConfig) => void): OrbitStudyConfig => {
    const c = ok();
    fn(c);
    return c;
  };

  it('rejects every LIMITS violation with RangeError', () => {
    expect(() => simulate(ok(), [LIMITS.maxSteps + 1])).toThrow(RangeError);
    expect(() => history(ok(), 0, LIMITS.maxSteps + 1)).toThrow(RangeError);
    expect(() => advance(ok(), initialSnapshot(ok()), LIMITS.maxSteps + 1)).toThrow(RangeError);
    expect(() => advance(ok(), simulate(ok(), [2000])[0], 401)).toThrow(RangeError);
    expect(() => validateConfig(makeConfig({ particles: range(0, LIMITS.maxParticles).map(() => part(1, 1, 0, 0)) }))).toThrow(RangeError);
    expect(() => validateConfig(makeConfig({ attractors: range(0, LIMITS.maxAttractors).map((k) => att(`mass-${k}`, 1, 1, 1)) }))).toThrow(RangeError);
    expect(() => validateConfig(makeConfig({ forbidden: range(0, LIMITS.maxForbidden).map((k) => rect(`forbidden-${k}`, 0, 0, 1, 1)) }))).toThrow(RangeError);
    // Exactly at the limits is allowed.
    expect(() => validateConfig(makeConfig({
      particles: range(1, LIMITS.maxParticles).map(() => part(1, 1, 0, 0)),
      attractors: range(1, LIMITS.maxAttractors).map((k) => att(`mass-${k}`, 1, 1, 1)),
      forbidden: range(1, LIMITS.maxForbidden).map((k) => rect(`forbidden-${k}`, 0, 0, 1, 1)),
    }))).not.toThrow();
    expect(() => simulate(ok(), [LIMITS.maxSteps])).not.toThrow();
  });

  it('rejects work above maxWork at the declared maxima, with no mocking', () => {
    // 1000 particles × 4096 edges × 2400 steps ≈ 9.8e9 edge tests > maxWork (1.5e9).
    const edgeHeavy = makeConfig({
      forbidden: range(0, 63).map((k) => ({
        id: `forbidden-${k}`, kind: 'forbidden' as const,
        polygon: range(0, 63).map((v) => ({ x: 10 + 0.01 * v, y: 10 + 0.01 * k + 0.0001 * v })),
      })),
      particles: range(0, 999).map(() => part(50, 50, 0, 0)),
    });
    expect(() => validateConfig(edgeHeavy)).not.toThrow(); // exactly 64 × 64 = 4096 edges is allowed
    expect(() => simulate(edgeHeavy, [LIMITS.maxSteps])).toThrow(/force evaluations and edge tests/);
    expect(() => history(edgeHeavy, LIMITS.maxSteps, LIMITS.maxSteps)).toThrow(RangeError);
    // The declared maxima as a whole (4000 particles, 16 attractors, 4096 edges).
    const maxima = { ...edgeHeavy, attractors: range(0, LIMITS.maxAttractors - 1).map((k) => att(`mass-${k}`, 1, 1, 1)), particles: range(0, LIMITS.maxParticles - 1).map(() => part(50, 50, 0, 0)) };
    expect(() => validateConfig(maxima)).not.toThrow();
    expect(() => simulate(maxima, [LIMITS.maxSteps])).toThrow(/force evaluations and edge tests/);
    // Edges are part of the formula: particles and attractors alone at their maxima are within the bound.
    expect(LIMITS.maxSteps * (LIMITS.maxParticles * LIMITS.maxAttractors + LIMITS.maxAttractors ** 2)).toBeLessThan(LIMITS.maxWork);
    expect(LIMITS.maxSteps * (1000 * 4096)).toBeGreaterThan(LIMITS.maxWork);
    // Realistic sketch ceiling: 2700 particles, 2 attractors, ~160 edges, 2400 steps stays under the bound.
    expect(LIMITS.maxSteps * (2700 * 2 + 4 + 2700 * 160)).toBeLessThan(LIMITS.maxWork);
  });

  it('caps the total number of forbidden edges', () => {
    const quads = (n: number): OrbitStudyConfig => makeConfig({
      forbidden: range(1, n).map((k) => ({
        id: `forbidden-${k}`, kind: 'forbidden' as const,
        polygon: range(0, 63).map((v) => ({ x: v, y: k + 0.001 * v })),
      })),
    });
    expect(() => validateConfig(quads(64))).not.toThrow();
    // One more vertex than the cap, inside the 64-region limit.
    const over = quads(64);
    over.forbidden[0].polygon.push({ x: 0, y: 99 });
    expect(() => validateConfig(over)).toThrow(/forbidden edges/);
  });

  it('caps the history window memory (loaded against a smaller model limit)', async () => {
    // At the declared maxima a window is 2401 × 4016 × 16 B ≈ 154 MB, below maxHistoryBytes (256 MB), so the cap
    // is a backstop: check the arithmetic here and exercise the throw against a tightened model.
    expect((LIMITS.maxSteps + 1) * (LIMITS.maxParticles + LIMITS.maxAttractors) * 16).toBeLessThan(LIMITS.maxHistoryBytes);
    vi.resetModules();
    vi.doMock('../../sketches/borrowed-orbits/model.ts', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../sketches/borrowed-orbits/model.ts')>();
      return { ...real, LIMITS: Object.freeze({ ...real.LIMITS, maxHistoryBytes: 1000 }) };
    });
    try {
      const tight = await import('../../sketches/borrowed-orbits/sim.ts');
      const config = makeConfig({ attractors: [att('mass-0', 50, 50, M_BIG)], particles: range(0, 9).map(() => part(60, 50, 0, 1)) });
      // 11 bodies × 16 B = 176 B per step: 5 steps (6 records) = 1056 B > 1000, 4 steps (5 records) = 880 B.
      expect(() => tight.history(config, 0, 5)).toThrow(/bytes/);
      expect(tight.history(config, 0, 4).xs.length).toBe(5);
      expect(() => tight.history(config, 1, 6)).toThrow(RangeError);
    } finally {
      vi.doUnmock('../../sketches/borrowed-orbits/model.ts');
      vi.resetModules();
    }
  });

  it('rejects invalid physical parameters with RangeError', () => {
    const bad: [string, (c: OrbitStudyConfig) => void][] = [
      ['dt = 0', (c) => { c.settings.dt = 0; }],
      ['dt < 0', (c) => { c.settings.dt = -0.1; }],
      ['escapeMargin < 0', (c) => { c.settings.escapeMargin = -1; }],
      ['bad boundary', (c) => { (c.settings as { boundary: string }).boundary = 'wrap'; }],
      ['particleMass 0', (c) => { c.particleMass = 0; }],
      ['attractor mass 0', (c) => { c.attractors[0].mass = 0; }],
      ['attractor mass NaN', (c) => { c.attractors[0].mass = Number.NaN; }],
      ['attractor mass Infinity', (c) => { c.attractors[0].mass = Infinity; }],
      ['softening 0', (c) => { c.attractors[0].softening = 0; }],
      ['captureRadius < 0', (c) => { c.attractors[0].captureRadius = -0.1; }],
      ['pinned with velocity', (c) => { c.attractors[0].velocity = { x: 0, y: 1e-9 }; }],
      ['polygon of 2 vertices', (c) => { c.forbidden = [{ id: 'forbidden-0', kind: 'forbidden', polygon: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]; }],
      ['polygon NaN vertex', (c) => { c.forbidden = [rect('forbidden-0', 0, 0, 1, 1)]; c.forbidden[0].polygon[2] = { x: Number.NaN, y: 0 }; }],
      ['particle NaN position', (c) => { c.particles[0].position.x = Number.NaN; }],
      ['particle Infinity velocity', (c) => { c.particles[0].velocity.y = Infinity; }],
      ['domain size 0', (c) => { c.domain.size.x = 0; }],
      ['worldToPage scale 0', (c) => { c.transforms.worldToPage.scale = 0; }],
    ];
    for (const [name, fn] of bad) {
      expect(() => validateConfig(mutate(fn)), name).toThrow(RangeError);
      expect(() => simulate(mutate(fn), [1]), name).toThrow(RangeError);
    }
    // A dynamic attractor may carry velocity.
    expect(() => validateConfig(mutate((c) => { c.attractors[0].dynamic = true; c.attractors[0].velocity = { x: 1, y: 0 }; }))).not.toThrow();
  });

  it('rejects bad step arguments', () => {
    expect(() => simulate(ok(), [-1])).toThrow(RangeError);
    expect(() => simulate(ok(), [1.5])).toThrow(RangeError);
    expect(() => history(ok(), 5, 4)).toThrow(RangeError);
    expect(() => advance(ok(), initialSnapshot(ok()), -1)).toThrow(RangeError);
  });
});

describe('moving attractors are swept, not sampled', () => {
  // The perturber has negligible mass (1e-20 kg), so particles feel nothing and it flies straight at its set speed.
  const mover = (x: number, y: number, vx: number, R: number): Attractor => att('mass-0', x, y, 1e-20, {
    dynamic: true, velocity: { x: vx, y: 0 }, captureRadius: R,
  });

  it('captures a stationary particle that an attractor sweeps across within one step', () => {
    // dt = 1: the attractor goes (40,50) → (60,50), R = 1, the particle sits at (45,50). A disc fixed at the
    // midpoint (50,50) misses it by 5 m; the relative segment enters the disc at t = 0.2.
    const config = makeConfig({ dt: 1, attractors: [mover(40, 50, 20, 1)], particles: [part(45, 50, 0, 0), part(45, 51.5, 0, 0)] });
    const s = simulate(config, [1])[0];
    expect(s.attractors[0].position.x).toBe(60);
    expect(s.status).toEqual([STATUS_CODE.captured, STATUS_CODE.free]); // the second passes 1.5 m away
    expect(s.reason[0]).toBe(REASON_CODE.attractor);
    expect(s.stoppedAt[0]).toBe(1);
    expect([s.px[0], s.py[0]]).toEqual([45, 50]);
  });

  it('captures a particle crossed by a fast perturber (speed 8, captureRadius 0.3, 0.8 m per step)', () => {
    // Step midpoints sit at 40.4 + 0.8k, which are 0.4 m from a particle at 49.6, so midpoint discs of radius 0.3
    // never touch it. The swept disc enters at x = 49.3 during step 11 (t = 0.625).
    const config = makeConfig({
      dt: 0.1, attractors: [mover(40, 50, 8, 0.3)], particles: [part(49.6, 50, 0, 0), part(49.6, 50.5, 0, 0)],
    });
    const h = history(config, 0, 40);
    const f = h.final;
    expect(f.status).toEqual([STATUS_CODE.captured, STATUS_CODE.free]);
    expect(f.stoppedAt[0]).toBe(12);
    expect([f.px[0], f.py[0]]).toEqual([49.6, 50]);
    expect(h.ax[12][0]).toBeCloseTo(49.6, 9);
  });
});

describe('closed boundaries', () => {
  const poly = rect('forbidden-0', 60, 40, 62, 60);

  it('captures a particle on any edge or corner of a forbidden polygon at step 0', () => {
    const onBoundary: [string, number, number][] = [
      ['left edge', 60, 50], ['right edge', 62, 50], ['top edge', 61, 40], ['bottom edge', 61, 60],
      ['corner', 60, 40], ['far corner', 62, 60],
    ];
    const config = makeConfig({
      forbidden: [poly],
      particles: [...onBoundary.map(([, x, y]) => part(x, y, 0, 0)), part(61, 50, 0, 0), part(59.9999, 50, 0, 0), part(61, 60.0001, 0, 0)],
    });
    const s = initialSnapshot(config);
    onBoundary.forEach(([name], i) => {
      expect(s.status[i], name).toBe(STATUS_CODE.captured);
      expect(s.reason[i], name).toBe(REASON_CODE.forbidden);
      expect(s.stoppedAt[i], name).toBe(0);
    });
    expect(s.status[6]).toBe(STATUS_CODE.captured); // interior
    expect(s.status[7]).toBe(STATUS_CODE.free); // 0.1 mm outside
    expect(s.status[8]).toBe(STATUS_CODE.free);
    // A slanted edge: the hypotenuse of a triangle is on the boundary too.
    const tri: ForbiddenRegion = { id: 'forbidden-1', kind: 'forbidden', polygon: [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 20, y: 30 }] };
    const t = initialSnapshot(makeConfig({ forbidden: [tri], particles: [part(25, 25, 0, 0), part(25.001, 25.001, 0, 0)] }));
    expect(t.status).toEqual([STATUS_CODE.captured, STATUS_CODE.free]);
  });

  it('treats a segment running along an edge line into a corner as a crossing', () => {
    const config = makeConfig({
      dt: 0.2, forbidden: [poly],
      particles: [part(50, 60, 7, 0), part(61, 70, 0, -7), part(50, 40, 7, 0), part(72, 40, -7, 0)],
    });
    const f = simulate(config, [100])[0];
    expect(f.status).toEqual([1, 1, 1, 1]);
    expect(Math.hypot(f.px[0] - 60, f.py[0] - 60)).toBeLessThan(1e-9); // along y = 60 into the corner (60, 60)
    expect(Math.abs(f.px[1] - 61)).toBeLessThan(1e-9); // straight down onto the bottom edge
    expect(Math.abs(f.py[1] - 60)).toBeLessThan(1e-9);
    expect(Math.hypot(f.px[2] - 60, f.py[2] - 40)).toBeLessThan(1e-9); // along y = 40 into (60, 40)
    expect(Math.hypot(f.px[3] - 62, f.py[3] - 40)).toBeLessThan(1e-9); // and from the other side into (62, 40)
  });

  it('treats the domain rectangle consistently on all four edges (on the edge is inside)', () => {
    const edges: [number, number, number, number][] = [ // x, y, outward vx, outward vy
      [0, 50, -1, 0], [100, 50, 1, 0], [50, 0, 0, -1], [50, 100, 0, 1],
    ];
    for (const [x, y, ox, oy] of edges) {
      const config = makeConfig({ dt: 0.1, boundary: 'absorb', particles: [part(x, y, 0, 0), part(x, y, -ox, -oy), part(x, y, ox, oy)] });
      expect(initialSnapshot(config).status).toEqual([0, 0, 0]); // a start on any edge is free
      const s = simulate(config, [1])[0];
      expect(s.status).toEqual([STATUS_CODE.free, STATUS_CODE.free, STATUS_CODE.captured]);
      expect(s.reason[2]).toBe(REASON_CODE.edge);
      expect([s.px[2], s.py[2]]).toEqual([x, y]);
      expect(s.stoppedAt[2]).toBe(1);
    }
    // Corners too, and a segment running along an edge stays free.
    const corner = makeConfig({ dt: 0.1, boundary: 'absorb', particles: [part(0, 0, 1, 0), part(100, 100, -1, 0), part(10, 0, 5, 0)] });
    expect(simulate(corner, [5])[0].status).toEqual([0, 0, 0]);
  });

  it('absorb lands on the boundary exactly for any approach angle', () => {
    const rnd = lcg(5);
    const particles = range(0, 299).map(() => {
      const a = rnd() * 2 * Math.PI;
      return part(30 + rnd() * 40, 30 + rnd() * 40, 40 * Math.cos(a), 40 * Math.sin(a));
    });
    const s = simulate(makeConfig({ dt: 0.37, boundary: 'absorb', particles }), [20])[0];
    expect(s.status.every((c) => c === STATUS_CODE.captured)).toBe(true);
    s.px.forEach((x, i) => {
      const y = s.py[i];
      expect(x >= 0 && x <= 100 && y >= 0 && y <= 100).toBe(true);
      expect(x === 0 || x === 100 || y === 0 || y === 100).toBe(true); // exactly on an edge, not an ulp off
    });
  });
});

describe('escape threshold in open mode', () => {
  const dist = (x: number, y: number): number => Math.hypot(Math.max(-x, 0, x - 100), Math.max(-y, 0, y - 100));

  it('escapes at the threshold crossing, on the rounded rectangle, including past a corner', () => {
    const rnd = lcg(11);
    const margin = 3;
    const particles = range(0, 119).map(() => {
      const a = rnd() * 2 * Math.PI;
      return part(2 + rnd() * 96, 2 + rnd() * 96, 60 * Math.cos(a), 60 * Math.sin(a)); // up to 30 m per step
    });
    const config = makeConfig({ dt: 0.5, escapeMargin: margin, particles: [...particles, part(90, 50, 100, 0), part(95, 95, 60, 60)] });
    const f = simulate(config, [10])[0];
    expect(f.status.every((c) => c === STATUS_CODE.escaped)).toBe(true);
    f.px.forEach((x, i) => expect(Math.abs(dist(x, f.py[i]) - margin), `particle ${i}`).toBeLessThan(1e-9));
    const n = particles.length;
    expect(Math.abs(f.px[n] - 103)).toBeLessThan(1e-9); // (90,50) → x = 100 + margin on a straight line
    expect(f.py[n]).toBe(50);
    expect(f.stoppedAt[n]).toBe(1);
    expect(f.stoppedAt.every((k) => k >= 1)).toBe(true);
  });

  it('lets a capture before the threshold win, and an escape before the capture win', () => {
    const wallIn = rect('forbidden-0', 102, 45, 104, 55); // inside the 5 m band
    const wallOut = rect('forbidden-1', 106, 45, 108, 55); // beyond it
    const run = (walls: ForbiddenRegion[]): OrbitSnapshot => simulate(makeConfig({
      dt: 0.2, escapeMargin: 5, forbidden: walls, particles: [part(90, 50, 100, 0)],
    }), [3])[0];
    const hit = run([wallIn]);
    expect(hit.status[0]).toBe(STATUS_CODE.captured);
    expect(hit.reason[0]).toBe(REASON_CODE.forbidden);
    expect(Math.abs(hit.px[0] - 102)).toBeLessThan(1e-9);
    const out = run([wallOut]);
    expect(out.status[0]).toBe(STATUS_CODE.escaped);
    expect(Math.abs(out.px[0] - 105)).toBeLessThan(1e-9);
    // Same instant: the wall face sits exactly on the threshold (x = 105): the capture wins the tie.
    const tie = run([rect('forbidden-2', 105, 45, 110, 55)]);
    expect(tie.status[0]).toBe(STATUS_CODE.captured);
    expect(tie.px[0]).toBeCloseTo(105, 9);
  });
});

describe('tie order and step-0 discs', () => {
  it('breaks forbidden/edge and attractor/edge ties toward the first', () => {
    // The particle reaches x = 100 (the domain edge) at t = 0.5 of the step, exactly where a wall face and a
    // capture disc both begin. Exact binary fractions keep the three parameters equal.
    const base = { dt: 1, boundary: 'absorb' as const, particles: [part(90, 50, 20, 0)] };
    const wall = simulate(makeConfig({ ...base, forbidden: [rect('forbidden-0', 100, 40, 110, 60)] }), [1])[0];
    expect(wall.reason[0]).toBe(REASON_CODE.forbidden);
    const disc = simulate(makeConfig({ ...base, attractors: [att('mass-0', 101, 50, 1e-20, { captureRadius: 1 })] }), [1])[0];
    expect(disc.reason[0]).toBe(REASON_CODE.attractor);
    expect(disc.px[0]).toBe(100);
    const edge = simulate(makeConfig(base), [1])[0];
    expect(edge.reason[0]).toBe(REASON_CODE.edge);
  });

  it('captures a particle that starts inside an attractor disc at step 0, not step 1', () => {
    const config = makeConfig({
      attractors: [att('mass-0', 50, 50, M_BIG, { captureRadius: 2 })], particles: [part(51, 50, 0.5, 0.5), part(53, 50, 0, 0)],
    });
    const s = initialSnapshot(config);
    expect(s.status).toEqual([STATUS_CODE.captured, STATUS_CODE.free]);
    expect(s.reason[0]).toBe(REASON_CODE.attractor);
    expect(s.stoppedAt[0]).toBe(0);
    expect([s.px[0], s.py[0], s.vx[0], s.vy[0]]).toEqual([51, 50, 0, 0]);
  });
});

describe('softening belongs to the source attractor', () => {
  it('uses the other attractor\'s ε for each dynamic attractor (exact one-step accelerations)', () => {
    const m0 = 1e12;
    const m1 = 2e12;
    const e0 = 1;
    const e1 = 5;
    const d = 4;
    const dt = 0.01;
    const config = makeConfig({
      dt, attractors: [
        att('mass-0', 40, 50, m0, { softening: e0, dynamic: true }),
        att('mass-1', 40 + d, 50, m1, { softening: e1, dynamic: true }),
      ],
    });
    const s = simulate(config, [1])[0];
    // From rest, one step moves each attractor by ½·a·dt² (first half kick, then drift).
    const a0 = (G * m1 * d) / (d * d + e1 * e1) ** 1.5; // on mass-0, from mass-1: ε of mass-1
    const a1 = (G * m0 * d) / (d * d + e0 * e0) ** 1.5; // on mass-1, from mass-0: ε of mass-0
    expect(Math.abs((s.attractors[0].position.x - 40) / (0.5 * a0 * dt * dt) - 1)).toBeLessThan(1e-9);
    expect(Math.abs((44 - s.attractors[1].position.x) / (0.5 * a1 * dt * dt) - 1)).toBeLessThan(1e-9);
    // And the swapped (wrong) assignment is far from both.
    const w0 = (G * m1 * d) / (d * d + e0 * e0) ** 1.5;
    expect(Math.abs(w0 / a0 - 1)).toBeGreaterThan(0.5);
  });
});

describe('finiteness under close encounters', () => {
  it('stays finite for 2400 steps through softened close passes', () => {
    const rnd = lcg(99);
    const particles = range(0, 299).map(() => part(30 + rnd() * 40, 30 + rnd() * 40, rnd() * 4 - 2, rnd() * 4 - 2));
    const config = makeConfig({
      dt: 0.02,
      attractors: [
        att('mass-0', 45, 50, 2e12, { softening: 0.05, dynamic: true, velocity: { x: 0, y: -1 } }),
        att('mass-1', 55, 50, 2e12, { softening: 0.05, dynamic: true, velocity: { x: 0, y: 1 } }),
        att('mass-2', 50, 50, 1e12, { softening: 0.05 }),
      ],
      particles,
    });
    const h = history(config, 0, 2400);
    const finiteAll = (arrs: Float64Array[]): boolean => arrs.every((a) => a.every(Number.isFinite));
    expect(finiteAll(h.xs) && finiteAll(h.ys) && finiteAll(h.ax) && finiteAll(h.ay)).toBe(true);
    const f = h.final;
    for (const arr of [f.px, f.py, f.vx, f.vy]) expect(arr.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(f.energy.particleSpecific)).toBe(true);
    expect(Number.isFinite(f.energy.attractorTotal)).toBe(true);
    expect(f.status.every((s) => s === STATUS_CODE.free)).toBe(true);
  });
});
