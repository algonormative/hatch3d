import * as THREE from 'three';
import type { AssemblySpec, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { routeParts } from '../../kit/assembly.ts';
import { HEM, agentFigure, cutTube, headCoil, uNear, type AgentHead } from '../../kit/agent.ts';
import { helixAlong } from '../../kit/helix.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, keepAlong } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, onGround, pageOf } from '../../kit/perspective.ts';
import { insideRing } from '../../kit/page.ts';
import { floorKind, rCuts } from '../lodestone-cuts.ts';
import { facetStrokes, slabGeometry, type Slab } from '../../kit/slabs.ts';
import { PartBuckets, hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { LOOK, toneField, type ToneEnv } from '../../kit/mannequin/hatch.ts';
import type { JointAngles, JointName, Proportions } from '../../kit/mannequin/skeleton.ts';
import { HEMS, pinstripeTube, suitFront } from '../../kit/mannequin/suit.ts';
import { Tube, silhouettes, type ClothStroke } from '../../kit/mannequin/tube.ts';
import { buildSurfaceMesh } from '../../../src/projection.ts';
import { ART, ASSEMBLY, H, MM_X, MM_Y, PAGE, PAPER, TRIM, W, bustFrame, lintelBar, pensOf, smoothPath } from '../world.ts';
import { LODESTONE_CONTROLS, fieldLines, fieldPull, magnet, orientedSlab, rightExits, slabHand, wordAlong } from '../lodestone-world.ts';

/**
 * Lodestone, panel R: the ground. A suited figure with the helix coiled where its head would be kneels on white,
 * three-quarters turned toward the centre panel. The magnet's field lines come in at R's left edge at the heights they
 * left C's right edge; the figure gathers them in its hands and leads them down into a black disc on the floor, a
 * curved cut in the white sheet over a black one, so the alignment doesn't lock everything. One strand is fluorescent
 * pink: the triptych's one shock. Two plies, bottom to top: black, white. With `figureField` the field reaches R too and
 * pulls at the figure toward C: the head leans and unwinds, the torso with it, the strands bow toward C as they fall,
 * while the knees hold their ground. `figure` = `clean` draws a straighter figure with a stacked-ring head instead.
 */

const plies = [
  { id: 'black', paper: PAPER.black, pens: ['silver', 'fluoro-pink'], cutInk: 'silver' },
  { id: 'white', paper: PAPER.white, pens: ['carbon', 'ultramarine', 'fluoro-pink'], cutInk: 'carbon' },
];
/** The signature: carbon, in a box at the foot of the sheet, right of the figure. */
const SIGNATURE = { ply: 'white', pen: 'carbon', box: { x: 222, y: 394, width: 40, height: 12 } };
export const spec: AssemblySpec = { ...ASSEMBLY, plies, signature: SIGNATURE };
const pens = pensOf(['silver', 'fluoro-pink', 'carbon', 'ultramarine']);

/**
 * White: the suit in carbon and ultramarine (its violet accent and vermilion edges to carbon, acid detail to
 * ultramarine), the strands in ultramarine, the pink one (`vermilion` here) in fluoro pink. Black, seen through the
 * disc: the same marks in silver, the pink strand in pink, and the ground rings.
 */
const ROUTES = {
  black: { groups: ['under', 'rings'], inks: { carbon: 'silver', ultramarine: 'silver', violet: 'silver', acid: 'silver', vermilion: 'silver' } },
  white: { groups: ['figure', 'contour', 'helix', 'hand', 'word'], inks: { carbon: 'carbon', ultramarine: 'ultramarine', violet: 'carbon', acid: 'ultramarine', vermilion: 'carbon' } },
};
/** The strands' pens: blue ones ultramarine on white and silver on black; the pink one (`vermilion`) pink on both. */
const STRAND_PEN = { white: { ultramarine: 'ultramarine', vermilion: 'fluoro-pink' }, black: { ultramarine: 'silver', vermilion: 'fluoro-pink' } } as const;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
const GROUPS = ['figure', 'contour', 'helix', 'hand', 'strand', 'word', 'under', 'strandunder', 'rings'] as const;

/** The kneeling pose: the kit's kneel, the arms raised forward to gather at head height, the head bowed to its hands. */
// Each upper arm forward and up, turned in so the bent forearms come across: the two hands meet before the chest.
const KNEEL: Partial<Record<JointName, JointAngles>> = {
  shoulder_l: { flex: 112, abduct: 0, twist: -84 }, elbow_l: { flex: 84 },
  shoulder_r: { flex: 104, abduct: 0, twist: 92 }, elbow_r: { flex: 88 },
  wrist_l: { flex: 0 }, wrist_r: { flex: 0 },
  neck: { flex: 14 }, head: { flex: 8 },
};
const BROAD: Proportions = { shoulderX: 1.22, hipX: 1.1 };
/** World units per canon unit: the suit's stripes land about 1.7 mm apart on the sheet. */
const K = 4;
/** How far the field pulls the crown of the figure toward C (mm; the head half again), and how far it bows the falling strands. */
const PULL_MM = 20, BOW_MM = 16;

/**
 * The clean figure's head: a stack of five flat ring bands round the head's axis, an egg in profile, each a short smooth
 * tube tipped a little off the last, like a coiled spring of flat band.
 */
function ringHead(h: AgentHead): Tube[] {
  const bands: Tube[] = [];
  const N = 5, bh = 0.24 * h.r, gap = 0.1 * h.r;
  for (let i = 0; i < N; i++) {
    const along = (-0.72 + i * (bh + gap) / h.r) * h.r + bh / 2;
    const egg = Math.sqrt(Math.max(0.12, 1 - (along / (1.15 * h.r)) ** 2)) * (along > 0 ? 1 : 0.9 + 0.1 * (1 + along / h.r));
    const R = 0.92 * egg * h.r;
    const a = h.axis.clone().applyAxisAngle(h.side, (i % 2 ? 1 : -1) * 0.07).normalize();
    const c = h.centre.clone().addScaledVector(h.axis, along);
    bands.push(new Tube(`ring${i}`, [c.clone().addScaledVector(a, -bh / 2), c.clone().addScaledVector(a, bh / 2)], [[0, R, R], [1, R, R]], h.face, 1, [0, 0]));
  }
  return bands;
}

type Tagged = Stroke & { slack: number };

/** An egg inside the head's coil, never drawn: it hides the coil's far side. */
function skull(h: AgentHead): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 28, 18);
  g.applyMatrix4(new THREE.Matrix4().makeBasis(h.side, h.axis, h.face).multiply(new THREE.Matrix4().makeScale(0.52 * h.r, 0.66 * h.r, 0.52 * h.r)));
  g.translate(h.centre.x, h.centre.y, h.centre.z);
  return g;
}

