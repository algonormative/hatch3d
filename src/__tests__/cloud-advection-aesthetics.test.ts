import { describe, expect, it } from 'vitest';
import { buildCandidates, repairFrames, snapToControl, stepCap } from '../../sketches/cloud-advection/explore.ts';
import { resolveFinishing } from '../../packages/plot-core/src/index.ts';
import {
  BANDS, LIMITS, MEASURE, PROFILES, interiorInk, sunGeometry, balance, bandDesirability, connectedComponents, componentStats, coreHalo, frameContact, frameGeometry, frameMetrics, jaccardDistance,
  latinHypercube, occupancy, resamplePaths, ropeAndSpacing, score, type FrameGeometry, type FramePart, type FrameMetrics, type Pt,
} from '../../sketches/cloud-advection/aesthetics.ts';

const content = { xMin: 12, yMin: 12, xMax: 267, yMax: 420 };
const geometry: FrameGeometry = { content, core: { x: 139.5, y: 216, r: 44 } };
const line = (x0: number, y0: number, x1: number, y1: number): Pt[] => [{ x: x0, y: y0 }, { x: x1, y: y1 }];
const cloud = (...paths: Pt[][]): FramePart[] => [{ id: 'cloud-cyan', pen: 'cyan', paths }];
const samplesOf = (paths: Pt[][]) => resamplePaths(paths);
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 },
];
const circle = (cx: number, cy: number, r: number, n = 180): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));

