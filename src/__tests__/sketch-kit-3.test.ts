import { describe, expect, it } from 'vitest';
import { TABLOID_FORMAT, formatFor, printFine } from '../../sketches/kit/format.ts';
import { thinParallel, thinRanked } from '../../sketches/kit/density.ts';

const line = (x0: number, x1: number, y: number) => [{ x: x0, y }, { x: x1, y }];

describe('sketch kit: shared card helpers, batch 3', () => {
  it('sets the depth oversample that gives back the print\'s world resolution: 1 at tabloid, 1 / s rounded up elsewhere', () => {
    // This process has no render target, so it is tabloid.
    expect(printFine()).toBe(1);
    expect(printFine(TABLOID_FORMAT)).toBe(1);
    // 70 x 120: the scale is 0.278 on height and 0.251 on width, so the world is 3.6 and 3.99 times coarser per pixel.
    expect(printFine(formatFor({ width: 70, height: 120 }))).toBe(4);
    expect(printFine(formatFor({ width: 70, height: 120 }, { fit: 'width' }))).toBe(4);
    // Rounded up, not to the nearest: 200 mm tall is 2.16 times coarser by height and 3.1 by width.
    expect(printFine(formatFor({ width: 90, height: 200 }))).toBe(3);
    expect(printFine(formatFor({ width: 90, height: 200 }, { fit: 'width' }))).toBe(4);
    expect(printFine(formatFor({ width: 140, height: 240 }))).toBe(2);
    // A page bigger than tabloid draws the print's world finer than the print already, so it never goes under 1.
    expect(printFine(formatFor({ width: 300, height: 500 }))).toBe(1);
  });

  it('thins ranked pieces: the lowest rank keeps its line, ties go to the earlier piece, and each piece comes back with its kept runs', () => {
    const cloth = { piece: line(0, 10, 0.2), rank: 2, key: 'cloth' }, outline = { piece: line(0, 10, 0), rank: 0, key: 'outline' };
    // The outline ranks first though it comes second: it keeps its line, and the cloth 0.2 mm beside it loses the stretch.
    const [c, o] = thinRanked([cloth, outline], 0.5);
    expect([c.item, o.item]).toEqual([cloth, outline]);
    expect(c.item).toBe(cloth);
    expect(c.runs).toEqual([]);
    expect(o.runs).toHaveLength(1);
    expect([o.runs[0][0], o.runs[0][o.runs[0].length - 1]]).toEqual(line(0, 10, 0));
    // Equal ranks go to whichever came first.
    const a = { piece: line(0, 10, 2), rank: 1 }, b = { piece: line(0, 10, 2.2), rank: 1 };
    expect(thinRanked([a, b], 0.5).map(r => r.runs.length)).toEqual([1, 0]);
    expect(thinRanked([b, a], 0.5).map(r => r.runs.length)).toEqual([1, 0]);
    expect(thinRanked([b, a], 0.5).map(r => r.item)).toEqual([b, a]);
  });

  it('gives thinRanked\'s results in the order the pieces came or, on request, in rank order, as thinParallel gives its own', () => {
    const items = [
      { piece: line(0, 10, 3), rank: 3 }, { piece: line(0, 10, 0.2), rank: 2 }, { piece: line(0, 10, 0), rank: 0 }, { piece: line(0, 10, 3.1), rank: 1 }, { piece: [{ x: 5, y: -2 }, { x: 5.1, y: 4 }], rank: 4 },
    ];
    // In rank order: the outline (y 0), the 3.1 line, the 0.2 line (crowded by the outline), the 3.0 line (crowded by the 3.1), the crossing stroke.
    const byRank = [2, 3, 1, 0, 4];
    const expected = thinParallel(byRank.map(i => items[i].piece), 0.5);
    expect(expected.map(runs => runs.length)).toEqual([1, 1, 0, 0, 1]);
    const input = thinRanked(items, 0.5);
    expect(input.map(r => r.item)).toEqual(items);
    byRank.forEach((i, j) => expect(input[i].runs).toEqual(expected[j]));
    const ranked = thinRanked(items, 0.5, { order: 'rank' });
    expect(ranked.map(r => r.item)).toEqual(byRank.map(i => items[i]));
    expect(ranked.map(r => r.runs)).toEqual(expected);
    // The thinning options pass through: a line 5 degrees off the outline's, rising from 0.3 mm beside it, loses the first
    // 2 mm of itself (under 0.5 mm beside it) at the default 12 degrees of parallel, and nothing at 3.
    const slant = { piece: [{ x: 0, y: 0.3 }, { x: 10, y: 1.2 }], rank: 5 };
    const [, parallel] = thinRanked([items[2], slant], 0.5), [, across] = thinRanked([items[2], slant], 0.5, { angle: 3 });
    expect(parallel.runs).toHaveLength(1);
    expect(parallel.runs[0][0].x).toBeGreaterThan(2);
    expect(across.runs).toHaveLength(1);
    expect(across.runs[0][0].x).toBe(0);
    // Nothing in, nothing out.
    expect(thinRanked([], 0.5)).toEqual([]);
  });
});
