import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../../src/occlusion.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import {
  helixStrands, simplify, slabGeometry, slabMatrix, solid, strandPoint, strandStrokes, towerSlabs,
  type Ink, type Slab, type Strand,
} from '../../breach-cathedral-tower/geometry.ts';
import { clearBands, planSlogans, sloganSettings, type SloganSurface } from '../../breach-cathedral-tower/slogan.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { densify, keepAlong } from '../page.ts';

/**
 * XVI The Tower: the page is struck, not the tower. A flat hatched lightning band runs down the
 * whole card, and everything on one side of it has slipped along the tear like a misregistered
 * print. The tower itself is unsealed rather than destroyed: its crown lifts off like a lid and
 * the helix pours up out of the opened shaft.
 */
type Family = 'edge' | 'hatch' | 'membrane' | 'text';
type Stroke = { ink: Ink; group: string; family: Family; points: THREE.Vector3[]; owner?: number };

const W = 559, H = 864;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 2.2;
/** The tower's own frame: Breach Cathedral Tower coordinates run from −10.9 to 10.6; ground is 0 here. */
const LIFT = 10.9, CROWN = 10.6 + LIFT;

function n(ctx: SketchContext, key: string, fallback: number, lo: number, hi: number): number {
  const v = ctx.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

/** A level camera at eye height, shifted so the horizon sits on the set's shared line. */
export function towerCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  const view = new THREE.PerspectiveCamera(n(ctx, 'fov', 56, 40, 80), W / H, 0.5, 400);
  const distance = n(ctx, 'distance', 48, 30, 90);
  view.position.set(0, EYE, distance);
  view.lookAt(0, EYE, 0);
  view.setViewOffset(W, H, 0, -(HORIZON_Y - TABLOID_PAGE.height / 2) / MM_Y, W, H);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
}

/** The cathedral tower on the ground, its crown slabs lifted off and turned like a lid. */
function tower(ctx: SketchContext): Slab[] {
  const rng = ctx.random('tower-card-lid');
  const lid = n(ctx, 'lid', 0.5, 0, 1);
  const scene: SketchContext = { ...ctx, params: { collapse: 0, debris: 0, cantilever: 0.85, levels: 19, ...ctx.params } };
  const out = towerSlabs(scene).map(s => ({ ...s, y: s.y + LIFT, home: { ...s.home, y: s.home.y + LIFT } }));
  for (const s of out) {
    // The top courses come away whole, rising and tipping as one lid.
    const k = (s.home.y - (CROWN - 3.2)) / 3.2;
    if (k <= 0) continue;
    s.y += (1.6 + 2.6 * lid) * (0.6 + 0.4 * k) + rng() * 0.5;
    s.x += (0.5 + 1.0 * lid) * (0.5 + k);
    s.rz = -(0.12 + 0.3 * lid) * (0.7 + 0.5 * rng());
    s.rx = (rng() - 0.5) * 0.3 * lid;
    s.role = 'fallen';
  }
  // A plinth and a few ground slabs, so the tower stands on the shared horizon's ground.
  const plinth = solid(0, -0.35, 0, 15, 0.7, 9, 90, 'pier');
  plinth.tone = 0.9;
  out.push(plinth);
  // Paving receding to the horizon, the same ground as Death's nave, so the cards join up in a spread.
  for (let row = 0; row < 18; row++) for (let c = -4; c <= 4; c++) {
    const z = 42 - row * 7;
    const g = solid(c * 3.3, -0.16, z, 3.0, 0.28, 6.4, 120 + row * 9 + c, 'stub');
    g.tone = 0.2;
    out.push(g);
  }
  // Slabs fallen from the tower, lying broken on the ground in front of it.
  for (let i = 0; i < 7; i++) {
    const g = solid((rng() - 0.5) * 22, 0.25 + rng() * 0.3, 4 + rng() * 22, 1.6 + 3.4 * rng(), 0.5 + 0.4 * rng(), 0.9 + 1.2 * rng(), 100 + i, 'debris');
    g.ry = (rng() - 0.5) * 1.6; g.rz = (rng() - 0.5) * 0.5; g.rx = (rng() - 0.5) * 0.3;
    g.tone = 0.9;
    out.push(g);
  }
  return out;
}

