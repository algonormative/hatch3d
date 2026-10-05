import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectSketch, renderSketch } from '../../cli/sketch/runner.ts';
import { resolveFinishing } from '../../packages/plot-core/src/index.ts';
import { MEMBER_CLEARANCE_MM, distanceToSegment, extractMarks, parseCloudStateId } from '../../sketches/cloud-advection/extract.ts';
import { studyContext } from '../../sketches/cloud-advection/evidence.ts';
import { buildDomain, configHashes, simulate } from '../../sketches/cloud-advection/sim.ts';
import { CORE_CENTER, CORE_KEEP_OUT, WORLD, distanceToPolygon, colonnadeLayout, portalLayout, ringLayout, sunLayout } from '../../sketches/cloud-advection/layout.ts';
import sketch from '../../sketches/cloud-advection/sketch.ts';
import { buildStudy } from '../../sketches/cloud-advection/study.ts';
import type { FinishingOptions, Params } from '../sketch/types.ts';

const entry = resolve('sketches/cloud-advection/sketch.ts');
type Request = { seed: number; params: Params; finishing: FinishingOptions };
const config = (id: string): Request => JSON.parse(readFileSync(resolve(`sketches/cloud-advection/configs/${id}.json`), 'utf8'));
type Result = Awaited<ReturnType<typeof renderSketch>>;
const render = (request: Request, params: Params = {}): Promise<Result> =>
  renderSketch({ entry, seed: request.seed, params: { ...request.params, ...params }, finishing: request.finishing });
const cloud = (result: Result) => result.parts.filter(part => part.id.startsWith('cloud-') && !part.diagnostic);
const structure = (result: Result) => result.parts.filter(part => part.id.startsWith('structure-'));
const state = (result: Result) => {
  const ids = result.parts.filter(part => part.diagnostic).map(part => part.id);
  expect(ids).toHaveLength(1);
  return ids[0];
};
const counts = (parts: Result['parts']) => ({
  paths: parts.reduce((n, p) => n + p.paths.length, 0),
  points: parts.reduce((n, p) => n + p.paths.reduce((m, path) => m + path.length, 0), 0),
});

