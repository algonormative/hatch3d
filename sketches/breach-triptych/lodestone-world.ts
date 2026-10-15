import * as THREE from 'three';
import type { Control, Point, SketchContext } from '../../src/sketch/types.ts';
import { strokeTextOnPath } from '../../src/sketch/stroke-text.ts';
import { clipToRect } from '../kit/page.ts';
import { solid, type Slab } from '../kit/slabs.ts';
import { CONTROLS, TRIM, lintelRect, type LintelBar } from './world.ts';

/**
 * The Breach triptych "Lodestone": the world its three panels share, on top of Lintel's (`world.ts`: the bust, its
 * censor bar and the eye height). The agent takes the censor bar off its eyes and sets it down (L); the bar is a magnet,
 * and everything near it swings into line (C); a kneeling figure takes the field's lines into its hands and grounds
 * them (R). The hole in L and the magnet in C sit at one height; the field lines leave C's right edge at the heights
 * where R's strands come in.
 */

/** The bust's controls, as Lintel's (L draws the bust; C and R recompute its bar from them). */
const BUST_IDS = ['scale', 'density', 'slack', 'elbow', 'gaze', 'fov', 'fitMargin', 'eyeAt', 'reach', 'value', 'impression', 'glare', 'slabMm', 'barPitch', 'holeBar'];

/** Every Lodestone panel declares these, so one params object draws all three. */
export const LODESTONE_CONTROLS: Control[] = [
  ...CONTROLS.filter(c => BUST_IDS.includes(c.id)),
  { type: 'slider', id: 'fieldLines', label: 'Field lines leaving each pole', default: 26, min: 8, max: 48, step: 1, group: 'Magnet' },
  { type: 'slider', id: 'filings', label: 'Filings (candidates, thousands)', default: 9, min: 0, max: 30, step: 0.5, group: 'Magnet' },
  { type: 'slider', id: 'handX', label: 'Hand: where it hangs over the bar (0 its left end, 1 its right)', default: 0.68, min: 0, max: 1, step: 0.01, group: 'Magnet' },
  { type: 'slider', id: 'kneelTurn', label: 'Kneeling figure: turn toward the centre', default: 50, min: 0, max: 80, step: 1, units: '°', group: 'Ground' },
  { type: 'toggle', id: 'groundRings', label: 'Ground rings in silver on the black disc (else bare)', default: true, group: 'Ground' },
];

// ── The magnet and its field ─────────────────────────────────────────

/** The bar as C carries it: level, centred across the sheet, at the eye height (Lintel's lintel placement). */
export const magnetRect = (bar: LintelBar) => lintelRect(bar);

export interface Magnet { rect: { x0: number; x1: number; y0: number; y1: number }; charges: { x: number; y: number; q: number }[] }

/** The bar magnetised along its length: a sheet of charge on each end face, north (+) on the left. */
export function magnet(bar: LintelBar): Magnet {
  const rect = magnetRect(bar);
  const charges: Magnet['charges'] = [];
  const K = 9, inset = 0.04 * (rect.x1 - rect.x0);
  for (let i = 0; i < K; i++) {
    const y = rect.y0 + (rect.y1 - rect.y0) * (i + 0.5) / K;
    charges.push({ x: rect.x0 + inset, y, q: 1 / K }, { x: rect.x1 - inset, y, q: -1 / K });
  }
  return { rect, charges };
}

/** The field at a page point (a 1/r² law, as of a three-dimensional bar seen in its plane). */
export function fieldAt(m: Magnet, p: Point): Point {
  let x = 0, y = 0;
  for (const c of m.charges) {
    const dx = p.x - c.x, dy = p.y - c.y, r2 = dx * dx + dy * dy + 0.25, r3 = r2 * Math.sqrt(r2);
    x += c.q * dx / r3; y += c.q * dy / r3;
  }
  return { x, y };
}

const inRect = (r: Magnet['rect'], p: Point, grow = 0) => p.x > r.x0 - grow && p.x < r.x1 + grow && p.y > r.y0 - grow && p.y < r.y1 + grow;
/** How far the field lines are followed off the sheet before they are let go (mm). */
const ROAM = 90;
/** How far a field line runs under the bar before it stops (mm): the assembly's bleed. */
const UNDER = 2;

/** One field line from `start`, followed along the field (`dir` 1) or against it (-1) until it reaches a pole, enters the bar or leaves the roam. */
function follow(m: Magnet, start: Point, dir: 1 | -1, step = 0.6): { points: Point[]; ended: 'pole' | 'away' } {
  const at = (p: Point) => { const f = fieldAt(m, p), l = Math.hypot(f.x, f.y) || 1; return { x: dir * f.x / l, y: dir * f.y / l }; };
  const pts: Point[] = [start];
  let p = start;
  for (let i = 0; i < 6000; i++) {
    const k1 = at(p), k2 = at({ x: p.x + k1.x * step / 2, y: p.y + k1.y * step / 2 }), k3 = at({ x: p.x + k2.x * step / 2, y: p.y + k2.y * step / 2 }), k4 = at({ x: p.x + k3.x * step, y: p.y + k3.y * step });
    p = { x: p.x + step * (k1.x + 2 * k2.x + 2 * k3.x + k4.x) / 6, y: p.y + step * (k1.y + 2 * k2.y + 2 * k3.y + k4.y) / 6 };
    pts.push(p);
    // Into the bar by the assembly's bleed, so a bar glued a little off never shows a gap at the pole.
    if (inRect(m.rect, p, -UNDER)) return { points: pts, ended: 'pole' };
    if (p.x < TRIM.x0 - ROAM || p.x > TRIM.x1 + ROAM || p.y < TRIM.y0 - ROAM || p.y > TRIM.y1 + ROAM) return { points: pts, ended: 'away' };
  }
  return { points: pts, ended: 'away' };
}

