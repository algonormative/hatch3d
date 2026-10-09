import * as THREE from 'three';
import type { Point, SketchContext } from '../../../src/sketch/types.ts';
import { S, TABLOID_CARD, TABLOID_HORIZON_Y, evenlyKept, layoutLength, layoutX, layoutY, scaledCount, tolerance } from '../../kit/format.ts';
import { keepAlong } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { valueNoise } from '../../kit/mannequin/hatch.ts';
import { CARD, HORIZON_Y, clipWindow } from '../card.ts';
import { EYE, type Scale } from './peak.ts';

/**
 * The night: a ruled field whose lines come in by tiers (every eighth line first, every line last)
 * as the local darkness rises, so one family of rules reads as a gradient from open paper to black.
 * Where the darkness only just clears a tier's threshold the line breaks into dashes.
 */
const THRESHOLD = [0, 0.22, 0.5, 0.74];
const tierOf = (i: number) => (i % 8 === 0 ? 0 : i % 4 === 0 ? 1 : i % 2 === 0 ? 2 : 3);

export interface Ruling {
  /** Direction of the rules, radians from the page's x axis. */
  angle: number;
  /** Millimetres between neighbouring rules at full darkness. */
  pitch: number;
  /** Darkness 0..1 at a page point. */
  dark: (p: Point) => number;
  /** Whether this rule may be drawn at the point at all (knockouts); `i` is the rule's index. */
  keep: (p: Point, i: number) => boolean;
  /** 64 seeded uniform numbers, for the breaking of a thinning rule. */
  table: number[];
  emit: (path: Point[]) => void;
}

export function ruling(o: Ruling): void {
  const dx = Math.cos(o.angle), dy = Math.sin(o.angle), nx = -dy, ny = dx;
  const span = Math.hypot(CARD.x1 - CARD.x0, CARD.y1 - CARD.y0);
  const cx = (CARD.x0 + CARD.x1) / 2, cy = (CARD.y0 + CARD.y1) / 2;
  for (let off = -span / 2, i = 0; off < span / 2; off += o.pitch, i++) {
    const tier = tierOf(i);
    const line: Point[] = [{ x: cx + nx * off - dx * span, y: cy + ny * off - dy * span }, { x: cx + nx * off + dx * span, y: cy + ny * off + dy * span }];
    for (const piece of clipWindow(line)) {
      for (const run of keepAlong(piece, (p, at) => {
        if (!o.keep(p, i)) return false;
        const margin = o.dark(p) - THRESHOLD[tier];
        if (margin < 0) return false;
        if (margin >= 0.14) return true;
        return o.table[(Math.floor(at / 3.2) * 7 + i * 13) % 64] < margin / 0.14;
      }, 0.2)) o.emit(run);
    }
  }
}

/** One ruled row of the network: its page y and the gaps (lit points) knocked out of it, as [x0, x1] page intervals. */
export interface NetworkRow { y: number; gaps: [number, number][] }

/**
 * A lit point on the ground: a small hole in the ruling. `x`, `y` are its place on tabloid's page; `hx`, `hy` its size
 * on paper, in millimetres, which holds on any card; `index` its place in the seeded set.
 */
export interface Lit { x: number; y: number; hx: number; hy: number; index: number }

/**
 * The fewest lit points a smaller card keeps, so the network still reads as the print's band of lights. By the window's
 * area alone a 70 × 120 card keeps 60 of the print's 870 (seed 1), and its lit belt prints at under three quarters of
 * the print's light (the holes' share of the rows, seeds 0 to 4); 90 holds the print's.
 */
const LIT_FLOOR = 90;

/**
 * The ruling's pitch below the horizon, in millimetres on paper, at `t` tabloid millimetres below the horizon (a card
 * passes its own offset as `off / S`): `pitch` across the lit belt, opening a little, then fast toward the eye.
 */
function rowGap(ctx: SketchContext, pitch: number): (t: number) => number {
  const grow = n(ctx, 'gridGrow', 60, 20, 200);
  // The ruling is tight (the lit grid can only show against it) out to `belt` below the horizon, then opens out fast toward the eye.
  const belt = n(ctx, 'gridBelt', 46, 20, 100), open = n(ctx, 'gridOpen', 0.1, 0.02, 0.3);
  return (t: number) => (t < belt ? pitch * (1 + t / grow) : pitch * (1 + belt / grow) + open * (t - belt));
}
const gridPitch = (ctx: SketchContext) => n(ctx, 'gridPitch', 0.62, 0.5, 1.5);

/**
 * The network the hermit left: a city seen at night from a height, as it sits on the plain below the
 * horizon. The plain is ruled in rows of constant ground distance, so they crowd together toward the
 * horizon and open out toward the eye. On that ground stands a grid of lots, in rows across and columns
 * that converge on the horizon, grouped into blocks with streets between; a lot in a lit block is lit
 * with a small round hole (a dot, 1 to 2 mm) cut out of the ruling. Rows are a lot's depth apart on the
 * ground, so they foreshorten: wide apart near the eye, packed into a bright speckled band at the horizon.
 * Blocks are lit less the nearer they are, and none at all close to the eye. Lit points never stack: in
 * a column each sits clear of the one before it by more than its own height, so the convergence of the
 * grid shows only in how the points line up, never as a continuous line.
 *
 * The lit points are the seeded world: laid out in tabloid's frame (`sc` is `worldScale`, on tabloid's page and card),
 * so every size and fit lights the print's lots. `networkRows` rules them on this card.
 */
