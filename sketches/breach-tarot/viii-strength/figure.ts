import * as THREE from 'three';
import { bodyMeshes, contourTube } from '../../kit/mannequin/body.ts';
import { flowBody, ribbonStrokes } from '../../kit/mannequin/gesture.ts';
import { LOOK, type Look } from '../../kit/mannequin/hatch.ts';
import type { Skeleton } from '../../kit/mannequin/skeleton.ts';
import type { ClothStroke, Tube } from '../../kit/mannequin/tube.ts';
import { clamp } from '../../kit/params.ts';
import { pageOf } from '../../kit/perspective.ts';

/**
 * The person as the deck's current figures are made (VI Lovers, XV Devil): the kit's flowing body, bare, a
 * third fuller in the limbs and trunk than the canon, in plain carbon. Each limb is one tapering tube from root
 * to tip, so a hand and a foot each get one silhouette. Long bands run the length of every limb and wind slowly
 * round it, their lines coming in where the light leaves them dark; the head is a blank egg, thinly ringed and
 * outlined by the hull of its surface. Copied from those cards' `figures.ts`, not imported.
 */
const BUILD = 1.3;

/** Plain carbon throughout, so the figure stays one pen beside the wall's hatch. */
const BODY_LOOK: Look = { ...LOOK, cloth: 'carbon', accent: 'carbon', edge: 'carbon', crease: 'carbon', detail: 'carbon', figure: 'figure', contour: 'figure', family: 'hatch' };

/** A head's outline on the page: the hull of its surface as the eye sees it, so a crown or chin seen end-on is not lost. */
function headOutline(head: Tube, view: THREE.Camera, look: Look): ClothStroke {
  const pts: { p: THREE.Vector3; x: number; y: number }[] = [];
  for (let i = 0; i <= 40; i++) for (let j = 0; j < 48; j++) {
    const p = head.point(i / 40, j / 48, 0.012);
    const q = pageOf(view, p);
    pts.push({ p, x: q.x, y: q.y });
  }
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: typeof pts[0], a: typeof pts[0], b: typeof pts[0]) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: typeof pts = [], upper: typeof pts = [];
  for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  const ring = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return { ink: look.edge, group: look.contour, family: 'hatch', points: [...ring, ring[0]].map(q => q.p) };
}

/** The same shape as `person` in geometry.ts: strokes, the closed surfaces for the depth pass, and the figure's bounds on the sheet. */
export function bodyPerson(s: Skeleton, view: THREE.PerspectiveCamera) {
  const body = flowBody(s, { build: BUILD, toes: 'point' });
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const light = new THREE.Vector3(-0.5, 0.55, 0.7).normalize();
  const env = {
    forward, density: 0.4,
    screen: (p: THREE.Vector3) => pageOf(view, p),
    dark: (_p: THREE.Vector3, normal: THREE.Vector3) => clamp(0.9 * (1 - Math.max(0, normal.dot(light))) ** 1.3 + 0.04, 0, 1),
  };
  const head = body.head!;
  const strokes: ClothStroke[] = [
    ...ribbonStrokes({ ...body, head: undefined }, env, BODY_LOOK, { bands: 6, fill: 0.58, twist: 0.3, lines: 6 }),
    ...contourTube(head, { ...env, dark: (p, nrm) => Math.max(0, env.dark(p, nrm) - 0.35) }, BODY_LOOK, s.height * 0.012),
    headOutline(head, view, BODY_LOOK),
  ];
  const pts = [...s.joints.values()].flatMap(j => [pageOf(view, j.origin), pageOf(view, j.end)]);
  const bounds = { x0: Math.min(...pts.map(p => p.x)) - 1.5, x1: Math.max(...pts.map(p => p.x)) + 1.5, y0: Math.min(...pts.map(p => p.y)) - 1.5, y1: Math.max(...pts.map(p => p.y)) + 1.5 };
  return { strokes, meshes: bodyMeshes(body, 0.7), bounds };
}
