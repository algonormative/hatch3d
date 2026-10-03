import doubleRing from '../../src/compositions/3d/geometric/double-ring.ts';
import spirograph from '../../src/compositions/2d/patterns/spirograph.ts';
import { createHatch3d3DSketch } from '../../src/sketch/hatch3d.ts';

/** Two rings and connector share a depth pass; the curve is paper-space ink. */
export default createHatch3d3DSketch({
  composition: doubleRing,
  page: { width: 210, height: 148, margin: 12, paper: '#f7f4ec' },
  pen: { id: 'rings', color: '#28353c', width: 0.28 },
  prefix: 'ringstudy',
  viewDefaults: { camDist: 5.5 },
  paper: {
    composition: spirograph,
    pen: { id: 'curve', color: '#9a7760', width: 0.2 },
    prefix: 'papercurve',
    defaults: { mode: 'lissajous', samples: 400, amplitude: 220, layers: 1 },
    transform: false,
  },
});
