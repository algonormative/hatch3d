import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, faceDarkness, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, onGround, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';

/**
 * V The Hierophant: by continuing, you agree. The institution as the middleman. One long high
 * wall of a few big slab courses crosses the card, dead level, shallowly bowed toward the eye. At
 * its centre stands one narrow gate between two taller piers, dark inside. Every lane on the ground
 * runs into it: a fan of ruled lanes and paving courses from all across the foot of the card,
 * narrowing to the gate; through the slot they open out again beyond. The facade is cut all over
 * with fine print, justified rows of asemic marks in patches and blanks, with the four words of
 * the phrase set among them in the same pen at the same size.
 */
const W = 1118, H = 1728;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 6;
const FACET_MM_PER_UNIT = 8.3;
/** The weights of the courses, bottom to top; the last is the lintel course over the gate. */
const COURSES = [0.31, 0.26, 0.23, 0.20];
const COURSE_GAP = 0.15;

export function gateCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 4000,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

type Piece = { slab: Slab; kind: 'wing' | 'pier' | 'cap' | 'lintel'; side: number; course: number; sealed?: boolean };
type Quad = { x: number; z: number }[];

interface Wall {
  pieces: Piece[];
  /** Ground footprints (x, z) of everything solid: piers and the two wings. */
  footprints: Quad[];
  D: number; gw: number; pw: number; dw: number; dp: number; wallH: number; gateTop: number;
}

/** The wall: two wings of staggered slab courses, two piers, a lintel. All courses dead level. */
export function buildWall(ctx: SketchContext, view: THREE.PerspectiveCamera): Wall {
  const rng = ctx.random('hier-wall'), tone = ctx.random('hier-tone');
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const D = n(ctx, 'dist', 70, 40, 140);
  const wallH = n(ctx, 'wallH', 26, 10, 40);
  const a = THREE.MathUtils.degToRad(n(ctx, 'bay', 20, 0, 40));
  const gw = n(ctx, 'gateW', 2.6, 1.4, 5);
  const pw = n(ctx, 'pierW', 4.4, 2, 9);
  const capH = n(ctx, 'capH', 3, 0.5, 8);
  const dw = 4.4, dp = dw + 1.6, joint = 0.2 + dw / 2 * Math.sin(a);
  const heights = COURSES.map(w => w * (wallH - (COURSES.length - 1) * COURSE_GAP));
  const bottoms = heights.map((_, c) => heights.slice(0, c).reduce((s, h) => s + h + COURSE_GAP, 0));
  const nC = COURSES.length;
  const pieces: Piece[] = [];
  const footprints: Quad[] = [];
  const halfW = (CARD.x1 - CARD.x0) / 2;
  for (const side of [-1, 1]) {
    const Bx = side * (gw / 2 + pw + joint);
    // The wing runs out until it clears the card edge, with a margin.
    const reach = 1.08 * halfW / f;
    const sEnd = (reach * D - Math.abs(Bx)) / (Math.cos(a) + reach * Math.sin(a));
    const dir = { x: side * Math.cos(a), z: Math.sin(a) };
    const nrm = { x: -dir.z, z: dir.x };
    const q = (s: number, k: number) => ({ x: Bx + dir.x * s + nrm.x * k * dw / 2, z: -D + dir.z * s + nrm.z * k * dw / 2 });
    footprints.push([q(0, 1), q(0, -1), q(sEnd, -1), q(sEnd, 1)]);
    for (let c = 0; c < nC; c++) {
      let s = 0, len = 4 + 14 * rng();
      while (s < sEnd - 0.5) {
        const sa = s, sb = Math.min(sEnd, s + len);
        s = sb; len = 11 + 14 * rng();
        const w = sb - sa - 0.2;
        if (w < 1.5) continue;
        const mid = (sa + sb) / 2;
        const sl = solid(Bx + dir.x * mid, bottoms[c] + heights[c] / 2, -D + dir.z * mid, w, heights[c], dw, pieces.length, 'stack');
        sl.ry = -side * a;
        // Pale courses (rings only, so the print reads clean) with the odd dark sealed block that carries none.
        const sealed = tone() < 0.14;
        sl.tone = sealed ? 1.45 : 0.15 + 0.25 * tone();
        pieces.push({ slab: sl, kind: 'wing', side, course: c, sealed });
      }
    }
    const x1 = side * (gw / 2), x2 = side * (gw / 2 + pw);
    footprints.push([{ x: x1, z: -D - dp / 2 }, { x: x2, z: -D - dp / 2 }, { x: x2, z: -D + dp / 2 }, { x: x1, z: -D + dp / 2 }]);
    // The pier: a stack of whole slabs on the wall's own courses, then a cap.
    for (let c = 0; c < nC; c++) {
      const sl = solid(side * (gw / 2 + pw / 2), bottoms[c] + heights[c] / 2, -D, pw, heights[c], dp, pieces.length, 'pier');
      sl.tone = 1.45;
      pieces.push({ slab: sl, kind: 'pier', side, course: c });
    }
    const top = bottoms[nC - 1] + heights[nC - 1] + COURSE_GAP;
    const cap = solid(side * (gw / 2 + pw / 2), top + capH / 2, -D, pw, capH, dp, pieces.length, 'pier');
    cap.tone = 1.45;
    pieces.push({ slab: cap, kind: 'cap', side, course: nC });
  }
  const lintel = solid(0, bottoms[nC - 1] + heights[nC - 1] / 2, -D, gw - 0.3, heights[nC - 1], dw, pieces.length, 'stack');
  lintel.tone = 1;
  pieces.push({ slab: lintel, kind: 'lintel', side: 0, course: nC - 1 });
  return { pieces, footprints, D, gw, pw, dw, dp, wallH, gateTop: bottoms[nC - 1] };
}

