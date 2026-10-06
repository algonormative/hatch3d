import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { inPolygon, MIN_SPACING } from '../../sketches/chamber-bloom-foam/geometry.ts';
import type { Point, RenderResult } from '../sketch/types.ts';
import { renderSketch } from '../../cli/sketch/runner.ts';

const entry = resolve('sketches/chamber-bloom-foam/sketch.ts');
const art = { left: 18, right: 261.4, top: 18, bottom: 413.8 };
const SEED = 307;
const LAMELLAE = ['blue-lamellae', 'hot-inner-lip', 'violet-murmurs'];
const SHELL = [...LAMELLAE, 'shared-walls', 'outer-rims', 'crater-lips'];

const part = (r: RenderResult, id: string) => r.parts.find(p => p.id === id)!;
type Sample = Point & { path: number; part: string };
function samples(r: RenderResult, ids: string[], step = 0.25): Sample[] {
  const out: Sample[] = [];
  let path = 0;
  for (const id of ids) for (const line of part(r, id).paths) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let j = 0; j < k; j++) out.push({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k, path, part: id });
    }
    out.push({ ...line[line.length - 1], path, part: id });
    path++;
  }
  return out;
}
function hash(points: Sample[], cell: number) {
  const map = new Map<string, Sample[]>();
  for (const p of points) { const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`; (map.get(k) ?? map.set(k, []).get(k)!).push(p); }
  return (p: Point, reach: number, visit: (q: Sample) => void) => {
    const r = Math.ceil(reach / cell), ix = Math.floor(p.x / cell), iy = Math.floor(p.y / cell);
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (const q of map.get(`${ix + a},${iy + b}`) ?? []) visit(q);
  };
}
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
/** Median lamella spacing within 5 mm of a shared wall and more than 30 mm from any. */
function pressureProfile(r: RenderResult) {
  const blue = samples(r, ['blue-lamellae']);
  const near = hash(blue, 1), walls = hash(samples(r, ['shared-walls']), 5);
  const atWall: number[] = [], inside: number[] = [];
  for (let s = 0; s < blue.length; s += 6) {
    const p = blue[s];
    let spacing = Infinity, wall = Infinity;
    near(p, 6, q => { if (q.path !== p.path) spacing = Math.min(spacing, Math.hypot(q.x - p.x, q.y - p.y)); });
    walls(p, 30, q => { wall = Math.min(wall, Math.hypot(q.x - p.x, q.y - p.y)); });
    if (spacing > 6) continue;
    if (wall < 5) atWall.push(spacing); else if (wall > 30) inside.push(spacing);
  }
  return { atWall, inside };
}

describe('Chamber Bloom: Pressure Foam', () => {
  it('replays exactly, varies with seed, inks five pens and stays on the tall sheet within budget', async () => {
    const first = await renderSketch({ entry, seed: SEED });
    const replay = await renderSketch({ entry, seed: SEED });
    const other = await renderSketch({ entry, seed: 29 });
    expect(replay.identity).toBe(first.identity);
    expect(other.parts).not.toEqual(first.parts);
    for (const result of [first, other]) {
      expect(result.diagnostics).toEqual([]);
      expect(result.params.posterMode).toBe('abstract');
      expect(result.stats.pathCount).toBeLessThanOrEqual(8000);
      expect(result.stats.lengthMm).toBeLessThanOrEqual(90_000);
      const counts = new Map(result.metadata.pens.map(pen => [pen.id, 0]));
      for (const p of result.parts.filter(p => !p.diagnostic)) {
        counts.set(p.pen, (counts.get(p.pen) ?? 0) + p.paths.length);
        for (const path of p.paths) {
          let len = 0;
          for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
          expect(len).toBeGreaterThanOrEqual(0.5);
          for (const q of path) {
            expect(Number.isFinite(q.x) && Number.isFinite(q.y)).toBe(true);
            expect(q.x).toBeGreaterThanOrEqual(art.left); expect(q.x).toBeLessThanOrEqual(art.right);
            expect(q.y).toBeGreaterThanOrEqual(art.top); expect(q.y).toBeLessThanOrEqual(art.bottom);
          }
        }
      }
      for (const count of counts.values()) expect(count).toBeGreaterThan(5);
    }
    // The art fills the tall sheet, not the old wide band.
    const ys = first.parts.filter(p => !p.diagnostic).flatMap(p => p.paths.flat().map(q => q.y));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(360);
  }, 60_000);

  it('builds a pressure foam: several chambers, shared walls, and lamellae that tighten toward them but never below 0.5 mm', async () => {
    const result = await renderSketch({ entry, seed: SEED });
    expect(part(result, 'foam-craters').boundary!.length).toBeGreaterThanOrEqual(2);
    expect(part(result, 'shared-walls').paths.length).toBeGreaterThan(0);
    const { atWall, inside } = pressureProfile(result);
    expect(atWall.length).toBeGreaterThan(200);
    expect(inside.length).toBeGreaterThan(200);
    expect(median(atWall)).toBeLessThan(median(inside) * 0.5);

    // An accent colour continues its lamella from the exact end point: join such pieces into one physical line.
    const shell = samples(result, SHELL, 0.2);
    const root: number[] = [];
    const find = (i: number): number => (root[i] ?? i) === i ? i : (root[i] = find(root[i]!));
    const ends = new Map<string, number>();
    let index = 0;
    for (const id of SHELL) for (const path of part(result, id).paths) {
      if (LAMELLAE.includes(id)) for (const q of [path[0], path[path.length - 1]]) {
        const key = `${q.x.toFixed(3)},${q.y.toFixed(3)}`;
        const seen = ends.get(key);
        if (seen === undefined) ends.set(key, index); else root[find(index)] = find(seen);
      }
      index++;
    }
    const lookup = hash(shell, 1);
    let closest = Infinity;
    for (const p of shell) {
      if (!LAMELLAE.includes(p.part)) continue;
      lookup(p, 1, q => { if (find(q.path) !== find(p.path)) closest = Math.min(closest, Math.hypot(q.x - p.x, q.y - p.y)); });
    }
    expect(closest).toBeGreaterThanOrEqual(MIN_SPACING);
  }, 60_000);

  it('lets the main buttress mask every lamella it crosses', async () => {
    const result = await renderSketch({ entry, seed: SEED });
    const main = part(result, 'foam-buttress-masks').boundary![0];
    const lamellae = LAMELLAE.flatMap(id => part(result, id).paths);
    expect(lamellae.flat().filter(p => inPolygon(p, main))).toEqual([]);
    // It actually cuts through the cluster: many lamellae end against its outline.
    const edge = hash(samples(result, ['stepped-buttress']), 2);
    const cut = lamellae.flatMap(path => [path[0], path[path.length - 1]]).filter(p => {
      let d = Infinity;
      edge(p, 1, q => { d = Math.min(d, Math.hypot(q.x - p.x, q.y - p.y)); });
      return d < 0.6;
    });
    expect(cut.length).toBeGreaterThan(40);
  }, 60_000);

  it('responds to chamber count and wall pressure', async () => {
    const two = await renderSketch({ entry, seed: SEED, params: { chamberCount: 2 } });
    const four = await renderSketch({ entry, seed: SEED, params: { chamberCount: 4 } });
    expect(part(two, 'foam-craters').boundary!.length).toBe(2);
    expect(part(four, 'foam-craters').boundary!.length).toBeGreaterThan(2);
    const slack = pressureProfile(await renderSketch({ entry, seed: SEED, params: { pressure: 0 } }));
    const squeezed = pressureProfile(await renderSketch({ entry, seed: SEED, params: { pressure: 1 } }));
    expect(median(squeezed.atWall)).toBeLessThan(median(slack.atWall) * 0.6);
  }, 90_000);
});
