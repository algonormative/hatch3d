import * as THREE from 'three';
import type { SketchContext } from '../../../src/sketch/types.ts';
import { solid, type Slab } from '../../kit/slabs.ts';
import { clamp, smooth } from '../../kit/params.ts';

/**
 * A tower that is a cup: slab courses stacked on a square plan, turned on the ground, whose width
 * follows a goblet's profile (a spreading foot, a slim stem with a knop, a bowl that flares to a
 * heavier lip). From the eye's height the rim is far overhead and the inside cannot be seen, so
 * the top is a plain heavy course and anything let down into it is hidden behind its near wall.
 */
export interface VesselSpec {
  /** Ground position of the axis. */
  x: number; z: number;
  /** Rim height and widest width (the lip), in world units. */
  height: number; width: number;
  /** Turn of the plan about the vertical, radians. */
  yaw: number;
  courses: number;
  /** Random stream name, so each vessel keeps its own draws. */
  stream: string;
}

export interface Vessel {
  slabs: Slab[];
  axis: THREE.Vector3;
  yaw: number;
  /** Height of the rim's top and half the lip's width. */
  rim: number;
  lipHalf: number;
  /** The plan's two horizontal directions: local +x and local +z. */
  right: THREE.Vector3;
  front: THREE.Vector3;
}

/** The goblet's width at height share u (0 foot, 1 lip), as a share of the widest. */
export function goblet(u: number): number {
  const bowl = smooth(0.36, 1.0, u) ** 0.75;
  const foot = 0.3 * Math.exp(-((u / 0.07) ** 2));
  const knop = 0.11 * Math.exp(-(((u - 0.33) / 0.035) ** 2));
  return 0.27 + 0.73 * bowl + foot + knop;
}

export function buildVessel(ctx: SketchContext, spec: VesselSpec): Vessel {
  const rng = ctx.random(spec.stream);
  const weights = Array.from({ length: spec.courses }, (_, i) => (i === 0 ? 0.75 : i === spec.courses - 1 ? 0.8 : 0.8 + 0.5 * rng()));
  const total = weights.reduce((a, b) => a + b, 0);
  const slabs: Slab[] = [];
  const gap = 0.1;
  let y = 0;
  for (let i = 0; i < spec.courses; i++) {
    const h = spec.height * weights[i] / total;
    const u = (y + h / 2) / spec.height;
    const lip = i === spec.courses - 1;
    const w = spec.width * goblet(u) * (0.93 + 0.14 * rng()) * (lip ? 1.1 : 1);
    const d = w * (0.92 + 0.12 * rng());
    const slip = (rng() - 0.5) * 0.05 * spec.width;
    const sl = solid(spec.x + slip, y + h / 2, spec.z, w, h - gap, d, i, 'stack');
    sl.ry = spec.yaw + (rng() - 0.5) * 0.07;
    sl.tone = lip ? 1.25 : clamp(0.62 + 0.55 * rng(), 0.55, 1.15);
    slabs.push(sl);
    y += h;
  }
  const last = slabs[slabs.length - 1];
  return {
    slabs, axis: new THREE.Vector3(spec.x, 0, spec.z), yaw: spec.yaw, rim: y,
    lipHalf: Math.max(last.w, last.d) / 2,
    right: new THREE.Vector3(Math.cos(spec.yaw), 0, -Math.sin(spec.yaw)),
    front: new THREE.Vector3(Math.sin(spec.yaw), 0, Math.cos(spec.yaw)),
  };
}
