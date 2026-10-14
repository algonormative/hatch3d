import * as THREE from 'three';
import type { AssemblySpec, Cut, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { routeParts } from '../../kit/assembly.ts';
import { MIN_FEATURE } from '../../kit/format.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, keepAlong } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { slabGeometry, type Slab } from '../../kit/slabs.ts';
import { PartBuckets, hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { ART, ASSEMBLY, CONTROLS, H, MM_X, MM_Y, PAGE, PAPER, W, bustFrame, eyeHeight, faceWord, farJoints, lintelBar, paving, pensOf, plainStrokes, ringOf, skyLines, slotRect, sun } from '../world.ts';

/**
 * Lintel, panel C: "the gaze". A paved plain in raking light, seen from eye height, so its horizon is the eye height
 * the three panels share; a long, thin, level slot is cut along that horizon in the white ply and shows the gold-yellow
 * ply beneath, where fine black gaze lines cross it. Everything on the plain is lower than the eye, so nothing rises
 * into the gaze. "can" is painted on a lit paver.
 */

const plies = [
  { id: 'gold', paper: PAPER.gold, pens: ['black'], cutInk: 'black' },
  { id: 'white', paper: PAPER.white, pens: ['carbon', 'ultramarine'], cutInk: 'carbon' },
];
export const spec: AssemblySpec = { ...ASSEMBLY, plies };
const pens = pensOf(['carbon', 'ultramarine', 'black']);

/** Carbon and ultramarine only on the white: the raking hatch's crossed violet field goes to carbon. */
const ROUTES = {
  gold: { groups: ['gaze'], inks: { carbon: 'black' } },
  white: { groups: ['plain', 'far', 'sky', 'word'], inks: { carbon: 'carbon', ultramarine: 'ultramarine', violet: 'carbon' } },
};
const INKS: Ink[] = ['carbon', 'ultramarine', 'violet'];
const GROUPS = ['plain', 'far', 'sky', 'word', 'gaze'] as const;

/** Eye height above the plain, and the paving pitch and joint, world units. */
const EYE = 4, PITCH = 1.5, JOINT = 0.09;
/** The word "can": where on the sheet its paver is sought, and its cap height there (mm). */
const CAN = { at: { x: 0.69, y: 0.71 }, capMm: 3.2 };

type Tagged = Stroke & { slack: number };

function draw(ctx: SketchContext): Part[] {
  const bar = lintelBar(ctx, bustFrame(ctx));
  const horizonY = eyeHeight(bar);
  const slot = slotRect(ctx, bar);

  const fov = n(ctx, 'plainFov', 50, 30, 80);
  const view = horizonCamera({ fov, eye: [0, EYE, 0], target: [0, EYE, -100], far: 1e4, page: PAGE, depth: { width: W, height: H }, horizonY });
  const eye = view.position.clone();
  const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const halfWidth = Math.atan(Math.tan(THREE.MathUtils.degToRad(fov / 2)) * W / H);
  const mmPerUnit = (p: THREE.Vector3) => f / -p.clone().applyMatrix4(view.matrixWorldInverse).z;

  // The plain: pavers from the foot of the sheet out until a paver is under a millimetre deep, dissolving into the glare.
  const near = EYE * f / (ART.y1 - horizonY) * 0.9;
  const far = Math.sqrt(EYE * f * PITCH / 0.8);
  const laid = plainStrokes(ctx, paving(ctx, { pitch: PITCH, joint: JOINT, near, far, halfWidth, salt: 'plain-paving' }),
    { near, far, eyeH: EYE, light: sun(ctx), eye, mmPerUnit, pitchMm: n(ctx, 'plainMm', 13, 3, 16), salt: 'plain-tone' });
  const slabs = laid.map(p => p.slab);
  const strokes: Tagged[] = laid.flatMap(({ slab, strokes: list }, i) => list.map(st => ({ ink: st.ink, group: 'plain', family: st.family, points: st.points, slack: 0.004 * -slab.z, owner: i })));
  const joints = ctx.params.joints === true ? farJoints({ pitch: PITCH, from: far, f, halfWidth, minMm: 1.2 }) : [];

  // "can": on the paver nearest its place on the sheet, painted on the top face, reading across.
  const target = { x: CAN.at.x * PAGE.width, y: CAN.at.y * PAGE.height };
  let paver: Slab = slabs[0], best = Infinity;
  for (const sl of slabs) {
    const p = pageOf(view, new THREE.Vector3(sl.x, sl.y, sl.z), PAGE);
    const d = Math.hypot(p.x - target.x, p.y - target.y);
    if (d < best) { best = d; paver = sl; }
  }
  const words: Tagged[] = faceWord(paver, 'can', { normal: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1), at: [0.12, -0.1], cap: CAN.capMm / mmPerUnit(new THREE.Vector3(paver.x, paver.y, paver.z)) })
    .map(points => ({ ink: 'carbon' as Ink, group: 'word', family: 'text' as const, points, slack: 0.03 }));

  const geometries = slabs.map(slabGeometry);
  fitDepthRange(view, geometries, 0.1, { exact: true });
  const depth = renderDepthBufferCPU(geometries, view, W, H);
  const buckets = new PartBuckets(0.4);
  const dist = (t: Tagged) => eye.distanceTo(t.points[t.points.length >> 1]);

  const wordPaths: Point[][] = [];
  projectStrokes(words, { view, depth, width: W, height: H, bias: hiddenBias(view, 0.03, dist(words[0])) }, {
    begin: () => (runs: ProjectedPoint[][]) => {
      for (const run of runs) for (const inside of clipToRect(scalePoints(run, MM_X, MM_Y), ART)) if (buckets.add('word-carbon', inside, true)) wordPaths.push(inside);
    },
  });
  const clear = glyphMask(wordPaths, 0.9, 6, PAGE);

  // Hidden lines per paver (each is small, so one bias at its own distance).
  const byOwner = new Map<number, Tagged[]>();
  for (const st of strokes) byOwner.set(st.owner!, [...(byOwner.get(st.owner!) ?? []), st]);
  for (const list of byOwner.values()) {
    projectStrokes(list, { view, depth, width: W, height: H, bias: hiddenBias(view, list[0].slack, dist(list[0])) }, {
      begin: (st: Tagged) => (runs: ProjectedPoint[][]) => {
        for (const run of runs) for (const inside of clipToRect(scalePoints(run, MM_X, MM_Y), ART)) {
          for (const piece of keepAlong(inside, p => !clear(p), 0.15)) buckets.add(`${st.group}-${st.ink}`, piece, false, st.family === 'hatch' && MIN_FEATURE ? MIN_FEATURE : undefined);
        }
      },
    });
  }
  // The joints beyond the pavers lie on bare ground in front of the eye: straight on the sheet, nothing hides them.
  for (const [a, b] of joints) for (const inside of clipToRect([pageOf(view, a, PAGE), pageOf(view, b, PAGE)], ART)) buckets.add('far-carbon', inside, true);

  // The sky: level lines in the lightest pen, open over the horizon, closing up toward the top.
  if (ctx.params.sky !== false) {
    for (const path of skyLines(ctx, 'plain-sky', { x0: ART.x0, x1: ART.x1, top: ART.y0, bottom: slot.y0 - 3 })) buckets.add('sky-ultramarine', path, true);
  }

  // The gaze, on the gold under the slot: fine level lines from the left, opening a little as they cross.
  const count = Math.round(n(ctx, 'gaze', 5, 1, 9));
  const half = (slot.y1 - slot.y0) / 2;
  for (let i = 0; i < count; i++) {
    const k = count === 1 ? 0 : i / (count - 1) * 2 - 1;
    const a = { x: slot.x0 - ASSEMBLY.bleed, y: horizonY + k * half * 0.25 }, b = { x: slot.x1 + ASSEMBLY.bleed, y: horizonY + k * (half - 0.6) };
    buckets.add('gaze-carbon', [a, b], true);
  }
  for (const g of geometries) g.dispose();

  const slotCut: Cut = { id: 'slot', label: 'SLOT', rings: [ringOf(slot)], guide: { size: 2.4, guard: 0.5, pitch: 24, heights: [2.5, 2] } };
  const art = routeParts(buckets.toParts(GROUPS, INKS), ROUTES);
  return renderPly(spec, ctx, pens, { cuts: { white: [slotCut] }, art });
}

const sketch: Sketch = {
  name: 'Breach triptych: Lintel C (the gaze)',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls: [plyControl(spec), ...CONTROLS],
  assembly: spec,
  draw,
};

export default sketch;
