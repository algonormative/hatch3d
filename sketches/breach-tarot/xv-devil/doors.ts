import * as THREE from 'three';
import type { SketchContext } from '../../../src/sketch/types.ts';
import { solid, type Slab } from '../../kit/slabs.ts';
import { param } from './params.ts';

export type DoorPart = 'jamb' | 'lintel' | 'sill' | 'leaf';
export interface DoorPiece { sl: Slab; part: DoorPart }
export interface Door { side: -1 | 1; pieces: DoorPiece[] }

/**
 * A freestanding door frame on the plain, near and big, taller than the pillar, its door swung
 * wide open. The frame is two thin jambs, a lintel and a low sill, plain and pale. It faces the eye,
 * turned `doorTurn` degrees toward the pillar, so the doorway shows the horizon and paper through
 * it. The leaf hangs from the outer jamb and has swung past square, out toward the eye. `side` -1
 * is the left door and +1 the right: the right is the left mirrored, so both stand equally open.
 */
export function buildDoor(ctx: SketchContext, side: -1 | 1, base: THREE.Vector3): Door {
  const rng = ctx.random(`devil-door-${side}`);
  const v = param(ctx, 'variety');
  const Wd = param(ctx, 'doorW'), Hd = param(ctx, 'doorH');
  const open = THREE.MathUtils.degToRad(param(ctx, 'doorOpen'));
  // The left door's frame turns by psi about the vertical; the right by -psi, and its x is mirrored.
  const m = -side;
  const psi = m * THREE.MathUtils.degToRad(param(ctx, 'doorTurn'));
  const frame = new THREE.Matrix4().makeRotationY(psi);
  const jambW = 0.3 + 0.03 * v * (rng() - 0.5), jambD = 0.4, lintelH = 0.5, lintelD = 0.5, sillH = 0.1;
  const tone = 0.35;
  const pieces: DoorPiece[] = [];
  const put = (part: DoorPart, lx: number, ly: number, lz: number, w: number, h: number, d: number, extra = 0) => {
    const p = new THREE.Vector3(m * lx, ly, lz).applyMatrix4(frame).add(base);
    const sl = solid(p.x, p.y, p.z, w, h, d, pieces.length, 'stack');
    sl.ry = psi + m * extra;
    sl.tone = tone;
    pieces.push({ sl, part });
  };
  for (const s of [-1, 1]) put('jamb', s * (Wd / 2 + jambW / 2), Hd / 2, 0, jambW, Hd, jambD);
  put('lintel', 0, Hd + lintelH / 2 + 0.03, 0, Wd + 2 * jambW + 0.3, lintelH, lintelD);
  put('sill', 0, sillH / 2, 0, Wd, sillH, lintelD * 0.9);
  // The leaf: hinged at the outer jamb (local -x), its free end swung `open` radians from the frame's plane toward +z, the
  // eye's side, so it stands out in front of the frame, past square.
  const Wl = Wd - 0.3, Hl = Hd - sillH - 0.08;
  const hinge = -Wd / 2 + 0.1;
  const cx = hinge + (Wl / 2) * Math.cos(open), cz = (Wl / 2) * Math.sin(open);
  put('leaf', cx, sillH + 0.04 + Hl / 2, cz, Wl, Hl, 0.1, -open);
  return { side, pieces };
}
