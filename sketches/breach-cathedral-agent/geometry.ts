import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../src/occlusion.ts';
import { TABLOID_PAGE, TALL_ART, posterArtTransform } from '../phase-garden/poster.ts';
import { clipArt, densityPitch, simplify, slabGeometry, slabMatrix, slabStrokes, solid, type Ink, type Role, type Slab } from '../breach-cathedral-tower/geometry.ts';
import { clearBands, knockOut, planSlogans, sloganSettings, type SloganSurface } from '../breach-cathedral-tower/slogan.ts';

/**
 * Breach Cathedral: Agent. The living force from Breach Cathedral has put on the system's suit:
 * a seated figure wound from the helix membrane, enthroned on the slab architecture, its head the
 * twin helix unwinding. Value is lit from the head, so the force shows itself as light.
 */
export type Group = 'system' | 'throne' | 'rays' | 'figure' | 'force' | 'contour' | 'slogan' | 'title';
type Stroke = { ink: Ink; group: Group; points: THREE.Vector3[]; owner?: number };

const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const GROUPS: Group[] = ['system', 'throne', 'rays', 'figure', 'force', 'contour', 'slogan', 'title'];
// Depth pixels: two per page millimetre, as in the Tower.
const W = 559, H = 864;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const HALF_H = 13.0;
const HALF_W = HALF_H * TABLOID_PAGE.width / TABLOID_PAGE.height;
const MM_PER_UNIT = TABLOID_PAGE.height / (2 * HALF_H);
const MIN_MM = 0.55;
const TAU = Math.PI * 2;

function n(ctx: SketchContext, key: string, fallback: number, lo: number, hi: number): number {
  const v = ctx.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function camera(ctx: SketchContext): THREE.OrthographicCamera {
  // From the right and below: the agent turns to the viewer's upper left and towers over the eye.
  const turn = n(ctx, 'turn', 26, -40, 40) * Math.PI / 180;
  const tilt = n(ctx, 'tilt', -7, -16, 24) * Math.PI / 180;
  const view = new THREE.OrthographicCamera(-HALF_W, HALF_W, HALF_H, -HALF_H, 0.1, 80);
  const target = V(0, 0.2, 0.6);
  view.up.set(0, 1, 0);
  view.position.copy(target).add(V(Math.sin(turn) * Math.cos(tilt), Math.sin(tilt), Math.cos(turn) * Math.cos(tilt)).multiplyScalar(24));
  view.lookAt(target);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
}

// ---------------------------------------------------------------- the figure

type Key = [u: number, rx: number, ry: number];

/**
 * A limb or trunk: a spine curve with sections sampled into a lookup table. Sections are ellipses,
 * or, with `facets`, polygons inscribed in them, so the body is cut into planes like the slabs.
 */
class Tube {
  readonly length: number;
  readonly circ: number;
  private readonly table: { c: THREE.Vector3; n: THREE.Vector3; b: THREE.Vector3; rx: number; ry: number }[];
  constructor(readonly id: string, spine: THREE.Vector3[], keys: Key[], ref: THREE.Vector3,
    readonly hand: 1 | -1, readonly caps: [number, number] = [0, 0], readonly mask?: (u: number, v: number) => boolean,
    readonly facets = 0) {
    const curve = new THREE.CatmullRomCurve3(spine, false, 'centripetal');
    this.length = curve.getLength();
    const M = 480;
    this.table = [];
    let circ = 0;
    for (let i = 0; i <= M; i++) {
      const u = i / M;
      const c = curve.getPointAt(u), t = curve.getTangentAt(u);
      const nn = new THREE.Vector3().crossVectors(t, ref).normalize();
      const b = new THREE.Vector3().crossVectors(nn, t).normalize();
      let k = 0;
      while (k < keys.length - 2 && keys[k + 1][0] < u) k++;
      const [u0, rx0, ry0] = keys[k], [u1, rx1, ry1] = keys[k + 1];
      const f = smooth(u0, u1, u);
      // Round caps: a dome of the end radius over the last stretch of spine.
      const s = u * this.length, e = this.length - s;
      let cap = 1;
      if (caps[0] > 0 && s < caps[0]) cap = Math.sqrt(Math.max(0, 1 - ((caps[0] - s) / caps[0]) ** 2));
      if (caps[1] > 0 && e < caps[1]) cap = Math.min(cap, Math.sqrt(Math.max(0, 1 - ((caps[1] - e) / caps[1]) ** 2)));
      const rx = (rx0 + (rx1 - rx0) * f) * cap, ry = (ry0 + (ry1 - ry0) * f) * cap;
      circ = Math.max(circ, Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry))));
      this.table.push({ c, n: nn, b, rx, ry });
    }
    this.circ = circ;
  }
  point(u: number, v: number, lift = 0): THREE.Vector3 {
    const x = clamp(u, 0, 1) * (this.table.length - 1);
    const i = Math.min(this.table.length - 2, Math.floor(x)), f = x - i;
    const a = this.table[i], b = this.table[i + 1];
    const rx = a.rx + (b.rx - a.rx) * f + lift, ry = a.ry + (b.ry - a.ry) * f + lift;
    const c = a.c.clone().lerp(b.c, f);
    const nn = a.n.clone().lerp(b.n, f), bb = a.b.clone().lerp(b.b, f);
    const angle = TAU * v;
    let k = 1;
    if (this.facets >= 3) {
      const seg = TAU / this.facets;
      const local = ((angle % seg) + seg) % seg - seg / 2;
      k = Math.cos(seg / 2) / Math.cos(local);
    }
    return c.addScaledVector(nn, rx * k * Math.cos(angle)).addScaledVector(bb, ry * k * Math.sin(angle));
  }
  centre(u: number): THREE.Vector3 {
    const x = clamp(u, 0, 1) * (this.table.length - 1);
    const i = Math.min(this.table.length - 2, Math.floor(x));
    return this.table[i].c.clone().lerp(this.table[i + 1].c, x - i);
  }
  normal(u: number, v: number): THREE.Vector3 {
    const e = 1e-3;
    // Keep the v difference inside one facet so a plane gets its own normal, not an edge average.
    let v0 = v - e, v1 = v + e;
    if (this.facets >= 3) {
      const k = Math.floor(v * this.facets);
      v0 = Math.max(v0, k / this.facets + 1e-5); v1 = Math.min(v1, (k + 1) / this.facets - 1e-5);
    }
    const pu = this.point(Math.min(1, u + e), v).sub(this.point(Math.max(0, u - e), v));
    const pv = this.point(u, v1).sub(this.point(u, v0));
    const out = new THREE.Vector3().crossVectors(pu, pv);
    if (out.lengthSq() < 1e-14) return this.point(u, v).sub(this.centre(u)).normalize();
    out.normalize();
    if (out.dot(this.point(u, v).sub(this.centre(u))) < 0) out.negate();
    return out;
  }
  mesh(): THREE.BufferGeometry {
    return buildSurfaceMesh((u, v) => this.point(u, v), {}, 200, this.facets >= 3 ? this.facets * 6 : 56);
  }
}

/** Suit front on the trunk, in trunk coordinates (u up the spine, v round it, 0.25 = front). */
const BUTTON = 0.4, COLLAR = 0.83;
function opening(u: number): number { return u < BUTTON || u > COLLAR + 0.04 ? 0 : 0.085 * clamp((u - BUTTON) / (COLLAR - BUTTON), 0, 1); }
function lapel(u: number): number { return u < BUTTON - 0.02 || u > COLLAR ? 0 : 0.034 + 0.026 * clamp((u - BUTTON) / (COLLAR - BUTTON), 0, 1); }
const front = (v: number) => Math.abs(((v - 0.25) % 1 + 1.5) % 1 - 0.5);

