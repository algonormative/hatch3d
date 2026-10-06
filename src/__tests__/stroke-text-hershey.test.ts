import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CATHEDRAL_CHARSET, cathedralGlyph, measureStrokeText, strokeText, strokeTextOnPath, type StrokeFace } from '../sketch/stroke-text.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('Hershey stroke faces', () => {
  it('keeps wire, matrix, sans and script output byte-identical as faces are added', () => {
    // wire/matrix digests come from the original two-face module; sans/script from 2f216f9, before 'cathedral'.
    const sample = 'Phase Garden 01T / this was made by a machine?';
    const expected: Record<string, string> = {
      wire: '8f8f5de3202a0907517eff8ad6ce75a68c02afe72e1f98fd73f8da67f84c09e8',
      matrix: 'a930329b434c5586b36ba60cc60ae5a74e2cbb5ca8f1f6407eb78da72864e444',
      sans: 'c52985087f9fb0db5fd1a3f79e0f0e47e4a1fbf40cbd87efd9205804776da053',
      script: '13e1188ccb1f142678d5e09319cc22541dd54c24e4099339f729468fc61db35c',
    };
    for (const face of ['wire', 'matrix', 'sans', 'script'] as StrokeFace[]) {
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

type P = { x: number; y: number };
/** Distance between two segments; 0 when they touch or cross. */
function segmentGap(a: P, b: P, c: P, d: P): number {
  const cross = (o: P, p: P, q: P) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (d1 * d2 < -1e-12 && d3 * d4 < -1e-12) return 0;
  const toSegment = (p: P, s: P, e: P) => {
    const dx = e.x - s.x, dy = e.y - s.y, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / l)) : 0;
    return Math.hypot(p.x - s.x - t * dx, p.y - s.y - t * dy);
  };
  return Math.min(toSegment(a, c, d), toSegment(b, c, d), toSegment(c, a, b), toSegment(d, a, b));
}

describe('Breach Cathedral face', () => {
  it('covers letters, digits and the title punctuation, case-preserving, inside its grid', () => {
    const required = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' + ".,:;'-!?/()&+";
    for (const char of required) expect(CATHEDRAL_CHARSET).toContain(char);
    for (const char of CATHEDRAL_CHARSET) {
      const glyph = cathedralGlyph(char)!;
      expect(glyph.paths.length).toBeGreaterThan(0);
      for (const p of glyph.paths.flat()) {
        // Grid: x 0..6, cap top 0, baseline 8, descender 11 (brackets overshoot by half a unit).
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(6);
        expect(p.y).toBeGreaterThanOrEqual(-0.5);
        expect(p.y).toBeLessThanOrEqual(11);
      }
      // Straight segments only: every stroke is a short list of grid vertices, not a sampled curve.
      expect(glyph.paths.every(path => path.length <= 13)).toBe(true);
    }
    expect(strokeText('machine', 0, 0, { face: 'cathedral', height: 2 })).not.toEqual(strokeText('MACHINE', 0, 0, { face: 'cathedral', height: 2 }));
    const ys = strokeText('H', 0, 0, { face: 'cathedral', height: 2 }).flat().map(p => p.y);
    expect(Math.min(...ys)).toBeCloseTo(0, 9);
    expect(Math.max(...ys)).toBeCloseTo(2, 9);
    expect(() => strokeText('#', 0, 0, { face: 'cathedral', height: 2 })).toThrow(RangeError);
    // A 30-character title with a git hash stays a sensible width at 3 mm.
    expect(measureStrokeText('Breach Cathedral v12 2f216f9+', { face: 'cathedral', height: 3 })).toBeLessThan(75);
  });

  it('keeps strokes that do not touch at least 0.25 mm apart at 2 mm cap height', () => {
    let closest = Infinity;
    for (const char of CATHEDRAL_CHARSET) {
      const segments = strokeText(char, 0, 0, { face: 'cathedral', height: 2 }).flatMap(path => path.slice(1).map((b, i) => [path[i], b]));
      for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
        const gap = segmentGap(segments[i][0], segments[i][1], segments[j][0], segments[j][1]);
        if (gap > 1e-6) closest = Math.min(closest, gap);
      }
    }
    expect(closest).toBeGreaterThanOrEqual(0.25 - 1e-6);
  });
});
