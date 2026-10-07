import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { bandMarks } from '../../kit/fills.ts';
import { keepAlong, meshCoverage, pathLength } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';

/**
 * II The High Priestess: there is a direction you cannot point. She keeps the hidden knowledge, and
 * here that is the fourth dimension, which we only ever see as a shadow. No figure: two pillar towers
 * of slab courses stand either side of the axis, one dark and heavily hatched, one light and barely
 * drawn, joined by a lintel. Between them hangs the veil, a flat plane of fine vertical threads,
 * the calmest field on the card. On the veil lies the card's one flat mark: the shadow of a
 * tesseract (16 vertices at ±1 in four dimensions, 32 edges), turned in two planes that involve w,
 * perspective-divided to 3D and cast onto the veil, each edge a narrow hatched band with the threads
 * knocked out round it. The phrase is cut into the pillars' faces, word by word, alternating sides.
 */
const W = 1118, H = 1728;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 6;
const FACET_MM_PER_UNIT = 8.3;
const COURSE_GAP = 0.5;

export function priestessCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 4000,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

// ---------------------------------------------------------------------------------------------
// The tesseract's shadow
// ---------------------------------------------------------------------------------------------

type V4 = [number, number, number, number];
const VERTS: V4[] = Array.from({ length: 16 }, (_, i): V4 => [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1]);
const EDGES: [number, number][] = [];
for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) { const x = i ^ j; if ((x & (x - 1)) === 0) EDGES.push([i, j]); }
/** The three planes that involve w, as pairs of axes (x y z w = 0 1 2 3). */
const W_PLANES: [number, number][] = [[0, 3], [1, 3], [2, 3]];

export interface TessPose {
  planes: [[number, number], [number, number]];
  angles: [number, number];
  /** Distance of the 4D eye along w: the perspective divide is (d − w). */
  d: number;
  /** A point light in front of the veil casts the 3D body onto it. */
  lx: number; ly: number; lz: number;
  /** How far in front of the veil the body floats. */
  zoff: number;
}

function rotate4(v: V4, plane: [number, number], a: number): V4 {
  const w: V4 = [...v];
  const c = Math.cos(a), s = Math.sin(a);
  w[plane[0]] = c * v[plane[0]] - s * v[plane[1]];
  w[plane[1]] = s * v[plane[0]] + c * v[plane[1]];
  return w;
}

/** The 16 vertices: rotated in two w-planes, divided by (d − w) into 3D, then cast onto the veil from a point light. */
function shadowOf(p: TessPose): Point[] {
  return VERTS.map(v0 => {
    const v = rotate4(rotate4(v0, p.planes[0], p.angles[0]), p.planes[1], p.angles[1]);
    const k = 1 / (p.d - v[3]);
    const X = v[0] * k, Y = v[1] * k, Z = v[2] * k + p.zoff;
    const m = p.lz / (p.lz - Z);
    return { x: p.lx + (X - p.lx) * m, y: p.ly + (Y - p.ly) * m };
  });
}

const segDist = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
};

const cross2 = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const properCross = (a: Point, b: Point, c: Point, d: Point) =>
  cross2(a, b, c) * cross2(a, b, d) < 0 && cross2(c, d, a) * cross2(c, d, b) < 0;

