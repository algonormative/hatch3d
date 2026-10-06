import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';
import { unrenderEdge } from '../../sketches/breach-tarot/xiii-death/geometry.ts';

const entry = resolve('sketches/breach-tarot/xiii-death/sketch.ts');
const PENS = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
const len = (paths: { x: number; y: number }[][]) => paths.reduce((t, p) => t + p.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - p[i].x, q.y - p[i].y), 0), 0);

describe('Breach Tarot: XIII Death', () => {
  it('replays, keeps every path finite and inside the card, and carries frame, threshold and phrase', async () => {
    const first = await renderSketch({ entry, seed: 1 });
    const replay = await renderSketch({ entry, seed: 1 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    expect(first.stats.pathCount).toBeLessThanOrEqual(8000);
    for (const pen of PENS) expect(first.parts.some(p => p.pen === pen && p.paths.length > 0)).toBe(true);
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(CARD.top - 0.01);
      expect(p.y).toBeLessThanOrEqual(CARD.bottom + 0.01);
    }
    expect(first.parts.find(p => p.id === 'threshold-carbon')!.paths[0][0].y).toBeCloseTo(HORIZON_Y, 6);
    expect(first.parts.find(p => p.id === 'card-frame')!.paths.length).toBeGreaterThan(10);
    expect(first.parts.some(p => p.id.startsWith('slogan-'))).toBe(true);
  }, 30_000);

  it('draws hatch only below the line: the system part above it is a fraction of the ink below', async () => {
    const result = await renderSketch({ entry, seed: 1 });
    const system = result.parts.filter(p => p.id.startsWith('system-')).flatMap(p => p.paths);
    const above = system.flatMap(path => path.every(p => p.y < HORIZON_Y - 1) ? [path] : []);
    const below = system.flatMap(path => path.every(p => p.y > HORIZON_Y + 1) ? [path] : []);
    expect(len(above)).toBeLessThan(len(below) * 0.25);
  }, 30_000);

  it('undoes an edge with height: solid near the line, broken higher up, gone at the top', () => {
    const u = { solid: 20, dashed: 60, dotted: 100 };
    const at = (h: number) => [{ x: 30, y: HORIZON_Y - h }, { x: 130, y: HORIZON_Y - h }];
    expect(len(unrenderEdge(at(5), u))).toBeCloseTo(100, 3);
    const dashed = len(unrenderEdge(at(40), u));
    expect(dashed).toBeGreaterThan(20);
    expect(dashed).toBeLessThan(70);
    expect(len(unrenderEdge(at(80), u))).toBeLessThan(dashed / 3);
    expect(unrenderEdge(at(110), u)).toEqual([]);
  });
});
