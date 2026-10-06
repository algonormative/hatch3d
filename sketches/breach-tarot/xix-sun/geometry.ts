import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import type { ProjectedPoint } from '../../../src/projection.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../../src/occlusion.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import {
  helixStrands, simplify, slabGeometry, slabMatrix, solid, type Ink, type Slab, type Strand,
} from '../../breach-cathedral-tower/geometry.ts';
import { sloganSettings } from '../../breach-cathedral-tower/slogan.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { keepAlong, meshCoverage } from '../page.ts';

/**
 * XIX The Sun: in full light a thing is known only by its shadow. A long wall faces the viewer, and
 * sunflowers stand in front of it. The light is total: wall, ledges and flower heads are blown out
 * to paper and exist only as the shadows they cast on the wall's face, hatched, offset down and to the
 * right. A breach in the wall holds nothing back: through it, and only there, the horizon shows. The
 * stems are helix strands, the one living thing drawn in colour. The disc in the sky is the card's
 * flat mark, concentric rings: a sign of the sun rather than its astronomical position. The phrase sits
 * in the shadows, on bands cleared of hatch.
 */
const W = 559, H = 864;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 4;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function n(ctx: SketchContext, key: string, fallback: number, lo: number, hi: number): number {
  const v = ctx.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

export function sunCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  const view = new THREE.PerspectiveCamera(n(ctx, 'fov', 54, 40, 80), W / H, 0.5, 600);
  view.position.set(0, EYE, 0);
  view.lookAt(0, EYE, -100);
  view.setViewOffset(W, H, 0, -(HORIZON_Y - TABLOID_PAGE.height / 2) / MM_Y, W, H);
  view.updateProjectionMatrix();
  view.updateMatrixWorld();
  return view;
}

/** The sun on the page, and the unit direction toward it in the world (along the eye's ray). */
export function sunOf(ctx: SketchContext, view: THREE.Camera): { page: Point; dir: THREE.Vector3 } {
  const window = HORIZON_Y - CARD.y0;
  const page = { x: CARD.x0 + (0.14 + 0.3 * n(ctx, 'sunX', 0.3, 0, 1)) * (CARD.x1 - CARD.x0), y: HORIZON_Y - (0.2 + 0.38 * n(ctx, 'sunHeight', 0.8, 0, 1)) * window };
  // The light comes from the front left, from behind the viewer's shoulder, so shadows land on the wall.
  void view;
  const e = (24 + 24 * n(ctx, 'elevation', 0.4, 0, 1)) * Math.PI / 180;
  const flat = new THREE.Vector3(-0.85, 0, 0.6).normalize();
  return { page, dir: flat.multiplyScalar(Math.cos(e)).setY(Math.sin(e)).normalize() };
}

/** A sunflower head: a petalled outline in a plane turned to the light. */
export interface Head { centre: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; radius: number; petals: number; phase: number }
export interface Garden { wallZ: number; wallTop: number; breach: [number, number]; ledges: Slab[]; heads: Head[]; stems: Strand[] }

