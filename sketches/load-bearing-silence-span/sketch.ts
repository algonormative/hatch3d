import type { Control, Sketch } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, TALL_ART, composePoster, posterControls, posterArtTransform } from '../phase-garden/poster.ts';
import { drawSpan } from './geometry.ts';

/** Poster controls with the full-height abstract sheet as the default. */
const lettering: Control[] = posterControls('LOAD BEARING SILENCE / SPAN', '03S').map(control =>
  control.id === 'posterMode' ? { ...control, default: 'abstract' } as Control : control);

/** A hotter, full-height fork: the broken bridge runs corner to corner around a larger quiet core. */
const sketch: Sketch = {
  name: 'Load Bearing Silence: Span',
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
    ...lettering,
    { type: 'slider', id: 'load', label: 'Architectural load', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'tension', label: 'Portal tension', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'disintegration', label: 'Disintegration', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'singularityPower', label: 'Singularity power', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'paletteVariation', label: 'Palette variation', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'spanAngle', label: 'Span angle', default: 0, min: -14, max: 14, step: 1, units: '°', group: 'Span' },
    { type: 'slider', id: 'remnantMass', label: 'Remnant mass', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Span' },
    { type: 'slider', id: 'coreRadius', label: 'Core radius', default: 30, min: 14, max: 44, step: 1, units: 'mm', group: 'Span' },
    { type: 'slider', id: 'gapWidth', label: 'Missing span', default: 0.18, min: 0.12, max: 0.36, step: 0.01, group: 'Span' },
    { type: 'slider', id: 'routeWarp', label: 'Route bow', default: 0, min: -40, max: 40, step: 1, units: 'mm', group: 'Span' },
    { type: 'slider', id: 'beamWidth', label: 'Beam width', default: 42, min: 20, max: 64, step: 1, units: 'mm', group: 'Bridge' },
    { type: 'slider', id: 'hatchPitch', label: 'Beam hatch spacing', default: 0.9, min: 0.6, max: 3, step: 0.05, units: 'mm', group: 'Bridge' },
    { type: 'slider', id: 'portalScale', label: 'Portal scale', default: 1.3, min: 0.5, max: 2.4, step: 0.05, group: 'Bridge' },
    { type: 'slider', id: 'structureDensity', label: 'Satellite density', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Bridge' },
    { type: 'slider', id: 'structuralIrregularity', label: 'Structural irregularity', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Bridge' },
    { type: 'slider', id: 'orbitalFragmentation', label: 'Orbital fragmentation', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Bridge' },
    { type: 'toggle', id: 'ribbonEnabled', label: 'Draw ribbon sheet', default: true, group: 'Ribbon' },
    { type: 'slider', id: 'lightRibbons', label: 'Ribbon amount', default: 0.62, min: 0, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'ribbonWidth', label: 'Ribbon half-width', default: 26, min: 6, max: 56, step: 0.5, units: 'mm', group: 'Ribbon' },
    { type: 'slider', id: 'ribbonBend', label: 'Ribbon bend', default: 36, min: -100, max: 100, step: 1, units: 'mm', group: 'Ribbon' },
    { type: 'slider', id: 'ribbonPinch', label: 'Center pinch', default: 0.55, min: 0, max: 0.92, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'ribbonExtent', label: 'Ribbon extent', default: 150, min: 60, max: 220, step: 1, units: 'mm', group: 'Ribbon' },
    { type: 'slider', id: 'ribbonShade', label: 'Tonal shading', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'lightGapAmount', label: 'Noisy gap amount', default: 0.32, min: 0, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'lightGapScale', label: 'Noisy gap scale', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'lightIrregularity', label: 'Light irregularity', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'ribbonEdgeReach', label: 'Ribbon frame reach', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'toggle', id: 'raysEnabled', label: 'Draw ray fans', default: true, group: 'Singularity / Rays' },
    { type: 'slider', id: 'rayCount', label: 'Ray count', default: 96, min: 0, max: 160, step: 1, group: 'Singularity / Rays' },
    { type: 'slider', id: 'rayDensity', label: 'Ray fan density', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Singularity / Rays' },
    { type: 'slider', id: 'rayLength', label: 'Ray length', default: 170, min: 20, max: 260, step: 1, units: 'mm', group: 'Singularity / Rays' },
    { type: 'slider', id: 'raySpread', label: 'Ray spread', default: 300, min: 25, max: 360, step: 5, units: '°', group: 'Singularity / Rays' },
    { type: 'slider', id: 'rayCurve', label: 'Ray curvature', default: 0.2, min: -1.5, max: 1.5, step: 0.05, group: 'Singularity / Rays' },
    { type: 'slider', id: 'rayEdgeReach', label: 'Ray frame reach', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Singularity / Rays' },
    { type: 'slider', id: 'singularityX', label: 'Singularity X', default: 0, min: -16, max: 16, step: 1, units: 'mm', group: 'Singularity / Rays' },
    { type: 'slider', id: 'singularityY', label: 'Singularity Y', default: 0, min: -16, max: 16, step: 1, units: 'mm', group: 'Singularity / Rays' },
    { type: 'slider', id: 'branchCount', label: 'Branch roots', default: 2, min: 0, max: 8, step: 1, group: 'Growth' },
    { type: 'slider', id: 'branchReach', label: 'Branch reach', default: 1.1, min: 0.4, max: 2.2, step: 0.05, group: 'Growth' },
    { type: 'slider', id: 'branchRootX', label: 'Branch root X', default: 0, min: -14, max: 14, step: 1, units: 'mm', group: 'Growth' },
    { type: 'slider', id: 'branchRootY', label: 'Branch root Y', default: 0, min: -14, max: 14, step: 1, units: 'mm', group: 'Growth' },
    { type: 'toggle', id: 'fogEnabled', label: 'Draw structural fog', default: false, group: 'Atmosphere' },
    { type: 'slider', id: 'fogCoverage', label: 'Fog coverage', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Atmosphere' },
    { type: 'slider', id: 'fogDepth', label: 'Fog depth', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Atmosphere' },
    { type: 'slider', id: 'fogScale', label: 'Cloud scale', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Atmosphere' },
    { type: 'slider', id: 'fogHatchPitch', label: 'Cloud hatch spacing', default: 3.6, min: 1.2, max: 6, step: 0.2, units: 'mm', group: 'Atmosphere' },
    { type: 'slider', id: 'worldX', label: 'Bridge world X', default: 0, min: -12, max: 12, step: 1, units: 'mm', group: 'Placement' },
    { type: 'slider', id: 'worldY', label: 'Bridge world Y', default: 0, min: -12, max: 12, step: 1, units: 'mm', group: 'Placement' },
    { type: 'slider', id: 'worldZ', label: 'Bridge world Z', default: 0, min: -10, max: 10, step: 1, units: 'mm', group: 'Placement' },
    { type: 'toggle', id: 'occlusion', label: 'Hide occluded bridge lines', default: true, group: 'Placement' },
  ],
  navigators: [
    { id: 'composition', label: 'Composition', axes: ['load', 'tension', 'singularityPower'] },
    { id: 'singularity', label: 'Singularity', type: 'xy', axes: ['singularityX', 'singularityY'], yDirection: 'down', axisLabels: ['X', 'Y'] },
    { id: 'branch-root', label: 'Branch root', type: 'xy', axes: ['branchRootX', 'branchRootY'], yDirection: 'down', axisLabels: ['X', 'Y'] },
    { id: 'world-position', label: 'Bridge world position', type: 'xyz', axes: ['worldX', 'worldY', 'worldZ'], axisLabels: ['X', 'Y', 'Z'] },
  ],
  macros: [
    { control: 'load', targets: [{ control: 'hatchPitch', amount: -0.5 }, { control: 'beamWidth', amount: 12 }, { control: 'remnantMass', amount: 0.5 }] },
    { control: 'tension', targets: [{ control: 'portalScale', amount: 0.6 }, { control: 'routeWarp', amount: 16 }] },
    { control: 'disintegration', targets: [{ control: 'gapWidth', amount: 0.1 }, { control: 'branchReach', amount: 0.5 }, { control: 'orbitalFragmentation', amount: 0.5 }] },
    { control: 'singularityPower', targets: [{ control: 'lightRibbons', amount: 0.7 }, { control: 'ribbonWidth', amount: 20 }, { control: 'rayCount', amount: 70 }, { control: 'rayLength', amount: 70 }, { control: 'rayDensity', amount: 0.4 }] },
  ],
  draw(ctx) {
    // With TALL_ART the abstract fit is the identity; the inverse widens light bounds in lettered mode.
    const fit = posterArtTransform(ctx, TABLOID_PAGE, TALL_ART);
    const a = fit.inverse({ x: fit.target.x, y: fit.target.y });
    const b = fit.inverse({ x: fit.target.x + fit.target.width, y: fit.target.y + fit.target.height });
    return composePoster(ctx, drawSpan(ctx, { xMin: a.x, xMax: b.x, yMin: a.y, yMax: b.y }).parts, {
      page: TABLOID_PAGE, subtitle: 'LOAD BEARING SILENCE / SPAN', edition: '03S', authored: TALL_ART,
    });
  },
};

export default sketch;
