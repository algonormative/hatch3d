import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { posterArtTransform, TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';

const entry = resolve('sketches/breach-cathedral-extended/sketch.ts');
// Sweep pick c004 (seed 792): its membrane and stack run past both authored envelope edges.
const pick = { posterMode: 'abstract', mass: 0.33, rupture: 0.28, growth: 0.7, focusX: 0.58, focusY: 0.34, levels: 11, cantilever: 0.84,
  breach: 0.65, hatchDensity: 0.56, shellWidth: 2.6, shellTwist: 0.1, interruption: 0.95, worldX: 0.1, worldY: -0.55, worldZ: 0.4, occlusion: true };

/** Path endpoints lying on the old authored envelope's top or bottom edge (y = 76 or 357). */
async function envelopeCuts(params: Record<string, string | number | boolean>): Promise<number> {
  const result = await renderSketch({ entry, seed: 792, params });
  expect(result.diagnostics).toEqual([]);
  const { inverse } = posterArtTransform({ params, seed: 792, assets: {}, random: () => Math.random }, TABLOID_PAGE);
  let cuts = 0;
  for (const part of result.parts) for (const path of part.paths) for (const end of [path[0], path.at(-1)!]) {
    const y = inverse(end).y;
    // The runner rounds page coordinates to ~1e-3 mm; anything this close is a clip edge.
    if (Math.abs(y - 76) < 2e-3 || Math.abs(y - 357) < 2e-3) cuts++;
  }
  return cuts;
}

describe('Breach Cathedral full height', () => {
  it('draws past the authored envelope with fullHeight on, and still cuts there with it off', async () => {
    // Negative control: the default edition really does end paths on y = 76 / 357.
    expect(await envelopeCuts(pick)).toBeGreaterThan(10);
    expect(await envelopeCuts({ ...pick, fullHeight: true })).toBe(0);
    expect(await envelopeCuts({ ...pick, fullHeight: true, fitWhole: true })).toBe(0);
  });

  it('leaves the edition untouched when the new toggles and slogans are off', async () => {
    const base = await renderSketch({ entry, seed: 17 });
    const explicit = await renderSketch({ entry, seed: 17, params: { fullHeight: false, fitWhole: true, sloganCount: 0, titleEnabled: false } });
    expect(explicit.parts).toEqual(base.parts);
    expect(base.parts.some(p => p.id.startsWith('slogan-') || p.id.startsWith('title-'))).toBe(false);
    const titled = await renderSketch({ entry, seed: 17, params: { titleEnabled: true, fullHeight: true } });
    expect(titled.parts.filter(p => p.id.startsWith('title-')).map(p => [p.id, p.pen])).toEqual([['title-lettering', 'lettering']]);
    const lettered = await renderSketch({ entry, seed: 17, params: { sloganCount: 1 } });
    expect(lettered.parts.some(p => p.id === 'slogan-lettering' && p.pen === 'lettering' && p.paths.length > 10)).toBe(true);
  });
});