/** The raking light: low from the bolt's side and a little toward the eye, so faces split into values. */
export function rakingLight(ctx: SketchContext): THREE.Vector3 {
  // Elevation from a few degrees (grazing: front faces fall dark, flanks blaze) to high (tops lit).
  const e = (4 + 56 * n(ctx, 'lightAngle', 0.3, 0, 1)) * Math.PI / 180;
  const toward = 0.15 + 0.5 * n(ctx, 'lightAngle', 0.3, 0, 1);
  return new THREE.Vector3(Math.cos(e), Math.sin(e) * 1.4, toward).normalize();
}

/** Face darkness under the raking light, 0 (paper) to 1, scaled by the slab's own tone. */
export function faceDarkness(normal: THREE.Vector3, light: THREE.Vector3, tone: number): number {
  const lit = Math.max(0, normal.dot(light));
  return Math.max(0, Math.min(1, (0.12 + 0.88 * (1 - lit) ** 1.3) * Math.min(1.15, 0.55 + 0.5 * tone)));
}

const MIN_PITCH = 0.072; // world units: about 0.6 mm on the sheet at the tower's depth

/** Clip the line o + s·dir to |x·U| ≤ a, |x·V| ≤ b in face coordinates (dir and o given as (u, v)). */
function clipRect(ox: number, oy: number, dx: number, dy: number, a: number, b: number): [number, number] | null {
  let lo = -Infinity, hi = Infinity;
  for (const [o, d, h] of [[ox, dx, a], [oy, dy, b]]) {
    if (Math.abs(d) < 1e-12) { if (Math.abs(o) > h) return null; continue; }
    const t0 = (-h - o) / d, t1 = (h - o) / d;
    lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
  }
  return hi - lo > 1e-6 ? [lo, hi] : null;
}

/**
 * A slab drawn in the Tower card's own hatch: twelve outline edges; then on each face that sees the
 * eye, contour rings that follow its outline inward, as many as the face is dark; and inside them a
 * field of diagonal hatch, crossed by a second family on the darkest faces, for body.
 */
export function facetStrokes(s: Slab, light: THREE.Vector3, eye: THREE.Vector3, outlineOnly: boolean): Stroke[] {
  const out: Stroke[] = [];
  const m = slabMatrix(s);
  const rot = new THREE.Matrix4().extractRotation(m);
  const hx = s.w / 2, hy = s.h / 2, hz = s.d / 2;
  const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
  const push = (ink: Ink, family: Family, ...pts: THREE.Vector3[]) => out.push({ ink, group: 'system', family, points: pts });
  const e = 0.006;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]];
  push('carbon', 'edge', ...corners.map(([x, y]) => P(x * hx, y * hy, hz + e)));
  push('carbon', 'edge', ...corners.map(([x, y]) => P(x * hx, y * hy, -hz - e)));
  for (const [x, y] of corners.slice(0, 4)) push('carbon', 'edge', P(x * (hx + e), y * (hy + e), -hz), P(x * (hx + e), y * (hy + e), hz));
  if (outlineOnly) return out;
  const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(0, 0, hz), new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(0, 0, -hz), new THREE.Vector3(-hx, 0, 0), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, 0, -hz), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(-hx, 0, 0), new THREE.Vector3(0, 0, hz), new THREE.Vector3(0, hy, 0)],
    [new THREE.Vector3(0, hy, 0), new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, 0, -hz)],
    [new THREE.Vector3(0, -hy, 0), new THREE.Vector3(hx, 0, 0), new THREE.Vector3(0, 0, hz)],
  ];
  for (const [c0, U0, V0] of faces) {
    const normal = c0.clone().normalize().applyMatrix4(rot);
    const centre = c0.clone().applyMatrix4(m).addScaledVector(normal, e);
    if (eye.clone().sub(centre).dot(normal) <= 0) continue;
    const a = U0.length(), b = V0.length();
    const U = U0.clone().normalize().applyMatrix4(rot), V = V0.clone().normalize().applyMatrix4(rot);
    const at = (u: number, v: number) => centre.clone().addScaledVector(U, u).addScaledVector(V, v);
    const d = faceDarkness(normal, light, s.tone);
    // Contour rings: the outline repeated inward, spaced tighter the darker the face.
    const ring = Math.max(MIN_PITCH, 0.075 + 0.11 * (1 - d));
    const band = Math.min(a, b) * (0.12 + 0.6 * d);
    let t = ring;
    for (; t <= band && a - t > 0.03 && b - t > 0.03; t += ring) {
      push('carbon', 'hatch', at(-(a - t), -(b - t)), at(a - t, -(b - t)), at(a - t, b - t), at(-(a - t), b - t), at(-(a - t), -(b - t)));
    }
    // The middle: diagonal hatch on mid faces, crossed on the darkest, for body.
    const ia = a - t, ib = b - t;
    if (ia < 0.05 || ib < 0.05 || d < 0.32) continue;
    const families: [number, number, Ink][] = [[0.6, Math.max(MIN_PITCH, 0.07 + 0.3 * (1 - d) ** 1.5), 'ultramarine']];
    if (d > 0.62) families.push([-0.95, Math.max(MIN_PITCH * 1.3, 0.1 + 0.35 * (1 - d)), 'violet']);
    for (const [angle, pitch, ink] of families) {
      const dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
      const reach = Math.hypot(ia, ib);
      for (let k = -reach + pitch / 2; k < reach; k += pitch) {
        const span = clipRect(nx * k, ny * k, dx, dy, ia, ib);
        if (!span) continue;
        push(ink, 'hatch', at(nx * k + dx * span[0], ny * k + dy * span[0]), at(nx * k + dx * span[1], ny * k + dy * span[1]));
      }
    }
  }
  return out;
}

