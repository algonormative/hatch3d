import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../../src/occlusion.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import {
  helixStrands, simplify, slabGeometry, slabMatrix, solid, strandPoint, strandStrokes, type Ink, type Slab, type Strand,
} from '../../breach-cathedral-tower/geometry.ts';
import { clearBands, planSlogans, sloganSettings, type SloganSurface } from '../../breach-cathedral-tower/slogan.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { keepAlong, meshCoverage } from '../page.ts';
import { facetStrokes } from '../xvi-tower/geometry.ts';

/**
 * XIX The Sun: the sun's bright, unitary power. One enormous disc, blown out to paper, stands over a
 * low wall on the horizon. Its rays alternate as on the old cards, straight and wavy: the straight
 * ones are long slabs radiating from the rim, the wavy ones are the helix. Fine rays fill the whole
 * sky beyond them. The wall, backlit, is the darkest thing on the card and carries the phrase; its
 * long shadow comes toward the viewer across the paving, split by one shaft of light where the wall
 * is breached. The disc's rim, a few flat rings, is the card's flat mark.
 */
type Family = 'edge' | 'hatch' | 'membrane' | 'text';
type Stroke = { ink: Ink; group: string; family: Family; points: THREE.Vector3[]; owner?: number };

const W = 559, H = 864;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 2.4;
const SUN_DIST = 150;

function n(ctx: SketchContext, key: string, fallback: number, lo: number, hi: number): number {
  const v = ctx.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

export function sunCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  const view = new THREE.PerspectiveCamera(n(ctx, 'fov', 54, 40, 80), W / H, 0.5, 800);
  view.position.set(0, EYE, 0);
  view.lookAt(0, EYE, -100);
  view.setViewOffset(W, H, 0, -(HORIZON_Y - TABLOID_PAGE.height / 2) / MM_Y, W, H);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
}

const pageOf = (view: THREE.Camera, w: THREE.Vector3): Point => {
  const q = w.clone().project(view);
  return { x: (q.x * 0.5 + 0.5) * TABLOID_PAGE.width, y: (-q.y * 0.5 + 0.5) * TABLOID_PAGE.height };
};
const atPage = (view: THREE.Camera, p: Point, dist: number): THREE.Vector3 => {
  const ndc = new THREE.Vector3(p.x / TABLOID_PAGE.width * 2 - 1, -(p.y / TABLOID_PAGE.height * 2 - 1), 0.5).unproject(view);
  return view.position.clone().addScaledVector(ndc.sub(view.position).normalize(), dist);
};

export interface Sun { page: Point; centre: THREE.Vector3; radius: number; rays: Slab[]; waves: { strand: Strand; turn: THREE.Matrix4 }[] }

