import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';

const entry = resolve('sketches/breach-tarot/xviii-moon/sketch.ts');

type Pt = { x: number; y: number };
type Box = { x0: number; x1: number; y0: number; y1: number };
const paths = (parts: { id: string; paths: Pt[][] }[], id: string) => parts.find(p => p.id === id)?.paths ?? [];
/** Ink grouped into images by x: paths whose x-spans come within `gap` millimetres of each other are one image. */
function images(list: Pt[][], gap = 3): Box[] {
  const spans = list.filter(p => p.length).map(p => ({
    x0: Math.min(...p.map(q => q.x)), x1: Math.max(...p.map(q => q.x)), y0: Math.min(...p.map(q => q.y)), y1: Math.max(...p.map(q => q.y)),
  })).sort((a, b) => a.x0 - b.x0);
  const out: Box[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.x0 <= last.x1 + gap) Object.assign(last, { x1: Math.max(last.x1, s.x1), y0: Math.min(last.y0, s.y0), y1: Math.max(last.y1, s.y1) });
    else out.push({ ...s });
  }
  return out;
}
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));

/**
 * The pool's false city, read off the render: the reflection's images (the mirror ink grouped by x), the
 * towers that stand (their ink below the horizon, where they stand on the land; the wolf's flying courses
 * are all in the sky above it), and the lettering cut into the reflection.
 */
async function pool(params: Record<string, unknown> = {}) {
  const result = await renderSketch({ entry, seed: 1, params } as never);
  const reflections = images(paths(result.parts, 'mirror-carbon'));
  const standing = images(paths(result.parts, 'tower-carbon').map(p => p.filter(q => q.y > HORIZON_Y + 0.5)));
  // Share of each reflected image's width that lies under a tower that stands.
  const under = reflections.map(r => standing.reduce((s, t) => s + overlap(r, t), 0) / (r.x1 - r.x0));
  const lettering = paths(result.parts, 'slogan-lettering');
  return { reflections, standing, under, lettering };
}

describe('Breach Tarot: XVIII The Moon', () => {
  it('replays, stays inside the card, and draws the sky, the broken moon, the towers, the pool, the road, the phrase, the horizon and the frame', async () => {
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
    for (const id of ['sky-carbon', 'sky-ultramarine', 'rock-carbon', 'moon-carbon', 'tower-carbon', 'mirror-carbon', 'water-carbon', 'horizon-carbon', 'slogan-lettering', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('the pool reflects a tower that is not there: one reflected tower lies under neither tower that stands, and "its own" is cut into it', async () => {
    const { reflections, standing, under, lettering } = await pool();
    expect(standing.length).toBe(2);
    // Exactly one reflected tower stands under no real one (the two true reflections lie under theirs).
    const false_ = reflections.filter((_, i) => under[i] < 0.25);
    expect(false_.length).toBe(1);
    expect(reflections.filter((_, i) => under[i] > 0.75).length).toBe(2);
    // The last two words lie inside it: lettering within its image, in two words one above the other.
    const f = false_[0];
    const inside = lettering.filter(p => p.every(q => q.x >= f.x0 && q.x <= f.x1 && q.y >= f.y0 && q.y <= f.y1));
    expect(inside.length).toBeGreaterThanOrEqual(10);
    const ys = inside.map(p => p.reduce((s, q) => s + q.y, 0) / p.length).sort((a, b) => a - b);
    const widest = Math.max(...ys.slice(1).map((y, i) => y - ys[i]));
    expect(widest).toBeGreaterThan(10);
  }, 60_000);
});