/** The helix as the tower's focus: wound up the open shaft, mid-height, swelling at its centre. */
function pour(ctx: SketchContext): Strand[] {
  const rise = n(ctx, 'pour', 0.5, 0, 1);
  return helixStrands({ ...ctx, params: { helixTurns: 1.8, shellTwist: 0.4, ...ctx.params } }).map(s => ({
    ...s, x: 0, y: 0, z: 0,
    y0: LIFT * 0.45 + (s.id === 'b' ? 0.7 : 0), y1: CROWN - 3.4 - (s.id === 'b' ? 0.9 : 0),
    radius: 1.35 * (s.id === 'b' ? 0.93 : 1), swell: 0.5 + 0.9 * rise, centre: (LIFT * 0.45 + CROWN - 3.4) / 2,
    width: n(ctx, 'shellWidth', 1.1, 0.4, 1.8) * (s.id === 'b' ? 0.9 : 1),
  }));
}

/**
 * The storm: slanted rain on a backdrop plane behind the tower, so the depth pass keeps it behind
 * everything. Dashes thicken toward the top of the sky into a cloud bank and thin out to the horizon;
 * a fixed 64-step rhythm breaks each fall.
 */
function storm(ctx: SketchContext): Stroke[] {
  const amount = n(ctx, 'storm', 0.5, 0, 1);
  if (amount <= 0) return [];
  const rng = ctx.random('tower-card-storm');
  const pattern = Array.from({ length: 64 }, (_, k) => k % 8 !== 7 && rng() < 0.75);
  const z = -32, top = 62, slant = -0.32, pitch = 0.62 - 0.22 * amount;
  const out: Stroke[] = [];
  for (let i = 0, x = -60; x < 60; i++, x += pitch * (0.85 + 0.3 * rng())) {
    let y = 0.4 + rng() * 2;
    for (let k = 0; y < top; k++) {
      const f = y / top;
      // Short broken rain low down, long dense streaks under the cloud bank.
      const dash = (0.5 + 2.8 * f * f) * (0.6 + 0.8 * rng());
      const gap = (2.6 - 2.2 * f * amount) * (0.5 + rng());
      if (pattern[(k * 5 + i * 3) % 64] && rng() < 0.35 + 0.65 * f) {
        out.push({ ink: i % 9 === 0 ? 'violet' : f > 0.55 ? 'carbon' : 'ultramarine', group: 'storm', family: 'hatch',
          points: [new THREE.Vector3(x + slant * y, y, z), new THREE.Vector3(x + slant * (y + dash), y + dash, z)] });
      }
      y += dash + gap;
    }
  }
  return out;
}

