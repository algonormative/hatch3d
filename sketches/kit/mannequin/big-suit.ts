import * as THREE from 'three';
import { clamp } from '../params.ts';
import { densityPitch } from '../slabs.ts';
import type { Ink } from '../types.ts';
import { squareRef } from './gesture.ts';
import { LOOK, TIER, perpendicular, runs, stride, tierOf, type Look, type ToneEnv } from './hatch.ts';
import { streamerStrokes } from './motion.ts';
import type { Side, Skeleton } from './skeleton.ts';
import { front } from './suit.ts';
import { Tube, silhouettes, type ClothStroke, type ViewEnv } from './tube.ts';

/**
 * The big suit: a suit far too big for the body inside it, the Fool's (after David Byrne's). The jacket
 * is a stiff box hung from the chest, its square shoulders far outside the body's; the sleeves hang
 * from the shoulder corners over the hands; the trousers are wide and pool over the shoes. The body
 * moves inside and the suit goes with it as a block.
 *
 * With `motley` it is cut in harlequin diamonds like a jester's: the stripes turn from lengthwise to
 * round the cloth diamond by diamond, so the pattern reads from any side.
 */
export interface BigSuitOptions {
  /** How far the suit stands off the body: 1 = nearly fitted, 1.6 = the big suit. */
  size?: number;
  /** Squareness of the cloth's sections: 2 = round, higher = boxier. */
  square?: number;
  /** How high the trouser hem rides up over the instep where it breaks on the shoe, world units at canon height. */
  instep?: number;
  /**
   * The body's legs, when the shoes are drawn: the hem is then fitted to them, lying on each shoe
   * where it passes under, so cloth and shoe never cut into each other.
   */
  feet?: Tube[];
}

export interface BigSuit {
  jacket: Tube;
  sleeves: Tube[];
  trousers: Tube[];
  /** The tie's knot at the collar, and the jacket's frame (x the figure's left, y up, z front). */
  knot: THREE.Vector3;
  frame: { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 };
  /** The figure's height scale, world units per canon unit. */
  k: number;
}

/**
 * A trouser leg whose hem breaks over the shoe: the cloth ends at `hem(v)` along the leg, higher in
 * front where it rests on the instep and longer behind. Past the hem the surface folds onto the hem
 * line, so the depth pass, the outline and the stripes all stop there.
 */
export class BreakTube extends Tube {
  hem: (v: number) => number = () => 1;
  override point(u: number, v: number, lift = 0): THREE.Vector3 { return super.point(Math.min(u, this.hem(v)), v, lift); }
  override normal(u: number, v: number): THREE.Vector3 { return super.normal(Math.min(u, this.hem(v) - 1e-3), v); }
}
const hemOf = (t: Tube) => (t instanceof BreakTube ? t.hem : () => 1);

/**
 * The shoe as a cloud of surface points: the foot end of the body's leg tube, from just behind the
 * ankle on toward the toe and low down, so the shin inside the trouser is never taken for it.
 */
export function shoeOf(foot: Tube, ankle: THREE.Vector3, toward: THREE.Vector3, k: number): THREE.Vector3[] {
  const shoe: THREE.Vector3[] = [];
  for (let i = 0; i <= 400; i++) for (let j = 0; j < 24; j++) {
    const p = foot.point(i / 400, j / 24);
    if (p.clone().sub(ankle).dot(toward) > -0.3 * k && p.y < ankle.y + 0.6 * k) shoe.push(p);
  }
  return shoe;
}

/**
 * A hem that lies on the shoe: round the leg, wherever the floor-level hem would sit inside the shoe,
 * raise it to just above the shoe's upper surface, then ease the rise round the leg so the cloth
 * drapes rather than notches.
 */
