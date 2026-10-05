import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { inspectSketch, renderSketch } from '../../cli/sketch/runner.ts';
import { resolveFinishing, resolveMacroParams, resolveParams } from '../../packages/plot-core/src/index.ts';
import { extractMarks, parseOrbitStateId, particleTrails, trailMarks } from '../../sketches/borrowed-orbits/extract.ts';
import { FORBIDDEN_CLEARANCE_M } from '../../sketches/borrowed-orbits/layout.ts';
import { LIMITS } from '../../sketches/borrowed-orbits/model.ts';
import { buildStudy, massFromPeriod } from '../../sketches/borrowed-orbits/study.ts';
import type { OrbitStudy } from '../../sketches/borrowed-orbits/study.ts';
import type { Params, SketchContext } from '../sketch/types.ts';

// Count every call that reaches the simulation, while still running the real one.
const simCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../sketches/borrowed-orbits/sim.ts', async importOriginal => {
  const mod = await importOriginal<typeof import('../../sketches/borrowed-orbits/sim.ts')>();
  const wrap = <F extends (...args: never[]) => unknown>(f: F): F => ((...args: Parameters<F>) => { simCalls.n++; return f(...args); }) as F;
  return { ...mod, history: wrap(mod.history), simulate: wrap(mod.simulate), advance: wrap(mod.advance), initialSnapshot: wrap(mod.initialSnapshot) };
});
const { default: sketch } = await import('../../sketches/borrowed-orbits/sketch.ts');
const { configHashes, history, simulate } = await import('../../sketches/borrowed-orbits/sim.ts');

const entry = resolve('sketches/borrowed-orbits/sketch.ts');
type Request = { seed: number; params: Params; finishing: Parameters<typeof resolveFinishing>[2] };
const config = (id: string): Request => JSON.parse(readFileSync(resolve(`sketches/borrowed-orbits/configs/${id}.json`), 'utf8'));
type Result = Awaited<ReturnType<typeof renderSketch>>;
const render = (request: Request, params: Params = {}): Promise<Result> =>
  renderSketch({ entry, seed: request.seed, params: { ...request.params, ...params }, finishing: request.finishing });
const part = (result: Result, id: string) => result.parts.find(p => p.id === id)!;
const state = (result: Result) => parseOrbitStateId(result.parts.filter(p => p.diagnostic).map(p => p.id)[0]);

/** The runner's named-stream generator (cli/sketch/child.ts randomStream), verbatim. */
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
/** A SketchContext equivalent to what the runner hands draw(): resolved params, macros applied, same streams. */
function context(request: { seed?: number; params?: Params }): SketchContext {
  const params = resolveParams(sketch.controls, request.params);
  const effective = sketch.macros?.length ? resolveMacroParams(sketch.controls, params, sketch.macros) : params;
  const seed = request.seed ?? 0;
  return { params: effective as Params, seed, assets: {}, random: (id: string) => randomStream(seed, id) };
}
const study = (params: Params = {}, seed = 311): OrbitStudy => buildStudy(context({ seed, params: { ...config('pilot-mid').params, ...params } }));
const total = (paths: { x: number; y: number }[][]) => paths.reduce((n, p) => n + p.length, 0);

