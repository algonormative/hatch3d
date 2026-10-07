import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, slabGeometry, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong } from '../../kit/helix.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { bandMarks } from '../../kit/fills.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { horizonCamera, onGround, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';

/**
 * The Machine: a study kept for later (first drawn as a reading of I The Magician, 2026-10-06; the
 * owner set it aside for another use). Every tool is already on the table. No magic, no magician: the machine, firing
 * on all cylinders. A stout supercomputer after the Cray: a C of wedge columns open toward us, each
 * a stack of thin blades, with a bench ring round its base (the table). Every blade carries a row
 * of status ticks blinking in the 64-step rhythm, all of them lit. Out of the open core the helix
 * rises into the sky: what the machine raises. The flat mark is a hatched square wave across the
 * sky, the clock it runs on. Dark coursed piers frame it; the floor falls dark away from it.
 */
const W = 1118, H = 1728;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 9;
const FACET_MM_PER_UNIT = 8.3;

export function machineCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 3000,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/** The machine: wedge columns of thin blades in a C, open toward the eye, and the bench ring round them. */
export function machine(ctx: SketchContext, base: THREE.Vector3) {
  const R = n(ctx, 'ring', 11, 6, 15), inner = R * 0.42, height = n(ctx, 'height', 24, 8, 34);
  const columns = Math.round(n(ctx, 'columns', 14, 8, 20));
  const open = n(ctx, 'open', 1.1, 0.4, 1.6);
  const turn = n(ctx, 'turn', -0.62, -1.2, 1.2);
  const plate = n(ctx, 'plate', 0.42, 0.25, 0.9), gap = 0.09;
  const blades: Slab[] = [], bench: Slab[] = [];
  /** Outward direction at angle a, measured from the eye-ward axis. */
  const out = (a: number) => new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
  const step = (Math.PI * 2 - open) / columns;
  const rm = (R + inner) / 2;
  const angles = Array.from({ length: columns }, (_, c) => turn + open / 2 + (c + 0.5) * step);
  for (const [c, a] of angles.entries()) {
    const u = out(a), chord = 2 * rm * Math.sin(step / 2) * 0.97;
    for (let y = plate / 2 + 0.05; y + plate / 2 < height; y += plate + gap) {
      const s = solid(base.x + u.x * rm, y, base.z + u.z * rm, chord, plate, R - inner, blades.length, 'stack');
      s.ry = a;
      blades.push(s);
    }
    // The bench: a low base and a cushion, round the outside of each column.
    const b0 = R + 0.25, b1 = R + 3.1, bm = (b0 + b1) / 2, bchord = 2 * bm * Math.sin(step / 2) * 0.97;
    const lower = solid(base.x + u.x * bm, 1.25, base.z + u.z * bm, bchord, 2.5, b1 - b0, 1000 + c, 'stack');
    const cushion = solid(base.x + u.x * (bm + 0.15), 3.05, base.z + u.z * (bm + 0.15), bchord * 1.02, 1.1, b1 - b0 + 0.3, 2000 + c, 'stack');
    lower.ry = a; cushion.ry = a;
    bench.push(lower, cushion);
  }
  return { blades, bench, height, R, inner, angles, step };
}

export function drawMachine(ctx: SketchContext): Part[] {
  const view = machineCamera(ctx);
  const eye = view.position.clone();
  const fovT = Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const f = TABLOID_PAGE.height / 2 / fovT;
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  const halfW = (CARD.x1 - CARD.x0) / 2;
  const half = (z: number) => halfW / f * (eye.z - z);
  // It stands so its top rises to a set height on the card, looming over a low eye.
  const topY = CARD.y0 + n(ctx, 'top', 0.3, 0.12, 0.5) * (CARD.y1 - CARD.y0);
  const depth = (n(ctx, 'height', 24, 8, 34) - EYE) * f / (HORIZON_Y - topY);
  const base = new THREE.Vector3((TABLOID_PAGE.width / 2 - (CARD.x0 + CARD.x1) / 2) / f * depth, 0, -depth);
  const light = new THREE.Vector3(-0.35, 0.8, 0.6).normalize();
  const m = machine(ctx, base);
  // Solid and dark: the blades heavy, the bench a shade lighter.
  for (const sl of m.blades) sl.tone = 0.85;
  for (const sl of m.bench) sl.tone = 0.8;

  // The stage: dark piers of thin courses at the card's edges.
  const rng = ctx.random('magician-stage');
  const stage: Slab[] = [];
  const pz = base.z - m.R - 4, reach = half(pz);
  for (const sx of [-1, 1]) for (let y = 0.45, i = 0; y < 90; y += 0.95, i++) {
    const sl = solid(base.x + sx * (reach + 0.4 + (rng() - 0.5) * 0.3), y, pz + (rng() - 0.5) * 0.4, 4.2 + 0.7 * (i % 3), 0.85, 4, stage.length, 'pier');
    sl.ry = (rng() - 0.5) * 0.04;
    sl.tone = 1.3;
    stage.push(sl);
  }

  // The helix, rising out of the open core into the sky.
  const core = base.clone().setY(m.height * 0.35);
  const rise = helixAlong(ctx, view, new THREE.CatmullRomCurve3([core, core.clone().setY(m.height + 6), core.clone().add(new THREE.Vector3(-0.8, m.height + 60, -6))], false, 'centripetal'),
    { radius: n(ctx, 'helixRadius', 1.7, 1, 4), width: 1.2, pitch: 9, spread: 0.2, narrow: 0.15 });

  // Firing on all cylinders: a row of status ticks along each blade's outer face, in the rhythm.
  const lrng = ctx.random('magician-lights');
  const patterns = Array.from({ length: 8 }, () => barPattern(lrng, 0.62));
  const lights: Stroke[] = [];
  m.blades.forEach((sl, i) => {
    const u = new THREE.Vector3(Math.sin(sl.ry), 0, Math.cos(sl.ry)), t = new THREE.Vector3(Math.cos(sl.ry), 0, -Math.sin(sl.ry));
    const face = new THREE.Vector3(sl.x, sl.y, sl.z).addScaledVector(u, sl.d / 2 + 0.02);
    const pattern = patterns[i % 8], K = 7;
    for (let k = 0; k < K; k++) {
      if (!pattern[(i * 5 + k) % 64]) continue;
      const x0 = -sl.w / 2 + (k + 0.12) * sl.w / K, x1 = -sl.w / 2 + (k + 0.88) * sl.w / K;
      lights.push({ ink: (i + k) % 3 === 2 ? 'acid' : 'vermilion', group: 'lights', family: 'hatch', points: [face.clone().addScaledVector(t, x0), face.clone().addScaledVector(t, x1)] });
    }
  });

  const strokes: Stroke[] = [];
  for (const [group, slabs] of [['stage', stage], ['machine', m.blades], ['bench', m.bench]] as const) for (const sl of slabs) {
    const scale = FACET_MM_PER_UNIT / mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z));
    for (const st of facetStrokes(sl, light, eye, false, scale)) strokes.push({ ink: st.ink, group, family: st.family, points: st.points });
  }
  strokes.push(...lights);
  for (const h of rise.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points });

  const geometries = [...stage, ...m.blades, ...m.bench].map(slabGeometry).concat(rise.meshes);
  try {
    const depthBuffer = renderDepthBufferCPU(geometries, view, W, H);
    // The phrase, cut into the outer faces of the bench ring (the table), a word to a segment, in
    // reading order round the ring from the viewer's left, each at its own height.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
    const style = { face: settings.face, height: settings.size };
    const wrng = ctx.random('magician-words');
    const textStrokes: THREE.Vector3[][] = [];
    const toEye = (sl: Slab) => new THREE.Vector3(Math.sin(sl.ry), 0, Math.cos(sl.ry)).dot(eye.clone().sub(new THREE.Vector3(sl.x, 0, sl.z)).normalize());
    const faces = m.bench.filter((sl, i) => i % 2 === 0 && toEye(sl) > 0.35)
      .sort((a, b) => pageOf(view, new THREE.Vector3(a.x, a.y, a.z)).x - pageOf(view, new THREE.Vector3(b.x, b.y, b.z)).x);
    const per = faces.length ? Math.max(1, Math.ceil(words.length / faces.length)) : 0;
    words.forEach((word, i) => {
      const sl = faces[Math.floor(i / per)];
      if (!sl) return;
      const u = new THREE.Vector3(Math.sin(sl.ry), 0, Math.cos(sl.ry)), t = new THREE.Vector3(Math.cos(sl.ry), 0, -Math.sin(sl.ry));
      const face = new THREE.Vector3(sl.x, sl.y, sl.z).addScaledVector(u, sl.d / 2 + 0.03);
      const unit = 1 / mmPerUnit(face);
      const w = measureStrokeText(word, style) * unit;
      if (w > sl.w - 0.4) return;
      const slot = i % per, x0 = -sl.w / 2 + 0.2 + (sl.w - 0.4 - w) * (per > 1 ? slot / (per - 1) : wrng());
      const y0 = sl.h / 2 - 0.35 - (sl.h - 0.7 - style.height * unit) * wrng();
      for (const path of strokeText(word, 0, 0, style)) textStrokes.push(path.map(q => face.clone().addScaledVector(t, x0 + q.x * unit).add(new THREE.Vector3(0, y0 - q.y * unit, 0))));
    });
    const glyphPaths: Point[][] = [];
    for (const line of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(line, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, 0.6);
    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[]) => { for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p), 0.15)) buckets.add(key, piece); };
    projectStrokes(strokes, { view, depth: depthBuffer, width: W, height: H }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y)); },
    });
    // The floor: dark rows, falling away from the light the machine stands in.
    const rows: Stroke[] = [];
    for (let y = HORIZON_Y + 0.6, i = 0; y < CARD.y1; y += 0.7, i++) {
      const z = onGround(view, { x: TABLOID_PAGE.width / 2, y }).z;
      const reachX = half(z) + 2;
      const pts: THREE.Vector3[] = [], keep: boolean[] = [];
      for (let q = 0; q <= 160; q++) {
        const px = base.x - reachX + 2 * reachX * q / 160;
        const r = Math.hypot((px - base.x) / (m.R + 6), (z - base.z) / (m.R + 4));
        pts.push(new THREE.Vector3(px, 0.02, z));
        keep.push(r > 1 && (i % 2 === 0 || r > 1.5));
      }
      let run: THREE.Vector3[] = [];
      for (let q = 0; q < pts.length; q++) {
        if (keep[q]) run.push(pts[q]);
        else { if (run.length > 1) rows.push({ ink: i % 4 === 0 ? 'ultramarine' : 'carbon', group: 'floor', family: 'hatch', points: run }); run = []; }
      }
      if (run.length > 1) rows.push({ ink: i % 4 === 0 ? 'ultramarine' : 'carbon', group: 'floor', family: 'hatch', points: run });
    }
    projectStrokes(rows, { view, depth: depthBuffer, width: W, height: H }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y)); },
    });
    // The flat mark: the clock, a hatched square wave across the sky, behind everything standing.
    const solidThings = meshCoverage(geometries, view, TABLOID_PAGE, 1.2);
    const cy = CARD.y0 + n(ctx, 'clockY', 0.2, 0.08, 0.45) * (CARD.y1 - CARD.y0);
    const amp = n(ctx, 'clockAmp', 7, 3, 14), period = n(ctx, 'clockPeriod', 34, 16, 60);
    const wave: Point[] = [];
    for (let x = CARD.x0 - period, k = 0; x < CARD.x1 + period; x += period / 2, k++) {
      const y = cy + (k % 2 ? amp : -amp);
      wave.push({ x, y }, { x: x + period / 2, y });
    }
    const box = { x0: CARD.x0, x1: CARD.x1, y0: cy - amp - 4, y1: cy + amp + 4 };
    for (const path of bandMarks(wave, 1.5, box, { pitch: 0.65, angle: Math.PI / 4 })) {
      for (const inside of clipWindow(path)) for (const piece of keepAlong(inside, p => !solidThings(p), 0.12)) buckets.add('clock-carbon', piece);
    }
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['stage', 'floor', 'bench', 'machine', 'lights', 'helix', 'clock', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solidThings(p), 0.3) });
    parts.push(...cardFrame('I', 'THE MAGICIAN'));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