function drapeOver(leg: Tube, shoe: THREE.Vector3[], gap: number): (v: number) => number {
  const N = 96;
  const reach = 0.35;
  const top = (p: THREE.Vector3) => {
    let y = -Infinity;
    for (const q of shoe) if (Math.hypot(q.x - p.x, q.z - p.z) < reach) y = Math.max(y, q.y);
    return y;
  };
  const length = leg.length;
  const raw = Array.from({ length: N }, (_, i) => {
    const p = leg.point(1, i / N);
    return Math.max(0, top(p) + gap - p.y) / length;
  });
  // Ease the rise round the leg: a wide soft bump that never dips below what clearance needs.
  const soft = raw.map((_, i) => {
    let m = 0;
    for (let d = -10; d <= 10; d++) m = Math.max(m, raw[(i + d + N) % N] * Math.cos((d / 11) * Math.PI / 2) ** 2);
    return m;
  });
  const eased = soft.map((_, i) => {
    let sum = 0, w = 0;
    for (let d = -4; d <= 4; d++) { const k = 5 - Math.abs(d); sum += soft[(i + d + N) % N] * k; w += k; }
    return Math.max(raw[i], sum / w);
  });
  return v => {
    const x = ((v % 1) + 1) % 1 * N, i = Math.floor(x) % N, f = x - Math.floor(x);
    return 1 - Math.min(0.4, eased[i] * (1 - f) + eased[(i + 1) % N] * f);
  };
}

/** Jacket front, in jacket coordinates (u up from the hem, v round it, 0.25 = front). */
const BUTTON = 0.5, COLLAR = 0.88;
/** The hem's drop below the collar top, as a fraction of height, and the shoulder line's u. */
const HEM_DROP = 0.42, SHOULDER = 1 - 0.045 / HEM_DROP;
const opening = (u: number) => (u < BUTTON || u > 0.97 ? 0 : 0.075 * clamp((u - BUTTON) / (COLLAR - BUTTON), 0, 1));
const lapel = (u: number) => (u < BUTTON || u > COLLAR ? 0 : 0.05 * (u - BUTTON) / (COLLAR - BUTTON));