export function networkLights(ctx: SketchContext, sc: Scale): Lit[] {
  const noise = valueNoise(ctx.random('night-city'));
  const lots = ctx.random('night-lots');
  const across = n(ctx, 'gridLot', 1.4, 1, 12), deep = n(ctx, 'gridDepth', 6, 2, 40);
  const fill = n(ctx, 'gridFill', 0.92, 0.2, 1), space = n(ctx, 'gridSpace', 1.5, 1.2, 5);
  const fade = n(ctx, 'gridBelt', 46, 20, 100);
  const blockAcross = Math.round(n(ctx, 'blockAcross', 6, 2, 10)), blockDeep = Math.round(n(ctx, 'blockDeep', 5, 2, 10));
  const streetAcross = Math.round(n(ctx, 'streetAcross', 2, 1, 4)), streetDeep = Math.round(n(ctx, 'streetDeep', 1, 1, 3));
  const card = TABLOID_CARD, horizon = TABLOID_HORIZON_Y;
  const centre = (card.x0 + card.x1) / 2;
  const reach = card.y1 - horizon;
  // The print's row pitch, for the dots' height: on any card the rows at a lot's place are as far apart on paper.
  const gapAt = rowGap(ctx, gridPitch(ctx));
  const points: Lit[] = [];
  const lastAt = new Map<number, number>();
  const wrap = (i: number, period: number) => ((i % period) + period) % period;
  // Lot rows from the horizon toward the eye, a lot's depth apart on the ground.
  for (let r = 0, d = sc.f * EYE / 1.3; d > 0; r++, d -= deep) {
    const off = sc.f * EYE / d;
    if (off >= Math.min(reach, fade)) break;
    const cell = across * sc.f / d;
    // Dots 1 to 2 mm wide, tall enough to cut a rule or two.
    const hx = Math.min(2.2, Math.max(1.1, 0.45 * cell)), hy = Math.max(1.7, 1.4 * gapAt(off));
    const near = off / fade;
    const rowStreet = wrap(r, blockDeep + streetDeep) >= blockDeep;
    const first = Math.floor((card.x0 - centre) / cell) - 1, last = Math.ceil((card.x1 - centre) / cell) + 1;
    for (let i = first; i <= last; i++) {
      const x = centre + (i + 0.5) * cell;
      if (x < card.x0 || x > card.x1) continue;
      // Streets: between blocks across, and between blocks in depth.
      if (rowStreet || wrap(i, blockAcross + streetAcross) >= blockAcross) continue;
      // A block is lit or dark by smooth noise over the grid of blocks; fewer are lit toward the eye.
      const bi = Math.floor(i / (blockAcross + streetAcross)), bj = Math.floor(r / (blockDeep + streetDeep));
      const block = noise(new THREE.Vector3(bi * 0.6 + 11, bj * 0.6 + 5, 0));
      if (block > 0.95 - 0.15 * near) continue;
      // Within a lit block, most lots show a light near the horizon and fewer toward the eye.
      if (lots() > fill * (1 - 0.45 * near ** 1.5)) continue;
      const y = horizon + off;
      // Each column starts at its own height, so the points do not all fall on the same rows.
      if (!lastAt.has(i)) lastAt.set(i, horizon + 1.3 - lots() * space * hy);
      if (y - lastAt.get(i)! < space * hy) continue;
      lastAt.set(i, y);
      points.push({ x, y, hx, hy, index: points.length });
    }
  }
  return points;
}

/**
 * The plain ruled on this card, with the lit points cut out of its rows. The ruling is a tone: its pitch holds on paper
 * (`rowGap`). The lit points are a density, each a hole of a fixed size on paper, so a smaller card keeps as many per
 * square millimetre as the print (`scaledCount` by area, never under `LIT_FLOOR`), an even spread through the seeded
 * set (`evenlyKept`), each at its own place scaled with the card. All of them, unmoved, at tabloid.
 */
export function networkRows(ctx: SketchContext, lights: Lit[]): NetworkRow[] {
  // The pitch is a tone: real millimetres, never under the pen floor; the gradient reads this card's offsets as the print's.
  const gapAt = rowGap(ctx, tolerance(gridPitch(ctx)));
  const keep = lights.length ? scaledCount(lights.length, LIT_FLOOR) / lights.length : 1;
  const points = lights.filter(q => evenlyKept(q.index, keep)).map(q => ({ ...q, x: layoutX(q.x), y: layoutY(q.y) }));
  points.sort((a, b) => a.y - b.y);
  const reach = CARD.y1 - HORIZON_Y;
  const rows: NetworkRow[] = [];
  let from = 0;
  // The first rule a little below the horizon line, never closer to it than the pens hold apart.
  for (let off = tolerance(layoutLength(1.3)); off < reach; off += gapAt(off / S)) {
    const y = HORIZON_Y + off;
    while (from < points.length && points[from].y + points[from].hy / 2 < y) from++;
    const found: [number, number][] = [];
    for (let k = from; k < points.length && points[k].y - points[k].hy / 2 <= y; k++) {
      const q = points[k];
      const t = (y - q.y) / (q.hy / 2);
      if (Math.abs(t) >= 1) continue;
      const half = q.hx / 2 * Math.sqrt(1 - t * t);
      if (half > 0.12) found.push([q.x - half, q.x + half]);
    }
    found.sort((a, b) => a[0] - b[0]);
    const gaps: [number, number][] = [];
    for (const g of found) {
      const last = gaps[gaps.length - 1];
      if (last && g[0] <= last[1]) last[1] = Math.max(last[1], g[1]); else gaps.push([g[0], g[1]]);
    }
    rows.push({ y, gaps });
  }
  return rows;
}
