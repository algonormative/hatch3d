import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { TABLOID_PAGE, TALL_ART } from '../../sketches/phase-garden/poster.ts';
import { CARD as CARD_OF_CARDS, HORIZON_Y as HORIZON_OF_CARDS } from '../../sketches/breach-tarot/card.ts';
import { targetPage } from '../sketch/render-target.ts';
import {
  CARD, FORMAT, FRAME, HORIZON_Y, PAGE, PITCH_SCALE, SHEET, TABLOID_FORMAT, assertFormatPage, depthRaster, fitFov, formatFor,
  halo, layoutLength, layoutX, layoutY, rasterFor, tolerance,
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
    expect(FRAME).toEqual({ rule: 1.2, numeral: { height: 8, tracking: 2.2 }, name: { height: 6.5, tracking: 3.2 }, phraseHeight: 2.2 });
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

  it('lays a 70 x 120 mm card out in tabloid proportions under one scale', () => {
    const page = { width: 70, height: 120, margin: 4.51, paper: '#f4f0e6' };
    const f = formatFor(page);
    const s = 120 / 431.8;
    expect(f).toMatchObject({ name: '70x120', tabloid: false, fit: 'height', phrase: 'band', minSpacing: 0.5 });
    expect(f.s).toBeCloseTo(s, 12);
    expect(f.pitchScale).toBeCloseTo(1 / s, 12);
    expect(f.card.x0).toBe(4.51);
    // Without a margin the card's edge is tabloid's 18 mm scaled by the smaller ratio.
    expect(formatFor({ width: 70, height: 120 }).card.x0).toBeCloseTo(18 * 70 / 279.4, 9);
    expect(f.card.x1 - f.card.x0).toBeCloseTo(61, 0);
    expect(f.card.y1 - f.card.y0).toBeCloseTo(97.6, 1);
    expect(f.horizonY).toBeCloseTo(f.card.y0 + 0.6 * (f.card.y1 - f.card.y0), 12);
    expect(f.frame.numeral.height).toBeCloseTo(8 * s, 12);
    expect(f.frame.name.height).toBeCloseTo(6.5 * s, 12);
    expect(f.frame.phraseHeight).toBe(1.6);
    const wide = formatFor(page, { fit: 'width', pen: 0.1 });
    expect(wide.s).toBeCloseTo(70 / 279.4, 12);
    expect(wide.minSpacing).toBeCloseTo(0.2, 12);
    expect(wide.pens.find(pen => pen.id === 'carbon')!.width).toBe(0.1);
    expect(() => formatFor(page, { fit: 'diagonal' })).toThrow(/fit/);
    expect(() => formatFor(page, { colour: 'red' })).toThrow(/Unknown format option/);
  });

  it('puts the card’s edge on an explicit page margin, and says so when the card cannot fit', () => {
    const f = formatFor({ width: 70, height: 120, margin: 10 });
    expect(f.card).toMatchObject({ x0: 10, x1: 60, top: 10, bottom: 110 });
    expect(f.card.y1 - f.card.y0).toBeCloseTo(100 - 48 * 120 / 431.8, 9);
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
    expect(card.W / card.H).toBeCloseTo(70 / 120, 2);
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
    // The scene lands in the window: the star, the falling pieces and the helix all survive the window's clip.
    const count = (prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).reduce((n, part) => n + part.paths.length, 0);
    expect(count('star-')).toBeGreaterThan(40);
    expect(count('pieces-')).toBeGreaterThan(150);
    expect(count('helix-')).toBeGreaterThan(60);
    expect(result.parts.filter(part => part.id !== 'card-frame').reduce((n, part) => n + part.paths.length, 0)).toBeGreaterThan(500);
  });

  it('keeps the frame whole on a page with an explicit margin', async () => {
    const result = await renderSketch({ entry: star, seed: 2, finishing: { page: { width: 70, height: 120, margin: 10 } }, timeoutMs: 120_000 });
    const frame = result.parts.find(part => part.id === 'card-frame')!;
    expect(frame.paths).toHaveLength(27);
    expect(frame.paths[0]).toEqual([{ x: 10, y: 16.67 }, { x: 60, y: 16.67 }]);
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

  it('renders the Tower, with its double-resolution machine pass, on a 12 x 18 in page', async () => {
    const tower = resolve(import.meta.dirname, '../../sketches/breach-tarot/xvi-tower/sketch.ts');
    const result = await renderSketch({ entry: tower, seed: 2, finishing: { page: { width: 304.8, height: 457.2 } }, timeoutMs: 120_000 });
    expect(result.metadata.page).toMatchObject({ width: 304.8, height: 457.2 });
    expect(result.stats.pathCount).toBeGreaterThan(1000);
  });
});
