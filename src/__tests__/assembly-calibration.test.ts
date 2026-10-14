import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkInksRead } from '../../cli/assembly-world.ts';
import { loadStack } from '../../cli/finalize.ts';
import { validateSketch } from '../../packages/plot-core/src/index.ts';
import { GUIDE_DEFAULTS, cutGuides, renderPly } from '../sketch/assembly.ts';
import { clipToRegion, distanceToRings, inRegion } from '../sketch/region.ts';
import type { Part, Point } from '../sketch/types.ts';
import sketch, {
  BLEED_OFFSETS, DEFAULT_DATE, G1, GHOST_BLACK, GHOST_SILVER, MARGIN_OFFSETS, PAGE, SWATCH, VARIANTS, W1, W2, bleedLadder, buildWorld, cuts,
  marginLadder, pens, spec, swatch, vernier,
} from '../../sketches/assembly-calibration/sketch.ts';
import { sketchContext } from './helpers/sketch-context.ts';

const length = (paths: Point[][]): number => paths.reduce((sum, path) => sum + path.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0), 0);
const world = buildWorld(DEFAULT_DATE, 1);
const render = (ply: string): Part[] => sketch.draw(sketchContext(1, { ply, date: DEFAULT_DATE })) as Part[];
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe('assembly calibration', () => {
  it('is a valid sketch of three plies, black under gold under white, each ink read on its own paper or on trial', () => {
    expect(() => validateSketch(sketch)).not.toThrow();
    expect(spec).toMatchObject({ control: 'ply', cutPen: 'cut', margin: 0.3, bleed: 5 });
    expect(spec.plies.map((p) => [p.id, p.paper.id, p.cutInk])).toEqual([['black', 'black', 'silver'], ['gold', 'gold-yellow', 'black'], ['white', 'white', 'carbon']]);
    expect(spec.signature).toBeUndefined(); // a test sheet, not signed
    expect(sketch.page).toEqual(PAGE);
    expect(pens.map((p) => p.id)).toContain('cut');
    expect(spec.plies.map((p) => checkInksRead(p, { trialInks: true }))).toEqual([[], ['gold'], ['silver', 'fluoro-pink', 'fluoro-orange']]);
    expect(() => checkInksRead(spec.plies[2])).toThrow(/ink silver does not read on paper white/);
  });

  it('cuts the windows as designed: W1 and W2 in the white, G1 inside W2 in the gold, five small windows with guide options', () => {
    const c = cuts();
    expect(Object.keys(c).sort()).toEqual(['gold', 'white']);
    expect(c.gold.map((cut) => cut.id)).toEqual(['g1']);
    expect(c.white.map((cut) => cut.id)).toEqual(['w1', 'w2', 'va', 'vb', 'vc', 'vd', 'ml']);
    expect([W1.x1 - W1.x0, W1.y1 - W1.y0, W2.x1 - W2.x0, W2.y1 - W2.y0]).toEqual([115, 180, 105, 180]);
    expect([G1.x0 - W2.x0, G1.y0 - W2.y0, W2.x1 - G1.x1, W2.y1 - G1.y1]).toEqual([12, 12, 12, 12]);
    expect(c.white.filter((cut) => cut.guide).map((cut) => [cut.label, cut.guide])).toEqual([
      ['CUT A', { pitch: 12, size: 4 }], ['CUT B', { pitch: 8, size: 3 }], ['CUT C', { pitch: 16, size: 6 }], [undefined, { label: false }],
    ]);
  });

  it('draws every ply with all its art in view: nothing is clipped away, and every ply carries the same cuts', () => {
    const diagnostics = (ply: string) => render(ply).filter((p) => p.id.startsWith('asm-'));
    for (const ply of spec.plies) {
      const parts = render(ply.id);
      for (const source of [...(world.art[ply.id] ?? []), ...(world.sealed[ply.id] ?? [])]) {
        const drawn = parts.find((p) => p.id === source.id);
        expect(drawn, `${ply.id}: ${source.id}`).toBeDefined();
        near(length(drawn!.paths), length(source.paths));
        expect(ply.pens).toContain(source.pen);
      }
      expect(diagnostics(ply.id)).toEqual(diagnostics('white'));
    }
    // The check bites: a swatch dropped inside a gold window, or onto a window of the white, does not survive.
    const bad = buildWorld(DEFAULT_DATE, 1);
    bad.art.gold.push({ ...swatch('black', 'gold-yellow', G1.x0 + 10, G1.y0 + 10), id: 'inside-g1' });
    bad.art.white.push({ ...swatch('carbon', 'white', W1.x0 + 10, W1.y0 + 10), id: 'inside-w1' });
    for (const [ply, id] of [['gold', 'inside-g1'], ['white', 'inside-w1']]) {
      expect(renderPly(spec, { params: { ply }, page: PAGE }, pens, bad).find((p) => p.id === id)).toBeUndefined();
    }
  });

  it('refuses a page it is not laid out for', () => {
    expect(() => sketch.draw({ ...sketchContext(1, { ply: 'white', date: DEFAULT_DATE }), page: { width: 210, height: 297, margin: 11 } })).toThrow(/laid out for 279.4 x 431.8 mm/);
  });
});

