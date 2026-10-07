import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/i-magician/sketch.ts');

describe('Breach Tarot: I The Magician', () => {
  it('replays, stays inside the card, and draws the figure, its field, the helix, the blocks, the cracks, the mark, the phrase and the frame', async () => {
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
    for (const id of ['figure-carbon', 'cracks-carbon', 'mark-carbon', 'card-frame']) expect(ids).toContain(id);
    for (const prefix of ['field-', 'helix-', 'blocks-', 'slogan-']) expect(ids.some(id => id.startsWith(prefix))).toBe(true);
  }, 60_000);

  it('keeps the figure on its own ground: with no veil, nothing else comes within a millimetre of its strokes', async () => {
    const veiled = await renderSketch({ entry, seed: 1, params: { veil: 0 } });
    const figure = veiled.parts.find(p => p.id === 'figure-carbon')!.paths.flat();
    const near = (q: { x: number; y: number }) => figure.some(p => Math.hypot(p.x - q.x, p.y - q.y) < 1);
    const crossing = veiled.parts.filter(p => p.id !== 'figure-carbon').flatMap(p => p.paths.flat()).filter(near);
    expect(figure.length).toBeGreaterThan(50);
    expect(crossing).toEqual([]);
  }, 60_000);
});
