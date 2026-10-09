import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TABLOID_FORMAT, formatFor, maskRes } from '../../sketches/kit/format.ts';
import { BIAS_FLOOR, chunkPolyline, hiddenBias } from '../../sketches/kit/strokes.ts';

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

  it('turns a slack in world units into window depth by the camera\'s planes and the distance, and keeps it above a floor on request', () => {
    const view = new THREE.PerspectiveCamera(50, 0.65, 8, 4000);
    // The formula, by hand: slack * far * near / ((far - near) * d^2).
    expect(hiddenBias(view, 1.5, 100)).toBeCloseTo(1.5 * 4000 * 8 / ((4000 - 8) * 100 * 100), 15);
    // Twice the distance, a quarter of the bias; twice the slack, twice the bias.
    expect(hiddenBias(view, 1, 200)).toBeCloseTo(hiddenBias(view, 1, 100) / 4, 15);
    expect(hiddenBias(view, 2, 100)).toBeCloseTo(2 * hiddenBias(view, 1, 100), 15);
    // It reads the planes at the call, so a range fitted after the camera was made is the one used.
    const before = hiddenBias(view, 1, 100);
    view.far = 400;
    expect(hiddenBias(view, 1, 100)).toBeGreaterThan(before);
    // Far away a small slack falls under the floor; a floor never lowers a bias that is above it.
    const far = hiddenBias(view, 0.01, 3000);
    expect(far).toBeLessThan(BIAS_FLOOR);
    expect(hiddenBias(view, 0.01, 3000, BIAS_FLOOR)).toBe(BIAS_FLOOR);
    expect(hiddenBias(view, 1, 10, BIAS_FLOOR)).toBe(hiddenBias(view, 1, 10));
  });

  it('cuts a polyline into runs of at most `size` points that share their ends, and leaves a short one whole only when told to', () => {
    const line = Array.from({ length: 10 }, (_, i) => i);
    // Ten points in runs of four: 0-3, 3-6, 6-9, and every point is in a run, each end shared with the next run.
    expect(chunkPolyline(line, 4)).toEqual([[0, 1, 2, 3], [3, 4, 5, 6], [6, 7, 8, 9]]);
    // The last run is the short one: eleven points leave a two-point run.
    expect(chunkPolyline([...line, 10], 4)).toEqual([[0, 1, 2, 3], [3, 4, 5, 6], [6, 7, 8, 9], [9, 10]]);
    // A polyline that fits in one run is that run; a point is no run.
    expect(chunkPolyline([0, 1, 2], 4)).toEqual([[0, 1, 2]]);
    expect(chunkPolyline([0], 4)).toEqual([]);
    expect(chunkPolyline([], 4)).toEqual([]);
    // With `whole`, up to `size + whole` points stay uncut (the same array), where without it the extra point makes a run of two.
    const five = [0, 1, 2, 3, 4];
    expect(chunkPolyline(five, 4)).toEqual([[0, 1, 2, 3], [3, 4]]);
    expect(chunkPolyline(five, 4, 1)[0]).toBe(five);
    expect(chunkPolyline(five, 4, 1)).toEqual([five]);
    expect(chunkPolyline([...five, 5], 4, 1)).toEqual([[0, 1, 2, 3], [3, 4, 5]]);
    // A short polyline is returned as it is under `whole`, a single point included.
    expect(chunkPolyline([7], 4, 1)).toEqual([[7]]);
  });
});