/**
 * The field lines: `count` lines leave the north end at equal steps of the flux through a contour hugging it (along
 * the top and bottom edges from a third of the way in, and round the end face, 1.5 mm out), so they crowd where the
 * field is strong and spread with distance, as the flux does; each is followed to the south end or off the sheet.
 * Lines that leave the sheet have their mirror twins drawn from the south end, which closes the picture.
 */
export function fieldLines(m: Magnet, count: number): Point[][] {
  const { rect } = m, L = rect.x1 - rect.x0, mid = (rect.x0 + rect.x1) / 2, g = 1.5;
  // The contour: along the top from a third of the way in to the end, down the end face, back along the bottom.
  const corners: Point[] = [{ x: rect.x0 + 0.34 * L, y: rect.y0 - g }, { x: rect.x0 - g, y: rect.y0 - g }, { x: rect.x0 - g, y: rect.y1 + g }, { x: rect.x0 + 0.34 * L, y: rect.y1 + g }];
  const samples: { p: Point; flux: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const a = corners[i], b = corners[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y), N = Math.ceil(len / 0.25);
    const nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len; // outward: the contour runs counter-clockwise round the end on the page
    for (let k = 0; k < N; k++) {
      const p = { x: a.x + (b.x - a.x) * (k + 0.5) / N, y: a.y + (b.y - a.y) * (k + 0.5) / N };
      const f = fieldAt(m, p);
      samples.push({ p, flux: Math.max(0, -(f.x * nx + f.y * ny)) * len / N });
    }
  }
  const total = samples.reduce((t, q) => t + q.flux, 0);
  const out: Point[][] = [];
  let acc = 0, next = 0;
  for (const q of samples) {
    acc += q.flux;
    while (acc >= (next + 0.5) / count * total && next < count) {
      next++;
      const line = follow(m, q.p, 1);
      const back = follow(m, q.p, -1);
      out.push([...back.points.reverse(), ...line.points.slice(1)]);
      if (line.ended === 'away') out.push(line.points.map(p => ({ x: 2 * mid - p.x, y: p.y })));
    }
  }
  return out;
}

/**
 * Iron filings: short dashes along the field, packed at the poles and thinning with distance. Candidate points are
 * thrown over the sheet and kept with a chance that grows with the field's strength, never closer than `gap` mm to one
 * kept before; each is a dash 1.4 to 2.6 mm long along the field there.
 */
export function filings(ctx: SketchContext, m: Magnet, candidates: number, keepOut: (p: Point) => boolean): Point[][] {
  const rng = ctx.random('lodestone-filings');
  const ref = Math.hypot(...Object.values(fieldAt(m, { x: m.rect.x0 - 6, y: (m.rect.y0 + m.rect.y1) / 2 })) as [number, number]);
  const cells = new Map<string, Point[]>();
  const GAP = 0.85, key = (x: number, y: number) => `${Math.floor(x / GAP)},${Math.floor(y / GAP)}`;
  const near = (p: Point) => { for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of cells.get(`${Math.floor(p.x / GAP) + i},${Math.floor(p.y / GAP) + j}`) ?? []) if (Math.hypot(q.x - p.x, q.y - p.y) < GAP) return true; return false; };
  const out: Point[][] = [];
  for (let i = 0; i < candidates; i++) {
    const p = { x: TRIM.x0 + (TRIM.x1 - TRIM.x0) * rng(), y: TRIM.y0 + (TRIM.y1 - TRIM.y0) * rng() };
    if (inRect(m.rect, p, 0.9) || keepOut(p)) { rng(); continue; }
    const f = fieldAt(m, p), s = Math.hypot(f.x, f.y);
    if (rng() > Math.min(1, 2.4 * (s / ref) ** 0.85)) continue;
    if (near(p)) continue;
    const len = 1.4 + 1.2 * rng(), ux = f.x / s, uy = f.y / s;
    out.push([{ x: p.x - ux * len / 2, y: p.y - uy * len / 2 }, { x: p.x + ux * len / 2, y: p.y + uy * len / 2 }]);
    const c = cells.get(key(p.x, p.y)); if (c) c.push(p); else cells.set(key(p.x, p.y), [p]);
  }
  return out;
}

/**
 * Where the field lines cross C's right trim edge, top to bottom: R's strands come in at these heights. At most `most`
 * of them, spread over the crossings, none closer than `gap` mm to the last.
 */