export function bigSuit(s: Skeleton, o: BigSuitOptions = {}): BigSuit {
  const H = s.height, k = H / 24, size = o.size ?? 1.6, sq = o.square ?? 4;
  const grow = (a: number, rate: number) => a * (1 + rate * (size - 1)) * k;
  const f = s.axes('chest');
  const top = s.at('neck').addScaledVector(f.y, 0.05 * H);
  const down = (d: number) => top.clone().addScaledVector(f.y, -d * H);
  const shoulder = grow(2.95, 1.6), hem = grow(2.4, 1.3), depth = grow(1.45, 0.8), trouser = grow(1.3, 0.9);
  // Hip length: a straight drop from the hem, out to the square shoulder line, then a flat top in to
  // the collar. Below the waist it rides on the legs: the hem follows the thighs front to back and
  // deepens to clear the leading one.
  const hemAt = down(HEM_DROP);
  const thighs = (['l', 'r'] as Side[]).map(side => {
    const a = s.at(`hip_${side}`), b = s.at(`knee_${side}`);
    return a.clone().lerp(b, clamp((a.y - hemAt.y) / Math.max(1e-6, a.y - b.y), 0, 1)).sub(hemAt).dot(f.z);
  });
  const lead = (thighs[0] + thighs[1]) / 2, spread = Math.abs(thighs[0] - thighs[1]) / 2;
  const at = (d: number) => down(d).addScaledVector(f.z, lead * clamp((d - 0.2) / (HEM_DROP - 0.2), 0, 1) ** 2);
  const hemDepth = Math.max(depth, spread + trouser * 1.05);
  const u = (d: number) => 1 - d / HEM_DROP;
  const jacket = new Tube('jacket', [at(HEM_DROP), at(0.28), down(0.12), down(0.045), down(0.025), top], [
    [0, hem, hemDepth], [u(0.28), hem * 0.93, Math.max(depth * 0.97, hemDepth * 0.8)], [u(0.12), shoulder * 0.92, depth * 0.95], [SHOULDER, shoulder, depth * 0.92],
    [u(0.025), 0.8 * k, 0.74 * k], [1, 0.66 * k, 0.64 * k],
  ], f.z, 1, [0, 0], (uu, v) => !(front(v) < opening(uu)), 0, sq);
  const sleeves: Tube[] = [], trousers: Tube[] = [];
  for (const side of ['l', 'r'] as Side[]) {
    const h: 1 | -1 = side === 'l' ? 1 : -1;
    // The sleeve hangs from the shoulder corner, past the elbow, and swallows the hand.
    const r = grow(1.0, 1.1);
    const corner = down(0.065).addScaledVector(f.x, h * (shoulder - r));
    const w = s.joints.get(`wrist_${side}`)!;
    const chain = [corner, s.at(`elbow_${side}`), w.end.clone().addScaledVector(w.end.clone().sub(w.origin).normalize(), 0.2 * k)];
    sleeves.push(new Tube(`sleeve_${side}`, chain, [[0, r * 1.12, r * 1.12], [0.5, r, r], [1, r * 0.96, r * 0.96]],
      squareRef(chain, [s.axes(`shoulder_${side}`).z, s.axes(`shoulder_${side}`).x]), h, [r * 0.9, 0], undefined, 0, 3));
    // The trouser leg from the seat to the floor, pooling over the shoe.
    const t = trouser;
    const ankle = s.at(`ankle_${side}`), toe = s.at(`ankle_${side}`, true);
    const floor = ankle.clone().setY(Math.max(0.03 * k, ankle.y - 1.0 * k));
    // The trouser's top sits up inside the jacket, so its rounded end never lets the thigh show.
    const legChain = [s.at(`hip_${side}`).addScaledVector(s.axes('pelvis').y, 0.08 * H), s.at(`knee_${side}`), floor];
    const leg = new BreakTube(`trouser_${side}`, legChain, [[0, t * 1.05, t * 1.05], [0.5, t, t], [1, t * 1.08, t * 1.08]],
      squareRef(legChain, [s.axes(`hip_${side}`).x, s.axes(`hip_${side}`).z]), h, [t * 0.5, 0], undefined, 0, 2.6);
    // The break: find the side of the hem the foot leaves by, and lift the hem there onto the instep.
    const toward = toe.clone().sub(ankle).setY(0).normalize();
    let vFront = 0, best = -Infinity;
    for (let i = 0; i < 72; i++) {
      const d = leg.point(1, i / 72).sub(leg.centre(1)).setY(0).normalize().dot(toward);
      if (d > best) { best = d; vFront = i / 72; }
    }
    // Fitted to the shoe when the shoes are drawn (measured from the plain floor-level hem), otherwise
    // a fixed rise onto the instep.
    const foot = o.feet?.find(t => t.id === `leg_${side}`);
    const lift = Math.min(0.3, (o.instep ?? 1.9) * k / leg.length);
    leg.hem = foot ? drapeOver(leg, shoeOf(foot, ankle, toward, k), 0.12 * k)
      : v => 1 - lift * (0.5 + 0.5 * Math.cos(2 * Math.PI * (v - vFront))) ** 2;
    trousers.push(leg);
  }
  return { jacket, sleeves, trousers, knot: down(0.04).addScaledVector(f.z, 0.72 * k), frame: f, k };
}

/** The suit's closed surfaces, for the depth pass. */
export function bigSuitMeshes(suit: BigSuit, detail = 0.8): THREE.BufferGeometry[] {
  return [suit.jacket, ...suit.sleeves, ...suit.trousers].map(t => t.mesh(Math.round(160 * detail), Math.round(72 * detail)));
}

type Grain = 'along' | 'around';

/** Harlequin diamonds over a tube, about `cell` world units across and half again as tall: whether (u, v) is in an even one. */
function harlequin(t: Tube, cell: number): (u: number, v: number) => boolean {
  const round = Math.max(2, 2 * Math.round(t.circ / cell / 2));
  const tall = t.length / (cell * 1.5);
  return (u, v) => {
    const a = u * tall, b = (((v % 1) + 1) % 1) * round;
    return (Math.floor(a + b) + Math.floor(a - b)) % 2 === 0;
  };
}