/** Where the head looks: `face` is the gaze, `axis` the crown, both world unit vectors. */
export type Gaze = { face: THREE.Vector3; axis: THREE.Vector3; side: THREE.Vector3 };
export type Legs = 'apart' | 'together' | 'crossed';
export type Pose = { tubes: Tube[]; slabs: Slab[]; head: THREE.Vector3; trunk: Tube; neck: THREE.Vector3; gaze: Gaze; legs: Legs };

/** The seated agent: trunk, limbs, block hands and shoes, all in world units (page ≈ 26 tall). */
function figure(ctx: SketchContext): Pose {
  const rng = ctx.random('agent-pose');
  const facets = Math.round(n(ctx, 'facets', 6, 0, 16));
  const cut = facets >= 3 ? facets : 0;
  const spread = n(ctx, 'stance', 0.5, 0, 1);
  const legRoll = rng();
  const picked = typeof ctx.params.legs === 'string' && ['apart', 'together', 'crossed'].includes(ctx.params.legs) ? ctx.params.legs as Legs | 'seed' : 'seed';
  const legs: Legs = picked !== 'seed' ? picked : legRoll < 0.4 ? 'apart' : legRoll < 0.65 ? 'together' : 'crossed';
  const crossing: 1 | -1 = rng() < 0.5 ? 1 : -1;
  // The gaze: up and toward the figure's right, which this camera puts at the viewer's upper left.
  const yaw = (n(ctx, 'gazeTurn', 48, 0, 80) + (rng() - 0.5) * 20) * Math.PI / 180;
  const pitch = (n(ctx, 'gazeLift', 24, 0, 60) + (rng() - 0.5) * 14) * Math.PI / 180;
  const level = V(-Math.sin(yaw), 0, Math.cos(yaw));
  const face = level.clone().multiplyScalar(Math.cos(pitch)).add(V(0, Math.sin(pitch), 0)).normalize();
  const axis = V(0, Math.cos(pitch), 0).addScaledVector(level, -Math.sin(pitch)).normalize();
  const gaze: Gaze = { face, axis, side: new THREE.Vector3().crossVectors(axis, face).normalize() };
  // A slight recline and a turn of the shoulders toward the gaze.
  const twist = -0.35 * Math.sin(yaw);
  const sh = (y: number) => y > 0 ? twist * y / 6 : 0;
  const spineAt = (y: number, z: number) => V(sh(y) * 0.6, y, z - 0.06 * Math.max(0, y));
  const kx = legs === 'together' ? 1.35 : 1.55 + 0.9 * spread;
  const trunk = new Tube('trunk', [spineAt(-2.7, -0.55), spineAt(-0.8, -0.72), spineAt(2.2, -0.82), spineAt(4.3, -0.86), spineAt(5.4, -0.82), spineAt(6.15, -0.76)],
    [[0, 2.2, 1.5], [0.2, 2.0, 1.36], [0.5, 2.65, 1.52], [0.74, 3.25, 1.36], [0.82, 2.7, 1.16], [0.885, 1.2, 0.95], [0.92, 0.74, 0.72], [1, 0.68, 0.66]],
    V(0, 0, 1), 1, [1.1, 0],
    (u, v) => {
      if (u > 0.9) return false; // the collar and neck belong to the shirt
      const o = front(v);
      return !(u >= BUTTON - 0.02 && u <= COLLAR + 0.04 && o < opening(u) + lapel(u));
    }, cut);
  const tubes: Tube[] = [trunk];
  const slabs: Slab[] = [];
  const block = (x: number, y: number, z: number, w: number, h: number, d: number, rx = 0, ry = 0, rz = 0, role: Role = 'stub') =>
    slabs.push({ ...solid(x, y, z, w, h, d, 40 + slabs.length, role), rx, ry, rz });
  /** A shoe: a thin sole slab under a blunt upper, turned about x so it can dangle. */
  const shoe = (x: number, y: number, z: number, ry: number, tip = 0) => {
    const c = Math.cos(tip), s = Math.sin(tip);
    block(x, y, z, 1.34, 0.72, 2.5, tip, ry, 0);
    block(x, y - 0.46 * c, z - 0.46 * s + 0.08, 1.44, 0.2, 2.72, tip, ry, 0);
  };
  for (const side of [-1, 1] as const) {
    const hip = V(side * 1.55, -2.65, -0.25);
    let knee = V(side * kx, -2.05 + 0.25 * rng(), 5.05);
    let ankle = V(side * (kx + 0.05), -8.95, 4.6 + 0.4 * rng());
    let planted = true;
    if (legs === 'crossed' && side === crossing) {
      // The crossing thigh rests over the other knee; its shin hangs outside it, the shoe off the floor.
      knee = V(-side * 0.7, -0.7, 5.25);
      ankle = V(-side * 2.75, -7.0, 6.0);
      planted = false;
    }
    tubes.push(new Tube(`thigh${side}`, [hip, hip.clone().lerp(knee, 0.5).add(V(0, 0.18, 0)), knee],
      [[0, 1.55, 1.42], [0.45, 1.4, 1.26], [1, 1.04, 1.0]], V(0, 1, 0), side === 1 ? 1 : -1, [0, 1.02], undefined, cut));
    tubes.push(new Tube(`shin${side}`, [knee.clone().add(V(0, 0.1, -0.15)), knee.clone().lerp(ankle, 0.45).add(V(0, 0, 0.25)), ankle],
      [[0, 1.02, 1.0], [0.3, 0.94, 0.96], [1, 0.62, 0.66]], V(0, 0, 1), side === 1 ? -1 : 1, [0.97, 0], undefined, cut));
    if (planted) shoe(ankle.x, -9.6, ankle.z + 0.45, side * 0.08);
    else shoe(ankle.x, ankle.y - 0.55, ankle.z + 0.55, side * 0.15, 0.55);
    const shoulder = V(side * 2.95 + sh(4) * 0.6, 3.95, -0.92), elbow = V(side * 4.12, 0.35, -0.98);
    const wrist = V(side * 4.42, -0.12, 3.05);
    tubes.push(new Tube(`upper${side}`, [shoulder, shoulder.clone().lerp(elbow, 0.5).add(V(side * 0.14, 0, 0)), elbow],
      [[0, 1.08, 1.0], [0.5, 0.94, 0.9], [1, 0.82, 0.8]], V(0, 0, 1), side === 1 ? 1 : -1, [0.95, 0.8], undefined, cut));
    tubes.push(new Tube(`fore${side}`, [elbow.clone().add(V(0, -0.1, 0.05)), elbow.clone().lerp(wrist, 0.5).add(V(0, 0.08, 0)), wrist],
      [[0, 0.8, 0.78], [0.6, 0.72, 0.68], [1, 0.62, 0.57]], V(0, 1, 0), side === 1 ? -1 : 1, [0.78, 0], undefined, cut));
    // Hands: a broad palm and four three-knuckled fingers. Resting fingers drape over the
    // armrest end; a clutching hand wraps them back under it.
    const clutch = rng() < 0.45;
    const wx = side * 4.46;
    block(wx, -0.3, 3.62, 1.42, 0.5, 1.3, 0.06, 0, 0);
    block(wx + side * 0.04, -0.12, 3.45, 1.2, 0.18, 0.9, 0.06, 0, 0);
    for (let f = 0; f < 4; f++) {
      const x = wx + side * (-0.53 + 0.355 * f);
      const reach = f === 0 || f === 3 ? 0.9 : 1;
      const droop = 0.12 * rng();
      const joints = clutch
        ? [V(x, -0.28, 4.18), V(x, -0.3, 4.62 - 0.1 * (1 - reach)), V(x, -0.95, 4.82), V(x, -1.5 - droop, 4.38)]
        : [V(x, -0.28, 4.18), V(x, -0.36, 4.68 + 0.06 * (f % 2)), V(x, -0.95 - 0.08 * (f === 1 || f === 2 ? 1 : 0), 4.82), V(x, -1.5 - droop, 4.7)];
      const width = f === 3 ? 0.27 : 0.31;
      for (let j = 0; j < 3; j++) {
        const a = joints[j], b = joints[j + 1], d = b.clone().sub(a);
        const c = a.clone().lerp(b, 0.5);
        // Local y along the segment, which lies in the y–z plane; each knuckle a touch narrower.
        block(c.x, c.y, c.z, width * (1 - 0.08 * j), d.length() + 0.06, 0.33 * (1 - 0.08 * j), Math.atan2(d.z, d.y), 0, 0);
      }
    }
    // Thumb along the inner face of the armrest.
    const tx = side * 3.82;
    block(tx, -0.6, 3.8, 0.27, 0.72, 0.3, -0.9, 0, 0);
    block(tx, -0.95, 4.28, 0.25, 0.58, 0.27, clutch ? -2.2 : -1.9, 0, 0);
  }
  const neck = trunk.centre(0.96);
  const head = neck.clone().addScaledVector(axis, 1.15).addScaledVector(face, 0.35);
  return { tubes, slabs, head, trunk, neck, gaze, legs };
}