describe('Prescribed Weather sketch', () => {
  it('exposes the simulation, mark, and navigator controls with macros', async () => {
    const metadata = await inspectSketch({ entry });
    const navigators = metadata.navigators ?? [];
    expect(navigators.map(n => [n.id, n.type ?? 'radar'])).toEqual([
      ['weather', 'radar'], ['wind', 'xy'], ['eddy', 'xy'], ['quiet-core', 'xy'], ['source', 'xyz'],
    ]);
    expect(navigators[0].axes).toEqual(['turbulence', 'drift', 'obscure']);
    expect(navigators[4]).toMatchObject({ axes: ['sourceX', 'sourceY', 'sourceSize'], axisLabels: ['X', 'Y', 'Size'] });
    expect((metadata.macros ?? []).map(m => m.control)).toEqual(['turbulence', 'drift']);
    const ids = new Set(metadata.controls.map(c => c.id));
    for (const id of ['layout', 'ringCount', 'weatherSeed', 'sunRays', 'sunInner', 'sunReach', 'sunAlternate', 'sunRings', 'sunNoise', 'trainEnabled', 'trainPeriod', 'trainCirculation', 'trainCore', 'trainAlternate', 'trainJitter', 'eddyDrift', 'markStyle', 'streakPen', 'streakSpacing', 'sourceEnabled', 'contourMinSpacing', 'structureDensity', 'frontSoftness', 'frontAmplitude', 'frontScale', 'frontCoverage', 'fillInterior', 'cloudEnabled', 'step', 'windX', 'windY', 'eddyX', 'eddyY', 'eddyCirculation', 'eddyCore', 'dispersion', 'boundary',
      'sourceX', 'sourceY', 'sourceSize', 'referenceDensity', 'cloudHatchPitch', 'cloudPen', 'obscure', 'coreRadius', 'coreX', 'coreY', 'hatchPitch']) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('draws bounded cloud on real pens that changes across steps, inside the finished content area', async () => {
    const results = [] as Result[];
    for (const id of ['step-00', 'step-30', 'step-60']) results.push(await render(config(id)));
    const request = config('step-30');
    const content = resolveFinishing(sketch.page, sketch.pens, request.finishing).contentRect;
    const penIds = new Set(results[0].metadata.pens.map(pen => pen.id));
    for (const result of results) {
      expect(result.diagnostics).toEqual([]);
      const clouds = cloud(result);
      expect(clouds.length).toBeGreaterThan(0);
      for (const part of clouds) expect(penIds.has(part.pen)).toBe(true);
      expect(counts(clouds).paths).toBeGreaterThan(20);
      expect(result.stats.pathCount).toBeLessThan(6000);
      expect(result.stats.pointCount).toBeLessThan(150_000);
      expect(result.durationMs).toBeLessThan(30_000);
      for (const part of result.parts.filter(p => !p.diagnostic && p.id !== 'finishing-border')) {
        for (const path of part.paths) for (const p of path) {
          expect(p.x).toBeGreaterThanOrEqual(content.xMin - 1e-6);
          expect(p.x).toBeLessThanOrEqual(content.xMax + 1e-6);
          expect(p.y).toBeGreaterThanOrEqual(content.yMin - 1e-6);
          expect(p.y).toBeLessThanOrEqual(content.yMax + 1e-6);
        }
      }
    }
    expect(new Set(results.map(r => r.identity)).size).toBe(3);
    expect(cloud(results[0])).not.toEqual(cloud(results[1]));
    expect(cloud(results[1])).not.toEqual(cloud(results[2]));
    // The diagnostic part carries the snapshot identity.
    const parsed = results.map(r => parseCloudStateId(state(r)));
    expect(parsed.map(p => p?.step)).toEqual([0, 30, 60]);
    expect(new Set(parsed.map(p => p!.stateKey)).size).toBe(1);
    expect(new Set(parsed.map(p => p!.densityHash)).size).toBe(3);
  }, 60000);

  it('is deterministic for a repeated request', async () => {
    const first = await render(config('step-30'));
    const second = await render(config('step-30'));
    expect(second.identity).toBe(first.identity);
    expect(second.parts).toEqual(first.parts);
  }, 30000);

  it('draws the off state as authored structure and ignores simulation parameters', async () => {
    const off = await render(config('off'));
    expect(cloud(off)).toEqual([]);
    expect(state(off)).toBe('cloud-state-off');
    expect(structure(off).length).toBeGreaterThanOrEqual(6);
    const moved = await render(config('off'), { step: 0, windX: -2, windY: -1, eddyCirculation: -60, dispersion: 0.7, boundary: 'closed', sourceX: 40, sourceSize: 3 });
    expect(moved.svg).toBe(off.svg);
    expect(moved.parts).toEqual(off.parts);
    // With obscuration off the structure is exactly the off-state drawing.
    const clear = await render(config('step-30'), { obscure: 0 });
    expect(structure(clear)).toEqual(structure(off));
    expect(cloud(clear).length).toBeGreaterThan(0);
    // With obscuration on, cloud conceals part of the structure.
    const veiled = await render(config('step-30'));
    expect(counts(structure(veiled)).points).not.toBe(counts(structure(off)).points);
    // A cloud too thin to conceal anything leaves even short hatch stubs as authored.
    const spent = await render(config('step-30'), { step: 120 });
    expect(structure(spent)).toEqual(structure(off));
  }, 60000);

  it('keeps cloud marks out of the quiet core', async () => {
    const request = config('step-30');
    const finish = resolveFinishing(sketch.page, sketch.pens, request.finishing);
    const inside = (params: Params, points: { x: number; y: number }[]) => {
      const cx = sketch.page.width / 2 + Number(params.coreX), cy = sketch.page.height / 2 + Number(params.coreY);
      const radius = Number(params.coreRadius) * finish.scale;
      const center = { x: cx * finish.scale + finish.offsetX, y: cy * finish.scale + finish.offsetY };
      return { distances: points.map(p => Math.hypot(p.x - center.x, p.y - center.y)), radius };
    };
    for (const change of [{}, { coreRadius: 70, coreX: 20, coreY: -90 }, { coreRadius: 50, coreY: -60 }] as Params[]) {
      const params = { ...request.params, ...change };
      const points = cloud(await render(request, change)).flatMap(part => part.paths.flat());
      if (Object.keys(change).length === 0) expect(points.length).toBeGreaterThan(100);
      const { distances, radius } = inside(params, points);
      for (const d of distances) expect(d).toBeGreaterThanOrEqual(radius);
      if (Object.keys(change).length > 0) {
        // Control: without the core the same cloud does enter the circle.
        const free = cloud(await render(request, { ...change, coreRadius: 0 })).flatMap(part => part.paths.flat());
        expect(inside(params, free).distances.filter(d => d < radius).length).toBeGreaterThan(20);
      }
    }
  }, 60000);

  it('lets mark-only changes redraw without touching simulation identity', async () => {
    const base = await render(config('step-30'));
    const baseState = parseCloudStateId(state(base))!;
    const variants: Params[] = [{ cloudPen: 'gold' }, { cloudHatchPitch: 4 }, { coreRadius: 70, coreX: 20, coreY: -90 }, { referenceDensity: 0.4 }];
    for (const change of variants) {
      const other = await render(config('step-30'), change);
      const otherState = parseCloudStateId(state(other))!;
      expect(otherState.stateKey).toBe(baseState.stateKey);
      expect(otherState.densityHash).toBe(baseState.densityHash);
      expect(otherState.relativeDrift).toBe(baseState.relativeDrift);
      expect(other.parts.filter(p => !p.diagnostic)).not.toEqual(base.parts.filter(p => !p.diagnostic));
    }
    // Obscuration only matters where cloud meets a member; at step 60 it sits on the right deck.
    const late = await render(config('step-60'));
    const lateLess = await render(config('step-60'), { obscure: 0.3 });
    expect(parseCloudStateId(state(lateLess))).toEqual(parseCloudStateId(state(late)));
    expect(structure(lateLess)).not.toEqual(structure(late));
    const gold = await render(config('step-30'), { cloudPen: 'gold' });
    expect(cloud(gold).map(p => p.id)).toEqual(['cloud-gold']);
    // A simulation parameter does change identity.
    const windy = await render(config('step-30'), { windX: 1.5 });
    expect(parseCloudStateId(state(windy))!.stateKey).not.toBe(baseState.stateKey);
  }, 60000);

  it('maps concentration to marks with a fixed mapping, never normalizing per frame', () => {
    const ctx = studyContext({ seed: 211, params: config('step-30').params });
    const study = buildStudy(ctx);
    const domain = buildDomain(study.config);
    const snapshot = simulate(study.config, [30])[0];
    const halved = { ...snapshot, density: snapshot.density.map(v => v / 2) };
    const extract = (s: typeof snapshot) => counts(extractMarks(domain, s, study, { cloudEnabled: true, hatchPitch: 1.35 })
      .filter(part => part.id.startsWith('cloud-') && !part.diagnostic));
    const before = JSON.stringify(snapshot);
    const full = extract(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
    const half = extract(halved);
    expect(full.points).toBeGreaterThan(1000);
    expect(half.points).toBeLessThan(full.points);
    expect(half.paths).toBeLessThan(full.paths);
  }, 30000);

  it('keeps cloud marks clear of visible member linework, and lets them cross concealed members', () => {
    const base = config('step-30').params;
    let nearest = Infinity;
    let crossed = 0;
    for (const obscure of [0.8, 0.3, 0]) {
      const study = buildStudy(studyContext({ seed: 211, params: { ...base, obscure } }));
      const domain = buildDomain(study.config);
      const clearance = MEMBER_CLEARANCE_MM / study.fit.scale;
      const rings = study.structure.map(member => member.polygon.map(study.worldToArt));
      const onEdge = (p: { x: number; y: number }) => rings.some(ring => ring.some((a, i) => distanceToSegment(p, a, ring[(i + 1) % ring.length]) < 1e-6));
      for (const snapshot of simulate(study.config, [0, 30, 60])) {
        const parts = extractMarks(domain, snapshot, study, { cloudEnabled: true, hatchPitch: 1.35 });
        // Outline runs are the structure segments that lie along a polygon edge; hatch lines cross the interior.
        const outline = parts.filter(part => part.id.startsWith('structure-')).flatMap(part => part.paths)
          .flatMap(path => path.slice(1).map((q, i) => [path[i], q] as const))
          .filter(([a, b]) => onEdge({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }));
        const cloudPoints = parts.filter(part => part.id.startsWith('cloud-') && !part.diagnostic).flatMap(part => part.paths.flat());
        expect(outline.length).toBeGreaterThan(0);
        expect(cloudPoints.length).toBeGreaterThan(100);
        for (const p of cloudPoints) for (const [a, b] of outline) nearest = Math.min(nearest, distanceToSegment(p, a, b) / clearance);
        // Cloud inside a member polygon is allowed only where the member is concealed.
        crossed += cloudPoints.filter(p => rings.some(ring => {
          let inside = false;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            if ((ring[i].y > p.y) !== (ring[j].y > p.y) && p.x < ((ring[j].x - ring[i].x) * (p.y - ring[i].y)) / (ring[j].y - ring[i].y) + ring[i].x) inside = !inside;
          }
          return inside;
        })).length;
        if (obscure === 0) {
          expect(cloudPoints.every(p => !rings.some(ring => {
            let inside = false;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
              if ((ring[i].y > p.y) !== (ring[j].y > p.y) && p.x < ((ring[j].x - ring[i].x) * (p.y - ring[i].y)) / (ring[j].y - ring[i].y) + ring[i].x) inside = !inside;
            }
            return inside;
          }))).toBe(true);
        }
      }
    }
    // `nearest` is the closest approach in units of the clearance.
    expect(nearest).toBeGreaterThanOrEqual(1 - 1e-9);
    expect(nearest).toBeLessThan(5);
    expect(crossed).toBeGreaterThan(0);
  }, 30000);

  it('wires the inflow boundary, weather front and source toggle into the simulation config', () => {
    const base = config('step-30').params;
    const open = buildStudy(studyContext({ seed: 211, params: base }));
    expect(open.config.front).toBeUndefined();
    expect(open.config.eddyDrift).toBeUndefined();
    const fixedKey = configHashes(open.config).stateKey;
    expect(configHashes(buildStudy(studyContext({ seed: 211, params: { ...base, eddyDrift: 'fixed' } })).config).stateKey).toBe(fixedKey);
    for (const eddyDrift of ['wind', 'kirchhoff']) {
      const drifting = buildStudy(studyContext({ seed: 211, params: { ...base, eddyDrift } }));
      expect(drifting.config.eddyDrift).toBe(eddyDrift);
      expect(configHashes(drifting.config).stateKey).not.toBe(fixedKey);
    }
    expect(open.config.settings.boundary).toBe('open');
    const inflow = buildStudy(studyContext({ seed: 211, params: { ...base, boundary: 'inflow', frontAmplitude: 0.9, frontScale: 9, frontCoverage: 0.42, frontSoftness: 0.3, fillInterior: false, sourceEnabled: false } }));
    expect(inflow.config.settings.boundary).toBe('inflow');
    expect(inflow.config.front).toMatchObject({ id: 'weather-front', kind: 'frozen-field', amplitude: 0.9, scale: 9, coverage: 0.42, softness: 0.3, fillInterior: false });
    expect(Number.isInteger(inflow.config.front!.seed)).toBe(true);
    expect(inflow.config.source.amplitude).toBe(0);
    expect(configHashes(inflow.config).stateKey).not.toBe(configHashes(open.config).stateKey);
    // The front is seeded from its own named stream, so the structure does not move when it changes.
    const other = buildStudy(studyContext({ seed: 212, params: { ...base, boundary: 'inflow' } }));
    expect(other.config.front!.seed).not.toBe(inflow.config.front!.seed);
  });

  it('orbit layout is the default, keeps the core free, and stays within its member and path budgets', async () => {
    expect(buildStudy(studyContext({ seed: 211, params: { posterMode: 'abstract' } })).layout).toBe('orbit');
    for (const seed of [1, 7, 23, 211, 1999]) {
      const study = buildStudy(studyContext({ seed, params: { layout: 'orbit', structureDensity: 0 } }));
      const members = study.structure;
      expect(members.length).toBeGreaterThanOrEqual(18);
      expect(members.length).toBeLessThanOrEqual(35);
      expect(new Set(members.map(m => m.id)).size).toBe(members.length);
      for (const member of members) {
        expect(distanceToPolygon(member.polygon, CORE_CENTER)).toBeGreaterThanOrEqual(CORE_KEEP_OUT - 1e-9);
      }
      // Some members reach out past the frame; some rails are thinner than a 0.4 m cell and must still block.
      expect(members.some(m => m.polygon.some(p => p.x < -1 || p.x > WORLD.width + 1 || p.y < -1 || p.y > WORLD.height + 1))).toBe(true);
      expect(members.some(m => m.kind === 'rail')).toBe(true);
      const pens = new Set(members.map(m => m.pen));
      expect(pens.has('cyan')).toBe(false);
      expect(pens.has('carbon') && pens.has('ultramarine')).toBe(true);
    }
    const spans = buildStudy(studyContext({ seed: 211, params: { layout: 'span' } })).structure;
    expect(spans.map(m => m.name)).toEqual(['deck-a', 'deck-b', 'deck-c', 'pier-a', 'pier-b', 'fin']);
    for (const structureDensity of [0, 0.6, 1]) {
      const off = await render(config('off'), { layout: 'orbit', structureDensity });
      expect(off.stats.pathCount).toBeLessThanOrEqual(2500);
      expect(cloud(off)).toEqual([]);
    }
  }, 30000);

  it('raising structureDensity only adds members: lower densities are a prefix and the core stays clear', () => {
    for (const seed of [211, 5, 42]) {
      const at = (structureDensity: number) => buildStudy(studyContext({ seed, params: { layout: 'orbit', structureDensity } })).structure;
      const [sparse, mid, dense] = [at(0), at(0.6), at(1)];
      expect(sparse.length).toBeLessThan(mid.length);
      expect(mid.length).toBeLessThan(dense.length);
      expect(dense.length).toBeLessThanOrEqual(75);
      for (const [low, high] of [[sparse, mid], [mid, dense], [sparse, dense]]) {
        const byId = new Map(high.map(m => [m.id, m]));
        for (const member of low) expect(byId.get(member.id), member.id).toEqual(member);
        // Relative draw order of the shared members is unchanged.
        const order = high.filter(m => low.some(l => l.id === m.id)).map(m => m.id);
        expect(order).toEqual(low.map(m => m.id));
      }
      for (const member of dense) expect(distanceToPolygon(member.polygon, CORE_CENTER)).toBeGreaterThanOrEqual(CORE_KEEP_OUT - 1e-9);
      // The same density gives the same layout, and the density does not touch the simulation's other inputs.
      expect(at(0.6)).toEqual(mid);
    }
  });

  describe('flow streaks', () => {
    const inflow: Params = { ...config('step-30').params, layout: 'orbit', markStyle: 'both', boundary: 'inflow', sourceEnabled: false, frontCoverage: 0.42, frontScale: 9, frontAmplitude: 1, coreRadius: 44, streakSpacing: 6 };
    const setup = (change: Params = {}) => {
      const study = buildStudy(studyContext({ seed: 211, params: { ...inflow, ...change } }));
      const domain = buildDomain(study.config);
      const snapshot = simulate(study.config, [30])[0];
      return { study, domain, snapshot };
    };
    const parts = (change: Params = {}) => {
      const { study, domain, snapshot } = setup(change);
      return { study, domain, snapshot, parts: extractMarks(domain, snapshot, study, { cloudEnabled: true, hatchPitch: 1.35 }) };
    };
    const streakPaths = (all: ReturnType<typeof parts>['parts']) => all.filter(p => p.id.startsWith('streak-')).flatMap(p => p.paths);
    const inRing = (ring: { x: number; y: number }[], p: { x: number; y: number }) => {
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if ((ring[i].y > p.y) !== (ring[j].y > p.y) && p.x < ((ring[j].x - ring[i].x) * (p.y - ring[i].y)) / (ring[j].y - ring[i].y) + ring[i].x) hit = !hit;
      }
      return hit;
    };

    it('exist, follow the style control, and are deterministic', () => {
      const first = parts();
      const again = parts();
      expect(streakPaths(first.parts).length).toBeGreaterThan(100);
      expect(again.parts).toEqual(first.parts);
      const bounded = first.parts.flatMap(p => p.paths).reduce((n, path) => n + path.length, 0);
      expect(bounded).toBeLessThan(150_000);
      const contours = parts({ markStyle: 'contours' });
      expect(contours.parts.some(p => p.id.startsWith('streak-'))).toBe(false);
      const streaks = parts({ markStyle: 'streaks' });
      expect(streaks.parts.some(p => p.id.startsWith('cloud-') && !p.diagnostic)).toBe(false);
      // The contour wisps do not depend on whether streaks are also drawn.
      const wisps = (all: typeof first.parts) => all.filter(p => p.id.startsWith('cloud-') && !p.diagnostic);
      expect(wisps(first.parts)).toEqual(wisps(contours.parts));
      expect(streakPaths(streaks.parts)).toEqual(streakPaths(first.parts));
      expect(first.parts.find(p => p.id.startsWith('streak-'))!.pen).toBe('coral');
    }, 30000);

    it('are absent from the quiet core and never touch a visible member', () => {
      let closest = Infinity;
      for (const obscure of [0.8, 0.3, 0]) {
        const { study, parts: all } = parts({ obscure });
        const streaks = streakPaths(all).flat();
        expect(streaks.length).toBeGreaterThan(500);
        const center = study.fit.inverse(study.marks.core.center);
        const radius = study.marks.core.radius / study.fit.scale;
        for (const p of streaks) expect(Math.hypot(p.x - center.x, p.y - center.y)).toBeGreaterThanOrEqual(radius);
        const rings = study.structure.map(m => m.polygon.map(study.worldToArt));
        const onEdge = (q: { x: number; y: number }) => rings.some(ring => ring.some((a, i) => distanceToSegment(q, a, ring[(i + 1) % ring.length]) < 1e-6));
        const outline = all.filter(p => p.id.startsWith('structure-')).flatMap(p => p.paths)
          .flatMap(path => path.slice(1).map((q, i) => [path[i], q] as const))
          .filter(([a, b]) => onEdge({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }));
        expect(outline.length).toBeGreaterThan(20);
        const clearance = MEMBER_CLEARANCE_MM / study.fit.scale;
        let nearest = Infinity;
        for (const p of streaks) for (const [a, b] of outline) nearest = Math.min(nearest, distanceToSegment(p, a, b));
        expect(nearest).toBeGreaterThanOrEqual(clearance * (1 - 1e-9));
        closest = Math.min(closest, nearest / clearance);
        // With obscuration off every member is visible, so no streak lies inside any member.
        if (obscure === 0) expect(streaks.some(p => rings.some(ring => inRing(ring, p)))).toBe(false);
      }
      // Not vacuous: streaks do run right up to members.
      expect(closest).toBeLessThan(6);
    }, 30000);

    it('use the fixed mapping: a thinner cloud draws fewer, shorter streaks', () => {
      const { study, domain, snapshot } = setup();
      const draw = (s: typeof snapshot) => {
        const paths = streakPaths(extractMarks(domain, s, study, { cloudEnabled: true, hatchPitch: 1.35 }));
        const length = paths.reduce((sum, path) => sum + path.slice(1).reduce((n, q, i) => n + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0), 0);
        return { count: paths.length, length };
      };
      const full = draw(snapshot);
      const half = draw({ ...snapshot, density: snapshot.density.map(v => v / 2) });
      expect(full.count).toBeGreaterThan(200);
      expect(half.count).toBeLessThan(full.count);
      expect(half.length).toBeLessThan(full.length * 0.8);
    }, 30000);
  });

  describe('contour minimum spacing', () => {
    const orbit = (change: Params = {}) => render(JSON.parse(readFileSync(resolve('sketches/cloud-advection/configs/orbit-step-30.json'), 'utf8')) as Request, change);
    const samples = (r: Result) => cloud(r).flatMap((part, pi) => part.paths.flatMap((path, i) => path.map(p => ({ ...p, id: `${pi}:${i}` }))));
    // Culling splits a wisp into several runs, so "different path" is checked as a path-pair distance
    // between runs that do not touch (shared cut ends belong to one wisp and sit within a step of each other).
    it('keeps ink from different wisps at least dmin apart, and 0 reproduces the unculled drawing', async () => {
      const off = await orbit({ contourMinSpacing: 0 });
      const on = await orbit({ contourMinSpacing: 0.55 });
      const request = JSON.parse(readFileSync(resolve('sketches/cloud-advection/configs/orbit-step-30.json'), 'utf8')) as Request;
      const finish = resolveFinishing(sketch.page, sketch.pens, request.finishing);
      const dmin = 0.55 * Number(request.params.cloudHatchPitch) * finish.scale;
      expect(off.stats.pointCount).not.toBe(on.stats.pointCount);
      expect(on.stats.pointCount).toBeLessThan(off.stats.pointCount);
      // Brute-force nearest sample on a grid, excluding samples within the same path.
      const pts = samples(on);
      const cell = dmin;
      const grid = new Map<string, typeof pts>();
      for (const p of pts) { const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(p); }
      let violations = 0;
      let nearest = Infinity;
      for (const p of pts) {
        const ci = Math.floor(p.x / cell), cj = Math.floor(p.y / cell);
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const q of grid.get(`${ci + di},${cj + dj}`) ?? []) {
          if (q.id === p.id) continue;
          const d = Math.hypot(p.x - q.x, p.y - q.y);
          nearest = Math.min(nearest, d);
          // Runs split from one wisp keep a gap far smaller than dmin only across a cut; allow those ends.
          if (d < dmin - 0.05) violations++;
        }
      }
      expect(pts.length).toBeGreaterThan(1000);
      // Pieces of one original wisp may sit close at a cut end; everything else must respect dmin.
      expect(violations / pts.length).toBeLessThan(0.0005);
      expect(nearest).toBeGreaterThan(0);
    }, 30000);

    it('is exactly the unculled output at 0, deterministic, and mark-only', async () => {
      const off = await orbit({ contourMinSpacing: 0 });
      const again = await orbit({ contourMinSpacing: 0 });
      expect(again.parts).toEqual(off.parts);
      const on = await orbit({ contourMinSpacing: 0.55 });
      expect((await orbit({ contourMinSpacing: 0.55 })).parts).toEqual(on.parts);
      const a = parseCloudStateId(state(off))!, b = parseCloudStateId(state(on))!;
      expect(b.stateKey).toBe(a.stateKey);
      expect(b.densityHash).toBe(a.densityHash);
      // Structure is not touched by the culling.
      expect(structure(on)).toEqual(structure(off));
    }, 30000);
  });

  describe('symmetric layouts', () => {
    type P = { x: number; y: number };
    const same = (a: P[], b: P[]): boolean => a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i].x) < 1e-9 && Math.abs(p.y - b[i].y) < 1e-9);
    /** True when some cyclic shift (either winding) of b matches a. */
    const sameRing = (a: P[], b: P[]): boolean => [b, [...b].reverse()].some(r => r.some((_, shift) => same(a, r.map((__, i) => r[(i + shift) % r.length]))));
    const mirror = (ring: P[]): P[] => ring.map(p => ({ x: 2 * CORE_CENTER.x - p.x, y: p.y }));
    const rotate = (ring: P[], by: number): P[] => ring.map(p => ({
      x: CORE_CENTER.x + (p.x - CORE_CENTER.x) * Math.cos(by) - (p.y - CORE_CENTER.y) * Math.sin(by),
      y: CORE_CENTER.y + (p.x - CORE_CENTER.x) * Math.sin(by) + (p.y - CORE_CENTER.y) * Math.cos(by),
    }));
    const area = (ring: P[]): number => Math.abs(ring.reduce((sum, p, i) => sum + p.x * ring[(i + 1) % ring.length].y - ring[(i + 1) % ring.length].x * p.y, 0)) / 2;
    const pensOf = (members: { pen: string }[]) => new Set(members.map(m => m.pen));

    it('colonnade: identical, equally spaced slabs in two rows, symmetric about the vertical axis, core clear', () => {
      for (const density of [0, 0.5, 1]) {
        const members = colonnadeLayout(density);
        expect(members.length).toBeGreaterThanOrEqual(6);
        const first = members[0].polygon;
        const w = Math.max(...first.map(p => p.x)) - Math.min(...first.map(p => p.x));
        const h = Math.max(...first.map(p => p.y)) - Math.min(...first.map(p => p.y));
        for (const m of members) {
          expect(Math.abs(area(m.polygon) - area(first))).toBeLessThan(1e-9);
          expect(m.hatchAngle).toBe(members[0].hatchAngle);
          expect(distanceToPolygon(m.polygon, CORE_CENTER)).toBeGreaterThanOrEqual(CORE_KEEP_OUT);
        }
        for (const row of ['u', 'l']) {
          const xs = members.filter(m => m.name.startsWith(row)).map(m => (Math.min(...m.polygon.map(p => p.x)) + Math.max(...m.polygon.map(p => p.x))) / 2);
          // Neighbouring slabs sit a whole number of equal pitches apart (the middle is left open for the core).
          const pitch = Math.min(...xs.slice(1).map((x, i) => x - xs[i]));
          for (let i = 1; i < xs.length; i++) {
            const steps = (xs[i] - xs[i - 1]) / pitch;
            expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
          }
          expect(Math.abs(pitch * Math.round(WORLD.width / pitch) - WORLD.width)).toBeLessThan(1e-9);
        }
        // Mirror pairs: every polygon has a mirror image in the same layout.
        for (const m of members) expect(members.some(o => sameRing(o.polygon, mirror(m.polygon))), m.name).toBe(true);
        expect(w).toBeGreaterThan(h);
        expect(pensOf(members).size).toBeLessThanOrEqual(2);
      }
    });

    it('portal: left and right members are exact mirror images, the core is clear, at most two pens', () => {
      const members = portalLayout();
      for (const m of members) {
        expect(distanceToPolygon(m.polygon, CORE_CENTER)).toBeGreaterThanOrEqual(CORE_KEEP_OUT);
        if (m.name.endsWith('-l')) {
          const twin = members.find(o => o.name === m.name.replace(/-l$/, '-r'))!;
          expect(sameRing(twin.polygon, mirror(m.polygon)), m.name).toBe(true);
          expect(twin.pen).toBe(m.pen);
          expect(Math.abs(Math.PI - m.hatchAngle - twin.hatchAngle)).toBeLessThan(1e-9);
        }
      }
      const lintel = members.find(m => m.name === 'lintel')!;
      expect(sameRing(lintel.polygon, mirror(lintel.polygon))).toBe(true);
      expect(members.some(m => m.polygon.some(p => p.x < 0))).toBe(true);
      expect(pensOf(members).size).toBeLessThanOrEqual(2);
    });

    it('ring: n slabs are exact rotations of one another, inner ends at one radius, core clear', () => {
      for (const n of [4, 8, 12]) {
        const members = ringLayout(n);
        const slabs = members.filter(m => m.kind === 'slab');
        const rails = members.filter(m => m.kind === 'rail');
        expect(slabs).toHaveLength(n);
        expect(rails).toHaveLength(n);
        for (const group of [slabs, rails]) {
          group.forEach((m, k) => {
            expect(sameRing(m.polygon, rotate(group[0].polygon, (2 * Math.PI * k) / n)), `${m.name} of ${n}`).toBe(true);
            expect(distanceToPolygon(m.polygon, CORE_CENTER)).toBeGreaterThanOrEqual(CORE_KEEP_OUT);
          });
        }
        const inner = slabs.map(m => Math.min(...m.polygon.map(p => Math.hypot(p.x - CORE_CENTER.x, p.y - CORE_CENTER.y))));
        for (const r of inner) expect(Math.abs(r - inner[0])).toBeLessThan(1e-9);
        expect(pensOf(members).size).toBeLessThanOrEqual(2);
      }
      // The control is wired into the study.
      const study = buildStudy(studyContext({ seed: 1, params: { layout: 'ring', ringCount: 6 } }));
      expect(study.structure.filter(m => m.kind === 'slab')).toHaveLength(6);
    });

    it('is independent of the seed (no jitter) and renders within the path budget, with thin members still blocking', async () => {
      for (const layout of ['colonnade', 'portal', 'ring']) {
        const a = buildStudy(studyContext({ seed: 1, params: { layout } })).structure;
        const b = buildStudy(studyContext({ seed: 999, params: { layout } })).structure;
        expect(a).toEqual(b);
        const off = await render(config('off'), { layout });
        expect(off.stats.pathCount).toBeLessThanOrEqual(2500);
      }
      // A thin portal rail (0.3 m, thinner than a 0.4 m cell) casts a clean wake: concentration upstream, none behind it.
      const params = { ...config('step-30').params, layout: 'portal', boundary: 'inflow', frontAmplitude: 1, frontScale: 12, frontCoverage: 0.6, windX: 0, windY: 1, eddyCirculation: 0, sourceEnabled: false };
      const study = buildStudy(studyContext({ seed: 211, params }));
      const domain = buildDomain(study.config);
      const snapshot = simulate(study.config, [60])[0];
      const rail = study.structure.find(m => m.name === 'rail1-l')!;
      const xs = rail.polygon.map(p => p.x), ys = rail.polygon.map(p => p.y);
      const x = (Math.min(...xs) + Math.max(...xs)) / 2;
      const above = (y: number) => snapshot.density[Math.floor(y / study.config.transforms.worldToGrid.spacing) * domain.cols + Math.floor(x / study.config.transforms.worldToGrid.spacing)];
      const yTop = Math.min(...ys), yBottom = Math.max(...ys);
      let up = 0, behind = 0;
      for (let k = 1; k <= 6; k++) { up += above(yTop - 0.4 * k); behind += above(yBottom + 0.4 * k + 0.4); }
      expect(up).toBeGreaterThan(0.2);
      expect(behind).toBeLessThan(up * 0.35);
    }, 60000);
  });

  describe('sun layout', () => {
    type P = { x: number; y: number };
    const stream = (seed: number) => studyContext({ seed, params: {} }).random('sun-noise');
    const sun = (noise: number, over: Partial<Parameters<typeof sunLayout>[0]> = {}, seed = 211) =>
      sunLayout({ rays: 32, inner: 12, reach: 30, alternate: 0.55, rings: 2, noise, random: stream(seed), ...over });
    const rotate = (ring: P[], by: number): P[] => ring.map(p => ({
      x: CORE_CENTER.x + (p.x - CORE_CENTER.x) * Math.cos(by) - (p.y - CORE_CENTER.y) * Math.sin(by),
      y: CORE_CENTER.y + (p.x - CORE_CENTER.x) * Math.sin(by) + (p.y - CORE_CENTER.y) * Math.cos(by),
    }));
    const close = (a: P[], b: P[]): boolean => a.length === b.length && a.every((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y) < 1e-9);

    it('has exact rotational symmetry at noise 0 (by two ray steps) and is seed independent', () => {
      const n = 32;
      const members = sun(0);
      const rays = members.filter(m => m.kind === 'ray');
      expect(rays).toHaveLength(n);
      rays.forEach((m, k) => {
        // Even rays are long, odd rays short: each repeats every two steps.
        expect(close(m.polygon, rotate(rays[k % 2].polygon, ((k - (k % 2)) * 2 * Math.PI) / n)), m.name).toBe(true);
      });
      for (const ring of [1, 2]) {
        const arcs = members.filter(m => m.name.startsWith(`ring${ring}-`));
        expect(arcs).toHaveLength(n);
        // Arcs sit between a long and a short ray, so they repeat every two steps like the rays.
        arcs.forEach((m, k) => expect(close(m.polygon, rotate(arcs[k % 2].polygon, ((k - (k % 2)) * 2 * Math.PI) / n)), m.name).toBe(true));
      }
      const spikes = members.filter(m => m.kind === 'spike');
      expect(spikes).toHaveLength(n * 3);
      expect(sun(0, {}, 1)).toEqual(sun(0, {}, 999));
      expect(new Set(members.map(m => m.pen)).size).toBeLessThanOrEqual(2);
      expect(members.every(m => m.pen !== 'cyan')).toBe(true);
    });

    it('is deterministic with noise, perturbs the layout, and never reaches the core', () => {
      expect(sun(0.4)).toEqual(sun(0.4));
      expect(sun(0.4, {}, 1)).not.toEqual(sun(0.4, {}, 2));
      expect(sun(0.4)).not.toEqual(sun(0));
      // The noise control scales fixed draws, so the member list keeps its identity.
      expect(sun(0.4).length).toBeGreaterThan(sun(0).length * 0.8);
      for (const noise of [0, 0.15, 1]) {
        for (const seed of [1, 2, 3]) {
          for (const m of sun(noise, { rays: 24, rings: 3 }, seed)) {
            expect(distanceToPolygon(m.polygon, CORE_CENTER), `${m.name} noise ${noise}`).toBeGreaterThanOrEqual(CORE_KEEP_OUT);
          }
        }
      }
    });

    it('tapers rays to a tip thinner than a grid cell, draws parallel strokes that end as the wedge narrows', () => {
      const study = buildStudy(studyContext({ seed: 211, params: { layout: 'sun', sunNoise: 0.4 } }));
      const rays = study.structure.filter(m => m.kind === 'ray');
      expect(rays.length).toBe(22);
      const cell = study.config.transforms.worldToGrid.spacing;
      for (const ray of rays) {
        const [a, tip, b] = ray.polygon;
        const baseWidth = Math.hypot(a.x - b.x, a.y - b.y);
        expect(baseWidth).toBeGreaterThan(cell);
        // Width of the wedge a cell-length short of the tip is already narrower than a cell.
        const length = Math.hypot(tip.x - (a.x + b.x) / 2, tip.y - (a.y + b.y) / 2);
        expect((baseWidth * cell) / length).toBeLessThan(cell);
        const lines = ray.strokes!;
        expect(lines.length).toBeGreaterThanOrEqual(1);
        const lengths = lines.map(l => Math.hypot(l[1].x - l[0].x, l[1].y - l[0].y));
        expect(Math.max(...lengths)).toBeCloseTo(length, 6);
        if (lines.length > 1) expect(Math.min(...lengths)).toBeLessThan(Math.max(...lengths) * 0.99);
      }
    });

    it('wires the controls, stays within the path budget, and lets wakes form behind thin rays', async () => {
      const sunParams: Params = { layout: 'sun', sunRays: 48, sunRings: 3, sunNoise: 0.4 };
      const off = await render(config('off'), sunParams);
      expect(off.stats.pathCount).toBeLessThanOrEqual(2500);
      expect(cloud(off)).toEqual([]);
      const study = buildStudy(studyContext({ seed: 211, params: { ...sunParams, sunRays: 48 } }));
      expect(study.structure.filter(m => m.kind === 'ray')).toHaveLength(48);
      expect(study.structure.some(m => m.kind === 'spike')).toBe(true);
      expect(study.structure.filter(m => m.name.startsWith('ring')).length).toBeGreaterThan(48 * 2);
      // Rings 0 gives no bands and no corona.
      expect(buildStudy(studyContext({ seed: 211, params: { layout: 'sun', sunRings: 0 } })).structure.every(m => m.kind === 'ray')).toBe(true);
      // The presentation configuration keeps every solid's strokes inside the structure budget at the maximum ray count.
      const dense = await render(config('off'), { layout: 'sun', sunRays: 72, sunRings: 3 });
      expect(dense.stats.pathCount).toBeLessThanOrEqual(2500);
    }, 60000);

    it('draws the corona (and, by default, the ring bands) without making solids; sunSolidRings turns the bands solid', () => {
      const params = { layout: 'sun', sunRays: 22, sunRings: 2 };
      const drawnOnly = buildStudy(studyContext({ seed: 211, params }));
      const solidIds = new Set(drawnOnly.config.solids.map(solid => solid.id));
      const rays = drawnOnly.structure.filter(m => m.kind === 'ray');
      const arcs = drawnOnly.structure.filter(m => m.kind === 'arc');
      const spikes = drawnOnly.structure.filter(m => m.kind === 'spike');
      expect(rays).toHaveLength(22);
      expect(arcs.length).toBeGreaterThan(22);
      expect(spikes.length).toBeGreaterThan(0);
      // Only the rays are in the simulation; everything else is drawn only (and is still drawn).
      expect([...solidIds].sort()).toEqual(rays.map(m => m.id).sort());
      expect(drawnOnly.config.solids).toHaveLength(22);
      for (const m of [...arcs, ...spikes]) { expect(m.solid).toBe(false); expect(m.strokes!.length).toBeGreaterThan(0); }
      const solidRings = buildStudy(studyContext({ seed: 211, params: { ...params, sunSolidRings: true } }));
      expect(solidRings.config.solids).toHaveLength(22 + arcs.length);
      expect(solidRings.config.solids.some(solid => solid.id.includes('spike'))).toBe(false);
      expect(configHashes(solidRings.config).stateKey).not.toBe(configHashes(drawnOnly.config).stateKey);
      // Ring arcs fill at most half of their sector, so there is a gap for the weather between arcs.
      const angleOf = (poly: { x: number; y: number }[]) => poly.map(p => Math.atan2(p.y - CORE_CENTER.y, p.x - CORE_CENTER.x));
      const first = angleOf(arcs.find(m => m.name === 'ring1-01')!.polygon);
      const span = Math.max(...first) - Math.min(...first);
      expect(span).toBeLessThan(((2 * Math.PI) / 22) * 0.55);
      // The whole sun sits inside the content width with room to spare (outer extent below 22 m of the 24 m half-width).
      const reach = Math.max(...drawnOnly.structure.flatMap(m => m.polygon.map(p => Math.hypot(p.x - CORE_CENTER.x, p.y - CORE_CENTER.y))));
      expect(reach).toBeLessThan(22);
    });

    it('wires the eddy train: controls reach the config, fixed drift is coerced, and the train changes the state', () => {
      const base = { ...config('step-30').params, layout: 'sun' };
      const plain = buildStudy(studyContext({ seed: 211, params: base }));
      expect(plain.config.eddyTrain).toBeUndefined();
      const train = buildStudy(studyContext({ seed: 211, params: { ...base, trainEnabled: true, trainPeriod: 24, trainCirculation: 55, trainCore: 3, trainAlternate: false, trainJitter: 0.6 } }));
      expect(train.config.eddyTrain).toMatchObject({ id: 'eddy-train', period: 24, circulation: 55, coreRadius: 3, alternate: false, lateralJitter: 0.6, timingJitter: 0 });
      expect(Number.isInteger(train.config.eddyTrain!.seed)).toBe(true);
      expect(train.config.eddyDrift).toBe('kirchhoff');
      expect(buildStudy(studyContext({ seed: 211, params: { ...base, trainEnabled: true, eddyDrift: 'wind' } })).config.eddyDrift).toBe('wind');
      expect(configHashes(train.config).stateKey).not.toBe(configHashes(plain.config).stateKey);
      const other = buildStudy(studyContext({ seed: 212, params: { ...base, trainEnabled: true } }));
      expect(other.config.eddyTrain!.seed).not.toBe(train.config.eddyTrain!.seed);
      // Mark-only changes still leave the train's state alone.
      const marked = buildStudy(studyContext({ seed: 211, params: { ...base, trainEnabled: true, trainPeriod: 24, trainCirculation: 55, trainCore: 3, trainAlternate: false, trainJitter: 0.6, obscure: 0.3, cloudHatchPitch: 3 } }));
      expect(configHashes(marked.config).stateKey).toBe(configHashes(train.config).stateKey);
    });
  });

  describe('weatherSeed', () => {
    const base = (): Request => JSON.parse(readFileSync(resolve('sketches/cloud-advection/configs/weather-b-mid.json'), 'utf8')) as Request;

    it('0 reproduces the pre-weatherSeed drawing exactly (state key, density hash, parts)', async () => {
      // Baseline recorded from configs/weather-b-mid.json before the control existed. The render identity
      // hashes the control list, so it necessarily changed with the new slider; the drawing did not.
      const result = await render(base());
      const id = parseCloudStateId(state(result))!;
      expect(id.stateKey).toBe('37b804d46fd36d63');
      expect(id.densityHash).toBe('eac7d04ffd5085c1');
      expect(result.stats).toMatchObject({ pathCount: 926, pointCount: 24276, lengthMm: 16101.575 });
      expect((await render(base(), { weatherSeed: 0 })).identity).toBe(result.identity);
    }, 30000);

    it('changes the weather but never the structure, deterministically', async () => {
      const zero = await render(base());
      const one = await render(base(), { weatherSeed: 1 });
      const again = await render(base(), { weatherSeed: 1 });
      expect(again.parts).toEqual(one.parts);
      expect(parseCloudStateId(state(one))!.stateKey).not.toBe(parseCloudStateId(state(zero))!.stateKey);
      expect(cloud(one)).not.toEqual(cloud(zero));
      // The drawn structure is only concealed by weather, so compare it with obscuration off (and with the cloud off).
      const clear = { obscure: 0 };
      expect(structure(await render(base(), { ...clear, weatherSeed: 1 }))).toEqual(structure(await render(base(), clear)));
      expect(structure(await render(base(), { cloudEnabled: false, weatherSeed: 1 }))).toEqual(structure(await render(base(), { cloudEnabled: false })));
      const study = (weatherSeed: number) => buildStudy(studyContext({ seed: 211, params: { ...base().params, weatherSeed } }));
      expect(study(7).structure).toEqual(study(0).structure);
      expect(study(7).marks.wispSeed).toBe(study(0).marks.wispSeed);
      expect(study(7).config.front!.seed).not.toBe(study(0).config.front!.seed);
      expect(study(7).config.source.seed).not.toBe(study(0).config.source.seed);
      const train = { trainEnabled: true };
      const t0 = buildStudy(studyContext({ seed: 211, params: { ...base().params, ...train } })).config.eddyTrain!.seed;
      expect(buildStudy(studyContext({ seed: 211, params: { ...base().params, ...train, weatherSeed: 7 } })).config.eddyTrain!.seed).not.toBe(t0);
    }, 60000);
  });
});