/** The sun: its centre on the page, its disc in the world, and its two kinds of ray. */
export function sun(ctx: SketchContext, view: THREE.PerspectiveCamera): Sun {
  const rng = ctx.random('sun-rays');
  const window = HORIZON_Y - CARD.y0;
  const page = { x: TABLOID_PAGE.width / 2, y: HORIZON_Y - (0.36 + 0.2 * n(ctx, 'height', 0.5, 0, 1)) * window };
  const centre = atPage(view, page, SUN_DIST);
  // World units per page millimetre at the sun's distance.
  const unit = SUN_DIST / (TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2)));
  const radius = (30 + 22 * n(ctx, 'size', 0.5, 0, 1)) * unit;
  const count = 2 * Math.round(6 + 4 * n(ctx, 'rays', 0.5, 0, 1));
  const spin = rng() * Math.PI / count;
  const rays: Slab[] = [];
  const waves: { strand: Strand; turn: THREE.Matrix4 }[] = [];
  const template = helixStrands({ ...ctx, params: { helixTurns: 3, shellTwist: 0.25, ...ctx.params } });
  for (let k = 0; k < count; k++) {
    const a = spin + k * Math.PI * 2 / count;
    // Rays that would reach down past the horizon are left out: the sun stands over the wall, not in front of it.
    if (Math.sin(a) < -0.6) continue;
    const reach = (k % 4 === 0 ? 70 : k % 2 === 0 ? 52 : 60) * unit * (0.9 + 0.2 * rng());
    if (k % 2 === 0) {
      // Straight ray: a long slab from the rim outward, stepping thinner toward its tip.
      for (let j = 0; j < 3; j++) {
        const r0 = radius * 1.08 + j * reach / 3, len = reach / 3 - 0.8 * unit;
        const thick = (5.2 - 1.4 * j) * unit;
        const s = solid(centre.x + Math.cos(a) * (r0 + len / 2), centre.y + Math.sin(a) * (r0 + len / 2), centre.z, len, thick, thick * 1.2, k * 3 + j, 'stack');
        s.rz = a; s.tone = 0.3;
        rays.push(s);
      }
    } else {
      // Wavy ray: a helix strand laid along the ray, from the rim outward.
      const strand: Strand = { ...template[(k >> 1) % 2], x: 0, y: 0, z: 0, y0: 0, y1: reach * 0.95, radius: 2.4 * unit, depth: 1, width: 2 * unit,
        swell: 0, centre: 0, phase: rng() * Math.PI * 2, turns: 2.5 + rng() };
      // Strand space runs up +y; turn it onto the ray and set it at the rim.
      const turn = new THREE.Matrix4().makeTranslation(centre.x + Math.cos(a) * radius * 1.1, centre.y + Math.sin(a) * radius * 1.1, centre.z)
        .multiply(new THREE.Matrix4().makeRotationZ(a - Math.PI / 2));
      waves.push({ strand, turn });
    }
  }
  return { page, centre, radius, rays, waves };
}

export interface Wall { slabs: Slab[]; z: number; top: number; breach: [number, number] }

/** A low wall in the Breach Cathedral's courses along the horizon, breached once. */
export function wall(ctx: SketchContext): Wall {
  const rng = ctx.random('sun-wall');
  const z = -44 - 10 * n(ctx, 'distance', 0.5, 0, 1);
  const half = 0.8 + 1.6 * n(ctx, 'breach', 0.5, 0, 1);
  const bx = (rng() - 0.5) * 3;
  const breach: [number, number] = [bx - half, bx + half];
  const slabs: Slab[] = [];
  const courses = 3;
  for (let c = 0; c < courses; c++) {
    let x = -26 + (c % 2) * 1.2 - rng();
    while (x < 26) {
      const len = 2.2 + 3.4 * rng();
      const cx = x + len / 2;
      if (cx + len / 2 < breach[0] || cx - len / 2 > breach[1]) {
        const s = solid(cx, 0.55 + c * 1.05, z + (rng() - 0.5) * 0.4, len - 0.1, 1.0, 1.6, slabs.length, 'stack');
        s.tone = 1.1;
        slabs.push(s);
      }
      x += len;
    }
  }
  // A cantilevered coping along the top, overhanging toward the viewer.
  for (let k = 0; k < 4; k++) {
    const len = 3 + 4 * rng(), cx = -24 + rng() * 48;
    if (cx + len / 2 < breach[0] || cx - len / 2 > breach[1]) {
      const s = solid(cx, 3.35, z + 0.5, len, 0.35, 2.4, slabs.length, 'stack');
      s.tone = 1.1;
      slabs.push(s);
    }
  }
  return { slabs, z, top: 3.5, breach };
}

