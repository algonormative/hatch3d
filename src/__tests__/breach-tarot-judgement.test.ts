import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { SHEETS_FLOOR } from '../../sketches/breach-tarot/xx-judgement/geometry.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { TABLOID_FORMAT, formatFor, type Fit } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { Point, RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/xx-judgement/sketch.ts');

describe('Breach Tarot: XX Judgement', () => {
  it('replays, stays inside the card, and draws the sky, the paving, the trays, the lids, the fragments, the helix, the phrase, the horizon and the frame', async () => {
    const first = await renderSketch({ entry, seed: 1 });
    const replay = await renderSketch({ entry, seed: 1 });
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
    for (const id of ['sky-carbon', 'ground-carbon', 'tray-carbon', 'lid-carbon', 'fragment-carbon', 'slogan-lettering', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('flares from the corner: the horn enters across the top edge in the left third, is at least four times as wide low down as at its entry, and sounds above the field without touching it', async () => {
    const result = await renderSketch({ entry, seed: 1 });
    const points = (match: (id: string) => boolean) => result.parts.filter(p => match(p.id)).flatMap(p => p.paths.flat());
    const helix = points(id => id.startsWith('helix-'));
    const lids = points(id => id.startsWith('lid-'));

    // It comes in across the top edge of the art window, in the left third of the card.
    const entering = helix.filter(p => p.y < CARD.y0 + 2);
    expect(entering.length).toBeGreaterThan(0);
    const third = CARD.x0 + (CARD.x1 - CARD.x0) / 3;
    expect(Math.max(...entering.map(p => p.x))).toBeLessThan(third);

    // Its width across the horn: where it runs along the top, the vertical thickness of a slice just past
    // the entry; where it hangs, the horizontal spread of its lowest 12 mm (the bell's mouth).
    const entryX = Math.min(...entering.map(p => p.x));
    const slice = helix.filter(p => p.x >= entryX + 8 && p.x <= entryX + 24).map(p => p.y);
    const near = Math.max(...slice) - Math.min(...slice);
    const lowest = Math.max(...helix.map(p => p.y));
    const mouth = helix.filter(p => p.y >= lowest - 12).map(p => p.x);
    const low = Math.max(...mouth) - Math.min(...mouth);
    expect(near).toBeGreaterThan(2);
    expect(low / near).toBeGreaterThanOrEqual(4);

    // The horn's lowest mark stays well above the highest mark of the lids: it sounds over the field.
    expect(lowest).toBeLessThanOrEqual(Math.min(...lids.map(p => p.y)) - 8);
  }, 60_000);
});

describe('Breach Tarot: XX Judgement at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none.
  const render = (fit: Fit) => renderSketch({ entry, seed: 1, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const paths = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths);
  const points = (result: RenderResult, prefix: string) => paths(result, prefix).flat();
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  // A part's paths as points every 0.1 mm, and the nearest two such points of two sets come (by a 1 mm grid).
  const along = (result: RenderResult, prefix: string) => paths(result, prefix).flatMap(path => path.flatMap((b, i) => {
    if (!i) return [b];
    const a = path[i - 1], n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.1);
    return Array.from({ length: n }, (_, k) => ({ x: a.x + (b.x - a.x) * (k + 1) / n, y: a.y + (b.y - a.y) * (k + 1) / n }));
  }));
  const nearest = (a: Point[], b: Point[]) => {
    const cells = new Map<string, Point[]>();
    for (const q of b) {
      const key = `${Math.floor(q.x)},${Math.floor(q.y)}`;
      const list = cells.get(key);
      if (list) list.push(q); else cells.set(key, [q]);
    }
    let d = Infinity;
    for (const p of a) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const q of cells.get(`${Math.floor(p.x) + dx},${Math.floor(p.y) + dy}`) ?? []) d = Math.min(d, Math.hypot(p.x - q.x, p.y - q.y));
    }
    return d;
  };
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: the horn\'s course, the plain box by box with its lids, the sheets rising, and draws a share of the sheets', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-judgement-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), its counts, and the sheets the card
    // draws (each by its place in the world's order), inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { judgementCamera, judgementWorld, shownSheets } from ${JSON.stringify(resolve('sketches/breach-tarot/xx-judgement/geometry.ts'))};
      export default { name: 'judgement-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [
          { type: 'slider', id: 'enterX', label: 'Where the horn enters the top', default: 34, min: 18, max: 120, step: 1 },
          { type: 'slider', id: 'mouthX', label: 'Mouth across the sheet', default: 178, min: 120, max: 250, step: 1 },
          { type: 'slider', id: 'horizonEdge', label: 'Horizon kept open at each edge', default: 12, min: 0, max: 40, step: 1 },
          { type: 'slider', id: 'fragments', label: 'Boxes sending fragments up', default: 8, min: 0, max: 16, step: 1 },
        ],
        draw(ctx) {
          const view = judgementCamera(ctx), w = judgementWorld(ctx, view), h = createHash('sha256');
          const v3 = v => [v.x, v.y, v.z].join(',');
          const slab = s => [s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.beat, s.role, s.tone, ';'].join(',');
          for (let i = 0; i <= 40; i++) h.update(v3(w.horn.curve.getPointAt(i / 40)) + ',' + w.horn.radiusAt(i / 40) + ';');
          h.update([w.horn.mouthU, v3(w.horn.mouth.centre), v3(w.horn.mouth.axis), w.horn.mouth.radius, ';'].join(','));
          for (const v of w.vaults) { h.update([v.id, v.x, v.z, v.yaw, v.open, v.hinge, ';'].join(',')); for (const s of [...v.tray, v.lid]) h.update(slab(s)); }
          for (const s of w.bits) h.update(slab(s));
          const d = h.digest();
          w.tube.dispose();
          const shown = shownSheets(w.bits, view).map(s => w.bits.indexOf(s));
          return [
            { id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.vaults.length / 10, y: 20 + w.bits.length }]] },
            { id: 'shown', pen: 'ink', paths: [[{ x: 20, y: 20 }, ...shown.map((i, k) => ({ x: 21 + i, y: 21 + k / 2 }))]] },
          ];
        } };`);
    const a4 = { width: 210, height: 297 };
    const indices = (result: RenderResult) => result.parts.find(part => part.id === 'shown')!.paths[0].slice(1).map(p => Math.round(p.x - 21));
    // The default, and the horn's entry and mouth, the horizon's open edges and the columns of sheets moved.
    for (const params of [{}, { enterX: 60, mouthX: 200, horizonEdge: 30, fragments: 12 }] as Record<string, number>[]) {
      const [print, larger, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 1, params }),
        renderSketch({ entry: probeEntry, seed: 1, params, finishing: { page: a4 } }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 1, params, finishing: { page }, format: { fit } })),
      ]);
      const counts = print.parts.find(part => part.id === 'counts')!.paths[0][1];
      const bits = Math.round(counts.y - 20);
      expect(counts.x - 20, 'vaults').toBeGreaterThan(5);
      expect(bits, 'sheets').toBeGreaterThan(SHEETS_FLOOR);
      for (const result of [larger, ...small]) for (const id of ['digest', 'counts']) {
        expect(result.parts.find(part => part.id === id)!.paths, `${JSON.stringify(params)} ${id}`).toEqual(print.parts.find(part => part.id === id)!.paths);
      }
      // The print draws every sheet; a small card about the floor's worth, a subset of what a larger card (A4) draws.
      expect(indices(print)).toEqual(Array.from({ length: bits }, (_, i) => i));
      for (const result of small) {
        const shown = indices(result);
        expect(shown.length, JSON.stringify(params)).toBeGreaterThanOrEqual(SHEETS_FLOOR - 2);
        expect(shown.length, JSON.stringify(params)).toBeLessThanOrEqual(SHEETS_FLOOR + 2);
        for (const i of shown) expect(indices(larger)).toContain(i);
      }
      expect(indices(larger).length).toBeGreaterThan(indices(small[1]).length);
    }
  }, 120_000);

  it('replays in both fits, draws the scene in the art window, no words in the art, and the phrase in the band', async () => {
    for (const fit of fits) {
      const [first, replay] = await Promise.all([render(fit), render(fit)]);
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
      // Paths wholly inside the art window, per part of the scene: the sky, the paving, the trays, the lids, the sheets
      // rising, the horn and the horizon.
      const inWindow = (prefix: string) => paths(first, prefix)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 25, 'ground-': 8, 'tray-': 80, 'lid-': 60, 'fragment-': 20, 'helix-': 150, 'horizon-': 0 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), `${fit} ${prefix}`).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(50);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as Judgement: the horn enters at the top-left as a thin cord, flares at least four times to the print\'s bell, and sounds above the field, in the sky; the boxes below the horizon, the near lids rising across it', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 1 }), ...fits.map(render)]);
    // The bell's mouth: the horizontal spread of the horn's lowest 12 mm (scaled), its middle, and the lowest mark.
    const bell = (helix: Point[], s: number) => {
      const lowest = Math.max(...helix.map(p => p.y));
      const xs = helix.filter(p => p.y >= lowest - 12 * s).map(p => p.x);
      return { lowest, left: Math.min(...xs), right: Math.max(...xs) };
    };
    const printBell = bell(points(print, 'helix-'), 1);
    for (const [k, fit] of fits.entries()) {
      const result = small[k];
      const { card, horizonY, s } = formatOf(fit);
      const helix = points(result, 'helix-'), lids = points(result, 'lid-');
      // It comes in across the top edge of the art window, in the left third of the card (the print's 2 mm, scaled).
      const entering = helix.filter(p => p.y < card.y0 + 2 * s);
      expect(entering.length, fit).toBeGreaterThan(0);
      expect(Math.max(...entering.map(p => p.x)), fit).toBeLessThan(card.x0 + (card.x1 - card.x0) / 3);
      // Its width just past the entry (the print's 8 to 24 mm, scaled), across its course there: a small card's window
      // shows a little more sky than the print's, so in fit width the cord comes in at the corner, running steeply down,
      // where a vertical slice cuts it long. Its course is the line between the slice's halves' centres.
      const entryX = Math.min(...entering.map(p => p.x));
      const slice = helix.filter(p => p.x >= entryX + 8 * s && p.x <= entryX + 24 * s);
      const middle = entryX + 16 * s;
      const centre = (ps: Point[]) => ({ x: ps.reduce((t, p) => t + p.x, 0) / ps.length, y: ps.reduce((t, p) => t + p.y, 0) / ps.length });
      const a = centre(slice.filter(p => p.x < middle)), b = centre(slice.filter(p => p.x >= middle));
      const len = Math.hypot(b.x - a.x, b.y - a.y), nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      const across = slice.map(p => p.x * nx + p.y * ny);
      const near = Math.max(...across) - Math.min(...across);
      // At the mouth: the horizontal spread of its lowest 12 mm (scaled).
      const mouth = bell(helix, s), lowest = mouth.lowest;
      expect(near, fit).toBeGreaterThan(2 * s);
      expect((mouth.right - mouth.left) / near, fit).toBeGreaterThanOrEqual(4);
      // The bell is the print's: back in tabloid's frame (from the window's centre line and the horizon), its mouth as
      // wide, its middle and its lowest mark where the print's are, within 3 mm.
      const back = (x: number) => TABLOID_PAGE.width / 2 + (x - page.width / 2) / s;
      expect((mouth.right - mouth.left) / s / (printBell.right - printBell.left), fit).toBeCloseTo(1, 1);
      expect(Math.abs(back((mouth.left + mouth.right) / 2) - (printBell.left + printBell.right) / 2), fit).toBeLessThan(3);
      expect(Math.abs(TABLOID_FORMAT.horizonY + (lowest - horizonY) / s - printBell.lowest), fit).toBeLessThan(3);
      // The horn's lowest mark stays well above the highest mark of the lids, and it hangs in the sky.
      expect(lowest, fit).toBeLessThanOrEqual(Math.min(...lids.map(p => p.y)) - 8 * s);
      expect(lowest, fit).toBeLessThan(horizonY);
      // The sky above the horizon; the trays and the paving below it; the nearest lids, wide open, rise across it.
      expect(Math.max(...points(result, 'sky-').map(p => p.y)), fit).toBeLessThan(horizonY);
      expect(Math.min(...points(result, 'tray-').map(p => p.y)), fit).toBeGreaterThan(horizonY);
      expect(Math.min(...points(result, 'ground-').map(p => p.y)), fit).toBeGreaterThan(horizonY);
      expect(lids.filter(p => p.y < horizonY - 5 * s).length, fit).toBeGreaterThan(10);
    }
  }, 120_000);

  it('keeps the paper round what stands in the sky at the card\'s scale: no sky ruling nearer the horn or the boxes than the halo\'s floor, none further than the halo scaled', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { s } = formatOf(fit);
      const sky = along(result, 'sky-');
      // The sky stops short of the horn, the lids and the sheets by the knockout (1.4 mm on the print, scaled with the card,
      // never under 0.5 mm). The halo is measured on a raster, so a clean ruling stands a little under the floor: none
      // nearer than 0.35 mm, nor, where it meets them, further than the scaled halo and a little more.
      const halo = Math.max(0.5, 1.4 * s);
      for (const prefix of ['helix-', 'lid-', 'fragment-']) {
        const gap = nearest(sky, along(result, prefix));
        expect(gap, `${fit} sky to ${prefix}`).toBeGreaterThan(0.35);
        expect(gap, `${fit} sky to ${prefix}`).toBeLessThan(halo + 0.2);
      }
    }
  }, 120_000);

  it('keeps the sheets and the far rows clean on a small card: the outlines trimmed, the plain\'s lines thinned on the paper', async () => {
    for (const fit of fits) {
      const report = probe(await render(fit));
      const share = (id: string) => report.parts.find(part => part.id === id)?.share ?? 0;
      // Trimmed (kit/slabs.ts' `SlabTrim`), a rising sheet is its outline: untrimmed, its back edges and its edge, a few
      // tenths of a millimetre thick on the card, crowd 41% of the sheets' lines.
      expect(share('fragment-carbon'), `${fit} sheets`).toBeLessThan(0.15);
      // Thinned (`thinRanked`), the far rows' lids keep clear of the nearer ones: unthinned, 10 to 12% of the lids' lines
      // crowd, against the print's 2.4%.
      expect(share('lid-carbon'), `${fit} lids`).toBeLessThan(0.05);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 1 }), ...fits.map(render)]);
    const master = probe(print);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      // Overall, within the probe's slack of the print: the horn, whose rings crowd where they pack toward the mouth (a
      // third of its edges, against the print's 38%), is a larger share of the small card's drawing than of the print's.
      expect(report.share).toBeLessThan(master.share + 0.05);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its boxes' hatch
    // and outlines, the sheets and the horn's laminations shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...print, parts: print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['tray-carbon', 'lid-carbon', 'fragment-carbon', 'helix-violet']) expect(denser).toContain(id);
  }, 120_000);

  it('draws in its preferred fit, width, where the render names none', async () => {
    const [plain, width] = await Promise.all([renderSketch({ entry, seed: 1, finishing: { page }, timeoutMs: 120_000 }), render('width')]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.parts).toEqual(width.parts);
  }, 120_000);
});
