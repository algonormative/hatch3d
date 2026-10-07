import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/v-hierophant/sketch.ts');
const points = (parts: { id: string; paths: { x: number; y: number }[][] }[], match: (id: string) => boolean) =>
  parts.filter(p => match(p.id)).flatMap(p => p.paths.flat());

describe('Breach Tarot: V The Hierophant', () => {
  it('replays, stays inside the card, and draws the sky, the wall, the piers, the lanes, the gate, the helix, the fine print, the phrase and the frame', async () => {
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
    for (const id of ['sky-carbon', 'wall-carbon', 'pier-carbon', 'lane-carbon', 'gate-ultramarine', 'print-lettering', 'slogan-lettering', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('stands the gate off centre and threads the helix through it: the slot lies outside the middle third, the thread passes inside it, and shows below the wall top on the near side and above it in the sky', async () => {
    const { parts } = await renderSketch({ entry, seed: 2 });
    const third = (CARD.x1 - CARD.x0) / 3;
    const slot = points(parts, id => id === 'gate-ultramarine');
    expect(slot.length).toBeGreaterThan(0);
    for (const p of slot) expect(p.x < CARD.x0 + third || p.x > CARD.x1 - third).toBe(true);
    const slotX = [Math.min(...slot.map(p => p.x)), Math.max(...slot.map(p => p.x))];
    const slotY = [Math.min(...slot.map(p => p.y)), Math.max(...slot.map(p => p.y))];
    const helix = points(parts, id => id.startsWith('helix-'));
    // The thread comes through the slot itself.
    expect(helix.filter(p => p.x > slotX[0] && p.x < slotX[1] && p.y > slotY[0] && p.y < slotY[1]).length).toBeGreaterThan(20);
    // Below the wall's top it runs across the foreground; above it, it climbs into the sky.
    const wallTop = Math.min(...points(parts, id => id === 'wall-carbon').map(p => p.y));
    expect(helix.filter(p => p.y > HORIZON_Y).length).toBeGreaterThan(50);
    expect(helix.filter(p => p.y < wallTop).length).toBeGreaterThan(50);
  }, 60_000);
});
