import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { sloganControls, titleControls, LETTERING_PEN } from '../../breach-cathedral-tower/slogan.ts';
import { drawStar } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: XVII The Star',
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
    { type: 'slider', id: 'night', label: 'Depth of the night', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Sky' },
    { type: 'slider', id: 'halo', label: 'Halo round each star', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Sky' },
    { type: 'slider', id: 'constellation', label: 'Fragments in the sky', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Sky' },
    { type: 'slider', id: 'glitter', label: 'Glitter path width', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Water' },
    { type: 'slider', id: 'starSize', label: 'Star size', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Star' },
    { type: 'slider', id: 'streams', label: 'Stream spread', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Star' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 40, max: 80, step: 1, units: '°', group: 'Star' },
    { type: 'toggle', id: 'occlusion', label: 'Hidden lines', default: true, group: 'Star' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'all of the pieces are still here' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.4 } : c),
    ...titleControls(),
  ],
  draw(ctx) {
    return drawStar(ctx);
  },
};

export default sketch;
