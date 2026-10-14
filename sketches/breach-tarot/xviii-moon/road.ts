import * as THREE from 'three';
import type { Point, SketchContext } from '../../../src/sketch/types.ts';
import { helixStrands, strandPoint, strandStrokes, type HelixStroke, type Strand } from '../../kit/helix.ts';
import { FORMAT, MIN_SPACING, PAGE, PITCH_SCALE, TABLOID_HORIZON_Y, tolerance } from '../../kit/format.ts';
import { n, smooth } from '../../kit/params.ts';
import { onGround, pageOf } from '../../kit/perspective.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';

/**
 * The path as the helix: one flat ribbon road lying on the ground, from under the water to the horizon.
 * It runs in wide S-bends, its edges parallel, and turns over a few times along its length: where it
 * turns, its edges cross and the other side comes up. The two strands of the kit's helix are the
 * ribbon's two faces, strand `a` the side that lies up first and strand `b` the underside, so each
 * turn swaps the road's inks. Every stroke is the kit's own, in the inks `strandStrokes` gives it; only
 * where it lies is the road's.
 */

/** Strand length in its own space: short enough that the kit's rests (open bars far from its breach centre) never fall. */
const LEN = 10;
/**
 * A strand with no turns of its own (the road does the turning) and its fixed wobble zeroed, so a stroke point gives back
 * where along and across the strand it lies. The kit lays its laminations across it at a pitch held on paper (times the
 * format's pitch scale), so off tabloid the strand is widened by that scale, and doubled: it gives twice the print's
 * laminations, so the small card's fill finds one near each place it wants, and the road thins them by its own width.
 */
function flatStrand(st: Strand): Strand {
  // The kit lifts each point by 0.3·sin(2θ + 0.3·phase): with no turns θ is fixed, and this θ makes that lift nothing.
  const theta0 = -0.15 * st.phase;
  const width = FORMAT.tabloid ? 1.05 : 2 * 1.05 * PITCH_SCALE;
  return { ...st, x: 0, y: 0, z: 0, y0: 0, y1: LEN, turns: 0, theta0, twist: 0, swell: 0, centre: LEN / 2, depth: 1, radius: 1, width };
}

/** Where along (`t`, 0..1) and across (`v`, -1..1 at the ribbon's edges) a strand-space point lies. */
function strandCoords(st: Strand, p: THREE.Vector3): { t: number; v: number } {
  const t = (p.y - st.y - st.y0) / (st.y1 - st.y0);
  const tc = Math.max(0, Math.min(1, t));
  const across = new THREE.Vector3(-Math.sin(st.theta0), 0, Math.cos(st.theta0));
  const c0 = strandPoint(st, tc, 0), e = strandPoint(st, tc, 1).sub(c0);
  return { t, v: p.clone().sub(c0).dot(across) / e.dot(across) };
}

/**
 * The fill of a small card's ribbon: each of the kit's laminations (by its place across, `v`) given a level, so that the
 * levels up to L lay lines in each half of the ribbon at the odd multiples of 1/2^L of the way from the middle to the
 * edge (a half at level 1, then the quarters, then the eighths), each the lamination nearest its place. The middle
 * lamination is level 0. `gap[L]` is the closest two lines then come, with the middle and the edge, in half widths.
 */
