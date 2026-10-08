import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';
import { shear } from '../../sketches/breach-tarot/xvi-tower/geometry.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { formatFor, type CardRect, type Fit } from '../../sketches/kit/format.ts';
import { clipToRect } from '../../sketches/kit/page.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { Part, RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/xvi-tower/sketch.ts');

type Pt = { x: number; y: number };
type Parts = { id: string; paths: Pt[][] }[];
const ink = (parts: Parts, prefixes: string[]) => parts.filter(p => prefixes.some(q => p.id.startsWith(q))).flatMap(p => p.paths);
/** A point every `step` millimetres (half a millimetre by default) along each path. */
function dense(paths: Pt[][], step = 0.5): Pt[] {
  const out: Pt[] = [];
  for (const path of paths) for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 0; j <= k; j++) out.push({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k });
  }
  return out;
}
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

/** Where a render's card sits and its scale against tabloid: every length the reading uses is tabloid's times `s`. */
type Frame = { card: CardRect; horizonY: number; s: number };
const TABLOID: Frame = { card: CARD, horizonY: HORIZON_Y, s: 1 };

/**
 * The machine form read off the render. The helix: where its ink starts and ends on the card, the
 * longest stretch of height it leaves blank, and how wide it shows through the machine's body
 * against its width in the open sky. The bolt: how many of its points fall inside the silhouette of
 * what stands (machine, lid, ticks, words and helix), read row by row as the spans of their ink. The
 * lid: the tallest band of rows the machine's own ink leaves empty, and where it is.
 */
function read(parts: Parts, { card, horizonY, s }: Frame) {
  const helix = dense(ink(parts, ['helix-']), 0.5 * s);
  const ys = helix.map(p => p.y);
  const top = Math.min(...ys), low = Math.max(...ys);
  const bin = 2 * s;
  const bins = new Set(ys.map(y => Math.floor(y / bin)));
  let gap = 0;
  for (let b = Math.floor(top / bin), run = 0; b <= Math.floor(low / bin); b++) gap = Math.max(gap, run = bins.has(b) ? 0 : run + bin);
  const extent = (y0: number, y1: number) => {
    const widths: number[] = [];
    for (let y = y0; y < y1; y += bin) {
      const xs = helix.filter(p => p.y >= y && p.y < y + bin).map(p => p.x);
      widths.push(xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
    }
    return median(widths);
  };
  const body = extent(horizonY - 40 * s, horizonY), sky = extent(card.y0 + 5 * s, card.y0 + 45 * s);
  const centre = helix.reduce((sum, p) => sum + p.x, 0) / helix.length - (card.x0 + card.x1) / 2;
  const rows = new Map<number, number[]>();
  for (const p of dense(ink(parts, ['machine-', 'lights-', 'helix-', 'slogan-']), 0.5 * s)) {
    const r = Math.round(p.y / s);
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r)!.push(p.x);
  }
  const spans = new Map<number, [number, number][]>();
  for (const [r, xs] of rows) {
    const out: [number, number][] = [];
    for (const x of xs.sort((a, b) => a - b)) {
      const last = out[out.length - 1];
      if (last && x - last[1] <= 6 * s) last[1] = x; else out.push([x, x]);
    }
    spans.set(r, out);
  }
  const bolt = dense(ink(parts, ['bolt-']), 0.5 * s);
  const inFront = bolt.filter(p => (spans.get(Math.round(p.y / s)) ?? []).some(([a, b]) => p.x > a + 0.5 * s && p.x < b - 0.5 * s)).length;
  const machineYs = dense(ink(parts, ['machine-']), 0.5 * s).map(p => p.y);
  const filled = new Set(machineYs.map(y => Math.floor(y / s)));
  const machineTop = Math.min(...machineYs);
  const lid = { gap: 0, at: 0 };
  for (let r = Math.floor(machineTop / s), run = 0; r <= Math.floor(Math.max(...machineYs) / s); r++) {
    run = filled.has(r) ? 0 : run + 1;
    if (run * s > lid.gap) { lid.gap = run * s; lid.at = (r + 1) * s; }
  }
  return { top, low, gap, body, sky, centre, bolt: bolt.length, inFront, machineTop, lid };
}

/** The cells, `4 × s` millimetres square, that the bolt's ink passes through: how far over the sky it reaches. */
function boltReach(parts: Parts, s: number): number {
  const cell = 4 * s, cells = new Set<string>();
  for (const p of dense(ink(parts, ['bolt-']), 0.4 * s)) cells.add(`${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`);
  return cells.size;
}

async function machine(params: Record<string, unknown> = {}) {
  const { parts } = await renderSketch({ entry, seed: 2, params } as never);
  return { parts, ...read(parts, TABLOID) };
}

