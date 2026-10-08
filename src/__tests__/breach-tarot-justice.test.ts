import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/xi-justice/sketch.ts');

type Pt = { x: number; y: number };
const paths = (parts: { id: string; paths: Pt[][] }[], id: string) => parts.find(p => p.id === id)?.paths ?? [];
/** Points along every path, a half millimetre apart, so a centroid weighs ink and not vertices. */
const sampled = (list: Pt[][]): Pt[] => list.flatMap(path => path.slice(1).flatMap((p, i) => {
  const a = path[i], k = Math.max(1, Math.ceil(Math.hypot(p.x - a.x, p.y - a.y) / 0.5));
  return Array.from({ length: k }, (_, j) => ({ x: a.x + (p.x - a.x) * (j + 0.5) / k, y: a.y + (p.y - a.y) * (j + 0.5) / k }));
}));
const centroid = (pts: Pt[]): Pt => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });

describe('Breach Tarot: XI Justice', () => {
  it('replays, stays inside the card, and draws the sky, the shadow, the column, the beam, the pans, the heap, the helix, the phrase, the horizon and the frame', async () => {
    const first = await renderSketch({ entry, seed: 3 });
    const replay = await renderSketch({ entry, seed: 3 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(CARD.x0 - 0.01);
      expect(p.x).toBeLessThanOrEqual(CARD.x1 + 0.01);
      expect(p.y).toBeGreaterThanOrEqual(CARD.top - 0.01);
      expect(p.y).toBeLessThanOrEqual(CARD.bottom + 0.01);
    }
    const ids = first.parts.map(p => p.id);
    for (const id of ['sky-carbon', 'shadow-beam-carbon', 'shadow-carbon', 'column-carbon', 'beam-carbon', 'pans-carbon', 'pile-carbon', 'horizon-carbon', 'slogan-lettering', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('is level but its shadow is not: the beam is horizontal on the sheet, and its shadow tips 8 to 15 degrees with the heap\'s end down', async () => {
    const result = await renderSketch({ entry, seed: 3 });
    // The beam: its top edge, the highest ink at each stretch along it, runs level on the sheet.
    const beam = paths(result.parts, 'beam-carbon').flat();
    const top = new Map<number, number>();
    for (const p of beam) { const k = Math.floor(p.x / 10); top.set(k, Math.min(top.get(k) ?? Infinity, p.y)); }
    const ymin = Math.min(...top.values());
    const edge = [...top.entries()].filter(([, y]) => y < ymin + 3).map(([k, y]) => ({ x: k * 10 + 5, y }));
    expect(edge.length).toBeGreaterThan(12);
    const mx = edge.reduce((s, p) => s + p.x, 0) / edge.length, my = edge.reduce((s, p) => s + p.y, 0) / edge.length;
    const slope = edge.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / edge.reduce((s, p) => s + (p.x - mx) ** 2, 0);
    expect(Math.abs(Math.atan(slope) * 180 / Math.PI)).toBeLessThan(0.5);
    // The heap's side: where the heap's ink sits against the column's.
    const heapSide = Math.sign(centroid(sampled(paths(result.parts, 'pile-carbon'))).x - centroid(sampled(paths(result.parts, 'column-carbon'))).x);
    expect(heapSide).not.toBe(0);
    // The beam's shadow: the middle of each end of it, on the sheet.
    const shadow = sampled(paths(result.parts, 'shadow-beam-carbon'));
    expect(shadow.length).toBeGreaterThan(200);
    const x0 = Math.min(...shadow.map(p => p.x)), x1 = Math.max(...shadow.map(p => p.x));
    const left = centroid(shadow.filter(p => p.x < x0 + 0.15 * (x1 - x0))), right = centroid(shadow.filter(p => p.x > x1 - 0.15 * (x1 - x0)));
    const heapEnd = heapSide < 0 ? left : right, otherEnd = heapSide < 0 ? right : left;
    const tilt = Math.atan2(heapEnd.y - otherEnd.y, Math.abs(right.x - left.x)) * 180 / Math.PI;
    expect(tilt).toBeGreaterThan(8);
    expect(tilt).toBeLessThan(15);
  }, 60_000);
});