function hull(pts: Point[]): Point[] {
  const s = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const build = (list: Point[]) => {
    const h: Point[] = [];
    for (const p of list) {
      while (h.length >= 2 && cross2(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  return [...build(s), ...build([...s].reverse())];
}
const polyArea = (h: Point[]) => Math.abs(h.reduce((s, p, i) => { const q = h[(i + 1) % h.length]; return s + p.x * q.y - q.x * p.y; }, 0)) / 2;

/** Fit to a unit box centred on the origin. */
function unitBox(pts: Point[]): Point[] {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const k = 1 / Math.max(x1 - x0, y1 - y0);
  return pts.map(p => ({ x: (p.x - (x0 + x1) / 2) * k, y: (p.y - (y0 + y1) / 2) * k }));
}

export interface Clarity { nest: number; minVV: number; minVE: number; minAng: number; crossings: number; fill: number }

/**
 * How clearly a shadow shows a cube inside a cube: `nest` is the room by which some cell of the
 * tesseract lies inside the hull of its opposite cell (-1 when none does, or the inner one is too
 * small or too big), `minVV` and `minVE` the closest approach of a vertex to another vertex or to a
 * foreign edge, `minAng` the sharpest angle between edges at a vertex, `fill` the short side of the box.
 */
export function clarity(pts: Point[]): Clarity {
  let minVV = Infinity, minVE = Infinity, minAng = Math.PI, crossings = 0;
  for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) minVV = Math.min(minVV, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  for (let i = 0; i < 16; i++) for (const [a, b] of EDGES) if (a !== i && b !== i) minVE = Math.min(minVE, segDist(pts[i], pts[a], pts[b]));
  for (let e = 0; e < EDGES.length; e++) for (let f = e + 1; f < EDGES.length; f++) {
    const [a, b] = EDGES[e], [c, d] = EDGES[f];
    const shared = a === c || a === d ? a : b === c || b === d ? b : -1;
    if (shared < 0) { if (properCross(pts[a], pts[b], pts[c], pts[d])) crossings++; continue; }
    const o = pts[shared], p = pts[a === shared ? b : a], q = pts[c === shared ? d : c];
    const u = { x: p.x - o.x, y: p.y - o.y }, v = { x: q.x - o.x, y: q.y - o.y };
    minAng = Math.min(minAng, Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y))))));
  }
  let nest = -1;
  for (let axis = 0; axis < 4; axis++) for (const flip of [1, -1]) {
    const outer = VERTS.map((v, i) => v[axis] === flip ? i : -1).filter(i => i >= 0);
    const inner = VERTS.map((v, i) => v[axis] === -flip ? i : -1).filter(i => i >= 0);
    const h = hull(outer.map(i => pts[i]));
    if (h.length < 3) continue;
    let margin = Infinity;
    for (const i of inner) for (let k = 0; k < h.length; k++) {
      const a = h[k], b = h[(k + 1) % h.length];
      margin = Math.min(margin, cross2(a, b, pts[i]) / Math.hypot(b.x - a.x, b.y - a.y));
    }
    const ratio = polyArea(hull(inner.map(i => pts[i]))) / polyArea(h);
    if (ratio < 0.15 || ratio > 0.5) continue;
    nest = Math.max(nest, margin);
  }
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { nest, minVV, minVE, minAng, crossings, fill: Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) };
}

/** Clarity as one number, negative when the shadow fails a floor. */
export function clarityScore(c: Clarity, floors = { nest: 0.04, minVV: 0.05, minVE: 0.015, minAng: 0.12 }): number {
  if (c.nest < floors.nest || c.minVV < floors.minVV || c.minVE < floors.minVE || c.minAng < floors.minAng) return -1;
  return 2 * c.nest + 6 * c.minVE + c.minVV + 0.5 * Math.min(1, c.minAng) + 0.5 * c.fill - 0.01 * c.crossings;
}

/** A random pose: two of the three w-planes, seeded angles, a 4D eye distance and a light. */
export function randomPose(rng: () => number): TessPose {
  const between = (lo: number, hi: number) => lo + (hi - lo) * rng();
  const sign = () => (rng() < 0.5 ? -1 : 1);
  const first = Math.floor(rng() * 3), second = (first + 1 + Math.floor(rng() * 2)) % 3;
  return {
    planes: [W_PLANES[first], W_PLANES[second]],
    angles: [sign() * between(0.2, 0.95), sign() * between(0.2, 0.95)],
    d: between(2.5, 3.6),
    lx: sign() * between(0.1, 0.9), ly: sign() * between(0.1, 0.9), lz: between(3, 6), zoff: between(0.3, 1),
  };
}
export const unitShadow = (pose: TessPose): Point[] => unitBox(shadowOf(pose));

/** The seeded pose with the clearest cube-in-cube shadow out of a few thousand draws. */
export function tesseractShadow(ctx: SketchContext): { pts: Point[]; pose: TessPose; score: number } {
  const rng = ctx.random('priestess-tesseract');
  let best: { pts: Point[]; pose: TessPose; score: number } | null = null;
  for (let k = 0; k < 4000; k++) {
    const pose = randomPose(rng);
    const pts = unitShadow(pose);
    const score = clarityScore(clarity(pts));
    if (score > (best?.score ?? -1)) best = { pts, pose, score };
  }
  if (!best) {
    const pose: TessPose = { planes: [W_PLANES[0], W_PLANES[2]], angles: [0.5, 0.4], d: 3, lx: 0.4, ly: 0.35, lz: 4.5, zoff: 0.6 };
    best = { pts: unitShadow(pose), pose, score: -1 };
  }
  return best;
}

