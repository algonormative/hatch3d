import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/iv-emperor/sketch.ts');

describe('Breach Tarot: IV The Emperor', () => {
  it('replays, stays inside the card, and draws the sky, the paving, the avenue, the throne, the figure, the helix head, the bar, the phrase and the frame', async () => {
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
    for (const id of ['sky-carbon', 'ground-carbon', 'avenue-carbon', 'throne-carbon', 'figure-carbon', 'bar-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-') && id !== 'helix-carbon')).toBe(true);
  }, 60_000);

  it('is colossal by distance: the plinth stands just below the horizon and the head reaches the top quarter of the art window', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const ys = (match: (id: string) => boolean) => result.parts.filter(p => match(p.id)).flatMap(p => p.paths.flat().map(q => q.y));
    const plinthFoot = Math.max(...ys(id => id === 'throne-carbon'));
    expect(plinthFoot - HORIZON_Y).toBeGreaterThan(2);
    expect(plinthFoot - HORIZON_Y).toBeLessThan(20);
    const crown = Math.min(...ys(id => id.startsWith('helix-')));
    expect(crown).toBeLessThan(CARD.y0 + 0.25 * (CARD.y1 - CARD.y0));
  }, 60_000);
});
