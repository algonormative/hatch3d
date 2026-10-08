import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';
import { shear } from '../../sketches/breach-tarot/xvi-tower/geometry.ts';

const entry = resolve('sketches/breach-tarot/xvi-tower/sketch.ts');

type Pt = { x: number; y: number };
type Parts = { id: string; paths: Pt[][] }[];
const ink = (parts: Parts, prefixes: string[]) => parts.filter(p => prefixes.some(q => p.id.startsWith(q))).flatMap(p => p.paths);
/** A point every half millimetre along each path. */
function dense(paths: Pt[][]): Pt[] {
  const out: Pt[] = [];
  for (const path of paths) for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5));
    for (let j = 0; j <= k; j++) out.push({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k });
  }
  return out;
}
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

/**
 * The machine form read off the render. The helix: where its ink starts and ends on the card, the
 * longest stretch of height it leaves blank, and how wide it shows through the machine's body
 * against its width in the open sky. The bolt: how many of its points fall inside the silhouette of
 * what stands (machine, lid, ticks, words and helix), read row by row as the spans of their ink.
 */
async function machine(params: Record<string, unknown> = {}) {
  const { parts } = await renderSketch({ entry, seed: 2, params } as never);
  const helix = dense(ink(parts, ['helix-']));
  const ys = helix.map(p => p.y);
  const top = Math.min(...ys), low = Math.max(...ys);
  const bins = new Set(ys.map(y => Math.floor(y / 2)));
  let gap = 0;
  for (let b = Math.floor(top / 2), run = 0; b <= Math.floor(low / 2); b++) gap = Math.max(gap, run = bins.has(b) ? 0 : run + 2);
  const extent = (y0: number, y1: number) => {
    const widths: number[] = [];
    for (let y = y0; y < y1; y += 2) {
      const xs = helix.filter(p => p.y >= y && p.y < y + 2).map(p => p.x);
      widths.push(xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
    }
    return median(widths);
  };
  const body = extent(HORIZON_Y - 40, HORIZON_Y), sky = extent(CARD.y0 + 5, CARD.y0 + 45);
  const centre = helix.reduce((s, p) => s + p.x, 0) / helix.length - (CARD.x0 + CARD.x1) / 2;
  const rows = new Map<number, number[]>();
  for (const p of dense(ink(parts, ['machine-', 'lights-', 'helix-', 'slogan-']))) {
    const r = Math.round(p.y);
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r)!.push(p.x);
  }
  const spans = new Map<number, [number, number][]>();
  for (const [r, xs] of rows) {
    const out: [number, number][] = [];
    for (const x of xs.sort((a, b) => a - b)) {
      const last = out[out.length - 1];
      if (last && x - last[1] <= 6) last[1] = x; else out.push([x, x]);
    }
    spans.set(r, out);
  }
  const bolt = dense(ink(parts, ['bolt-']));
  const inFront = bolt.filter(p => (spans.get(Math.round(p.y)) ?? []).some(([a, b]) => p.x > a + 0.5 && p.x < b - 0.5)).length;
  return { parts, top, low, gap, body, sky, centre, bolt: bolt.length, inFront };
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