// ---------------------------------------------------------------- light and screen

interface Env {
  view: THREE.Camera;
  forward: THREE.Vector3;
  screen: (p: THREE.Vector3) => { x: number; y: number };
  dark: (p: THREE.Vector3, normal: THREE.Vector3) => number;
  density: number;
}

/** Seeded smooth value noise for the impressionist breakup of the tone field. */
function valueNoise(rng: () => number): (p: THREE.Vector3) => number {
  const table = Array.from({ length: 512 }, () => rng());
  const h = (i: number, j: number, k: number) => table[(((i * 73856093) ^ (j * 19349663) ^ (k * 83492791)) >>> 0) % 512];
  return (p: THREE.Vector3) => {
    const x0 = Math.floor(p.x), y0 = Math.floor(p.y), z0 = Math.floor(p.z);
    const fx = p.x - x0, fy = p.y - y0, fz = p.z - z0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
    let out = 0;
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
      out += h(x0 + a, y0 + b, z0 + c) * (a ? sx : 1 - sx) * (b ? sy : 1 - sy) * (c ? sz : 1 - sz);
    }
    return out;
  };
}

/** Tone field: the head is the light. Close to it the suit blows out to paper; the base stays heavy. */
function toneField(ctx: SketchContext, head: THREE.Vector3): (p: THREE.Vector3, normal: THREE.Vector3) => number {
  const base = 0.58 + 0.42 * n(ctx, 'value', 0.5, 0, 1);
  const reach = 3 + 5 * n(ctx, 'glow', 0.5, 0, 1);
  const impression = 0.75 * n(ctx, 'impression', 0.5, 0, 1);
  const noise = valueNoise(ctx.random('agent-impression'));
  const key = V(0.45, 0.55, 0.7).normalize();
  return (p, normal) => {
    const to = head.clone().sub(p);
    const d = to.length();
    const facing = Math.max(0, normal.dot(to) / d);
    // An aura first, a lamp second: distance from the head sets the value, facing only modulates it.
    const glow = 1.1 * (0.55 + 0.45 * facing) / (1 + (d / reach) ** 2.2);
    const patch = noise(p.clone().multiplyScalar(0.42)) - 0.5;
    return clamp(base - 1.5 * glow - 0.22 * Math.max(0, normal.dot(key)) + impression * patch, 0, 1);
  };
}

/** Smallest power-of-two stride that keeps neighbouring lines at least MIN_MM apart on the sheet. */
function stride(spacing: number): number {
  let k = 1;
  while (spacing * k < MIN_MM && k < 64) k *= 2;
  return k;
}
const TIER = [0.1, 0.42, 0.66];
const tierOf = (j: number) => (j % 4 === 0 ? 0 : j % 2 === 0 ? 1 : 2);

/** Collect contiguous runs of samples that pass `keep` into strokes. */
function runs(points: THREE.Vector3[], keep: boolean[], ink: Ink, group: Group, out: Stroke[]) {
  let run: THREE.Vector3[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) run.push(points[i]);
    else { if (run.length > 1) out.push({ ink, group, points: run }); run = []; }
  }
  if (run.length > 1) out.push({ ink, group, points: run });
}

function perpendicular(env: Env, a: THREE.Vector3, along: THREE.Vector3, beside: THREE.Vector3): number {
  const p = env.screen(a), t = env.screen(along), q = env.screen(beside);
  const tx = t.x - p.x, ty = t.y - p.y, tl = Math.hypot(tx, ty) || 1e-9;
  return Math.abs(((q.x - p.x) * ty - (q.y - p.y) * tx) / tl);
}

/**
 * A tube wound in one continuous ribbon: band coordinate b = u·L/W + hand·v. Laminations follow the
 * ribbon (constant b), ribs cross it (constant v), and a paper gap separates the turns.
 * Fine lines appear only where the tone is dark enough; rests (the 64-step interruptions) open some turns.
 */
function ribbonTube(t: Tube, env: Env, opts: { band: number; gap: number; rests: (k: number) => boolean }): Stroke[] {
  const out: Stroke[] = [];
  const Wb = opts.band, L = t.length, gap = opts.gap;
  const lamPrimary = Math.max(3, Math.round(densityPitch(env.density, 3, 5, 7)));
  const N = lamPrimary * 4;
  const perTurn = Math.max(96, Math.round(t.circ / 0.09));
  const bAt = (u: number, v: number) => u * L / Wb + t.hand * v;
  const turns = L / Wb;
  const visible = (u: number, v: number) => !t.mask || t.mask(u, ((v % 1) + 1) % 1);
  // Laminations and the two ribbon edges.
  for (let j = -1; j <= N; j++) {
    const edge = j === -1 || j === N;
    const f = j === -1 ? 0 : j === N ? 1 - gap : (j + 0.5) / N * (1 - gap);
    const samples = Math.ceil((turns + 2) * perTurn);
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let i = 0; i <= samples; i++) {
      const tau = -1 + (turns + 2) * i / samples; // unwrapped angle, in turns
      const u = (f + tau) * Wb / L;
      const v = t.hand * -tau;
      if (u < 0 || u > 1) { pts.push(V(0, 0, 0)); keep.push(false); continue; }
      const p = t.point(u, v);
      pts.push(p);
      if (!visible(u, v)) { keep.push(false); continue; }
      const k = Math.floor(bAt(u, ((v % 1) + 1) % 1));
      const dark = env.dark(p, t.normal(u, v));
      if (edge) { keep.push(dark > 0.05); continue; }
      const du = (1 - gap) / N * Wb / L;
      const s = stride(perpendicular(env, p, t.point(u + Wb / L / perTurn, v - t.hand / perTurn), t.point(u + du, v)));
      const tier = opts.rests(k) ? Math.max(tierOf(j), 1) : tierOf(j);
      keep.push(j % s === 0 && dark > TIER[tier] + (tier === 0 && opts.rests(k) ? 0.2 : 0));
    }
    runs(pts, keep, edge ? 'vermilion' : 'ultramarine', edge ? 'contour' : 'figure', out);
  }
  // Ribs across each turn of the ribbon.
  const ribPrimary = Math.max(8, Math.round(t.circ / densityPitch(env.density, 0.62, 0.4, 0.3)));
  const R = ribPrimary * 2;
  const kMin = Math.floor(bAt(0, 1)) - 1, kMax = Math.ceil(bAt(1, 0)) + 1;
  for (let k = kMin; k <= kMax; k++) {
    for (let i = 0; i < R; i++) {
      const v = i / R;
      const b0 = k + 0.02, b1 = k + 1 - gap - 0.02;
      const u0 = (b0 - t.hand * v) * Wb / L, u1 = (b1 - t.hand * v) * Wb / L;
      if (u1 < 0 || u0 > 1) continue;
      const mid = clamp((u0 + u1) / 2, 0, 1);
      const p = t.point(mid, v);
      if (!visible(mid, v)) continue;
      const dark = env.dark(p, t.normal(mid, v));
      const s = stride(perpendicular(env, p, t.point(mid + 0.01, v), t.point(mid, v + 1 / R)));
      const tier = i % 2 === 0 ? (i % 4 === 0 ? 0 : 1) : 2;
      if (i % s !== 0 || dark < TIER[tier] + 0.08 || (opts.rests(k) && tier > 0)) continue;
      const pts: THREE.Vector3[] = [], keep: boolean[] = [];
      for (let q = 0; q <= 6; q++) {
        const u = u0 + (u1 - u0) * q / 6;
        const ok = u >= 0 && u <= 1 && visible(u, v);
        pts.push(ok ? t.point(u, v) : V(0, 0, 0));
        keep.push(ok);
      }
      runs(pts, keep, i % 8 === 0 ? 'violet' : 'ultramarine', 'figure', out);
    }
  }
  return out;
}

