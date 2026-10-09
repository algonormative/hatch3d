import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { formatFor, type Fit } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/vi-lovers/sketch.ts');

type Pt = { x: number; y: number };
type Part = { id: string; paths: Pt[][] };

/** Every path resampled to points at most `step` millimetres apart, so a long straight hatch line is a row of points. */
const dense = (parts: Part[], ids: string[], step = 1): Pt[] => parts.filter(p => ids.includes(p.id)).flatMap(p => p.paths.flatMap(path => {
  const out: Pt[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 1; j <= k; j++) out.push({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k });
  }
  return out;
}));

/** Whether any point of `a` lies within `limit` millimetres of any point of `b` (a grid of `limit`-sized cells over `b`). */
function anyWithin(a: Pt[], b: Pt[], limit: number): boolean {
  const cell = new Map<string, Pt[]>();
  for (const q of b) {
    const key = `${Math.floor(q.x / limit)},${Math.floor(q.y / limit)}`;
    (cell.get(key) ?? cell.set(key, []).get(key)!).push(q);
  }
  for (const p of a) {
    const cx = Math.floor(p.x / limit), cy = Math.floor(p.y / limit);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const q of cell.get(`${cx + dx},${cy + dy}`) ?? []) if (Math.hypot(p.x - q.x, p.y - q.y) < limit) return true;
    }
  }
  return false;
}

const lover = (parts: Part[], side: 'left' | 'right') => dense(parts, [`${side}-carbon`, `${side}-edge-carbon`]);
const shadowOf = (parts: Part[], side: 'left' | 'right') => dense(parts, [`shadow-${side}-carbon`]);

describe('Breach Tarot: VI The Lovers', () => {
  it('replays, stays inside the card, and draws the sky, the shadows, the two towers, the two lovers, the helix, the phrase and the frame', async () => {
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
    for (const id of ['sky-carbon', 'shadow-carbon', 'shadow-left-carbon', 'shadow-right-carbon', 'near-carbon', 'far-carbon', 'left-carbon', 'right-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-') && id !== 'helix-carbon')).toBe(true);
  }, 60_000);

  it('has the lovers reach but never touch, and float: their drawn paths come close without meeting, and each hangs clear of its own shadow', async () => {
    const { parts } = await renderSketch({ entry, seed: 2 });
    const left = lover(parts, 'left'), right = lover(parts, 'right');
    expect(left.length).toBeGreaterThan(100);
    expect(right.length).toBeGreaterThan(100);
    // They reach: the hands come within a few millimetres of each other on the sheet.
    expect(anyWithin(left, right, 8)).toBe(true);
    // They never touch: nothing of one is within 2 mm of anything of the other.
    expect(anyWithin(left, right, 2)).toBe(false);
    for (const side of ['left', 'right'] as const) {
      const body = lover(parts, side), shadow = shadowOf(parts, side);
      expect(shadow.length).toBeGreaterThan(100);
      // Detached from its shadow: no drawn point of the lover within 6 mm of its own shadow (a figure standing on the ground would touch it).
      expect(anyWithin(body, shadow, 6)).toBe(false);
      // Above the ground under it: the lowest drawn point is well above the bottom of its shadow on the sheet.
      expect(Math.max(...shadow.map(p => p.y)) - Math.max(...body.map(p => p.y))).toBeGreaterThan(8);
    }
  }, 60_000);
});