/* ------------------------------------------------------------------------------------------ */
/* Asemic fine print                                                                          */
/* ------------------------------------------------------------------------------------------ */

type G = [number, number][];
/** Glyph grid: ascender y = 0, x-height top y = 3, baseline y = 8, descender y = 10.5; width up to 4. */
const AS = 0, XH = 3, BL = 8, DS = 10.5, LEAN = 0.1, TRACK = 1.3;

/** One made-up letter in the Cathedral hand's own grid: angular, leaning, never quite a letter. */
function asemicGlyph(rng: () => number): { strokes: G[]; w: number } {
  const w = [2.2, 3, 3, 3.8][Math.floor(rng() * 4)];
  const k = rng();
  const s: G[] = [];
  if (k < 0.14) s.push([[0, XH], [0, BL]]);
  else if (k < 0.27) s.push([[0, BL], [0, XH], [w, XH], [w, BL]]);
  else if (k < 0.38) s.push([[w, XH], [0, XH], [0, BL], [w, BL], [w, XH + 1.6]]);
  else if (k < 0.48) s.push([[0, XH], [w / 2, BL], [w, XH]]);
  else if (k < 0.56) s.push([[0, BL], [w, XH]]);
  else if (k < 0.66) { s.push([[0, XH - 0.5], [0, BL]]); s.push([[0, XH + 1], [w, XH + 1], [w, BL], [0, BL]]); }
  else if (k < 0.74) s.push([[w, XH], [0, XH + 1.3], [w, BL - 1.3], [0, BL]]);
  else if (k < 0.8) { s.push([[w / 2, AS], [w / 2, BL]]); s.push([[0, XH + 0.6], [w, XH + 0.6]]); }
  else if (k < 0.9) { s.push([[0, AS], [0, DS]]); s.push([[0, XH + 1], [w, XH + 1], [w, BL - 1]]); }
  else { s.push([[0, XH], [w, XH], [0, BL], [w, BL]]); }
  if (rng() < 0.07) s.push([[w / 2, AS + 0.4], [w / 2, AS + 1.4]]);
  return { strokes: s, w };
}

/** A made-up word: glyphs side by side, now and then joined by a ligature along the baseline. */
function asemicWord(rng: () => number): { strokes: G[]; width: number } {
  const count = 2 + Math.floor(rng() ** 1.4 * 6);
  const strokes: G[] = [];
  let x = 0, lastRight = -1;
  for (let i = 0; i < count; i++) {
    const g = asemicGlyph(rng);
    if (lastRight >= 0 && rng() < 0.22) strokes.push([[lastRight, BL], [x, BL]]);
    for (const st of g.strokes) strokes.push(st.map(([px, py]) => [x + px, py] as [number, number]));
    lastRight = x + g.w;
    x += g.w + TRACK;
  }
  return { strokes, width: x - TRACK };
}