type Tailoring = { seams: number[]; hems: number[]; creases?: number[]; stop?: number; cuffs?: number[] };

/**
 * Tailored cloth: pinstripes run along each garment piece (constant v), seams and hems in vermilion,
 * pressed creases and facet edges in carbon. Value comes from line density alone: fine stripes join
 * the primaries only where the tone is dark, rings cross them in the deepest shadow, and the domed
 * ends (knees, shoulders, elbows) are hatched with rings instead of converging stripes.
 */
function pinstripeTube(t: Tube, env: Env, opts: Tailoring): Stroke[] {
  const out: Stroke[] = [];
  const primary = Math.max(8, Math.round(t.circ / densityPitch(env.density, 0.56, 0.38, 0.29)));
  const N = primary * 4;
  const samples = Math.max(80, Math.round(t.length / 0.07));
  const lo = 0.35 * t.caps[0] / t.length, hi = Math.min(opts.stop ?? 1, 1 - 0.35 * t.caps[1] / t.length);
  const cloth = (u: number, v: number) => !t.mask || t.mask(u, ((v % 1) + 1) % 1);
  const visible = (u: number, v: number) => u >= lo && u <= hi && cloth(u, v);
  const offset = t.facets >= 3 ? 0.5 / N : 0;
  for (let j = 0; j < N; j++) {
    const v = j / N + offset;
    const tier = tierOf(j);
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let i = 0; i <= samples; i++) {
      const u = i / samples;
      const p = t.point(u, v);
      pts.push(p);
      if (!visible(u, v)) { keep.push(false); continue; }
      const s = stride(perpendicular(env, p, t.point(u + 1 / samples, v), t.point(u, v + 1 / N)));
      keep.push(j % s === 0 && env.dark(p, t.normal(u, v)) > TIER[tier]);
    }
    runs(pts, keep, j % 16 === 0 ? 'violet' : 'ultramarine', 'figure', out);
  }
  // Rings: the only hatch on the domed ends, and a cross-hatch over the stripes in the deepest shadow.
  const R = Math.max(8, Math.round(t.length / 0.34)) * 4;
  const around = Math.max(120, Math.round(t.circ / 0.06));
  for (let i = 0; i < R; i++) {
    const u = (i + 0.5) / R;
    if (u > (opts.stop ?? 1)) continue;
    const tier = tierOf(i);
    const capped = u < lo || u > hi;
    const threshold = capped ? TIER[tier] : tier === 0 ? 0.74 : tier === 1 ? 0.84 : 2;
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let q = 0; q <= around; q++) {
      const v = q / around;
      const p = t.point(u, v);
      pts.push(p);
      if (!cloth(u, v)) { keep.push(false); continue; }
      const s = stride(perpendicular(env, p, t.point(u, v + 1 / around), t.point(u + 1 / R, v)));
      keep.push(i % s === 0 && env.dark(p, t.normal(u, v)) > threshold);
    }
    runs(pts, keep, i % 8 === 0 ? 'violet' : 'ultramarine', 'figure', out);
  }
  const along = (v: number, ink: Ink, group: Group, lift: number, show: (u: number) => boolean) => {
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let i = 0; i <= samples; i++) { const u = i / samples; pts.push(t.point(u, v, lift)); keep.push(show(u) && cloth(u, v)); }
    runs(pts, keep, ink, group, out);
  };
  const ring = (u: number, ink: Ink, lift: number, show = true) => {
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let i = 0; i <= around; i++) { const v = i / around; pts.push(t.point(u, v, lift)); keep.push(show && cloth(u, v)); }
    runs(pts, keep, ink, 'contour', out);
  };
  // The planes of a faceted body: crisp carbon edges, end to end.
  if (t.facets >= 3) for (let k = 0; k < t.facets; k++) along(k / t.facets, 'carbon', 'figure', 0.004, u => u <= (opts.stop ?? 1));
  for (const v of opts.seams) along(v + offset, 'vermilion', 'contour', 0.01, u => u >= lo && u <= hi);
  for (const v of opts.creases ?? []) along(v + offset, 'carbon', 'figure', 0.012, u => u >= lo && u <= hi);
  for (const u of opts.hems) ring(u, 'vermilion', 0.012);
  for (const u of opts.cuffs ?? []) ring(u, 'carbon', 0.03);
  return out;
}

/** Silhouette curves: where the surface turns edge-on to the camera. */
function silhouettes(t: Tube, env: Env): Stroke[] {
  const out: Stroke[] = [];
  const NU = 220, NV = 96;
  type Track = { v: number; pts: THREE.Vector3[]; last: number };
  let tracks: Track[] = [];
  const close = (tr: Track) => { if (tr.pts.length > 1) out.push({ ink: 'vermilion', group: 'contour', points: tr.pts }); };
  for (let i = 0; i <= NU; i++) {
    const u = i / NU;
    const g = (v: number) => t.normal(u, v).dot(env.forward);
    const roots: number[] = [];
    let prev = g(0);
    for (let j = 1; j <= NV; j++) {
      const v = j / NV, cur = g(v);
      if (Math.sign(cur) !== Math.sign(prev)) roots.push((j - 1 + prev / (prev - cur)) / NV);
      prev = cur;
    }
    const next: Track[] = [];
    for (let r of roots) {
      if (t.facets >= 3) r = Math.round(r * t.facets) / t.facets; // a faceted outline turns at a plane edge
      const p = t.point(u, r, 0.012);
      const match = tracks.find(tr => tr.last === i - 1 && Math.min(Math.abs(tr.v - r), 1 - Math.abs(tr.v - r)) < 0.08);
      if (match) { match.pts.push(p); match.v = r; match.last = i; next.push(match); tracks = tracks.filter(tr => tr !== match); }
      else next.push({ v: r, pts: [p], last: i });
    }
    for (const tr of tracks) close(tr);
    tracks = next;
  }
  for (const tr of tracks) close(tr);
  return out;
}

