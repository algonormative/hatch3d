import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import type { Part, SketchContext } from '../../src/sketch/types.ts';
import { drawTower, towerScene, towerSlabs } from '../../sketches/breach-cathedral-tower/geometry.ts';

const entry = resolve('sketches/breach-cathedral-tower/sketch.ts');
const PENS = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];

function length(parts: Part[], prefix = ''): number {
  let total = 0;
  for (const part of parts) if (part.id.startsWith(prefix)) for (const path of part.paths) {
    for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  return total;
}

/** A direct draw context with a seeded stream per part, for geometry-level audits. */
function context(seed: number, params: SketchContext['params'] = {}): SketchContext {
  return { params, seed, assets: {}, random: (id: string) => {
    let h = (seed * 2654435761) >>> 0;
    for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 2 ** 32; };
  } };
}

describe('Breach Cathedral: Tower', () => {
  it('replays, fills five pens with finite page-bounded paths, and stays inside the budget', async () => {
    const first = await renderSketch({ entry, seed: 211 });
    const replay = await renderSketch({ entry, seed: 211 });
    const other = await renderSketch({ entry, seed: 17 });
    expect(replay.identity).toBe(first.identity);
    expect(replay.parts).toEqual(first.parts);
    expect(other.identity).not.toBe(first.identity);
    for (const result of [first, other]) {
      expect(result.diagnostics).toEqual([]);
      expect(result.stats.pathCount).toBeLessThanOrEqual(8000);
      expect(result.stats.lengthMm).toBeLessThanOrEqual(90_000);
      expect(result.stats.pathCount).toBeGreaterThan(2000);
      for (const pen of PENS) {
        const paths = result.parts.filter(p => p.pen === pen).flatMap(p => p.paths);
        expect(paths.length).toBeGreaterThan(pen === 'acid' ? 10 : 60);
      }
      for (const part of result.parts) for (const path of part.paths) for (const p of path) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(279.4);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(431.8);
      }
      // Full height: the art spans most of the sheet, unlike the short original envelope.
      const ys = result.parts.filter(p => !p.id.startsWith('finishing')).flatMap(p => p.paths.flat().map(q => q.y));
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(330);
    }
  });

  it('draws two membrane strands that slabs genuinely occlude, and that occlude slabs in turn', () => {
    const ctx = context(211);
    const full = drawTower(ctx);
    const slabOnly = drawTower(ctx, { occluders: 'architecture' });
    const open = drawTower(context(211, { occlusion: false }));
    for (const strand of ['strand-a-', 'strand-b-']) {
      expect(length(full, strand)).toBeGreaterThan(2000);
      // Slab solids alone hide part of each strand.
      expect(length(slabOnly, strand)).toBeLessThan(length(open, strand) * 0.97);
    }
    // Adding the membranes to the same depth pass hides further masonry.
    expect(length(full, 'tower-')).toBeLessThan(length(slabOnly, 'tower-') * 0.97);
    expect(full.filter(p => p.id.startsWith('strand-b-')).map(p => p.pen)).toContain('violet');
  });

  it('shears slabs out of the stack in the collapse band and leaves the default stack intact without it', () => {
    const slabs = towerSlabs(context(211));
    const fallen = slabs.filter(s => s.role === 'fallen');
    expect(fallen.length).toBeGreaterThan(4);
    for (const s of fallen) expect(Math.hypot(s.x - s.home.x, s.y - s.home.y) > 0.5 || Math.abs(s.rz) > 0.1).toBe(true);
    expect(fallen.some(s => Math.abs(s.rz) > 0.3)).toBe(true);
    expect(fallen.every(s => s.y < s.home.y)).toBe(true);
    expect(slabs.filter(s => s.role === 'debris').length).toBeGreaterThan(8);
    const calm = towerSlabs(context(211, { collapse: 0, debris: 0 }));
    expect(calm.every(s => s.role === 'stack' || s.role === 'pier')).toBe(true);
    expect(calm.every(s => s.rz === 0 && s.x === s.home.x && s.y === s.home.y)).toBe(true);
  });

  it('spreads the opt-in slogan over intact faces in reading order, through the same depth pass', () => {
    const plain = towerScene(context(211));
    expect(plain.parts.some(p => p.id.startsWith('slogan-'))).toBe(false);
    for (const seed of [211, 17]) {
      const scene = towerScene(context(seed, { sloganCount: 1 }));
      const words = scene.slogans.placed;
      expect(words.length).toBeGreaterThanOrEqual(3);
      expect(words.map(w => w.text).join(' ')).toBe('this was made by a machine');
      for (let i = 1; i < words.length; i++) expect(words[i].y).toBeGreaterThan(words[i - 1].y);
      for (const w of words) expect(w.visible).toBeGreaterThanOrEqual(0.82);
      const slabs = towerSlabs(context(seed, { sloganCount: 1 }));
      expect(words.every(w => slabs[w.id].role === 'stack')).toBe(true);
      expect(length(scene.parts, 'slogan-lettering')).toBeGreaterThan(20);
      // The bands clear the chosen faces' own hatch.
      expect(length(scene.parts, 'tower-')).toBeLessThan(length(towerScene(context(seed)).parts, 'tower-'));
    }
    const whole = towerScene(context(211, { sloganCount: 3, sloganSpread: false, sloganPen: 'vermilion' }));
    expect(whole.slogans.placed.length).toBeGreaterThanOrEqual(2);
    expect(whole.slogans.placed.every(w => w.text === 'this was made by a machine')).toBe(true);
    expect(whole.parts.some(p => p.id === 'slogan-vermilion')).toBe(true);
  });
});
