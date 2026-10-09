import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { TABLOID_FORMAT, formatFor, type Fit } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { Point, RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/ii-high-priestess/sketch.ts');

describe('Breach Tarot: II The High Priestess', () => {
  it('replays, stays inside the card, and draws the sky, the pillars, the lintel, the helix cable, the unwinding veil, the shadow, the phrase and the frame', async () => {
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
    for (const id of ['horizon-carbon', 'veil-ultramarine', 'shadow-carbon', 'card-frame']) expect(ids).toContain(id);
    for (const prefix of ['sky-', 'floor-', 'dark-', 'light-', 'lintel-', 'helix-', 'unwind-', 'slogan-']) expect(ids.some(id => id.startsWith(prefix))).toBe(true);
  }, 60_000);

  it('opens the horizon at both card edges, so any three cards side by side make one landscape', async () => {
    const result = await renderSketch({ entry, seed: 2 });
    const xs = result.parts.find(p => p.id === 'horizon-carbon')!.paths.flatMap(path => path.map(p => p.x));
    expect(Math.min(...xs)).toBeLessThanOrEqual(CARD.x0 + 2);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(CARD.x1 - 2);
  }, 60_000);
});

describe('Breach Tarot: II The High Priestess at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none.
  const render = (fit: Fit) => renderSketch({ entry, seed: 2, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const points = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths.flat());
  const box = (ps: Point[]) => ({ x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)) });
  const length = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix))
    .reduce((sum, part) => sum + part.paths.reduce((t, path) => t + path.slice(1).reduce((u, q, i) => u + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0), 0), 0);
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  const geometry = JSON.stringify(resolve('sketches/breach-tarot/ii-high-priestess/geometry.ts'));
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

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
      // Paths wholly inside the art window, per part of the scene: the sky, the floor, both pillars, the lintel, the
      // cable, the unwinding, the veil, the shadow, the horizon either side of the temple.
      const inWindow = (prefix: string) => first.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 60, 'floor-': 6, 'dark-': 80, 'light-': 10, 'lintel-': 5, 'helix-': 1, 'unwind-': 15, 'veil-': 30, 'shadow-': 28, 'horizon-': 1 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), prefix).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('builds the same seeded world at every size and fit: the layout, every course of the temple, the veil, the cable, the floor and the shadow', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-priestess-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { priestessWorld, tesseractShadow } from ${geometry};
      export default { name: 'priestess-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [{ type: 'slider', id: 'distance', label: 'Distance', default: 90, min: 50, max: 220, step: 1 },
          { type: 'slider', id: 'lintelTop', label: 'Lintel', default: 62, min: 46, max: 100, step: 0.5 },
          { type: 'select', id: 'darkSide', label: 'Dark', default: 'seed', options: ['seed', 'left', 'right'] }],
        draw(ctx) {
          const w = priestessWorld(ctx), l = w.lay, h = createHash('sha256');
          h.update([l.f, l.u, l.distance, l.cx, l.groundY, l.pillarCentre, l.pillarWidth, l.lintelTop, ';'].join(','));
          for (const p of w.temple.pillars) {
            h.update([p.side, p.dark, ';'].join(','));
            for (const c of p.courses) h.update([c.y, c.h, c.widen, c.tone, c.face, ';'].join(','));
          }
          h.update([w.temple.lintel.span, ';'].join(','));
          for (const c of w.temple.lintel.courses) h.update([c.y, c.h, c.inset, c.tone, ';'].join(','));
          h.update([w.veil.half, w.veil.top, w.veil.bottom, w.cable.z, w.cable.end, ';'].join(','));
          for (const p of w.cable.points) h.update([p.x, p.y, p.z, ';'].join(','));
          for (const j of w.joints) h.update([j.x, j.cell, j.dashes.join(''), ';'].join(','));
          const t = tesseractShadow(ctx);
          h.update(JSON.stringify(t.pose));
          for (const p of t.pts) h.update([p.x, p.y, ';'].join(','));
          const d = h.digest();
          const [left, right] = w.temple.pillars.map(p => p.courses.length);
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + left / 10, y: 20 + right / 10 }, { x: 20 + w.joints.length / 10, y: 20 + w.temple.lintel.courses.length / 10 }]] }];
        } };`);
    for (const params of [{}, { darkSide: 'right', distance: 50 }, { lintelTop: 100, distance: 220 }] as Record<string, unknown>[]) {
      const [print, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 2, params: params as never }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 2, params: params as never, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      const counts = print.parts.find(part => part.id === 'counts')!.paths[0];
      // Each pillar has dozens of courses; the floor seven joints, the lintel two courses.
      expect(counts[1].x).toBeGreaterThan(20 + 30 / 10);
      expect(counts[1].y).toBeGreaterThan(20 + 30 / 10);
      expect(counts[2].x).toBeCloseTo(20 + 7 / 10, 6);
      expect(counts[2].y).toBeCloseTo(20 + 2 / 10, 6);
      for (const result of small) for (const id of ['digest', 'counts']) {
        expect(result.parts.find(part => part.id === id)!.paths, `${JSON.stringify(params)} ${id}`).toEqual(print.parts.find(part => part.id === id)!.paths);
      }
    }
  }, 120_000);

  it('still reads as the High Priestess: the dark pillar and the pale one where the print has them, the veil between them under the lintel, the cable down the axis into the unwinding, the shadow on the veil', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    const parts = ['dark-', 'light-', 'lintel-', 'veil-', 'shadow-'] as const;
    const printBox = Object.fromEntries(parts.map(prefix => [prefix, box(points(print, prefix))]));
    const centre = TABLOID_PAGE.width / 2;
    for (const [k, result] of small.entries()) {
      const { card, horizonY, s } = formatOf(fits[k]);
      // Each part's box back in tabloid's frame (from the window's centre line and the horizon).
      const x = (v: number) => centre + (v - page.width / 2) / s, y = (v: number) => TABLOID_FORMAT.horizonY + (v - horizonY) / s;
      const here = Object.fromEntries(parts.map(prefix => {
        const b = box(points(result, prefix));
        return [prefix, { x0: x(b.x0), x1: x(b.x1), y0: y(b.y0), y1: y(b.y1) }];
      }));
      // The pillars stand where the print's do, the dark one on its side (the left, at seed 2): as wide, as tall, on the ground.
      expect(here['dark-'].x1).toBeLessThan(centre);
      expect(here['light-'].x0).toBeGreaterThan(centre);
      for (const prefix of ['dark-', 'light-']) {
        expect(Math.abs(here[prefix].x0 - printBox[prefix].x0), `${prefix} x0`).toBeLessThan(1);
        expect(Math.abs(here[prefix].x1 - printBox[prefix].x1), `${prefix} x1`).toBeLessThan(1);
        expect(Math.abs(here[prefix].y0 - printBox[prefix].y0), `${prefix} y0`).toBeLessThan(2);
        expect(Math.abs(here[prefix].y1 - printBox[prefix].y1), `${prefix} y1`).toBeLessThan(2);
      }
      // The veil hangs between them, as the print's does, under the lintel, whose top and ends are the print's.
      for (const edge of ['x0', 'x1', 'y1'] as const) expect(Math.abs(here['veil-'][edge] - printBox['veil-'][edge]), `veil ${edge}`).toBeLessThan(1);
      expect(Math.abs(here['veil-'].y0 - printBox['veil-'].y0)).toBeLessThan(2);
      expect(here['veil-'].x0).toBeGreaterThan((here['dark-'].x0 + here['dark-'].x1) / 2);
      expect(here['veil-'].x1).toBeLessThan((here['light-'].x0 + here['light-'].x1) / 2);
      for (const edge of ['x0', 'x1', 'y0'] as const) expect(Math.abs(here['lintel-'][edge] - printBox['lintel-'][edge]), `lintel ${edge}`).toBeLessThan(2);
      expect(here['lintel-'].y0).toBeLessThan(here['veil-'].y0);
      // The shadow lies on the veil a little above its middle, where the print's does.
      for (const edge of ['x0', 'x1', 'y0', 'y1'] as const) expect(Math.abs(here['shadow-'][edge] - printBox['shadow-'][edge]), `shadow ${edge}`).toBeLessThan(1);
      expect((here['shadow-'].y0 + here['shadow-'].y1) / 2).toBeLessThan((here['veil-'].y0 + here['veil-'].y1) / 2);
      // The cable comes down the axis from the top of the window and ends where the unwinding begins.
      const cable = box(points(result, 'helix-')), unwinding = box(points(result, 'unwind-'));
      expect(Math.abs((cable.x0 + cable.x1) / 2 - page.width / 2)).toBeLessThan(1);
      expect(cable.y0).toBeLessThan(card.y0 + 0.5);
      expect(Math.abs(cable.y1 - unwinding.y0)).toBeLessThan(1.5);
      // The sky above the horizon, the floor below it, the horizon out to both edges of the card.
      expect(Math.max(...points(result, 'sky-').map(p => p.y))).toBeLessThan(horizonY);
      expect(Math.min(...points(result, 'floor-').map(p => p.y))).toBeGreaterThan(horizonY);
      const horizon = points(result, 'horizon-').map(p => p.x);
      expect(Math.min(...horizon)).toBeLessThan(card.x0 + 0.5);
      expect(Math.max(...horizon)).toBeGreaterThan(card.x1 - 0.5);
      // One pillar dark, one pale: the dark one carries several times the pale one's ink, as on the print.
      expect(length(result, 'dark-')).toBeGreaterThan(2.5 * length(result, 'light-'));
    }
  }, 120_000);

  it('keeps the print’s tones where the port scaled them: fewer, taller courses with the print’s reveal, the rulings at the print’s pitch, the cable by its spines, the shadow by its edges', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-priestess-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: each pillar's seeded and drawn courses as points (20 + base / 10, 20 + height / 10, in tabloid
    // millimetres) after a first point at (20, 20), the lintel's the same, and the face each drawn slab of the left
    // pillar keeps under its joint.
    await writeFile(probeEntry, `import { drawnCourses, drawnLintel, drawnTemple, priestessWorld } from ${geometry};
      export default { name: 'priestess-courses', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }], controls: [],
        draw(ctx) {
          const w = priestessWorld(ctx);
          const at = cs => [{ x: 20, y: 20 }, ...cs.map(c => ({ x: 20 + c.y / 10, y: 20 + c.h / 10 }))];
          const [left, right] = w.temple.pillars.map(p => p.courses);
          const faces = drawnTemple(w.lay, w.temple).slabs.slice(0, drawnCourses(left).length).map((sl, i) => ({ x: 20 + i / 10, y: 20 + sl.h / w.lay.u / 10 }));
          return [{ id: 'left', pen: 'ink', paths: [at(left), at(drawnCourses(left))] }, { id: 'right', pen: 'ink', paths: [at(right), at(drawnCourses(right))] },
            { id: 'lintel', pen: 'ink', paths: [at(w.temple.lintel.courses), at(drawnLintel(w.temple.lintel.courses))] }, { id: 'faces', pen: 'ink', paths: [faces] }];
        } };`);
    type Course = { y: number; h: number };
    const courses = (result: RenderResult, id: string): Course[][] => result.parts.find(part => part.id === id)!.paths.map(path => path.slice(1).map(p => ({ y: 10 * (p.x - 20), h: 10 * (p.y - 20) })));
    const [coursesPrint, ...coursesSmall] = await Promise.all([
      renderSketch({ entry: probeEntry, seed: 2 }),
      ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 2, finishing: { page }, format: { fit } })),
    ]);
    // The print draws every seeded course.
    for (const id of ['left', 'right', 'lintel']) expect(courses(coursesPrint, id)[1]).toEqual(courses(coursesPrint, id)[0]);
    const near = (a: number, b: number) => Math.abs(a - b) < 0.02;
    for (const [k, result] of coursesSmall.entries()) {
      const { s } = formatOf(fits[k]);
      for (const id of ['left', 'right']) {
        const [seeded, drawn] = courses(result, id);
        expect(seeded).toEqual(courses(coursesPrint, id)[0]);
        // Every drawn course starts on a seeded joint, and the drawn ones tile the pillar.
        for (const c of drawn) expect(seeded.some(q => near(q.y, c.y)), `${id} ${c.y}`).toBe(true);
        for (let i = 1; i < drawn.length; i++) expect(near(drawn[i].y, drawn[i - 1].y + drawn[i - 1].h)).toBe(true);
        // The plinth and the capital are one course each, their shallow steps joined: 8 mm of tabloid's.
        expect(seeded[0].h).toBeCloseTo(4.5, 1);
        expect(drawn[0].h).toBeCloseTo(8, 1);
        expect(drawn.at(-1)!.h).toBeCloseTo(8, 1);
        // The shaft draws a quarter or so of its courses, each at least as tall on paper as the print's shortest (2.9 mm,
        // where the seeded ones would be under 1 mm), none much taller than its tallest (7.2 mm).
        const seededShaft = seeded.slice(2, -2), shaft = drawn.slice(1, -1);
        expect(shaft.length, id).toBeLessThan(0.4 * seededShaft.length);
        expect(shaft.length, id).toBeGreaterThan(0.15 * seededShaft.length);
        expect(Math.min(...seededShaft.map(c => c.h * s))).toBeLessThan(1);
        expect(Math.min(...shaft.map(c => c.h * s))).toBeGreaterThan(2.89);
        expect(Math.max(...shaft.map(c => c.h * s))).toBeLessThan(7.8);
      }
      // The lintel's cap, under a millimetre on paper, joins the beam.
      const [lintelSeeded, lintelDrawn] = courses(result, 'lintel');
      expect(lintelSeeded.length).toBe(2);
      expect(lintelDrawn.length).toBe(1);
      expect(lintelDrawn[0].h).toBeCloseTo(12, 1);
      // Each joint keeps the print's half-millimetre reveal on paper.
      const faces = result.parts.find(part => part.id === 'faces')!.paths[0].map(p => 10 * (p.y - 20));
      const drawn = courses(result, 'left')[1];
      expect(faces.length).toBe(drawn.length);
      for (const [i, face] of faces.entries()) expect((drawn[i].h - face) * s).toBeCloseTo(0.5, 2);
    }
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    // On the print the cable's strands are ribbons with laminations, and the shadow's edges hatched bands.
    expect(print.parts.some(part => part.id === 'helix-violet' || part.id === 'helix-ultramarine')).toBe(true);
    expect(print.parts.find(part => part.id === 'shadow-carbon')!.paths.length).toBeGreaterThan(500);
    for (const result of small) {
      // Here the strands are narrower on paper than the smallest feature: each is drawn by its spine.
      expect(result.parts.filter(part => part.id.startsWith('helix-')).map(part => part.id).sort()).toEqual(['helix-acid', 'helix-vermilion']);
      expect(result.parts.filter(part => part.id.startsWith('helix-')).reduce((n, part) => n + part.paths.length, 0)).toBeLessThanOrEqual(4);
      // The shadow's bands, a fraction of a millimetre across, are its 32 edges as single lines, not outlines and hatch.
      const shadow = result.parts.find(part => part.id === 'shadow-carbon')!.paths.length;
      expect(shadow).toBeGreaterThanOrEqual(32);
      expect(shadow).toBeLessThan(64);
      // The sky's ruling keeps the print's 0.62 mm on paper, and the veil's threads their 0.95 mm or so.
      const rows = [...new Set(points(result, 'sky-').map(p => Math.round(p.y * 1000) / 1000))].sort((a, b) => a - b);
      expect(Math.min(...rows.slice(1).map((row, i) => row - rows[i]))).toBeCloseTo(0.62, 2);
      const threads = [...new Set(result.parts.find(part => part.id === 'veil-ultramarine')!.paths.map(path => Math.round(path.at(-1)!.x * 100) / 100))].sort((a, b) => a - b);
      const pitch = (threads.at(-1)! - threads[0]) / (threads.length - 1);
      expect(pitch).toBeGreaterThan(0.9);
      expect(pitch).toBeLessThan(1.05);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 2 }), ...fits.map(render)]);
    const master = probe(print);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its rulings,
    // threads, rings and joints shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...print, parts: print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['sky-carbon', 'dark-carbon', 'light-carbon', 'veil-ultramarine', 'shadow-carbon']) expect(denser).toContain(id);
  }, 120_000);

  it('draws in the fit it prefers, height, where the render names none', async () => {
    const [plain, height] = await Promise.all([renderSketch({ entry, seed: 2, finishing: { page }, timeoutMs: 120_000 }), render('height')]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.parts).toEqual(height.parts);
  }, 120_000);
});
