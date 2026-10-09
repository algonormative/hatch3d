import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveOptions } from '../../cli/finalize.ts';
import { MPC, checkStack, deckEntry, geometry, layoutCard, printBack, printCard, printChart, printOptions, printSvg, run, type PrintOptions, type RunOptions } from '../../cli/print-export.ts';
import { encodePng, hexRgb, pngInfo, readRgb, type RGB } from '../../cli/print-export/raster.ts';
import { parseLayers } from '../../cli/print-export/svg.ts';
import { thickenLayers, unguardedPairs } from '../../cli/print-export/thicken.ts';

const { width: W, height: H } = MPC.trimMm;
const G = geometry(MPC);
const MM = MPC.ppi / 25.4;
const TINT = hexRgb(MPC.tint);
const CARBON = hexRgb('#22282c'), BLUE = hexRgb('#3c49aa');

/** A sketch SVG in the grammar the cards render: one layer group per pen, one part group inside. */
const layer = (n: number, pen: string, color: string, width: number, ds: string[]) =>
  `<g inkscape:groupmode="layer" inkscape:label="${n}-${pen}" data-pen-id="${pen}" data-passes="1" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">`
  + `<g data-part-id="${pen}-part">${ds.map(d => `<path d="${d}"/>`).join('')}</g></g>`;
const cardSvg = (...layers: string[]) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">\n${layers.join('\n')}\n</svg>`;
const frame = (inset: number) => layer(7, 'finishing-border', '#22282c', 0.25, [`M${inset},${inset}L${W - inset},${inset}L${W - inset},${H - inset}L${inset},${H - inset}L${inset},${inset}`]);
const line = (x0: number, y0: number, x1: number, y1: number) => `M${x0},${y0}L${x1},${y1}`;

const SAMPLE = cardSvg(
  layer(1, 'carbon', '#22282c', 0.25, [line(30, 30, 30, 60)]),
  layer(2, 'ultramarine', '#3c49aa', 0.25, [line(15, 80, 50, 80)]),
  layer(6, 'lettering', '#22282c', 0.13, [line(20, 100, 40, 100)]),
  frame(5.25),
);

/** Where a point of the page lands on the canvas, in pixels (the bleed is on every side). */
const px = (mm: number): number => MPC.bleedPx + mm * MM;

/** How much of a pixel is `ink` over the tint, 0 to 1, from the channel the two differ in most. */
function coverage(rgb: Uint8Array, w: number, x: number, y: number, ink: RGB): number {
  const c = [0, 1, 2].reduce((best, k) => Math.abs(TINT[k] - ink[k]) > Math.abs(TINT[best] - ink[best]) ? k : best, 0);
  return (TINT[c] - rgb[(y * w + x) * 3 + c]) / (TINT[c] - ink[c]);
}
/** A line's width in pixels: the ink coverage summed across it. */
function crossing(rgb: Uint8Array, w: number, ink: RGB, from: number, to: number, fixed: number, vertical: boolean): number {
  let sum = 0;
  for (let t = Math.round(from); t <= Math.round(to); t++) sum += vertical ? coverage(rgb, w, t, Math.round(fixed), ink) : coverage(rgb, w, Math.round(fixed), t, ink);
  return sum;
}
const isTint = (rgb: Uint8Array, i: number) => rgb[i * 3] === TINT[0] && rgb[i * 3 + 1] === TINT[1] && rgb[i * 3 + 2] === TINT[2];

/** Pixels of `rgb` that are not the tint inside the band `inset` pixels wide round the trim's edge (the bleed and the safe margin). */
function inkInBand(rgb: Uint8Array, w: number, h: number, band: number): number {
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x < band || y < band || x >= w - band || y >= h - band) && !isTint(rgb, y * w + x)) n++;
  return n;
}
/** The first column along a row, from the left, that is not the tint. */
const firstInk = (rgb: Uint8Array, w: number, y: number): number => { let x = 0; while (x < w && isTint(rgb, y * w + x)) x++; return x; };