interface Band { a: Point; b: Point }

/**
 * The shadow as narrow hatched bands, one per edge, in page millimetres. Where bands cross they
 * merge: the outline of one stops where it enters another, and the earlier band's hatch wins the
 * overlap. Returns the paths and the bands, which also knock the veil's threads out.
 */
export function shadowBands(pts: Point[], half: number, hatchPitch = 0.55): { outlines: Point[][]; hatch: Point[][]; bands: Band[] } {
  const ext = half * 0.6;
  const bands: Band[] = EDGES.map(([i, j]) => {
    const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y, l = Math.hypot(dx, dy) || 1;
    return { a: { x: pts[i].x - dx / l * ext, y: pts[i].y - dy / l * ext }, b: { x: pts[j].x + dx / l * ext, y: pts[j].y + dy / l * ext } };
  });
  const inside = (p: Point, skip: (j: number) => boolean, depth: number) => bands.some((s, j) => !skip(j) && segDist(p, s.a, s.b) < half - depth);
  const outlines: Point[][] = [], hatch: Point[][] = [];
  bands.forEach((s, i) => {
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, l = Math.hypot(dx, dy);
    const nx = -dy / l, ny = dx / l;
    const area = { x0: Math.min(s.a.x, s.b.x) - half - 1, x1: Math.max(s.a.x, s.b.x) + half + 1, y0: Math.min(s.a.y, s.b.y) - half - 1, y1: Math.max(s.a.y, s.b.y) + half + 1 };
    const marks = bandMarks([s.a, s.b], half, area, { pitch: hatchPitch, angle: Math.atan2(dy, dx) + 1.15, margin: 0.3 });
    const caps: Point[][] = [s.a, s.b].map(e => [{ x: e.x + nx * half, y: e.y + ny * half }, { x: e.x - nx * half, y: e.y - ny * half }]);
    for (const path of [...marks.slice(0, 2), ...caps]) outlines.push(...keepAlong(path, p => !inside(p, j => j === i, 0.03), 0.1));
    for (const path of marks.slice(2)) hatch.push(...keepAlong(path, p => !inside(p, j => j >= i, 0.12), 0.1));
  });
  return { outlines, hatch, bands };
}

// ---------------------------------------------------------------------------------------------
// The temple
// ---------------------------------------------------------------------------------------------

interface Face { slab: Slab; pillar: 0 | 1; y: number; h: number }
/** How a slab is drawn: its light, and its hatch pitch as a multiple of the base (the dark pillar is tight, the light one open). */
interface Look { group: 'dark' | 'light' | 'lintel'; light: THREE.Vector3; pitch: number }
interface Temple { slabs: Slab[]; faces: Face[]; look: Map<Slab, Look> }

interface Layout {
  view: THREE.PerspectiveCamera;
  /** World units per page millimetre at the pillars' depth. */
  u: number;
  distance: number;
  cx: number;
  groundY: number;
  pillarCentre: number;
  pillarWidth: number;
  lintelTop: number;
}

const FRONT_LIGHT = new THREE.Vector3(0.55, 0.6, 0.6).normalize();
/** The dark pillar is lit from behind, so the faces we see fall heavy. */
const BACK_LIGHT = new THREE.Vector3(-0.25, 0.55, -0.8).normalize();

