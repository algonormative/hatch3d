import type { Sketch } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, composePoster, posterControls } from '../phase-garden/poster.ts';
import { extractMarks } from './extract.ts';
import { LIMITS } from './model.ts';
import { buildDomain, simulate } from './sim.ts';
import { DT, WORLD, buildStudy } from './study.ts';

/** Architecture that continues past its window and half-dissolves in advected, plotted cloud. */
const sketch: Sketch = {
  name: 'Prescribed Weather',
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
    ...posterControls('PRESCRIBED WEATHER', 'P1'),
    { type: 'slider', id: 'turbulence', label: 'Turbulence', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Weather', expensive: true },
    { type: 'slider', id: 'drift', label: 'Drift', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Weather', expensive: true },
    { type: 'select', id: 'layout', label: 'Structure layout', default: 'orbit', options: ['span', 'orbit', 'colonnade', 'portal', 'ring', 'sun'], optionLabels: { span: 'Span (decks and piers)', orbit: 'Orbit (clusters around the core)', colonnade: 'Colonnade (two exact rows)', portal: 'Portal (mirror gate)', ring: 'Ring (radial slabs)', sun: 'Sun (tapered rays and rings)' }, group: 'Structure', expensive: true },
    { type: 'slider', id: 'structureDensity', label: 'Structure density', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Structure', expensive: true },
    { type: 'slider', id: 'ringCount', label: 'Ring slab count', default: 8, min: 4, max: 12, step: 1, group: 'Structure', expensive: true },
    { type: 'slider', id: 'sunRays', label: 'Sun rays', default: 22, min: 12, max: 72, step: 2, group: 'Structure', expensive: true },
    { type: 'slider', id: 'sunInner', label: 'Sun inner radius', default: 10.5, min: 10, max: 16, step: 0.5, units: 'm', group: 'Structure', expensive: true },
    { type: 'slider', id: 'sunReach', label: 'Sun ray reach', default: 20, min: 14, max: 40, step: 0.5, units: 'm', group: 'Structure', expensive: true },
    { type: 'slider', id: 'sunAlternate', label: 'Short ray length', default: 0.55, min: 0.2, max: 1, step: 0.05, group: 'Structure', expensive: true },
    { type: 'slider', id: 'sunRings', label: 'Sun rings', default: 2, min: 0, max: 3, step: 1, group: 'Structure', expensive: true },
    { type: 'toggle', id: 'sunSolidRings', label: 'Sun rings are solid', default: false, group: 'Structure', expensive: true },
    { type: 'slider', id: 'sunNoise', label: 'Sun noise', default: 0.15, min: 0, max: 1, step: 0.01, group: 'Structure', expensive: true },
    { type: 'toggle', id: 'cloudEnabled', label: 'Draw advected cloud', default: true, group: 'Simulation' },
    { type: 'slider', id: 'step', label: 'Time step', default: 30, min: 0, max: LIMITS.maxSteps, step: 1, units: `steps of ${DT} s`, group: 'Simulation', expensive: true },
    { type: 'slider', id: 'windX', label: 'Wind X', default: -0.8, min: -3, max: 3, step: 0.1, units: 'm/s', group: 'Simulation', expensive: true },
    { type: 'slider', id: 'windY', label: 'Wind Y', default: 0.5, min: -3, max: 3, step: 0.1, units: 'm/s', group: 'Simulation', expensive: true },
    { type: 'slider', id: 'eddyX', label: 'Eddy X', default: 20, min: 0, max: WORLD.width, step: 0.5, units: 'm', group: 'Simulation', expensive: true },
    { type: 'slider', id: 'eddyY', label: 'Eddy Y', default: 34, min: 0, max: WORLD.height, step: 0.5, units: 'm', group: 'Simulation', expensive: true },
    { type: 'select', id: 'eddyDrift', label: 'Eddy motion', default: 'fixed', options: ['fixed', 'wind', 'kirchhoff'], optionLabels: { fixed: 'Fixed centres', wind: 'Carried by the wind', kirchhoff: 'Wind and each other' }, group: 'Simulation', expensive: true },
    { type: 'slider', id: 'weatherSeed', label: 'Weather seed', default: 0, min: 0, max: 999, step: 1, group: 'Simulation', expensive: true },
    { type: 'toggle', id: 'trainEnabled', label: 'Eddy train', default: false, group: 'Eddy train', expensive: true },
    { type: 'slider', id: 'trainPeriod', label: 'Train period', default: 20, min: 8, max: 60, step: 1, units: 'steps', group: 'Eddy train', expensive: true },
    { type: 'slider', id: 'trainCirculation', label: 'Train circulation', default: 40, min: 10, max: 120, step: 1, units: 'm²/s', group: 'Eddy train', expensive: true },
    { type: 'slider', id: 'trainCore', label: 'Train core radius', default: 2.5, min: 1, max: 6, step: 0.25, units: 'm', group: 'Eddy train', expensive: true },
    { type: 'toggle', id: 'trainAlternate', label: 'Alternate spin', default: true, group: 'Eddy train', expensive: true },
    { type: 'slider', id: 'trainJitter', label: 'Train lateral jitter', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Eddy train', expensive: true },
    { type: 'slider', id: 'eddyCirculation', label: 'Eddy circulation', default: 30, min: -120, max: 120, step: 1, units: 'm²/s', group: 'Simulation', expensive: true },
    { type: 'slider', id: 'eddyCore', label: 'Eddy core radius', default: 3, min: 0.5, max: 12, step: 0.25, units: 'm', group: 'Simulation', expensive: true },
    { type: 'slider', id: 'dispersion', label: 'Dispersion (diffusivity)', default: 0.1, min: 0, max: 0.7, step: 0.05, units: 'm²/s', group: 'Simulation', expensive: true },
    { type: 'select', id: 'boundary', label: 'Domain edges', default: 'open', options: ['open', 'closed', 'inflow'], optionLabels: { open: 'Open (outflow)', closed: 'Closed (walls)', inflow: 'Inflow (weather front)' }, group: 'Simulation', expensive: true },
    { type: 'slider', id: 'sourceX', label: 'Source X', default: 43, min: 0, max: WORLD.width, step: 0.5, units: 'm', group: 'Simulation', expensive: true },
    { type: 'slider', id: 'sourceY', label: 'Source Y', default: 26, min: 0, max: WORLD.height, step: 0.5, units: 'm', group: 'Simulation', expensive: true },
    { type: 'slider', id: 'sourceSize', label: 'Source size', default: 11, min: 1, max: 20, step: 0.5, units: 'm', group: 'Simulation', expensive: true },
    { type: 'slider', id: 'frontAmplitude', label: 'Front peak density', default: 0.8, min: 0.1, max: 2, step: 0.05, group: 'Weather front', expensive: true },
    { type: 'slider', id: 'frontScale', label: 'Front bank size', default: 12, min: 4, max: 30, step: 0.5, units: 'm', group: 'Weather front', expensive: true },
    { type: 'slider', id: 'frontCoverage', label: 'Front coverage', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Weather front', expensive: true },
    { type: 'slider', id: 'frontSoftness', label: 'Front edge softness', default: 0.12, min: 0.02, max: 0.5, step: 0.01, group: 'Weather front', expensive: true },
    { type: 'toggle', id: 'fillInterior', label: 'Weather already present', default: true, group: 'Weather front', expensive: true },
    { type: 'toggle', id: 'sourceEnabled', label: 'Smoke source on', default: true, group: 'Simulation', expensive: true },
    { type: 'slider', id: 'referenceDensity', label: 'Reference density', default: 0.8, min: 0.05, max: 2, step: 0.05, group: 'Marks' },
    { type: 'slider', id: 'cloudHatchPitch', label: 'Cloud hatch spacing', default: 2, min: 1.2, max: 6, step: 0.1, units: 'mm', group: 'Marks' },
    { type: 'slider', id: 'contourMinSpacing', label: 'Contour minimum spacing', default: 0.55, min: 0, max: 1, step: 0.05, units: '× pitch', group: 'Marks' },
    { type: 'select', id: 'markStyle', label: 'Cloud marks', default: 'contours', options: ['contours', 'streaks', 'both'], optionLabels: { contours: 'Contour wisps', streaks: 'Flow streaks', both: 'Wisps and streaks' }, group: 'Marks' },
    { type: 'select', id: 'cloudPen', label: 'Cloud pen', default: 'cyan', options: ['cyan', 'ultramarine', 'violet', 'gold', 'carbon'], group: 'Marks' },
    { type: 'select', id: 'streakPen', label: 'Streak pen', default: 'coral', options: ['coral', 'gold', 'cyan', 'violet', 'ultramarine', 'carbon', 'vermilion', 'acid'], group: 'Marks' },
    { type: 'slider', id: 'streakSpacing', label: 'Streak spacing', default: 4, min: 2, max: 10, step: 0.5, units: 'mm', group: 'Marks' },
    { type: 'slider', id: 'obscure', label: 'Structure obscuration', default: 0.8, min: 0, max: 1, step: 0.01, group: 'Marks' },
    { type: 'slider', id: 'coreRadius', label: 'Quiet core radius', default: 34, min: 0, max: 90, step: 1, units: 'mm', group: 'Marks' },
    { type: 'slider', id: 'coreX', label: 'Quiet core X', default: 0, min: -60, max: 60, step: 1, units: 'mm', group: 'Marks' },
    { type: 'slider', id: 'coreY', label: 'Quiet core Y', default: 0, min: -90, max: 90, step: 1, units: 'mm', group: 'Marks' },
    { type: 'slider', id: 'hatchPitch', label: 'Structure hatch spacing', default: 1.35, min: 0.6, max: 4, step: 0.05, units: 'mm', group: 'Structure' },
  ],
  navigators: [
    { id: 'weather', label: 'Weather', axes: ['turbulence', 'drift', 'obscure'] },
    { id: 'wind', label: 'Wind', type: 'xy', axes: ['windX', 'windY'], yDirection: 'down', axisLabels: ['X', 'Y'] },
    { id: 'eddy', label: 'Eddy', type: 'xy', axes: ['eddyX', 'eddyY'], yDirection: 'down', axisLabels: ['X', 'Y'] },
    { id: 'quiet-core', label: 'Quiet core', type: 'xy', axes: ['coreX', 'coreY'], yDirection: 'down', axisLabels: ['X', 'Y'] },
    { id: 'source', label: 'Smoke source', type: 'xyz', axes: ['sourceX', 'sourceY', 'sourceSize'], axisLabels: ['X', 'Y', 'Size'] },
  ],
  macros: [
    { control: 'turbulence', targets: [{ control: 'eddyCirculation', amount: 70 }, { control: 'eddyCore', amount: -4 }, { control: 'dispersion', amount: 0.6 }] },
    { control: 'drift', targets: [{ control: 'windX', amount: 2.4 }, { control: 'windY', amount: 1 }] },
  ],
  draw(ctx) {
    const study = buildStudy(ctx);
    const enabled = ctx.params.cloudEnabled === true;
    const step = Math.max(0, Math.min(LIMITS.maxSteps, Math.round(Number(ctx.params.step ?? 30))));
    // The off state never touches the simulation.
    const domain = enabled ? buildDomain(study.config) : null;
    const snapshot = enabled ? simulate(study.config, [step])[0] : null;
    const parts = extractMarks(domain, snapshot, study, {
      cloudEnabled: enabled, hatchPitch: Number(ctx.params.hatchPitch ?? 1.35),
    });
    return composePoster(ctx, parts, { page: TABLOID_PAGE, subtitle: 'PRESCRIBED WEATHER', edition: 'P1' });
  },
};

export default sketch;