/** Lapels, tie and collar laid over the trunk; the shirt in the opening stays paper. */
function suitFront(trunk: Tube, env: Env): Stroke[] {
  const out: Stroke[] = [];
  const steps = 90;
  const lift = 0.05;
  const line = (ink: Ink, group: Group, fn: (s: number) => [number, number], count = steps, liftBy = lift) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= count; i++) { const [u, v] = fn(i / count); pts.push(trunk.point(u, v, liftBy)); }
    out.push({ ink, group, points: pts });
  };
  const u0 = BUTTON - 0.02, u1 = COLLAR;
  for (const side of [-1, 1]) {
    const edgeIn = (s: number): [number, number] => { const u = u0 + (u1 - u0) * s; return [u, 0.25 + side * opening(u)]; };
    const edgeOut = (s: number): [number, number] => { const u = u0 + (u1 - u0) * s; return [u, 0.25 + side * (opening(u) + lapel(u))]; };
    line('vermilion', 'contour', edgeIn);
    line('vermilion', 'contour', edgeOut);
    // Lapel cloth: laminations parallel to the roll line, thicker toward the dark lower lapel.
    const count = Math.round(densityPitch(env.density, 6, 10, 13));
    for (let k = 1; k < count; k++) {
      const f = k / count;
      const pts: THREE.Vector3[] = [], keep: boolean[] = [];
      for (let i = 0; i <= steps; i++) {
        const u = u0 + (u1 - u0) * i / steps;
        const v = 0.25 + side * (opening(u) + f * lapel(u));
        const p = trunk.point(u, v, lift);
        pts.push(p);
        keep.push(env.dark(p, trunk.normal(u, v)) > TIER[tierOf(k)] - 0.05);
      }
      runs(pts, keep, k % 4 === 0 ? 'violet' : 'ultramarine', 'figure', out);
    }
    // Notch and collar points.
    line('vermilion', 'contour', s => [u1 + 0.065 * s, 0.25 + side * (opening(u1) + lapel(u1) * (1 - 0.6 * s))], 12);
    line('vermilion', 'contour', s => [0.895 - 0.075 * s, 0.25 + side * (0.02 + 0.05 * s)], 12, 0.03);
    line('vermilion', 'contour', s => [0.82 + 0.075 * s, 0.25 + side * (0.07 + 0.045 * s)], 12, 0.03);
  }
  // The tie: a knot under the collar, a blade with diagonal stripes, ending at the button.
  const tieTop = 0.875, tieEnd = BUTTON + 0.005;
  const half = (u: number) => u > 0.85 ? 0.011 : 0.012 + 0.012 * (0.85 - u) / (0.85 - tieEnd);
  line('vermilion', 'contour', s => { const u = tieTop - (tieTop - tieEnd) * s; return [u, 0.25 - half(u)]; }, 60, 0.07);
  line('vermilion', 'contour', s => { const u = tieTop - (tieTop - tieEnd) * s; return [u, 0.25 + half(u)]; }, 60, 0.07);
  line('vermilion', 'contour', s => [0.85, 0.25 + (2 * s - 1) * half(0.85)], 6, 0.07);
  const stripes = Math.round(densityPitch(env.density, 22, 34, 44));
  for (let k = 0; k < stripes; k++) {
    const c = tieEnd + (0.85 - tieEnd) * (k + 0.5) / stripes;
    if (k % 6 === 5) continue;
    line(k % 6 === 2 ? 'acid' : 'carbon', 'figure', s => [c + 0.012 * (s - 0.5), 0.25 + (2 * s - 1) * half(c) * 0.9], 4, 0.07);
  }
  return out;
}

// ---------------------------------------------------------------- the force

/** `from` is where along the strand it starts: the second strand joins only at the crown, to unwind. */
export type ForceStrand = { theta0: number; hand: 1 | -1; turns: number; width: number; phase: number; lift: number; from: number };

/** The head: two ribbons wound into a skull, then unwinding upward and flaring into the architecture. */
export function forceStrands(ctx: SketchContext): ForceStrand[] {
  const rng = ctx.random('agent-force');
  const hand: 1 | -1 = rng() < 0.5 ? 1 : -1;
  const turns = n(ctx, 'headTurns', 4.2, 1, 6) + (rng() - 0.5) * 0.4;
  const theta0 = rng() * TAU;
  const width = n(ctx, 'headWidth', 0.5, 0.25, 1.4);
  return [
    { theta0, hand, turns, width, phase: rng() * TAU, lift: 1, from: 0 },
    { theta0: theta0 + Math.PI * (0.85 + 0.3 * rng()), hand, turns, width: width * (0.85 + 0.2 * rng()), phase: rng() * TAU, lift: 0.82 + 0.2 * rng(), from: 0.5 },
  ];
}

function forcePoint(s: ForceStrand, neck: THREE.Vector3, gaze: Gaze, rise: number, along: number, v: number): THREE.Vector3 {
  const t = s.from + (1 - s.from) * along;
  // Head 0..0.6 of t; the flare above it climbs `rise` units and pours out along the gaze.
  // Built in a head frame (x = side, y = crown, z = face), then turned onto the gaze.
  const headTop = 2.9;
  const above = t < 0.6 ? 0 : (t - 0.6) / 0.4;
  const y = t < 0.6 ? headTop * t / 0.6 : headTop + above * rise * s.lift;
  const hy = clamp(y / headTop, 0, 1);
  // An egg: narrow at the neck, widest just above the middle, closing in under the crown.
  const skull = 0.5 + 0.85 * Math.sin(Math.PI * Math.min(1, 0.04 + 0.92 * hy)) ** 0.75 - 0.15 * hy;
  const flare = above ** 1.6 * 2.8;
  const r = skull * (1 - 0.2 * above) + flare + 0.05 * Math.sin(7 * TAU * t + s.phase);
  const th = s.theta0 + s.hand * TAU * s.turns * t * (1 - 0.25 * above);
  const radial = V(Math.cos(th), 0, Math.sin(th) * 0.9);
  const taper = s.from > 0 && t < 0.6 ? smooth(s.from, 0.6, t) : t < 0.6 ? 0.3 + 0.7 * Math.sin(Math.PI * Math.min(1, t / 0.6 * 0.9 + 0.1)) ** 0.5 : 1 - 0.75 * above;
  // The face: where the ribbons pass in front of it they narrow, leaving an opening that looks out.
  const facing = Math.sin(th);
  const opening = t < 0.6 ? smooth(0.1, 0.75, facing) * Math.sin(Math.PI * clamp((hy - 0.12) / 0.8, 0, 1)) ** 0.6 : 0;
  const width = s.width * taper * (1 - 0.85 * opening);
  const tangent = V(-Math.sin(th) * r * s.hand * TAU * s.turns, 1, Math.cos(th) * 0.9 * r * s.hand * TAU * s.turns).normalize();
  const across = new THREE.Vector3().crossVectors(radial, tangent).normalize();
  if (across.y < 0) across.negate();
  const roll = (t < 0.6 ? 0 : 0.5) * Math.sin(TAU * 1.4 * t + s.phase);
  const dir = across.multiplyScalar(Math.cos(roll)).addScaledVector(radial, Math.sin(roll));
  const local = V(0, y - 0.5, 1.6 * above ** 1.3 * rise * s.lift * 0.45).addScaledVector(radial, r).addScaledVector(dir, v * width);
  return neck.clone().addScaledVector(gaze.side, local.x).addScaledVector(gaze.axis, local.y).addScaledVector(gaze.face, local.z);
}

