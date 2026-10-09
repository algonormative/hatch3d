import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { FORMAT, PAGE, PHRASE, TABLOID_CARD, TABLOID_HORIZON_Y, TABLOID_RASTER, depthRaster, halo, hatchMin, layoutLength, tolerance } from '../../kit/format.ts';
import { facetStrokes, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong, narrowStrands, type HelixStroke } from '../../kit/helix.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage, reduceAtScale } from '../../kit/page.ts';
import { clamp, n, smooth } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, oversampledView, pageOf, tabloidFrameCamera } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, fineDepth, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';

/**
 * X Wheel of Fortune: it all comes back around. The market cycle as a wheel. A thick round rim of
 * curved slab segments (like the voussoirs of an arch) stands on its edge, half sunk in the plain
 * and turned only a quarter-turn from the eye so it reads as a near-circle. Seven big slab towers
 * stand on its outer face along the radii and tell the cycle round the rim: a short pale stub just
 * out of the ground on the rising side, towers climbing, the proud upright one at the top, then
 * towers that are darker and lower, and at the end one lying out almost level and going headfirst
 * into the ground with only its base showing. The towers are straight; the rim's turning does the
 * tilting. Where the rim enters and leaves the ground a crisp ring of lifted paving blocks breaks
 * the plain. The hub is a round drum of slabs, and a few thin spokes join it to the rim. The helix
 * is the axle: wide and smooth in the near foreground, sweeping up out of the bottom corner and
 * through the hub's bore, then thinning away toward the horizon. The phrase is cut a word to a
 * tower, in order round the wheel, so reading it means going round.
 */
/**
 * How many times finer each way than the card's raster the depth test runs (`fineDepth`): 1 at tabloid. On a small card a
 * pixel of the card's raster spans several times the world it does on the print, and against it the edges of faces seen
 * nearly edge-on (the rim's sides, the paving's tops) fail the test and print as dashes; the finer raster gives back
 * about the print's world per pixel.
 */
const FINE = FORMAT.tabloid ? 1 : 4;
const RASTER = depthRaster(TABLOID_RASTER.width, TABLOID_RASTER.height, FINE);
const { W, H } = RASTER;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const FACET_MM_PER_UNIT = 8.3;
/** World size of the whole wheel: the tip of an ordinary tower stands this far from the hub. */
const R_OUT = 94;
/** Radial thickness and axial depth of a rim segment; axial depth of a tower; of the hub drum. */
const TB = 12, PD = 16, TD = 10, HD = 14;
/** Rim segments per tower (a segment sits under each tower, with one either side). */
const SEG = 3;
/** Hidden-line slack, in world units: slabs, and the helix's membrane. */
const SLAB_SLACK = 0.45, HELIX_SLACK = 0.5;
/** Faces turned further than this from the eye (cosine) get no hatch; edges only count a face as turned toward the eye past the smaller one. */
const GRAZING = 0.3, EDGE_GRAZING = 0.08;
/** Hidden-line slack for the outlines of slivers, in world units. */
const SOFT_SLACK = 1.4;
/** How wide the helix's occluding ribbon is, against the drawn one. */
const SLIM = 0.3;
const LIGHT = new THREE.Vector3(0.3, 0.75, 0.45).normalize();
const UP = new THREE.Vector3(0, 1, 0);
const rad = THREE.MathUtils.degToRad;

type Kind = 'rim' | 'tower' | 'spoke' | 'hub' | 'paver';
type WSlab = Slab & { kind: Kind; psi: number; tower: number };

/**
 * Where the eye stands. The top tower's tip lands at `topY` on the sheet and the ground under the
 * hub at `groundY`; those two heights, and the wheel's own height, fix its scale on the sheet, the
 * eye's height above the plain and the wheel's distance. They are the print's page positions, so the
 * placement is worked out in tabloid's frame (its page and horizon) on every size and fit: a small
 * card stands the eye where the print does, and its own camera draws the wheel smaller.
 */
function placement(ctx: SketchContext) {
  const fov = n(ctx, 'fov', 60, 36, 75);
  const f = TABLOID_PAGE.height / 2 / Math.tan(rad(fov / 2));
  const towerH = n(ctx, 'towerH', 24, 12, 40), proud = n(ctx, 'proud', 2.8, 1, 3.4);
  const ringOuter = R_OUT - towerH;
  const hubY = n(ctx, 'sink', 0.38, 0.1, 0.5) * ringOuter;
  const topTip = hubY + ringOuter + towerH * proud;
  const scale = (n(ctx, 'groundY', 330, 290, 370) - n(ctx, 'topY', 107, 60, 200)) / topTip;
  const eyeH = (n(ctx, 'groundY', 330, 290, 370) - TABLOID_HORIZON_Y) / scale;
  const D = f / scale;
  return { fov, f, ringOuter, hubY, eyeH, D, scale };
}