export function rightExits(lines: Point[][], most = 7, gap = 9): number[] {
  const ys: number[] = [];
  for (const line of lines) for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    if ((a.x - TRIM.x1) * (b.x - TRIM.x1) <= 0 && a.x !== b.x) {
      const y = a.y + (b.y - a.y) * (TRIM.x1 - a.x) / (b.x - a.x);
      if (y > TRIM.y0 + 25 && y < TRIM.y1 - 60) ys.push(y);
    }
  }
  ys.sort((a, b) => a - b);
  const kept: number[] = [];
  for (const y of ys) if (!kept.length || y - kept[kept.length - 1] >= gap) kept.push(y);
  if (kept.length <= most) return kept;
  return Array.from({ length: most }, (_, i) => kept[Math.round(i * (kept.length - 1) / (most - 1))]);
}

/** A word along a page line (a field line or a strand), `offset` mm to its side, starting `from` mm along it. */
export function wordAlong(word: string, line: Point[], from: number, height: number, offset: number): Point[][] {
  const guide: Point[] = [];
  let s = 0;
  for (let i = 1; i < line.length && s < from + 6 * height * word.length; i++) {
    s += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
    if (s >= from) guide.push(line[i]);
  }
  if (guide.length < 2) return [];
  return strokeTextOnPath(word, guide, { face: 'sans', height, align: 'start', normalOffset: offset });
}

/** Clip page paths to the trim. */
export const clipTrim = (paths: Point[][]): Point[][] => paths.flatMap(p => clipToRect(p, TRIM));

// ── Hands ────────────────────────────────────────────────────────────

/** A slab whose own axes are `x` (across), `y` (along) and `z` (through), centred at `c`. */
export function orientedSlab(c: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, w: number, h: number, d: number, beat: number): Slab {
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  const xx = new THREE.Vector3().crossVectors(y, z).normalize();
  const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xx, y.clone().normalize(), z), 'XYZ');
  const sl = solid(c.x, c.y, c.z, w, h, d, beat, 'stub');
  sl.rx = e.x; sl.ry = e.y; sl.rz = e.z;
  return sl;
}

export interface HandOptions {
  /** The wrist, the way the fingers point, and across the back of the hand (thumb side negative). */
  wrist: THREE.Vector3; along: THREE.Vector3; across: THREE.Vector3;
  /** World units of the palm's length; everything scales with it. */
  size: number;
  /** How far each knuckle bends toward the palm side (radians), and how far the fingers fan apart. */
  curl: number; spread: number;
}

/**
 * A faceted hand of slabs: a palm, four fingers of three segments and a thumb of two, each a touch narrower toward the
 * tip. Planes, not a mitten. The palm side is `along × across`.
 */
export function slabHand(o: HandOptions): Slab[] {
  const s = o.size, along = o.along.clone().normalize(), across = o.across.clone().normalize();
  const palmSide = new THREE.Vector3().crossVectors(along, across).normalize();
  const slabs: Slab[] = [];
  slabs.push(orientedSlab(o.wrist.clone().addScaledVector(along, 0.5 * s), across, along, 0.86 * s, s, 0.26 * s, 0));
  const lengths = [0.42, 0.28, 0.22];
  for (let f = 0; f < 4; f++) {
    const fan = o.spread * (f - 1.5);
    let dir = along.clone().applyAxisAngle(palmSide, fan);
    let at = o.wrist.clone().addScaledVector(along, s).addScaledVector(across, (f - 1.5) * 0.22 * s);
    const reach = f === 0 || f === 3 ? 0.86 : 1;
    for (let j = 0; j < 3; j++) {
      dir = dir.clone().applyAxisAngle(new THREE.Vector3().crossVectors(dir, palmSide).normalize(), -o.curl * (j === 0 ? 0.6 : 1));
      const len = lengths[j] * s * reach;
      const x = new THREE.Vector3().crossVectors(palmSide, dir).normalize();
      slabs.push(orientedSlab(at.clone().addScaledVector(dir, len / 2), x, dir, 0.19 * s * (1 - 0.08 * j), len + 0.02 * s, 0.17 * s * (1 - 0.08 * j), 1 + f * 3 + j));
      at = at.clone().addScaledVector(dir, len);
    }
  }
  // The thumb: from the palm's side near the wrist, out and down.
  let dir = along.clone().applyAxisAngle(palmSide, 0.75).applyAxisAngle(across, 0.35);
  let at = o.wrist.clone().addScaledVector(along, 0.3 * s).addScaledVector(across, -0.4 * s);
  for (let j = 0; j < 2; j++) {
    const len = (j === 0 ? 0.42 : 0.32) * s;
    dir = dir.clone().applyAxisAngle(new THREE.Vector3().crossVectors(dir, palmSide).normalize(), -o.curl * 0.7);
    const x = new THREE.Vector3().crossVectors(palmSide, dir).normalize();
    slabs.push(orientedSlab(at.clone().addScaledVector(dir, len / 2), x, dir, 0.22 * s, len, 0.19 * s, 20 + j));
    at = at.clone().addScaledVector(dir, len);
  }
  return slabs;
}
