import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/vi-lovers/sketch.ts');

type Pt = { x: number; y: number };
type Part = { id: string; paths: Pt[][] };

/** Every path resampled to points at most `step` millimetres apart, so a long straight hatch line is a row of points. */
const dense = (parts: Part[], ids: string[], step = 1): Pt[] => parts.filter(p => ids.includes(p.id)).flatMap(p => p.paths.flatMap(path => {
  const out: Pt[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 1; j <= k; j++) out.push({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k });
  }
  return out;
}));

/** Whether any point of `a` lies within `limit` millimetres of any point of `b` (a grid of `limit`-sized cells over `b`). */
function anyWithin(a: Pt[], b: Pt[], limit: number): boolean {
  const cell = new Map<string, Pt[]>();
  for (const q of b) {
    const key = `${Math.floor(q.x / limit)},${Math.floor(q.y / limit)}`;
    (cell.get(key) ?? cell.set(key, []).get(key)!).push(q);
  }
  for (const p of a) {
    const cx = Math.floor(p.x / limit), cy = Math.floor(p.y / limit);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const q of cell.get(`${cx + dx},${cy + dy}`) ?? []) if (Math.hypot(p.x - q.x, p.y - q.y) < limit) return true;
    }
  }
  return false;
}

const lover = (parts: Part[], side: 'left' | 'right') => dense(parts, [`${side}-carbon`, `${side}-edge-carbon`]);
const shadowOf = (parts: Part[], side: 'left' | 'right') => dense(parts, [`shadow-${side}-carbon`]);

describe('Breach Tarot: VI The Lovers', () => {
  it('replays, stays inside the card, and draws the sky, the shadows, the two towers, the two lovers, the helix, the phrase and the frame', async () => {
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
    for (const id of ['sky-carbon', 'shadow-carbon', 'shadow-left-carbon', 'shadow-right-carbon', 'near-carbon', 'far-carbon', 'left-carbon', 'right-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-') && id !== 'helix-carbon')).toBe(true);
  }, 60_000);

  it('has the lovers reach but never touch, and float: their drawn paths come close without meeting, and each hangs clear of its own shadow', async () => {
    const { parts } = await renderSketch({ entry, seed: 2 });
    const left = lover(parts, 'left'), right = lover(parts, 'right');
    expect(left.length).toBeGreaterThan(100);
    expect(right.length).toBeGreaterThan(100);
    // They reach: the hands come within a few millimetres of each other on the sheet.
    expect(anyWithin(left, right, 8)).toBe(true);
    // They never touch: nothing of one is within 2 mm of anything of the other.
    expect(anyWithin(left, right, 2)).toBe(false);
    for (const side of ['left', 'right'] as const) {
      const body = lover(parts, side), shadow = shadowOf(parts, side);
      expect(shadow.length).toBeGreaterThan(100);
      // Detached from its shadow: no drawn point of the lover within 6 mm of its own shadow (a figure standing on the ground would touch it).
      expect(anyWithin(body, shadow, 6)).toBe(false);
      // Above the ground under it: the lowest drawn point is well above the bottom of its shadow on the sheet.
      expect(Math.max(...shadow.map(p => p.y)) - Math.max(...body.map(p => p.y))).toBeGreaterThan(8);
    }
  }, 60_000);
});
