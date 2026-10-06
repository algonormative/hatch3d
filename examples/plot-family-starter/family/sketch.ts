import type { Sketch } from '@hatch3d/plot-core';
import { crossingLines } from './geometry.ts';

/** One independent family view, with its own intent and controls. */
const sketch: Sketch = {
  name: 'Crossing field',
  page: { width: 210, height: 148, margin: 12, paper: '#f7f4ec' },
  pens: [{ id: 'graphite', color: '#30343a', width: 0.3 }],
  controls: [
    { type: 'slider', id: 'spacing', label: 'Line spacing', min: 4, max: 20, step: 1, default: 10, units: 'mm' },
    { type: 'slider', id: 'drift', label: 'Right edge drift', min: -12, max: 12, step: 1, default: 3, units: 'mm' },
  ],
  assets: { tonalReference: { path: 'assets/reference.png', box: { x: 24, y: 24, width: 162, height: 100 }, fit: 'contain' } },
  draw(ctx) {
    return [{ id: 'crossing-field', pen: 'graphite', paths: crossingLines(Number(ctx.params.spacing), Number(ctx.params.drift)) }];
  },
};
export default sketch;
