import * as THREE from 'three';
import type { AssemblySpec, Cut, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { routeParts } from '../../kit/assembly.ts';
import { MIN_FEATURE } from '../../kit/format.ts';
import { glyphMask, groundWord } from '../../kit/lettering.ts';
import { clipToRect, keepAlong, meshCoverage } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { facetStrokes, slabGeometry, slabMatrix, solid, type FacetStroke, type Slab } from '../../kit/slabs.ts';
import { PartBuckets, hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import {
  ART, ASSEMBLY, CONTROLS, H, MM_X, MM_Y, PAGE, PAPER, THREAD, TRIM, W, bustFrame, eyeHeight, faceWordAt, farLines, fewerRings, flatRibbon, knotOf, lintelBar, paving, pensOf,
  plainStrokes, ringOf, skyLines, slotRect, sun, threadOn, threadPaths,
} from '../world.ts';

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

/**
 * Each sheet in its own inks. White: carbon and ultramarine (the raking hatch's crossed violet field and the thread's
 * edges go to carbon, its spine to ultramarine). Gold: black. Black: silver, and gold for the thread's edges and spine,
 * as on L. The thread is drawn on all three and each sheet keeps the part of it that it shows.
 */
const ROUTES = {
  black: { groups: ['echo', 'threadblack'], inks: { ultramarine: 'silver', violet: 'silver', vermilion: 'gold', acid: 'gold' } },
  gold: { groups: ['gaze', 'threadgold'], inks: { carbon: 'black', ultramarine: 'black', violet: 'black', vermilion: 'black', acid: 'black' } },
  white: { groups: ['plain', 'far', 'word', 'thread'], inks: { carbon: 'carbon', ultramarine: 'ultramarine', violet: 'carbon', vermilion: 'carbon', acid: 'ultramarine' } },
};
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
const GROUPS = ['plain', 'far', 'word', 'thread', 'gaze', 'threadgold', 'echo', 'threadblack'] as const;


/** Eye height above the plain, and the paving pitch and joint, world units. */
const EYE = 4, PITCH = 1.5, JOINT = 0.09;
/**
 * The word "can": where its centre lands on the sheet, and its cap height there across the sheet (mm). Painted flat on
 * the ground it is foreshortened to about half that in height, so its lowercase stands about 1.7 mm tall on the paper.
 */
const CAN = { at: { x: 0.66, y: 0.79 }, capMm: 6 };

type Tagged = Stroke & { slack: number };

/**
 * What a ground gives the panel: its strokes (each tagged with an owner for its hidden-line test), its solids, its long
 * lines (tested one by one), marks drawn flat on the sheet (`flat`), and the solids "can" may be painted on.
 */
interface Ground { strokes: Tagged[]; solids: Slab[]; lines: Tagged[]; flat: { group: string; ink: Ink; points: Point[] }[]; canOn: Slab[] }
type GroundKind = 'paving' | 'corridor' | 'field' | 'water';
const GROUND_KINDS: GroundKind[] = ['paving', 'corridor', 'field', 'water'];
/** The faces "can" may be painted on: their outward normal and the text's up, in a solid's own frame. */
const CAN_FACES: [THREE.Vector3, THREE.Vector3][] = [
  [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)], [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)], [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)],
  [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)], [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)],
];

/** A rectangle as a ring, for a cut. */
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => ringOf({ x0, y0, x1, y1 });