function ribbonStrokes(fn: (t: number, v: number) => THREE.Vector3, env: Env, rng: () => number, interruption: number, source: THREE.Vector3): Stroke[] {
  const out: Stroke[] = [];
  const along = 520;
  const trace = (ink: Ink, group: Group, count: number, f: (x: number) => THREE.Vector3) =>
    out.push({ ink, group, points: Array.from({ length: count + 1 }, (_, i) => f(i / count)) });
  for (const v of [-1, 1]) trace('vermilion', 'contour', along, t => fn(t, v));
  trace('acid', 'force', along, t => fn(t, 0));
  const N = Math.round(densityPitch(env.density, 8, 14, 18)) * 2;
  for (let j = 1; j < N; j++) {
    if (j === N / 2) continue;
    const v = -1 + 2 * j / N;
    const pts: THREE.Vector3[] = [], keep: boolean[] = [];
    for (let i = 0; i <= along; i++) {
      const t = i / along;
      const p = fn(t, v);
      pts.push(p);
      const s = stride(perpendicular(env, p, fn(Math.min(1, t + 0.002), v), fn(t, v + 2 / N)));
      const glow = env.dark(p, source.clone().sub(p).normalize());
      keep.push(j % s === 0 && (tierOf(j) === 0 || glow > TIER[tierOf(j)] - 0.1));
    }
    runs(pts, keep, j % 5 === 0 ? 'violet' : 'ultramarine', 'force', out);
  }
  const ribs = Math.round(densityPitch(env.density, 60, 130, 170));
  let last: { x: number; y: number } | null = null;
  for (let i = 0; i <= ribs; i++) {
    const t = i / ribs;
    if (rng() < interruption * (Math.floor(i / 8) % 2 ? 0.9 : 0.35)) continue;
    const centre = fn(t, 0);
    if (i % 4 !== 0 && env.dark(centre, source.clone().sub(centre).normalize()) < 0.25) continue;
    const here = env.screen(centre);
    if (last && Math.hypot(here.x - last.x, here.y - last.y) < 1.1) continue;
    last = here;
    trace(i % 8 === 0 ? 'acid' : i % 3 === 0 ? 'violet' : 'ultramarine', 'force', 12, x => fn(t, -0.95 + 1.9 * x));
  }
  return out;
}

/** Light leaving the head: radial strokes on a plane behind the throne, dashed in a fixed 64-step rhythm. */
function rays(ctx: SketchContext, head: THREE.Vector3): Stroke[] {
  const amount = n(ctx, 'radiance', 0.5, 0, 1);
  if (amount <= 0) return [];
  const rng = ctx.random('agent-rays');
  const pattern = Array.from({ length: 64 }, (_, k) => (k % 8 !== 7) && rng() < 0.7);
  const count = 8 * Math.round(6 + 12 * amount);
  const z = -4.3, growth = 1.13;
  const out: Stroke[] = [];
  for (let i = 0; i < count; i++) {
    const a = TAU * (i + 0.5) / count;
    const long = i % 8 === 0;
    const end = long ? 30 : 8 + 14 * amount;
    for (let k = 0, r = 2.5; r < end; k++, r *= growth) {
      if (!pattern[(k * 3 + i * 5) % 64]) continue;
      const r1 = r * (1 + (growth - 1) * 0.68);
      out.push({ ink: long ? 'vermilion' : 'acid', group: 'rays',
        points: [V(head.x + Math.cos(a) * r, head.y + Math.sin(a) * r, z), V(head.x + Math.cos(a) * r1, head.y + Math.sin(a) * r1, z)] });
    }
  }
  return out;
}

/** The gaze made visible: a cone of straight lines leaving the face toward the upper left. */
function beam(ctx: SketchContext, head: THREE.Vector3, gaze: Gaze): Stroke[] {
  const amount = n(ctx, 'beam', 0.5, 0, 1);
  if (amount <= 0) return [];
  const lines = Math.round(12 + 36 * amount);
  const spread = 0.12 + 0.2 * amount;
  const up = new THREE.Vector3().crossVectors(gaze.face, gaze.side).normalize();
  const out: Stroke[] = [];
  for (let i = 0; i < lines; i++) {
    // A sunflower disc of directions: even, deterministic, no clumps.
    const rho = Math.sqrt((i + 0.5) / lines) * spread, phi = i * 2.399963;
    const d = gaze.face.clone().addScaledVector(gaze.side, rho * Math.cos(phi)).addScaledVector(up, rho * Math.sin(phi)).normalize();
    const start = head.clone().addScaledVector(d, 1.7);
    out.push({ ink: i % 6 === 0 ? 'vermilion' : 'acid', group: 'rays', points: [start, start.clone().addScaledVector(d, 34)] });
  }
  return out;
}

// ---------------------------------------------------------------- the system