/** The wall's face plane, ledges jutting from it in the Breach Cathedral grammar, and sunflowers before it. */
export function garden(ctx: SketchContext, sun: THREE.Vector3): Garden {
  const rng = ctx.random('sun-garden');
  const wallZ = -22 - 6 * n(ctx, 'distance', 0.5, 0, 1);
  const wallTop = 12 + 3 * rng();
  const half = 1.8 + 3 * n(ctx, 'breach', 0.5, 0, 1);
  const bx = (rng() - 0.5) * 4;
  const breach: [number, number] = [bx - half, bx + half];
  // Ledges: cantilevered slabs jutting from the face at a few courses; the breach takes them too.
  const ledges: Slab[] = [];
  for (let course = 0; course < 5; course++) {
    const y = 1.6 + course * (wallTop - 2.4) / 4.4 + (rng() - 0.5) * 0.6;
    let x = -18 + rng() * 4;
    while (x < 18) {
      const len = 3 + 7 * rng();
      const cx = x + len / 2;
      if (rng() < 0.85 && (cx + len / 2 < breach[0] - 0.5 || cx - len / 2 > breach[1] + 0.5)) {
        ledges.push(solid(cx, y, wallZ + 0.25, len, 0.22 + 0.12 * rng(), 0.5, ledges.length, 'stack'));
      }
      x += len + 1 + 4 * rng();
    }
  }
  const count = Math.round(4 + 4 * n(ctx, 'flowers', 0.5, 0, 1));
  const heads: Head[] = [];
  const stems: Strand[] = [];
  const template = helixStrands({ ...ctx, params: { helixTurns: 2.4, ...ctx.params } });
  for (let i = 0; i < count; i++) {
    const x = -7.5 + 12 * (i + 0.5) / count + (rng() - 0.5) * 1.2;
    const fz = wallZ + 1.4 + 1.6 * rng();
    const tall = 4.5 + 5 * rng();
    stems.push({ ...template[i % 2], id: i % 2 ? 'b' : 'a', x, y: 0, z: fz, y0: 0, y1: tall, radius: 0.13, depth: 1, width: 0.1, swell: 0,
      centre: 0, phase: rng() * Math.PI * 2, theta0: rng() * Math.PI * 2, turns: 4 + 2 * rng() });
    const centre = stemPoint(stems[stems.length - 1], 1, 0).add(new THREE.Vector3(0, 0.6, 0));
    // Heads turn to the light.
    const normal = sun.clone().setY(sun.y * 0.4).normalize();
    const u = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(u, normal).normalize();
    heads.push({ centre, u, v, radius: 0.85 + 0.45 * rng(), petals: 18 + Math.floor(8 * rng()), phase: rng() * Math.PI * 2 });
  }
  return { wallZ, wallTop, breach, ledges, heads, stems };
}

/** A stem: a smooth double helix, gently swaying, with no wobble of its own. v = −1, 1 are the strands, 0 the spine. */
export function stemPoint(s: Strand, t: number, v: number): THREE.Vector3 {
  const y = s.y0 + t * (s.y1 - s.y0);
  const sway = 0.7 * Math.sin(Math.PI * t * 0.9 + s.phase) * t;
  const th = s.theta0 + 2 * Math.PI * s.turns * t + (v > 0 ? Math.PI : 0);
  const r = v === 0 ? 0 : s.radius;
  return new THREE.Vector3(s.x + sway + r * Math.cos(th), y, s.z + r * Math.sin(th));
}

/** Project a world point along the light onto the wall's face (z = wallZ). */
const toWall = (p: THREE.Vector3, sun: THREE.Vector3, wallZ: number) => p.clone().addScaledVector(sun, -(p.z - wallZ) / sun.z);

/** A head's outline: a seed disc ringed by pointed petals. */
export function headOutline(h: Head, steps = 144): THREE.Vector3[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = i / steps * Math.PI * 2;
    const tooth = Math.abs(((a * h.petals / (Math.PI * 2) + h.phase) % 1) - 0.5) * 2;
    const r = h.radius * (1 + 0.5 * (1 - tooth) ** 1.6);
    return h.centre.clone().addScaledVector(h.u, r * Math.cos(a)).addScaledVector(h.v, r * Math.sin(a));
  });
}

/** A fan mesh from a centre over a closed outline (star-shaped about the centre). */
function fan(centre: THREE.Vector3, outline: THREE.Vector3[]): THREE.BufferGeometry {
  const verts: number[] = [];
  for (let i = 1; i < outline.length; i++) for (const q of [centre, outline[i - 1], outline[i]]) verts.push(q.x, q.y, q.z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  return g;
}

/** Convex hull of 2D points (x, y), as a fan mesh on the wall face. */
function hullMesh(pts: { x: number; y: number }[], z: number): THREE.BufferGeometry {
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: typeof pts[0], a: typeof pts[0], b: typeof pts[0]) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: typeof pts = [], upper: typeof pts = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  const verts: number[] = [];
  for (let i = 1; i < hull.length - 1; i++) for (const q of [hull[0], hull[i], hull[i + 1]]) verts.push(q.x, q.y, z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  return g;
}

/** The shadow a box casts on the wall face. */
function boxShadow(s: Slab, sun: THREE.Vector3, wallZ: number): THREE.BufferGeometry {
  const m = slabMatrix(s);
  const pts: { x: number; y: number }[] = [];
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) {
    const w = toWall(new THREE.Vector3(dx * s.w / 2, dy * s.h / 2, dz * s.d / 2).applyMatrix4(m), sun, wallZ);
    pts.push({ x: w.x, y: w.y });
  }
  return hullMesh(pts, wallZ + 0.02);
}

