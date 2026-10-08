import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { FORMAT, MIN_FEATURE, PAGE, PHRASE, PITCH_SCALE, TABLOID_CARD, TABLOID_HORIZON_Y, depthRaster, halo, layoutLength, layoutX, layoutY, scaledCount, tolerance } from '../../kit/format.ts';
import { facetStrokes, rakingLight, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong } from '../../kit/helix.ts';
import { clearBands, planSlogans, sloganSettings, titleSettings, type SloganSurface } from '../../kit/lettering.ts';
import { bandMarks, sideOf } from '../../kit/fills.ts';
import { clipToRect, keepAlong, meshCoverage, type Rect } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { storm, tower, towerCamera } from './geometry.ts';

/**
 * XVI The Tower, `form: 'machine'`: the tower is the supercomputer of the Machine study, square on
 * and centred. A stout C of wedge columns of thin blades after the Cray-1, open a quarter of the
 * way round at the front so we look into its core, a bench ring round the outside of its base, a
 * row of status ticks on every blade; inside the C the walls shade each other, so the opening reads
 * as a hollow. The helix rises from the floor of the core, in full view, up through the opening and
 * on up the card; the machine's top floats above it, lifted off whole like a lid and tipped a
 * little, the helix passing up through it. The storm falls behind, and behind the machine the sky is struck: a forked bolt comes in at
 * a slant from the top corner, branching as it goes, a flat hatched band like the cantilever
 * card's, hidden wherever the machine, its lid or the helix stand in front. Where the bolt passes
 * behind the machine its status ticks go dark (`machineTicks`). There is no tear: the bolt no
 * longer crosses anything that could slip. The clock the machine ran on, a hatched square wave
 * across the sky, can come too (`machineClock`).
 */
/** The card's depth raster, within budget for the machine's pass at twice its size. */
const { W, H, MM_X, MM_Y } = depthRaster(559, 864, 2);
/** The machine's own depth pass: the same projection at twice the resolution, its range fitted. */
const W2 = 2 * W, H2 = 2 * H;
const MM2_X = PAGE.width / W2, MM2_Y = PAGE.height / H2;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
/**
 * The smallest feature this format draws as a shape, in millimetres on paper: a flat band narrower than this is
 * drawn as its centreline, a paving stone shallower than this is left out. Tabloid is the authored format: its
 * print keeps everything it has.
 */
const FEATURE = FORMAT.tabloid ? 0 : MIN_FEATURE;
/** tower() pushes the ground last: the plinth, 18 × 9 paving stones and 7 pieces of debris. */
const GROUND_COUNT = 1 + 18 * 9 + 7;

/** The machine, in the Tower's frame (ground y = 0, the eye 2.2 up, 48 back): centred, its open front facing the eye. */
const M = {
  x: 0, z: -4, R: 10, inner: 0.62, height: 13.5, columns: 12, plate: 0.55, gap: 0.11, tone: 0.65, pitch: 1.2, hollow: 1,
  lidDepth: 2.2, lidGap: 2.8, lidClear: 1.2, helixRadius: 1.5, helixWidth: 1.2,
};

type Machine = { solids: Slab[]; kind: ('blade' | 'panel' | 'bench')[]; column: number[]; lid: Set<number>; core: THREE.Vector3; lidCentre: THREE.Vector3 };

/**
 * The machine's blades as the format draws them: tabloid's plate and gap; or, where the gap between two blades
 * would print closer than the pens hold at the back of the C, the gap held at that floor and the blades merged
 * into courses of as many as keep the plate's proportion to it. Fewer blades, the same tone.
 */
export function blades(view: THREE.PerspectiveCamera): { plate: number; gap: number; merged: number } {
  const far = view.position.z - (M.z - M.R);
  const paper = M.gap * PAGE.height / (2 * far * Math.tan(THREE.MathUtils.degToRad(view.fov / 2)));
  // (The ratio first: at tabloid `tolerance` returns `paper` itself, so the gap is exactly M.gap.)
  const gap = M.gap * (tolerance(paper) / paper);
  const merged = Math.max(1, Math.floor(gap / M.gap));
  return { plate: merged * M.plate + (merged - 1) * M.gap, gap, merged };
}