describe('Breach Tarot: VI The Lovers at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none. One render per fit, shared.
  const renders = new Map<Fit, Promise<RenderResult>>();
  const fresh = (fit: Fit) => renderSketch({ entry, seed: 2, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const render = (fit: Fit) => renders.get(fit) ?? renders.set(fit, fresh(fit)).get(fit)!;
  let printed: Promise<RenderResult> | undefined;
  const print = () => printed ??= renderSketch({ entry, seed: 2, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const paths = (result: { parts: Part[] }, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths);
  const box = (ps: Pt[]) => ({ x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)) });
  const mean = (ps: Pt[]) => ps.reduce((sum, p) => sum + p.x, 0) / ps.length;
  /** The nearest two points of `a` and `b`. */
  const nearest = (a: Pt[], b: Pt[]) => {
    let best = { d: Infinity, at: { x: 0, y: 0 } };
    for (const p of a) for (const q of b) { const d = Math.hypot(p.x - q.x, p.y - q.y); if (d < best.d) best = { d, at: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } }; }
    return best;
  };
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: the light, the lovers, every course of both towers and the strands\' course', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-lovers-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { loversWorld } from ${JSON.stringify(resolve('sketches/breach-tarot/vi-lovers/geometry.ts'))};
      import { figureMeshes } from ${JSON.stringify(resolve('sketches/breach-tarot/vi-lovers/figures.ts'))};
      import { JOINTS } from ${JSON.stringify(resolve('sketches/kit/mannequin/skeleton.ts'))};
      export default { name: 'lovers-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [{ type: 'slider', id: 'figX', label: 'The pair, across the page', default: 144, min: 90, max: 190, step: 1 }],
        draw(ctx) {
          const w = loversWorld(ctx), h = createHash('sha256');
          h.update([w.light.x, w.light.y, w.light.z, w.scale, w.phaseB, w.leadWidth, w.rollA, w.rollB, ...Object.values(w.ribbon), ';'].join(','));
          for (const f of [w.lovers.left, w.lovers.right]) {
            for (const j of JOINTS) { const p = f.skeleton.at(j); h.update([p.x, p.y, p.z, ';'].join(',')); }
            h.update([f.tip.x, f.tip.y, f.tip.z, ';'].join(','));
            for (const g of figureMeshes(f)) { h.update(Buffer.from(g.getAttribute('position').array.buffer)); g.dispose(); }
          }
          for (const t of [w.near, w.far]) {
            for (const v of [t.top, t.base]) h.update([v.x, v.y, v.z, ';'].join(','));
            for (const { sl, course, piece, centre } of t.pieces) h.update([sl.x, sl.y, sl.z, sl.w, sl.h, sl.d, sl.rx, sl.ry, sl.rz, sl.tone, course, piece, centre, ';'].join(','));
          }
          for (const s of [w.spineA, w.spineB, w.leadA, w.leadB]) for (const p of s.pts) h.update([p.x, p.y, p.z, ';'].join(','));
          const d = h.digest();
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.near.pieces.length / 10, y: 20 + w.far.pieces.length / 10 }]] }];
        } };`);
    // The default, and the pair moved across the page.
    for (const params of [{}, { figX: 110 }] as Record<string, number>[]) {
      const [printWorld, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 2, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 2, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      expect(printWorld.diagnostics).toEqual([]);
      const counts = printWorld.parts.find(part => part.id === 'counts')!.paths[0];
      expect(counts[1].x).toBeGreaterThan(20 + 12 / 10);
      expect(counts[1].y).toBeGreaterThan(20 + 12 / 10);
      for (const result of small) for (const id of ['digest', 'counts']) {
        expect(result.parts.find(part => part.id === id)!.paths, `${JSON.stringify(params)} ${id}`).toEqual(printWorld.parts.find(part => part.id === id)!.paths);
      }
    }
  }, 120_000);

  it('replays in both fits, draws the scene in the art window, no words in the art, and the phrase in the band', async () => {
    for (const fit of fits) {
      const [first, replay] = await Promise.all([render(fit), fresh(fit)]);
      expect(replay.identity).toBe(first.identity);
      expect(first.diagnostics).toEqual([]);
      expect(first.metadata.page).toMatchObject(page);
      const { card, frame } = formatOf(fit);
      for (const part of first.parts) for (const path of part.paths) for (const p of path) {
        expect(p.x).toBeGreaterThanOrEqual(card.x0 - 0.01);
        expect(p.x).toBeLessThanOrEqual(card.x1 + 0.01);
        expect(p.y).toBeGreaterThanOrEqual(card.top - 0.01);
        expect(p.y).toBeLessThanOrEqual(card.bottom + 0.01);
      }
      // Paths wholly inside the art window, per part of the scene: the sky, the towers' shadows, the lovers' shadow, the two
      // towers, the two lovers, the strands, the horizon.
      const inWindow = (prefix: string) => paths(first, prefix)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 80, 'shadow-carbon': 30, 'shadow-left-': 20, 'near-': 100, 'far-': 80, 'left-': 20, 'right-': 15, 'helix-': 60, 'horizon-': 0 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = paths(first, 'card-phrase').flat();
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 240_000);

  it('still reads as the Lovers: two towers either side of the pair, the hands a breath apart, the shadow running on beneath the gap, the two strands winding round each other overhead', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { card, horizonY } = formatOf(fit);
      const near = paths(result, 'near-').flat(), far = paths(result, 'far-').flat();
      const left = dense(result.parts, ['left-carbon', 'left-edge-carbon'], 0.1), right = dense(result.parts, ['right-carbon', 'right-edge-carbon'], 0.1);
      const shadow = dense(result.parts, ['shadow-left-carbon', 'shadow-right-carbon'], 0.1);
      // The towers stand on the ground and rise far above the horizon, the near one left of the pair, the far one right.
      for (const tower of [near, far]) {
        expect(box(tower).y1).toBeGreaterThan(horizonY);
        expect(box(tower).y0).toBeLessThan(horizonY - 15);
      }
      expect(mean(near)).toBeLessThan(mean(left));
      expect(mean(left)).toBeLessThan(mean(right));
      expect(mean(right)).toBeLessThan(mean(far));
      // The lovers float below the horizon, over their shadow: their lowest point well above its bottom, the left one clear of it.
      for (const lover of [left, right]) {
        expect(box(lover).y0).toBeGreaterThan(horizonY);
        expect(box(shadow).y1 - box(lover).y1).toBeGreaterThan(2);
      }
      expect(anyWithin(left, shadow, 1.5)).toBe(false);
      // They reach but never touch: the hands within 2 mm, with three pen widths of paper or more between them.
      const hands = nearest(left, right);
      expect(hands.d).toBeLessThan(2);
      expect(hands.d).toBeGreaterThan(0.75);
      // The hands that do not touch cast a shadow that does: the lovers' shadow lies on the ground beneath the gap and runs
      // on well past it either side.
      expect(shadow.filter(p => Math.abs(p.x - hands.at.x) < 0.5).length).toBeGreaterThan(20);
      expect(hands.at.x - box(shadow).x0).toBeGreaterThan(4);
      expect(box(shadow).x1 - hands.at.x).toBeGreaterThan(4);
      // The strands: one line each (too narrow for ribbons), rising from the towers to the top of the window, winding round
      // each other above the pair: they come together at the meeting point and cross again further up.
      expect(result.parts.filter(part => part.id.startsWith('helix-')).map(part => part.id).sort()).toEqual(['helix-acid', 'helix-vermilion']);
      const a = dense(result.parts, ['helix-acid'], 0.1), b = dense(result.parts, ['helix-vermilion'], 0.1);
      expect(box([...a, ...b]).y0).toBeLessThan(card.y0 + 1);
      expect(box([...a, ...b]).y1).toBeLessThan(Math.min(box(left).y0, box(right).y0));
      const touching = a.filter(p => b.some(q => Math.hypot(p.x - q.x, p.y - q.y) < 0.4)).sort((p, q) => p.y - q.y);
      const crossings = touching.filter((p, i) => !i || Math.hypot(p.x - touching[i - 1].x, p.y - touching[i - 1].y) >= 1).length;
      expect(crossings).toBeGreaterThanOrEqual(3);
    }
  }, 240_000);

  it('scales its halos and trims its towers: the sky clears the towers and the towers clear the lovers by their scaled halos, floored, and the courses keep single outlines', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const towers = dense(result.parts, ['near-carbon', 'far-carbon'], 0.1), lovers = dense(result.parts, ['left-carbon', 'left-edge-carbon', 'right-carbon', 'right-edge-carbon'], 0.1);
      // The sky's knockout round the towers: the print's 1.1 mm scaled (0.31 mm) is under the floor, so 0.5 mm, give or take a
      // cell of its mask (0.50 to 0.55 mm); left at the print's size the nearest rule stops 0.86 mm short.
      const ends = paths(result, 'sky-').flatMap(path => [path[0], path.at(-1)!]);
      const towerGap = Math.min(...ends.map(p => nearest([p], towers).d));
      expect(towerGap).toBeGreaterThan(0.4);
      expect(towerGap).toBeLessThan(0.7);
      // Each lover's clear pocket: the print's 3 mm scaled (0.75 to 0.83 mm), so the towers' lines stop short of the lovers by
      // more than the floor and well under the print's pocket (3.3 mm left at the print's size).
      const pocket = nearest(lovers, towers).d;
      expect(pocket).toBeGreaterThan(0.5);
      expect(pocket).toBeLessThan(1.5);
      // The towers' slabs are trimmed (kit/slabs.ts' `SlabTrim`): untrimmed, their back edges and slivers doubled the
      // outlines and the far tower ran half again as crowded as the print (48-54% against 38%).
      const shares = new Map(probe(result).parts.map(part => [part.id, part.share]));
      expect(shares.get('far-carbon')).toBeLessThan(0.43);
      expect(shares.get('near-carbon')).toBeLessThan(0.72);
    }
  }, 240_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is', async () => {
    const [master, ...small] = await Promise.all([print(), ...fits.map(render)]);
    const reference = probe(master);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, reference), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(reference.share);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its sky ruling,
    // shadow hatch, the towers' hatch and the lovers' bands shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...master, parts: master.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), reference).map(p => p.id);
    for (const id of ['sky-carbon', 'shadow-carbon', 'far-carbon', 'left-carbon', 'right-carbon']) expect(denser).toContain(id);
  }, 240_000);

  it('draws in its preferred fit, height, where the render names none', async () => {
    const [plain, height] = await Promise.all([renderSketch({ entry, seed: 2, finishing: { page }, timeoutMs: 120_000 }), render('height')]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.parts).toEqual(height.parts);
  }, 240_000);
});
