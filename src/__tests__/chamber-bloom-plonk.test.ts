import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { inPolygon, MIN_SPACING } from '../../sketches/chamber-bloom-plonk/geometry.ts';
import type { Point, RenderResult } from '../sketch/types.ts';
import { renderSketch } from '../../cli/sketch/runner.ts';

const entry = resolve('sketches/chamber-bloom-plonk/sketch.ts');
const art = { left: 18, right: 261.4, top: 18, bottom: 413.8 };
const SEED = 17;
const SHELL = ['cell-membrane', 'crater-lips', 'blue-lamellae', 'hot-pinch'];
const LAMELLAE = ['blue-lamellae', 'hot-pinch'];

const part = (r: RenderResult, id: string) => r.parts.find(p => p.id === id)!;
const boundary = (r: RenderResult, id: string) => part(r, id).boundary![0];
type Sample = Point & { path: number; s: number; part: string; loop: number };
function samples(r: RenderResult, ids: string[], step = 0.2): Sample[] {
  const out: Sample[] = [];
  let path = 0;
  for (const id of ids) for (const line of part(r, id).paths) {
    let s = 0;
    const start = out.length;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], len = Math.hypot(b.x - a.x, b.y - a.y), k = Math.max(1, Math.ceil(len / step));
      for (let j = 0; j < k; j++) out.push({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k, path, s: s + len * j / k, part: id, loop: 0 });
      s += len;
    }
    out.push({ ...line[line.length - 1], path, s, part: id, loop: 0 });
    // Closed rings: arclength wraps at the seam.
    const end = line[line.length - 1];
    const loop = Math.hypot(end.x - line[0].x, end.y - line[0].y) < 1e-6 ? s : 0;
    for (let k = start; k < out.length; k++) out[k].loop = loop;
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
const area = (poly: Point[]) => Math.abs(poly.reduce((acc, p, i) => { const q = poly[(i + 1) % poly.length]; return acc + p.x * q.y - q.x * p.y; }, 0)) / 2;
const bbox = (poly: Point[]) => {
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
};
/** Plank frame from its mask: polygon[0..1] is the underside, left to right. */
function plankFrame(r: RenderResult) {
  const poly = boundary(r, 'plonk-plank-mask');
  const [a, b] = poly;
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const along = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }, up = { x: along.y, y: -along.x };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return { poly, L, local: (p: Point) => ({ u: (p.x - mid.x) * along.x + (p.y - mid.y) * along.y, v: (p.x - mid.x) * up.x + (p.y - mid.y) * up.y }) };
}

describe('Chamber Bloom: Plonk', () => {
  it('replays exactly, varies with seed, inks five pens and stays in the content area within budget', async () => {
    const first = await renderSketch({ entry, seed: SEED });
    const replay = await renderSketch({ entry, seed: SEED });
    const other = await renderSketch({ entry, seed: 640 });
    expect(replay.identity).toBe(first.identity);
    expect(other.parts).not.toEqual(first.parts);
    for (const result of [first, other]) {
      expect(result.diagnostics).toEqual([]);
      expect(result.params.posterMode).toBe('abstract');
      expect(result.stats.pathCount).toBeLessThanOrEqual(5000);
      expect(result.stats.lengthMm).toBeLessThanOrEqual(70_000);
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
      expect(counts.size).toBe(5);
      for (const count of counts.values()) expect(count).toBeGreaterThan(3);
    }
  }, 60_000);

  it('keeps every shell line out of the plank and at least 0.5 mm from every other line', async () => {
    const result = await renderSketch({ entry, seed: SEED });
    const { poly } = plankFrame(result);
    const shell = samples(result, SHELL);
    expect(shell.filter(p => inPolygon(p, poly))).toEqual([]);
    // The cell actually meets the slab: lamellae end against its outline.
    const outline = hash(samples(result, ['plank-outline']), 2);
    let crowding = Infinity, against = 0;
    for (const p of shell) outline(p, 1, q => { const d = Math.hypot(q.x - p.x, q.y - p.y); crowding = Math.min(crowding, d); if (d < 1) against++; });
    expect(against).toBeGreaterThan(20);
    expect(crowding).toBeGreaterThanOrEqual(MIN_SPACING);
    // Separate lines, or far-apart stretches of one line, never come closer than the pen floor.
    const lookup = hash(shell, 1);
    let closest = Infinity;
    for (const p of shell) lookup(p, 1, q => {
      if (q.path === p.path) {
        const ds = Math.abs(q.s - p.s);
        if (ds < 2 || (p.loop > 0 && p.loop - ds < 2)) return;
      }
      closest = Math.min(closest, Math.hypot(q.x - p.x, q.y - p.y));
    });
    expect(closest).toBeGreaterThanOrEqual(MIN_SPACING);
  }, 60_000);

  it('packs the lamellae under the plank and lets them balloon open in the bulges', async () => {
    const result = await renderSketch({ entry, seed: SEED });
    const { L, local } = plankFrame(result);
    const lam = samples(result, LAMELLAE);
    const near = hash(lam, 1);
    const under: number[] = [], bulge: number[] = [];
    for (let i = 0; i < lam.length; i += 4) {
      const p = lam[i];
      let spacing = Infinity;
      near(p, 8, q => { if (q.path !== p.path) spacing = Math.min(spacing, Math.hypot(q.x - p.x, q.y - p.y)); });
      if (spacing > 8) continue;
      const { u, v } = local(p);
      if (Math.abs(u) < L / 2 - 10 && v < 0 && v > -18) under.push(spacing);
      else if (Math.abs(u) > L / 2 + 12 && p.y < art.bottom - 30) bulge.push(spacing);
    }
    expect(under.length).toBeGreaterThan(200);
    expect(bulge.length).toBeGreaterThan(200);
    expect(median(under)).toBeLessThan(median(bulge) * 0.6);
  }, 60_000);

  it('squashes: wider and shorter as squash rises, area conserved, crater still open', async () => {
    const results = [];
    for (const squash of [0, 0.3, 0.6, 1]) results.push(await renderSketch({ entry, seed: SEED, params: { squash } }));
    const shapes = results.map(r => ({ box: bbox(boundary(r, 'plonk-membrane')), area: area(boundary(r, 'plonk-membrane')), rest: area(boundary(r, 'plonk-rest')) }));
    for (let k = 1; k < shapes.length; k++) {
      expect(shapes[k].box.width).toBeGreaterThan(shapes[k - 1].box.width + 5);
      expect(shapes[k].box.height).toBeLessThan(shapes[k - 1].box.height - 5);
    }
    expect(shapes[3].box.width / shapes[3].box.height).toBeGreaterThan(2 * shapes[0].box.width / shapes[0].box.height);
    for (const s of shapes) expect(Math.abs(s.area / s.rest - 1)).toBeLessThanOrEqual(0.2);
    // The rest outline is the same cell every time: squash reshuffles nothing.
    expect(shapes.every(s => Math.abs(s.rest - shapes[0].rest) < 1e-6)).toBe(true);

    for (const r of results) {
      const crater = boundary(r, 'plonk-crater');
      const { width, height } = bbox(crater);
      expect(height).toBeGreaterThan(12);
      expect(width).toBeGreaterThan(40);
      // Quiet paper: no ink inside the crater apart from its own lip.
      const ink = r.parts.filter(p => !p.diagnostic && p.id !== 'crater-lips').flatMap(p => p.paths.flat());
      expect(ink.filter(q => inPolygon(q, crater))).toEqual([]);
      expect(part(r, 'crater-lips').paths.length).toBeGreaterThan(0);
    }
  }, 90_000);
});
