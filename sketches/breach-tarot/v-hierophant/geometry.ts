import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { FORMAT, MIN_FEATURE, PAGE, PHRASE, TABLOID_CARD, TABLOID_HORIZON_Y, TABLOID_RASTER, depthRaster, halo, hatchMin, layoutLength, tolerance } from '../../kit/format.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, faceDarkness, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong, helixStrands, ribbonEdges, ribbonWidths, strandPoint, strandStrokes, type HelixStroke } from '../../kit/helix.ts';
import { buildSurfaceMesh } from '../../../src/projection.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { clamp, n } from '../../kit/params.ts';
import { atPage, fitDepthRange, horizonCamera, onGround, pageOf, tabloidFrameCamera } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, fineDepth, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';

/**
 * V The Hierophant: by continuing, you agree. The institution as the middleman. A long high wall of
 * a few big slab courses turns across the card on a strong diagonal, near and tall at one side and
 * running away to a vanishing point well off the other, dead level in its courses. Its one narrow
 * gate stands between two taller piers in the near third, dark inside. Every lane on the ground
 * sweeps in from across the foreground and merges, like on-ramps, into that gate. The helix is the
 * thread through the needle: it comes in from the near side, pinches to a bare thread as it passes
 * the slot, and fans out beyond, seen only through the slot and then rising and opening above the
 * wall top in the distance. The facade is cut all over with fine print, justified rows of asemic
 * marks in patches and blanks, with the four words of the phrase set among them.
 *
 * On a smaller card (`kit/format.ts`) the wall, the lanes and the thread's course are the print's world, laid out in
 * tabloid's frame (`hierophantWorld`) and drawn with the card's own camera, so they scale with the card. The fine print
 * is a tone: its letters and rows keep their size and pitch on paper, re-set on the smaller faces, so fewer of them
 * fit. The sky's ruling, the gate's fill and the piers' hatch keep their pitch; the course joints, the lanes where they
 * crowd into the gate and the thread where it is narrower than the pen can part are drawn as one line.
 */
/** The card's depth raster at tabloid; on any other page, the format's. */
/** How many times finer each way the thread's depth test is on a small card (see `drawHierophant`); the raster leaves room for it. */
const THREAD_OVERSAMPLE = 4;
const { W, H, MM_X, MM_Y } = depthRaster(TABLOID_RASTER.width, TABLOID_RASTER.height, THREAD_OVERSAMPLE);
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 6;
const FACET_MM_PER_UNIT = 8.3;
/** The weights of the courses, bottom to top; the last is the lintel course over the gate. */
const COURSES = [0.31, 0.26, 0.23, 0.20];
const COURSE_GAP = 0.15;

/** The card's camera, on the format's page. */
export function gateCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 4000,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/**
 * The same camera in tabloid's frame (its page, raster and horizon, and its field of view whatever the fit): the one
 * the card's world is laid out with. At tabloid it is `gateCamera`.
 */
export function worldCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return tabloidFrameCamera({ fov: n(ctx, 'fov', 54, 36, 75), eye: EYE, near: 8, far: 4000 });
}

type Piece = { slab: Slab; kind: 'wing' | 'pier' | 'cap' | 'lintel'; side: number; course: number; sealed?: boolean };

interface Wall {
  pieces: Piece[];
  /** The gate's centre on the ground, on the wall's centreline; `ex` runs along the wall to the right of the picture, `ez` out of its face toward the eye. */
  G: THREE.Vector3; ex: THREE.Vector3; ez: THREE.Vector3;
  /** +1 when the wall is near on the left and recedes to the right, -1 when mirrored. */
  sx: number;
  D: number; gw: number; pw: number; dw: number; dp: number; wallH: number; gateTop: number;
}

/** Which way the wall turns: near on the left (gate in the left third) or mirrored, by the seed unless the control says. */
function wallSide(ctx: SketchContext): number {
  const p = ctx.params.side;
  if (p === 'left') return 1;
  if (p === 'right') return -1;
  return ctx.random('hier-side')() < 0.5 ? 1 : -1;
}

/**
 * The wall: two wings of staggered slab courses, two piers, a lintel. All courses dead level; the plan runs on a diagonal.
 * It is laid out in tabloid's frame: `view` is `worldCamera`, and page millimetres here are tabloid's.
 */
export function buildWall(ctx: SketchContext, view: THREE.PerspectiveCamera, sx: number): Wall {
  const rng = ctx.random('hier-wall'), tone = ctx.random('hier-tone');
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const wallH = n(ctx, 'wallH', 18, 10, 40);
  const phi = THREE.MathUtils.degToRad(n(ctx, 'angle', 36, 18, 60));
  const gw = n(ctx, 'gateW', 3.6, 1.6, 6);
  const pw = n(ctx, 'pierW', 4.2, 2, 9);
  const capH = n(ctx, 'capH', 2.5, 0.5, 8);
  const dw = n(ctx, 'wallT', 2.2, 1.5, 6), dp = dw + 1;
  const D = n(ctx, 'gateDist', 46, 26, 80);
  const theta = sx * phi;
  const ex = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta)), ez = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
  // The gate stands in the near third: its centre lands a set fraction across the card from the near edge.
  const frac = n(ctx, 'gateAt', 0.3, 0.12, 0.4);
  const xPage = sx > 0 ? TABLOID_CARD.x0 + frac * (TABLOID_CARD.x1 - TABLOID_CARD.x0) : TABLOID_CARD.x1 - frac * (TABLOID_CARD.x1 - TABLOID_CARD.x0);
  const G = new THREE.Vector3((xPage - TABLOID_PAGE.width / 2) * D / f, 0, -D);
  const heights = COURSES.map(w => w * (wallH - (COURSES.length - 1) * COURSE_GAP));
  const bottoms = heights.map((_, c) => heights.slice(0, c).reduce((s, h) => s + h + COURSE_GAP, 0));
  const nC = COURSES.length;
  const pieces: Piece[] = [];
  const at = (s: number) => G.clone().addScaledVector(ex, s);
  const pageX = (s: number) => pageOf(view, at(s), TABLOID_PAGE).x;
  // The picture's x grows with s along the wall; find the s that lands a given page x (the wall's plane keeps depth above 12).
  const depthAt = (s: number) => -at(s).z;
  let sA = -400, sB = 400;
  while (depthAt(sA) < 12) sA += 2;
  while (depthAt(sB) < 12) sB -= 2;
  const sAt = (px: number) => {
    let lo = sA, hi = sB;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (pageX(mid) < px) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  };
  // Where the wall runs out: off the near edge by a margin, and short of the far edge so the horizon shows there.
  const endAt = n(ctx, 'endAt', 0.86, 0.6, 1.1);
  const cardW = TABLOID_CARD.x1 - TABLOID_CARD.x0;
  const sLeft = sx > 0 ? sAt(TABLOID_CARD.x0 - 16) : sAt(TABLOID_CARD.x0 + (1 - endAt) * cardW);
  const sRight = sx > 0 ? sAt(TABLOID_CARD.x0 + endAt * cardW) : sAt(TABLOID_CARD.x1 + 16);
  const joint = 0.2;
  for (const side of [-1, 1]) {
    const limit = side < 0 ? sLeft : sRight;
    const s0 = side * (gw / 2 + pw + joint);
    if ((limit - s0) * side > 1) for (let c = 0; c < nC; c++) {
      let s = s0, first = true;
      while ((limit - s) * side > 0.5) {
        // Slabs of 45..95 mm on the sheet, so the near ones are short in the world and the far ones long;
        // the first of a course a short one, so joints stagger.
        const wPage = first ? 14 + 50 * rng() : 45 + 50 * rng();
        first = false;
        let e = sAt(pageX(s) + side * wPage);
        e = side < 0 ? Math.max(e, limit) : Math.min(e, limit);
        if ((e - s) * side < 0.4) e = limit;
        const w = Math.abs(e - s) - joint;
        const mid = (s + e) / 2;
        s = e;
        if (w < 1.2) continue;
        const centre = at(mid);
        const sl = solid(centre.x, bottoms[c] + heights[c] / 2, centre.z, w, heights[c], dw, pieces.length, 'stack');
        sl.ry = theta;
        // Pale courses (rings only, so the print reads clean), the odd one left without print.
        const sealed = tone() < 0.14;
        sl.tone = sealed ? 0.3 : 0.15 + 0.25 * tone();
        pieces.push({ slab: sl, kind: 'wing', side, course: c, sealed });
      }
    }
    // The pier: a stack of whole slabs on the wall's own courses, then a cap.
    const cp = at(side * (gw / 2 + pw / 2));
    for (let c = 0; c < nC; c++) {
      const sl = solid(cp.x, bottoms[c] + heights[c] / 2, cp.z, pw, heights[c], dp, pieces.length, 'pier');
      sl.ry = theta; sl.tone = 1;
      pieces.push({ slab: sl, kind: 'pier', side, course: c });
    }
    const top = bottoms[nC - 1] + heights[nC - 1] + COURSE_GAP;
    const cap = solid(cp.x, top + capH / 2, cp.z, pw, capH, dp, pieces.length, 'pier');
    cap.ry = theta; cap.tone = 1;
    pieces.push({ slab: cap, kind: 'cap', side, course: nC });
  }
  const lintel = solid(G.x, bottoms[nC - 1] + heights[nC - 1] / 2, G.z, gw - 0.3, heights[nC - 1], dw, pieces.length, 'stack');
  lintel.ry = theta; lintel.tone = 0.3;
  pieces.push({ slab: lintel, kind: 'lintel', side: 0, course: nC - 1 });
  return { pieces, G, ex, ez, sx, D, gw, pw, dw, dp, wallH, gateTop: bottoms[nC - 1] };
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
  else if (k < 0.82) { s.push([[w / 2, AS], [w / 2, BL]]); s.push([[0, XH + 0.6], [w, XH + 0.6]]); }
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

