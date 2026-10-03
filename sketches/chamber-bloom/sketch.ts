import type { Sketch } from '../../src/sketch/types.ts';
import { posterFrame } from '../phase-garden/poster.ts';
import { drawChamber } from './geometry.ts';

const sketch: Sketch = {
  name: 'Chamber Bloom',
  page: { width: 297, height: 420, margin: 18, paper: '#f4f0e6' },
  pens: [
    { id: 'carbon', color: '#22282c', width: 0.25 },
    { id: 'ultramarine', color: '#3c49aa', width: 0.25 },
    { id: 'vermilion', color: '#d04b3c', width: 0.25 },
    { id: 'acid', color: '#a5a938', width: 0.25 },
    { id: 'violet', color: '#776090', width: 0.25 },
  ],
  controls: [
    { type: 'slider', id: 'pressure', label: 'Pressure', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'cellularity', label: 'Cellularity', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'rupture', label: 'Rupture', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'focusX', label: 'Crater X', default: 0.5, min: 0.16, max: 0.84, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'focusY', label: 'Crater Y', default: 0.5, min: 0.16, max: 0.84, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'lobeCount', label: 'Cell lobes', default: 6, min: 5, max: 8, step: 1, group: 'Shell' },
    { type: 'slider', id: 'lamellaPitch', label: 'Lamella spacing', default: 2.05, min: 1.55, max: 3, step: 0.05, units: 'mm', group: 'Shell' },
    { type: 'slider', id: 'shellWarp', label: 'Shell warp', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Shell' },
    { type: 'slider', id: 'terraceCount', label: 'Terrace count', default: 4, min: 3, max: 6, step: 1, group: 'Architecture' },
    { type: 'slider', id: 'terraceDepth', label: 'Terrace width', default: 1, min: 0.65, max: 1.5, step: 0.01, group: 'Architecture' },
    { type: 'slider', id: 'filamentDensity', label: 'Rhythmic ribs', default: 54, min: 24, max: 64, step: 1, group: 'Detail' },
    { type: 'slider', id: 'rhythmGap', label: 'Grouped rests', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Detail' },
  ],
  navigators: [
    { id: 'chamber-composition', label: 'Composition', axes: ['pressure', 'cellularity', 'rupture'] },
    { id: 'crater-position', label: 'Crater position', type: 'xy', axes: ['focusX', 'focusY'], axisLabels: ['X', 'Y'] },
  ],
  macros: [
    { control: 'pressure', targets: [{ control: 'lamellaPitch', amount: -0.75 }, { control: 'filamentDensity', amount: 18 }] },
    { control: 'cellularity', targets: [{ control: 'lobeCount', amount: 2 }, { control: 'shellWarp', amount: 0.45 }] },
    { control: 'rupture', targets: [{ control: 'terraceDepth', amount: 0.55 }, { control: 'rhythmGap', amount: 0.5 }] },
  ],
  draw(ctx) {
    return [...posterFrame({ subtitle: 'CHAMBER BLOOM', edition: '02' }), ...drawChamber(ctx)];
  },
};

export default sketch;
