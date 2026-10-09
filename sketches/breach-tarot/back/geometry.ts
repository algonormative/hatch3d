import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { CARD, FRAME, MIN_SPACING } from '../../kit/format.ts';
import { clipToRect, pathLength, segDist, straightened } from '../../kit/page.ts';
import { clamp, n } from '../../kit/params.ts';
import type { Ink } from '../../kit/types.ts';
import { chartresPlan, type P2 } from '../xxi-world/labyrinth.ts';
import { composite } from './composite.ts';
import { cathedral } from './cathedral.ts';

/**
 * The Breach Tarot's back: one design for all 22 cards, the same either way up. It names no card and carries no
 * words; it is drawn in the deck's own language, in one of five forms:
 *
 *   - `helix`: the twin helix closed into a ring, seen from above, in its native inks. Its ribbons broaden where the
 *     strands cross and turn edge-on at the ring's inside and outside; at every crossing the strand on top knocks the
 *     other out.
 *   - `labyrinth`: the Chartres labyrinth of XXI, flat in carbon, twice, head to tail as a court card is drawn, the
 *     two mouths facing across the middle. A thin helix runs from one centre to the other through both mouths, so the
 *     walk in is the walk out, whichever way up the card is held.
 *   - `field`: a field of helix crossings, the playing-card back's all-over trellis: thin twin helices in two families,
 *     woven over and under by turns, round a quiet lozenge window in the middle.
 *   - `composite` (composite.ts): every element at once in one emblem: a through-labyrinth walked by the helix from a
 *     gate of slabs at the head to the star at its heart and out to the foot, walls heavier toward the heart, the
 *     heart ruled dark, paper round whatever passes in front.
 *   - `cathedral` (cathedral.ts): the Breach Cathedral that the deck grew from, head to tail: its cantilevered slabs
 *     round the open shaft, its ribbed membrane looping round them in front and behind.
 *
 * **One way up is the other.** Every mark is built for one half of the card and drawn twice, as it is and turned
 * 180° about the card's centre, pen for pen. Each form's half is cut where the figure itself is symmetric (the ring
 * and every thread where they cross the card's centre line, the labyrinths whole), so the joins are continuous. The
 * last two hide their half's marks behind its own solids before turning it, and lay the halves out so that no solid
 * crosses the middle, where a turned half (seen, in effect, from behind) could not hide the other consistently.
 *
 * **Page-aware.** Everything is laid out on the format's card rect (`kit/format.ts`): sizes as fractions of the card,
 * pitches in real millimetres no closer than the pens hold apart (`MIN_SPACING`). The card's outer edge is the
 * format's page margin, which a print stack keeps outside its safe zone, so anything inside the card is safe.
 */
export const BACK_FORMS = ['helix', 'labyrinth', 'field', 'composite', 'cathedral'] as const;
export type BackForm = typeof BACK_FORMS[number];
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];

/** The card's centre: the point the back turns about. */
export const CARD_CENTRE: Point = { x: (CARD.x0 + CARD.x1) / 2, y: (CARD.top + CARD.bottom) / 2 };
/** A page point turned 180° about the card's centre. */
export const turned = (p: Point): Point => ({ x: 2 * CARD_CENTRE.x - p.x, y: 2 * CARD_CENTRE.y - p.y });

/** Shortest kept path, in millimetres. */
const MIN_PATH = 0.4;

/**
 * Half a back, gathered by group and ink, and given out whole: every path as it is and turned. Paths are reduced
 * (`straightened`, which keeps curves at any size) and dropped under `MIN_PATH` before they are turned, so the two
 * halves are the same marks. Nothing is clipped here: each form keeps itself inside the card, and the test holds it
 * to that before finishing's clip could hide a mark that strays.
 */
export class HalfBack {
  private readonly groups = new Map<string, Point[][]>();