/** The light on the wall's face: mostly frontal, so the pale courses carry only rings and the print reads clean. */
function wallLight(w: Wall): THREE.Vector3 {
  return w.ez.clone().multiplyScalar(0.8).addScaledVector(w.ex, 0.25).add(new THREE.Vector3(0, 0.55, 0)).normalize();
}
/** The light on the piers: low and from the side, so their faces fall to a middle dark. */
function pierLight(w: Wall): THREE.Vector3 {
  return w.ez.clone().multiplyScalar(0.42).addScaledVector(w.ex, 0.57).add(new THREE.Vector3(0, 0.7, 0)).normalize();
}

/**
 * The fine print on the wing slabs' faces, as world strokes: asemic rows in paragraphs, and the phrase's words among
 * them where the format sets the phrase in the art. `view` is the card's camera, `worldView` the world's (tabloid's
 * frame), on which the print's rows are laid out.
 */
export function setFinePrint(ctx: SketchContext, wall: Wall, view: THREE.PerspectiveCamera, worldView: THREE.PerspectiveCamera, depthVisible: (lines: THREE.Vector3[][]) => boolean): Printed {
  const rng = ctx.random('hier-print'), wrng = ctx.random('hier-words');
  const L = n(ctx, 'printLine', 1.6, 1.2, 1.6), P = n(ctx, 'printPitch', 2.5, 2, 3.6);
  const density = n(ctx, 'print', 0.9, 0, 1), margin = n(ctx, 'margin', 1.2, 0.5, 6);
  const unit = L / 8;
  const settings = sloganSettings(ctx);
  // Where the format sets the phrase in the band, none of its words are cut in the wall.
  const words = settings.count > 0 && PHRASE === 'art' ? settings.text.split(' ').filter(Boolean) : [];
  const style = { face: settings.face, height: settings.size };
  const light = wallLight(wall);

  // The face of each wing slab, in page millimetres at its centre: how many a world unit along it and up it comes to
  // on the sheet, through a camera (the card's, or at tabloid's scale the world's).
  const mats = new Map<number, THREE.Matrix4>();
  const faceMat = (i: number) => { let m = mats.get(i); if (!m) { m = slabMatrix(wall.pieces[i].slab); mats.set(i, m); } return m; };
  const scaler = (camera: THREE.PerspectiveCamera, page: { width: number; height: number }) => {
    const scales = new Map<number, { hx: number; hy: number }>();
    return (i: number) => {
      let s = scales.get(i);
      if (!s) {
        const sl = wall.pieces[i].slab, m = faceMat(i);
        const at = (u: number, v: number) => pageOf(camera, new THREE.Vector3(u, v, sl.d / 2 + 0.03).applyMatrix4(m), page);
        const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
        s = { hx: dist(at(-0.5, 0), at(0.5, 0)), hy: dist(at(0, -0.5), at(0, 0.5)) };
        scales.set(i, s);
      }
      return s;
    };
  };
  const faceScale = scaler(view, PAGE);
  // The print's faces: at tabloid the card's own camera, so the print is laid out exactly as it was.
  const printScale = FORMAT.tabloid ? faceScale : scaler(worldView, TABLOID_PAGE);
  const world = (i: number, u: number, v: number) => {
    const sl = wall.pieces[i].slab, sc = faceScale(i);
    return new THREE.Vector3(u / sc.hx, v / sc.hy, sl.d / 2 + 0.03).applyMatrix4(faceMat(i));
  };

  // Every row of every wing slab on the print, and which ones carry text.
  let slots: Slot[] = [];
  wall.pieces.forEach((pc, i) => {
    if (pc.kind !== 'wing' || pc.sealed) return;
    const sl = pc.slab, sc = printScale(i);
    const Wmm = sl.w * sc.hx, Hmm = sl.h * sc.hy;
    const normal = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(sl.rx, sl.ry, sl.rz, 'XYZ'));
    const band = Math.min(sl.w, sl.h) / 2 * (0.12 + 0.6 * faceDarkness(normal, light, sl.tone));
    const mx = band * sc.hx + margin, my = band * sc.hy + margin * 0.7;
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
  // On a smaller card the print is a tone: the letters keep their size and the rows their pitch on paper, so the card
  // keeps every k-th of the print's rows (k the nearest whole number to 1 / s), each where the print has it on its face, in proportion, with
  // its paragraph, indent and ragged end; the paper inside the rings is a halo. Fewer letters, the same patches.
  if (!FORMAT.tabloid) {
    const k = Math.max(1, Math.round(1 / FORMAT.s)), clear = halo(margin);
    slots = slots.filter(slot => slot.r % k === 0).flatMap(slot => {
      const sl = wall.pieces[slot.piece].slab, sc = faceScale(slot.piece), tab = printScale(slot.piece);
      const rx = sc.hx / tab.hx, ry = sc.hy / tab.hy, extra = Math.max(0, clear - margin * rx);
      // The row's cap line in proportion on the face, the letters hung from it at their own size.
      const v = (slot.v + L) * ry - 0.7 * extra - L;
      const normal = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(sl.rx, sl.ry, sl.rz, 'XYZ'));
      const band = Math.min(sl.w, sl.h) / 2 * (0.12 + 0.6 * faceDarkness(normal, light, sl.tone));
      const floor = -sl.h * sc.hy / 2 + band * sc.hy + 0.7 * clear;
      if (v - 0.5 < floor) return [];
      return [{ ...slot, r: slot.r / k, v, u0: slot.u0 * rx + extra, width: slot.width * rx - 2 * extra }];
    });
  }

  // The phrase: one word to a row, staggered from the top of the wall down and side to side, each
  // tried at a few places along its row until one lands inside the card and in clear view.
  const targetsX = wall.sx > 0 ? [0.3, 0.72, 0.42, 0.8] : [0.7, 0.28, 0.58, 0.2];
  const topY = CARD.y0 + layoutLength(60), baseY = HORIZON_Y + layoutLength(30);
  const taken: Slot[] = [];
  const takenAt: Point[] = [];
  words.forEach((word, i) => {
    const tx = CARD.x0 + (CARD.x1 - CARD.x0) * (targetsX[i % 4] + (wrng() - 0.5) * 0.08);
    const ty = topY + (baseY - topY) * (i + 0.5) / words.length;
    const ww = measureStrokeText(word, style);
    const cands: { slot: Slot; frac: number; cost: number }[] = [];
    for (const slot of slots) {
      if (taken.some(t => t.piece === slot.piece && Math.abs(t.r - slot.r) < 3)) continue;
      for (const frac of [0.12, 0.28, 0.44, 0.6, 0.76, 0.9]) {
        const u = slot.u0 + slot.width * frac;
        const p = pageOf(view, world(slot.piece, u, slot.v + settings.size / 2));
        // Well apart from the others, so the eye finds one and has to hunt for the next.
        if (takenAt.some(q => Math.hypot(q.x - p.x, q.y - p.y) < layoutLength(55))) continue;
        if (p.x - ww / 2 < CARD.x0 + layoutLength(7) || p.x + ww / 2 > CARD.x1 - layoutLength(7) || p.y < CARD.y0 + layoutLength(5) || p.y > HORIZON_Y + layoutLength(45)) continue;
        // A word forced into an unprinted row would sit alone and be easy to find: prefer rows already in a paragraph.
        const near = (r: number) => slots.some(o => o.piece === slot.piece && o.r === r && o.printed);
        const lonely = !slot.printed && !near(slot.r - 1) && !near(slot.r + 1);
        cands.push({ slot, frac, cost: Math.hypot((p.x - tx) * 0.8, p.y - ty) + (slot.printed ? 0 : layoutLength(12)) + (lonely ? layoutLength(80) : 0) });
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
      takenAt.push(pageOf(view, world(c.slot.piece, u + ww / 2, c.slot.v + settings.size / 2)));
      return;
    }
  });

  // Lay the rows out and emit their marks as world strokes on the faces.
  const asemic: THREE.Vector3[][] = [], out: THREE.Vector3[][] = [];
  for (const slot of slots) {
    if (!slot.printed) continue;
    const width = slot.width * (slot.last && !slot.special ? slot.ragged : 1);
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
    // A row of one word reads as a stray on the print; on a small face, a row may be only a word long.
    if (chosen.length < (FORMAT.tabloid ? 2 : 1)) continue;
    const sum = chosen.reduce((s, c) => s + c.w, 0);
    const gap = slot.last && !slot.special ? gmin * 1.15 : Math.min(gmin * 3.5, (width - sum) / (chosen.length - 1));
    let x = 0;
    for (const c of chosen) {
      const u = slot.u0 + x;
      if (c.word) {
        for (const path of strokeText(c.word, 0, 0, style)) out.push(path.map(q2 => world(slot.piece, u + q2.x, slot.v + style.height - q2.y)));
      } else if (c.strokes) {
        for (const st of c.strokes) {
          asemic.push(st.map(([gx, gy]) => world(slot.piece, u + (gx + LEAN * (BL - gy)) * unit, slot.v + (BL - gy) * unit)));
        }
      }
      x += c.w + gap;
    }
  }
  return { asemic, words: out };
}

/** Hatch across a slab's whole front face (inside one ring just in from the outline), `pitchMm` apart on the sheet, crossed on request; `mmPerUnit` is the sheet's scale at the slab. */
function stoneHatch(sl: Slab, mmPerUnit: number, pitchMm: number, cross: boolean): THREE.Vector3[][] {
  const m = slabMatrix(sl);
  const hx = sl.w / 2, hy = sl.h / 2, z = sl.d / 2 + 0.006;
  const P = (u: number, v: number) => new THREE.Vector3(u, v, z).applyMatrix4(m);
  const out: THREE.Vector3[][] = [];
  const r = 0.1;
  // The ring just inside the outline; on a small card, where it would sit closer to the outline than a feature on paper, the outline alone.
  if (r * mmPerUnit >= MIN_FEATURE) out.push([P(-(hx - r), -(hy - r)), P(hx - r, -(hy - r)), P(hx - r, hy - r), P(-(hx - r), hy - r), P(-(hx - r), -(hy - r))]);
  const a = hx - 0.2, b = hy - 0.2;
  const families: [number, number][] = [[0.9, pitchMm]];
  if (cross) families.push([-0.9, pitchMm * 1.6]);
  for (const [angle, pm] of families) {
    const step = pm / mmPerUnit, dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
    const reach = Math.hypot(a, b);
    for (let k = -reach + step / 2; k < reach; k += step) {
      // The line (nx, ny)·k + t (dx, dy) clipped to the face rectangle.
      let lo = -Infinity, hi = Infinity, ok = true;
      for (const [o, d, h] of [[nx * k, dx, a], [ny * k, dy, b]]) {
        if (Math.abs(d) < 1e-9) { if (Math.abs(o) > h) ok = false; continue; }
        const t0 = (-h - o) / d, t1 = (h - o) / d;
        lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      }
      if (ok && hi - lo > 0.05) out.push([P(nx * k + dx * lo, ny * k + dy * lo), P(nx * k + dx * hi, ny * k + dy * hi)]);
    }
  }
  return out;
}

/**
 * The straight strokes kept on the page so far, by cell, to find where a new one would run beside one of them (within
 * 10° of parallel, alongside it rather than beyond its ends) closer than `gap` millimetres.
 */
function besideKept(gap: number) {
  type Seg = { a: Point; b: Point; ux: number; uy: number; length: number };
  const cells = new Map<string, Seg[]>();
  const sin = Math.sin(THREE.MathUtils.degToRad(10));
  const at = (x: number, y: number) => `${Math.floor(x / gap)},${Math.floor(y / gap)}`;
  const beside = (p: Point, ux: number, uy: number): boolean => {
    const cx = Math.floor(p.x / gap), cy = Math.floor(p.y / gap);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const sg of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
      if (Math.abs(ux * sg.uy - uy * sg.ux) > sin) continue;
      const along = (p.x - sg.a.x) * sg.ux + (p.y - sg.a.y) * sg.uy;
      if (along < 0 || along > sg.length) continue;
      if (Math.abs((p.x - sg.a.x) * sg.uy - (p.y - sg.a.y) * sg.ux) < gap) return true;
    }
    return false;
  };
  const keep = (path: Point[]) => {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], length = Math.hypot(b.x - a.x, b.y - a.y);
      if (!length) continue;
      const sg: Seg = { a, b, ux: (b.x - a.x) / length, uy: (b.y - a.y) / length, length };
      const steps = Math.ceil(length / gap) + 1, seen = new Set<string>();
      for (let k = 0; k <= steps; k++) {
        const key = at(a.x + (b.x - a.x) * k / steps, a.y + (b.y - a.y) * k / steps);
        if (seen.has(key)) continue;
        seen.add(key);
        const list = cells.get(key);
        if (list) list.push(sg); else cells.set(key, [sg]);
      }
    }
  };
  /** The stretches of `path` that run beside no kept stroke, each kept in turn. */
  const pieces = (path: Point[], step = 0.15): Point[][] => {
    const out: Point[][] = [];
    let run: Point[] = [];
    const flush = () => { if (run.length > 1) out.push(run); run = []; };
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], length = Math.hypot(b.x - a.x, b.y - a.y);
      if (!length) continue;
      const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length, n2 = Math.max(1, Math.ceil(length / step));
      for (let k = 0; k <= n2; k++) {
        const q = { x: a.x + (b.x - a.x) * k / n2, y: a.y + (b.y - a.y) * k / n2 };
        if (beside(q, ux, uy)) flush(); else if (!run.length || run[run.length - 1].x !== q.x || run[run.length - 1].y !== q.y) run.push(q);
      }
    }
    flush();
    for (const piece of out) keep(piece);
    return out;
  };
  return { pieces };
}

