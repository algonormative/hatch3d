import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { TABLOID_FORMAT, formatFor, type Fit } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { Point, RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/v-hierophant/sketch.ts');
const points = (parts: { id: string; paths: { x: number; y: number }[][] }[], match: (id: string) => boolean) =>
  parts.filter(p => match(p.id)).flatMap(p => p.paths.flat());

describe('Breach Tarot: V The Hierophant', () => {
  it('replays, stays inside the card, and draws the sky, the wall, the piers, the lanes, the gate, the helix, the fine print, the phrase and the frame', async () => {
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
    for (const id of ['sky-carbon', 'wall-carbon', 'pier-carbon', 'lane-carbon', 'gate-ultramarine', 'print-lettering', 'slogan-lettering', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('stands the gate off centre and threads the helix through it: the slot lies outside the middle third, the thread passes inside it, and shows below the wall top on the near side and above it in the sky', async () => {
    const { parts } = await renderSketch({ entry, seed: 2 });
    const third = (CARD.x1 - CARD.x0) / 3;
    const slot = points(parts, id => id === 'gate-ultramarine');
    expect(slot.length).toBeGreaterThan(0);
    for (const p of slot) expect(p.x < CARD.x0 + third || p.x > CARD.x1 - third).toBe(true);
    const slotX = [Math.min(...slot.map(p => p.x)), Math.max(...slot.map(p => p.x))];
    const slotY = [Math.min(...slot.map(p => p.y)), Math.max(...slot.map(p => p.y))];
    const helix = points(parts, id => id.startsWith('helix-'));
    // The thread comes through the slot itself.
    expect(helix.filter(p => p.x > slotX[0] && p.x < slotX[1] && p.y > slotY[0] && p.y < slotY[1]).length).toBeGreaterThan(20);
    // Below the wall's top it runs across the foreground; above it, it climbs into the sky.
    const wallTop = Math.min(...points(parts, id => id === 'wall-carbon').map(p => p.y));
    expect(helix.filter(p => p.y > HORIZON_Y).length).toBeGreaterThan(50);
    expect(helix.filter(p => p.y < wallTop).length).toBeGreaterThan(50);
  }, 60_000);
});

describe('Breach Tarot: V The Hierophant at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none.
  const render = (fit: Fit) => renderSketch({ entry, seed: 2, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const of = (result: RenderResult, match: (id: string) => boolean) => points(result.parts, match);
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  const box = (ps: Point[]) => ({ x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)) });
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: which way the wall turns, every slab, the lanes in plan and the thread’s course', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-hierophant-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { hierophantWorld } from ${JSON.stringify(resolve('sketches/breach-tarot/v-hierophant/geometry.ts'))};
      export default { name: 'hierophant-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [{ type: 'select', id: 'side', label: 'Side', default: 'seed', options: ['seed', 'left', 'right'] },
          { type: 'slider', id: 'lanes', label: 'Lanes', default: 12, min: 3, max: 16, step: 1 }],
        draw(ctx) {
          const w = hierophantWorld(ctx), h = createHash('sha256');
          const v = p => h.update([p.x, p.y, p.z, ';'].join(','));
          h.update(String(w.sx)); v(w.wall.G);
          for (const pc of w.wall.pieces) { const s = pc.slab; h.update([pc.kind, pc.side, pc.course, pc.sealed, s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.tone, ';'].join(',')); }
          for (const leaf of w.lanes.leaves) for (const line of [leaf.left, leaf.right, leaf.centre]) line.forEach(v);
          for (const line of [w.thread.near, w.thread.slot, w.thread.climb]) line.forEach(v);
          const d = h.digest(), wings = w.wall.pieces.filter(pc => pc.kind === 'wing').length;
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.wall.pieces.length / 10, y: 20 + w.lanes.leaves.length / 10 }, { x: 20 + wings / 100, y: 20 }]] }];
        } };`);
    // The print's world, its mirror, and the most lanes.
    for (const params of [{}, { side: 'left' }, { lanes: 16 }] as Record<string, string | number>[]) {
      const [print, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 2, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 2, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      const counts = print.parts.find(part => part.id === 'counts')!.paths[0];
      expect(counts[1].x).toBeGreaterThan(20 + 20 / 10);
      expect(counts[1].y).toBeGreaterThan(20 + 2 / 10);
      for (const result of small) for (const id of ['digest', 'counts']) {
        expect(result.parts.find(part => part.id === id)!.paths, `${JSON.stringify(params)} ${id}`).toEqual(print.parts.find(part => part.id === id)!.paths);
      }
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
      // Paths wholly inside the art window, per part of the scene: the sky, the horizon, the wall, the piers, the lanes,
      // the gate, the thread and the fine print.
      const inWindow = (prefix: string) => first.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 40, 'horizon-': 0, 'wall-': 25, 'pier-': 90, 'lane-': 60, 'gate-': 5, 'helix-': 40, 'print-': 60 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = of(first, id => id === 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as the Hierophant: the gate off centre with the thread pinched to one line through it, the wall off the near side, the V opening above the wall with both tips inside the window, each coming to a point', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    for (const [i, result] of small.entries()) {
      const { card, horizonY, s } = formatOf(fits[i]);
      const third = (card.x1 - card.x0) / 3;
      const slot = of(result, id => id.startsWith('gate-'));
      for (const p of slot) expect(p.x < card.x0 + third || p.x > card.x1 - third).toBe(true);
      const gate = box(slot);
      const helix = of(result, id => id.startsWith('helix-'));
      // The thread comes through the slot itself, a single line: one crossing at each of three heights up it (the print
      // shows its strands there, four or five lines).
      expect(helix.filter(p => p.x > gate.x0 && p.x < gate.x1 && p.y > gate.y0 && p.y < gate.y1).length).toBeGreaterThan(10);
      for (const t of [0.3, 0.5, 0.7]) {
        const y = gate.y0 + t * (gate.y1 - gate.y0);
        const crossings = result.parts.filter(part => part.id.startsWith('helix-')).flatMap(part => part.paths)
          .flatMap(path => path.slice(1).flatMap((b, k) => {
            const a = path[k];
            return (a.y - y) * (b.y - y) <= 0 && a.y !== b.y ? [a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y)] : [];
          }))
          .filter(x => x > gate.x0 - 1 && x < gate.x1 + 1);
        expect(crossings.length, `${fits[i]} at ${t}`).toBe(1);
      }
      // The wall runs off the near (right) side and stops short of the open side, where the horizon shows.
      const wall = box(of(result, id => id === 'wall-carbon'));
      expect(wall.x1).toBeGreaterThan(card.x1 - 0.01);
      expect(Math.min(...of(result, id => id === 'horizon-carbon').map(p => p.x))).toBeLessThan(card.x0 + 0.5);
      // Below the wall's top the thread runs across the foreground; above it, it opens into a V in the sky.
      expect(helix.filter(p => p.y > horizonY).length).toBeGreaterThan(50);
      const sky = helix.filter(p => p.y < wall.y0), v = box(sky);
      expect(sky.length).toBeGreaterThan(30);
      expect(v.x1 - v.x0).toBeGreaterThan(5);
      // Both tips inside the window, clear of its edges by most of the end margin (9 mm on the print, in proportion).
      expect(v.x0).toBeGreaterThan(card.x0 + 0.8 * 9 * s);
      expect(v.x1).toBeLessThan(card.x1 - 0.8 * 9 * s);
      expect(v.y0).toBeGreaterThan(card.y0 + 0.8 * 9 * s);
      // Each arm comes to a point between its two edges, as on the print: at each tip (the highest end of a vermilion
      // line, and the highest a few millimetres across from it) two lines end together.
      const ends = result.parts.filter(part => part.id === 'helix-vermilion').flatMap(part => part.paths)
        .flatMap(path => [path[0], path.at(-1)!]).filter(p => p.y < wall.y0).sort((a, b) => a.y - b.y);
      const first = ends[0], second = ends.find(p => Math.abs(p.x - first.x) > 3)!;
      for (const tip of [first, second]) expect(ends.filter(p => Math.hypot(p.x - tip.x, p.y - tip.y) < 0.1).length, `${fits[i]} tip`).toBeGreaterThanOrEqual(2);
      // Kept to its width, the card's V is the print's: back in tabloid's frame, as wide and as high, within a millimetre.
      if (fits[i] === 'width') {
        const printV = box(of(print, id => id.startsWith('helix-')).filter(p => p.y < box(of(print, id => id === 'wall-carbon')).y0));
        expect(Math.abs((v.x1 - v.x0) / s - (printV.x1 - printV.x0))).toBeLessThan(1);
        expect(Math.abs(TABLOID_FORMAT.horizonY + (v.y0 - horizonY) / s - printV.y0)).toBeLessThan(1);
      }
    }
  }, 120_000);

  it('keeps the print’s tones where the port held them on paper: the sky’s ruling and the gate’s fill at their pitch, the fine print’s letters at their size and its rows in proportion', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    const length = (r: RenderResult, id: string) => r.parts.filter(part => part.id === id).flatMap(part => part.paths)
      .reduce((sum, path) => sum + path.slice(1).reduce((l, q, k) => l + Math.hypot(q.x - path[k].x, q.y - path[k].y), 0), 0);
    for (const [i, result] of small.entries()) {
      const { s } = formatOf(fits[i]);
      // The sky's rules 1.4 mm apart and the gate's fill 0.5 mm, as on the print (shrunk with the card, 0.4 and 0.14).
      const gaps = (values: number[]) => { const v = [...new Set(values.map(x => Math.round(x * 1000) / 1000))].sort((a, b) => a - b); return v.slice(1).map((x, k) => x - v[k]); };
      expect(Math.min(...gaps(result.parts.filter(part => part.id === 'sky-carbon').flatMap(part => part.paths).map(path => path[0].y)))).toBeGreaterThan(1.39);
      expect(Math.min(...gaps(result.parts.filter(part => part.id.startsWith('gate-')).flatMap(part => part.paths).map(path => path[0].x)))).toBeGreaterThan(0.49);
      // The fine print's letters are the print's size: its tallest strokes (an ascender to a descender) over 1.8 mm.
      const tallest = Math.max(...result.parts.filter(part => part.id === 'print-lettering').flatMap(part => part.paths).map(path => box(path).y1 - box(path).y0));
      expect(tallest).toBeGreaterThan(1.8);
      // And it is still a tone: a smaller face keeps a share of the print's rows, at their pitch, so the card carries
      // between 0.4 and 1.25 times the print's ink in proportion to its area (s squared of it): every row kept would
      // pack them four times as close, every eighth would leave the faces half bare.
      const tone = length(result, 'print-lettering') / (length(print, 'print-lettering') * s * s);
      expect(tone).toBeGreaterThan(0.4);
      expect(tone).toBeLessThan(1.25);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card without its pitches holding is', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    const master = probe(print);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its sky ruling,
    // course joints, pier hatch, lanes and gate fill shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...print, parts: print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['sky-carbon', 'wall-carbon', 'pier-carbon', 'lane-carbon', 'gate-ultramarine']) expect(denser).toContain(id);
  }, 120_000);

  it('draws in its preferred fit, the width, where the render names none', async () => {
    const [plain, width] = await Promise.all([
      renderSketch({ entry, seed: 2, finishing: { page }, timeoutMs: 120_000 }),
      render('width'),
    ]);
    expect(plain.parts).toEqual(width.parts);
  }, 120_000);
});