const safeBand = (): number => Math.floor(px(MPC.safeMm));
const options = (o: Partial<PrintOptions> = {}) => printOptions(MPC, o);

describe('print export: the canvas', () => {
  let printed: ReturnType<typeof printSvg>;
  let image: { width: number; height: number; rgb: Uint8Array };
  beforeAll(() => {
    printed = printSvg(SAMPLE, MPC, options());
    image = readRgb(printed.png);
  }, 120_000);

  it('is MPC’s 897 × 1497 px: the 825 × 1425 px trim plus 36 px of bleed, tagged 300 ppi and sRGB', () => {
    expect(G.trimPx).toEqual({ width: 825, height: 1425 });
    expect(G.canvasPx).toEqual({ width: 897, height: 1497 });
    expect(G.bleedMm).toBeCloseTo(3.048, 3);
    const info = pngInfo(printed.png);
    expect(info).toEqual({ width: 897, height: 1497, colorType: 2, ppi: 300, srgb: true });
    // The trim starts after the bleed: the 5.25 mm border's outer edge is 5.075 mm in, on pixel 36 + 59.96.
    expect(firstInk(image.rgb, image.width, 700)).toBeGreaterThanOrEqual(95);
    expect(firstInk(image.rgb, image.width, 700)).toBeLessThanOrEqual(96);
  });

  it('prints the tint to every edge of the canvas, bleed included, and keeps it exact without grain', () => {
    const { width: w, height: h, rgb } = image;
    for (let x = 0; x < w; x++) { expect(isTint(rgb, x)).toBe(true); expect(isTint(rgb, (h - 1) * w + x)).toBe(true); }
    for (let y = 0; y < h; y++) { expect(isTint(rgb, y * w)).toBe(true); expect(isTint(rgb, y * w + w - 1)).toBe(true); }
    // With grain it still reaches every edge, within the strength either side, and is no longer flat.
    const grained = readRgb(printSvg(SAMPLE, MPC, options({ grain: { seed: 7, grainMm: 0.5, strength: 0.06 } })).png);
    const edge = [0, w - 1, (h - 1) * w, h * w - 1, 5 * w + 3, 700 * w + 0];
    for (const i of edge) for (let k = 0; k < 3; k++) expect(Math.abs(grained.rgb[i * 3 + k] - TINT[k])).toBeLessThanOrEqual(Math.ceil(TINT[k] * 0.06));
    expect(new Set(Array.from({ length: 400 }, (_, i) => grained.rgb[i * 3])).size).toBeGreaterThan(3);
  }, 120_000);

  it('puts no line pixel in the bleed or within the safe margin of the trim, and finds one that is', () => {
    expect(printed.layout.safeOk).toBe(true);
    expect(inkInBand(image.rgb, image.width, image.height, safeBand())).toBe(0);
    // The border is there, just outside the band. A line in the safe zone is caught by the scan and by the layout check.
    expect(firstInk(image.rgb, image.width, 700)).toBeGreaterThanOrEqual(safeBand());
    const bad = cardSvg(layer(1, 'carbon', '#22282c', 0.25, [line(3, 40, 3, 70)]), frame(5.25));
    expect(layoutCard(bad, MPC, MPC.widthsMm).safeOk).toBe(false);
    const caught = readRgb(printSvg(bad, MPC, options()).png);
    expect(inkInBand(caught.rgb, caught.width, caught.height, safeBand())).toBeGreaterThan(100);
  }, 120_000);

  it('draws the lines at the thickened widths, in the pen colours exactly', () => {
    const { width: w, rgb } = image;
    const expectPx = (mm: number) => mm * MM;
    // Carbon 0.25 → 0.35 mm, coloured 0.25 → 0.42, lettering 0.13 → 0.26: measured across each line on the canvas.
    expect(Math.abs(crossing(rgb, w, CARBON, px(30) - 8, px(30) + 8, px(45), true) - expectPx(0.35))).toBeLessThan(0.15);
    expect(Math.abs(crossing(rgb, w, BLUE, px(80) - 8, px(80) + 8, px(32), false) - expectPx(0.42))).toBeLessThan(0.15);
    expect(Math.abs(crossing(rgb, w, CARBON, px(100) - 8, px(100) + 8, px(30), false) - expectPx(0.26))).toBeLessThan(0.15);
    // The widths are the options': a wider carbon setting is wider on the canvas.
    const wide = readRgb(printSvg(SAMPLE, MPC, options({ widthsMm: { carbon: 0.6, colour: 0.42, lettering: 0.26 } })).png);
    expect(Math.abs(crossing(wide.rgb, w, CARBON, px(30) - 10, px(30) + 10, px(45), true) - expectPx(0.6))).toBeLessThan(0.15);
    // The ink is the pen colour exactly where a line fills a pixel.
    const at = (x: number, y: number) => Array.from(rgb.slice((Math.round(y) * w + Math.round(x)) * 3, (Math.round(y) * w + Math.round(x)) * 3 + 3));
    expect(at(px(30), px(45))).toEqual(Array.from(CARBON));
    expect(at(px(32), px(80))).toEqual(Array.from(BLUE));
  });
});