/* ------------------------------------------------------------------------------------------ */
/* The lanes                                                                                  */
/* ------------------------------------------------------------------------------------------ */

interface Network {
  /** Lane edges, course lines and the straight run through the passage, in page millimetres; `behind` ones lie past the gate's front. */
  paths: { path: Point[]; behind: boolean }[];
}

/** One lane in plan: its two edges and centre line, `LANE_SAMPLES + 1` points each, from off the card to the gate. */
export interface Leaf { left: THREE.Vector3[]; right: THREE.Vector3[]; centre: THREE.Vector3[] }
const LANE_SAMPLES = 140;

/**
 * Lanes in plan: each a ribbon curving in from a point round the foot and sides of the card and
 * arriving square to the gate, the ribbons lying edge to edge across the slot. Where they run side
 * by side there is one line between them; as they part, the line opens into two, so the lanes merge
 * as on-ramps do. Courses of paving cross each ribbon, longer the wider the ribbon looks.
 *
 * Laid out in tabloid's frame: `view` is `worldCamera`, and the entry points lie round the U of tabloid's card. The
 * ribbons lie side by side across the passage, `w` wide each, `trunk` in all; `laneNetwork` draws them.
 */
export function laneLeaves(ctx: SketchContext, view: THREE.PerspectiveCamera, wall: Wall): { leaves: Leaf[]; trunk: number; w: number } {
  const rng = ctx.random('hier-lanes');
  const K = Math.round(n(ctx, 'lanes', 12, 3, 16));
  const { G, ex, ez, gw, dp } = wall;
  const frame = (a: number, b: number) => G.clone().addScaledVector(ez, a).addScaledVector(ex, b);
  const aOf = (p: THREE.Vector3) => ez.dot(p.clone().sub(G)), bOf = (p: THREE.Vector3) => ex.dot(p.clone().sub(G));

  // Entry points: round the U of the card's foot and sides, kept to the ground in front of the wall.
  const CARD = TABLOID_CARD;
  const yS = TABLOID_HORIZON_Y + 25;
  const perimeter = [{ x: CARD.x0, y: yS }, { x: CARD.x0, y: CARD.y1 }, { x: CARD.x1, y: CARD.y1 }, { x: CARD.x1, y: yS }];
  const seg = perimeter.slice(1).map((p, i) => Math.hypot(p.x - perimeter[i].x, p.y - perimeter[i].y));
  const total = seg.reduce((s, v) => s + v, 0);
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
  const fine: THREE.Vector3[] = [];
  for (let i = 0; i <= 600; i++) {
    const e = onGround(view, along(i / 600), TABLOID_PAGE);
    if (aOf(e) > dp / 2 + 2.5) fine.push(e);
  }
  const entries: THREE.Vector3[] = [];
  for (let j = 0; j < K && fine.length; j++) {
    const t = (j + 0.5 + (rng() - 0.5) * 0.6) / K;
    entries.push(fine[Math.min(fine.length - 1, Math.max(0, Math.floor(t * fine.length)))]);
  }
  entries.sort((p, q) => bOf(p) - bOf(q));
  const k = entries.length;
  const trunk = gw - 0.7, w = trunk / k;

  const leaves: Leaf[] = [];
  const N = LANE_SAMPLES;
  entries.forEach((E, j) => {
    const bj = -trunk / 2 + (j + 0.5) * w;
    const P3 = frame(dp / 2, bj);
    const dist = E.distanceTo(P3);
    const P2 = frame(dp / 2 + THREE.MathUtils.clamp(0.55 * dist, 8, 18), bj);
    const P1 = E.clone().lerp(P2, 0.5);
    // Start a little beyond the entry so the lane runs off the card, never ends in it.
    const P0 = E.clone().addScaledVector(E.clone().sub(P1).normalize(), 4);
    const curve = new THREE.CubicBezierCurve3(P0, P0.clone().lerp(P1, 0.7).lerp(E, 0.2), P2.clone().lerp(P3, 0.2).lerp(P1, 0.1), P3);
    const leaf: Leaf = { left: [], right: [], centre: [] };
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const c = curve.getPoint(t), T = curve.getTangent(t);
      // The normal that points along +b at the gate, kept the same way round all the way.
      const nrm = new THREE.Vector3(-T.z, 0, T.x).normalize();
      leaf.centre.push(c);
      leaf.right.push(c.clone().addScaledVector(nrm, w / 2));
      leaf.left.push(c.clone().addScaledVector(nrm, -w / 2));
    }
    leaves.push(leaf);
  });
  return { leaves, trunk, w };
}

