import * as THREE from 'three';
import type { Part, Point, Sketch, SketchContext } from '../../src/sketch/types.ts';
import { buildSurfaceMesh, type ProjectedPoint } from '../../src/projection.ts';
import { renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { HEM, agentFigure, cutTube, headCoil, type AgentHead } from '../kit/agent.ts';
import { MIN_FEATURE, PAGE, halo, layoutLength, tolerance } from '../kit/format.ts';
import { hatchedBar } from '../kit/fills.ts';
import { helixAlong } from '../kit/helix.ts';
import { clipToRect, keepAlong, meshCoverage } from '../kit/page.ts';
import { n } from '../kit/params.ts';
import { fitDepthRange, pageOf } from '../kit/perspective.ts';
import { TABLOID_PAGE } from '../phase-garden/poster.ts';
import { facetStrokes, slabGeometry, solid, type Slab } from '../kit/slabs.ts';
import { PartBuckets, hiddenBias, projectStrokes, scalePoints } from '../kit/strokes.ts';
import type { Ink, Stroke } from '../kit/types.ts';
import { LOOK, toneField, type ToneEnv } from '../kit/mannequin/hatch.ts';
import type { JointAngles, JointName, Proportions } from '../kit/mannequin/skeleton.ts';
import { HEMS, pinstripeTube, suitFront } from '../kit/mannequin/suit.ts';
import { silhouettes, type ClothStroke, type Tube } from '../kit/mannequin/tube.ts';

/**
 * A worked example of the kit's agent zoomed in: a seated bust from below that fills an 11 x 17 sheet (tabloid only). The
 * recipe is the doc comment of `kit/agent.ts`: a raw perspective camera looking up, the figure built big enough for its
 * pinstripes (`scale`), the exact depth fit, a tight hidden-line slack, outlines tested against the eye, the head's aura
 * sized with `reach`, a censor bar sized to the projected head, and background slabs hatched in page millimetres.
 * It draws the figure and the slabs only: no hands (the sleeves end in a flat disc up close), no throne, no card frame.
 */

/** The Emperor's pose and proportions, the figure `agentFigure` was promoted from. */
const SIT: Partial<Record<JointName, JointAngles>> = {
  hip_l: { flex: 90, abduct: 3 }, hip_r: { flex: 90, abduct: 3 },
  knee_l: { flex: 90 }, knee_r: { flex: 90 },
  shoulder_l: { flex: 0, abduct: 12, twist: 6 }, shoulder_r: { flex: 0, abduct: 12, twist: 6 },
  elbow_l: { flex: 90 }, elbow_r: { flex: 90 },
  wrist_l: { flex: -70 }, wrist_r: { flex: -70 },
  neck: { flex: -24, twist: -30 }, head: { flex: -12, twist: -15 },
};
const BROAD: Proportions = { shoulderX: 1.28, hipX: 1.12 };
const BUILD = 1.3;

const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
const GROUPS = ['slab', 'figure', 'contour', 'helix', 'bar'] as const;

/** The depth raster, 11 x 17 in units of 148 px: 4.096 Mpx, under the CPU depth pass's 4.19 Mpx budget. */
const UNIT_PX = 148;
const W = 11 * UNIT_PX, H = 17 * UNIT_PX;
const MM_X = PAGE.width / W, MM_Y = PAGE.height / H;
const MARGIN = 9;
const CLIP = { x0: MARGIN, x1: PAGE.width - MARGIN, y0: MARGIN, y1: PAGE.height - MARGIN };

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

/** A stroke with the slack its hidden-line test allows. */
type Tagged = Stroke & { slack: number };

const sketch: Sketch = {
  name: 'Agent bust (kit example)',
  page: TABLOID_PAGE,
  pens: [
    { id: 'carbon', color: '#22282c', width: 0.25 },
    { id: 'ultramarine', color: '#3c49aa', width: 0.25 },
    { id: 'vermilion', color: '#d04b3c', width: 0.25 },
    { id: 'acid', color: '#a5a938', width: 0.25 },
    { id: 'violet', color: '#776090', width: 0.25 },
  ],
  controls: [
    { type: 'slider', id: 'scale', label: 'World units per canon unit (6 or more)', default: 6, min: 2, max: 30, step: 0.5, group: 'Figure' },
    { type: 'slider', id: 'density', label: 'Suit line density', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Figure' },
    { type: 'slider', id: 'slack', label: 'Figure hidden-line slack (of its scale)', default: 0.15, min: 0.01, max: 2, step: 0.01, group: 'Figure' },
    { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 30, max: 80, step: 1, group: 'Camera' },
    { type: 'slider', id: 'pitch', label: 'Looking up', default: 25, min: 0, max: 60, step: 1, units: '°', group: 'Camera' },
    { type: 'slider', id: 'fitMargin', label: 'Margin the shoulders are fitted inside', default: 40, min: 0, max: 60, step: 1, units: 'mm', group: 'Camera' },
    { type: 'slider', id: 'headAt', label: 'Head centre, share of the sheet down', default: 0.33, min: 0.1, max: 0.6, step: 0.01, group: 'Camera' },
    { type: 'slider', id: 'reach', label: 'Reach of the head\'s light (canon units)', default: 2, min: 0.5, max: 8, step: 0.1, group: 'Light' },
    { type: 'slider', id: 'value', label: 'Value far from the head', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Light' },
    { type: 'slider', id: 'glow', label: 'Reach of the head\'s light (unused: reach overrides it)', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Light' },
    { type: 'slider', id: 'impression', label: 'Breakup of the value', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Light' },
    { type: 'slider', id: 'slabMm', label: 'Slab hatch pitch', default: 7, min: 3, max: 20, step: 0.5, units: 'mm', group: 'Slabs' },
  ],
  draw(ctx: SketchContext): Part[] {
    const K = n(ctx, 'scale', 6, 2, 30);
    const FOV = n(ctx, 'fov', 54, 30, 80);
    const pitch = THREE.MathUtils.degToRad(n(ctx, 'pitch', 25, 0, 60));

    // The figure, at the Emperor's settings, seated at the origin and turned toward the viewer's left.
    const yaw = -THREE.MathUtils.degToRad(36);
    const fig = agentFigure({ height: 24 * K, anchor: new THREE.Vector3(), yaw, pose: SIT, proportions: BROAD, build: BUILD, facets: 6, bow: 0.015, hem: HEM });
    const { body, head, stops } = fig;
    const arms = body.limbs.filter(t => t.id.startsWith('arm'));

    // The camera: on the figure's front, below the head, looking up. The shoulders (the trunk from the chest up) fill the
    // sheet between its margins; the head's centre sits `headAt` of the way down it; the chest runs off the foot of the page.
    const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const makeCamera = (target: THREE.Vector3, D: number) => {
      const c = new THREE.PerspectiveCamera(FOV, W / H, 1, 1e6);
      c.position.copy(target).add(new THREE.Vector3(0, -Math.sin(pitch), Math.cos(pitch)).multiplyScalar(D));
      c.lookAt(target);
      c.updateMatrixWorld();
      c.updateProjectionMatrix();
      return c;
    };
    const bust: THREE.Vector3[] = [...headCoil(head)];
    for (let i = 0; i <= 16; i++) for (let j = 0; j < 24; j++) bust.push(body.trunk.point(0.62 + 0.38 * i / 16, j / 24));
    let target = head.centre.clone().lerp(fig.skeleton.at('chest'), 0.4), D = 40 * K;
    const margin = n(ctx, 'fitMargin', 40, 0, 60), headAt = n(ctx, 'headAt', 0.33, 0.1, 0.6);
    for (let it = 0; it < 60; it++) {
      const c = makeCamera(target, D);
      const ps = bust.map(p => pageOf(c, p, PAGE));
      const x0 = Math.min(...ps.map(p => p.x)), x1 = Math.max(...ps.map(p => p.x));
      const right = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 1);
      const dx = (x0 + x1) / 2 - PAGE.width / 2, dy = pageOf(c, head.centre, PAGE).y - headAt * PAGE.height;
      target = target.clone().addScaledVector(right, dx * D / f).addScaledVector(up, -dy * D / f);
      D *= (x1 - x0) / (PAGE.width - 2 * margin);
    }
    const view = makeCamera(target, D);
    const eye = view.position.clone();
    const forward = new THREE.Vector3();
    view.getWorldDirection(forward);
    const mmPerUnit = (p: THREE.Vector3) => f / -p.clone().applyMatrix4(view.matrixWorldInverse).z;

    // The tone: the head is the light, its aura sized to the head with `reach` (canon units).
    const aura = toneField(ctx, head.centre.clone().divideScalar(K), { noiseKey: 'bust-aura', reach: n(ctx, 'reach', 2, 0.5, 8) });
    const env: ToneEnv = { density: n(ctx, 'density', 0.45, 0, 1), dark: (p, nrm) => aura(p.clone().divideScalar(K), nrm), screen: p => pageOf(view, p, PAGE) };

    const strokes: Tagged[] = [];
    const slack = n(ctx, 'slack', 0.15, 0.01, 2) * K;
    const cloth = (list: ClothStroke[]) => {
      for (const st of list) strokes.push({ ink: st.ink, group: st.group, family: st.family ?? 'hatch', points: st.points, slack });
    };
    // The suit: pinstripes along each piece, the lapels and tie, the cuffs; outlines tested against the eye.
    cloth(pinstripeTube(body.trunk, env, HEMS.trunk, LOOK));
    cloth(suitFront(body.trunk, env, LOOK));
    for (const t of arms) {
      const stop = stops.get(t.id)!;
      cloth(pinstripeTube(t, env, { seams: [0.5], hems: [], stop: stop - 0.012, cuffs: [stop - 0.035] }, LOOK));
    }
    const sleeves = arms.map(t => cutTube(t, stops.get(t.id)!));
    for (const t of [body.trunk, ...sleeves]) cloth(silhouettes(t, { forward, eye }, { ink: LOOK.edge, group: LOOK.contour }));

    // The head: the helix wound along the coil.
    const helix = helixAlong(ctx, view, new THREE.CatmullRomCurve3(headCoil(head), false, 'centripetal'),
      { radius: 0.12 * K, width: 0.5 * K, pitch: 9 * K, spread: 0.1 * K, narrow: 0.08 * K, density: 0.45, interruption: 0.1 });
    for (const h of helix.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points, slack });

    // The background: two large slabs, hatched at a pitch in page millimetres (mm / mmPerUnit), not world units.
    const right = new THREE.Vector3().setFromMatrixColumn(view.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(view.matrixWorld, 1);
    const back = forward.clone().setY(0).normalize();
    const slabs: Slab[] = [];
    const place = (r: number, u: number, b: number, w: number, h: number, d: number, ry: number) => {
      const c = head.centre.clone().addScaledVector(right, r * K).addScaledVector(up, u * K).addScaledVector(back, b * K);
      const sl = solid(c.x, c.y, c.z, w * K, h * K, d * K, slabs.length, 'stack');
      sl.ry = ry;
      slabs.push(sl);
    };
    place(9, 8, 26, 16, 80, 9, 0.5);
    place(-12, -4, 38, 30, 56, 9, -0.35);
    const slabSlack = new Map<Slab, number>();
    for (const sl of slabs) {
      const at = new THREE.Vector3(sl.x, sl.y, sl.z), toHead = head.centre.clone().sub(at).normalize();
      sl.tone = 2.4 * env.dark(at, toHead) - 1.1;
      slabSlack.set(sl, Math.max(0.12, Math.min(0.5 * Math.max(1, K / 4), 0.25 * Math.min(sl.w, sl.h, sl.d))));
      for (const st of facetStrokes(sl, toHead, eye, false, n(ctx, 'slabMm', 7, 3, 20) / mmPerUnit(at))) {
        strokes.push({ ink: 'carbon', group: 'slab', family: st.family, points: st.points, slack: slabSlack.get(sl)!, owner: slabs.indexOf(sl) });
      }
    }

    // The depth pass, fitted from the exact vertex depths, at a raster finer than the card's own.
    const figureGeos = [body.trunk.mesh(192, body.trunk.facets * 4), ...sleeves.flatMap(cutMeshes), ...helix.meshes, skull(head)];
    const geometries = [...slabs.map(slabGeometry), ...figureGeos];
    fitDepthRange(view, geometries, 0.1, { exact: true });
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    const solids = meshCoverage(figureGeos, view, PAGE, halo(1.1));

    // The censor bar: flat on the sheet across the eyes, sized to the projected head.
    const eyes = pageOf(view, head.centre.clone().addScaledVector(head.face, 0.9 * head.r).addScaledVector(head.axis, 0.12 * head.r), PAGE);
    const headMm = 2 * head.r * mmPerUnit(head.centre);
    const brng = ctx.random('bust-censor');
    const tilt = (brng() < 0.5 ? -1 : 1) * (0.06 + 0.1 * (0.5 + brng()));
    const bar = hatchedBar({ cx: eyes.x, cy: eyes.y, l: 1.75 * headMm, h: 0.36 * headMm }, tilt, [[Math.PI / 3, 0.62], [-Math.PI / 3, 0.9]],
      layoutLength(1.1), tolerance(layoutLength(1.6)), MIN_FEATURE);
    const onBar = inQuad(bar.quad, halo(1.4));

    // Hidden lines, tested in bands of eye distance: the bias (`hiddenBias`) turns a world slack into window depth at one
    // distance, so a stroke is tested at the bias of the distance band it lies in.
    const BANDS = 12;
    const dist = (t: Tagged) => eye.distanceTo(t.points[t.points.length >> 1]);
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
    const buckets = new PartBuckets(0.4);
    for (const g of groups.values()) {
      projectStrokes(g.strokes, { view, depth, width: W, height: H, bias: g.bias }, {
        begin: (st: Tagged) => (runs: ProjectedPoint[][]) => {
          for (const run of runs) {
            const keep = st.owner === undefined ? () => true : (p: Point) => !solids(p);
            for (const inside of clipToRect(scalePoints(run, MM_X, MM_Y), CLIP)) {
              for (const piece of keepAlong(inside, p => !onBar(p) && keep(p), 0.15)) buckets.add(`${st.group}-${st.ink}`, piece, false, st.family === 'hatch' && MIN_FEATURE ? MIN_FEATURE : undefined);
            }
          }
        },
      });
    }
    for (const path of bar.paths) buckets.add('bar-carbon', path, true);
    for (const g of geometries) g.dispose();
    return buckets.toParts(GROUPS, INKS);
  },
};

export default sketch;
