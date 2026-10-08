import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/xx-judgement/sketch.ts');

describe('Breach Tarot: XX Judgement', () => {
  it('replays, stays inside the card, and draws the sky, the paving, the trays, the lids, the fragments, the helix, the phrase, the horizon and the frame', async () => {
    const first = await renderSketch({ entry, seed: 1 });
    const replay = await renderSketch({ entry, seed: 1 });
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
    for (const id of ['sky-carbon', 'ground-carbon', 'tray-carbon', 'lid-carbon', 'fragment-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('flares from the corner: the horn enters across the top edge in the left third, is at least four times as wide low down as at its entry, and sounds above the field without touching it', async () => {
    const result = await renderSketch({ entry, seed: 1 });
    const points = (match: (id: string) => boolean) => result.parts.filter(p => match(p.id)).flatMap(p => p.paths.flat());
    const helix = points(id => id.startsWith('helix-'));
    const lids = points(id => id.startsWith('lid-'));

    // It comes in across the top edge of the art window, in the left third of the card.
    const entering = helix.filter(p => p.y < CARD.y0 + 2);
    expect(entering.length).toBeGreaterThan(0);
    const third = CARD.x0 + (CARD.x1 - CARD.x0) / 3;
    expect(Math.max(...entering.map(p => p.x))).toBeLessThan(third);

    // Its width across the horn: where it runs along the top, the vertical thickness of a slice just past
    // the entry; where it hangs, the horizontal spread of its lowest 12 mm (the bell's mouth).
    const entryX = Math.min(...entering.map(p => p.x));
    const slice = helix.filter(p => p.x >= entryX + 8 && p.x <= entryX + 24).map(p => p.y);
    const near = Math.max(...slice) - Math.min(...slice);
    const lowest = Math.max(...helix.map(p => p.y));
    const mouth = helix.filter(p => p.y >= lowest - 12).map(p => p.x);
    const low = Math.max(...mouth) - Math.min(...mouth);
    expect(near).toBeGreaterThan(2);
    expect(low / near).toBeGreaterThanOrEqual(4);

    // The horn's lowest mark stays well above the highest mark of the lids: it sounds over the field.
    expect(lowest).toBeLessThanOrEqual(Math.min(...lids.map(p => p.y)) - 8);
  }, 60_000);
});
