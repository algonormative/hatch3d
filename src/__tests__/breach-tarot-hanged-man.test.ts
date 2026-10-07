import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/xii-hanged-man/sketch.ts');

describe('Breach Tarot: XII The Hanged Man', () => {
  it('replays, stays inside the card, and draws the sky, the leaning city, the bob, the line, the ring, the phrase and the frame', async () => {
    const first = await renderSketch({ entry, seed: 3 });
    const replay = await renderSketch({ entry, seed: 3 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(CARD.top - 0.01);
      expect(p.y).toBeLessThanOrEqual(CARD.bottom + 0.01);
    }
    const ids = first.parts.map(p => p.id);
    for (const id of ['ring-carbon', 'card-frame']) expect(ids).toContain(id);
    for (const prefix of ['sky-', 'city-', 'bob-', 'line-', 'slogan-']) expect(ids.some(id => id.startsWith(prefix))).toBe(true);
  }, 60_000);

  it('hangs the bob on one true vertical: the bare thread is a single straight page-vertical stroke', async () => {
    const result = await renderSketch({ entry, seed: 3 });
    const carbon = result.parts.find(p => p.id === 'line-carbon')!.paths;
    const vertical = carbon.filter(path => path.length >= 2 && Math.abs(path[0].x - path[path.length - 1].x) < 0.05 && Math.abs(path[0].y - path[path.length - 1].y) > 20);
    expect(vertical.length).toBeGreaterThan(0);
  }, 60_000);
});
