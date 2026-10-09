import { describe, expect, it } from 'vitest';
import { TABLOID_FORMAT, formatFor, printFine } from '../../sketches/kit/format.ts';

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
});
