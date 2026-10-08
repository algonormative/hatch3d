import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { PAGE, depthRaster } from '../../kit/format.ts';
import { facetStrokes, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { alongRay, helixStrands, strandPoint, strandStrokes, type Strand } from '../../kit/helix.ts';
import { glyphMask, groundWord, planSloganAttempts, sloganSettings, type SloganSurface } from '../../kit/lettering.ts';
import { circlePath } from '../../kit/fills.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { measureStrokeText } from '../../../src/sketch/stroke-text.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { n } from '../../kit/params.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { atPage, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';

/**
 * XIX The Sun: the sun's bright, unitary power. One enormous disc, blown out to paper, stands over a
 * low wall on the horizon. Its rays alternate as on the old cards, straight and wavy: the straight
 * ones are long slabs radiating from the rim, the wavy ones are the helix. Fine rays fill the whole
 * sky beyond them. The wall, backlit, is the darkest thing on the card and carries the phrase; its
 * long shadow comes toward the viewer across the paving, split by one shaft of light where the wall
 * is breached. The disc's rim, a few flat rings, is the card's flat mark.
 */
const { W, H, MM_X, MM_Y } = depthRaster(559, 864);
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 2.4;
const SUN_DIST = 150;

export function sunCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 40, 80), eye: [0, EYE, 0], target: [0, EYE, -100], far: 800,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

export interface Sun { page: Point; centre: THREE.Vector3; radius: number; rays: Slab[]; waves: { strand: Strand; turn: THREE.Matrix4 }[] }

