import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { TABLOID_PAGE, concertLettering } from '../../sketches/phase-garden/poster.ts';

const entries = ['breach-cathedral', 'chamber-bloom', 'load-bearing-silence'];
const entry = (name: string) => resolve(`sketches/${name}/sketch.ts`);

describe('Phase Garden lettering controls', () => {
  it('renders lettered and fully abstract editions on the same 11 × 17 paper', async () => {
    for (const name of entries) {
      const lettered = await renderSketch({ entry: entry(name), seed: 17 });
      const abstract = await renderSketch({ entry: entry(name), seed: 17, params: { posterMode: 'abstract' } });
      expect(lettered.metadata.page).toEqual(TABLOID_PAGE);
      expect(abstract.metadata.page).toEqual(TABLOID_PAGE);
      expect(lettered.diagnostics).toEqual([]);
      expect(abstract.diagnostics).toEqual([]);
      expect(lettered.parts.filter(p => p.id.startsWith('poster-')).map(p => p.id))
        .toEqual(['poster-title', 'poster-caption', 'poster-rules']);
      expect(abstract.parts.every(p => !p.id.startsWith('poster-'))).toBe(true);
      expect(abstract.parts.length).toBe(lettered.parts.length - 3);
      for (const p of abstract.parts.flatMap(part => part.paths).flat()) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(p.x).toBeGreaterThanOrEqual(18);
        expect(p.x).toBeLessThanOrEqual(TABLOID_PAGE.width - 18);
        expect(p.y).toBeGreaterThanOrEqual(18);
        expect(p.y).toBeLessThanOrEqual(TABLOID_PAGE.height - 18);
      }
    }
  }, 30000);

  it('accepts custom strings and the matrix face as plotted paths, with bounded input', async () => {
    const path = entry('breach-cathedral');
    const result = await renderSketch({ entry: path, seed: 17, params: {
      posterFace: 'matrix', posterTitle: 'A & B', posterKicker: 'LIVE / 2026',
      posterSubtitle: 'CUSTOM STUDY', posterFooter: 'EDITION + 04',
    } });
    expect(result.diagnostics).toEqual([]);
    expect(result.parts.find(p => p.id === 'poster-title')?.paths.length).toBeGreaterThan(40);
    expect(result.svg).not.toContain('A & B'); // lettering is path geometry, not an SVG text node
    await expect(renderSketch({ entry: path, params: { posterTitle: 'A'.repeat(49) } })).rejects.toThrow(/maximum 48/);
    await expect(renderSketch({ entry: path, params: { posterTitle: '<SCRIPT>' } })).rejects.toThrow(/Unsupported stroke character U\+3C/);
  }, 30000);

  it('keeps a long footer clear of its decorative rule', () => {
    const parts = concertLettering({ page: TABLOID_PAGE, title: '', kicker: '', subtitle: '', footer: 'T'.repeat(80) });
    const footer = parts.find(p => p.id === 'poster-caption')!.paths.flat();
    const rule = parts.find(p => p.id === 'poster-rules')!.paths.at(-1)!;
    const maxFooterX = Math.max(...footer.map(p => p.x));
    expect(rule[0].x - maxFooterX).toBeGreaterThanOrEqual(5 - 1e-6);
  });
});
