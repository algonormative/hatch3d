import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh, projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../../src/occlusion.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import {
  helixStrands, simplify, slabGeometry, slabMatrix, slabStrokes, solid, strandPoint, strandStrokes, towerSlabs,
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

/** The helix pours up out of the opened shaft and flares above the lifted crown. */
function pour(ctx: SketchContext): Strand[] {
  const rise = n(ctx, 'pour', 0.5, 0, 1);
  return helixStrands({ ...ctx, params: { helixTurns: 1.6, ...ctx.params } }).map(s => ({
    ...s, x: 0, y: 0, z: 0,
    y0: CROWN - 8 + (s.id === 'b' ? 0.8 : 0), y1: CROWN + 4 + 3 * rise - (s.id === 'b' ? 1.2 : 0),
    radius: 0.95 * (s.id === 'b' ? 0.92 : 1), swell: 0.8 + 1.4 * rise, centre: CROWN + 4.5 + 3 * rise,
    width: n(ctx, 'shellWidth', 0.9, 0.4, 1.8) * (s.id === 'b' ? 0.9 : 1),
  }));
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
  const beatRng = ctx.random('tower-card-rests');
  const beats = Array.from({ length: 64 }, () => beatRng() < interruption);
  const strokes: Stroke[] = architecture.flatMap((s, owner) => slabStrokes(s, density, beats[(s.beat * 7) % 64])
    // The paving is drawn in outline only: it leads to the horizon without weighing on it.
    .filter((_, k) => s.role !== 'stub' || k < 6)
    .map((stroke, k): Stroke => ({ ink: stroke.ink, group: 'system', family: k < 6 ? 'edge' : 'hatch', points: stroke.points, owner })));
  for (const s of strands) {
    for (const stroke of strandStrokes(s, density, interruption, ctx, view)) strokes.push({ ink: stroke.ink, group: 'helix', family: 'membrane', points: stroke.points });
  }
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
    const surfaces: SloganSurface[] = [];
    architecture.forEach((s, id) => {
      if (s.role !== 'stack' || s.w <= 1.2 || s.h <= 0.3) return;
      const c = new THREE.Vector3(s.x, s.y, s.z + s.d / 2).project(view);
      const p = { x: (c.x * 0.5 + 0.5) * TABLOID_PAGE.width, y: (-c.y * 0.5 + 0.5) * TABLOID_PAGE.height };
      // Keep words off the bolt, so no word is torn in two.
      if (sideOf(bolt, p).dist > half + 18) surfaces.push({ id, matrix: slabMatrix(s), w: s.w, h: s.h, d: s.d });
    });
    const slogans = planSlogans(ctx, surfaces, {
      view, depth, width: W, height: H, bias: 0.0014, mmPerPx: MM_Y,
      art: { x0: CARD.x0 / MM_X, x1: CARD.x1 / MM_X, y0: CARD.y0 / MM_Y, y1: CARD.y1 / MM_Y },
    });
    const pen = sloganSettings(ctx).pen as Ink;
    for (const points of slogans.strokes) strokes.push({ ink: pen, group: 'slogan', family: 'text', points });
    for (const points of slogans.titleStrokes) strokes.push({ ink: 'lettering', group: 'title', family: 'text', points });
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
      const bands = stroke.owner === undefined ? undefined : slogans.knockouts.get(stroke.owner);
      const pieces = clipProjectedPolyline(projection.polylines[i], W, H).flatMap(c => bands ? clearBands(c, bands, MM_Y) : [c]);
      for (const clipped of pieces) {
        const dense = densifyProjectedPolyline(clipped);
        const runs = removeHidden ? splitPolylineByDepth(dense, depth, 0.0014).visible : [dense];
        for (const run of runs) {
          const mm = run.map(p => ({ x: p.x * MM_X, y: p.y * MM_Y }));
          for (const inside of clipWindow(mm)) for (const path of shear(inside, bolt, slip, half)) {
            for (const kept of clipWindow(path)) add(key, kept, text);
          }
        }
      }
    }
    const parts: Part[] = [];
    for (const group of ['system', 'helix', 'slogan', 'title']) for (const ink of INKS) {
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
