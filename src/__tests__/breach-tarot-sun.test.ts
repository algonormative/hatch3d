import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/xix-sun/sketch.ts');

describe('Breach Tarot: XIX The Sun', () => {
  it('replays, stays inside the card, and draws the disc, both kinds of ray, the wall shadow, the phrase and the frame', async () => {
    const first = await renderSketch({ entry, seed: 1 });
    const replay = await renderSketch({ entry, seed: 1 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(CARD.top - 0.01);
      expect(p.y).toBeLessThanOrEqual(CARD.bottom + 0.01);
    }
    const ids = first.parts.map(p => p.id);
    for (const id of ['disc-vermilion', 'shadow-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('waves-'))).toBe(true);
    expect(ids.some(id => id.startsWith('rays-'))).toBe(true);
    expect(ids.some(id => id.startsWith('slogan-'))).toBe(true);
  }, 30_000);

  it('keeps the disc blown out: nothing is drawn inside the sun but its rim', async () => {
    const result = await renderSketch({ entry, seed: 1 });
    const rim = result.parts.find(p => p.id === 'disc-vermilion')!.paths.flat();
    const cx = rim.reduce((t, p) => t + p.x, 0) / rim.length, cy = rim.reduce((t, p) => t + p.y, 0) / rim.length;
    const r = Math.min(...rim.map(p => Math.hypot(p.x - cx, p.y - cy)));
    const inside = result.parts.filter(p => p.id !== 'disc-vermilion').flatMap(p => p.paths.flat()).filter(p => Math.hypot(p.x - cx, p.y - cy) < r - 0.5);
    expect(r).toBeGreaterThan(20);
    expect(inside).toEqual([]);
  }, 30_000);
});
