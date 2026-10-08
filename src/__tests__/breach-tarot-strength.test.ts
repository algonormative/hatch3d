import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/viii-strength/sketch.ts');

type Parts = Awaited<ReturnType<typeof renderSketch>>['parts'];
const points = (parts: Parts, prefix: string) => parts.filter(p => p.id.startsWith(prefix)).flatMap(p => p.paths.flat());

/**
 * Where the helix's head hangs, on the sheet: the person's highest point, and the helix's lowest
 * stretch above it (within 60 mm either side). The head end is the centroid of that stretch's last
 * 6 mm, so a swelling ribbon's edge does not pull it sideways.
 */
function headOverPerson(parts: Parts) {
  const person = points(parts, 'figure-');
  const top = person.reduce((a, p) => (p.y < a.y ? p : a));
  const above = points(parts, 'helix-').filter(p => p.y < top.y - 3 && Math.abs(p.x - top.x) < 60);
  if (!above.length) return null;
  const lowest = Math.max(...above.map(p => p.y));
  const end = above.filter(p => p.y > lowest - 6);
  const x = end.reduce((a, p) => a + p.x, 0) / end.length;
  return { sideways: x - top.x, above: top.y - lowest };
}

describe('Breach Tarot: VIII Strength', () => {
  it('replays, stays inside the card, and draws the sky, the lake, the dam, the helix, the person, the phrase and the frame', async () => {
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
    for (const id of ['sky-carbon', 'lake-carbon', 'dam-carbon', 'gorge-carbon', 'parapet-carbon', 'figure-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('hangs the helix head over whoever holds it: within 8 mm sideways of the person\'s highest point and 15 to 50 mm above it', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const head = headOverPerson(result.parts)!;
    expect(head).not.toBeNull();
    expect(Math.abs(head.sideways)).toBeLessThanOrEqual(8);
    expect(head.above).toBeGreaterThanOrEqual(15);
    expect(head.above).toBeLessThanOrEqual(50);
  }, 60_000);

  it('draws the body-style person where the scratch figure stood: same height and place within 1 mm, the helix head still over it, the tail still ending at its hand', async () => {
    const box = (parts: Parts) => {
      const pts = points(parts, 'figure-');
      return { x0: Math.min(...pts.map(p => p.x)), x1: Math.max(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)), y1: Math.max(...pts.map(p => p.y)) };
    };
    const scratch = await renderSketch({ entry, seed: 2 });
    const body = await renderSketch({ entry, seed: 2, params: { figureStyle: 'body' } });
    const a = box(scratch.parts), b = box(body.parts);
    for (const k of ['x0', 'x1', 'y0', 'y1'] as const) expect(Math.abs(a[k] - b[k])).toBeLessThanOrEqual(1);
    const head = headOverPerson(body.parts)!;
    expect(Math.abs(head.sideways)).toBeLessThanOrEqual(8);
    expect(head.above).toBeGreaterThanOrEqual(15);
    expect(head.above).toBeLessThanOrEqual(50);
    // The hand is the figure's leftmost point; the helix's tail ends on it.
    const hand = points(body.parts, 'figure-').reduce((m, p) => (p.x < m.x ? p : m));
    const gap = Math.min(...points(body.parts, 'helix-').map(p => Math.hypot(p.x - hand.x, p.y - hand.y)));
    expect(gap).toBeLessThanOrEqual(1);
  }, 90_000);

  it('would notice the head moving: pushed aside, dropped onto the person, or lifted away, the measure fails', async () => {
    const aside = headOverPerson((await renderSketch({ entry, seed: 2, params: { headOffset: 30 } })).parts);
    expect(!aside || Math.abs(aside.sideways) > 8).toBe(true);
    const low = headOverPerson((await renderSketch({ entry, seed: 2, params: { headGap: 5 } })).parts)!;
    expect(low.above).toBeLessThan(15);
    const high = headOverPerson((await renderSketch({ entry, seed: 2, params: { headGap: 60 } })).parts)!;
    expect(high.above).toBeGreaterThan(50);
  }, 90_000);
});
