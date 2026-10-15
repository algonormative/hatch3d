import * as THREE from 'three';
import type { AssemblySpec, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { buildSurfaceMesh, type ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { routeParts } from '../../kit/assembly.ts';
import { cutTube, headCoil, type AgentHead } from '../../kit/agent.ts';
import { MIN_FEATURE } from '../../kit/format.ts';
import { helixAlong } from '../../kit/helix.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, keepAlong, meshCoverage } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, pageOf } from '../../kit/perspective.ts';
import { facetStrokes, slabGeometry, solid, type Slab } from '../../kit/slabs.ts';
import { PartBuckets, hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { LOOK, toneField, type ToneEnv } from '../../kit/mannequin/hatch.ts';
import { BUTTON, COLLAR, HEMS, front, pinstripeTube, suitFront } from '../../kit/mannequin/suit.ts';
import { silhouettes, type ClothStroke, type Tube } from '../../kit/mannequin/tube.ts';
import { inGrown, lCuts, stripeFill } from '../lodestone-cuts.ts';
import {
  ART, H, MM_X, MM_Y, PAGE, PAPER, THREAD, TRIM, W, bustFrame, faceWordAt, flatRibbon, hatchedUnder, holeBarPaths, lintelBar, pensOf, threadPaths,
} from '../world.ts';
import { FILL_OVER, LODESTONE_ASSEMBLY, LODESTONE_CONTROLS, barWindows, crossingY, gapOf, magnet, suitFrontOutlines, ribbonBleed, ribbonPath, ribbonPitch, ribbonUnravel, seamLevel } from '../lodestone-world.ts';

/**
 * Lodestone, panel L: Lintel's L (approved in Lintel R2: gaze down, the bar drawn in black on the gold inside the
 * hole, silver and gold), its censor bar cut out as a part that is glued on Lodestone's C as the magnet, the helix's
 * strand leaving the head toward the right edge, and "everything" in the glare where Lintel hid "what blinds".
 *
 * Lintel's text, kept for the bust: panel L, "the hole". The Plenipotentiary as a bust from below, filling the sheet, drawn in silver with gold
 * edges on black paper over a gold-yellow sheet. The censor bar across its eyes is plotted in silver hatch and cut out
 * as a part: the gold shows through where it was, with the bar drawn again on it in black ink, and the bar itself is
 * glued on panel R as the lintel of a gate. "what blinds" is hidden in the hatch of the slabs behind the head, in its
 * glare. `gaze` sets the head's tilt and the camera (see `GAZE` in the world).
 *
 * Built on the kit's bust (`sketches/agent-bust`); the shared world (bar, eye height) is `../world.ts`.
 */

const plies = [
  { id: 'gold', paper: PAPER.gold, pens: ['black'], cutInk: 'black' },
  { id: 'black', paper: PAPER.black, pens: ['silver', 'gold'], cutInk: 'silver' },
];
export const spec: AssemblySpec = { ...LODESTONE_ASSEMBLY, plies };
const pens = pensOf(['silver', 'gold', 'black']);

/**
 * The kit's inks on each ply. On the black ply silver carries the cloth, the slabs and the bar, and gold the edges
 * (the suit's seams and silhouettes, the helix's ribbon edges and spine): the figure is outlined in the colour the hole
 * shows. The bar on the gold ply is black.
 */
const ROUTES = {
  gold: { groups: ['hole', 'shirt'], inks: { carbon: 'black' } },
  black: { groups: ['slab', 'figure', 'contour', 'helix', 'thread', 'bar', 'word'], inks: { carbon: 'silver', ultramarine: 'silver', violet: 'silver', vermilion: 'gold', acid: 'gold' } },
};
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
const GROUPS = ['slab', 'figure', 'contour', 'helix', 'thread', 'bar', 'word', 'hole', 'shirt'] as const;

/** An egg inside the head's coil, never drawn: it hides the coil's far side. */
function skull(h: AgentHead): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 28, 18);
  g.applyMatrix4(new THREE.Matrix4().makeBasis(h.side, h.axis, h.face).multiply(new THREE.Matrix4().makeScale(0.52 * h.r, 0.66 * h.r, 0.52 * h.r)));
  g.translate(h.centre.x, h.centre.y, h.centre.z);
  return g;
}

/** A sleeve cut at the cuff, for the depth pass: its surface and a disc closing the end. */
function cutMeshes(t: Tube): THREE.BufferGeometry[] {
  const segs = t.facets >= 3 ? t.facets * 4 : 32;
  return [t.mesh(96, segs), buildSurfaceMesh((u, v) => t.centre(1).lerp(t.point(1, v), u), {}, 2, segs)];
}

/** The point inside a convex page quad (clockwise on the sheet), grown by `margin`. */
const inQuad = (quad: Point[], margin: number) => (p: Point) => quad.every((a, i) => {
  const b = quad[(i + 1) % quad.length];
  const ex = b.x - a.x, ey = b.y - a.y;
  return (ex * (p.y - a.y) - ey * (p.x - a.x)) / Math.hypot(ex, ey) > -margin;
});

/** The vertical faces of a slab, as outward normals in its own frame. */
const SIDES = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0)];

