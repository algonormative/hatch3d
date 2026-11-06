import type { Point } from '../../src/sketch/types.ts';
import { mulberry32 } from '../../packages/plot-core/src/prng.ts';
import { contours, grid, lengthOf, reduce, stripes, valueNoise } from './field.ts';

/**
 * The figure: a frontal icon. The face and neck are the only smooth form; the hair and robe are one stripe field; the
 * halo is a fan of wires. Everything is authored in a local frame (x from the axis, y from the crown, both in the
 * table's units) and carried to the page by `world`, so a roll of the head or a change of scale reaches every part.
 */

export const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const gauss = (a: number, b = 0) => Math.exp(-a * a - b * b);
const hash = (a: number, b: number, c = 0) => {
  let v = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
};

function profile(rows: [number, number][]): (y: number) => number {
  return y => {
    if (y <= rows[0][0] || y >= rows[rows.length - 1][0]) return 0;
    let i = 0;
    while (rows[i + 1][0] < y) i++;
    const p1 = rows[i], p2 = rows[i + 1], p0 = rows[Math.max(0, i - 1)], p3 = rows[Math.min(rows.length - 1, i + 2)];
    const t = (y - p1[0]) / (p2[0] - p1[0]), h = p2[0] - p1[0];
    const m1 = (p2[1] - p0[1]) / (p2[0] - p0[0]) * h, m2 = (p3[1] - p1[1]) / (p3[0] - p1[0]) * h;
    const t2 = t * t, t3 = t2 * t;
    return Math.max(0, (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2);
  };
}

const BODY = profile([[0, 0], [1, 12], [4, 21], [11, 28], [24, 33], [48, 35], [80, 37], [104, 39], [116, 44], [128, 62], [143, 86], [163, 108], [188, 128], [213, 146], [240, 164], [460, 310]]);
const FACE = profile([[17, 0], [18, 5], [22, 15], [28, 22], [40, 26], [54, 25.2], [64, 22], [72, 16], [78, 8], [81, 0]]);
const NECK = profile([[72, 11.5], [90, 11.8], [108, 13], [124, 13.6], [134, 8], [141, 0]]);
const EYE_Y = 47, EYE_X = 12.3, EYE_HALF = 7.1;

export type Drape = 'fan' | 'plumb' | 'cope' | 'radial' | 'tide';
export type FaceMode = 'engraved' | 'contour' | 'void' | 'die';
export type EyeMode = 'open' | 'closed' | 'lit' | 'none';
export type Eroded = 'hem' | 'left' | 'right' | 'centre';
export type HaloForm = 'round' | 'octagon' | 'square' | 'none';

export interface FigureShape {
  cx: number; top: number; scale: number; flare: number; hair: number; neck: number; roll: number;
  page: { width: number; height: number; margin: number };
  dissolve: number; eroded: Eroded; block: number;
  drape: Drape; wavelength: number; taper: number; order: number; rigid: number; folds: number; swag: number; flaw: number; ridge: number; shade: number; bodySeed: number;
}
export interface FaceShape {
  face: FaceMode; eyes: EyeMode; eyeSize: number; mouth: boolean; thirdEye: boolean;
  faceWidth: number; faceLength: number; light: number; lineAngle: number; pitch: number; glitch: number; bend: number;
}
export interface HaloShape {
  form: HaloForm; y: number; reach: number; span: number; count: number; rhythm: number; jog: number; rings: number;
}

/** The frame and the silhouette: cheap, and shared by every other part. */
export interface Frame {
  world: (dx: number, yy: number) => Point;
  local: (x: number, y: number) => { dx: number; yy: number; turn: number };
  /** Whole silhouette, ignoring any dissolve. */
  whole: (x: number, y: number) => boolean;
  /** The figure as drawn: is a page point within `grow` mm of it? */
  near: (x: number, y: number, grow: number) => boolean;
  stripeInside: (x: number, y: number) => boolean;
  inFace: (x: number, y: number, g?: number) => boolean;
  inNeck: (x: number, y: number, g?: number) => boolean;
  bodyAt: (yy: number) => number;
  neckAt: (yy: number) => number;
  faceAt: (yy: number) => number;
}

export function frame(o: FigureShape, f: Pick<FaceShape, 'faceWidth' | 'faceLength'>): Frame {
  const { cx, top, scale: S, neck: dn } = o;
  const pivot = 118 + dn, roll = o.roll * Math.PI / 180;
  const turnAt = (yy: number) => roll * (1 - smooth(pivot - 26, pivot + 2, yy));
  const world = (dx: number, yy: number): Point => {
    const a = turnAt(yy), c = Math.cos(a), s = Math.sin(a), ly = yy - pivot;
    return { x: cx + (dx * c - ly * s) * S, y: top + (pivot + dx * s + ly * c) * S };
  };
  const local = (x: number, y: number) => {
    const px = (x - cx) / S, py = (y - top) / S - pivot;
    let yy = py + pivot, dx = px, a = 0;
    if (roll) for (let i = 0; i < 4; i++) {
      a = turnAt(yy);
      const c = Math.cos(a), s = Math.sin(a);
      dx = px * c + py * s;
      yy = pivot - px * s + py * c;
    }
    return { dx, yy, turn: a };
  };
  const bodyAt = (yy: number) => {
    const y = yy < 104 ? yy : Math.max(104, yy - dn);
    const w = BODY(y);
    if (y < 104) return w * (1 + (o.hair - 1) * smooth(0, 6, y));
    const hairW = 39 * o.hair, spread = Math.max(0, w - 39) * o.flare;
    return hairW + spread;
  };
  const neckAt = (yy: number) => NECK(yy < 90 ? yy : Math.max(90, yy - dn));
  const faceY = (yy: number) => 48 + (yy - 48) / f.faceLength;
  const faceAt = (yy: number) => FACE(faceY(yy)) * f.faceWidth;
  const inFace = (x: number, y: number, g = 0) => { const l = local(x, y); return Math.abs(l.dx) < faceAt(l.yy) + g / S && faceAt(l.yy) > 0; };
  const inNeck = (x: number, y: number, g = 0) => { const l = local(x, y); return l.yy > 74 && neckAt(l.yy) > 0 && Math.abs(l.dx) < neckAt(l.yy) + g / S; };
  const whole = (x: number, y: number) => { const l = local(x, y); return Math.abs(l.dx) < bodyAt(l.yy); };

  // Erosion by square blocks, so the figure comes away like a floorplan rather than fraying.
  const slow = valueNoise(o.bodySeed + 71);
  const gone = (x: number, y: number) => {
    if (o.dissolve <= 0) return false;
    const l = local(x, y);
    const w = Math.max(bodyAt(l.yy), 1);
    const shoulder = 104 + dn;
    let t: number;
    switch (o.eroded) {
      case 'left': t = smooth(-0.05, -1, l.dx / w); break;
      case 'right': t = smooth(0.05, 1, l.dx / w); break;
      case 'centre': t = (1 - Math.abs(l.dx / w)) * smooth(shoulder, shoulder + 40, l.yy); break;
      default: t = smooth(shoulder, (o.page.height - top) / S, l.yy);
    }
    const bx = Math.floor(x / o.block), by = Math.floor(y / o.block);
    const n = hash(bx, by, o.bodySeed) * 0.55 + slow(x / 48, y / 48) * 0.45;
    return n < o.dissolve * 1.5 * Math.pow(t, 1.2) - 0.05;
  };
  const m = o.page.margin;
  const stripeInside = (x: number, y: number) => {
    if (x < m || y < m || x > o.page.width - m || y > o.page.height - m) return false;
    if (!whole(x, y) || inFace(x, y, 1.7) || inNeck(x, y, 1.7)) return false;
    return !gone(x, y);
  };

  // A distance map of what is drawn, by chamfer: the board's keep-out follows the figure into every hole it leaves.
  const CELL = 1;
  const w = Math.ceil(o.page.width / CELL), h = Math.ceil(o.page.height / CELL);
  const dist = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = (i + 0.5) * CELL, y = (j + 0.5) * CELL;
    dist[j * w + i] = stripeInside(x, y) || inFace(x, y) || inNeck(x, y) ? 0 : 1e6;
  }
  const D = Math.SQRT2;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i; let v = dist[k];
    if (i) v = Math.min(v, dist[k - 1] + 1);
    if (j) { v = Math.min(v, dist[k - w] + 1); if (i) v = Math.min(v, dist[k - w - 1] + D); if (i < w - 1) v = Math.min(v, dist[k - w + 1] + D); }
    dist[k] = v;
  }
  for (let j = h - 1; j >= 0; j--) for (let i = w - 1; i >= 0; i--) {
    const k = j * w + i; let v = dist[k];
    if (i < w - 1) v = Math.min(v, dist[k + 1] + 1);
    if (j < h - 1) { v = Math.min(v, dist[k + w] + 1); if (i < w - 1) v = Math.min(v, dist[k + w + 1] + D); if (i) v = Math.min(v, dist[k + w - 1] + D); }
    dist[k] = v;
  }
  const near = (x: number, y: number, grow: number) => {
    const i = Math.floor(x / CELL), j = Math.floor(y / CELL);
    if (i < 0 || j < 0 || i >= w || j >= h) return false;
    return dist[j * w + i] <= grow;
  };
  return { world, local, whole, near, stripeInside, inFace, inNeck, bodyAt, neckAt, faceAt };
}

