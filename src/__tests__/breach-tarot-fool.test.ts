import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { foolCamera, maze, walls } from '../../sketches/breach-tarot/0-fool/geometry.ts';
import { onGround } from '../../sketches/kit/perspective.ts';
import type { Slab } from '../../sketches/kit/slabs.ts';
import { sketchContext } from './helpers/sketch-context.ts';

const entry = resolve('sketches/breach-tarot/0-fool/sketch.ts');

describe('Breach Tarot: 0 The Fool', () => {
  it('replays, stays inside the card, and draws the maze, its collapse, the undecided walls, the figure, the tie, the sun, the phrase and the frame', async () => {
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
    for (const id of ['undecided-carbon', 'sun-acid', 'card-frame']) expect(ids).toContain(id);
    for (const prefix of ['maze-', 'collapse-', 'figure-', 'figure-edge-', 'helix-', 'slogan-']) expect(ids.some(id => id.startsWith(prefix))).toBe(true);
  }, 60_000);

  it('frays the grown walls without moving the maze: footprints and standing blocks stay put, only more blocks rise', () => {
    const build = (fray: number) => {
      const ctx = sketchContext(1, { fray });
      const view = foolCamera(ctx);
      const foot = onGround(view, { x: CARD.x0 + (CARD.x1 - CARD.x0) * 0.6, y: CARD.y1 - 32 });
      return walls(ctx, view, maze(ctx, view, foot));
    };
    const still = build(0), frayed = build(1);
    expect(JSON.stringify(frayed.undecided)).toBe(JSON.stringify(still.undecided));
    const at = (sl: Slab) => `${sl.x.toFixed(5)},${sl.y.toFixed(5)},${sl.z.toFixed(5)}`;
    const standing = (w: typeof still) => w.walls.flatMap(x => x.slabs).filter(sl => sl.role === 'stack' || sl.role === 'pier');
    const before = new Set(standing(still).map(at));
    for (const sl of standing(frayed)) expect(before.has(at(sl))).toBe(true);
    const rising = (w: typeof still) => w.walls.flatMap(x => x.slabs).filter(sl => sl.role === 'debris').length;
    expect(rising(frayed)).toBeGreaterThan(rising(still));
  });
});
