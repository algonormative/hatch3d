import * as THREE from 'three';
import type { Point, SketchContext } from '../../../src/sketch/types.ts';
import { CARD, MIN_SPACING } from '../../kit/format.ts';
import { n } from '../../kit/params.ts';
import type { Slab } from '../../kit/slabs.ts';
import type { Ink } from '../../kit/types.ts';
import type { HalfBack } from './geometry.ts';
import { box, faceOnPage, faceSeen, faces, FLOOR, hidden, obliqueView, seenEdges, visibleRuns } from './solids.ts';

/**
 * The `cathedral` back: the Breach Cathedral, the piece the deck grew from, head to tail as a court card is drawn. Its
 * upper half, in the architect's oblique, is turned 180° for the lower, so the card is the same either way up.
 *
 * Slabs cantilever from either side round the empty shaft up the card's middle, a level at a time, each with a shorter
 * block set back on the other side; one level is split, the breach. They are hatched in the cathedral's own hand:
 * slanted courses on the front, staggered, every fourth in ultramarine, with rests in the middle of some, closer level
 * by level toward the card's middle; ticks down the seen side, scores under. The ribbed membrane loops round the stack
 * as the original's open loop does, in front of some slabs and behind others: from the right side over the head and
 * down the left, closing a little as it goes, and, turned, under the foot, the two loops interleaving at the card's
 * sides (`membranePath` `hooks`); or as one S through the shaft (`s`). It is drawn as the cathedral draws it,
 * vermilion edges, contours in ultramarine and violet, the acid seam, ribs in the cycle. Where a mark passes behind
 * another it stops short, paper round the one in front. The shaft's middle, where the halves meet, is left open: the
 * halves are laid out not to overlap there, since a turned half is seen as from behind and cannot hide the other.
 *
 * Nothing here is imported from `sketches/breach-cathedral`: its hatch is redrawn for the back's scale, held on paper.
 */

type P = Point;

/** Strokes in world space with their inks, to be hidden and projected. */
interface WorldStroke { ink: Ink; points: THREE.Vector3[] }

/** The page quads of a ribbon, with the nearest height of each and where it lies along the ribbon, for what it hides. */
interface RibbonQuad { v: number; z: number; pts: P[] }

const insideQuad = (q: P[], p: P) => {
  let inn = false;
  for (let i = 0, j = 3; i < 4; j = i++) if ((q[i].y > p.y) !== (q[j].y > p.y) && p.x < (q[j].x - q[i].x) * (p.y - q[i].y) / (q[j].y - q[i].y) + q[i].x) inn = !inn;
  return inn;
};
const segD = (p: P, a: P, b: P) => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
};

