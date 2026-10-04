import { describe, expect, it } from 'vitest';
import { LIMITS, MODEL, SNAPSHOT_SCHEMA, type CloudStudyConfig, type EddyDrift, type EddyTrain, type SolidRegion, type Vec2, type Vortex, type WeatherFront } from '../../sketches/cloud-advection/model.ts';
import {
  SnapshotMismatchError,
  advance,
  buildDomain,
  configHashes,
  eddyTrainSpawns,
  frontAt,
  hashFloat64,
  initialSnapshot,
  parseSnapshot,
  sampleDensity,
  serializeSnapshot,
  simulate,
  stableHash,
  velocityAt,
  velocityAtTime,
  vortexStateAt,
} from '../../sketches/cloud-advection/sim.ts';

interface Opts {
  cols: number;
  rows: number;
  spacing: number;
  dt: number;
  boundary: 'open' | 'closed';
  diffusivity: number;
  wind: Vec2;
  vortices: Vortex[];
  solids: SolidRegion[];
  center: Vec2;
  radii: Vec2;
  seed: number;
  amplitude: number;
  front: WeatherFront;
  eddyDrift: EddyDrift;
  eddyTrain: EddyTrain;
}

function makeConfig(over: Partial<Opts> = {}): CloudStudyConfig {
  const o: Partial<Opts> & Omit<Opts, 'front' | 'eddyDrift' | 'eddyTrain'> = {
    cols: 40, rows: 40, spacing: 0.5, dt: 0.5, boundary: 'open', diffusivity: 0,
    wind: { x: 0, y: 0 }, vortices: [], solids: [],
    center: { x: 6, y: 10 }, radii: { x: 3, y: 3 }, seed: 1234, amplitude: 1,
    ...over,
  };
  return {
    domain: { origin: { x: 0, y: 0 }, size: { x: o.cols * o.spacing, y: o.rows * o.spacing } },
    transforms: {
      worldToGrid: { origin: { x: 0, y: 0 }, spacing: o.spacing, cols: o.cols, rows: o.rows },
      worldToPage: { scale: 3, offset: { x: 10, y: 20 } },
    },
    settings: { dt: o.dt, boundary: o.boundary, diffusivity: o.diffusivity },
    wind: { id: 'wind', kind: 'uniform-wind', velocity: o.wind },
    vortices: o.vortices,
    source: {
      id: 'smoke-source', kind: 'source', center: o.center, radii: o.radii,
      amplitude: o.amplitude, noiseScale: 2.5, seed: o.seed,
    },
    solids: o.solids,
    ...(o.front ? { front: o.front } : {}),
    ...(o.eddyDrift ? { eddyDrift: o.eddyDrift } : {}),
    ...(o.eddyTrain ? { eddyTrain: o.eddyTrain } : {}),
  };
}

const rect = (id: string, x0: number, y0: number, x1: number, y1: number): SolidRegion => ({
  id, kind: 'solid',
  polygon: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
});

const vortex = (id: string, x: number, y: number, circulation: number, coreRadius: number): Vortex => ({
  id, kind: 'vortex', center: { x, y }, circulation, coreRadius,
});

function centroid(density: number[], cols: number, spacing: number): Vec2 {
  let m = 0, sx = 0, sy = 0;
  density.forEach((c, k) => {
    m += c;
    sx += c * ((k % cols) + 0.5) * spacing;
    sy += c * (Math.floor(k / cols) + 0.5) * spacing;
  });
  return { x: sx / m, y: sy / m };
}

const centersAt = (config: CloudStudyConfig, step: number): Vec2[] => vortexStateAt(config, step).map((v) => v.center);
const centersOf = (s: { vortices: Array<{ center: Vec2 }> }): Vec2[] => s.vortices.map((v) => v.center);

const sum = (a: ArrayLike<number>): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };

describe('cloud advection: numerical fixtures', () => {
  it('1. zero velocity is the exact identity in both boundary modes', () => {
    for (const boundary of ['open', 'closed'] as const) {
      const config = makeConfig({ boundary });
      const [s0, s60] = simulate(config, [0, 60]);
      expect(s60.density).toEqual(s0.density);
      expect(s60.densityHash).toBe(s0.densityHash);
      expect(s60.mass.drift).toBe(0);
      expect(s60.step).toBe(60);
      expect(s0.mass.initial).toBeGreaterThan(0);
    }
  });

  it('2. one cell per step translates exactly by whole cells', () => {
    const config = makeConfig({ wind: { x: 0.5 / 0.5, y: 0 } });
    const [s0, s10] = simulate(config, [0, 10]);
    const { cols, rows } = s0.grid;
    let maxDiff = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const expected = i >= 10 ? s0.density[j * cols + i - 10] : 0;
        maxDiff = Math.max(maxDiff, Math.abs(s10.density[j * cols + i] - expected));
      }
    }
    console.log(`[cloud-advection] integer translation max |diff| = ${maxDiff}`);
    expect(maxDiff).toBe(0);
    expect(s10.mass.relativeDrift).toBeCloseTo(0, 12);
  });

  it('3. fractional diagonal translation moves the centroid and conserves mass', () => {
    const h = 0.5;
    const speed = 0.37 * h / 0.5; // 0.37 cell/step
    const dir = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
    const config = makeConfig({
      cols: 60, rows: 60, wind: { x: speed * dir.x, y: speed * dir.y },
      center: { x: 9, y: 9 }, radii: { x: 3, y: 3 },
    });
    const [s0, s20] = simulate(config, [0, 20]);
    const c0 = centroid(s0.density, 60, h);
    const c20 = centroid(s20.density, 60, h);
    const travel = 20 * 0.37 * h;
    const errX = c20.x - c0.x - travel * dir.x;
    const errY = c20.y - c0.y - travel * dir.y;
    console.log(`[cloud-advection] fractional translation centroid error = (${errX.toExponential(2)}, ${errY.toExponential(2)}) m (limit ${0.02 * h}); relDrift = ${s20.mass.relativeDrift.toExponential(2)}`);
    expect(Math.abs(errX)).toBeLessThan(0.02 * h);
    expect(Math.abs(errY)).toBeLessThan(0.02 * h);
    expect(Math.abs(s20.mass.relativeDrift)).toBeLessThan(1e-9);
  });

  describe('thin wall', () => {
    const h = 0.5;
    const wallX = 12.1; // centers at 11.75 and 12.25: the wall sits between two cell centers
    const thickness = 0.05 * h;
    const wall = (yTop: number): SolidRegion =>
      rect('solid-wall', wallX - thickness / 2, yTop, wallX + thickness / 2, 20.5);
    const rightOfWall = (index: number): boolean => ((index % 40) + 0.5) * h > wallX;

    const rightMax = (snaps: Array<{ density: number[] }>): number => {
      let m = 0;
      for (const s of snaps) s.density.forEach((c, k) => { if (rightOfWall(k)) m = Math.max(m, Math.abs(c)); });
      return m;
    };
    // Early snapshots matter: strong wind pushes the whole cloud out of the closed box within ~20 steps.
    const STEPS = [4, 6, 8, 10, 12, 16, 30, 60, 120];
    const scenarios: Array<[string, Partial<Parameters<typeof makeConfig>[0]>, number[]]> = [
      ['strong wind (1.7 cell/step) + vortex', {
        wind: { x: 1.7 * h / 0.5, y: 0 }, vortices: [vortex('eddy-1', 11, 8, 4, 1)],
      }, STEPS],
      ['weak wind + trapping vortex (cloud persists to step 120)', {
        wind: { x: 0.3, y: 0 }, vortices: [vortex('eddy-1', 8, 10, -25, 2)],
        center: { x: 5.5, y: 10 }, radii: { x: 2, y: 2 },
      }, [10, 30, 60, 120]],
    ];

    it('4. never lets density through a sub-cell wall (diffusion off and on)', () => {
      for (const [label, flow, steps] of scenarios) {
        for (const diffusivity of [0, 0.3]) {
          const base = { boundary: 'closed' as const, diffusivity, ...flow };
          const config = makeConfig({ ...base, solids: [wall(-0.5)] });
          const domain = buildDomain(config);
          expect(domain.solid.reduce((a, b) => a + b, 0)).toBe(0); // raster misses it entirely
          expect(domain.segmentBlocked({ x: 11.75, y: 10 }, { x: 12.25, y: 10 })).not.toBeNull();
          const snaps = simulate(config, steps);
          const leaked = rightMax(snaps);
          // control: same flow without the wall must put real density on the right side
          const control = rightMax(simulate(makeConfig(base), steps));
          const mass = snaps.map((s) => s.mass.current.toFixed(2)).join('/');
          console.log(`[cloud-advection] thin wall, ${label}, D=${diffusivity}: max right-side value = ${leaked}; no-wall control = ${control.toFixed(4)}; mass by step = ${mass}`);
          expect(leaked).toBe(0);
          expect(control).toBeGreaterThan(0.01);
          expect(snaps[0].mass.current).toBeGreaterThan(0); // the cloud was present against the wall
        }
      }
    });

    it('5. a gap at the top lets density reach the right side', () => {
      const flow = {
        boundary: 'closed' as const,
        wind: { x: 1.7 * h / 0.5, y: 0 },
        vortices: [vortex('eddy-1', 11, 8, 4, 1)],
        center: { x: 6, y: 3 },
        radii: { x: 2.5, y: 2.5 },
      };
      const steps = [8, 12, 30, 60, 120];
      const through = rightMax(simulate(makeConfig({ ...flow, solids: [wall(6)] }), steps));
      const sealed = rightMax(simulate(makeConfig({ ...flow, solids: [wall(-0.5)] }), steps));
      console.log(`[cloud-advection] gap control: max right-side value ${through.toFixed(4)}; sealed ${sealed}`);
      expect(through).toBeGreaterThan(0.05);
      expect(sealed).toBe(0);
    });
  });

  it('6a. open boundary: outflow lowers mass monotonically', () => {
    const config = makeConfig({ wind: { x: 1.7, y: 0 }, center: { x: 15, y: 10 } });
    const snaps = simulate(config, Array.from({ length: 31 }, (_, k) => k));
    for (let k = 1; k < snaps.length; k++) {
      expect(snaps[k].mass.current).toBeLessThanOrEqual(snaps[k - 1].mass.current * (1 + 1e-12));
    }
    const last = snaps[30];
    console.log(`[cloud-advection] open outflow: relativeDrift after 30 steps = ${last.mass.relativeDrift.toFixed(4)}`);
    expect(last.mass.drift).toBeLessThan(0);
    expect(last.mass.current).toBeLessThan(snaps[0].mass.current * 0.5);
  });

  it('6b. closed boundary: rotating blob stays finite, nonnegative, and near-conservative', () => {
    const config = makeConfig({
      boundary: 'closed', vortices: [vortex('eddy-1', 10, 10, 20, 2)], center: { x: 13, y: 10 }, radii: { x: 2, y: 2 },
    });
    const [s60] = simulate(config, [60]);
    console.log(`[cloud-advection] closed rotating vortex: relativeDrift after 60 steps = ${s60.mass.relativeDrift.toExponential(3)}`);
    for (const c of s60.density) {
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
    }
    // Semi-Lagrangian bilinear advection is not exactly conservative. The drift is a discretization
    // error: it shrinks as the grid is refined at the same physical time (checked below).
    expect(Math.abs(s60.mass.relativeDrift)).toBeLessThan(0.1);
    const fine = makeConfig({
      boundary: 'closed', cols: 80, rows: 80, spacing: 0.25, dt: 0.25,
      vortices: [vortex('eddy-1', 10, 10, 20, 2)], center: { x: 13, y: 10 }, radii: { x: 2, y: 2 },
    });
    const [f120] = simulate(fine, [120]);
    console.log(`[cloud-advection] same physical time at half spacing/dt: relativeDrift = ${f120.mass.relativeDrift.toExponential(3)}`);
    expect(Math.abs(f120.mass.relativeDrift)).toBeLessThan(Math.abs(s60.mass.relativeDrift));
  });

  describe('blocked backtraces absorb (no mass created by walls)', () => {
    const REL = 1e-12;
    const winds: Array<[string, Vec2]> = [['1 cell/step', { x: 1, y: 0 }], ['fractional diagonal', { x: 0.63, y: 0.21 }]];
    const wallAt = (x: number): SolidRegion => rect('solid-wall', x - 0.025, -1, x + 0.025, 21);

    /** Runs 20 steps with D=0 and checks mass never exceeds the previous step; returns the snapshots. */
    const checkNoGrowth = (label: string, config: CloudStudyConfig) => {
      const snaps = simulate(config, Array.from({ length: 21 }, (_, k) => k));
      const m0 = snaps[0].mass.current;
      let worst = 0;
      for (let k = 1; k < snaps.length; k++) {
        const growth = (snaps[k].mass.current - snaps[k - 1].mass.current) / m0;
        worst = Math.max(worst, growth, (snaps[k].mass.current - m0) / m0);
      }
      console.log(`[cloud-advection] no-growth ${label}: mass ${m0.toFixed(3)} -> ${snaps[20].mass.current.toFixed(3)}, worst relative increase = ${worst.toExponential(2)}`);
      expect(worst, label).toBeLessThanOrEqual(REL);
      return snaps;
    };

    it('lee of a thin wall is cleaned, not frozen (open boundary)', () => {
      for (const [name, wind] of winds) {
        const config = makeConfig({ wind, solids: [wallAt(9.1)], center: { x: 11, y: 10 }, radii: { x: 2.5, y: 2.5 } });
        const snaps = checkNoGrowth(`thin-wall lee, ${name}`, config);
        const leeCell = 20 * 40 + 18; // center x = 9.25, just right of the wall at 9.1
        expect(snaps[0].density[leeCell]).toBeGreaterThan(0);
        expect(snaps[1].density[leeCell]).toBe(0);
        expect(snaps[2].density[leeCell]).toBe(0);
      }
    });

    it('lee of a closed edge is cleaned (wind blowing away from the edge)', () => {
      for (const [name, wind] of winds) {
        const away = { x: -wind.x, y: -wind.y };
        const config = makeConfig({ boundary: 'closed', wind: away, center: { x: 18, y: 10 }, radii: { x: 3, y: 3 } });
        const snaps = checkNoGrowth(`closed edge lee, ${name}`, config);
        const last = (j: number): number => snaps[1].density[j * 40 + 39];
        expect(snaps[0].density[20 * 40 + 39]).toBeGreaterThan(0);
        for (let j = 0; j < 40; j++) expect(last(j)).toBeLessThan(1e-3 * snaps[0].density[20 * 40 + 39]);
        if (wind.y === 0) for (let j = 0; j < 40; j++) expect(last(j)).toBe(0);
      }
    });

    it('closed upwind wall with blob against it does not feed the box', () => {
      for (const [name, wind] of winds) {
        checkNoGrowth(`closed upwind wall, ${name}`, makeConfig({
          cols: 32, rows: 16, boundary: 'closed', wind, center: { x: 1.5, y: 4 }, radii: { x: 2.5, y: 2.5 },
        }));
      }
    });

    it('a wall just inside the open inflow edge creates no mass', () => {
      for (const [name, wind] of winds) {
        checkNoGrowth(`wall 0.2h inside inflow edge, ${name}`, makeConfig({
          wind, solids: [wallAt(0.1)], center: { x: 1.5, y: 10 }, radii: { x: 2.5, y: 2.5 },
        }));
      }
    });
  });

  it('outside-only walls do not change open-mode results (when farther than a cell out)', () => {
    const flow = { wind: { x: 0.8, y: 0.1 }, center: { x: 10, y: 10 }, radii: { x: 3, y: 3 } };
    const plain = simulate(makeConfig(flow), [30])[0];
    const walled = simulate(makeConfig({
      ...flow, solids: [rect('solid-left', -6, -1, -5.9, 21), rect('solid-right', 26, -1, 26.1, 21)],
    }), [30])[0];
    expect(walled.density).toEqual(plain.density);
  });

  it('keeps a frozen copy of the config, so later mutation cannot desync hashes', () => {
    const config = makeConfig();
    const domain = buildDomain(config);
    config.settings.dt = 99;
    config.solids.push(rect('solid-late', 1, 1, 2, 2));
    expect(domain.config.settings.dt).toBe(0.5);
    expect(domain.config.solids).toHaveLength(0);
    expect(Object.isFrozen(domain.config)).toBe(true);
    expect(domain.hashes).toEqual(configHashes(domain.config));
  });

  it('open/closed results without a front are bit-for-bit unchanged (regression hashes)', () => {
    const base = {
      cols: 48, rows: 36, wind: { x: 0.8, y: 0.15 }, diffusivity: 0.1,
      vortices: [vortex('eddy-1', 12, 9, 6, 1.5), vortex('eddy-2', 15, 12, -4, 1)],
      solids: [rect('solid-a', 9.2, 5, 9.7, 13), { id: 'solid-b' as const, kind: 'solid' as const, polygon: [{ x: 14, y: 2 }, { x: 17, y: 4 }, { x: 15, y: 6.2 }] }],
      center: { x: 6, y: 9 }, radii: { x: 3, y: 4 },
    };
    const got: Record<string, string> = {};
    for (const boundary of ['open', 'closed'] as const) {
      const [s60] = simulate(makeConfig({ ...base, boundary }), [60]);
      got[boundary] = s60.densityHash;
    }
    // Values computed with MODEL 1.0.0 before the inflow mode existed.
    expect(got).toEqual({ open: 'f4561ba25511f244', closed: 'c47fa27b32c0c03b' });
  });

  describe('inflow boundary and the frozen upstream field', () => {
    const front = (over: Partial<WeatherFront> = {}): WeatherFront => ({
      id: 'weather-front', kind: 'frozen-field', amplitude: 1, scale: 3, coverage: 0.5, seed: 99, fillInterior: true, ...over,
    });
    const centerOf = (k: number, cols = 40, h = 0.5): Vec2 => ({ x: ((k % cols) + 0.5) * h, y: (Math.floor(k / cols) + 0.5) * h });

    it('frontAt is a rigidly advected, bounded, deterministic pattern', () => {
      const cfg = makeConfig({ boundary: 'inflow', front: front(), wind: { x: 1.3, y: -0.4 } });
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < 400; k++) {
        const p = { x: (k % 20) * 1.1, y: Math.floor(k / 20) * 1.1 };
        const v = frontAt(cfg, p, 0);
        lo = Math.min(lo, v); hi = Math.max(hi, v);
        expect(frontAt(cfg, { x: p.x + 1.3 * 7, y: p.y - 0.4 * 7 }, 7)).toBeCloseTo(v, 12);
        expect(frontAt(cfg, p, 0)).toBe(v);
      }
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(1);
      expect(hi - lo).toBeGreaterThan(0.5); // genuinely patchy
      expect(frontAt(makeConfig(), { x: 1, y: 1 }, 3)).toBe(0); // no front
      const thin = makeConfig({ boundary: 'inflow', front: front({ coverage: 0.1 }) });
      const thick = makeConfig({ boundary: 'inflow', front: front({ coverage: 0.9 }) });
      const mean = (c: CloudStudyConfig): number => { let m = 0; for (let k = 0; k < 400; k++) m += frontAt(c, { x: (k % 20) * 1.1, y: Math.floor(k / 20) * 1.1 }, 0); return m / 400; };
      expect(mean(thick)).toBeGreaterThan(mean(thin) + 0.3);
    });

    it('1. the interior equals the frozen field carried by the wind (fillInterior)', () => {
      for (const [name, wind] of [['+x', { x: 1, y: 0 }], ['diagonal', { x: 1, y: 1 }]] as Array<[string, Vec2]>) {
        const config = makeConfig({ boundary: 'inflow', front: front(), wind, amplitude: 0 });
        const snaps = simulate(config, [0, 10, 40]);
        let maxErr = 0;
        for (const snap of snaps) {
          snap.density.forEach((v, k) => {
            maxErr = Math.max(maxErr, Math.abs(v - frontAt(config, centerOf(k), snap.timeS)));
          });
          expect(Math.max(...snap.density)).toBeGreaterThan(0.5);
        }
        console.log(`[cloud-advection] frozen-field consistency ${name}: max |cell - W(center - U t)| = ${maxErr.toExponential(2)} over steps 0/10/40`);
        expect(maxErr).toBeLessThan(1e-12);
      }
    });

    it('2. without fillInterior the field enters one column per step', () => {
      const config = makeConfig({ boundary: 'inflow', front: front({ fillInterior: false }), wind: { x: 1, y: 0 }, amplitude: 0 });
      const [s0, s10] = simulate(config, [0, 10]);
      expect(Math.max(...s0.density)).toBe(0);
      let maxErr = 0;
      s10.density.forEach((v, k) => {
        if (k % 40 < 10) maxErr = Math.max(maxErr, Math.abs(v - frontAt(config, centerOf(k), s10.timeS)));
        else expect(v).toBe(0);
      });
      console.log(`[cloud-advection] inflow front, 10 upwind columns: max error = ${maxErr.toExponential(2)}`);
      expect(maxErr).toBeLessThan(1e-12);
      expect(Math.max(...s10.density)).toBeGreaterThan(0.3);
    });

    it('3. zero velocity is the exact identity under inflow', () => {
      const config = makeConfig({ boundary: 'inflow', front: front() });
      const [s0, s60] = simulate(config, [0, 60]);
      expect(s60.densityHash).toBe(s0.densityHash);
      expect(s60.density).toEqual(s0.density);
      expect(s60.mass.drift).toBe(0);
      expect(s0.mass.initial).toBeGreaterThan(0);
    });

    it('4. a thin wall keeps the lee exactly 0 while the front arrives on the left', () => {
      const h = 0.5;
      const wallX = 12.1;
      const wall = rect('solid-wall', wallX - 0.025 * h, -1, wallX + 0.025 * h, 21);
      const base = { boundary: 'inflow' as const, front: front({ fillInterior: false }), wind: { x: 1.7, y: 0 }, amplitude: 0 };
      const steps = [4, 8, 12, 16, 30, 60, 120];
      let leaked = 0, left = 0, control = 0;
      for (const snap of simulate(makeConfig({ ...base, solids: [wall] }), steps)) {
        snap.density.forEach((v, k) => {
          if (centerOf(k).x > wallX) leaked = Math.max(leaked, v);
          else left = Math.max(left, v);
        });
      }
      for (const snap of simulate(makeConfig(base), steps)) {
        snap.density.forEach((v, k) => { if (centerOf(k).x > wallX) control = Math.max(control, v); });
      }
      console.log(`[cloud-advection] inflow thin wall: max right-side value = ${leaked}; left max = ${left.toFixed(3)}; no-wall control right = ${control.toFixed(3)}`);
      expect(leaked).toBe(0);
      expect(left).toBeGreaterThan(0.3);
      expect(control).toBeGreaterThan(0.3);
    });

    const richConfig = (over: Partial<WeatherFront> = {}): CloudStudyConfig => makeConfig({
      boundary: 'inflow', front: front(over), wind: { x: 0.8, y: 0.2 }, diffusivity: 0.1,
      vortices: [vortex('eddy-1', 12, 10, 8, 1.5)], solids: [rect('solid-a', 14, 6, 15, 14)],
    });

    it('front configs without softness keep their pre-softness hashes', () => {
      const [s40] = simulate(richConfig(), [40]);
      expect(s40.densityHash).toBe('11d588b63b0ff896');
// Pinned with MODEL 1.2.0 before eddyDrift existed; an absent eddyDrift must keep these.
      // Pinned with MODEL 1.3.0 before eddyTrain existed; an absent eddyTrain must keep these.
      expect(configHashes(richConfig()).simulation).toBe('62e60b8d61285a5b');
      expect(configHashes(makeConfig({ wind: { x: 0.8, y: 0.15 }, vortices: [vortex('eddy-1', 12, 9, 6, 1.5)] })).simulation).toBe('c4e54b1406e2d69c');
      expect(configHashes(makeConfig({ eddyDrift: 'kirchhoff', vortices: [vortex('eddy-1', 12, 9, 6, 1.5)] })).simulation).toBe('70ed5a57d1907af5');
    });

    it('softness: absent equals 0.12, is validated, hashed, and widens the bank edge', () => {
      const withSoft = (softness: number | undefined): CloudStudyConfig => makeConfig({
        boundary: 'inflow', front: front({ ...(softness === undefined ? {} : { softness }), fillInterior: true }), amplitude: 0,
      });
      const a = simulate(richConfig(), [20])[0];
      const explicit = simulate(makeConfig({
        boundary: 'inflow', front: front({ softness: 0.12 }), wind: { x: 0.8, y: 0.2 }, diffusivity: 0.1,
        vortices: [vortex('eddy-1', 12, 10, 8, 1.5)], solids: [rect('solid-a', 14, 6, 15, 14)],
      }), [20])[0];
      expect(explicit.density).toEqual(a.density); // bitwise: 0.12 is the default
      expect(configHashes(withSoft(0.12)).simulation).not.toBe(configHashes(withSoft(undefined)).simulation);
      expect(configHashes(withSoft(undefined)).simulation).toBe(configHashes(makeConfig({ boundary: 'inflow', front: front(), amplitude: 0 })).simulation);

      for (const bad of [0.01, 0.51, -0.1, Number.NaN]) {
        expect(() => buildDomain(withSoft(bad)), `softness ${bad}`).toThrow(RangeError);
      }
      expect(() => buildDomain(withSoft(0.02))).not.toThrow();
      expect(() => buildDomain(withSoft(0.5))).not.toThrow();

      const snap = initialSnapshot(withSoft(undefined));
      expect(() => advance(snap, withSoft(0.3), 1)).toThrow(SnapshotMismatchError);

      // peak |grad W| on a fine sample grid shrinks as softness grows
      const grad = (softness: number): number => {
        const cfg = withSoft(softness);
        const d = 0.05;
        let peak = 0;
        for (let i = 0; i < 200; i++) {
          for (let j = 0; j < 200; j++) {
            const p = { x: i * 0.1, y: j * 0.1 };
            const w = frontAt(cfg, p, 0);
            peak = Math.max(peak, Math.hypot(
              (frontAt(cfg, { x: p.x + d, y: p.y }, 0) - w) / d,
              (frontAt(cfg, { x: p.x, y: p.y + d }, 0) - w) / d,
            ));
          }
        }
        return peak;
      };
      const g = [0.06, 0.12, 0.3].map(grad);
      console.log(`[cloud-advection] peak |grad W| for softness 0.06/0.12/0.3 = ${g.map((v) => v.toFixed(3)).join(' / ')}`);
      expect(g[0]).toBeGreaterThan(g[1]);
      expect(g[1]).toBeGreaterThan(g[2]);
    });

    it('5a. resumes deterministically from a serialized snapshot', () => {
      const config = richConfig();
      const [direct] = simulate(config, [60]);
      const half = advance(initialSnapshot(config), config, 30);
      const resumed = advance(parseSnapshot(serializeSnapshot(half)), config, 30);
      expect(resumed.densityHash).toBe(direct.densityHash);
      expect(resumed.density).toEqual(direct.density);
      expect(resumed.mass).toEqual(direct.mass);
      expect(Math.max(...direct.density)).toBeGreaterThan(0.1);
    });

    it('5b. any front field change invalidates snapshots (simulation hash only)', () => {
      const base = richConfig();
      const snap = initialSnapshot(base);
      const h0 = configHashes(base);
      const changes: Array<[string, Partial<WeatherFront>]> = [
        ['amplitude', { amplitude: 0.9 }], ['scale', { scale: 4 }], ['coverage', { coverage: 0.6 }],
        ['seed', { seed: 100 }], ['fillInterior', { fillInterior: false }],
      ];
      for (const [label, change] of changes) {
        const changed = richConfig(change);
        const h1 = configHashes(changed);
        expect(h1.simulation, label).not.toBe(h0.simulation);
        expect(h1.geometry, label).toBe(h0.geometry);
        expect(h1.transform, label).toBe(h0.transform);
        expect(() => advance(snap, changed, 1), label).toThrow(SnapshotMismatchError);
      }
      // dropping the front from an open config is a different state too
      const open = { ...structuredClone(base), front: undefined };
      open.settings.boundary = 'open';
      expect(() => advance(snap, open, 1)).toThrow(SnapshotMismatchError);
      expect(configHashes(makeConfig()).simulation).toBe(configHashes({ ...makeConfig(), front: undefined }).simulation);
    });

    it('5c. snapshots from an older model version refuse to resume', () => {
      const config = makeConfig({ boundary: 'inflow', front: front() });
      const snap = initialSnapshot(config);
      expect(MODEL.version).toBe('1.3.0');
      expect(MODEL.backendVersion).toBe('1.3.0');
      const old = { ...snap, model: { ...snap.model, version: '1.0.0', backendVersion: '1.0.0' } } as unknown as typeof snap;
      expect(() => advance(old, config, 1)).toThrow(SnapshotMismatchError);
    });

    it('validates the front and the inflow requirement', () => {
      expect(() => buildDomain(makeConfig({ boundary: 'inflow' }))).toThrow(/requires config.front/);
      const bad = (over: Partial<WeatherFront>): void => {
        expect(() => buildDomain(makeConfig({ boundary: 'inflow', front: front(over) }))).toThrow(RangeError);
      };
      bad({ coverage: 1.5 }); bad({ coverage: -0.1 }); bad({ scale: 0 }); bad({ amplitude: -1 });
      bad({ seed: -1 }); bad({ seed: 1.5 }); bad({ amplitude: Number.NaN });
      // fillInterior applies whenever a front is present, in any mode
      const [s0] = simulate(makeConfig({ boundary: 'open', front: front(), amplitude: 0 }), [0]);
      expect(Math.max(...s0.density)).toBeGreaterThan(0.5);
    });

    it('sampleDensity reads the upstream field outside the grid when given timeS', () => {
      const config = makeConfig({ boundary: 'inflow', front: front(), amplitude: 0, wind: { x: 1, y: 0 } });
      const domain = buildDomain(config);
      const [s3] = simulate(config, [3]);
      const y = 10.25; // row 20: a cell-center row, so fy = 0
      const edge = { x: 0, y };
      const expected = 0.5 * frontAt(config, { x: -0.25, y }, s3.timeS) + 0.5 * s3.density[20 * 40];
      expect(sampleDensity(domain, s3.density, edge, s3.timeS)).toBeCloseTo(expected, 12);
      expect(sampleDensity(domain, s3.density, edge)).toBeCloseTo(0.5 * s3.density[20 * 40], 12);
      const outside = { x: -3, y: 4 };
      expect(sampleDensity(domain, s3.density, outside, s3.timeS)).toBe(frontAt(config, outside, s3.timeS));
    });

    it('6. art-like inflow config stays finite, bounded and fast', () => {
      const config = makeConfig({
        cols: 120, rows: 195, spacing: 0.4, dt: 0.25, boundary: 'inflow', diffusivity: 0.05,
        wind: { x: 0.9, y: 0.35 },
        vortices: [vortex('eddy-1', 20, 30, 12, 2), vortex('eddy-2', 30, 55, -9, 3)],
        center: { x: 12, y: 20 }, radii: { x: 6, y: 9 },
        front: front({ scale: 8, coverage: 0.45 }),
        solids: [
          rect('solid-a', 22, 15, 30, 24),
          { id: 'solid-b', kind: 'solid', polygon: [{ x: 8, y: 50 }, { x: 14, y: 46 }, { x: 18, y: 52 }, { x: 14, y: 58 }, { x: 8, y: 57 }] },
          rect('solid-thin', 30, 28, 30.02, 60),
          { id: 'solid-c', kind: 'solid', polygon: [{ x: 38, y: 40 }, { x: 44, y: 70 }, { x: 34, y: 66 }] },
        ],
      });
      const t0 = performance.now();
      simulate(config, [0, 30, 60]);
      const ms60 = performance.now() - t0;
      const t1 = performance.now();
      const snaps = simulate(config, [0, 30, 60, 120]);
      const ms120 = performance.now() - t1;
      const last = snaps[snaps.length - 1];
      console.log(`[cloud-advection] art-like inflow 120x195: steps 0..60 ${ms60.toFixed(0)} ms, 0..120 ${ms120.toFixed(0)} ms, relativeDrift = ${last.mass.relativeDrift.toFixed(3)}`);
      for (const snap of snaps) {
        let min = Infinity, max = -Infinity;
        for (const c of snap.density) { expect(Number.isFinite(c)).toBe(true); min = Math.min(min, c); max = Math.max(max, c); }
        expect(min).toBeGreaterThanOrEqual(0);
        expect(max).toBeLessThanOrEqual(1 + 1e-9); // convex reads of values that are all <= 1
      }
      expect(ms60).toBeLessThan(1000);
      expect(sum(last.density)).toBeGreaterThan(0);
    });
  });

  describe('vortex drift (eddyDrift)', () => {
    const angleOf = (a: Vec2, b: Vec2): number => Math.atan2(b.y - a.y, b.x - a.x);

    it('train-free drifting configs keep their pre-train density hashes', () => {
      const got: Record<string, string> = {};
      for (const eddyDrift of ['wind', 'kirchhoff'] as const) {
        const config = makeConfig({
          boundary: 'inflow', eddyDrift, diffusivity: 0.1, wind: { x: 0.6, y: 0.2 },
          front: { id: 'weather-front', kind: 'frozen-field', amplitude: 1, scale: 3, coverage: 0.5, seed: 99, fillInterior: true },
          vortices: [vortex('eddy-1', 12, 10, 8, 1.5), vortex('eddy-2', 15, 12, -5, 1.2), vortex('eddy-3', 9, 14, 3, 1)],
          solids: [rect('solid-a', 14, 6, 15, 8)],
        });
        got[eddyDrift] = simulate(config, [90])[0].densityHash;
      }
      // Computed with MODEL 1.2.0 before the eddy train existed.
      expect(got).toEqual({ wind: 'b3a4f20d0508a4f3', kirchhoff: '1415024e1ce5e440' });
    });

    it('fixed (absent or explicit) keeps centres, hashes and density bitwise', () => {
      const base = { wind: { x: 0.8, y: 0.1 }, vortices: [vortex('eddy-1', 12, 9, 6, 1.5)], solids: [rect('solid-a', 14, 6, 15, 14)], diffusivity: 0.1 };
      const absent = makeConfig(base);
      const explicit = makeConfig({ ...base, eddyDrift: 'fixed' });
      expect(configHashes(explicit)).toEqual(configHashes(absent));
      const [a] = simulate(absent, [60]);
      const [e] = simulate(explicit, [60]);
      expect(e.density).toEqual(a.density);
      expect(centersOf(a)).toEqual([{ x: 12, y: 9 }]);
      expect(centersAt(absent, 60)).toEqual([{ x: 12, y: 9 }]);
      expect(a.schema).toBe(SNAPSHOT_SCHEMA);
      expect(SNAPSHOT_SCHEMA).toMatch(/\.v3$/);
    });

    it("'wind': a lone vortex travels with the wind", () => {
      const wind = { x: 0.8, y: -0.3 };
      const config = makeConfig({ eddyDrift: 'wind', wind, vortices: [vortex('eddy-1', 8, 14, 5, 1.5)] });
      const snaps = simulate(config, [0, 50, 120]);
      let worst = 0;
      for (const snap of snaps) {
        const t = snap.step * 0.5;
        worst = Math.max(worst, Math.abs(snap.vortices[0].center.x - (8 + wind.x * t)), Math.abs(snap.vortices[0].center.y - (14 + wind.y * t)));
        expect(vortexStateAt(config, snap.step)).toEqual(snap.vortices); // replay is bitwise
      }
      console.log(`[cloud-advection] wind drift: max centre error after 120 steps = ${worst.toExponential(2)} m`);
      expect(worst).toBeLessThan(1e-12);
      // the flow really follows: the velocity field at the drifted centres matches the initial layout shifted by the travel
      const v0 = velocityAtTime(config, vortexStateAt(config, 0), { x: 10, y: 14 });
      const v1 = velocityAtTime(config, snaps[2].vortices, { x: 10 + wind.x * 60, y: 14 + wind.y * 60 });
      expect(v1.x).toBeCloseTo(v0.x, 10);
      expect(v1.y).toBeCloseTo(v0.y, 10);
    });

    it("'kirchhoff': two equal co-rotating vortices orbit their midpoint", () => {
      const G = 2, a = 0.5, d = 4, dt = 0.1;
      const config = makeConfig({
        eddyDrift: 'kirchhoff', dt, vortices: [vortex('eddy-1', 8, 10, G, a), vortex('eddy-2', 12, 10, G, a)],
      });
      const omega = G / (Math.PI * (d * d + a * a)); // v = G d / (2π (d²+a²)) at radius d/2
      let sepErr = 0, midErr = 0;
      for (let step = 0; step <= 240; step += 8) {
        const [c1, c2] = centersAt(config, step);
        sepErr = Math.max(sepErr, Math.abs(Math.hypot(c2.x - c1.x, c2.y - c1.y) - d) / d);
        midErr = Math.max(midErr, Math.hypot((c1.x + c2.x) / 2 - 10, (c1.y + c2.y) / 2 - 10));
      }
      const [c1, c2] = centersAt(config, 240);
      const turned = angleOf(c1, c2); // vortex 2 started on +x of vortex 1 (angle 0)
      const expected = omega * 240 * dt;
      console.log(`[cloud-advection] kirchhoff co-rotating pair: separation drift ${sepErr.toExponential(2)} (relative), midpoint drift ${midErr.toExponential(2)} m, rotation ${turned.toFixed(7)} rad vs analytic ${expected.toFixed(7)}`);
      expect(sepErr).toBeLessThan(1e-6);
      expect(midErr).toBeLessThan(1e-12);
      // RK2 phase error is O(θ³) per step with θ = ω·dt ≈ 0.004; about 1e-6 rad accumulates over 240 steps (measured).
      expect(Math.abs(turned - expected)).toBeLessThan(1e-5);
      const [snap] = simulate(config, [240]);
      expect(snap.vortices).toEqual(vortexStateAt(config, 240));
    });

    it("'kirchhoff': a counter-rotating pair translates perpendicular to its axis", () => {
      const G = 2, a = 0.5, d = 4, dt = 0.5;
      const config = makeConfig({
        eddyDrift: 'kirchhoff', dt, vortices: [vortex('eddy-1', 8, 10, G, a), vortex('eddy-2', 12, 10, -G, a)],
      });
      // Each vortex sees the other at distance d with kernel G d / (2π (d² + a²)): both move along +y at that speed.
      const speed = (G * d) / (2 * Math.PI * (d * d + a * a));
      const [snap] = simulate(config, [100]);
      const travel = speed * 100 * dt;
      const errY = Math.abs((snap.vortices[0].center.y - 10) - travel) / travel;
      const errY2 = Math.abs((snap.vortices[1].center.y - 10) - travel) / travel;
      const errX = Math.max(Math.abs(snap.vortices[0].center.x - 8), Math.abs(snap.vortices[1].center.x - 12));
      console.log(`[cloud-advection] kirchhoff dipole: speed ${speed.toFixed(6)} m/s, relative travel error ${Math.max(errY, errY2).toExponential(2)}, sideways drift ${errX.toExponential(2)} m`);
      expect(Math.max(errY, errY2)).toBeLessThan(1e-6);
      expect(errX).toBeLessThan(1e-9);
    });

    it('resumes bitwise from a serialized snapshot while the eddies drift', () => {
      const config = makeConfig({
        boundary: 'inflow', eddyDrift: 'kirchhoff', diffusivity: 0.1, wind: { x: 0.6, y: 0.2 },
        front: { id: 'weather-front', kind: 'frozen-field', amplitude: 1, scale: 3, coverage: 0.5, seed: 99, fillInterior: true },
        vortices: [vortex('eddy-1', 12, 10, 8, 1.5), vortex('eddy-2', 15, 12, -5, 1.2), vortex('eddy-3', 9, 14, 3, 1)],
        solids: [rect('solid-a', 14, 6, 15, 8)],
      });
      const [direct] = simulate(config, [60]);
      const half = advance(initialSnapshot(config), config, 30);
      const resumed = advance(parseSnapshot(serializeSnapshot(half)), config, 30);
      expect(resumed.densityHash).toBe(direct.densityHash);
      expect(resumed.density).toEqual(direct.density);
      expect(resumed.vortices).toEqual(direct.vortices);
      expect(resumed.mass).toEqual(direct.mass);
      expect(direct.vortices[0].center).not.toEqual({ x: 12, y: 10 }); // they really moved
    });

    it('a thin wall still leaks nothing while a vortex drifts past it', () => {
      const wallX = 12.1;
      const wall = rect('solid-wall', wallX - 0.0125, -1, wallX + 0.0125, 21);
      const steps = [4, 8, 12, 20, 30, 60, 120];
      const rightMax = (c: CloudStudyConfig): number => {
        let m = 0;
        for (const snap of simulate(c, steps)) snap.density.forEach((v, k) => { if (((k % 40) + 0.5) * 0.5 > wallX) m = Math.max(m, v); });
        return m;
      };
      for (const eddyDrift of ['wind', 'kirchhoff'] as const) {
        for (const diffusivity of [0, 0.3]) {
          const base = {
            boundary: 'closed' as const, eddyDrift, diffusivity, wind: { x: 1, y: 0 },
            vortices: [vortex('eddy-1', 8, 8, 10, 1.5), vortex('eddy-2', 8, 12, -6, 1.5)],
            center: { x: 5, y: 10 }, radii: { x: 2.5, y: 2.5 },
          };
          const [last] = simulate(makeConfig({ ...base, solids: [wall] }), [30]);
          expect(last.vortices[0].center.x).toBeGreaterThan(wallX); // the vortex did cross the wall line
          const leaked = rightMax(makeConfig({ ...base, solids: [wall] }));
          const control = rightMax(makeConfig(base));
          console.log(`[cloud-advection] drifting vortex past a thin wall (${eddyDrift}, D=${diffusivity}): max right-side = ${leaked}; no-wall control = ${control.toFixed(3)}`);
          expect(leaked).toBe(0);
          expect(control).toBeGreaterThan(0.01);
        }
      }
    });

    it('eddyDrift changes invalidate snapshots; forged centres are rejected', () => {
      const mk = (eddyDrift?: EddyDrift): CloudStudyConfig => makeConfig({
        ...(eddyDrift ? { eddyDrift } : {}), wind: { x: 0.5, y: 0 },
        vortices: [vortex('eddy-1', 8, 10, 4, 1), vortex('eddy-2', 13, 10, 4, 1)],
      });
      const h0 = configHashes(mk());
      for (const drift of ['wind', 'kirchhoff'] as const) {
        const hs = configHashes(mk(drift));
        expect(hs.simulation).not.toBe(h0.simulation);
        expect(hs.geometry).toBe(h0.geometry);
        expect(hs.transform).toBe(h0.transform);
        expect(() => advance(initialSnapshot(mk()), mk(drift), 1)).toThrow(SnapshotMismatchError);
      }
      expect(configHashes(mk('wind')).simulation).not.toBe(configHashes(mk('kirchhoff')).simulation);
      expect(() => buildDomain({ ...mk(), eddyDrift: 'spin' as EddyDrift })).toThrow(RangeError);

      const config = mk('kirchhoff');
      const snap = advance(initialSnapshot(config), config, 5);
      const forged = { ...snap, vortices: vortexStateAt(config, 0) }; // the step-0 layout at step 5
      expect(() => advance(forged, config, 1)).toThrow(/vortices/);
      expect(() => advance({ ...snap, vortices: [snap.vortices[0]] }, config, 1)).toThrow(SnapshotMismatchError);
      expect(() => advance({ ...snap, vortices: snap.vortices.map((v) => ({ ...v, circulation: v.circulation * 2 })) }, config, 1)).toThrow(/vortices/);
      const text = JSON.parse(serializeSnapshot(snap)) as Record<string, unknown>;
      delete text.vortices;
      expect(() => parseSnapshot(JSON.stringify(text))).toThrow(/vortices/);
      expect(() => parseSnapshot(JSON.stringify({ ...text, vortices: [{ key: 'a', center: { x: null, y: 1 }, circulation: 1, coreRadius: 1 }] }))).toThrow(/vortices/);
      expect(() => parseSnapshot(JSON.stringify({ ...JSON.parse(serializeSnapshot(snap)), schema: 'hatch3d.cloud-advection.snapshot.v1' }))).toThrow(/schema/);
      expect(() => vortexStateAt(config, -1)).toThrow(RangeError);
    });

    it('velocityAtTime uses the supplied active list; velocityAt stays the initial layout', () => {
      const config = makeConfig({ wind: { x: 1, y: 0 }, vortices: [vortex('eddy-1', 5, 5, 6, 1)] });
      const p = { x: 7, y: 6 };
      const initial = vortexStateAt(config, 0);
      expect(initial[0].key).toBe('eddy-1');
      expect(velocityAtTime(config, initial, p)).toEqual(velocityAt(config, p));
      const moved = [{ ...initial[0], center: { x: 9, y: 5 } }];
      expect(velocityAtTime(config, moved, p)).not.toEqual(velocityAt(config, p));
      expect(velocityAtTime(config, [], p)).toEqual({ x: 1, y: 0 }); // wind only
    });

    it('art-like config with ~30 solids and drifting eddies fits the time budget', () => {
      const solids: SolidRegion[] = [];
      for (let i = 0; i < 30; i++) {
        const ang = i * 2.399;
        const cx = 24 + 16 * Math.cos(ang) * ((i % 7) / 7 + 0.3);
        const cy = 39 + 30 * Math.sin(ang) * ((i % 5) / 5 + 0.3);
        solids.push({
          id: `solid-${i}`, kind: 'solid',
          polygon: Array.from({ length: 6 }, (_, k) => {
            const t = (k / 6) * 2 * Math.PI;
            const r = 1.2 + 0.5 * (k % 2);
            return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
          }),
        });
      }
      const config = makeConfig({
        cols: 120, rows: 195, spacing: 0.4, dt: 0.25, boundary: 'inflow', diffusivity: 0.05, eddyDrift: 'kirchhoff',
        wind: { x: 0.9, y: 0.35 }, solids,
        vortices: [vortex('eddy-1', 20, 30, 12, 2), vortex('eddy-2', 30, 55, -9, 3), vortex('eddy-3', 25, 42, 7, 2)],
        center: { x: 12, y: 20 }, radii: { x: 6, y: 9 },
        front: { id: 'weather-front', kind: 'frozen-field', amplitude: 1, scale: 8, coverage: 0.45, seed: 9, fillInterior: true },
      });
      const t0 = performance.now();
      const snaps = simulate(config, [0, 60, 120, 240]);
      const ms = performance.now() - t0;
      console.log(`[cloud-advection] drifting-eddy art config (30 solids, kirchhoff, inflow, D on), steps 0..240: ${ms.toFixed(0)} ms`);
      for (const snap of snaps) {
        let min = Infinity, max = -Infinity;
        for (const c of snap.density) { expect(Number.isFinite(c)).toBe(true); min = Math.min(min, c); max = Math.max(max, c); }
        expect(min).toBeGreaterThanOrEqual(0);
        expect(max).toBeLessThanOrEqual(1 + 1e-9);
      }
      expect(ms).toBeLessThan(4000);
      // the work budget counts the per-step stencil rebuild: 99,856 cells x 240 steps x 5 > the limit
      const big = makeConfig({ cols: 316, rows: 316, eddyDrift: 'wind', vortices: [vortex('eddy-1', 80, 80, 5, 2)], center: { x: 80, y: 80 }, radii: { x: 10, y: 10 } });
      expect(() => simulate(big, [240])).toThrow(/cell updates/);
    });
  });

  describe('eddy train', () => {
    const train = (over: Partial<EddyTrain> = {}): EddyTrain => ({
      id: 'eddy-train', period: 20, firstStep: 0, circulation: 4, coreRadius: 1.5, alternate: true,
      lateralJitter: 0.5, timingJitter: 0, seed: 7, removeMargin: 3, maxActive: 6, ...over,
    });
    const withTrain = (over: Partial<Parameters<typeof makeConfig>[0]> = {}, t: Partial<EddyTrain> = {}): CloudStudyConfig =>
      makeConfig({ eddyDrift: 'wind', wind: { x: 1, y: 0 }, eddyTrain: train(t), amplitude: 0, ...over });
    const trainKeys = (config: CloudStudyConfig, step: number): string[] =>
      vortexStateAt(config, step).map((v) => v.key).filter((k) => k.startsWith('train-'));

    it('spawn schedule follows the rule: steps, signs, lateral bounds, determinism', () => {
      const exact = withTrain({}, { firstStep: 3, period: 20 });
      const spawns = eddyTrainSpawns(exact);
      expect(spawns.map((sp) => sp.step)).toEqual(Array.from({ length: 12 }, (_, k) => 3 + 20 * k)); // 3 .. 223
      expect(spawns.map((sp) => sp.index)).toEqual(Array.from({ length: 12 }, (_, k) => k));
      spawns.forEach((sp, k) => {
        expect(sp.circulation).toBe(k % 2 === 0 ? 4 : -4);
        expect(sp.center.x).toBe(-1.5); // upwind edge is the left one; one core radius outside
        expect(Math.abs(sp.center.y - 10)).toBeLessThanOrEqual(0.5 * 10 + 1e-12); // ±lateralJitter · half the edge length
      });
      expect(new Set(spawns.map((sp) => sp.center.y)).size).toBeGreaterThan(6); // genuinely jittered
      // non-alternating: always +
      expect(eddyTrainSpawns(withTrain({}, { alternate: false })).every((sp) => sp.circulation === 4)).toBe(true);
      // lateralJitter 0: exactly the edge midpoint; 1: reaches far toward the corners
      expect(eddyTrainSpawns(withTrain({}, { lateralJitter: 0 })).every((sp) => sp.center.y === 10)).toBe(true);
      const wide = eddyTrainSpawns(withTrain({}, { lateralJitter: 1, period: 4 })).map((sp) => sp.center.y);
      expect(Math.max(...wide) - Math.min(...wide)).toBeGreaterThan(14);
      expect(Math.max(...wide)).toBeLessThanOrEqual(20 + 1e-12);
      expect(Math.min(...wide)).toBeGreaterThanOrEqual(-1e-12);
      // deterministic, and seed-dependent
      expect(eddyTrainSpawns(withTrain())).toEqual(eddyTrainSpawns(withTrain()));
      expect(eddyTrainSpawns(withTrain({}, { seed: 8 }))).not.toEqual(eddyTrainSpawns(withTrain()));

      // timing jitter: within ±J of the exact period, strictly increasing, deterministic
      const jittered = eddyTrainSpawns(withTrain({}, { firstStep: 4, period: 20, timingJitter: 4 }));
      let moved = 0;
      jittered.forEach((sp, k) => {
        expect(Math.abs(sp.step - (4 + 20 * k))).toBeLessThanOrEqual(4);
        if (sp.step !== 4 + 20 * k) moved++;
        if (k > 0) expect(sp.step).toBeGreaterThan(jittered[k - 1].step);
      });
      expect(moved).toBeGreaterThan(3);
      expect(jittered.every((sp) => sp.step <= LIMITS.maxSteps)).toBe(true);
    });

    it('chooses the upwind edge from the wind direction (four directions, diagonals, ties)', () => {
      const edgeFor = (wind: Vec2): Vec2 => eddyTrainSpawns(withTrain({ wind }, { lateralJitter: 0, coreRadius: 1.5 }))[0].center;
      expect(edgeFor({ x: 1, y: 0 })).toEqual({ x: -1.5, y: 10 }); // left
      expect(edgeFor({ x: -1, y: 0 })).toEqual({ x: 21.5, y: 10 }); // right
      expect(edgeFor({ x: 0, y: 1 })).toEqual({ x: 10, y: -1.5 }); // top (air comes from y < 0)
      expect(edgeFor({ x: 0, y: -1 })).toEqual({ x: 10, y: 21.5 }); // bottom
      expect(edgeFor({ x: 1, y: 0.4 })).toEqual({ x: -1.5, y: 10 }); // diagonal, x dominant
      expect(edgeFor({ x: 0.3, y: -1 })).toEqual({ x: 10, y: 21.5 }); // diagonal, y dominant
      expect(edgeFor({ x: 1, y: 1 })).toEqual({ x: -1.5, y: 10 }); // exact tie: x edges first
      expect(edgeFor({ x: -1, y: 1 })).toEqual({ x: 21.5, y: 10 }); // tie: right before top
      expect(edgeFor({ x: 0, y: 0 })).toEqual({ x: -1.5, y: 10 }); // zero wind: left
      // along a top/bottom edge the lateral jitter runs in x
      const top = eddyTrainSpawns(withTrain({ wind: { x: 0, y: 1 } }, { lateralJitter: 1, period: 4 }));
      expect(top.every((sp) => sp.center.y === -1.5 && sp.center.x >= -1e-12 && sp.center.x <= 20 + 1e-12)).toBe(true);
      expect(new Set(top.map((sp) => sp.center.x)).size).toBeGreaterThan(10);
    });

    it('spawned eddies enter the state at their step and carry key, sign and core', () => {
      const config = withTrain({ vortices: [vortex('eddy-a', 5, 5, 3, 1)] }, { firstStep: 0, period: 20 });
      const s0 = vortexStateAt(config, 0);
      expect(s0.map((v) => v.key)).toEqual(['eddy-a', 'train-0']); // a spawn at step 0 is in the initial state
      expect(s0[1]).toEqual({ key: 'train-0', center: eddyTrainSpawns(config)[0].center, circulation: 4, coreRadius: 1.5 });
      expect(vortexStateAt(config, 19).map((v) => v.key)).toEqual(['eddy-a', 'train-0']);
      const s20 = vortexStateAt(config, 20);
      expect(s20.map((v) => v.key)).toEqual(['eddy-a', 'train-0', 'train-1']);
      expect(s20[2].center).toEqual(eddyTrainSpawns(config)[1].center); // unmoved on its spawn step
      expect(s20[2].circulation).toBe(-4);
      const [snap] = simulate(config, [20]);
      expect(snap.vortices).toEqual(s20);
    });

    it('removes eddies beyond removeMargin and keeps static vortices', () => {
      const config = withTrain({ vortices: [vortex('eddy-a', 18, 5, 3, 1)] }, { period: 100, removeMargin: 2.2 });
      // train-0 starts at x = -1.5 and moves 0.5 m/step: x_n = -1.5 + 0.5 n; beyond 22.2 from n = 48
      expect(trainKeys(config, 47)).toEqual(['train-0']);
      expect(trainKeys(config, 48)).toEqual([]);
      expect(trainKeys(config, 100)).toEqual(['train-1']); // the next spawn arrives at step 100
      // the static vortex also left the domain but is never removed
      const s120 = vortexStateAt(config, 120);
      const a = s120.find((v) => v.key === 'eddy-a');
      expect(a?.center.x).toBeGreaterThan(22.2);
    });

    it('evicts the oldest train eddy at maxActive and stays bounded', () => {
      const config = withTrain({}, { period: 5, maxActive: 3, removeMargin: 1e6 });
      expect(trainKeys(config, 50)).toEqual(['train-8', 'train-9', 'train-10']);
      expect(trainKeys(config, 10)).toEqual(['train-0', 'train-1', 'train-2']);
      expect(trainKeys(config, 15)).toEqual(['train-1', 'train-2', 'train-3']);
      for (let step = 0; step <= LIMITS.maxSteps; step += 13) expect(trainKeys(config, step).length).toBeLessThanOrEqual(3);
      // with the default margin the count is also bounded by what is inside/near the domain
      const dense = withTrain({}, { period: 2, maxActive: LIMITS.maxTrainEddies, removeMargin: 3 });
      let most = 0;
      for (let step = 0; step <= LIMITS.maxSteps; step += 7) most = Math.max(most, trainKeys(dense, step).length);
      expect(most).toBeLessThanOrEqual(LIMITS.maxTrainEddies);
    });

    it('validates the train', () => {
      const bad = (t: Partial<EddyTrain>, over: Partial<Parameters<typeof makeConfig>[0]> = {}): void => {
        expect(() => buildDomain(withTrain(over, t)), JSON.stringify({ t, over })).toThrow(RangeError);
      };
      bad({}, { eddyDrift: 'fixed' });
      expect(() => buildDomain({ ...withTrain(), eddyDrift: undefined })).toThrow(/requires eddyDrift/);
      bad({ period: 0 }); bad({ period: 2.5 }); bad({ firstStep: -1 }); bad({ circulation: 0 }); bad({ coreRadius: 0 });
      bad({ lateralJitter: 1.1 }); bad({ timingJitter: -1 }); bad({ timingJitter: 10, period: 20 }); bad({ firstStep: 1, timingJitter: 2 });
      bad({ seed: -1 }); bad({ removeMargin: -1 }); bad({ maxActive: 0 }); bad({ maxActive: LIMITS.maxTrainEddies + 1 });
      bad({ circulation: Number.NaN });
      expect(() => buildDomain(withTrain({ vortices: [vortex('train-7', 5, 5, 1, 1)] }))).toThrow(RangeError);
      expect(() => buildDomain(withTrain({ eddyDrift: 'kirchhoff' }))).not.toThrow();
    });

    it('is deterministic and resumes bitwise between spawns and exactly at a spawn step', () => {
      const config = withTrain({
        boundary: 'inflow', eddyDrift: 'kirchhoff', diffusivity: 0.1, wind: { x: 0.8, y: 0.1 },
        front: { id: 'weather-front', kind: 'frozen-field', amplitude: 1, scale: 3, coverage: 0.5, seed: 99, fillInterior: true },
        vortices: [vortex('eddy-a', 12, 10, 6, 1.5)], solids: [rect('solid-a', 14, 6, 15, 8)], amplitude: 1,
      }, { firstStep: 4, period: 20, timingJitter: 3, lateralJitter: 0.6 });
      const spawns = eddyTrainSpawns(config).map((sp) => sp.step);
      const direct = simulate(config, [80])[0];
      expect(simulate(config, [80])[0].densityHash).toBe(direct.densityHash);
      expect(direct.vortices.length).toBeGreaterThan(2);
      for (const resumeAt of [spawns[1] - 7, spawns[1], spawns[2], 33]) {
        const half = advance(initialSnapshot(config), config, resumeAt);
        const resumed = advance(parseSnapshot(serializeSnapshot(half)), config, 80 - resumeAt);
        expect(resumed.densityHash, `resume at ${resumeAt}`).toBe(direct.densityHash);
        expect(resumed.density).toEqual(direct.density);
        expect(resumed.vortices).toEqual(direct.vortices);
        expect(resumed.mass).toEqual(direct.mass);
      }
    });

    it('a thin wall stays leak-free while train eddies cross it', () => {
      const wallX = 12.1;
      const wall = rect('solid-wall', wallX - 0.0125, -1, wallX + 0.0125, 21);
      const steps = [4, 8, 12, 20, 30, 60, 120];
      const rightMax = (c: CloudStudyConfig): number => {
        let m = 0;
        for (const snap of simulate(c, steps)) snap.density.forEach((v, k) => { if (((k % 40) + 0.5) * 0.5 > wallX) m = Math.max(m, v); });
        return m;
      };
      for (const diffusivity of [0, 0.3]) {
        const base = {
          boundary: 'closed' as const, eddyDrift: 'kirchhoff' as const, diffusivity, wind: { x: 1, y: 0 },
          center: { x: 5, y: 10 }, radii: { x: 2.5, y: 2.5 }, amplitude: 1,
          eddyTrain: train({ period: 12, circulation: 8, lateralJitter: 0.3 }),
        };
        const [late] = simulate(makeConfig({ ...base, solids: [wall] }), [60]);
        expect(late.vortices.some((v) => v.key.startsWith('train-') && v.center.x > wallX)).toBe(true); // eddies crossed the wall line
        const leaked = rightMax(makeConfig({ ...base, solids: [wall] }));
        const control = rightMax(makeConfig(base));
        console.log(`[cloud-advection] eddy train crossing a thin wall (D=${diffusivity}): max right-side = ${leaked}; no-wall control = ${control.toFixed(3)}`);
        expect(leaked).toBe(0);
        expect(control).toBeGreaterThan(0.01);
      }
    });

    it('any train field change invalidates snapshots; the train is hashed only when present', () => {
      const base = withTrain({ eddyDrift: 'kirchhoff' }, { firstStep: 2 });
      const h0 = configHashes(base);
      const snap = initialSnapshot(base);
      const changes: Array<Partial<EddyTrain>> = [
        { period: 21 }, { firstStep: 3 }, { circulation: 5 }, { coreRadius: 1.4 }, { alternate: false },
        { lateralJitter: 0.4 }, { timingJitter: 1 }, { seed: 8 }, { removeMargin: 4 }, { maxActive: 5 },
      ];
      for (const change of changes) {
        const changed = withTrain({ eddyDrift: 'kirchhoff' }, { firstStep: 2, ...change });
        const h1 = configHashes(changed);
        expect(h1.simulation, JSON.stringify(change)).not.toBe(h0.simulation);
        expect(h1.geometry).toBe(h0.geometry);
        expect(h1.transform).toBe(h0.transform);
        expect(() => advance(snap, changed, 1), JSON.stringify(change)).toThrow(SnapshotMismatchError);
      }
      const without = { ...structuredClone(base), eddyTrain: undefined };
      expect(configHashes(without).simulation).not.toBe(h0.simulation);
      expect(() => advance(snap, without, 1)).toThrow(SnapshotMismatchError);
      expect(configHashes({ ...without, eddyTrain: undefined })).toEqual(configHashes(without));
    });

    it('art-like config with a period-20 train and ~30 solids fits the time budget', () => {
      const solids: SolidRegion[] = [];
      for (let i = 0; i < 30; i++) {
        const ang = i * 2.399;
        const cx = 24 + 16 * Math.cos(ang) * ((i % 7) / 7 + 0.3);
        const cy = 39 + 30 * Math.sin(ang) * ((i % 5) / 5 + 0.3);
        solids.push({
          id: `solid-${i}`, kind: 'solid',
          polygon: Array.from({ length: 6 }, (_, k) => {
            const t = (k / 6) * 2 * Math.PI;
            const r = 1.2 + 0.5 * (k % 2);
            return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
          }),
        });
      }
      const config = makeConfig({
        cols: 120, rows: 195, spacing: 0.4, dt: 0.25, boundary: 'inflow', diffusivity: 0.05, eddyDrift: 'kirchhoff',
        wind: { x: 0.9, y: 0.35 }, solids, amplitude: 1,
        vortices: [vortex('eddy-1', 20, 30, 12, 2), vortex('eddy-2', 30, 55, -9, 3), vortex('eddy-3', 25, 42, 7, 2)],
        center: { x: 12, y: 20 }, radii: { x: 6, y: 9 },
        front: { id: 'weather-front', kind: 'frozen-field', amplitude: 1, scale: 8, coverage: 0.45, seed: 9, fillInterior: true },
        eddyTrain: train({ period: 20, circulation: 8, coreRadius: 2.5, removeMargin: 6, maxActive: 12, lateralJitter: 0.7, timingJitter: 3, firstStep: 3 }),
      });
      const t0 = performance.now();
      const snaps = simulate(config, [0, 60, 120, 240]);
      const ms = performance.now() - t0;
      const counts = snaps.map((snap) => snap.vortices.length);
      console.log(`[cloud-advection] eddy-train art config (30 solids, kirchhoff, inflow, D on), steps 0..240: ${ms.toFixed(0)} ms; active vortices at 0/60/120/240 = ${counts.join('/')}`);
      for (const snap of snaps) {
        let min = Infinity, max = -Infinity;
        for (const c of snap.density) { expect(Number.isFinite(c)).toBe(true); min = Math.min(min, c); max = Math.max(max, c); }
        expect(min).toBeGreaterThanOrEqual(0);
        expect(max).toBeLessThanOrEqual(1 + 1e-9);
      }
      expect(ms).toBeLessThan(4000);
      expect(counts[3]).toBeGreaterThan(3); // the train is still alive at the end
    });
  });

  it('simulate returns ascending unique steps', () => {
    expect(simulate(makeConfig(), [5, 0, 5, 2]).map((s) => s.step)).toEqual([0, 2, 5]);
  });

  it('bounds diffusion work', () => {
    // 100x100, h=0.1, dt=0.25, D=5 needs 625 substeps/step (was ~9 s); rejected up front.
    const heavy = makeConfig({ cols: 100, rows: 100, spacing: 0.1, dt: 0.25, diffusivity: 5 });
    const t0 = performance.now();
    expect(() => buildDomain(heavy)).toThrow(/substeps/);
    expect(() => simulate(heavy, [240])).toThrow(RangeError);
    expect(() => initialSnapshot(heavy)).toThrow(RangeError);
    // an effectively unbounded substep count (used to loop forever)
    expect(() => buildDomain(makeConfig({ dt: 1e308, diffusivity: 1e308 }))).toThrow(RangeError);
    expect(performance.now() - t0).toBeLessThan(500);
    // exactly the cap is fine: 15 substeps per step
    const capped = makeConfig({ cols: 10, rows: 10, diffusivity: 1.5 });
    expect(simulate(capped, [3])[0].step).toBe(3);
    expect(() => buildDomain(makeConfig({ cols: 10, rows: 10, diffusivity: 2 }))).toThrow(/substeps/);
  });

  it('bounds total work: cells x steps x substeps', () => {
    // 316x316 = 99,856 cells, 5 substeps, 240 steps = 119.8M > 90M
    const big = makeConfig({ cols: 316, rows: 316, diffusivity: 0.35, center: { x: 80, y: 80 }, radii: { x: 10, y: 10 } });
    const t0 = performance.now();
    expect(() => simulate(big, [240])).toThrow(/cell updates/);
    const snap = initialSnapshot(big);
    expect(() => advance(snap, big, 240)).toThrow(/cell updates/);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('rejects forged snapshots on parse and advance', () => {
    const config = makeConfig({ wind: { x: 0.5, y: 0 } });
    const snap = advance(initialSnapshot(config), config, 4);
    const forge = (mut: (s: Record<string, unknown>) => void): Record<string, unknown> => {
      const copy = JSON.parse(serializeSnapshot(snap)) as Record<string, unknown>;
      mut(copy);
      return copy;
    };
    const parses = (o: Record<string, unknown>): void => { parseSnapshot(JSON.stringify(o)); };
    const advances = (o: Record<string, unknown>): void => { advance(o as unknown as typeof snap, config, 1); };
    expect(() => advances(forge(() => {}))).not.toThrow();

    // step: not an integer, negative, or beyond the limit
    for (const step of [1.5, -1, LIMITS.maxSteps + 1]) {
      const o = forge((s) => { s.step = step; s.timeS = step * 0.5; });
      expect(() => parses(o), `parse step ${step}`).toThrow(/step/);
      expect(() => advances(o), `advance step ${step}`).toThrow(SnapshotMismatchError);
    }
    // forged step with consistent everything else: timeS no longer equals step*dt
    expect(() => advances(forge((s) => { s.step = 7; }))).toThrow(/timeS/);
    expect(() => advances(forge((s) => { s.timeS = 2.0000001; }))).toThrow(/timeS/);

    // density: NaN (as null in JSON), negative, and in-memory NaN/negative with a recomputed hash
    expect(() => parses(forge((s) => { (s.density as Array<number | null>)[5] = null; }))).toThrow(/finite/);
    expect(() => parses(forge((s) => { (s.density as number[])[5] = -0.25; }))).toThrow(/nonnegative/);
    for (const bad of [Number.NaN, -0.25, Infinity]) {
      const density = [...snap.density];
      density[5] = bad;
      const o = { ...snap, density, densityHash: hashFloat64(density) };
      expect(() => advance(o, config, 1), `advance density ${bad}`).toThrow(SnapshotMismatchError);
    }

    // mass: current must match the density; initial must match the config's source
    expect(() => parses(forge((s) => { (s.mass as { current: number }).current *= 1.001; }))).toThrow(/mass\.current/);
    expect(() => advances(forge((s) => { (s.mass as { initial: number }).initial *= 1.001; }))).toThrow(/mass\.initial/);
  });

  it('7. art-like config stays finite and nonnegative within the time budget', () => {
    const config = makeConfig({
      cols: 120, rows: 195, spacing: 0.4, dt: 0.25, boundary: 'closed', diffusivity: 0.05,
      wind: { x: 0.9, y: 0.35 },
      vortices: [vortex('eddy-1', 20, 30, 12, 2), vortex('eddy-2', 30, 55, -9, 3)],
      center: { x: 12, y: 20 }, radii: { x: 6, y: 9 },
      solids: [
        rect('solid-a', 22, 15, 30, 24),
        { id: 'solid-b', kind: 'solid', polygon: [{ x: 8, y: 50 }, { x: 14, y: 46 }, { x: 18, y: 52 }, { x: 14, y: 58 }, { x: 8, y: 57 }] },
        rect('solid-thin', 30, 28, 30.02, 60), // thinner than a cell
        { id: 'solid-c', kind: 'solid', polygon: [{ x: 38, y: 40 }, { x: 44, y: 70 }, { x: 34, y: 66 }] },
      ],
    });
    const t0 = performance.now();
    const snaps = simulate(config, [0, 30, 60, 120]);
    const ms = performance.now() - t0;
    const last = snaps[snaps.length - 1];
    console.log(`[cloud-advection] art-like 120x195, 120 steps, D on: ${ms.toFixed(0)} ms, relativeDrift = ${last.mass.relativeDrift.toExponential(3)}`);
    for (const s of snaps) {
      let min = Infinity;
      for (const c of s.density) { expect(Number.isFinite(c)).toBe(true); min = Math.min(min, c); }
      expect(min).toBeGreaterThanOrEqual(0);
    }
    expect(ms).toBeLessThan(2000);
    expect(sum(last.density)).toBeGreaterThan(0);
  });

  it('8. resuming from a serialized snapshot matches an uninterrupted run', () => {
    const config = makeConfig({
      boundary: 'closed', diffusivity: 0.1, wind: { x: 0.8, y: 0.2 },
      vortices: [vortex('eddy-1', 12, 10, 8, 1.5)], solids: [rect('solid-a', 14, 6, 15, 14)],
    });
    const [direct] = simulate(config, [60]);
    const [again] = simulate(config, [60]);
    const half = advance(initialSnapshot(config), config, 30);
    const resumed = advance(parseSnapshot(serializeSnapshot(half)), config, 30);
    expect(resumed.densityHash).toBe(direct.densityHash);
    expect(resumed.density).toEqual(direct.density);
    expect(resumed.mass).toEqual(direct.mass);
    expect(again.density).toEqual(direct.density);
    expect(again.densityHash).toBe(direct.densityHash);
    // never mutates its input
    const before = [...half.density];
    advance(half, config, 5);
    expect(half.density).toEqual(before);
    expect(half.step).toBe(30);
  });

  it('9. invalidation: changed inputs throw and move the expected hash component', () => {
    const base = makeConfig({
      wind: { x: 0.5, y: 0 }, solids: [rect('solid-a', 14, 6, 15, 14)],
    });
    const snap = initialSnapshot(base);
    const clone = (): CloudStudyConfig => structuredClone(base);
    const cases: Array<[string, (c: CloudStudyConfig) => void, 'geometry' | 'transform' | 'simulation']> = [
      ['dt', (c) => { c.settings.dt = 0.4; }, 'simulation'],
      ['solid vertex', (c) => { c.solids[0].polygon[0].x += 0.1; }, 'geometry'],
      ['worldToPage.scale', (c) => { c.transforms.worldToPage.scale = 4; }, 'transform'],
      ['wind', (c) => { c.wind.velocity.x = 0.6; }, 'simulation'],
      ['source seed', (c) => { c.source.seed += 1; }, 'simulation'],
    ];
    const h0 = configHashes(base);
    for (const [label, mutate, component] of cases) {
      const changed = clone();
      mutate(changed);
      const h1 = configHashes(changed);
      for (const key of ['geometry', 'transform', 'simulation'] as const) {
        if (key === component) expect(h1[key], `${label}: ${key} should change`).not.toBe(h0[key]);
        else expect(h1[key], `${label}: ${key} should not change`).toBe(h0[key]);
      }
      expect(h1.stateKey, `${label}: stateKey`).not.toBe(h0.stateKey);
      expect(() => advance(snap, changed, 1), label).toThrow(SnapshotMismatchError);
    }
    // identical config with shuffled key order is the same state
    const shuffled = {
      solids: base.solids, source: base.source, vortices: base.vortices, wind: base.wind,
      settings: { diffusivity: 0, boundary: base.settings.boundary, dt: base.settings.dt },
      transforms: base.transforms, domain: base.domain,
    } as CloudStudyConfig;
    expect(configHashes(shuffled)).toEqual(h0);
    expect(stableHash({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(stableHash({ b: { d: 'x', c: [1, 2] }, a: 1 }));
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
    expect(stableHash('x')).toMatch(/^[0-9a-f]{16}$/);
    expect(() => stableHash({ a: Number.NaN })).toThrow(RangeError);
    expect(() => stableHash([Infinity])).toThrow(RangeError);
    // tampered density is caught on advance as well
    const tampered = { ...snap, density: snap.density.map((v, k) => (k === 0 ? v + 1 : v)) };
    expect(() => advance(tampered, base, 1)).toThrow(SnapshotMismatchError);
    // step limit
    expect(() => advance(snap, base, LIMITS.maxSteps + 1)).toThrow(RangeError);
    expect(() => advance(snap, base, 1.5)).toThrow(RangeError);
  });

  it('10. parseSnapshot rejects tampered or non-finite density', () => {
    const snap = initialSnapshot(makeConfig());
    const text = serializeSnapshot(snap);
    expect(parseSnapshot(text)).toEqual(snap);
    const firstNonZero = snap.density.findIndex((v) => v > 0);
    const edited = JSON.parse(text) as { density: number[] };
    edited.density[firstNonZero] += 1e-9;
    expect(() => parseSnapshot(JSON.stringify(edited))).toThrow(/densityHash/);
    const nan = JSON.parse(text) as { density: Array<number | null> };
    nan.density[3] = null; // JSON.stringify(NaN) === 'null'
    expect(() => parseSnapshot(JSON.stringify(nan))).toThrow(/finite/);
    const short = JSON.parse(text) as { density: number[] };
    short.density.pop();
    expect(() => parseSnapshot(JSON.stringify(short))).toThrow(/length/);
    expect(() => parseSnapshot(JSON.stringify({ ...JSON.parse(text), schema: 'nope' }))).toThrow(/schema/);
  });
});

describe('cloud advection: helpers', () => {
  it('hashFloat64 hashes exact bytes', () => {
    expect(hashFloat64([1, 2, 3])).toBe(hashFloat64(new Float64Array([1, 2, 3])));
    expect(hashFloat64([1, 2, 3])).not.toBe(hashFloat64([1, 2, 3.0000000000000004]));
    expect(hashFloat64([])).toBe('cbf29ce484222325');
  });

  it('velocityAt is wind plus regularized vortices', () => {
    const config = makeConfig({ wind: { x: 1, y: 2 }, vortices: [vortex('eddy-1', 5, 5, 2 * Math.PI, 1)] });
    expect(velocityAt(config, { x: 5, y: 5 })).toEqual({ x: 1, y: 2 });
    const v = velocityAt(config, { x: 7, y: 5 }); // dx = 2: (-dy, dx)/(dx²+core²) = (0, 2/5)
    expect(v.x).toBeCloseTo(1, 12);
    expect(v.y).toBeCloseTo(2.4, 12);
  });

  it('buildDomain validates configs', () => {
    const bad = (mutate: (c: CloudStudyConfig) => void): void => {
      const c = makeConfig();
      mutate(c);
      expect(() => buildDomain(c)).toThrow(RangeError);
    };
    bad((c) => { c.settings.dt = 0; });
    bad((c) => { c.transforms.worldToGrid.spacing = -1; });
    bad((c) => { c.wind.velocity.x = Number.NaN; });
    bad((c) => { c.domain.size.x = 21; });
    bad((c) => { c.solids = [{ id: 'solid-x', kind: 'solid', polygon: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]; });
    expect(() => buildDomain(makeConfig({ cols: 400, rows: 400 }))).toThrow(RangeError);
  });

  it('sampleDensity matches bilinear interpolation and respects walls', () => {
    const config = makeConfig({ cols: 10, rows: 10, spacing: 1, boundary: 'closed', solids: [rect('solid-w', 4.95, -1, 5.05, 11)] });
    const domain = buildDomain(config);
    const density = new Array<number>(100).fill(0);
    for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) density[j * 10 + i] = i < 5 ? 1 : 3;
    expect(sampleDensity(domain, density, { x: 2.5, y: 5 })).toBe(1);
    expect(sampleDensity(domain, density, { x: 4.9, y: 5 })).toBe(1); // left of wall: only left corners count
    expect(sampleDensity(domain, density, { x: 5.1, y: 5 })).toBe(3);
    const free = buildDomain(makeConfig({ cols: 10, rows: 10, spacing: 1 }));
    expect(sampleDensity(free, density, { x: 5, y: 5 })).toBeCloseTo(2, 12);
  });
});
