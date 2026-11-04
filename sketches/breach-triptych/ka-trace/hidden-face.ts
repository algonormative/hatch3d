import * as THREE from 'three';
import type { Point, SketchContext } from '../../../src/sketch/types.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { pathLength } from '../../kit/page.ts';
import { fitDepthRange, pageOf } from '../../kit/perspective.ts';
import { hiddenBias, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import { isoLines, meshSdf, sphere, modelPoint, perVertex, platesOn, scatterOn, sculptGeometry, toWorld, type IsoLine, type SurfacePoint, type V3 } from '../../kit/sculpt.ts';
import { sculptHead } from '../../kit/sculpt-head.ts';
import { H, MM_X, MM_Y, PAGE, W } from '../world.ts';

/**
 * The face a visor hides: a sculpted head set to the traced face (nose tip and chin on theirs), its skin in plates of
 * lines as Upward Erasure's is. Drawn in black on the colour, so the lines gather in the shadow, the reverse of the
 * silver on black: the sockets, the side of the nose and the brow's underside go dark and the form shows through.
 */

export interface FaceFit { noseTip: Point; chin: Point; yaw: number; tilt: number; plateMm: number; pitchMm: number; cross: number }

const deg = THREE.MathUtils.degToRad;
const FEATURES: V3[] = [
  [0, -0.11, 0.47], [0, 0.03, 0.4], [0, 0.17, 0.36], [0.115, 0.05, 0.36], [-0.115, 0.05, 0.36],
  [0.2, -0.03, 0.26], [-0.2, -0.03, 0.26], [0.17, 0.16, 0.3], [-0.17, 0.16, 0.3],
];

/** Lines of the hidden head on the sheet (its whole skin; the windows choose what shows). */
export function hiddenFace(ctx: SketchContext, fit: FaceFit, step = 0.011): { lines: Point[][]; seams: Point[][]; features: Point[][] } {
  // Deeper sockets than the canon's, so the eyes read as shadow through the lines.
  const sockets: [ReturnType<typeof sphere>, number][] = [[sphere([0.118, 0.045, 0.385], 0.078), -0.035], [sphere([-0.118, 0.045, 0.385], 0.078), -0.035]];
  const head = sculptHead({ noseShape: 'round', nose: 1, bulb: 0.75, chin: 0.8, jaw: 0.8, lips: 1.2, brow: 1.35, cheeks: 1.2, neck: 0.5, tilt: deg(fit.tilt), extras: sockets });
  const own = (p: V3) => head.unplace(...p);
  const S = 100;
  // The roll and the camera that put the head's nose tip and chin on the traced ones.
  let roll = 0, fov = 12, ox = 0, oy = 0;
  const transformOf = (r: number) => new THREE.Matrix4().makeRotationZ(r).multiply(new THREE.Matrix4().makeRotationY(deg(fit.yaw))).multiply(new THREE.Matrix4().makeScale(S, S, S));
  const cameraOf = (target: THREE.Vector3, f: number, x: number, y: number) => {
    const c = new THREE.PerspectiveCamera(f, W / H, 1, 1e6);
    c.position.copy(target).add(new THREE.Vector3(0, 0, 8 * S));
    c.lookAt(target);
    c.setViewOffset(W, H, x, y, W, H);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    return c;
  };
  const want = Math.hypot(fit.chin.x - fit.noseTip.x, fit.chin.y - fit.noseTip.y), wantAngle = Math.atan2(fit.chin.y - fit.noseTip.y, fit.chin.x - fit.noseTip.x);
  for (let k = 0; k < 40; k++) {
    const t = transformOf(roll), toW = (p: V3) => new THREE.Vector3(...p).applyMatrix4(t);
    const view = cameraOf(toW(head.at.noseTip), fov, ox, oy);
    const n = pageOf(view, toW(head.at.noseTip), PAGE), c = pageOf(view, toW(head.at.chin), PAGE);
    const have = Math.hypot(c.x - n.x, c.y - n.y), angle = Math.atan2(c.y - n.y, c.x - n.x);
    fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(deg(fov) / 2) * have / want));
    roll -= angle - wantAngle;
    ox += (n.x - fit.noseTip.x) / MM_X * 0.8;
    oy += (n.y - fit.noseTip.y) / MM_Y * 0.8;
  }
  const transform = transformOf(roll), toW = (p: V3) => new THREE.Vector3(...p).applyMatrix4(transform);
  const view = cameraOf(toW(head.at.noseTip), fov, ox, oy);
  const mesh = meshSdf(head.sdf, head.lo, head.hi, step, transform), geo = sculptGeometry(mesh);
  fitDepthRange(view, [geo], 0.1, { exact: true });
  const depth = renderDepthBufferCPU([geo], view, W, H), eye = modelPoint(mesh, view.position);
  const unit = Math.hypot(pageOf(view, toW([0, 0, 0]), PAGE).x - pageOf(view, toW([0, 1, 0]), PAGE).x, pageOf(view, toW([0, 0, 0]), PAGE).y - pageOf(view, toW([0, 1, 0]), PAGE).y);
  const isHead = (p: V3) => head.parts.head(...own(p)) <= head.parts.neck(...p);
  const facing = (sp: SurfacePoint) => sp.n[0] * (eye[0] - sp.p[0]) + sp.n[1] * (eye[1] - sp.p[1]) + sp.n[2] * (eye[2] - sp.p[2]) > 0;
  const light = new THREE.Vector3(0.18, 1, 0.42).normalize();
  const bright = (sp: SurfacePoint) => Math.max(0, new THREE.Vector3(...sp.n).transformDirection(transform).dot(light));

  const rng = ctx.random('ka-hidden-face');
  const seeds = scatterOn(mesh, fit.plateMm / unit, rng, isHead, FEATURES.map(head.place), own);
  const plates = platesOn(mesh, seeds, own);
  const dirs = seeds.map((seed, i) => new THREE.Vector3(1, 0.15, 0).applyAxisAngle(new THREE.Vector3(seed[0], seed[1] + 0.05, seed[2]).normalize(), (i < FEATURES.length ? 0.4 : 1) * 1.2 * (rng() * 2 - 1)));
  const style = seeds.map(() => rng());
  const pitch = fit.pitchMm / unit;
  // Lines by four: one in four even in the light, every other in the half tone, all of them in the shadow.
  const toned = (sp: SurfacePoint, line: IsoLine) => {
    const i = Math.abs(line.index), b = bright(sp);
    return i % 4 === 0 ? b < 0.97 : i % 2 === 0 ? b < 0.58 : b < 0.3;
  };
  interface Mark { points: THREE.Vector3[]; kind: 'lines' | 'seams' | 'features' }
  const marks: Mark[] = [];
  const runs = (lines: IsoLine[], okay: (sp: SurfacePoint, line: IsoLine) => boolean, kind: 'lines' | 'seams' | 'features') => {
    for (const line of lines) {
      let run: SurfacePoint[] = [];
      const flush = () => { if (run.length >= 2) marks.push({ points: toWorld(mesh, run), kind }); run = []; };
      for (const sp of line.points) { if (okay(sp, line)) run.push(sp); else flush(); }
      flush();
    }
  };
  const SEAM = 0.006;
  const field = (turn: number) => perVertex(mesh, (p, _n, v) => { const q = own(p), d = dirs[plates.plate[v]].clone().applyAxisAngle(new THREE.Vector3(q[0], q[1] + 0.05, q[2]).normalize(), turn); return q[0] * d.x + q[1] * d.y + q[2] * d.z; });
  runs(isoLines(mesh, field(0), pitch, rng() * pitch), (sp, line) => isHead(sp.p) && facing(sp) && plates.gap[sp.a ?? 0] > SEAM && toned(sp, line), 'lines');
  runs(isoLines(mesh, field(1.25), pitch * 1.6, rng() * pitch), (sp, line) => isHead(sp.p) && facing(sp) && plates.gap[sp.a ?? 0] > SEAM && style[plates.plate[sp.a ?? 0]] < fit.cross && toned(sp, line), 'lines');
  runs(isoLines(mesh, plates.gap, 1, 0, [0.002]), sp => isHead(sp.p) && facing(sp), 'seams');
  // The closed lids and the brow's line, walked onto the surface.
  const onFace = (x: number, y: number): THREE.Vector3 | undefined => {
    let outside = 0.74;
    for (let z = 0.73; z >= 0.1; z -= 0.008) {
      if (head.parts.head(x, y, z) <= 0) return toW(head.place([x, y, (outside + z) / 2 + 0.004]));
      outside = z;
    }
    return undefined;
  };
  const curve = (f: (t: number) => [number, number], n = 24) => { const pts: THREE.Vector3[] = []; for (let i = 0; i <= n; i++) { const [x, y] = f(i / n); const q = onFace(x, y); if (q) pts.push(q); } if (pts.length >= 2) marks.push({ points: pts, kind: 'features' }); };
  for (const side of [1, -1]) {
    curve(t => { const u = t * 2 - 1; return [side * (0.12 + 0.075 * u), 0.04 - 0.022 * (1 - u * u)]; });
    curve(t => { const u = t * 2 - 1; return [side * (0.12 + 0.075 * u), 0.04 + 0.03 * (1 - u * u)]; });
    curve(t => { const u = t * 2 - 1; return [side * (0.135 + 0.11 * u), 0.135 + 0.025 * (1 - u * u) - 0.02 * u * side * side]; });
  }
  curve(t => [0, 0.05 - 0.18 * t]);
  // The sockets' shadow, walked on in rows and again across them, so the eyes read as two dark shapes under the pattern;
  // and the shadowed side of the nose. Each row stays inside its ellipse.
  const rows = (cx: number, cy: number, rx: number, ry: number, spacing: number, slant: number) => {
    for (let v = -ry; v <= ry; v += spacing) {
      const half = rx * Math.sqrt(Math.max(0, 1 - (v / ry) ** 2));
      if (half < 0.012) continue;
      curve(t => { const u = -half + 2 * half * t; return [cx + u + slant * v, cy + v - slant * u]; }, 14);
    }
  };
  const gap = fit.pitchMm * 0.95 / unit;
  for (const side of [1, -1]) {
    rows(side * 0.122, 0.052, 0.098, 0.066, gap, 0);
    rows(side * 0.122, 0.052, 0.084, 0.058, gap * 1.25, side * 0.8);
  }
  rows(0.046, -0.06, 0.03, 0.1, gap, 0);

  const bias = hiddenBias(view, 0.012 * S, view.position.distanceTo(toW(head.at.noseTip)));
  const out = { lines: [] as Point[][], seams: [] as Point[][], features: [] as Point[][] };
  projectStrokes(marks, { view, depth, width: W, height: H, bias }, {
    begin: (mark: Mark) => (found: ProjectedPoint[][]) => {
      for (const run of found) { const piece = scalePoints(run, MM_X, MM_Y); if (pathLength(piece) >= 0.8) out[mark.kind].push(piece); }
    },
  });
  geo.dispose();
  return out;
}
