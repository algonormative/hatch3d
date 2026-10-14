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

  it('passes strokes converging at 15 degrees, though they run under the limit for 1.5 mm', () => {
    const turn = 15 * Math.PI / 180;
    const converging = [line(0, 10, 10, 10), line(0, 10.1, 10 * Math.cos(turn), 10.1 + 10 * Math.sin(turn))];
    expect(probe([part('a', converging)]).violations).toBe(0);
    // ...which is under the limit long enough to count once the angle allows it.
    expect(densityProbe([part('a', converging)], { penWidth: () => 0.25, angle: 20 }).violations).toBe(1);
  });

  it('counts a run only while it lasts unbroken, and a share only of the length that runs too close', () => {
    // A stroke that touches down beside a line twice, 0.6 mm each time: 1.2 mm in all, but never 1 mm at once.
    const touches: Point[] = [{ x: 1, y: 10.3 }, { x: 1.6, y: 10.3 }, { x: 2, y: 12 }, { x: 5, y: 12 }, { x: 5, y: 10.3 }, { x: 5.6, y: 10.3 }];
    const touching = probe([part('a', [line(0, 10, 10, 10), touches])]);
    expect(touching.violations).toBe(0);
    expect(touching.parts[0].crowded).toBe(0);
    // A 2 mm stroke beside the middle of a 10 mm one: 2 mm of each run too close, a third of the 12 mm drawn.
    const report = probe([part('a', [line(0, 10, 10, 10), line(4, 10.3, 6, 10.3)])]);
    expect(report.violations).toBe(1);
    expect(report.parts[0].drawn).toBeCloseTo(12, 9);
    expect(report.parts[0].crowded).toBeCloseTo(4, 9);
    expect(report.parts[0].share).toBeCloseTo(1 / 3, 9);
  });

  it('takes a ring smaller than the limit for a dot, not two strokes', () => {
    const ring = Array.from({ length: 25 }, (_, i) => ({ x: 10 + 0.2 * Math.cos(i / 24 * 2 * Math.PI), y: 10 + 0.2 * Math.sin(i / 24 * 2 * Math.PI) }));
    expect(probe([part('a', [ring])]).violations).toBe(0);
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
