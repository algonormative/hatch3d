import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, slabGeometry, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong } from '../../kit/helix.ts';
import { glyphMask, groundWord, sloganSettings } from '../../kit/lettering.ts';
import { bandMarks } from '../../kit/fills.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { clamp, n, smooth } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, onGround, pageOf } from '../../kit/perspective.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { ELONGATED, gesture } from '../../kit/mannequin/gesture.ts';
import { POSES, poseSkeleton, withPose, type JointName, type Skeleton } from '../../kit/mannequin/skeleton.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { bodyFigure, figureMeshes, figureStrokes } from './figure.ts';

/**
 * I The Magician: the power, not the costume. A very small figure, a few scratches just enough to
 * make out (a line of action, a bow of arms, a leg, an open loop of a head), stands charging up in
 * a clear pocket of paper at the heart of its field. The field flares round it in a wide flame of
 * fine lines; a few tongues pass in front and break its strokes, the animator's way. The helix sweeps round
 * behind it in a rising spiral and
 * streams up into the sky; the paving at its feet and blocks all round lift and tumble upward, and the
 * ground cracks out from under it. Over
 * its head, in full view with everything cleared round it, the lemniscate: the card's flat mark.
 */
const W = 1118, H = 1728;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const FIGURE = 24;
const EYE = 9;
const FACET_MM_PER_UNIT = 8.3;
/** Hidden-line slack on the body figure's hatch and on its outlines, in world units. */
const FIGURE_SLACK = 0.08;
const FIGURE_EDGE_SLACK = 1;

export function magicianCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 4000,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/** The charging stance: feet planted wide, knees bent, arms down and out with fists clenched, the
 * back arched and the head thrown back. */
export function chargingPose(yaw = 8) {
  return withPose(gesture(POSES.stand, { arc: -20 }), {
    hip_l: { flex: 14, abduct: 22 }, hip_r: { flex: 14, abduct: 22 },
    knee_l: { flex: 30 }, knee_r: { flex: 30 }, ankle_l: { flex: 10 }, ankle_r: { flex: 10 },
    shoulder_l: { flex: -8, abduct: 38 }, shoulder_r: { flex: -8, abduct: 38 },
    elbow_l: { flex: 22 }, elbow_r: { flex: 22 },
    neck: { flex: -30 }, head: { flex: -18 },
  }, { yaw });
}

/**
 * The figure as a few scratches on the sheet, the power stance stylized to a hero's shape: the legs
 * as one wide arch from foot to foot; the torso a V from the shoulders down to the waist; the arms as
 * one bow from fist to fist across the shoulders; a tick of neck and an open loop of head.
 * Each stroke wobbles and overshoots its ends a little.
 */