describe('print export: the gap guard', () => {
  const pair = (pitch: number, width = 0.25) => parseLayers(cardSvg(layer(1, 'carbon', '#22282c', width, [line(30, 30, 30, 60), line(30 + pitch, 30, 30 + pitch, 60)])));
  const widths = { carbon: 0.35, colour: 0.42, lettering: 0.26 };
  const guard = { widths, gapMin: 0.25 };

  it('holds a close pair at the plotted width, thins a middling one to the room it has, and leaves a wide one thick', () => {
    const close = thickenLayers(pair(0.5), guard);
    expect(close.layers[0].strokes.map(s => s.width)).toEqual([0.25, 0.25]);
    expect(close.report).toMatchObject({ paths: 2, thickened: 0, capped: 2, heldAtPlotted: 2 });
    const middling = thickenLayers(pair(0.58), guard);
    expect(middling.layers[0].strokes[0].width).toBeCloseTo(0.33, 6);
    expect(middling.report).toMatchObject({ thickened: 2, capped: 2, heldAtPlotted: 0 });
    const wide = thickenLayers(pair(0.9), guard);
    expect(wide.layers[0].strokes.map(s => s.width)).toEqual([0.35, 0.35]);
    expect(wide.report.capped).toBe(0);
    // Afterwards no pair is closer than its widths leave room for.
    for (const pitch of [0.5, 0.58, 0.7, 0.9]) {
      const before = pair(pitch), out = thickenLayers(before, guard).layers;
      expect(unguardedPairs(before, out, guard)).toEqual([]);
    }
    // Strokes that cross are not neighbours.
    const crossed = parseLayers(cardSvg(layer(1, 'carbon', '#22282c', 0.25, [line(30, 30, 30, 60), line(20, 45, 40, 45.3)])));
    expect(thickenLayers(crossed, guard).report.capped).toBe(0);
  });

  it('keeps the paper gap open on the canvas: the pair prints at the plotted width, not the thick one', () => {
    const across = (pitch: number) => {
      const out = readRgb(printSvg(cardSvg(layer(1, 'carbon', '#22282c', 0.25, [line(30, 30, 30, 60), line(30 + pitch, 30, 30 + pitch, 60)]), frame(5.25)), MPC, options()).png);
      return crossing(out.rgb, out.width, CARBON, px(30) - 8, px(30 + pitch) + 8, px(45), true);
    };
    expect(Math.abs(across(0.5) - 2 * 0.25 * MM)).toBeLessThan(0.2);
    expect(Math.abs(across(0.9) - 2 * 0.35 * MM)).toBeLessThan(0.2);
  }, 120_000);
});