export function cathedral(ctx: SketchContext, half: HalfBack): void {
  const cw = CARD.x1 - CARD.x0, ch = CARD.bottom - CARD.top;
  const gap = MIN_SPACING;
  const view = obliqueView(-0.4, -0.45);
  const inset = Math.max(2 * gap, 0.05 * cw);
  const hw = cw / 2 - inset, hh = ch / 2 - inset;
  const levels = Math.round(n(ctx, 'naveLevels', 4, 3, 6));
  const shaft = 0.06 * cw, deep = 0.08 * cw;
  const slabs: Slab[] = [];
  // Level by level from the head down toward the card's middle, where the shaft is left open: a weighted
  // counterpoint, each level's cantilever from one side reaching across the shaft, a shorter block set back opposite.
  const head = -hh + 0.02 * ch, waist = -0.07 * ch, pitchY = (waist - head) / levels;
  const course = Math.min(0.5 * pitchY, 0.085 * cw);
  for (let i = 0; i < levels; i++) {
    const y = head + (i + 0.5) * pitchY;
    const side = i % 2 === 0 ? -1 : 1;
    const tone = 0.7 + 0.5 * i / Math.max(1, levels - 1);
    const outer = (0.92 - 0.1 * (i % 3)) * hw, tip = (i % 3 === 1 ? 0.2 : 0.9) * shaft;
    if (i === levels - 2) {
      // The breach: this level's cantilever split, paper between its two solids.
      const w = outer + tip, a = 0.55 * w, cut = Math.max(3 * gap, 0.12 * w);
      slabs.push(box(side * (outer - a / 2), y, 0, a, course, deep, tone, i));
      slabs.push(box(side * (outer - a - cut - (w - a - cut) / 2), y, 0, w - a - cut, course, deep, tone, i));
    } else slabs.push(box(side * (outer - (outer + tip) / 2), y, 0, outer + tip, course, deep, tone, i));
    // The block set back on the other side.
    const b0 = shaft + 1.5 * gap, b1 = (0.5 + 0.12 * (i % 2)) * hw;
    if (i % 3 !== 2) slabs.push(box(-side * (b0 + b1) / 2, y + 0.2 * course, -0.9 * deep, b1 - b0, 0.8 * course, 0.7 * deep, tone, i));
  }

  // ---- The membrane. As an S (`membranePath` 's'): from the card's centre, out to the right, up over the stack and down
  // the left side; turned, the other way. As hooks (the default): an open arc round the stack from the right side, over
  // the head and down the left, closing a little as it goes; turned, the arc under the foot, so the two interleave.
  const hooks = ctx.params.membranePath !== 's';
  const rx = n(ctx, 'membraneReach', 0.36, 0.2, 0.5) * cw, ry = (hooks ? 0.8 : 0.44) * hh;
  const wid = n(ctx, 'membraneWidth', 0.075, 0.03, 0.14) * cw;
  const zAmp = 1.2 * deep;
  const at = hooks
    ? (v: number) => {
      const a = 0.06 * Math.PI - v * 1.17 * Math.PI, r = 1 - 0.16 * v;
      return new THREE.Vector3(r * rx * Math.cos(a), r * ry * Math.sin(a), zAmp * Math.sin(2.4 * a + 0.9));
    }
    : (v: number) => { const a = v * 1.42 * Math.PI; return new THREE.Vector3(rx * Math.sin(a), -ry + ry * Math.cos(a), zAmp * Math.sin(2.1 * a)); };
  const taper = hooks ? (v: number) => 0.16 + 0.93 * Math.sin(Math.PI * Math.min(1, Math.max(0, v))) ** 0.58
    : (v: number) => 0.18 + 0.9 * Math.cos(0.5 * Math.PI * Math.min(1, v)) ** 0.58;
  /** A point of the membrane at `v` along its half (0 at the centre) and `f` across it (-1..1). */
  const point = (v: number, f: number) => {
    const p = at(v), T = at(v + 1e-4).sub(at(v - 1e-4)).normalize();
    const N = new THREE.Vector3(-T.y, T.x, 0).normalize(), out = new THREE.Vector3(0, 0, 1);
    const roll = hooks ? 0.7 * Math.sin(3.4 * v + 0.6) : 0.85 * Math.sin(3.1 * v + 0.4) * v;
    const w = wid * taper(v);
    return p.addScaledVector(N.multiplyScalar(Math.cos(roll)).addScaledVector(out, Math.sin(roll)), f * w);
  };
  const Q = 200;
  const quads: RibbonQuad[] = [];
  for (let i = 0; i < Q; i++) {
    const v0 = i / Q, v1 = (i + 1) / Q;
    const cs = [point(v0, -1), point(v1, -1), point(v1, 1), point(v0, 1)];
    quads.push({ v: (v0 + v1) / 2, z: Math.max(...cs.map(p => p.z)), pts: cs.map(p => view.page(p)) });
  }
  const underMembrane = (p: P, z: number, halo: number, v?: number) => quads.some(q => q.z > z + 1e-3 && (v === undefined || Math.abs(q.v - v) > 0.05)
    && (insideQuad(q.pts, p) || (halo > 0 && [0, 1, 2, 3].some(i => segD(p, q.pts[i], q.pts[(i + 1) % 4]) < halo))));
  const pad = 1.2 * gap;

  // ---- The slabs, in the cathedral's hand: the outline, slanted courses on the front, ticks down the seen side, scores under.
  for (const s of slabs) {
    const keep = (w: THREE.Vector3, p: P) => !hidden(slabs, view, w, pad, s) && !underMembrane(p, w.z, pad);
    for (const edge of seenEdges(s, view)) for (const run of visibleRuns(edge, view, keep, 0.1)) half.add('nave', 'carbon', run);
    const f = Math.min(1, s.beat / Math.max(1, levels - 1));
    const pitch = Math.max(1.25 * MIN_SPACING, 2.4 - 1.2 * f);
    if (s.h >= FLOOR.feature + 2 * gap) for (const stroke of frontCourses(s, pitch, s.beat % 2 === 0)) for (const run of visibleRuns(stroke.points, view, keep, 0.1)) half.add('nave', stroke.ink, run);
    for (const face of faces(s)) {
      if (face.normal.z !== 0 || !faceSeen(view, face)) continue;
      const size = faceOnPage(view, face);
      if (size.width < FLOOR.feature) continue;
      for (const stroke of sideTicks(face, size, pitch)) for (const run of visibleRuns(stroke.points, view, keep, 0.1)) half.add('nave', stroke.ink, run);
    }
  }

  // ---- The membrane: vermilion edges, contours in ultramarine and violet, the acid seam, ribs in the cycle.
  const memKeep = (w: THREE.Vector3, p: P, v: number) => !hidden(slabs, view, w, pad) && !underMembrane(p, w.z, 0, v);
  /** The membrane's width on the page at `v`: where it turns edge-on its contours give way, so no two run closer than the pens hold apart. */
  const across = (v: number) => { const a = view.page(point(v, -1)), b = view.page(point(v, 1)); return Math.hypot(b.x - a.x, b.y - a.y); };
  const trace = (ink: Ink, count: number, pt: (t: number) => { w: THREE.Vector3; v: number }, minWidth = 0) => {
    let run: P[] = [];
    const flush = () => { if (run.length > 1) half.add('membrane', ink, run); run = []; };
    for (let i = 0; i <= count; i++) {
      const { w, v } = pt(i / count), p = view.page(w);
      if (memKeep(w, p, v) && (minWidth === 0 || across(v) >= minWidth)) run.push(p); else flush();
    }
    flush();
  };
  // Seven lines across: the contours need six gaps of the pen floor, the seam alone two.
  for (const [f, ink, min] of [[-1, 'vermilion', 0], [1, 'vermilion', 0], [-0.66, 'ultramarine', 6], [0.66, 'ultramarine', 6], [-0.33, 'violet', 6], [0.33, 'violet', 6], [0, 'acid', 2]] as const) {
    trace(ink, 700, v => ({ w: point(v, f), v }), min * 1.1 * gap);
  }
  const ribs = Math.round(n(ctx, 'membraneRibs', 14, 6, 40));
  for (let i = 0; i < ribs; i++) {
    const v = (i + 0.5) / ribs;
    const ink: Ink = i % 8 === 0 ? 'acid' : i % 3 === 0 ? 'violet' : i % 4 === 0 ? 'vermilion' : 'ultramarine';
    if (across(v) >= 2 * gap) trace(ink, 30, t => ({ w: point(v, -0.92 + 1.84 * t), v }));
  }
}