/** The sun: its centre on the page, its disc in the world, and its two kinds of ray. */
export function sun(ctx: SketchContext, view: THREE.PerspectiveCamera): Sun {
  const rng = ctx.random('sun-rays');
  const window = HORIZON_Y - CARD.y0;
  const page = { x: PAGE.width / 2, y: HORIZON_Y - (0.36 + 0.2 * n(ctx, 'height', 0.5, 0, 1)) * window };
  const centre = atPage(view, page, SUN_DIST);
  // World units per page millimetre at the sun's distance.
  const unit = SUN_DIST / (PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2)));
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
      const turn = alongRay(new THREE.Vector3(centre.x + Math.cos(a) * radius * 1.1, centre.y + Math.sin(a) * radius * 1.1, centre.z), a);
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
    // The phrase. Carved: alternating left and right walls row by row, each word cut into the dark
    // hatch with a hairline of clearance. Ground: painted in the shaft of light between the walls,
    // stretched like a road marking so it reads at this low angle, far to near.
    const settings = sloganSettings(ctx);
    const place = ctx.params.phrasePlace === 'carved' ? 'carved' : 'ground';
    const textStrokes: THREE.Vector3[][] = [];
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
    const toward = s.centre.clone().sub(view.position).normalize();
    const length = w.top / Math.tan(Math.asin(Math.max(0.05, toward.y)));
    const groundY = (z: number) => pageOf(view, new THREE.Vector3(0, 0, z)).y;
    const y0 = groundY(w.z + 0.8), y1 = Math.min(CARD.y1 - 0.5, groundY(Math.min(-5, w.z + length)));
    if (place === 'carved') {
      const env = { view, depth, width: W, height: H, bias: 0.0014, mmPerPx: MM_Y,
        art: { x0: CARD.x0 / MM_X, x1: CARD.x1 / MM_X, y0: CARD.y0 / MM_Y, y1: CARD.y1 / MM_Y } };
      const courses = [...new Set(w.slabs.filter(sl => sl.h > 0.6).map(sl => Math.round(sl.y * 10) / 10))].sort((a, b) => b - a);
      const used = new Set<number>();
      words.forEach((word, i) => {
        const side = i % 2 === 0 ? -1 : 1, row = courses[Math.min(courses.length - 1, Math.floor(i / 2))];
        const candidates = w.slabs.map((sl, id) => ({ sl, id })).filter(({ sl, id }) => !used.has(id) && sl.h > 0.6 && sl.w > 1.8
          && Math.sign(sl.x - (w.breach[0] + w.breach[1]) / 2) === side && Math.abs(sl.y - row) < 0.3);
        const surfaces: SloganSurface[] = candidates.map(({ sl, id }) => ({ id, matrix: slabMatrix(sl), w: sl.w, h: sl.h, d: sl.d }));
        const one = { ...ctx, params: { ...ctx.params, slogan: word, sloganSpread: false, sloganCount: 1 } };
        const plan = planSloganAttempts(one, env, Array.from({ length: 6 }, (_, k) => ({ surfaces: () => surfaces, salt: `carve-${i}-${k}` })));
        if (plan.placed.length) { textStrokes.push(...plan.strokes); used.add(plan.placed[0].id); }
      });
    } else {
      const cap = settings.size + 0.4;
      const style = { face: settings.face, height: cap };
      // Staggered over the whole desert, as the other cards scatter theirs: alternating sides at seeded
      // distances, still reading top to bottom, clear of the wall's shadow.
      const wrng = ctx.random('sun-words');
      let side = wrng() < 0.5 ? -1 : 1;
      // The first word sits well into the desert, where the plates are large enough to read it.
      const top = Math.max(y0 + 8, y1 + 5) + 16;
      words.forEach((word, i) => {
        const target = top + (CARD.y1 - 12 - top) * (i / Math.max(1, words.length - 1)) ** 1.1 + (wrng() - 0.5) * 4;
        const half = measureStrokeText(word, style) / 2 + 6;
        const x = Math.max(CARD.x0 + half, Math.min(CARD.x1 - half, s.page.x + side * (14 + 46 * wrng())));
        side = -side;
        textStrokes.push(...groundWord(view, word, { x, y: target }, style));
      });
    }
    // Project the lettering first: every other mark keeps a hairline clear of its strokes.
    const glyphPaths: Point[][] = [];
    const lettering = projectPolylinesClipped(textStrokes, view, W, H);
    for (const line of lettering.polylines) for (const c of clipProjectedPolyline(line, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, place === 'carved' ? 0.55 : 0.8);
    const drawn = strokes;
    const buckets = new PartBuckets(0.4);
    projectStrokes(drawn, { view, depth, width: W, height: H }, {
      begin: st => {
        const key = `${st.group}-${st.ink}`;
        return runs => {
          for (const run of runs) {
            for (const inside of clipWindow(scalePoints(run, MM_X, MM_Y))) {
              for (const piece of keepAlong(inside, p => !onGlyph(p), 0.15)) buckets.add(key, piece);
            }
          }
        };
      },
    });
    const disc = s.radius * PAGE.height / 2 / (SUN_DIST * Math.tan(THREE.MathUtils.degToRad(view.fov / 2)));
    const solidThings = meshCoverage(geometries, view, PAGE, 1.4);
    // Fine rays over the whole sky, from just beyond the disc, in a fixed 64-step rhythm.
    const rng = ctx.random('sun-fine');
    const pattern = barPattern(rng, 0.8);
    const fine = Math.round(120 + 160 * n(ctx, 'radiance', 0.5, 0, 1));
    for (let k = 0; k < fine; k++) {
      const a = (k + 0.5) / fine * Math.PI * 2;
      const r0 = disc + 4 + (k % 3) * 2.5;
      const line = [{ x: s.page.x + Math.cos(a) * r0, y: s.page.y + Math.sin(a) * r0 }, { x: s.page.x + Math.cos(a) * 400, y: s.page.y + Math.sin(a) * 400 }];
      for (const piece of clipWindow(line, { ...CARD, y1: HORIZON_Y - 1 })) {
        const keep = (p: Point, at: number) => !solidThings(p) && pattern[Math.floor(at / (2 + 0.04 * Math.hypot(p.x - s.page.x, p.y - s.page.y))) % 64];
        for (const run of keepAlong(piece, keep, 0.25)) buckets.add(k % 6 === 0 ? 'radiance-vermilion' : 'radiance-acid', run);
      }
    }
    // The disc's rim: a few flat rings, broken only where a ray stands in front.
    for (let j = 0; j < 4; j++) {
      const r = disc - j * 0.8;
      const ring = circlePath(s.page, r, 240);
      for (const piece of clipWindow(ring)) buckets.add('disc-vermilion', piece);
    }
    // The ground: the wall's long shadow toward the viewer, split by the shaft of light from the breach.
    const left = pageOf(view, new THREE.Vector3(w.breach[0], 0, w.z)), right = pageOf(view, new THREE.Vector3(w.breach[1], 0, w.z));
    // The shaft widens as it comes toward us, along lines from the sun's foot through the breach edges.
    const shaft = (p: Point) => {
      const f = (p.y - y0) / Math.max(1, y1 - y0);
      const l = s.page.x + (left.x - s.page.x) * (1 + 2.2 * f), r = s.page.x + (right.x - s.page.x) * (1 + 2.2 * f);
      return p.x > l && p.x < r;
    };
    for (let y = y0, k = 0; y < y1; y += 0.75 + 0.02 * (y - y0), k++) {
      for (const run of keepAlong([{ x: CARD.x0, y }, { x: CARD.x1, y }], p => !shaft(p) && !onGlyph(p), 0.25)) buckets.add(k % 4 === 0 ? 'shadow-ultramarine' : 'shadow-carbon', run);
    }
    // The ground: a cracked desert. Dried-mud plates (a seeded Voronoi on the ground plane), each drawn
    // as its own slightly shrunken outline so every crack is a double line; perspective does the rest.
    const crng = ctx.random('sun-cracks');
    const cell = 1.6 + 1.6 * n(ctx, 'cracks', 0.5, 0, 1);
    const sites: { x: number; z: number }[] = [];
    const zFar = w.z + 1, zNear = -2.5;
    const cols = Math.ceil(90 / cell), rows = Math.ceil((zNear - zFar) / cell);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      sites.push({ x: -45 + (c + 0.15 + 0.7 * crng()) * cell, z: zFar + (r + 0.15 + 0.7 * crng()) * cell });
    }
    const inShadowRow = (p: Point) => p.y >= y0 && p.y < y1 && !shaft(p);
    for (let i = 0; i < sites.length; i++) {
      const a = sites[i];
      let poly: { x: number; z: number }[] = [
        { x: a.x - cell * 2, z: a.z - cell * 2 }, { x: a.x + cell * 2, z: a.z - cell * 2 },
        { x: a.x + cell * 2, z: a.z + cell * 2 }, { x: a.x - cell * 2, z: a.z + cell * 2 },
      ];
      for (let j = 0; j < sites.length && poly.length > 2; j++) {
        const b = sites[j];
        if (j === i || Math.abs(b.x - a.x) > cell * 2.5 || Math.abs(b.z - a.z) > cell * 2.5) continue;
        // Keep the half-plane nearer a than b.
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, nx = b.x - a.x, nz = b.z - a.z;
        const side = (p: { x: number; z: number }) => (p.x - mx) * nx + (p.z - mz) * nz;
        const out: typeof poly = [];
        for (let k = 0; k < poly.length; k++) {
          const p = poly[k], q = poly[(k + 1) % poly.length], sp = side(p), sq = side(q);
          if (sp <= 0) out.push(p);
          if ((sp < 0) !== (sq < 0)) { const t = sp / (sp - sq); out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t }); }
        }
        poly = out;
      }
      if (poly.length < 3) continue;
      // Shrink toward the site to open the crack, then wobble each edge a little.
      const gap = 0.07 + 0.05 * crng();
      const ring: THREE.Vector3[] = [];
      for (let k = 0; k < poly.length; k++) {
        const p = poly[k], q = poly[(k + 1) % poly.length];
        const steps = Math.max(2, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 0.25));
        for (let t = 0; t < steps; t++) {
          const f = t / steps;
          let x = p.x + (q.x - p.x) * f, z = p.z + (q.z - p.z) * f;
          const d = Math.hypot(x - a.x, z - a.z) || 1;
          const wob = 0.04 * Math.sin(17 * x + 11 * z + i);
          x -= (x - a.x) / d * (gap + wob); z -= (z - a.z) / d * (gap + wob);
          ring.push(new THREE.Vector3(x, 0, z));
        }
      }
      ring.push(ring[0].clone());
      const page = ring.map(p => pageOf(view, p));
      const ys = page.map(p => p.y);
      if (Math.max(...ys) - Math.min(...ys) < 1.2 || Math.min(...ys) < HORIZON_Y) continue;
      for (const piece of clipWindow(page)) {
        for (const run of keepAlong(piece, p => !inShadowRow(p) && !onGlyph(p), 0.2)) buckets.add('ground-carbon', run);
      }
    }
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['radiance', 'disc', 'rays', 'waves', 'wall', 'shadow', 'ground', 'slogan'], INKS);
    // The horizon shows where the wall does not stand: beyond its ends and through the breach.
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solidThings(p), 0.3) });
    parts.push(...cardFrame('XIX', 'THE SUN'));
    return parts;
  } finally {
    for (const g of geometries) g.dispose();
  }
}
