import type { Control, Sketch } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, TALL_ART, composePoster, posterControls } from '../phase-garden/poster.ts';
import { sloganControls, titleControls, LETTERING_PEN } from '../kit/lettering.ts';
import { drawAgent } from './geometry.ts';

const lettering: Control[] = posterControls('BREACH CATHEDRAL / AGENT', '01A')
  .map(c => c.type === 'select' && c.id === 'posterMode' ? { ...c, default: 'abstract' } : c);

const sketch: Sketch = {
  name: 'Breach Cathedral: Agent',
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
    { type: 'slider', id: 'value', label: 'Overall value', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Light' },
    { type: 'slider', id: 'glow', label: 'Head light reach', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Light' },
    { type: 'slider', id: 'impression', label: 'Impressionist breakup', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Light' },
    { type: 'slider', id: 'radiance', label: 'Rays', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Light' },
    { type: 'slider', id: 'hatchDensity', label: 'Line density', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Light' },
    { type: 'select', id: 'cloth', label: 'Cloth', default: 'pinstripe', options: ['pinstripe', 'ribbon'], optionLabels: { pinstripe: 'Pinstripe suit', ribbon: 'Wound ribbon' }, group: 'Figure' },
    { type: 'slider', id: 'facets', label: 'Planes per limb (0 = smooth)', default: 6, min: 0, max: 16, step: 1, group: 'Figure' },
    { type: 'select', id: 'legs', label: 'Legs', default: 'seed', options: ['seed', 'apart', 'together', 'crossed'],
      optionLabels: { seed: 'From the seed', apart: 'Apart', together: 'Together', crossed: 'Crossed' }, group: 'Figure' },
    { type: 'slider', id: 'band', label: 'Ribbon width', default: 1.25, min: 0.7, max: 2.2, step: 0.05, group: 'Figure' },
    { type: 'slider', id: 'stance', label: 'Knee spread', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Figure' },
    { type: 'slider', id: 'interruption', label: '64-step rests', default: 0.32, min: 0, max: 1, step: 0.01, group: 'Figure' },
    { type: 'slider', id: 'gazeTurn', label: 'Gaze turn', default: 48, min: 0, max: 80, step: 1, units: '°', group: 'Force' },
    { type: 'slider', id: 'gazeLift', label: 'Gaze lift', default: 24, min: 0, max: 60, step: 1, units: '°', group: 'Force' },
    { type: 'slider', id: 'beam', label: 'Beam from the face', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Force' },
    { type: 'toggle', id: 'censor', label: 'Censor bar over the head', default: true, group: 'Force' },
    { type: 'slider', id: 'censorAngle', label: 'Censor bar tilt', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Force' },
    { type: 'slider', id: 'headTurns', label: 'Head turns', default: 4.2, min: 1, max: 6, step: 0.05, group: 'Force' },
    { type: 'slider', id: 'headWidth', label: 'Head ribbon width', default: 0.5, min: 0.25, max: 1.4, step: 0.05, group: 'Force' },
    { type: 'slider', id: 'rise', label: 'Unwinding rise', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Force' },
    { type: 'slider', id: 'breach', label: 'Breach', default: 0.5, min: 0, max: 1, step: 0.01, group: 'System' },
    { type: 'slider', id: 'debris', label: 'Rising fragments', default: 0.5, min: 0, max: 1, step: 0.01, group: 'System' },
    { type: 'slider', id: 'levels', label: 'Cathedral levels', default: 12, min: 8, max: 16, step: 1, group: 'System' },
    { type: 'slider', id: 'turn', label: 'Camera turn', default: 26, min: -40, max: 40, step: 1, units: '°', group: 'Camera' },
    { type: 'slider', id: 'tilt', label: 'Camera tilt', default: -7, min: -16, max: 24, step: 1, units: '°', group: 'Camera' },
    { type: 'toggle', id: 'occlusion', label: 'Hidden lines', default: true, group: 'Camera' },
    ...sloganControls(0),
    ...titleControls(),
  ],
  draw(ctx) {
    return composePoster(ctx, drawAgent(ctx), {
      page: TABLOID_PAGE, subtitle: 'BREACH CATHEDRAL / AGENT', edition: '01A', authored: TALL_ART,
    });
  },
};

export default sketch;