/** The lanes drawn with the card's camera (`view`): their edges, the edges through the passage and the paving courses, in page millimetres. */
function laneNetwork(view: THREE.PerspectiveCamera, wall: Wall, lanes: { leaves: Leaf[]; trunk: number; w: number }): Network {
  const { leaves, trunk, w } = lanes;
  const N = LANE_SAMPLES;
  const { G, ex, ez, dp } = wall;
  const frame = (a: number, b: number) => G.clone().addScaledVector(ez, a).addScaledVector(ex, b);
  const ground = (x: number, z: number) => pageOf(view, new THREE.Vector3(x, 0, z));
  const paths: Network['paths'] = [];
  const toPage = (pts: THREE.Vector3[]): Point[] => pts.map(p => ground(p.x, p.z));
  const thr = 0.12;
  // Two lanes part where their edges are `thr` apart; on a small card, also only where that gap is a feature on paper
  // (`MIN_FEATURE`): closer, the pen draws the one line between them.
  const pageSep = (i: number, a: THREE.Vector3[], b: THREE.Vector3[]) => { const p = ground(a[i].x, a[i].z), q = ground(b[i].x, b[i].z); return Math.hypot(p.x - q.x, p.y - q.y); };
  const parted = (i: number, a: THREE.Vector3[], b: THREE.Vector3[]) => a[i].distanceTo(b[i]) >= thr && (!MIN_FEATURE || pageSep(i, a, b) >= MIN_FEATURE);
  const drawRun = (pts: THREE.Vector3[], keep: (i: number) => boolean) => {
    let run: THREE.Vector3[] = [];
    for (let i = 0; i < pts.length; i++) {
      if (keep(i)) run.push(pts[i]); else { if (run.length > 1) paths.push({ path: toPage(run), behind: false }); run = []; }
    }
    if (run.length > 1) paths.push({ path: toPage(run), behind: false });
  };
  // Over the last stretch before the gate the lines crowd: only every other boundary between lanes is kept there.
  const cvg = Math.round(N * 0.7);
  const keepB = (b: number, i: number) => i < cvg || b % 2 === 0 || b === 0 || b === leaves.length;
  // On a small card a lane narrower on paper than a feature is a flat band too narrow to draw as two lines. Where it
  // runs on its own it is drawn as its centre line; where lanes run side by side, only every second, fourth, ...
  // boundary between them is kept, as many as leave a feature's width of paper between the lines.
  const small = MIN_FEATURE > 0;
  const widthMm = small ? leaves.map(lf => lf.left.map((_, i) => pageSep(i, lf.left, lf.right))) : [];
  const stride = (b: number, i: number) => {
    const narrowest = Math.min(widthMm[Math.max(0, b - 1)][i], widthMm[Math.min(leaves.length - 1, b)][i]);
    let k = 1;
    while (k * narrowest < MIN_FEATURE && k < 64) k *= 2;
    return k;
  };
  // Each decision held steady along the lane, so a line does not break into dashes where it sits on a threshold.
  const partedFlags = small ? leaves.map((_, b) => b === 0 ? [] : steady(leaves[b].left.map((_, i) => parted(i, leaves[b - 1].right, leaves[b].left)), 5)) : [];
  const partedAt = (b: number, i: number) => small ? partedFlags[b][i] : parted(i, leaves[b - 1].right, leaves[b].left);
  const sharedAt = (b: number, i: number) => b > 0 && b < leaves.length && !partedAt(b, i);
  const keepShared = (b: number, i: number) => !small || !sharedAt(b, i) || b % stride(b, i) === 0;
  const aloneFlags = small ? leaves.map((_, j) => steady(leaves[j].left.map((_, i) => widthMm[j][i] < MIN_FEATURE && !sharedAt(j, i) && !sharedAt(j + 1, i)), 5)) : [];
  const alone = (j: number, i: number) => small && aloneFlags[j][i];
  leaves.forEach((lf, j) => {
    // The edge toward -b is always drawn (boundary j); the edge toward +b (boundary j + 1) only where it is not shared with the next lane.
    drawRun(lf.left, i => keepB(j, i) && keepShared(j, i) && !alone(j, i));
    if (j === leaves.length - 1) drawRun(lf.right, i => !alone(j, i));
    else {
      const nx = leaves[j + 1];
      drawRun(lf.right, i => (partedAt(j + 1, i) || i === N) && keepB(j + 1, i) && !alone(j, i));
      drawRun(nx.left, i => partedAt(j + 1, i) && keepB(j + 1, i) && !alone(j + 1, i));
    }
    if (small) drawRun(lf.centre, i => alone(j, i));
  });
  // The edges that run through the passage and stop at the back of the gate (on a small card, as many as the lanes keep there).
  const edges = [-trunk / 2, ...leaves.map((_, j) => -trunk / 2 + (j + 1) * w)];
  edges.forEach((b, e) => {
    if (e % 2 === 1 && e !== edges.length - 1) return;
    if (small && e % stride(e, N) !== 0 && e !== edges.length - 1) return;
    const a = frame(dp / 2, b), c = frame(-dp / 2, b);
    paths.push({ path: [ground(a.x, a.z), ground(c.x, c.z)], behind: true });
  });
  // Courses of paving across each ribbon: spaced by how wide the ribbon looks, set half a course off in the next one;
  // over the last stretch only every other ribbon keeps its courses, and they open out.
  leaves.forEach((lf, j) => {
    let acc = (j % 2) * 0.5, prev = ground(lf.centre[N].x, lf.centre[N].z);
    for (let i = N - 1; i >= 0; i--) {
      const cp = ground(lf.centre[i].x, lf.centre[i].z);
      const lp = ground(lf.left[i].x, lf.left[i].z), rp = ground(lf.right[i].x, lf.right[i].z);
      const width = Math.hypot(lp.x - rp.x, lp.y - rp.y);
      const crowded = i >= cvg;
      const step = Math.max(2.2, 1.7 * width) * (crowded ? 1.8 : 1);
      acc += Math.hypot(cp.x - prev.x, cp.y - prev.y) / step;
      prev = cp;
      // A course across a lane narrower than a feature on paper would be a speck: a small card leaves it out.
      if (acc >= 1) { acc -= 1; if (i > 3 && (!crowded || j % 2 === 0) && !(small && width < MIN_FEATURE)) paths.push({ path: [lp, rp], behind: false }); }
    }
  });
  return { paths };
}