function dyadicFill(vs: number[]): { level: (v: number) => number; gap: number[] } {
  // The kit lays `count` laminations evenly across, at v = -0.975 + 1.95 (j + 0.5) / count; j and its mirror share a level.
  const count = Math.round(0.975 / (Math.min(...vs) + 0.975));
  const indexOf = (v: number) => { const j = Math.round((v + 0.975) / 1.95 * count - 0.5); return Math.min(j, count - 1 - j); };
  const place = (i: number) => Math.abs(-0.975 + 1.95 * (i + 0.5) / count);
  const half = Array.from({ length: Math.ceil(count / 2) }, (_, i) => i);
  const levels = new Map<number, number>([[half[half.length - 1], 0]]);
  const gap = [1];
  for (let L = 1; L <= 6; L++) {
    const picks = Array.from({ length: 2 ** (L - 1) }, (_, q) => (2 * q + 1) / 2 ** L)
      .map(t => half.reduce((a, b) => Math.abs(place(b) - t) < Math.abs(place(a) - t) ? b : a));
    if (picks.some(i => levels.has(i)) || new Set(picks).size < picks.length) break;
    for (const i of picks) levels.set(i, L);
    const placed = [0, ...[...levels.keys()].filter(i => levels.get(i)! > 0).map(place), 1].sort((a, b) => a - b);
    gap.push(Math.min(...placed.slice(1).map((p, k) => p - placed[k])));
  }
  // With an even count the middle is a pair a hair apart: one of them is the middle line.
  return { level: v => (count % 2 === 0 && v < 0 && levels.get(indexOf(v)) === 0 ? Infinity : levels.get(indexOf(v)) ?? Infinity), gap };
}

export interface RoadPlan {
  /** Ground point of the road's centre at parameter u (0 at the water's edge, 1 at the far end; below 0 under the water). */
  centre: (u: number) => THREE.Vector3;
  /** Unit vector across the road, on the ground, to its right. */
  across: (u: number) => THREE.Vector3;
  /** The ribbon's turn: 0 lies face up, π face down. */
  turn: (u: number) => number;
  /** Half the road's width in world units. */
  half: number;
  /** How far under the water the strands begin, in u. */
  u0: number;
}

/**
 * The road in plan. Its centre is laid on the sheet: from the spit at `x0` it swings in S-bends that
 * shrink exactly as the ground recedes, so on the ground they are bends of one width, and it ends at
 * `pathEnd`, just under the horizon. Turns sit at the bends' crossings, where the road runs straightest.
 * It is laid out in tabloid's frame: `view` is the card's world camera and `shore` the bank on tabloid's page, so
 * every size and fit lays the same road.
 */
export function roadPlan(ctx: SketchContext, view: THREE.PerspectiveCamera, shore: (x: number) => number, eye: number): RoadPlan {
  const x0 = n(ctx, 'pathX', 150, 110, 190);
  const y0 = shore(x0);
  const d0 = y0 - TABLOID_HORIZON_Y;
  const kEnd = (n(ctx, 'pathEnd', 252.5, 251, 270) - TABLOID_HORIZON_Y) / d0;
  const xv = n(ctx, 'pathVanish', 162, 110, 200);
  const swing = n(ctx, 'pathBend', 55, 0, 140);
  const bends = n(ctx, 'pathBends', 3.5, 1.5, 6);
  // Share of the road's depth on the sheet: k = 1 at the water, kEnd at the far end, eased so the bends spread down the ground.
  const root = Math.sqrt(kEnd);
  const kOf = (u: number) => ((1 - u) + u * root) ** 2;
  const pageAt = (u: number): Point => {
    const k = kOf(u);
    // The swing eases in from nothing, so the road comes straight up out of the water before it bends.
    return { x: xv + k * ((x0 - xv) - swing * smooth(0, 0.18, u) * Math.sin(Math.PI * bends * Math.max(0, u))), y: TABLOID_HORIZON_Y + d0 * k };
  };
  const centre = (u: number) => onGround(view, pageAt(u), TABLOID_PAGE);
  const across = (u: number) => {
    const a = centre(u - 0.002), b = centre(u + 0.002);
    const t = b.sub(a).setY(0).normalize();
    return new THREE.Vector3(-t.z, 0, t.x);
  };
  const turns = Math.round(n(ctx, 'pathTwists', 3, 1, 4));
  const spread = n(ctx, 'pathTwistLength', 0.15, 0.03, 0.25);
  // The turns sit at the S-bends' crossings, nearest first (none later than 0.95 of the way along).
  const at = Array.from({ length: turns }, (_, k) => Math.min(0.95, (k + 1) / bends));
  const turn = (u: number) => Math.PI * at.reduce((acc, c) => acc + smooth(c - spread / 2, c + spread / 2, u), 0);
  // The road's half width, from how wide it is on the sheet where it leaves the water.
  const half = n(ctx, 'pathWidth', 34, 8, 70) / 2 * eye / d0;
  return { centre, across, turn, half, u0: -n(ctx, 'pathUnder', 0.08, 0, 0.3) };
}