/**
 * A plane of the suit to cut out: of the trunk's six flat planes, the largest on the sheet that faces the eye and is
 * not the front one (the lapels and shirt), between SUIT_U's two places along the trunk; its outline traced along both of
 * its long edges.
 */
const SUIT_U: [number, number] = [0.58, 0.76];

/**
 * The notch where the unravelled lines run out of L toward C: from NOTCH.above the level height they cross the gap at
 * (where they come down over the shoulder) to just below the lowest of them at L's edge, from just left of where they
 * come down to the right trim (its right side on the trim line, so trimmed it is a notch in the edge and the gold runs
 * right up to it). A pentagon: the top edge falling a little toward the edge, the bottom-left corner cut off.
 */
const NOTCH = { above: 48, margin: 6, below: 7 };
function exitNotch(lines: Point[][], level: number | undefined): Point[] | undefined {
  if (level === undefined || !lines.length) return undefined;
  const y0 = level - NOTCH.above;
  const pts = lines.flatMap(l => l.filter(p => p.y >= y0 && p.x <= TRIM.x1 && p.x >= TRIM.x1 - 90));
  if (pts.length < 2) return undefined;
  const x0 = Math.min(...pts.map(p => p.x)) - NOTCH.margin, y1 = Math.max(...lines.map(l => crossingY(l, TRIM.x1) ?? -Infinity)) + NOTCH.below;
  if (!Number.isFinite(y1) || TRIM.x1 - x0 < 8) return undefined;
  return [{ x: x0, y: y0 }, { x: TRIM.x1, y: y0 + 6 }, { x: TRIM.x1, y: y1 }, { x: x0 + 12, y: y1 }, { x: x0, y: y1 - 12 }];
}

/** Shirt stripes: lines down the shirt's front about the tie, a little over a millimetre apart on the sheet. */
function shirtStripes(trunk: Tube, view: THREE.Camera): Point[][] {
  const out: Point[][] = [];
  for (let v = 0.25 - 0.09; v <= 0.25 + 0.09; v += 0.0045) {
    if (Math.abs(v - 0.25) < 0.008) continue;
    const path: Point[] = [];
    for (let i = 0; i <= 60; i++) { const u = BUTTON + (COLLAR + 0.02 - BUTTON) * i / 60; path.push(pageOf(view, trunk.point(u, v, 0.02), PAGE)); }
    out.push(path);
  }
  return out;
}
function suitFacet(trunk: Tube, view: THREE.Camera, eye: THREE.Vector3): Point[] {
  let best: Point[] = [], area = 0;
  for (let k = 0; k < trunk.facets; k++) {
    const v0 = k / trunk.facets, v1 = (k + 1) / trunk.facets, vc = (v0 + v1) / 2;
    if (front(vc) < 0.12) continue;
    const u = (SUIT_U[0] + SUIT_U[1]) / 2, p = trunk.point(u, vc);
    if (trunk.normal(u, vc).dot(eye.clone().sub(p).normalize()) < 0.25) continue;
    const N = 16, ring: Point[] = [];
    for (let i = 0; i <= N; i++) ring.push(pageOf(view, trunk.point(SUIT_U[0] + (SUIT_U[1] - SUIT_U[0]) * i / N, v0), PAGE));
    for (let i = N; i >= 0; i--) ring.push(pageOf(view, trunk.point(SUIT_U[0] + (SUIT_U[1] - SUIT_U[0]) * i / N, v1), PAGE));
    const a = Math.abs(ring.reduce((t, q, i) => { const r = ring[(i + 1) % ring.length]; return t + q.x * r.y - r.x * q.y; }, 0)) / 2;
    if (a > area) { area = a; best = ring; }
  }
  return best;
}

