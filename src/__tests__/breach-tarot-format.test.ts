import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { TABLOID_PAGE, TALL_ART } from '../../sketches/phase-garden/poster.ts';
import { CARD as CARD_OF_CARDS, HORIZON_Y as HORIZON_OF_CARDS, cardFrame } from '../../sketches/breach-tarot/card.ts';
import { targetPage } from '../sketch/render-target.ts';
import {
  AREA, CARD, FORMAT, FRAME, HORIZON_Y, MIN_FEATURE, PAGE, PITCH_SCALE, SHEET, TABLOID_CARD, TABLOID_FORMAT, TABLOID_HORIZON_Y,
  assertFormatPage, depthRaster, evenlyKept, fitFov, formatFor, halo, layoutLength, layoutX, layoutY, rasterFor, scaledCount, tolerance,
} from '../../sketches/kit/format.ts';

let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

describe('Breach Tarot format', () => {
  it('is the tabloid preset without a render target, and that preset is today’s constants', () => {
    expect(FORMAT).toBe(TABLOID_FORMAT);
    expect(PAGE).toBe(TABLOID_PAGE);
    expect(PAGE).toEqual({ width: 279.4, height: 431.8, margin: 18, paper: '#f4f0e6' });
    // The card rect and horizon as card.ts defined them before the format module existed.
    const before = {
      x0: TALL_ART.x, x1: TALL_ART.x + TALL_ART.width,
      top: TALL_ART.y, bottom: TALL_ART.y + TALL_ART.height,
      y0: TALL_ART.y + 24, y1: TALL_ART.y + TALL_ART.height - 24,
    };
    for (const key of Object.keys(before) as (keyof typeof before)[]) expect(Object.is(CARD[key], before[key])).toBe(true);
    expect(Object.keys(CARD)).toEqual(Object.keys(before));
    expect(Object.is(HORIZON_Y, before.y0 + 0.6 * (before.y1 - before.y0))).toBe(true);
    expect(CARD_OF_CARDS).toBe(CARD);
    expect(HORIZON_OF_CARDS).toBe(HORIZON_Y);
    expect(FRAME).toEqual({ rule: 1.2, numeral: { height: 8, tracking: 2.2 }, name: { height: 6.5, tracking: 3.2 }, phraseHeight: 2.2, lead: 1.1 });
    expect(PITCH_SCALE).toBe(1);
    expect(SHEET).toEqual({ x: 1, y: 1 });
    expect(FORMAT.phrase).toBe('art');
  });

  it('leaves every tabloid measurement exactly as authored', () => {
    for (const [w, h] of [[559, 864], [1118, 1728]]) {
      expect(depthRaster(w, h)).toEqual({ W: w, H: h, MM_X: TABLOID_PAGE.width / w, MM_Y: TABLOID_PAGE.height / h });
    }
    for (const v of [0, 0.1, 0.4, 18, 42.37, 139.7, 250.68, 261.4, 389.8, 1e-9]) {
      expect(layoutX(v)).toBe(v);
      expect(layoutY(v)).toBe(v);
      expect(layoutLength(v)).toBe(v);
      expect(halo(v)).toBe(v);
      expect(tolerance(v)).toBe(v);
    }
    expect(fitFov(54)).toBe(54);
    expect(TABLOID_CARD).toBe(CARD);
    expect(TABLOID_HORIZON_Y).toBe(HORIZON_Y);
    expect(AREA).toBe(1);
    // The print keeps every feature it has.
    expect(MIN_FEATURE).toBe(0);
    expect(TABLOID_FORMAT.minFeature).toBe(0);
    for (const v of [0, 7, 80, 112.5]) expect(scaledCount(v, 16)).toBe(v);
    expect(scaledCount(80, 16, 'length')).toBe(80);
    // The phrase stays in the art at tabloid: the frame ignores one passed to it.
    expect(cardFrame('0', 'THE FOOL', { phrase: { text: 'nothing here has been decided yet' } })).toEqual(cardFrame('0', 'THE FOOL'));
    expect(() => assertFormatPage(undefined)).not.toThrow();
    expect(() => assertFormatPage({ width: 279.4, height: 431.8 })).not.toThrow();
    expect(() => assertFormatPage({ width: 70, height: 120 })).toThrow(/70 × 120/);
  });

  it('a tabloid-sized page, whatever its margin or paper, is the preset itself', () => {
    expect(formatFor({ ...TABLOID_PAGE, paper: '#17181a' })).toBe(TABLOID_FORMAT);
    expect(formatFor({ width: 279.4, height: 431.8 }, { fit: 'width' })).toBe(TABLOID_FORMAT);
    const banded = formatFor(TABLOID_PAGE, { phrase: 'band' });
    expect(banded).not.toBe(TABLOID_FORMAT);
    expect(banded).toMatchObject({ tabloid: true, card: TABLOID_FORMAT.card, phrase: 'band' });
  });

  it('lays a 70 x 120 mm card out in tabloid proportions under one scale, its frame set for its pens', () => {
    const page = { width: 70, height: 120, margin: 4.51, paper: '#f4f0e6' };
    const f = formatFor(page);
    const s = 120 / 431.8, paper = 70 / 279.4;
    expect(f).toMatchObject({ name: '70x120', tabloid: false, fit: 'height', phrase: 'band', minSpacing: 0.5 });
    expect(f.s).toBeCloseTo(s, 12);
    expect(f.pitchScale).toBeCloseTo(1 / s, 12);
    expect(f.card.x0).toBe(4.51);
    // Without a margin the card's edge is tabloid's 18 mm scaled by the smaller ratio.
    expect(formatFor({ width: 70, height: 120 }).card.x0).toBeCloseTo(18 * 70 / 279.4, 9);
    expect(f.card.x1 - f.card.x0).toBeCloseTo(61, 0);
    expect(f.horizonY).toBeCloseTo(f.card.y0 + 0.6 * (f.card.y1 - f.card.y0), 12);
    // The name is never set under eight widths of its 0.25 mm pen (tabloid's 6.5 mm scaled would be 1.6), and the
    // numeral is the larger, in tabloid's proportion.
    expect(f.frame.name.height).toBe(2);
    expect(f.frame.numeral.height).toBeCloseTo(2 * 8 / 6.5, 12);
    expect(f.frame.phraseHeight).toBe(1.6);
    expect(f.frame.lead).toBeCloseTo(0.96, 12);
    // Each band is as deep as its lettering needs, with three quarters of its cap height clear above and below
    // (more than tabloid's 24 mm scaled, 6 mm): the numeral's, and the name's with the phrase under it to its
    // descenders, so the bottom band is the deeper. The art window gives up the difference.
    expect(f.card.y0 - f.card.top).toBeCloseTo(0.75 + 2.5 * 2 * 8 / 6.5, 9);
    expect(f.card.bottom - f.card.y1).toBeCloseTo(0.75 + 2 + 0.96 + 1.6 * 11 / 8 + 2 * 0.75 * 2, 9);
    expect(f.card.y1 - f.card.y0).toBeCloseTo(95.2, 1);
    // Without the phrase in the band, the name alone needs less than tabloid's band, scaled with the paper.
    const none = formatFor(page, { phrase: 'none' });
    expect(none.card.bottom - none.card.y1).toBeCloseTo(24 * paper, 9);
    expect(none.card.y0).toBe(f.card.y0);
    // Tracking is in grid units, which scale with the lettering already; the band's rules print as two lines.
    expect(f.frame.numeral.tracking).toBe(2.2);
    expect(f.frame.name.tracking).toBe(3.2);
    expect(f.frame.rule).toBe(0.75);
    expect(f.minFeature).toBe(1);
    // The frame is the card's, whatever the fit: every card of the deck has the same bands and horizon.
    const width = formatFor(page, { fit: 'width' });
    expect(width.s).toBeCloseTo(paper, 12);
    expect(width.card).toEqual(f.card);
    expect(width.horizonY).toBe(f.horizonY);
    expect(width.frame).toEqual(f.frame);
    // A finer pen sets the name smaller: eight widths of 0.1 mm is under tabloid's 6.5 mm scaled with the paper.
    const wide = formatFor(page, { fit: 'width', pen: 0.1 });
    expect(wide.frame.name.height).toBeCloseTo(6.5 * paper, 12);
    expect(wide.minSpacing).toBeCloseTo(0.2, 12);
    expect(wide.pens.find(pen => pen.id === 'carbon')!.width).toBe(0.1);
    expect(() => formatFor(page, { fit: 'diagonal' })).toThrow(/fit/);
    expect(() => formatFor(page, { colour: 'red' })).toThrow(/Unknown format option/);
  });

  it('keeps an even spread of a seeded set, and a smaller share keeps a subset of a larger one', () => {
    const kept = (keep: number) => Array.from({ length: 200 }, (_, i) => i).filter(i => evenlyKept(i, keep));
    expect(kept(1)).toHaveLength(200);
    expect(kept(1.5)).toHaveLength(200);
    for (const [small, large] of [[0.1, 0.3], [0.3, 0.31], [0.05, 0.9]]) {
      const a = kept(small), b = new Set(kept(large));
      expect(Math.abs(a.length - 200 * small)).toBeLessThanOrEqual(2);
      for (const i of a) expect(b.has(i)).toBe(true);
    }
    // Even: every run of 20 in the set keeps at least one when a tenth is kept.
    const tenth = new Set(kept(0.1));
    for (let start = 0; start < 200; start += 20) expect(Array.from({ length: 20 }, (_, k) => start + k).some(i => tenth.has(i)), `from ${start}`).toBe(true);
  });

  it('puts the card’s edge on an explicit page margin, and says so when the card cannot fit', () => {
    const f = formatFor({ width: 70, height: 120, margin: 10 });
    expect(f.card).toMatchObject({ x0: 10, x1: 60, top: 10, bottom: 110 });
    // The bands are as deep whatever the margin.
    const free = formatFor({ width: 70, height: 120 }).card;
    expect(f.card.y0 - f.card.top).toBeCloseTo(free.y0 - free.top, 12);
    expect(f.card.bottom - f.card.y1).toBeCloseTo(free.bottom - free.y1, 12);
    // Tabloid with another margin is laid out from that margin, not the preset.
    const wider = formatFor({ ...TABLOID_PAGE, margin: 25 });
    expect(wider).not.toBe(TABLOID_FORMAT);
    expect(wider.card).toMatchObject({ x0: 25, x1: 279.4 - 25, top: 25, bottom: 431.8 - 25 });
    expect(formatFor({ ...TABLOID_PAGE, margin: 18 })).toBe(TABLOID_FORMAT);
    expect(() => formatFor({ width: 70, height: 120, margin: 35 })).toThrow(/70 × 120 mm page with a 35 mm margin leaves no room/);
  });

  it('keeps every depth raster within the 4 Mpx budget, tabloid unchanged', () => {
    const budget = 4_194_304;
    expect(rasterFor(TABLOID_FORMAT, 559, 864, 2)).toEqual({ W: 559, H: 864, MM_X: 279.4 / 559, MM_Y: 431.8 / 864 });
    const card = rasterFor(formatFor({ width: 70, height: 120 }), 1118, 1728);
    expect(card.MM_Y).toBeLessThanOrEqual(0.25);
    // The camera's aspect is the raster's: on a 70 x 120 card it is the page's exactly.
    expect(card.W * 120).toBe(card.H * 70);
    for (const page of [{ width: 304.8, height: 457.2 }, { width: 609.6, height: 914.4 }]) {
      const f = formatFor(page);
      for (const [w, h, o] of [[559, 864, 2], [1118, 1728, 1]]) {
        const r = rasterFor(f, w, h, o);
        expect(r.W * o * r.H * o).toBeLessThanOrEqual(budget);
        expect(r.W / r.H).toBeCloseTo(page.width / page.height, 2);
      }
    }
  });

  const star = resolve(import.meta.dirname, '../../sketches/breach-tarot/xvii-star/sketch.ts');

  it('a card printed at tabloid through the tarot stack’s finishing keeps its print identity', async () => {
    // The request finalize sends for the tarot stack (phase-garden palette); the identity is the print-queue entry's.
    const inks = ['#22282c', '#3c49aa', '#d04b3c', '#a5a938', '#776090'];
    const finishing = {
      border: { style: 'double' as const, pen: 'carbon', inset: 12, contentGap: 6 },
      page: { width: 279.4, height: 431.8, margin: 18, paper: '#f4f0e6' },
      pens: { ...Object.fromEntries(inks.map((color, i) => [['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'][i], { color }])), lettering: { color: inks[0] } },
    };
    const result = await renderSketch({ entry: star, seed: 2, finishing, timeoutMs: 120_000 });
    expect(result.identity).toBe('a39a6030f765cc28d4fc32092a862bd2b46ebea840bac97212aa8f1885649564');
  });

  it('renders a card on a 70 x 120 mm page, its frame on the format’s card rect', async () => {
    const result = await renderSketch({ entry: star, seed: 2, finishing: { page: { width: 70, height: 120 } }, timeoutMs: 120_000 });
    const page = targetPage(TABLOID_PAGE, { width: 70, height: 120 });
    expect(result.metadata.page).toEqual(page);
    expect(result.metadata.page).toMatchObject({ width: 70, height: 120, margin: 4.51 });
    const card = formatFor(page).card;
    const frame = result.parts.find(part => part.id === 'card-frame')!;
    const q = (n: number) => Math.round(n * 1000) / 1000;
    expect(frame.paths[0]).toEqual([{ x: q(card.x0), y: q(card.y0) }, { x: q(card.x1), y: q(card.y0) }]);
    // The scene lands in the window: the star, the falling pieces and the helix all survive the window's clip. (The
    // Star reads the format: its fragments are a density, thinned on a small card; see breach-tarot-star.test.ts.)
    const count = (prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).reduce((n, part) => n + part.paths.length, 0);
    expect(count('star-')).toBeGreaterThan(40);
    expect(count('pieces-')).toBeGreaterThan(80);
    expect(count('helix-')).toBeGreaterThan(60);
    expect(result.parts.filter(part => part.id !== 'card-frame').reduce((n, part) => n + part.paths.length, 0)).toBeGreaterThan(500);
  });

  it('keeps the frame whole on a page with an explicit margin', async () => {
    const result = await renderSketch({ entry: star, seed: 2, finishing: { page: { width: 70, height: 120, margin: 10 } }, timeoutMs: 120_000 });
    const frame = result.parts.find(part => part.id === 'card-frame')!;
    expect(frame.paths).toHaveLength(27);
    // The art window's top: the margin, and the top band's 0.75 mm rule gap and 2.46 mm numeral, 1.85 mm clear either side.
    expect(frame.paths[0]).toEqual([{ x: 10, y: 16.904 }, { x: 60, y: 16.904 }]);
  });

  it('carries --format from the request through the render process into the format module', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-format-'));
    const entry = join(dir, 'probe.ts');
    // A page-aware probe that draws a line as long as the format's scale and the art pens' width, in tenths.
    await writeFile(entry, `import { PENS, S } from ${JSON.stringify(resolve(import.meta.dirname, '../../sketches/kit/format.ts'))};
      export default { name: 'probe', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.3 }], controls: [],
        draw() { return [{ id: 'scale', pen: 'ink', paths: [[{ x: 10, y: 10 }, { x: 10 + 10 * S, y: 10 + 100 * PENS[0].width }]] }]; } };`);
    const finishing = { page: { width: 70, height: 120 } };
    const [height, width] = await Promise.all([
      renderSketch({ entry, finishing }),
      renderSketch({ entry, finishing, format: { fit: 'width', pen: 0.1 } }),
    ]);
    const end = (r: typeof height) => r.parts[0].paths[0][1];
    expect(end(height).x).toBeCloseTo(10 + 10 * 120 / 431.8, 3);
    expect(end(height).y).toBeCloseTo(35, 3);
    expect(end(width).x).toBeCloseTo(10 + 10 * 70 / 279.4, 3);
    expect(end(width).y).toBeCloseTo(20, 3);
  });

  it('scales density counts with the card, and sets the phrase in the band under the name, a shallow band too, none on a card too small', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-format-'));
    const entry = join(dir, 'probe.ts');
    const kit = (path: string) => JSON.stringify(resolve(import.meta.dirname, '../../sketches', path));
    // A page-aware probe: its frame with a phrase, and a line whose end encodes two scaled counts.
    await writeFile(entry, `import { scaledCount } from ${kit('kit/format.ts')};
      import { cardFrame } from ${kit('breach-tarot/card.ts')};
      export default { name: 'probe', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'carbon', color: '#111111', width: 0.25 }, { id: 'lettering', color: '#111111', width: 0.13 }], controls: [],
        draw() { return [{ id: 'counts', pen: 'carbon', paths: [[{ x: 1, y: 1 }, { x: scaledCount(1000, 10) / 10, y: scaledCount(1000, 10, 'length') / 10 }]] },
          ...cardFrame('0', 'THE FOOL', { phrase: { text: 'nothing here has been decided yet' } })]; } };`);
    const page = { width: 70, height: 120 };
    const f = formatFor(targetPage(TABLOID_PAGE, page));
    const result = await renderSketch({ entry, finishing: { page } });
    const counts = result.parts.find(part => part.id === 'counts')!.paths[0][1];
    const area = (c: typeof f.card) => (c.x1 - c.x0) * (c.y1 - c.y0);
    expect(counts.x).toBeCloseTo(Math.round(1000 * area(f.card) / area(TABLOID_FORMAT.card)) / 10, 2);
    expect(counts.x).toBeLessThan(10);
    expect(counts.y).toBeCloseTo(Math.round(1000 * f.s) / 10, 2);
    // The bands: the numeral above, and below it the name, then the phrase, apart and inside the band, each with
    // `clear` mm of paper from the rules and the card's edge (at least the frame's 0.2 mm), the two lines `lead` apart.
    const band = (r: typeof result, g: typeof f, low: number, high: number, clear = 0.2, lead = 0) => {
      const eps = 0.005;
      const phrase = r.parts.find(part => part.id === 'card-phrase')!;
      expect(phrase.pen).toBe('lettering');
      const points = phrase.paths.flat(), ys = points.map(p => p.y), xs = points.map(p => p.x);
      expect(Math.max(...ys)).toBeLessThanOrEqual(g.card.bottom - clear + eps);
      // Ascenders to descenders are 11/8 of the cap height.
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(low * 11 / 8);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(high * 11 / 8);
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(g.page.width / 2, 0);
      const lettering = r.parts.find(part => part.id === 'card-frame')!.paths.slice(4).flat();
      const name = lettering.filter(p => p.y > g.card.y1), numeral = lettering.filter(p => p.y < g.card.y0);
      expect(Math.min(...name.map(p => p.y))).toBeGreaterThanOrEqual(g.card.y1 + g.frame.rule + clear - eps);
      expect(Math.min(...ys) - Math.max(...name.map(p => p.y))).toBeGreaterThan(lead - eps);
      expect(Math.min(...numeral.map(p => p.y))).toBeGreaterThanOrEqual(g.card.top + clear - eps);
      expect(Math.max(...numeral.map(p => p.y))).toBeLessThanOrEqual(g.card.y0 - g.frame.rule - clear + eps);
    };
    // At 70 x 120: the phrase at the lettering pen's legible 1.6 mm, three quarters of the name's 2 mm clear above
    // it and below the phrase, the numeral's 1.85 mm above and below it, and the format's lead between the lines.
    band(result, f, 1.55, 1.65, 1.5, f.frame.lead);
    // A poker card, wider than tabloid's proportions, has the same frame.
    const poker = { width: 63.5, height: 88.9 };
    const pokerFormat = formatFor(targetPage(TABLOID_PAGE, poker));
    expect(pokerFormat.frame).toEqual(f.frame);
    band(await renderSketch({ entry, finishing: { page: poker } }), pokerFormat, 1.55, 1.65, 1.5, f.frame.lead);
    // On a card too small for those bands, they shrink to a quarter of its height: both lines closer, then smaller,
    // still inside it.
    const small = { width: 30, height: 40 };
    const smallFormat = formatFor(targetPage(TABLOID_PAGE, small));
    const cardHeight = smallFormat.card.bottom - smallFormat.card.top;
    expect((smallFormat.card.y0 - smallFormat.card.top) + (smallFormat.card.bottom - smallFormat.card.y1)).toBeCloseTo(cardHeight / 4, 9);
    band(await renderSketch({ entry, finishing: { page: small } }), smallFormat, 1.2, 1.55);
    // On cards too small to letter, the phrase goes, then the name and numeral; whatever is set stays inside the card.
    for (const tiny of [{ width: 20, height: 30 }, { width: 15, height: 25 }, { width: 10, height: 20 }]) {
      const r = await renderSketch({ entry, finishing: { page: tiny } });
      const g = formatFor(targetPage(TABLOID_PAGE, tiny));
      expect(r.parts.find(part => part.id === 'card-phrase'), `${tiny.width} x ${tiny.height}`).toBeUndefined();
      // The four rules, and any lettering clear of them and of the card's edge.
      const frame = r.parts.find(part => part.id === 'card-frame')!;
      expect(frame.paths.length).toBeGreaterThanOrEqual(4);
      const clear = 0.2 - 0.005;
      for (const p of frame.paths.slice(4).flat()) {
        const above = p.y < g.card.y0;
        expect(p.y).toBeGreaterThanOrEqual((above ? g.card.top : g.card.y1 + g.frame.rule) + clear);
        expect(p.y).toBeLessThanOrEqual((above ? g.card.y0 - g.frame.rule : g.card.bottom) - clear);
      }
    }
  });

  it('draws in a card’s preferred fit where the render names none, an explicit fit winning, and refuses it once the format has loaded', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-format-'));
    const kit = (path: string) => JSON.stringify(resolve(import.meta.dirname, '../../sketches/kit', path));
    // A page-aware probe that prefers `width`, declared first, and draws a line as long as the format's scale.
    await writeFile(join(dir, 'prefers.ts'), `import { preferFit } from ${kit('format-preference.ts')};\npreferFit('width');\n`);
    const probe = (first: string, second: string) => `import ${first};\nimport ${second};
      import { S } from ${kit('format.ts')};
      export default { name: 'probe', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.3 }], controls: [],
        draw() { return [{ id: 'scale', pen: 'ink', paths: [[{ x: 10, y: 10 }, { x: 10 + 10 * S, y: 10 }]] }]; } };`;
    await writeFile(join(dir, 'probe.ts'), probe(`'./prefers.ts'`, kit('format.ts')));
    const finishing = { page: { width: 70, height: 120 } };
    const scale = (r: Awaited<ReturnType<typeof renderSketch>>) => (r.parts[0].paths[0][1].x - 10) / 10;
    const [preferred, height] = await Promise.all([
      renderSketch({ entry: join(dir, 'probe.ts'), finishing }),
      renderSketch({ entry: join(dir, 'probe.ts'), finishing, format: { fit: 'height' } }),
    ]);
    expect(scale(preferred)).toBeCloseTo(70 / 279.4, 3);
    expect(scale(height)).toBeCloseTo(120 / 431.8, 3);
    // Declared after the format has laid itself out, the preference would be ignored: the render fails instead.
    await writeFile(join(dir, 'late.ts'), probe(kit('format.ts'), `'./prefers.ts'`));
    await expect(renderSketch({ entry: join(dir, 'late.ts'), finishing })).rejects.toThrow(/prefers fit 'width', but the format had already loaded in fit 'height'/);
    // A render that names its fit is drawn in it, however late the card declares its own.
    expect(scale(await renderSketch({ entry: join(dir, 'late.ts'), finishing, format: { fit: 'height' } }))).toBeCloseTo(120 / 431.8, 3);
    // The pilot cards: the Fool and the Tower keep their whole width, the Star its vertical framing.
    const cards: [string, number, 'width' | 'height'][] = [['0-fool', 1, 'width'], ['xvi-tower', 2, 'width'], ['xvii-star', 2, 'height']];
    for (const [card, seed, fit] of cards) {
      const entry = resolve(import.meta.dirname, `../../sketches/breach-tarot/${card}/sketch.ts`);
      const [plain, named] = await Promise.all([
        renderSketch({ entry, seed, finishing, timeoutMs: 120_000 }),
        renderSketch({ entry, seed, finishing, format: { fit }, timeoutMs: 120_000 }),
      ]);
      expect(plain.parts, card).toEqual(named.parts);
    }
  });

  it('takes the pen floor from a pen option on a tabloid page too, and leaves the preset alone', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-format-'));
    const entry = join(dir, 'probe.ts');
    // A page-aware probe: a line as long as tolerance(0.3), in tenths.
    await writeFile(entry, `import { tolerance } from ${JSON.stringify(resolve(import.meta.dirname, '../../sketches/kit/format.ts'))};
      export default { name: 'probe', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.3 }], controls: [],
        draw() { return [{ id: 'floor', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + 10 * tolerance(0.3), y: 20 }]] }]; } };`);
    const page = { width: 279.4, height: 431.8, margin: 18 };
    const [preset, thick] = await Promise.all([renderSketch({ entry, finishing: { page } }), renderSketch({ entry, finishing: { page }, format: { pen: 0.35 } })]);
    const end = (r: typeof preset) => r.parts[0].paths[0][1].x;
    expect(end(preset)).toBeCloseTo(23, 3);
    expect(end(thick)).toBeCloseTo(27, 3);
  });

  it('renders the Tower, with its double-resolution machine pass, on a 12 x 18 in page', async () => {
    const tower = resolve(import.meta.dirname, '../../sketches/breach-tarot/xvi-tower/sketch.ts');
    const result = await renderSketch({ entry: tower, seed: 2, finishing: { page: { width: 304.8, height: 457.2 } }, timeoutMs: 120_000 });
    expect(result.metadata.page).toMatchObject({ width: 304.8, height: 457.2 });
    expect(result.stats.pathCount).toBeGreaterThan(1000);
  });
});