/** The throne and the cathedral behind it; near the head the structure breaks and lifts away. */
function architecture(ctx: SketchContext, head: THREE.Vector3): Slab[] {
  const rng = ctx.random('agent-system');
  const breach = n(ctx, 'breach', 0.5, 0, 1);
  const out: Slab[] = [];
  const add = (x: number, y: number, z: number, w: number, h: number, d: number, role: Role = 'stack') => {
    const s = solid(x, y, z, w, h, d, out.length, role);
    out.push(s);
    return s;
  };
  // Throne: floor plinth, seat, armrests, legs, back posts and rails.
  add(0, -10.55, 2.6, 9.8 + 0.6 * rng(), 0.62, 6.4, 'pier');
  add(0, -4.55, 0.55, 8.6, 0.85, 6.2, 'pier');
  for (const side of [-1, 1]) {
    add(side * 4.56, -1.28, 0.9, 1.0, 0.76, 6.75, 'pier');
    add(side * 4.56, -5.95, 3.75, 0.86, 8.6, 0.86, 'pier');
    add(side * 4.45, -5.95, -2.2, 0.86, 8.6, 0.86, 'pier');
    add(side * 4.42, 2.6, -2.75, 0.86, 9.0, 0.86, 'pier');
    add(side * 4.56, -3.1, 1.2, 0.5, 0.5, 4.8, 'pier');
  }
  // Back rails behind the shoulders, and a crest that the head has broken open.
  add(0, 1.9, -2.95, 9.6, 0.8, 0.7);
  add(0, 4.9, -2.95, 10.6 + 1.2 * rng(), 0.72, 0.7);
  const crest = { y: 7.45 + 0.4 * rng(), w: 13 + 1.6 * rng() };
  const gapHalf = 1.6 + 2.6 * breach;
  for (const side of [-1, 1]) {
    const inner = gapHalf, outer = crest.w / 2;
    if (outer - inner > 0.6) add(side * (inner + outer) / 2, crest.y, -2.95, outer - inner, 0.95, 0.9);
  }
  // The broken crest pieces, lifted and turned by the force.
  const shards = 2 + Math.round(3 * breach);
  for (let i = 0; i < shards; i++) {
    const w = gapHalf * 2 / shards * (0.7 + 0.25 * rng());
    const x = -gapHalf + (i + 0.5) * gapHalf * 2 / shards;
    const s = add(x * (1.15 + 0.4 * breach), crest.y + 1.1 + (2.2 + 1.5 * rng()) * breach, -2.95 + (rng() - 0.5) * 1.4, w, 0.95, 0.9, 'fallen');
    s.rz = (rng() - 0.5) * 1.2 * breach + Math.sign(x) * 0.3 * breach; s.rx = (rng() - 0.5) * 0.7 * breach; s.ry = (rng() - 0.5) * 0.9 * breach;
  }
  // Cathedral behind: cantilevered slabs from both walls, the original slab grammar, pushed back from the head.
  const levels = Math.round(n(ctx, 'levels', 12, 8, 16));
  const z0 = -7.6;
  // Walls are laid out where the camera sees them: world x from a wanted screen x at this depth.
  const turn = n(ctx, 'turn', 26, -40, 40) * Math.PI / 180;
  const wx = (sx: number, z: number) => (sx + z * Math.sin(turn)) / Math.cos(turn);
  for (let i = 0; i < levels; i++) {
    const y = -11.2 + (23.6 * (i + 0.5)) / levels + (rng() - 0.5) * 0.5;
    for (const side of [-1, 1]) {
      if (rng() < 0.22) continue;
      const w = 2.6 + 3.6 * rng();
      const z = z0 + (rng() - 0.5) * 1.2;
      const x = wx(side * (8.7 - w / 2 + 0.6 * rng()), z);
      const s = add(x, y, z, w, 0.55 + 0.6 * rng(), 1.1 + 0.6 * rng());
      const away = V(s.x - head.x, s.y - head.y, 0);
      const d = away.length();
      const push = breach * 3.2 * Math.exp(-((d / 6.5) ** 2));
      if (push > 0.25) {
        away.normalize();
        s.x += away.x * push; s.y += away.y * push; s.z += 0.6 * push;
        s.rz = -side * 0.35 * push * (rng() < 0.2 ? -1 : 1); s.rx = (rng() - 0.5) * 0.4 * push;
        s.role = 'fallen';
      }
    }
  }
  for (const side of [-1, 1]) for (let k = 0; k < 3; k++) {
    if (rng() < 0.3) continue;
    add(wx(side * (7.4 + 0.4 * rng()), z0 - 1.1), -8 + 7.6 * k + rng(), z0 - 1.1, 0.7, 4.4 + 2 * rng(), 0.9, 'pier');
  }
  // Fragments rising off the breach around the head.
  const drng = ctx.random('agent-debris');
  const pieces = Math.round((6 + 34 * breach) * n(ctx, 'debris', 0.5, 0, 1) * 2);
  for (let i = 0; i < pieces; i++) {
    const a = Math.PI * (0.04 + 0.92 * drng());
    const r = 3.2 + 6.5 * drng() ** 0.8;
    const size = (1 - 0.5 * (r - 3) / 6.5) * (0.35 + 0.65 * drng());
    const x = head.x + Math.cos(a) * r, y = head.y + 0.6 + Math.sin(a) * r * 0.85;
    if (y > 10.6 || Math.abs(x) > 7.2 || (Math.abs(x - head.x) < 3.4 && y < head.y + 1)) continue;
    const s = add(x, y, -2.2 + 3 * drng(), 0.25 + 0.8 * size, 0.1 + 0.25 * size, 0.2 + 0.4 * size, 'debris');
    s.rx = (drng() - 0.5) * 2.4; s.ry = (drng() - 0.5) * 2.4; s.rz = (drng() - 0.5) * Math.PI;
  }
  // Tone: the structure is lit by the head, so it goes quiet near the force and loud at the base.
  for (const s of out) {
    const d = Math.hypot(s.x - head.x, s.y - head.y, (s.z - head.z) * 0.5);
    s.tone = s.role === 'debris' ? 0.3 + 0.4 * smooth(3, 10, d) : 0.16 + 1.1 * smooth(3.2, 15, d);
  }
  return out;
}

// ---------------------------------------------------------------- assembly

/**
 * The censor: flat bars laid over the head on the sheet itself, no perspective, filled with
 * hatching instead of ink. Whatever the bars cover is knocked out; light still leaks round them.
 * Returns the bars as page-millimetre quads plus their hatch and outline paths.
 */
function censorBars(ctx: SketchContext, pose: Pose, screenMm: (p: THREE.Vector3) => Point): { quads: Point[][]; paths: Point[][] } {
  const empty = { quads: [], paths: [] };
  if (ctx.params.censor === false) return empty;
  const rng = ctx.random('agent-censor');
  const centre = screenMm(pose.neck.clone().addScaledVector(pose.gaze.axis, 1.35).addScaledVector(pose.gaze.face, 0.35));
  const tilt = (rng() < 0.5 ? -1 : 1) * (0.04 + 0.3 * n(ctx, 'censorAngle', 0.4, 0, 1) * (0.4 + rng()));
  const length = 64 + 22 * rng(), height = 12 + 5 * rng();
  const bars: { cx: number; cy: number; l: number; h: number }[] = [{ cx: centre.x, cy: centre.y, l: length, h: height }];
  if (rng() < 0.55) {
    // A second, thinner strip, as if the first did not quite cover it.
    const side = rng() < 0.5 ? -1 : 1, slide = (rng() - 0.5) * 0.4 * length;
    const h2 = height * (0.35 + 0.2 * rng());
    bars.push({ cx: centre.x + slide * Math.cos(tilt) - side * (height / 2 + h2 / 2 + 2.2) * Math.sin(tilt),
      cy: centre.y + slide * Math.sin(tilt) + side * (height / 2 + h2 / 2 + 2.2) * Math.cos(tilt), l: length * (0.45 + 0.25 * rng()), h: h2 });
  }
  const ux = Math.cos(tilt), uy = Math.sin(tilt);
  const quads: Point[][] = [], paths: Point[][] = [];
  for (const b of bars) {
    const at = (s: number, t: number): Point => ({ x: b.cx + ux * s - uy * t, y: b.cy + uy * s + ux * t });
    const q = [at(-b.l / 2, -b.h / 2), at(b.l / 2, -b.h / 2), at(b.l / 2, b.h / 2), at(-b.l / 2, b.h / 2)];
    quads.push(q);
    paths.push([...q, q[0]], [at(-b.l / 2 + 1.1, -b.h / 2 + 1.1), at(b.l / 2 - 1.1, -b.h / 2 + 1.1), at(b.l / 2 - 1.1, b.h / 2 - 1.1), at(-b.l / 2 + 1.1, b.h / 2 - 1.1), at(-b.l / 2 + 1.1, -b.h / 2 + 1.1)]);
    // Two hatch families at ±60° to the bar, inside the inner rule: dense enough to read as a fill.
    for (const [angle, pitch] of [[Math.PI / 3, 0.62], [-Math.PI / 3, 0.9]] as const) {
      const dx = Math.cos(angle), dy = Math.sin(angle);
      const reach = (b.l + b.h) / 2;
      const inset = 1.6;
      for (let k = -reach; k <= reach; k += pitch) {
        // Line s = k + t·(dx/dy) in bar coordinates, clipped to the inner rectangle.
        let t0 = -b.h / 2 + inset, t1 = b.h / 2 - inset;
        const sAt = (t: number) => k + t * dx / dy;
        const lo = -b.l / 2 + inset, hi = b.l / 2 - inset;
        const s0 = sAt(t0), s1 = sAt(t1);
        if (Math.max(s0, s1) < lo || Math.min(s0, s1) > hi) continue;
        const clipT = (s: number) => (s - k) * dy / dx;
        if (s0 < lo) t0 = clipT(lo); else if (s0 > hi) t0 = clipT(hi);
        if (s1 < lo) t1 = clipT(lo); else if (s1 > hi) t1 = clipT(hi);
        if (Math.abs(t1 - t0) < 0.4) continue;
        paths.push([at(sAt(t0), t0), at(sAt(t1), t1)]);
      }
    }
  }
  return { quads, paths };
}

