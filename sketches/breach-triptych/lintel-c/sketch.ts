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
import { fitDepthRange, horizonCamera } from '../../kit/perspective.ts';
import { slabGeometry, type Slab } from '../../kit/slabs.ts';
import { PartBuckets, hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { ART, ASSEMBLY, CONTROLS, H, MM_X, MM_Y, PAGE, PAPER, TRIM, W, bustFrame, eyeHeight, faceWordAt, farLines, lintelBar, paving, pensOf, plainStrokes, ringOf, skyLines, slotRect, sun } from '../world.ts';

/**
 * Lintel, panel C: "the gaze". A plain seen from eye height, so its horizon is the eye height the three panels share.
 * Three sheets, bottom to top: black, gold-yellow, white. The white is cut away above the horizon band and the gold
 * above the band's top edge, so the sky is the black paper and the horizon is a band of gold between the black sky and
 * the white plain: the gaze crossing it, fine black lines on the gold. Everything on the plain is lower than the eye,
 * so nothing rises into the gaze. "can" is painted on the ground.
 */

const plies = [
  { id: 'black', paper: PAPER.black, pens: ['silver', 'gold'], cutInk: 'silver' },
  { id: 'gold', paper: PAPER.gold, pens: ['black'], cutInk: 'black' },
  { id: 'white', paper: PAPER.white, pens: ['carbon', 'ultramarine'], cutInk: 'carbon' },
];
export const spec: AssemblySpec = { ...ASSEMBLY, plies };
const pens = pensOf(['silver', 'gold', 'black', 'carbon', 'ultramarine']);

/** Carbon and ultramarine only on the white (the raking hatch's crossed violet field goes to carbon); black on the gold; silver on the black. */
const ROUTES = {
  black: { groups: ['echo'], inks: { ultramarine: 'silver' } },
  gold: { groups: ['gaze'], inks: { carbon: 'black' } },
  white: { groups: ['plain', 'far', 'word'], inks: { carbon: 'carbon', ultramarine: 'ultramarine', violet: 'carbon' } },
};
const INKS: Ink[] = ['carbon', 'ultramarine', 'violet'];
const GROUPS = ['plain', 'far', 'word', 'gaze', 'echo'] as const;

/** Eye height above the plain, and the paving pitch and joint, world units. */
const EYE = 4, PITCH = 1.5, JOINT = 0.09;
/**
 * The word "can": where its centre lands on the sheet, and its cap height there across the sheet (mm). Painted flat on
 * the ground it is foreshortened to about half that in height, so its lowercase stands about 1.7 mm tall on the paper.
 */
const CAN = { at: { x: 0.66, y: 0.79 }, capMm: 6 };

type Tagged = Stroke & { slack: number };

/** What a ground gives the panel: its strokes (each tagged with an owner for its hidden-line test), its solids, its long lines, and the solids "can" may be painted on. */
interface Ground { strokes: Tagged[]; solids: Slab[]; lines: Tagged[]; canOn: Slab[] }

/** A rectangle as a ring, for a cut. */
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => ringOf({ x0, y0, x1, y1 });

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
  const near = EYE * f / (ART.y1 - horizonY) * 0.9;

  // The ground: a paved plain in raking light, on to the horizon.
  const pavingGround = (): Ground => {
    const far = Math.sqrt(EYE * f * PITCH / 0.8);
    const laid = plainStrokes(ctx, paving(ctx, { pitch: PITCH, joint: JOINT, near, far, halfWidth, salt: 'plain-paving' }),
      { near, far, eyeH: EYE, light: sun(ctx), eye, mmPerUnit, pitchMm: n(ctx, 'plainMm', 13, 3, 16), salt: 'plain-tone', rings: Math.round(n(ctx, 'rings', 3, 0, 30)) });
    const strokes = laid.flatMap(({ slab, strokes: list }, i) => list.map(st => ({ ink: st.ink, group: 'plain', family: st.family, points: st.points, slack: 0.004 * -slab.z, owner: i })));
    const lines: Tagged[] = [];
    if (ctx.params.joints !== false) {
      const { courses, joints } = farLines({ pitch: PITCH, from: far * 0.6, eyeH: EYE, f, halfWidth, minMm: 1.4 });
      for (const points of courses) lines.push({ ink: 'ultramarine', group: 'far', family: 'edge', points, slack: 0.05 });
      for (const points of joints) lines.push({ ink: 'carbon', group: 'far', family: 'edge', points, slack: 0.05 });
    }
    const slabs = laid.map(p => p.slab);
    return { strokes, solids: slabs, lines, canOn: slabs };
  };
  const ground = pavingGround();

  // "can": painted flat on the top of whichever solid lies under its place on the sheet, reading across.
  const target = { x: CAN.at.x * PAGE.width, y: CAN.at.y * PAGE.height };
  const painted = ground.canOn.map(sl => faceWordAt(sl, 'can', view, target, { normal: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1), capMm: CAN.capMm })).find(Boolean) ?? [];
  const words: Tagged[] = painted.map(points => ({ ink: 'carbon' as Ink, group: 'word', family: 'text' as const, points, slack: 0.03 }));

  const geometries = ground.solids.map(slabGeometry);
  fitDepthRange(view, geometries, 0.1, { exact: true });
  // The far lines run on to the horizon, beyond the last solid: the depth range reaches them.
  view.far = Math.max(view.far, EYE * f / 0.3);
  view.updateProjectionMatrix();
  const depth = renderDepthBufferCPU(geometries, view, W, H);
  const buckets = new PartBuckets(0.4);
  const dist = (t: Tagged) => eye.distanceTo(t.points[t.points.length >> 1]);

  const wordPaths: Point[][] = [];
  if (words.length) projectStrokes(words, { view, depth, width: W, height: H, bias: hiddenBias(view, 0.03, dist(words[0])) }, {
    begin: () => (runs: ProjectedPoint[][]) => {
      for (const run of runs) for (const inside of clipToRect(scalePoints(run, MM_X, MM_Y), ART)) if (buckets.add('word-carbon', inside, true)) wordPaths.push(inside);
    },
  });
  const clear = glyphMask(wordPaths, 0.9, 6, PAGE);

  // Hidden lines per owner (each solid is small, so one bias at its own distance); the far lines one by one.
  const byOwner = new Map<number, Tagged[]>();
  for (const st of ground.strokes) { const list = byOwner.get(st.owner!); if (list) list.push(st); else byOwner.set(st.owner!, [st]); }
  for (const list of [...byOwner.values(), ...ground.lines.map(l => [l])]) {
    projectStrokes(list, { view, depth, width: W, height: H, bias: hiddenBias(view, list[0].slack, dist(list[0])) }, {
      begin: (st: Tagged) => (runs: ProjectedPoint[][]) => {
        for (const run of runs) for (const inside of clipToRect(scalePoints(run, MM_X, MM_Y), ART)) {
          for (const piece of keepAlong(inside, p => !clear(p), 0.15)) buckets.add(`${st.group}-${st.ink}`, piece, false, st.family === 'hatch' && MIN_FEATURE ? MIN_FEATURE : undefined);
        }
      },
    });
  }

  // The black sky: bare, or a sparse silver echo of level dashes.
  if (ctx.params.skyEcho === true) {
    for (const path of skyLines(ctx, 'plain-sky', { x0: ART.x0, x1: ART.x1, top: ART.y0, bottom: slot.y0 - 3 }, 26, 9)) buckets.add('echo-ultramarine', path, true);
  }

  // The gaze, on the gold band: fine level lines from the left, opening a little as they cross.
  const count = Math.round(n(ctx, 'gazeLines', 5, 1, 9));
  const half = (slot.y1 - slot.y0) / 2;
  for (let i = 0; i < count; i++) {
    const k = count === 1 ? 0 : i / (count - 1) * 2 - 1;
    const a = { x: slot.x0 - 1, y: horizonY + k * half * 0.25 }, b = { x: slot.x1 + 1, y: horizonY + k * (half - 0.9) };
    buckets.add('gaze-carbon', [a, b], true);
  }
  for (const g of geometries) g.dispose();

  // One cut per sheet: the white loses the sky and the band, the gold the sky alone.
  const cuts: Record<string, Cut[]> = {
    white: [{ id: 'sky', label: 'SKY', rings: [rect(TRIM.x0, TRIM.y0, TRIM.x1, slot.y1)] }],
    gold: [{ id: 'sky', label: 'SKY', rings: [rect(TRIM.x0, TRIM.y0, TRIM.x1, slot.y0)] }],
  };
  const art = routeParts(buckets.toParts(GROUPS, INKS), ROUTES);
  return renderPly(spec, ctx, pens, { cuts, art });
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
