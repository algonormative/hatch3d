import { describe, expect, it } from 'vitest';
import { measureStrokeText, strokeText, strokeTextOnPath } from '../sketch/stroke-text.ts';

describe('plotted stroke text', () => {
  it('keeps the original wire face and a distinct matrix face as finite paths', () => {
    const wire = strokeText('PHASE GARDEN / 01', 18, 24, { face: 'wire', height: 12 });
    const matrix = strokeText('PHASE GARDEN / 01', 18, 24, { face: 'matrix', height: 12 });
    expect(wire.length).toBeGreaterThan(10);
    expect(matrix.length).toBeGreaterThan(wire.length * 3);
    expect(matrix).not.toEqual(wire);
    for (const path of [...wire, ...matrix]) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
    expect(measureStrokeText('PHASE', { height: 12 })).toBeGreaterThan(0);
  });

  it('bends over a multi-segment guide without nonfinite or out-of-guide samples', () => {
    const guide = [{ x: 10, y: 10 }, { x: 65, y: 10 }, { x: 105, y: 55 }];
    const paths = strokeTextOnPath('CURVED TEXT PATH', guide, { height: 6, align: 'end' });
    expect(paths.length).toBeGreaterThan(10);
    expect(paths.flat().some(p => p.x > 70 && p.y > 20)).toBe(true);
    for (const p of paths.flat()) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(() => strokeTextOnPath('LONG WORD', [{ x: 0, y: 0 }, { x: 1, y: 0 }], { height: 8 })).toThrow(/exceeds guide length/);
    expect(() => strokeTextOnPath('A', [{ x: 0, y: 0 }, { x: NaN, y: 3 }], { height: 8 })).toThrow(/finite points/);
  });

  it('rejects unsupported Unicode and bounded length explicitly', () => {
    expect(() => strokeText('<SCRIPT>', 0, 0, { height: 4 })).toThrow(/Unsupported stroke character U\+3C/);
    expect(() => strokeText('😀', 0, 0, { height: 4 })).toThrow(/Unsupported stroke character U\+1F600/);
    expect(() => strokeText('A'.repeat(257), 0, 0, { height: 4 })).toThrow(/exceeds 256/);
    expect(() => strokeText('A', Infinity, 0, { height: 4 })).toThrow(/finite/);
  });
});