/** The supercomputer: wedge columns of blades in a C, a few double blades for panels, the bench ring, and the top lifted off as one lid. */
function machine(ctx: SketchContext, view: THREE.PerspectiveCamera): Machine {
  const rng = ctx.random('tower-card-machine');
  const lidAmount = n(ctx, 'lid', 0.5, 0, 1);
  const { R, height, columns } = M;
  const { plate, gap } = blades(view);
  // The opening of the C at the front, in radians of the ring: about a quarter, as on the Cray-1.
  const open = n(ctx, 'machineOpen', 1.55, 0.1, 2.4);
  const inner = R * M.inner, rm = (R + inner) / 2;
  const base = new THREE.Vector3(M.x, 0, M.z);
  const step = (Math.PI * 2 - open) / columns;
  const solids: Slab[] = [], kind: Machine['kind'] = [], column: number[] = [];
  const lid = new Set<number>();
  let c = 0;
  const add = (s: Slab, k: Machine['kind'][number]) => { solids.push(s); kind.push(k); column.push(c); return solids.length - 1; };
  for (; c < columns; c++) {
    // Angles from the eye-ward axis, the opening centred on it, so the columns pair off left and right.
    const a = open / 2 + (c + 0.5) * step;
    const u = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    const chord = 2 * rm * Math.sin(step / 2) * 0.97;
    // A double blade every so often, staggered column to column: the panels the words are cut into.
    const phase = Math.floor(rng() * 5);
    for (let y = plate / 2 + 0.05, k = 0; y + plate / 2 < height; k++) {
      const panel = k > 3 && (k + phase) % 5 === 0 && y + 1.5 * plate + gap < height - M.lidDepth;
      const h = panel ? 2 * plate + gap : plate;
      const yc = y - plate / 2 + h / 2;
      const s = solid(base.x + u.x * rm, yc, base.z + u.z * rm, chord, h, R - inner, 0, 'stack');
      s.ry = a;
      s.tone = M.tone;
      const id = add(s, panel ? 'panel' : 'blade');
      if (yc + h / 2 > height - M.lidDepth) lid.add(id);
      y += h + gap;
    }
    // The bench: a low base and a cushion round the outside of each column.
    const b0 = R + 0.12, b1 = R + 2, bm = (b0 + b1) / 2, bchord = 2 * bm * Math.sin(step / 2) * 0.97;
    const lower = solid(base.x + u.x * bm, 0.6, base.z + u.z * bm, bchord, 1.2, b1 - b0, 0, 'stack');
    const cushion = solid(base.x + u.x * (bm + 0.07), 1.47, base.z + u.z * (bm + 0.07), bchord * 1.02, 0.52, b1 - b0 + 0.15, 0, 'stack');
    lower.ry = a; cushion.ry = a;
    lower.tone = M.tone; cushion.tone = M.tone;
    add(lower, 'bench'); add(cushion, 'bench');
  }
  // The lid: the top courses come away as one rigid piece, floating centred over the machine, tipped a little.
  const pivot = new THREE.Vector3(base.x, height - M.lidDepth / 2, base.z);
  const lidCentre = pivot.clone().setY(height + M.lidGap * (0.5 + lidAmount) + M.lidDepth / 2);
  const lean = rng() < 0.5 ? 1 : -1;
  const tip = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.04 + 0.1 * lidAmount, 0, lean * (0.03 + 0.08 * lidAmount) * (0.8 + 0.4 * rng()), 'XYZ'));
  for (const id of lid) {
    const s = solids[id];
    const m = new THREE.Matrix4().makeTranslation(lidCentre.x, lidCentre.y, lidCentre.z)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(tip))
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
      .multiply(slabMatrix(s));
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    m.decompose(p, q, new THREE.Vector3());
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    Object.assign(s, { x: p.x, y: p.y, z: p.z, rx: e.x, ry: e.y, rz: e.z, role: 'fallen' });
  }
  // However far the lid tips, it stays well clear of the body it came off.
  let lowest = Infinity;
  for (const id of lid) {
    const s = solids[id], mat = slabMatrix(s);
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) lowest = Math.min(lowest, new THREE.Vector3(x * s.w / 2, -s.h / 2, z * s.d / 2).applyMatrix4(mat).y);
  }
  const raise = height + M.lidClear - lowest;
  if (raise > 0) {
    for (const id of lid) solids[id].y += raise;
    lidCentre.y += raise;
  }
  return { solids, kind, column, lid, core: base, lidCentre };
}

/** A channel of the bolt on the page: its centreline, its half-width at the start and the end, the channel it forks from, and its order (0 the main channel, 1 a branch off it, 2 a branch off that, ...). */
type Channel = { path: Point[]; h0: number; h1: number; parent: number; order: number };

/** A run from a to b broken into seeded jags about every `step` mm, `amp` mm either side: lightning, not a staircase. */
function jagged(rng: () => number, a: Point, b: Point, step: number, amp: number): Point[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y), nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  const legs = Math.max(2, Math.round(len / step));
  const out: Point[] = [a];
  for (let j = 1; j < legs; j++) {
    const t = (j + (rng() - 0.5) * 0.45) / legs, jag = (j % 2 ? 1 : -1) * amp * (0.45 + 0.55 * rng());
    out.push({ x: a.x + (b.x - a.x) * t + nx * jag, y: a.y + (b.y - a.y) * t + ny * jag });
  }
  out.push(b);
  return out;
}