/** Seams and hems per garment piece, in tube coordinates. */
const HEMS: Record<string, Tailoring> = {
  trunk: { seams: [0, 0.5, 0.75], hems: [0.07] },
  thigh: { seams: [0, 0.5], hems: [], creases: [0.25] },
  shin: { seams: [0, 0.5], hems: [0.955], creases: [0.25] },
  upper: { seams: [0.5], hems: [] },
  fore: { seams: [0.5], hems: [0.88], stop: 0.88, cuffs: [0.955] },
};

export function drawAgent(ctx: SketchContext): Part[] {
  const view = camera(ctx);
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const pose = figure(ctx);
  const density = n(ctx, 'hatchDensity', 0.55, 0, 1);
  const rawInterruption = n(ctx, 'interruption', 0.32, 0, 1);
  const env: Env = {
    view, forward, density,
    screen: p => { const q = p.clone().project(view); return { x: q.x * HALF_W * MM_PER_UNIT, y: q.y * HALF_H * MM_PER_UNIT }; },
    dark: toneField(ctx, pose.head),
  };
  const system = architecture(ctx, pose.head);
  const solids = [...system, ...pose.slabs];
  const beatRng = ctx.random('agent-rests');
  const beats = Array.from({ length: 64 }, () => beatRng() < rawInterruption);
  const strokes: Stroke[] = solids.flatMap((s, owner) => {
    const group: Group = owner < system.length && s.role !== 'stub' ? (s.z < -5 ? 'system' : 'throne') : 'figure';
    return slabStrokes(s, density, beats[(s.beat * 7) % 64]).map(stroke => ({ ...stroke, group, owner }));
  });
  const band = n(ctx, 'band', 1.25, 0.7, 2.2);
  const cloth = ctx.params.cloth === 'ribbon' ? 'ribbon' : 'pinstripe';
  pose.tubes.forEach((t, i) => {
    const restRng = ctx.random(`agent-band-${t.id}`);
    const rest = new Map<number, boolean>();
    const rests = (k: number) => {
      if (!rest.has(k)) rest.set(k, restRng() < rawInterruption * (Math.abs(k + i) % 8 < 4 ? 0.9 : 0.4));
      return rest.get(k)!;
    };
    if (cloth === 'ribbon') strokes.push(...ribbonTube(t, env, { band: band * (t.id === 'trunk' ? 1.15 : 1), gap: 0.13, rests }));
    else strokes.push(...pinstripeTube(t, env, HEMS[t.id.replace(/-?1$/, '')] ?? { seams: [0, 0.5], hems: [] }));
    strokes.push(...silhouettes(t, env));
  });
  strokes.push(...suitFront(pose.trunk, env));
  const strands = forceStrands(ctx);
  // The unwinding stops short of the art edge, so the force never reads as cropped.
  const room = (10.4 - pose.neck.y) / Math.max(0.5, pose.gaze.axis.y) - 2.4;
  const rise = Math.max(0.6, (0.35 + 0.65 * n(ctx, 'rise', 0.5, 0, 1)) * room);
  const forceFns = strands.map(s => (t: number, v: number) => forcePoint(s, pose.neck, pose.gaze, rise, t, v));
  const forceRng = ctx.random('agent-force-ribs');
  for (const fn of forceFns) strokes.push(...ribbonStrokes(fn, env, forceRng, rawInterruption, pose.head));
  strokes.push(...rays(ctx, pose.head), ...beam(ctx, pose.head, pose.gaze));

  const geometries = solids.map(slabGeometry);
  for (const t of pose.tubes) geometries.push(t.mesh());
  for (const fn of forceFns) geometries.push(buildSurfaceMesh((u, v) => fn(u, 2 * v - 1), {}, 520, 10));
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    const surfaces: SloganSurface[] = [];
    system.forEach((s, id) => {
      if ((s.role === 'stack' || s.role === 'pier') && s.w > 1.2 && s.h > 0.3) surfaces.push({ id, matrix: slabMatrix(s), w: s.w, h: s.h, d: s.d });
    });
    const ART = { x0: TALL_ART.x, x1: TALL_ART.x + TALL_ART.width, y0: TALL_ART.y, y1: TALL_ART.y + TALL_ART.height };
    const pageMmPerPx = MM_Y * posterArtTransform(ctx, TABLOID_PAGE, TALL_ART).scale;
    const slogans = planSlogans(ctx, surfaces, {
      view, depth, width: W, height: H, bias: 0.0014, mmPerPx: pageMmPerPx,
      art: { x0: ART.x0 / MM_X, x1: ART.x1 / MM_X, y0: ART.y0 / MM_Y, y1: ART.y1 / MM_Y },
    });
    const pen = sloganSettings(ctx).pen as Ink;
    for (const points of slogans.strokes) strokes.push({ ink: pen, group: 'slogan', points });
    // The print title: one line on a low, clear slab face, always on the fine lettering pen.
    for (const points of slogans.titleStrokes) strokes.push({ ink: 'lettering', group: 'title', points });
    const projection = projectPolylinesClipped(strokes.map(s => s.points), view, W, H);
    const buckets = new Map<string, Point[][]>();
    const removeHidden = ctx.params.occlusion !== false;
    const censor = censorBars(ctx, pose, p => { const q = p.clone().project(view); return { x: (q.x * 0.5 + 0.5) * W * MM_X, y: (-q.y * 0.5 + 0.5) * H * MM_Y }; });
    const censorPx = censor.quads.map(q => q.map(c => ({ x: c.x / MM_X, y: c.y / MM_Y })));
    for (let i = 0; i < projection.polylines.length; i++) {
      const stroke = strokes[projection.sourceIndices[i]];
      const key = `${stroke.group}-${stroke.ink}`;
      const text = stroke.group === 'slogan' || stroke.group === 'title';
      const bands = stroke.owner === undefined ? undefined : slogans.knockouts.get(stroke.owner);
      const pieces = clipProjectedPolyline(projection.polylines[i], W, H).flatMap(c => bands ? clearBands(c, bands, pageMmPerPx) : [c]);
      for (const clipped of pieces) {
        const dense = densifyProjectedPolyline(clipped);
        const shown = removeHidden ? splitPolylineByDepth(dense, depth, 0.0014).visible : [dense];
        const visible = censorPx.length && !text ? shown.flatMap(r => knockOut(r, censorPx)) : shown;
        for (const run of visible) {
          const mm = run.map(p => ({ x: p.x * MM_X, y: p.y * MM_Y }));
          for (const path of clipArt(mm)) {
            const reduced = text ? path : simplify(path);
            let length = 0;
            for (let j = 1; j < reduced.length; j++) length += Math.hypot(reduced[j].x - reduced[j - 1].x, reduced[j].y - reduced[j - 1].y);
            if (reduced.length > 1 && length > (text ? 0.05 : 0.5)) {
              if (!buckets.has(key)) buckets.set(key, []);
              buckets.get(key)!.push(reduced);
            }
          }
        }
      }
    }
    const parts: Part[] = [];
    const bars = censor.paths.flatMap(clipArt);
    for (const group of GROUPS) for (const ink of INKS) {
      const paths = buckets.get(`${group}-${ink}`);
      if (paths?.length) parts.push({ id: `${group}-${ink}`, pen: ink, paths });
    }
    if (bars.length) parts.push({ id: 'censor-carbon', pen: 'carbon', paths: bars });
    return parts;
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}
