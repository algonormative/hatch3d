import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/x-wheel/sketch.ts');

describe('Breach Tarot: X Wheel of Fortune', () => {
  it('replays, stays inside the card, and draws the sky, the paving, the rim, the towers, the hub, the helix, the phrase and the frame', async () => {
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
    for (const id of ['sky-carbon', 'ground-carbon', 'rim-carbon', 'tower-carbon', 'hub-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-') && id !== 'helix-carbon')).toBe(true);
  }, 60_000);

  it('stands half sunk with one upright tower on top', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const points = (match: (id: string) => boolean) => result.parts.filter(p => match(p.id)).flatMap(p => p.paths.flat());
    const ys = (match: (id: string) => boolean) => points(match).map(q => q.y);

    // The rim goes into the ground: it comes down among the broken paving round its crossings, and
    // nothing of it is drawn below that paving.
    const rimLow = Math.max(...ys(id => id.startsWith('rim-')));
    expect(rimLow).toBeLessThanOrEqual(Math.max(...ys(id => id.startsWith('ground-'))) - 2);
    expect(rimLow).toBeGreaterThan(Math.min(...ys(id => id.startsWith('ground-'))) + 10);

    // The highest mark of the wheel is a tower, and that tower stands upright on the sheet: its marks
    // at the top and 30 mm further down are centred within 5 degrees of one vertical.
    const top = Math.min(...ys(id => /^(rim|tower|hub)-/.test(id)));
    expect(Math.min(...ys(id => id.startsWith('tower-')))).toBeCloseTo(top, 3);
    const centreAt = (y0: number) => {
      const xs = points(id => id.startsWith('tower-')).filter(q => q.y >= y0 && q.y <= y0 + 8).map(q => q.x);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    const lean = Math.atan2(Math.abs(centreAt(top) - centreAt(top + 30)), 30) * 180 / Math.PI;
    expect(lean).toBeLessThan(5);
  }, 60_000);
});
