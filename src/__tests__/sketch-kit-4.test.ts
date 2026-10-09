import { describe, expect, it } from 'vitest';
import { TABLOID_FORMAT, formatFor, maskRes } from '../../sketches/kit/format.ts';

describe('sketch kit: shared card helpers, batch 4', () => {
  it('rasters a knockout mask at the print\'s resolution in the world: 3 at tabloid, 3 / s on a smaller card, and the base is a parameter', () => {
    // This process has no render target, so it is tabloid.
    expect(maskRes()).toBe(3);
    expect(maskRes(TABLOID_FORMAT)).toBe(3);
    expect(maskRes(TABLOID_FORMAT, 4)).toBe(4);
    // 70 x 120: the scale is 0.278 on height and 0.251 on width, so a mask pixel must be 3.6 and 3.99 times finer.
    const small = formatFor({ width: 70, height: 120 }), wide = formatFor({ width: 70, height: 120 }, { fit: 'width' });
    expect(maskRes(small)).toBeCloseTo(3 / small.s, 12);
    expect(maskRes(small)).toBeGreaterThan(10);
    expect(maskRes(wide)).toBeGreaterThan(maskRes(small));
    expect(maskRes(small, 4)).toBeCloseTo(4 / small.s, 12);
    // A page bigger than tabloid has a scale over 1, so a coarser mask suffices.
    expect(maskRes(formatFor({ width: 300, height: 500 }))).toBeLessThan(3);
  });
});
