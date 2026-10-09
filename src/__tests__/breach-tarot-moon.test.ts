import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD, HORIZON_Y } from '../../sketches/breach-tarot/card.ts';
import { DEBRIS_FLOOR } from '../../sketches/breach-tarot/xviii-moon/geometry.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { formatFor, type Fit } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/xviii-moon/sketch.ts');

type Pt = { x: number; y: number };
type Box = { x0: number; x1: number; y0: number; y1: number };
const paths = (parts: { id: string; paths: Pt[][] }[], id: string) => parts.find(p => p.id === id)?.paths ?? [];
/** Ink grouped into images by x: paths whose x-spans come within `gap` millimetres of each other are one image. */
function images(list: Pt[][], gap = 3): Box[] {
  const spans = list.filter(p => p.length).map(p => ({
    x0: Math.min(...p.map(q => q.x)), x1: Math.max(...p.map(q => q.x)), y0: Math.min(...p.map(q => q.y)), y1: Math.max(...p.map(q => q.y)),
  })).sort((a, b) => a.x0 - b.x0);
  const out: Box[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.x0 <= last.x1 + gap) Object.assign(last, { x1: Math.max(last.x1, s.x1), y0: Math.min(last.y0, s.y0), y1: Math.max(last.y1, s.y1) });
    else out.push({ ...s });
  }
  return out;
}
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));

/**
 * The pool's false city, read off the render: the reflection's images (the mirror ink grouped by x), the
 * towers that stand (their ink below the horizon, where they stand on the land; the wolf's flying courses
 * are all in the sky above it), and the lettering cut into the reflection.
 */
async function pool(params: Record<string, unknown> = {}) {
  const result = await renderSketch({ entry, seed: 1, params } as never);
  const reflections = images(paths(result.parts, 'mirror-carbon'));
  const standing = images(paths(result.parts, 'tower-carbon').map(p => p.filter(q => q.y > HORIZON_Y + 0.5)));
  // Share of each reflected image's width that lies under a tower that stands.
  const under = reflections.map(r => standing.reduce((s, t) => s + overlap(r, t), 0) / (r.x1 - r.x0));
  const lettering = paths(result.parts, 'slogan-lettering');
  return { reflections, standing, under, lettering };
}

describe('Breach Tarot: XVIII The Moon', () => {
  it('replays, stays inside the card, and draws the sky, the broken moon, the towers, the pool, the road, the phrase, the horizon and the frame', async () => {
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
    for (const id of ['sky-carbon', 'sky-ultramarine', 'rock-carbon', 'moon-carbon', 'tower-carbon', 'mirror-carbon', 'water-carbon', 'horizon-carbon', 'slogan-lettering', 'card-frame']) expect(ids).toContain(id);
    expect(ids.some(id => id.startsWith('helix-'))).toBe(true);
  }, 60_000);

  it('the pool reflects a tower that is not there: one reflected tower lies under neither tower that stands, and "its own" is cut into it', async () => {
    const { reflections, standing, under, lettering } = await pool();
    expect(standing.length).toBe(2);
    // Exactly one reflected tower stands under no real one (the two true reflections lie under theirs).
    const false_ = reflections.filter((_, i) => under[i] < 0.25);
    expect(false_.length).toBe(1);
    expect(reflections.filter((_, i) => under[i] > 0.75).length).toBe(2);
    // The last two words lie inside it: lettering within its image, in two words one above the other.
    const f = false_[0];
    const inside = lettering.filter(p => p.every(q => q.x >= f.x0 && q.x <= f.x1 && q.y >= f.y0 && q.y <= f.y1));
    expect(inside.length).toBeGreaterThanOrEqual(10);
    const ys = inside.map(p => p.reduce((s, q) => s + q.y, 0) / p.length).sort((a, b) => a - b);
    const widest = Math.max(...ys.slice(1).map((y, i) => y - ys[i]));
    expect(widest).toBeGreaterThan(10);
  }, 60_000);
});

