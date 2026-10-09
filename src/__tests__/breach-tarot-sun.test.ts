import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { FINE_FLOOR } from '../../sketches/breach-tarot/xix-sun/geometry.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { formatFor, type Fit } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { Point, RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/xix-sun/sketch.ts');

describe('Breach Tarot: XIX The Sun', () => {
  it('replays, stays inside the card, and draws the disc, both kinds of ray, the wall shadow, the phrase and the frame', async () => {
    const first = await renderSketch({ entry, seed: 1 });
    const replay = await renderSketch({ entry, seed: 1 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(CARD.top - 0.01);
      expect(p.y).toBeLessThanOrEqual(CARD.bottom + 0.01);
    }
    const ids = first.parts.map(p => p.id);
    for (const id of ['disc-vermilion', 'shadow-carbon', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('waves-'))).toBe(true);
    expect(ids.some(id => id.startsWith('rays-'))).toBe(true);
    expect(ids.some(id => id.startsWith('slogan-'))).toBe(true);
  }, 30_000);

  it('keeps the disc blown out: nothing is drawn inside the sun but its rim', async () => {
    const result = await renderSketch({ entry, seed: 1 });
    const rim = result.parts.find(p => p.id === 'disc-vermilion')!.paths.flat();
    const cx = rim.reduce((t, p) => t + p.x, 0) / rim.length, cy = rim.reduce((t, p) => t + p.y, 0) / rim.length;
    const r = Math.min(...rim.map(p => Math.hypot(p.x - cx, p.y - cy)));
    const inside = result.parts.filter(p => p.id !== 'disc-vermilion').flatMap(p => p.paths.flat()).filter(p => Math.hypot(p.x - cx, p.y - cy) < r - 0.5);
    expect(r).toBeGreaterThan(20);
    expect(inside).toEqual([]);
  }, 30_000);
});

describe('Breach Tarot: XIX The Sun at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none. One render per fit, and one print, shared.
  const renders = new Map<string, Promise<RenderResult>>();
  const once = (key: string, run: () => Promise<RenderResult>) => { if (!renders.has(key)) renders.set(key, run()); return renders.get(key)!; };
  const render = (fit: Fit) => renderSketch({ entry, seed: 1, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const rendered = (fit: Fit) => once(fit, () => render(fit));
  const print = () => once('print', () => renderSketch({ entry, seed: 1, timeoutMs: 120_000 }));
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const all = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths);
  const points = (result: RenderResult, prefix: string) => all(result, prefix).flat();
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  /** Points every `step` mm along some paths. */
  const along = (paths: Point[][], step = 0.05): Point[] => paths.flatMap(path => path.flatMap((b, i) => {
    if (!i) return [b];
    const a = path[i - 1], n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
    return Array.from({ length: n }, (_, k) => ({ x: a.x + (b.x - a.x) * (k + 1) / n, y: a.y + (b.y - a.y) * (k + 1) / n }));
  }));
  /** The nearest any point of `a` comes to any of `b`, by a millimetre grid. */
  const nearest = (a: Point[], b: Point[]) => {
    const cells = new Map<string, Point[]>();
    for (const q of b) { const key = `${Math.floor(q.x)},${Math.floor(q.y)}`; if (!cells.has(key)) cells.set(key, []); cells.get(key)!.push(q); }
    let best = Infinity;
    for (const p of a) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const q of cells.get(`${Math.floor(p.x) + dx},${Math.floor(p.y) + dy}`) ?? []) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    }
    return best;
  };
  /** The disc's rim: its centre, from its extent, and each ring's mean radius, outermost first. */
  const rim = (result: RenderResult) => {
    const rings = all(result, 'disc-'), ps = rings.flat();
    const xs = ps.map(p => p.x), ys = ps.map(p => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const radii = rings.map(ring => ring.reduce((sum, p) => sum + Math.hypot(p.x - cx, p.y - cy), 0) / ring.length).sort((a, b) => b - a);
    return { cx, cy, radii };
  };
  /** The fine rays by direction from the disc's centre: the count of directions more than a degree apart. */
  const fineRays = (result: RenderResult) => {
    const { cx, cy } = rim(result);
    const angles = all(result, 'radiance-').map(path => {
      const m = path[Math.floor(path.length / 2)];
      return Math.atan2(m.y - cy, m.x - cx) * 180 / Math.PI;
    }).sort((a, b) => a - b);
    return angles.filter((a, i) => i === 0 || a - angles[i - 1] > 1).length - (angles.length && angles[0] + 360 - angles.at(-1)! <= 1 ? 1 : 0);
  };
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

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
      // Paths wholly inside the art window, per part of the scene: the fine rays, the rim, the straight rays and the waves,
      // the wall, its shadow, the cracked desert and the horizon through the breach.
      const inWindow = (prefix: string) => all(first, prefix)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'radiance-': 45, 'disc-': 1, 'rays-': 50, 'waves-': 5, 'wall-': 80, 'shadow-': 4, 'ground-': 60, 'horizon-': 0 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), `${fit} ${prefix}`).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('builds the same seeded world at every size and fit: the wall, the sun\'s rays and waves about its centre, and the desert\'s plates', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-sun-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: digests of the wall and of the plates the desert keeps (their world rings), their counts, and the
    // sun in world units about its centre (each straight ray's slab, each wave's strand and its turn onto the ray), as
    // points; and the fine rays and rim rings the format draws.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { RIM_RINGS, fineRays, plates, sun, sunCamera, wall } from ${JSON.stringify(resolve('sketches/breach-tarot/xix-sun/geometry.ts'))};
      const digest = (values) => { const d = createHash('sha256').update(values.join(';')).digest(); return Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 })); };
      export default { name: 'sun-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [{ type: 'slider', id: 'cracks', label: 'Crack plate size', default: 0.5, min: 0, max: 1, step: 0.01 }],
        draw(ctx) {
          const view = sunCamera(ctx), s = sun(ctx, view), w = wall(ctx), kept = plates(ctx, view, w), c = s.centre;
          // Two numbers to a short path of its own, inside both pages' margins (18 mm on tabloid).
          const at = (x, y) => [{ x: 42 + x / 2, y: 60 + y / 2 }, { x: 43 + x / 2, y: 61 + y / 2 }];
          const rays = s.rays.flatMap(r => [at(r.x - c.x, r.y - c.y), at(r.z - c.z, r.rz), at(r.w, r.h), at(r.d, r.tone)]);
          const waves = s.waves.flatMap(({ strand: t, turn }) => { const e = turn.elements;
            return [at(e[12] - c.x, e[13] - c.y), at(e[14] - c.z, e[0]), at(e[1], t.phase), at(t.turns, t.y1), at(t.radius, t.width)]; });
          return [{ id: 'wall', pen: 'ink', paths: [digest(w.slabs.map(sl => [sl.x, sl.y, sl.z, sl.w, sl.h, sl.d, sl.rx, sl.ry, sl.rz, sl.role, sl.tone].join(',')))] },
            { id: 'plates', pen: 'ink', paths: [digest(kept.map(p => [p.index, ...p.ring.flatMap(v => [v.x, v.z])].join(',')))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.slabs.length / 10, y: 20 + kept.length / 100 }, { x: 20 + s.rays.length / 10, y: 20 + s.waves.length / 10 }]] },
            { id: 'radius', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + s.radius, y: 20 + w.breach[1] - w.breach[0] }]] },
            { id: 'rays', pen: 'ink', paths: rays }, { id: 'waves', pen: 'ink', paths: waves },
            { id: 'drawn', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + fineRays(ctx) / 10, y: 20 + RIM_RINGS }]] }];
        } };`);
    const parts = (result: RenderResult, id: string) => result.parts.find(part => part.id === id)?.paths ?? [];
    // The render keeps three decimals: equal to a unit of the last.
    const near = (a: Point[][], b: Point[][]) => a.length === b.length && a.every((path, i) => path.length === b[i].length
      && path.every((p, j) => Math.abs(p.x - b[i][j].x) < 0.0015 && Math.abs(p.y - b[i][j].y) < 0.0015));
    // The default, and the desert's smallest plates, where the print's paper leaves out the most of them: the plates it
    // keeps set what exists at every size.
    for (const params of [{}, { cracks: 0 }] as Record<string, number>[]) {
      const [tabloid, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 1, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 1, params, finishing: { page }, format: { fit } })),
      ]);
      const counts = parts(tabloid, 'counts')[0];
      // Some thirty-odd slabs of wall, hundreds of plates, five straight rays of three steps and six waves.
      expect(counts[1].x).toBeGreaterThan(20 + 30 / 10);
      expect(counts[1].y).toBeGreaterThan(20 + 100 / 100);
      expect(counts[2]).toEqual({ x: 20 + 15 / 10, y: 20 + 6 / 10 });
      for (const [k, result] of small.entries()) {
        const label = `${JSON.stringify(params)} ${fits[k]}`;
        for (const id of ['wall', 'plates', 'counts']) expect(parts(result, id), `${label} ${id}`).toEqual(parts(tabloid, id));
        for (const id of ['radius', 'rays', 'waves']) expect(near(parts(result, id), parts(tabloid, id)), `${label} ${id}`).toBe(true);
        // What a small card draws of it: the fine rays as many as keep their spacing round a disc scaled with the card, and
        // the rim's rings as many as keep their pitch, at least two.
        const { s } = formatOf(fits[k]);
        const drawn = parts(result, 'drawn')[0][1];
        expect(drawn.x).toBeCloseTo(20 + Math.max(FINE_FLOOR, Math.round((120 + 160 * 0.5) * s)) / 10, 6);
        expect(drawn.y).toBe(22);
      }
      expect(parts(tabloid, 'drawn')[0][1]).toEqual({ x: 20 + 200 / 10, y: 24 });
    }
  }, 120_000);

  it('still reads as the Sun: the disc in its place in the sky and its size against the card, blown out, the rays straight and wavy by turns round it, fine rays out to the frame, the wall on the horizon showing it only through the breach, and its shadow parted by the shaft', async () => {
    for (const fit of fits) {
      const result = await rendered(fit);
      const { card, horizonY, s } = formatOf(fit);
      const { cx, cy, radii } = rim(result);
      // The disc keeps its place in the card's sky, on the centre line and 0.46 of the sky above the horizon (the height
      // control's default), and its size against the card: the print's 41 mm radius, scaled. (It stood 82 mm across the
      // 61 mm card before the port.) Its rim: two rings, 0.8 mm apart on paper.
      expect(Math.abs(cx - (card.x0 + card.x1) / 2), fit).toBeLessThan(0.05);
      expect(Math.abs(cy - (horizonY - 0.46 * (horizonY - card.y0))), fit).toBeLessThan(0.05);
      expect(Math.abs(radii[0] / s - 41), fit).toBeLessThan(0.2);
      expect(radii.length, fit).toBe(2);
      expect(Math.abs(radii[0] - radii[1] - 0.8), fit).toBeLessThan(0.02);
      const dist = (p: Point) => Math.hypot(p.x - cx, p.y - cy);
      const inside = result.parts.filter(part => !part.id.startsWith('disc-')).flatMap(part => part.paths.flat()).filter(p => dist(p) < radii[1] - 0.3);
      expect(inside, fit).toEqual([]);
      // The rays stand round the disc above the horizon, straight and wavy by turns: between each two waves next to each
      // other round it, a straight ray (but across the foot of the sun, where the rays that would reach past the horizon are
      // left out).
      for (const prefix of ['rays-', 'waves-']) {
        const ps = points(result, prefix);
        expect(Math.min(...ps.map(dist)), `${fit} ${prefix}`).toBeGreaterThan(radii[0]);
        expect(Math.max(...ps.map(p => p.y)), `${fit} ${prefix}`).toBeLessThan(horizonY);
      }
      const angle = (p: Point) => Math.atan2(p.y - cy, p.x - cx);
      const waves = all(result, 'waves-').map(path => angle(path[Math.floor(path.length / 2)])).sort((a, b) => a - b);
      expect(waves.length, fit).toBe(6);
      const straight = points(result, 'rays-').map(angle);
      const spans = waves.map((a, i) => [a, i + 1 < waves.length ? waves[i + 1] : waves[0] + 2 * Math.PI]);
      const foot = spans.reduce((widest, span, i) => span[1] - span[0] > spans[widest][1] - spans[widest][0] ? i : widest, 0);
      spans.forEach(([a, b], i) => {
        if (i !== foot) expect(straight.some(t => (t > a && t < b) || (t + 2 * Math.PI > a && t + 2 * Math.PI < b)), `${fit} between waves ${i}`).toBe(true);
      });
      // Fine rays fill the sky from beyond the disc out to the frame, on both sides and to the top, and stop above the horizon.
      const fine = points(result, 'radiance-');
      expect(Math.min(...fine.map(p => p.x)), fit).toBeLessThan(card.x0 + 0.01);
      expect(Math.max(...fine.map(p => p.x)), fit).toBeGreaterThan(card.x1 - 0.01);
      expect(Math.min(...fine.map(p => p.y)), fit).toBeLessThan(card.y0 + 0.01);
      expect(Math.max(...fine.map(p => p.y)), fit).toBeLessThan(horizonY);
      expect(Math.min(...fine.map(dist)), fit).toBeGreaterThan(radii[0] + 4 * s - 0.01);
      // The wall stands on the horizon across the window, and the horizon shows only through its breach: one stretch of it,
      // with the wall either side and none of the wall at its height between.
      const wall = points(result, 'wall-');
      expect(Math.min(...wall.map(p => p.y)), fit).toBeLessThan(horizonY - 1);
      expect(Math.max(...wall.map(p => p.y)), fit).toBeGreaterThan(horizonY + 1);
      expect(Math.min(...wall.map(p => p.x)), fit).toBeLessThan(card.x0 + 0.01);
      expect(Math.max(...wall.map(p => p.x)), fit).toBeGreaterThan(card.x1 - 0.01);
      const horizon = all(result, 'horizon-');
      expect(horizon.length, fit).toBe(1);
      const h0 = Math.min(...horizon[0].map(p => p.x)), h1 = Math.max(...horizon[0].map(p => p.x));
      expect(h1 - h0, fit).toBeGreaterThan(3);
      const level = wall.filter(p => p.y > horizonY - 1 && p.y < horizonY + 0.5);
      expect(level.some(p => p.x < h0) && level.some(p => p.x > h1), fit).toBe(true);
      expect(level.filter(p => p.x > h0 + 0.6 && p.x < h1 - 0.6), fit).toEqual([]);
      // Its shadow lies on the ground in rows from the wall's foot toward the viewer, every row parted by the shaft of light,
      // which falls from the breach and widens as it comes.
      const rows = new Map<number, number[][]>();
      for (const path of all(result, 'shadow-')) {
        const y = Math.round(path[0].y * 1000) / 1000;
        rows.set(y, [...rows.get(y) ?? [], [Math.min(path[0].x, path.at(-1)!.x), Math.max(path[0].x, path.at(-1)!.x)]]);
      }
      const gaps = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([y, row]) => {
        expect(row.length, `${fit} row ${y}`).toBe(2);
        const [left, right] = row.sort((a, b) => a[0] - b[0]);
        return [left[1], right[0]];
      });
      expect(gaps.length, fit).toBeGreaterThan(2);
      expect(Math.min(...points(result, 'shadow-').map(p => p.y)), fit).toBeGreaterThan(horizonY);
      expect(gaps[0][0], fit).toBeGreaterThan(h0);
      expect(gaps[0][1], fit).toBeLessThan(h1);
      gaps.slice(1).forEach(([l, r], i) => expect(l <= gaps[i][0] && r >= gaps[i][1] && r - l > gaps[i][1] - gaps[i][0], `${fit} shaft ${i}`).toBe(true));
      // The shaft reads as light through those few rows: bare paper, the desert's cracks only beyond the shadow's last row
      // (its far plates, shallower than the smallest feature, scribbled over it).
      expect(Math.min(...points(result, 'ground-').map(p => p.y)), fit).toBeGreaterThan(Math.max(...points(result, 'shadow-').map(p => p.y)));
    }
  }, 120_000);

  it('keeps the print\'s spacing where the port scaled it: as many fine rays as hold their spacing round the smaller disc, the shadow\'s rows opening as on the print', async () => {
    const tabloid = await print();
    // The print's 200 (one runs up behind the straight ray that reaches the frame).
    expect(fineRays(tabloid)).toBeGreaterThanOrEqual(198);
    const printSpacing = rim(tabloid).radii[0] / 200;
    for (const fit of fits) {
      const result = await rendered(fit);
      const { s } = formatOf(fit);
      // The print's 200 fine rays, scaled with the card (56 in fit height, 50 in width), keep its spacing round the disc on paper.
      const drawn = Math.round(200 * s), count = fineRays(result);
      expect(count, fit).toBeGreaterThanOrEqual(drawn - 2);
      expect(count, fit).toBeLessThanOrEqual(drawn);
      expect(rim(result).radii[0] / drawn / printSpacing, fit).toBeGreaterThan(0.97);
      expect(rim(result).radii[0] / drawn / printSpacing, fit).toBeLessThan(1.03);
      // The shadow's rows start 0.75 mm apart on paper and open toward the viewer as on the print, by 0.02 of the distance
      // from the wall's foot measured in the print's millimetres (in the card's own they would open by only 0.015 or so).
      const rows = [...new Set(points(result, 'shadow-').map(p => Math.round(p.y * 1000) / 1000))].sort((a, b) => a - b);
      for (let i = 1; i < rows.length; i++) expect(rows[i] - rows[i - 1], `${fit} row ${i}`).toBeCloseTo(0.75 + 0.02 * (rows[i - 1] - rows[0]) / s, 2);
    }
  }, 120_000);

  it('scales its halos: the fine rays stop short of what stands by the knockout, and the ground and its shadow short of painted words by their clearance, each scaled with the card and floored', async () => {
    for (const fit of fits) {
      const result = await rendered(fit);
      const { s } = formatOf(fit);
      // The knockout is 1.4 mm on the print, scaled with the card and never under 0.5 mm, on a mask as fine as the print's
      // (cells of a third of a print millimetre). A fine ray ends within half its 0.25 mm sampling step and a cell of the
      // knockout's edge, so it stands no nearer than a quarter millimetre to what stands, nor further than the scaled knockout
      // and a tenth (left at the print's 1.4 mm, about a millimetre).
      const gap = nearest(along(all(result, 'radiance-')), along([...all(result, 'rays-'), ...all(result, 'waves-'), ...all(result, 'wall-')]));
      expect(gap, fit).toBeGreaterThan(0.25);
      expect(gap, fit).toBeLessThan(Math.max(0.5, 1.4 * s) + 0.1);
    }
    // Words painted in the desert, where a small card carries the phrase in the art: the ground and the shadow keep 0.8 mm
    // clear of them on the print, scaled and floored the same way (on a mask of sixth-millimetre cells).
    const art = await renderSketch({ entry, seed: 1, finishing: { page }, format: { phrase: 'art' }, timeoutMs: 120_000 });
    const { s } = formatFor(targetPage(TABLOID_PAGE, page), { fit: 'width', phrase: 'art' });
    const words = along(all(art, 'slogan-'));
    expect(words.length).toBeGreaterThan(500);
    const clear = nearest(along([...all(art, 'ground-'), ...all(art, 'shadow-')]), words);
    expect(clear).toBeGreaterThan(0.3);
    expect(clear).toBeLessThan(Math.max(0.5, 0.8 * s) + 0.1);
  }, 120_000);

  it('draws each wave by its line, whole and waving: one violet path to a wave, unbroken by its own ribbon, swinging either side of its ray', async () => {
    for (const fit of fits) {
      const result = await rendered(fit);
      expect(result.parts.filter(part => part.id.startsWith('waves-')).map(part => part.id), fit).toEqual(['waves-violet']);
      const waves = all(result, 'waves-');
      expect(waves.length, fit).toBe(6);
      for (const path of waves) {
        // Its swing off the line between its ends, and how much longer than that line it runs.
        const a = path[0], b = path.at(-1)!, chord = Math.hypot(b.x - a.x, b.y - a.y);
        const swing = Math.max(...path.map(p => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / chord));
        const length = path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0);
        expect(chord, fit).toBeGreaterThan(10);
        expect(swing, fit).toBeGreaterThan(0.6);
        expect(swing, fit).toBeLessThan(2);
        expect(length / chord, fit).toBeGreaterThan(1.12);
      }
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, its slabs trimmed and its narrow cracks single, which the print shrunk to the card is', async () => {
    const tabloid = await print();
    const master = probe(tabloid);
    for (const fit of fits) {
      const report = probe(await rendered(fit));
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
      const share = (id: string) => report.parts.find(part => part.id === id)!.share;
      // The slabs are trimmed on a small card (kit/slabs.ts' `SlabTrim`): untrimmed, the coping's thin edge and the rays' thin
      // steps doubled their outlines (the wall's crowded share near the print's 55%, the rays' over 60%).
      expect(share('wall-carbon'), `${fit} ${describeDensity(report)}`).toBeLessThan(0.45);
      expect(share('rays-carbon'), `${fit} ${describeDensity(report)}`).toBeLessThan(0.45);
      // A crack narrower than the pens hold apart is drawn once, and the shallowest plates are left out: drawn as on the
      // print, three fifths of the desert ran too close.
      expect(share('ground-carbon'), `${fit} ${describeDensity(report)}`).toBeLessThan(0.1);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its fine rays, the
    // rim's rings, the wall's outlines, its shadow's rows and the desert's cracks shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...tabloid, parts: tabloid.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['radiance-acid', 'disc-vermilion', 'wall-carbon', 'shadow-carbon', 'ground-carbon']) expect(denser).toContain(id);
  }, 120_000);

  it('draws in its preferred fit, width, where the render names none: the level rays stand whole inside the window, which height runs into its edges', async () => {
    const [plain, width, height] = await Promise.all([renderSketch({ entry, seed: 1, finishing: { page }, timeoutMs: 120_000 }), rendered('width'), rendered('height')]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.parts).toEqual(width.parts);
    const edge = (fit: Fit, result: RenderResult) => {
      const { card } = formatOf(fit);
      return Math.min(...points(result, 'rays-').map(p => Math.min(p.x - card.x0, card.x1 - p.x)));
    };
    expect(edge('width', width)).toBeGreaterThan(1);
    expect(edge('height', height)).toBeLessThan(0.05);
  }, 120_000);
});
