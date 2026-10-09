import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { devilLayout } from '../../sketches/breach-tarot/xv-devil/layout.ts';
import { denserThan, densityProbe, describeDensity } from '../../sketches/kit/density.ts';
import { formatFor, type Fit } from '../../sketches/kit/format.ts';
import { TABLOID_PAGE } from '../../sketches/phase-garden/poster.ts';
import { targetPage } from '../sketch/render-target.ts';
import type { RenderResult } from '../sketch/types.ts';
import { nearestDistance } from './helpers/nearest.ts';

const entry = resolve('sketches/breach-tarot/xv-devil/sketch.ts');

type Pt = { x: number; y: number };
type Part = { id: string; paths: Pt[][] };

/** The runner's own seeded stream, so the layout here is the layout of a seed-1 render. */
function randomStream(seed: number, id: string): () => number {
  const digest = createHash('sha256').update(`${seed}\0${id}`).digest();
  let state = digest.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What each leash says about itself, from the route the card draws: its length against the straight line between its ends, and its lowest point. */
function leashes(params: Record<string, number> = {}) {
  const { routes } = devilLayout({ params, seed: 1, assets: {}, random: (id: string) => randomStream(1, id) } as never);
  return routes.map(route => {
    // From where it leaves the pillar (the point before it, inside the cap, is hidden) to the wrist.
    const visible = route.slice(1);
    const curve = new THREE.CatmullRomCurve3(visible, false, 'centripetal');
    const ends = [visible[0], visible[visible.length - 1]];
    const lowest = Math.min(...Array.from({ length: 401 }, (_, i) => curve.getPointAt(i / 400).y));
    return { stretch: curve.getLength() / ends[0].distanceTo(ends[1]), lowest, endsY: ends.map(p => p.y) };
  });
}
type Leash = ReturnType<typeof leashes>[number];
/** Slack, in three parts: at least 1.4 times as long as the straight line, its lowest point on the ground, and clear below both its ends. */
const longEnough = (l: Leash) => l.stretch >= 1.4;
const onGround = (l: Leash) => l.lowest > -0.3 && l.lowest < 0.4;
const belowEnds = (l: Leash) => l.endsY.every(y => y - l.lowest > 1);

const box = (parts: Part[], id: string) => {
  const points = parts.find(p => p.id === id)!.paths.flat();
  return { x0: Math.min(...points.map(p => p.x)), x1: Math.max(...points.map(p => p.x)), y0: Math.min(...points.map(p => p.y)), y1: Math.max(...points.map(p => p.y)) };
};
/** The two door frames mirror each other about the card's centre line: each one's extent is the other's reflected, within 2 mm. */
const mirrored = (parts: Part[]) => {
  const left = box(parts, 'door-left-carbon'), right = box(parts, 'door-right-carbon'), mid = (CARD.x0 + CARD.x1) / 2;
  return [left.x0 - (2 * mid - right.x1), left.x1 - (2 * mid - right.x0), left.y0 - right.y0, left.y1 - right.y1].every(d => Math.abs(d) <= 2);
};

describe('Breach Tarot: XV The Devil', () => {
  it('replays, stays inside the card, and draws the sky, the shadow, the pillar, both doors, both leashes, the figures, the echo, the phrase and the frame', async () => {
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
    for (const id of ['sky-carbon', 'shadow-carbon', 'pillar-carbon', 'door-left-carbon', 'door-right-carbon', 'figure-carbon', 'echo-acid', 'horizon-carbon', 'slogan-lettering', 'card-frame']) expect(ids).toContain(id);
    for (const side of ['left', 'right']) expect(ids.some(id => id.startsWith(`leash-${side}-`))).toBe(true);
  }, 60_000);

  it('is slack and frontal: each leash is 1.4 times its straight length and lies on the ground below both its ends, and the doors mirror about the centre line', async () => {
    for (const leash of leashes()) {
      expect(longEnough(leash)).toBe(true);
      expect(onGround(leash)).toBe(true);
      expect(belowEnds(leash)).toBe(true);
    }
    // A taut leash, the same cord pulled straight from the pillar to the wrist, fails all three.
    for (const leash of leashes({ leashSag: 0 })) {
      expect(longEnough(leash)).toBe(false);
      expect(onGround(leash)).toBe(false);
      expect(belowEnds(leash)).toBe(false);
    }
    const level = await renderSketch({ entry, seed: 1 });
    expect(mirrored(level.parts)).toBe(true);
    // One door moved 8 mm toward the pillar is no longer the other's reflection.
    expect(mirrored((await renderSketch({ entry, seed: 1, params: { doorShift: -8 } })).parts)).toBe(false);
  }, 120_000);
});

describe('Breach Tarot: XV The Devil at 70 x 120 mm', () => {
  const page = { width: 70, height: 120 };
  const fits: Fit[] = ['height', 'width'];
  // Each fit named: a card draws in its own preferred fit where the render names none. One render per fit, shared.
  const renders = new Map<Fit, Promise<RenderResult>>();
  const fresh = (fit: Fit, params: Record<string, number> = {}) => renderSketch({ entry, seed: 1, params, finishing: { page }, format: { fit }, timeoutMs: 120_000 });
  const render = (fit: Fit) => renders.get(fit) ?? renders.set(fit, fresh(fit)).get(fit)!;
  let printed: Promise<RenderResult> | undefined;
  const print = () => printed ??= renderSketch({ entry, seed: 1, timeoutMs: 120_000 });
  const formatOf = (fit: Fit) => formatFor(targetPage(TABLOID_PAGE, page), { fit });
  const paths = (result: { parts: Part[] }, prefix: string) => result.parts.filter(part => part.id.startsWith(prefix)).flatMap(part => part.paths);
  /** A part's paths resampled to points at most `step` mm apart, so a long straight line is a row of points. */
  const dense = (result: { parts: Part[] }, prefix: string, step = 0.1): Pt[] => paths(result, prefix).flatMap(path => {
    const out: Pt[] = [path[0]];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let j = 1; j <= k; j++) out.push({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k });
    }
    return out;
  });
  const bounds = (ps: Pt[]) => ps.reduce((b, p) => ({ x0: Math.min(b.x0, p.x), x1: Math.max(b.x1, p.x), y0: Math.min(b.y0, p.y), y1: Math.max(b.y1, p.y) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
  const length = (result: { parts: Part[] }, prefix: string) => paths(result, prefix).reduce((sum, path) => sum + path.slice(1).reduce((l, q, i) => l + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0), 0);
  /** Ink per square millimetre of a part's bounding box: how dark it reads. */
  const darkness = (result: { parts: Part[] }, prefix: string) => { const b = bounds(dense(result, prefix, 0.5)); return length(result, prefix) / ((b.x1 - b.x0) * (b.y1 - b.y0)); };
  const ends = (result: { parts: Part[] }, prefix: string) => paths(result, prefix).flatMap(path => [path[0], path.at(-1)!]);
  const probe = (result: RenderResult) => densityProbe(result.parts, { penWidth: pen => result.metadata.pens.find(p => p.id === pen)!.width });
  /** The figures, the left one and the right, by which side of the card's centre line their points fall. */
  const figures = (result: { parts: Part[] }, mid: number) => { const all = dense(result, 'figure-'); return [all.filter(p => p.x < mid), all.filter(p => p.x > mid)]; };
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('builds the same seeded world at every size and fit: every course of the pillar, both figures, both doors and both leashes\' routes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatch3d-devil-'));
    const probeEntry = join(dir, 'probe.ts');
    // A page-aware probe: the world's digest as a path of points (two bytes each), and its counts, inside either page's margin.
    await writeFile(probeEntry, `import { createHash } from 'node:crypto';
      import { devilLayout } from ${JSON.stringify(resolve('sketches/breach-tarot/xv-devil/layout.ts'))};
      import { figureMeshes } from ${JSON.stringify(resolve('sketches/breach-tarot/xv-devil/figures.ts'))};
      import { JOINTS } from ${JSON.stringify(resolve('sketches/kit/mannequin/skeleton.ts'))};
      export default { name: 'devil-world', page: { width: 279.4, height: 431.8, margin: 18 }, pageAware: true,
        pens: [{ id: 'ink', color: '#111111', width: 0.25 }],
        controls: [{ type: 'slider', id: 'figX', label: 'Figures across the page', default: 84, min: 50, max: 120, step: 1 },
          { type: 'slider', id: 'doorShift', label: 'The right door alone', default: 0, min: -30, max: 30, step: 0.5 }],
        draw(ctx) {
          const w = devilLayout(ctx), h = createHash('sha256');
          for (const { sl, course, height } of w.pillar.pieces) h.update([sl.x, sl.y, sl.z, sl.w, sl.h, sl.d, sl.rx, sl.ry, sl.rz, sl.tone, course, height, ';'].join(','));
          h.update([w.pillar.attach.y, w.pillar.attach.half, w.pillar.attach.z, w.pillar.front, ...w.figZs, ';'].join(','));
          for (const f of w.figures) {
            for (const j of JOINTS) { const p = f.skeleton.at(j); h.update([p.x, p.y, p.z, ';'].join(',')); }
            h.update([f.wrist.x, f.wrist.y, f.wrist.z, ';'].join(','));
            for (const g of figureMeshes(f)) { h.update(Buffer.from(g.getAttribute('position').array.buffer)); g.dispose(); }
          }
          for (const d of w.doors) for (const { sl, part } of d.pieces) h.update([d.side, part, sl.x, sl.y, sl.z, sl.w, sl.h, sl.d, sl.rx, sl.ry, sl.rz, sl.tone, ';'].join(','));
          for (const route of w.routes) for (const p of route) h.update([p.x, p.y, p.z, ';'].join(','));
          const d = h.digest();
          return [{ id: 'digest', pen: 'ink', paths: [Array.from({ length: 16 }, (_, i) => ({ x: 20 + d[2 * i] / 10, y: 20 + d[2 * i + 1] / 10 }))] },
            { id: 'counts', pen: 'ink', paths: [[{ x: 20, y: 20 }, { x: 20 + w.pillar.pieces.length / 10, y: 20 + (w.doors[0].pieces.length + w.doors[1].pieces.length + w.routes.length) / 10 }]] }];
        } };`);
    // The default, and the figures and the right door moved across the page.
    for (const params of [{}, { figX: 70, doorShift: -8 }] as Record<string, number>[]) {
      const [printWorld, ...small] = await Promise.all([
        renderSketch({ entry: probeEntry, seed: 1, params }),
        ...fits.map(fit => renderSketch({ entry: probeEntry, seed: 1, params, finishing: { page }, ...(fit === 'width' ? { format: { fit } } : {}) })),
      ]);
      expect(printWorld.diagnostics).toEqual([]);
      const counts = printWorld.parts.find(part => part.id === 'counts')!.paths[0];
      // Seven courses or more (three steps, a shaft of two or more, a cap of two); five pieces to each door (two jambs, the lintel, the sill and the
      // leaf), and two routes.
      expect(counts[1].x).toBeGreaterThan(20 + 6.5 / 10);
      expect(counts[1].y).toBeCloseTo(20 + 12 / 10, 6);
      for (const result of small) for (const id of ['digest', 'counts']) {
        expect(result.parts.find(part => part.id === id)!.paths, `${JSON.stringify(params)} ${id}`).toEqual(printWorld.parts.find(part => part.id === id)!.paths);
      }
    }
  }, 120_000);

  it('replays in both fits, draws the scene in the art window, no words in the art, and the phrase in the band', async () => {
    for (const fit of fits) {
      const [first, replay] = await Promise.all([render(fit), fresh(fit)]);
      expect(replay.identity).toBe(first.identity);
      expect(first.diagnostics).toEqual([]);
      expect(first.metadata.page).toMatchObject(page);
      const { card, frame } = formatOf(fit);
      for (const part of first.parts) for (const path of part.paths) for (const p of path) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(p.x).toBeGreaterThanOrEqual(card.x0 - 0.01);
        expect(p.x).toBeLessThanOrEqual(card.x1 + 0.01);
        expect(p.y).toBeGreaterThanOrEqual(card.top - 0.01);
        expect(p.y).toBeLessThanOrEqual(card.bottom + 0.01);
      }
      // Paths wholly inside the art window, per part of the scene.
      const inWindow = (prefix: string) => paths(first, prefix)
        .filter(path => path.every(p => p.x >= card.x0 - 0.01 && p.x <= card.x1 + 0.01 && p.y >= card.y0 - 0.01 && p.y <= card.y1 + 0.01)).length;
      const least = { 'sky-': 40, 'shadow-': 10, 'pillar-': 300, 'door-left-': 25, 'door-right-': 25, 'leash-left-': 3, 'leash-right-': 3, 'figure-carbon': 10, 'figure-edge-': 10, 'echo-': 0, 'horizon-': 0 };
      for (const [prefix, n] of Object.entries(least)) expect(inWindow(prefix), `${fit} ${prefix}`).toBeGreaterThan(n);
      expect(first.parts.some(part => part.id.startsWith('slogan-') || part.id.startsWith('title-'))).toBe(false);
      const phrase = paths(first, 'card-phrase').flat();
      expect(phrase.length).toBeGreaterThan(100);
      expect(Math.min(...phrase.map(p => p.y))).toBeGreaterThan(card.y1 + frame.rule);
    }
  }, 240_000);

  it('still reads as the Devil: the pillar dead centre and darkest, a figure in each open doorway, the doors mirrored, the leashes slack to the ground, the echo quiet in the sky', async () => {
    // On the print: each figure's box (by the print card's centre line), for the figure seen whole on the small card; the
    // echo's width against the pillar's.
    const master = await print();
    const printFigures = figures(master, (CARD.x0 + CARD.x1) / 2).map(bounds);
    const widthOf = (b: ReturnType<typeof bounds>) => b.x1 - b.x0;
    const printEcho = widthOf(bounds(dense(master, 'echo-'))) / widthOf(bounds(dense(master, 'pillar-', 0.5)));
    for (const fit of fits) {
      const result = await render(fit);
      const { card, horizonY, s } = formatOf(fit);
      const mid = (card.x0 + card.x1) / 2;
      // The pillar, dead centre, standing on the ground and rising above the horizon.
      const pillar = bounds(dense(result, 'pillar-', 0.5));
      expect(Math.abs((pillar.x0 + pillar.x1) / 2 - mid), fit).toBeLessThan(0.2);
      expect(pillar.y0).toBeLessThan(horizonY - 10);
      expect(pillar.y1).toBeGreaterThan(horizonY + 10);
      // The darkest mass on the card: more than half as much ink again, for its size, as anything else.
      for (const other of ['door-left-', 'door-right-', 'shadow-', 'sky-', 'figure-', 'leash-left-', 'leash-right-']) {
        expect(darkness(result, 'pillar-'), `${fit} pillar against ${other}`).toBeGreaterThan(1.5 * darkness(result, other));
      }
      // The doors mirror each other about the centre line, to half a millimetre (the print's 2 mm, scaled).
      const left = bounds(dense(result, 'door-left-')), right = bounds(dense(result, 'door-right-'));
      for (const d of [left.x0 - (2 * mid - right.x1), left.x1 - (2 * mid - right.x0), left.y0 - right.y0, left.y1 - right.y1]) expect(Math.abs(d), fit).toBeLessThan(2 * s);
      // A small figure stands in each doorway, below the horizon, either side of the pillar. The doorway is open: the figure
      // is seen whole through it, as wide and as tall as the print's scaled with the card, and no line of the door crosses it.
      const [figL, figR] = figures(result, mid);
      for (const [fig, door, printed] of [[figL, left, printFigures[0]], [figR, right, printFigures[1]]] as const) {
        const b = bounds(fig);
        expect(Math.abs(b.x1 - b.x0 - (printed.x1 - printed.x0) * s), `${fit} figure width`).toBeLessThan(0.3);
        expect(Math.abs(b.y1 - b.y0 - (printed.y1 - printed.y0) * s), `${fit} figure height`).toBeLessThan(0.3);
        expect(b.x0).toBeGreaterThan(door.x0);
        expect(b.x1).toBeLessThan(door.x1);
        expect(b.y0).toBeGreaterThan(horizonY);
        expect(b.y1 - b.y0).toBeLessThan((pillar.y1 - pillar.y0) / 2);
        expect(dense(result, 'door-').filter(p => p.x > b.x0 + 0.3 && p.x < b.x1 - 0.3 && p.y > b.y0 + 0.3 && p.y < b.y1 - 0.3)).toEqual([]);
      }
      expect(bounds(figL).x1).toBeLessThan(pillar.x0);
      expect(bounds(figR).x0).toBeGreaterThan(pillar.x1);
      // Each leash runs from the pillar's side to its figure and hangs slack: it lies on the ground in front of the figure's
      // feet, far below where it leaves the pillar and the wrist.
      for (const [side, fig] of [['left', figL], ['right', figR]] as const) {
        const leash = bounds(dense(result, `leash-${side}-`)), feet = bounds(fig).y1;
        expect(leash.y1, `${fit} ${side} leash on the ground`).toBeGreaterThan(feet);
        expect(leash.y1 - leash.y0, `${fit} ${side} leash drop`).toBeGreaterThan(10);
        if (side === 'left') { expect(leash.x0).toBeLessThan(bounds(fig).x1); expect(leash.x1).toBeGreaterThan(pillar.x0 - 1); }
        else { expect(leash.x1).toBeGreaterThan(bounds(fig).x0); expect(leash.x0).toBeLessThan(pillar.x1 + 1); }
      }
      // The echo: one line in the lightest pen, a small share of the ink, centred in the sky between the black ground and
      // the horizon, and as much wider than the pillar as on the print (it scales with the pillar it echoes).
      expect(result.parts.filter(part => part.id.startsWith('echo-')).map(part => part.id)).toEqual(['echo-acid']);
      const echo = bounds(dense(result, 'echo-'));
      expect(length(result, 'echo-') / result.parts.filter(part => !part.id.startsWith('card-')).reduce((sum, part) => sum + length(result, part.id), 0)).toBeLessThan(0.05);
      expect(Math.abs((echo.x0 + echo.x1) / 2 - mid)).toBeLessThan(0.2);
      expect(echo.y1).toBeLessThan(horizonY);
      expect(echo.y0).toBeGreaterThan(card.y0 + 0.2 * (horizonY - card.y0));
      expect(echo.y0).toBeLessThan(pillar.y0);
      expect(Math.abs(widthOf(echo) / widthOf(pillar) - printEcho)).toBeLessThan(0.01);
    }
    // A leash pulled taut no longer reaches the ground; the right door moved 8 mm on the print no longer mirrors the left;
    // the pillar ruled at 1.5 mm is no darker than its shadow.
    const { card, s } = formatOf('width');
    const mid = (card.x0 + card.x1) / 2;
    const [taut, shifted, pale] = await Promise.all([fresh('width', { leashSag: 0 }), fresh('width', { doorShift: -8 }), fresh('width', { stonePitch: 1.5 })]);
    const [figL] = figures(taut, mid);
    expect(bounds(dense(taut, 'leash-left-')).y1).toBeLessThan(bounds(figL).y1);
    const left = bounds(dense(shifted, 'door-left-')), right = bounds(dense(shifted, 'door-right-'));
    expect(Math.abs(left.x0 - (2 * mid - right.x1))).toBeGreaterThan(2 * s);
    expect(darkness(pale, 'pillar-')).toBeLessThan(1.5 * darkness(pale, 'shadow-'));
  }, 240_000);

  it('draws each leash as its two strands\' lines, unbroken, and trims the doors', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      // Too narrow for ribbons, each strand is one line, still wound round the other: no laminations, ribs or pulses.
      for (const side of ['left', 'right']) {
        expect(result.parts.filter(part => part.id.startsWith(`leash-${side}-`)).map(part => part.id).sort()).toEqual([`leash-${side}-acid`, `leash-${side}-vermilion`]);
        // Unbroken: each line runs on for centimetres between what hides it (cut into the print's twelve-point pieces it fell into dashes of 1 to 2 mm).
        for (const ink of ['acid', 'vermilion']) {
          const longest = Math.max(...paths(result, `leash-${side}-${ink}`).map(path => path.slice(1).reduce((l, q, i) => l + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0)));
          expect(longest, `${fit} ${side} ${ink}`).toBeGreaterThan(10);
        }
      }
      // The doors' slabs are trimmed (kit/slabs.ts' `SlabTrim`): untrimmed, their back edges and slivers ran the two doors to
      // 690-780 mm of line; trimmed, 625-640 mm.
      expect(length(result, 'door-'), fit).toBeLessThan(665);
    }
  }, 240_000);

  it('scales its halos: the sky clears the pillar and the doors and stands off the echo, and the echo clears what stands, by their scaled halos, floored', async () => {
    for (const fit of fits) {
      const result = await render(fit);
      const { s } = formatOf(fit);
      const solid = [...dense(result, 'pillar-'), ...dense(result, 'door-')], echo = dense(result, 'echo-');
      // The sky's knockout and its stand-off from the echo, 1.1 mm on the print: scaled (0.28-0.31 mm), under the 0.5 mm
      // floor, give or take a cell of its mask (0.50-0.63 mm); left at the print's size the nearest rule stops 0.9-1.1 mm short.
      const sky = ends(result, 'sky-');
      for (const [what, gap] of [['solid', nearestDistance(sky, solid)], ['echo', nearestDistance(sky, echo)]] as const) {
        expect(gap, `${fit} sky to ${what}`).toBeGreaterThan(0.35);
        expect(gap, `${fit} sky to ${what}`).toBeLessThan(Math.max(0.5, 1.1 * s) + 0.25);
      }
      // The echo stops short of what stands in front of it by the print's 2.2 mm scaled (0.55-0.61 mm): 0.55-0.60 mm; left
      // at the print's size, 2.4-2.5 mm.
      const echoGap = nearestDistance(ends(result, 'echo-'), solid);
      expect(echoGap, `${fit} echo to solid`).toBeGreaterThan(0.35);
      expect(echoGap, `${fit} echo to solid`).toBeLessThan(Math.max(0.5, 2.2 * s) + 0.3);
    }
  }, 240_000);

  it('is no denser than its tabloid print, part by part, which the print shrunk to the card is', async () => {
    const [master, ...small] = await Promise.all([print(), ...fits.map(render)]);
    const reference = probe(master);
    for (const result of small) {
      const report = probe(result);
      expect(denserThan(report, reference), describeDensity(report)).toEqual([]);
      expect(report.share).toBeLessThan(reference.share);
    }
    // The negative control: the print scaled down onto the card, as a sketch that is not page-aware is, its rulings, the
    // doors' hatch and the figures' bands shrinking with it.
    const k = Math.min(70 / TABLOID_PAGE.width, 120 / TABLOID_PAGE.height);
    const shrunk = { ...master, parts: master.parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(p => ({ x: p.x * k, y: p.y * k }))) })) };
    const denser = denserThan(probe(shrunk), reference).map(p => p.id);
    for (const id of ['sky-carbon', 'shadow-carbon', 'door-left-carbon', 'door-right-carbon', 'figure-carbon']) expect(denser).toContain(id);
  }, 240_000);

  it('draws in its preferred fit, width, where the render names none', async () => {
    const [plain, width] = await Promise.all([renderSketch({ entry, seed: 1, finishing: { page }, timeoutMs: 120_000 }), render('width')]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.parts).toEqual(width.parts);
  }, 240_000);
});