/** A slab's front in the cathedral's hatch: slanted courses `pitch` page millimetres apart, staggered, every fourth in ultramarine, with rests. */
function frontCourses(s: Slab, pitch: number, rests: boolean): WorldStroke[] {
  const out: WorldStroke[] = [];
  const z = s.z + s.d / 2 + 1e-3, x0 = s.x - s.w / 2, x1 = s.x + s.w / 2, y0 = s.y - s.h / 2, y1 = s.y + s.h / 2;
  const margin = Math.max(0.6 * MIN_SPACING, 0.08 * s.h);
  const slant = Math.min(0.3 * s.h, 0.8 * pitch);
  const count = Math.floor((s.w - 2 * margin - slant) / pitch);
  for (let j = 0; j <= count; j++) {
    if (rests && j % 5 < 2 && j > count * 0.27 && j < count * 0.76) continue;
    const x = x0 + margin + j * (s.w - 2 * margin - slant) / Math.max(1, count);
    // Courses run from the top (page y0) staggered down the face, slanting right as they fall.
    const cut = (j % 4) * Math.min(0.08 * s.h, 0.35 * pitch);
    out.push({ ink: j % 4 === 0 ? 'ultramarine' : 'carbon', points: [new THREE.Vector3(x, y0 + margin + cut, z), new THREE.Vector3(Math.min(x + slant, x1 - margin), y1 - margin, z)] });
  }
  return out;
}

/** Short ticks down a seen side or underside face, its long way, `pitch` page millimetres apart on its tighter axis. */
function sideTicks(face: ReturnType<typeof faces>[number], size: { su: number; sv: number }, pitch: number): WorldStroke[] {
  const out: WorldStroke[] = [];
  // Along the face's longer page extent.
  const longU = face.u.length() * size.su >= face.v.length() * size.sv;
  const A = longU ? face.u : face.v, B = longU ? face.v : face.u, sA = longU ? size.su : size.sv;
  const lenA = A.length(), step = Math.max(pitch * 1.4, 1.2 * MIN_SPACING) / sA;
  const count = Math.floor(2 * lenA / step);
  for (let j = 1; j < count; j++) {
    const a = -1 + 2 * j / count;
    const p = face.centre.clone().addScaledVector(A, a).addScaledVector(B, -0.8).addScaledVector(face.normal, 1e-3);
    const q = face.centre.clone().addScaledVector(A, Math.min(1, a + 0.4 * step / lenA)).addScaledVector(B, 0.8).addScaledVector(face.normal, 1e-3);
    out.push({ ink: j % 4 === 0 ? 'ultramarine' : 'carbon', points: [p, q] });
  }
  return out;
}

