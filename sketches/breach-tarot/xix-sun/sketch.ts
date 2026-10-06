import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawSun } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: XIX The Sun',
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
    { type: 'slider', id: 'size', label: 'Sun size', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Sun' },
    { type: 'slider', id: 'height', label: 'Sun height', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Sun' },
    { type: 'slider', id: 'rays', label: 'Ray count', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Sun' },
    { type: 'slider', id: 'radiance', label: 'Fine rays', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Sun' },
    { type: 'select', id: 'phrasePlace', label: 'Phrase', default: 'ground', options: ['ground', 'carved'],
      optionLabels: { ground: 'Painted on the ground, in the light', carved: 'Carved into both walls' }, group: 'Wall' },
    { type: 'slider', id: 'cracks', label: 'Crack plate size', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Wall' },
    { type: 'slider', id: 'breach', label: 'Breach in the wall', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Wall' },
    { type: 'slider', id: 'distance', label: 'Wall distance', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Wall' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 40, max: 80, step: 1, units: '°', group: 'Wall' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'there is nothing left to hide' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.4 } : c),
  ],
  draw(ctx) {
    return drawSun(ctx);
  },
};

export default sketch;