/** The card's camera, on the format's page. */
export function wheelCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  const p = placement(ctx);
  return horizonCamera({
    fov: p.fov, eye: [0, p.eyeH, 0], target: [0, p.eyeH, -100], near: 8, far: 4000,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/** The same camera in tabloid's frame, whatever the size and fit: the one the card's world is laid out with. At tabloid it is `wheelCamera`. */
export function worldCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  const p = placement(ctx);
  return tabloidFrameCamera({ fov: p.fov, eye: p.eyeH, near: 8, far: 4000 });
}

/** The wheel's own frame: hub, axle direction (away from the eye), in-plane right, and the face we see. */
interface Frame {
  C: THREE.Vector3; a: THREE.Vector3; u: THREE.Vector3; face: THREE.Vector3;
  dir: (psi: number) => THREE.Vector3; tangent: (psi: number) => THREE.Vector3;
}

function wheelFrame(C: THREE.Vector3, turn: number): Frame {
  const phi = rad(turn);
  const a = new THREE.Vector3(Math.sin(phi), 0, -Math.cos(phi));
  const u = new THREE.Vector3(Math.cos(phi), 0, Math.sin(phi));
  return {
    C, a, u, face: a.clone().negate(),
    dir: psi => u.clone().multiplyScalar(Math.sin(psi)).addScaledVector(UP, Math.cos(psi)),
    tangent: psi => u.clone().multiplyScalar(Math.cos(psi)).addScaledVector(UP, -Math.sin(psi)),
  };
}

/** Rotation that stands a slab with local x along `x`, y along `y`, z (its front face) along `z`. */
function orient(s: Slab, x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3) {
  const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z), 'XYZ');
  s.rx = e.x; s.ry = e.y; s.rz = e.z;
}

/** The eight corners of a slab in the world. */
function corners(s: Slab): THREE.Vector3[] {
  const m = slabMatrix(s);
  const out: THREE.Vector3[] = [];
  for (let k = 0; k < 8; k++) out.push(new THREE.Vector3((k & 1 ? 1 : -1) * s.w / 2, (k & 2 ? 1 : -1) * s.h / 2, (k & 4 ? 1 : -1) * s.d / 2).applyMatrix4(m));
  return out;
}

/** A slab built in the wheel's frame at ring angle `psi`, its front face toward the eye. */
function wheelSlab(f: Frame, centre: THREE.Vector3, psi: number, w: number, h: number, d: number, kind: Kind, tower: number, tone: number, beat: number): WSlab {
  const s = solid(centre.x, centre.y, centre.z, w, h, d, beat, 'stack') as WSlab;
  orient(s, f.tangent(psi), f.dir(psi), f.face);
  s.kind = kind; s.psi = psi; s.tower = tower; s.tone = tone;
  return s;
}

export interface Layout { C: THREE.Vector3; frame: Frame; ringOuter: number; hubY: number; D: number }

/** Where the wheel stands: the hub lands at `hubX` across the print, `D` units from the eye, at `hubY` above the plain. */
export function layout(ctx: SketchContext): Layout {
  const p = placement(ctx);
  const x = (n(ctx, 'hubX', 118, 100, 200) - TABLOID_PAGE.width / 2) * p.D / p.f;
  const C = new THREE.Vector3(x, p.hubY, -p.D);
  return { C, frame: wheelFrame(C, n(ctx, 'turn', 25, 15, 60)), ringOuter: p.ringOuter, hubY: p.hubY, D: p.D };
}

/** A ring angle in (-180°, 180°], from the top, clockwise as the eye sees it. */
function ringAngle(i: number, N: number): number {
  const psi = 2 * Math.PI * i / N;
  return psi > Math.PI ? psi - 2 * Math.PI : psi;
}

/** The rim: a continuous ring of curved slab segments, each as wide as its chord on the rim's inner edge. */
function rim(ctx: SketchContext, L: Layout): WSlab[] {
  const f = L.frame;
  const M = SEG * Math.round(n(ctx, 'towers', 10, 8, 12));
  const Rb = L.ringOuter, Rin = Rb - TB;
  const out: WSlab[] = [];
  for (let k = 0; k < M; k++) {
    const psi = ringAngle(k, M);
    const deg = psi * 180 / Math.PI;
    out.push(wheelSlab(f, f.C.clone().addScaledVector(f.dir(psi), Rb - TB / 2), psi, 0.985 * 2 * Rin * Math.sin(Math.PI / M), TB, PD, 'rim', -3, 0.6 + 0.5 * smooth(-100, 100, deg), out.length));
  }
  return out;
}

/**
 * The towers: straight stacks of a few big courses on the rim's outer face, along the radii. Round
 * from the rising side: a short stub, then taller, the proud upright one at the top, then lower
 * again on the way down, and the last the longest, lying out nearly level and buried by the ground.
 * Pale on the way up, dark on the way down.
 */
