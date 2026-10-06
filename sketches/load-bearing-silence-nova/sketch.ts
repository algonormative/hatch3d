import type { Control, Sketch } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, TALL_ART, composePoster, posterControls } from '../phase-garden/poster.ts';
import { drawNova } from './geometry.ts';

const posterDefaults = posterControls('LOAD BEARING SILENCE / NOVA', '03N').map(control =>
  control.id === 'posterMode' ? { ...control, default: 'abstract' } as Control : control);

/** A space structure torn apart by a bright burst behind it, suspended in its own sunbeam. */
const sketch: Sketch = {
  name: 'Load Bearing Silence / Nova',
  page: TABLOID_PAGE,
  pens: [
    { id: 'carbon', color: '#22282c', width: 0.25 },
    { id: 'cyan', color: '#6b8491', width: 0.25 },
    { id: 'vermilion', color: '#d04b3c', width: 0.25 },
    { id: 'gold', color: '#a69d84', width: 0.25 },
  ],
  controls: [
    ...posterDefaults,
    { type: 'slider', id: 'violence', label: 'Violence', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'radiance', label: 'Radiance', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'mass', label: 'Mass', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'sourceX', label: 'Source X', default: 0.46, min: 0, max: 1, step: 0.01, group: 'Burst' },
    { type: 'slider', id: 'sourceY', label: 'Source Y', default: 0.41, min: 0, max: 1, step: 0.01, group: 'Burst' },
    { type: 'slider', id: 'blastStrength', label: 'Blast strength', default: 0.62, min: 0, max: 1, step: 0.01, group: 'Burst' },
    { type: 'slider', id: 'moment', label: 'Moment after blast', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Burst' },
    { type: 'slider', id: 'panelCount', label: 'Panel count', default: 7, min: 5, max: 9, step: 1, group: 'Panels' },
    { type: 'slider', id: 'panelSize', label: 'Panel size', default: 62, min: 36, max: 84, step: 1, units: 'mm', group: 'Panels' },
    { type: 'slider', id: 'hatchPitch', label: 'Hatch pitch', default: 1.0, min: 0.6, max: 3, step: 0.05, units: 'mm', group: 'Panels' },
    { type: 'slider', id: 'shardAmount', label: 'Shards', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Panels' },
    { type: 'slider', id: 'rayCount', label: 'Ray count', default: 440, min: 40, max: 720, step: 10, group: 'Sunbeam' },
    { type: 'slider', id: 'rayLength', label: 'Ray length', default: 0.85, min: 0.15, max: 1, step: 0.01, group: 'Sunbeam' },
    { type: 'slider', id: 'shadowStrength', label: 'Shadow shafts', default: 0.75, min: 0, max: 1, step: 0.01, group: 'Sunbeam' },
  ],
  navigators: [
    { id: 'composition', label: 'Composition', axes: ['violence', 'radiance', 'mass'] },
    { id: 'source', label: 'Burst source', type: 'xy', axes: ['sourceX', 'sourceY'], yDirection: 'down', axisLabels: ['X', 'Y'] },
  ],
  macros: [
    { control: 'violence', targets: [{ control: 'blastStrength', amount: 0.7 }, { control: 'moment', amount: 0.6 }, { control: 'shardAmount', amount: 0.5 }] },
    { control: 'radiance', targets: [{ control: 'rayCount', amount: 360 }, { control: 'rayLength', amount: 0.5 }, { control: 'shadowStrength', amount: 0.5 }] },
    { control: 'mass', targets: [{ control: 'panelSize', amount: 30 }, { control: 'hatchPitch', amount: -0.6 }] },
  ],
  draw(ctx) {
    return composePoster(ctx, drawNova(ctx).parts, {
      page: TABLOID_PAGE, subtitle: 'LOAD BEARING SILENCE / NOVA', edition: '03N', authored: TALL_ART,
    });
  },
};

export default sketch;
