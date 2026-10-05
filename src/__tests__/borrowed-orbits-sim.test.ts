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
    expect(f.px[0] - 100).toBeGreaterThan(margin); // stopped beyond the margin
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

  it('rejects a call whose steps × (particles × attractors + attractors²) exceeds maxWork', async () => {
    // At the real LIMITS the product tops out at 2400 × (4000 × 16 + 16²) = 1.54e8 < 2e8, so the work bound is a
    // backstop; exercise it by loading the sim against a model with a tighter maxWork.
    expect(LIMITS.maxSteps * (LIMITS.maxParticles * LIMITS.maxAttractors + LIMITS.maxAttractors ** 2)).toBeLessThanOrEqual(LIMITS.maxWork);
    vi.resetModules();
    vi.doMock('../../sketches/borrowed-orbits/model.ts', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../sketches/borrowed-orbits/model.ts')>();
      return { ...real, LIMITS: Object.freeze({ ...real.LIMITS, maxWork: 1000 }) };
    });
    try {
      const tight = await import('../../sketches/borrowed-orbits/sim.ts');
      const config = makeConfig({
        attractors: [att('mass-0', 50, 50, M_BIG), att('mass-1', 30, 50, M_BIG)],
        particles: range(0, 9).map(() => part(60, 50, 0, 1)),
      });
      // 2 attractors, 10 particles: 24 evaluations per step, so 41 steps = 984 <= 1000 and 42 steps = 1008 > 1000.
      expect(() => tight.simulate(config, [42])).toThrow(RangeError);
      expect(() => tight.history(config, 0, 42)).toThrow(RangeError);
      expect(() => tight.simulate(config, [42])).toThrow(/force evaluations/);
      expect(() => tight.simulate(config, [42])).not.toThrow(SnapshotMismatchError);
      expect(tight.simulate(config, [41]).length).toBe(1);
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