function towers(ctx: SketchContext, L: Layout): WSlab[] {
  const f = L.frame;
  const N = Math.round(n(ctx, 'towers', 10, 8, 12));
  const towerH = n(ctx, 'towerH', 24, 12, 40), proud = n(ctx, 'proud', 2.8, 1, 3.4);
  const rng = ctx.random('wheel-courses');
  const Rb = L.ringOuter;
  const out: WSlab[] = [];
  for (let i = 0; i < N; i++) {
    const psi = ringAngle(i, N);
    const deg = psi * 180 / Math.PI;
    const top = i === 0;
    const baseTone = top ? 0.8 : 0.5 + 1.0 * smooth(-100, 105, deg);
    const len = towerH * (top ? proud : deg < 0 ? 0.45 + 0.45 * smooth(-112, -30, deg) : 1 - 0.3 * smooth(10, 80, deg) + 0.45 * smooth(80, 112, deg));
    const disorder = 0.2 + 0.8 * smooth(10, 105, deg);
    const baseW = 0.4 * 2 * Rb * Math.sin(Math.PI / N) * (top ? 1.1 : 1);
    const d = f.dir(psi);
    const cur = f.C.clone().addScaledVector(d, Rb - 0.2);
    let y = 0, w = baseW;
    while (y < len - 2.5) {
      let h = 5 + 3 * rng();
      if (y + h > len - 2.5) h = Math.max(3, len - y);
      if (rng() < 0.22) w = clamp(w + (rng() - 0.5) * 0.3 * baseW, 0.8 * baseW, 1.12 * baseW);
      const last = y + h >= len - 2.5;
      const cw = top && last ? w * 1.2 : w;
      const c = cur.clone().addScaledVector(d, h / 2).addScaledVector(f.tangent(psi), (rng() - 0.5) * disorder);
      out.push(wheelSlab(f, c, psi, cw, h - 0.15, TD, 'tower', i, clamp(baseTone * (0.85 + 0.3 * rng()), 0.35, 1.45), out.length));
      cur.addScaledVector(d, h);
      y += h;
    }
  }
  return out;
}

/** The hub: a round drum, a ring of slabs round the bore, and a few thin spokes to the rim. */
function hubAndSpokes(ctx: SketchContext, L: Layout, bore: number): WSlab[] {
  const f = L.frame;
  const out: WSlab[] = [];
  const t = 7, outer = bore + t, K = 12;
  for (let k = 0; k < K; k++) {
    const psi = ringAngle(k, K);
    out.push(wheelSlab(f, f.C.clone().addScaledVector(f.dir(psi), bore + t / 2), psi, 0.97 * 2 * bore * Math.sin(Math.PI / K), t, HD, 'hub', -1, 1, out.length));
  }
  // Spokes to the rim a fifth of the way round either side of the top; a third, straight up, is for those who want it.
  const count = Math.round(n(ctx, 'spokes', 2, 0, 3));
  const r0 = outer * 0.9, r1 = L.ringOuter - TB + 0.3;
  for (const deg of [60, -60, 0].slice(0, count)) {
    const psi = rad(deg);
    out.push(wheelSlab(f, f.C.clone().addScaledVector(f.dir(psi), (r0 + r1) / 2), psi, 2.4, r1 - r0, 3.5, 'spoke', -4, 0.4, out.length));
  }
  return out;
}

/** Whether two slabs come within `margin` of each other (separating-axis test on their boxes, each grown by the margin). */
function nearEach(a: Slab, b: Slab, margin: number): boolean {
  const axes = (s: Slab) => { const e = slabMatrix(s).elements; return [new THREE.Vector3(e[0], e[1], e[2]), new THREE.Vector3(e[4], e[5], e[6]), new THREE.Vector3(e[8], e[9], e[10])]; };
  const ax = axes(a), bx = axes(b);
  const ha = [a.w / 2 + margin, a.h / 2 + margin, a.d / 2 + margin], hb = [b.w / 2 + margin, b.h / 2 + margin, b.d / 2 + margin];
  const d = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
  const tests = [...ax, ...bx];
  for (const x of ax) for (const y of bx) { const c = new THREE.Vector3().crossVectors(x, y); if (c.lengthSq() > 1e-8) tests.push(c.normalize()); }
  return tests.every(t => ax.reduce((sum, v, i) => sum + ha[i] * Math.abs(v.dot(t)), 0) + bx.reduce((sum, v, i) => sum + hb[i] * Math.abs(v.dot(t)), 0) > Math.abs(d.dot(t)));
}

/**
 * A ring of lifted paving blocks round each place where the rim goes into or comes out of the ground:
 * the plain buckles outward from the point, each block tilted up on its inner edge and resting on
 * the ground by its lowest corner. A block that would touch the wheel, another block or the axle is
 * left out, and so is one that would leave the card. Laid out in tabloid's frame: `view` is
 * `worldCamera`, and the axle's cover and the card are the print's (see `wheelWorld`).
 */