interface Slot {
  piece: number; r: number;
  /** Baseline and left margin of the row in face millimetres from the face centre; width of the row. */
  v: number; u0: number; width: number;
  printed: boolean; last: boolean; ragged: number;
  special?: { word: string; frac: number };
}

interface Printed { asemic: THREE.Vector3[][]; words: THREE.Vector3[][] }

export function setFinePrint(ctx: SketchContext, wall: Wall, view: THREE.PerspectiveCamera, depthVisible: (lines: THREE.Vector3[][]) => boolean): Printed {
  const rng = ctx.random('hier-print'), wrng = ctx.random('hier-words');
  const eye = view.position;
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const L = n(ctx, 'printLine', 1.6, 1.2, 1.6), P = n(ctx, 'printPitch', 2.5, 2, 3.6);
  const density = n(ctx, 'print', 0.8, 0, 1), margin = n(ctx, 'margin', 1.2, 0.5, 6);
  const unit = L / 8;
  const settings = sloganSettings(ctx);
  const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
  const style = { face: settings.face, height: settings.size };
  const mpu = (s: Slab) => f / (eye.z - s.z);

  // Every row of every wing slab, and which ones carry text.
  const slots: Slot[] = [];
  wall.pieces.forEach((pc, i) => {
    if (pc.kind !== 'wing' || pc.sealed) return;
    const sl = pc.slab, k = mpu(sl);
    const Wmm = sl.w * k, Hmm = sl.h * k;
    const band = faceBand(sl, k);
    const mx = band + margin, my = band + margin * 0.7;
    const width = Wmm - 2 * mx;
    if (width < 14) return;
    const rows: Slot[] = [];
    for (let v = Hmm / 2 - my - L, r = 0; v - 0.5 >= -Hmm / 2 + my; v -= P, r++) {
      rows.push({ piece: i, r, v, u0: -Wmm / 2 + mx, width, printed: false, last: false, ragged: 1 });
    }
    // Paragraphs of justified rows with a ragged last line, blank patches between and some left wholly bare.
    for (let r = 0; r < rows.length;) {
      const len = 2 + Math.floor(rng() * 7), on = rng() < density, indent = rng() < 0.5 ? 2.5 + 2 * rng() : 0;
      const ragged = 0.3 + 0.6 * rng(), gap = rng() < 0.5 ? 1 : 0;
      for (let q = 0; q < len && r + q < rows.length; q++) {
        const row = rows[r + q];
        if (on && rng() < 0.94) {
          row.printed = true;
          if (q === 0 && indent) { row.u0 += indent; row.width -= indent; }
          if (q === len - 1 || r + q === rows.length - 1) { row.last = true; row.ragged = ragged; }
        }
      }
      r += len + gap;
    }
    slots.push(...rows);
  });

  // The phrase: one word to a row, staggered from the top of the wall down and side to side, each
  // tried at a few places along its row until one lands inside the card and in clear view.
  const mat = new Map<number, THREE.Matrix4>();
  const faceMat = (i: number) => { let m = mat.get(i); if (!m) { m = slabMatrix(wall.pieces[i].slab); mat.set(i, m); } return m; };
  const world = (i: number, u: number, v: number) => {
    const sl = wall.pieces[i].slab, kk = 1 / mpu(sl);
    return new THREE.Vector3(u * kk, v * kk, sl.d / 2 + 0.03).applyMatrix4(faceMat(i));
  };
  const topY = pageOf(view, new THREE.Vector3(0, wall.wallH, -wall.D)).y, baseY = pageOf(view, new THREE.Vector3(0, 0, -wall.D)).y;
  const targetsX = [0.22, 0.76, 0.3, 0.7];
  const taken: Slot[] = [];
  words.forEach((word, i) => {
    const tx = CARD.x0 + (CARD.x1 - CARD.x0) * (targetsX[i % 4] + (wrng() - 0.5) * 0.08);
    const ty = topY + 9 + (baseY - topY - 18) * (i + 0.5) / words.length;
    const ww = measureStrokeText(word, style);
    const cands: { slot: Slot; frac: number; cost: number }[] = [];
    for (const slot of slots) {
      if (taken.some(t => t.piece === slot.piece && Math.abs(t.r - slot.r) < 3)) continue;
      for (const frac of [0.12, 0.28, 0.44, 0.6, 0.76, 0.9]) {
        const u = slot.u0 + slot.width * frac;
        const p = pageOf(view, world(slot.piece, u, slot.v + settings.size / 2));
        if (p.x - ww / 2 < CARD.x0 + 7 || p.x + ww / 2 > CARD.x1 - 7 || p.y < CARD.y0 + 5 || p.y > baseY - 4) continue;
        // A word forced into an unprinted row would sit alone and be easy to find: prefer rows already in a paragraph.
        const near = (r: number) => slots.some(o => o.piece === slot.piece && o.r === r && o.printed);
        const lonely = !slot.printed && !near(slot.r - 1) && !near(slot.r + 1);
        cands.push({ slot, frac, cost: Math.hypot((p.x - tx) * 0.8, p.y - ty) + (slot.printed ? 0 : 12) + (lonely ? 80 : 0) });
      }
    }
    cands.sort((p, q) => p.cost - q.cost);
    for (const c of cands.slice(0, 400)) {
      const u = c.slot.u0 + c.slot.width * c.frac - ww / 2;
      const test = strokeText(word, 0, 0, style).map(path => path.map(q2 => world(c.slot.piece, u + q2.x, c.slot.v + style.height - q2.y)));
      if (!depthVisible(test)) continue;
      c.slot.special = { word, frac: c.frac };
      c.slot.printed = true; c.slot.last = false;
      taken.push(c.slot);
      return;
    }
  });

  // Lay the rows out and emit their marks as world strokes on the faces.
  const asemic: THREE.Vector3[][] = [], out: THREE.Vector3[][] = [];
  for (const slot of slots) {
    if (!slot.printed) continue;
    const width = slot.width * (slot.last && !slot.special ? slot.ragged : 1);
    const items: { x: number; word?: string; strokes?: G[]; w: number }[] = [];
    const specialW = slot.special ? measureStrokeText(slot.special.word, style) : 0;
    const chosen: { strokes?: G[]; w: number; word?: string }[] = [];
    let used = 0, placed = !slot.special;
    const gmin = 3.2 * unit;
    for (let guard = 0; guard < 200; guard++) {
      if (!placed && used >= slot.width * slot.special!.frac - specialW / 2) {
        if (used + specialW > width) break;
        chosen.push({ word: slot.special!.word, w: specialW }); used += specialW + gmin; placed = true; continue;
      }
      const wd = asemicWord(rng);
      const wmm = wd.width * unit;
      if (used + wmm > width) break;
      chosen.push({ strokes: wd.strokes, w: wmm }); used += wmm + gmin;
    }
    if (!placed && slot.special) chosen.push({ word: slot.special.word, w: specialW });
    if (chosen.length < 2) continue;
    const sum = chosen.reduce((s, c) => s + c.w, 0);
    const gap = slot.last && !slot.special ? gmin * 1.15 : Math.min(gmin * 3.5, (width - sum) / (chosen.length - 1));
    let x = 0;
    for (const c of chosen) { items.push({ x, ...c }); x += c.w + gap; }
    // A justified row of the paragraph runs the whole width; the special row is held to its place.
    for (const it of items) {
      const u = slot.u0 + it.x;
      if (it.word) {
        for (const path of strokeText(it.word, 0, 0, style)) out.push(path.map(q2 => world(slot.piece, u + q2.x, slot.v + style.height - q2.y)));
      } else if (it.strokes) {
        for (const st of it.strokes) {
          asemic.push(st.map(([gx, gy]) => world(slot.piece, u + (gx + LEAN * (BL - gy)) * unit, slot.v + (BL - gy) * unit)));
        }
      }
    }
  }
  return { asemic, words: out };
}