/** Arc length along a path to each vertex. */
function lengths(path: Point[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  return out;
}

/** The point at fraction t of a path's length, and the direction it runs there. */
function along(path: Point[], t: number): { p: Point; dir: Point } {
  const ls = lengths(path), target = t * ls.at(-1)!;
  let i = 1;
  while (i < path.length - 1 && ls[i] < target) i++;
  const a = path[i - 1], b = path[i], f = (target - ls[i - 1]) / Math.max(1e-9, ls[i] - ls[i - 1]);
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, dir: { x: (b.x - a.x) / l, y: (b.y - a.y) / l } };
}

/** Distance from p to a path, and the fraction of the path's length at the nearest point. */
function nearest(path: Point[], ls: number[], p: Point): { dist: number; t: number } {
  let best = Infinity, at = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-9;
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const d = Math.hypot(p.x - (a.x + dx * u), p.y - (a.y + dy * u));
    if (d < best) { best = d; at = ls[i - 1] + u * (ls[i] - ls[i - 1]); }
  }
  return { dist: best, t: at / Math.max(1e-9, ls.at(-1)!) };
}

const rotate = (d: Point, a: number): Point => ({ x: d.x * Math.cos(a) - d.y * Math.sin(a), y: d.x * Math.sin(a) + d.y * Math.cos(a) });

/**
 * The forked bolt, in page millimetres: a main channel in at a slant from the top right corner,
 * running down behind the machine, with branches forking off it to either side and sub-branches
 * off those, each tapering to a point. `half` is the main channel's half-width on tabloid. The bolt
 * is laid out in tabloid's frame and carried to the format's (its places through `layoutX` and
 * `layoutY`, its widths through `layoutLength`), so every size and fit strikes with the same seeded
 * bolt, in the same place against the machine.
 */
function forkedBolt(ctx: SketchContext, half: number): Channel[] {
  const rng = ctx.random('tower-front-bolt');
  const start = { x: TABLOID_CARD.x1 + 3, y: TABLOID_CARD.y0 - 3 };
  // It leaves through the far edge above the horizon, so the shared horizon stays open below it.
  const end = { x: TABLOID_CARD.x0 - 6, y: TABLOID_HORIZON_Y - 40 - 35 * rng() };
  const channels: Channel[] = [{ path: jagged(rng, start, end, 15, 6.5), h0: half, h1: half * 0.6, parent: -1, order: 0 }];
  const fork = (parent: number, t: number, side: number, spread: [number, number], length: number, level: number) => {
    const from = channels[parent], { p, dir } = along(from.path, t);
    const at = from.h0 + (from.h1 - from.h0) * t;
    const d = rotate(dir, side * (spread[0] + (spread[1] - spread[0]) * rng()));
    const tip = { x: p.x + d.x * length, y: p.y + d.y * length };
    const path = jagged(rng, p, tip, level === 1 ? 10 : 6, level === 1 ? 3.5 : 2);
    channels.push({ path, h0: Math.max(0.4, at * (level === 1 ? 0.55 : 0.65)), h1: 0.2, parent, order: from.order + 1 });
    return channels.length - 1;
  };
  // Branches all down the main channel, alternating sides, longest near the top; each splits again.
  const branches = 9 + Math.floor(rng() * 3);
  for (let b = 0; b < branches; b++) {
    const t = 0.04 + 0.86 * (b + 0.2 + 0.6 * rng()) / branches;
    const side = b % 2 ? 1 : -1;
    const k = fork(0, t, side, [0.3, 0.9], (55 + 75 * rng()) * (1 - 0.35 * t), 1);
    const subs = 2 + Math.floor(rng() * 3);
    for (let s = 0; s < subs; s++) {
      const sk = fork(k, 0.2 + 0.65 * (s + rng()) / subs, rng() < 0.5 ? 1 : -1, [0.25, 0.75], 12 + 30 * rng(), 2);
      if (rng() < 0.5) fork(sk, 0.35 + 0.45 * rng(), rng() < 0.5 ? 1 : -1, [0.2, 0.6], 6 + 12 * rng(), 2);
    }
  }
  return channels.map(ch => ({ ...ch, path: ch.path.map(p => ({ x: layoutX(p.x), y: layoutY(p.y) })), h0: layoutLength(ch.h0), h1: layoutLength(ch.h1) }));
}

/** The fewest branches a smaller card keeps off the bolt's main channel, so it still forks. */
const BRANCH_FLOOR = 4;
const GOLDEN = 0.6180339887498949;

/**
 * Which of the bolt's channels a card draws. Branching is a density: the branches off each channel are
 * spaced along it, so they are thinned in proportion to the scale, as an even spread, never under
 * `BRANCH_FLOOR` off the main channel; a branch goes with the channel it forks from. All of them at tabloid.
 */
