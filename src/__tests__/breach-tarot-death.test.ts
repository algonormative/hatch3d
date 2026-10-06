import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';
import { SINGULARITY, unrenderEdge, unrenderHatch } from '../../sketches/breach-tarot/xiii-death/geometry.ts';

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

  it('converges on the singularity: the drawing thins toward the point and is empty at it', async () => {
    const result = await renderSketch({ entry, seed: 1 });
    const system = result.parts.filter(p => p.id.startsWith('system-')).flatMap(p => p.paths);
    const r = (p: { x: number; y: number }) => Math.hypot(p.x - SINGULARITY.x, p.y - SINGULARITY.y);
    const ink = (lo: number, hi: number) => len(system.flatMap(path => path.every(p => r(p) >= lo && r(p) < hi) ? [path] : []));
    // Ink per unit area falls toward the point, and nothing of the system reaches the void.
    const area = (lo: number, hi: number) => Math.PI * (hi * hi - lo * lo);
    expect(ink(20, 40) / area(20, 40)).toBeLessThan(ink(90, 130) / area(90, 130));
    // Nothing of the system or the helix crosses into the event horizon.
    const core = 6 + 14 * 0.5;
    expect(result.parts.filter(p => !p.id.startsWith('singularity') && !p.id.startsWith('threshold')).some(p => p.paths.some(path => path.some(q => r(q) < core)))).toBe(false);
    expect(result.parts.find(p => p.id === 'singularity-carbon')!.paths.length).toBeGreaterThan(30);
  }, 30_000);

  it('undoes edges with closeness to the point and keeps hatch only at the periphery', () => {
    const u = { core: 3, void: 5, dots: 18, dashes: 38, edges: 72 };
    const at = (d: number) => [{ x: SINGULARITY.x - 50, y: SINGULARITY.y - d }, { x: SINGULARITY.x + 50, y: SINGULARITY.y - d }];
    expect(len(unrenderEdge(at(45), u))).toBeCloseTo(100, 3);
    const near = len(unrenderEdge(at(10), u));
    expect(near).toBeGreaterThan(5);
    expect(near).toBeLessThan(80);
    expect(len(unrenderHatch(at(80), u))).toBeCloseTo(100, 3);
    expect(len(unrenderHatch(at(10), u))).toBeLessThan(len(unrenderHatch(at(60), u)));
  });
});
