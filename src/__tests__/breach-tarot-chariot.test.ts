import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/vii-chariot/sketch.ts');

describe('Breach Tarot: VII The Chariot', () => {
  it('replays, stays inside the card, and draws the sky, the shadow, the trails, the road, the unbuilt road, both forces, the helix, the phrase and the frame', async () => {
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
    for (const id of ['sky-carbon', 'shadow-carbon', 'trail-carbon', 'road-carbon', 'unbuilt-carbon', 'pale-carbon', 'dark-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-') && id !== 'helix-carbon')).toBe(true);
  }, 60_000);

  it('leaves the ground and is still being built: the helix rides high in the sky, and dashed unbuilt road runs on above the front edge', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const ys = (match: (id: string) => boolean) => result.parts.filter(p => match(p.id)).flatMap(p => p.paths.flat().map(q => q.y));
    // The chariot is up on the ramp, not down on the ground.
    expect(HORIZON_Y - Math.min(...ys(id => id.startsWith('helix-')))).toBeGreaterThanOrEqual(60);
    // The built road's front edge is its highest point; the road it is meant to become goes on above it, dashed.
    const front = Math.min(...ys(id => id === 'road-carbon'));
    const unbuilt = result.parts.find(p => p.id === 'unbuilt-carbon')!.paths;
    const lengths = unbuilt.map(path => path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0)).sort((a, b) => a - b);
    expect(lengths[Math.floor(lengths.length / 2)]).toBeLessThan(3);
    const above = unbuilt.filter(path => Math.max(...path.map(q => q.y)) < front - 5);
    expect(above.length).toBeGreaterThanOrEqual(40);
    expect(front - Math.min(...above.flat().map(q => q.y))).toBeGreaterThanOrEqual(40);
  }, 60_000);
});
