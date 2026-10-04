import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectSketch, renderSketch } from '../../cli/sketch/runner.ts';
import { resolveFinishing } from '../../packages/plot-core/src/index.ts';
import { MEMBER_CLEARANCE_MM, distanceToSegment, extractMarks, parseCloudStateId } from '../../sketches/cloud-advection/extract.ts';
import { studyContext } from '../../sketches/cloud-advection/evidence.ts';
import { buildDomain, simulate } from '../../sketches/cloud-advection/sim.ts';
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
    for (const id of ['cloudEnabled', 'step', 'windX', 'windY', 'eddyX', 'eddyY', 'eddyCirculation', 'eddyCore', 'dispersion', 'boundary',
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
});
