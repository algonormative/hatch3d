import noiseGridCircles from '../../src/compositions/2d/generative/noise-grid-circles.ts';
import { createHatch3d2DSketch } from '../../src/sketch/hatch3d.ts';

/** Existing noise-circle generator with native controls, seed, and placement. */
export default createHatch3d2DSketch({
  composition: noiseGridCircles,
  page: { width: 210, height: 148, margin: 12, paper: '#f7f4ec' },
  pen: { id: 'charcoal', color: '#30383e', width: 0.25 },
  prefix: 'circles',
  defaults: { gridCols: 18, gridRows: 14, circleSegments: 16 },
  seedValueKey: 'noiseSeed',
});
