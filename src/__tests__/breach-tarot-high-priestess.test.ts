import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/ii-high-priestess/sketch.ts');

describe('Breach Tarot: II The High Priestess', () => {
  it('replays, stays inside the card, and draws the sky, the pillars, the lintel, the helix cable, the unwinding veil, the shadow, the phrase and the frame', async () => {
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
    for (const id of ['horizon-carbon', 'veil-ultramarine', 'shadow-carbon', 'card-frame']) expect(ids).toContain(id);
    for (const prefix of ['sky-', 'floor-', 'dark-', 'light-', 'lintel-', 'helix-', 'unwind-', 'slogan-']) expect(ids.some(id => id.startsWith(prefix))).toBe(true);
  }, 60_000);

  it('opens the horizon at both card edges, so any three cards side by side make one landscape', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const xs = result.parts.find(p => p.id === 'horizon-carbon')!.paths.flatMap(path => path.map(p => p.x));
    expect(Math.min(...xs)).toBeLessThanOrEqual(CARD.x0 + 2);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(CARD.x1 - 2);
  }, 60_000);
});
