import { describe, expect, it } from 'vitest';
import { LIMITS, type CloudStudyConfig, type SolidRegion, type Vec2, type Vortex } from '../../sketches/cloud-advection/model.ts';
import {
  SnapshotMismatchError,
  advance,
  buildDomain,
  configHashes,
  hashFloat64,
  initialSnapshot,
  parseSnapshot,
  sampleDensity,
  serializeSnapshot,
  simulate,
  stableHash,
  velocityAt,
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
}

function makeConfig(over: Partial<Opts> = {}): CloudStudyConfig {
  const o: Opts = {
    cols: 40, rows: 40, spacing: 0.5, dt: 0.5, boundary: 'open', diffusivity: 0,
    wind: { x: 0, y: 0 }, vortices: [], solids: [],
    center: { x: 6, y: 10 }, radii: { x: 3, y: 3 }, seed: 1234,
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
      amplitude: 1, noiseScale: 2.5, seed: o.seed,
    },
    solids: o.solids,
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
    // 316x316 = 99,856 cells, 3 substeps, 240 steps = 71.9M > 60M
    const big = makeConfig({ cols: 316, rows: 316, diffusivity: 0.25, center: { x: 80, y: 80 }, radii: { x: 10, y: 10 } });
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