function pavers(ctx: SketchContext, L: Layout, view: THREE.Camera, blocked: (p: Point) => boolean, obstacles: Slab[]): WSlab[] {
  const count = Math.round(n(ctx, 'pavers', 9, 0, 14));
  const reach = n(ctx, 'crater', 26, 12, 44);
  const f = L.frame;
  const rng = ctx.random('wheel-pavers');
  const Rp = L.ringOuter - TB / 2;
  const out: WSlab[] = [];
  const cross = Math.acos(clamp(-L.hubY / Rp, -1, 1));
  for (const sign of [-1, 1]) {
    // The rim's footprint is a short wall along the wheel's plane (u) and thin across it (a), so the ring of blocks is an oval.
    const p = f.C.clone().addScaledVector(f.dir(sign * cross), Rp).setY(0).addScaledVector(f.u, sign * reach * 0.25);
    const ra = reach * 0.8, ru = reach * 1.3;
    const start = rng() * Math.PI * 2;
    for (let k = 0; k < count; k++) {
      const theta = start + 2 * Math.PI * k / count;
      const jitter = 0.94 + 0.12 * rng();
      const at = (t: number) => p.clone().addScaledVector(f.a, ra * jitter * Math.cos(t)).addScaledVector(f.u, ru * jitter * Math.sin(t));
      const c = at(theta);
      // Along the oval and out from it, on the ground.
      const tangent = at(theta + 0.01).sub(at(theta - 0.01)).setY(0).normalize();
      const radial = new THREE.Vector3(tangent.z, 0, -tangent.x);
      if (radial.dot(c.clone().sub(p)) < 0) radial.negate();
      const tilt = 0.3 + 0.08 * (rng() - 0.5), yaw = (rng() - 0.5) * 0.16;
      // Its inner edge up: rotate its up axis outward about the tangent.
      const up = UP.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(radial, Math.sin(tilt));
      const x = tangent.clone().applyAxisAngle(UP, yaw);
      const s = solid(c.x, 0, c.z, 11 + 2 * rng(), 2.6 + 0.6 * rng(), 8 + 1.5 * rng(), out.length, 'debris') as WSlab;
      orient(s, x, up, new THREE.Vector3().crossVectors(x, up));
      // Rest it on the ground by its lowest corner.
      s.y = -Math.min(...corners(s).map(q => q.y)) + 0.01;
      s.kind = 'paver'; s.psi = sign * cross; s.tower = -2; s.tone = 0.75;
      if (blocked(pageOf(view, new THREE.Vector3(s.x, s.y, s.z), TABLOID_PAGE))) continue;
      // Wholly inside the sheet.
      if (corners(s).some(q => { const pg = pageOf(view, q, TABLOID_PAGE); return pg.x < TABLOID_CARD.x0 + 3 || pg.x > TABLOID_CARD.x1 - 3 || pg.y > TABLOID_CARD.y1 - 3; })) continue;
      if (obstacles.some(o => nearEach(s, o, 1)) || out.some(o => nearEach(s, o, 1))) continue;
      out.push(s);
    }
  }
  return out;
}

/** A polyline cut to the part above the ground plane. */
function aboveGround(points: THREE.Vector3[]): THREE.Vector3[][] {
  const out: THREE.Vector3[][] = [];
  let run: THREE.Vector3[] = [];
  const flush = () => { if (run.length > 1) out.push(run); run = []; };
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const inside = p.y >= 0;
    if (i > 0) {
      const q = points[i - 1];
      if (inside !== (q.y >= 0)) {
        const x = q.clone().lerp(p, -q.y / (p.y - q.y)).setY(0);
        if (inside) run = [x]; else { run.push(x); flush(); }
      }
    }
    if (inside) run.push(p);
  }
  flush();
  return out;
}

/** Where a slab enters the ground: its section at y = 0, as a closed outline, a hair outside the faces. */
function groundSection(s: Slab): THREE.Vector3[] | null {
  const cs = corners(s);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) {
    const j = i | bit;
    if (j === i) continue;
    if ((cs[i].y < 0) !== (cs[j].y < 0)) pts.push(cs[i].clone().lerp(cs[j], -cs[i].y / (cs[j].y - cs[i].y)).setY(0));
  }
  if (pts.length < 3) return null;
  const c = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  pts.sort((p, q) => Math.atan2(p.z - c.z, p.x - c.x) - Math.atan2(q.z - c.z, q.x - c.x));
  const grown = pts.map(p => p.clone().add(p.clone().sub(c).setY(0).normalize().multiplyScalar(0.015)).setY(0.004));
  return [...grown, grown[0].clone()];
}

type EdgeStroke = ReturnType<typeof facetStrokes>[number] & { soft?: boolean };

/**
 * The kit draws all twelve edges of a slab and leaves the depth pass to hide them; at grazing angles
 * the far edges leak through as dashes. An edge can only show if one of the two faces it joins faces
 * the eye, so edges between two back faces are dropped here. An edge that only a glancing face
 * supports is marked `soft`: it is the outline of a sliver, and gets more hidden-line slack so it
 * draws whole instead of breaking up. (The kit's edge strokes come first: the front ring, the back
 * ring, then the four depth edges.)
 */
