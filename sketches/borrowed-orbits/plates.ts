import type { Control, Sketch } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, composePoster, posterControls } from '../phase-garden/poster.ts';
import { extractPlate } from './plates-extract.ts';
import { buildPlate, CATALOG, runPlate } from './plates-study.ts';
import { history } from './sim.ts';

const PENS = ['carbon', 'ultramarine', 'vermilion', 'cyan', 'violet', 'acid', 'coral', 'gold'];
const slider = (id: string, label: string, def: number, min: number, max: number, step: number, group: string, extra: Partial<Extract<Control, { type: 'slider' }>> = {}): Control =>
  ({ type: 'slider', id, label, default: def, min, max, step, group, ...extra });
const when = (plate: string) => ({ showWhen: { control: 'plate', equals: plate } }) as const;
/** Changes simulation state, so the editor re-runs it rather than redrawing marks. */
const sim = { expensive: true } as const;

/** Three plates of clean, integrated orbital systems drawn as lines only: orbits, bodies as small circles, Lagrange points as crosses, burns as ticks. */
const sketch: Sketch = {
  name: 'Orbit Plates',
  page: TABLOID_PAGE,
  pens: [
    { id: 'carbon', color: '#22282c', width: 0.25 },
    { id: 'ultramarine', color: '#3c49aa', width: 0.25 },
    { id: 'vermilion', color: '#d04b3c', width: 0.25 },
    { id: 'acid', color: '#a5a938', width: 0.25 },
    { id: 'violet', color: '#776090', width: 0.25 },
    { id: 'cyan', color: '#6b8491', width: 0.25 },
    { id: 'coral', color: '#a48b8c', width: 0.25 },
    { id: 'gold', color: '#a69d84', width: 0.25 },
  ],
  controls: [
    ...posterControls('ORBIT PLATES', 'O2'),
    { type: 'select', id: 'plate', label: 'Plate', default: 'hohmann', options: ['hohmann', 'lagrange', 'threebody'], optionLabels: { hohmann: 'Hohmann transfer', lagrange: 'Lagrange system (restricted three-body)', threebody: 'Three-body choreographies' }, group: 'Plate', ...sim },
    { type: 'toggle', id: 'orbitsEnabled', label: 'Integrate (off: bodies and references only)', default: true, group: 'Plate' },
    slider('plateMargin', 'Margin', 0.08, 0.03, 0.3, 0.01, 'Plate'),
    slider('rotation', 'Rotation', 0, -180, 180, 1, 'Plate', { units: 'deg' }),
    { type: 'toggle', id: 'autoOrient', label: 'Turn 90° when that fills the poster better', default: true, group: 'Plate' },
    slider('orbitCount', 'Orbit count', 4, 2, 6, 1, 'Hohmann', { ...when('hohmann'), ...sim }),
    slider('spacing', 'Radius ratio between orbits', 1.32, 1.15, 1.5, 0.01, 'Hohmann', { ...when('hohmann'), ...sim }),
    { type: 'select', id: 'transferMode', label: 'Transfers', default: 'chain', options: ['chain', 'single'], optionLabels: { chain: 'Chain (every orbit to the next)', single: 'Single transfer' }, group: 'Hohmann', ...when('hohmann'), ...sim },
    slider('transferIndex', 'Single transfer: from orbit', 0, 0, 4, 1, 'Hohmann', { showWhen: { control: 'transferMode', equals: 'single' }, ...sim }),
    slider('stagger', 'Angle between successive departures', 70, 0, 180, 1, 'Hohmann', { units: 'deg', ...when('hohmann'), ...sim }),
    slider('hohmannPhase', 'First departure angle', 20, -180, 180, 1, 'Hohmann', { units: 'deg', ...when('hohmann'), ...sim }),
    slider('departureStep', 'Burn at step', 0, 0, 600, 1, 'Hohmann', { units: 'steps of 1 s', ...when('hohmann'), ...sim }),
    { type: 'toggle', id: 'showTransfers', label: 'Draw transfers and burn ticks', default: true, group: 'Hohmann', ...when('hohmann') },
    { type: 'toggle', id: 'showPlanets', label: 'Draw planets at departure and arrival', default: true, group: 'Hohmann', ...when('hohmann') },
    slider('tickScale', 'Burn tick length', 1200, 100, 6000, 50, 'Hohmann', { units: 'mm per m/s', ...when('hohmann') }),
    slider('massRatio', 'Mass ratio μ (the horseshoe closes up to 0.004)', 0.001, 0.001, 0.01, 0.001, 'Lagrange', { ...when('lagrange'), ...sim }),
    slider('tadpoleCount', 'Nested tadpoles at each of L4 and L5', 3, 0, 3, 1, 'Lagrange', { ...when('lagrange'), ...sim }),
    slider('tadpoleAmplitude', 'Innermost tadpole radial offset (the others are 2x, 3x)', 0.013, 0.005, 0.015, 0.001, 'Lagrange', { units: 'a', ...when('lagrange'), ...sim }),
    { type: 'toggle', id: 'horseshoe', label: 'Horseshoe orbit', default: true, group: 'Lagrange', ...when('lagrange'), ...sim },
    slider('horseshoeOffset', 'Horseshoe radial offset', 0.03, 0.01, 0.04, 0.005, 'Lagrange', { units: 'a', ...when('lagrange'), ...sim }),
    { type: 'toggle', id: 'showPoints', label: 'Lagrange points', default: true, group: 'Lagrange', ...when('lagrange') },
    { type: 'select', id: 'zvcMode', label: 'Zero-velocity curves', default: 'necks', options: ['off', 'necks', 'critical'], optionLabels: { off: 'Off', necks: 'Necks opening one by one', critical: 'Critical levels' }, group: 'Lagrange', ...when('lagrange') },
    slider('zvcCount', 'Curve levels', 2, 2, 4, 1, 'Lagrange', when('lagrange')),
    { type: 'toggle', id: 'orbitBoundaries', label: "Each orbit's own zero-velocity boundary", default: false, group: 'Lagrange', ...when('lagrange') },
    { type: 'select', id: 'choreography', label: 'Choreography', default: 'figure-eight', options: Object.keys(CATALOG), optionLabels: Object.fromEntries(Object.values(CATALOG).map(c => [c.id, c.label])), group: 'Three-body', ...when('threebody'), ...sim },
    { type: 'select', id: 'bodies', label: 'Curves drawn', default: 'all', options: ['all', 'first'], optionLabels: { all: 'All three bodies', first: 'Body 1 only' }, group: 'Three-body', ...when('threebody') },
    slider('bodyPhase', 'Body positions at phase', 0, 0, 1, 0.01, 'Three-body', when('threebody')),
    slider('bodyRadius', 'Body circle radius', 1.6, 0.4, 5, 0.1, 'Marks', { units: 'mm' }),
    slider('crossSize', 'Lagrange cross size', 2.4, 0.8, 8, 0.1, 'Marks', { units: 'mm' }),
    { type: 'select', id: 'orbitPen', label: 'Orbit pen', default: 'carbon', options: PENS, group: 'Marks' },
    { type: 'select', id: 'highlightPen', label: 'Transfer and highlight pen', default: 'vermilion', options: PENS, group: 'Marks' },
    { type: 'select', id: 'referencePen', label: 'Reference pen', default: 'cyan', options: PENS, group: 'Marks' },
  ],
  draw(ctx) {
    const study = buildPlate(ctx);
    // Off state: bodies and analytic references only; the simulation is never called.
    const run = study.integrate ? runPlate(study, history) : null;
    return composePoster(ctx, extractPlate(study, run), { page: TABLOID_PAGE, subtitle: 'ORBIT PLATES', edition: 'O2' });
  },
};

export default sketch;
