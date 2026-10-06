import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { sloganControls, titleControls, LETTERING_PEN } from '../../breach-cathedral-tower/slogan.ts';
import { drawDeath } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: XIII Death',
  page: TABLOID_PAGE,
  pens: [
    { id: 'carbon', color: '#22282c', width: 0.25 },
    { id: 'ultramarine', color: '#3c49aa', width: 0.25 },
    { id: 'vermilion', color: '#d04b3c', width: 0.25 },
    { id: 'acid', color: '#a5a938', width: 0.25 },
    { id: 'violet', color: '#776090', width: 0.25 },
    LETTERING_PEN,
  ],
  controls: [
    { type: 'slider', id: 'undoing', label: 'How far the drawing holds above the line', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Threshold' },
    { type: 'slider', id: 'hatchDensity', label: 'Weight below the line', default: 0.78, min: 0, max: 1, step: 0.01, group: 'Threshold' },
    { type: 'slider', id: 'levels', label: 'Slab levels', default: 17, min: 15, max: 21, step: 1, group: 'Architecture' },
    { type: 'slider', id: 'cantilever', label: 'Cantilever reach', default: 0.72, min: 0, max: 1, step: 0.01, group: 'Architecture' },
    { type: 'slider', id: 'breach', label: 'Shaft opening (the gate)', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Architecture' },
    { type: 'slider', id: 'interruption', label: '64-step rests', default: 0.32, min: 0, max: 1, step: 0.01, group: 'Architecture' },
    { type: 'slider', id: 'helixTurns', label: 'Helix turns', default: 1.6, min: 0.6, max: 3.4, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'helixRadius', label: 'Helix radius', default: 2.5, min: 1.6, max: 4.2, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'shellWidth', label: 'Membrane width', default: 0.85, min: 0.4, max: 2.4, step: 0.05, group: 'Helix' },
    { type: 'toggle', id: 'occlusion', label: 'Hidden lines', default: true, group: 'Helix' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'this part no longer needs to be drawn' } : c),
    ...titleControls(),
  ],
  draw(ctx) {
    return drawDeath(ctx);
  },
};

export default sketch;
