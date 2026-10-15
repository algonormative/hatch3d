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
import { facetStrokes, slabGeometry, slabMatrix, type Slab } from '../../kit/slabs.ts';
import { PartBuckets, hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { LOOK, type ToneEnv } from '../../kit/mannequin/hatch.ts';
import { pinstripeTube } from '../../kit/mannequin/suit.ts';
import { Tube, silhouettes, type ClothStroke } from '../../kit/mannequin/tube.ts';
import { ART, ASSEMBLY, BAR_ID, H, MM_X, MM_Y, PAGE, PAPER, THREAD, TRIM, W, bustFrame, fewerRings, holeBarPaths, lintelBar, pensOf } from '../world.ts';
import { cCuts, inGrown } from '../lodestone-cuts.ts';
import { FILL_OVER, LODESTONE_ASSEMBLY, LODESTONE_CONTROLS, barFootprint, cosmos, emphasisOn, frameBand, frameRings, reachTarget, gapOf, withSeamLines, clipTrim, crossingY, fieldLines, filings, handFromBottom, lineToNorth, magnet, ribbonLines, slabHand, squareFist, wordAlong } from '../lodestone-world.ts';
import { headCoil } from '../../kit/agent.ts';

/**
 * Lodestone, panel C: the magnet. L's censor bar, cut from the bust's face, is glued here level on a full gold-yellow
 * sheet, at the height of the hole it left. It is a magnet: black field lines loop from pole to pole on the gold, iron
 * filings packed at the poles and thinning out; a hand in a pinstriped cuff comes in from the top. With `handPull` it
 * grips and draws a bundle of lines up into its fist, a small south pole superposed on the bar's field; in R1 it had
 * just let the bar go. With `ribbonField` the field line that L's ribbon becomes runs on here into the north pole.
 * Two sheets, bottom to top: black and gold (R7, `window`): the bar is a window cut in the gold where it lies, showing
 * the black, the bar's hatch drawn on the black in silver; the gold is also cut by the cut set (`cutScheme`), the field
 * drawn on in silver where the black shows. Or (R1 to R6, `onlay`, the sketch `lodestone-c-onlay`) a third: L's cut-out
 * bar glued on top. An assembly's sheets are fixed per sketch, so the onlay is its own sketch.
 */

export type BarMode = 'window' | 'onlay';
const pliesFor = (mode: BarMode) => [
  { id: 'black', paper: PAPER.black, pens: mode === 'onlay' ? ['silver'] : ['silver', 'gold'], cutInk: 'silver' },
  { id: 'gold', paper: PAPER.gold, pens: ['black'], cutInk: 'black' },
  ...(mode === 'onlay' ? [{ id: 'bar', paper: PAPER.black, pens: [], cutInk: 'black', onlay: { from: `lodestone-l/black/${BAR_ID}` } }] : []),
];
/** R1 to R6's onlay keeps Lintel's 2 mm bleed; the window (R7) Lodestone's 4 mm. */
const specFor = (mode: BarMode): AssemblySpec => ({ ...(mode === 'onlay' ? ASSEMBLY : LODESTONE_ASSEMBLY), plies: pliesFor(mode) });
const pens = pensOf(['silver', 'gold', 'black']);

const ALL_BLACK = { carbon: 'black', ultramarine: 'black', violet: 'black', vermilion: 'black', acid: 'black' };
const ROUTES = { gold: { groups: ['field', 'filing', 'hand', 'word'], inks: ALL_BLACK } };
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
const GROUPS = ['field', 'filing', 'hand', 'word'] as const;

/** The hand's camera: page millimetres per world unit at the hand's depth, and its distance. */
const MM_PER_UNIT = 10, DIST = 150;
/** The fist's facet hatch pitch (`facetStrokes`' scale): its darkest faces about 1.2 mm apart on the sheet, its lit ones about 6. */
const HAND_PITCH = 1.6;
/**
 * "falls" and "into", each along a closed loop under the bar: which loop (counted outward from the bar) and the page x
 * where the word starts on it, left of centre for "falls", right for "into", so they stagger.
 */
const WORDS: { word: string; loop: number; x: number }[] = [{ word: 'falls', loop: 2, x: 66 }, { word: 'into', loop: 4, x: 176 }];

type Tagged = Stroke & { slack: number; face?: string };

const drawFor = (mode: BarMode, spec: AssemblySpec) => function draw(ctx: SketchContext): Part[] {
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
  // From the bottom (`handFrom`, default): the arm rises from the bottom edge, fingers up, the fist under the bar.
  const fromBottom = pulling && handFromBottom(ctx);
  // With the bar slipping (`barPose`), the fist reaches up toward the bar's middle (or, R5, its right end; `reachFor`),
  // leaning halfway from upright toward it, and closes just short of it.
  const toEnd = (() => { const e = reachTarget(m, ctx), g = m.poles[0] ?? e, l = Math.hypot(e.x - g.x, e.y - g.y) || 1; return new THREE.Vector3((e.x - g.x) / l, -(e.y - g.y) / l, 0); })();
  const along = !pulling ? new THREE.Vector3(-0.32, -1, 0.18).normalize()
    : fromBottom ? (m.pose ? toEnd.clone().add(new THREE.Vector3(0, 1, 0)).normalize().setZ(0.22).normalize() : new THREE.Vector3(0.12, 1, 0.22).normalize())
    : new THREE.Vector3(-0.12, -1, 0.22).normalize();
  const across = fromBottom ? new THREE.Vector3(0.5, 0.12, -1).normalize() : new THREE.Vector3(0.5, -0.12, 1).normalize();
  const size = pulling ? 5.4 : 4.4;
  const squared = pulling && ctx.params.fist === 'clean';
  const build = (wrist: THREE.Vector3) => squared ? squareFist({ wrist, along, across, size }) : slabHand({ wrist, along, across, size, curl: pulling ? 1.2 : 0.34, spread: pulling ? 0.02 : 0.1 });
  const grip = m.poles[0];
  let wrist = world({ x: pulling ? grip.x : handX, y: 48 });
  for (let it = 0; it < 6; it++) {
    const slabs = build(wrist);
    if (pulling) {
      // The fist's inside (the middle of its folded fingers, slabs 1 to 12) on the pole: the lines end within the fist.
      const fingers = slabs.slice(1, 13).map(sl => pageOf(view, new THREE.Vector3(sl.x, sl.y, sl.z), PAGE));
      const c = { x: fingers.reduce((t, p) => t + p.x, 0) / fingers.length, y: fingers.reduce((t, p) => t + p.y, 0) / fingers.length };
      wrist = wrist.clone().add(new THREE.Vector3((grip.x - c.x) / MM_PER_UNIT, -(grip.y - c.y) / MM_PER_UNIT, 0));
    } else {
      const low = Math.max(...slabs.flatMap(sl => corners(sl)).map(p => pageOf(view, p, PAGE).y));
      wrist = wrist.clone().add(new THREE.Vector3(0, -(m.rect.y0 - 5 - low) / MM_PER_UNIT, 0));
    }
  }
  const hand = build(wrist);
  // The sleeve and the shirt cuff, out of the top (or the bottom) of the sheet.
  const up = along.clone().negate();
  const shirt = new Tube('shirt', [wrist.clone().addScaledVector(up, 1.9), wrist.clone().addScaledVector(up, -0.2)], [[0, 1.6, 1.4], [1, 1.55, 1.35]], across, 1, [0, 0], undefined, 6);
  // From the bottom the sleeve runs from the cuff down past the bottom trim, however long `sleeveLength` makes it.
  const reach = fromBottom ? (TRIM.y1 + 24 - pageOf(view, wrist, PAGE).y) / (MM_PER_UNIT * Math.max(0.5, Math.abs(up.y))) : 18;
  const sleeve = new Tube('sleeve', [wrist.clone().addScaledVector(up, 1.4), wrist.clone().addScaledVector(up, 8), wrist.clone().addScaledVector(up, reach)],
    [[0, 2.2, 1.95], [1, 2.3, 2.05]], across, 1, [0, 0], undefined, 6);
  const env: ToneEnv = { density: 0.3, dark: () => 0.5, screen: p => pageOf(view, p, PAGE) };
  const strokes: Tagged[] = [];
  const cloth = (list: ClothStroke[]) => { for (const st of list) strokes.push({ ink: st.ink, group: 'hand', family: st.family ?? 'hatch', points: st.points, slack: 0.05 }); };
  cloth(pinstripeTube(sleeve, env, { seams: [], hems: [0.02] }, LOOK));
  for (const t of [sleeve, shirt]) cloth(silhouettes(t, { forward, eye }, { ink: 'carbon', group: 'hand' }));
  // The hand's planes: outlines, and one ring on the faces turned from the light, no more.
  const light = new THREE.Vector3(-0.5, 0.8, 0.4).normalize();
  // (`handTexture` hatch, R10) The faces in the raking-light hatch, as the triptych's slabs are: up to two contour rings
  // and a diagonal field, crossed on the darkest faces, about 1.2 mm apart there and wider as a face turns to the light,
  // so the fist reads as a solid among the field's curves. Else (R2 to R9) outlines and one ring.
  const textured = ctx.params.handTexture !== 'outline';
  // (A face seen at a slant, under 0.35 of square on, keeps its rings but not its field: a sliver of hatch would float.)
  const NORMALS = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  const facing = (sl: Slab, k: number) => {
    const n = new THREE.Vector3(...NORMALS[k]).applyMatrix4(new THREE.Matrix4().extractRotation(slabMatrix(sl)));
    return n.dot(eye.clone().sub(new THREE.Vector3(sl.x, sl.y, sl.z)).normalize());
  };
  hand.forEach((sl, i) => {
    for (const st of fewerRings(facetStrokes(sl, light, eye, false, textured ? HAND_PITCH : 7 / MM_PER_UNIT), textured ? 2 : 1)) {
      const ring = st.family === 'edge' || st.points.length === 5;
      if (textured ? ring || st.face === undefined || facing(sl, st.face) >= 0.35 : ring) strokes.push({ ink: 'carbon', group: 'hand', family: st.family, points: st.points, slack: 0.04, ...(ring || st.face === undefined ? {} : { face: `${i}:${st.face}` }) });
    }
  });
  const geos = [...hand.map(slabGeometry), sleeve.mesh(64, 36), shirt.mesh(16, 36)];
  fitDepthRange(view, geos, 0.1, { exact: true });
  const depth = renderDepthBufferCPU(geos, view, W, H);
  const handArea = meshCoverage(geos, view, PAGE, 1.4);
  // The lines the fist grips run into it: they end on its outline, not short of it (`handCore`); the rest pass behind.
  const handCore = textured ? meshCoverage(geos, view, PAGE, 0.3) : handArea;
  // A face whose field shows less than 0.4 of itself (the rest hidden behind other slabs) keeps its rings only: a patch of
  // hatch with no edge round it would float.
  const seen = new Map<string, { shown: number; whole: number }>();
  const length = (pts: Point[]) => pts.slice(1).reduce((t, q, k) => t + Math.hypot(q.x - pts[k].x, q.y - pts[k].y), 0);
  projectStrokes(strokes.filter(st => st.face), { view, depth, width: W, height: H, bias: hiddenBias(view, 0.04, DIST) }, {
    begin: (st: Tagged) => (runs: ProjectedPoint[][]) => {
      const f = seen.get(st.face!) ?? { shown: 0, whole: 0 };
      f.whole += length(st.points.map(q => pageOf(view, q, PAGE)));
      for (const run of runs) f.shown += length(scalePoints(run, MM_X, MM_Y));
      seen.set(st.face!, f);
    },
  });
  const shows = (st: Tagged) => { const f = st.face ? seen.get(st.face) : undefined; return !f || f.shown >= 0.4 * f.whole; };
  projectStrokes(strokes.filter(shows), { view, depth, width: W, height: H, bias: hiddenBias(view, 0.04, DIST) }, {
    begin: (st: Tagged) => (runs: ProjectedPoint[][]) => {
      for (const run of runs) for (const inside of clipToRect(scalePoints(run, MM_X, MM_Y), ART)) buckets.add(`hand-${st.ink}`, inside, false);
    },
  });
  for (const g of geos) g.dispose();

  // The cut set's windows in the gold (`cutScheme`), and the bar's: here, so the field can give way round their frames
  // (`emphasis`, R9: the bar's window framed three times, the sleeve's twice, in black on the gold kept round them).
  const sleevePts: Point[] = [];
  for (let i = 0; i <= 24; i++) for (let j = 0; j < 12; j++) sleevePts.push(pageOf(view, sleeve.point(i / 24, j / 12), PAGE));
  const windows = cCuts(ctx, { rect: m.rect, grip: m.poles[0] ?? { x: handX, y: m.rect.y0 - 40 }, sleeve: sleevePts });
  const barRing = barFootprint(bar, ctx).rings[0], grow = spec.bleed + FILL_OVER;
  const frames = emphasisOn(ctx) && mode === 'window' ? [{ ring: barRing, lines: 3 }, ...windows.filter(w => w.id === 'sleeve').map(w => ({ ring: w.rings[0], lines: 2 }))] : [];
  const bands = frames.map(f => frameBand(f.ring, f.lines));
  const framed = (p: Point) => bands.some(b => b(p));
  // (A filing is tested at its middle: it keeps half its length further off.)
  const farBands = frames.map(f => frameBand(f.ring, f.lines, 1.2));
  const framedFar = (p: Point) => farBands.some(b => b(p));

  // The field, and the words along two of its lines ("falls into"), which the filings give way to.
  // With the panels hung apart, the lines that carry the field across the gap into R are among them (`withSeamLines`).
  const lines = withSeamLines(m, fieldLines(m, Math.round(n(ctx, 'fieldLines', 26, 8, 48))));
  // The closed loops under the bar, innermost first.
  const loops = lines.filter(l => Math.max(...l.map(p => p.y)) > m.rect.y1 + 10 && l.every(p => p.y > TRIM.y0 && p.y < TRIM.y1 && p.x > TRIM.x0 && p.x < TRIM.x1))
    .sort((a, b) => Math.max(...a.map(p => p.y)) - Math.max(...b.map(p => p.y)));
  const words: Point[][] = [];
  // Each word on its loop at its place, or (where the hand is in the way) the nearest loop and place that keep it whole,
  // clear of the hand and inside the trim. R1's words land on the first try.
  const place = (w: typeof WORDS[number], loop: number, x: number): Point[][] | undefined => {
    const line = loops[Math.min(loop, loops.length - 1)];
    if (!line) return undefined;
    let s = 0, from = -1;
    for (let i = 1; i < line.length; i++) { s += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y); if (line[i].x >= x && line[i].y > m.rect.y1) { from = s; break; } }
    if (from < 0) return undefined;
    return wordAlong(w.word, line, from, 2.6, -2.2);
  };
  for (const w of WORDS) {
    const first = place(w, w.loop, w.x);
    const ok = (paths: Point[][] | undefined) => !!paths?.length && paths.flat().every(p => !handArea(p) && !framed(p) && p.x > TRIM.x0 + 3 && p.x < TRIM.x1 - 3 && p.y < TRIM.y1 - 3);
    let chosen = ok(first) ? first : undefined;
    search: for (let dl = 0; !chosen && dl <= 4; dl++) for (const loop of [w.loop - dl, w.loop + dl]) for (let dx = 0; dx <= 120; dx += 10) for (const x of [w.x - dx, w.x + dx]) {
      if (loop < 0) continue;
      const tried = place(w, loop, x);
      if (ok(tried)) { chosen = tried; break search; }
    }
    words.push(...(chosen ?? []));
  }
  for (const path of clipTrim(words)) for (const piece of keepAlong(path, p => !handArea(p), 0.1)) buckets.add('word-carbon', piece, true);
  const clear = glyphMask(words, 0.8, 6, PAGE);
  // The field gives way to the frames on the gold; under it, on the black, it runs on through the frames' band, so a
  // window's edge never crops it (`underBand`).
  const underBand: Point[][] = [];
  const field = (line: Point[]) => {
    const gripped = !!grip && [line[0], line[line.length - 1]].some(q => Math.hypot(q.x - grip.x, q.y - grip.y) < 6);
    const behind = gripped ? handCore : handArea;
    for (const piece of keepAlong(line, p => !behind(p) && !clear(p) && !framed(p), 0.2)) buckets.add('field-carbon', piece, true);
    if (frames.length) underBand.push(...keepAlong(line, p => !behind(p) && !clear(p) && framed(p), 0.2));
  };
  for (const line of clipTrim(lines)) field(line);
  for (const dash of filings(ctx, m, Math.round(1000 * n(ctx, 'filings', 9, 0, 30)), p => handArea(p) || clear(p) || framedFar(p))) buckets.add('filing-carbon', dash, true);
  // L's ribbon, pulled along the field, leaves L's right edge on a field line: here that line goes on into the north pole.
  // With `ribbonBleed` it has come apart into several lines in L: each runs on here from the height it left L.
  if (ctx.params.ribbonField !== false) {
    const crown = pageOf(frame.view, headCoil(frame.fig.head).at(-1)!, PAGE);
    const paths = ribbonLines(ctx, crown, m, bar, { width: THREAD.widthMm, pitch: THREAD.pitchMm });
    for (const path of paths) {
      const y = crossingY(path, TRIM.x1);
      // L hangs the gap to the left: the line leaves L's edge there and runs on across the gap into C.
      if (y !== undefined) for (const line of clipTrim([lineToNorth(m, { x: TRIM.x0 - gapOf(m), y })])) field(line);
    }
  }

  // The black beneath the windows: every mark of the gold is drawn on the black too, in silver, and each sheet keeps
  // what it shows, so the field reads on through the windows.
  const art = routeParts(buckets.toParts(GROUPS, INKS), ROUTES);
  if (mode === 'onlay') {
    art.black = windows.length ? art.gold.map(part => ({ ...part, id: `under-${part.id}`, pen: 'silver' })) : [];
    return renderPly(spec, ctx, pens, { cuts: { gold: windows, bar: [barFootprint(bar, ctx)] }, art });
  }
  // The bar as a window in the gold where it lies (L's bar placed by `barPose`, a waste cut), the black beneath carrying
  // (`cBarFill`) the cosmos (R10: stars in silver, its galaxies suggested; R9's drawn out, `cosmos-explicit`; one star
  // gold) or the bar's hatch in silver (R7, R8, as
  // L's gold carries it in black ink), out under the window's edge by the bleed; the gold's marks run on in silver on the
  // black, but not into the bar, where the lines and filings stop at its edge.
  // (The gold's marks stop short of the bar on the black by the bleed, so a window a little off never shows them.)
  const inBar = inGrown(barRing, grow);
  const pose = m.pose ?? { cx: (m.rect.x0 + m.rect.x1) / 2, cy: (m.rect.y0 + m.rect.y1) / 2, angle: 0 };
  const sky = ctx.params.cBarFill === 'hatch' ? undefined : cosmos(ctx.random('lodestone-cosmos'), { cx: pose.cx, cy: pose.cy, angle: pose.angle, l: bar.l, h: bar.h }, { grow, galaxies: 2, explicit: ctx.params.cBarFill === 'cosmos-explicit' });
  art.black = [
    ...art.gold.map(part => ({ ...part, id: `under-${part.id}`, pen: 'silver', paths: part.paths.flatMap(path => keepAlong(path, q => !inBar(q), 0.2)) })).filter(part => part.paths.length),
    ...(underBand.length ? [{ id: 'under-field-band', pen: 'silver', paths: underBand.flatMap(path => keepAlong(path, q => !inBar(q), 0.2)) }] : []),
    ...(sky
      ? [{ id: 'cosmos-silver', pen: 'silver', paths: [...sky.silver, ...sky.cores] }, { id: 'cosmos-gold', pen: 'gold', paths: sky.accent }]
      : [{ id: 'bar-silver', pen: 'silver', paths: holeBarPaths({ ...bar, centre: { x: pose.cx, y: pose.cy }, tilt: pose.angle }, grow, n(ctx, 'barPitch', 2.6, 0.6, 5)) }]),
  ];
  // The frames give way where the hand passes over them.
  if (frames.length) art.gold.push({ id: 'emphasis-black', pen: 'black', paths: frames.flatMap(f => frameRings(f.ring, f.lines)).flatMap(r => clipToRect(r, ART)).flatMap(r => keepAlong(r, q => !handArea(q), 0.1)) });
  return renderPly(spec, ctx, pens, { cuts: { gold: [{ id: BAR_ID, label: 'BAR', rings: [barRing] }, ...windows] }, art });
};

/** A slab's eight corners in the world. */
function corners(sl: Slab): THREE.Vector3[] {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(sl.x, sl.y, sl.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(sl.rx, sl.ry, sl.rz, 'XYZ')), new THREE.Vector3(1, 1, 1));
  return [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => new THREE.Vector3(x * sl.w / 2, y * sl.h / 2, z * sl.d / 2).applyMatrix4(m))));
}

/** C as a sketch: the bar a window in the gold (`window`, R7), or L's bar glued on as an onlay (`onlay`, R1 to R6). */
export function lodestoneC(mode: BarMode): Sketch {
  const spec = specFor(mode);
  return {
    name: mode === 'onlay' ? 'Breach triptych: Lodestone C (the magnet, the bar glued on)' : 'Breach triptych: Lodestone C (the magnet)',
    page: { ...PAGE },
    pageAware: true,
    pens,
    // With the onlay the top ply is never rendered: the control starts on the gold sheet either way.
    controls: [{ type: 'select', id: spec.control, label: 'Ply', default: 'gold', options: spec.plies.map(p => p.id) }, ...LODESTONE_CONTROLS],
    assembly: spec,
    draw: drawFor(mode, spec),
  };
}

export default lodestoneC('window');