  add(group: string, ink: Ink, path: Point[]): void {
    const reduced = straightened(path, 0.02);
    if (reduced.length < 2 || pathLength(reduced) < MIN_PATH) return;
    const key = `${group}-${ink}`;
    if (!this.groups.has(key)) this.groups.set(key, []);
    this.groups.get(key)!.push(reduced);
  }

  /** The whole back, as parts in `groups` × ink order: each half path followed by its turn. */
  parts(groups: readonly string[]): Part[] {
    const out: Part[] = [];
    for (const group of groups) for (const ink of INKS) {
      const half = this.groups.get(`${group}-${ink}`);
      if (half?.length) out.push({ id: `${group}-${ink}`, pen: ink, paths: half.flatMap(p => [p, p.map(turned)]) });
    }
    return out;
  }
}

/** The runs of a sampled page path whose samples a test keeps (by point and by sample index). */
function keepRuns(points: Point[], keep: (p: Point, i: number) => boolean): Point[][] {
  const out: Point[][] = [];
  let run: Point[] = [];
  points.forEach((p, i) => {
    if (keep(p, i)) run.push(p);
    else { if (run.length > 1) out.push(run); run = []; }
  });
  if (run.length > 1) out.push(run);
  return out;
}

/**
 * A fine rule round the card, the faces' band-rule gap inside its outer edge (a rule on the edge itself would sit on
 * the finishing's content clip). With a print stack's border outside the card, the pair reads as a double rule. Drawn
 * as its top half, from the middle of the left side round to the middle of the right.
 */
function frame(half: HalfBack): void {
  const e = FRAME.rule, cy = CARD_CENTRE.y;
  const x0 = CARD.x0 + e, x1 = CARD.x1 - e, top = CARD.top + e;
  half.add('frame', 'carbon', [{ x: x0, y: cy }, { x: x0, y: top }, { x: x1, y: top }, { x: x1, y: cy }]);
}

// ---------------------------------------------------------------------------------------------------------------
// The helix ring.

/** Kit ink cycles for a helix's ribs, by strand (as `strandStrokes` deals them). */
const ribInk = (strand: number, i: number): Ink => strand === 0
  ? (i % 8 === 0 ? 'acid' : i % 3 === 0 ? 'violet' : i % 4 === 0 ? 'vermilion' : 'ultramarine')
  : (i % 8 === 0 ? 'vermilion' : i % 3 === 0 ? 'ultramarine' : 'violet');

/**
 * The twin helix closed into a ring round the card's centre, seen from straight above. Each strand winds `turns`
 * times round a circular core (an even number, so a half turn of the ring brings each strand back onto itself), as a
 * ribbon lying on the tube, its width across the strand, as the kit's helix is built. From above the ribbons broaden
 * where the strands cross and turn edge-on at the ring's inside and outside. Edges in vermilion; laminations in
 * ultramarine (strand a, round an acid spine) and violet (strand b), kept only where the ribbon is broad enough to hold
 * them apart; ribs across the broad stretches in the kit's ink cycle. At a crossing the strand on top knocks the
 * other out, with paper round it. The half drawn runs from the ring's right-hand seam over the top to its left.
 */
