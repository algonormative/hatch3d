import * as THREE from 'three';
import type { AssemblySpec, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { renderPly } from '../../../src/sketch/assembly.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { routeParts } from '../../kit/assembly.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, keepAlong, meshCoverage } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, pageOf } from '../../kit/perspective.ts';
import { facetStrokes, slabGeometry, type Slab } from '../../kit/slabs.ts';
import { PartBuckets, hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { LOOK, type ToneEnv } from '../../kit/mannequin/hatch.ts';
import { pinstripeTube } from '../../kit/mannequin/suit.ts';
import { Tube, silhouettes, type ClothStroke } from '../../kit/mannequin/tube.ts';
import { ART, ASSEMBLY, BAR_ID, H, MM_X, MM_Y, PAGE, PAPER, TRIM, W, bustFrame, fewerRings, lintelBar, lintelFootprint, pensOf } from '../world.ts';
import { LODESTONE_CONTROLS, clipTrim, crossingY, fieldLines, filings, lineToNorth, magnet, ribbonPath, slabHand, wordAlong } from '../lodestone-world.ts';
import { headCoil } from '../../kit/agent.ts';

/**
 * Lodestone, panel C: the magnet. L's censor bar, cut from the bust's face, is glued here level on a full gold-yellow
 * sheet, at the height of the hole it left. It is a magnet: black field lines loop from pole to pole on the gold, iron
 * filings packed at the poles and thinning out; a hand in a pinstriped cuff comes in from the top. With `handPull` it
 * grips and draws a bundle of lines up into its fist, a small south pole superposed on the bar's field; in R1 it had
 * just let the bar go. With `ribbonField` the field line that L's ribbon becomes runs on here into the north pole.
 * Two plies, bottom to top: the gold sheet, and the bar as an onlay.
 */

const plies = [
  { id: 'gold', paper: PAPER.gold, pens: ['black'], cutInk: 'black' },
  { id: 'bar', paper: PAPER.black, pens: [], cutInk: 'black', onlay: { from: `lodestone-l/black/${BAR_ID}` } },
];
export const spec: AssemblySpec = { ...ASSEMBLY, plies };
const pens = pensOf(['black']);

const ALL_BLACK = { carbon: 'black', ultramarine: 'black', violet: 'black', vermilion: 'black', acid: 'black' };
const ROUTES = { gold: { groups: ['field', 'filing', 'hand', 'word'], inks: ALL_BLACK } };
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
const GROUPS = ['field', 'filing', 'hand', 'word'] as const;

/** The hand's camera: page millimetres per world unit at the hand's depth, and its distance. */
const MM_PER_UNIT = 10, DIST = 150;
/**
 * "falls" and "into", each along a closed loop under the bar: which loop (counted outward from the bar) and the page x
 * where the word starts on it, left of centre for "falls", right for "into", so they stagger.
 */
const WORDS: { word: string; loop: number; x: number }[] = [{ word: 'falls', loop: 2, x: 66 }, { word: 'into', loop: 4, x: 176 }];

type Tagged = Stroke & { slack: number };

function draw(ctx: SketchContext): Part[] {
  const frame = bustFrame(ctx);
  const bar = lintelBar(ctx, frame);
  const m = magnet(bar, ctx);
  const pulling = m.poles.length > 0;
  const buckets = new PartBuckets(0.3);

  // The hand: a near-orthographic camera, page millimetres scaled MM_PER_UNIT to the world at z = 0.
  const fov = 2 * THREE.MathUtils.radToDeg(Math.atan(PAGE.height / (2 * MM_PER_UNIT * DIST)));
  const view = new THREE.PerspectiveCamera(fov, W / H, 1, 1e4);
  view.position.set(0, 0, DIST);
  view.lookAt(0, 0, 0);
  view.updateMatrixWorld();
  view.updateProjectionMatrix();
  const world = (p: Point, z = 0) => new THREE.Vector3((p.x - PAGE.width / 2) / MM_PER_UNIT, -(p.y - PAGE.height / 2) / MM_PER_UNIT, z);
  const eye = view.position.clone(), forward = new THREE.Vector3(0, 0, -1);
  const handX = m.rect.x0 + (m.rect.x1 - m.rect.x0) * n(ctx, 'handX', 0.68, 0, 1);
  // R1 (no pull): the hand hangs over the bar, fingers down and a little toward us, relaxing open as it lets go, turned
  // toward profile, the back of the hand to the upper right. Pulling: it hangs straighter and closes into a fist round
  // the lines it has gathered, the fist's lowest point just under the pole the lines run into.
  const along = pulling ? new THREE.Vector3(-0.12, -1, 0.22).normalize() : new THREE.Vector3(-0.32, -1, 0.18).normalize();
  const across = new THREE.Vector3(0.5, -0.12, 1).normalize();
  const size = pulling ? 5.4 : 4.4;
  const build = (wrist: THREE.Vector3) => slabHand({ wrist, along, across, size, curl: pulling ? 1.2 : 0.34, spread: pulling ? 0.02 : 0.1 });
  const grip = m.poles[0];
  let wrist = world({ x: pulling ? grip.x : handX, y: 48 });
  for (let it = 0; it < 6; it++) {
    const slabs = build(wrist);
    if (pulling) {
      // The fist's inside (the middle of its curled fingers, slabs 1 to 12) on the pole: the lines end within the fist.
      const fingers = slabs.slice(1, 13).map(sl => pageOf(view, new THREE.Vector3(sl.x, sl.y, sl.z), PAGE));
      const c = { x: fingers.reduce((t, p) => t + p.x, 0) / fingers.length, y: fingers.reduce((t, p) => t + p.y, 0) / fingers.length };
      wrist = wrist.clone().add(new THREE.Vector3((grip.x - c.x) / MM_PER_UNIT, -(grip.y - c.y) / MM_PER_UNIT, 0));
    } else {
      const low = Math.max(...slabs.flatMap(sl => corners(sl)).map(p => pageOf(view, p, PAGE).y));
      wrist = wrist.clone().add(new THREE.Vector3(0, -(m.rect.y0 - 5 - low) / MM_PER_UNIT, 0));
    }
  }
  const hand = build(wrist);
  // The sleeve and the shirt cuff, out of the top of the sheet.
  const up = along.clone().negate();
  const shirt = new Tube('shirt', [wrist.clone().addScaledVector(up, 1.9), wrist.clone().addScaledVector(up, -0.2)], [[0, 1.6, 1.4], [1, 1.55, 1.35]], across, 1, [0, 0], undefined, 6);
  const sleeve = new Tube('sleeve', [wrist.clone().addScaledVector(up, 1.4), wrist.clone().addScaledVector(up, 8), wrist.clone().addScaledVector(up, 18)],
    [[0, 2.2, 1.95], [1, 2.3, 2.05]], across, 1, [0, 0], undefined, 6);
  const env: ToneEnv = { density: 0.3, dark: () => 0.5, screen: p => pageOf(view, p, PAGE) };
  const strokes: Tagged[] = [];
  const cloth = (list: ClothStroke[]) => { for (const st of list) strokes.push({ ink: st.ink, group: 'hand', family: st.family ?? 'hatch', points: st.points, slack: 0.05 }); };
  cloth(pinstripeTube(sleeve, env, { seams: [], hems: [0.02] }, LOOK));
  for (const t of [sleeve, shirt]) cloth(silhouettes(t, { forward, eye }, { ink: 'carbon', group: 'hand' }));
  // The hand's planes: outlines, and one ring on the faces turned from the light, no more.
  const light = new THREE.Vector3(-0.5, 0.8, 0.4).normalize();
  for (const sl of hand) for (const st of fewerRings(facetStrokes(sl, light, eye, false, 7 / MM_PER_UNIT), 1)) if (st.family === 'edge' || st.points.length === 5) strokes.push({ ink: 'carbon', group: 'hand', family: st.family, points: st.points, slack: 0.04 });
  const geos = [...hand.map(slabGeometry), sleeve.mesh(64, 36), shirt.mesh(16, 36)];
  fitDepthRange(view, geos, 0.1, { exact: true });
  const depth = renderDepthBufferCPU(geos, view, W, H);
  const handArea = meshCoverage(geos, view, PAGE, 1.4);
  projectStrokes(strokes, { view, depth, width: W, height: H, bias: hiddenBias(view, 0.04, DIST) }, {
    begin: (st: Tagged) => (runs: ProjectedPoint[][]) => {
      for (const run of runs) for (const inside of clipToRect(scalePoints(run, MM_X, MM_Y), ART)) buckets.add(`hand-${st.ink}`, inside, false);
    },
  });
  for (const g of geos) g.dispose();

  // The field, and the words along two of its lines ("falls into"), which the filings give way to.
  const lines = fieldLines(m, Math.round(n(ctx, 'fieldLines', 26, 8, 48)));
  // The closed loops under the bar, innermost first.
  const loops = lines.filter(l => Math.max(...l.map(p => p.y)) > m.rect.y1 + 10 && l.every(p => p.y > TRIM.y0 && p.y < TRIM.y1 && p.x > TRIM.x0 && p.x < TRIM.x1))
    .sort((a, b) => Math.max(...a.map(p => p.y)) - Math.max(...b.map(p => p.y)));
  const words: Point[][] = [];
  for (const w of WORDS) {
    const line = loops[Math.min(w.loop, loops.length - 1)];
    if (!line) continue;
    let s = 0, from = 0;
    for (let i = 1; i < line.length; i++) { s += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y); if (line[i].x >= w.x && line[i].y > m.rect.y1) { from = s; break; } }
    words.push(...wordAlong(w.word, line, from, 2.6, -2.2));
  }
  for (const path of clipTrim(words)) for (const piece of keepAlong(path, p => !handArea(p), 0.1)) buckets.add('word-carbon', piece, true);
  const clear = glyphMask(words, 0.8, 6, PAGE);
  for (const line of clipTrim(lines)) for (const piece of keepAlong(line, p => !handArea(p) && !clear(p), 0.2)) buckets.add('field-carbon', piece, true);
  for (const dash of filings(ctx, m, Math.round(1000 * n(ctx, 'filings', 9, 0, 30)), p => handArea(p) || clear(p))) buckets.add('filing-carbon', dash, true);
  // L's ribbon, pulled along the field, leaves L's right edge on a field line: here that line goes on into the north pole.
  if (ctx.params.ribbonField !== false) {
    const y = crossingY(ribbonPath(pageOf(frame.view, headCoil(frame.fig.head).at(-1)!, PAGE), m), TRIM.x1);
    if (y !== undefined) for (const line of clipTrim([lineToNorth(m, { x: TRIM.x0, y })])) for (const piece of keepAlong(line, p => !handArea(p) && !clear(p), 0.2)) buckets.add('field-carbon', piece, true);
  }

  const art = routeParts(buckets.toParts(GROUPS, INKS), ROUTES);
  return renderPly(spec, ctx, pens, { cuts: { bar: [lintelFootprint(bar)] }, art });
}

/** A slab's eight corners in the world. */
function corners(sl: Slab): THREE.Vector3[] {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(sl.x, sl.y, sl.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(sl.rx, sl.ry, sl.rz, 'XYZ')), new THREE.Vector3(1, 1, 1));
  return [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => new THREE.Vector3(x * sl.w / 2, y * sl.h / 2, z * sl.d / 2).applyMatrix4(m))));
}

const sketch: Sketch = {
  name: 'Breach triptych: Lodestone C (the magnet)',
  page: { ...PAGE },
  pageAware: true,
  pens,
  // The top ply is the onlay, which is never rendered: the control starts on the gold sheet.
  controls: [{ type: 'select', id: spec.control, label: 'Ply', default: 'gold', options: spec.plies.map(p => p.id) }, ...LODESTONE_CONTROLS],
  assembly: spec,
  draw,
};

export default sketch;
