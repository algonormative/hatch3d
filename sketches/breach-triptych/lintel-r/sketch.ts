import * as THREE from 'three';
import type { AssemblySpec, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { renderPly } from '../../../src/sketch/assembly.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { routeParts } from '../../kit/assembly.ts';
import { MIN_FEATURE } from '../../kit/format.ts';
import { helixAlong } from '../../kit/helix.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, keepAlong, meshCoverage } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { facetStrokes, ruledFaces, slabGeometry, slabMatrix, solid, swapRuledFaces, type FacetStroke, type Slab } from '../../kit/slabs.ts';
import { PartBuckets, hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import {
  ART, ASSEMBLY, BAR_ID, CONTROLS, H, MM_X, MM_Y, PAGE, PAPER, W, bustFrame, faceWord, farJoints, lintelBar, lintelFootprint, lintelRect,
  pageWord, paving, pensOf, plainStrokes, skyLines, sun,
} from '../world.ts';

/**
 * Lintel, panel R: "the weight". Two monumental piers, slab stacks in carbon and ultramarine on white paper, with a
 * city beyond the gate; L's censor bar is glued level across their tops as the lintel, at the eye height the three
 * panels share. The helix is knotted round the joint where lintel and pier meet. "bear" is painted on a pier in the
 * light; "weight" is plotted under the strip and sealed, the only word with no light.
 */

const plies = [
  { id: 'white', paper: PAPER.white, pens: ['carbon', 'ultramarine'], cutInk: 'carbon' },
  { id: 'bar', paper: PAPER.black, pens: [], cutInk: 'carbon', onlay: { from: `lintel-l/black/${BAR_ID}` } },
];
/** The signature: carbon, in a box at the foot of the sheet, right of the right pier. */
const SIGNATURE = { ply: 'white', pen: 'carbon', box: { x: 222, y: 394, width: 40, height: 12 } };
export const spec: AssemblySpec = { ...ASSEMBLY, plies, signature: SIGNATURE };
const pens = pensOf(['carbon', 'ultramarine']);

/** Carbon and ultramarine only: the helix's edges and the raking hatch's crossed field go to carbon, its spine to ultramarine. */
const ROUTES = {
  white: { groups: ['pier', 'plain', 'far', 'city', 'sky', 'helix', 'word'], inks: { carbon: 'carbon', ultramarine: 'ultramarine', violet: 'carbon', vermilion: 'carbon', acid: 'ultramarine' } },
};
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
const GROUPS = ['pier', 'plain', 'far', 'city', 'sky', 'helix', 'word'] as const;

/** Eye height and paving, world units. */
const EYE = 2, PITCH = 1.5, JOINT = 0.09;
/** The spacing of the ruled faces of the piers, and the hatch pitch of the city, on the sheet (mm). */
const RULE_MM = 1.1, CITY_MM = 2.4;
/** The least paper between two forms on the sheet (mm): a city tower and a pier's edge. */
const CLEAR = 4;

type Tagged = Stroke & { slack: number };

function draw(ctx: SketchContext): Part[] {
  const bar = lintelBar(ctx, bustFrame(ctx));
  const footprint = lintelFootprint(bar);
  const lintel = lintelRect(bar);

  const fov = 50;
  const horizonY = n(ctx, 'horizon', 0.74, 0.45, 0.9) * PAGE.height;
  const view = horizonCamera({ fov, eye: [0, EYE, 0], target: [0, EYE, -100], far: 1e4, page: PAGE, depth: { width: W, height: H }, horizonY });
  const eye = view.position.clone();
  const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const halfWidth = Math.atan(Math.tan(THREE.MathUtils.degToRad(fov / 2)) * W / H);
  const mmPerUnit = (p: THREE.Vector3) => f / -p.clone().applyMatrix4(view.matrixWorldInverse).z;
  const light = sun(ctx);
  const rng = ctx.random('gate-courses');

  // The piers: their front faces at depth D, standing on the ground at the foot of the sheet; their tops run up under
  // the lintel's middle, so the strip covers the joint. Page millimetres to world at that depth: `D / f`.
  const footY = ART.y1 - 22;
  const D = EYE * f / (footY - horizonY);
  const toWorld = D / f;
  const pierW = n(ctx, 'pierMm', 48, 24, 70) * toWorld, depth = pierW * 0.85;
  const over = n(ctx, 'overhang', 6, 0, 20);
  const splay = THREE.MathUtils.degToRad(n(ctx, 'splay', 22, 0, 45));
  const courses = Math.round(n(ctx, 'courses', 4, 3, 12));
  const weights = Array.from({ length: courses }, () => 0.7 + 0.6 * rng());
  const jitter = Array.from({ length: 2 * courses }, () => [rng() - 0.5, rng() - 0.5, rng() - 0.5]);
  // Each pier is turned `splay` about its axis, its inner face toward the eye, like the jamb of a splayed doorway. Its
  // place and the piers' height are solved on the sheet: the outer edges stand `overhang` inside the lintel's ends, and
  // the highest corner of the top course sits just under the lintel's top edge, so the strip covers the whole joint.
  const build = (cx: number, side: number, top: number): Slab[] => {
    const total = weights.reduce((a, b) => a + b, 0);
    let y = 0;
    return weights.map((w, i) => {
      const h = top * w / total, [jx, jw, jr] = jitter[(side > 0 ? courses : 0) + i];
      const wide = i === courses - 1 ? 1.06 : 1 + jw * 0.05;
      const sl = solid(cx + jx * 0.03, y + h / 2, -D - depth / 2, pierW * wide, h, depth * wide, i, 'pier');
      sl.ry = side * splay + jr * 0.02;
      y += h;
      return sl;
    });
  };
  const corners = (sl: Slab) => [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => pageOf(view, new THREE.Vector3(x * sl.w / 2, y * sl.h / 2, z * sl.d / 2).applyMatrix4(slabMatrix(sl)), PAGE))));
  const xOf = (x: number) => (x - PAGE.width / 2) * toWorld;
  const centres = [xOf(lintel.x0 + over) + pierW / 2, xOf(lintel.x1 - over) - pierW / 2];
  let top = EYE + (horizonY - lintel.y0) * toWorld;
  for (let it = 0; it < 12; it++) {
    const caps = [-1, 1].map((side, k) => corners(build(centres[k], side, top)[courses - 1]));
    centres[0] += (lintel.x0 + over - Math.min(...caps[0].map(p => p.x))) * toWorld;
    centres[1] += (lintel.x1 - over - Math.max(...caps[1].map(p => p.x))) * toWorld;
    top += (Math.min(...caps.flat().map(p => p.y)) - (lintel.y0 + 2.5)) * toWorld;
  }
  const piers = [-1, 1].map((side, k) => build(centres[k], side, top));
  const pierSlabs = piers.flat();

  // The plain runs up to the gate and on through it; no paver under a pier.
  const near = EYE * f / (ART.y1 - horizonY) * 0.9;
  const far = Math.sqrt(EYE * f * PITCH / 0.8);
  const keepOut = (x: number, z: number) => centres.some(cx => Math.abs(x - cx) < pierW / 2 + PITCH / 2 && Math.abs(z + D + depth / 2) < depth / 2 + PITCH / 2);
  const laid = plainStrokes(ctx, paving(ctx, { pitch: PITCH, joint: JOINT, near, far, halfWidth, keepOut, salt: 'gate-paving' }),
    { near, far, eyeH: EYE, light, eye, mmPerUnit, pitchMm: n(ctx, 'plainMm', 13, 3, 16), salt: 'gate-tone' });
  const pavers = laid.map(p => p.slab);
  const joints = ctx.params.joints === true ? farJoints({ pitch: PITCH, from: far, f, halfWidth, minMm: 1.2 }) : [];

  // The city beyond the gate: towers of slabs standing on the horizon, far off, a few of them seen through the gate.
  // None stands within `CLEAR` of a pier's edge on the sheet, nor rises near the lintel: no tangencies.
  const bounds = (sl: Slab) => { const c = corners(sl); return { x0: Math.min(...c.map(p => p.x)), x1: Math.max(...c.map(p => p.x)), y0: Math.min(...c.map(p => p.y)) }; };
  const pierBounds = piers.map(stack => stack.map(bounds).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0) })));
  const edges = pierBounds.flatMap(b => [b.x0, b.x1]);
  const gate = { x0: pierBounds[0].x1 + CLEAR, x1: pierBounds[1].x0 - CLEAR };
  const city: Slab[] = [];
  const crng = ctx.random('gate-city');
  for (let i = 0; i < 48 && city.length < 16; i++) {
    const z = -(140 + 320 * crng());
    // Every third candidate is sought in the gate's opening.
    const px = i % 3 === 0 ? gate.x0 + (gate.x1 - gate.x0) * crng() : ART.x0 + (ART.x1 - ART.x0) * crng();
    const x = (px - PAGE.width / 2) * -z / f;
    const w = 4 + 10 * crng() * (i % 3 === 0 ? 0.5 : 1), h = 6 + 40 * crng() ** 1.8, d = 4 + 6 * crng();
    const sl = solid(x, h / 2, z, w, h, d, i, 'stack');
    sl.ry = (crng() - 0.5) * 0.4;
    sl.tone = 0.25 * crng();
    const b = bounds(sl);
    if (edges.some(e => b.x0 - CLEAR < e && e < b.x1 + CLEAR) || b.y0 < lintel.y1 + 3 * CLEAR) continue;
    city.push(sl);
  }

  const strokes: Tagged[] = [];
  const gateMm = n(ctx, 'gateMm', 6.5, 3, 16);
  const push = (list: FacetStroke[], group: string, slack: number, owner: number) => { for (const st of list) strokes.push({ ink: st.ink, group, family: st.family, points: st.points, slack, owner }); };
  const centreOf = (sl: Slab) => new THREE.Vector3(sl.x, sl.y, sl.z);
  // The piers: the raking hatch, with the faces the sun misses ruled along their length instead of ringed.
  pierSlabs.forEach((sl, i) => {
    sl.tone = 1;
    const unit = mmPerUnit(centreOf(sl));
    push(swapRuledFaces(facetStrokes(sl, light, eye, false, gateMm / unit), ruledFaces(sl, light, view, RULE_MM / unit)), 'pier', 0.03, i);
  });
  laid.forEach(({ slab, strokes: list }, i) => push(list, 'plain', 0.004 * -slab.z, 1000 + i));
  // The city: outlines, and the faces the sun misses ruled wide, so it stays far off.
  city.forEach((sl, i) => push([...facetStrokes(sl, light, eye, true), ...ruledFaces(sl, light, view, CITY_MM / mmPerUnit(centreOf(sl)))], 'city', 0.004 * -sl.z, 5000 + i));

  // The helix, knotted round the joint: three turns round the pier's top course, climbing into the lintel's end.
  const k = ctx.params.knot === 'right' ? 1 : 0;
  const capital = piers[k][courses - 1];
  const coil: THREE.Vector3[] = [];
  const turns = 1.7, r0 = pierW * 1.05;
  const lift0 = top - 1.3 * pierW, lift1 = top + 0.2 * pierW;
  for (let i = 0; i <= 240; i++) {
    const t = i / 240, th = 2 * Math.PI * turns * t + (k ? Math.PI : 0);
    const r = r0 * (1 - 0.15 * Math.sin(Math.PI * t));
    coil.push(new THREE.Vector3(capital.x + r * Math.cos(th), lift0 + (lift1 - lift0) * t, capital.z + r * 0.8 * Math.sin(th)));
  }
  const helix = helixAlong(ctx, view, new THREE.CatmullRomCurve3(coil, false, 'centripetal'),
    { radius: 0.05, width: 0.42, pitch: 7, spread: 0.06, narrow: 0.06, density: 0.28, interruption: 0.2 });
  for (const h of helix.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points, slack: 0.04, owner: 9000 });

  // "bear": painted on the right pier's splayed inner face, the face the sun lights, low on its second course.
  const face = piers[1][1];
  const words: Tagged[] = faceWord(face, 'bear', { normal: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0), at: [0.25, -0.3], cap: 3.4 * toWorld })
    .map(points => ({ ink: 'carbon' as Ink, group: 'word', family: 'text' as const, points, slack: 0.03 }));

  const geometries = [...pierSlabs, ...pavers, ...city].map(slabGeometry).concat(helix.meshes);
  fitDepthRange(view, geometries, 0.1, { exact: true });
  const depthBuffer = renderDepthBufferCPU(geometries, view, W, H);
  const buckets = new PartBuckets(0.4);
  const dist = (t: Tagged) => eye.distanceTo(t.points[t.points.length >> 1]);

  const wordPaths: Point[][] = [];
  projectStrokes(words, { view, depth: depthBuffer, width: W, height: H, bias: hiddenBias(view, 0.03, dist(words[0])) }, {
    begin: () => (runs: ProjectedPoint[][]) => {
      for (const run of runs) for (const inside of clipToRect(scalePoints(run, MM_X, MM_Y), ART)) if (buckets.add('word-carbon', inside, true)) wordPaths.push(inside);
    },
  });
  const clear = glyphMask(wordPaths, 0.9, 6, PAGE);

  const byOwner = new Map<number, Tagged[]>();
  for (const st of strokes) { const list = byOwner.get(st.owner!); if (list) list.push(st); else byOwner.set(st.owner!, [st]); }
  for (const list of byOwner.values()) {
    projectStrokes(list, { view, depth: depthBuffer, width: W, height: H, bias: hiddenBias(view, list[0].slack, dist(list[0])) }, {
      begin: (st: Tagged) => (runs: ProjectedPoint[][]) => {
        for (const run of runs) for (const inside of clipToRect(scalePoints(run, MM_X, MM_Y), ART)) {
          for (const piece of keepAlong(inside, p => !clear(p), 0.15)) buckets.add(`${st.group}-${st.ink}`, piece, false, st.family === 'hatch' && MIN_FEATURE ? MIN_FEATURE : undefined);
        }
      },
    });
  }
  // The far joints and the sky lie behind the piers, the city and the helix: they give way to them on the sheet.
  const solids = [...pierSlabs, ...city].map(slabGeometry);
  const behind = meshCoverage([...solids, ...helix.meshes], view, PAGE, 0.8);
  const open = (path: Point[]) => keepAlong(path, p => !behind(p), 0.2);
  for (const [a, b] of joints) for (const inside of clipToRect([pageOf(view, a, PAGE), pageOf(view, b, PAGE)], ART)) for (const piece of open(inside)) buckets.add('far-carbon', piece, true);
  if (ctx.params.sky !== false) {
    for (const path of skyLines(ctx, 'gate-sky', { x0: ART.x0, x1: ART.x1, top: ART.y0, bottom: horizonY - 30 })) for (const piece of open(path)) buckets.add('sky-ultramarine', piece, true);
  }
  for (const g of [...geometries, ...solids]) g.dispose();

  // "weight": under the strip, sealed: off-centre in the lintel's footprint, clear of its corner ticks.
  const cap = 4;
  const weight = pageWord('weight', lintel.x0 + 0.56 * (lintel.x1 - lintel.x0), lintel.y0 + 0.3 * (lintel.y1 - lintel.y0), cap);
  const sealed = { white: [{ id: 'weight-carbon', pen: 'carbon', paths: weight }] };

  const art = routeParts(buckets.toParts(GROUPS, INKS), ROUTES);
  return renderPly(spec, ctx, pens, { cuts: { bar: [footprint] }, art, sealed });
}

const sketch: Sketch = {
  name: 'Breach triptych: Lintel R (the weight)',
  page: { ...PAGE },
  pageAware: true,
  pens,
  // The top ply is the onlay, which is never rendered: the control starts on the white sheet.
  controls: [{ type: 'select', id: spec.control, label: 'Ply', default: 'white', options: spec.plies.map(p => p.id) }, ...CONTROLS],
  assembly: spec,
  draw,
};

export default sketch;
