import type { Composition2DDefinition, Composition3DDefinition } from '../../src/compositions/types.ts';
import { createHatch3d2DSketch, legacyControlPack } from './dist/planar.js';
import { createHatch3d3DSketch } from './dist/spatial.js';

declare const planar: Composition2DDefinition;
declare const spatial: Composition3DDefinition;
const page = { width: 210, height: 148 };
const pen = { id: 'ink', color: '#222', width: 0.3 };
legacyControlPack(planar, 'planar');
createHatch3d2DSketch({ composition: planar, page, pen });
createHatch3d3DSketch({ composition: spatial, page, pen });