describe('Breach Tarot: XVIII The Moon at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none.
  const render = (fit: Fit) => renderSketch({ entry, seed: 1, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const lines = (result: RenderResult, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths);
  const points = (result: RenderResult, prefix: string) => lines(result, prefix).flat();
  const bounds = (ps: Pt[]): Box => ({ x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)) });
  const length = (path: Pt[]) => path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0);
  /** Ink (mm) of a part's segments whose midpoints fall in a box. */
  const inkIn = (result: RenderResult, prefix: string, b: Box) => lines(result, prefix).reduce((sum, path) => sum + path.slice(1).reduce((t, q, i) => {
    const m = { x: (q.x + path[i].x) / 2, y: (q.y + path[i].y) / 2 };
    return m.x >= b.x0 && m.x < b.x1 && m.y >= b.y0 && m.y < b.y1 ? t + Math.hypot(q.x - path[i].x, q.y - path[i].y) : t;
  }, 0), 0);
  /** Points every `step` mm along a part's paths. */
  const along = (result: RenderResult, prefix: string, step = 0.05) => lines(result, prefix).flatMap(path => path.flatMap((b, i) => {
    if (!i) return [b];
    const a = path[i - 1], n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
    return Array.from({ length: n }, (_, k) => ({ x: a.x + (b.x - a.x) * (k + 1) / n, y: a.y + (b.y - a.y) * (k + 1) / n }));
  }));
  /** The nearest two points of two sets come, by a millimetre grid. */
  const nearest = (a: Pt[], b: Pt[]) => {
    const cells = new Map<string, Pt[]>();
    for (const q of b) { const key = `${Math.floor(q.x)},${Math.floor(q.y)}`; cells.set(key, [...cells.get(key) ?? [], q]); }
    let d = Infinity;
    for (const p of a) for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      for (const q of cells.get(`${Math.floor(p.x) + dx},${Math.floor(p.y) + dy}`) ?? []) d = Math.min(d, Math.hypot(p.x - q.x, p.y - q.y));
    }
    return d;
  };
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: the bank, the towers and the city in the pool, the howl, the moon, the road; the floating blocks thinned to a few', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-moon-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), its counts, and which of the seeded
    // floating blocks the format draws, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { moonCamera, moonWorld, shownDebris } from ${JSON.stringify(resolve('sketches/breach-tarot/xviii-moon/geometry.ts'))};
      export default { name: 'moon-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [
          { type: 'select', id: 'towerForm', label: 'Towers', default: 'howl', options: ['howl', 'column', 'stack'] },
          { type: 'select', id: 'moonForm', label: 'Moon', default: 'broken', options: ['broken', 'station', 'crescent'] },
          { type: 'slider', id: 'nearX', label: 'Near tower across', default: 62, min: 30, max: 120, step: 1 },
          { type: 'slider', id: 'brokenX', label: 'Broken moon across', default: 178, min: 120, max: 240, step: 1 },
          { type: 'slider', id: 'debris', label: 'Floating blocks', default: 14, min: 0, max: 40, step: 1 },
        ],
        draw(ctx) {
          const w = moonWorld(ctx), h = createHash('sha256');
          const v3 = v => [v.x, v.y, v.z].join(',');
          const slabs = list => { for (const s of list) h.update([s.x, s.y, s.z, s.w, s.h, s.d, s.rx, s.ry, s.rz, s.beat, s.role, s.tone, ';'].join(',')); h.update('|'); };
          for (const list of [w.land.near, w.land.far, w.land.waterNear, w.land.waterFar, w.land.extra, w.extra, w.set.near, w.set.far, w.set.spears]) slabs(list);
          for (let x = 20; x <= 260; x += 10) h.update(w.shore(x) + ';');
          for (let u = -0.08; u <= 1; u += 0.04) h.update([v3(w.road.centre(u)), v3(w.road.across(u)), w.road.turn(u), ';'].join(','));
          h.update([w.road.half, w.road.u0, w.moonForm, w.towerForm, ';'].join(','));
          if (w.shards) {
            h.update([v3(w.shards.centre), w.shards.radius, v3(w.shards.light), v3(w.shards.axis), ';'].join(','));
            for (const c of w.shards.cracks) h.update([v3(c.m), c.o, ';'].join(','));
            for (const [k, p] of w.shards.pieces) h.update([k, v3(p.pivot), v3(p.drift), p.turn.x, p.turn.y, p.turn.z, p.turn.w, ';'].join(','));
            slabs(w.shards.piercers); slabs(w.shards.debris);
          }
          if (w.base) {
            h.update([v3(w.base.centre), w.base.radius, ';'].join(','));
            for (const list of [w.base.spine, w.base.collar, w.base.dock, w.base.scatter]) slabs(list);
            for (const c of w.base.craters) h.update([v3(c.dir), c.size, ';'].join(','));
          }
          if (w.moon) { h.update([v3(w.moon.centre), w.moon.radius, ';'].join(',')); slabs(w.moon.slabs); }
          const d = h.digest();
          const debris = w.shards ? w.shards.debris : [];
          const shown = shownDebris(debris, moonCamera(ctx)).map(s => debris.indexOf(s));
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.set.near.length / 10, y: 20 + w.set.far.length / 10 }, { x: 20 + w.set.spears.length, y: 20 + debris.length / 10 }, { x: 20 + w.extra.length, y: 20 }]] },
            { id: 'shown', pen: 'ink', paths: [[{ x: 20, y: 21 }, { x: 20.5, y: 21 }, ...shown.map(i => ({ x: 21 + i, y: 21 }))]] }];
        } };`);
    const part = (result: RenderResult, id: string) => result.parts.find(p => p.id === id)!.paths;
    const shown = (result: RenderResult) => part(result, 'shown')[0].slice(2).map(p => Math.round(p.x - 21));
    const a5 = { width: 148, height: 210 };
    // The default; the column with the near tower and the moon moved and more blocks; the station; the crescent and the stacks.
    for (const params of [{}, { towerForm: 'column', nearX: 50, brokenX: 200, debris: 24 }, { moonForm: 'station' }, { moonForm: 'crescent', towerForm: 'stack' }] as Record<string, string | number>[]) {
      const [print, larger, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 1, params }),
        renderSketch({ entry: probeEntry, seed: 1, params, finishing: { page: a5 } }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 1, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      const counts = part(print, 'counts')[0];
      expect(counts[1].x, JSON.stringify(params)).toBeGreaterThan(20 + 0.4);
      for (const result of [larger, ...small]) for (const id of ['digest', 'counts']) {
        expect(part(result, id), `${JSON.stringify(params)} ${id}`).toEqual(part(print, id));
      }
      if (params.moonForm) continue;
      // The print draws every block the moon seeded; a small card a few (the format's share by length, never under the
      // floor at the default), an even spread of their seeded order, and a subset of what a larger card (A5) shows.
      const seeded = Math.round((counts[2].y - 20) * 10);
      expect(shown(print)).toEqual(Array.from({ length: seeded }, (_, i) => i));
      for (const result of small) {
        const kept = shown(result);
        const floor = Math.round(DEBRIS_FLOOR * seeded / 14);
        expect(kept.length, JSON.stringify(params)).toBeGreaterThanOrEqual(floor - 2);
        expect(kept.length, JSON.stringify(params)).toBeLessThanOrEqual(Math.max(floor, Math.round(seeded * 0.28)));
        for (const i of kept) expect(shown(larger)).toContain(i);
      }
      expect(shown(larger).length).toBeGreaterThan(shown(small[0]).length);
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
      // Paths wholly inside the art window, per part of the scene: the night, the broken rock, its slabs and blocks, the
      // towers, the city in the water, the water, the road and the horizon.
      const inWindow = (prefix: string) => lines(first, prefix)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 35, 'rock-': 35, 'moon-': 40, 'tower-': 220, 'mirror-': 100, 'water-': 15, 'helix-': 25, 'horizon-': 0 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), `${fit} ${prefix}`).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = points(first, 'card-phrase');
      expect(phrase.length).toBeGreaterThan(50);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 120_000);

  it('still reads as the Moon: the broken moon high on the right, lit only on its sunward side, pierced through; the wolf streaming up toward it; the dog staked; the road between them; and the pool\'s third tower', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { card, horizonY, s } = formatOf(fit);
      const centre = (card.x0 + card.x1) / 2;
      // The broken moon hangs high in the night, right of the card's middle: its top in the night's upper third, its
      // lowest point about halfway down (as on the print).
      const rock = bounds(points(result, 'rock-'));
      expect((rock.x0 + rock.x1) / 2, fit).toBeGreaterThan(centre + 5 * s / 0.25);
      expect(rock.y0, fit).toBeLessThan(card.y0 + 0.3 * (horizonY - card.y0));
      expect(rock.y1, fit).toBeLessThan(card.y0 + 0.55 * (horizonY - card.y0));
      // None of its light is its own: the sunward third (the sun is to its left) is paper but for the limb and the cracks'
      // rims, the night side ruled; and the night runs up to its lit side.
      const third = (rock.x1 - rock.x0) / 3;
      const lit = inkIn(result, 'rock-', { ...rock, x1: rock.x0 + third }), night = inkIn(result, 'rock-', { ...rock, x0: rock.x1 - third });
      expect(lit, fit).toBeLessThan(0.5 * night);
      expect(inkIn(result, 'sky-', { ...rock, x0: rock.x0 - (rock.x1 - rock.x0) / 4, x1: rock.x0 }), fit).toBeGreaterThan(10);
      // Its slabs stand out past the rock on both sides.
      expect(inkIn(result, 'moon-', { ...rock, x0: -Infinity, x1: rock.x0 }), fit).toBeGreaterThan(10);
      expect(inkIn(result, 'moon-', { ...rock, x0: rock.x1, x1: Infinity }), fit).toBeGreaterThan(10);
      // The wolf stands on the left and the dog on the right, their feet below the horizon.
      const tower = points(result, 'tower-');
      const standing = tower.filter(p => p.y > horizonY + 0.5);
      const wolf = bounds(standing.filter(p => p.x < centre)), dog = bounds(standing.filter(p => p.x > centre));
      expect(wolf.x1, fit).toBeLessThan(centre);
      expect(dog.x0, fit).toBeGreaterThan(centre);
      // The wolf's stream rises from it toward the moon: its highest slab is above the moon's lowest point, between the
      // wolf and the moon.
      const top = tower.reduce((a, p) => p.y < a.y ? p : a, { x: 0, y: Infinity });
      expect(top.y, fit).toBeLessThan(rock.y1);
      expect(top.x, fit).toBeGreaterThan((wolf.x0 + wolf.x1) / 2);
      expect(top.x, fit).toBeLessThan(rock.x0);
      // The dog is staked: long straight edges at a steep slope (the stakes), right of the card's middle.
      const straight = lines(result, 'tower-').filter(path => length(path) > 3 * s / 0.25 && length(path) < 1.001 * Math.hypot(path.at(-1)!.x - path[0].x, path.at(-1)!.y - path[0].y));
      const slope = (path: Pt[]) => { const a = Math.abs(Math.atan2(path.at(-1)!.y - path[0].y, path.at(-1)!.x - path[0].x)) * 180 / Math.PI; return Math.min(a, 180 - a); };
      expect(straight.filter(path => slope(path) > 30 && slope(path) < 70 && Math.min(...path.map(p => p.x)) > centre).length, fit).toBeGreaterThanOrEqual(4);
      // The road winds from the water between the towers and threads out at the horizon between them.
      const roadInk = points(result, 'helix-');
      const road = bounds(roadInk);
      expect(road.y0, fit).toBeGreaterThan(horizonY);
      expect(road.y0, fit).toBeLessThan(horizonY + 1.5);
      expect((road.x0 + road.x1) / 2, fit).toBeGreaterThan((wolf.x0 + wolf.x1) / 2);
      expect((road.x0 + road.x1) / 2, fit).toBeLessThan((dog.x0 + dog.x1) / 2);
      const end = roadInk.reduce((a, p) => p.y < a.y ? p : a, { x: 0, y: Infinity });
      expect(end.x, fit).toBeGreaterThan(wolf.x1);
      expect(end.x, fit).toBeLessThan(dog.x0);
      // The pool reflects a city that is not there: of the reflection's images, one lies under neither tower that stands
      // (between them), and the two others under theirs.
      const reflections = images(lines(result, 'mirror-carbon'), 3 * s);
      const towers = images(lines(result, 'tower-carbon').map(path => path.filter(p => p.y > horizonY + 0.5)), 3 * s);
      expect(towers.length, fit).toBe(2);
      const under = reflections.map(r => towers.reduce((sum, t) => sum + overlap(r, t), 0) / (r.x1 - r.x0));
      const falseTower = reflections.filter((_, i) => under[i] < 0.25);
      expect(falseTower.length, fit).toBe(1);
      expect(reflections.filter((_, i) => under[i] > 0.75).length, fit).toBe(2);
      expect(falseTower[0].x0, fit).toBeGreaterThan(towers[0].x1);
      expect(falseTower[0].x1, fit).toBeLessThan(towers[1].x0);
      expect(falseTower[0].y0, fit).toBeGreaterThan(horizonY);
    }
  }, 120_000);

  it('keeps the paper round the towers and the moon\'s slabs at the card\'s scale: no ruling nearer than the halo\'s floor, none further than the halo scaled', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { s } = formatOf(fit);
      const sky = along(result, 'sky-'), tower = along(result, 'tower-'), slabs = along(result, 'moon-');
      // The night stops short of the towers by the knockout (1.1 mm on the print) and of the moon's slabs and blocks by its
      // halo (1.2 mm), and the moon short of the towers by the knockout, each scaled with the card and never under 0.5 mm.
      // The halos are measured on a mask, so a clean ruling stands a little under the floor: none nearer than 0.35 mm,
      // nor further than the scaled halo and 0.15 mm.
      for (const [name, a, b, mm] of [['sky to towers', sky, tower, 1.1], ['sky to slabs', sky, slabs, 1.2], ['slabs to towers', slabs, tower, 1.1]] as const) {
        const d = nearest(a, b);
        expect(d, `${fit} ${name}`).toBeGreaterThan(0.35);
        expect(d, `${fit} ${name}`).toBeLessThan(Math.max(0.5, mm * s) + 0.15);
      }
    }
  }, 120_000);

  it('lays the road as one ribbon: its laminations fill both halves either side of the spine evenly, and its lines in every ink stand the pen floor apart', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      // The spine (the acid line along the middle where the face that carries it is up): which side of it, and how far,
      // each stretch of lamination lies. Before the fix the small card's fill fell on one half only (44 mm of ink against 5).
      const spine = lines(result, 'helix-acid').filter(path => length(path) > 3).flatMap(path => path.slice(1).map((q, i) => [path[i], q] as const));
      const side = (m: Pt) => spine.reduce((best, [a, b]) => {
        const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(m.x - a.x - t * dx, m.y - a.y - t * dy);
        return d < best.d ? { d, s: Math.sign(dx * (m.y - a.y) - dy * (m.x - a.x)) } : best;
      }, { d: Infinity, s: 0 });
      const ink = [0, 0];
      for (const path of [...lines(result, 'helix-ultramarine'), ...lines(result, 'helix-violet')]) for (let i = 1; i < path.length; i++) {
        const { d, s } = side({ x: (path[i].x + path[i - 1].x) / 2, y: (path[i].y + path[i - 1].y) / 2 });
        if (d > 0.2 && d < 1.5) ink[s > 0 ? 0 : 1] += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
      }
      expect(Math.min(...ink), `${fit} ${ink}`).toBeGreaterThan(10);
      expect(Math.max(...ink) / Math.min(...ink), `${fit} ${ink}`).toBeLessThan(1.5);
      // The road's lines taken together, whatever their pen: the fill packs at the pen floor, never under it (before the
      // fix, 46% of the road ran closer; the print's road, laid by its own rule, 59%).
      const road = probe({ ...result, parts: [{ id: 'road', pen: 'carbon', paths: lines(result, 'helix-') }] });
      expect(road.share, fit).toBeLessThan(0.15);
    }
  }, 120_000);

  it('trims its slabs on a small card: the moon\'s slabs and the towers\' courses keep single outlines', async () => {
    for (const fit of fits) {
      const report = probe(await render(fit));
      const share = (id: string) => report.parts.find(part => part.id === id)?.share ?? 0;
      // Untrimmed, the back edges and sliver faces crowd about half the slabs' outlines and 37% of the towers'; trimmed,
      // none and a quarter (the print's towers: 40%, its course joints doubled).
      expect(share('moon-carbon'), `${fit} slabs`).toBeLessThan(0.2);
      expect(share('tower-carbon'), `${fit} towers`).toBeLessThan(0.32);
    }
  }, 120_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is', async () => {
    const [print, ...small] = await Promise.all([renderSketch({ entry, seed: 1, timeoutMs: 120_000 }), ...fits.map(render)]);
    const master = probe(print);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, master), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(master.share);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its night, rock
    // and water rulings, the towers' hatch and the road's laminations shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...print, parts: print.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), master).map(p => p.id);
    for (const id of ['sky-carbon', 'rock-carbon', 'tower-carbon', 'water-carbon', 'helix-ultramarine']) expect(denser).toContain(id);
  }, 120_000);

  it('draws in its preferred fit, width, where the render names none', async () => {
    const [plain, width] = await Promise.all([renderSketch({ entry, seed: 1, finishing: { page }, timeoutMs: 120_000 }), render('width')]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.parts).toEqual(width.parts);
  }, 120_000);
});
