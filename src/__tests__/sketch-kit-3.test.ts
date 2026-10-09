import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TABLOID_FORMAT, formatFor, printFine } from '../../sketches/kit/format.ts';
import { thinParallel, thinRanked } from '../../sketches/kit/density.ts';
import { contourTube } from '../../sketches/kit/mannequin/body.ts';
import { drape, drapeStrokes } from '../../sketches/kit/mannequin/drape.ts';
import { figureBands, flowBody, ribbonStrokes } from '../../sketches/kit/mannequin/gesture.ts';
import { LOOK, type Look } from '../../sketches/kit/mannequin/hatch.ts';
import { POSES, poseSkeleton } from '../../sketches/kit/mannequin/skeleton.ts';
import { Tube, silhouettes } from '../../sketches/kit/mannequin/tube.ts';
import { sketchContext } from './helpers/sketch-context.ts';

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

  it('counts a ribbon figure\'s bands tube by tube, as a body ribboned a tube at a time would, and the numeric count as it always was', () => {
    const body = flowBody(poseSkeleton(POSES.stand));
    const env = { forward: new THREE.Vector3(0, 0, -1), density: 0.4, dark: () => 0.95, screen: (p: THREE.Vector3) => ({ x: 5 * p.x, y: -5 * p.y }) };
    const ribbon = { fill: 0.58, twist: 0.3, lines: 6 };
    const of = (b: typeof body, bands: number | { trunk: number; limb: number; head?: number }) => ribbonStrokes(b, env, LOOK, { ...ribbon, bands });
    const headless = { ...body, head: undefined };
    // Three bands round the trunk and two round each limb, in one call: each tube on its own as the trunk of a body, in the same order.
    const together = of(headless, { trunk: 3, limb: 2 });
    const apart = [body.trunk, ...body.limbs].flatMap(t => of({ ...body, trunk: t, limbs: [], head: undefined }, t === body.trunk ? 3 : 2));
    expect(together.length).toBeGreaterThan(100);
    expect(together).toEqual(apart);
    expect(of(headless, { trunk: 3, limb: 4 })).not.toEqual(together);
    expect(of(headless, { trunk: 4, limb: 2 })).not.toEqual(together);
    // A single number is the trunk's count, a limb's a little over half of it (at least four), the head's five: as before.
    expect(of(body, 6)).toEqual(of(body, { trunk: 6, limb: 4, head: 5 }));
    expect(of(body, 9)).toEqual(of(body, { trunk: 9, limb: 5 }));
    expect(of(body, { trunk: 6, limb: 4 })).toEqual(of(body, { trunk: 6, limb: 4, head: 5 }));
    expect(of(body, { trunk: 6, limb: 4, head: 2 })).not.toEqual(of(body, { trunk: 6, limb: 4 }));
  }, 60_000);

  it('gives a small figure the print\'s bands scaled with the card and never under one, and the print\'s own at tabloid', () => {
    expect(figureBands()).toBe(6);
    expect(figureBands(TABLOID_FORMAT)).toBe(6);
    // 70 x 120: s is 0.278 by height and 0.251 by width.
    expect(figureBands(formatFor({ width: 70, height: 120 }))).toEqual({ trunk: 2, limb: 1 });
    expect(figureBands(formatFor({ width: 70, height: 120 }, { fit: 'width' }))).toEqual({ trunk: 2, limb: 1 });
    expect(figureBands(formatFor({ width: 20, height: 34 }))).toEqual({ trunk: 1, limb: 1 });
    expect(figureBands(formatFor({ width: 200, height: 350 }))).toEqual({ trunk: 5, limb: 3 });
  });

  describe('the role a mannequin stroke carries', () => {
    const body = flowBody(poseSkeleton(POSES.stand));
    const env = { forward: new THREE.Vector3(0, 0, -1), density: 0.4, dark: () => 0.95, screen: (p: THREE.Vector3) => ({ x: 5 * p.x, y: -5 * p.y }) };
    // Each of the look's two groups apart, so a stroke's group says which of them drew it.
    const look: Look = { ...LOOK, figure: 'cloth-group', contour: 'outline-group' };

    it('tags a tube\'s silhouettes `outline`, whatever style they are drawn in', () => {
      const tube = new Tube('post', [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 2, 0)], [[0, 1, 1], [1, 1, 1]], new THREE.Vector3(1, 0, 0), 1);
      const plain = silhouettes(tube, env), styled = silhouettes(tube, env, { ink: 'carbon', group: 'edge', family: 'edge' });
      expect(plain.length).toBeGreaterThan(1);
      expect(styled).toHaveLength(plain.length);
      for (const st of [...plain, ...styled]) expect(st.role).toBe('outline');
    });

    it('tags a tube\'s rings `ring`, and a faceted tube\'s plane edges with them', () => {
      const rings = contourTube(body.trunk, env, look);
      expect(rings.length).toBeGreaterThan(5);
      for (const st of rings) expect(st.role).toBe('ring');
      const faceted = new Tube('post', [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 2, 0)], [[0, 1, 1], [1, 1, 1]], new THREE.Vector3(1, 0, 0), 1, [0, 0], undefined, 6);
      const edges = contourTube(faceted, env, { ...look, crease: 'acid' }).filter(st => st.ink === 'acid');
      expect(edges).toHaveLength(6);
      for (const st of edges) expect(st.role).toBe('ring');
    });

    it('tags a drape\'s fall hatch and creases `fold` and its neckline, hem, opening and silhouette `outline`', () => {
      const cloak = drape(body, { rng: sketchContext(3).random('cloak'), attach: 'shoulders', length: 0.95, folds: 9, depth: 0.1, flare: 0.07, gap: 0.015 * body.skeleton.height, open: 1.2 });
      const strokes = drapeStrokes(cloak, env, look);
      expect(strokes.length).toBeGreaterThan(20);
      // The look's cloth group draws the hatch and creases, its contour group everything that bounds the cloth.
      expect(new Set(strokes.map(st => st.group))).toEqual(new Set(['cloth-group', 'outline-group']));
      for (const st of strokes) expect(st.role).toBe(st.group === 'cloth-group' ? 'fold' : 'outline');
    });

    it('leaves the role of every other stroke unset: a ribbon figure\'s bands carry none, its silhouettes `outline`', () => {
      const strokes = ribbonStrokes({ ...body, head: undefined }, env, look, { bands: 3, lines: 4 });
      expect(strokes.some(st => st.group === 'cloth-group')).toBe(true);
      expect(strokes.some(st => st.group === 'outline-group')).toBe(true);
      for (const st of strokes) expect(st.role).toBe(st.group === 'outline-group' ? 'outline' : undefined);
      expect(strokes.filter(st => st.group === 'cloth-group').every(st => !('role' in st))).toBe(true);
    });
  });
});