/** One pillar: a stepped plinth, a shaft of slab courses of uneven height, a stepped capital. True vertical, clean edged. */
function pillar(ctx: SketchContext, lay: Layout, side: -1 | 1, dark: boolean, top: number, faces: Face[], look: Map<Slab, Look>): Slab[] {
  const rng = ctx.random(side < 0 ? 'priestess-pillar-left' : 'priestess-pillar-right');
  const { u, distance: D, pillarWidth: pw } = lay;
  const cx = (lay.cx + side * lay.pillarCentre - TABLOID_PAGE.width / 2) * u;
  const out: Slab[] = [];
  let y = 0;
  // The light pillar is lit from the side its inner flank faces, so that flank stays open paper.
  const mine: Look = dark ? { group: 'dark', light: BACK_LIGHT, pitch: 0.85 } : { group: 'light', light: new THREE.Vector3(-side * 0.5, 0.6, 0.6).normalize(), pitch: 1.5 };
  const add = (widen: number, h: number, tone: number, face = false) => {
    const sl = solid(cx, (y + h / 2) * u, -D, (pw + widen) * u, (h - COURSE_GAP) * u, (pw + widen) * u, out.length, 'stack');
    sl.tone = tone;
    out.push(sl);
    look.set(sl, mine);
    if (face) faces.push({ slab: sl, pillar: side < 0 ? 0 : 1, y: lay.groundY - (y + h / 2), h: h - COURSE_GAP });
    y += h;
  };
  const tone = () => (dark ? 1.25 + 0.4 * rng() : 0.18 + 0.2 * rng());
  add(10, 4.5, tone());
  add(5, 3.5, tone());
  const shaftTop = top - 8;
  const heights: number[] = [];
  for (let sum = y; sum < shaftTop;) {
    let h = rng() < 0.3 ? 5 + 2.2 * rng() : 2.9 + 1.5 * rng();
    if (shaftTop - sum - h < 2.9) h = shaftTop - sum;
    heights.push(h);
    sum += h;
  }
  for (const h of heights) add(0, h, tone(), true);
  add(5, 3.5, tone());
  add(10, 4.5, tone());
  return out;
}

/** The lintel: a long beam on the pillars' tops with a thin cap course over it. */
function lintel(lay: Layout, top: number, look: Map<Slab, Look>): Slab[] {
  const { u, distance: D, pillarWidth: pw } = lay;
  const span = 2 * (lay.pillarCentre + pw / 2 + 6);
  const out: Slab[] = [];
  let y = top;
  for (const [h, inset, tone] of [[9, 0, 0.7], [3, 4, 0.5]] as const) {
    const sl = solid((lay.cx - TABLOID_PAGE.width / 2) * u, (y + h / 2) * u, -D, (span - 2 * inset) * u, (h - COURSE_GAP) * u, (pw + 12 - 2 * inset) * u, out.length, 'stack');
    sl.tone = tone;
    out.push(sl);
    look.set(sl, { group: 'lintel', light: FRONT_LIGHT, pitch: 2.2 });
    y += h;
  }
  return out;
}

function temple(ctx: SketchContext, lay: Layout): Temple {
  const faces: Face[] = [], look = new Map<Slab, Look>();
  const darkSide = ctx.params.darkSide === 'left' ? -1 : ctx.params.darkSide === 'right' ? 1 : ctx.random('priestess-dark')() < 0.5 ? -1 : 1;
  const totalH = lay.groundY - lay.lintelTop - 12;
  const left = pillar(ctx, lay, -1, darkSide < 0, totalH, faces, look);
  const right = pillar(ctx, lay, 1, darkSide > 0, totalH, faces, look);
  const beam = lintel(lay, totalH, look);
  return { slabs: [...left, ...right, ...beam], faces, look };
}

// ---------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------