describe('print export: determinism and the proof deck', () => {
  const grain = { seed: 3, grainMm: 0.5, strength: 0.04 };
  const ink = { seed: 3, jitter: 0.08, correlationMm: 6, blob: 1.6, blobMm: 0.3, stepMm: 0.25 };

  it('gives the same bytes for the same inputs, with grain and ink character on, and different ones for another seed', () => {
    const a = printSvg(SAMPLE, MPC, options({ grain, ink })).png;
    const b = printSvg(SAMPLE, MPC, options({ grain, ink })).png;
    expect(b.equals(a)).toBe(true);
    expect(printSvg(SAMPLE, MPC, options({ grain: { ...grain, seed: 4 }, ink: { ...ink, seed: 4 } })).png.equals(a)).toBe(false);
    expect(printSvg(SAMPLE, MPC, options()).png.equals(a)).toBe(false);
  }, 180_000);

  it('names cards by deck order and builds a chart that carries the five pen colours', () => {
    expect([deckEntry('0-fool').stem, deckEntry('xvi-tower').stem, deckEntry('xvii-star').stem, deckEntry('xiv-temperance').stem, deckEntry('xix-sun').stem])
      .toEqual(['00-the-fool', '16-the-tower', '17-the-star', '14-temperance', '19-the-sun']);
    const palette = resolveOptions({ out: '', pieces: [] }).palette;
    const first = printChart(palette, MPC, options()), again = printChart(palette, MPC, options());
    expect(again.png.equals(first.png)).toBe(true);
    expect(first.file).toMatchObject({ file: '22-test-chart.front.png', widthPx: 897, heightPx: 1497, ppi: 300, kind: 'chart' });
    const { rgb } = readRgb(first.png);
    for (const hex of palette.inks.slice(0, 5)) {
      const [r, g, b] = hexRgb(hex);
      let n = 0;
      for (let i = 0; i < rgb.length; i += 3) if (rgb[i] === r && rgb[i + 1] === g && rgb[i + 2] === b) n++;
      expect(n, hex).toBeGreaterThan(500);
    }
  }, 120_000);

  it('takes a back image only at the canvas size, and writes it with the dpi and sRGB tag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'print-export-'));
    const wrong = join(dir, 'wrong.png'), right = join(dir, 'right.png');
    writeFileSync(wrong, encodePng(new Uint8Array(30 * 40 * 3), 30, 40, 72));
    writeFileSync(right, encodePng(new Uint8Array(897 * 1497 * 3).fill(200), 897, 1497, 72));
    expect(() => printBack(wrong, MPC, options())).toThrow(/897 x 1497/);
    const back = printBack(right, MPC, options());
    expect(pngInfo(back.png)).toEqual({ width: 897, height: 1497, colorType: 2, ppi: 300, srgb: true });
    expect(back.file).toMatchObject({ file: 'back.png', kind: 'back' });
  });
});

describe('print export: the print stack and a real card', () => {
  const stackPath = resolve('sketches/phase-garden/stacks/tarot-print.json');
  const stack = JSON.parse(readFileSync(stackPath, 'utf8'));

  it('draws on the trim with its border outside the 5 mm safe line, and refuses one that is not', () => {
    expect(() => checkStack(stack, MPC, options())).not.toThrow();
    expect(stack.page).toMatchObject({ width: W, height: H });
    expect(() => checkStack({ ...stack, border: { ...stack.border, inset: 4 } }, MPC, options())).toThrow(/safe zone/);
    expect(() => checkStack({ ...stack, page: { width: 70, height: 120 } }, MPC, options())).toThrow(/trim/);
  });

  it('prints the Fool at its print seed with the art inside the safe zone and some strokes held by the guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'print-export-'));
    const card = await printCard(stack, stack.pieces[0], resolveOptions(stack).palette, MPC, options(), dir);
    expect(card.file).toMatchObject({ file: '00-the-fool.front.png', seed: 1, widthPx: 897, heightPx: 1497, artInsideSafeZone: true });
    expect(card.file.cappedPaths).toBeGreaterThan(0);
    expect(card.file.cappedPaths).toBeLessThan(card.file.paths!);
    expect(card.file.borderOuterEdgeMm).toBeGreaterThanOrEqual(5);
    const { width, height, rgb } = readRgb(card.png);
    expect(inkInBand(rgb, width, height, safeBand())).toBe(0);
  }, 240_000);
});

