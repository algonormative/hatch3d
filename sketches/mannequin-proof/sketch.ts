import * as THREE from 'three';
import type { Part, Point, Sketch, SketchContext } from '../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../phase-garden/poster.ts';
import { PartBuckets, projectStrokes } from '../kit/strokes.ts';
import { renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { buildBody, bodyMeshes, bodyStrokes } from '../kit/mannequin/body.ts';
import { LOOK } from '../kit/mannequin/hatch.ts';
import { drape, drapeMesh, drapeStrokes } from '../kit/mannequin/drape.ts';
import { emptyPieces, mergePieces, outfit, piecesMeshes, piecesStrokes, prop, type PropKind } from '../kit/mannequin/pieces.ts';
import type { Side } from '../kit/mannequin/skeleton.ts';
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
const INKS = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
/** Props per pose on the proof sheet, after the arcana they are for. */
const PROPS: Partial<Record<keyof typeof POSES, [Side, PropKind][]>> = {
  stand: [['r', 'lantern']], walk: [['r', 'staff']], reach: [['r', 'wand']], dance: [['l', 'wand'], ['r', 'wand']],
  sit: [['l', 'scales'], ['r', 'sword']], kneel: [['r', 'cup']],
};

function layout(name: keyof typeof POSES, i: number): { pose: Pose; position: THREE.Vector3 } {
  const row = i < 4 ? 0 : 1, col = row === 0 ? i : i - 4;
  const x = row === 0 ? (col - 1.5) * 22 : (col - 1) * 26;
  const floor = row === 0 ? 4 : -38;
  // The hanging figure hangs from a point a full height above its row's floor.
  return { pose: POSES[name], position: new THREE.Vector3(x, name === 'hang' ? floor + 27 : floor, 0) };
}

function draw(ctx: SketchContext): Part[] {
  const STYLES = ['stick', 'bare', 'suit', 'robe', 'cloak', 'outfit'] as const;
  const style = STYLES.find(x => x === ctx.params.style) ?? 'stick';
  const withProps = ctx.params.props !== false;
  const turn = n(ctx, 'turn', 28, -60, 60) * Math.PI / 180, tilt = n(ctx, 'tilt', 8, -20, 30) * Math.PI / 180;
  const facets = Math.round(n(ctx, 'facets', 0, 0, 12));
  const skeletons = ORDER.map((name, i) => { const { pose, position } = layout(name, i); return poseSkeleton(pose, { position }); });
  // An orthographic view fitted to every figure, matching the box's aspect.
  const view = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);
  view.position.set(Math.sin(turn) * Math.cos(tilt), Math.sin(tilt), Math.cos(turn) * Math.cos(tilt)).multiplyScalar(200);
  view.lookAt(0, 0, 0);
  view.updateMatrixWorld();
  const pts = skeletons.flatMap(s => s.bones().flatMap(([, a, b]) => [a, b])).map(p => p.clone().applyMatrix4(view.matrixWorldInverse));
  const pad = 4;
  let x0 = Math.min(...pts.map(p => p.x)) - pad, x1 = Math.max(...pts.map(p => p.x)) + pad;
  let y0 = Math.min(...pts.map(p => p.y)) - pad, y1 = Math.max(...pts.map(p => p.y)) + pad;
  const bw = BOX.x1 - BOX.x0, bh = BOX.y1 - BOX.y0;
  if ((x1 - x0) / (y1 - y0) > bw / bh) { const c = (y0 + y1) / 2, h = (x1 - x0) * bh / bw; y0 = c - h / 2; y1 = c + h / 2; }
  else { const c = (x0 + x1) / 2, w = (y1 - y0) * bw / bh; x0 = c - w / 2; x1 = c + w / 2; }
  Object.assign(view, { left: x0, right: x1, top: y1, bottom: y0 });
  view.updateProjectionMatrix();
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const W = Math.round(bw * 2), H = Math.round(bh * 2);
  const mm = (p: { x: number; y: number }): Point => ({ x: BOX.x0 + p.x * bw / W, y: BOX.y0 + p.y * bh / H });
  const buckets = new PartBuckets();
  if (style === 'stick' && !withProps) {
    const strokes: Stroke[] = skeletons.flatMap((s, i) => stickStrokes(s, { forward, joints: 'ring', group: ORDER[i] }));
    for (const st of strokes) {
      const page = st.points.map(p => { const q = p.clone().project(view); return mm({ x: (q.x * 0.5 + 0.5) * W, y: (-q.y * 0.5 + 0.5) * H }); });
      for (const piece of clipToRect(page, BOX)) buckets.add(`${st.group}-${st.ink}`, piece, true);
    }
    return buckets.toParts(ORDER, INKS);
  }
  const bodies = skeletons.map(s => buildBody(s, { facets, jacket: style === 'suit' }));
  const rng = ctx.random('proof-drape');
  const drapes = style === 'robe' || style === 'cloak'
    ? bodies.map((b, i) => drape(b, { rng, attach: ORDER[i] === 'hang' ? 'waist' : 'shoulders', length: ORDER[i] === 'hang' ? 0.42 : 1, open: style === 'cloak' ? 1.1 : 0 }))
    : [];
  const pieces = skeletons.map((s, i) => mergePieces(
    style === 'outfit' ? outfit(s) : emptyPieces(),
    ...(withProps ? (PROPS[ORDER[i]] ?? []).map(([side, kind]) => prop(s, side, kind)) : []),
  ));
  const light = new THREE.Vector3(-0.5, 0.6, 0.65).normalize();
  const sheetScale = bw / (x1 - x0);
  const env = {
    forward, density: n(ctx, 'density', 0.55, 0, 1),
    screen: (p: THREE.Vector3) => { const q = p.clone().applyMatrix4(view.matrixWorldInverse); return { x: q.x * sheetScale, y: -q.y * sheetScale }; },
    dark: (_p: THREE.Vector3, normal: THREE.Vector3) => Math.max(0, Math.min(1, 1.02 - 1.2 * Math.max(0, normal.dot(light)))),
  };
  const look = (i: number) => ({ ...LOOK, figure: ORDER[i], contour: ORDER[i] });
  const pieceEnv = { ...env, eye: view.position.clone(), light: light.clone() };
  const strokes = [
    ...(style === 'outfit' || style === 'stick'
      ? skeletons.flatMap((s, i) => stickStrokes(s, { forward, joints: 'ring', group: ORDER[i] }))
      : bodies.flatMap((b, i) => bodyStrokes(b, env, style === 'suit' ? 'suit' : 'bare', look(i)))),
    ...drapes.flatMap((d, i) => drapeStrokes(d, env, look(i))),
    ...pieces.flatMap((p, i) => piecesStrokes(p, pieceEnv, look(i))),
  ];
  const meshes = [
    ...(style === 'outfit' || style === 'stick' ? [] : bodies.flatMap(b => bodyMeshes(b, 0.6))),
    ...drapes.map(drapeMesh),
    ...pieces.flatMap(p => piecesMeshes(p)),
  ];
  try {
    const depth = renderDepthBufferCPU(meshes, view, W, H);
    projectStrokes(strokes, { view, depth, width: W, height: H }, {
      begin: st => runs => { for (const run of runs) for (const piece of clipToRect(run.map(mm), BOX)) buckets.add(`${st.group}-${st.ink}`, piece); },
    });
  } finally {
    for (const m of meshes) m.dispose();
  }
  return buckets.toParts(ORDER, INKS);
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
    { type: 'select', id: 'style', label: 'Renderer', default: 'stick', options: ['stick', 'bare', 'suit', 'robe', 'cloak', 'outfit'], group: 'Figure' },
    { type: 'toggle', id: 'props', label: 'Held props', default: true, group: 'Figure' },
    { type: 'slider', id: 'facets', label: 'Planes per limb (0 = smooth)', default: 0, min: 0, max: 12, step: 1, group: 'Figure' },
    { type: 'slider', id: 'density', label: 'Line density', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Figure' },
    { type: 'slider', id: 'turn', label: 'Camera turn', default: 28, min: -60, max: 60, step: 1, units: '°', group: 'View' },
    { type: 'slider', id: 'tilt', label: 'Camera tilt', default: 8, min: -20, max: 30, step: 1, units: '°', group: 'View' },
  ],
  draw,
};

export default sketch;
