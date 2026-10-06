import * as THREE from 'three';
import type { Part, Point, Sketch, SketchContext } from '../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../phase-garden/poster.ts';
import { PartBuckets } from '../kit/strokes.ts';
import { clipToRect } from '../kit/page.ts';
import { n } from '../kit/params.ts';
import { POSES, poseSkeleton, type Pose } from '../kit/mannequin/skeleton.ts';
import { stickStrokes } from '../kit/mannequin/stick.ts';
import type { Stroke } from '../kit/types.ts';

/**
 * Mannequin proof sheet: every named pose of the kit skeleton, side by side, in one renderer.
 * A development sheet, not a print: it exists to judge poses and renderers by eye.
 */
const ORDER: (keyof typeof POSES)[] = ['stand', 'walk', 'reach', 'dance', 'sit', 'kneel', 'hang'];
const BOX = { x0: 24, x1: 255.4, y0: 30, y1: 401.8 };

function layout(name: keyof typeof POSES, i: number): { pose: Pose; position: THREE.Vector3 } {
  const row = i < 4 ? 0 : 1, col = row === 0 ? i : i - 4;
  const x = row === 0 ? (col - 1.5) * 22 : (col - 1) * 26;
  const floor = row === 0 ? 4 : -38;
  // The hanging figure hangs from a point a full height above its row's floor.
  return { pose: POSES[name], position: new THREE.Vector3(x, name === 'hang' ? floor + 27 : floor, 0) };
}

function draw(ctx: SketchContext): Part[] {
  const turn = n(ctx, 'turn', 28, -60, 60) * Math.PI / 180, tilt = n(ctx, 'tilt', 8, -20, 30) * Math.PI / 180;
  const view = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 400);
  view.position.set(Math.sin(turn) * Math.cos(tilt), Math.sin(tilt), Math.cos(turn) * Math.cos(tilt)).multiplyScalar(150);
  view.lookAt(0, 0, 0);
  view.updateMatrixWorld();
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const strokes: Stroke[] = [];
  ORDER.forEach((name, i) => {
    const { pose, position } = layout(name, i);
    strokes.push(...stickStrokes(poseSkeleton(pose, { position }), { forward, joints: 'ring', group: name }));
  });
  // Fit every stroke into the box, preserving aspect.
  const proj = strokes.map(s => s.points.map(p => { const q = p.clone().applyMatrix4(view.matrixWorldInverse); return { x: q.x, y: -q.y }; }));
  const all = proj.flat();
  const minX = Math.min(...all.map(p => p.x)), maxX = Math.max(...all.map(p => p.x));
  const minY = Math.min(...all.map(p => p.y)), maxY = Math.max(...all.map(p => p.y));
  const scale = Math.min((BOX.x1 - BOX.x0) / (maxX - minX), (BOX.y1 - BOX.y0) / (maxY - minY));
  const ox = (BOX.x0 + BOX.x1) / 2 - (minX + maxX) / 2 * scale, oy = (BOX.y0 + BOX.y1) / 2 - (minY + maxY) / 2 * scale;
  const buckets = new PartBuckets();
  proj.forEach((path, k) => {
    const page: Point[] = path.map(p => ({ x: ox + p.x * scale, y: oy + p.y * scale }));
    for (const piece of clipToRect(page, BOX)) buckets.add(`${strokes[k].group}-${strokes[k].ink}`, piece, true);
  });
  return buckets.toParts(ORDER, ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet']);
}

const sketch: Sketch = {
  name: 'Mannequin proof',
  page: TABLOID_PAGE,
  pens: [
    { id: 'carbon', color: '#22282c', width: 0.25 },
    { id: 'ultramarine', color: '#3c49aa', width: 0.25 },
    { id: 'vermilion', color: '#d04b3c', width: 0.25 },
    { id: 'acid', color: '#a5a938', width: 0.25 },
    { id: 'violet', color: '#776090', width: 0.25 },
  ],
  controls: [
    { type: 'slider', id: 'turn', label: 'Camera turn', default: 28, min: -60, max: 60, step: 1, units: '°', group: 'View' },
    { type: 'slider', id: 'tilt', label: 'Camera tilt', default: 8, min: -20, max: 30, step: 1, units: '°', group: 'View' },
  ],
  draw,
};

export default sketch;
