import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/iii-empress/sketch.ts');

describe('Breach Tarot: III The Empress', () => {
  it('replays, stays inside the card, and draws the sky, the ground rules, the far field, the crop, the wind, the phrase, the horizon and the frame', async () => {
    const first = await renderSketch({ entry, seed: 2 });
    const replay = await renderSketch({ entry, seed: 2 });
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
    for (const id of ['sky-carbon', 'ground-carbon', 'far-carbon', 'crop-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    // The wind keeps the helix's own inks: it is not remapped to one pen.
    expect(ids).toContain('wind-vermilion');
  }, 60_000);

  it('draws the wind as a wave across the card: its strokes span 60% of the art window across and 15% of it up and down', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const wind = result.parts.filter(p => p.id.startsWith('wind-')).flatMap(p => p.paths).flat();
    expect(wind.length).toBeGreaterThan(0);
    const xs = wind.map(p => p.x), ys = wind.map(p => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(0.6 * (CARD.x1 - CARD.x0));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(0.15 * (CARD.y1 - CARD.y0));
  }, 60_000);
});
