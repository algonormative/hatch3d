import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { BACK_FORMS } from '../../sketches/breach-tarot/back/geometry.ts';
import { formatFor } from '../../sketches/kit/format.ts';
import { pathLength, segDist } from '../../sketches/kit/page.ts';
import type { Page, Part, Point, RenderResult } from '../sketch/types.ts';

const entry = resolve('sketches/breach-tarot/back/sketch.ts');
/** The plotter's card, and the print trim as the print stack lays it out. */
const PLOT = { width: 70, height: 120 };
const PRINT: Page = (JSON.parse(readFileSync(resolve('sketches/phase-garden/stacks/tarot-print.json'), 'utf8')) as { page: Page }).page;
/** The print's safe zone, and the half-width of its widest stroke (print-export's colour width), in millimetres. */
const SAFE_MM = 5, PRINT_HALF_STROKE = 0.42 / 2;
/**
 * A back is plotted 22 times: its line, at 70 x 120, in millimetres. The first three forms keep under 3 m; the two that
 * gather the deck's elements (`composite`) and redraw the Breach Cathedral (`cathedral`) under 3.5 m.
 */
const BUDGET_MM: Record<string, number> = { helix: 3000, labyrinth: 3000, field: 3000, composite: 3500, cathedral: 3500 };
/** How far a turned path may lie from the path it lands on. */
const TOLERANCE_MM = 0.05;

const render = (form: string, page: Page, sketch = entry) => renderSketch({ entry: sketch, seed: 1, params: { form }, finishing: { page }, timeoutMs: 120_000 });

/**
 * A render of the back that also keeps what it drew before finishing. Finishing clips every part to the page margin,
 * which is the card's edge, so the rendered paths are inside the card whatever the sketch draws: the raw parts show
 * whether the back itself keeps inside, with nothing cut away. A page-aware probe wraps the sketch and writes them out.
 */
async function drawn(dir: string, form: string, page: Page): Promise<{ result: RenderResult; raw: Part[] }> {
  const out = join(dir, `${form}-${page.width}.json`), probe = join(dir, `${form}-${page.width}.ts`);
  writeFileSync(probe, `import { writeFileSync } from 'node:fs';
    import back from ${JSON.stringify(entry)};
    export default { ...back, name: 'back-probe', draw(ctx) { const parts = back.draw(ctx); writeFileSync(${JSON.stringify(out)}, JSON.stringify(parts)); return parts; } };\n`);
  const result = await render(form, page, probe);
  return { result, raw: JSON.parse(readFileSync(out, 'utf8')) as Part[] };
}

/** Points along a path no more than `step` apart. */
function dense(path: Point[], step = 0.02): Point[] {
  const out = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 1; j <= k; j++) out.push({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k });
  }
  return out;
}
/** The farthest any point of `a` lies from the polyline `b`. */
const reach = (a: Point[], b: Point[]) => Math.max(...a.map(p => {
  let d = Infinity;
  for (let i = 1; i < b.length; i++) d = Math.min(d, segDist(p, b[i - 1], b[i]));
  return b.length === 1 ? Math.hypot(p.x - b[0].x, p.y - b[0].y) : d;
}));
const bounds = (path: Point[]) => ({ x0: Math.min(...path.map(p => p.x)), x1: Math.max(...path.map(p => p.x)), y0: Math.min(...path.map(p => p.y)), y1: Math.max(...path.map(p => p.y)) });

/**
 * Every path turned 180° about the card's centre, matched one to one with a path in the same pen that it lands on
 * within the tolerance (both ways: the Hausdorff distance between them). Returns the paths that found no partner.
 */
function unmatchedWhenTurned(result: RenderResult): string[] {
  const card = formatFor(result.metadata.page).card;
  const cx = (card.x0 + card.x1) / 2, cy = (card.top + card.bottom) / 2;
  const turn = (p: Point): Point => ({ x: 2 * cx - p.x, y: 2 * cy - p.y });
  const byPen = new Map<string, Point[][]>();
  for (const part of result.parts) byPen.set(part.pen, [...(byPen.get(part.pen) ?? []), ...part.paths]);
  const lost: string[] = [];
  for (const [pen, paths] of byPen) {
    const boxes = paths.map(bounds), used = new Set<number>();
    paths.forEach((path, i) => {
      const turned = path.map(turn), box = bounds(turned), samples = dense(turned);
      const near = (j: number) => !used.has(j) && Math.abs(boxes[j].x0 - box.x0) <= TOLERANCE_MM && Math.abs(boxes[j].x1 - box.x1) <= TOLERANCE_MM
        && Math.abs(boxes[j].y0 - box.y0) <= TOLERANCE_MM && Math.abs(boxes[j].y1 - box.y1) <= TOLERANCE_MM;
      const j = paths.findIndex((other, k) => near(k) && reach(samples, other) <= TOLERANCE_MM && reach(dense(other), turned) <= TOLERANCE_MM);
      if (j < 0) lost.push(`${pen} path ${i} from (${path[0].x.toFixed(2)}, ${path[0].y.toFixed(2)})`);
      else used.add(j);
    });
  }
  return lost;
}