export function drawHighPriestess(ctx: SketchContext): Part[] {
  const view = priestessCamera(ctx);
  const eye = view.position.clone();
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const distance = n(ctx, 'distance', 90, 50, 220);
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  const lay: Layout = {
    view, u: distance / f, distance, cx: TABLOID_PAGE.width / 2,
    groundY: pageOf(view, new THREE.Vector3(0, 0, -distance)).y,
    pillarCentre: n(ctx, 'pillarCentre', 74, 40, 95), pillarWidth: n(ctx, 'pillarWidth', 36, 20, 50), lintelTop: n(ctx, 'lintelTop', 62, 46, 100),
  };
  const { slabs, faces, look } = temple(ctx, lay);
  const geometries = slabs.map(slabGeometry);
  fitDepthRange(view, geometries);

  // The veil: a flat rectangle on the sheet (the plane faces the eye), between the pillars' inner
  // faces, hung from just under the lintel to just above the ground.
  const innerHalf = (lay.pillarCentre - lay.pillarWidth / 2) * lay.u;
  const soffit = (lay.groundY - lay.lintelTop - 12) * lay.u;
  const veilTL = pageOf(view, new THREE.Vector3(-innerHalf, soffit - 0.6, -distance));
  const veilBR = pageOf(view, new THREE.Vector3(innerHalf, 1.5, -distance));
  const veil = { x0: veilTL.x, x1: veilBR.x, y0: veilTL.y, y1: veilBR.y };
  const inVeil = (p: Point, grow = 0) => p.x > veil.x0 - grow && p.x < veil.x1 + grow && p.y > veil.y0 - grow && p.y < veil.y1 + grow;

  try {
    const depthBuffer = renderDepthBufferCPU(geometries, view, W, H);
    const solids = meshCoverage(geometries, view, TABLOID_PAGE, n(ctx, 'knockout', 1.1, 0.3, 3));

    // The shadow: the cube-within-a-cube read of the tesseract, laid flat on the veil a little above its centre.
    const shadow = tesseractShadow(ctx);
    const size = n(ctx, 'tessSize', 0.5, 0.3, 0.7) * (veil.x1 - veil.x0);
    const centre = { x: (veil.x0 + veil.x1) / 2, y: (veil.y0 + veil.y1) / 2 - n(ctx, 'tessRise', 0.1, -0.2, 0.3) * (veil.y1 - veil.y0) };
    const half = n(ctx, 'tessBand', 0.85, 0.5, 2);
    const flat = shadow.pts.map(p => ({ x: centre.x + p.x * size, y: centre.y + p.y * size }));
    const bands = shadowBands(flat, half);
    const bandBox = { x0: Math.min(...flat.map(p => p.x)) - half - 4, x1: Math.max(...flat.map(p => p.x)) + half + 4, y0: Math.min(...flat.map(p => p.y)) - half - 4, y1: Math.max(...flat.map(p => p.y)) + half + 4 };
    const clear = half + n(ctx, 'veilClear', 0.9, 0.3, 2.5);
    const nearBand = (p: Point) => p.x > bandBox.x0 && p.x < bandBox.x1 && p.y > bandBox.y0 && p.y < bandBox.y1 && bands.bands.some(s => segDist(p, s.a, s.b) < clear);

    // The phrase, word by word, alternating pillars from the top down, each cut into a course face
    // tall enough to take it.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
    const wrng = ctx.random('priestess-words');
    const style = { face: settings.face, height: settings.size };
    const used = new Set<Slab>();
    const textStrokes: THREE.Vector3[][] = [];
    const visible = (lines3: THREE.Vector3[][]) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth: depthBuffer, width: W, height: H }, {
        hidden: () => hidden, begin: () => runs => { for (const r of runs) addTo(r.length); },
      });
      count(false, k => { total += k; });
      count(true, k => { seen += k; });
      return total > 0 && seen >= total * 0.98;
    };
    const yTop = lay.lintelTop + 26, yBottom = lay.groundY - 26;
    words.forEach((word, i) => {
      const target = yTop + (yBottom - yTop) * (words.length > 1 ? i / (words.length - 1) : 0.5) + (wrng() - 0.5) * 10;
      const unit = lay.u;
      const ww = measureStrokeText(word, style) * unit, hh = style.height * unit;
      const pool = faces.filter(fc => fc.pillar === i % 2 && !used.has(fc.slab) && fc.h >= style.height + 1 && ww <= fc.slab.w - 10 * unit)
        .sort((a, b) => Math.abs(a.y - target) - Math.abs(b.y - target)).slice(0, 8);
      for (const fc of pool) {
        const sl = fc.slab, m = slabMatrix(sl);
        const x0 = -ww / 2 + (wrng() - 0.5) * (sl.w - ww - 10 * unit), y0 = hh / 2;
        const word3 = strokeText(word, 0, 0, style).map(path => path.map(q => new THREE.Vector3(x0 + q.x * unit, y0 - q.y * unit, sl.d / 2 + 0.03).applyMatrix4(m)));
        if (!visible(word3)) continue;
        textStrokes.push(...word3);
        used.add(sl);
        break;
      }
    });
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, 0.6);

    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], extra: (p: Point) => boolean = () => true, step = 0.15) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => extra(p), step)) buckets.add(key, piece);
    };

    // The temple, hatched by its light. The accent is the veil's alone, so every pillar mark is carbon;
    // whatever lies behind the veil's rectangle is hidden by it.
    const strokes: Stroke[] = [];
    for (const sl of slabs) {
      const at = new THREE.Vector3(sl.x, sl.y, sl.z);
      const { group, light, pitch: tightness } = look.get(sl)!;
      const pitch = n(ctx, 'hatchPitch', 1, 0.8, 2) * tightness * FACET_MM_PER_UNIT / mmPerUnit(at);
      for (const st of facetStrokes(sl, light, eye, false, pitch)) strokes.push({ ink: 'carbon', group, family: st.family, points: st.points });
    }
    projectStrokes(strokes, { view, depth: depthBuffer, width: W, height: H }, {
      begin: st => runs => {
        for (const run of runs) for (const inside of clipWindow(scalePoints(run, MM_X, MM_Y))) {
          for (const piece of keepAlong(inside, p => !onGlyph(p) && !inVeil(p, 0.3), 0.15)) {
            // The pillars' inner flanks show as slivers beside the veil; their stray ticks are noise.
            if (inVeil(piece[0], 4) && pathLength(piece) < 1.8) continue;
            buckets.add(`${st.group}-${st.ink}`, piece);
          }
        }
      },
    });

    // The veil: fine vertical threads in page space, hung from the lintel and ending in a ragged hem.
    const vrng = ctx.random('priestess-veil');
    const pitch = n(ctx, 'veilPitch', 0.95, 0.6, 1.2);
    const threads = Math.floor((veil.x1 - veil.x0 - 1.2) / pitch);
    for (let k = 0; k <= threads; k++) {
      const x = veil.x0 + 0.6 + k * (veil.x1 - veil.x0 - 1.2) / Math.max(1, threads);
      const hem = vrng() * vrng() * 3;
      add('veil-ultramarine', [{ x, y: veil.y0 + 0.4 }, { x, y: veil.y1 - hem }], p => !nearBand(p), 0.2);
    }

    // The shadow's bands, in carbon.
    for (const path of bands.outlines) buckets.add('shadow-carbon', path, true);
    for (const path of bands.hatch) buckets.add('shadow-carbon', path, true);

    // The sky: a ruled night, densest at the top and opening toward the horizon, knocked out round the
    // temple and behind the veil.
    const reach = n(ctx, 'skyReach', 0.65, 0, 1);
    const pattern = barPattern(ctx.random('priestess-sky'), 0.86);
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - 1;
    if (reach > 0) for (let y = skyTop + 0.3, i = 0; y < skyBottom; i++, y += 0.62) {
      const t = (y - skyTop) / (skyBottom - skyTop) / reach;
      const tier = i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2;
      if (t > 1 || !(t < 0.45 || tier === 0 || (tier === 1 && t < 0.75))) continue;
      const broken = t > 0.55;
      add('sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => !solids(p) && !inVeil(p, 1) && (!broken || pattern[Math.floor((p.x - CARD.x0) / 3.2 + i) % 64]));
    }

    // The ground: a few long joints converging on the veil, in dashes of uneven length.
    const jrng = ctx.random('priestess-joints');
    const joints = Math.round(n(ctx, 'joints', 7, 0, 14));
    const reachX = (lay.pillarCentre + lay.pillarWidth / 2 + 18) * lay.u;
    for (let k = 0; k < joints; k++) {
      const x = ((k + 0.5) / joints * 2 - 1) * reachX + (jrng() - 0.5) * reachX / joints * 0.6;
      const far = pageOf(view, new THREE.Vector3(x, 0, -distance + lay.pillarWidth * lay.u * 0.55));
      const near = pageOf(view, new THREE.Vector3(x, 0, -14));
      const dashes = barPattern(jrng, 0.9);
      const cell = 8 + 6 * jrng();
      for (const piece of clipWindow([far, near])) {
        for (const run of keepAlong(piece, (p, at) => dashes[Math.floor(at / cell) % 64] && !solids(p) && !inVeil(p, 1), 0.2)) buckets.add('floor-carbon', run, false, 2);
      }
    }

    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['sky', 'floor', 'dark', 'light', 'lintel', 'veil', 'shadow', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p) && !inVeil(p, 1), 0.3) });
    parts.push(...cardFrame('II', 'THE HIGH PRIESTESS'));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