/* ------------------------------------------------------------------------------------------ */
/* The helix: thread through a needle                                                         */
/* ------------------------------------------------------------------------------------------ */

interface PieceOptions { radius: number; pitch: number; taper: number; flare: number; pitchGrowth: number; ends?: { margin: number; tip: number } }

/**
 * The kit's helix, laid along a curve with its ends brought to a clean stop: each strand narrows its
 * ribbon to a thread over the last stretch of its run and stops there, short of the window's edge by
 * `margin` millimetres, the second strand a little before the first. Built as `helixAlong` builds it
 * (same strands, same strokes), with the ribbon's width scaled toward its centre line before the bend.
 */
function helixAlongEnded(ctx: SketchContext, view: THREE.PerspectiveCamera, curve: THREE.CatmullRomCurve3,
  o: { radius: number; width: number; pitch: number; spread: number; narrow: number; twist: number; density: number; interruption: number; taper: number; flare: number; pitchGrowth: number }, margin: number, tip: number) {
  const start = curve.getPointAt(0);
  const length = curve.getLength();
  const frames = curve.computeFrenetFrames(400, false);
  const template = helixStrands({ ...ctx, params: { ...ctx.params, helixTurns: 1.6, shellTwist: o.twist } });
  const STEPS = 400;
  const widthAt = (s: number) => o.taper ** (s ** o.flare);
  const turnsTo: number[] = [0];
  for (let i = 1; i <= STEPS; i++) turnsTo.push(turnsTo[i - 1] + 1 / (STEPS * widthAt((i - 0.5) / STEPS) ** o.pitchGrowth));
  const curveAt = (u: number): number => {
    const want = u * turnsTo[STEPS];
    let lo = 0, hi = STEPS;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (turnsTo[mid] < want) lo = mid; else hi = mid; }
    const span = turnsTo[hi] - turnsTo[lo];
    return (lo + (span > 0 ? (want - turnsTo[lo]) / span : 0)) / STEPS;
  };
  const strands = template.map((st, i) => ({
    ...st, x: start.x, y: start.y, z: start.z, y0: 0, y1: length, radius: o.radius + o.spread * i, depth: 1, width: o.width - o.narrow * i,
    swell: 0, centre: -1e3, turns: length / o.pitch * turnsTo[STEPS],
  }));
  const bend = (p: THREE.Vector3): THREE.Vector3 => {
    const u = clamp((p.y - start.y) / length, 0, 1);
    const s = curveAt(u), scale = widthAt(s);
    const k = Math.min(400, Math.round(s * 400));
    return curve.getPointAt(s).addScaledVector(frames.normals[k], (p.x - start.x) * scale).addScaledVector(frames.binormals[k], (p.z - start.z - 0.25) * scale);
  };
  // Where each strand stops: before its centre line leaves the window by `margin`, the second strand a little earlier.
  const reach = (st: typeof strands[number]) => {
    for (let k = 0; k <= 400; k++) {
      const q = pageOf(view, bend(strandPoint(st, k / 400, 0)));
      if (q.x < CARD.x0 + margin || q.x > CARD.x1 - margin || q.y < CARD.y0 + margin || q.y > CARD.y1 - margin) return Math.max(0, (k - 4) / 400);
    }
    return 1;
  };
  const natural = Math.min(1, ...strands.map(reach));
  // Where a strand stops, as a share of the strand's run (u); the second stops a little short of the first along the curve.
  const uOfS = (sv2: number) => turnsTo[Math.round(clamp(sv2, 0, 1) * STEPS)] / turnsTo[STEPS];
  const sOfU = (u: number) => curveAt(u);
  const stop = strands.map((_, i) => uOfS(sOfU(natural) - 0.03 * i));
  // The tip: over its last `tip` millimetres on the sheet each strand narrows its ribbon to the centre line, so the
  // wide, open part stays wide and only the very end comes to a point.
  const arc = strands.map(st => {
    const acc = [0];
    let prev = pageOf(view, bend(strandPoint(st, 0, 0)));
    for (let k = 1; k <= 400; k++) {
      const q = pageOf(view, bend(strandPoint(st, k / 400, 0)));
      acc.push(acc[k - 1] + Math.hypot(q.x - prev.x, q.y - prev.y));
      prev = q;
    }
    return acc;
  });
  const lenAt = (i: number, t: number) => { const f = clamp(t, 0, 1) * 400, k = Math.min(399, Math.floor(f)); return arc[i][k] + (arc[i][k + 1] - arc[i][k]) * (f - k); };
  const gOf = (i: number, t: number) => clamp((lenAt(i, stop[i]) - lenAt(i, t)) / tip, 0, 1) ** 0.8;
  const strokes: HelixStroke[] = [];
  strands.forEach((st, i) => {
    const thin = (p: THREE.Vector3): THREE.Vector3 => {
      const t = clamp((p.y - start.y) / length, 0, 1);
      const c = strandPoint(st, t, 0);
      return c.addScaledVector(p.clone().sub(c), gOf(i, t));
    };
    for (const h of strandStrokes(st, o.density, o.interruption, ctx, view)) {
      const out: THREE.Vector3[] = [];
      for (let k = 0; k < h.points.length; k++) {
        const p = h.points[k], t = (p.y - start.y) / length;
        if (t > stop[i]) {
          const prev = h.points[k - 1];
          if (prev && (prev.y - start.y) / length < stop[i]) {
            const tp = (prev.y - start.y) / length;
            out.push(thin(prev.clone().lerp(p, (stop[i] - tp) / (t - tp))));
          }
          break;
        }
        out.push(thin(p));
      }
      if (out.length > 1) strokes.push({ ...h, points: out.map(bend) });
    }
  });
  const meshes = strands.map((st, i) => buildSurfaceMesh((u, v) => {
    const t = Math.min(u, stop[i]);
    const c = bend(strandPoint(st, t, 0));
    return c.lerp(bend(strandPoint(st, t, 2 * v - 1)), gOf(i, t));
  }, {}, 320, 8));
  return { strokes, meshes };
}

/**
 * The twin helix as pieces that meet at the pinch. The kit's wiggles are fixed in world units,
 * so a thread this thin is built `S` times the size, seen from a camera moved out to match, and
 * brought back. `taper` is how much wider the piece is at its end than at its start.
 */
function helixPiece(ctx: SketchContext, view: THREE.PerspectiveCamera, pts: THREE.Vector3[], o: PieceOptions) {
  const S = 40;
  const sv = view.clone();
  sv.position.multiplyScalar(S); sv.near *= S; sv.far *= S;
  sv.updateProjectionMatrix(); sv.updateMatrixWorld(true);
  const big = new THREE.CatmullRomCurve3(pts.map(p => p.clone().multiplyScalar(S)), false, 'centripetal');
  const r = o.radius * S;
  const spec = { radius: r, width: r * 0.95, pitch: o.pitch * S, spread: r * 0.3, narrow: r * 0.12, twist: 0.35, density: 0.5, interruption: 0.3, taper: o.taper, flare: o.flare, pitchGrowth: o.pitchGrowth };
  const made = o.ends ? helixAlongEnded(ctx, sv, big, spec, o.ends.margin, o.ends.tip) : helixAlong(ctx, sv, big, spec);
  return {
    strokes: made.strokes.map(h => ({ ...h, points: h.points.map(q => q.clone().multiplyScalar(1 / S)) })),
    meshes: made.meshes.map(g => g.scale(1 / S, 1 / S, 1 / S)),
  };
}