/** The contour-ring band (mm) the slab's facet hatch lays inside its front face, so the print stays clear of it. */
function faceBand(sl: Slab, mmPerUnit: number): number {
  const light = new THREE.Vector3(0.25, 0.55, 0.8).normalize();
  const normal = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(sl.rx, sl.ry, sl.rz, 'XYZ'));
  const d = faceDarkness(normal, light, sl.tone);
  return Math.min(sl.w, sl.h) / 2 * (0.12 + 0.6 * d) * mmPerUnit;
}

/* ------------------------------------------------------------------------------------------ */
/* The lanes                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** The parts of the segment a→b (ground x, z) that fall outside every footprint, as [t0, t1] ranges. */
function outside(a: { x: number; z: number }, b: { x: number; z: number }, quads: Quad[]): [number, number][] {
  const dx = b.x - a.x, dz = b.z - a.z;
  const inside: [number, number][] = [];
  for (const q of quads) {
    let area = 0;
    for (let i = 0; i < q.length; i++) { const p = q[i], r = q[(i + 1) % q.length]; area += p.x * r.z - r.x * p.z; }
    let te = 0, tl = 1, ok = true;
    for (let i = 0; i < q.length && ok; i++) {
      const p = q[i], r = q[(i + 1) % q.length];
      const ex = r.x - p.x, ez = r.z - p.z;
      const nx = area > 0 ? ez : -ez, nz = area > 0 ? -ex : ex;
      const dn = nx * dx + nz * dz, num = nx * (p.x - a.x) + nz * (p.z - a.z);
      if (Math.abs(dn) < 1e-12) { if (num < 0) ok = false; continue; }
      const t = num / dn;
      if (dn > 0) tl = Math.min(tl, t); else te = Math.max(te, t);
    }
    if (ok && te < tl) inside.push([te, tl]);
  }
  inside.sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [t0, t1] of inside) { if (t0 > at) out.push([at, t0]); at = Math.max(at, t1); }
  if (at < 1) out.push([at, 1]);
  return out.filter(([t0, t1]) => t1 - t0 > 1e-6);
}

