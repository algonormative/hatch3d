import type { Sketch } from '../../src/sketch/types.ts';
import { drawFields } from './fields.ts';
import { drawFolds } from './folds.ts';

/** Five separable physical inks. No opacity or screen-only blending is needed. */
const sketch: Sketch = {
  name: 'Fault Choir',
  page: { width: 420, height: 297, margin: 18, paper: '#f6f1e7' },
  pens: [
    { id: 'carbon', color: '#28343d', width: 0.23 },
    { id: 'cobalt', color: '#3455a3', width: 0.25 },
    { id: 'lagoon', color: '#197e83', width: 0.25 },
    { id: 'ember', color: '#cb5e46', width: 0.25 },
    { id: 'brass', color: '#a08038', width: 0.25 },
  ],
  controls: [
    { type: 'slider', id: 'density', label: 'Density', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'turbulence', label: 'Turbulence', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'fracture', label: 'Fracture', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'fieldFocusX', label: 'Field focus X', default: 0.5, min: 0.15, max: 0.85, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'fieldFocusY', label: 'Field focus Y', default: 0.5, min: 0.15, max: 0.85, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'contourPitch', label: 'Contour spacing', default: 2.3, min: 1.5, max: 3.5, step: 0.05, units: 'mm', group: 'Fields' },
    { type: 'slider', id: 'weavePitch', label: 'Weave spacing', default: 5.4, min: 3.5, max: 8, step: 0.1, units: 'mm', group: 'Fields' },
    { type: 'slider', id: 'fieldTurbulence', label: 'Field bend', default: 0.46, min: 0, max: 1, step: 0.01, group: 'Fields' },
    { type: 'slider', id: 'breakup', label: 'Interrupted beats', default: 0.36, min: 0, max: 0.75, step: 0.01, group: 'Fields' },
    { type: 'slider', id: 'linkChance', label: 'Local crosslinks', default: 0.25, min: 0, max: 0.5, step: 0.01, group: 'Fields' },
    { type: 'slider', id: 'corridorWidth', label: 'Fault corridor', default: 19, min: 12, max: 30, step: 0.5, units: 'mm', group: 'Fields' },
    { type: 'slider', id: 'foldX', label: 'Fold center X', default: 0, min: -1, max: 1, step: 0.02, group: 'Folds' },
    { type: 'slider', id: 'foldY', label: 'Fold center Y', default: 0, min: -1, max: 1, step: 0.02, group: 'Folds' },
    { type: 'slider', id: 'foldZ', label: 'Fold depth', default: 0, min: -1, max: 1, step: 0.02, group: 'Folds' },
    { type: 'slider', id: 'foldCount', label: 'Fold count', default: 4, min: 2, max: 7, step: 1, group: 'Folds' },
    { type: 'slider', id: 'foldTwist', label: 'Fold twist', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Folds' },
    { type: 'slider', id: 'foldScale', label: 'Fold scale', default: 1, min: 0.6, max: 1.35, step: 0.01, group: 'Folds' },
    { type: 'toggle', id: 'occlusion', label: 'Fold hidden lines', default: true, group: 'Folds' },
  ],
  navigators: [
    { id: 'composition', label: 'Composition', axes: ['density', 'turbulence', 'fracture'] },
    { id: 'field-focus', label: 'Field focus', type: 'xy', axes: ['fieldFocusX', 'fieldFocusY'], axisLabels: ['X', 'Y'] },
    { id: 'fold-position', label: 'Fold position', type: 'xyz', axes: ['foldX', 'foldY', 'foldZ'], axisLabels: ['X', 'Y', 'Z'] },
  ],
  macros: [
    { control: 'density', targets: [{ control: 'contourPitch', amount: -1.35 }, { control: 'weavePitch', amount: -2.2 }, { control: 'linkChance', amount: 0.1 }] },
    { control: 'turbulence', targets: [{ control: 'fieldTurbulence', amount: 0.9 }, { control: 'linkChance', amount: 0.08 }] },
    { control: 'fracture', targets: [{ control: 'breakup', amount: 0.58 }, { control: 'corridorWidth', amount: 9 }] },
  ],
  draw(ctx) {
    const folds = drawFolds(ctx);
    return [...drawFields(ctx, folds.occludes), ...folds.parts];
  },
};

export default sketch;