/**
 * The road's strokes in world space, in the kit's inks. Each face's strokes are kept only where that
 * face is up; its laminations thin in nested powers of two as the road narrows on the sheet (toward
 * the horizon, and where it turns on edge), and its ribs keep at least `ribGap` millimetres apart.
 * `view` is the card's own camera: the laminations and ribs keep their millimetres on this card's paper, never
 * closer than the pens hold apart, so a smaller card draws fewer of them.
 */
export function roadStrokes(ctx: SketchContext, view: THREE.PerspectiveCamera, plan: RoadPlan): HelixStroke[] {
  const strands = helixStrands({ ...ctx, params: { ...ctx.params, helixTurns: 1.6, shellTwist: 0 } }).map(flatStrand);
  // The kit spaces its laminations by how the unbent strand looks to the camera it is given: a stand-in that sees
  // the whole strand large, so every lamination and rib comes through, and the road thins them by its own width.
  const hx = PAGE.width / 2 / 80, hy = PAGE.height / 2 / 80;
  const sight = new THREE.OrthographicCamera(-hx, hx, hy, -hy, 0.1, 100);
  const lift = n(ctx, 'pathLift', 0.05, 0, 1) * plan.half;
  const tilt = n(ctx, 'pathTwistLift', 0.35, 0, 1);
  // Off tabloid the road is filled at the pen floor: at the print's 0.75 mm a road a few millimetres wide keeps a handful
  // of laminations and reads as a bundle of lines, where the print's reads as one dense ribbon.
  const minGap = FORMAT.tabloid ? tolerance(n(ctx, 'pathLamination', 0.75, 0.4, 2)) : MIN_SPACING;
  const ribGap = n(ctx, 'pathRibGap', 6, 0.5, 12);
  // The kit's laminations across the strand at tabloid (a small card's fill counts its own).
  const contours = Math.max(6, Math.round(2 * 1.05 * 0.95 / 0.09));
  const uOf = (t: number) => plan.u0 + t * (1 - plan.u0);
  const world = (u: number, s: number): THREE.Vector3 => {
    const phi = plan.turn(u);
    const c = plan.centre(u), a = plan.across(u);
    const up = lift + plan.half * tilt * (Math.abs(Math.sin(phi)) + s * Math.sin(phi));
    return c.addScaledVector(a, plan.half * Math.cos(phi) * s).setY(up);
  };
  // The road's width on the sheet at u, square to its run, with its turn.
  const widthOnPage = (u: number) => {
    const c = plan.centre(u), a = plan.across(u);
    const p = pageOf(view, c.clone().addScaledVector(a, plan.half)), q = pageOf(view, c.clone().addScaledVector(a, -plan.half));
    return Math.hypot(p.x - q.x, p.y - q.y) * Math.abs(Math.cos(plan.turn(u)));
  };
  // Off tabloid, the width as the ribbon lies (lifted where it turns), square to its run on the sheet: where the road
  // swings across the view its edges at one place along it fall far apart on the sheet but close square to its run, and
  // lines packed by the width the tabloid rule measures close up there. Opened over a stretch of road (its least nearby,
  // then the most of that), so it never overstates the width, and a lamination does not break and resume where the
  // road only briefly widens.
  const lyingWidth = (() => {
    if (FORMAT.tabloid) return () => 0;
    const STEPS = 1200, REACH = 36;
    const at = (i: number) => plan.u0 + (1 - plan.u0) * i / STEPS;
    const raw = Array.from({ length: STEPS + 1 }, (_, i) => {
      const u = at(i);
      const a = pageOf(view, world(u, -1)), b = pageOf(view, world(u, 1));
      const t0 = pageOf(view, world(u - 0.002, 0)), t1 = pageOf(view, world(u + 0.002, 0));
      const tx = t1.x - t0.x, ty = t1.y - t0.y, tl = Math.hypot(tx, ty) || 1;
      return Math.abs(((b.x - a.x) * ty - (b.y - a.y) * tx) / tl);
    });
    const least = raw.map((_, i) => Math.min(...raw.slice(Math.max(0, i - REACH), i + REACH + 1)));
    const opened = least.map((_, i) => Math.max(...least.slice(Math.max(0, i - REACH), i + REACH + 1)));
    return (u: number) => opened[Math.max(0, Math.min(STEPS, Math.round((u - plan.u0) / (1 - plan.u0) * STEPS)))];
  })();
  const out: HelixStroke[] = [];
  for (const st of strands) {
    const mid = strandPoint(st, 0.5, 0);
    sight.position.copy(mid).add(new THREE.Vector3(Math.cos(st.theta0), 0, Math.sin(st.theta0)).multiplyScalar(10));
    sight.lookAt(mid);
    sight.updateProjectionMatrix(); sight.updateMatrixWorld(true);
    // Strand a is the face that lies up first; b is the underside, so its across runs the other way.
    const face = st.id === 'a' ? 1 : -1;
    const up = (u: number) => face * Math.cos(plan.turn(u)) >= 0;
    let lastRib: Point | null = null;
    const strokes = strandStrokes(st, 0, 0, ctx, sight);
    // Off tabloid the laminations fill the ribbon at the pen floor, at even places from the middle to each edge.
    const fill = FORMAT.tabloid ? null
      : dyadicFill(strokes.filter(h => h.role === 'lamination').map(h => strandCoords(st, h.points[0]).v));
    for (const h of strokes) {
      const coords = h.points.map(p => strandCoords(st, p));
      const constantV = Math.abs(coords[0].v - coords[coords.length - 1].v) < 0.01;
      if (!constantV) {
        // A rib or a pulse: one place along the road. Ribs keep their distance on the sheet.
        const u = uOf(coords[0].t);
        if (!up(u)) continue;
        const rib = coords.some(c => c.v > 0);
        if (rib) {
          const here = pageOf(view, plan.centre(u));
          if (lastRib && Math.hypot(here.x - lastRib.x, here.y - lastRib.y) < ribGap) continue;
          lastRib = here;
        }
        out.push({ ...h, points: coords.map(c => world(u, face * c.v)) });
        continue;
      }
      const v = coords[0].v;
      if (fill) {
        // A small card: the edges and the spine always; a lamination where its level keeps the lines the pen floor apart
        // across the ribbon as it lies. The middle lamination stands in for the spine on the underside, which has none.
        const level = h.role === 'lamination' ? fill.level(v) : -1;
        if (level === 0 && face === 1) continue;
        const keep = (u: number) => {
          if (!up(u)) return false;
          if (level <= 0) return true;
          return level < fill.gap.length && fill.gap[level] * lyingWidth(u) / 2 >= minGap;
        };
        let run: THREE.Vector3[] = [];
        const flush = () => { if (run.length > 1) out.push({ ...h, points: run }); run = []; };
        for (const c of coords) {
          const u = uOf(c.t);
          if (!keep(u)) { flush(); continue; }
          run.push(world(u, face * c.v));
        }
        flush();
        continue;
      }
      const edge = Math.abs(Math.abs(v) - 1) < 0.01 || Math.abs(v) < 0.01;
      const j = Math.round((v + 0.975) / 1.95 * contours - 0.5);
      const keep = (u: number) => {
        if (!up(u)) return false;
        if (edge) return true;
        const spacing = widthOnPage(u) * 0.975 / contours;
        let k = 1;
        while (spacing * k < minGap && k < 64) k *= 2;
        return j % k === 0;
      };
      let run: THREE.Vector3[] = [];
      const flush = () => { if (run.length > 1) out.push({ ...h, points: run }); run = []; };
      for (const c of coords) {
        const u = uOf(c.t);
        if (!keep(u)) { flush(); continue; }
        run.push(world(u, face * c.v));
      }
      flush();
    }
  }
  return out;
}