/** A stroke with the slack its hidden-line test allows. */
type Tagged = Stroke & { slack: number };

/**
 * The two words of "what blinds", beside the hole in the head's glare: which background slab each is painted on, where
 * its centre lands on the sheet (page millimetres, R1's approved places), and its cap height (mm). "what" sits off the
 * bar's right end, high; "blinds" off its left end, low.
 */
const WORDS: { word: string; slab: number; at: Point; capMm: number }[] = [
  { word: 'everything', slab: 1, at: { x: 52, y: 186 }, capMm: 2.6 },
];

function draw(ctx: SketchContext): Part[] {
  const frame = bustFrame(ctx);
  const { fig, K, view, eye, forward, mmPerUnit } = frame;
  const { body, head, stops } = fig;
  const arms = body.limbs.filter(t => t.id.startsWith('arm'));
  const bar = lintelBar(ctx, frame);
  const toward = ctx.params.glare !== 'away';

  // The tone: the head is the light. On black paper silver is the light, so by default the field is turned over: the
  // cloth is densest round the head and goes bare far from it; `away` keeps the kit's value (bare at the head).
  const aura = toneField(ctx, head.centre.clone().divideScalar(K), { noiseKey: 'bust-aura', reach: n(ctx, 'reach', 2, 0.5, 8) });
  const dark = (p: THREE.Vector3, nrm: THREE.Vector3) => { const d = aura(p.clone().divideScalar(K), nrm); return toward ? 1 - d : d; };
  const env: ToneEnv = { density: n(ctx, 'density', 0.45, 0, 1), dark, screen: p => pageOf(view, p, PAGE) };

  const strokes: Tagged[] = [];
  const slack = n(ctx, 'slack', 0.15, 0.01, 2) * K;
  const cloth = (list: ClothStroke[]) => {
    for (const st of list) strokes.push({ ink: st.ink, group: st.group, family: st.family ?? 'hatch', points: st.points, slack });
  };
  cloth(pinstripeTube(body.trunk, env, HEMS.trunk, LOOK));
  cloth(suitFront(body.trunk, env, LOOK));
  for (const t of arms) {
    const stop = stops.get(t.id)!;
    cloth(pinstripeTube(t, env, { seams: [0.5], hems: [], stop: stop - 0.012, cuffs: [stop - 0.035] }, LOOK));
  }
  const sleeves = arms.map(t => cutTube(t, stops.get(t.id)!));
  for (const t of [body.trunk, ...sleeves]) cloth(silhouettes(t, { forward, eye }, { ink: LOOK.edge, group: LOOK.contour }));

  const helix = helixAlong(ctx, view, new THREE.CatmullRomCurve3(headCoil(head), false, 'centripetal'),
    { radius: 0.12 * K, width: 0.5 * K, pitch: 9 * K, spread: 0.1 * K, narrow: 0.08 * K, density: 0.45, interruption: 0.1 });
  for (const h of helix.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points, slack });

  // The background: two large slabs, hatched at a pitch in page millimetres. Their light is the head's, turned over
  // with the tone: faces toward the head take the most silver.
  const right = new THREE.Vector3().setFromMatrixColumn(view.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(view.matrixWorld, 1);
  const back = forward.clone().setY(0).normalize();
  const slabs: Slab[] = [];
  const place = (r: number, u: number, b: number, w: number, h: number, d: number, ry: number) => {
    const c = head.centre.clone().addScaledVector(right, r * K).addScaledVector(up, u * K).addScaledVector(back, b * K);
    const sl = solid(c.x, c.y, c.z, w * K, h * K, d * K, slabs.length, 'stack');
    sl.ry = ry;
    slabs.push(sl);
  };
  place(18, 8, 26, 16, 80, 9, 0.5);
  place(-12, -4, 38, 30, 56, 9, -0.35);
  const lightOf = (sl: Slab) => { const toHead = head.centre.clone().sub(new THREE.Vector3(sl.x, sl.y, sl.z)).normalize(); return toward ? toHead.negate() : toHead; };
  for (const sl of slabs) {
    const at = new THREE.Vector3(sl.x, sl.y, sl.z), toHead = head.centre.clone().sub(at).normalize();
    sl.tone = 2.4 * env.dark(at, toHead) - 1.1;
    const slabSlack = Math.max(0.12, Math.min(0.5 * Math.max(1, K / 4), 0.25 * Math.min(sl.w, sl.h, sl.d)));
    for (const st of facetStrokes(sl, lightOf(sl), eye, false, n(ctx, 'slabMm', 7, 3, 20) / mmPerUnit(at))) {
      strokes.push({ ink: st.ink, group: 'slab', family: st.family, points: st.points, slack: slabSlack, owner: slabs.indexOf(sl) });
    }
  }

  const figureGeos = [body.trunk.mesh(192, body.trunk.facets * 4), ...sleeves.flatMap(cutMeshes), ...helix.meshes, skull(head)];
  const solids = meshCoverage(figureGeos, view, PAGE, 1.1);
  const onBar = inQuad(bar.quad, 1.4);

  // "what blinds": painted on the slabs' faces that look at the eye, each at its approved place on the sheet, or the
  // nearest place round it (a spiral of 4 mm steps, out to 64 mm) where the word lies whole on the face, clear of the figure, the bar
  // and the trim: the gaze readings move the slabs with the camera.
  const words: Tagged[] = [];
  const clearOf = (points: THREE.Vector3[][]) => points.flat().every(q => {
    const p = pageOf(view, q, PAGE);
    return p.x > ART.x0 + 3 && p.x < ART.x1 - 3 && p.y > ART.y0 + 3 && p.y < ART.y1 - 3 && !solids(p) && !inQuad(bar.quad, 3)(p);
  });
  for (const w of WORDS) {
    const sl = slabs[w.slab];
    let painted: THREE.Vector3[][] = [];
    search: for (let ring = 0; ring <= 16; ring++) {
      const steps = ring === 0 ? 1 : 8 * ring;
      for (let k = 0; k < steps; k++) {
        const a = 2 * Math.PI * k / steps, at = { x: w.at.x + 4 * ring * Math.cos(a), y: w.at.y + 4 * ring * Math.sin(a) };
        for (const normal of SIDES) {
          // Only where the face's hatch lies, so the word hides in the silver rather than standing on bare black.
          const up = new THREE.Vector3(0, 1, 0);
          const made = faceWordAt(sl, w.word, view, at, { normal, up, capMm: w.capMm });
          if (made && clearOf(made) && hatchedUnder(sl, normal, up, lightOf(sl), made.flat())) { painted = made; break search; }
        }
      }
    }
    for (const points of painted) words.push({ ink: 'carbon', group: 'word', family: 'text', points, slack: 0.12, owner: w.slab });
  }

  const geometries = [...slabs.map(slabGeometry), ...figureGeos];
  fitDepthRange(view, geometries, 0.1, { exact: true });
  const depth = renderDepthBufferCPU(geometries, view, W, H);

  const buckets = new PartBuckets(0.4);
  const BANDS = 12;
  // The helix's strand leaves the crown of the coil and runs out across the right edge, toward the magnet. It lies in
  // front of everything; all else gives way to it.
  let threadArea: (p: Point) => boolean = () => false;
  let exiting: Point[][] = [];
  {
    // With `ribbonField` the magnet in C pulls the strand along its field toward the north pole, and its twist
    // tightens where the field is strong; else R1's path to the right edge.
    const m = magnet(bar, ctx);
    const pulled = ctx.params.ribbonField !== false;
    const crown = pageOf(view, headCoil(head).at(-1)!, PAGE);
    // `ribbonBleed`: progressive (it loosens and unravels into field lines overhead), split (R3: it comes apart at one
    // point), or off (R2: one line). The lines it becomes are drawn below.
    const mode = String(ctx.params.ribbonBleed), dims = { width: THREAD.widthMm, pitch: THREAD.pitchMm };
    const unravel = pulled && mode === 'progressive' ? ribbonUnravel(crown, m, bar, dims) : undefined;
    const bleed = unravel ?? (pulled && mode === 'split' ? ribbonBleed(crown, m, bar, dims) : undefined);
    const l = bleed ? { path: bleed.ribbon, phase0: 0 } : pulled ? { path: ribbonPath(crown, m), phase0: 0 } : threadPaths(frame, bar).l;
    const ribbon = flatRibbon(l.path, { width: THREAD.widthMm, pitch: THREAD.pitchMm, phase0: l.phase0, ...(pulled ? { pitchAt: unravel?.pitchAt ?? ribbonPitch(m, bar) } : {}) });
    for (const rib of unravel?.ribs ?? []) for (const inside of clipToRect(rib, ART)) for (const piece of keepAlong(inside, p => !onBar(p), 0.1)) buckets.add('thread-ultramarine', piece, true);
    exiting = (bleed?.strands ?? []).map(st => st.path);
    for (const st of bleed?.strands ?? []) {
      for (const inside of clipToRect(st.path, ART)) for (const piece of keepAlong(inside, p => !onBar(p), 0.1)) buckets.add(`thread-${st.ink}`, piece, true);
      ribbon.mask.push(st.path);
    }
    // Never on the bar: the bar is cut out and glued on R, and must carry only its own hatch.
    for (const st of ribbon.strokes) for (const inside of clipToRect(st.points, ART)) for (const piece of keepAlong(inside, p => !onBar(p), 0.1)) buckets.add(`thread-${st.ink}`, piece, true);
    threadArea = glyphMask(ribbon.mask, 0.8, 6, PAGE);
  }
  const dist = (t: Tagged) => eye.distanceTo(t.points[t.points.length >> 1]);
  // Words first, so the hatch round them can give way.
  const wordPaths: Point[][] = [];
  projectStrokes(words, { view, depth, width: W, height: H, bias: hiddenBias(view, 0.12, dist(words[0] ?? strokes[0])) }, {
    begin: () => (runs: ProjectedPoint[][]) => {
      for (const run of runs) for (const inside of clipToRect(scalePoints(run, MM_X, MM_Y), ART)) {
        for (const piece of keepAlong(inside, p => !onBar(p) && !solids(p) && !threadArea(p), 0.1)) if (buckets.add('word-carbon', piece, true)) wordPaths.push(piece);
      }
    },
  });
  const clear = glyphMask(wordPaths, 0.9, 6, PAGE);

  // Hidden lines, tested in bands of eye distance (see `sketches/agent-bust`).
  const order = [...strokes].sort((a, b) => dist(a) - dist(b));
  const groups = new Map<string, { strokes: Tagged[]; bias: number }>();
  for (let b = 0; b < BANDS; b++) {
    const chunk = order.slice(Math.floor(b * order.length / BANDS), Math.floor((b + 1) * order.length / BANDS));
    for (const t of chunk) {
      const key = `${t.owner ?? 'figure'}:${b}`;
      const g = groups.get(key) ?? { strokes: [], bias: hiddenBias(view, t.slack, dist(chunk[chunk.length >> 1])) };
      g.strokes.push(t);
      groups.set(key, g);
    }
  }
  for (const g of groups.values()) {
    projectStrokes(g.strokes, { view, depth, width: W, height: H, bias: g.bias }, {
      begin: (st: Tagged) => (runs: ProjectedPoint[][]) => {
        for (const run of runs) {
          const keep = st.owner === undefined ? () => true : (p: Point) => !solids(p);
          for (const inside of clipToRect(scalePoints(run, MM_X, MM_Y), ART)) {
            for (const piece of keepAlong(inside, p => !onBar(p) && !clear(p) && !threadArea(p) && keep(p), 0.15)) buckets.add(`${st.group}-${st.ink}`, piece, false, st.family === 'hatch' && MIN_FEATURE ? MIN_FEATURE : undefined);
          }
        }
      },
    });
  }
  for (const path of bar.paths) buckets.add('bar-carbon', path, true);

  // The censor bar in black ink on the gold, seen through the hole (the gold runs `bleed` under the hole's edge).
  if (ctx.params.holeBar !== false) for (const path of holeBarPaths(bar, spec.bleed + FILL_OVER)) buckets.add('hole-carbon', path, true);
  for (const g of geometries) g.dispose();

  // The cut set's windows in the black (`cutScheme`): a plane of the suit and a corner. The gold beneath carries every mark
  // of the black too, in black ink, so the pinstripes run on across the cut; each sheet keeps what it shows.
  const front = suitFrontOutlines(body.trunk, view);
  const notch = exitNotch(exiting, gapOf(magnet(bar, ctx)) > 0 ? seamLevel(magnet(bar, ctx)) : undefined);
  const windows = lCuts(ctx, { facet: suitFacet(body.trunk, view, eye), ...front, ...(notch ? { notch } : {}) });
  // The shirt cut out (`lCut` shirt): its stripes, fine lines down it, drawn in black on the gold beneath.
  if (windows.some(c => c.id.startsWith('shirt'))) for (const path of shirtStripes(body.trunk, view)) for (const inside of clipToRect(path, ART)) buckets.add('shirt-carbon', inside, true);
  const art = routeParts(buckets.toParts(GROUPS, INKS), ROUTES);
  // The tie and the shirt are filled with stripes over each window grown by the bleed (so a cut or registration a little
  // off never shows bare gold at the edge): the tie's across it, the shirt's along it. The black's other marks run on
  // across the gold everywhere else, so the corner and the notch are filled by them.
  const grow = spec.bleed + FILL_OVER;
  const tieAxis = Math.atan2(front.tie[40].y - front.tie[0].y, front.tie[40].x - front.tie[0].x);
  const stripes = windows.flatMap(w => (w.id === 'tie' ? stripeFill(w.rings[0], tieAxis + Math.PI / 2 - 0.35, 1.5, grow) : w.id.startsWith('shirt') ? stripeFill(w.rings[0], tieAxis, 1.3, grow) : []));
  const filled = windows.filter(w => w.id === 'tie' || w.id.startsWith('shirt')).map(w => inGrown(w.rings[0], grow));
  if (windows.length) {
    art.gold.push(...art.black.filter(part => !part.id.startsWith('bar-')).map(part => ({ ...part, id: `under-${part.id}`, pen: 'black', paths: part.paths.flatMap(path => keepAlong(path, q => !filled.some(f => f(q)), 0.15)) })).filter(part => part.paths.length));
    if (stripes.length) art.gold.push({ id: 'fill-black', pen: 'black', paths: stripes });
  }
  // The bar: a window in the black (`barMode` window, R7), or a part cut out and kept for C (onlay, R1 to R6).
  const barCutHere = barWindows(ctx) ? { ...bar.cut, kind: 'waste' as const, label: 'BAR' } : bar.cut;
  return renderPly(spec, ctx, pens, { cuts: { black: [barCutHere, ...windows] }, art });
}

const sketch: Sketch = {
  name: 'Breach triptych: Lodestone L (the open eyes)',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls: [plyControl(spec), ...LODESTONE_CONTROLS],
  assembly: spec,
  draw,
};

export default sketch;