describe('Breach Tarot: XVI The Tower', () => {
  it('replays at its print seed, stays inside the art window, and draws the storm, the machine, its ticks, the helix, the phrase, the bolt, the horizon and the frame', async () => {
    const first = await renderSketch({ entry, seed: 2 });
    const replay = await renderSketch({ entry, seed: 2 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    // The runner clips everything to the page margin; the art itself must keep to the window between the bands.
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(CARD.x0 - 0.01);
      expect(p.x).toBeLessThanOrEqual(CARD.x1 + 0.01);
      expect(p.y).toBeGreaterThanOrEqual((part.id === 'card-frame' ? CARD.top : CARD.y0) - 0.01);
      expect(p.y).toBeLessThanOrEqual((part.id === 'card-frame' ? CARD.bottom : CARD.y1) + 0.01);
    }
    const ids = first.parts.map(p => p.id);
    for (const id of ['storm-carbon', 'system-carbon', 'machine-carbon', 'lights-vermilion', 'helix-violet', 'helix-vermilion', 'slogan-lettering', 'bolt-carbon', 'horizon-carbon', 'card-frame']) expect(ids).toContain(id);
  }, 60_000);

  it('the machine is open and the helix rises through it; the lightning is behind', async () => {
    const m = await machine();
    // The helix runs unbroken from the floor of the core, below the eye line, up off the top of the card...
    expect(m.low).toBeGreaterThan(HORIZON_Y + 6);
    expect(m.top).toBeLessThan(CARD.y0 + 3);
    expect(m.gap).toBeLessThanOrEqual(2);
    // ...in full view inside the opening: as wide through the machine's body as in the open sky, on the card's axis.
    expect(m.body / m.sky).toBeGreaterThan(0.7);
    expect(Math.abs(m.centre)).toBeLessThan(3);
    // Not one mark of the bolt falls inside what stands in front of it.
    expect(m.bolt).toBeGreaterThan(2000);
    expect(m.inFront).toBe(0);
  }, 60_000);

  it('keeps the cantilever form reachable: struck across the page, its far side sheared along the tear', async () => {
    const first = await renderSketch({ entry, seed: 1, params: { form: 'cantilever' } } as never);
    const ids = first.parts.map(p => p.id);
    expect(ids).not.toContain('machine-carbon');
    expect(ids).toContain('system-carbon');
    expect(first.parts.find(p => p.id === 'bolt-carbon')!.paths.length).toBeGreaterThan(100);
    const bolt = [{ x: 100, y: 0 }, { x: 100, y: 200 }];
    const out = shear([{ x: 50, y: 100 }, { x: 150, y: 100 }], bolt, { x: 0, y: 6 }, 3);
    expect(out.map(p => p[0].y).sort((a, b) => a - b)).toEqual([100, 106]);
    for (const path of out) for (const p of path) expect(Math.abs(p.x - 100)).toBeGreaterThan(3);
  }, 60_000);
});

describe('Breach Tarot: XVI The Tower at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  const render = (fit: Fit) => renderSketch({ entry, seed: 2, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}), timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const frameOf = (fit: Fit): Frame => { const f = formatOf(fit); return { card: f.card, horizonY: f.horizonY, s: f.s }; };
  const probe = (parts: readonly Part[], result: RenderResult) => densityProbe(parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });

  it('replays in both fits, draws the scene in the art window, no words on the machine, and the phrase in the band', async () => {
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
      // Paths wholly inside the art window, per part of the scene: the storm, the ground, the machine, its status
      // ticks, the helix, the bolt, the horizon.
      const inWindow = (prefix: string) => first.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'storm-': 50, 'system-': 120, 'machine-': 600, 'lights-': 10, 'helix-': 150, 'bolt-': 60, 'horizon-': 1 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-'))).toBe(false);
      const phrase = first.parts.filter(part => part.id === 'card-phrase').flatMap(part => part.paths.flat());
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as the Tower: the helix rises through the open machine, the lid floats clear of it, the lightning is behind and still forks', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    const printReach = boltReach(print.parts, 1);
    for (const [k, fit] of fits.entries()) {
      const frame = frameOf(fit), { card, horizonY, s } = frame;
      const m = read(small[k].parts, frame);
      // The helix runs unbroken from the floor of the core, below the eye line, up off the top of the card...
      expect(m.low).toBeGreaterThan(horizonY + 6 * s);
      expect(m.top).toBeLessThan(card.y0 + 3 * s);
      expect(m.gap).toBeLessThanOrEqual(2 * s);
      // ...in full view inside the opening: as wide through the machine's body as in the open sky, on the card's axis.
      expect(m.body / m.sky).toBeGreaterThan(0.7);
      expect(Math.abs(m.centre)).toBeLessThan(3 * s);
      // The lid floats: above the eye line, a clear band between it and the body, with the lid above that.
      expect(m.lid.gap).toBeGreaterThan(10 * s);
      expect(m.lid.at).toBeLessThan(horizonY - 10 * s);
      expect(m.machineTop).toBeLessThan(m.lid.at - m.lid.gap - 2 * s);
      // Not one mark of the bolt falls inside what stands in front of it.
      expect(m.bolt).toBeGreaterThan(2000);
      expect(m.inFront).toBe(0);
      // Its branches thinned, it still forks out over the sky, not one channel's strip: it reaches 40% of the
      // print's cells (its main channel alone, a third).
      expect(boltReach(small[k].parts, s)).toBeGreaterThan(0.4 * printReach);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is; its blade courses hold the pen floor', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    const master = probe(print.parts, print);
    // The machine's body, clear of the eye line's slivers and of the lid: where blades merge into courses whose
    // gaps hold the pen floor, it crowds far less than the print's, whose blades sit well apart on tabloid.
    const body = (result: RenderResult, { horizonY, s }: Frame) => {
      const box = { x0: 0, x1: result.metadata.page.width, y0: horizonY - 80 * s, y1: horizonY - 20 * s };
      return probe(result.parts.filter(part => part.id === 'machine-carbon').map(part => ({ ...part, paths: part.paths.flatMap(path => clipToRect(path, box)) })), result).share;
    };
    const printBody = body(print, TABLOID);
    for (const [k, result] of small.entries()) {
      const report = probe(result.parts, result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
      expect(body(result, frameOf(fits[k]))).toBeLessThan(printBody - 0.15);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its
    // hatch pitches, blade gaps and bolt shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) }));
    const denser = denserThan(probe(shrunk, print), master).map(p => p.id);
    for (const id of ['machine-carbon', 'system-carbon', 'helix-violet', 'bolt-carbon']) expect(denser).toContain(id);
  }, 120_000);
});
