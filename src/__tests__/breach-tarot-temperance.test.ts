import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/xiv-temperance/sketch.ts');

type Pt = { x: number; y: number };
const box = (pts: Pt[]) => ({ top: Math.min(...pts.map(p => p.y)), base: Math.max(...pts.map(p => p.y)), left: Math.min(...pts.map(p => p.x)), right: Math.max(...pts.map(p => p.x)) });

describe('Breach Tarot: XIV Temperance', () => {
  it('replays, stays inside the card, and draws the sky, the water and its reflection, the paving, the shore, both vessels, the helix, the phrase, the horizon and the frame', async () => {
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
    for (const id of ['sky-carbon', 'water-carbon', 'reflect-carbon', 'land-carbon', 'shore-carbon', 'near-carbon', 'far-carbon', 'horizon-carbon', 'slogan-lettering', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('pours uphill and both ways: the helix rises above both rims between the vessels, arrives at each rim, and the far vessel stands in the water', async () => {
    const result = await renderSketch({ entry, seed: 1 });
    const ink = (match: (id: string) => boolean): Pt[] => result.parts.filter(p => match(p.id)).flatMap(p => p.paths.flat());
    const near = box(ink(id => id.startsWith('near-'))), far = box(ink(id => id.startsWith('far-')));
    const helix = ink(id => id.startsWith('helix-'));
    const water = ink(id => id.startsWith('water-'));

    // It climbs: the far vessel's rim is the lower one, and between the two vessels the helix rises
    // at least 20 mm above the higher rim (a pour that fell would sag below it).
    expect(far.top).toBeGreaterThan(near.top + 60);
    const between = helix.filter(p => p.x > near.right && p.x < far.left);
    expect(between.length).toBeGreaterThan(200);
    expect(Math.min(near.top, far.top) - Math.min(...between.map(p => p.y))).toBeGreaterThan(20);

    // It goes both ways: at each rim the helix arrives, and a strand spills over it and hangs below the rim
    // line, one at each end (nothing of it below either rim means the pour stops short of that vessel).
    for (const vessel of [near, far]) {
      const spill = helix.filter(p => p.x > vessel.left - 30 && p.x < vessel.right + 30 && p.y > vessel.top + 8 && p.y < vessel.top + 80);
      expect(spill.length).toBeGreaterThan(20);
    }

    // The far vessel stands in the water, the near one on the land: at each base the water ruling either
    // runs on both sides of the vessel (far) or starts clear to its right (near).
    const waterAt = (y: number) => water.filter(p => Math.abs(p.y - y) < 1.2);
    const atFar = waterAt(far.base), atNear = waterAt(near.base);
    expect(atFar.length).toBeGreaterThan(50);
    expect(Math.min(...atFar.map(p => p.x))).toBeLessThan(far.left - 4);
    expect(Math.max(...atFar.map(p => p.x))).toBeGreaterThan(far.right + 4);
    expect(atNear.length === 0 || Math.min(...atNear.map(p => p.x)) > near.right + 4).toBe(true);
  }, 60_000);
});
