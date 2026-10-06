import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { sloganControls, titleControls, LETTERING_PEN } from '../../breach-cathedral-tower/slogan.ts';
import { drawTower } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: XVI The Tower',
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
    { type: 'slider', id: 'bolt', label: 'Bolt width', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Strike' },
    { type: 'slider', id: 'slip', label: 'Slip along the tear', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Strike' },
    { type: 'slider', id: 'lid', label: 'Crown lifted', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Tower' },
    { type: 'slider', id: 'pour', label: 'Helix pouring out', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Tower' },
    { type: 'slider', id: 'hatchDensity', label: 'Hatch weight', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Tower' },
    { type: 'slider', id: 'levels', label: 'Slab levels', default: 19, min: 15, max: 21, step: 1, group: 'Tower' },
    { type: 'slider', id: 'cantilever', label: 'Cantilever reach', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Tower' },
    { type: 'slider', id: 'interruption', label: '64-step rests', default: 0.32, min: 0, max: 1, step: 0.01, group: 'Tower' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 56, min: 40, max: 80, step: 1, units: '°', group: 'Camera' },
    { type: 'slider', id: 'distance', label: 'Camera distance', default: 48, min: 30, max: 90, step: 0.5, group: 'Camera' },
    { type: 'slider', id: 'shellWidth', label: 'Membrane width', default: 0.9, min: 0.4, max: 1.8, step: 0.05, group: 'Camera' },
    { type: 'toggle', id: 'occlusion', label: 'Hidden lines', default: true, group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'it was never load bearing' } : c),
    ...titleControls(),
  ],
  draw(ctx) {
    return drawTower(ctx);
  },
};

export default sketch;
