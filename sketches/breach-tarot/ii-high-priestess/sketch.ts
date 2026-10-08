import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { assertFormatPage } from '../../kit/format.ts';
import { sloganControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawHighPriestess } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: II The High Priestess',
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
    { type: 'slider', id: 'distance', label: 'Distance to the pillars', default: 90, min: 50, max: 220, step: 1, units: 'u', group: 'Pillars' },
    { type: 'slider', id: 'pillarCentre', label: 'Pillar centre off the axis', default: 62, min: 40, max: 95, step: 0.5, units: 'mm', group: 'Pillars' },
    { type: 'slider', id: 'pillarWidth', label: 'Pillar width', default: 27, min: 20, max: 50, step: 0.5, units: 'mm', group: 'Pillars' },
    { type: 'slider', id: 'lintelTop', label: 'Top of the lintel (page y)', default: 62, min: 46, max: 100, step: 0.5, units: 'mm', group: 'Pillars' },
    { type: 'slider', id: 'hatchPitch', label: 'Pillar hatch pitch', default: 1, min: 0.8, max: 2, step: 0.05, group: 'Pillars' },
    { type: 'select', id: 'darkSide', label: 'The dark pillar', default: 'seed', options: ['seed', 'left', 'right'],
      optionLabels: { seed: 'By seed', left: 'Left', right: 'Right' }, group: 'Pillars' },
    { type: 'slider', id: 'veilPitch', label: 'Veil thread pitch', default: 0.95, min: 0.6, max: 1.2, step: 0.01, units: 'mm', group: 'Veil' },
    { type: 'slider', id: 'veilClear', label: 'Paper round the shadow', default: 0.9, min: 0.3, max: 2.5, step: 0.05, units: 'mm', group: 'Veil' },
    { type: 'slider', id: 'cable', label: 'Cable (helix) radius', default: 0.36, min: 0.08, max: 0.45, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'unwindLength', label: 'Length of the unwinding', default: 44, min: 30, max: 100, step: 1, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'coil', label: 'Coil left on the threads', default: 2.4, min: 0.5, max: 5, step: 0.1, units: 'mm', group: 'Helix' },
    { type: 'slider', id: 'tessSize', label: 'Shadow size (of the veil width)', default: 0.5, min: 0.3, max: 0.7, step: 0.01, group: 'Shadow' },
    { type: 'slider', id: 'tessRise', label: 'Shadow above the veil centre', default: 0.06, min: -0.2, max: 0.3, step: 0.01, group: 'Shadow' },
    { type: 'slider', id: 'tessBand', label: 'Edge band half-width', default: 0.85, min: 0.5, max: 2, step: 0.05, units: 'mm', group: 'Shadow' },
    { type: 'slider', id: 'knockout', label: 'Paper round what stands', default: 1.1, min: 0.3, max: 3, step: 0.05, units: 'mm', group: 'Ground and sky' },
    { type: 'slider', id: 'skyReach', label: 'How far the night ruling reaches down', default: 0.65, min: 0, max: 1, step: 0.01, group: 'Ground and sky' },
    { type: 'slider', id: 'joints', label: 'Floor joints', default: 7, min: 0, max: 14, step: 1, group: 'Ground and sky' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 36, max: 75, step: 1, units: '°', group: 'Camera' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'there is a direction you cannot point' }
      : c.type === 'slider' && c.id === 'sloganSize' ? { ...c, default: 2.4 } : c),
  ],
  draw(ctx) {
    assertFormatPage(ctx.page);
    return drawHighPriestess(ctx);
  },
};

export default sketch;