/** Stripes in one grain over the cloth where `region` holds, as dense as the tone asks, tier by tier. */
function stripes(t: Tube, env: ToneEnv, look: Look, grain: Grain, region: (u: number, v: number) => boolean, out: ClothStroke[]) {
  const pitch = densityPitch(env.density, 0.56, 0.38, 0.29);
  const hem = hemOf(t);
  const cloth = (u: number, v: number) => u <= hem(v) && region(u, v) && (!t.mask || t.mask(u, ((v % 1) + 1) % 1));
  if (grain === 'along') {
    const N = Math.max(8, Math.round(t.circ / pitch)) * 4;
    const samples = Math.max(80, Math.round(t.length / 0.07));
    for (let j = 0; j < N; j++) {
      const v = j / N, tier = tierOf(j);
      const pts: THREE.Vector3[] = [], keep: boolean[] = [];
      for (let i = 0; i <= samples; i++) {
        const u = i / samples, p = t.point(u, v);
        pts.push(p);
        if (!cloth(u, v)) { keep.push(false); continue; }
        const s = stride(perpendicular(env, p, t.point(u + 1 / samples, v), t.point(u, v + 1 / N)));
        keep.push(j % s === 0 && env.dark(p, t.normal(u, v)) > TIER[tier]);
      }
      runs(pts, keep, j % 16 === 0 ? look.accent : look.cloth, look.figure, out, look.family);
    }
  } else {
    const R = Math.max(8, Math.round(t.length / pitch)) * 4;
    const around = Math.max(120, Math.round(t.circ / 0.06));
    for (let i = 0; i < R; i++) {
      const u = (i + 0.5) / R, tier = tierOf(i);
      const pts: THREE.Vector3[] = [], keep: boolean[] = [];
      for (let q = 0; q <= around; q++) {
        const v = q / around, p = t.point(u, v);
        pts.push(p);
        if (!cloth(u, v)) { keep.push(false); continue; }
        const s = stride(perpendicular(env, p, t.point(u, v + 1 / around), t.point(u + 1 / R, v)));
        keep.push(i % s === 0 && env.dark(p, t.normal(u, v)) > TIER[tier]);
      }
      runs(pts, keep, i % 16 === 0 ? look.accent : look.cloth, look.figure, out, look.family);
    }
  }
}

export interface BigSuitLook {
  /** Quarter the stripes like a jester's. */
  motley?: boolean;
  /** A tie blown back over the shoulder by this wind (world direction), or none. */
  wind?: THREE.Vector3 | null;
  /** Which shoulder the tie blows over: 1 the figure's left, −1 its right. */
  over?: 1 | -1;
}

