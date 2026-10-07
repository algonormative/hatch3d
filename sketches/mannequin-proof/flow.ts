import * as THREE from 'three';
import type { Part, Point, Sketch, SketchContext } from '../../src/sketch/types.ts';
import { TABLOID_PAGE } from '../phase-garden/poster.ts';
import { PartBuckets, projectStrokes } from '../kit/strokes.ts';
import { renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { bigSuit, bigSuitMeshes, bigSuitStrokes } from '../kit/mannequin/big-suit.ts';
import { buildBody, bodyMeshes, bodyStrokes, contourTube, type Body } from '../kit/mannequin/body.ts';
import { ELONGATED, flowBody, gesture, ribbonStrokes, type Gesture } from '../kit/mannequin/gesture.ts';
import { LOOK } from '../kit/mannequin/hatch.ts';
import { STRIDE, streamerStrokes, walkCycle } from '../kit/mannequin/motion.ts';
import { POSES, poseSkeleton, withPose, type Pose, type Skeleton } from '../kit/mannequin/skeleton.ts';
import { silhouettes, type ClothStroke } from '../kit/mannequin/tube.ts';
import { clipToRect } from '../kit/page.ts';
import { n } from '../kit/params.ts';

/**
 * Flowing-figure proof: one figure, filling the sheet, in one stylization, so the stylizations can be
 * set side by side and judged by eye at full size and as thumbnails. A development sheet, not a print.
 * - reference: the stiff kit body, as posed;
 * - gesture: the pose pushed along its line of action, long proportions, limbs as single tapering tubes;
 * - ribbon: the gesture figure drawn as long bands running the length of each limb;
 * - motion: the gesture figure with the moments before it as outlines, its path traced, a scarf streaming;
 * - bigsuit: the gesture figure, small-headed, in a suit far too big for it, curled toes, the tie in the wind;
 * - motley: the big suit quartered like a jester's.
 */
const BOX = { x0: 24, x1: 255.4, y0: 30, y1: 401.8 };
const GROUPS = ['trail', 'ghost', 'figure', 'contour'];
const INKS = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
const STYLES = ['reference', 'gesture', 'ribbon', 'motion', 'bigsuit', 'motley'] as const;

/** The pose under test: a named pose (the Fool's walk by default) with the head turned up. */
function basePose(ctx: SketchContext, phase = 0): Pose {
  const name = (Object.keys(POSES) as (keyof typeof POSES)[]).find(k => k === ctx.params.pose) ?? 'walk';
  const look = { neck: { flex: -n(ctx, 'lookUp', 22, -40, 50) }, head: { flex: -n(ctx, 'lookUp', 22, -40, 50) * 0.5 } };
  return withPose(name === 'walk' ? walkCycle(phase) : POSES[name], look);
}

function draw(ctx: SketchContext): Part[] {
  const style = STYLES.find(x => x === ctx.params.style) ?? 'gesture';
  const turn = n(ctx, 'turn', 62, -90, 90) * Math.PI / 180, tilt = n(ctx, 'tilt', 6, -20, 30) * Math.PI / 180;
  const g: Gesture = {
    push: n(ctx, 'push', 1.35, 0.5, 2), arc: n(ctx, 'arc', -10, -40, 40), sway: n(ctx, 'sway', 0, -20, 20),
    wring: n(ctx, 'wring', 10, -30, 30), lean: n(ctx, 'lean', 5, -20, 20),
  };
  const stylized = style !== 'reference';
  const suited = style === 'bigsuit' || style === 'motley';
  const H = 24;
  const skeletonAt = (phase: number, back = 0): Skeleton => {
    const pose = stylized ? gesture(basePose(ctx, phase), g) : basePose(ctx, phase);
    return poseSkeleton(pose, { height: H, proportions: suited ? { ...ELONGATED, head: n(ctx, 'head', 0.72, 0.5, 1) } : stylized ? ELONGATED : undefined, position: new THREE.Vector3(0, 0, -back) });
  };
  const main = skeletonAt(0);
  const body: Body = stylized ? flowBody(main, { bow: n(ctx, 'bow', 0.06, 0, 0.2), toes: suited ? 'curl' : 'point' }) : buildBody(main);
  const suit = suited ? bigSuit(main, { size: n(ctx, 'size', 1.6, 1, 2.2) }) : null;
  // The moments before: ghosts back along the walk, older ones further behind.
  const ghostCount = style === 'motion' ? Math.round(n(ctx, 'ghosts', 5, 0, 12)) : 0;
  const spacing = n(ctx, 'spacing', 0.1, 0.02, 0.2);
  const ghosts = Array.from({ length: ghostCount }, (_, i) => {
    const dt = (i + 1) * spacing;
    return flowBody(skeletonAt(-dt, dt * STRIDE * H), { bow: n(ctx, 'bow', 0.06, 0, 0.2) });
  });
  // Paths of the crown, hands and toes over the trail, and the scarf from the neck along its own path.
  const span = ghostCount * spacing;
  const samples = Array.from({ length: 41 }, (_, i) => -span * i / 40);
  const pathSkeletons = style === 'motion' ? samples.map(t => skeletonAt(t, -t * STRIDE * H)) : [];
  const trails = pathSkeletons.length ? ([['head', true], ['wrist_l', true], ['wrist_r', true], ['ankle_l', true], ['ankle_r', true]] as const)
    .map(([j, end]) => pathSkeletons.map(s => s.at(j, end))) : [];
  // The scarf runs back from the neck along the neck's own path, a third again as long, sinking and
  // fluttering more toward its free end.
  const scarf = pathSkeletons.length ? Array.from({ length: 61 }, (_, i) => {
    const f = i / 60, x = f * 1.35 * (pathSkeletons.length - 1);
    const k = Math.min(pathSkeletons.length - 2, Math.floor(x));
    const a = pathSkeletons[k].at('neck'), b = pathSkeletons[k + 1].at('neck');
    const p = a.clone().lerp(b, x - k);
    return p.addScaledVector(main.axes('chest').z, -0.5).add(new THREE.Vector3(1.4 * f * Math.sin(f * 9), -2.6 * f * f + 0.8 * f * Math.sin(f * 6 + 1), 0));
  }) : [];

  // An orthographic view fitted to everything drawn, matching the box's aspect.
  const view = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);
  view.position.set(Math.sin(turn) * Math.cos(tilt), Math.sin(tilt), Math.cos(turn) * Math.cos(tilt)).multiplyScalar(200);
  view.lookAt(0, H * 0.5, 0);
  view.updateMatrixWorld();
  const extent = [...main.bones().flatMap(([, a, b]) => [a, b]), ...(suit ? Array.from({ length: 16 }, (_, i) => suit.jacket.point(0.9, i / 16)) : []), ...ghosts.flatMap(b => b.skeleton.bones().flatMap(([, a, c]) => [a, c])), ...scarf]
    .map(p => p.clone().applyMatrix4(view.matrixWorldInverse));
  const pad = 2.5;
  let x0 = Math.min(...extent.map(p => p.x)) - pad, x1 = Math.max(...extent.map(p => p.x)) + pad;
  let y0 = Math.min(...extent.map(p => p.y)) - pad, y1 = Math.max(...extent.map(p => p.y)) + pad;
  const bw = BOX.x1 - BOX.x0, bh = BOX.y1 - BOX.y0;
  if ((x1 - x0) / (y1 - y0) > bw / bh) { const c = (y0 + y1) / 2, h = (x1 - x0) * bh / bw; y0 = c - h / 2; y1 = c + h / 2; }
  else { const c = (x0 + x1) / 2, w = (y1 - y0) * bw / bh; x0 = c - w / 2; x1 = c + w / 2; }
  Object.assign(view, { left: x0, right: x1, top: y1, bottom: y0 });
  view.updateProjectionMatrix();
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const W = Math.round(bw * 3), Hpx = Math.round(bh * 3);
  const mm = (p: { x: number; y: number }): Point => ({ x: BOX.x0 + p.x * bw / W, y: BOX.y0 + p.y * bh / Hpx });
  const light = new THREE.Vector3(-0.5, 0.6, 0.65).normalize();
  const sheetScale = bw / (x1 - x0);
  // Cloth takes a softer key than skin, so the lit front keeps its primaries.
  const key = suited ? 1.35 : 1.7;
  const env = {
    forward, density: n(ctx, 'density', 0.55, 0, 1),
    screen: (p: THREE.Vector3) => { const q = p.clone().applyMatrix4(view.matrixWorldInverse); return { x: q.x * sheetScale, y: -q.y * sheetScale }; },
    // A raking key: the lit side goes to paper, the turned side fills.
    dark: (_p: THREE.Vector3, normal: THREE.Vector3) => Math.max(0, Math.min(1, 1.05 - key * Math.max(0, normal.dot(light)))),
  };
  const buckets = new PartBuckets();
  const emit = (strokes: ClothStroke[], meshes: THREE.BufferGeometry[]) => {
    try {
      const depth = renderDepthBufferCPU(meshes, view, W, Hpx);
      projectStrokes(strokes, { view, depth, width: W, height: Hpx }, {
        begin: st => runs => { for (const run of runs) for (const piece of clipToRect(run.map(mm), BOX)) buckets.add(`${st.group}-${st.ink}`, piece); },
      });
    } finally {
      for (const m of meshes) m.dispose();
    }
  };
  // In the big suit only the head, the hands and the shoes show: the shoes in the dark pen.
  const shoes = { ...LOOK, cloth: 'carbon' as const, accent: 'carbon' as const };
  const figure = suit
    ? [
      ...bigSuitStrokes(suit, env, LOOK, { motley: style === 'motley', wind: new THREE.Vector3(0, 0.25, 1) }),
      ...[body.head!, ...body.limbs].flatMap(t => [...contourTube(t, env, t.id.startsWith('leg') ? shoes : LOOK), ...silhouettes(t, env, { ink: LOOK.edge, group: LOOK.contour })]),
    ]
    : style === 'ribbon'
      ? ribbonStrokes(body, env, LOOK, { bands: n(ctx, 'bands', 7, 3, 16), twist: n(ctx, 'twist', 0.4, -1, 1), fill: n(ctx, 'fill', 0.55, 0.2, 1) })
      : bodyStrokes(body, env, 'bare', LOOK);
  const mainMeshes = () => [...bodyMeshes(body, 0.8), ...(suit ? bigSuitMeshes(suit) : [])];
    const trailLook = { ...LOOK, figure: 'trail', contour: 'trail' };
  emit([
    ...figure,
    ...trails.map(points => ({ ink: 'acid' as const, group: 'trail', points })),
    ...(scarf.length ? streamerStrokes(scarf, env, { width: 1.3, turns: 3, rungs: 4 }, trailLook) : []),
  ], mainMeshes());
  // Each ghost is outlined against itself and the figure in front of it, never against the other ghosts.
  for (const gb of ghosts) emit([gb.trunk, ...gb.limbs, ...(gb.head ? [gb.head] : [])].flatMap(t => silhouettes(t, env, { ink: 'violet', group: 'ghost' })),
    [...mainMeshes(), ...bodyMeshes(gb, 0.6)]);
  return buckets.toParts(GROUPS, INKS);
}