/** Hair and robe as closed ridge loops. */
export function bodyLines(o: FigureShape, fr: Frame): Point[][] {
  const noise = valueNoise(o.bodySeed + 11), wander = valueNoise(o.bodySeed + 23), patch = valueNoise(o.bodySeed + 29);
  const dn = o.neck;
  // Where the flaw falls is the seed's to decide.
  const flawX = (hash(o.bodySeed, 3) < 0.5 ? -1 : 1) * (40 + 50 * hash(o.bodySeed, 5)), flawY = 150 + 50 * hash(o.bodySeed, 7);
  const direction = (x: number, y: number) => {
    const { dx, yy, turn } = fr.local(x, y);
    const side = dx < 0 ? -1 : 1, w = Math.max(fr.bodyAt(yy), 1);
    // Hair: strands from a centre parting, turning to fall.
    const fall = smooth(4, 42, yy);
    const hairA = (0.15 + 0.85 * fall) * Math.PI / 2 + 0.16 * Math.sin(yy / 9 + side);
    const hx = side * Math.cos(hairA), hy = Math.sin(hairA);
    const robe = smooth(100 + dn, 122 + dn, yy), ny = 118 + dn;
    let rx = 0, ry = 1;
    switch (o.drape) {
      case 'fan': rx = (fr.bodyAt(yy + 2) - fr.bodyAt(yy - 2)) / 4 * (dx / w); break;
      case 'cope': rx = -(yy - ny); ry = dx; if (rx > 0) { rx = -rx; ry = -ry; } break;
      case 'radial': rx = dx; ry = yy - ny + 4; break;
      case 'tide': rx = 1; ry = 0.22 * Math.sin(dx / 17 + yy / 40); break;
      default:
    }
    const rl = Math.hypot(rx, ry) || 1;
    let c2 = 0, s2 = 0;
    const add = (ax: number, wt: number) => { c2 += wt * Math.cos(2 * ax); s2 += wt * Math.sin(2 * ax); };
    add(Math.atan2(hy, hx), 1 - robe);
    add(Math.atan2(ry / rl, rx / rl), robe);
    // Swags across the chest, and one panel of drapery knocked off the centre so the symmetry has a flaw.
    if (o.swag) add(Math.atan2((dx - 3) * 0.009 + 0.25 * Math.sin(yy / 7), 1), o.swag * 1.3 * gauss((dx - 3) / 62, (yy - 172 - dn) / 16));
    if (o.flaw) add(Math.sin(yy / 3.2) > 0 ? 0.75 : -0.75, o.flaw * 1.6 * gauss((dx - flawX) / 26, (yy - flawY - dn) / 20));
    const a = Math.atan2(s2, c2) / 2 + turn;
    // A rigid patch snaps to the board's own angles: there the ridges bend like traces, at 45 degrees.
    if (patch(x / 44, y / 44) < o.rigid * 1.3 - 0.15) return Math.round(a / (Math.PI / 4)) * Math.PI / 4;
    return a + o.folds * (noise(x / 26, y / 26) - 0.5);
  };
  const order = (x: number, y: number) => {
    const { dx, yy } = fr.local(x, y);
    const temple = gauss((Math.abs(dx) - 31 * o.hair) / 7, (yy - 50) / 8);
    return temple > 0.35 || wander(x / 34, y / 34) < o.order ? 0 : 1;
  };
  // Ridges open up towards the hem and, with `shade`, down the far side of each fold: spacing is the only tone gold has.
  const taper = Math.max(o.taper, 1 + 1.3 * o.shade);
  const hemShare = taper > 1 ? Math.log(o.taper) / Math.log(taper) : 0;
  const coarsen = (x: number, y: number) => {
    const { dx, yy } = fr.local(x, y), w = Math.max(fr.bodyAt(yy), 1);
    const hem = smooth(110 + dn, 250 + dn, yy) * hemShare;
    if (!o.shade) return hem;
    const fold = Math.pow(0.5 + 0.5 * Math.sin(dx / w * 11 + 5 * noise(x / 60, y / 90)), 2.2);
    const away = smooth(-0.2, 1, dx / w);
    return hem + o.shade * smooth(100 + dn, 128 + dn, yy) * (0.75 * fold + 0.35 * away);
  };
  const g = grid(0, 0, o.page.width, o.page.height, 0.5);
  stripes(g, { wavelength: o.wavelength, taper, coarsen, direction, inside: fr.stripeInside, order, random: mulberry32(o.bodySeed * 7919 + 13) });
  return contours(g, o.ridge).filter(l => lengthOf(l) > 3).map(l => reduce(l, 0.05));
}

