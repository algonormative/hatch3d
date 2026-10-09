import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { facetStrokes, ruledFaces, solid, swapRuledFaces } from '../../sketches/kit/slabs.ts';
import { horizonCamera } from '../../sketches/kit/perspective.ts';
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

  describe('a slab\'s ruled faces swapped in for its hatch', () => {
    const page = { width: 279.4, height: 431.8 };
    const view = horizonCamera({ fov: 54, eye: [0, 2.4, 0], target: [0, 2.4, -100], far: 600, page, depth: { width: 559, height: 864 }, horizonY: 300 });
    // A block to the right of the eye, lit from behind and a little from the left: its front face is dark and ruled; the side
    // that turns to the eye is hatched as well, but is lit enough to stay hatch.
    const block = solid(10, 2, -30, 6, 8, 4, 0, 'stack');
    const behind = new THREE.Vector3(-0.5, 0.3, -1).normalize();

    it('drops the hatch on exactly the faces the ruling covers, keeps the outline and the other faces\' hatch, and adds the ruled lines last', () => {
      const made = facetStrokes(block, behind, view.position, false);
      const ruled = ruledFaces(block, behind, view, 1);
      const ruledFace = new Set(ruled.map(st => st.face));
      expect(ruled.length).toBeGreaterThan(0);
      // The test is only worth something if the facet hatch covers the ruled face and some face besides.
      const hatchFaces = new Set(made.filter(st => st.family === 'hatch').map(st => st.face));
      expect(hatchFaces.size).toBeGreaterThan(ruledFace.size);
      const swapped = swapRuledFaces(made, ruled);
      expect(swapped.slice(swapped.length - ruled.length)).toEqual(ruled);
      const rest = swapped.slice(0, swapped.length - ruled.length);
      expect(rest).toEqual(made.filter(st => st.family !== 'hatch' || !ruledFace.has(st.face)));
      expect(rest.filter(st => st.family === 'edge')).toEqual(made.filter(st => st.family === 'edge'));
      expect(rest.some(st => st.family === 'hatch' && ruledFace.has(st.face))).toBe(false);
      expect(rest.some(st => st.family === 'hatch')).toBe(true);
    });

    it('hands back the strokes it was given when nothing is ruled', () => {
      const made = facetStrokes(block, behind, view.position, false);
      expect(swapRuledFaces(made, [])).toBe(made);
    });
  });
});