function draw(ctx: SketchContext): Part[] {
  const frame = bustFrame(ctx);
  const bar = lintelBar(ctx, frame);
  const horizonY = eyeHeight(bar);
  const slot = slotRect(ctx, bar);

  const fov = n(ctx, 'plainFov', 50, 30, 80);
  const view = horizonCamera({ fov, eye: [0, EYE, 0], target: [0, EYE, -100], far: 1e4, page: PAGE, depth: { width: W, height: H }, horizonY });
  const eye = view.position.clone();
  const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const halfWidth = Math.atan(Math.tan(THREE.MathUtils.degToRad(fov / 2)) * W / H);
  const mmPerUnit = (p: THREE.Vector3) => f / -p.clone().applyMatrix4(view.matrixWorldInverse).z;
  const near = EYE * f / (ART.y1 - horizonY) * 0.9;

  const light = sun(ctx);
  const toTagged = (list: FacetStroke[], group: string, slack: number, owner: number): Tagged[] => list.map(st => ({ ink: st.ink, group, family: st.family, points: st.points, slack, owner }));
  /** The paving's courses (level lines across the ground) from `from` on to the horizon, thinning as they close up. */
  const courses = (from: number, minMm: number): Tagged[] => farLines({ pitch: PITCH, from, eyeH: EYE, f, halfWidth, minMm }).courses
    .map(points => ({ ink: 'ultramarine' as Ink, group: 'far', family: 'edge' as const, points, slack: 0.05 }));
  /** A slab standing on the ground: its lowest corner on y = 0. */
  const grounded = (sl: Slab): Slab => {
    const m = slabMatrix(sl);
    let low = Infinity;
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) low = Math.min(low, new THREE.Vector3(x * sl.w / 2, y * sl.h / 2, z * sl.d / 2).applyMatrix4(m).y);
    sl.y -= low;
    return sl;
  };

  // paving (R1): a paved plain in raking light, on to the horizon.
  const pavingGround = (): Ground => {
    const far = Math.sqrt(EYE * f * PITCH / 0.8);
    const laid = plainStrokes(ctx, paving(ctx, { pitch: PITCH, joint: JOINT, near, far, halfWidth, salt: 'plain-paving' }),
      { near, far, eyeH: EYE, light, eye, mmPerUnit, pitchMm: n(ctx, 'plainMm', 13, 3, 16), salt: 'plain-tone', rings: Math.round(n(ctx, 'rings', 3, 0, 30)) });
    const strokes = laid.flatMap(({ slab, strokes: list }, i) => toTagged(list, 'plain', 0.004 * -slab.z, i));
    const lines: Tagged[] = [];
    if (ctx.params.joints !== false) {
      const { courses: across, joints } = farLines({ pitch: PITCH, from: far * 0.6, eyeH: EYE, f, halfWidth, minMm: 1.4 });
      for (const points of across) lines.push({ ink: 'ultramarine', group: 'far', family: 'edge', points, slack: 0.05 });
      for (const points of joints) lines.push({ ink: 'carbon', group: 'far', family: 'edge', points, slack: 0.05 });
    }
    const slabs = laid.map(p => p.slab);
    return { strokes, solids: slabs, lines, flat: [], canOn: slabs };
  };

  // corridor: a processional way of low stelae in two rows, converging on the gold band; the gaze travels down it.
  const corridorGround = (): Ground => {
    const rng = ctx.random('plain-corridor');
    const solids: Slab[] = [];
    const X = 3.4, STEP = 3.4;
    for (let z = 8, i = 0; 2.9 * f / z > 1.2; z += STEP, i++) for (const side of [-1, 1]) {
      const h = 2.9 + (rng() - 0.5) * 0.15;
      const sl = solid(side * X, h / 2, -z, 0.45, h, 1.7, i, 'stack');
      sl.ry = (rng() - 0.5) * 0.03;
      sl.tone = 0.9;
      solids.push(sl);
    }
    const strokes = solids.flatMap((sl, i) => toTagged(facetStrokes(sl, light, eye, sl.h * mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z)) < 6, n(ctx, 'plainMm', 13, 3, 16) / mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z))), 'plain', 0.004 * -sl.z, i));
    const lines = courses(near, 1.6);
    // The way's floor: joints converging on the vanishing point between the rows.
    for (let k = -2; k <= 2; k++) lines.push({ ink: 'carbon', group: 'far', family: 'edge', points: [new THREE.Vector3(k * 1.3, 0.01, -near), new THREE.Vector3(k * 1.3, 0.01, -EYE * f / 0.4)], slack: 0.05 });
    return { strokes, solids, lines, flat: [], canOn: solids };
  };

  // field: a field of standing slabs in the censor bar's proportions, leaning at its tilt, receding to the horizon:
  // some broadside to the gaze, some aligned toward the slot, some toppled flat. The prior restraint, multiplied.
  const fieldGround = (): Ground => {
    const rng = ctx.random('plain-field');
    const L = 5.2, Hb = L * 0.36 / 1.75, T = 0.32;
    const solids: Slab[] = [];
    const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const count = Math.round(n(ctx, 'fieldCount', 70, 10, 120));
    for (let attempt = 0; attempt < 4000 && solids.length < count; attempt++) {
      // Even over the sheet: a page height and across, then the ground point under it.
      const py = horizonY + 4 + (ART.y1 - horizonY - 4) * rng() ** 2.4, px = ART.x0 + (ART.x1 - ART.x0) * rng();
      const z = EYE * f / (py - horizonY), x = (px - PAGE.width / 2) * z / f;
      const kind = rng();
      const sl = solid(x, 0, -z, L, Hb, T, solids.length, 'stack');
      if (kind < 0.2) { sl.rx = Math.PI / 2; sl.ry = (rng() - 0.5) * 1.2; }
      // Aligned toward the slot only far off, so the near field lies across the gaze, not along it.
      else if (kind < 0.35) { if (py > horizonY + 90) continue; sl.ry = Math.PI / 2 + (rng() - 0.5) * 0.06; }
      else { sl.rz = bar.tilt * (0.8 + 0.4 * rng()) * (kind < 0.5 ? -1 : 1); sl.ry = kind < 0.6 ? (rng() - 0.5) * 0.08 : (rng() - 0.5) * 1.1; }
      grounded(sl);
      sl.tone = 0.85;
      // No tangencies: each keeps clear of the others on the sheet, or lies well behind one it overlaps.
      const c = [-1, 1].flatMap(a => [-1, 1].flatMap(b => [-1, 1].map(d => pageOf(view, new THREE.Vector3(a * sl.w / 2, b * sl.h / 2, d * sl.d / 2).applyMatrix4(slabMatrix(sl)), PAGE))));
      const box = { x0: Math.min(...c.map(p => p.x)), x1: Math.max(...c.map(p => p.x)), y0: Math.min(...c.map(p => p.y)), y1: Math.max(...c.map(p => p.y)) };
      // Whole slabs only (none cropped by the trim), clear of the band, and each clear of the others.
      if (box.x0 < ART.x0 + 3 || box.x1 > ART.x1 - 3 || box.y1 > ART.y1 - 3 || box.y0 < slot.y1 + 1.5) continue;
      if (boxes.some(o => box.x0 < o.x1 + 3 && box.x1 > o.x0 - 3 && box.y0 < o.y1 + 3 && box.y1 > o.y0 - 3)) continue;
      boxes.push(box);
      solids.push(sl);
    }
    const strokes = solids.flatMap((sl, i) => {
      const at = new THREE.Vector3(sl.x, sl.y, sl.z), unit = mmPerUnit(at);
      return toTagged(fewerRings(facetStrokes(sl, light, eye, sl.w * unit < 5, n(ctx, 'plainMm', 13, 3, 16) / unit), Math.round(n(ctx, 'rings', 3, 0, 30))), 'plain', 0.004 * -sl.z, i);
    });
    return { strokes, solids, lines: courses(near, 1.6), flat: [], canOn: solids };
  };

  // water: still water to the horizon, its level ripples bare in the glare under the gold band and closing up toward us
  // (the black sky overhead), with a few low monoliths standing in it, each reflected as ruled water.
  const waterGround = (): Ground => {
    const rng = ctx.random('plain-water');
    const PLACES: [number, number, number, number][] = [[0.24, 24, 1.4, 3.3], [0.7, 48, 1.1, 3.0], [0.47, 130, 1.6, 3.4], [0.83, 17, 0.9, 2.6]];
    const solids = PLACES.map(([px, z, w, h], i) => {
      const sl = solid((px * PAGE.width - PAGE.width / 2) * z / f, h / 2, -z, w, h, w * 0.8, i, 'stack');
      sl.ry = (rng() - 0.5) * 0.5;
      sl.tone = 1;
      return sl;
    });
    const strokes = solids.flatMap((sl, i) => toTagged(facetStrokes(sl, light, eye, false, n(ctx, 'plainMm', 13, 3, 16) / mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z))), 'plain', 0.004 * -sl.z, i));
    const geos = solids.map(slabGeometry);
    const mirrored = solids.map(sl => { const g = slabGeometry(sl); g.applyMatrix4(new THREE.Matrix4().makeScale(1, -1, 1)); return g; });
    const standing = meshCoverage(geos, view, PAGE, 1.2), reflected = meshCoverage(mirrored, view, PAGE, 0);
    for (const g of [...geos, ...mirrored]) g.dispose();
    const flat: Ground['flat'] = [];
    const glare = 7;
    for (let y = slot.y1 + glare; y < ART.y1;) {
      const t = (y - slot.y1) / (ART.y1 - slot.y1);
      const cover = 0.1 + 0.62 * t ** 0.8, dash = 3 + 40 * t;
      for (let x = ART.x0 + dash * rng(); x < ART.x1;) {
        const len = dash * (0.4 + rng()), gap = len * (1 - cover) / cover * (0.5 + rng());
        for (const piece of keepAlong([{ x, y }, { x: Math.min(ART.x1, x + len), y }], p => !standing(p) && !reflected(p), 0.2)) flat.push({ group: 'far', ink: t > 0.5 && rng() < 0.4 ? 'carbon' : 'ultramarine', points: piece });
        x += len + gap;
      }
      y += Math.min(8, 1 + 0.06 * (y - horizonY));
    }
    // Inside a reflection the water is ruled close and level, a millimetre apart, broken a little.
    for (let y = slot.y1 + 1; y < ART.y1; y += 1) {
      for (let x = ART.x0; x < ART.x1; x += 0.25) {
        if (!reflected({ x, y }) || standing({ x, y })) continue;
        let x1 = x;
        while (x1 < ART.x1 && reflected({ x: x1, y }) && !standing({ x: x1, y })) x1 += 0.25;
        for (let a = x + 1.5 * rng(); a < x1;) { const len = 6 + 18 * rng(); flat.push({ group: 'far', ink: 'ultramarine', points: [{ x: a, y }, { x: Math.min(x1, a + len), y }] }); a += len + 1 + 2 * rng(); }
        x = x1;
      }
    }
    return { strokes, solids, lines: [], flat, canOn: solids };
  };

  const kind: GroundKind = GROUND_KINDS.includes(ctx.params.ground as GroundKind) ? ctx.params.ground as GroundKind : 'corridor';
  const ground = { paving: pavingGround, corridor: corridorGround, field: fieldGround, water: waterGround }[kind]();

  // The thread (knot `thread` or `all`): in at the left edge at THREAD.h1, stitching through the horizon band (over the
  // band, then under it, by turns) and out at the right edge at h2. It lies in front of everything; all else gives way.
  let threadArea: (p: Point) => boolean = () => false;
  const thread: { ink: Ink; points: Point[] }[] = [];
  if (threadOn(knotOf(ctx))) {
    const { c } = threadPaths(frame, bar);
    // Where the centreline is in the band, and which crossing of it that is: every second one passes under the band.
    const inBand = (p: Point) => Math.abs(p.y - horizonY) < (slot.y1 - slot.y0) / 2 + 2.5;
    const under: [number, number][] = [];
    let s = 0, start = -1, crossing = 0;
    for (let i = 0; i < c.path.length; i++) {
      if (i) s += Math.hypot(c.path[i].x - c.path[i - 1].x, c.path[i].y - c.path[i - 1].y);
      if (inBand(c.path[i]) && start < 0) start = s;
      if (!inBand(c.path[i]) && start >= 0) { if (crossing++ % 2 === 1) under.push([start, s]); start = -1; }
    }
    const ribbon = flatRibbon(c.path, { width: THREAD.widthMm, pitch: THREAD.pitchMm, phase0: c.phase0, skip: v => under.some(([a, b]) => v > a && v < b) });
    thread.push(...ribbon.strokes);
    threadArea = glyphMask(ribbon.mask, 0.8, 6, PAGE);
  }

  // "can": in the corridor, painted on the way's floor like a road marking; elsewhere on whichever face of a solid lies
  // at its place on the sheet, or the nearest such place round it.
  const target = { x: CAN.at.x * PAGE.width, y: CAN.at.y * PAGE.height };
  let painted: THREE.Vector3[][] = [];
  if (kind === 'corridor') painted = groundWord(view, 'can', { x: PAGE.width / 2 + 9, y: target.y }, { face: 'sans', height: 3.2 });
  else search: for (let ring = 0; ring <= 20; ring++) {
    const steps = ring === 0 ? 1 : 8 * ring;
    for (let k = 0; k < steps; k++) {
      const at = { x: target.x + 4 * ring * Math.cos(2 * Math.PI * k / steps), y: target.y + 4 * ring * Math.sin(2 * Math.PI * k / steps) };
      for (const sl of ground.canOn) for (const [normal, up] of CAN_FACES) {
        const made = faceWordAt(sl, 'can', view, at, { normal, up, capMm: normal.y ? CAN.capMm : CAN.capMm / 2 });
        if (made && !threadArea(pageOf(view, made[0][0], PAGE))) { painted = made; break search; }
      }
    }
  }
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
          for (const piece of keepAlong(inside, p => !clear(p) && !threadArea(p), 0.15)) buckets.add(`${st.group}-${st.ink}`, piece, false, st.family === 'hatch' && MIN_FEATURE ? MIN_FEATURE : undefined);
        }
      },
    });
  }

  // The ground's flat marks (still water), giving way to the words and the thread.
  for (const m of ground.flat) for (const piece of keepAlong(m.points, p => !clear(p) && !threadArea(p), 0.2)) buckets.add(`${m.group}-${m.ink}`, piece, true);

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
    for (const piece of keepAlong([a, b], p => !threadArea(p), 0.15)) buckets.add('gaze-carbon', piece, true);
  }
  // The thread on every sheet, each in its inks: each sheet keeps the part of it that it shows.
  for (const st of thread) for (const inside of clipToRect(st.points, ART)) for (const group of ['thread', 'threadgold', 'threadblack']) buckets.add(`${group}-${st.ink}`, inside, true);
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
