import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { inspectSketch, renderSketch } from '../../cli/sketch/runner.ts';
import { resolveFinishing, resolveParams } from '../../packages/plot-core/src/index.ts';
import { contourLines } from '../../sketches/borrowed-orbits/contour.ts';
import { criticalLevels, jacobiField, lagrangePoints, librationMode, potentialGradient, zeroVelocityCurves } from '../../sketches/borrowed-orbits/lagrange.ts';
import { makeMapper, plateScene, zeroVelocityLevels } from '../../sketches/borrowed-orbits/plates-extract.ts';
import { buildPlate, CATALOG, runPlate } from '../../sketches/borrowed-orbits/plates-study.ts';
import type { PlateStudy } from '../../sketches/borrowed-orbits/plates-study.ts';
import type { Params, SketchContext } from '../sketch/types.ts';

// Count every call that reaches the simulation, while still running the real one.
const simCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../sketches/borrowed-orbits/sim.ts', async importOriginal => {
  const mod = await importOriginal<typeof import('../../sketches/borrowed-orbits/sim.ts')>();
  const wrap = <F extends (...args: never[]) => unknown>(f: F): F => ((...args: Parameters<F>) => { simCalls.n++; return f(...args); }) as F;
  return { ...mod, history: wrap(mod.history), simulate: wrap(mod.simulate), advance: wrap(mod.advance), initialSnapshot: wrap(mod.initialSnapshot) };
});
const { default: sketch } = await import('../../sketches/borrowed-orbits/plates.ts');
const { configHashes, history } = await import('../../sketches/borrowed-orbits/sim.ts');

const entry = resolve('sketches/borrowed-orbits/plates.ts');
type Request = { seed: number; params: Params; finishing: Parameters<typeof resolveFinishing>[2] };
const config = (id: string): Request => JSON.parse(readFileSync(resolve(`sketches/borrowed-orbits/configs/plate-${id}.json`), 'utf8'));
type Result = Awaited<ReturnType<typeof renderSketch>>;
const render = (request: Request, params: Params = {}): Promise<Result> =>
  renderSketch({ entry, seed: request.seed, params: { ...request.params, ...params }, finishing: request.finishing });

function randomStream(seed: number, partId: string): () => number {
  const digest = createHash('sha256').update(`${seed}\0${partId}`).digest();
  let s = digest.readUInt32LE(0);
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const context = (id: string, params: Params = {}): SketchContext => {
  const request = config(id);
  return { params: resolveParams(sketch.controls, { ...request.params, ...params }) as Params, seed: request.seed, assets: {}, random: (x: string) => randomStream(request.seed, x) };
};
const study = (id: string, params: Params = {}): PlateStudy => buildPlate(context(id, params));
const integrate = (s: PlateStudy) => runPlate(s, history);
const IDS = ['hohmann', 'lagrange', 'lagrange-off', 'threebody-figure8', 'threebody-butterfly', 'threebody-moth', 'threebody-yinyang'];

/** Largest distance of a vertex from the chord of its neighbours, page mm (a bound on the polygonization of a smooth curve). */
function worstChord(s: PlateStudy, parts: string[]): number {
  const h = integrate(s);
  const scene = plateScene(s, h);
  const map = makeMapper(s, scene);
  let worst = 0;
  for (const line of scene.lines.filter(l => parts.includes(l.part))) {
    const pts = line.points.map(map.toPage);
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i + 1], p = pts[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      worst = Math.max(worst, Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / len);
    }
  }
  return worst;
}

