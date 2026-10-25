/**
 * How much hand cutting a sheet asks for, from its cut rings: how many outlines, how long, how many corners, the
 * narrowest window and the narrowest strip of paper kept between two cuts, and an estimate in minutes. Pure and free
 * of Node modules (the sketch lab's worker uses it too).
 */
import { distanceToRings, inRegion } from '../packages/plot-core/src/region.ts';
import type { Point } from '../src/sketch/types.ts';

/** The hand-cutting rates the estimate assumes: a craft knife along a ruler or freehand on a mat. */
export const CUT_RATES = { mmPerSecond: 4, secondsPerCorner: 2, secondsPerPiece: 20 } as const;

export interface CutEffort {
  /** Separate outlines to cut. */
  pieces: number;
  /** Their total length, mm. */
  lengthMm: number;
  /** Turns sharper than 30°: each a stop and a turn of the knife. */
  corners: number;
  /** Twice the largest circle that fits in the narrowest window, mm (undefined with no cuts). */
  narrowestWindowMm?: number;
  /** The least paper kept between two outlines, mm (undefined with fewer than two). */
  narrowestBridgeMm?: number;
  /** Where that bridge is (page mm), to find it on the sheet. */
  narrowestBridgeAt?: Point;
  /** At `CUT_RATES`. */
  minutes: number;
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/** Closed rings (a repeated last point is ignored). */
const open = (ring: Point[]) => (ring.length > 1 && ring[0].x === ring[ring.length - 1].x && ring[0].y === ring[ring.length - 1].y ? ring.slice(0, -1) : ring);

function perimeter(ring: Point[]): number {
  let t = 0;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; t += Math.hypot(b.x - a.x, b.y - a.y); }
  return t;
}

function cornersOf(ring: Point[]): number {
  let n = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-9 || lv < 1e-9) continue;
    if (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)))) > Math.PI / 6) n++;
  }
  return n;
}

/** The largest clearance from the cut's outlines inside one ring's share of the cut (sampled on a grid). */
function clearanceIn(ring: Point[], all: Point[][]): number {
  const xs = ring.map(p => p.x), ys = ring.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const step = Math.max((x1 - x0) / 60, (y1 - y0) / 60, 0.05);
  let best = 0;
  for (let y = y0 + step / 2; y < y1; y += step) for (let x = x0 + step / 2; x < x1; x += step) {
    const p = { x, y };
    if (!inRegion(p, { rings: [ring] }) || !inRegion(p, { rings: all })) continue;
    best = Math.max(best, distanceToRings(p, all));
  }
  return best;
}

/** The least distance between two rings' edges (by their vertices against the other's edges, both ways), and where. */
function gapBetween(a: Point[], b: Point[]): { d: number; at: Point } {
  let d = Infinity, at = a[0];
  for (const [from, to] of [[a, b], [b, a]] as const) for (const p of from) { const q = distanceToRings(p, [to]); if (q < d) { d = q; at = p; } }
  return { d, at };
}

export function cutEffort(rings: Point[][]): CutEffort {
  const list = rings.map(open).filter(r => r.length >= 3);
  const lengthMm = list.reduce((t, r) => t + perimeter(r), 0);
  const corners = list.reduce((t, r) => t + cornersOf(r), 0);
  const minutes = (lengthMm / CUT_RATES.mmPerSecond + corners * CUT_RATES.secondsPerCorner + list.length * CUT_RATES.secondsPerPiece) / 60;
  const out: CutEffort = { pieces: list.length, lengthMm: Math.round(lengthMm), corners, minutes: round(minutes) };
  if (list.length) out.narrowestWindowMm = round(2 * Math.min(...list.map(r => clearanceIn(r, list)).filter(c => c > 0)), 2);
  if (list.length > 1) {
    const box = list.map(r => ({ x0: Math.min(...r.map(p => p.x)), x1: Math.max(...r.map(p => p.x)), y0: Math.min(...r.map(p => p.y)), y1: Math.max(...r.map(p => p.y)) }));
    let best = { d: Infinity, at: list[0][0] };
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = box[i], b = box[j];
      const apart = Math.max(a.x0 - b.x1, b.x0 - a.x1, a.y0 - b.y1, b.y0 - a.y1, 0);
      if (apart >= best.d) continue;
      const g = gapBetween(list[i], list[j]);
      if (g.d < best.d) best = g;
    }
    out.narrowestBridgeMm = round(best.d, 2);
    out.narrowestBridgeAt = { x: round(best.at.x), y: round(best.at.y) };
  }
  return out;
}

/** One line for a finalize summary or a status bar. */
export const describeCutEffort = (e: CutEffort): string =>
  `${e.pieces} outline${e.pieces === 1 ? '' : 's'}, ${(e.lengthMm / 1000).toFixed(2)} m, ${e.corners} corners, ~${Math.round(e.minutes)} min`
  + (e.narrowestWindowMm !== undefined ? `, narrowest window ${e.narrowestWindowMm} mm` : '')
  + (e.narrowestBridgeMm !== undefined ? `, narrowest bridge ${e.narrowestBridgeMm} mm at (${e.narrowestBridgeAt?.x}, ${e.narrowestBridgeAt?.y})` : '');
