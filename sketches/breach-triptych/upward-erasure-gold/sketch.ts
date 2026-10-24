import type { AssemblySpec, Part, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { LODESTONE_ASSEMBLY } from '../lodestone-world.ts';
import { PAGE, PAPER, pensOf } from '../world.ts';
import { CONTROLS, erasure } from '../upward-erasure/world.ts';

/**
 * Upward Erasure's gold-yellow pieces: the bar and its fragments, cut out of a gold-yellow sheet where they will lie on
 * the assembled piece (so they are placed by eye against its own outline) and glued on top of the black
 * (`upward-erasure`, ply `gold`). Nothing is plotted on them but their cut lines.
 */

const plies = [{ id: 'gold', paper: PAPER.gold, pens: ['black'], cutInk: 'black' }];
export const spec: AssemblySpec = { ...LODESTONE_ASSEMBLY, plies };
const pens = pensOf(['black']);

function draw(ctx: SketchContext): Part[] {
  const e = erasure(ctx);
  // One part of several pieces, so the assembly lays them all with one fit (the onlay's footprint is the same rings).
  return renderPly(spec, ctx, pens, { cuts: { gold: [{ id: 'pieces', kind: 'part', rings: [e.bar, ...e.fragments] }] }, art: { gold: [] } });
}

const sketch: Sketch = {
  name: 'Breach / Lodestone: Upward Erasure, the gold-yellow pieces',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls: [plyControl(spec), ...CONTROLS],
  assembly: spec,
  draw,
};

export default sketch;
