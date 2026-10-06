import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import type { Part, SketchContext } from '../../src/sketch/types.ts';
import { drawAgent } from '../../sketches/breach-cathedral-agent/geometry.ts';

const entry = resolve('sketches/breach-cathedral-agent/sketch.ts');
const PENS = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];

function length(parts: Part[], prefix = ''): number {
  let total = 0;
  for (const part of parts) if (part.id.startsWith(prefix)) for (const path of part.paths) {
    for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  return total;
}

function context(seed: number, params: SketchContext['params'] = {}): SketchContext {
  return { params, seed, assets: {}, random: (id: string) => {
    let h = (seed * 2654435761) >>> 0;
    for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 2 ** 32; };
  } };
}

describe('Breach Cathedral: Agent', () => {
  it('replays, fills five pens with finite page-bounded paths, and stays inside the budget', async () => {
    const first = await renderSketch({ entry, seed: 1 });
    const replay = await renderSketch({ entry, seed: 1 });
    const other = await renderSketch({ entry, seed: 5 });
    expect(replay.identity).toBe(first.identity);
    expect(other.identity).not.toBe(first.identity);
    for (const result of [first, other]) {
      expect(result.diagnostics).toEqual([]);
      expect(result.stats.pathCount).toBeLessThanOrEqual(8000);
      expect(result.stats.lengthMm).toBeLessThanOrEqual(90_000);
      for (const pen of PENS) expect(result.parts.filter(p => p.pen === pen).flatMap(p => p.paths).length).toBeGreaterThan(20);
      for (const part of result.parts) for (const path of part.paths) for (const p of path) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(p.x).toBeGreaterThanOrEqual(18);
        expect(p.x).toBeLessThanOrEqual(261.4);
        expect(p.y).toBeGreaterThanOrEqual(18);
        expect(p.y).toBeLessThanOrEqual(413.8);
      }
    }
  }, 30_000);

  it('lights the suit from the head: a longer reach of light removes pinstripes', () => {
    const dim = length(drawAgent(context(1, { glow: 0 })), 'figure');
    const bright = length(drawAgent(context(1, { glow: 1 })), 'figure');
    expect(bright).toBeLessThan(dim * 0.8);
  }, 30_000);

  it('hides lines behind the figure and throne, and keeps the ribbon cloth as an alternative', () => {
    const shown = drawAgent(context(2));
    expect(length(drawAgent(context(2, { occlusion: false })))).toBeGreaterThan(length(shown) * 1.3);
    const ribbon = drawAgent(context(2, { cloth: 'ribbon' }));
    expect(length(ribbon, 'figure')).not.toBeCloseTo(length(shown, 'figure'), 0);
    expect(ribbon.some(p => p.id === 'contour-vermilion')).toBe(true);
  }, 30_000);

  it('looks up and to the viewer\'s left: the beam leaves the face toward the upper-left of the sheet', () => {
    const parts = drawAgent(context(1, { radiance: 0, beam: 1 }));
    const beams = parts.filter(p => p.id.startsWith('rays-')).flatMap(p => p.paths);
    expect(beams.length).toBeGreaterThan(10);
    let dx = 0, dy = 0;
    for (const path of beams) { dx += path.at(-1)!.x - path[0].x; dy += path.at(-1)!.y - path[0].y; }
    expect(dx).toBeLessThan(0);
    expect(dy).toBeLessThan(0);
  }, 30_000);

  it('varies the pose: crossed legs move the trousers', () => {
    const apart = length(drawAgent(context(3, { legs: 'apart' })), 'figure');
    const crossed = length(drawAgent(context(3, { legs: 'crossed' })), 'figure');
    expect(Math.abs(crossed - apart) / apart).toBeGreaterThan(0.02);
  }, 30_000);
});