function boltShown(bolt: Channel[]): boolean[] {
  const forks = new Map<number, number[]>();
  bolt.forEach((ch, k) => { if (ch.parent >= 0) forks.set(ch.parent, [...(forks.get(ch.parent) ?? []), k]); });
  const shown = bolt.map(ch => ch.parent < 0);
  // A channel forks off one listed before it, so its parent is decided first.
  bolt.forEach((ch, k) => {
    const off = forks.get(k) ?? [];
    const keep = off.length ? scaledCount(off.length, ch.order === 0 ? BRANCH_FLOOR : 0, 'length') / off.length : 1;
    off.forEach((c, i) => { shown[c] = shown[k] && (keep >= 1 || (i * GOLDEN) % 1 < keep); });
  });
  return shown;
}

/** A path cut at arc length `s`: the part before and the part after, sharing the point there. */
function splitAt(path: Point[], ls: number[], s: number): { head: Point[]; tail: Point[] } {
  let i = 1;
  while (i < path.length - 1 && ls[i] < s) i++;
  const a = path[i - 1], b = path[i], f = Math.min(1, (s - ls[i - 1]) / Math.max(1e-9, ls[i] - ls[i - 1]));
  const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  return { head: [...path.slice(0, i), p], tail: [p, ...path.slice(i)] };
}

/**
 * A tapering flat band round a channel: two outline rules meeting at the tip, and a hatch inside where it is
 * wide enough. Where it tapers under `narrow` millimetres across, the rules meet there and the channel runs on
 * to its tip as a single line (all of it, when it starts that narrow).
 */
function channelMarks(ch: Channel, area: Rect, pitch = 0.6, angle = Math.PI / 6, margin = 0.5, narrow = 0): Point[][] {
  const ls = lengths(ch.path), total = ls.at(-1)!;
  if (2 * ch.h1 < narrow) {
    const end = total * (ch.h0 - narrow / 2) / (ch.h0 - ch.h1);
    if (!(end > 0)) return clipToRect(ch.path, area);
    const { head, tail } = splitAt(ch.path, ls, end);
    return [...channelMarks({ ...ch, path: head, h1: narrow / 2 }, area, pitch, angle, margin), ...clipToRect(tail, area)];
  }
  const halfAt = (s: number) => ch.h0 + (ch.h1 - ch.h0) * s / total;
  const side = (sign: number): Point[] => ch.path.map((p, i) => {
    const a = ch.path[Math.max(0, i - 1)], b = ch.path[Math.min(ch.path.length - 1, i + 1)];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    let scale = 1;
    if (i > 0 && i < ch.path.length - 1) {
      const u = { x: p.x - ch.path[i - 1].x, y: p.y - ch.path[i - 1].y }, ul = Math.hypot(u.x, u.y) || 1;
      scale = 1 / Math.max(0.35, (-u.y / ul) * nx + (u.x / ul) * ny);
    }
    const h = i === ch.path.length - 1 ? 0 : halfAt(ls[i]) * scale;
    return { x: p.x + sign * nx * h, y: p.y + sign * ny * h };
  });
  const out: Point[][] = [[...side(1), ...side(-1).reverse()]];
  if (ch.h0 - margin > pitch) {
    const xs = ch.path.map(p => p.x), ys = ch.path.map(p => p.y);
    const box = { x0: Math.min(...xs) - ch.h0, x1: Math.max(...xs) + ch.h0, y0: Math.min(...ys) - ch.h0, y1: Math.max(...ys) + ch.h0 };
    const cx = Math.cos(angle), cy = Math.sin(angle), span = Math.hypot(box.x1 - box.x0, box.y1 - box.y0);
    for (let o = -span; o < span; o += pitch) {
      const ox = box.x0 - cy * o, oy = box.y0 + cx * o;
      for (const piece of clipToRect([{ x: ox - cx * span, y: oy - cy * span }, { x: ox + cx * span, y: oy + cy * span }], box)) {
        out.push(...keepAlong(piece, q => { const near = nearest(ch.path, ls, q); return near.dist < halfAt(near.t * total) - margin; }, 0.3));
      }
    }
  }
  return out.flatMap(path => clipToRect(path, area));
}

