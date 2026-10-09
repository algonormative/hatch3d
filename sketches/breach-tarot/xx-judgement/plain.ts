import * as THREE from 'three';
import type { Point, SketchContext } from '../../../src/sketch/types.ts';
import { solid, type Slab } from '../../kit/slabs.ts';
import { n, smooth } from '../../kit/params.ts';
import { pageOf, type PageSize } from '../../kit/perspective.ts';
import { TABLOID_CARD, TABLOID_HORIZON_Y } from '../../kit/format.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';

/**
 * The plain: stone boxes set in the ground in a grid (part cemetery, part server floor), turned on
 * the diagonal so the rows run away to the horizon. Each is a tray with a lid; every lid is lifting
 * at once, hinged on its own edge, wide open near and only cracking far.
 *
 * The plain is the card's seeded world, laid out in tabloid's frame: `view` is the world camera (`worldCamera` in
 * geometry.ts), and every page test that decides what stands (a lid let down off the horizon's open edges, a box or a
 * fragment outside the card) is made on tabloid's page, card and horizon, so every size and fit builds the same plain.
 */
export const BOX = { w: 4.3, l: 7.8, wall: 0.66, high: 1.45, floor: 0.27, lid: 0.55, over: 0.18, gap: 0.04 };

/** Which local edge a lid hinges on: `far` is the grid's far edge, `left` and `right` the sides. */
export type Hinge = 'near' | 'far' | 'left' | 'right';

export interface Vault {
  id: number;
  /** Where it stands: world x and z of the tray's centre. */
  x: number; z: number; yaw: number;
  /** The lid's opening, radians from shut. */
  open: number;
  hinge: Hinge;
  tray: Slab[];
  lid: Slab;
}

const UP = new THREE.Vector3(0, 1, 0);

function slabAt(centre: THREE.Vector3, yawQ: THREE.Quaternion, local: THREE.Vector3, size: [number, number, number], q: THREE.Quaternion, beat: number): Slab {
  const p = local.clone().applyQuaternion(yawQ).add(centre);
  const s = solid(p.x, p.y, p.z, size[0], size[1], size[2], beat, 'stack');
  const e = new THREE.Euler().setFromQuaternion(yawQ.clone().multiply(q), 'XYZ');
  s.rx = e.x; s.ry = e.y; s.rz = e.z;
  return s;
}

/** The tray (floor and four walls) and the lid at `open` radians on the given hinge. */
export function buildVault(id: number, x: number, z: number, yaw: number, open: number, hinge: Hinge, lidTone: number): Vault {
  const { w, l, wall, high, floor, lid: t, over, gap } = BOX;
  const centre = new THREE.Vector3(x, 0, z);
  const yawQ = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  const ident = new THREE.Quaternion();
  const tray: Slab[] = [];
  const add = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, tone: number) => {
    const s = slabAt(centre, yawQ, new THREE.Vector3(lx, ly, lz), [sx, sy, sz], ident, id * 8 + tray.length);
    s.tone = tone;
    tray.push(s);
  };
  // The inside is darker the less the lid shows of it: a cracking lid leaves a thin dark slit, an open one a calm pit.
  const pit = THREE.MathUtils.lerp(1.5, 1.05, Math.min(1, open / THREE.MathUtils.degToRad(70)));
  add(0, floor / 2, 0, w - 2 * wall, floor, l - 2 * wall, pit);
  add(-(w - wall) / 2, high / 2, 0, wall, high, l, 1.0);
  add((w - wall) / 2, high / 2, 0, wall, high, l, 1.0);
  add(0, high / 2, -(l - wall) / 2, w - 2 * wall, high, wall, pit);
  add(0, high / 2, (l - wall) / 2, w - 2 * wall, high, wall, 1.0);

  // The lid: pivot on the hinge edge at the lid's own underside, swung up by `open`.
  const wl = w + 2 * over, ll = l + 2 * over, py = high + gap;
  let pivot: THREE.Vector3, off: THREE.Vector3, q: THREE.Quaternion;
  switch (hinge) {
    case 'far': pivot = new THREE.Vector3(0, py, -ll / 2); off = new THREE.Vector3(0, t / 2, ll / 2); q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -open); break;
    case 'near': pivot = new THREE.Vector3(0, py, ll / 2); off = new THREE.Vector3(0, t / 2, -ll / 2); q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), open); break;
    case 'left': pivot = new THREE.Vector3(-wl / 2, py, 0); off = new THREE.Vector3(wl / 2, t / 2, 0); q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), open); break;
    default: pivot = new THREE.Vector3(wl / 2, py, 0); off = new THREE.Vector3(-wl / 2, t / 2, 0); q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -open); break;
  }
  const local = pivot.clone().add(off.clone().applyQuaternion(q));
  const lid = slabAt(centre, yawQ, local, [wl, t, ll], q, id * 8 + 7);
  lid.tone = lidTone;
  return { id, x, z, yaw, open, hinge, tray, lid };
}