/**
 * The bolt, in page millimetres: from the top of the card it strikes the lifted crown, runs down
 * the tower's flank to its foot, and leaves through the bottom of the card. Each leg is broken into
 * seeded jags. Returns the main channel and one thin branch.
 */
export function boltPath(ctx: SketchContext, crown: Point, foot: Point): { main: Point[]; branch: Point[] } {
  const rng = ctx.random('tower-card-bolt');
  const w = CARD.x1 - CARD.x0;
  const keys: Point[] = [
    { x: Math.min(CARD.x1 - 8, crown.x + 0.28 * w + 0.1 * w * rng()), y: CARD.y0 - 2 },
    { x: crown.x + 6, y: crown.y },
    { x: crown.x + 0.16 * w, y: (crown.y + foot.y) / 2 },
    { x: foot.x + 0.08 * w, y: foot.y },
    { x: foot.x - 0.1 * w - 0.12 * w * rng(), y: CARD.y1 + 2 },
  ];
  const main: Point[] = [keys[0]];
  for (let k = 1; k < keys.length; k++) {
    const a = keys[k - 1], b = keys[k];
    const len = Math.hypot(b.x - a.x, b.y - a.y), nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    // Jags every 18 mm or so, a few millimetres either side: lightning, not a staircase.
    const legs = Math.max(2, Math.round(len / 18));
    for (let j = 1; j < legs; j++) {
      const t = (j + (rng() - 0.5) * 0.4) / legs, jag = (j % 2 ? 1 : -1) * (2.5 + 5 * rng());
      main.push({ x: a.x + (b.x - a.x) * t + nx * jag, y: a.y + (b.y - a.y) * t + ny * jag });
    }
    main.push(b);
  }
  // One branch forks off the middle of the run down the tower, outward and down.
  const from = main[Math.floor(main.length / 2)];
  const dir = rng() < 0.5 ? 1 : -1;
  const branch = [from, { x: from.x + dir * (14 + 10 * rng()), y: from.y + 16 }, { x: from.x + dir * (20 + 14 * rng()), y: from.y + 30 }, { x: from.x + dir * (34 + 16 * rng()), y: from.y + 44 }];
  return { main, branch };
}

/** Signed side of a page point relative to the bolt, and its distance from it. */
function sideOf(bolt: Point[], p: Point): { side: number; dist: number } {
  let best = Infinity, side = 1;
  for (let i = 1; i < bolt.length; i++) {
    const a = bolt[i - 1], b = bolt[i];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best) { best = d; side = Math.sign(dx * (p.y - a.y) - dy * (p.x - a.x)) || 1; }
  }
  return { side, dist: best };
}

/** Shear a page path across the bolt: the far side slips by `slip`; the band itself is left clear. */
export function shear(path: Point[], bolt: Point[], slip: Point, half: number): Point[][] {
  const out: Point[][] = [];
  let run: Point[] = [], last = 0;
  const flush = () => { if (run.length > 1) out.push(run); run = []; };
  for (const p of densify(path, 0.5)) {
    const { side, dist } = sideOf(bolt, p);
    if (dist < half + 0.6) { flush(); last = 0; continue; }
    if (last !== 0 && side !== last) flush();
    last = side;
    run.push(side > 0 ? { x: p.x + slip.x, y: p.y + slip.y } : p);
  }
  flush();
  // Slipped pieces must not land inside the band either.
  return out.flatMap(r => keepAlong(r, q => sideOf(bolt, q).dist > half + 0.4, 0.3));
}