function visibleEdges(s: Slab, eye: THREE.Vector3, strokes: ReturnType<typeof facetStrokes>): EdgeStroke[] {
  const rot = new THREE.Matrix4().extractRotation(slabMatrix(s));
  // Face order: +z, -z, +x, -x, +y, -y; cosines of the angle from each face's normal to the eye.
  const normals = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]].map(v => new THREE.Vector3(...v).applyMatrix4(rot));
  const half = [s.d / 2, s.d / 2, s.w / 2, s.w / 2, s.h / 2, s.h / 2];
  const [pz, nz, px, nx, py, ny] = normals.map((nv, i) => nv.dot(eye.clone().sub(new THREE.Vector3(s.x, s.y, s.z).addScaledVector(nv, half[i])).normalize()));
  const out: EdgeStroke[] = [];
  /** The faces each segment of a stroke joins, as a pair of cosines. */
  const emit = (st: ReturnType<typeof facetStrokes>[number], joins: [number, number][]) => {
    let run: THREE.Vector3[] = [], soft = false;
    const flush = () => { if (run.length > 1) out.push({ ...st, points: run, soft }); run = []; };
    joins.forEach(([a, b], i) => {
      const best = Math.max(a, b);
      if (best <= EDGE_GRAZING) { flush(); return; }
      const glancing = best < GRAZING;
      if (run.length && glancing !== soft) flush();
      if (!run.length) run.push(st.points[i]);
      soft = glancing;
      run.push(st.points[i + 1]);
    });
    flush();
  };
  emit(strokes[0], [[pz, ny], [pz, px], [pz, py], [pz, nx]]);
  emit(strokes[1], [[nz, ny], [nz, px], [nz, py], [nz, nx]]);
  [[nx, ny], [px, ny], [px, py], [nx, py]].forEach((join, i) => emit(strokes[2 + i], [join as [number, number]]));
  return [...out, ...strokes.slice(6)];
}

/**
 * A trimmed outline (`facetStrokes`' `trim`, off tabloid) as `visibleEdges` treats the kit's: each edge's two faces
 * are found from where it lies on the slab, an edge that neither sees the eye past `EDGE_GRAZING` is dropped, and one
 * that only a glancing face supports is marked `soft`, so a sliver's outline draws whole. Other strokes pass through.
 */
function trimmedEdges(s: Slab, eye: THREE.Vector3, strokes: ReturnType<typeof facetStrokes>): EdgeStroke[] {
  const m = slabMatrix(s), inverse = m.clone().invert(), rot = new THREE.Matrix4().extractRotation(m);
  const half = [s.w / 2, s.h / 2, s.d / 2];
  const centre = new THREE.Vector3(s.x, s.y, s.z);
  const out: EdgeStroke[] = [];
  for (const st of strokes) {
    if (st.family !== 'edge') { out.push(st); continue; }
    const mid = st.points[0].clone().add(st.points[st.points.length - 1]).multiplyScalar(0.5).applyMatrix4(inverse);
    const local = [mid.x, mid.y, mid.z];
    let best = -Infinity;
    // The edge runs along one axis (its middle there is the slab's); it joins the faces across the other two.
    for (let a = 0; a < 3; a++) {
      if (Math.abs(local[a]) < half[a] / 2) continue;
      const normal = new THREE.Vector3().setComponent(a, Math.sign(local[a])).applyMatrix4(rot);
      best = Math.max(best, normal.dot(eye.clone().sub(centre.clone().addScaledVector(normal, half[a])).normalize()));
    }
    if (best <= EDGE_GRAZING) continue;
    out.push({ ...st, soft: best < GRAZING });
  }
  return out;
}

/**
 * A face seen almost edge-on squeezes its rings into a sliver that the depth pass breaks into dashes,
 * so hatch on faces turned this far from the eye (cosine of the angle to the line of sight) is dropped.
 */
function dropGrazing(s: Slab, eye: THREE.Vector3, strokes: ReturnType<typeof facetStrokes>, minCos: number): ReturnType<typeof facetStrokes> {
  const m = slabMatrix(s);
  const inv = m.clone().invert();
  const rot = new THREE.Matrix4().extractRotation(m);
  const half = [s.w / 2, s.h / 2, s.d / 2];
  return strokes.filter(st => {
    if (st.family !== 'hatch') return true;
    const q = st.points[0].clone().add(st.points[st.points.length - 1]).multiplyScalar(0.5).applyMatrix4(inv);
    const qa = [q.x, q.y, q.z];
    let axis = 0, best = Infinity;
    for (let i = 0; i < 3; i++) { const d = Math.abs(Math.abs(qa[i]) - half[i]); if (d < best) { best = d; axis = i; } }
    const nl = new THREE.Vector3(); nl.setComponent(axis, Math.sign(qa[axis]));
    const normal = nl.applyMatrix4(rot);
    const here = st.points[0];
    return normal.dot(eye.clone().sub(here).normalize()) >= minCos;
  });
}

