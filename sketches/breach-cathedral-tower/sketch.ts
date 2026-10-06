import { lineRoughControls } from '../phase-garden/scratch.ts';
import type { Control, Sketch } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, TALL_ART, composePoster, posterControls } from '../phase-garden/poster.ts';
import { drawTower } from './geometry.ts';
import { sloganControls, titleControls, LETTERING_PEN } from './slogan.ts';

const lettering: Control[] = posterControls('BREACH CATHEDRAL / TOWER', '01T')
  .map(c => c.type === 'select' && c.id === 'posterMode' ? { ...c, default: 'abstract' } : c);

const sketch: Sketch = {
  name: 'Breach Cathedral: Tower',
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
    ...lettering,
    { type: 'slider', id: 'mass', label: 'Harmonic mass', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'rupture', label: 'Rupture', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'growth', label: 'Membrane growth', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'braid', label: 'Braid', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'focusX', label: 'Organic focus X', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'focusY', label: 'Organic focus Y', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'levels', label: 'Slab levels', default: 17, min: 15, max: 21, step: 1, group: 'Architecture' },
    { type: 'slider', id: 'cantilever', label: 'Cantilever reach', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Architecture' },
    { type: 'slider', id: 'breach', label: 'Shaft opening', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Architecture' },
    { type: 'slider', id: 'hatchDensity', label: 'Shadow courses', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Architecture' },
    { type: 'slider', id: 'collapse', label: 'Collapse intensity', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Collapse' },
    { type: 'slider', id: 'collapseHeight', label: 'Collapse height', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Collapse' },
    { type: 'slider', id: 'debris', label: 'Debris', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Collapse' },
    { type: 'slider', id: 'helixTurns', label: 'Helix turns', default: 1.6, min: 0.6, max: 3.4, step: 0.05, group: 'Twin helix' },
    { type: 'slider', id: 'strandOffset', label: 'Strand offset', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Twin helix' },
    { type: 'slider', id: 'helixRadius', label: 'Helix radius', default: 2.7, min: 1.6, max: 4.2, step: 0.05, group: 'Twin helix' },
    { type: 'slider', id: 'shellWidth', label: 'Membrane width', default: 1.4, min: 0.4, max: 2.4, step: 0.05, group: 'Twin helix' },
    { type: 'slider', id: 'shellTwist', label: 'Membrane twist', default: 0.62, min: 0, max: 1, step: 0.01, group: 'Twin helix' },
    { type: 'slider', id: 'interruption', label: '64-step rests', default: 0.32, min: 0, max: 1, step: 0.01, group: 'Twin helix' },
    { type: 'slider', id: 'worldX', label: 'World X', default: 0, min: -1.5, max: 1.5, step: 0.05, group: 'Placement' },
    { type: 'slider', id: 'worldY', label: 'World Y', default: 0, min: -1.5, max: 1.5, step: 0.05, group: 'Placement' },
    { type: 'slider', id: 'worldZ', label: 'World depth', default: 0, min: -2, max: 2, step: 0.05, group: 'Placement' },
    { type: 'toggle', id: 'occlusion', label: 'Hidden lines', default: true, group: 'Placement' },
    ...lineRoughControls(),
    ...sloganControls(0),
    ...titleControls(),
  ],
  navigators: [
    { id: 'composition', label: 'Composition', axes: ['mass', 'rupture', 'growth', 'braid'] },
    { id: 'organic-focus', label: 'Organic focus', type: 'xy', axes: ['focusX', 'focusY'], axisLabels: ['X', 'Y'] },
    { id: 'world-placement', label: 'World placement', type: 'xyz', axes: ['worldX', 'worldY', 'worldZ'], axisLabels: ['X', 'Y', 'Z'] },
  ],
  macros: [
    { control: 'mass', targets: [{ control: 'hatchDensity', amount: 0.9 }, { control: 'levels', amount: 6 }] },
    { control: 'rupture', targets: [{ control: 'collapse', amount: 0.9 }, { control: 'debris', amount: 0.6 }, { control: 'interruption', amount: 0.5 }] },
    { control: 'growth', targets: [{ control: 'shellWidth', amount: 1.3 }, { control: 'helixRadius', amount: 1.0 }, { control: 'shellTwist', amount: 0.6 }] },
    { control: 'braid', targets: [{ control: 'helixTurns', amount: 2.0 }, { control: 'strandOffset', amount: -0.5 }] },
  ],
  draw(ctx) {
    return composePoster(ctx, drawTower(ctx), {
      page: TABLOID_PAGE, subtitle: 'BREACH CATHEDRAL / TOWER', edition: '01T', authored: TALL_ART,
    });
  },
};

export default sketch;
