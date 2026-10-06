import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { measureStrokeText, strokeText, strokeTextOnPath, type StrokeFace } from '../sketch/stroke-text.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('Hershey stroke faces', () => {
  it('keeps wire and matrix output byte-identical to the pre-Hershey implementation', () => {
    // Digests recorded from the original two-face module before the Hershey faces were added.
    const sample = 'Phase Garden 01T / this was made by a machine?';
    const expected: Record<string, string> = {
      wire: '8f8f5de3202a0907517eff8ad6ce75a68c02afe72e1f98fd73f8da67f84c09e8',
      matrix: 'a930329b434c5586b36ba60cc60ae5a74e2cbb5ca8f1f6407eb78da72864e444',
    };
    for (const face of ['wire', 'matrix'] as StrokeFace[]) {
      expect(digest([strokeText(sample, 10, 20, { face, height: 7 }), measureStrokeText(sample, { face, height: 7 }),
        strokeTextOnPath('ARC 9', [{ x: 0, y: 0 }, { x: 40, y: 10 }, { x: 80, y: 0 }], { face, height: 5, align: 'center' })]))
        .toBe(expected[face]);
    }
  });

  it('renders lowercase distinctly, with height as cap height', () => {
    for (const face of ['sans', 'script'] as StrokeFace[]) {
      const lower = strokeText('machine', 0, 0, { face, height: 2 });
      const upper = strokeText('MACHINE', 0, 0, { face, height: 2 });
      expect(lower.length).toBeGreaterThan(0);
      expect(lower).not.toEqual(upper);
      const ys = (paths: typeof lower) => paths.flat().map(p => p.y);
      // Capitals span the cap height; x-height lowercase sits well below the cap line.
      expect(Math.min(...ys(upper))).toBeCloseTo(0, 5);
      expect(Math.max(...ys(strokeText('H', 0, 0, { face: 'sans', height: 2 })))).toBeCloseTo(2, 5);
      expect(Math.min(...ys(strokeText('xu', 0, 0, { face, height: 2 })))).toBeGreaterThan(0.5);
      expect(measureStrokeText('this was made by a machine', { face, height: 2 })).toBeGreaterThan(20);
    }
    expect(() => strokeText('é', 0, 0, { face: 'sans', height: 2 })).toThrow(RangeError);
  });
});
