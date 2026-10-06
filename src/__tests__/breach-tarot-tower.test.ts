import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { shear } from '../../sketches/breach-tarot/xvi-tower/geometry.ts';

const entry = resolve('sketches/breach-tarot/xvi-tower/sketch.ts');

describe('Breach Tarot: XVI The Tower', () => {
  it('replays, stays inside the card, and carries the bolt band, frame and phrase', async () => {
    const first = await renderSketch({ entry, seed: 1 });
    const replay = await renderSketch({ entry, seed: 1 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    expect(first.stats.pathCount).toBeLessThanOrEqual(9000);
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(CARD.top - 0.01);
      expect(p.y).toBeLessThanOrEqual(CARD.bottom + 0.01);
    }
    expect(first.parts.find(p => p.id === 'bolt-carbon')!.paths.length).toBeGreaterThan(100);
    expect(first.parts.some(p => p.id.startsWith('slogan-'))).toBe(true);
    expect(first.parts.some(p => p.id.startsWith('helix-'))).toBe(true);
  }, 30_000);

  it('shears a line across the bolt: the far side slips, the band stays clear', () => {
    const bolt = [{ x: 100, y: 0 }, { x: 100, y: 200 }];
    const out = shear([{ x: 50, y: 100 }, { x: 150, y: 100 }], bolt, { x: 0, y: 6 }, 3);
    expect(out.length).toBe(2);
    const ys = out.map(p => p[0].y).sort((a, b) => a - b);
    expect(ys).toEqual([100, 106]);
    for (const path of out) for (const p of path) expect(Math.abs(p.x - 100)).toBeGreaterThan(3);
  });
});