/** A cut sleeve or trouser for the depth pass: its surface and a disc closing the end. */
function cutMeshes(t: Tube): THREE.BufferGeometry[] {
  const segs = t.facets >= 3 ? t.facets * 4 : 32;
  return [t.mesh(96, segs), buildSurfaceMesh((u, v) => t.centre(1).lerp(t.point(1, v), u), {}, 2, segs)];
}

/** A convex-or-not polygon clipped to a rectangle (Sutherland–Hodgman). */
function clipPolygon(poly: Point[], r: { x0: number; x1: number; y0: number; y1: number }): Point[] {
  const edges: [(p: Point) => boolean, (a: Point, b: Point) => Point][] = [
    [p => p.x >= r.x0, (a, b) => ({ x: r.x0, y: a.y + (b.y - a.y) * (r.x0 - a.x) / (b.x - a.x) })],
    [p => p.x <= r.x1, (a, b) => ({ x: r.x1, y: a.y + (b.y - a.y) * (r.x1 - a.x) / (b.x - a.x) })],
    [p => p.y >= r.y0, (a, b) => ({ x: a.x + (b.x - a.x) * (r.y0 - a.y) / (b.y - a.y), y: r.y0 })],
    [p => p.y <= r.y1, (a, b) => ({ x: a.x + (b.x - a.x) * (r.y1 - a.y) / (b.y - a.y), y: r.y1 })],
  ];
  let out = poly;
  for (const [inside, cross] of edges) {
    const input = out; out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i + input.length - 1) % input.length], b = input[i];
      if (inside(b)) { if (!inside(a)) out.push(cross(a, b)); out.push(b); } else if (inside(a)) out.push(cross(a, b));
    }
  }
  return out;
}