describe('Orbit Plates sketch', () => {
  it('exposes the plate select, grouped per-plate controls and the pens', async () => {
    const metadata = await inspectSketch({ entry });
    expect(metadata.name).toBe('Orbit Plates');
    const byId = new Map(metadata.controls.map(c => [c.id, c]));
    expect(byId.get('plate')).toMatchObject({ type: 'select', options: ['hohmann', 'lagrange', 'threebody'], default: 'hohmann' });
    for (const [id, group] of [['orbitCount', 'Hohmann'], ['transferMode', 'Hohmann'], ['stagger', 'Hohmann'], ['tickScale', 'Hohmann'], ['massRatio', 'Lagrange'], ['zvcMode', 'Lagrange'], ['orbitBoundaries', 'Lagrange'], ['choreography', 'Three-body'], ['bodyPhase', 'Three-body'], ['orbitPen', 'Marks'], ['highlightPen', 'Marks'], ['referencePen', 'Marks']] as const) {
      expect(byId.get(id), id).toMatchObject({ group });
    }
    expect(byId.get('orbitCount')).toMatchObject({ min: 2, max: 6 });
    expect(byId.get('massRatio')).toMatchObject({ min: 0.001, max: 0.038 });
    expect(byId.get('orbitPen')).toMatchObject({ default: 'carbon' });
    expect(byId.get('highlightPen')).toMatchObject({ default: 'vermilion' });
    expect(byId.get('referencePen')).toMatchObject({ default: 'cyan' });
    expect(metadata.pens.map(p => p.id)).toContain('cyan');
  });

  it('renders every plate with finite points inside the finished content area, lines only', async () => {
    const request = config('hohmann');
    const content = resolveFinishing(sketch.page, sketch.pens, request.finishing).contentRect;
    for (const id of IDS) {
      const result = await render(config(id));
      expect(result.diagnostics, id).toEqual([]);
      const drawn = result.parts.filter(p => !p.diagnostic && p.id !== 'finishing-border');
      expect(drawn.length, id).toBeGreaterThan(1);
      for (const part of drawn) {
        for (const path of part.paths) for (const pt of path) {
          expect(Number.isFinite(pt.x) && Number.isFinite(pt.y)).toBe(true);
          expect(pt.x).toBeGreaterThanOrEqual(content.xMin - 1e-6);
          expect(pt.x).toBeLessThanOrEqual(content.xMax + 1e-6);
          expect(pt.y).toBeGreaterThanOrEqual(content.yMin - 1e-6);
          expect(pt.y).toBeLessThanOrEqual(content.yMax + 1e-6);
        }
      }
      // Pens are the three roles (orbit, highlight, reference), nothing else.
      expect(new Set(drawn.map(p => p.pen)).size, id).toBeLessThanOrEqual(3);
      expect(result.svg).not.toContain('<text');
    }
  }, 120000);

  it('keeps the stateKey when a mark-only control changes, and changes it for simulation controls', async () => {
    const marks: Record<string, Params[]> = {
      hohmann: [{ rotation: 33 }, { plateMargin: 0.2 }, { bodyRadius: 3 }, { orbitPen: 'gold' }, { highlightPen: 'coral' }, { tickScale: 3000 }, { showTransfers: false }, { showPlanets: false }, { autoOrient: false }],
      lagrange: [{ rotation: 33 }, { zvcMode: 'critical' }, { zvcCount: 2 }, { orbitBoundaries: true }, { showPoints: false }, { crossSize: 5 }, { referencePen: 'violet' }],
      'threebody-butterfly': [{ bodies: 'first' }, { bodyPhase: 0.4 }, { bodyRadius: 3 }, { rotation: 90 }],
    };
    for (const [id, variants] of Object.entries(marks)) {
      const key = configHashes(study(id).config).stateKey;
      for (const change of variants) expect(configHashes(study(id, change).config).stateKey, `${id} ${JSON.stringify(change)}`).toBe(key);
    }
    const hohmann = configHashes(study('hohmann').config).stateKey;
    for (const change of [{ orbitCount: 5 }, { spacing: 1.4 }, { stagger: 20 }, { transferMode: 'single' }, { departureStep: 50 }]) expect(configHashes(study('hohmann', change).config).stateKey).not.toBe(hohmann);
    const lagrange = configHashes(study('lagrange').config).stateKey;
    for (const change of [{ massRatio: 0.01 }, { tadpoleCount: 3 }, { horseshoe: false }]) expect(configHashes(study('lagrange', change).config).stateKey).not.toBe(lagrange);
    expect(configHashes(study('threebody-moth').config).stateKey).not.toBe(configHashes(study('threebody-butterfly').config).stateKey);
    // And through the runner: the diagnostic part carries the key, which a mark-only change leaves alone.
    const base = await render(config('hohmann'));
    const other = await render(config('hohmann'), { orbitPen: 'gold', rotation: 45 });
    const id = (r: Result) => r.parts.find(p => p.diagnostic)!.id;
    expect(id(other)).toBe(id(base));
    expect(other.parts.filter(p => !p.diagnostic)).not.toEqual(base.parts.filter(p => !p.diagnostic));
  }, 60000);

  it('puts every Lagrange point at an equilibrium of the effective potential', () => {
    for (const mu of [0.001, 0.002, 0.01, 0.038]) {
      const points = lagrangePoints(mu);
      for (const [name, p] of Object.entries(points)) {
        const g = potentialGradient(mu, p.x, p.y);
        expect(Math.hypot(g.x, g.y), `${name} mu ${mu}`).toBeLessThan(1e-12);
      }
      expect(points.L3.x).toBeLessThan(-1);
      expect(points.L1.x).toBeLessThan(1 - mu);
      expect(points.L2.x).toBeGreaterThan(1 - mu);
      // Critical Jacobi constants are ordered, and L4 sits at 3 - mu (1 - mu).
      const c = criticalLevels(mu);
      expect(c.L1).toBeGreaterThan(c.L2);
      expect(c.L2).toBeGreaterThan(c.L3);
      expect(c.L3).toBeGreaterThan(c.L4);
      expect(c.L4).toBeCloseTo(3 - mu * (1 - mu), 12);
    }
  });

  it('draws zero-velocity curves on their Jacobi level, vertex and segment midpoint alike', () => {
    for (const mu of [0.002, 0.01]) {
      const levels = zeroVelocityLevels(mu, 'necks', 4);
      expect(levels).toHaveLength(4);
      const half = 1.12 * Math.sqrt(Math.max(...levels));
      for (const level of levels) {
        const lines = zeroVelocityCurves(mu, level, { xMin: -half, xMax: half, yMin: -half, yMax: half }, 900, 1.25e-4);
        expect(lines.length).toBeGreaterThan(0);
        let worstVertex = 0, worstMid = 0, count = 0;
        for (const line of lines) {
          // Closed loops repeat their first point.
          expect(Math.hypot(line[0].x - line[line.length - 1].x, line[0].y - line[line.length - 1].y)).toBeLessThan(1e-9);
          line.forEach((p, i) => {
            worstVertex = Math.max(worstVertex, Math.abs(jacobiField(mu, p.x, p.y) - level));
            if (i > 0) worstMid = Math.max(worstMid, Math.abs(jacobiField(mu, (p.x + line[i - 1].x) / 2, (p.y + line[i - 1].y) / 2) - level));
            count++;
          });
        }
        expect(count).toBeGreaterThan(100);
        expect(worstVertex).toBeLessThan(1e-9);
        expect(worstMid).toBeLessThan(5e-3);
      }
    }
    // The same through the drawn scene: every zero-velocity vertex of the plate is on one of its levels.
    const s = study('lagrange');
    const scene = plateScene(s, integrate(s));
    const levels = zeroVelocityLevels(s.lagrange!.mu, s.marks.zvcMode, s.marks.zvcCount);
    const lines = scene.lines.filter(l => l.part === 'zero-velocity');
    expect(lines.length).toBeGreaterThanOrEqual(levels.length);
    for (const line of lines) for (const p of line.points) {
      const c = jacobiField(s.lagrange!.mu, p.x / s.lagrange!.a, p.y / s.lagrange!.a);
      expect(Math.min(...levels.map(l => Math.abs(c - l)))).toBeLessThan(1e-9);
    }
    // The generic contour on a field with a known level set: circles of radius 3.
    const circle = contourLines((x, y) => x * x + y * y, (x, y) => ({ x: 2 * x, y: 2 * y }), 9, { xMin: -4, xMax: 4, yMin: -4, yMax: 4 }, 200, 1e-3);
    expect(circle).toHaveLength(1);
    for (const p of circle[0]) expect(Math.hypot(p.x, p.y)).toBeCloseTo(3, 9);
  });

  it('integrates the Lagrange orbits in the inertial frame and keeps their Jacobi constant', () => {
    const s = study('lagrange');
    const h = integrate(s);
    const { mu, a, omega } = s.lagrange!;
    const m = s.config.attractors.map(x => x.mass);
    // Jacobi constant along each integrated orbit, from the inertial state: rotating position and velocity about the integrated binary.
    for (const particle of s.lagrange!.particles) {
      const jacobi = (k: number): number => {
        const p1 = { x: h.ax[k][0], y: h.ay[k][0] }, p2 = { x: h.ax[k][1], y: h.ay[k][1] };
        const bary = { x: (m[0] * p1.x + m[1] * p2.x) / (m[0] + m[1]), y: (m[0] * p1.y + m[1] * p2.y) / (m[0] + m[1]) };
        const theta = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        const c = Math.cos(-theta), sn = Math.sin(-theta);
        const x = h.xs[k][particle.particle] - bary.x, y = h.ys[k][particle.particle] - bary.y;
        const k1 = Math.min(k + 1, h.xs.length - 1), k0 = Math.max(k - 1, 0);
        // Inertial velocity by central difference over the recorded step, then into the rotating frame: v_rot = R(-theta) v - Omega x r.
        const dt = (k1 - k0) * s.config.settings.dt;
        const vx = (h.xs[k1][particle.particle] - h.xs[k0][particle.particle]) / dt, vy = (h.ys[k1][particle.particle] - h.ys[k0][particle.particle]) / dt;
        const rx = (x * c - y * sn) / a, ry = (x * sn + y * c) / a;
        const ux = (vx * c - vy * sn) / (a * omega) + ry, uy = (vx * sn + vy * c) / (a * omega) - rx;
        return jacobiField(mu, rx, ry) - (ux * ux + uy * uy);
      };
      const c0 = jacobi(40), c1 = jacobi(Math.floor(h.xs.length / 2)), c2 = jacobi(h.xs.length - 40);
      // Central differencing over 80 steps per period costs a little; conservation to 1e-3 of a unit that is about 3.
      expect(Math.abs(c1 - c0)).toBeLessThan(2e-3);
      expect(Math.abs(c2 - c0)).toBeLessThan(2e-3);
      expect(Math.abs(c0 - particle.jacobi)).toBeLessThan(2e-2);
    }
    expect(librationMode(0.002, 1).omega).toBeCloseTo(Math.sqrt((-1 + Math.sqrt(1 - 27 * 0.002 * 0.998)) / -2), 12);
  });

  it('integrates the Hohmann orbits and ends the drawn transfer arc on the target radius', () => {
    const s = study('hohmann');
    const plan = s.hohmann!;
    const h = integrate(s);
    const scene = plateScene(s, h);
    const map = makeMapper(s, scene);
    const centre = plan.centre;
    const radius = (p: { x: number; y: number }) => Math.hypot(p.x - centre.x, p.y - centre.y);
    const orbits = scene.lines.filter(l => l.part === 'orbits');
    expect(orbits).toHaveLength(plan.radii.length);
    orbits.forEach((line, k) => {
      // A circle: every integrated point at the snapped radius, and the period closes exactly by construction.
      for (const p of line.points) expect(Math.abs(radius(p) / plan.radii[k] - 1)).toBeLessThan(1e-4);
      const first = map.toPage(line.points[0]), last = map.toPage(line.points[line.points.length - 1]);
      expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(0.01);
    });
    const transfers = scene.lines.filter(l => l.part === 'transfers');
    expect(transfers).toHaveLength(plan.hops.length);
    transfers.forEach((line, i) => {
      const hop = plan.hops[i];
      expect(Math.abs(radius(line.points[0]) / hop.rFrom - 1)).toBeLessThan(1e-4);
      expect(Math.abs(radius(line.points[line.points.length - 1]) / hop.rTo - 1)).toBeLessThan(2e-3);
      expect(Math.max(...line.points.map(radius)) / hop.rTo).toBeLessThan(1 + 2e-3);
      // The arc starts at the source planet and ends at the target planet.
      expect(line.points.length).toBe(hop.arriveStep - hop.departStep + 1);
    });
    // Two scheduled burns per transfer: the sim's impulses, prograde.
    expect(s.config.impulses).toHaveLength(2 * plan.hops.length);
    for (const impulse of s.config.impulses!) expect(Math.hypot(impulse.dv.x, impulse.dv.y)).toBeGreaterThan(0);
    // Burn ticks scale with delta-v.
    const ticks = scene.glyphs.filter(g => g.kind === 'tick');
    expect(ticks).toHaveLength(2 * plan.hops.length);
    expect(ticks[0].mm / ticks[1].mm).toBeCloseTo(Math.hypot(plan.hops[0].dv1.x, plan.hops[0].dv1.y) / Math.hypot(plan.hops[0].dv2.x, plan.hops[0].dv2.y), 9);
    // Single mode draws one transfer; a delayed departure moves the burn step.
    expect(plateScene(study('hohmann', { transferMode: 'single', transferIndex: 1 }), integrate(study('hohmann', { transferMode: 'single', transferIndex: 1 }))).lines.filter(l => l.part === 'transfers')).toHaveLength(1);
    expect(study('hohmann', { departureStep: 120 }).hohmann!.hops[0].departStep).toBe(120);
  });

  it('closes every choreography to within 0.1 page mm and keeps the lines smooth', () => {
    for (const id of ['threebody-figure8', 'threebody-butterfly', 'threebody-moth', 'threebody-yinyang']) {
      const s = study(id);
      const h = integrate(s);
      expect(h.xs.length).toBe(s.threebody!.steps + 1);
      const scene = plateScene(s, h);
      const map = makeMapper(s, scene);
      const orbits = scene.lines.filter(l => l.part === 'orbits');
      expect(orbits).toHaveLength(3);
      for (const line of orbits) {
        const first = map.toPage(line.points[0]), last = map.toPage(line.points[line.points.length - 1]);
        expect(Math.hypot(first.x - last.x, first.y - last.y), id).toBeLessThan(0.1);
      }
      expect(worstChord(s, ['orbits']), id).toBeLessThan(0.05);
    }
    expect(Object.keys(CATALOG)).toEqual(['figure-eight', 'butterfly', 'yin-yang', 'moth']);
    // Zero total momentum and the barycentre at rest: the recorded barycentre stays put.
    const s = study('threebody-butterfly', { choreography: 'butterfly' });
    const h = integrate(s);
    const bary = (k: number) => ({ x: (h.ax[k][0] + h.ax[k][1] + h.ax[k][2]) / 3, y: (h.ay[k][0] + h.ay[k][1] + h.ay[k][2]) / 3 });
    expect(Math.hypot(bary(h.xs.length - 1).x - bary(0).x, bary(h.xs.length - 1).y - bary(0).y)).toBeLessThan(1e-6);
    // The first-body option draws one curve; the phase moves the circles but not the curves.
    expect(plateScene(study('threebody-figure8', { bodies: 'first' }), integrate(study('threebody-figure8'))).lines).toHaveLength(1);
  }, 60000);

  it('keeps the Hohmann and Lagrange lines within 0.05 mm of their chords', () => {
    expect(worstChord(study('hohmann'), ['orbits', 'transfers'])).toBeLessThan(0.05);
    expect(worstChord(study('lagrange'), ['tadpoles', 'horseshoe', 'zero-velocity'])).toBeLessThan(0.05);
  });

  it('draws the off state without calling the simulation', async () => {
    simCalls.n = 0;
    const off = await render(config('lagrange-off'));
    const ids = off.parts.map(p => p.id);
    expect(ids).toContain('zero-velocity');
    expect(ids).toContain('lagrange-points');
    expect(ids).toContain('bodies');
    expect(ids.some(id => id === 'tadpoles' || id === 'horseshoe')).toBe(false);
    // The runner runs in a child process, so also call draw directly.
    sketch.draw(context('lagrange-off'));
    expect(simCalls.n).toBe(0);
    sketch.draw(context('lagrange', { periods: 5, tadpoleCount: 1 }));
    expect(simCalls.n).toBeGreaterThan(0);
  }, 60000);
});
