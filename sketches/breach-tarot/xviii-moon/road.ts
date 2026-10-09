import * as THREE from 'three';
import type { Point, SketchContext } from '../../../src/sketch/types.ts';
import { helixStrands, strandPoint, strandStrokes, type HelixStroke, type Strand } from '../../kit/helix.ts';
import { PAGE, TABLOID_HORIZON_Y, tolerance } from '../../kit/format.ts';
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
/** A strand with no turns of its own (the road does the turning) and its fixed wobble zeroed, so a stroke point gives back where along and across the strand it lies. */
function flatStrand(st: Strand): Strand {
  // The kit lifts each point by 0.3·sin(2θ + 0.3·phase): with no turns θ is fixed, and this θ makes that lift nothing.
  const theta0 = -0.15 * st.phase;
  return { ...st, x: 0, y: 0, z: 0, y0: 0, y1: LEN, turns: 0, theta0, twist: 0, swell: 0, centre: LEN / 2, depth: 1, radius: 1, width: 1.05 };
}

/** Where along (`t`, 0..1) and across (`v`, -1..1 at the ribbon's edges) a strand-space point lies. */
function strandCoords(st: Strand, p: THREE.Vector3): { t: number; v: number } {
  const t = (p.y - st.y - st.y0) / (st.y1 - st.y0);
  const tc = Math.max(0, Math.min(1, t));
  const across = new THREE.Vector3(-Math.sin(st.theta0), 0, Math.cos(st.theta0));
  const c0 = strandPoint(st, tc, 0), e = strandPoint(st, tc, 1).sub(c0);
  return { t, v: p.clone().sub(c0).dot(across) / e.dot(across) };
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
  const minGap = tolerance(n(ctx, 'pathLamination', 0.75, 0.4, 2));
  const ribGap = n(ctx, 'pathRibGap', 6, 0.5, 12);
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
    for (const h of strandStrokes(st, 0, 0, ctx, sight)) {
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