export function scratchFigure(s: Skeleton, view: THREE.Camera, rng: () => number): Point[][] {
  const P = (j: JointName, end = false) => pageOf(view, s.at(j, end));
  const feet = { x: (P('ankle_l').x + P('ankle_r').x) / 2, y: (P('ankle_l').y + P('ankle_r').y) / 2 };
  const size = Math.hypot(P('head', true).x - feet.x, P('head', true).y - feet.y);
  const jit = (p: Point, a: number): Point => ({ x: p.x + (rng() - 0.5) * a * size, y: p.y + (rng() - 0.5) * a * size });
  const curve = (pts: Point[], over = 0.04, wobble = 0.018): Point[] => {
    const q = pts.map(p => jit(p, wobble));
    const ext = (a: Point, b: Point, k: number): Point => {
      const dx = a.x - b.x, dy = a.y - b.y, l = Math.hypot(dx, dy) || 1;
      return { x: a.x + dx / l * k * size, y: a.y + dy / l * k * size };
    };
    const all = [ext(q[0], q[1], over * (0.4 + rng())), ...q, ext(q[q.length - 1], q[q.length - 2], over * (0.4 + rng()))];
    return new THREE.CatmullRomCurve3(all.map(p => new THREE.Vector3(p.x, p.y, 0)), false, 'centripetal').getPoints(all.length * 10).map(v => ({ x: v.x, y: v.y }));
  };
  const out: Point[][] = [];
  // The legs: one arch, foot to foot through the pelvis.
  out.push(curve([P('ankle_l', true), P('ankle_l'), P('knee_l'), P('pelvis'), P('knee_r'), P('ankle_r'), P('ankle_r', true)], 0.04));
  // The torso: a V from each shoulder in to the waist, bowed a little.
  const waist = P('pelvis');
  for (const side of ['l', 'r'] as const) {
    const sh = P(`shoulder_${side}`), mid = P('spine');
    out.push(curve([sh, { x: (sh.x + mid.x) / 2 + (sh.x - mid.x) * 0.12, y: (sh.y + mid.y) / 2 }, waist], 0.03));
  }
  // The neck: a short tick up from between the shoulders.
  out.push(curve([P('neck'), P('head')], 0.02, 0.01));
  // The bow: fist, elbow, shoulder, across, shoulder, elbow, fist.
  out.push(curve([P('wrist_l', true), P('wrist_l'), P('elbow_l'), P('shoulder_l'), P('shoulder_r'), P('elbow_r'), P('wrist_r'), P('wrist_r', true)], 0.03));
  // The head: an open loop, three quarters round.
  const hc = { x: (P('head').x + P('head', true).x) / 2, y: (P('head').y + P('head', true).y) / 2 };
  const hr = Math.max(2.1, Math.hypot(P('head', true).x - P('head').x, P('head', true).y - P('head').y) * 0.6);
  const a0 = rng() * Math.PI * 2;
  out.push(Array.from({ length: 41 }, (_, i) => {
    const a = a0 + i / 40 * Math.PI * 1.55, r = hr * (1 + 0.1 * Math.sin(a * 3));
    return { x: hc.x + r * Math.cos(a), y: hc.y + r * 1.15 * Math.sin(a) };
  }));
  return out;
}