/** Flip every run of equal flags shorter than `least` samples that lies between two others, so a decision does not flicker along a line. */
function steady(flags: boolean[], least: number): boolean[] {
  const out = [...flags];
  for (let i = 0; i < out.length;) {
    let j = i;
    while (j < out.length && out[j] === out[i]) j++;
    if (i > 0 && j < out.length && j - i < least) for (let k = i; k < j; k++) out[k] = !out[k];
    i = j;
  }
  return out;
}

/**
 * On a small card, the stretches of a helix piece's strands narrower on paper than a feature (`MIN_FEATURE`) over a
 * twentieth of their length or more (the thread, an arm seen edge-on; not a twist's passing edge-on moment): each is
 * drawn as its strand's centre line, a world stroke in the edges' ink; where both strands are that thin and run closer
 * than a feature (the thread through the slot), as strand a's line alone. `masks` holds, per strand, the centre line
 * on the page over every such stretch, round which the strand's own strokes are cleared.
 */
function strandThreads(view: THREE.Camera, strokes: HelixStroke[], tip = 0): { centres: { strand: 'a' | 'b'; points: THREE.Vector3[] }[]; masks: Map<'a' | 'b', Point[][]> } {
  const page = (p: THREE.Vector3) => pageOf(view, p);
  const lines = (['a', 'b'] as const).map(strand => {
    const edges = ribbonEdges(strokes, `strand-${strand}`);
    if (!edges) return null;
    const [e1, e2] = edges.map(h => h.points);
    const count = Math.min(e1.length, e2.length);
    const mid = Array.from({ length: count }, (_, k) => e1[k].clone().add(e2[k]).multiplyScalar(0.5));
    const widths = ribbonWidths(edges, view);
    // Narrow over a stretch, not where the twist turns the ribbon edge-on for a moment (a twentieth of the strand or less);
    // and never over the strand's last `tip` millimetres, where it comes to its point: that taper keeps its edges.
    const toEnd: number[] = new Array(count).fill(0);
    for (let k = count - 2; k >= 0; k--) { const p = page(mid[k]), q = page(mid[k + 1]); toEnd[k] = toEnd[k + 1] + Math.hypot(q.x - p.x, q.y - p.y); }
    return { strand, mid, narrow: steady(widths.map(w => w < MIN_FEATURE), Math.ceil(count / 20)).map((thin, k) => thin && toEnd[k] > tip) };
  });
  const [a, b] = lines;
  const drawn = (line: NonNullable<typeof a>) => line.narrow.map((thin, k) => {
    if (!thin || line.strand === 'a' || !a || k >= a.mid.length || !a.narrow[k]) return thin;
    const p = page(a.mid[k]), q = page(line.mid[k]);
    return Math.hypot(p.x - q.x, p.y - q.y) >= MIN_FEATURE;
  });
  const stretches = (mid: THREE.Vector3[], keep: boolean[]) => {
    const out: THREE.Vector3[][] = [];
    let run: THREE.Vector3[] = [];
    keep.forEach((on, k) => { if (on) run.push(mid[k]); else { if (run.length > 1) out.push(run); run = []; } });
    if (run.length > 1) out.push(run);
    return out;
  };
  const centres: { strand: 'a' | 'b'; points: THREE.Vector3[] }[] = [];
  const masks = new Map<'a' | 'b', Point[][]>();
  for (const line of [a, b]) {
    if (!line) continue;
    for (const points of stretches(line.mid, steady(drawn(line), Math.ceil(line.mid.length / 20)))) centres.push({ strand: line.strand, points });
    masks.set(line.strand, stretches(line.mid, line.narrow).map(run => run.map(page)));
  }
  return { centres, masks };
}

/** The card's world: which way the wall turns, the wall, the lanes in plan, and the thread's course in three pieces. */
export interface HierophantWorld {
  camera: THREE.PerspectiveCamera;
  sx: number;
  wall: Wall;
  lanes: { leaves: Leaf[]; trunk: number; w: number };
  thread: { near: THREE.Vector3[]; slot: THREE.Vector3[]; climb: THREE.Vector3[] };
}

/**
 * The card's world, laid out in tabloid's frame with `worldCamera` (page points picked on tabloid's card), so every size
 * and fit builds the same wall, lanes and thread, to the bit; the card's own camera then draws them.
 */
export function hierophantWorld(ctx: SketchContext): HierophantWorld {
  const camera = worldCamera(ctx);
  const eye = camera.position.clone();
  const sx = wallSide(ctx);
  const wall = buildWall(ctx, camera, sx);
  const { G, ex, ez, dp } = wall;
  // The helix. Near side: in from the foreground, sweeping toward the slot and narrowing until it is a bare thread in the passage.
  const hS = n(ctx, 'threadHeight', 6.2, 3, 10);
  const P = (a: number, b: number, h: number) => G.clone().addScaledVector(ez, a).addScaledVector(ex, b).setY(h);
  const lat = -sx; // the foreground lies on the side of the axis toward the bottom of the card
  // It comes in from just outside the foot of the card on the near side, over the lanes.
  const startPage = { x: sx > 0 ? TABLOID_CARD.x1 + 14 : TABLOID_CARD.x0 - 14, y: TABLOID_CARD.y1 - 4 };
  const near = [
    atPage(camera, startPage, 17, TABLOID_PAGE), P(20, lat * 4.5, 2.6), P(12, lat * 2, 3.8), P(6, lat * 0.6, 5), P(dp / 2 + 0.3, 0, hS - 0.2), P(0, 0, hS),
  ];
  const mid = near[near.length - 1];
  const midPage = pageOf(camera, mid, TABLOID_PAGE);
  const d0 = eye.distanceTo(mid);
  const toward = sx; // the far part veers toward the open side of the card
  // Beyond the gate: through the slot the strands start to part; behind the wall it is out of sight; then, over the far
  // wing, it rises above the wall top and opens, the strands loosening and fanning, toward the top of the card.
  const beyond = (dx: number, dy: number, k: number) => atPage(camera, { x: midPage.x + toward * dx, y: midPage.y + dy }, d0 * k, TABLOID_PAGE);
  const slot = [mid, beyond(0.5, -6, 1.12), beyond(1.5, -34, 1.45), beyond(5, -60, 1.9), beyond(24, -82, 2.5), beyond(75, -86, 3.2)];
  const climb = [slot[slot.length - 1], beyond(105, -100, 3.8), beyond(118, -128, 4.1), beyond(126, -160, 4.4), beyond(130, -188, 4.6)];
  return { camera, sx, wall, lanes: laneLeaves(ctx, camera, wall), thread: { near, slot, climb } };
}