/** Face and neck. Returns gold lines and whatever the accent pen should take. */
export function faceLines(o: FigureShape, f: FaceShape, fr: Frame): { lines: Point[][]; features: Point[][]; accent: Point[][] } {
  const S = o.scale, dn = o.neck;
  const fy = (yy: number) => 48 + (yy - 48) / f.faceLength, fw = f.faceWidth;
  const chin = 48 + (81 - 48) * f.faceLength;
  const relief = (dx0: number, yy0: number) => {
    if (yy0 > chin - 2) {
      const w = Math.max(fr.neckAt(yy0), 1);
      return 7 * Math.sqrt(Math.max(0, 1 - (dx0 / (w + 0.5)) ** 2));
    }
    const dx = dx0 / fw, yy = fy(yy0), ad = Math.abs(dx);
    const u = dx / 28.5, v = (yy - 48) / 36;
    let h = 12 * Math.sqrt(Math.max(0, 1 - u * u)) * (1 - 0.22 * v * v);
    const up = smooth(34, 42, yy) * (1 - smooth(60, 64.5, yy));
    const nw = 1.7 + 0.1 * Math.max(0, yy - 36);
    h += up * (2.8 + 2.8 * smooth(36, 60, yy)) * gauss(dx / nw);
    h += 1.6 * gauss(dx / 3.2, (yy - 61) / 2.5);
    h -= 2.9 * gauss((ad - 12) / 7.2, (yy - 46) / 4.5);
    h += 1.7 * gauss((ad - 12) / 5.2, (yy - 46.5) / 2.5);
    h += 1.4 * gauss((ad - 12) / 10, (yy - 39.5 - 0.02 * (ad - 12) ** 2) / 1.9);
    h += 1.6 * gauss((ad - 15) / 7, (yy - 60) / 7);
    if (f.mouth) {
      h += 1.3 * gauss(dx / 6, (yy - 68.6) / 1.1) + 1.6 * gauss(dx / 4.6, (yy - 71.6) / 1.3);
      h -= 1.2 * gauss(dx / 5.5, (yy - 70) / 0.4);
      h -= 0.8 * gauss(dx / 4, (yy - 74) / 1);
    }
    h += 1.3 * gauss(dx / 5.5, (yy - 76.5) / 2.2);
    return h;
  };
  const az = f.light * Math.PI / 180;
  const L = [Math.sin(az) * 0.72, -Math.cos(az) * 0.72, 0.69];
  const tone = (dx: number, yy: number) => {
    const e = 0.4;
    const hx = (relief(dx + e, yy) - relief(dx - e, yy)) / (2 * e), hy = (relief(dx, yy + e) - relief(dx, yy - e)) / (2 * e);
    const lam = (-hx * L[0] - hy * L[1] + L[2]) / Math.hypot(hx, hy, 1);
    let t = Math.pow(Math.max(0, lam), 1.5) * 1.05;
    if (yy > chin - 2) t *= 0.15 + 0.85 * smooth(chin + 3, chin + 25 + dn * 0.5, yy);
    return t;
  };
  const eyeArc = (t: number) => Math.sin(Math.PI * Math.pow(t, 0.8));
  const eyeSpan = EYE_HALF * f.eyeSize, eyeIn = EYE_X - eyeSpan;
  const eyeOpen = (dx: number, yy: number) => {
    if (f.eyes === 'closed' || f.eyes === 'none') return false;
    const ad = Math.abs(dx / fw), y = fy(yy);
    const t = (ad - eyeIn) / (2 * eyeSpan);
    if (t <= 0 || t >= 1) return false;
    const arc = eyeArc(t) * f.eyeSize;
    return y > EYE_Y - 3.3 * arc && y < EYE_Y + 1.9 * arc;
  };
  const lines: Point[][] = [], features: Point[][] = [], accent: Point[][] = [];
  const P = fr.world;

  const a = fr.world(0, 0);
  const pad = 34 * S * Math.max(fw, 1);
  const y1 = Math.min(o.page.height - o.page.margin, fr.world(0, 145 + dn).y + 8);
  const box = { x0: a.x - pad - Math.abs(o.roll) * 2, x1: a.x + pad + Math.abs(o.roll) * 2, y0: fr.world(0, 12).y - 12, y1 };
  const G = grid(box.x0, box.y0, box.x1, box.y1, 0.2);
  const pitch = f.face === 'contour' ? f.pitch * 0.9 : f.pitch;
  // How far apart lines of this tier stand here, in mm: the level spacing over the field's slope, read from the grid.
  const spacing = (x: number, y: number, n: number) => {
    const i = Math.min(G.w - 2, Math.max(1, Math.round((x - G.x0) / 0.2))), j = Math.min(G.h - 2, Math.max(1, Math.round((y - G.y0) / 0.2)));
    const k = j * G.w + i;
    const slope = Math.hypot(G.data[k + 1] - G.data[k - 1], G.data[k + G.w] - G.data[k - G.w]) / 0.4;
    return pitch / Math.max(slope, 1e-3) * (n % 4 === 0 ? 4 : n % 2 === 0 ? 2 : 1);
  };
  const open = (x: number, y: number, n: number) => {
    const inF = fr.inFace(x, y, -0.7), inN = !fr.inFace(x, y, 0.8) && fr.inNeck(x, y, -0.7);
    if (!inF && !inN) return false;
    const { dx, yy } = fr.local(x, y);
    // Under the clean pitch but over the fuse pitch: a lit plane may close up towards solid gold, never fill in.
    if (spacing(x, y, n) < 0.68) return false;
    if (inF && eyeOpen(dx, yy)) return false;
    if (f.face === 'void' || f.face === 'die') return inN && tone(dx, yy) > (n % 4 === 0 ? 0.1 : n % 2 === 0 ? 0.36 : 0.6);
    if (f.face === 'contour') return true;
    // Each line has its own threshold within its tier, so the shadow's edge frays instead of stepping.
    const j = hash(n, 7) * 0.09;
    const tier = n % 4 === 0 ? 0.08 + j : n % 2 === 0 ? 0.32 + j : 0.55 + j;
    return tone(dx, yy) > tier;
  };
  const cuts = (points: Point[], n: number) => {
    let run: Point[] = [];
    const flush = () => { if (lengthOf(run) > 0.9) lines.push(reduce(run, 0.03)); run = []; };
    for (const p of points) { if (open(p.x, p.y, n)) run.push(p); else flush(); }
    flush();
  };
  const la = f.lineAngle * Math.PI / 180, lc = Math.cos(la), ls = Math.sin(la);
  // Scanlines, or for `contour` the relief's own level sets: a contour map of a face.
  const contourMode = f.face === 'contour';
  for (let j = 0; j < G.h; j++) for (let i = 0; i < G.w; i++) {
    const { dx, yy } = fr.local(box.x0 + i * 0.2, box.y0 + j * 0.2);
    G.data[j * G.w + i] = contourMode ? relief(dx, yy) : (yy * lc + dx * ls + (f.bend * relief(dx, yy) + 0.012 * dx * dx)) * S;
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of G.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const n0 = Math.ceil(lo / pitch), n1 = Math.floor(hi / pitch);
  for (let n = n0; n <= n1; n++) for (const line of contours(G, n * pitch + 0.0137)) cuts(line, n);
  // A glitch: bands of the face's lines slipped sideways, as a scan loses sync.
  if (f.glitch > 0) {
    const bandH = 2.6 * S;
    const slipped: Point[][] = [];
    for (const line of lines) {
      let run: Point[] = [];
      const flush = () => { if (lengthOf(run) > 0.9) slipped.push(run); run = []; };
      for (const q of line) {
        const band = Math.floor(q.y / bandH);
        const shift = hash(band, 91) < f.glitch * 0.5 ? (hash(band, 37) - 0.5) * 22 * f.glitch : 0;
        const moved = { x: q.x + shift, y: q.y };
        if (fr.inFace(moved.x, moved.y, -0.7) || fr.inNeck(moved.x, moved.y, -0.7)) run.push(moved); else flush();
      }
      flush();
    }
    lines.length = 0;
    lines.push(...slipped);
  }

  const side = (w: (y: number) => number, a0: number, b: number, s: number): Point[] => {
    const out: Point[] = [];
    for (let y = a0; y <= b + 1e-6; y += 0.6) out.push(P(s * w(y), y));
    return out;
  };
  const faceTop = 48 + (17.05 - 48) * f.faceLength, faceEnd = 48 + (80.95 - 48) * f.faceLength;
  features.push([...side(fr.faceAt, faceTop, faceEnd, -1).reverse(), ...side(fr.faceAt, faceTop, faceEnd, 1)]);
  const lid = (s: number, off: number, k: number): Point[] => {
    const out: Point[] = [];
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const y = EYE_Y + (k * eyeArc(t) * f.eyeSize + off);
      out.push(P(s * fw * (eyeIn + 2 * eyeSpan * t), 48 + (y - 48) * f.faceLength));
    }
    return out;
  };
  for (const s of [-1, 1]) {
    const neckTop = chin + 3;
    features.push(side(fr.neckAt, neckTop, 124 + dn, s));
    features.push([P(s * 13.6, 124 + dn), P(0, 141 + dn)]);
    if (f.eyes === 'closed') {
      features.push(lid(s, 0, 1.9), lid(s, 0.5, 1.9));
    } else if (f.eyes !== 'none') {
      features.push(lid(s, 0, -3.3), lid(s, -0.5, -3.3), lid(s, 0, 1.9));
      if (f.eyes === 'lit') {
        // The eye filled, a boustrophedon across the almond.
        const fill: Point[] = [];
        let flip = false;
        for (let d = -2.9 * f.eyeSize; d < 1.6 * f.eyeSize; d += 0.5 / S) {
          const row: Point[] = [];
          for (let t = 0.02; t <= 0.98; t += 0.03) {
            const arc = eyeArc(t) * f.eyeSize;
            if (EYE_Y + d > EYE_Y - 3.3 * arc + 0.2 && EYE_Y + d < EYE_Y + 1.9 * arc - 0.2) row.push(P(s * fw * (eyeIn + 2 * eyeSpan * t), 48 + (EYE_Y + d - 48) * f.faceLength));
          }
          if (row.length > 1) { fill.push(...(flip ? [row[row.length - 1], row[0]] : [row[0], row[row.length - 1]])); flip = !flip; }
        }
        if (fill.length > 1) accent.push(fill);
      }
    }
    if (f.face !== 'void' && f.face !== 'die') {
      const nos: Point[] = [];
      for (let t = 0; t <= 1.0001; t += 0.1) nos.push(P(s * fw * (3.3 + 2.7 * Math.sin(t * 2.6)), 48 + (62.6 - 3.0 * t * t + 1.0 * Math.sin(t * 3.14) - 48) * f.faceLength));
      features.push(nos);
    }
  }
  if (f.mouth && f.face !== 'void' && f.face !== 'die') {
    const lip: Point[] = [];
    for (let d = -8; d <= 8.001; d += 0.5) lip.push(P(d * fw, 48 + (69.9 - 0.012 * d * d - 0.63 * Math.exp(-((d / 2.2) ** 2)) + 0.6 - 48 + 0.4) * f.faceLength));
    features.push(lip);
  }
  if (f.thirdEye) {
    const y = 48 + (31 - 48) * f.faceLength;
    const ring: Point[] = [], ring2: Point[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24 * 2 * Math.PI;
      ring.push(P(2.1 * Math.cos(t), y + 3.8 * Math.sin(t)));
      ring2.push(P(0.9 * Math.cos(t), y + 1.7 * Math.sin(t)));
    }
    accent.push(ring, ring2);
  }
  if (f.face === 'die') {
    // The face is a bare die: a square of silicon inside the mask, bonded out to its edge.
    const c = 47, a2 = 13.5 * fw;
    const sq = (r: number) => [P(-r, c - r), P(r, c - r), P(r, c + r), P(-r, c + r), P(-r, c - r)];
    features.push(sq(a2), sq(a2 - 0.8));
    for (let i = -6; i <= 6; i++) {
      const d = i * 1.9 * fw;
      for (const [x0, y0, ux, uy] of [[d, c - a2, 0, -1], [d, c + a2, 0, 1], [-a2, c + d, -1, 0], [a2, c + d, 1, 0]] as const) {
        // A bond wire runs until the mask's edge is near.
        const line: Point[] = [P(x0, y0)];
        const yBase = y0;
        let l = 0;
        for (; l < 40; l += 0.4) {
          const q = P(x0 + ux * l, yBase + uy * l);
          if (!fr.inFace(q.x, q.y, -2.2)) break;
        }
        if (l > 1.5) { line.push(P(x0 + ux * l, yBase + uy * l)); lines.push(line); }
      }
    }
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
      const u = i * 3.3 * fw, v = c + j * 3.3 * fw, r = 1.05 * fw;
      if (hash(i + 9, j + 9, o.bodySeed) < 0.72) lines.push([P(u - r, v - r), P(u + r, v - r), P(u + r, v + r), P(u - r, v + r), P(u - r, v - r)]);
    }
  }
  return { lines, features, accent };
}