describe('Borrowed Orbits sketch', () => {
  it('exposes the guide, hidden-mass, perturber, seed and mark controls with navigators and macros', async () => {
    const metadata = await inspectSketch({ entry });
    expect((metadata.navigators ?? []).map(n => [n.id, n.type ?? 'radar'])).toEqual([
      ['event', 'radar'], ['hidden-mass', 'xy'], ['apparent-centre', 'xy'], ['perturber', 'xyz'],
    ]);
    expect((metadata.macros ?? []).map(m => m.control)).toEqual(['displacement', 'disturbance']);
    const byId = new Map(metadata.controls.map(c => [c.id, c]));
    for (const id of ['orbitsEnabled', 'step', 'centreX', 'centreY', 'guideCount', 'guideInner', 'guideOuter', 'massDX', 'massDY', 'orbitPeriod', 'softening', 'captureRadius',
      'particlesPerGuide', 'borrow', 'speedJitter', 'spin', 'perturberEnabled', 'perturberRatio', 'perturberAngle', 'perturberImpact', 'perturberSpeed', 'perturberStep',
      'forbiddenLayout', 'forbiddenCount', 'boundary', 'escapeMargin', 'structureSeed', 'dynamicsSeed', 'trailSteps', 'taper', 'trailMinSpacing', 'trailPen', 'drawGuides']) {
      expect(byId.has(id), id).toBe(true);
    }
    expect(byId.get('step')).toMatchObject({ default: 600, min: 0, max: LIMITS.maxSteps });
    expect(byId.get('step')).toMatchObject({ units: 'steps of 0.1 s', expensive: true });
    expect(byId.get('taper')).not.toHaveProperty('expensive');
    expect(byId.get('structureSeed')).toMatchObject({ expensive: true });
  });

  it('renders every pilot with finite points inside the finished content area and a changing state', async () => {
    const results: Result[] = [];
    for (const id of ['pilot-early', 'pilot-mid', 'pilot-late']) results.push(await render(config(id)));
    const request = config('pilot-mid');
    const content = resolveFinishing(sketch.page, sketch.pens, request.finishing).contentRect;
    for (const result of results) {
      expect(result.diagnostics).toEqual([]);
      expect(part(result, 'trails').paths.length).toBeGreaterThan(50);
      expect(part(result, 'guides').paths.length).toBe(5);
      expect(part(result, 'forbidden-outline').paths.length).toBeGreaterThan(0);
      expect(result.stats.pointCount).toBeLessThan(150_000);
      for (const p of result.parts.filter(q => !q.diagnostic && q.id !== 'finishing-border')) {
        for (const path of p.paths) for (const pt of path) {
          expect(Number.isFinite(pt.x) && Number.isFinite(pt.y)).toBe(true);
          expect(pt.x).toBeGreaterThanOrEqual(content.xMin - 1e-6);
          expect(pt.x).toBeLessThanOrEqual(content.xMax + 1e-6);
          expect(pt.y).toBeGreaterThanOrEqual(content.yMin - 1e-6);
          expect(pt.y).toBeLessThanOrEqual(content.yMax + 1e-6);
        }
      }
    }
    expect(state(results[0])!.step).toBe(300);
    expect(new Set(results.map(r => state(r)!.stateKey)).size).toBe(1);
    expect(new Set(results.map(r => r.identity)).size).toBe(3);
    // Deterministic for a repeated request.
    const again = await render(config('pilot-mid'));
    expect(again.parts).toEqual(results[1].parts);
  }, 90000);

  it('draws the off state as guides and forbidden regions and never calls the simulation', async () => {
    simCalls.n = 0;
    const off = context({ seed: 311, params: { ...config('pilot-off').params, orbitsEnabled: false, step: 2000, perturberRatio: 1 } });
    const parts = sketch.draw(off) as Awaited<Result>['parts'];
    expect(simCalls.n).toBe(0);
    const ids = parts.map(p => p.id);
    expect(ids.some(id => id.startsWith('trails'))).toBe(false);
    expect(ids).toContain('orbit-state-off');
    expect(parts.find(p => p.id === 'guides')!.paths.length).toBe(5);
    expect(parts.find(p => p.id === 'forbidden-outline')!.paths.length).toBeGreaterThan(0);
    // Simulation controls do not touch the off drawing.
    const moved = sketch.draw(context({ seed: 311, params: { ...config('pilot-off').params, orbitsEnabled: false, step: 0, massDX: -9, borrow: 0, perturberEnabled: false, boundary: 'absorb', particlesPerGuide: 10 } }));
    expect(moved).toEqual(parts);
    expect(simCalls.n).toBe(0);
    // And the live state does call it (the spy is wired).
    sketch.draw(context({ seed: 311, params: { ...config('pilot-mid').params, step: 20, particlesPerGuide: 6 } }));
    expect(simCalls.n).toBeGreaterThan(0);
    const result = await render(config('pilot-off'));
    expect(part(result, 'guides').paths.length).toBe(5);
    expect(result.parts.some(p => p.id === 'trails')).toBe(false);
  }, 60000);

  it('lets mark-only changes redraw without touching simulation identity', async () => {
    const base = study();
    const key = configHashes(base.config).stateKey;
    const baseRender = await render(config('pilot-mid'));
    const variants: Params[] = [{ taper: 0 }, { taper: 1 }, { trailPen: 'gold' }, { trailSteps: 120 }, { drawGuides: false }, { trailMinSpacing: 3 }, { guidePen: 'cyan' }, { hatchPitch: 2 }, { structurePen: 'violet' }];
    for (const change of variants) {
      expect(configHashes(study(change).config).stateKey, JSON.stringify(change)).toBe(key);
      const other = await render(config('pilot-mid'), change);
      expect(state(other)!.stateKey).toBe(state(baseRender)!.stateKey);
      expect(other.parts.filter(p => !p.diagnostic)).not.toEqual(baseRender.parts.filter(p => !p.diagnostic));
    }
    expect(part(await render(config('pilot-mid'), { trailPen: 'gold' }), 'trails').pen).toBe('gold');
    expect(part(await render(config('pilot-mid'), { drawGuides: false }), 'guides').paths).toEqual([]);
    // A simulation control does change identity.
    expect(configHashes(study({ borrow: 0.5 }).config).stateKey).not.toBe(key);
    expect(configHashes(study({ massDX: -3 }).config).stateKey).not.toBe(key);
  }, 90000);

  it('separates the structure and dynamics seeds', () => {
    const base = study();
    const hashes = configHashes(base.config);
    // dynamicsSeed: particles change, geometry (domain + forbidden regions) does not.
    const dyn = study({ dynamicsSeed: 7 });
    expect(dyn.config.particles).not.toEqual(base.config.particles);
    expect(dyn.config.forbidden).toEqual(base.config.forbidden);
    expect(configHashes(dyn.config).geometry).toBe(hashes.geometry);
    expect(configHashes(dyn.config).simulation).not.toBe(hashes.simulation);
    // structureSeed: the layout changes, particles' initial state does not.
    const str = study({ structureSeed: 7 });
    expect(str.config.forbidden).not.toEqual(base.config.forbidden);
    expect(configHashes(str.config).geometry).not.toBe(hashes.geometry);
    expect(str.config.particles).toEqual(base.config.particles);
    expect(str.config.attractors).toEqual(base.config.attractors);
    // Seed 0 is the plain stream name: another seed value reproduces itself.
    expect(study({ structureSeed: 7 }).config.forbidden).toEqual(str.config.forbidden);
    // The structure stream also decides the arc, and the gate is exact.
    expect(study({ forbiddenLayout: 'arc' }).config.forbidden).not.toEqual(study({ forbiddenLayout: 'arc', structureSeed: 3 }).config.forbidden);
    const gate = study({ forbiddenLayout: 'gate' });
    expect(gate.config.forbidden).toEqual(study({ forbiddenLayout: 'gate', structureSeed: 3 }).config.forbidden);
    const [l, r] = gate.config.forbidden.map(f => f.polygon);
    const cx = gate.guides.centre.x;
    for (const p of l) expect(r.some(q => Math.abs(q.x - (2 * cx - p.x)) < 1e-9 && Math.abs(q.y - p.y) < 1e-9)).toBe(true);
    expect(study({ forbiddenLayout: 'none' }).config.forbidden).toEqual([]);
  });

  it('ends a captured trail exactly at its capture point and an escaped one where it escaped', () => {
    for (const [layout, boundary] of [['bars', 'open'], ['arc', 'open'], ['gate', 'absorb']] as const) {
      const s = study({ forbiddenLayout: layout, boundary, particlesPerGuide: 40, forbiddenCount: 16 });
      const step = 700;
      const h = history(s.config, 0, step);
      const trails = particleTrails(s, h);
      const marks = trailMarks(s, h).paths;
      const reasons = new Set<number>();
      let checked = 0;
      for (let i = 0; i < h.final.status.length; i++) {
        if (h.final.status[i] === 0 || h.final.stoppedAt[i] < 0) continue;
        const stop = s.worldToArt({ x: h.final.px[i], y: h.final.py[i] });
        const trail = trails.find(t => t.index === i);
        if (!trail) continue;
        reasons.add(h.final.reason[i] + 10 * h.final.status[i]);
        const end = trail.path[trail.path.length - 1];
        expect(end.x).toBeCloseTo(stop.x, 9);
        expect(end.y).toBeCloseTo(stop.y, 9);
        const f = s.frame;
        // A trail shorter than a speck of ink (0.15 page mm) is dropped, whatever it ends on.
        const length = trail.path.slice(1).reduce((sum, q, k) => sum + Math.hypot(q.x - trail.path[k].x, q.y - trail.path[k].y), 0) * s.fit.scale;
        if (length > 0.3 && stop.x > f.xMin && stop.x < f.xMax && stop.y > f.yMin && stop.y < f.yMax) {
          // The drawn marks of an in-frame stop end on the same point (the head is never dashed away).
          expect(marks.some(p => Math.hypot(p[p.length - 1].x - stop.x, p[p.length - 1].y - stop.y) < 1e-9), `${layout} particle ${i}`).toBe(true);
          checked++;
        }
      }
      expect(checked, layout).toBeGreaterThan(3);
      expect(reasons.size, layout).toBeGreaterThan(0);
    }
  }, 60000);

  it('keeps a capture at a forbidden region clear of the drawn outline by the clearance', () => {
    const s = study({ forbiddenLayout: 'gate', particlesPerGuide: 60 });
    const h = history(s.config, 0, 600);
    const edgeDistance = (p: { x: number; y: number }, ring: { x: number; y: number }[]) => Math.min(...ring.map((a, i) => {
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    }));
    let hits = 0;
    for (let i = 0; i < h.final.status.length; i++) {
      if (h.final.reason[i] !== 1 || h.final.stoppedAt[i] < 1) continue;
      const p = { x: h.final.px[i], y: h.final.py[i] };
      expect(Math.min(...s.forbidden.map(f => edgeDistance(p, f.polygon)))).toBeCloseTo(FORBIDDEN_CLEARANCE_M, 6);
      hits++;
    }
    expect(hits).toBeGreaterThan(0);
  });

  it('round-trips world to art to world and builds the mass from the orbit period', () => {
    const s = study();
    for (const p of [{ x: 0, y: 0 }, { x: 24, y: 36 }, { x: 47.5, y: 77.25 }, { x: -3, y: 90 }]) {
      const back = s.artToWorld(s.worldToArt(p));
      expect(Math.abs(back.x - p.x)).toBeLessThan(1e-9);
      expect(Math.abs(back.y - p.y)).toBeLessThan(1e-9);
    }
    const lettered = study({ posterMode: 'lettered' });
    const p = { x: 10, y: 20 };
    expect(Math.abs(lettered.artToWorld(lettered.worldToArt(p)).x - p.x)).toBeLessThan(1e-9);
    // M = 4π² r³ / (G T²) at the middle guide radius (13 m), 60 s: about 3.6e11 kg.
    expect(s.primaryMass).toBeCloseTo(massFromPeriod(13, 60), 0);
    expect(s.primaryMass).toBeGreaterThan(3.5e11);
    expect(s.primaryMass).toBeLessThan(3.7e11);
    expect(s.config.attractors[0].mass).toBe(s.primaryMass);
  });

  it('without borrowing or a perturber, particles keep their radius about the hidden mass', () => {
    const s = study({ borrow: 0, speedJitter: 0, perturberEnabled: false, forbiddenLayout: 'none', massDX: 1.5, massDY: 2, particlesPerGuide: 12, boundary: 'absorb' });
    expect(s.config.attractors).toHaveLength(1);
    const steps = 500;
    const h = history(s.config, 0, steps);
    const m = s.primaryPosition;
    let worst = 0;
    for (let i = 0; i < s.config.particles.length; i++) {
      const p0 = s.config.particles[i].position;
      const r0 = Math.hypot(p0.x - m.x, p0.y - m.y);
      for (let k = 0; k <= steps; k++) {
        const r = Math.hypot(h.xs[k][i] - m.x, h.ys[k][i] - m.y);
        worst = Math.max(worst, Math.abs(r - r0) / r0);
      }
    }
    expect(h.final.status.every(v => v === 0)).toBe(true);
    expect(worst).toBeLessThan(0.02);
    // Control: the borrowed construction (the default) drifts far off those radii.
    const b = study({ borrow: 1, speedJitter: 0, perturberEnabled: false, forbiddenLayout: 'none', massDX: 1.5, massDY: 2, particlesPerGuide: 12, boundary: 'absorb' });
    const hb = history(b.config, 0, steps);
    let drift = 0;
    for (let i = 0; i < b.config.particles.length; i++) {
      const p0 = b.config.particles[i].position;
      const r0 = Math.hypot(p0.x - m.x, p0.y - m.y);
      for (let k = 0; k <= steps; k++) drift = Math.max(drift, Math.abs(Math.hypot(hb.xs[k][i] - m.x, hb.ys[k][i] - m.y) - r0) / r0);
    }
    expect(drift).toBeGreaterThan(0.1);
  }, 30000);

  it('builds the perturber on a straight line that reaches its closest approach at the declared step', () => {
    const s = study({ perturberAngle: 0, perturberImpact: 6, perturberSpeed: 2, perturberStep: 300 });
    const per = s.config.attractors[1];
    expect(per.mass).toBeCloseTo(s.primaryMass * 0.35, 0);
    // Heading +x, 6 m below-centre offset (y grows downward), 60 m of run-up in 300 steps.
    expect(per.velocity).toEqual({ x: 2, y: 0 });
    expect(per.position.y).toBeCloseTo(36 + 6, 9);
    expect(per.position.x).toBeCloseTo(24 - 2 * 300 * 0.1, 9);
    expect(study({ perturberEnabled: false }).config.attractors).toHaveLength(1);
    expect(study({ perturberRatio: 0 }).config.attractors).toHaveLength(1);
  });

  it('lets the perturber kink trails and keeps point budgets sane', () => {
    const on = study();
    const off = study({ perturberEnabled: false });
    const [a, b] = [on, off].map(s => simulate(s.config, [800])[0]);
    expect(a.stateHash).not.toBe(b.stateHash);
    const marks = extractMarks(on, history(on.config, 400, 800));
    expect(total(marks.find(p => p.id === 'trails')!.paths)).toBeLessThan(100_000);
    // Minimum spacing thins stacked ropes; taper 0 draws fewer, longer pieces than taper 1.
    const thin = trailMarks(study({ trailMinSpacing: 4 }), history(on.config, 200, 800)).paths;
    const plain = trailMarks(on, history(on.config, 200, 800)).paths;
    const inkLength = (paths: { x: number; y: number }[][]) => paths.reduce((n, path) => n + path.slice(1).reduce((m, q, i) => m + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0), 0);
    expect(inkLength(thin)).toBeLessThan(inkLength(plain));
    expect(total(thin)).toBeLessThan(total(plain));
    const solid = trailMarks(study({ taper: 0 }), history(on.config, 200, 800)).paths;
    const dashed = trailMarks(study({ taper: 1 }), history(on.config, 200, 800)).paths;
    expect(dashed.length).toBeGreaterThan(solid.length);
  }, 60000);
});