export function drawSun(ctx: SketchContext): Part[] {
  const view = sunCamera(ctx);
  const s = sun(ctx, view);
  const w = wall(ctx);
  const back = new THREE.Vector3(0, 0.35, -1).normalize();
  const strokes: Stroke[] = [];
  // Rays lit from the front: pale, a few rings. The wall is lit from behind by the sun: dark faces.
  s.rays.forEach((r, i) => strokes.push(...facetStrokes(r, new THREE.Vector3(0.2, 0.3, 1).normalize(), view.position, false)
    .map(st => ({ ...st, group: 'rays', owner: 1000 + i }))));
  w.slabs.forEach((sl, owner) => strokes.push(...facetStrokes(sl, back, view.position, false).map(st => ({ ...st, group: 'wall', owner }))));
  for (const { strand, turn } of s.waves) for (const st of strandStrokes(strand, 0.4, 0.25, ctx, view)) {
    strokes.push({ ink: st.ink, group: 'waves', family: 'membrane', points: st.points.map(p => p.clone().applyMatrix4(turn)) });
  }
  const geometries = [...w.slabs.map(slabGeometry), ...s.rays.map(slabGeometry)];
  for (const { strand, turn } of s.waves) {
    const g = buildSurfaceMesh((u, v) => strandPoint(strand, u, 2 * v - 1), {}, 240, 8);
    g.applyMatrix4(turn);
    geometries.push(g);
  }
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    // The phrase on the wall's faces; faces carrying a word drop their middle hatch.
    const surfaces: SloganSurface[] = w.slabs.map((sl, id) => ({ id, matrix: slabMatrix(sl), w: sl.w, h: sl.h, d: sl.d }))
      .filter(f => f.w > 1.8 && f.h > 0.6);
    const env = { view, depth, width: W, height: H, bias: 0.0014, mmPerPx: MM_Y,
      art: { x0: CARD.x0 / MM_X, x1: CARD.x1 / MM_X, y0: CARD.y0 / MM_Y, y1: CARD.y1 / MM_Y } };
    let slogans = planSlogans(ctx, surfaces, env);
    for (let k = 1; k < 8 && slogans.placed.length === 0 && sloganSettings(ctx).count > 0; k++) slogans = planSlogans(ctx, surfaces, env, `slogan-${k}`);
    const lettered = new Set(slogans.knockouts.keys());
    const drawn = strokes.filter(st => !(st.owner !== undefined && lettered.has(st.owner) && st.family === 'hatch' && st.ink !== 'carbon'));
    const pen = sloganSettings(ctx).pen as Ink;
    for (const points of slogans.strokes) drawn.push({ ink: pen, group: 'slogan', family: 'text', points });
    const allBands = [...slogans.knockouts.values()].flat();
    const projection = projectPolylinesClipped(drawn.map(st => st.points), view, W, H);
    const buckets = new Map<string, Point[][]>();
    const add = (key: string, path: Point[], exact = false) => {
      const reduced = exact ? path : simplify(path);
      let length = 0;
      for (let j = 1; j < reduced.length; j++) length += Math.hypot(reduced[j].x - reduced[j - 1].x, reduced[j].y - reduced[j - 1].y);
      if (reduced.length > 1 && length > (exact ? 0.05 : 0.4)) {
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(reduced);
      }
    };
    for (let i = 0; i < projection.polylines.length; i++) {
      const st = drawn[projection.sourceIndices[i]];
      const text = st.family === 'text';
      const bands = text || allBands.length === 0 ? undefined : allBands;
      for (const clipped of clipProjectedPolyline(projection.polylines[i], W, H).flatMap(c => bands ? clearBands(c, bands, MM_Y) : [c])) {
        const runs = text ? [densifyProjectedPolyline(clipped)] : splitPolylineByDepth(densifyProjectedPolyline(clipped), depth, 0.0014).visible;
        for (const run of runs) for (const inside of clipWindow(run.map(p => ({ x: p.x * MM_X, y: p.y * MM_Y })))) add(`${st.group}-${st.ink}`, inside, text);
      }
    }
    const disc = s.radius * TABLOID_PAGE.height / 2 / (SUN_DIST * Math.tan(THREE.MathUtils.degToRad(view.fov / 2)));
    const solidThings = meshCoverage(geometries, view, TABLOID_PAGE, 1.4);
    // Fine rays over the whole sky, from just beyond the disc, in a fixed 64-step rhythm.
    const rng = ctx.random('sun-fine');
    const pattern = Array.from({ length: 64 }, (_, k) => k % 8 !== 7 && rng() < 0.8);
    const fine = Math.round(120 + 160 * n(ctx, 'radiance', 0.5, 0, 1));
    for (let k = 0; k < fine; k++) {
      const a = (k + 0.5) / fine * Math.PI * 2;
      const r0 = disc + 4 + (k % 3) * 2.5;
      const line = [{ x: s.page.x + Math.cos(a) * r0, y: s.page.y + Math.sin(a) * r0 }, { x: s.page.x + Math.cos(a) * 400, y: s.page.y + Math.sin(a) * 400 }];
      for (const piece of clipWindow(line, { ...CARD, y1: HORIZON_Y - 1 })) {
        const keep = (p: Point, at: number) => !solidThings(p) && pattern[Math.floor(at / (2 + 0.04 * Math.hypot(p.x - s.page.x, p.y - s.page.y))) % 64];
        for (const run of keepAlong(piece, keep, 0.25)) add(k % 6 === 0 ? 'radiance-vermilion' : 'radiance-acid', run);
      }
    }
    // The disc's rim: a few flat rings, broken only where a ray stands in front.
    for (let j = 0; j < 4; j++) {
      const r = disc - j * 0.8;
      const ring = Array.from({ length: 241 }, (_, i) => ({ x: s.page.x + r * Math.cos(i / 240 * Math.PI * 2), y: s.page.y + r * Math.sin(i / 240 * Math.PI * 2) }));
      for (const piece of clipWindow(ring)) add('disc-vermilion', piece);
    }
    // The ground: the wall's long shadow toward the viewer, split by the shaft of light from the breach.
    const toward = s.centre.clone().sub(view.position).normalize();
    const length = w.top / Math.tan(Math.asin(Math.max(0.05, toward.y)));
    const groundY = (z: number) => pageOf(view, new THREE.Vector3(0, 0, z)).y;
    const y0 = groundY(w.z + 0.8), y1 = Math.min(CARD.y1 - 0.5, groundY(Math.min(-5, w.z + length)));
    const left = pageOf(view, new THREE.Vector3(w.breach[0], 0, w.z)), right = pageOf(view, new THREE.Vector3(w.breach[1], 0, w.z));
    // The shaft widens as it comes toward us, along lines from the sun's foot through the breach edges.
    const shaft = (p: Point) => {
      const f = (p.y - y0) / Math.max(1, y1 - y0);
      const l = s.page.x + (left.x - s.page.x) * (1 + 2.2 * f), r = s.page.x + (right.x - s.page.x) * (1 + 2.2 * f);
      return p.x > l && p.x < r;
    };
    for (let y = y0, k = 0; y < y1; y += 0.75 + 0.02 * (y - y0), k++) {
      for (const run of keepAlong([{ x: CARD.x0, y }, { x: CARD.x1, y }], p => !shaft(p), 0.25)) add(k % 4 === 0 ? 'shadow-ultramarine' : 'shadow-carbon', run);
    }
    // Paving from the shadow's edge to the foot of the card: outlines only, running toward the sun's foot.
    for (let c = -24; c <= 24; c++) {
      const far = pageOf(view, new THREE.Vector3(c * 1.6, 0, w.z + length)), near = pageOf(view, new THREE.Vector3(c * 1.6, 0, -2.5));
      for (const piece of clipWindow([far, near], { ...CARD, y0: y1 + 0.6 })) add('paving-carbon', piece);
    }
    for (let z = w.z + length + 1.5, k = 0; z < -2.5 && k < 40; z += 1.2 + 0.15 * k, k++) {
      const y = groundY(z);
      for (const piece of clipWindow([{ x: CARD.x0, y }, { x: CARD.x1, y }], { ...CARD, y0: y1 + 0.6 })) add('paving-carbon', piece);
    }
    const parts: Part[] = [];
    for (const group of ['radiance', 'disc', 'rays', 'waves', 'wall', 'shadow', 'paving', 'slogan']) for (const ink of INKS) {
      const paths = buckets.get(`${group}-${ink}`);
      if (paths?.length) parts.push({ id: `${group}-${ink}`, pen: ink, paths });
    }
    // The horizon shows where the wall does not stand: beyond its ends and through the breach.
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solidThings(p), 0.3) });
    parts.push(...cardFrame('XIX', 'THE SUN'));
    return parts;
  } finally {
    for (const g of geometries) g.dispose();
  }
}
