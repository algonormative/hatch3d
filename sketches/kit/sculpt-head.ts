import { blend, capsule, ellipsoid, smin, sphere, type Sdf, type V3 } from './sculpt.ts';

/**
 * A sculpted head and neck for the pen: an androgynous, idealised head (a mannequin's or a statue's), about 1 unit from
 * chin to crown, x to its left, y up, z forward (the face), the origin about level with the ears. Built from smooth
 * unions of ellipsoids and round cones (`kit/sculpt.ts`); its landmarks place the features drawn as lines (nostrils, the
 * lips' parting, the ear's rims) and anything that follows the face (a line from the lip down the throat).
 */
export interface HeadOptions {
  /** How long the neck runs below the jaw (units). */
  neck?: number;
  /** The neck's radius. */
  neckR?: number;
  /** How far the chin and jaw stand out (1 = the canon; more is a stronger jaw). */
  jaw?: number;
  /** Nose length (1 = the canon). */
  nose?: number;
  /** How far the head tips back on the neck (radians; the face turns up). */
  tilt?: number;
  /** How far it turns to its left on the neck (radians). */
  turn?: number;
}

export interface Head {
  sdf: Sdf;
  /** A point in the head's own frame (before the tilt and turn) in the mesh's, and back. */
  place: (q: V3) => V3;
  unplace: (x: number, y: number, z: number) => V3;
  /** The head alone in its own frame, and the neck alone in the mesh's: which is nearer says head or neck. */
  parts: { head: Sdf; neck: Sdf };
  /** The box the head and neck lie in, for meshing. */
  lo: V3; hi: V3;
  /** Landmarks, on or just off the surface. */
  at: {
    noseTip: V3; noseRoot: V3; nostrils: [V3, V3]; lipUpper: V3; lipLower: V3; mouth: [V3, V3]; chin: V3; chinUnder: V3;
    eyes: [V3, V3]; brow: V3; ears: [V3, V3]; crown: V3; throat: V3; neckBase: V3;
  };
}

const mirror = (p: V3): V3 => [-p[0], p[1], p[2]];
const both = (p: V3, f: (q: V3) => Sdf): Sdf => { const a = f(p), b = f(mirror(p)); return (x, y, z) => Math.min(a(x, y, z), b(x, y, z)); };

/** Where the head pivots on the neck (the top of the spine, under the skull). */
const PIVOT: V3 = [0, -0.2, -0.08];