/** The radius of the halo's outline in a direction: its form is the board's geometry or the icon's. */
export function haloRadius(h: HaloShape, a: number): number {
  if (h.form === 'octagon') {
    const q = Math.PI / 4, m = ((a % q) + q) % q - q / 2;
    return h.reach * Math.cos(q / 2) / Math.cos(m);
  }
  if (h.form === 'square') return h.reach * 0.86 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
  return h.reach;
}

export function haloLines(o: FigureShape, h: HaloShape, fr: Frame, random: () => number): { wires: Point[][]; pads: Point[]; centre: Point; inHalo: (x: number, y: number, grow: number) => boolean } {
  const c = fr.world(0, h.y);
  const wires: Point[][] = [], pads: Point[] = [];
  const span = h.span * 2 * Math.PI;
  const inSpan = (a: number) => { let d = a + Math.PI / 2; d = Math.atan2(Math.sin(d), Math.cos(d)); return Math.abs(d) <= span / 2; };
  const inHalo = (x: number, y: number, grow: number) => {
    if (h.form === 'none') return false;
    const a = Math.atan2(y - c.y, x - c.x);
    return inSpan(a) && Math.hypot(x - c.x, y - c.y) < haloRadius(h, a) + grow;
  };
  if (h.form === 'none') return { wires, pads, centre: c, inHalo };
  const ringBand = h.rings ? 3.2 + h.rings * 1.7 : 0;
  const closed = h.span >= 0.999;
  for (let i = 0; i < h.count; i++) {
    const a = -Math.PI / 2 + (closed ? i / h.count - 0.5 : i / (h.count - 1) - 0.5) * span;
    const ux = Math.cos(a), uy = Math.sin(a);
    let start = 6;
    while (start < 400 && fr.whole(c.x + ux * start, c.y + uy * start)) start += 0.5;
    if (start >= 400) continue;
    const tier = i % h.rhythm === 0 ? 2 : i % 2 === 0 ? 1 : 0;
    // A wire starts only where the neighbours of its own tier have opened to a clean pitch: fans pinch at the root.
    const inset = Math.max(tier === 0 ? 5 + random() * 3 : 2, 0.95 / (span / h.count * [1, 2, h.rhythm][tier]) - start);
    const outer = haloRadius(h, a) - ringBand;
    const end = outer * [0.72 + 0.1 * random(), 0.82 + 0.1 * random(), 0.97 + 0.03 * random()][tier];
    if (end - start - inset < 5) continue;
    const nx = -uy, ny = ux;
    // A routed jog: a wire shifts sideways once, at 45 degrees, as a trace does around an obstacle.
    const jogAt = start + inset + (end - start - inset) * (0.25 + 0.5 * random());
    const jog = random() < h.jog ? (random() < 0.5 ? -1 : 1) * 1.1 : 0;
    const at = (d: number, off: number): Point => ({ x: c.x + ux * d + nx * off, y: c.y + uy * d + ny * off });
    const half = tier === 2 ? 0.34 : 0;
    const line = (o2: number): Point[] => jog
      ? [at(start + inset, o2), at(jogAt, o2), at(jogAt + Math.abs(jog), o2 + jog), at(end, o2 * 0.2 + jog)]
      : [at(start + inset, o2), at(end, o2 * 0.2)];
    wires.push(line(-half));
    if (half) { wires.push(line(half)); if (random() < 0.6) pads.push(at(end + 1.3, jog)); }
  }
  // Rings: concentric traces beyond the wires' tips, broken into runs like a guard ring.
  for (let n = 0; n < h.rings; n++) {
    const off = -ringBand + 2.2 + n * 1.7;
    let run: Point[] = [];
    const flush = () => { if (lengthOf(run) > 3) wires.push(run); run = []; };
    const steps = 720;
    for (let i = 0; i <= steps; i++) {
      const a = -Math.PI / 2 - span / 2 + i / steps * span;
      const r = haloRadius(h, a) + off, p = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
      const gap = Math.floor(i / (30 + 14 * (n % 3)));
      if (fr.whole(p.x, p.y) || hash(gap, n, 5) < 0.14) flush(); else run.push(p);
    }
    flush();
  }
  return { wires, pads, centre: c, inHalo };
}