function draw(ctx: SketchContext): Part[] {
  const bar = lintelBar(ctx, bustFrame(ctx));
  // One field across the triptych: C's magnet (with the gripping hand's pole when it pulls), whose lines leave C's right
  // edge at the heights R's strands come in, and whose field reaches R and pulls at the figure.
  const m = magnet(bar, ctx);
  const exits = rightExits(fieldLines(m, Math.round(n(ctx, 'fieldLines', 26, 8, 48))));
  const clean = ctx.params.figure === 'clean';
  const pulled = ctx.params.figureField !== false;

  // The figure, kneeling at the origin, turned toward the viewer's left (the centre panel).
  const yaw = -THREE.MathUtils.degToRad(n(ctx, 'kneelTurn', 50, 0, 80));
  // `clean`: straight faceted limbs (no bow) built like the bust, and a stacked-ring head; else R1's flowing figure.
  const fig = agentFigure({ height: 24 * K, anchor: new THREE.Vector3(), yaw, base: 'kneel', pose: KNEEL, proportions: BROAD, build: clean ? 1.3 : 1.25, facets: 6, bow: clean ? 0 : 0.015, hem: HEM, lift: 0.5 * K });
  const { body, head, stops, skeleton: s } = fig;
  const arms = body.limbs.filter(t => t.id.startsWith('arm')), legs = body.limbs.filter(t => t.id.startsWith('leg'));
  // The kit stops a trouser at a level hem above the ankle, which a kneeling leg's shin, lying along the floor, never
  // reaches: it would stop at the knee. Each trouser stops just short of its ankle instead.
  for (const side of ['l', 'r'] as const) {
    const leg = legs.find(t => t.id === `leg_${side}`)!;
    stops.set(leg.id, Math.max(stops.get(leg.id)!, uNear(leg, s.at(`ankle_${side}`)) - 0.03));
  }

  // The hands: gripping, fingers curled round the strands; the shoes: blunt slabs along each foot.
  const hands: Slab[] = [];
  for (const side of ['l', 'r'] as const) {
    const elbow = s.at(`elbow_${side}`), wrist = s.at(`wrist_${side}`);
    const along = wrist.clone().sub(elbow).normalize();
    const across = new THREE.Vector3().crossVectors(along, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(side === 'l' ? 1 : -1);
    hands.push(...slabHand({ wrist, along, across, size: 1.15 * K, curl: 0.62, spread: 0.06 }));
  }
  const shoes: Slab[] = [];
  for (const side of ['l', 'r'] as const) {
    const j = s.joints.get(`ankle_${side}`)!;
    const toe = j.end.clone(), heel = j.origin.clone();
    const along = toe.clone().sub(heel).normalize();
    const across = new THREE.Vector3().crossVectors(along, new THREE.Vector3(0, 1, 0)).normalize();
    shoes.push(orientedSlab(heel.clone().lerp(toe, 0.5).add(new THREE.Vector3(0, -0.1 * K, 0)), across, along, 0.62 * K, toe.distanceTo(heel) + 0.35 * K, 0.5 * K, 30));
  }
  const gather = s.at('wrist_l').lerp(s.at('wrist_r'), 0.5);

  // The camera: in front, a little below the chest, the figure fitted to the sheet's height and set right of centre.
  const fov = 38;
  const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const pts: THREE.Vector3[] = [...headCoil(head)];
  for (const t of [body.trunk, ...body.limbs]) for (let i = 0; i <= 12; i++) for (let k = 0; k < 8; k++) pts.push(t.point(i / 12, k / 8));
  for (const sl of shoes) pts.push(new THREE.Vector3(sl.x, sl.y - sl.h / 2, sl.z));
  const camera = (target: THREE.Vector3, D: number) => {
    const c = new THREE.PerspectiveCamera(fov, W / H, 1, 1e6);
    // From a little above: the floor opens into a disc the figure kneels on.
    c.position.copy(target).add(new THREE.Vector3(0, 0.32, 1).normalize().multiplyScalar(D));
    c.lookAt(target);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    return c;
  };
  let target = s.at('chest').clone().setY(s.at('chest').y * 0.7), D = 60 * K;
  const top = TRIM.y0 + 20, bottom = TRIM.y1 - 30, cx = 0.58 * PAGE.width, right = TRIM.x1 - 6, left = 0.2 * PAGE.width;
  for (let it = 0; it < 40; it++) {
    const c = camera(target, D);
    const ps = pts.map(p => pageOf(c, p, PAGE));
    const y0 = Math.min(...ps.map(p => p.y)), y1 = Math.max(...ps.map(p => p.y)), x0 = Math.min(...ps.map(p => p.x)), x1 = Math.max(...ps.map(p => p.x));
    const across = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 1);
    target = target.clone().addScaledVector(across, ((x0 + x1) / 2 - Math.min(cx, (left + right) / 2 + 20)) * D / f).addScaledVector(up, -((y0 + y1) / 2 - (top + bottom) / 2) * D / f);
    D *= Math.max((y1 - y0) / (bottom - top), (x1 - x0) / (right - left));
  }
  const view = camera(target, D);
  const eye = view.position.clone(), forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const mmPerUnit = (p: THREE.Vector3) => f / -p.clone().applyMatrix4(view.matrixWorldInverse).z;

  // The tone: the light is in the gathered strands at the hands.
  const aura = toneField(ctx, gather.clone().divideScalar(K), { noiseKey: 'kneel-aura', reach: 5 });
  // Clean: one even tone (between the second and third stripe tiers), so the stripes run whole, never in patches.
  const env: ToneEnv = clean
    ? { density: 0.8 * n(ctx, 'density', 0.45, 0, 1), dark: () => 0.5, screen: p => pageOf(view, p, PAGE) }
    : { density: n(ctx, 'density', 0.45, 0, 1), dark: (p, nrm) => 0.05 + 0.5 * aura(p.clone().divideScalar(K), nrm), screen: p => pageOf(view, p, PAGE) };
  const strokes: Tagged[] = [];
  const slack = 0.15 * K;
  const cloth = (list: ClothStroke[]) => { for (const st of list) strokes.push({ ink: st.ink, group: st.group, family: st.family ?? 'hatch', points: st.points, slack }); };
  cloth(pinstripeTube(body.trunk, env, HEMS.trunk, LOOK));
  cloth(suitFront(body.trunk, env, LOOK));
  const cut = body.limbs.map(t => cutTube(t, stops.get(t.id)!));
  for (const t of arms) { const stop = stops.get(t.id)!; cloth(pinstripeTube(t, env, { seams: [0.5], hems: [], stop: stop - 0.012, cuffs: [stop - 0.035] }, LOOK)); }
  for (const t of legs) { const stop = stops.get(t.id)!; cloth(pinstripeTube(t, env, { seams: [0, 0.5], hems: [stop - 0.004], creases: [0.25], stop }, LOOK)); }
  for (const t of [body.trunk, ...cut]) cloth(silhouettes(t, { forward, eye }, { ink: LOOK.edge, group: LOOK.contour }));
  const light = new THREE.Vector3(-0.6, 0.7, 0.4).normalize();
  // Hands hatched in the raking light; shoes as outlines (the planted one stands on the disc, where a hatched block
  // would read as a slab of silver).
  for (const sl of [...hands, ...shoes]) for (const st of facetStrokes(sl, light, eye, shoes.includes(sl), 4 / mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z)))) strokes.push({ ink: st.ink === 'violet' ? 'carbon' : st.ink, group: 'hand', family: st.family, points: st.points, slack: 0.05 * K });
  // The head: R1's helix wound along the coil, or (clean) a stack of flat ring bands like a coiled spring.
  const headGeos: THREE.BufferGeometry[] = [];
  if (clean) {
    for (const band of ringHead(head)) {
      cloth(pinstripeTube(band, env, { seams: [], hems: [0.05, 0.95] }, LOOK).map(st => ({ ...st, group: 'helix' })));
      cloth(silhouettes(band, { forward, eye }, { ink: 'carbon', group: 'helix' }));
      headGeos.push(band.mesh(6, 72));
    }
  } else {
    const helix = helixAlong(ctx, view, new THREE.CatmullRomCurve3(headCoil(head), false, 'centripetal'),
      { radius: 0.12 * K, width: 0.6 * K, pitch: 9 * K, spread: 0.1 * K, narrow: 0.08 * K, density: 0.4, interruption: 0.1 });
    for (const h of helix.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points, slack });
    headGeos.push(...helix.meshes, skull(head));
  }

  // The floor disc: a circle on the ground the figure kneels on, reaching forward under its hands, as a curved cut in
  // the white.
  // Centred under the kneeling knee and the planted foot, so the figure kneels on it; its front edge takes the strands.
  const under = s.at('knee_r').lerp(s.at('ankle_l'), 0.5);
  const centre = new THREE.Vector3(under.x, 0, under.z);
  const radius = 6.4 * K;
  const ring = (r: number) => Array.from({ length: 96 }, (_, i) => pageOf(view, centre.clone().add(new THREE.Vector3(r * Math.cos(2 * Math.PI * i / 96), 0, r * Math.sin(2 * Math.PI * i / 96))), PAGE));
  // The floor's outline: R1 to R4's disc, or (the angular cut set) a square on the ground seen corner-on, angular.
  const square = [0, 1, 2, 3].map(k => pageOf(view, centre.clone().add(new THREE.Vector3(radius * Math.cos(k * Math.PI / 2), 0, radius * Math.sin(k * Math.PI / 2))), PAGE));
  const disc = clipPolygon(floorKind(ctx) === 'square' ? square : ring(radius), TRIM);
  const discCentre = pageOf(view, centre, PAGE);

  // The field's pull on the figure (`figureField`): every mark moved along the field toward C, nothing at the ground and
  // most at the crown of the head, so the head leans and the torso with it while the knees hold. The head's own marks
  // are pulled half again as far, so it unwinds toward C.
  const groundY = discCentre.y, crownY = Math.min(...headCoil(head).map(p => pageOf(view, p, PAGE).y));
  const lift = (p: Point) => Math.max(0, Math.min(1, (groundY - p.y) / (groundY - crownY))) ** 1.7;
  const pullBody = pulled ? fieldPull(m, PULL_MM, lift) : (p: Point) => p;
  const pullHead = pulled ? fieldPull(m, 1.5 * PULL_MM, lift) : (p: Point) => p;

  // The strands: in at the left edge at the heights the field left C, gathered at the hands (where the pull has moved
  // them), led down into the disc, and with the pull, bowed toward C as they fall.
  const g = pullBody(pageOf(view, gather, PAGE));
  const bow = pulled ? -BOW_MM : 0;
  const pink = Math.floor(exits.length / 2);
  const strands = exits.map((y, k) => {
    const t = exits.length > 1 ? k / (exits.length - 1) - 0.5 : 0;
    // Level through the trim, so each strand meets its field line from C at exactly the height it left C's edge.
    const path = smoothPath([{ x: TRIM.x0 - 6, y }, { x: TRIM.x0, y }, { x: TRIM.x0 + 26, y: y + (g.y - y) * 0.12 }, { x: g.x - 34, y: g.y + (y - g.y) * 0.35 + 6 * t }, { x: g.x + 3 * t, y: g.y + 2 * t },
      { x: g.x - 10 + 14 * t + bow, y: (g.y + discCentre.y) / 2 }, { x: discCentre.x + 22 * t, y: discCentre.y + 3 * Math.abs(t) }]);
    return { path, ink: (k === pink ? 'vermilion' : 'ultramarine') as Ink };
  });
  const strandArea = glyphMask(strands.map(st => st.path), 0.9, 6, PAGE);
  // "line", along the pink strand where it falls from the hands toward the floor.
  const pinkPath = strands[pink]?.path ?? [];
  const word = wordAlong('line', pinkPath, 0.74 * 0.4 * pinkPath.length, 2.4, 2.4);
  const clear = glyphMask(word, 0.8, 6, PAGE);

  const figureGeos = [body.trunk.mesh(192, body.trunk.facets * 4), ...cut.flatMap(cutMeshes), ...[...hands, ...shoes].map(slabGeometry), ...headGeos];
  fitDepthRange(view, figureGeos, 0.1, { exact: true });
  const depth = renderDepthBufferCPU(figureGeos, view, W, H);
  const buckets = new PartBuckets(0.4);
  const BANDS = 10;
  const dist = (t: Tagged) => eye.distanceTo(t.points[t.points.length >> 1]);
  const order = [...strokes].sort((a, b) => dist(a) - dist(b));
  for (let b = 0; b < BANDS; b++) {
    const chunk = order.slice(Math.floor(b * order.length / BANDS), Math.floor((b + 1) * order.length / BANDS));
    if (!chunk.length) continue;
    projectStrokes(chunk, { view, depth, width: W, height: H, bias: hiddenBias(view, slack, dist(chunk[chunk.length >> 1])) }, {
      begin: (st: Tagged) => (runs: ProjectedPoint[][]) => {
        for (const run of runs) for (const inside of clipToRect(scalePoints(run, MM_X, MM_Y).map(st.group === 'helix' ? pullHead : pullBody), ART)) {
          for (const piece of keepAlong(inside, p => !strandArea(p) && !clear(p), 0.15)) {
            buckets.add(`${st.group === 'contour' || st.group === 'figure' || st.group === 'helix' || st.group === 'hand' ? st.group : 'figure'}-${st.ink}`, piece, false);
            // Where the figure stands on the disc, the black shows: the same mark there in silver.
            buckets.add(`under-${st.ink}`, piece, false);
          }
        }
      },
    });
  }
  for (const st of strands) for (const piece of clipToRect(st.path, ART)) {
    for (const part of keepAlong(piece, p => !clear(p), 0.15)) { buckets.add(`strand-${st.ink}`, part, true); buckets.add(`strandunder-${st.ink}`, part, true); }
  }
  for (const w of word) for (const piece of clipToRect(w, ART)) buckets.add('word-ultramarine', piece, true);
  // The ground (`groundFx`), on the black sheet under the floor disc: R1's three silver rings, or the field going on into
  // the ground. A ring about a ground point, sampled on the floor plane and kept inside the floor disc.
  const fx = String(ctx.params.groundFx ?? 'pulse');
  const fxSilver: Point[][] = [], fxPink: Point[][] = [];
  const onDisc = (q: Point) => insideRing(disc, q);
  const ringAt = (c: THREE.Vector3, r: number, a0 = 0, a1 = 2 * Math.PI, n = 144): Point[] => Array.from({ length: n + 1 }, (_, i) => pageOf(view, c.clone().add(new THREE.Vector3(r * Math.cos(a0 + (a1 - a0) * i / n), 0, r * Math.sin(a0 + (a1 - a0) * i / n))), PAGE));
  const keepOnDisc = (path: Point[], into: Point[][]) => { for (const piece of keepAlong(path, onDisc, 0.2)) into.push(piece); };
  const landing = (st: { path: Point[] }) => onGround(view, st.path[st.path.length - 1], PAGE);
  const bundle = strands.map(landing).reduce((t, q) => t.add(q), new THREE.Vector3()).divideScalar(Math.max(1, strands.length)).setY(0);
  const pinkAt = strands[pink] ? landing(strands[pink]).setY(0) : bundle;
  // Ring spacing on the floor: about 2.4 mm across the sheet at the disc.
  const stepW = 2.4 / mmPerUnit(centre);
  if (fx === 'interference') {
    // Two families of rings, from where the strands land and (a touch wider apart) from the disc's own centre: where
    // they cross they beat into moiré. The three rings round where the pink strand lands are pink.
    for (let r = 1.3 * stepW; r < 1.6 * radius; r += 1.3 * stepW) keepOnDisc(ringAt(bundle, r), fxSilver);
    for (let r = 1.45 * stepW; r < 1.6 * radius; r += 1.45 * stepW) keepOnDisc(ringAt(centre, r), fxSilver);
    for (let k = 1; k <= 3; k++) keepOnDisc(ringAt(pinkAt, 0.6 * k * stepW), fxPink);
  } else if (fx === 'pulse') {
    // Rings spreading from where the strands land, ever further apart, dashed by turns; between them, filings pointing
    // into the ground (radial dashes). The third ring is pink.
    const rings: number[] = [];
    for (let r = 1.2 * stepW; r < 1.6 * radius; r *= 1.22) rings.push(r);
    rings.forEach((r, k) => {
      const path = ringAt(bundle, r, 0.3 * k, 0.3 * k + 2 * Math.PI, 240);
      const into = k === 2 ? fxPink : fxSilver;
      if (k % 2 === 0) keepOnDisc(path, into);
      else for (let i = 0; i + 4 < path.length; i += 6) keepOnDisc(path.slice(i, i + 5), into);
      const next = rings[k + 1] ?? 1.22 * r, count = Math.round(18 + 6 * k);
      for (let i = 0; i < count; i++) {
        const a = 2 * Math.PI * (i + 0.5 * (k % 2)) / count;
        const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        const r0 = r + 0.25 * (next - r), r1 = r + 0.6 * (next - r);
        keepOnDisc([pageOf(view, bundle.clone().addScaledVector(d, r0), PAGE), pageOf(view, bundle.clone().addScaledVector(d, r1), PAGE)], fxSilver);
      }
    });
  } else if (ctx.params.groundRings !== false) {
    for (const r of [0.22, 0.42, 0.64]) { const pr = ring(r * radius); for (const piece of clipToRect([...pr, pr[0]], ART)) buckets.add('rings-carbon', piece, true); }
  }
  for (const geo of figureGeos) geo.dispose();

  // Route: the white keeps the figure and strands, the black the marks under the disc; the pink strand in pink on both.
  const parts = buckets.toParts(GROUPS, INKS);
  // (The strands are routed by hand: routeParts keys a ply's pens by ink, and the pink strand needs its own pen on both.)
  const art = routeParts(parts.filter(p => !p.id.startsWith('strand')), ROUTES);
  for (const p of parts.filter(q => q.id.startsWith('strand-'))) art.white.push({ ...p, pen: STRAND_PEN.white[p.pen as 'ultramarine' | 'vermilion'] });
  for (const p of parts.filter(q => q.id.startsWith('strandunder-'))) art.black.push({ ...p, pen: STRAND_PEN.black[p.pen as 'ultramarine' | 'vermilion'] });
  if (fxSilver.length) art.black.push({ id: 'fx-silver', pen: 'silver', paths: fxSilver });
  if (fxPink.length) art.black.push({ id: 'fx-pink', pen: 'fluoro-pink', paths: fxPink });
  // The cut set's windows in the white (`cutScheme`), beside the floor disc: the black shows there, the figure and the
  // strands drawn on it in silver (the `under` marks).
  const headPage = pullHead(pageOf(view, head.centre, PAGE));
  const windows = rCuts(ctx, { head: headPage, headR: head.r * mmPerUnit(head.centre), gather: g, entries: exits, floor: disc });
  return renderPly(spec, ctx, pens, { cuts: { white: windows }, art });
}

const sketch: Sketch = {
  name: 'Breach triptych: Lodestone R (the ground)',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls: [plyControl(spec), ...LODESTONE_CONTROLS],
  assembly: spec,
  draw,
};

export default sketch;
