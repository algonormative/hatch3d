import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawMachine } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot study: The Machine (supercomputer)',
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
    { type: 'slider', id: 'ring', label: 'Ring radius', default: 11, min: 6, max: 15, step: 0.1, group: 'Machine' },
    { type: 'slider', id: 'height', label: 'Column height', default: 24, min: 8, max: 34, step: 0.5, group: 'Machine' },
    { type: 'slider', id: 'columns', label: 'Columns', default: 14, min: 8, max: 20, step: 1, group: 'Machine' },
    { type: 'slider', id: 'open', label: 'Opening of the C', default: 1.1, min: 0.4, max: 1.6, step: 0.01, units: 'rad', group: 'Machine' },
    { type: 'slider', id: 'turn', label: 'Turn of the C', default: -0.62, min: -1.2, max: 1.2, step: 0.01, units: 'rad', group: 'Machine' },
    { type: 'slider', id: 'plate', label: 'Blade thickness', default: 0.42, min: 0.25, max: 0.9, step: 0.01, group: 'Machine' },
    { type: 'slider', id: 'top', label: 'Top of the machine on the card', default: 0.3, min: 0.12, max: 0.5, step: 0.01, group: 'Machine' },
    { type: 'slider', id: 'helixRadius', label: 'Helix radius', default: 1.7, min: 1, max: 4, step: 0.05, group: 'Machine' },
    { type: 'slider', id: 'clockY', label: 'Clock band height', default: 0.2, min: 0.08, max: 0.45, step: 0.01, group: 'Sky' },
    { type: 'slider', id: 'clockAmp', label: 'Clock amplitude', default: 7, min: 3, max: 14, step: 0.5, units: 'mm', group: 'Sky' },
    { type: 'slider', id: 'clockPeriod', label: 'Clock period', default: 34, min: 16, max: 60, step: 1, units: 'mm', group: 'Sky' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'every tool is already on the table' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.4 } : c),
  ],
  draw(ctx) {
    return drawMachine(ctx);
  },
};

export default sketch;
