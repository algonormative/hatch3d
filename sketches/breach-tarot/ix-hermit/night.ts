import * as THREE from 'three';
import type { Point, SketchContext } from '../../../src/sketch/types.ts';
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
 * The network the hermit left: the plain below the horizon is ruled in rows of constant ground
 * distance, so they crowd together toward the horizon and open out toward the eye. Lots stand on a
 * fixed grid on that ground, in rows and in columns that converge on the horizon: a ruled row is a
 * row of the grid wherever the ground distance it stands at crosses a lot boundary. Where a lot in
 * such a row is lit, a gap is cut out of the rule at its place, wide enough to read as a dash. The
 * cells shrink toward the horizon until the gaps merge into a thin bright band. Clusters of lit lots
 * come from smooth noise (blocks and streets), and the near ground is quieter.
 */
export function networkRows(ctx: SketchContext, sc: Scale): NetworkRow[] {
  const noise = valueNoise(ctx.random('night-city'));
  const lots = ctx.random('night-lots');
  const pitch = n(ctx, 'gridPitch', 0.75, 0.5, 1.5), grow = n(ctx, 'gridGrow', 22, 8, 80);
  const lot = n(ctx, 'gridLot', 3.5, 2, 20), fill = n(ctx, 'gridFill', 0.9, 0.2, 1);
  const centre = (CARD.x0 + CARD.x1) / 2;
  const reach = CARD.y1 - HORIZON_Y;
  const rows: NetworkRow[] = [];
  let before = Infinity;
  for (let off = 1.3; off < reach; off += pitch * (1 + off / grow)) {
    const d = sc.f * EYE / off;
    const q = Math.floor(d / lot);
    const onGrid = q !== before;
    before = q;
    const gaps: [number, number][] = [];
    if (onGrid) {
      const cell = lot * sc.f / d;
      const hx = Math.min(7, Math.max(0.7, 0.45 * cell));
      // The near ground is quieter: fewer lots lit the nearer they are.
      const lit = fill * Math.min(1, Math.max(0.4, 1.15 - off / 160));
      const first = Math.floor((CARD.x0 - centre) / cell) - 1, last = Math.ceil((CARD.x1 - centre) / cell) + 1;
      for (let i = first; i <= last; i++) {
        const x = centre + (i + 0.5) * cell;
        if (x < CARD.x0 || x > CARD.x1) continue;
        const blocks = noise(new THREE.Vector3(((i + 0.5) * lot) / 40, d / 120, 0));
        if (lots() > lit * Math.min(1, Math.max(0.6, 0.95 + 1.2 * (blocks - 0.45)))) continue;
        gaps.push([x - hx / 2, x + hx / 2]);
      }
    }
    rows.push({ y: HORIZON_Y + off, gaps });
  }
  return rows;
}