export function drawHierophant(ctx: SketchContext): Part[] {
  const view = gateCamera(ctx);
  const eye = view.position.clone();
  const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  const world = hierophantWorld(ctx);
  const { wall } = world;
  const { G, ex, ez, dp } = wall;
  const light = wallLight(wall), dark = pierLight(wall);
  // On a small card each slab's outline is drawn for the card (`facetStrokes`' trim: no back edges, slivers folded in).
  const trim = { view };

  const strokes: Stroke[] = [];
  for (const pc of wall.pieces) {
    const sl = pc.slab, at = new THREE.Vector3(sl.x, sl.y, sl.z);
    const mm = mmPerUnit(at);
    const isPier = pc.kind === 'pier' || pc.kind === 'cap';
    const group = isPier ? 'pier' : 'wall';
    // Strokes along a slab's underside: the print leaves them out (slivers through the joints, the lintel's soffit). On a
    // small card the trimmed outline already folds those slivers into the outline and draws each edge on its own, so
    // there the edges stay: the foot of the wall and the gate's head are among them.
    const underside = (st: { family: string; points: THREE.Vector3[] }) => (FORMAT.tabloid || st.family !== 'edge') && st.points.every(q => Math.abs(q.y - (sl.y - sl.h / 2)) < 0.02);
    // The wall is one stone mass drawn in carbon: outlines and sparse contour rings, and no coloured fields.
    // The piers alone are heavy: outline and a ring, then hatch across the whole face, tighter at the foot
    // where the shadow gathers and opening toward the top.
    if (isPier) {
      for (const st of facetStrokes(sl, dark, eye, true, undefined, trim)) {
        // The undersides of the courses show only as slivers through the joints: no ticks there.
        if (underside(st)) continue;
        strokes.push({ ink: 'carbon', group, family: st.family, points: st.points });
      }
      const rise = pc.kind === 'cap' ? 1 : pc.course / COURSES.length;
      for (const pts of stoneHatch(sl, mm, tolerance(n(ctx, 'pierHatch', 1.35, 0.8, 2.5) * (1 + rise)), pc.kind === 'pier' && pc.course <= 1)) strokes.push({ ink: 'carbon', group, family: 'hatch', points: pts });
      continue;
    }
    for (const st of facetStrokes(sl, light, eye, Math.max(sl.w, sl.h) * mm < 1.5, n(ctx, 'ringScale', 1, 1, 3) * FACET_MM_PER_UNIT / mm, trim)) {
      // Undersides show only as slivers through the course joints, and the lintel's soffit as a 2 mm band: leave them bare.
      if (underside(st)) continue;
      // A stone face has no hatched field in it.
      if (st.family === 'hatch' && st.points.length === 2) continue;
      strokes.push({ ink: 'carbon', group, family: st.family, points: st.points });
    }
  }

  // The thread, built on the world's course and drawn with the card's camera: where each strand ends and comes to a
  // point is measured on this card, in proportion to the print's, so the tips stay inside the window.
  const { near: nearPts, slot: slotPts, climb: climbPts } = world.thread;
  const rNear = n(ctx, 'threadNear', 0.3, 0.1, 0.8), rThread = n(ctx, 'threadThin', 0.022, 0.008, 0.08), rParted = n(ctx, 'threadParted', 0.5, 0.03, 0.8), rFar = n(ctx, 'threadFar', 11, 2, 15);
  const nearHelix = helixPiece(ctx, view, nearPts, { radius: rNear, pitch: n(ctx, 'threadPitch', 5, 2, 12), taper: rThread / rNear, flare: 2.3, pitchGrowth: 0.4 });
  const slotHelix = helixPiece(ctx, view, slotPts, { radius: rThread, pitch: n(ctx, 'slotPitch', 5, 2, 12), taper: rParted / rThread, flare: n(ctx, 'slotFlare', 0.55, 0.3, 1.5), pitchGrowth: 0.3 });
  const rClimb = n(ctx, 'climbStart', 0.16, 0.05, 0.5);
  const climbTip = layoutLength(n(ctx, 'tipLength', 10, 3, 30));
  const climbHelix = helixPiece(ctx, view, climbPts, { radius: rClimb, pitch: n(ctx, 'climbPitch', 6, 3, 30), taper: rFar / rClimb, flare: n(ctx, 'threadFlare', 1.3, 0.8, 4), pitchGrowth: 0.8, ends: { margin: layoutLength(n(ctx, 'endMargin', 9, 3, 20)), tip: climbTip } });
  // Which piece and strand each thread stroke is, for the small card's thin strands: there a strand narrower on paper
  // than a feature is drawn as its centre line (`strandThreads`), and its own strokes are cleared round that line.
  const strandOf = new WeakMap<Stroke, { piece: number; strand: 'a' | 'b'; centre?: boolean }>();
  const threads = MIN_FEATURE ? [strandThreads(view, nearHelix.strokes), strandThreads(view, slotHelix.strokes), strandThreads(view, climbHelix.strokes, climbTip)] : [];
  const helixStroke = (h: HelixStroke, piece: number): Stroke => {
    const st: Stroke = { ink: h.ink, group: 'helix', family: 'membrane', points: h.points };
    strandOf.set(st, { piece, strand: h.group === 'strand-b' ? 'b' : 'a' });
    return st;
  };
  const centreStrokes = (piece: number): Stroke[] => (threads[piece]?.centres ?? []).map(c => {
    const st: Stroke = { ink: 'vermilion', group: 'helix', family: 'membrane', points: c.points };
    strandOf.set(st, { piece, strand: c.strand, centre: true });
    return st;
  });
  for (const h of nearHelix.strokes) strokes.push(helixStroke(h, 0));
  strokes.push(...centreStrokes(0));
  const farStrokes: Stroke[] = [...slotHelix.strokes.map(h => helixStroke(h, 1)), ...climbHelix.strokes.map(h => helixStroke(h, 2)), ...centreStrokes(1), ...centreStrokes(2)];

  // Two depth views, each fitted to what it must tell apart: the wall and the near thread, which share a tight range;
  // and the far thread, whose distance would otherwise blur the wall's hidden lines. The far thread is hidden behind
  // the wall on the page instead, by where the wall covers the sheet.
  const wallGeos = [...wall.pieces.map(pc => slabGeometry(pc.slab)), ...nearHelix.meshes];
  const slabGeos = wallGeos.slice(0, wall.pieces.length);
  const farGeos = [...slotHelix.meshes, ...climbHelix.meshes];
  const geometries = [...wallGeos, ...farGeos];
  const viewW = view.clone(), viewF = view.clone();
  try {
    fitDepthRange(viewW, wallGeos);
    fitDepthRange(viewF, farGeos);
    const depthW = renderDepthBufferCPU(wallGeos, viewW, W, H);
    const depthF = renderDepthBufferCPU(farGeos, viewF, W, H);
    // The paper round what stands in the sky, and round the thread, are halos: in proportion to the card, never under 0.5 mm.
    // The hairline margins that keep a mark off the wall (0.15, 0.35 mm) and the clearance round the lettering, which keeps
    // its size on every card, are the pen's: real millimetres.
    const knock = halo(n(ctx, 'knockout', 1.1, 0.3, 3));
    const standingW = meshCoverage(wallGeos, viewW, PAGE, knock), standingF = meshCoverage(farGeos, viewF, PAGE, knock);
    const solids = (p: Point) => standingW(p) || standingF(p);
    const solids0 = meshCoverage(slabGeos, viewW, PAGE, 0.15);
    const solidsGate = meshCoverage(slabGeos, viewW, PAGE, 0.35);
    const envW = { view: viewW, depth: depthW, width: W, height: H };
    const depthVisible = (lines3: THREE.Vector3[][]) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k2: number) => void) => projectStrokes(lines3.map(points => ({ points })), envW, {
        hidden: () => hidden, begin: () => runs => { for (const r2 of runs) addTo(r2.length); },
      });
      count(false, k2 => { total += k2; });
      count(true, k2 => { seen += k2; });
      return total > 0 && seen >= total * 0.98;
    };
    const printed = setFinePrint(ctx, wall, viewW, world.camera, depthVisible);

    // Page-space marks from 3D strokes, clipped to the depth view and window and tested against the depth pass.
    const toPage = (lines3: THREE.Vector3[][]): Point[][] => {
      const res: Point[][] = [];
      projectStrokes(lines3.map(points => ({ points })), envW, {
        begin: () => runs => { for (const run of runs) res.push(scalePoints(run, MM_X, MM_Y)); },
      });
      return res;
    };
    const wordPaths = toPage(printed.words).flatMap(p => clipWindow(p));
    const onWord = glyphMask(wordPaths, 0.55);
    const printPaths = toPage(printed.asemic).flatMap(p => clipWindow(p));
    const onPrint = glyphMask(printPaths, 0.42);

    // The thread as drawn (what the depth passes leave of it), and the paper it keeps round itself.
    const helixRuns: { key: string; run: Point[] }[] = [];
    // A thin strand's own strokes, cleared round its centre line (small cards only).
    const threadMask = new Map<string, (p: Point) => boolean>();
    threads.forEach((t, piece) => { for (const [strand, paths] of t.masks) if (paths.length) threadMask.set(`${piece}${strand}`, glyphMask(paths, 0.8 * MIN_FEATURE)); });
    const unmasked = (st: Stroke, run: Point[]): Point[][] => {
      const of = strandOf.get(st), mask = of && !of.centre ? threadMask.get(`${of.piece}${of.strand}`) : undefined;
      return mask ? keepAlong(run, p => !mask(p), 0.1) : [run];
    };
    // The thread's strands are fine and twisted, so on a small card a depth pixel spans more of a strand than the print's
    // does, and the strands' own surfaces would hide stretches of their edges. There the thread is tested against a depth
    // pass `THREAD_OVERSAMPLE` times finer each way, as fine in the world as the print's.
    const fine = FORMAT.tabloid ? 1 : THREAD_OVERSAMPLE;
    const threadEnv = (view: THREE.PerspectiveCamera, geos: THREE.BufferGeometry[], depth: typeof depthW) =>
      fine === 1 ? { view, depth, width: W, height: H } : fineDepth(geos, view, { W, H, MM_X, MM_Y }, fine).env;
    const collect = (st: Stroke) => (runs: { x: number; y: number }[][]) => { for (const run of runs) for (const kept of unmasked(st, scalePoints(run, MM_X / fine, MM_Y / fine))) helixRuns.push({ key: `helix-${st.ink}`, run: kept }); };
    // A thin strand's centre line is no surface of its own: tested against the strands' surfaces it would break up
    // wherever the other strand passes a hair in front, so it skips the depth test (the far thread is still hidden
    // behind the wall below, by where the wall covers the sheet).
    const tested = (st: Stroke) => !strandOf.get(st)?.centre;
    projectStrokes(strokes.filter(st => st.group === 'helix'), threadEnv(viewW, wallGeos, depthW), { begin: collect, hidden: tested });
    const farRuns: typeof helixRuns = [];
    projectStrokes(farStrokes, threadEnv(viewF, farGeos, depthF), {
      hidden: tested,
      begin: st => runs => { for (const run of runs) for (const kept of unmasked(st, scalePoints(run, MM_X / fine, MM_Y / fine))) farRuns.push({ key: `helix-${st.ink}`, run: kept }); },
    });
    // Behind the wall the far thread is out of sight, wherever the wall covers it on the sheet.
    for (const h of farRuns) for (const inside of clipWindow(h.run)) for (const piece of keepAlong(inside, p => !solids0(p), 0.2)) helixRuns.push({ key: h.key, run: piece });
    // Where the ribbon is narrow its laminations would crowd to a clot: keep the edges and let a lamination in only
    // where it has half a millimetre of paper to itself.
    const order = ['helix-vermilion', 'helix-acid', 'helix-ultramarine', 'helix-violet'];
    const taken = new Set<number>();
    const cell = (q: Point) => Math.floor(q.x / 0.3) * 100003 + Math.floor(q.y / 0.3);
    const kept: typeof helixRuns = [];
    for (const h of [...helixRuns].sort((p, q) => order.indexOf(p.key) - order.indexOf(q.key))) {
      const samples: Point[] = [];
      for (let i = 1; i < h.run.length; i++) {
        const a = h.run[i - 1], b = h.run[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.2));
        for (let k = 0; k < steps; k++) samples.push({ x: a.x + (b.x - a.x) * k / steps, y: a.y + (b.y - a.y) * k / steps });
      }
      const crowded = samples.length ? samples.filter(q => taken.has(cell(q))).length / samples.length : 0;
      if (h.key !== 'helix-vermilion' && crowded > 0.6) continue;
      for (const q of samples) taken.add(cell(q));
      kept.push(h);
    }
    helixRuns.length = 0;
    helixRuns.push(...kept);
    const helixClear = glyphMask(helixRuns.flatMap(h => clipWindow(h.run)), halo(n(ctx, 'helixClear', 0.9, 0, 3)));

    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], extra: (p: Point) => boolean = () => true, min?: number) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onWord(p) && !onPrint(p) && extra(p), 0.15)) buckets.add(key, piece, false, min);
    };
    for (const h of helixRuns) for (const inside of clipWindow(h.run)) buckets.add(h.key, inside);
    // On a small card two outline edges closer than a feature on paper (a course joint, the joint between two slabs or
    // between a pier and the wing) are drawn as one line: the first drawn keeps it.
    const edges: { key: string; run: Point[] }[] = [];
    projectStrokes(strokes.filter(st => st.group !== 'helix'), envW, {
      begin: st => runs => {
        for (const run of runs) {
          const key = `${st.group}-${st.ink}`, page = scalePoints(run, MM_X, MM_Y);
          if (MIN_FEATURE && st.family === 'edge') edges.push({ key, run: page });
          // On a small card a scrap of hatch or ring shorter than a feature on paper is a speck: dropped (`hatchMin`).
          else add(key, page, p => !helixClear(p), hatchMin(st.family));
        }
      },
    });
    const single = besideKept(MIN_FEATURE);
    for (const e of edges) for (const inside of clipWindow(e.run)) {
      for (const piece of keepAlong(inside, p => !onWord(p) && !onPrint(p) && !helixClear(p), 0.15)) for (const one of single.pieces(piece)) buckets.add(e.key, one);
    }
    for (const p of printPaths) {
      for (const piece of keepAlong(p, q => !onWord(q) && !helixClear(q), 0.2)) buckets.add('print-lettering', piece, true);
    }
    for (const p of wordPaths) buckets.add('slogan-lettering', p, true);

    // The ground: lanes in plan, curving in from across the foreground to the gate.
    const net = laneNetwork(viewW, wall, world.lanes);
    for (const lp of net.paths) for (const inside of clipWindow(lp.path)) {
      for (const piece of keepAlong(inside, p => (!lp.behind || !solids0(p)) && !helixClear(p), 0.25)) buckets.add('lane-carbon', piece);
    }

    // The slot: a dark ruled fill above the horizon, clear of the wall round it and of the thread through it.
    const accent = (typeof ctx.params.accent === 'string' ? ctx.params.accent : 'ultramarine') as string;
    const gateInk = accent === 'ultramarine' || accent === 'vermilion' ? accent : 'carbon';
    const corners = [-1, 1].flatMap(b => [dp / 2, -dp / 2].flatMap(a => [0, wall.gateTop].map(h => pageOf(view, G.clone().addScaledVector(ez, a).addScaledVector(ex, b * wall.gw / 2).setY(h)))));
    const slotX0 = Math.min(...corners.map(p => p.x)), slotX1 = Math.max(...corners.map(p => p.x));
    const reach = layoutLength(1);
    const slotTop = Math.min(...corners.map(p => p.y)) - layoutLength(3), slotBottom = Math.max(...corners.map(p => p.y));
    // The slot's own dark takes the place of the sky seen through it.
    const inSlot = (p: Point) => p.x > slotX0 - reach && p.x < slotX1 + reach && p.y > slotTop && p.y < HORIZON_Y && !solidsGate(p);
    // Its ruling is a tone: the pitch holds on paper.
    const pitch = tolerance(n(ctx, 'gatePitch', 0.5, 0.35, 1.2));
    for (let x = slotX0 - reach; x <= slotX1 + reach; x += pitch) {
      add(`gate-${gateInk}`, [{ x, y: slotTop }, { x, y: slotBottom }], p => !solidsGate(p) && !helixClear(p) && p.y < HORIZON_Y - 0.4);
    }

    // The horizon, wherever the wall leaves it open.
    for (const piece of keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solidsGate(p) && !helixClear(p), 0.3)) buckets.add('horizon-carbon', piece);

    // The sky: lightly ruled, densest at the top, opening toward the horizon and knocked out round everything standing in it.
    const pattern = barPattern(ctx.random('hier-sky'), 0.86);
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - 1;
    // A tone: its pitch and the dashes' rhythm hold on paper, so a smaller sky has fewer, not finer, rules.
    const skyPitch = tolerance(n(ctx, 'skyPitch', 1.4, 0.8, 5));
    for (let y = skyTop + 0.3, i = 0; y < skyBottom; i++, y += skyPitch) {
      const t = (y - skyTop) / (skyBottom - skyTop);
      if (!(t < 0.14 || i % 2 === 0 || (i % 3 === 0 && t < 0.6))) continue;
      const broken = t > 0.16;
      add('sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => !solids(p) && !inSlot(p) && (!broken || pattern[Math.floor((p.x - CARD.x0) / 3.2 + i) % 64]));
    }
    const parts = buckets.toParts(['sky', 'horizon', 'wall', 'pier', 'lane', 'gate', 'helix', 'print', 'slogan'], INKS);
    parts.push(...cardFrame('V', 'THE HIEROPHANT', { phrase: sloganSettings(ctx) }));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
