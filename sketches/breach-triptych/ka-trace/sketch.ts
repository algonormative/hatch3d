import type { AssemblySpec, Control, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { LODESTONE_ASSEMBLY } from '../lodestone-world.ts';
import { PAGE, PAPER, pensOf } from '../world.ts';
import { FIGURES } from './figures.ts';
import { world, type World } from './world.ts';

/**
 * Breach / Kawaii Aggro. Figures traced from concept images (`trace.py`), so each keeps the concept's flowing line: a
 * black sheet in silver and gold over a magenta sheet, every bit of colour the paper showing through a cut. Slipped,
 * Collar and Close also take Upward Erasure's plates, covered colour and glitch (`world.ts`).
 */

export const spec: AssemblySpec = {
  ...LODESTONE_ASSEMBLY,
  plies: [
    { id: 'magenta', paper: PAPER.magenta, pens: ['black'], cutInk: 'black' },
    { id: 'black', paper: PAPER.black, pens: ['silver', 'gold'], cutInk: 'silver' },
  ],
};
const pens = pensOf(['silver', 'gold', 'black']);

const slider = (id: string, label: string, d: number, min: number, max: number, step: number, group: string, units?: string): Control =>
  ({ type: 'slider', id, label, default: d, min, max, step, group, ...(units ? { units } : {}) });
const CONTROLS: Control[] = [
  { type: 'select', id: 'figure', label: 'The figure', default: 'collar', options: Object.keys(FIGURES), group: 'Figure',
    optionLabels: { slipped: 'Column: slipped bands', hem: 'Column: dissolving hem', collar: 'Profile: magenta collar', bob: 'Profile: magenta bob', quiet: 'Turned back: quiet', close: 'Turned back: close' } },
  { type: 'select', id: 'treatment', label: 'Treatment', default: 'full', options: ['full', 'plain'], group: 'Figure',
    optionLabels: { full: 'Plates, covered colour, glitch', plain: 'The trace alone' } },
  { type: 'select', id: 'sloganPlace', label: 'Where the slogan goes', default: 'off', options: ['off', 'visor', 'mass', 'stream', 'edge'], group: 'Slogan',
    optionLabels: { off: 'No slogan', visor: 'Readout in the visor', mass: 'Large on the colour, a word a line', stream: 'Out in the glitch, coming apart', edge: 'Up the edge of the sheet' } },
  { type: 'text', id: 'sloganText', label: 'Slogan', default: 'SLOGAN GOES HERE', maxLength: 64, group: 'Slogan' },
  { type: 'select', id: 'sloganFace', label: 'Lettering', default: 'matrix', options: ['matrix', 'wire', 'sans'], group: 'Slogan',
    optionLabels: { matrix: 'Dot matrix', wire: 'Wire', sans: 'Hershey sans' } },
  slider('minLine', 'Shortest traced line kept', 1.6, 0.6, 12, 0.2, 'Figure', 'mm'),
  slider('plateMm', 'Body plate size (where the figure leaves it free)', 30, 12, 90, 1, 'Plates', 'mm'),
  slider('hatchMm', 'Lines in a plate apart', 1.5, 0.8, 5, 0.1, 'Plates', 'mm'),
  slider('flowShare', 'Plates that keep the flowing lines', 0.4, 0, 1, 0.01, 'Plates'),
  slider('bareShare', 'Plates left bare', 0.12, 0, 0.8, 0.01, 'Plates'),
  slider('crossShare', 'Plates cross-hatched', 0.2, 0, 0.8, 0.01, 'Plates'),
  slider('plateSwing', 'Plates\' line angles vary', 0.8, 0, 1.6, 0.05, 'Plates'),
  slider('colourPlateMm', 'Colour plate size', 46, 14, 120, 1, 'Covered colour', 'mm'),
  slider('inkShare', 'Colour plates inked', 0.6, 0, 1, 0.01, 'Covered colour'),
  slider('inkMm', 'Ink lines on the colour apart', 2.2, 0.8, 6, 0.1, 'Covered colour', 'mm'),
  slider('visorPlateMm', 'Visor plate size', 22, 8, 70, 1, 'Covered colour', 'mm'),
  slider('visorInk', 'Visor covered', 0.55, 0, 1, 0.01, 'Covered colour'),
  slider('sliceShare', 'Slices moved', 0.32, 0, 1, 0.01, 'Glitch'),
  slider('shiftMm', 'Largest slice shift', 30, 0, 80, 1, 'Glitch', 'mm'),
  slider('sliceMin', 'Thinnest slice', 1.6, 1, 8, 0.1, 'Glitch', 'mm'),
  slider('sliceMax', 'Thickest slice', 20, 3, 60, 1, 'Glitch', 'mm'),
  slider('faceCap', 'Most the face can shift', 5, 0, 30, 0.5, 'Glitch', 'mm'),
  slider('reach', 'Columns reach', 1, 0, 2, 0.05, 'Glitch'),
  slider('colMin', 'Narrowest column', 3.5, 2, 12, 0.5, 'Glitch', 'mm'),
  slider('colMax', 'Widest column', 15, 4, 40, 1, 'Glitch', 'mm'),
  slider('colGaps', 'Columns missing', 0.32, 0, 0.9, 0.01, 'Glitch'),
  slider('pieces', 'Pieces lifted', 0.6, 0, 1.5, 0.05, 'Glitch'),
  slider('fragments', 'Fragments', 1, 0, 3, 0.05, 'Glitch'),
  slider('streaks', 'Streaks', 1, 0, 3, 0.05, 'Glitch'),
];

let last: { key: string; made: World } | undefined;
function worldOf(ctx: SketchContext, thin: boolean, preview: boolean): World {
  const key = JSON.stringify([thin, preview, ctx.seed, Object.entries(ctx.params).filter(([id]) => id !== spec.control).sort(([a], [b]) => (a < b ? -1 : 1))]);
  if (last?.key !== key) last = { key, made: world(ctx, thin, preview) };
  return last.made;
}

/** The lab's two sheets; a draft skips the thinning. */
export async function labSheets(ctx: SketchContext, quality: 'draft' | 'full' = 'full'): Promise<{ ply: string; parts: Part[]; cuts: Point[][] }[]> {
  const { windows, art } = worldOf(ctx, quality !== 'draft', true);
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
    const { windows, art } = worldOf(ctx, true, false);
    return renderPly(spec, ctx, pens, { cuts: { black: [{ id: 'windows', rings: windows, label: 'W' }] }, art });
  },
};

export default sketch;