export function vaultCorners(v: Vault): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const s of [...v.tray, v.lid]) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(s.x, s.y, s.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rx, s.ry, s.rz, 'XYZ')), new THREE.Vector3(1, 1, 1));
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) out.push(new THREE.Vector3(a * s.w / 2, b * s.h / 2, c * s.d / 2).applyMatrix4(m));
  }
  return out;
}

export function pageBox(view: THREE.Camera, pts: THREE.Vector3[], page: PageSize = TABLOID_PAGE): { x0: number; x1: number; y0: number; y1: number } | null {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    const behind = p.clone().applyMatrix4(view.matrixWorldInverse).z >= -1;
    if (behind) return null;
    const q: Point = pageOf(view, p, page);
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
  }
  return { x0, x1, y0, y1 };
}

/**
 * The whole plain: identical boxes in a regular grid, turned so the rows run away on the diagonal, every
 * lid hinged on the same edge. Only the opening changes, steadily with distance: wide open near, only
 * cracking far. A lid that would stand across the horizon at the card's left or right edge is let down
 * until it does not, so the horizon stays open there.
 */
export function plain(ctx: SketchContext, view: THREE.PerspectiveCamera, keepClear: (v: Vault) => boolean = () => true): Vault[] {
  const rng = ctx.random('judgement-field');
  const turn = THREE.MathUtils.degToRad(n(ctx, 'turn', 34, 10, 60));
  const gu = n(ctx, 'gapAcross', 5, 1, 9), gv = n(ctx, 'gapAlong', 8, 1.5, 14);
  const pu = BOX.w + gu, pv = BOX.l + gv;
  // The seed shifts the whole field a little and nothing else about its order.
  const ox = n(ctx, 'originX', -6, -40, 40) + (rng() - 0.5) * 3, oz = n(ctx, 'originZ', -27, -70, -9) + (rng() - 0.5) * 4;
  const nearOpen = THREE.MathUtils.degToRad(n(ctx, 'openNear', 105, 60, 130));
  const farOpen = THREE.MathUtils.degToRad(n(ctx, 'openFar', 8, 2, 30));
  const fall = n(ctx, 'openFall', 85, 60, 260);
  const reach = n(ctx, 'reach', 220, 80, 500);
  const edge = n(ctx, 'horizonEdge', 12, 0, 40), lidTone = n(ctx, 'lidTone', 0.5, 0.3, 1.4);
  const out: Vault[] = [];
  let id = 0;
  // Rows j away from the viewer along the grid's far direction, columns i across.
  for (let j = 0; j < 22; j++) for (let i = -4; i < 14; i++) {
    const a = i * pu, b = -j * pv;
    const x = ox + a * Math.cos(turn) + b * Math.sin(turn);
    const z = oz - a * Math.sin(turn) + b * Math.cos(turn);
    const depth = -z;
    if (depth < 9 || depth > reach) continue;
    const t = smooth(n(ctx, 'openNearDepth', 20, 9, 60), fall, depth);
    const open = THREE.MathUtils.lerp(nearOpen, farOpen, t ** 0.8);
    // Near the card's edges a lid that would stand across the horizon is let down until it does not.
    let v: Vault | null = null;
    for (let a2 = open; a2 >= THREE.MathUtils.degToRad(3) - 1e-6; a2 -= THREE.MathUtils.degToRad(7)) {
      const trial = buildVault(id, x, z, turn, Math.max(a2, THREE.MathUtils.degToRad(3)), 'far', lidTone);
      const box = pageBox(view, vaultCorners(trial));
      if (!box) break;
      if (box.x1 < TABLOID_CARD.x0 - 12 || box.x0 > TABLOID_CARD.x1 + 12 || box.y1 < TABLOID_CARD.y0 - 10 || box.y0 > TABLOID_CARD.y1 + 80) break;
      if (box.y0 < TABLOID_HORIZON_Y + 2 && (box.x0 < TABLOID_CARD.x0 + edge || box.x1 > TABLOID_CARD.x1 - edge)) continue;
      v = trial;
      break;
    }
    if (!v || !keepClear(v)) continue;
    out.push(v);
    id++;
  }
  return out;
}