/** Split long polylines so each piece sits in one depth band. */
function chunk(points: THREE.Vector3[], max = 20): THREE.Vector3[][] {
  if (points.length <= max + 2) return [points];
  const out: THREE.Vector3[][] = [];
  for (let i = 0; i < points.length - 1; i += max) out.push(points.slice(i, Math.min(points.length, i + max + 1)));
  return out;
}

/** The helix is built at this many times the world's size and brought back: its wiggles are fixed in world units. */
const UPSCALE = 3;

/** A camera that sees the helix built at `UPSCALE` as `view` sees the world. */
function upscaled(view: THREE.PerspectiveCamera): THREE.PerspectiveCamera {
  const sv = view.clone();
  sv.position.multiplyScalar(UPSCALE); sv.near *= UPSCALE; sv.far *= UPSCALE;
  sv.updateProjectionMatrix(); sv.updateMatrixWorld(true);
  return sv;
}

/** A helix built at `UPSCALE`, its strokes brought back to the world's size. */
const unscaled = (strokes: HelixStroke[]): HelixStroke[] => strokes.map(h => ({ ...h, points: h.points.map(q => q.clone().multiplyScalar(1 / UPSCALE)) }));

/**
 * The card's world: where the wheel stands, its rim, towers, hub and spokes, the paving its crossings lift, and the
 * axle's course and helix. It is laid out in tabloid's frame, with `worldCamera` and the print's page and card, so
 * every size and fit builds the same world, to the bit; each card's own camera (`wheelCamera`) then draws it. The
 * helix's strokes here are spaced on the print's paper; a small card traces its own (`drawWheel`).
 */
export function wheelWorld(ctx: SketchContext) {
  const view = worldCamera(ctx);
  const depthOf = (p: THREE.Vector3) => Math.max(1, -p.z);
  const L = layout(ctx);
  const fr = L.frame;

  // The axle: a straight line through the hub along the wheel's axis, cut where it leaves the print's card.
  const pageAt = (t: number) => pageOf(view, fr.C.clone().addScaledVector(fr.a, t), TABLOID_PAGE);
  let tNear = 0;
  while (tNear > -2000 && pageAt(tNear).x > TABLOID_CARD.x0 - 30 && depthOf(fr.C.clone().addScaledVector(fr.a, tNear)) > 40) tNear -= 1;
  let tFar = 0;
  while (tFar < 900 && pageAt(tFar).x < TABLOID_CARD.x1 + 40) tFar += 1;
  const r0 = n(ctx, 'thread', 1.8, 0.6, 3), taper = n(ctx, 'taper', 4.5, 1, 8), flare = n(ctx, 'flare', 4, 1, 6);
  const sHub = tFar / (tFar - tNear);
  const hubScale = taper ** (sHub ** flare);
  // Wide enough for the strands at the hub, with a clear gap.
  const bore = Math.max(6, (r0 * (1 + 0.35 + 0.9)) * hubScale + 1.6);

  // The axle runs level through the hub, then sweeps down toward the ground as it comes toward the eye, so its near end
  // lies low in the foreground and runs off the bottom of the sheet's left side.
  const axleLow = n(ctx, 'axleLow', 14, 3, 40), straight = HD / 2 + 14;
  const axle: THREE.Vector3[] = [];
  for (let i = 0; i <= 28; i++) {
    const t = tFar + (tNear - tFar) * i / 28;
    const q = fr.C.clone().addScaledVector(fr.a, t);
    if (t < -straight) q.y = L.hubY - (L.hubY - axleLow) * ((-straight - t) / (-straight - tNear)) ** 1.7;
    axle.push(q);
  }
  const axleCurve = new THREE.CatmullRomCurve3(axle.map(p => p.clone().multiplyScalar(UPSCALE)), false, 'centripetal');
  const options = {
    radius: r0 * UPSCALE, width: r0 * 0.9 * UPSCALE, pitch: n(ctx, 'pitch', 40, 8, 120) * UPSCALE, spread: r0 * 0.35 * UPSCALE, narrow: 0.1, twist: 0.1,
    density: 0.45, interruption: 0.15, taper, flare, pitchGrowth: 1,
  };
  const made = helixAlong(ctx, upscaled(view), axleCurve, options);
  // Seen this nearly along its length, a wide ribbon hides the far side of every turn behind the near side and the coil
  // reads as a row of arches. The helix's own lines are tested against a slim copy of the ribbon (same turns), so the turns
  // show through; everything else is tested against the ribbon at its true width. The surfaces don't depend on the camera.
  const slim = helixAlong(ctx, upscaled(view), axleCurve, { ...options, width: options.width * SLIM });
  const unscale = (g: THREE.BufferGeometry) => { g.scale(1 / UPSCALE, 1 / UPSCALE, 1 / UPSCALE); g.computeBoundingSphere(); return g; };
  const helix = {
    strokes: unscaled(made.strokes),
    meshes: slim.meshes.map(unscale),
    /** The ribbon at its true width: what hides the wheel behind it. */
    full: made.meshes.map(unscale),
  };

  // Paving blocks keep clear of the axle on the print.
  const nearHelix = meshCoverage(helix.full, view, TABLOID_PAGE, 1);
  const wheel: WSlab[] = [...rim(ctx, L), ...towers(ctx, L), ...hubAndSpokes(ctx, L, bore)];
  const slabs: WSlab[] = [...wheel, ...pavers(ctx, L, view, nearHelix, wheel)].filter(s => Math.max(...corners(s).map(q => q.y)) > 0.02);
  return { L, tNear, tFar, r0, taper, flare, bore, slabs, helix, axleCurve, options };
}

