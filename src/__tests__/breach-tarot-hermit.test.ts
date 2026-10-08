import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { inspectSketch, renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/ix-hermit/sketch.ts');

type Pt = { x: number; y: number };
type PartLike = { id: string; pen: string; paths: Pt[][] };
const paths = (parts: PartLike[], id: string) => parts.find(p => p.id === id)?.paths ?? [];
/** Points along every path, a quarter millimetre apart, so a long ruling stroke counts where it passes and not only at its ends. */
const sampled = (list: Pt[][]): Pt[] => list.flatMap(path => path.slice(1).flatMap((p, i) => {
  const a = path[i], k = Math.max(1, Math.ceil(Math.hypot(p.x - a.x, p.y - a.y) / 0.25));
  return Array.from({ length: k + 1 }, (_, j) => ({ x: a.x + (p.x - a.x) * j / k, y: a.y + (p.y - a.y) * j / k }));
}));
/** The middle of the helix: the middle of the box round everything it draws. */
const helixCentre = (parts: PartLike[]): Pt => {
  const pts = parts.filter(p => p.id.startsWith('helix-')).flatMap(p => p.paths.flat());
  return { x: (Math.min(...pts.map(p => p.x)) + Math.max(...pts.map(p => p.x))) / 2, y: (Math.min(...pts.map(p => p.y)) + Math.max(...pts.map(p => p.y))) / 2 };
};
/** The night ruling: the sky's rules and the rules that follow the mountain's slope. */
const night = (parts: PartLike[]): Pt[] => sampled([...paths(parts, 'night-carbon'), ...paths(parts, 'slope-carbon')]);
const within = (pts: Pt[], c: Pt, r: number) => pts.filter(p => Math.hypot(p.x - c.x, p.y - c.y) < r);

describe('Breach Tarot: IX The Hermit', () => {
  it('replays, stays inside the card, and draws the night, the mountain, the hermit, the lantern, the helix, the network, the phrase, the horizon and the frame', async () => {
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
    for (const id of ['night-carbon', 'slope-carbon', 'ground-carbon', 'peak-carbon', 'figure-carbon', 'lantern-carbon', 'horizon-carbon', 'slogan-lettering', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('has no light but the lantern\'s: no night ruling lies in its clear core, and the helix\'s inks are the only ones besides carbon and the lettering', async () => {
    const result = await renderSketch({ entry, seed: 1 });
    const meta = await inspectSketch({ entry });
    const lit = meta.controls.find(c => c.id === 'lit');
    expect(lit?.type).toBe('slider');
    const core = (lit as { default: number }).default;
    // The core is a real one (the lantern and the helix inside it fit in 8 mm); lowering the control is the mutation this catches.
    expect(core).toBeGreaterThanOrEqual(8);
    const centre = helixCentre(result.parts);
    // The clear core: nothing of the night's ruling inside it. A millimetre or two of margin for the helix's box being
    // only close to its middle.
    const ruling = night(result.parts);
    expect(ruling.length).toBeGreaterThan(100_000);
    expect(within(ruling, centre, core - 2).length).toBe(0);
    // And the night is really there round the core: ruling in the ring just past the light and plenty of it in the open sky.
    expect(within(ruling, centre, core + 40).length).toBeGreaterThan(200);
    expect(within(ruling, { x: CARD.x0 + 40, y: CARD.y0 + 40 }, 30).length).toBeGreaterThan(500);
    // The ink: every part is carbon or lettering, except the helix, which draws in its own inks and nothing else does.
    const helix = result.parts.filter(p => p.id.startsWith('helix-'));
    expect(helix.length).toBeGreaterThanOrEqual(3);
    for (const part of helix) {
      expect(part.id).toBe(`helix-${part.pen}`);
      expect(['ultramarine', 'vermilion', 'acid', 'violet']).toContain(part.pen);
    }
    for (const part of result.parts.filter(p => !p.id.startsWith('helix-'))) expect(['carbon', 'lettering']).toContain(part.pen);
  }, 60_000);

  it('would fail without its core: with no clear core the ruling runs through the lantern', async () => {
    const result = await renderSketch({ entry, seed: 1, params: { lit: 0 } });
    const centre = helixCentre(result.parts);
    expect(within(night(result.parts), centre, 8).length).toBeGreaterThan(50);
  }, 60_000);
});