export function drawHierophant(ctx: SketchContext): Part[] {
  const view = gateCamera(ctx);
  const eye = view.position.clone();
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  const wall = buildWall(ctx, view);
  const { D, dp } = wall;
  const wallLight = new THREE.Vector3(0.25, 0.55, 0.8).normalize();
  const darkLight = new THREE.Vector3(-0.25, 0.55, -0.8).normalize();

  const strokes: Stroke[] = [];
  for (const pc of wall.pieces) {
    const sl = pc.slab, at = new THREE.Vector3(sl.x, sl.y, sl.z);
    const isDark = pc.kind === 'pier' || pc.kind === 'cap' || pc.sealed === true;
    const group = isDark ? 'pier' : 'wall';
    // Rings a little more open than the Tower's, so a whole wall of them stays calm.
    const ring = n(ctx, 'ringScale', 1.5, 1, 3);
    for (const st of facetStrokes(sl, isDark ? darkLight : wallLight, eye, Math.max(sl.w, sl.h) * mmPerUnit(at) < 1.5, ring * FACET_MM_PER_UNIT / mmPerUnit(at))) {
      // Undersides show only as slivers through the course joints, and the lintel's soffit as a 2 mm band: leave them bare.
      if (st.points.every(q => Math.abs(q.y - (sl.y - sl.h / 2)) < 0.02)) continue;
      strokes.push({ ink: st.ink, group, family: st.family, points: st.points });
    }
  }
  const geometries = wall.pieces.map(pc => slabGeometry(pc.slab));
  try {
    fitDepthRange(view, geometries);
    const depthBuffer = renderDepthBufferCPU(geometries, view, W, H);
    const solids = meshCoverage(geometries, view, TABLOID_PAGE, n(ctx, 'knockout', 1.1, 0.3, 3));
    const solids0 = meshCoverage(geometries, view, TABLOID_PAGE, 0.15);
    const solidsGate = meshCoverage(geometries, view, TABLOID_PAGE, 0.35);

    const depthVisible = (lines3: THREE.Vector3[][]) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k2: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth: depthBuffer, width: W, height: H }, {
        hidden: () => hidden, begin: () => runs => { for (const r2 of runs) addTo(r2.length); },
      });
      count(false, k2 => { total += k2; });
      count(true, k2 => { seen += k2; });
      return total > 0 && seen >= total * 0.98;
    };
    const printed = setFinePrint(ctx, wall, view, depthVisible);

    // Page-space marks from 3D strokes, clipped to the depth view and window and tested against the depth pass.
    const toPage = (lines3: THREE.Vector3[][]): Point[][] => {
      const res: Point[][] = [];
      projectStrokes(lines3.map(points => ({ points })), { view, depth: depthBuffer, width: W, height: H }, {
        begin: () => runs => { for (const run of runs) res.push(scalePoints(run, MM_X, MM_Y)); },
      });
      return res;
    };
    const wordPaths = toPage(printed.words).flatMap(p => clipWindow(p));
    const onWord = glyphMask(wordPaths, 0.55);
    const printPaths = toPage(printed.asemic).flatMap(p => clipWindow(p));
    const onPrint = glyphMask(printPaths, 0.42);

    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], extra: (p: Point) => boolean = () => true) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onWord(p) && !onPrint(p) && extra(p), 0.15)) buckets.add(key, piece);
    };
    projectStrokes(strokes, { view, depth: depthBuffer, width: W, height: H }, {
      begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y)); },
    });
    for (const p of printPaths) {
      for (const piece of keepAlong(p, q => !onWord(q), 0.2)) buckets.add('print-lettering', piece, true);
    }
    for (const p of wordPaths) buckets.add('slogan-lettering', p, true);

    // The ground. Ruled lanes run from all across the foot and sides of the card into the gate: each a
    // ribbon of its own with paper between, some paved in courses, some ruled along their length, some
    // plain. Past the slot a few of them open out again.
    const lrng = ctx.random('hier-lanes');
    const lanes = Math.round(n(ctx, 'lanes', 20, 4, 40));
    const mouth = n(ctx, 'mouth', 3.2, 0.5, 5);
    const zPier = -D + dp / 2, zBack = -D - dp / 2;
    const baseSide = pageOf(view, new THREE.Vector3(wall.gw / 2 + wall.pw, 0, zPier)).y;
    const yS = baseSide + 9;
    const perimeter = [{ x: CARD.x0, y: yS }, { x: CARD.x0, y: CARD.y1 }, { x: CARD.x1, y: CARD.y1 }, { x: CARD.x1, y: yS }];
    const seg = perimeter.slice(1).map((p, i) => Math.hypot(p.x - perimeter[i].x, p.y - perimeter[i].y));
    const total = seg.reduce((s2, v) => s2 + v, 0);
    const along = (tau: number): Point => {
      let d = tau * total;
      for (let i = 0; i < seg.length; i++) {
        if (d <= seg[i] || i === seg.length - 1) {
          const t = d / seg[i];
          return { x: perimeter[i].x + (perimeter[i + 1].x - perimeter[i].x) * t, y: perimeter[i].y + (perimeter[i + 1].y - perimeter[i].y) * t };
        }
        d -= seg[i];
      }
      return perimeter[0];
    };
    type Ray = { xg: number; slope: number };
    const rays: Ray[] = [];
    // Uneven lanes: the rays are jittered along the foot of the card, in order.
    const taus = Array.from({ length: lanes + 1 }, (_, j) => (j + 0.5 + (lrng() - 0.5) * 0.7) / (lanes + 1)).sort((p, q) => p - q);
    for (let j = 0; j <= lanes; j++) {
      const xg = -mouth + 2 * mouth * j / lanes;
      const b = onGround(view, along(taus[j]));
      rays.push({ xg, slope: (b.x - xg) / (b.z + D) });
    }
    const mix = (p: Ray, q: Ray, t: number): Ray => ({ xg: p.xg + (q.xg - p.xg) * t, slope: p.slope + (q.slope - p.slope) * t });
    const xAt = (r: Ray, z: number) => r.xg + r.slope * (z + D);
    const zNear = -9;
    const lanePaths: { path: Point[]; behind: boolean }[] = [];
    const ground = (x: number, z: number) => pageOf(view, new THREE.Vector3(x, 0, z));
    const emit = (a: { x: number; z: number }, b: { x: number; z: number }) => {
      for (const [t0, t1] of outside(a, b, wall.footprints)) {
        const pa = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 }, pb = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
        // Split at the pier's front plane: in front of it nothing hides the ground; behind, only the slot shows it.
        const dz = pb.z - pa.z;
        const tc = dz !== 0 ? (zPier - pa.z) / dz : -1;
        const cuts = tc > 0 && tc < 1 ? [tc, 1] : [1];
        let from = pa;
        for (const tk of cuts) {
          const to = tk === 1 ? pb : { x: pa.x + (pb.x - pa.x) * tk, z: pa.z + dz * tk };
          lanePaths.push({ path: [ground(from.x, from.z), ground(to.x, to.z)], behind: (from.z + to.z) / 2 < zPier });
          from = to;
        }
      }
    };
    const line = (r: Ray) => emit({ x: xAt(r, zNear), z: zNear }, { x: xAt(r, zBack), z: zBack });
    // Paving courses: page spacing grows toward the eye; neighbouring ribbons are set half a course off.
    const rowStart = n(ctx, 'rowStart', 1.5, 0.6, 4), rowGrow = n(ctx, 'rowGrow', 1.12, 1.03, 1.3);
    const rowYs: number[] = [];
    for (let y = baseSide + 1.2, step = rowStart; y < CARD.y1 + 14; y += step, step *= rowGrow) rowYs.push(y);
    const zOf = (y: number) => onGround(view, { x: TABLOID_PAGE.width / 2, y }).z;
    const ribbons: Ray[] = [];
    for (let j = 0; j < lanes; j++) {
      const inset = 0.1 + 0.16 * lrng(), inset2 = 0.1 + 0.16 * lrng(), kind = lrng();
      const ra = mix(rays[j], rays[j + 1], inset), rb = mix(rays[j], rays[j + 1], 1 - inset2);
      line(ra); line(rb);
      ribbons.push(mix(ra, rb, 0.5));
      if (kind < 0.6) {
        for (let k = 0; k < rowYs.length - 1; k++) {
          const y = j % 2 ? (rowYs[k] + rowYs[k + 1]) / 2 : rowYs[k], z = zOf(y);
          emit({ x: xAt(ra, z), z }, { x: xAt(rb, z), z });
        }
      } else if (kind < 0.85) {
        for (const t of [0.34, 0.66]) line(mix(ra, rb, t));
      }
    }
    // Past the slot: the lanes that reach it open out again from the back of the gate, never crossing.
    const fan = n(ctx, 'fan', 38, 10, 120), Db = D + dp / 2;
    ribbons.forEach(r => {
      const x0 = xAt(r, zBack);
      if (Math.abs(x0) > wall.gw / 2) return;
      emit({ x: x0, z: zBack }, { x: x0 * (3000 - (Db - fan)) / (Db - (Db - fan)), z: -3000 });
    });
    const beyond: Point[][] = [];
    for (const lp of lanePaths) for (const inside of clipWindow(lp.path)) {
      for (const piece of keepAlong(inside, p => !lp.behind || !solids0(p), 0.25)) {
        buckets.add('lane-carbon', piece);
        if (lp.behind) beyond.push(piece);
      }
    }

    // The slot: a dark ruled fill clear of the lines glimpsed through it and of the wall round it.
    const accent = (typeof ctx.params.accent === 'string' ? ctx.params.accent : 'ultramarine') as string;
    const gateInk = accent === 'ultramarine' || accent === 'vermilion' ? accent : 'carbon';
    const onBeyond = glyphMask(beyond, 0.4);
    const slotL = pageOf(view, new THREE.Vector3(-wall.gw / 2, 0, zPier)), slotR = pageOf(view, new THREE.Vector3(wall.gw / 2, 0, zPier));
    const slotTop = pageOf(view, new THREE.Vector3(0, wall.gateTop, zPier)).y - 3;
    const pitch = n(ctx, 'gatePitch', 0.5, 0.35, 1.2);
    for (let x = slotL.x - 1, i = 0; x <= slotR.x + 1; x += pitch, i++) {
      // Dark above the horizon; below it the ground beyond is left to its own lines.
      add(`gate-${gateInk}`, [{ x, y: slotTop }, { x, y: slotL.y }], p => !solidsGate(p) && !onBeyond(p) && p.y < HORIZON_Y - 0.4);
    }
    buckets.add('gate-carbon', [{ x: slotL.x, y: HORIZON_Y }, { x: slotR.x, y: HORIZON_Y }]);

    // The sky: lightly ruled, densest at the top, opening toward the wall and knocked out round everything standing in it.
    const pattern = barPattern(ctx.random('hier-sky'), 0.86);
    const skyTop = CARD.y0, skyBottom = pageOf(view, new THREE.Vector3(0, wall.wallH, -D + 6)).y;
    const skyPitch = n(ctx, 'skyPitch', 2.2, 0.8, 5);
    for (let y = skyTop + 0.3, i = 0; y < skyBottom; i++, y += skyPitch) {
      const t = (y - skyTop) / (skyBottom - skyTop);
      if (!(t < 0.2 || i % 2 === 0 || (i % 3 === 0 && t < 0.75))) continue;
      const broken = t > 0.22;
      add('sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => !solids(p) && (!broken || pattern[Math.floor((p.x - CARD.x0) / 3.2 + i) % 64]));
    }
    const parts = buckets.toParts(['sky', 'wall', 'pier', 'lane', 'gate', 'print', 'slogan'], INKS);
    parts.push(...cardFrame('V', 'THE HIEROPHANT'));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}

