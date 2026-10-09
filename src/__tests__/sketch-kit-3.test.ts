import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { TABLOID_FORMAT, formatFor, printFine } from '../../sketches/kit/format.ts';
import { thinParallel, thinRanked } from '../../sketches/kit/density.ts';
import { contourTube } from '../../sketches/kit/mannequin/body.ts';
import { drape, drapeStrokes } from '../../sketches/kit/mannequin/drape.ts';
import { figureBands, flowBody, ribbonStrokes } from '../../sketches/kit/mannequin/gesture.ts';
import { LOOK, type Look } from '../../sketches/kit/mannequin/hatch.ts';
import { POSES, poseSkeleton } from '../../sketches/kit/mannequin/skeleton.ts';
import { Tube, silhouettes } from '../../sketches/kit/mannequin/tube.ts';
import { facetStrokes, ruledFaces, slabFaceNormal, slabGeometry, slabMatrix, solid } from '../../sketches/kit/slabs.ts';
import { horizonCamera, oversampledView } from '../../sketches/kit/perspective.ts';
import { fineDepth, fineEnv } from '../../sketches/kit/strokes.ts';
import { renderDepthBufferCPU } from '../sketch/depth-buffer.ts';
import { sketchContext } from './helpers/sketch-context.ts';

const line = (x0: number, x1: number, y: number) => [{ x: x0, y }, { x: x1, y }];

