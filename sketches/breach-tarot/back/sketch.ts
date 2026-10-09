import type { Sketch } from '../../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { assertFormatPage } from '../../kit/format.ts';
import { BACK_FORMS, drawBack } from './geometry.ts';

/**
 * The Breach Tarot's back: one design for all 22 cards, the same either way up, in one of five forms (see
 * geometry.ts). Page-aware like the faces: it draws on the format's card rect at any size, at 70 × 120 for the
 * plotter (`--page 70x120`) and at the print trim through `stacks/tarot-print.json`.
 */
const sketch: Sketch = {
  name: 'Breach Tarot: back',
  page: TABLOID_PAGE,
  pageAware: true,
  pens: [
    { id: 'carbon', color: '#22282c', width: 0.25 },
    { id: 'ultramarine', color: '#3c49aa', width: 0.25 },
    { id: 'vermilion', color: '#d04b3c', width: 0.25 },
    { id: 'acid', color: '#a5a938', width: 0.25 },
    { id: 'violet', color: '#776090', width: 0.25 },
  ],
  controls: [
    { type: 'select', id: 'form', label: 'Reading', default: 'helix', options: [...BACK_FORMS],
      optionLabels: { helix: 'The helix, closed into a ring', labyrinth: 'The labyrinth, head to tail, joined by a thread', field: 'A field of helix crossings round a quiet window', composite: 'Every element: a labyrinth walked by the helix between slab gates, round a star', cathedral: 'The Breach Cathedral, head to tail' } },
    { type: 'toggle', id: 'frame', label: 'Rule at the card’s edge', default: true },
    { type: 'slider', id: 'ringSize', label: 'Ring radius (of the card’s width)', default: 0.31, min: 0.2, max: 0.4, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'turns', label: 'Turns round the ring (even)', default: 6, min: 4, max: 16, step: 2, group: 'Helix' },
    { type: 'slider', id: 'tube', label: 'Helix radius (of the ring’s)', default: 0.2, min: 0.1, max: 0.3, step: 0.01, group: 'Helix' },
    { type: 'slider', id: 'labyrinthSize', label: 'Labyrinth radius (of the card’s width)', default: 0.36, min: 0.25, max: 0.45, step: 0.01, group: 'Labyrinth' },
    { type: 'slider', id: 'mouthGap', label: 'Paper between the mouths (of the card’s width)', default: 0.1, min: 0, max: 0.3, step: 0.01, group: 'Labyrinth' },
    { type: 'toggle', id: 'thread', label: 'Helix from centre to centre', default: true, group: 'Labyrinth' },
    { type: 'slider', id: 'threadTurn', label: 'Thread turn (circuits)', default: 4, min: 2, max: 10, step: 0.5, group: 'Labyrinth' },
    { type: 'slider', id: 'trellisPitch', label: 'Thread spacing (of the card’s width)', default: 0.2, min: 0.12, max: 0.35, step: 0.01, group: 'Field' },
    { type: 'slider', id: 'trellisAngle', label: 'Threads from the vertical', default: 34, min: 20, max: 45, step: 1, units: '°', group: 'Field' },
    { type: 'slider', id: 'window', label: 'Quiet window (diamonds out from the centre)', default: 1, min: 0, max: 3, step: 1, group: 'Field' },
    { type: 'slider', id: 'mazeSize', label: 'Labyrinth radius (of the card’s width)', default: 0.43, min: 0.3, max: 0.47, step: 0.01, group: 'Composite' },
    { type: 'slider', id: 'circuits', label: 'Circuits', default: 4, min: 3, max: 6, step: 1, group: 'Composite' },
    { type: 'slider', id: 'naveLevels', label: 'Slab levels (each half)', default: 4, min: 3, max: 6, step: 1, group: 'Cathedral' },
    { type: 'select', id: 'membranePath', label: 'Membrane', default: 'hooks', options: ['hooks', 's'], group: 'Cathedral',
      optionLabels: { hooks: 'Two open loops, head to tail', s: 'One S through the shaft' } },
    { type: 'slider', id: 'membraneReach', label: 'Membrane reach (of the card’s width)', default: 0.36, min: 0.2, max: 0.5, step: 0.01, group: 'Cathedral' },
    { type: 'slider', id: 'membraneWidth', label: 'Membrane width (of the card’s width)', default: 0.075, min: 0.03, max: 0.16, step: 0.005, group: 'Cathedral' },
    { type: 'slider', id: 'membraneRibs', label: 'Membrane ribs', default: 14, min: 6, max: 40, step: 1, group: 'Cathedral' },
  ],
  draw(ctx) {
    assertFormatPage(ctx.page);
    return drawBack(ctx);
  },
};

export default sketch;