/** The flat band: two outline rules and a dense hatch across it, the card's one 2D mark. */
function bandMarks(bolt: Point[], half: number): Point[][] {
  const offset = (sign: number): Point[] => bolt.map((p, i) => {
    const a = bolt[Math.max(0, i - 1)], b = bolt[Math.min(bolt.length - 1, i + 1)];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    // Miter the corners so the band keeps its width round each turn.
    let scale = 1;
    if (i > 0 && i < bolt.length - 1) {
      const u = { x: p.x - bolt[i - 1].x, y: p.y - bolt[i - 1].y }, ul = Math.hypot(u.x, u.y);
      scale = 1 / Math.max(0.35, (-u.y / ul) * nx + (u.x / ul) * ny);
    }
    return { x: p.x + sign * nx * half * scale, y: p.y + sign * ny * half * scale };
  });
  const marks: Point[][] = [offset(1), offset(-1)];
  // Hatch at 30° to the page, inside the band.
  const pitch = 0.6, angle = Math.PI / 6, cx = Math.cos(angle), cy = Math.sin(angle);
  const span = Math.hypot(CARD.x1 - CARD.x0, CARD.y1 - CARD.y0);
  for (let o = -span; o < span; o += pitch) {
    const ox = CARD.x0 - cy * o, oy = CARD.y0 + cx * o;
    const line: Point[] = [{ x: ox - cx * span, y: oy - cy * span }, { x: ox + cx * span, y: oy + cy * span }];
    for (const piece of clipWindow(line)) marks.push(...keepAlong(piece, p => sideOf(bolt, p).dist < half - 0.5, 0.3));
  }
  return marks;
}

