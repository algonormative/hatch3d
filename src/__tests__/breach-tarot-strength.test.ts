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
  it('replays, stays inside the card, and draws the lake, the dam, the helix, the person, the phrase and the frame', async () => {
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
    for (const id of ['lake-carbon', 'dam-carbon', 'gorge-carbon', 'parapet-carbon', 'figure-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
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

  it('would notice the head moving: pushed aside, dropped onto the person, or lifted away, the measure fails', async () => {
    const aside = headOverPerson((await renderSketch({ entry, seed: 2, params: { headOffset: 30 } })).parts);
    expect(!aside || Math.abs(aside.sideways) > 8).toBe(true);
    const low = headOverPerson((await renderSketch({ entry, seed: 2, params: { headGap: 5 } })).parts)!;
    expect(low.above).toBeLessThan(15);
    const high = headOverPerson((await renderSketch({ entry, seed: 2, params: { headGap: 60 } })).parts)!;
    expect(high.above).toBeGreaterThan(50);
  }, 90_000);
});