describe('Breach Tarot: the back', () => {
  const plotted = new Map<string, { result: RenderResult; raw: Part[] }>(), printed = new Map<string, { result: RenderResult; raw: Part[] }>();
  let dir = '';
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hatch3d-back-'));
    for (const form of BACK_FORMS) {
      plotted.set(form, await drawn(dir, form, PLOT));
      printed.set(form, await drawn(dir, form, PRINT));
    }
  }, 600_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it.each(BACK_FORMS)('%s replays to the byte and draws without diagnostics', async form => {
    const [first, replay] = [await render(form, PLOT), await render(form, PLOT)];
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    expect(printed.get(form)!.result.diagnostics).toEqual([]);
    expect(first.parts.length).toBeGreaterThan(1);
  }, 120_000);

  it.each(BACK_FORMS)('%s is the same turned 180° about the card’s centre, path for path and pen for pen', form => {
    for (const { result } of [plotted.get(form)!, printed.get(form)!]) {
      expect(unmatchedWhenTurned(result)).toEqual([]);
    }
  }, 120_000);

  it.each(BACK_FORMS)('%s draws nothing outside the card, and on the print nothing in the safe zone', form => {
    for (const { result, raw } of [plotted.get(form)!, printed.get(form)!]) {
      const card = formatFor(result.metadata.page).card;
      const points = raw.flatMap(part => part.paths.flat());
      expect(points.length).toBeGreaterThan(0);
      for (const p of points) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(p.x).toBeGreaterThanOrEqual(card.x0 - 0.01);
        expect(p.x).toBeLessThanOrEqual(card.x1 + 0.01);
        expect(p.y).toBeGreaterThanOrEqual(card.top - 0.01);
        expect(p.y).toBeLessThanOrEqual(card.bottom + 0.01);
      }
    }
    const page = printed.get(form)!.result.metadata.page;
    expect(page).toMatchObject({ width: PRINT.width, height: PRINT.height });
    const edge = SAFE_MM + PRINT_HALF_STROKE;
    for (const p of printed.get(form)!.raw.flatMap(part => part.paths.flat())) {
      expect(Math.min(p.x, page.width - p.x, p.y, page.height - p.y)).toBeGreaterThanOrEqual(edge);
    }
  });

  it.each(BACK_FORMS)('%s plots within its line budget at 70 x 120', form => {
    const total = plotted.get(form)!.raw.reduce((sum, part) => sum + part.paths.reduce((s, path) => s + pathLength(path), 0), 0);
    expect(total).toBeGreaterThan(500);
    expect(total).toBeLessThanOrEqual(BUDGET_MM[form]);
  });

  it('composite winds its helix round every gate block, never through or under one', () => {
    // Each gate block's page footprint, from its outline: the boxes of its edges, merged where they touch, and merged
    // again into courses where they share a height (so a course split by a breach counts as one).
    const HALO = 0.5;
    for (const { raw } of [plotted.get('composite')!, printed.get('composite')!]) {
      let boxes = raw.filter(part => part.id === 'gate-carbon').flatMap(part => part.paths.map(bounds));
      const touch = (a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>, slack: number, xToo: boolean) =>
        a.y0 <= b.y1 + slack && b.y0 <= a.y1 + slack && (!xToo || (a.x0 <= b.x1 + slack && b.x0 <= a.x1 + slack));
      for (const xToo of [true, false]) {
        for (let merged = true; merged;) {
          merged = false;
          for (let i = 0; i < boxes.length && !merged; i++) for (let j = i + 1; j < boxes.length && !merged; j++) {
            if (!touch(boxes[i], boxes[j], xToo ? 0.3 : -0.3, xToo)) continue;
            const [a, b] = [boxes[i], boxes[j]];
            boxes = [...boxes.filter((_, k) => k !== i && k !== j), { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) }];
            merged = true;
          }
        }
      }
      // Three courses at the head and three at the foot.
      expect(boxes).toHaveLength(6);
      const strays = raw.filter(part => part.id.startsWith('thread-')).flatMap(part => part.paths.flat())
        .filter(p => boxes.some(b => p.x > b.x0 - HALO && p.x < b.x1 + HALO && p.y > b.y0 - HALO && p.y < b.y1 + HALO));
      expect(strays.slice(0, 3)).toEqual([]);
    }
  });

  it('composite draws every element of the deck, each in its own inks, at both sizes', () => {
    // The slab gates, the labyrinth, the dark heart, the star, and the helix in all four of its inks.
    const wanted = ['gate-carbon', 'gate-ultramarine', 'labyrinth-carbon', 'heart-carbon', 'star-carbon', 'thread-acid', 'thread-vermilion', 'thread-ultramarine', 'thread-violet'];
    for (const { raw } of [plotted.get('composite')!, printed.get('composite')!]) {
      const ids = new Set(raw.filter(part => part.paths.length).map(part => part.id));
      for (const id of wanted) expect(ids, id).toContain(id);
    }
  });
});