export function drawTower(ctx: SketchContext): Part[] {
  const view = towerCamera(ctx);
  const architecture = tower(ctx);
  const strands = pour(ctx);
  const density = n(ctx, 'hatchDensity', 0.6, 0, 1);
  const interruption = n(ctx, 'interruption', 0.32, 0, 1);
  const light = rakingLight(ctx);
  // The paving is drawn in outline only: it leads to the horizon without weighing on it.
  const strokes: Stroke[] = architecture.flatMap((s, owner) => facetStrokes(s, light, view.position, s.role === 'stub')
    .map(stroke => ({ ...stroke, owner })));
  for (const s of strands) {
    for (const stroke of strandStrokes(s, density, interruption, ctx, view)) strokes.push({ ink: stroke.ink, group: 'helix', family: 'membrane', points: stroke.points });
  }
  strokes.push(...storm(ctx));
  const geometries = architecture.map(slabGeometry);
  for (const s of strands) geometries.push(buildSurfaceMesh((u, v) => strandPoint(s, u, 2 * v - 1), {}, 480, 12));
  const pageOf = (p: THREE.Vector3): Point => { const c = p.clone().project(view); return { x: (c.x * 0.5 + 0.5) * TABLOID_PAGE.width, y: (-c.y * 0.5 + 0.5) * TABLOID_PAGE.height }; };
  const lidSlabs = architecture.filter(s => s.role === 'fallen');
  const lidY = lidSlabs.length ? lidSlabs.reduce((t, s) => t + s.y, 0) / lidSlabs.length : CROWN;
  const { main: bolt, branch } = boltPath(ctx, pageOf(new THREE.Vector3(0, lidY, 0)), pageOf(new THREE.Vector3(0, 0, 4.5)));
  const half = 3 + 4 * n(ctx, 'bolt', 0.5, 0, 1);
  // The slip runs along the bolt's overall line, with a little opening across it.
  const along = { x: bolt.at(-1)!.x - bolt[0].x, y: bolt.at(-1)!.y - bolt[0].y };
  const al = Math.hypot(along.x, along.y);
  const amount = 3 + 8 * n(ctx, 'slip', 0.5, 0, 1);
  const slip = { x: along.x / al * amount + along.y / al * amount * 0.25, y: along.y / al * amount - along.x / al * amount * 0.25 };
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    // Candidate faces: off the bolt (no word torn in two), off the shaft (clear of the helix), inside the card.
    const faces = (boltGap: number, shaftGap: number): SloganSurface[] => {
      const out: SloganSurface[] = [];
      architecture.forEach((s, id) => {
        if (s.role !== 'stack' || s.w <= 1.2 || s.h <= 0.3) return;
        const p = pageOf(new THREE.Vector3(s.x, s.y, s.z + s.d / 2));
        const shaftX = pageOf(new THREE.Vector3(0, s.y, 0)).x;
        if (sideOf(bolt, p).dist > half + boltGap && Math.abs(p.x - shaftX) > shaftGap && p.x > CARD.x0 + 8 && p.x < CARD.x1 - 8) {
          out.push({ id, matrix: slabMatrix(s), w: s.w, h: s.h, d: s.d });
        }
      });
      return out;
    };
    const env = {
      view, depth, width: W, height: H, bias: 0.0014, mmPerPx: MM_Y,
      art: { x0: CARD.x0 / MM_X, x1: CARD.x1 / MM_X, y0: CARD.y0 / MM_Y, y1: CARD.y1 / MM_Y },
    };
    // The spread phrase is placed whole or not at all; a few fixed reshuffles keep every seed lettered.
    let slogans = planSlogans(ctx, faces(18, 9), env);
    for (const [k, gaps] of [[18, 9], [12, 6], [8, 4], [8, 0]].entries()) {
      for (let j = 0; j < 6 && slogans.placed.length === 0 && sloganSettings(ctx).count > 0; j++) {
        slogans = planSlogans(ctx, faces(gaps[0], gaps[1]), env, `slogan-${k}-${j}`);
      }
    }
    const pen = sloganSettings(ctx).pen as Ink;
    for (const points of slogans.strokes) strokes.push({ ink: pen, group: 'slogan', family: 'text', points });
    for (const points of slogans.titleStrokes) strokes.push({ ink: 'lettering', group: 'title', family: 'text', points });
    // A face that carries a word keeps its outline and rings but drops its middle field, so the word sits on clean stone.
    const lettered = new Set(slogans.knockouts.keys());
    const allBands = [...slogans.knockouts.values()].flat();
    for (let k = strokes.length - 1; k >= 0; k--) {
      const st = strokes[k];
      if (st.owner !== undefined && lettered.has(st.owner) && st.family === 'hatch' && st.ink !== 'carbon') strokes.splice(k, 1);
    }
    const projection = projectPolylinesClipped(strokes.map(s => s.points), view, W, H);
    const buckets = new Map<string, Point[][]>();
    const add = (key: string, path: Point[], text: boolean) => {
      const reduced = text ? path : simplify(path);
      let length = 0;
      for (let j = 1; j < reduced.length; j++) length += Math.hypot(reduced[j].x - reduced[j - 1].x, reduced[j].y - reduced[j - 1].y);
      if (reduced.length > 1 && length > (text ? 0.05 : 0.5)) {
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(reduced);
      }
    };
    const removeHidden = ctx.params.occlusion !== false;
    for (let i = 0; i < projection.polylines.length; i++) {
      const stroke = strokes[projection.sourceIndices[i]];
      const key = `${stroke.group}-${stroke.ink}`;
      const text = stroke.family === 'text';
      // Words read on top: every other line, the helix and piers in front included, parts round each placed word.
      const bands = text || allBands.length === 0 ? undefined : allBands;
      const pieces = clipProjectedPolyline(projection.polylines[i], W, H).flatMap(c => bands ? clearBands(c, bands, MM_Y) : [c]);
      for (const clipped of pieces) {
        const dense = densifyProjectedPolyline(clipped);
        // Lettering was placed against this depth pass already; the helix parts round it, so it is not hidden again.
        const runs = removeHidden && !text ? splitPolylineByDepth(dense, depth, 0.0014).visible : [dense];
        for (const run of runs) {
          const mm = run.map(p => ({ x: p.x * MM_X, y: p.y * MM_Y }));
          for (const inside of clipWindow(mm)) for (const path of shear(inside, bolt, slip, half)) {
            for (const kept of clipWindow(path)) add(key, kept, text);
          }
        }
      }
    }
    const parts: Part[] = [];
    for (const group of ['storm', 'system', 'helix', 'slogan', 'title']) for (const ink of INKS) {
      const paths = buckets.get(`${group}-${ink}`);
      if (paths?.length) parts.push({ id: `${group}-${ink}`, pen: ink, paths });
    }
    parts.push({ id: 'bolt-carbon', pen: 'carbon', paths: [...bandMarks(bolt, half), ...bandMarks(branch, half * 0.35)].flatMap(p => clipWindow(p)) });
    // The shared horizon, drawn on this card as the ground line either side of the tower.
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: shear([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], bolt, slip, half) });
    parts.push(...cardFrame('XVI', 'THE TOWER'));
    return parts;
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}
