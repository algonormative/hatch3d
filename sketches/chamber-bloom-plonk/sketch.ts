import type { Control, Sketch } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, TALL_ART, composePoster, posterControls } from '../phase-garden/poster.ts';
import { drawPlonk } from './geometry.ts';

const lettering: Control[] = posterControls('CHAMBER BLOOM / PLONK', '02P')
  .map(control => control.id === 'posterMode' && control.type === 'select' ? { ...control, default: 'abstract' } : control);

const sketch: Sketch = {
  name: 'Chamber Bloom: Plonk',
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
    { type: 'slider', id: 'impact', label: 'Impact', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'ooze', label: 'Ooze', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'heft', label: 'Heft', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'squash', label: 'Squash', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Plonk' },
    { type: 'slider', id: 'plankTilt', label: 'Plank tilt', default: 5, min: 0, max: 12, step: 0.1, units: '°', group: 'Plonk' },
    { type: 'slider', id: 'plankWeight', label: 'Plank weight', default: 72, min: 30, max: 100, step: 1, units: 'mm', group: 'Plonk' },
    { type: 'slider', id: 'plankWidth', label: 'Plank width', default: 136, min: 100, max: 215, step: 1, units: 'mm', group: 'Plonk' },
    { type: 'slider', id: 'lobeCount', label: 'Cell lobes', default: 6, min: 3, max: 12, step: 1, group: 'Cell' },
    { type: 'slider', id: 'shellWarp', label: 'Cell warp', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Cell' },
    { type: 'slider', id: 'lamellaPitch', label: 'Lamella spacing', default: 2.4, min: 1.4, max: 5, step: 0.05, units: 'mm', group: 'Cell' },
    { type: 'slider', id: 'impactMarks', label: 'Impact marks', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Comic' },
    { type: 'slider', id: 'droplets', label: 'Squeezed-out droplets', default: 2, min: 0, max: 3, step: 1, group: 'Comic' },
  ],
  navigators: [
    { id: 'plonk-composition', label: 'Composition', axes: ['impact', 'ooze', 'heft'] },
  ],
  macros: [
    { control: 'impact', targets: [{ control: 'squash', amount: 0.9 }, { control: 'plankTilt', amount: 9 }, { control: 'impactMarks', amount: 0.9 }] },
    { control: 'ooze', targets: [{ control: 'lobeCount', amount: 6 }, { control: 'shellWarp', amount: 0.8 }, { control: 'droplets', amount: 3 }] },
    { control: 'heft', targets: [{ control: 'plankWeight', amount: 50 }, { control: 'plankWidth', amount: 90 }, { control: 'lamellaPitch', amount: -1.4 }] },
  ],
  draw(ctx) {
    return composePoster(ctx, drawPlonk(ctx), { page: TABLOID_PAGE, subtitle: 'CHAMBER BLOOM / PLONK', edition: '02P', authored: TALL_ART });
  },
};

export default sketch;