/** The shadow a head casts on the wall: its outline, sun-projected. */
function headShadow(h: Head, sun: THREE.Vector3, wallZ: number): THREE.BufferGeometry {
  const at = (p: THREE.Vector3) => { const w = toWall(p, sun, wallZ); w.z = wallZ + 0.02; return w; };
  return fan(at(h.centre), headOutline(h).map(at));
}

/** Concentric rings filling a disc on the page: the flat sun. */
function sunDisc(c: Point, r: number, pitch: number): Point[][] {
  const out: Point[][] = [];
  for (let k = r; k > 0.4; k -= pitch) {
    const steps = Math.max(24, Math.round(k * 6));
    out.push(Array.from({ length: steps + 1 }, (_, i) => ({ x: c.x + k * Math.cos(i / steps * Math.PI * 2), y: c.y + k * Math.sin(i / steps * Math.PI * 2) })));
  }
  return out;
}

/** Place the phrase in the shadows: each word on a band wholly inside shadow, reading top to bottom. */
function shadowWords(ctx: SketchContext, inShadow: (p: Point) => boolean): { strokes: Point[][]; bands: { x0: number; x1: number; y0: number; y1: number }[] } {
  const settings = sloganSettings(ctx);
  const empty = { strokes: [], bands: [] };
  if (settings.count === 0) return empty;
  const rng = ctx.random('sun-words');
  const size = settings.size;
  const style = { face: settings.face, height: size };
  const words = settings.text.split(' ').filter(Boolean);
  const bands: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const strokes: Point[][] = [];
  const fits = (b: { x0: number; x1: number; y0: number; y1: number }) => {
    for (let i = 0; i <= 6; i++) for (let j = 0; j <= 2; j++) {
      if (!inShadow({ x: b.x0 + (b.x1 - b.x0) * i / 6, y: b.y0 + (b.y1 - b.y0) * j / 2 })) return false;
    }
    return !bands.some(o => b.x0 < o.x1 + 2 && o.x0 < b.x1 + 2 && b.y0 < o.y1 + 2 && o.y0 < b.y1 + 2);
  };
  // The words spread over the height the shadows actually span.
  let top = Infinity, bottom = -Infinity;
  for (let y = CARD.y0; y < CARD.y1; y += 2) for (let x = CARD.x0; x < CARD.x1; x += 2) {
    if (inShadow({ x, y })) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  if (!Number.isFinite(top)) return empty;
  // Scan on a grid for every band a word fits inside; pick, in reading order, the one nearest its share
  // of that height. Deterministic, so small patches of shadow are never missed; a tighter spread is tried
  // if the phrase does not fit.
  for (const spread of [1, 0.75, 0.5, 0.25]) {
    bands.length = 0; strokes.length = 0;
    let prev = top - 4, ok = true;
    for (let i = 0; i < words.length && ok; i++) {
      const width = measureStrokeText(words[i], style) + 0.2 * size;
      const target = top + (bottom - top) * spread * (i + 0.5) / words.length;
      let best: { x0: number; y0: number; band: { x0: number; x1: number; y0: number; y1: number } } | null = null, score = Infinity;
      for (let y0 = prev + 2.5; y0 < CARD.y1 - size * 2; y0 += 1.5) {
        for (let x0 = CARD.x0 + 4; x0 < CARD.x1 - width - 4; x0 += 2) {
          const band = { x0: x0 - 1.4, x1: x0 + width + 1.4, y0: y0 - 1.2, y1: y0 + size * 1.5 + 1.2 };
          const value = Math.abs(y0 - target) + 6 * rng();
          if (value >= score || !fits(band)) continue;
          best = { x0, y0, band }; score = value;
        }
      }
      if (!best) { ok = false; break; }
      bands.push(best.band);
      strokes.push(...strokeText(words[i], best.x0, best.y0, style));
      prev = best.band.y1;
    }
    if (ok) return { strokes, bands };
  }
  return empty;
  return { strokes, bands };
}

export function drawSun(ctx: SketchContext): Part[] {
  const view = sunCamera(ctx);
  const sun = sunOf(ctx, view);
  const { wallZ, wallTop, breach, ledges, heads, stems } = garden(ctx, sun.dir);
  // Things in front of the wall still stand in the depth pass, so their silhouettes cut the shadows.
  const geometries = [...ledges.map(slabGeometry), ...heads.map(h => fan(h.centre, headOutline(h)))];
  const stemMeshes = stems.map(s => buildSurfaceMesh((u, v) => stemPoint(s, u, 0).add(new THREE.Vector3(s.radius * Math.cos(v * Math.PI * 2), 0, s.radius * Math.sin(v * Math.PI * 2))), {}, 120, 8));
  geometries.push(...stemMeshes);
  const shadows = [...ledges.map(s => boxShadow(s, sun.dir, wallZ)), ...heads.map(h => headShadow(h, sun.dir, wallZ))];
  // The wall's face, as the only surface shadows can land on: from the ground to its top, open at the breach.
  const face = (p: Point): boolean => {
    const ndc = new THREE.Vector3(p.x / TABLOID_PAGE.width * 2 - 1, -(p.y / TABLOID_PAGE.height * 2 - 1), 0.5).unproject(view);
    const dir = ndc.sub(view.position);
    const w = view.position.clone().addScaledVector(dir, (wallZ - view.position.z) / dir.z);
    return w.y > 0 && w.y < wallTop && (w.x < breach[0] || w.x > breach[1]);
  };
  const wallDepth = (p: Point): number => {
    const ndc = new THREE.Vector3(p.x / TABLOID_PAGE.width * 2 - 1, -(p.y / TABLOID_PAGE.height * 2 - 1), 0.5).unproject(view);
    const dir = ndc.sub(view.position);
    const v = view.position.clone().addScaledVector(dir, (wallZ - view.position.z) / dir.z).project(view);
    return v.z * 0.5 + 0.5;
  };
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    const cast = meshCoverage(shadows, view, TABLOID_PAGE, 0, 5);
    const inShadow = (p: Point) => face(p) && cast(p);
    const words = shadowWords(ctx, inShadow);
    const onWord = (p: Point) => words.bands.some(b => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1);
    // Each head's shadow keeps its seeds: a golden-angle spiral of paper points left in the hatch.
    const pageOf = (w: THREE.Vector3): Point => { const q = w.clone().project(view); return { x: (q.x * 0.5 + 0.5) * TABLOID_PAGE.width, y: (-q.y * 0.5 + 0.5) * TABLOID_PAGE.height }; };
    const seeds: Point[] = heads.flatMap(h => Array.from({ length: 55 }, (_, k) => {
      const r = h.radius * 0.92 * Math.sqrt((k + 1) / 55), a = (k + 1) * GOLDEN;
      return pageOf(toWall(h.centre.clone().addScaledVector(h.u, r * Math.cos(a)).addScaledVector(h.v, r * Math.sin(a)), sun.dir, wallZ));
    }));
    const onSeed = (p: Point) => seeds.some(q => Math.abs(p.x - q.x) < 0.75 && Math.abs(p.y - q.y) < 0.75 && Math.hypot(p.x - q.x, p.y - q.y) < 0.75);
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
    const ledgeCast = meshCoverage(ledges.map(l => boxShadow(l, sun.dir, wallZ)), view, TABLOID_PAGE, 0, 5);
    const ledgeShadow = (p: Point) => ledgeCast(p);
    const pitch = 0.62 + 0.4 * (1 - n(ctx, 'shade', 0.5, 0, 1));
    const families: [number, number, Ink, (p: Point) => boolean][] = [
      [-0.75, pitch, 'carbon', () => true],
      // A second, crossing family deepens the ledges' shadows, the heaviest in the card.
      [0.55, pitch * 1.5, 'ultramarine', p => ledgeShadow(p)],
    ];
    for (const [angle, step, ink, where] of families) {
      const dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
      const cx = (CARD.x0 + CARD.x1) / 2, cy = (CARD.y0 + CARD.y1) / 2;
      const span = Math.hypot(CARD.x1 - CARD.x0, CARD.y1 - CARD.y0);
      for (let o = -span; o < span; o += step) {
        const line = [{ x: cx + nx * o - dx * span, y: cy + ny * o - dy * span }, { x: cx + nx * o + dx * span, y: cy + ny * o + dy * span }];
        for (const piece of clipWindow(line)) {
          for (const run of keepAlong(piece, p => inShadow(p) && where(p) && !onWord(p) && !onSeed(p), 0.12)) {
            const projected: ProjectedPoint[] = run.map(p => ({ x: p.x / MM_X, y: p.y / MM_Y, depth: wallDepth(p) }));
            for (const vis of splitPolylineByDepth(densifyProjectedPolyline(projected), depth, 0.0014).visible) {
              add(`shadow-${ink}`, vis.map(q => ({ x: q.x * MM_X, y: q.y * MM_Y })));
            }
          }
        }
      }
    }
    // The stems: drawn in full, the living thing in the light, hidden only where a blown-out thing stands in front.
    // A clean double helix per stem: its two edges and the spine, no laminations at this size.
    const trace = (s: Strand, v: number) => Array.from({ length: 241 }, (_, i) => stemPoint(s, i / 240, v));
    const stemStrokes = stems.flatMap((s, i) => [
      { ink: 'vermilion' as Ink, points: trace(s, -1) }, { ink: 'vermilion' as Ink, points: trace(s, 1) },
      { ink: (i % 2 ? 'violet' : 'acid') as Ink, points: trace(s, 0) },
    ]);
    const projection = projectPolylinesClipped(stemStrokes.map(s => s.points), view, W, H);
    for (let i = 0; i < projection.polylines.length; i++) {
      const stroke = stemStrokes[projection.sourceIndices[i]];
      for (const clipped of clipProjectedPolyline(projection.polylines[i], W, H)) {
        for (const run of splitPolylineByDepth(densifyProjectedPolyline(clipped), depth, 0.0014).visible) {
          for (const inside of clipWindow(run.map(p => ({ x: p.x * MM_X, y: p.y * MM_Y })))) add(`stem-${stroke.ink}`, inside);
        }
      }
    }
    // A stem's shadow is a line drawing too: its double helix, cast on the wall, where the wall is.
    for (const s of stems) for (const v of [-1, 1]) {
      const pts = Array.from({ length: 241 }, (_, i) => toWall(stemPoint(s, i / 240, v), sun.dir, wallZ));
      const projected = projectPolylinesClipped([pts], view, W, H);
      for (const line of projected.polylines) for (const clipped of clipProjectedPolyline(line, W, H)) {
        const mm = densifyProjectedPolyline(clipped).map(p => ({ x: p.x * MM_X, y: p.y * MM_Y }));
        for (const run of keepAlong(mm, p => face(p) && !onWord(p), 0.2)) {
          const back: ProjectedPoint[] = run.map(p => ({ x: p.x / MM_X, y: p.y / MM_Y, depth: wallDepth(p) }));
          for (const vis of splitPolylineByDepth(densifyProjectedPolyline(back), depth, 0.0014).visible) add('shadow-carbon', vis.map(q => ({ x: q.x * MM_X, y: q.y * MM_Y })));
        }
      }
    }
    for (const p of words.strokes) add('slogan-lettering', p, true);
    const parts: Part[] = [];
    for (const group of ['shadow', 'stem', 'slogan']) for (const ink of INKS) {
      const paths = buckets.get(`${group}-${ink}`);
      if (paths?.length) parts.push({ id: `${group}-${ink}`, pen: ink, paths });
    }
    const radius = 12 + 10 * n(ctx, 'sunSize', 0.5, 0, 1);
    parts.push({ id: 'sun-vermilion', pen: 'vermilion', paths: [...sunDisc(sun.page, radius, 0.75), ...sunDisc(sun.page, radius + 2.2, 99)].flatMap(p => clipWindow(p)) });
    // The horizon shows only through the breach: elsewhere the wall stands in front of it.
    const pageX = (x: number) => { const q = new THREE.Vector3(x, 0, wallZ).project(view); return (q.x * 0.5 + 0.5) * TABLOID_PAGE.width; };
    const horizon = clipWindow([{ x: pageX(breach[0]), y: HORIZON_Y }, { x: pageX(breach[1]), y: HORIZON_Y }]);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: horizon });
    parts.push(...cardFrame('XIX', 'THE SUN'));
    return parts;
  } finally {
    for (const g of [...geometries, ...shadows]) g.dispose();
  }
}
