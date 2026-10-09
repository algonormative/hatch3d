import * as THREE from 'three';
import type { SketchContext } from '../../../src/sketch/types.ts';
import { tabloidFrameCamera } from '../../kit/perspective.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { buildDoor, type Door } from './doors.ts';
import { standing, type Figure } from './figures.ts';
import { param } from './params.ts';
import { buildPillar, type Pillar } from './pillar.ts';

/**
 * The leash's route from the pillar to a wrist, in world units. `m` is -1 on the left, +1 on the
 * right. It starts inside the shaft (so the ribbon comes out from behind the pillar's edge, not out of
 * its face), falls to the ground in front of the pillar, lies out along it in a loose loop toward the
 * eye, and comes back up to the wrist. `slack` stretches the loop; `sag` is 1 for the leash as drawn
 * and 0 for the same leash pulled taut, a straight cord from the pillar to the wrist.
 */
export function leashRoute(m: -1 | 1, pillar: Pillar, wrist: THREE.Vector3, figZ: number, slack: number, sag = 1): THREE.Vector3[] {
  const { y: ay, half: os, z: zp } = pillar.attach;
  const ow = Math.abs(wrist.x);
  const span = Math.max(1.5, ow - os);
  const P = (o: number, y: number, z: number) => new THREE.Vector3(m * o, y, z);
  const zf = figZ;
  const route = [
    P(os - 1.7, ay, zp - 0.4),
    P(os + 0.02, ay, zp + 0.6),
    P(os + 0.18 * span, ay - 0.9, zp + 2.0),
    P(os + 0.34 * span, ay * 0.4, zf - 0.5),
    P(os + 0.5 * span, 0.16, zf + 1.0 * slack),
    P(os + 0.68 * span, 0.15, zf + 2.6 * slack),
    P(os + 0.88 * span, 0.2, zf + 1.6),
    P(ow - 0.35, 1.2, zf + 0.7),
    wrist.clone().add(new THREE.Vector3(-m * 0.1, 0.08, 0.08)),
  ];
  if (sag >= 1) return route;
  // Pulled taut: every point after the one that leaves the pillar slides toward the straight line from it to the wrist.
  const from = route[1], to = route[route.length - 1];
  return route.map((p, i) => i < 2 ? p : p.clone().lerp(from.clone().lerp(to, (i - 1) / (route.length - 2)), 1 - Math.max(0, sag)));
}

/** The eye's height above the ground, world units. */
export const EYE = 6;

/**
 * The card's camera in tabloid's frame (its page, raster and horizon, and its field of view whatever the fit): the one
 * the Devil's world is laid out with, so every size and fit builds the same world. At tabloid it is `devilCamera`.
 */
export function worldCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return tabloidFrameCamera({ fov: param(ctx, 'fov'), eye: EYE, near: 8, far: 4000 });
}

export interface Layout {
  pillar: Pillar;
  figures: Figure[];
  figZs: number[];
  doors: Door[];
  /** Each leash's route, the left first, then the right. */
  routes: THREE.Vector3[][];
}

/**
 * Where everything stands, in world units: the pillar dead centre, a figure either side facing in, a
 * door frame behind and round each, and the route of each leash from the pillar to the figure's
 * wrist. Pure layout: no drawing, so what the card says can be checked without rendering it. Laid out in tabloid's
 * frame (`worldCamera`, tabloid's page millimetres), so the figures and doors stand where the print stands them on any
 * card, which draws them with its own camera.
 */
export function devilLayout(ctx: SketchContext): Layout {
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(worldCamera(ctx).fov / 2));
  const rng = ctx.random('devil-layout');
  const v = param(ctx, 'variety');

  // The pillar, dead centre.
  const pillar = buildPillar(ctx);
  // The figures, one either side, facing in; the seed moves each a little in depth and across the page, and tilts the head.
  const figHeight = param(ctx, 'figHeight');
  const turn = param(ctx, 'figTurn');
  const figSides = [-1, 1] as const;
  // Each stands a little nearer or farther than its twin, by the seed.
  const figZs = figSides.map(side => -param(ctx, 'figDist') - side * (rng() - 0.5) * 2 * v);
  const figures: Figure[] = figSides.map((side, i) => {
    const z = figZs[i];
    return standing(side === -1 ? 'r' : 'l', side === -1 ? 90 - turn : -(90 - turn), figHeight, (side * param(ctx, 'figX') + (rng() - 0.5) * 3 * v) * -z / f, z, 5 + 5 * rng() * v);
  });
  // The doors, big and near, one at each edge of the card, mirrored. `doorShift` moves the right one alone, for a check.
  const doorDist = param(ctx, 'doorDist');
  const doors: Door[] = ([-1, 1] as const).map(side => buildDoor(ctx, side, new THREE.Vector3((side * param(ctx, 'doorX') + (side === 1 ? param(ctx, 'doorShift') : 0)) * doorDist / f, 0, -doorDist)));
  // The leashes: from the pillar to each wrist.
  const slack = param(ctx, 'leashSlack');
  const routes = ([-1, 1] as const).map(side => {
    const i = side === -1 ? 0 : 1;
    return leashRoute(side, pillar, figures[i].wrist, figZs[i], slack * (1 + (rng() - 0.5) * 0.6 * v), param(ctx, 'leashSag'));
  });
  return { pillar, figures, figZs, doors, routes };
}
