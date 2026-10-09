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

const entry = resolve('sketches/breach-tarot/xi-justice/sketch.ts');

type Pt = { x: number; y: number };
const paths = (parts: { id: string; paths: Pt[][] }[], id: string) => parts.find(p => p.id === id)?.paths ?? [];
/** Points along every path, a half millimetre apart, so a centroid weighs ink and not vertices. */
const sampled = (list: Pt[][]): Pt[] => list.flatMap(path => path.slice(1).flatMap((p, i) => {
  const a = path[i], k = Math.max(1, Math.ceil(Math.hypot(p.x - a.x, p.y - a.y) / 0.5));
  return Array.from({ length: k }, (_, j) => ({ x: a.x + (p.x - a.x) * (j + 0.5) / k, y: a.y + (p.y - a.y) * (j + 0.5) / k }));
}));
const centroid = (pts: Pt[]): Pt => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });

describe('Breach Tarot: XI Justice', () => {
  it('replays, stays inside the card, and draws the sky, the shadow, the column, the beam, the pans, the heap, the helix, the phrase, the horizon and the frame', async () => {
    const first = await renderSketch({ entry, seed: 3 });
    const replay = await renderSketch({ entry, seed: 3 });
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
    for (const id of ['sky-carbon', 'shadow-beam-carbon', 'shadow-carbon', 'column-carbon', 'beam-carbon', 'pans-carbon', 'pile-carbon', 'horizon-carbon', 'slogan-lettering', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('is level but its shadow is not: the beam is horizontal on the sheet, and its shadow tips 8 to 15 degrees with the heap\'s end down', async () => {
    const result = await renderSketch({ entry, seed: 3 });
    // The beam: its top edge, the highest ink at each stretch along it, runs level on the sheet.
    const beam = paths(result.parts, 'beam-carbon').flat();
    const top = new Map<number, number>();
    for (const p of beam) { const k = Math.floor(p.x / 10); top.set(k, Math.min(top.get(k) ?? Infinity, p.y)); }
    const ymin = Math.min(...top.values());
    const edge = [...top.entries()].filter(([, y]) => y < ymin + 3).map(([k, y]) => ({ x: k * 10 + 5, y }));
    expect(edge.length).toBeGreaterThan(12);
    const mx = edge.reduce((s, p) => s + p.x, 0) / edge.length, my = edge.reduce((s, p) => s + p.y, 0) / edge.length;
    const slope = edge.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / edge.reduce((s, p) => s + (p.x - mx) ** 2, 0);
    expect(Math.abs(Math.atan(slope) * 180 / Math.PI)).toBeLessThan(0.5);
    // The heap's side: where the heap's ink sits against the column's.
    const heapSide = Math.sign(centroid(sampled(paths(result.parts, 'pile-carbon'))).x - centroid(sampled(paths(result.parts, 'column-carbon'))).x);
    expect(heapSide).not.toBe(0);
    // The beam's shadow: the middle of each end of it, on the sheet.
    const shadow = sampled(paths(result.parts, 'shadow-beam-carbon'));
    expect(shadow.length).toBeGreaterThan(200);
    const x0 = Math.min(...shadow.map(p => p.x)), x1 = Math.max(...shadow.map(p => p.x));
    const left = centroid(shadow.filter(p => p.x < x0 + 0.15 * (x1 - x0))), right = centroid(shadow.filter(p => p.x > x1 - 0.15 * (x1 - x0)));
    const heapEnd = heapSide < 0 ? left : right, otherEnd = heapSide < 0 ? right : left;
    const tilt = Math.atan2(heapEnd.y - otherEnd.y, Math.abs(right.x - left.x)) * 180 / Math.PI;
    expect(tilt).toBeGreaterThan(8);
    expect(tilt).toBeLessThan(15);
  }, 60_000);
});

describe('Breach Tarot: XI Justice at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none. One render per fit, and one print, shared.
  const renders = new Map<Fit, Promise<RenderResult>>();
  const render = (fit: Fit) => renderSketch({ entry, seed: 3, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const rendered = (fit: Fit) => { if (!renders.has(fit)) renders.set(fit, render(fit)); return renders.get(fit)!; };
  let printed: Promise<RenderResult> | undefined;
  const print = () => (printed ??= renderSketch({ entry, seed: 3, timeoutMs: 120_000 }));
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const all = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths);
  const points = (result: RenderResult, prefix: string) => all(result, prefix).flat();
  const length = (path: Pt[]) => path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0);
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  /** Which side of the column the heap stands: where the heap's ink sits against the column's. */
  const heapSide = (result: RenderResult) => Math.sign(centroid(sampled(paths(result.parts, 'pile-carbon'))).x - centroid(sampled(paths(result.parts, 'column-carbon'))).x);
  /** The closest any point of `a` comes to any of `b`, both sampled every 0.05 mm, through a millimetre grid. */
  const nearest = (a: Pt[][], b: Pt[][]) => {
    const along = (list: Pt[][]) => list.flatMap(path => path.flatMap((q, i) => {
      if (!i) return [q];
      const p = path[i - 1], k = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 0.05);
      return Array.from({ length: k }, (_, j) => ({ x: p.x + (q.x - p.x) * (j + 1) / k, y: p.y + (q.y - p.y) * (j + 1) / k }));
    }));
    const grid = new Map<string, Pt[]>();
    for (const q of along(b)) { const key = `${Math.floor(q.x)},${Math.floor(q.y)}`; if (!grid.has(key)) grid.set(key, []); grid.get(key)!.push(q); }
    let best = Infinity;
    for (const p of along(a)) for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
      for (const q of grid.get(`${Math.floor(p.x) + dx},${Math.floor(p.y) + dy}`) ?? []) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    }
    return best;
  };
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: the layout, every slab of the balance, the cords\' routes and the shadow on the ground', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-justice-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { justiceWorld } from ${JSON.stringify(resolve('sketches/breach-tarot/xi-justice/geometry.ts'))};
      export default { name: 'justice-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [
          { type: 'select', id: 'side', label: 'Short arm', default: 'seed', options: ['seed', 'left', 'right'] },
          { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1 },
        ],
        draw(ctx) {
          const { L, bal, cords, shadow } = justiceWorld(ctx), h = createHash('sha256');
          h.update([L.D, L.U, L.f, L.mirror, L.pivotX, L.shortX, L.longX, L.beamL, L.beamR, L.beamY, L.beamH, L.panTop, L.panThick, bal.chainBack, bal.chainFront, ';'].join(','));
          for (const p of bal.pieces) { const s = p.slab; h.update([p.group, p.light, s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.role, s.tone, ';'].join(',')); }
          for (const r of cords.routes) { h.update(String(r.chainFrom)); for (const v of r.pts) h.update([v.x, v.y, v.z, ';'].join(',')); }
          h.update(String(cords.rise));
          for (const poly of [...shadow.polygons, ...shadow.frame]) { for (const v of poly) h.update([v.x, v.z, ';'].join(',')); h.update('|'); }
          const d = h.digest();
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + bal.pieces.length / 10, y: 20 + bal.pile.length / 10 }, { x: 20 + shadow.polygons.length / 10, y: 20 }]] }];
        } };`);
    // The default (the heap on the left at this seed), mirrored, and a narrower lens (a fit that widens the card's lens must
    // not move the world).
    for (const params of [{}, { side: 'right' }, { fov: 40 }] as Record<string, string | number>[]) {
      const [tabloid, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 3, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 3, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      const counts = tabloid.parts.find(part => part.id === 'counts')!.paths[0];
      expect(counts[1].y).toBeGreaterThan(20 + 8 / 10);
      for (const result of small) for (const id of ['digest', 'counts']) {
        expect(result.parts.find(part => part.id === id)!.paths, `${JSON.stringify(params)} ${id}`).toEqual(tabloid.parts.find(part => part.id === id)!.paths);
      }
    }
  }, 120_000);

  it('replays in both fits, draws the scene in the art window, no words in the art, and the phrase in the band', async () => {
    for (const fit of fits) {
      const [first, replay] = await Promise.all([rendered(fit), render(fit)]);
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
      // Paths wholly inside the art window, per part of the scene.
      const inWindow = (prefix: string) => all(first, prefix)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 25, 'shadow-beam-': 8, 'shadow-carbon': 8, 'column-': 60, 'beam-': 60, 'pans-': 8, 'pile-': 200, 'helix-': 80, 'horizon-': 1 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), `${fit} ${prefix}`).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as Justice: the beam level, its shadow tipped 8 to 15 degrees with the heap\'s end down, the heap hung above the horizon and heavy and dark against the one block', async () => {
    const tabloid = await print();
    const side = heapSide(tabloid);
    // The heap's ink per square millimetre of its box, and against the one block's ink.
    const heap = (result: RenderResult) => {
      const columnX = centroid(sampled(paths(result.parts, 'column-carbon'))).x;
      const pile = paths(result.parts, 'pile-carbon');
      const mine = pile.filter(path => path.every(p => Math.sign(p.x - columnX) === side)), block = pile.filter(path => path.every(p => Math.sign(p.x - columnX) === -side));
      const ps = mine.flat(), ink = mine.reduce((sum, path) => sum + length(path), 0);
      const area = (Math.max(...ps.map(p => p.x)) - Math.min(...ps.map(p => p.x))) * (Math.max(...ps.map(p => p.y)) - Math.min(...ps.map(p => p.y)));
      return { tone: ink / area, against: ink / block.reduce((sum, path) => sum + length(path), 0) };
    };
    for (const fit of fits) {
      const result = await rendered(fit);
      const { horizonY, s } = formatOf(fit);
      // The beam: its top edge, the highest ink at each stretch along it, runs level on the sheet.
      const top = new Map<number, number>();
      for (const p of points(result, 'beam-carbon')) { const k = Math.floor(p.x / (10 * s)); top.set(k, Math.min(top.get(k) ?? Infinity, p.y)); }
      const ymin = Math.min(...top.values());
      const edge = [...top.entries()].filter(([, y]) => y < ymin + 3 * s).map(([k, y]) => ({ x: (k + 0.5) * 10 * s, y }));
      expect(edge.length, fit).toBeGreaterThan(12);
      const mx = edge.reduce((sum, p) => sum + p.x, 0) / edge.length, my = edge.reduce((sum, p) => sum + p.y, 0) / edge.length;
      const slope = edge.reduce((sum, p) => sum + (p.x - mx) * (p.y - my), 0) / edge.reduce((sum, p) => sum + (p.x - mx) ** 2, 0);
      expect(Math.abs(Math.atan(slope) * 180 / Math.PI), fit).toBeLessThan(0.5);
      // The heap stands on the print's side of the column.
      expect(heapSide(result), fit).toBe(side);
      // Its shadow tips on the ground, the heap's end down, as on the print.
      const shadow = sampled(paths(result.parts, 'shadow-beam-carbon'));
      expect(shadow.length, fit).toBeGreaterThan(150);
      const x0 = Math.min(...shadow.map(p => p.x)), x1 = Math.max(...shadow.map(p => p.x));
      const left = centroid(shadow.filter(p => p.x < x0 + 0.15 * (x1 - x0))), right = centroid(shadow.filter(p => p.x > x1 - 0.15 * (x1 - x0)));
      const heapEnd = side < 0 ? left : right, otherEnd = side < 0 ? right : left;
      const tilt = Math.atan2(heapEnd.y - otherEnd.y, Math.abs(right.x - left.x)) * 180 / Math.PI;
      expect(tilt, fit).toBeGreaterThan(8);
      expect(tilt, fit).toBeLessThan(15);
      // The balance hangs above the horizon, the column stands across it, the shadow lies on the ground below it.
      for (const prefix of ['beam-', 'pans-', 'pile-']) expect(Math.max(...points(result, prefix).map(p => p.y)), `${fit} ${prefix}`).toBeLessThan(horizonY);
      const column = points(result, 'column-').map(p => p.y);
      expect(Math.min(...column)).toBeLessThan(horizonY);
      expect(Math.max(...column)).toBeGreaterThan(horizonY);
      expect(Math.min(...points(result, 'shadow').map(p => p.y)), fit).toBeGreaterThan(horizonY);
      // The heap heavy and dark: near the print's tone (its hatch keeps its pitch on paper), and many times the block's ink.
      const small = heap(result), big = heap(tabloid);
      expect(small.tone / big.tone, fit).toBeGreaterThan(0.6);
      expect(small.against, fit).toBeGreaterThan(6);
    }
  }, 120_000);

  it('hangs each pan\'s chain as one line where its ribbon is narrower than the smallest feature', async () => {
    for (const fit of fits) {
      const result = await rendered(fit);
      const { s } = formatOf(fit);
      const side = heapSide(result);
      const columnX = centroid(sampled(paths(result.parts, 'column-carbon'))).x;
      const beamBottom = Math.max(...points(result, 'beam-').map(p => p.y));
      // Halfway between the beam and what each chain carries, the helix crosses once per chain: one line, which runs
      // most of the way between them.
      for (const arm of [side, -side]) {
        const load = Math.min(...paths(result.parts, 'pile-carbon').filter(path => path.every(p => Math.sign(p.x - columnX) === arm)).flat().map(p => p.y));
        const half = (beamBottom + load) / 2;
        const crossing = all(result, 'helix-').filter(path => path.some((q, i) => i > 0 && (path[i - 1].y - half) * (q.y - half) <= 0
          && Math.sign(q.x - columnX) === arm && Math.abs(q.x - columnX) > 20 * s));
        expect(crossing.length, `${fit} arm ${arm}`).toBe(1);
        const ys = crossing[0].map(p => p.y);
        expect(Math.min(Math.max(...ys), load) - Math.max(Math.min(...ys), beamBottom), `${fit} arm ${arm}`).toBeGreaterThan(0.6 * (load - beamBottom));
      }
    }
  }, 120_000);

  it('keeps its knockouts as halos scaled with the card: the sky stops short of what stands by the knockout, and of the cord by its wider glow', async () => {
    for (const fit of fits) {
      const result = await rendered(fit);
      const { s } = formatOf(fit);
      const sky = all(result, 'sky-'), helix = all(result, 'helix-');
      const solids = ['column-', 'beam-', 'pans-', 'pile-'].flatMap(prefix => all(result, prefix));
      // The knockout round what stands is 1.1 mm on the print, scaled with the card and never under 0.5 mm; the cord's glow
      // is 3 mm, scaled. Each is measured on a mask, so a clean ruling stands a little inside it: no nearer than about
      // 0.3 mm to what stands, nor further than the scaled knockout and a tenth.
      const toSolids = nearest(sky, solids);
      expect(toSolids, `${fit} sky to what stands`).toBeGreaterThan(0.3);
      expect(toSolids, `${fit} sky to what stands`).toBeLessThan(Math.max(0.5, 1.1 * s) + 0.1);
      // Round the cord the glow stays wider than a solid's knockout (on the print's 3 cells to the millimetre, both rounded to
      // the same two cells, 0.67 mm), and no wider than the scaled glow and a tenth (left at the print's 3 mm, it was 2.8).
      const toCord = nearest(sky, helix);
      expect(toCord, `${fit} sky to the cord`).toBeGreaterThan(0.69);
      expect(toCord, `${fit} sky to the cord`).toBeLessThan(Math.max(0.5, 3 * s) + 0.1);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, its column trimmed, which the print shrunk to the card is', async () => {
    const tabloid = await print();
    const master = probe(tabloid);
    for (const fit of fits) {
      const report = probe(await rendered(fit));
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
      // The slabs are trimmed on a small card (kit/slabs.ts' `SlabTrim`): untrimmed, the plinth's sliver tops and the courses'
      // back edges doubled the column's outline, and a third of it ran too close (0.31-0.35); trimmed, under a tenth.
      const column = report.parts.find(part => part.id === 'column-carbon')!;
      expect(column.share, `${fit} ${describeDensity(report)}`).toBeLessThan(0.15);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its sky ruling, its
    // shadow's hatch and the heap's hatch shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...tabloid, parts: tabloid.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['sky-carbon', 'shadow-beam-carbon', 'shadow-carbon', 'pile-carbon']) expect(denser).toContain(id);
  }, 120_000);

  it('draws in its preferred fit, width, where the render names none: the whole balance in the window, which height crops', async () => {
    const [plain, width, height] = await Promise.all([renderSketch({ entry, seed: 3, finishing: { page }, timeoutMs: 120_000 }), rendered('width'), rendered('height')]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.parts).toEqual(width.parts);
    // In its width the pans and their loads stand clear of the window's sides; in height the long arm's pan runs to the edge.
    const edge = (fit: Fit, result: RenderResult) => {
      const { card } = formatOf(fit);
      return Math.min(...['pans-', 'pile-'].flatMap(prefix => points(result, prefix)).map(p => Math.min(p.x - card.x0, card.x1 - p.x)));
    };
    expect(edge('width', width)).toBeGreaterThan(1);
    expect(edge('height', height)).toBeLessThan(0.05);
  }, 120_000);
});