let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

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

  describe('the face a slab\'s hatch lies on', () => {
    const page = { width: 279.4, height: 431.8 };
    const view = horizonCamera({ fov: 54, eye: [0, 2.4, 0], target: [0, 2.4, -100], far: 600, page, depth: { width: 559, height: 864 }, horizonY: 300 });

    it('names the six faces by their normals in the slab\'s own frame: +z, -z, +x, -x, +y, -y', () => {
      expect([0, 1, 2, 3, 4, 5].map(f => slabFaceNormal(f).toArray())).toEqual([[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]);
      // A fresh vector each time, so a caller may turn it.
      expect(slabFaceNormal(0)).not.toBe(slabFaceNormal(0));
    });

    it('tags each hatch stroke of facetStrokes with the face it lies on, and no edge', () => {
      // A slab turned every which way, seen from above and to one side so several of its faces see the eye.
      const slab = { ...solid(1, 2, -30, 4, 6, 3, 0, 'stack'), rx: 0.4, ry: 0.7, rz: 0.2 };
      const strokes = facetStrokes(slab, new THREE.Vector3(0.2, -1, 0.3).normalize(), new THREE.Vector3(14, 30, 0), false);
      const inverse = slabMatrix(slab).invert(), half = [slab.w / 2, slab.h / 2, slab.d / 2];
      const hatch = strokes.filter(st => st.family === 'hatch');
      expect(hatch.length).toBeGreaterThan(20);
      expect(strokes.filter(st => st.family === 'edge').every(st => st.face === undefined)).toBe(true);
      expect(new Set(hatch.map(st => st.face)).size).toBeGreaterThanOrEqual(3);
      for (const st of hatch) {
        // Every point of the stroke stands the hair off that face's plane that the kit keeps hatch from its surface.
        const n = slabFaceNormal(st.face!), axis = n.x ? 0 : n.y ? 1 : 2;
        for (const p of st.points) {
          const local = p.clone().applyMatrix4(inverse);
          expect(local.dot(n)).toBeCloseTo(half[axis] + 0.006, 9);
        }
      }
    });

    it('tags the ruled lines of ruledFaces with their face too, in the same numbering', () => {
      // Seen from the origin, light from behind: only the face towards the eye is ruled. Turned a quarter about y it is the -x one.
      const block = solid(0, 2, -30, 6, 8, 4, 0, 'stack');
      const behind = new THREE.Vector3(0, 0, -1);
      const front = ruledFaces(block, behind, view, 1);
      expect(front.length).toBe(5);
      expect(front.every(st => st.face === 0)).toBe(true);
      const turned = ruledFaces({ ...block, ry: Math.PI / 2 }, behind, view, 1);
      expect(turned.length).toBeGreaterThan(0);
      expect(turned.every(st => st.face === 3)).toBe(true);
      const other = ruledFaces({ ...block, ry: -Math.PI / 2 }, behind, view, 1);
      expect(other.length).toBeGreaterThan(0);
      expect(other.every(st => st.face === 2)).toBe(true);
      const tipped = ruledFaces({ ...block, rx: Math.PI / 2 }, behind, view, 1);
      expect(tipped.length).toBeGreaterThan(0);
      expect(tipped.every(st => st.face === 4)).toBe(true);
      expect(ruledFaces({ ...block, rx: -Math.PI / 2 }, behind, view, 1).every(st => st.face === 5)).toBe(true);
    });
  });

  it('keeps a scenery scrap at the layout scale but never under the smallest feature: as authored at tabloid, a millimetre or the scaled length on 70 x 120', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-kit3-'));
    const entry = join(dir, 'probe.ts');
    // A page-aware probe: lines whose ends encode what `sceneMin` gives for 2, 5 and 0.2 mm (the probe is clipped to the page margin, so offset from 20).
    await writeFile(entry, `import { sceneMin } from ${JSON.stringify(resolve(import.meta.dirname, '../../sketches/kit/format.ts'))};
      export default { name: 'probe', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.3 }], controls: [],
        draw() { return [{ id: 'mins', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + sceneMin(2), y: 20 + sceneMin(5) }]] },
          { id: 'tiny', pen: 'ink', paths: [[{ x: 20, y: 30 }, { x: 20 + sceneMin(0.2), y: 31 }]] }]; } };`);
    const at = (r: Awaited<ReturnType<typeof renderSketch>>, id: string) => { const [a, b] = r.parts.find(part => part.id === id)!.paths[0]; return { x: b.x - a.x, y: b.y - a.y }; };
    const tabloid = await renderSketch({ entry, timeoutMs: 120_000 });
    expect(at(tabloid, 'mins').x).toBeCloseTo(2, 3);
    expect(at(tabloid, 'mins').y).toBeCloseTo(5, 3);
    expect(at(tabloid, 'tiny').x).toBeCloseTo(0.2, 3);
    const small = await renderSketch({ entry, finishing: { page: { width: 70, height: 120 } }, timeoutMs: 120_000 });
    // 2 mm scales to 0.56 mm, under the 1 mm feature floor; 5 mm to 1.39 mm, over it.
    expect(at(small, 'mins').x).toBeCloseTo(1, 3);
    expect(at(small, 'mins').y).toBeCloseTo(5 * 120 / 431.8, 3);
    expect(at(small, 'tiny').x).toBeCloseTo(1, 3);
  }, 120_000);

  it('takes a card\'s own depth pass as the fine one at 1, and renders the finer pass at any other', () => {
    const page = { width: 279.4, height: 431.8 };
    const view = horizonCamera({ fov: 54, eye: [0, 2.4, 0], target: [0, 2.4, -100], far: 600, page, depth: { width: 40, height: 62 }, horizonY: 300 });
    const slabs = [solid(0, 2, -30, 8, 6, 2, 0, 'stack')].map(slabGeometry);
    const raster = { W: 40, H: 62, MM_X: page.width / 40, MM_Y: page.height / 62 };
    const own = { view, depth: renderDepthBufferCPU(slabs, view, 40, 62), width: 40, height: 62 };
    // At 1 the card's own env comes back as it is: the same object, not a second render, and the raster's own millimetres.
    const same = fineEnv(slabs, view, own, raster, 1);
    expect(same.env).toBe(own);
    expect([same.mmX, same.mmY]).toEqual([raster.MM_X, raster.MM_Y]);
    // At 4 it is `fineDepth`'s: a depth pass four times the raster, from the camera given, and a quarter of the millimetres per pixel.
    const finer = oversampledView(view, 4);
    const fine = fineEnv(slabs, finer, own, raster, 4);
    expect(fine.env).not.toBe(own);
    expect([fine.env.width, fine.env.height, fine.env.view]).toEqual([160, 248, finer]);
    expect(fine.env.depth.depthData).toEqual(fineDepth(slabs, finer, raster, 4).env.depth.depthData);
    expect([fine.mmX, fine.mmY]).toEqual([raster.MM_X / 4, raster.MM_Y / 4]);
  });
});