export function drawMagician(ctx: SketchContext): Part[] {
  const view = magicianCamera(ctx);
  const eye = view.position.clone();
  const fovT = Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const f = TABLOID_PAGE.height / 2 / fovT;
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  const halfW = (CARD.x1 - CARD.x0) / 2;
  const half = (z: number) => halfW / f * (eye.z - z);
  // Small and far: the figure stands a set height on the card.
  const figureMm = n(ctx, 'figure', 40, 14, 100);
  const depth = FIGURE * f / figureMm;
  const base = new THREE.Vector3((TABLOID_PAGE.width / 2 - (CARD.x0 + CARD.x1) / 2) / f * depth + n(ctx, 'figureX', 0, -0.3, 0.3) * half(-depth), 0, -depth);
  const light = new THREE.Vector3(0.1, 0.9, 0.5).normalize();
  const s = poseSkeleton(chargingPose(n(ctx, 'turn', 8, -60, 60)), { height: FIGURE, position: base, proportions: ELONGATED });
  const rng = ctx.random('magician-power');

  // Blocks: the paving at its feet lifting, and blocks all round, larger and higher further out.
  const blocks: Slab[] = [];
  for (let i = 0; i < Math.round(n(ctx, 'paving', 16, 0, 40)); i++) {
    const a = rng() * Math.PI * 2, r = 9 + 10 * rng();
    const sl = solid(base.x + Math.cos(a) * r, 0.6 + 6 * rng() ** 2, base.z + Math.sin(a) * r * 0.9, 3 + 3 * rng(), 0.7, 2.5 + 2 * rng(), blocks.length, 'debris');
    sl.rx = (rng() - 0.5) * 1.2; sl.ry = rng() * Math.PI; sl.rz = (rng() - 0.5) * 1.2;
    blocks.push(sl);
  }
  const count = Math.round(n(ctx, 'blocks', 44, 0, 120));
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2, r = 22 + 140 * rng() ** 1.4;
    const lift = (8 + 70 * rng() ** 1.3) * (0.4 + r / 120);
    const size = 2.5 + r * 0.09 * (0.6 + rng());
    const sl = solid(base.x + Math.cos(a) * r, lift, base.z + Math.sin(a) * r * 0.8, size * (1.4 + rng()), size * (0.25 + 0.3 * rng()), size * (0.8 + 0.6 * rng()), blocks.length, 'debris');
    sl.rx = (rng() - 0.5) * 1.6; sl.ry = rng() * Math.PI; sl.rz = (rng() - 0.5) * 1.6;
    if (eye.z - sl.z < 20) continue;
    // Keep the air round the figure and its flame clear.
    const pc = pageOf(view, new THREE.Vector3(sl.x, sl.y, sl.z)), foot = pageOf(view, base);
    if (Math.abs(pc.x - foot.x) < figureMm * 1.25 && pc.y < foot.y + 8 && pc.y > foot.y - figureMm * 3.2) continue;
    blocks.push(sl);
  }
  for (const sl of blocks) sl.tone = 0.5 + 0.7 * clamp(Math.hypot(sl.x - base.x, sl.z - base.z) / 80, 0, 1);

  // The ribbon: the helix sweeping round behind it in a rising spiral, then up into the sky.
  const k = FIGURE / 24;
  const at = (x: number, y: number, z: number) => base.clone().add(new THREE.Vector3(x * k, y * k, z * k));
  const sweep = n(ctx, 'sweep', 1, 0.5, 1.6);
  const ribbon = helixAlong(ctx, view, new THREE.CatmullRomCurve3([
    at(-20 * sweep, 2, -6), at(-15 * sweep, 12, -16), at(8 * sweep, 22, -19), at(22 * sweep, 34, -8), at(12 * sweep, 48, -19),
    at(-14 * sweep, 60, -17), at(-20 * sweep, 74, -8), at(-6, 96, -21), at(8, 140, -34), at(0, 230, -50),
  ], false, 'centripetal'), { radius: n(ctx, 'ribbon', 3.4, 1, 6) * k, width: 3 * k, pitch: 15 * k, spread: 0.4, narrow: 0.3 });

  // The field: a flame of fine lines. Each starts tight round its feet, fans out wide as it rises
  // and ends in a tongue of its own length, swaying; the ragged ends make the flame's edge.
  const fieldLines: THREE.Vector3[][] = [];
  const lines = Math.round(n(ctx, 'field', 64, 0, 140));
  const top = n(ctx, 'flame', 2.6, 1.5, 4) * FIGURE, wide = n(ctx, 'flare', 1.2, 0.5, 2) * FIGURE;
  for (let j = 0; j < lines; j++) {
    const th0 = (j + rng() * 0.6) / lines * Math.PI * 2, wob = rng() * Math.PI * 2;
    const reach = 0.45 + 0.55 * rng() ** 0.7, rb = 0.16 * FIGURE * (0.6 + 0.8 * rng());
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 140; i++) {
      const v = i / 140 * reach, y = v * top;
      const open = Math.sin(Math.PI / 2 * Math.min(1, v / 0.62)) ** 0.85 * (1 - 0.55 * smooth(0.62, 1, v));
      const r = rb + (wide - rb) * open * (1 + 0.14 * Math.sin(v * 13 + wob) * v);
      const th = th0 + 0.7 * v * v + 0.3 * v * Math.sin(v * 7 + wob);
      pts.push(new THREE.Vector3(base.x + r * Math.cos(th), y + 0.04 * FIGURE * Math.sin(v * 9 + wob) * v, base.z + r * Math.sin(th) * 0.85));
    }
    fieldLines.push(pts);
  }
  // Split each line where it crosses the figure's plane: the front runs pass before it, the back behind.
  const field: (Stroke & { front: boolean })[] = [];
  fieldLines.forEach((pts, j) => {
    let run: THREE.Vector3[] = [], front = pts[0].z > base.z;
    const flush = () => { if (run.length > 1) field.push({ ink: j % 3 === 0 ? 'violet' : 'acid', group: 'field', family: 'hatch', points: run, front }); };
    for (const p of pts) {
      const f = p.z > base.z;
      if (f !== front) { run.push(p); flush(); run = [p]; front = f; } else run.push(p);
    }
    flush();
  });

  const strokes: Stroke[] = [];
  for (const sl of blocks) {
    const at3 = new THREE.Vector3(sl.x, sl.y, sl.z);
    const scale = FACET_MM_PER_UNIT / mmPerUnit(at3);
    for (const st of facetStrokes(sl, light, eye, Math.max(sl.w, sl.h) * mmPerUnit(at3) < 2, scale)) {
      strokes.push({ ink: st.ink, group: 'blocks', family: st.family, points: st.points });
    }
  }
  for (const h of ribbon.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points });

  const geometries = [...blocks.map(slabGeometry), ...ribbon.meshes];
  try {
    const depthBuffer = renderDepthBufferCPU(geometries, view, W, H);
    // The lemniscate over its head, in full view: everything else is cleared round it.
    const crown = pageOf(view, s.at('head', true).add(new THREE.Vector3(0, n(ctx, 'infinityLift', 15, 3, 40) * k, 0)));
    const a = n(ctx, 'infinity', 16, 8, 50);
    const lemniscate: Point[] = Array.from({ length: 241 }, (_, i) => {
      const t = i / 240 * Math.PI * 2, d = 1 + Math.sin(t) ** 2;
      return { x: crown.x + a * Math.cos(t) / d, y: crown.y + a * Math.sin(t) * Math.cos(t) / d };
    });
    const band = 1.6;
    const markPaths = bandMarks(lemniscate, band, { x0: crown.x - a - 4, x1: crown.x + a + 4, y0: crown.y - a, y1: crown.y + a }, { pitch: 0.62, angle: Math.PI / 4 });
    const onMark = glyphMask([lemniscate], band + 1.4);
    // Fire and figure: page masks of the sketch and of the flame's front runs, each breaking the other.
    const pageOfAll = (lines3: THREE.Vector3[][]) => {
      const out: Point[][] = [];
      for (const line of projectPolylinesClipped(lines3, view, W, H).polylines) for (const c of clipProjectedPolyline(line, W, H)) out.push(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y));
      return out;
    };
    // The scratch figure always sets the figure's place, size and pocket, so the body (the other style) stands exactly where it stood.
    const figure = scratchFigure(s, view, ctx.random('magician-scratch'));
    // Its own ground: a pocket of paper round it, edged like a flame, where nothing else is drawn.
    const fx = figure.flat().map(p => p.x), fy = figure.flat().map(p => p.y);
    const pc = { x: (Math.min(...fx) + Math.max(...fx)) / 2, y: (Math.min(...fy) + Math.max(...fy)) / 2 - 0.08 * (Math.max(...fy) - Math.min(...fy)) };
    const prx = (Math.max(...fx) - Math.min(...fx)) / 2 * n(ctx, 'pocket', 1.6, 1, 3) + 3, pry = (Math.max(...fy) - Math.min(...fy)) / 2 * 1.3 + 3;
    const pph = rng() * Math.PI * 2;
    const inPocket = (p: Point) => {
      const dx = (p.x - pc.x) / prx, dy = (p.y - pc.y) / pry, a = Math.atan2(dy, dx);
      return Math.hypot(dx, dy) < 1 + 0.12 * Math.sin(5 * a + pph) + 0.07 * Math.sin(9 * a + 2 * pph) + (dy < 0 ? 0.15 * Math.max(0, -Math.sin(a)) : 0);
    };
    // A few tongues in front still cross the pocket and break its strokes.
    const veil = n(ctx, 'veil', 0.18, 0, 1);
    const veilLine = (f: { front: boolean }, i: number) => f.front && ((i * 37) % 100) / 100 < veil;
    const onFlameFront = glyphMask(pageOfAll(field.filter(veilLine).map(f => f.points)), 0.32);

    // The phrase, painted on the ground round it, staggered, each word where it can be seen whole.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
    const style = { face: settings.face, height: settings.size + 0.4 };
    const wrng = ctx.random('magician-words');
    const textStrokes: THREE.Vector3[][] = [];
    const taken: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const cover = meshCoverage(geometries, view, TABLOID_PAGE, 2);
    const top2 = HORIZON_Y + 6, bottom = CARD.y1 - 5;
    let side = wrng() < 0.5 ? -1 : 1, lastY = top2 - 8;
    words.forEach((word, i) => {
      const hw = measureStrokeText(word, style) / 2 + 3;
      for (let attempt = 0; attempt < 200; attempt++) {
        const yy = top2 + (bottom - top2) * clamp((i + 0.5) / words.length + (wrng() - 0.5) * 0.3 * (1 + attempt / 20), 0, 1);
        if (yy < lastY + 2.5) continue;
        const xx = clamp((CARD.x0 + CARD.x1) / 2 + side * (10 + 90 * wrng()), CARD.x0 + hw + 2, CARD.x1 - hw - 2);
        const box = { x0: xx - hw - 3, x1: xx + hw + 3, y0: yy - 4, y1: yy + 4 };
        if (taken.some(b => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
        const word3 = groundWord(view, word, { x: xx, y: yy }, style);
        let blocked = false;
        for (const path3 of word3) for (const q of path3) if (cover(pageOf(view, q))) blocked = true;
        if (blocked) continue;
        textStrokes.push(...word3);
        taken.push(box);
        lastY = yy;
        break;
      }
      side = -side;
    });
    const glyphPaths: Point[][] = [];
    for (const line of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(line, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, 0.6);
    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], extra: (p: Point) => boolean = () => true) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && !onMark(p) && extra(p), 0.15)) buckets.add(key, piece);
    };
    projectStrokes(strokes, { view, depth: depthBuffer, width: W, height: H }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y), p => !inPocket(p)); },
    });
    projectStrokes(field, { view, depth: depthBuffer, width: W, height: H }, {
      begin: (st, i) => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y), veilLine(st, i) ? () => true : p => !inPocket(p)); },
    });
    if (ctx.params.figureStyle === 'body') {
      // The body, fitted to the scratch figure's box on the sheet (same height, same ground, same middle), hatched in carbon and
      // hidden-line tested against itself alone: its own depth pass, fitted close, so a small figure keeps its detail.
      const box = { x0: Math.min(...fx), x1: Math.max(...fx), y0: Math.min(...fy), y1: Math.max(...fy) };
      const pose = chargingPose(n(ctx, 'turn', 8, -60, 60));
      const place = base.clone();
      let height = FIGURE;
      let fig = bodyFigure(pose, height, place);
      for (let pass = 0; pass < 3; pass++) {
        const geos = figureMeshes(fig);
        const seen = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
        const v = new THREE.Vector3();
        for (const g of geos) {
          const pos = g.getAttribute('position');
          for (let i = 0; i < pos.count; i++) {
            const q = pageOf(view, v.fromBufferAttribute(pos, i));
            seen.x0 = Math.min(seen.x0, q.x); seen.x1 = Math.max(seen.x1, q.x); seen.y0 = Math.min(seen.y0, q.y); seen.y1 = Math.max(seen.y1, q.y);
          }
          g.dispose();
        }
        height *= (box.y1 - box.y0) / (seen.y1 - seen.y0);
        place.x += ((box.x0 + box.x1) / 2 - (seen.x0 + seen.x1) / 2) / f * (eye.z - place.z);
        fig = bodyFigure(pose, height, place);
      }
      const lit = (_p: THREE.Vector3, normal: THREE.Vector3) => clamp(0.9 * (1 - Math.max(0, normal.dot(new THREE.Vector3(-0.5, 0.55, 0.7).normalize()))) ** 1.3 + 0.04, 0, 1);
      const forward = new THREE.Vector3();
      view.getWorldDirection(forward);
      const env = { forward, density: 0.4, dark: lit, screen: (p: THREE.Vector3) => { const q = pageOf(view, p); return { x: q.x, y: q.y }; } };
      const figGeos = figureMeshes(fig);
      const figView = view.clone();
      try {
        fitDepthRange(figView, figGeos);
        const figDepth = renderDepthBufferCPU(figGeos, figView, W, H);
        const biasAt = (tol: number) => tol * figView.far * figView.near / ((figView.far - figView.near) * (eye.z - place.z) ** 2);
        const lines = figureStrokes(fig, env);
        // An outline runs along the edge where the surface turns away from the eye, so its depth changes fastest there: it gets more slack than the hatch.
        for (const edge of [false, true]) {
          projectStrokes(lines.filter(st => (st.group === 'figure-edge') === edge), { view: figView, depth: figDepth, width: W, height: H, bias: biasAt(edge ? FIGURE_EDGE_SLACK : FIGURE_SLACK) }, {
            begin: () => runs => { for (const run of runs) add('figure-carbon', scalePoints(run, MM_X, MM_Y), p => !onFlameFront(p)); },
          });
        }
      } finally {
        for (const g of figGeos) g.dispose();
      }
    } else {
      for (const path of figure) add('figure-carbon', path, p => !onFlameFront(p));
    }
    // The ground: dark rows, the field's light pooled round its feet.
    const rows: Stroke[] = [];
    for (let y = HORIZON_Y + 0.6, i = 0; y < CARD.y1; y += 0.7, i++) {
      const z = onGround(view, { x: TABLOID_PAGE.width / 2, y }).z;
      const reachX = half(z) + 2;
      const pts: THREE.Vector3[] = [], keep: boolean[] = [];
      for (let q = 0; q <= 200; q++) {
        const px = base.x - reachX + 2 * reachX * q / 200;
        const r = Math.hypot((px - base.x) / (wide * 1.8), (z - base.z) / (wide * 1.3));
        pts.push(new THREE.Vector3(px, 0.02, z));
        keep.push(r > 1 && (i % 3 === 0 || (i % 3 === 1 && r > 1.8)));
      }
      let run: THREE.Vector3[] = [];
      for (let q = 0; q < pts.length; q++) {
        if (keep[q]) run.push(pts[q]);
        else { if (run.length > 1) rows.push({ ink: i % 4 === 0 ? 'ultramarine' : 'carbon', group: 'ground', family: 'hatch', points: run }); run = []; }
      }
      if (run.length > 1) rows.push({ ink: i % 4 === 0 ? 'ultramarine' : 'carbon', group: 'ground', family: 'hatch', points: run });
    }
    // The shockwave: cracks running from the pocket's foot across the ground toward us, drawn on the
    // sheet (the ground is a plane) so they keep an even scale; the rows break round them.
    const crng = ctx.random('magician-cracks');
    const cracks: Point[][] = [];
    const crack = (from: Point, a: number, length: number, forks: number) => {
      const pts = [from];
      let p = from, dir = a;
      for (let travelled = 0; travelled < length;) {
        const step = 3.5 + 5 * crng();
        dir = clamp(dir + (crng() - 0.5) * 0.5 + (crng() < 0.12 ? (crng() - 0.5) * 1.2 : 0), 0.15, Math.PI - 0.15);
        p = { x: p.x + Math.cos(dir) * step, y: p.y + Math.sin(dir) * step * 0.8 };
        if (p.y > CARD.y1 || p.x < CARD.x0 || p.x > CARD.x1) break;
        pts.push(p);
        travelled += step;
        if (forks > 0 && crng() < 0.08) crack(p, dir + (crng() < 0.5 ? -1 : 1) * (0.35 + 0.4 * crng()), (length - travelled) * 0.5, forks - 1);
      }
      if (pts.length > 1) cracks.push(pts);
    };
    const foot = pageOf(view, base);
    const spokes = Math.round(n(ctx, 'cracks', 7, 0, 30));
    for (let i = 0; i < spokes; i++) {
      const a = Math.PI / 2 + ((i + 0.2 + 0.6 * crng()) / spokes - 0.5) * 2.4;
      crack({ x: foot.x + Math.cos(a) * 4, y: foot.y + 2 + Math.sin(a) * 2 }, a, 40 + 120 * crng(), 2);
    }
    const onCrack = glyphMask(cracks, 0.7);
    for (const path of cracks) add('cracks-carbon', path, p => !inPocket(p));
    projectStrokes(rows, { view, depth: depthBuffer, width: W, height: H }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y), p => !onCrack(p) && !inPocket(p)); },
    });
    for (const path of markPaths) for (const inside of clipWindow(path)) buckets.add('mark-carbon', inside);
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['ground', 'cracks', 'blocks', 'field', 'helix', 'figure', 'mark', 'slogan'], INKS);
    const solidThings = meshCoverage(geometries, view, TABLOID_PAGE, 0.4);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solidThings(p) && !onMark(p) && !inPocket(p), 0.3) });
    parts.push(...cardFrame('I', 'THE MAGICIAN'));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
