import type { Control, Sketch } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, composePoster, posterControls } from '../phase-garden/poster.ts';
import { extractMarks } from './extract.ts';
import { LIMITS } from './model.ts';
import { history } from './sim.ts';
import { DT, WORLD, buildStudy } from './study.ts';

const PENS = ['ultramarine', 'cyan', 'violet', 'vermilion', 'acid', 'coral', 'gold', 'carbon'];
const slider = (id: string, label: string, def: number, min: number, max: number, step: number, group: string, extra: Partial<Extract<Control, { type: 'slider' }>> = {}): Control =>
  ({ type: 'slider', id, label, default: def, min, max, step, group, ...extra });
/** Changes simulation state, so the editor re-runs it rather than redrawing marks. */
const sim = { expensive: true } as const;

/** Trajectories that begin on exact drawn circles about the wrong centre, and the hidden event that breaks them. */
const sketch: Sketch = {
  name: 'Borrowed Orbits',
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
    ...posterControls('BORROWED ORBITS', 'O1'),
    { type: 'toggle', id: 'orbitsEnabled', label: 'Draw trajectories', default: true, group: 'Orbits' },
    slider('step', 'Time step', 600, 0, LIMITS.maxSteps, 1, 'Orbits', { units: `steps of ${DT} s`, ...sim }),
    slider('centreX', 'Apparent centre X', 24, 0, WORLD.width, 0.5, 'Guides', { units: 'm', ...sim }),
    slider('centreY', 'Apparent centre Y', 36, 0, WORLD.height, 0.5, 'Guides', { units: 'm', ...sim }),
    slider('guideCount', 'Guide count', 5, 2, 9, 1, 'Guides', sim),
    slider('guideInner', 'Guide inner radius', 6, 2, 20, 0.5, 'Guides', { units: 'm', ...sim }),
    slider('guideOuter', 'Guide outer radius', 20, 8, 30, 0.5, 'Guides', { units: 'm', ...sim }),
    slider('massDX', 'Hidden mass offset X', 3, -15, 15, 0.5, 'Hidden mass', { units: 'm', ...sim }),
    slider('massDY', 'Hidden mass offset Y', 5, -15, 15, 0.5, 'Hidden mass', { units: 'm', ...sim }),
    slider('orbitPeriod', 'Orbit period at middle guide', 60, 20, 180, 1, 'Hidden mass', { units: 's', ...sim }),
    slider('softening', 'Softening', 0.6, 0.1, 3, 0.05, 'Hidden mass', { units: 'm', ...sim }),
    slider('captureRadius', 'Capture radius', 1.2, 0, 4, 0.1, 'Hidden mass', { units: 'm', ...sim }),
    slider('particlesPerGuide', 'Particles per guide', 60, 4, 300, 1, 'Particles', sim),
    slider('borrow', 'Borrowed velocity', 1, 0, 1, 0.01, 'Particles', sim),
    slider('speedJitter', 'Speed jitter', 0.03, 0, 0.3, 0.005, 'Particles', sim),
    { type: 'select', id: 'spin', label: 'Direction of revolution', default: 'cw', options: ['cw', 'ccw'], optionLabels: { cw: 'Clockwise', ccw: 'Counter-clockwise' }, group: 'Particles', ...sim },
    { type: 'toggle', id: 'massPinned', label: 'Hidden mass pinned', default: true, group: 'Hidden mass', ...sim },
    { type: 'toggle', id: 'perturberEnabled', label: 'Unseen perturber', default: true, group: 'Perturber', ...sim },
    slider('perturberRatio', 'Perturber mass (× hidden mass)', 0.35, 0, 1.5, 0.05, 'Perturber', sim),
    slider('perturberAngle', 'Approach direction', 25, -180, 180, 1, 'Perturber', { units: 'deg', ...sim }),
    slider('perturberImpact', 'Impact parameter', 8, -30, 30, 0.5, 'Perturber', { units: 'm', ...sim }),
    slider('perturberSpeed', 'Perturber speed', 2, 0.5, 8, 0.1, 'Perturber', { units: 'm/s', ...sim }),
    slider('perturberStep', 'Closest approach at step', 400, 0, LIMITS.maxSteps, 1, 'Perturber', { units: `steps of ${DT} s`, ...sim }),
    { type: 'select', id: 'forbiddenLayout', label: 'Forbidden regions', default: 'bars', options: ['none', 'bars', 'arc', 'gate'], optionLabels: { none: 'None', bars: 'Radial bars', arc: 'Curved band', gate: 'Mirror gate' }, group: 'Forbidden', ...sim },
    slider('forbiddenCount', 'Bar count', 8, 1, 24, 1, 'Forbidden', { ...sim, showWhen: { control: 'forbiddenLayout', equals: 'bars' } }),
    { type: 'select', id: 'boundary', label: 'Domain edges', default: 'open', options: ['open', 'absorb'], optionLabels: { open: 'Open (escape far outside)', absorb: 'Absorb at the frame' }, group: 'Orbits', ...sim },
    slider('escapeMargin', 'Escape margin', 30, 5, 100, 1, 'Orbits', { units: 'm', ...sim }),
    slider('structureSeed', 'Structure seed', 0, 0, 999, 1, 'Seeds', sim),
    slider('dynamicsSeed', 'Dynamics seed', 0, 0, 999, 1, 'Seeds', sim),
    slider('trailSteps', 'Trail length', 400, 20, 1200, 1, 'Marks', { units: `steps of ${DT} s` }),
    slider('taper', 'Tail taper', 0.5, 0, 1, 0.01, 'Marks'),
    slider('trailMinSpacing', 'Trail minimum spacing', 0, 0, 10, 0.25, 'Marks', { units: '× pen width' }),
    { type: 'select', id: 'trailPen', label: 'Trail pen', default: 'ultramarine', options: PENS, group: 'Marks' },
    { type: 'toggle', id: 'drawGuides', label: 'Draw guides', default: true, group: 'Marks' },
    { type: 'select', id: 'guidePen', label: 'Guide pen', default: 'vermilion', options: ['vermilion', 'ultramarine', 'cyan', 'violet', 'acid', 'coral', 'gold', 'carbon'], group: 'Marks' },
    { type: 'select', id: 'structurePen', label: 'Forbidden pen', default: 'carbon', options: ['carbon', 'ultramarine', 'vermilion', 'violet', 'cyan', 'acid', 'coral', 'gold'], group: 'Marks' },
    slider('hatchPitch', 'Forbidden hatch spacing', 1, 0.3, 4, 0.05, 'Marks', { units: 'mm' }),
    // Macros: neutral at 0.5, so the defaults above are what you get when they sit untouched.
    slider('displacement', 'Displacement', 0.5, 0, 1, 0.01, 'Event'),
    slider('disturbance', 'Disturbance', 0.5, 0, 1, 0.01, 'Event'),
  ],
  navigators: [
    { id: 'event', label: 'Event', axes: ['displacement', 'disturbance', 'taper'] },
    { id: 'hidden-mass', label: 'Hidden mass', type: 'xy', axes: ['massDX', 'massDY'], yDirection: 'down', axisLabels: ['X', 'Y'] },
    { id: 'apparent-centre', label: 'Apparent centre', type: 'xy', axes: ['centreX', 'centreY'], yDirection: 'down', axisLabels: ['X', 'Y'] },
    { id: 'perturber', label: 'Perturber', type: 'xyz', axes: ['perturberAngle', 'perturberImpact', 'perturberStep'], axisLabels: ['Angle', 'Impact', 'Step'] },
  ],
  macros: [
    { control: 'displacement', targets: [{ control: 'massDX', amount: 12 }, { control: 'massDY', amount: 20 }] },
    { control: 'disturbance', targets: [{ control: 'perturberRatio', amount: 1 }, { control: 'borrow', amount: -0.4 }, { control: 'speedJitter', amount: 0.06 }] },
  ],
  draw(ctx) {
    const study = buildStudy(ctx);
    const enabled = ctx.params.orbitsEnabled !== false;
    const step = Math.max(0, Math.min(LIMITS.maxSteps, Math.round(Number(ctx.params.step ?? 600))));
    // The off state never touches the simulation.
    const record = enabled ? history(study.config, Math.max(0, step - study.marks.trailSteps), step) : null;
    return composePoster(ctx, extractMarks(study, record), { page: TABLOID_PAGE, subtitle: 'BORROWED ORBITS', edition: 'O1' });
  },
};

export default sketch;