export function drawWheel(ctx: SketchContext): Part[] {
  const world = wheelWorld(ctx);
  const { slabs } = world;
  const view = wheelCamera(ctx);
  const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  // The helix as this card's paper spaces it: the world's at tabloid, traced again on any other page (its surfaces are the world's).
  const traced = FORMAT.tabloid ? undefined : helixAlong(ctx, upscaled(view), world.axleCurve, world.options);
  for (const g of traced?.meshes ?? []) g.dispose();
  const helix = traced ? { ...world.helix, strokes: unscaled(traced.strokes) } : world.helix;
  const eye = view.position.clone();
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  const depthOf = (p: THREE.Vector3) => Math.max(1, eye.z - p.z);
  const hatch = n(ctx, 'hatch', 0.7, 0.5, 3);

  // Off tabloid every slab's outline is trimmed (kit/slabs.ts): no back edges, and a face narrower on paper than the
  // smallest feature folded into it. That outline is no longer the kit's twelve edges in order, so `trimmedEdges` does
  // `visibleEdges`' work on it.
  const trim = FORMAT.tabloid ? undefined : { view };
  const strokes: (Stroke & { soft?: boolean })[] = [];
  for (const sl of slabs) {
    const at = new THREE.Vector3(sl.x, sl.y, sl.z);
    // The wheel draws as rim, towers and hub (spokes with the rim), so each can be told apart.
    const group = sl.kind === 'paver' ? 'ground' : sl.kind === 'spoke' ? 'rim' : sl.kind;
    // Under 1.5 mm on this card's paper a slab is an outline; its hatch keeps its pitch on paper.
    const outline = Math.max(sl.w, sl.h) * mmPerUnit(at) < 1.5;
    const kept = dropGrazing(sl, eye, facetStrokes(sl, LIGHT, eye, outline, hatch * FACET_MM_PER_UNIT / mmPerUnit(at), trim), GRAZING);
    for (const st of trim ? trimmedEdges(sl, eye, kept) : visibleEdges(sl, eye, kept)) {
      for (const piece of aboveGround(st.points)) strokes.push({ ink: st.ink, group, family: st.family, points: piece, soft: st.soft });
    }
    if (sl.kind !== 'paver') {
      const section = groundSection(sl);
      if (section) strokes.push({ ink: 'carbon', group, family: 'edge', points: section });
    }
  }
  // A strand whose ribbon is narrower on this card's paper than the smallest feature is drawn by its line (none at tabloid).
  for (const h of narrowStrands(helix.strokes, view)) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points });

  const solidGeos = slabs.map(slabGeometry);
  const geometries = [...solidGeos, ...helix.full];
  const slimGeos = [...solidGeos, ...helix.meshes];
  try {
    fitDepthRange(view, [...geometries, ...helix.meshes]);
    // The depth passes, against the full ribbon and the slim one (see `wheelWorld`), and the page mm per pixel of their raster.
    const dview = FINE === 1 ? view : oversampledView(view, FINE);
    const full = fineDepth(geometries, dview, RASTER, FINE), slimmed = fineDepth(slimGeos, dview, RASTER, FINE);
    const { env, mmX, mmY } = full;
    const nearP = view.near, farP = view.far;
    const biasAt = (d: number, slack: number) => Math.max(3e-5, slack * nearP * farP / ((farP - nearP) * d * d));
    const solids = meshCoverage(geometries, view, PAGE, halo(n(ctx, 'knockout', 1, 0.3, 3)));

    // The phrase: one word to a tower round the rim, in order from the rising side over the top and down. Or, where the
    // format sets it in the band, under the card's name instead.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 && PHRASE === 'art' ? settings.text.split(' ').filter(Boolean) : [];
    const wrng = ctx.random('wheel-words');
    const style = { face: settings.face, height: settings.size };
    const textStrokes: THREE.Vector3[][] = [];
    const visible = (lines3: THREE.Vector3[][], bias: number) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k: number) => void) => projectStrokes(lines3.map(points => ({ points })), { ...env, bias }, {
        hidden: () => hidden, begin: () => runs => { for (const r of runs) addTo(r.length); },
      });
      count(false, k => { total += k; });
      count(true, k => { seen += k; });
      return total > 0 && seen >= total * 0.97;
    };
    const cands = slabs.filter(s => s.kind === 'tower').map(sl => ({ sl, at: pageOf(view, new THREE.Vector3(sl.x, sl.y, sl.z)), low: Math.min(...corners(sl).map(q => q.y)) }))
      .filter(({ at, low }) => low > 0.6 && at.x > CARD.x0 + layoutLength(6) && at.x < CARD.x1 - layoutLength(6) && at.y > CARD.y0 + layoutLength(6) && at.y < CARD.y1 - layoutLength(6));
    const used = new Set<number>();
    words.forEach((word, i) => {
      // Round the wheel from the rising side, over the top, to the falling side.
      const target = words.length > 1 ? -72 + 144 * i / (words.length - 1) : 0;
      const wmm = measureStrokeText(word, style);
      const ranked = cands.filter(({ sl }) => !used.has(sl.tower) && sl.kind === 'tower')
        .filter(({ sl }) => {
          const mm = mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z));
          return wmm < sl.w * mm * 0.88 && style.height < (sl.h - 0.3) * mm * 0.8;
        })
        .map(c => ({ c, k: Math.abs(c.sl.psi * 180 / Math.PI - target) + 3 * wrng() }))
        .sort((p, q) => p.k - q.k).map(x => x.c);
      for (const { sl } of ranked) {
        const at = new THREE.Vector3(sl.x, sl.y, sl.z);
        const m = slabMatrix(sl);
        const unit = 1 / mmPerUnit(at);
        const ww = wmm * unit, hh = style.height * unit;
        const x0 = -ww / 2 + (wrng() - 0.5) * (sl.w - ww) * 0.6, y0 = hh / 2 + (wrng() - 0.5) * (sl.h - hh) * 0.5;
        const word3 = strokeText(word, 0, 0, style).map(path => path.map(q => new THREE.Vector3(x0 + q.x * unit, y0 - q.y * unit, sl.d / 2 + 0.03).applyMatrix4(m)));
        if (!visible(word3, biasAt(depthOf(at), SLAB_SLACK))) continue;
        textStrokes.push(...word3);
        used.add(sl.tower);
        break;
      }
    });
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, env.view, env.width, env.height).polylines) for (const c of clipProjectedPolyline(l, env.width, env.height)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), mmX, mmY)));
    }
    const onGlyph = glyphMask(glyphPaths, halo(0.7));
    // The buckets' reducer keeps the helix's curves on a small card (`simplify` at tabloid).
    const buckets = new PartBuckets(0.4, { reduce: reduceAtScale });
    const add = (key: string, run: Point[], extra: (p: Point) => boolean = () => true, min?: number) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && extra(p), 0.15)) buckets.add(key, piece, false, min);
    };
    // Each stroke is tested at its own depth: strokes are split into pieces and banded by distance.
    const bands = new Map<string, { list: Stroke[]; d: number; slack: number }>();
    for (const st of strokes) for (const piece of (st.group === 'helix' ? chunk(st.points) : [st.points])) {
      const mid = piece[Math.floor(piece.length / 2)];
      const d = depthOf(mid), band = Math.round(Math.log(d) / Math.log(1.12));
      const key = `${st.group}|${band}|${st.soft ? 'soft' : ''}`;
      if (!bands.has(key)) bands.set(key, { list: [], d: Math.exp(band * Math.log(1.12)), slack: st.group === 'helix' ? HELIX_SLACK : st.soft ? SOFT_SLACK : SLAB_SLACK });
      bands.get(key)!.list.push({ ...st, points: piece });
    }
    for (const { list, d, slack } of bands.values()) {
      projectStrokes(list, { ...(list[0].group === 'helix' ? slimmed : full).env, bias: biasAt(d, slack) }, {
        begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, mmX, mmY), undefined, hatchMin(st.family)); },
      });
    }

    // The sky: a ruled night, closest at the top and opening to the horizon, knocked out round all that stands in it.
    // The ruling and its breaks keep their millimetres on paper, so a small card keeps the print's tones in fewer rules.
    const pattern = barPattern(ctx.random('wheel-sky'), 0.86);
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - layoutLength(1), pitch = tolerance(n(ctx, 'skyPitch', 1.8, 0.8, 5));
    for (let y = skyTop + tolerance(0.3), i = 0; y < skyBottom; i++) {
      const t = (y - skyTop) / (skyBottom - skyTop);
      const broken = t > 0.5;
      const row = i;
      add('sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }],
        p => !solids(p) && (!broken || pattern[Math.floor((p.x - CARD.x0) / 3.2 + row) % 64]));
      y += pitch * (1 + 3.2 * t * t);
    }
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['sky', 'ground', 'rim', 'tower', 'hub', 'helix', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p), 0.3) });
    parts.push(...cardFrame('X', 'WHEEL OF FORTUNE', { phrase: settings }));
    return parts;
  } finally {
    for (const geo of [...geometries, ...slimGeos]) geo.dispose();
  }
}
