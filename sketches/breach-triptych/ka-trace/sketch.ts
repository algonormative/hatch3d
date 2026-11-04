import type { AssemblySpec, Control, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { thinRanked } from '../../kit/density.ts';
import { clipToRect, keepAlong, insideRing, pathLength } from '../../kit/page.ts';
import { ALONGSIDE_DEG, LINE_PITCH, LODESTONE_ASSEMBLY } from '../lodestone-world.ts';
import { ART, PAGE, PAPER, pensOf } from '../world.ts';
import slipped from './traces/02a-slipped.json';
import hem from './traces/02c-hem.json';
import collar from './traces/03b-collar.json';
import bob from './traces/03c-magenta-bob.json';
import quiet from './traces/04a-quiet.json';
import close from './traces/04c-close.json';

/**
 * Breach / Kawaii Aggro. Six figures traced from concept images (`trace.py`), so each keeps the concept's flowing line:
 * a black sheet in silver and gold over a magenta sheet, every bit of colour the paper showing through a cut.
 */

type Line = number[][];
interface Trace { silver: Line[]; gold: Line[]; black: Line[]; windows: Line[] }
const TRACES: Record<string, Trace> = { slipped, hem, collar, bob, quiet, close };

export const spec: AssemblySpec = {
  ...LODESTONE_ASSEMBLY,
  plies: [
    { id: 'magenta', paper: PAPER.magenta, pens: ['black'], cutInk: 'black' },
    { id: 'black', paper: PAPER.black, pens: ['silver', 'gold'], cutInk: 'silver' },
  ],
};
const pens = pensOf(['silver', 'gold', 'black']);

const CONTROLS: Control[] = [
  { type: 'select', id: 'figure', label: 'The figure', default: 'collar', options: Object.keys(TRACES), group: 'Figure',
    optionLabels: { slipped: 'Column: slipped bands', hem: 'Column: dissolving hem', collar: 'Profile: magenta collar', bob: 'Profile: magenta bob', quiet: 'Turned back: quiet', close: 'Turned back: close' } },
  { type: 'slider', id: 'minLine', label: 'Shortest line kept', default: 1.6, min: 0.6, max: 12, step: 0.2, group: 'Lines', units: 'mm' },
];

const points = (line: Line): Point[] => line.map(([x, y]) => ({ x, y }));
interface Item { pen: string; rank: number; piece: Point[] }

/** A sheet's lines, the long ones kept first where two run closer than the pen allows. */
function partsOf(items: Item[], prefix: string, thin: boolean): Part[] {
  const byPen = new Map<string, Point[][]>();
  const put = (pen: string, piece: Point[]) => byPen.set(pen, [...(byPen.get(pen) ?? []), piece]);
  if (thin) for (const { item, runs } of thinRanked(items, LINE_PITCH.gel, { angle: ALONGSIDE_DEG })) for (const run of runs) { if (pathLength(run) >= 0.6) put(item.pen, run); }
  else for (const item of items) put(item.pen, item.piece);
  return [...byPen].map(([pen, paths]) => ({ id: prefix + '-' + pen, pen, paths }));
}

function world(ctx: SketchContext, thin: boolean): { windows: Point[][]; art: { black: Part[]; magenta: Part[] } } {
  const trace = TRACES[String(ctx.params.figure)] ?? TRACES.collar, min = Number(ctx.params.minLine ?? 1.6);
  const windows = trace.windows.map(points);
  const inWindow = (p: Point) => windows.some(ring => insideRing(ring, p));
  const front = (lines: Line[], pen: string): Item[] => lines.map(points)
    .flatMap(line => clipToRect(line, ART)).flatMap(line => keepAlong(line, p => !inWindow(p), 0.2))
    .filter(piece => pathLength(piece) >= min)
    .map(piece => ({ pen, rank: (pen === 'gold' ? 0 : 1) + 1 / pathLength(piece), piece }));
  const back = trace.black.map(points).flatMap(line => clipToRect(line, ART))
    .map(piece => ({ pen: 'black', rank: 1 / pathLength(piece), piece }));
  return { windows, art: { black: partsOf([...front(trace.gold, 'gold'), ...front(trace.silver, 'silver')], 'black', thin), magenta: partsOf(back, 'magenta', thin) } };
}

/** The lab's two sheets; a draft skips the thinning. */
export async function labSheets(ctx: SketchContext, quality: 'draft' | 'full' = 'full'): Promise<{ ply: string; parts: Part[]; cuts: Point[][] }[]> {
  const { windows, art } = world(ctx, quality !== 'draft');
  return [{ ply: 'magenta', parts: art.magenta, cuts: [] }, { ply: 'black', parts: art.black, cuts: windows }];
}

const sketch: Sketch = {
  name: 'Breach / Kawaii Aggro',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls: [plyControl(spec), ...CONTROLS],
  assembly: spec,
  draw(ctx) {
    const { windows, art } = world(ctx, true);
    return renderPly(spec, ctx, pens, { cuts: { black: [{ id: 'windows', rings: windows, label: 'W' }] }, art });
  },
};

export default sketch;