describe('cloud-advection aesthetics', () => {
  it('resamples to the exact path length with sub-step spacing', () => {
    const samples = samplesOf([line(0, 0, 10.3, 0), rect(0, 0, 4, 3)]);
    const total = samples.reduce((s, p) => s + p.weight, 0);
    expect(total).toBeCloseTo(10.3 + 14, 9);
    expect(Math.max(...samples.map(p => p.weight))).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('ropeIndex is high for lines 0.3 mm apart and zero for 3 mm apart', () => {
    const near = ropeAndSpacing(samplesOf([line(50, 100, 150, 100), line(50, 100.3, 150, 100.3)]), 2);
    const far = ropeAndSpacing(samplesOf([line(50, 100, 150, 100), line(50, 103, 150, 103)]), 2);
    expect(near.ropeIndex).toBeGreaterThan(0.95);
    expect(far.ropeIndex).toBe(0);
    // A lone path has no neighbour on another path.
    expect(ropeAndSpacing(samplesOf([line(0, 0, 50, 0)]), 2)).toEqual({ ropeIndex: 0, spacingCV: 0 });
  });

  it('spacingCV is near zero for evenly spaced sweeps and larger for uneven ones', () => {
    const even = [0, 2, 4, 6, 8].map(k => line(50, 100 + k, 150, 100 + k));
    const uneven = [0, 1, 2.5, 6, 8.8].map(k => line(50, 100 + k, 150, 100 + k));
    // Edge lines see only one neighbour; a long first-to-last chain stays even for even spacing.
    expect(ropeAndSpacing(samplesOf(even), 2).spacingCV).toBeLessThan(0.05);
    expect(ropeAndSpacing(samplesOf(uneven), 2).spacingCV).toBeGreaterThan(0.3);
  });

  it('frameContact is about 1 for ink along the frame band, and balance is computed', () => {
    const ring = [rect(18, 18, 261, 414)];
    const samples = samplesOf(ring);
    expect(frameContact(samples, content)).toBeGreaterThan(0.97);
    const b = balance(samples, content);
    expect(b).toBeGreaterThan(0.8);
    expect(b).toBeLessThanOrEqual(1);
    // Ink only in the middle of the page touches no frame segment.
    expect(frameContact(samplesOf([line(100, 200, 180, 230)]), content)).toBe(0);
    // Ink in one place only is unbalanced.
    expect(balance(samplesOf([line(20, 20, 40, 30)]), content)).toBe(0);
  });

  it('coreHalo is an absolute density: ink in the annulus over a fixed 40 m/m2 reference, 0 away from it', () => {
    const halo = coreHalo(samplesOf([circle(139.5, 216, 60)]), geometry);
    const area = Math.PI * ((MEASURE.haloOuter * 44) ** 2 - 44 ** 2);
    expect(halo).toBeCloseTo(((2 * Math.PI * 60) / area) * 1000 / MEASURE.haloReference, 1);
    expect(halo).toBeGreaterThan(0.9);
    expect(coreHalo(samplesOf([circle(139.5, 216, 50), circle(139.5, 216, 56), circle(139.5, 216, 62), circle(139.5, 216, 68)]), geometry)).toBeGreaterThan(LIMITS.maxCoreHalo);
    // Unlike the old ratio, adding unrelated ink elsewhere does not change it.
    const withFar = coreHalo(samplesOf([circle(139.5, 216, 60), line(20, 20, 250, 20), line(20, 400, 250, 400)]), geometry);
    expect(withFar).toBeCloseTo(halo, 6);
    expect(coreHalo(samplesOf([line(20, 20, 60, 20)]), geometry)).toBe(0);
    // Ink inside the core itself is not halo.
    expect(coreHalo(samplesOf([circle(139.5, 216, 20)]), geometry)).toBe(0);
    expect(coreHalo(samplesOf([line(20, 20, 60, 20)]), { ...geometry, core: { ...geometry.core, r: 0 } })).toBe(0);
  });

  it('change is 0 for identical frames and 1 for disjoint ones', () => {
    expect(MEASURE.occupancyCellMm).toBe(20);
    const a = occupancy(cloud(line(20, 30, 170, 30)), content);
    const same = occupancy(cloud(line(20, 30, 170, 30)), content);
    const elsewhere = occupancy(cloud(line(20, 300, 170, 300)), content);
    expect(a.size).toBeGreaterThanOrEqual(7);
    expect(jaccardDistance(a, same)).toBe(0);
    expect(jaccardDistance(a, elsewhere)).toBe(1);
    expect(jaccardDistance(new Set(), new Set())).toBe(0);
    const half = occupancy(cloud(line(20, 30, 90, 30)), content);
    // Same weather shifted a little reads as small change; unrelated frames read as 1.
    const shifted = occupancy(cloud(line(32, 30, 182, 30)), content);
    expect(jaccardDistance(a, shifted)).toBeLessThan(0.35);
    expect(jaccardDistance(a, half)).toBeGreaterThan(0.2);
    expect(jaccardDistance(a, half)).toBeLessThan(0.8);
  });

  it('coherence counts 8-connected components of the 8 mm occupancy grid', () => {
    const one = occupancy(cloud(line(20, 30, 120, 30), line(20, 38, 120, 38)), content, MEASURE.coherenceCellMm);
    expect(connectedComponents(one)).toBe(1);
    const diagonal = occupancy(cloud(line(20, 30, 60, 70)), content, MEASURE.coherenceCellMm);
    expect(connectedComponents(diagonal)).toBe(1);
    const specks = occupancy(cloud(line(20, 30, 24, 30), line(60, 30, 64, 30), line(100, 30, 104, 30), line(20, 100, 24, 100)), content, MEASURE.coherenceCellMm);
    expect(connectedComponents(specks)).toBe(4);
    expect(connectedComponents(new Set())).toBe(0);
    expect(MEASURE.coherenceCellMm).toBe(8);
    const parts = cloud(line(20, 30, 120, 30), line(60, 100, 64, 100));
    const m = frameMetrics({ parts, geometry, cloudHatchPitch: 2 }, 0);
    expect(m.coherence).toBe(2);
    // largestShare: the 100 mm line holds 100 of 104 mm of ink.
    expect(m.largestShare).toBeCloseTo(100 / 104, 6);
    expect(componentStats(samplesOf([line(20, 30, 120, 30)]), content).largestShare).toBe(1);
    // Four equal specks: each holds a quarter of the ink.
    const specks4 = [line(20, 30, 24, 30), line(60, 30, 64, 30), line(100, 30, 104, 30), line(20, 100, 24, 100)];
    expect(componentStats(samplesOf(specks4), content)).toEqual({ coherence: 4, largestShare: 0.25 });
    expect(componentStats([], content)).toEqual({ coherence: 0, largestShare: 0 });
  });

  it('frameMetrics combines ink, concealment, fill and points, ignoring diagnostics and the border', () => {
    const parts: FramePart[] = [
      ...cloud(line(20, 100, 120, 100)),
      { id: 'structure-a01', pen: 'carbon', paths: [line(20, 200, 70, 200)] },
      { id: 'finishing-border', pen: 'carbon', paths: [rect(12, 12, 267, 420)] },
      { id: 'cloud-state-step-30', pen: 'cyan', paths: [line(0, 0, 500, 0)], diagnostic: true },
    ];
    const m = frameMetrics({ parts, geometry, cloudHatchPitch: 2 }, 0.1);
    expect(m.cloudInkM).toBeCloseTo(0.1, 9);
    expect(m.structureInkM).toBeCloseTo(0.05, 9);
    expect(m.concealment).toBeCloseTo(0.5, 9);
    expect(m.points).toBe(2 + 2 + 5);
    expect(m.fill).toBeCloseTo(0.1 / (255 * 408 / 1e6), 6);
    expect(frameMetrics({ parts, geometry, cloudHatchPitch: 2 }, 0).concealment).toBe(0);
  });

  it('maps the core through finishing like the sketch does', () => {
    const page = { width: 279.4, height: 431.8, margin: 18 };
    const pens = [{ id: 'carbon', color: '#222', width: 0.25 }];
    const finishing = resolveFinishing(page, pens, { border: { style: 'double', pen: 'carbon', inset: 12, contentGap: 0 } });
    const g = frameGeometry(page, finishing, { coreRadius: 44, coreX: 10, coreY: -20 });
    expect(g.content).toEqual(finishing.contentRect);
    expect(g.core.r).toBeCloseTo(44 * finishing.scale, 9);
    expect(g.core.x).toBeCloseTo((page.width / 2 + 10) * finishing.scale + finishing.offsetX, 9);
    expect(g.core.y).toBeCloseTo((page.height / 2 - 20) * finishing.scale + finishing.offsetY, 9);
    // Without offsets the core sits at the page centre.
    const centred = frameGeometry(page, finishing, { coreRadius: 44 });
    expect(centred.core.x).toBeCloseTo(page.width / 2, 6);
    expect(centred.core.y).toBeCloseTo(page.height / 2, 6);
  });

  it('bandDesirability is trapezoidal and one-sided bands work', () => {
    expect(bandDesirability(BANDS.ropeIndex, 0)).toBe(1);
    // Rope desirability keeps discriminating above the 0.12 hard limit, reaching 0 at 0.3.
    expect(bandDesirability(BANDS.ropeIndex, 0.3)).toBe(0);
    expect(bandDesirability(BANDS.ropeIndex, 0.15)).toBeCloseTo(0.5, 9);
    expect(bandDesirability(BANDS.ropeIndex, 0.12)).toBeGreaterThan(bandDesirability(BANDS.ropeIndex, 0.2));
    expect(bandDesirability(BANDS.fill, 20)).toBe(0);
    expect(bandDesirability(BANDS.fill, 35)).toBe(1);
    expect(bandDesirability(BANDS.coreHalo, 0.3)).toBe(1);
    expect(bandDesirability(BANDS.coreHalo, 1.5)).toBe(0);
    expect(LIMITS.maxCoreHalo).toBe(1.5);
    expect(bandDesirability(BANDS.spacingCV, 0.2)).toBe(1);
    expect(bandDesirability(BANDS.spacingCV, 0.4)).toBe(0);
    expect(bandDesirability(BANDS.largestShare, 0.35)).toBe(1);
    expect(bandDesirability(BANDS.largestShare, 0.1)).toBe(0);
    expect(bandDesirability(BANDS.coherence, 6)).toBe(1);
    expect(bandDesirability(BANDS.coherence, 25)).toBe(0);
    expect(bandDesirability(BANDS.concealment, 0.3)).toBe(1);
    expect(bandDesirability(BANDS.concealment, 0)).toBe(0);
    expect(bandDesirability(BANDS.balance, 1)).toBe(1);
    expect(bandDesirability(BANDS.balance, 0.5)).toBe(0);
  });

  const good: FrameMetrics = {
    cloudInkM: 4, structureInkM: 6, points: 20_000, ropeIndex: 0.01, spacingCV: 0.3, frameContact: 0.5,
    coreHalo: 0.1, concealment: 0.3, balance: 0.95, fill: 40, coherence: 4, largestShare: 0.5,
  };

  it('score separates feasibility from desirability and lists violations', () => {
    const ok = score({ frames: [good, good, good], change01: 0.5, change12: 0.5 });
    expect(ok.feasible).toBe(true);
    expect(ok.violations).toEqual([]);
    expect(ok.desirability).toBeGreaterThan(0.9);
    const bad = score({
      frames: [good, { ...good, ropeIndex: 0.3, points: 70_000 }, { ...good, frameContact: 0.1, coreHalo: 1.8 }],
      change01: 0.5, change12: 0.5,
    });
    expect(bad.feasible).toBe(false);
    expect(bad.violations).toHaveLength(4);
    const blank = score({ frames: [good, { ...good, fill: 10 }, good], change01: 0.5, change12: 0.5 });
    expect(blank.feasible).toBe(false);
    expect(blank.violations.join('\n')).toMatch(/frame 1: fill/);
    expect(bad.violations.join('\n')).toMatch(/frame 1: points/);
    expect(bad.violations.join('\n')).toMatch(/frame 2: coreHalo/);
    expect(bad.desirability).toBeLessThan(ok.desirability);
    // A frozen sequence is less desirable than one that changes.
    expect(score({ frames: [good, good, good], change01: 0, change12: 0 }).desirability).toBeLessThan(ok.desirability);
  });

  it('latinHypercube is deterministic and covers every stratum in every dimension', () => {
    const n = 24, dims = 5;
    const a = latinHypercube(n, dims, 7);
    expect(latinHypercube(n, dims, 7)).toEqual(a);
    expect(latinHypercube(n, dims, 8)).not.toEqual(a);
    expect(a).toHaveLength(n);
    for (let d = 0; d < dims; d++) {
      const strata = new Set(a.map(p => Math.floor(p[d] * n)));
      expect(strata.size).toBe(n);
      for (const p of a) { expect(p[d]).toBeGreaterThanOrEqual(0); expect(p[d]).toBeLessThan(1); }
    }
  });

  it('explore builds deterministic candidates with integer frame timing that fits the step cap', () => {
    const space = {
      base: { seed: 1, params: { windX: 0 } }, n: 40, seed: 5, steps: [0, 30, 60],
      ranges: { windX: [-1.5, 1.5] as [number, number], frameStart: [20, 120] as [number, number], frameDelta: [10, 45] as [number, number] },
    };
    const a = buildCandidates(space);
    expect(buildCandidates(space)).toEqual(a);
    expect(a).toHaveLength(41);
    expect(a[0]).toMatchObject({ id: 'c000', steps: [0, 30, 60], varied: { windX: 0, frameStart: 0, frameDelta: 30 } });
    for (const c of a.slice(1)) {
      const { frameStart, frameDelta } = c.varied;
      expect(Number.isInteger(frameStart) && Number.isInteger(frameDelta)).toBe(true);
      expect(c.steps).toEqual([frameStart, frameStart + frameDelta, frameStart + 2 * frameDelta]);
      expect(c.steps[2]).toBeLessThanOrEqual(stepCap());
      expect(frameDelta).toBeGreaterThanOrEqual(10);
      expect('frameStart' in c.params).toBe(false);
      expect(snapToControl('windX', c.params.windX as number)).toBe(c.params.windX);
    }
    // Over the cap, delta shrinks toward its minimum first, then start drops.
    const cap = stepCap();
    const fit = repairFrames(cap - 20, 40, 10);
    expect(fit.steps).toEqual([cap - 20, cap - 10, cap]);
    expect(repairFrames(cap, 40, 10).steps).toEqual([cap - 20, cap - 10, cap]);
    expect(repairFrames(20, 10, 10).steps).toEqual([20, 30, 40]);
    // Without frame ranges every candidate keeps the fallback steps.
    const plain = buildCandidates({ ...space, ranges: { windX: space.ranges.windX } });
    expect(plain.every(c => c.steps.join() === '0,30,60')).toBe(true);
  });

  it('precise profile: concealment band, interiorInk, and the default profile unchanged', () => {
    const precise = PROFILES.precise.bands;
    expect(bandDesirability(precise.concealment, 0)).toBe(1);
    expect(bandDesirability(precise.concealment, 0.12)).toBe(1);
    expect(bandDesirability(precise.concealment, 0.35)).toBe(0);
    expect(bandDesirability(precise.interiorInk, 15)).toBe(1);
    expect(bandDesirability(precise.interiorInk, 3)).toBe(0);
    expect(PROFILES.default.bands).toBe(BANDS);
    expect(PROFILES.default.perFrame).not.toContain('interiorInk');
    expect(BANDS.concealment).toEqual([0, 0.15, 0.45, 0.8]);
    const m: FrameMetrics = { ...good, concealment: 0.08, interiorInk: 20 };
    const metrics = { frames: [m, m, m], change01: 0.4, change12: 0.4 };
    expect(score(metrics, 'precise').desirability).toBeGreaterThan(score(metrics).desirability);
    expect(score(metrics).parts.interiorInk).toBeUndefined();
    expect(score(metrics, 'precise').parts.interiorInk).toBe(1);
    // A sun-less frame has no interior ink, so it scores badly in the precise profile.
    expect(score({ frames: [good, good, good], change01: 0.4, change12: 0.4 }, 'precise').parts.interiorInk).toBeCloseTo(0.01, 9);
  });

  it('sunGeometry maps world metres through the page mapping and finishing; interiorInk measures the ray band', () => {
    const finishing = { scale: 1.02, offsetX: 3, offsetY: 4, contentRect: content };
    const g = sunGeometry({ scale: 5, offset: { x: 10, y: 20 } }, finishing, { sunInner: 10, sunReach: 20 }, { x: 24, y: 39 });
    expect(g.x).toBeCloseTo((10 + 24 * 5) * 1.02 + 3, 9);
    expect(g.y).toBeCloseTo((20 + 39 * 5) * 1.02 + 4, 9);
    expect(g.inner).toBeCloseTo(10 * 5 * 1.02, 9);
    expect(g.reach).toBeCloseTo(20 * 5 * 1.02, 9);
    const geom: FrameGeometry = { content, core: { x: 139.5, y: 216, r: 40 }, sun: { x: 139.5, y: 216, inner: 54, reach: 100 } };
    // Ink on a circle of radius 77 (inside the band) vs radius 45 (inside inner) and 150 (outside reach).
    const inBand = interiorInk(samplesOf([circle(139.5, 216, 77)]), geom);
    expect(inBand).toBeGreaterThan(0);
    expect(inBand).toBeCloseTo(((2 * Math.PI * 77) / (Math.PI * (100 ** 2 - 54 ** 2))) * 1000, 0);
    expect(interiorInk(samplesOf([circle(139.5, 216, 45)]), geom)).toBe(0);
    expect(interiorInk(samplesOf([circle(139.5, 216, 105)]), geom)).toBe(0);
    expect(interiorInk(samplesOf([circle(139.5, 216, 77)]), { ...geom, sun: undefined })).toBe(0);
    // The lower radius is the larger of core radius and sunInner.
    const bigCore = interiorInk(samplesOf([circle(139.5, 216, 60)]), { ...geom, core: { ...geom.core, r: 70 } });
    expect(bigCore).toBe(0);
  });
});
