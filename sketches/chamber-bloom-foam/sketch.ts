import type { Control, Sketch } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, TALL_ART, composePoster, posterControls } from '../phase-garden/poster.ts';
import { drawFoam } from './geometry.ts';

const lettering: Control[] = posterControls('CHAMBER BLOOM / FOAM', '02F')
  .map(control => control.id === 'posterMode' && control.type === 'select' ? { ...control, default: 'abstract' } : control);

const sketch: Sketch = {
  name: 'Chamber Bloom: Pressure Foam',
  page: TABLOID_PAGE,
  pens: [
    { id: 'carbon', color: '#22282c', width: 0.25 },
    { id: 'ultramarine', color: '#3c49aa', width: 0.25 },
    { id: 'vermilion', color: '#d04b3c', width: 0.25 },
    { id: 'acid', color: '#a5a938', width: 0.25 },
    { id: 'violet', color: '#776090', width: 0.25 },
  ],
  controls: [
    ...lettering,
    { type: 'slider', id: 'compression', label: 'Compression', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'cellularity', label: 'Cellularity', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'rupture', label: 'Rupture', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'craterX', label: 'Dominant crater X', default: 0.46, min: 0.15, max: 0.85, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'craterY', label: 'Dominant crater Y', default: 0.4, min: 0.15, max: 0.85, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'chamberCount', label: 'Chambers', default: 3, min: 2, max: 4, step: 1, group: 'Foam' },
    { type: 'slider', id: 'pressure', label: 'Wall pressure', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Foam' },
    { type: 'slider', id: 'dominantSize', label: 'Dominant size', default: 1, min: 0.7, max: 1.35, step: 0.01, group: 'Foam' },
    { type: 'slider', id: 'lamellaPitch', label: 'Lamella spacing', default: 2.6, min: 1.2, max: 5, step: 0.05, units: 'mm', group: 'Shell' },
    { type: 'slider', id: 'lobeCount', label: 'Cell lobes', default: 6, min: 3, max: 12, step: 1, group: 'Shell' },
    { type: 'slider', id: 'shellWarp', label: 'Shell warp', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Shell' },
    { type: 'slider', id: 'buttressAngle', label: 'Buttress angle', default: 62, min: 0, max: 90, step: 1, units: '°', group: 'Buttress' },
    { type: 'slider', id: 'buttressWidth', label: 'Buttress width', default: 48, min: 20, max: 90, step: 1, units: 'mm', group: 'Buttress' },
    { type: 'slider', id: 'buttressPosition', label: 'Buttress offset', default: 0.75, min: 0, max: 1, step: 0.01, group: 'Buttress' },
    { type: 'slider', id: 'minorTerraces', label: 'Minor terraces', default: 1, min: 0, max: 3, step: 1, group: 'Buttress' },
  ],
  navigators: [
    { id: 'foam-composition', label: 'Composition', axes: ['compression', 'cellularity', 'rupture'] },
    { id: 'dominant-crater', label: 'Dominant crater', type: 'xy', axes: ['craterX', 'craterY'], axisLabels: ['X', 'Y'] },
  ],
  macros: [
    { control: 'compression', targets: [{ control: 'pressure', amount: 0.9 }, { control: 'lamellaPitch', amount: -1.6 }, { control: 'dominantSize', amount: 0.2 }] },
    { control: 'cellularity', targets: [{ control: 'lobeCount', amount: 6 }, { control: 'shellWarp', amount: 0.8 }, { control: 'chamberCount', amount: 2 }] },
    { control: 'rupture', targets: [{ control: 'buttressWidth', amount: 44 }, { control: 'minorTerraces', amount: 3 }] },
  ],
  draw(ctx) {
    return composePoster(ctx, drawFoam(ctx), { page: TABLOID_PAGE, subtitle: 'CHAMBER BLOOM / FOAM', edition: '02F', authored: TALL_ART });
  },
};

export default sketch;