/** Draw the big suit: stripes, edges and hems, buttons, the open front, and the tie in the wind. */
export function bigSuitStrokes(suit: BigSuit, env: ToneEnv & ViewEnv, look: Look = LOOK, o: BigSuitLook = {}): ClothStroke[] {
  const out: ClothStroke[] = [];
  const { jacket, k } = suit;
  const all = () => true;
  const fam = look.family;
  const curve = (pts: THREE.Vector3[], ink: Ink, group: string) => out.push(fam ? { ink, group, family: fam, points: pts } : { ink, group, points: pts });
  const along = (t: Tube, v: (u: number) => number, u0: number, u1: number, ink: Ink, group: string, lift = 0.012) =>
    curve(Array.from({ length: 81 }, (_, i) => { const u = u0 + (u1 - u0) * i / 80; return t.point(u, v(u), lift); }), ink, group);
  const ring = (t: Tube, u: (v: number) => number, ink: Ink, lift = 0.012, show: (v: number) => boolean = () => true) => {
    const n = Math.max(120, Math.round(t.circ / 0.05));
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let q = 0; q <= n; q++) { const v = q / n; pts.push(t.point(u(v), v, lift)); keep.push(show(v)); }
    runs(pts, keep, ink, look.contour, out, fam);
  };
  // Cloth: pinstripes, or harlequin diamonds whose stripes turn from one diamond to the next.
  for (const t of [jacket, ...suit.sleeves, ...suit.trousers]) {
    if (o.motley) {
      const even = harlequin(t, 3.2 * k);
      stripes(t, env, look, 'along', even, out);
      stripes(t, env, look, 'around', (u, v) => !even(u, v), out);
    } else stripes(t, env, look, 'along', all, out);
  }
  for (const t of [jacket, ...suit.sleeves, ...suit.trousers]) out.push(...silhouettes(t, env, { ink: look.edge, group: look.contour, family: fam }));
  // Jacket: hem, the closing line below the button, the open front with its lapels, the shoulder edge, the collar, the back seam.
  ring(jacket, () => 0.004, look.edge);
  along(jacket, () => 0.25, 0, BUTTON, look.edge, look.contour);
  along(jacket, () => 0.75, 0, 0.93, look.crease, look.figure);
  for (const side of [-1, 1]) {
    along(jacket, u => 0.25 + side * opening(u), BUTTON, 0.97, look.edge, look.contour);
    along(jacket, u => 0.25 + side * (opening(u) + lapel(u)), BUTTON, COLLAR, look.edge, look.contour);
    curve([jacket.point(COLLAR, 0.25 + side * (opening(COLLAR) + lapel(COLLAR)), 0.012), jacket.point(COLLAR + 0.02, 0.25 + side * opening(COLLAR + 0.02), 0.012)], look.edge, look.contour);
  }
  ring(jacket, () => SHOULDER, look.crease, 0.01, v => front(v) > 0.09);
  ring(jacket, () => 1 - 0.025 / HEM_DROP, look.crease, 0.01);
  ring(jacket, () => 0.998, look.edge, 0.01);
  // Two buttons, too big.
  for (const u of [BUTTON - 0.03, BUTTON - 0.2]) {
    const c = jacket.point(u, 0.25, 0.03), nrm = jacket.normal(u, 0.25);
    const a = new THREE.Vector3().crossVectors(nrm, suit.frame.y).normalize(), b = new THREE.Vector3().crossVectors(nrm, a);
    curve(Array.from({ length: 25 }, (_, i) => c.clone().addScaledVector(a, 0.42 * k * Math.cos(i / 24 * Math.PI * 2)).addScaledVector(b, 0.42 * k * Math.sin(i / 24 * Math.PI * 2))), look.crease, look.figure);
  }
  // Cuffs, and trouser hems with the cloth piled up above them in a concertina.
  for (const t of suit.sleeves) { ring(t, () => 0.995, look.edge); ring(t, () => 0.93, look.crease); }
  for (const t of suit.trousers) {
    // The hem follows the break; the folds above it follow the hem.
    const hem = hemOf(t);
    ring(t, v => hem(v) - 0.003, look.edge);
    for (const [u, amp] of [[0.08, 0.012], [0.15, 0.01], [0.21, 0.007]]) ring(t, v => hem(v) - u + amp * Math.sin(v * Math.PI * 2 * 7), look.crease);
  }
  // The tie, blown back over the shoulder: free end first, so it narrows into the knot.
  if (o.wind) {
    const f = suit.frame, w = o.wind.clone().normalize();
    const p0 = suit.knot, p1 = p0.clone().addScaledVector(f.z, 1.2 * k).addScaledVector(f.y, -0.9 * k);
    const p2 = p0.clone().addScaledVector(w, 3.2 * k).addScaledVector(f.y, 0.6 * k).addScaledVector(f.x, (o.over ?? 0.3) * 3.4 * k);
    const path = Array.from({ length: 40 }, (_, i) => {
      const t = 1 - i / 39;
      const flutter = 0.35 * k * t * Math.sin(t * 9);
      return p0.clone().multiplyScalar((1 - t) ** 2).addScaledVector(p1, 2 * t * (1 - t)).addScaledVector(p2, t * t).addScaledVector(f.x, flutter);
    });
    out.push(...streamerStrokes(path, env, { width: 1.0 * k, turns: 1.2, rungs: 6 }, look));
  }
  return out;
}
