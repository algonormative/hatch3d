import type { Sketch } from '../../src/sketch/types.ts';
import { PAPERS } from '../../src/sketch/materials.ts';
import base, { draw } from './sketch.ts';

/** The same piece on the sheet stood upright, for the labs and renders that take their page from the entry. */
const PAGE = { width: 279.4, height: 431.8, margin: 14 };

const sketch: Sketch = {
  ...base,
  name: 'God in the Machine (portrait)',
  page: { ...PAGE, paper: PAPERS.black.color },
  draw(ctx) {
    const { width, height, margin } = { ...PAGE, ...ctx.page };
    return draw(ctx, { width, height, margin });
  },
};
export default sketch;
