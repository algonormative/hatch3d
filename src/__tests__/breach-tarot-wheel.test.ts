import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { resolveParams } from '../../packages/plot-core/src/index.ts';
import type { SketchContext } from '../sketch/types.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import sketch from '../../sketches/breach-tarot/x-wheel/sketch.ts';
import { crossingRows, scene } from '../../sketches/breach-tarot/x-wheel/geometry.ts';
import { slabMatrix } from '../../sketches/kit/slabs.ts';
import { pageOf } from '../../sketches/kit/perspective.ts';

const entry = resolve('sketches/breach-tarot/x-wheel/sketch.ts');

/** The sketch's own context, as the runner builds it (same params, same seeded streams), to read the wheel's geometry. */
function context(seed: number): SketchContext {
  return {
    params: resolveParams(sketch.controls, undefined), seed, assets: {},
    random(id: string) {
      let state = createHash('sha256').update(`${seed}\0${id}`).digest().readUInt32LE(0);
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },
  };
}

describe('Breach Tarot: X Wheel of Fortune', () => {
  it('replays, stays inside the card, and draws the sky, the joints, the paving, the rim, the towers, the hub, the helix, the phrase and the frame', async () => {
    const first = await renderSketch({ entry, seed: 2 });
    const replay = await renderSketch({ entry, seed: 2 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(CARD.x0 - 0.01);
      expect(p.x).toBeLessThanOrEqual(CARD.x1 + 0.01);
      expect(p.y).toBeGreaterThanOrEqual(CARD.top - 0.01);
      expect(p.y).toBeLessThanOrEqual(CARD.bottom + 0.01);
    }
    const ids = first.parts.map(p => p.id);
    for (const id of ['sky-carbon', 'joints-carbon', 'ground-carbon', 'rim-carbon', 'tower-carbon', 'hub-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-') && id !== 'helix-carbon')).toBe(true);
  }, 60_000);

  it('stands half sunk with one tower on top: no rim mark below where the rim meets the ground, the top tower the highest point of the wheel and upright on the sheet', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const ctx = context(2);
    const { view, slabs } = scene(ctx);
    const ys = (match: (id: string) => boolean) => result.parts.filter(p => match(p.id)).flatMap(p => p.paths.flat().map(q => q.y));

    // The rim is cut at the ground: nothing of it is drawn lower on the sheet than the lower of its two crossings, and it comes right down to that line.
    const crossings = crossingRows(ctx);
    const lower = Math.max(crossings.left, crossings.right);
    const rimLow = Math.max(...ys(id => id.startsWith('rim-')));
    expect(rimLow).toBeLessThanOrEqual(lower + 0.3);
    expect(rimLow).toBeGreaterThan(lower - 3);

    // One tower stands on top, directly above the hub: the highest mark of the whole wheel is drawn in it...
    const top = slabs.filter(s => s.kind === 'tower' && s.tower === 0);
    const pageCentre = (s: (typeof top)[number]) => pageOf(view, new THREE.Vector3(s.x, s.y, s.z));
    const xs = top.flatMap(s => { const m = slabMatrix(s); return [-1, 1].flatMap(a => [-1, 1].flatMap(b => [-1, 1].map(c => pageOf(view, new THREE.Vector3(a * s.w / 2, b * s.h / 2, c * s.d / 2).applyMatrix4(m)).x))); });
    const band = [Math.min(...xs) - 0.5, Math.max(...xs) + 0.5];
    const inBand = result.parts.filter(p => p.id.startsWith('tower-')).flatMap(p => p.paths.filter(path => path.every(q => q.x >= band[0] && q.x <= band[1]))).flat();
    const wheelTop = Math.min(...ys(id => /^(rim|tower|hub)-/.test(id)));
    expect(inBand.length).toBeGreaterThan(0);
    expect(Math.min(...inBand.map(q => q.y))).toBeLessThanOrEqual(wheelTop + 0.01);

    // ...and it stands within 5 degrees of vertical on the sheet, from its lowest course to its highest.
    const courses = top.map(pageCentre).sort((a, b) => b.y - a.y);
    const lean = Math.atan2(Math.abs(courses[0].x - courses[courses.length - 1].x), courses[0].y - courses[courses.length - 1].y) * 180 / Math.PI;
    expect(courses.length).toBeGreaterThan(3);
    expect(lean).toBeLessThan(5);
  }, 60_000);

  it('keeps the foreground joints in the band below everything else drawn in the wheel', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const ys = (match: (id: string) => boolean) => result.parts.filter(p => match(p.id)).flatMap(p => p.paths.flat().map(q => q.y));
    expect(Math.min(...ys(id => id.startsWith('joints-')))).toBeGreaterThanOrEqual(Math.max(...ys(id => /^(rim|tower|hub|ground)-/.test(id))));
  }, 60_000);
});
