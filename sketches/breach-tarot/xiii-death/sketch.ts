// First: the fit this card prefers on a small card, declared before the format loads.
import './prefers.ts';
import type { Control, Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { assertFormatPage } from '../../kit/format.ts';
import { sloganControls, titleControls, LETTERING_PEN } from '../../kit/lettering.ts';
import { drawDeath } from './geometry.ts';

const sketch: Sketch = {
  name: 'Breach Tarot: XIII Death',
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
    { type: 'slider', id: 'undoing', label: 'How far the drawing comes undone round the point', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Singularity' },
    { type: 'slider', id: 'core', label: 'Event horizon size', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Singularity' },
    { type: 'slider', id: 'infall', label: 'Fragments falling in', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Singularity' },
    { type: 'slider', id: 'lensing', label: 'Lensing (halo width)', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Singularity' },
    { type: 'slider', id: 'swirl', label: 'Swirl round the point', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Singularity' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 64, min: 40, max: 90, step: 1, units: '°', group: 'Singularity' },
    { type: 'slider', id: 'hatchDensity', label: 'Weight at the edges', default: 0.62, min: 0, max: 1, step: 0.01, group: 'Nave' },
    { type: 'slider', id: 'bays', label: 'Bays', default: 26, min: 14, max: 36, step: 1, group: 'Nave' },
    { type: 'slider', id: 'width', label: 'Nave width', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Nave' },
    { type: 'slider', id: 'reach', label: 'Cantilever reach', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Nave' },
    { type: 'slider', id: 'interruption', label: '64-step rests', default: 0.32, min: 0, max: 1, step: 0.01, group: 'Nave' },
    { type: 'select', id: 'helixMode', label: 'Helix', default: 'apart', options: ['world', 'apart', 'torn'], optionLabels: { world: 'Part of the world: bent and undone', apart: 'Its own power: whole, in front', torn: 'Torn at the ends' }, group: 'Helix' },
    { type: 'slider', id: 'helixTurns', label: 'Helix turns', default: 2.4, min: 0.6, max: 3.4, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'helixRadius', label: 'Helix radius', default: 1.9, min: 1, max: 3.4, step: 0.05, group: 'Helix' },
    { type: 'slider', id: 'shellWidth', label: 'Membrane width', default: 0.7, min: 0.4, max: 1.8, step: 0.05, group: 'Helix' },
    { type: 'toggle', id: 'occlusion', label: 'Hidden lines', default: true, group: 'Helix' },
    ...sloganControls(1).map((c): Control => c.type === 'text' && c.id === 'slogan' ? { ...c, default: 'this part no longer needs to be drawn' } : c),
    ...titleControls(),
  ],
  draw(ctx) {
    assertFormatPage(ctx.page);
    return drawDeath(ctx);
  },
};

export default sketch;
