import './prefers.ts'; // First: the fit this card prefers on a small card, declared before the format loads.
import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { assertFormatPage } from '../../kit/format.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawWheel } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: X Wheel of Fortune',
  page: TABLOID_PAGE,
  pageAware: true,
  pens: [
    { id: 'carbon', color: '#22282c', width: 0.25 },
    { id: 'ultramarine', color: '#3c49aa', width: 0.25 },
    { id: 'vermilion', color: '#d04b3c', width: 0.25 },
    { id: 'acid', color: '#a5a938', width: 0.25 },
    { id: 'violet', color: '#776090', width: 0.25 },
    LETTERING_PEN,
  ],
  controls: [
    { type: 'slider', id: 'turn', label: 'Wheel turned from the eye (axle to line of sight)', default: 25, min: 15, max: 60, step: 1, units: '°', group: 'Wheel' },
    { type: 'slider', id: 'sink', label: 'Hub above the ground (of the ring radius)', default: 0.38, min: 0.1, max: 0.5, step: 0.01, group: 'Wheel' },
    { type: 'slider', id: 'topY', label: 'Top tower tip down the sheet', default: 107, min: 60, max: 200, step: 1, units: 'mm', group: 'Wheel' },
    { type: 'slider', id: 'groundY', label: 'Ground under the hub down the sheet', default: 330, min: 290, max: 370, step: 1, units: 'mm', group: 'Wheel' },
    { type: 'slider', id: 'hubX', label: 'Hub across the sheet', default: 118, min: 100, max: 200, step: 1, units: 'mm', group: 'Wheel' },
    { type: 'slider', id: 'towers', label: 'Towers round the full ring', default: 10, min: 8, max: 12, step: 1, group: 'Wheel' },
    { type: 'slider', id: 'towerH', label: 'Tower height', default: 24, min: 12, max: 40, step: 1, group: 'Wheel' },
    { type: 'slider', id: 'proud', label: 'How much taller the top tower stands', default: 2.8, min: 1, max: 3.4, step: 0.05, group: 'Wheel' },
    { type: 'slider', id: 'spokes', label: 'Thin spokes (0 to 3)', default: 2, min: 0, max: 3, step: 1, group: 'Wheel' },
    { type: 'slider', id: 'pavers', label: 'Lifted paving blocks in each crossing ring', default: 9, min: 0, max: 14, step: 1, group: 'Ground' },
    { type: 'slider', id: 'crater', label: 'Size of the ring of blocks', default: 26, min: 12, max: 44, step: 1, group: 'Ground' },
    { type: 'slider', id: 'thread', label: 'Axle (helix) radius at the far end', default: 1.8, min: 0.6, max: 3, step: 0.05, group: 'Axle' },
    { type: 'slider', id: 'taper', label: 'How much wider the axle is at the near end', default: 4.5, min: 1, max: 8, step: 0.1, group: 'Axle' },
    { type: 'slider', id: 'flare', label: 'How late the axle flares', default: 4, min: 1, max: 6, step: 0.1, group: 'Axle' },
    { type: 'slider', id: 'pitch', label: 'Axle length per turn at the far end', default: 40, min: 8, max: 120, step: 1, group: 'Axle' },
    { type: 'slider', id: 'axleLow', label: 'Height of the axle at its near end', default: 14, min: 3, max: 40, step: 1, group: 'Axle' },
    { type: 'slider', id: 'hatch', label: 'Facet ring spacing (x the Tower)', default: 0.7, min: 0.5, max: 3, step: 0.05, group: 'Look' },
    { type: 'slider', id: 'knockout', label: 'Paper round what stands', default: 1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'skyPitch', label: 'Sky ruling pitch', default: 1.8, min: 0.8, max: 5, step: 0.1, units: 'mm', group: 'Look' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 60, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'it all comes back around' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.2 } : c),
  ],
  draw(ctx) {
    assertFormatPage(ctx.page);
    return drawWheel(ctx);
  },
};

export default sketch;
