import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/xvii-star/sketch.ts');

describe('Breach Tarot: XVII The Star', () => {
  it('replays, stays inside the card, and carries night, star, water, frame and phrase', async () => {
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
    for (const id of ['night-carbon', 'star-carbon', 'ripple-ultramarine', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('slogan-'))).toBe(true);
  }, 30_000);

  it('keeps the night above the horizon and the reflections below it', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const night = result.parts.filter(p => p.id.startsWith('night-')).flatMap(p => p.paths.flat());
    const water = result.parts.filter(p => p.id.startsWith('water-') || p.id.startsWith('ripple-')).flatMap(p => p.paths.flat());
    expect(night.length).toBeGreaterThan(100);
    expect(water.length).toBeGreaterThan(100);
    expect(Math.max(...night.map(p => p.y))).toBeLessThan(HORIZON_Y);
    expect(Math.min(...water.map(p => p.y))).toBeGreaterThan(HORIZON_Y);
  }, 30_000);
});
