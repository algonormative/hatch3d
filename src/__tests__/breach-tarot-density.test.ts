import { describe, expect, it } from 'vitest';
import type { Part, Point } from '../sketch/types.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';

const line = (x0: number, y0: number, x1: number, y1: number): Point[] => [{ x: x0, y: y0 }, { x: x1, y: y1 }];
const part = (id: string, paths: Point[][], pen = 'carbon'): Part => ({ id, pen, paths });
const widths: Record<string, number> = { carbon: 0.25, lettering: 0.13 };
const probe = (parts: Part[]) => densityProbe(parts, { penWidth: pen => widths[pen] });

describe('density probe', () => {
  it('flags parallel strokes of one part closer than twice the pen width, with where they are', () => {
    const report = probe([part('hatch', [line(0, 10, 10, 10), line(0, 10.3, 10, 10.3)])]);
    expect(report.violations).toBe(1);
    expect(report.worst[0]).toMatchObject({ part: 'hatch', pen: 'carbon', paths: [0, 1] });
    expect(report.worst[0].gap).toBeCloseTo(0.3, 6);
    expect(report.worst[0].run).toBeCloseTo(10, 1);
    expect(report.worst[0].at.y).toBeGreaterThan(9.9);
    expect(report.parts[0].share).toBeCloseTo(1, 1);
    expect(describeDensity(report)).toMatch(/hatch paths 0\/1: 0\.300 mm apart/);
  });

  it('passes strokes at the pen floor or wider, the same line drawn twice, crossings and brief touches', () => {
    expect(probe([part('a', [line(0, 10, 10, 10), line(0, 10.6, 10, 10.6)])]).violations).toBe(0);
    expect(probe([part('a', [line(0, 10, 10, 10), line(0, 10.02, 10, 10.02)])]).violations).toBe(0);
    expect(probe([part('a', [line(0, 0, 10, 10), line(0, 10, 10, 0)])]).violations).toBe(0);
    // Alongside for only 0.6 mm, under the 1 mm a run needs.
    expect(probe([part('a', [line(0, 10, 10, 10), line(9.4, 10.3, 20, 10.3)])]).violations).toBe(0);
    // Turned 20 degrees: not parallel.
    const turn = 20 * Math.PI / 180;
    expect(probe([part('a', [line(0, 10, 10, 10), line(0, 10.3, 10 * Math.cos(turn), 10.3 + 10 * Math.sin(turn))])]).violations).toBe(0);
  });

  it('judges each part by its own pen, and a stroke folded back on itself', () => {
    expect(probe([part('a', [line(0, 10, 10, 10)]), part('b', [line(0, 10.3, 10, 10.3)])]).violations).toBe(0);
    expect(probe([part('words', [line(0, 10, 10, 10), line(0, 10.3, 10, 10.3)], 'lettering')]).violations).toBe(0);
    const hairpin: Point[] = [{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 10.3 }, { x: 0, y: 10.3 }];
    expect(probe([part('a', [hairpin])]).worst[0]).toMatchObject({ paths: [0, 0] });
  });

  it('names the parts that crowd more than on a reference render', () => {
    const sparse = probe([part('hatch', [line(0, 10, 10, 10), line(0, 10.6, 10, 10.6)]), part('edge', [line(0, 0, 10, 0)])]);
    const tight = probe([part('hatch', [line(0, 10, 10, 10), line(0, 10.3, 10, 10.3)]), part('edge', [line(0, 0, 10, 0)])]);
    expect(denserThan(sparse, sparse)).toEqual([]);
    expect(denserThan(sparse, tight)).toEqual([]);
    expect(denserThan(tight, sparse)).toEqual([{ id: 'hatch', share: tight.parts[0].share, reference: 0 }]);
  });
});