/**
 * Seams in the paving: lines along both directions of the grid down the middle of each street, as on a
 * raised floor, from the nearest row out to `reach`. World polylines just above the ground.
 */
export function seams(ctx: SketchContext): THREE.Vector3[][] {
  const turn = THREE.MathUtils.degToRad(n(ctx, 'turn', 34, 10, 60));
  const pu = BOX.w + n(ctx, 'gapAcross', 5, 1, 9), pv = BOX.l + n(ctx, 'gapAlong', 8, 1.5, 14);
  const rng = ctx.random('judgement-field');
  const ox = n(ctx, 'originX', -6, -40, 40) + (rng() - 0.5) * 3, oz = n(ctx, 'originZ', -27, -70, -9) + (rng() - 0.5) * 4;
  const at = (a: number, b: number) => new THREE.Vector3(ox + a * Math.cos(turn) + b * Math.sin(turn), 0.03, oz - a * Math.sin(turn) + b * Math.cos(turn));
  const out: THREE.Vector3[][] = [];
  const line = (f: (t: number) => THREE.Vector3, steps: number) => out.push(Array.from({ length: steps + 1 }, (_, i) => f(i / steps)));
  for (let i = -6; i < 15; i++) {
    const a = (i + 0.5) * pu;
    line(t => at(a, pv * (0.8 - 24 * t)), 48);
  }
  for (let j = -1; j < 22; j++) {
    const b = -(j + 0.5) * pv;
    line(t => at(pu * (-6 + 21 * t), b), 42);
  }
  return out;
}

/** Whether a world point lies inside a slab, grown by `pad` all round. */
function inside(p: THREE.Vector3, s: Slab, pad: number): boolean {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(s.x, s.y, s.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rx, s.ry, s.rz, 'XYZ')), new THREE.Vector3(1, 1, 1));
  const q = p.clone().applyMatrix4(m.invert());
  return Math.abs(q.x) < s.w / 2 + pad && Math.abs(q.y) < s.h / 2 + pad && Math.abs(q.z) < s.d / 2 + pad;
}

/**
 * Fragments rising from open boxes: a handful of boxes each send up a short column of thin sheets that
 * tumble more and shrink as they climb, drifting toward the horn's mouth. Kept clear of every box and of the horn.
 */
export function fragments(ctx: SketchContext, view: THREE.PerspectiveCamera, vaults: Vault[], toward: THREE.Vector3, clear: (p: THREE.Vector3) => boolean): Slab[] {
  const rng = ctx.random('judgement-fragments');
  const columns = Math.round(n(ctx, 'fragments', 8, 0, 16));
  const out: Slab[] = [];
  const open = vaults.filter(v => v.open > THREE.MathUtils.degToRad(25) && -v.z > 26 && -v.z < 90).sort((a, b) => a.x - b.x);
  if (!open.length || !columns) return out;
  const all = vaults.flatMap(v => [...v.tray, v.lid]);
  for (let c = 0; c < columns; c++) {
    // Evenly through the open boxes, left to right.
    const v = open[Math.min(open.length - 1, Math.floor((c + 0.5 + (rng() - 0.5) * 0.6) / columns * open.length))];
    const heights = 4 + Math.floor(rng() * 3);
    const to = new THREE.Vector3(toward.x - v.x, 0, toward.z - v.z).normalize();
    for (let k = 0; k < heights; k++) {
      const climb = 0.8 + k * (2.6 + 1.2 * rng());
      const w = (1.9 - 0.2 * k) * (0.8 + 0.4 * rng()), d = w * (0.5 + 0.3 * rng());
      const p = new THREE.Vector3(v.x + to.x * k * 0.9 + (rng() - 0.5) * 1.4, BOX.high + 1.6 + climb, v.z + to.z * k * 0.9 + (rng() - 0.5) * 1.4);
      const s = solid(p.x, p.y, p.z, w, 0.09 + 0.05 * rng(), d, 900 + c * 8 + k, 'debris');
      const tumble = 0.35 + 0.5 * k;
      s.rx = (rng() - 0.5) * tumble; s.ry = rng() * Math.PI; s.rz = (rng() - 0.5) * tumble;
      s.tone = 0.4;
      if (all.some(o => inside(p, o, Math.max(w, d) * 0.8)) || !clear(p)) continue;
      const box = pageBox(view, [p]);
      if (!box || box.x0 < TABLOID_CARD.x0 + 6 || box.x0 > TABLOID_CARD.x1 - 6 || box.y0 < TABLOID_CARD.y0 + 6) continue;
      out.push(s);
    }
  }
  return out;
}
