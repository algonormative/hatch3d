import type { Sketch } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, composePoster, posterControls } from '../phase-garden/poster.ts';
import { drawCathedral } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Cathedral',
  page: TABLOID_PAGE,
  pens: [
    { id: 'carbon', color: '#22282c', width: 0.25 },
    { id: 'ultramarine', color: '#3c49aa', width: 0.25 },
    { id: 'vermilion', color: '#d04b3c', width: 0.25 },
    { id: 'acid', color: '#a5a938', width: 0.25 },
    { id: 'violet', color: '#776090', width: 0.25 },
  ],
  controls: [
    ...posterControls('BREACH CATHEDRAL', '01'),
    { type: 'slider', id: 'mass', label: 'Harmonic mass', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'rupture', label: 'Breach rhythm', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'growth', label: 'Membrane growth', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'focusX', label: 'Organic focus X', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'focusY', label: 'Organic focus Y', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'levels', label: 'Slab levels', default: 9, min: 5, max: 13, step: 1, group: 'Architecture' },
    { type: 'slider', id: 'cantilever', label: 'Cantilever reach', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Architecture' },
    { type: 'slider', id: 'breach', label: 'Void opening', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Architecture' },
    { type: 'slider', id: 'hatchDensity', label: 'Shadow courses', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Architecture' },
    { type: 'slider', id: 'shellWidth', label: 'Membrane width', default: 1.75, min: 0.4, max: 3.7, step: 0.05, group: 'Membrane' },
    { type: 'slider', id: 'shellTwist', label: 'Membrane twist', default: 0.62, min: 0, max: 1, step: 0.01, group: 'Membrane' },
    { type: 'slider', id: 'interruption', label: '64-step rests', default: 0.32, min: 0, max: 1, step: 0.01, group: 'Membrane' },
    { type: 'slider', id: 'worldX', label: 'World X', default: 0, min: -1.5, max: 1.5, step: 0.05, group: 'Placement' },
    { type: 'slider', id: 'worldY', label: 'World Y', default: 0, min: -1.5, max: 1.5, step: 0.05, group: 'Placement' },
    { type: 'slider', id: 'worldZ', label: 'World depth', default: 0, min: -2, max: 2, step: 0.05, group: 'Placement' },
    { type: 'toggle', id: 'occlusion', label: 'Hidden lines', default: true, group: 'Placement' },
  ],
  navigators: [
    { id: 'composition', label: 'Composition', axes: ['mass', 'rupture', 'growth'] },
    { id: 'organic-focus', label: 'Organic focus', type: 'xy', axes: ['focusX', 'focusY'], axisLabels: ['X', 'Y'] },
    { id: 'world-placement', label: 'World placement', type: 'xyz', axes: ['worldX', 'worldY', 'worldZ'], axisLabels: ['X', 'Y', 'Z'] },
  ],
  macros: [
    { control: 'mass', targets: [{ control: 'hatchDensity', amount: 0.9 }, { control: 'levels', amount: 6 }] },
    { control: 'rupture', targets: [{ control: 'interruption', amount: 0.55 }, { control: 'breach', amount: 0.58 }] },
    { control: 'growth', targets: [{ control: 'shellWidth', amount: 2.2 }, { control: 'shellTwist', amount: 0.7 }] },
  ],
  draw(ctx) { return composePoster(ctx, drawCathedral(ctx), {
    page: TABLOID_PAGE, subtitle: 'BREACH CATHEDRAL', edition: '01',
  }); },
};

export default sketch;