describe('print export: the stack back', () => {
  const stackPath = resolve('sketches/phase-garden/stacks/tarot-print.json');
  /** A run that draws only the back: `only: []` leaves out every card, and the back is drawn either way. */
  const backRun = async (o: Partial<RunOptions> = {}) => {
    const out = mkdtempSync(join(tmpdir(), 'print-export-back-'));
    const manifest = await run({ stackPath, profile: MPC, options: options(), only: [], chart: false, out, ...o });
    return { manifest, out };
  };

  it('draws the stack back at the canvas size, tinted at every edge, and lists it in the manifest', async () => {
    const { manifest, out } = await backRun();
    expect(manifest.files.map(f => f.file)).toEqual(['back.png']);
    expect(manifest.files[0]).toMatchObject({ kind: 'back', seed: 1, widthPx: 897, heightPx: 1497, ppi: 300, artInsideSafeZone: true });
    const png = readFileSync(join(out, 'back.png'));
    expect(pngInfo(png)).toEqual({ width: 897, height: 1497, colorType: 2, ppi: 300, srgb: true });
    const { width: w, height: h, rgb } = readRgb(png);
    for (let x = 0; x < w; x++) { expect(isTint(rgb, x)).toBe(true); expect(isTint(rgb, (h - 1) * w + x)).toBe(true); }
    for (let y = 0; y < h; y++) { expect(isTint(rgb, y * w)).toBe(true); expect(isTint(rgb, y * w + w - 1)).toBe(true); }
    expect(inkInBand(rgb, w, h, safeBand())).toBe(0);
  }, 120_000);

  it('draws the labyrinth for --back-form labyrinth, not the helix the stack gives by default, and refuses a form it does not know', async () => {
    const helix = (await backRun()).manifest.files[0].sha256;
    expect((await backRun({ backForm: 'helix' })).manifest.files[0].sha256).toBe(helix);
    expect((await backRun({ backForm: 'labyrinth' })).manifest.files[0].sha256).not.toBe(helix);
    await expect(backRun({ backForm: 'labyrinh' })).rejects.toThrow(/labyrinh/);
  }, 120_000);

  it('refuses a stack whose back or face params name a control the sketch does not declare, naming the piece and the key', async () => {
    const stack = JSON.parse(readFileSync(stackPath, 'utf8'));
    const write = (edit: (s: any) => void) => {
      const copy = structuredClone(stack);
      edit(copy);
      const path = join(mkdtempSync(join(tmpdir(), 'print-export-stack-')), 'stack.json');
      writeFileSync(path, JSON.stringify(copy));
      return path;
    };
    await expect(backRun({ stackPath: write(s => { s.back.params = { ...s.back.params, formm: 'helix' }; }) })).rejects.toThrow(/back has no control named formm/);
    const first = stack.pieces[0].name;
    await expect(backRun({ stackPath: write(s => { s.pieces[0].params = { ...s.pieces[0].params, sloganSzie: 2 }; }), only: [first], noBack: true }))
      .rejects.toThrow(new RegExp(`${first} has no control named sloganSzie`));
  }, 120_000);

  it('prints an explicit --back image in place of the stack back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'print-export-'));
    const explicit = join(dir, 'explicit.png');
    writeFileSync(explicit, encodePng(new Uint8Array(897 * 1497 * 3).fill(200), 897, 1497, 72));
    const { manifest, out } = await backRun({ back: explicit });
    expect(manifest.files[0]).toMatchObject({ file: 'back.png', kind: 'back' });
    expect(manifest.files[0].seed).toBeUndefined();
    const { rgb } = readRgb(readFileSync(join(out, 'back.png')));
    expect(rgb.filter(v => v !== 200).length).toBe(0);
  }, 120_000);
});