export function sculptHead(options: HeadOptions = {}): Head {
  const neck = options.neck ?? 1.0, neckR = options.neckR ?? 0.15, jaw = options.jaw ?? 1, nose = options.nose ?? 1.25;
  // The head's frame on the neck's: tipped back by `tilt` (about x, the face toward +y), then turned by `turn` (about y).
  const tilt = options.tilt ?? 0, turn = options.turn ?? 0;
  const ct = Math.cos(tilt), st = Math.sin(tilt), cu = Math.cos(turn), su = Math.sin(turn);
  /** A point of the head (its own frame) in the neck's. */
  const place = (q: V3): V3 => {
    const x = q[0] - PIVOT[0], y = q[1] - PIVOT[1], z = q[2] - PIVOT[2];
    const y1 = y * ct + z * st, z1 = -y * st + z * ct;
    return [PIVOT[0] + x * cu + z1 * su, PIVOT[1] + y1, PIVOT[2] - x * su + z1 * cu];
  };
  /** The inverse: a point of the neck's frame in the head's. */
  const unplace = (x0: number, y0: number, z0: number): V3 => {
    const x = x0 - PIVOT[0], y = y0 - PIVOT[1], z = z0 - PIVOT[2];
    const x1 = x * cu - z * su, z1 = x * su + z * cu;
    return [PIVOT[0] + x1, PIVOT[1] + y * ct - z1 * st, PIVOT[2] + y * st + z1 * ct];
  };
  const base = ellipsoid([0, 0.13, -0.07], [0.30, 0.39, 0.40]);
  const tip: V3 = [0, -0.125, 0.40 + 0.075 * nose];
  const chin: V3 = [0, -0.405, 0.28 + 0.03 * jaw];
  const neckEnd: V3 = [0, -0.22 - neck, -0.01];
  const head = blend(base,
    // The face's mass, the cheekbones, the brow.
    [ellipsoid([0, -0.08, 0.10], [0.27, 0.36, 0.30]), 0.12],
    [both([0.18, -0.02, 0.21], p => sphere(p, 0.08)), 0.12],
    [capsule([-0.19, 0.11, 0.30], [0.19, 0.11, 0.30], 0.05), 0.08],
    // The jaw from below the ears to the chin, and the chin.
    [both([0.25, -0.18, -0.04], p => capsule(p, [Math.sign(p[0]) * 0.08, -0.40, 0.25 + 0.02 * jaw], 0.06 * jaw)), 0.08],
    [ellipsoid(chin, [0.09, 0.07, 0.07]), 0.06],
    // Eye sockets carved under the brow, and the eyes in them.
    [both([0.115, 0.05, 0.345], p => sphere(p, 0.05)), -0.05],
    [both([0.115, 0.045, 0.285], p => sphere(p, 0.05)), 0.03],
    // The underside of the jaw, from the chin back toward the neck: the plane an upturned face shows.
    [capsule([0, -0.44, 0.20], [0, -0.36, -0.04], 0.075, 0.09), 0.09],
    // The nose: the bridge to the tip, the tip, the wings.
    [capsule([0, 0.04, 0.36], [tip[0], tip[1] + 0.005, tip[2] - 0.005], 0.03, 0.045), 0.05],
    [sphere(tip, 0.045), 0.03],
    [both([0.045, -0.15, 0.36 + 0.05 * nose], p => sphere(p, 0.035)), 0.03],
    // The lips: the upper with its bow, the lower, their parting, and the groove under the lower.
    [ellipsoid([0, -0.25, 0.30], [0.12, 0.10, 0.10]), 0.06],
    [capsule([-0.055, -0.235, 0.385], [0.055, -0.235, 0.385], 0.024), 0.05],
    [sphere([0, -0.228, 0.398], 0.026), 0.03],
    [capsule([-0.045, -0.28, 0.37], [0.045, -0.28, 0.37], 0.028), 0.05],
    [capsule([-0.07, -0.256, 0.42], [0.07, -0.256, 0.42], 0.006), -0.012],
    [capsule([-0.05, -0.33, 0.37], [0.05, -0.33, 0.37], 0.012), -0.03],
    // The ears.
    [both([0.31, -0.02, -0.04], p => ellipsoid(p, [0.035, 0.12, 0.075])), 0.03],
    // Each ear's bowl, inside its rim.
    [both([0.35, -0.03, -0.035], p => ellipsoid(p, [0.03, 0.085, 0.05])), -0.015],
  );
  // The neck, upright, its two long muscles from behind the ears (where the head has put them) to the collarbones'
  // notch; the head on it.
  const behind = [place([0.23, -0.12, -0.08]), place([-0.23, -0.12, -0.08])];
  const neckSdf = blend(capsule([0, -0.12, -0.07], neckEnd, neckR, neckR * 1.08),
    [capsule(behind[0], [0.05, neckEnd[1] + 0.1, 0.13], 0.045), 0.08],
    [capsule(behind[1], [-0.05, neckEnd[1] + 0.1, 0.13], 0.045), 0.08],
  );
  const sdf: Sdf = (x, y, z) => { const q = unplace(x, y, z); return smin(head(q[0], q[1], q[2]), neckSdf(x, y, z), 0.1); };
  const P = place;
  return {
    sdf,
    lo: [-0.6, neckEnd[1] - 0.05, -0.75], hi: [0.6, 0.75, 0.75],
    place, unplace, parts: { head, neck: neckSdf },
    at: {
      noseTip: P([tip[0], tip[1], tip[2] + 0.045]), noseRoot: P([0, 0.04, 0.39]),
      nostrils: [P([0.028, -0.165, 0.43 + 0.03 * nose]), P([-0.028, -0.165, 0.43 + 0.03 * nose])],
      lipUpper: P([0, -0.235, 0.41]), lipLower: P([0, -0.282, 0.398]), mouth: [P([0.07, -0.256, 0.40]), P([-0.07, -0.256, 0.40])],
      chin: P([chin[0], chin[1], chin[2] + 0.07]), chinUnder: P([0, -0.47, 0.22]),
      eyes: [P([0.12, 0.05, 0.37]), P([-0.12, 0.05, 0.37])], brow: P([0, 0.11, 0.35]), ears: [P([0.345, -0.02, -0.04]), P([-0.345, -0.02, -0.04])],
      crown: P([0, 0.53, -0.06]), throat: [0, -0.62, 0.15], neckBase: [0, neckEnd[1], 0.15],
    },
  };
}
