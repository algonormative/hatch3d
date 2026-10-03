import type { Sketch } from '../../src/sketch/types.ts';
import { TABLOID_PAGE, composePoster, posterControls, posterArtTransform } from '../phase-garden/poster.ts';
import { drawBridge } from './geometry.ts';

/** A bridge with its structural center removed, then a living support system at one end. */
const sketch: Sketch = {
  name: 'Load Bearing Silence',
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
    ...posterControls('LOAD BEARING SILENCE', '03'),
    { type: 'slider', id: 'load', label: 'Architectural load', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'tension', label: 'Portal tension', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'disintegration', label: 'Disintegration', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'structureDensity', label: 'Satellite density', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Bridge' },
    { type: 'slider', id: 'structuralIrregularity', label: 'Structural irregularity', default: 0.48, min: 0, max: 1, step: 0.01, group: 'Bridge' },
    { type: 'slider', id: 'orbitalFragmentation', label: 'Orbital fragmentation', default: 0.52, min: 0, max: 1, step: 0.01, group: 'Bridge' },
    { type: 'slider', id: 'hatchPitch', label: 'Beam hatch spacing', default: 1.35, min: 0.5, max: 4.2, step: 0.05, units: 'mm', group: 'Bridge' },
    { type: 'slider', id: 'beamWidth', label: 'Beam width', default: 25, min: 10, max: 48, step: 1, units: 'mm', group: 'Bridge' },
    { type: 'slider', id: 'portalScale', label: 'Portal scale', default: 1.15, min: 0.35, max: 2.2, step: 0.05, group: 'Bridge' },
    { type: 'slider', id: 'routeWarp', label: 'Route bend', default: 0, min: -38, max: 38, step: 1, units: 'mm', group: 'Bridge' },
    { type: 'slider', id: 'gapWidth', label: 'Missing span', default: 0.28, min: 0.12, max: 0.48, step: 0.01, group: 'Bridge' },
    { type: 'slider', id: 'singularityPower', label: 'Singularity power', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'paletteVariation', label: 'Palette variation', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Composition' },
    { type: 'slider', id: 'ribbonShade', label: 'Tonal shading', default: 0.68, min: 0, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'lightGapAmount', label: 'Noisy gap amount', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'lightGapScale', label: 'Noisy gap scale', default: 0.48, min: 0, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'ribbonEdgeReach', label: 'Ribbon frame reach', default: 0.22, min: 0, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'rayEdgeReach', label: 'Ray frame reach', default: 0.18, min: 0, max: 1, step: 0.01, group: 'Singularity / Rays' },
    { type: 'slider', id: 'lightIrregularity', label: 'Light irregularity', default: 0.48, min: 0, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'toggle', id: 'ribbonEnabled', label: 'Draw ribbon sheet', default: true, group: 'Ribbon' },
    { type: 'slider', id: 'lightRibbons', label: 'Ribbon amount', default: 0.42, min: 0, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'ribbonWidth', label: 'Ribbon half-width', default: 18, min: 3, max: 48, step: 0.5, units: 'mm', group: 'Ribbon' },
    { type: 'slider', id: 'ribbonBend', label: 'Ribbon bend', default: 32, min: -85, max: 85, step: 1, units: 'mm', group: 'Ribbon' },
    { type: 'slider', id: 'ribbonPinch', label: 'Center pinch', default: 0.55, min: 0, max: 0.92, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'ribbonExtent', label: 'Ribbon extent', default: 118, min: 40, max: 160, step: 1, units: 'mm', group: 'Ribbon' },
    { type: 'slider', id: 'singularityX', label: 'Singularity X', default: 0, min: -12, max: 12, step: 1, units: 'mm', group: 'Singularity / Rays' },
    { type: 'slider', id: 'singularityY', label: 'Singularity Y', default: 0, min: -12, max: 12, step: 1, units: 'mm', group: 'Singularity / Rays' },
    { type: 'toggle', id: 'raysEnabled', label: 'Draw ray fans', default: true, group: 'Singularity / Rays' },
    { type: 'slider', id: 'rayDensity', label: 'Ray fan density', default: 0.62, min: 0, max: 1, step: 0.01, group: 'Singularity / Rays' },
    { type: 'slider', id: 'rayCount', label: 'Ray count', default: 34, min: 0, max: 120, step: 1, group: 'Singularity / Rays' },
    { type: 'slider', id: 'rayLength', label: 'Ray length', default: 66, min: 8, max: 125, step: 1, units: 'mm', group: 'Singularity / Rays' },
    { type: 'slider', id: 'raySpread', label: 'Ray spread', default: 310, min: 25, max: 360, step: 5, units: '°', group: 'Singularity / Rays' },
    { type: 'slider', id: 'rayCurve', label: 'Ray curvature', default: 0.25, min: -1.5, max: 1.5, step: 0.05, group: 'Singularity / Rays' },
    { type: 'slider', id: 'branchCount', label: 'Branch roots', default: 6, min: 0, max: 15, step: 1, group: 'Growth' },
    { type: 'slider', id: 'branchReach', label: 'Branch reach', default: 1, min: 0.25, max: 2, step: 0.05, group: 'Growth' },
    { type: 'slider', id: 'branchRootX', label: 'Branch root X', default: 0, min: -14, max: 14, step: 1, units: 'mm', group: 'Growth' },
    { type: 'slider', id: 'branchRootY', label: 'Branch root Y', default: 0, min: -14, max: 14, step: 1, units: 'mm', group: 'Growth' },
    { type: 'slider', id: 'worldX', label: 'Bridge world X', default: 0, min: -12, max: 12, step: 1, units: 'mm', group: 'Placement' },
    { type: 'slider', id: 'worldY', label: 'Bridge world Y', default: 0, min: -12, max: 12, step: 1, units: 'mm', group: 'Placement' },
    { type: 'slider', id: 'worldZ', label: 'Bridge world Z', default: 0, min: -10, max: 10, step: 1, units: 'mm', group: 'Placement' },
    { type: 'toggle', id: 'occlusion', label: 'Hide occluded bridge lines', default: true, group: 'Placement' },
  ],
  navigators: [
    { id: 'composition', label: 'Composition', axes: ['load', 'tension', 'singularityPower'] },
    { id: 'branch-root', label: 'Branch root', type: 'xy', axes: ['branchRootX', 'branchRootY'], yDirection: 'down', axisLabels: ['X', 'Y'] },
    { id: 'singularity', label: 'Singularity', type: 'xy', axes: ['singularityX', 'singularityY'], yDirection: 'down', axisLabels: ['X', 'Y'] },
    { id: 'world-position', label: 'Bridge world position', type: 'xyz', axes: ['worldX', 'worldY', 'worldZ'], axisLabels: ['X', 'Y', 'Z'] },
  ],
  macros: [
    { control: 'load', targets: [{ control: 'hatchPitch', amount: -0.6 }, { control: 'beamWidth', amount: 4 }] },
    { control: 'tension', targets: [{ control: 'portalScale', amount: 0.4 }, { control: 'routeWarp', amount: 8 }] },
    { control: 'disintegration', targets: [{ control: 'gapWidth', amount: 0.18 }, { control: 'branchReach', amount: 0.5 }, { control: 'orbitalFragmentation', amount: 0.45 }] },
    { control: 'singularityPower', targets: [{ control: 'lightRibbons', amount: 0.9 }, { control: 'ribbonWidth', amount: 30 }, { control: 'rayCount', amount: 100 }, { control: 'rayLength', amount: 80 }, { control: 'rayDensity', amount: 0.5 }] },
  ],
  draw(ctx) {
    const fit = posterArtTransform(ctx, TABLOID_PAGE);
    const a = fit.inverse({ x: fit.target.x, y: fit.target.y });
    const b = fit.inverse({ x: fit.target.x + fit.target.width, y: fit.target.y + fit.target.height });
    return composePoster(ctx, drawBridge(ctx, { xMin: a.x, xMax: b.x, yMin: a.y, yMax: b.y }).parts, {
      page: TABLOID_PAGE, subtitle: 'LOAD BEARING SILENCE', edition: '03',
    });
  },
};

export default sketch;