function helixRing(ctx: SketchContext, half: HalfBack): void {
  const c = CARD_CENTRE, cw = CARD.x1 - CARD.x0;
  const R = n(ctx, 'ringSize', 0.31, 0.2, 0.4) * cw;
  const a = n(ctx, 'tube', 0.2, 0.1, 0.3) * R, hw = 0.45 * a;
  const k = 2 * Math.round(n(ctx, 'turns', 6, 4, 16) / 2);
  const gap = Math.max(MIN_SPACING, 0.012 * cw);
  const centreline = (s: number, th: number): THREE.Vector3 => {
    const psi = k * th + Math.PI / 2 + s * Math.PI, r = R + a * Math.cos(psi);
    return new THREE.Vector3(c.x + r * Math.cos(th), c.y + r * Math.sin(th), a * Math.sin(psi));
  };
  /** A point of strand `s`'s ribbon at ring angle `th`, `v` across it (-1..1), and its height. */
  const point = (s: number, th: number, v: number): THREE.Vector3 => {
    const p = centreline(s, th);
    const tangent = centreline(s, th + 1e-5).sub(centreline(s, th - 1e-5)).normalize();
    const psi = k * th + Math.PI / 2 + s * Math.PI;
    const radial = new THREE.Vector3(Math.cos(psi) * Math.cos(th), Math.cos(psi) * Math.sin(th), Math.sin(psi));
    return p.addScaledVector(radial.cross(tangent).normalize(), v * hw);
  };
  /** The ribbon's width on the page across its run, in millimetres. */
  const broad = (s: number, th: number): number => {
    const e0 = point(s, th, -1), e1 = point(s, th, 1);
    const t = point(s, th + 1e-4, 0).sub(point(s, th - 1e-4, 0));
    const tl = Math.hypot(t.x, t.y) || 1;
    return Math.abs((e1.x - e0.x) * t.y - (e1.y - e0.y) * t.x) / tl;
  };
  // The occluders: each strand's ribbon as page quads with their mean height, binned on a grid.
  const N = 120 * k, CELL = 2;
  const quads: { s: number; z: number; pts: Point[] }[] = [];
  const grid = new Map<string, number[]>();
  for (let s = 0; s < 2; s++) for (let i = 0; i < N; i++) {
    const t0 = i / N * 2 * Math.PI, t1 = (i + 1) / N * 2 * Math.PI;
    const corners = [point(s, t0, -1), point(s, t1, -1), point(s, t1, 1), point(s, t0, 1)];
    const pts = corners.map(p => ({ x: p.x, y: p.y }));
    const index = quads.push({ s, z: corners.reduce((m, p) => m + p.z, 0) / 4, pts }) - 1;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    for (let gx = Math.floor((Math.min(...xs) - gap) / CELL); gx <= Math.floor((Math.max(...xs) + gap) / CELL); gx++) {
      for (let gy = Math.floor((Math.min(...ys) - gap) / CELL); gy <= Math.floor((Math.max(...ys) + gap) / CELL); gy++) {
        const key = `${gx},${gy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key)!.push(index);
      }
    }
  }
  const inQuad = (q: Point[], p: Point) => {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      if ((q[i].y > p.y) !== (q[j].y > p.y) && p.x < (q[j].x - q[i].x) * (p.y - q[i].y) / (q[j].y - q[i].y) + q[i].x) inside = !inside;
    }
    return inside || [0, 1, 2, 3].some(i => segDist(p, q[i], q[(i + 1) % 4]) < gap);
  };
  /** Whether the other strand's ribbon lies over this point of strand `s` at height `z`. */
  const covered = (s: number, p: Point, z: number) => (grid.get(`${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`) ?? [])
    .some(i => quads[i].s !== s && quads[i].z > z && inQuad(quads[i].pts, p));

  const M = 120 * k;
  const steps = Array.from({ length: M + 1 }, (_, i) => i / M * Math.PI);
  for (let s = 0; s < 2; s++) {
    const width = steps.map(th => broad(s, th));
    const line = (v: number, ink: Ink, minWidth: number) => {
      const pts = steps.map(th => point(s, th, v));
      for (const run of keepRuns(pts.map(p => ({ x: p.x, y: p.y })), (p, i) => width[i] >= minWidth && !covered(s, p, pts[i].z))) half.add('helix', ink, run);
    };
    line(-1, 'vermilion', 0);
    line(1, 'vermilion', 0);
    // Five lines across the ribbon (two edges, two laminations and the middle) need a quarter of its width apiece.
    line(-0.5, s === 0 ? 'ultramarine' : 'violet', 4 * MIN_SPACING);
    line(0.5, s === 0 ? 'ultramarine' : 'violet', 4 * MIN_SPACING);
    line(0, s === 0 ? 'acid' : 'violet', 2.4 * MIN_SPACING);
    // Ribs: six a turn, across the broad stretches.
    const ribs = 3 * k;
    for (let i = 0; i < ribs; i++) {
      const th = (i + 0.5) / ribs * Math.PI;
      if (broad(s, th) < 3 * MIN_SPACING) continue;
      const pts = Array.from({ length: 13 }, (_, j) => point(s, th, -0.9 + 1.8 * j / 12));
      for (const run of keepRuns(pts.map(p => ({ x: p.x, y: p.y })), (p, j) => !covered(s, p, pts[j].z))) half.add('helix', ribInk(s, i), run);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The twin labyrinth.

/** The plan is built at the World's pitch and scaled down, so its arcs stay fine at any size. */
const PLAN_PITCH = 10;

/**
 * Two Chartres labyrinths, head to tail: the lower one with its mouth turned up toward the card's centre, the upper
 * one the same turned 180°. Their walls are single carbon lines. A thin helix, drawn as the deck draws a narrow one
 * (strand a's acid spine, strand b's vermilion line, rungs between them in ultramarine and violet), runs up the
 * entrance axis from the lower centre to the card's centre (and, turned, on to the upper centre), its two strands
 * closing to a point at each centre. Where it passes, the walls give way with paper round it. The half drawn is the
 * lower labyrinth and the lower half of the thread.
 */
function twinLabyrinth(ctx: SketchContext, half: HalfBack): void {
  const c = CARD_CENTRE, cw = CARD.x1 - CARD.x0, ch = CARD.bottom - CARD.top;
  const plan = chartresPlan(PLAN_PITCH);
  const rim = plan.wall(0);
  // The labyrinth's radius: a share of the card's width, but never so large that the pair leaves the card.
  const inset = Math.max(MIN_SPACING, 0.03 * cw);
  const gapAt = n(ctx, 'mouthGap', 0.1, 0, 0.3) * cw;
  const radius = Math.min(n(ctx, 'labyrinthSize', 0.36, 0.25, 0.45) * cw, cw / 2 - inset, (ch / 2 - inset - gapAt / 2) / 2);
  const scale = radius / rim, pitch = PLAN_PITCH * scale;
  const d = radius + gapAt / 2;
  // The lower labyrinth's centre; plan +Y (its mouth) faces up the card.
  const o = { x: c.x, y: c.y + d };
  const toPage = (p: P2): Point => ({ x: o.x - p.x * scale, y: o.y - p.y * scale });

  // The thread: two strands about the axis, from the card's centre (t = 0) to the labyrinth's centre (t = d). Its
  // amplitude closes to nothing over the centre's last stretch. A turn every `period`; at t = 0 strand a is in front
  // and the strands cross, so the turned half continues it.
  const amp = 0.85 * pitch, period = n(ctx, 'threadTurn', 4, 2, 10) * pitch;
  const close = 3.44 * pitch;
  const thread = ctx.params.thread !== false;
  const ampAt = (t: number) => amp * clamp((d - t) / close, 0, 1) ** 0.7;
  const clear = Math.max(MIN_SPACING, 0.4 * pitch);
  const band = (p: Point) => {
    const t = p.y - c.y;
    return thread && t > -clear && t < d + clear && Math.abs(p.x - c.x) < ampAt(clamp(t, 0, d)) + clear;
  };

  // Walls, densified so the band cuts them cleanly.
  for (const wall of plan.walls) {
    const pts: Point[] = [];
    for (let i = 0; i < wall.length; i++) {
      const p = toPage(wall[i]);
      if (i) {
        const q = pts[pts.length - 1], steps = Math.max(1, Math.ceil(Math.hypot(p.x - q.x, p.y - q.y) / 0.1));
        for (let j = 1; j < steps; j++) pts.push({ x: q.x + (p.x - q.x) * j / steps, y: q.y + (p.y - q.y) * j / steps });
      }
      pts.push(p);
    }
    for (const run of keepRuns(pts, p => !band(p))) half.add('labyrinth', 'carbon', run);
  }
  if (!thread) return;

  twinThread(half, { origin: c, dir: { x: 0, y: 1 }, t0: 0, t1: d, amp: ampAt, period, gap: clear });
}

/** A thin helix laid along a straight line, as the deck draws a narrow one. */
interface ThreadSpec {
  /** Where the strands cross with strand a in front: t = 0. */
  origin: Point;
  /** The line's direction (a unit vector), toward increasing t. */
  dir: Point;
  /** The stretch drawn, in millimetres along the line. */
  t0: number;
  t1: number;
  /** Each strand's distance from the line at t. */
  amp: (t: number) => number;
  /** Millimetres along the line per turn. */
  period: number;
  /** Paper a strand keeps round the strand in front of it. */
  gap: number;
  /** Where the thread may be drawn (a weave's crossings, a quiet window); everywhere by default. */
  keep?: (p: Point) => boolean;
}

/**
 * A thin twin helix along a line: strand a's acid spine and strand b's vermilion line winding round it (as the kit's
 * `narrowStrands` reduces a helix too narrow for its ribbons), the strand behind giving way where they cross, and
 * rungs between them at the broad of each half turn in ultramarine and violet by turns. The phase is fixed at the
 * origin, so a thread and its turn about a point on its line join up.
 */
function twinThread(half: HalfBack, spec: ThreadSpec): void {
  const { origin, dir, t0, t1, amp, period, gap } = spec;
  if (!(t1 > t0)) return;
  const nx = -dir.y, ny = dir.x;
  const at = (s: number, t: number) => {
    const ph = 2 * Math.PI * t / period, off = (s === 0 ? 1 : -1) * amp(t) * Math.sin(ph);
    return { x: origin.x + t * dir.x + off * nx, y: origin.y + t * dir.y + off * ny, z: (s === 0 ? 1 : -1) * Math.cos(ph), off };
  };
  const keep = spec.keep ?? (() => true);
  const count = Math.max(1, Math.ceil((t1 - t0) / 0.08));
  const ts = Array.from({ length: count + 1 }, (_, i) => t0 + (t1 - t0) * i / count);
  for (let s = 0; s < 2; s++) {
    const pts = ts.map(t => at(s, t)), other = ts.map(t => at(1 - s, t));
    // The strand behind gives way round the one in front.
    const behind = (i: number) => pts[i].z < other[i].z && Math.abs(pts[i].off - other[i].off) < gap;
    for (const run of keepRuns(pts.map(p => ({ x: p.x, y: p.y })), (p, i) => !behind(i) && keep(p))) half.add('thread', s === 0 ? 'acid' : 'vermilion', run);
  }
  // Rungs at the broad of each half turn, where the strands stand far enough apart.
  for (let m = Math.ceil(t0 / (period / 2) - 0.5); (m + 0.5) * period / 2 <= t1; m++) {
    const t = (m + 0.5) * period / 2;
    if (t < t0) continue;
    const a = at(0, t), b = at(1, t);
    const span = Math.abs(a.off - b.off);
    if (span < 2 * gap + MIN_SPACING) continue;
    const ends = [a, b].map((p, e) => { const back = (e === 0 ? 1 : -1) * Math.sign(b.off - a.off) * 0.7 * gap; return { x: p.x + back * nx, y: p.y + back * ny }; });
    if (ends.every(keep)) half.add('thread', ((m % 2) + 2) % 2 ? 'violet' : 'ultramarine', ends);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The trellis.

/**
 * A field of helix crossings: an all-over diamond trellis of thin twin helices, the two families woven over and under
 * by turns, round a quiet lozenge window in the middle framed by the threads either side of it. The lattice is laid so
 * that the card's centre is the middle of a diamond: every thread is turned onto another (or itself) about it, and the
 * weave's parity with it. The half drawn is every thread above the card's centre line, from where it crosses that line.
 */
function trellis(ctx: SketchContext, half: HalfBack): void {
  const c = CARD_CENTRE, cw = CARD.x1 - CARD.x0;
  const s = n(ctx, 'trellisPitch', 0.2, 0.12, 0.35) * cw;
  const alpha = THREE.MathUtils.degToRad(n(ctx, 'trellisAngle', 34, 20, 45));
  const amp = 0.075 * s, period = 0.4 * s, gap = Math.max(MIN_SPACING, 0.04 * s);
  const window = (Math.round(n(ctx, 'window', 1, 0, 3)) + 0.5) * s;
  const inset = FRAME.rule + Math.max(1.5 * MIN_SPACING, 0.03 * cw);
  const box = { x0: CARD.x0 + inset, x1: CARD.x1 - inset, y0: CARD.top + inset, y1: CARD.bottom - inset };
  const fam = [0, 1].map(f => {
    const d = { x: (f === 0 ? 1 : -1) * Math.sin(alpha), y: Math.cos(alpha) };
    return { d, nrm: { x: -d.y, y: d.x } };
  });
  /** A page point's offset across each family's lines, from the centre. */
  const across = (p: Point, f: number) => (p.x - c.x) * fam[f].nrm.x + (p.y - c.y) * fam[f].nrm.y;
  const index = (o: number) => Math.round(o / s - 0.5);
  const band = amp + gap;
  const reach = Math.hypot(box.x1 - box.x0, box.y1 - box.y0) / 2 + s;
  for (let f = 0; f < 2; f++) {
    const g = 1 - f, { d, nrm } = fam[f];
    for (let i = -Math.ceil(reach / s); i <= Math.ceil(reach / s); i++) {
      const o = (i + 0.5) * s;
      // Where this line crosses the centre line: its origin, and the top half runs from there back along it.
      const origin = { x: c.x + o * nrm.x - (o * nrm.y / d.y) * d.x, y: c.y };
      // The stretch inside the box (the line is clipped as a long segment through the origin).
      const run = clipToRect([{ x: origin.x - 2 * reach * d.x, y: origin.y - 2 * reach * d.y }, origin], box)[0];
      if (!run) continue;
      const t0 = -Math.hypot(run[0].x - origin.x, run[0].y - origin.y), t1 = -Math.hypot(run[run.length - 1].x - origin.x, run[run.length - 1].y - origin.y);
      const interior = Math.abs(o) < window - 1e-9;
      twinThread(half, {
        origin, dir: d, t0, t1, amp: () => amp, period, gap,
        keep: p => {
          const q = across(p, g);
          // Inside the window: an interior thread stops short of the threads that frame it.
          if (interior && Math.abs(q) < window + band) return false;
          // Under the other family at a crossing where it lies on top.
          const j = index(q);
          const over = (f === 0 ? i + j : j + i) % 2 === 0 ? 0 : 1;
          const crossInterior = Math.abs((j + 0.5) * s) < window - 1e-9 && Math.abs(across(p, f)) < window + band;
          return over === f || crossInterior || Math.abs(q - (j + 0.5) * s) >= band;
        },
      });
    }
  }
}

/** The form a render asks for, by its `form` control (the helix by default). */
export function backForm(ctx: SketchContext): BackForm {
  const form = ctx.params.form;
  return typeof form === 'string' && (BACK_FORMS as readonly string[]).includes(form) ? form as BackForm : 'helix';
}

export function drawBack(ctx: SketchContext): Part[] {
  const half = new HalfBack();
  const form = backForm(ctx);
  if (form === 'helix') helixRing(ctx, half);
  else if (form === 'labyrinth') twinLabyrinth(ctx, half);
  else if (form === 'field') trellis(ctx, half);
  else if (form === 'composite') composite(ctx, half);
  else cathedral(ctx, half);
  if (ctx.params.frame !== false) frame(half);
  return half.parts(['frame', 'nave', 'gate', 'labyrinth', 'heart', 'star', 'thread', 'membrane', 'helix']);
}
