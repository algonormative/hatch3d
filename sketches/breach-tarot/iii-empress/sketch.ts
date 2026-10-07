import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawEmpress } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: III The Empress',
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
    { type: 'slider', id: 'furrow', label: 'Furrow spacing', default: 2.8, min: 2, max: 7, step: 0.1, group: 'Crop' },
    { type: 'slider', id: 'row', label: 'Spacing along the furrow', default: 3.4, min: 2.5, max: 8, step: 0.1, group: 'Crop' },
    { type: 'slider', id: 'reach', label: 'How far the rows run', default: 400, min: 100, max: 1400, step: 10, group: 'Crop' },
    { type: 'slider', id: 'patch', label: 'Size of the ripe and seedling patches', default: 0.85, min: 0.5, max: 2.5, step: 0.05, group: 'Crop' },
    { type: 'slider', id: 'ripen', label: 'Ripeness toward the horizon', default: 0.15, min: -0.4, max: 0.6, step: 0.01, group: 'Crop' },
    { type: 'slider', id: 'vanish', label: 'Furrows aim left (-) or right (+) of centre', default: 0.05, min: -0.3, max: 0.3, step: 0.005, group: 'Crop' },
    { type: 'slider', id: 'hatch', label: 'Hatch spacing (more is lighter)', default: 1.6, min: 0.6, max: 4, step: 0.05, group: 'Crop' },
    { type: 'slider', id: 'knockout', label: 'Paper round what stands', default: 1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Crop' },
    { type: 'slider', id: 'lean', label: 'Most bend at the tip, under the wind', default: 10, min: 0, max: 40, step: 0.5, units: '°', group: 'Wind' },
    { type: 'slider', id: 'windDepth', label: 'Wind: mean distance', default: 30, min: 18, max: 120, step: 1, group: 'Wind' },
    { type: 'slider', id: 'windSwing', label: 'Wind: swing of the S', default: 9, min: 2, max: 30, step: 0.5, group: 'Wind' },
    { type: 'slider', id: 'windSlope', label: 'Wind: far end farther (+) or nearer (-)', default: 6, min: -30, max: 30, step: 0.5, group: 'Wind' },
    { type: 'slider', id: 'windHigh', label: 'Wind: height over the crop', default: 1.6, min: 0.4, max: 4, step: 0.1, group: 'Wind' },
    { type: 'slider', id: 'windRadius', label: 'Wind: ribbon radius', default: 0.2, min: 0.08, max: 0.8, step: 0.01, group: 'Wind' },
    { type: 'slider', id: 'windPitch', label: 'Wind: length per turn', default: 4.5, min: 1.5, max: 12, step: 0.5, group: 'Wind' },
    { type: 'select', id: 'windFrom', label: 'Wind enters from', default: 'left', options: ['left', 'right'],
      optionLabels: { left: 'The left edge', right: 'The right edge' }, group: 'Wind' },
    { type: 'slider', id: 'sky', label: 'Ruled sky', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Sky' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    { type: 'slider', id: 'eye', label: 'Eye height', default: 6, min: 3, max: 12, step: 0.5, group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'there will always be more' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.2 } : c),
  ],
  draw(ctx) {
    return drawEmpress(ctx);
  },
};

export default sketch;