const sketch: Sketch = {
  name: 'Flowing figure proof',
  page: TABLOID_PAGE,
  pens: [
    { id: 'carbon', color: '#22282c', width: 0.25 },
    { id: 'ultramarine', color: '#3c49aa', width: 0.25 },
    { id: 'vermilion', color: '#d04b3c', width: 0.25 },
    { id: 'acid', color: '#a5a938', width: 0.25 },
    { id: 'violet', color: '#776090', width: 0.25 },
  ],
  controls: [
    { type: 'select', id: 'style', label: 'Stylization', default: 'gesture', options: [...STYLES], group: 'Figure' },
    { type: 'select', id: 'pose', label: 'Pose', default: 'walk', options: Object.keys(POSES), group: 'Figure' },
    { type: 'slider', id: 'push', label: 'Push the pose', default: 1.35, min: 0.5, max: 2, step: 0.05, group: 'Gesture' },
    { type: 'slider', id: 'arc', label: 'Spine arc', default: -10, min: -40, max: 40, step: 1, units: '°', group: 'Gesture' },
    { type: 'slider', id: 'sway', label: 'Contrapposto', default: 0, min: -20, max: 20, step: 1, units: '°', group: 'Gesture' },
    { type: 'slider', id: 'wring', label: 'Wring', default: 10, min: -30, max: 30, step: 1, units: '°', group: 'Gesture' },
    { type: 'slider', id: 'lean', label: 'Lean', default: 5, min: -20, max: 20, step: 1, units: '°', group: 'Gesture' },
    { type: 'slider', id: 'bow', label: 'Limb bow', default: 0.06, min: 0, max: 0.2, step: 0.01, group: 'Gesture' },
    { type: 'slider', id: 'lookUp', label: 'Look up', default: 22, min: -40, max: 50, step: 1, units: '°', group: 'Gesture' },
    { type: 'slider', id: 'size', label: 'Suit size', default: 1.6, min: 1, max: 2.2, step: 0.05, group: 'Big suit' },
    { type: 'slider', id: 'head', label: 'Head size', default: 0.72, min: 0.5, max: 1, step: 0.01, group: 'Big suit' },
    { type: 'slider', id: 'bands', label: 'Ribbon bands', default: 7, min: 3, max: 16, step: 1, group: 'Ribbon' },
    { type: 'slider', id: 'twist', label: 'Ribbon twist (turns)', default: 0.4, min: -1, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'fill', label: 'Ribbon fill', default: 0.55, min: 0.2, max: 1, step: 0.01, group: 'Ribbon' },
    { type: 'slider', id: 'ghosts', label: 'Ghosts', default: 5, min: 0, max: 12, step: 1, group: 'Motion' },
    { type: 'slider', id: 'spacing', label: 'Ghost spacing (cycle)', default: 0.1, min: 0.02, max: 0.2, step: 0.01, group: 'Motion' },
    { type: 'slider', id: 'density', label: 'Line density', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Figure' },
    { type: 'slider', id: 'turn', label: 'Camera turn', default: 62, min: -90, max: 90, step: 1, units: '°', group: 'View' },
    { type: 'slider', id: 'tilt', label: 'Camera tilt', default: 6, min: -20, max: 30, step: 1, units: '°', group: 'View' },
  ],
  draw,
};

export default sketch;