export function drawMachineTower(ctx: SketchContext): Part[] {
  // The ground pass keeps the cantilever card's own camera and depth pass, so the paving and storm
  // are hidden exactly as before wherever the machine does not stand in front of them.
  const view = towerCamera(ctx);
  const viewB = horizonCamera({
    fov: n(ctx, 'fov', 56, 40, 80), eye: [0, 2.2, n(ctx, 'distance', 48, 30, 90)], target: [0, 2.2, 0], far: 400,
    page: PAGE, depth: { width: W2, height: H2 }, horizonY: HORIZON_Y,
  });
  const eye = view.position.clone();
  const all = tower(ctx);
  if (all[all.length - GROUND_COUNT].role !== 'pier') throw new Error('xvi-tower machine: tower() no longer ends with plinth, paving and debris');
  // The ground as the cantilever card has it, less any debris that would sit inside the machine's footprint.
  const footprint = M.R + 2.4;
  // A paving stone whose top shows less than the smallest feature deep on paper, toward the horizon, is left out:
  // the paving runs on as far as it can be drawn, and the ground beyond is open to the horizon line. (A stone
  // reaching the eye's plane, with a camera pulled in close, is near and large: it stays.)
  const deep = (s: Slab) => s.z + s.d / 2 > view.position.z - 1 ? Infinity
    : pageOf(view, new THREE.Vector3(s.x, s.y + s.h / 2, s.z + s.d / 2)).y - pageOf(view, new THREE.Vector3(s.x, s.y + s.h / 2, s.z - s.d / 2)).y;
  const ground = all.slice(all.length - GROUND_COUNT).filter(s => (s.role !== 'debris' || Math.hypot(s.x - M.x, s.z - M.z) > footprint + Math.max(s.w, s.d) / 2)
    && (s.role !== 'stub' || FEATURE === 0 || deep(s) >= FEATURE));
  const m = machine(ctx, view);
  const light = rakingLight(ctx);
  // The machine takes the Machine study's light, high and from the front left, so its faces read square on.
  const front = new THREE.Vector3(-0.35, 0.8, 0.6).normalize();
  const density = n(ctx, 'hatchDensity', 0.6, 0, 1);
  const interruption = n(ctx, 'interruption', 0.32, 0, 1);

  // The helix, rising from the floor of the open core straight up through the opening and the lid, and on out of the card.
  const core = m.core;
  const rise = helixAlong(ctx, viewB, new THREE.CatmullRomCurve3([core.clone().setY(0.4), core.clone().setY(20), core.clone().setY(44)], false, 'centripetal'),
    { radius: M.helixRadius, width: M.helixWidth, pitch: 8.5, spread: 0.2, narrow: 0.15, density, interruption });

  // The bolt, behind everything standing.
  const bolt = forkedBolt(ctx, 3.5 + 3 * n(ctx, 'bolt', 0.5, 0, 1));
  const shown = boltShown(bolt);
  const reach = bolt.map(ch => ({
    ls: lengths(ch.path),
    xs: [Math.min(...ch.path.map(p => p.x)) - ch.h0, Math.max(...ch.path.map(p => p.x)) + ch.h0],
    ys: [Math.min(...ch.path.map(p => p.y)) - ch.h0, Math.max(...ch.path.map(p => p.y)) + ch.h0],
  }));
  /** Whether a page point lies within a channel's band (grown by `pad` mm). */
  const inChannel = (k: number, p: Point, pad = 0) => {
    const ch = bolt[k], r = reach[k];
    if (p.x < r.xs[0] - pad || p.x > r.xs[1] + pad || p.y < r.ys[0] - pad || p.y > r.ys[1] + pad) return false;
    const near = nearest(ch.path, r.ls, p);
    return near.dist < ch.h0 + (ch.h1 - ch.h0) * near.t + pad;
  };
  const inBolt = (p: Point, pad = 0) => bolt.some((_, k) => shown[k] && inChannel(k, p, pad));

  // Ground strokes: the paving in outline, plinth and debris hatched, and the storm behind.
  const groundStrokes: Stroke[] = [];
  for (const s of ground) for (const st of facetStrokes(s, light, eye, s.role === 'stub')) groundStrokes.push({ ...st, group: 'system' });
  groundStrokes.push(...storm(ctx));

  // Machine strokes, each owned by its solid; the status ticks on every blade's outer face.
  const strokes: Stroke[] = [];
  // Inside the C the walls shade each other: the further round the back a column stands, the more
  // its light turns away from the face we see into the core, so the open front reads as a hollow.
  const shade = new THREE.Vector3(0, 0.8, -0.6).normalize();
  m.solids.forEach((s, owner) => {
    const back = m.kind[owner] === 'bench' || m.lid.has(owner) ? 0 : Math.max(0, -Math.cos(s.ry)) * M.hollow;
    const lightHere = back > 0 ? front.clone().lerp(shade, back).normalize() : front;
    for (const st of facetStrokes(s, lightHere, eye, false, M.pitch * PITCH_SCALE)) strokes.push({ ...st, group: 'machine', owner });
  });
  const lrng = ctx.random('tower-card-lights');
  const patterns = Array.from({ length: 8 }, () => barPattern(lrng, 0.62));
  // The ticks are spaced along a blade's width, which scales with the card: a smaller card lights fewer, longer
  // ones, two at least, so each stays a mark rather than a dot.
  const K = scaledCount(5, 2, 'length');
  m.solids.forEach((s, i) => {
    if (m.kind[i] === 'bench') return;
    const mat = slabMatrix(s), pattern = patterns[i % 8];
    for (let k = 0; k < K; k++) {
      if (!pattern[(i * 5 + k) % 64]) continue;
      const x0 = -s.w / 2 + (k + 0.14) * s.w / K, x1 = -s.w / 2 + (k + 0.86) * s.w / K;
      strokes.push({ ink: (i + k) % 3 === 2 ? 'acid' : 'vermilion', group: 'lights', family: 'hatch', owner: i,
        points: [new THREE.Vector3(x0, 0, s.d / 2 + 0.02).applyMatrix4(mat), new THREE.Vector3(x1, 0, s.d / 2 + 0.02).applyMatrix4(mat)] });
    }
  });
  for (const h of rise.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points });

  const machineGeoms = m.solids.map(slabGeometry).concat(rise.meshes);
  const groundGeoms = ground.map(slabGeometry);
  const geometries = [...groundGeoms, ...machineGeoms];
  const pageAt = (p: THREE.Vector3): Point => pageOf(view, p);
  const ticks = ctx.params.machineTicks === 'lit' ? 'lit' : 'dead';
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    // The machine's pass: everything that can stand in front of it, the depth range fitted round it.
    const near = [...machineGeoms, ...groundGeoms.filter((_, i) => ground[i].role !== 'stub')];
    fitDepthRange(viewB, near);
    const depthB = renderDepthBufferCPU(near, viewB, W2, H2);

    // The phrase, a word to a panel, each in a column of its own and in reading order top to bottom,
    // on whichever face of the panel sees the eye, clear of the helix, inside the card.
    type Face = SloganSurface & { col: number; y: number };
    // A face behind the helix's axis must stand clear of where the helix crosses the sheet.
    const onHelix = meshCoverage(rise.meshes, view, PAGE, halo(2.5));
    const axisDepth = eye.distanceTo(core);
    // Each panel offers whichever of its four upright faces sees the eye best: outer, inner, or the
    // radial ends at the mouth of the C; each bench base offers its outer face.
    const turns = [0, Math.PI, Math.PI / 2, -Math.PI / 2].map(a => new THREE.Matrix4().makeRotationY(a));
    const faces = (): Face[] => {
      const out: Face[] = [];
      m.solids.forEach((s, id) => {
        const bench = m.kind[id] === 'bench' && s.h > 1;
        if (!(m.kind[id] === 'panel' || bench) || m.lid.has(id)) return;
        const matrix = slabMatrix(s), centre = new THREE.Vector3(s.x, s.y, s.z), toEye = eye.clone().sub(centre).normalize();
        let best: { face: THREE.Matrix4; w: number; d: number; sees: number } | null = null;
        for (const [k, turn] of turns.entries()) {
          if (bench && k > 0) break;
          const face = matrix.clone().multiply(turn);
          const sees = new THREE.Vector3(0, 0, 1).transformDirection(face).dot(toEye);
          const [w, d] = k < 2 ? [s.w, s.d] : [s.d, s.w];
          if (sees >= 0.45 && (!best || sees > best.sees)) best = { face, w, d, sees };
        }
        if (!best) return;
        const { face, w, d } = best;
        const at = (x: number) => pageAt(new THREE.Vector3(x, 0, d / 2).applyMatrix4(face));
        const p = at(0);
        const behind = eye.distanceTo(new THREE.Vector3(0, 0, d / 2).applyMatrix4(face)) > axisDepth;
        const clear = !behind || [-0.5, -0.25, 0, 0.25, 0.5].every(t => !onHelix(at(t * w)));
        if (clear && p.x > CARD.x0 + layoutLength(8) && p.x < CARD.x1 - layoutLength(8)) out.push({ id, matrix: face, w, h: s.h, d, col: m.column[id], y: p.y });
      });
      return out;
    };
    const env = {
      view: viewB, depth: depthB, width: W2, height: H2, bias: 0.0014, mmPerPx: MM2_Y,
      art: { x0: CARD.x0 / MM2_X, x1: CARD.x1 / MM2_X, y0: CARD.y0 / MM2_Y, y1: CARD.y1 / MM2_Y },
    };
    const settings = sloganSettings(ctx);
    // Where the format sets the phrase in the band, the machine carries no words.
    const words = settings.count > 0 && PHRASE === 'art' ? settings.text.split(' ').filter(Boolean) : [];
    const one = (params: Record<string, unknown>): SketchContext => ({ ...ctx, params: { ...ctx.params, ...params } as SketchContext['params'] });
    const slogans = { strokes: [] as THREE.Vector3[][], titleStrokes: [] as THREE.Vector3[][], knockouts: new Map<number, Point[][]>() };
    const keep = (plan: ReturnType<typeof planSlogans>) => {
      slogans.strokes.push(...plan.strokes);
      slogans.titleStrokes.push(...plan.titleStrokes);
      for (const [id, quads] of plan.knockouts) slogans.knockouts.set(id, [...(slogans.knockouts.get(id) ?? []), ...quads]);
    };
    const offered = faces();
    const top = Math.min(...offered.map(f => f.y)), span = Math.max(1, Math.max(...offered.map(f => f.y)) - top);
    const usedCols = new Set<number>(), usedIds = new Set<number>(), colYs = new Map<number, number[]>();
    // A column's panels and its bench segment count apart: the bench is a row of its own.
    const key = (f: Face) => m.kind[f.id] === 'bench' ? 100 + f.col : f.col;
    const xOf = (f: Face) => pageAt(new THREE.Vector3(0, 0, f.d / 2).applyMatrix4(f.matrix)).x;
    let prev = -Infinity, prevX = -Infinity;
    words.forEach((word, i) => {
      // Each word owns its share of the height, so the phrase spreads top to bottom and saves room for the rest.
      const lo = top + span * (i - 0.3) / words.length, hi = top + span * (i + 1) / words.length;
      // Dropping down a row, start it at the left, leaving the faces to the right for the words still to come.
      const roomRight = (pool: Face[]) => [...pool].sort((a, b) => xOf(a) - xOf(b)).slice(0, Math.max(1, Math.ceil(pool.length / (words.length - i))));
      const [g6, g8, g10, g20, g30] = [6, 8, 10, 20, 30].map(layoutLength);
      const tries: [(f: Face) => boolean, boolean][] = [
        [f => !usedCols.has(key(f)) && f.y > Math.max(prev + g8, lo) && f.y <= hi, false],
        [f => !usedCols.has(key(f)) && f.y > prev + g8 && f.y <= top + span * (i + 1.6) / words.length, false],
        // Reading on along a row: level with the word before, further right.
        [f => !usedCols.has(key(f)) && Math.abs(f.y - prev) < g10 && xOf(f) > prevX + g20, false],
        // A column may carry a second word when the two stand well apart.
        [f => !usedIds.has(f.id) && f.y > prev + g8 && f.y <= top + span * (i + 1.6) / words.length && (colYs.get(key(f)) ?? []).every(y => Math.abs(y - f.y) > g30), false],
        [f => !usedCols.has(key(f)) && f.y > prev + g8, true],
        [f => !usedIds.has(f.id) && f.y > prev + g6, true],
      ];
      for (const [j, [test, room]] of tries.entries()) {
        const pool = room ? roomRight(offered.filter(test)) : offered.filter(test);
        if (!pool.length) continue;
        const plan = planSlogans(one({ slogan: word, sloganCount: 1, sloganSpread: false, titleEnabled: false }), pool, env, `machine-word-${i}-${j}`);
        if (!plan.placed.length) continue;
        keep(plan);
        const at = pool.find(f => f.id === plan.placed[0].id)!;
        usedCols.add(key(at)); usedIds.add(at.id); prev = at.y; prevX = xOf(at);
        colYs.set(key(at), [...(colYs.get(key(at)) ?? []), at.y]);
        return;
      }
    });
    if (titleSettings(ctx).enabled) keep(planSlogans(one({ sloganCount: 0 }), offered.filter(f => !usedIds.has(f.id)), env, 'machine-title'));
    for (const points of slogans.strokes) strokes.push({ ink: settings.pen as Ink, group: 'slogan', family: 'text', points });
    for (const points of slogans.titleStrokes) strokes.push({ ink: 'lettering', group: 'title', family: 'text', points });
    // A face that carries a word drops its coloured field and its ticks, so the word sits on clean metal.
    const lettered = new Set(slogans.knockouts.keys());
    for (let k = strokes.length - 1; k >= 0; k--) {
      const st = strokes[k];
      if (st.owner !== undefined && lettered.has(st.owner) && st.family === 'hatch' && st.ink !== 'carbon') strokes.splice(k, 1);
    }
    const bandsB = [...slogans.knockouts.values()].flat();
    const bandsA = bandsB.map(q => q.map(p => ({ x: p.x * W / W2, y: p.y * H / H2 })));

    // The clock the machine ran on: a hatched square wave across the sky.
    const clock = ctx.params.machineClock === true;
    const cy = CARD.y0 + 0.03 * (CARD.y1 - CARD.y0), amp = layoutLength(3.5), period = layoutLength(22), clockHalf = layoutLength(0.8);
    const wave: Point[] = [];
    for (let x = CARD.x0 - period, k = 0; x < CARD.x1 + period; x += period / 2, k++) {
      const y = cy + (k % 2 ? amp : -amp);
      wave.push({ x, y }, { x: x + period / 2, y });
    }

    const buckets = new PartBuckets();
    const removeHidden = ctx.params.occlusion !== false;
    const put = (key: string, run: Point[], text: boolean) => { for (const kept of clipWindow(run)) buckets.add(key, kept, text); };
    projectStrokes(groundStrokes, { view, depth, width: W, height: H }, {
      hidden: () => removeHidden,
      pieces: c => bandsA.length === 0 ? [c] : clearBands(c, bandsA, MM_Y),
      begin: st => runs => {
        for (const run of runs) {
          const pts = scalePoints(run, MM_X, MM_Y);
          // The bolt and the clock are flat marks over the rain: it parts round them.
          const pieces = st.group === 'storm' ? keepAlong(pts, p => !inBolt(p, halo(0.6)) && !(clock && sideOf(wave, p).dist < clockHalf + halo(1.2)), 0.2) : [pts];
          for (const piece of pieces) put(`${st.group}-${st.ink}`, piece, false);
        }
      },
    });
    projectStrokes(strokes, { view: viewB, depth: depthB, width: W2, height: H2 }, {
      hidden: st => removeHidden && st.family !== 'text',
      pieces: (c, st) => st.family === 'text' || bandsB.length === 0 ? [c] : clearBands(c, bandsB, MM2_Y),
      begin: st => runs => {
        for (const run of runs) {
          const pts = scalePoints(run, MM2_X, MM2_Y);
          let key = `${st.group}-${st.ink}`;
          // Where the bolt runs behind the machine, the status ticks in front of it are dead.
          if (st.group === 'lights' && ticks === 'dead' && pts.length && inBolt(pts[Math.floor(pts.length / 2)], layoutLength(9))) key = 'lights-carbon';
          put(key, pts, st.family === 'text');
        }
      },
    });

    // Everything standing (the machine, its lid, the helix) stands in front of the bolt and the clock.
    const standing = meshCoverage(machineGeoms, view, PAGE, halo(1.2));
    if (clock) {
      const box = { x0: CARD.x0, x1: CARD.x1, y0: cy - amp - layoutLength(4), y1: cy + amp + layoutLength(4) };
      // A band narrower than the smallest feature is drawn as its centreline.
      const marks = 2 * clockHalf < FEATURE ? [wave] : bandMarks(wave, clockHalf, box, { pitch: tolerance(0.8), angle: Math.PI / 4 });
      for (const path of marks) {
        for (const inside of clipWindow(path)) for (const piece of keepAlong(inside, p => !standing(p) && !inBolt(p, halo(0.8)), 0.12)) buckets.add('clock-carbon', piece, true);
      }
    }
    const parts = buckets.toParts(['storm', 'clock', 'system', 'machine', 'lights', 'helix', 'slogan', 'title'], INKS);
    // The bolt: each channel's band, cut back where it meets the channel it forks from, hidden behind
    // everything standing. Where only a scrap of a channel would show in a gap, it is left out. Where a
    // channel narrows under the smallest feature, it runs on as its centreline.
    const boltPaths: Point[][] = [];
    bolt.forEach((ch, k) => {
      if (!shown[k]) return;
      const ls = reach[k].ls, total = ls.at(-1)!;
      const spans: [number, number][] = [];
      let open = -1;
      for (let s = 0, i = 1; s <= total + 1e-9; s += 0.5) {
        while (i < ch.path.length - 1 && ls[i] < s) i++;
        const a = ch.path[i - 1], b = ch.path[i], f = Math.min(1, (s - ls[i - 1]) / Math.max(1e-9, ls[i] - ls[i - 1]));
        const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
        const seen = !standing(p) && p.x > CARD.x0 && p.x < CARD.x1 && p.y > CARD.y0 && p.y < CARD.y1;
        if (seen && open < 0) open = s;
        if (!seen && open >= 0) { spans.push([open, s]); open = -1; }
      }
      if (open >= 0) spans.push([open, total]);
      const kept = spans.filter(([a, b]) => b - a >= layoutLength(ch.parent < 0 ? 12 : 5));
      const slack = layoutLength(1.5);
      const onSpan = (q: Point) => { const s = nearest(ch.path, ls, q).t * total; return kept.some(([a, b]) => s > a - slack && s < b + slack); };
      for (const path of channelMarks(ch, CARD, tolerance(0.6), Math.PI / 6, tolerance(0.5), FEATURE)) {
        for (const piece of keepAlong(path, p => !standing(p) && onSpan(p) && (ch.parent < 0 || !inChannel(ch.parent, p, halo(0.3))), 0.15)) if (piece.length > 1) boltPaths.push(piece);
      }
    });
    parts.push({ id: 'bolt-carbon', pen: 'carbon', paths: boltPaths });
    // The shared horizon, hidden behind the machine and the bolt.
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !standing(p) && !inBolt(p, halo(0.6)), 0.3) });
    // Where the format sets the phrase in the bottom band, the frame sets it there, under the name.
    parts.push(...cardFrame('XVI', 'THE TOWER', { phrase: settings }));
    return parts;
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}