describe('assembly calibration: swatches', () => {
  it('carry each ply’s own inks, marked "(trial)" when the paper has not trusted them yet', () => {
    const labels = (ply: string) => (world.art[ply] ?? []).filter((p) => p.id.startsWith('swatch-')).map((p) => p.pen);
    expect(labels('black')).toEqual(['gold', 'silver', 'fluoro-pink', 'fluoro-orange', 'fluoro-green', 'fluoro-yellow']);
    expect(labels('gold')).toEqual(['black', 'gold']);
    expect(labels('white')).toEqual(['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'silver', 'fluoro-pink', 'fluoro-orange']);
    // The label is the only text: the same swatch on a paper where the ink reads has a shorter label.
    const trial = swatch('silver', 'white', 20, 20), reads = swatch('silver', 'black', 20, 20);
    expect(trial.paths.length).toBeGreaterThan(reads.paths.length);
  });

  it('are a 22 x 12 patch at 0.6 mm, a line, a dashed line and a 3 mm strip at 0.3 mm', () => {
    const part = swatch('carbon', 'white', 20, 100);
    const horizontal = part.paths.filter((p) => p.length === 2 && p[0].y === p[1].y);
    const at = (x0: number, x1: number) => horizontal.filter((p) => Math.min(p[0].x, p[1].x) >= x0 - 1e-9 && Math.max(p[0].x, p[1].x) <= x1 + 1e-9);
    const patch = at(20, 42).map((p) => p[0].y).sort((a, b) => a - b);
    expect(patch).toHaveLength(20);
    expect(patch[0]).toBeCloseTo(100.3, 6);
    for (let i = 1; i < patch.length; i++) near(patch[i] - patch[i - 1], SWATCH.patch.pitch);
    expect(patch[19]).toBeLessThan(112);
    const beside = at(45, 67).map((p) => p[0].y).sort((a, b) => a - b);
    const strip = beside.filter((y) => y >= 108);
    expect(strip).toHaveLength(10);
    for (let i = 1; i < strip.length; i++) near(strip[i] - strip[i - 1], SWATCH.strip.pitch);
    expect(beside.filter((y) => y < 108).length).toBeGreaterThan(3); // the single line and the dashes
    expect(Math.max(...strip) - Math.min(...strip)).toBeLessThan(3);
  });
});

describe('assembly calibration: guide variants', () => {
  it('draw X marks and, but for D, a label that the marks make room for: at 30 x 20 mm variants A and C lost theirs', () => {
    const parts = render('white');
    const sameStroke = (a: Point[], b: Point[]) => a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y);
    for (const v of VARIANTS) {
      const cut = cuts().white.find((c) => c.id === v.id)!;
      const bare = cutGuides({ ...cut, label: undefined }, 'cut', { ...GUIDE_DEFAULTS, ...cut.guide, label: false, penWidth: 0.25 });
      expect((bare.paths.length - 1) / 2, `${v.id} X marks`).toBeGreaterThanOrEqual(3); // one outline, then two strokes per X
      const drawn = parts.find((p) => p.id === `cut-${v.id}`)!;
      const label = drawn.paths.filter((p) => !bare.paths.some((q) => sameStroke(p, q)));
      if (v.label) expect(label.length, `${v.id} label strokes`).toBeGreaterThanOrEqual(4);
      else expect(drawn.paths, 'D has no label').toEqual(bare.paths);
    }
  });
});

describe('assembly calibration: ladders', () => {
  const lineOf = (part: Part) => part.paths.filter((p) => p.length === 2 && (p[0].x === p[1].x || p[0].y === p[1].y));

  it('margin ladders: four lines parallel to a cut edge at 0.5, 1.0, 1.5 and 2.0 mm, on the kept paper, each labelled', () => {
    expect(MARGIN_OFFSETS).toEqual([0.5, 1, 1.5, 2]);
    const gold = world.art.gold.find((p) => p.id === 'margin-gold')!, white = world.art.white.find((p) => p.id === 'margin-white')!;
    for (const [part, cut] of [[gold, cuts().gold[0]], [white, cuts().white.find((c) => c.id === 'ml')!]] as const) {
      const lines = lineOf(part).filter((p) => p[0].y === p[1].y).sort((a, b) => distanceToRings(a[0], cut.rings) - distanceToRings(b[0], cut.rings));
      expect(lines).toHaveLength(4);
      lines.forEach((l, i) => {
        near(distanceToRings(l[0], cut.rings), MARGIN_OFFSETS[i]);
        near(distanceToRings(l[1], cut.rings), MARGIN_OFFSETS[i]);
      });
      // They are outside the window (kept paper), and plotted as asked: art may sit 0.3 mm from the cut, so none is clipped.
      expect(length(clipToRegion(lines, { not: { rings: cut.rings } }))).toBeCloseTo(length(lines), 6);
      expect(part.paths.length).toBeGreaterThan(4 * 3); // the offsets are written beside the lines
    }
    expect(marginLadder('carbon', 0, 100, 1, 'x').paths.length).toBe(marginLadder('carbon', 0, 100, -1, 'x').paths.length);
  });

  it('bleed ladders: seven lines toward the window’s bottom edge ending -1, -0.5, 0, 0.5, 1, 2 and 3 mm past it', () => {
    expect(BLEED_OFFSETS).toEqual([-1, -0.5, 0, 0.5, 1, 2, 3]);
    for (const [ply, edge] of [['gold', W1.y1], ['black', G1.y1]] as const) {
      const part = world.art[ply].find((p) => p.id === `bleed-${ply}`)!;
      const lines = lineOf(part).filter((p) => p[0].x === p[1].x).sort((a, b) => a[0].x - b[0].x);
      expect(lines.map((l) => +(l[1].y - edge).toFixed(6))).toEqual(BLEED_OFFSETS);
      for (const l of lines) expect(l[0].y).toBeLessThan(edge - 5); // each starts well inside the window
    }
    expect(bleedLadder('black', 0, 100, 9, 'b').paths.filter((p) => p.length === 2 && p[0].x === p[1].x)).toHaveLength(7);
  });
});

describe('assembly calibration: verniers', () => {
  const pair = (axis: 'x' | 'y') => vernier(axis, 100, 50);
  const along = (p: Point[], axis: 'x' | 'y') => (axis === 'x' ? p[0].x : p[0].y);
  const across = (p: Point, axis: 'x' | 'y') => (axis === 'x' ? p.y : p.x);

  it('has a main scale of 21 ticks at 1.00 mm and a vernier of 11 at 0.90 mm, zero ticks aligned, every fifth longer', () => {
    for (const axis of ['x', 'y'] as const) {
      const v = pair(axis);
      expect(v.main).toHaveLength(21);
      expect(v.scale).toHaveLength(11);
      v.main.forEach((tick, i) => near(along(tick, axis), 50 + (i - 10)));
      v.scale.forEach((tick, k) => near(along(tick, axis), 50 + 0.9 * k));
      near(along(v.main[10], axis), along(v.scale[0], axis)); // the zeros line up
      const visible = (tick: Point[]) => 100 - across(tick[0], axis);
      v.main.forEach((tick, i) => {
        expect(visible(tick)).toBe((i - 10) % 5 === 0 ? 6 : 4);
        near(across(tick[1], axis), 104); // 4 mm under the upper paper
      });
      v.scale.forEach((tick, k) => {
        near(across(tick[0], axis), 100.31); // on the paper, just outside the 0.3 mm art margin
        near(across(tick[1], axis) - across(tick[0], axis), k % 5 === 0 ? 6 : 4);
      });
    }
  });

  it('reads tenths as the vernier tick that lines up: reading = n + 0.1 k, for shifts from -2.9 to +1.9 mm', () => {
    const v = pair('x');
    // The aligned main tick j = n + k has to be on the 21-tick scale (j <= 10), so a shift of about +2 mm or more is out of reach of the tenths.
    for (let tenth = -29; tenth <= 19; tenth++) {
      const d = tenth / 10; // the upper sheet sits d mm to the right
      const verniers = v.scale.map((t, k) => ({ k, x: along(t, 'x') + d }));
      const mains = v.main.map((t, i) => ({ j: i - 10, x: along(t, 'x') }));
      const lined = verniers.flatMap((a) => mains.filter((b) => Math.abs(a.x - b.x) < 1e-9).map((b) => ({ k: a.k, j: b.j })));
            for (const { k, j } of lined) near(j - 0.9 * k, d);
      // Tick 10 lining up means tick 0 lines up with the next main tick, so the tenths come from ticks 0 to 9.
      const tenths = lined.filter(({ k }) => k < 10);
      expect(tenths.length, `shift ${d}`).toBe(1);
      near(Math.floor(d + 1e-9) + 0.1 * tenths[0].k, d); // n, the main tick at or before the vernier's zero, plus 0.1 k
    }
  });

  it('puts the pairs on the right edges: white over gold at W1, gold over black at G1, x on a horizontal edge and y on a vertical one', () => {
    const lowerSealed = (ply: string, id: string) => world.sealed[ply].find((p) => p.id === id)!.paths;
    const upperArt = (ply: string, id: string) => world.art[ply].find((p) => p.id === id)!.paths;
    // Ticks of the lower ply run under the edge (the sealed main scale) and the vernier stands on the upper paper.
    expect(Math.max(...lowerSealed('gold', 'vernier-w-x-main').flat().map((p) => p.y))).toBeCloseTo(W1.y1 + 4, 6);
    expect(Math.max(...lowerSealed('gold', 'vernier-w-y-main').flat().map((p) => p.x))).toBeCloseTo(W1.x1 + 4, 6);
    expect(Math.max(...lowerSealed('black', 'vernier-g-x-main').flat().map((p) => p.y))).toBeCloseTo(G1.y1 + 4, 6);
    expect(Math.max(...lowerSealed('black', 'vernier-g-y-main').flat().map((p) => p.x))).toBeCloseTo(G1.x1 + 4, 6);
    expect(Math.min(...upperArt('white', 'vernier-w-x-scale').slice(0, 11).flat().map((p) => p.y))).toBeCloseTo(W1.y1 + 0.31, 6);
    expect(Math.min(...upperArt('white', 'vernier-w-y-scale').slice(0, 11).flat().map((p) => p.x))).toBeCloseTo(W1.x1 + 0.31, 6);
    expect(Math.min(...upperArt('gold', 'vernier-g-x-scale').slice(0, 11).flat().map((p) => p.y))).toBeCloseTo(G1.y1 + 0.31, 6);
    expect(Math.min(...upperArt('gold', 'vernier-g-y-scale').slice(0, 11).flat().map((p) => p.x))).toBeCloseTo(G1.x1 + 0.31, 6);
    // The sealed main scale stays whole under the upper paper: renderPly does not clip it.
    expect(render('gold').find((p) => p.id === 'vernier-w-x-main')!.paths).toHaveLength(21);
  });
});

describe('assembly calibration: ghosts and the stack', () => {
  it('hides a dense hatch under the paper above, clear of every window, with a white caption over each', () => {
    const ghost = (ply: string, id: string) => world.sealed[ply].find((p) => p.id === id)!;
    const c = cuts();
    for (const [part, area, above] of [[ghost('black', 'ghost-silver'), GHOST_SILVER, [...c.gold, ...c.white]], [ghost('gold', 'ghost-black'), GHOST_BLACK, c.white]] as const) {
      const xs = part.paths.flat().map((p) => p.x), ys = part.paths.flat().map((p) => p.y);
      expect([Math.min(...xs), Math.max(...xs)]).toEqual([area.x0, area.x1]);
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(24.4, 6); // 62 lines, the first half a pitch in
      expect(part.paths.length).toBe(62); // 25 mm at 0.4 mm pitch
      for (const cut of above) {
        for (const p of part.paths.flat()) expect(!inRegion(p, { rings: cut.rings }) && distanceToRings(p, cut.rings) > 1, `${cut.id} is clear of the ghost box`).toBe(true);
      }
    }
    for (const id of ['ghost-caption-silver', 'ghost-caption-black']) {
      const caption = world.art.white.find((p) => p.id === id)!;
      expect(caption.pen).toBe('carbon');
      expect(Math.min(...caption.paths.flat().map((p) => p.y))).toBeGreaterThan(262);
      expect(Math.max(...caption.paths.flat().map((p) => p.y))).toBeLessThan(287);
    }
  });

  it('stack.json is one assembly of the three plies on crop marks, allowing trial inks', () => {
    const stack = loadStack('sketches/assembly-calibration/stack.json');
    expect(stack.border).toEqual({ style: 'cropmarks', pen: 'cut' });
    expect(stack.page).toEqual(PAGE);
    expect(stack.defaults).toMatchObject({ trialInks: true });
    expect(stack.out).toBe('.sketch-output/finalize/assembly-calibration');
    expect(stack.pieces.map((p) => [p.assembly, p.seed, p.params?.ply])).toEqual([['calibration', 1, 'black'], ['calibration', 1, 'gold'], ['calibration', 1, 'white']]);
    const notes = JSON.parse(readFileSync('sketches/assembly-calibration/notes.json', 'utf8')) as Record<string, string>;
    expect(Object.keys(notes).sort()).toEqual(stack.pieces.map((p) => p.name).sort());
    for (const text of Object.values(notes)) expect(text).toMatch(/1 hour[\s\S]*Report back/);
  });
});
