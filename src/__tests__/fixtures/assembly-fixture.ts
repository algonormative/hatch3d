import { plyControl, renderPly, validateCuts } from '../../sketch/assembly.ts';
import { PAPERS, inkPen } from '../../sketch/materials.ts';
import type { AssemblySpec, Cut, Cuts, Part, Point, Sketch } from '../../sketch/types.ts';

/**
 * Two tiny panels for the assembly tools. Panel L: a white sheet under a black sheet, the black one cut with a window
 * (waste) and a bar (a part, kept). Panel R: a white sheet with the bar glued on top as an onlay, turned a quarter and
 * set down at a different place. Four options break one thing each, for the checks that must catch it.
 */
const page = { width: 100, height: 140, margin: 16, paper: '#ffffff' };
const pens = [inkPen('gold'), inkPen('black'), inkPen('carbon')];
const P = (x: number, y: number): Point => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];

export const WINDOW = rect(24, 26, 56, 56);
export const BAR = rect(22, 76, 78, 90);
/** The bar as panel R sets it: turned a quarter about its centre (50, 83) and set down centred on (50, 60). */
export const placed = (ring: Point[], scale = 1): Point[] => ring.map((p) => P(50 - (p.y - 83), 60 + (p.x - 50) * scale));

const lines = (horizontal: boolean, from: number, step: number, count: number): Point[][] =>
  Array.from({ length: count }, (_, i) => (horizontal
    ? [P(18, from + i * step), P(82, from + i * step)]
    : [P(from + i * step, 18), P(from + i * step, 122)]));

const spacing = { type: 'slider' as const, id: 'spacing', label: 'Spacing', default: 6, min: 3, max: 12, step: 1, units: 'mm' };
const windowShift = { type: 'slider' as const, id: 'windowShift', label: 'Window shift', default: 0, min: -4, max: 4, step: 1, units: 'mm' };

/**
 * Panel L. `whiteGold`: the white ply carries the gold pen, which does not read on white. `whiteTrial`: it carries
 * silver, which the catalog has on trial for white. `leaky`: the window moves with the ply. `equalInk`: both plies are
 * cut with an ink of one measured width, 0.39 mm (fluoro orange, on trial for white, and gold), so a border's spacing fits
 * the page alike on both.
 * `noCarbon`: the white ply, which signs in carbon, draws nothing in it. The `windowShift` control moves the window.
 */
export function lintelL(options: { whiteGold?: boolean; whiteTrial?: boolean; leaky?: boolean; equalInk?: boolean; noCarbon?: boolean } = {}): Sketch {
  const whitePen = options.whiteGold ? 'gold' : options.whiteTrial ? 'silver' : 'carbon';
  const spec: AssemblySpec = {
    control: 'ply', cutPen: 'black', margin: 1.5, bleed: 1,
    plies: [
      { id: 'white', paper: { id: 'white', color: PAPERS.white.color }, pens: [whitePen], cutInk: options.equalInk ? 'fluoro-orange' : 'black' },
      { id: 'black', paper: { id: 'black', color: PAPERS.black.color }, pens: ['gold'], cutInk: 'gold', lift: 0.4 },
    ],
    signature: { ply: 'white', pen: whitePen, box: { x: 50, y: 112, width: 30, height: 8 } },
  };
  const sketchPens = [...pens, ...(options.whiteTrial ? [inkPen('silver')] : []), ...(options.equalInk ? [inkPen('fluoro-orange')] : [])];
  return {
    name: 'Assembly fixture, panel L', page, pens: sketchPens, controls: [plyControl(spec), spacing, windowShift], assembly: spec,
    draw(ctx) {
      const step = Number(ctx.params.spacing);
      const shift = (options.leaky && ctx.params.ply === 'black' ? 2 : 0) + Number(ctx.params.windowShift);
      const cuts: Cuts = { black: [{ id: 'w', rings: [WINDOW.map((p) => P(p.x + shift, p.y))] }, { id: 'bar', kind: 'part', rings: [BAR] }] };
      validateCuts(spec, cuts, page);
      const art: Record<string, Part[]> = {
        white: options.noCarbon ? [] : [{ id: 'carbon-lines', pen: spec.plies[0].pens[0], paths: lines(true, 20, step, 18) }],
        black: [{ id: 'gold-lines', pen: 'gold', paths: lines(false, 20, 8, 8) }],
      };
      return renderPly(spec, ctx, sketchPens, { cuts, art });
    },
  };
}

/** Panel R. `skew`: the footprint is stretched by this factor along one axis, so it is no longer the bar. `from`: the onlay's source, which is malformed when it is not three names. */
export function lintelR(options: { skew?: number; from?: string } = {}): Sketch {
  const spec: AssemblySpec = {
    control: 'ply', cutPen: 'black', margin: 1.5, bleed: 1,
    plies: [
      { id: 'white', paper: { id: 'white', color: PAPERS.white.color }, pens: ['carbon'], cutInk: 'black' },
      { id: 'bar', paper: { id: 'black', color: PAPERS.black.color }, pens: [], cutInk: 'gold', onlay: { from: options.from ?? 'lintel-l/black/bar' } },
    ],
  };
  return {
    name: 'Assembly fixture, panel R', page, pens, controls: [plyControl(spec), spacing], assembly: spec,
    draw(ctx) {
      const cuts: Cuts = { bar: [{ id: 'bar', kind: 'footprint', rings: [placed(BAR, options.skew ?? 1)] } satisfies Cut] };
      validateCuts(spec, cuts, page);
      return renderPly(spec, ctx, pens, { cuts, art: { white: [{ id: 'carbon-lines', pen: 'carbon', paths: lines(true, 20, Number(ctx.params.spacing), 18) }] } });
    },
  };
}
