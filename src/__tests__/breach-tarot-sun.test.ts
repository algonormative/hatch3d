import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/xix-sun/sketch.ts');

describe('Breach Tarot: XIX The Sun', () => {
  it('replays, stays inside the card, and draws shadows, stems, the sun disc, the phrase and the frame', async () => {
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
    for (const id of ['shadow-carbon', 'sun-vermilion', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('stem-'))).toBe(true);
    expect(ids).toContain('slogan-lettering');
  }, 30_000);

  it('is the lightest card: far less ink than the Star', async () => {
    const sun = await renderSketch({ entry, seed: 1 });
    const star = await renderSketch({ entry: resolve('sketches/breach-tarot/xvii-star/sketch.ts'), seed: 1 });
    expect(sun.stats.lengthMm).toBeLessThan(star.stats.lengthMm * 0.5);
  }, 30_000);
});
