import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { buildSurfaceMesh } from '../../../src/projection.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { PAGE, depthRaster, scaledCount } from '../../kit/format.ts';
import { towerSlabs } from '../../breach-cathedral-tower/geometry.ts';
import { facetStrokes, rakingLight, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { helixStrands, strandPoint, strandStrokes, type Strand } from '../../kit/helix.ts';
import { clearBands, planSloganAttempts, sloganSettings, type SloganSurface } from '../../kit/lettering.ts';
import { bandMarks, sideOf } from '../../kit/fills.ts';
import type { Ink, Stroke } from '../../kit/types.ts';

// The raking-light hatch lives in the sketch kit; re-exported for older importers.
export { facetStrokes, faceDarkness, rakingLight } from '../../kit/slabs.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { n } from '../../kit/params.ts';
import { densify, keepAlong } from '../../kit/page.ts';
import { horizonCamera, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';

/**
 * XVI The Tower: the page is struck, not the tower. A flat hatched lightning band runs down the
 * whole card, and everything on one side of it has slipped along the tear like a misregistered
 * print. The tower itself is unsealed rather than destroyed: its crown lifts off like a lid and
 * the helix pours up out of the opened shaft.
 */
const { W, H, MM_X, MM_Y } = depthRaster(559, 864);
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 2.2;
/** The tower's own frame: Breach Cathedral Tower coordinates run from −10.9 to 10.6; ground is 0 here. */
const LIFT = 10.9, CROWN = 10.6 + LIFT;

/** A level camera at eye height, shifted so the horizon sits on the set's shared line. */
export function towerCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 56, 40, 80), eye: [0, EYE, n(ctx, 'distance', 48, 30, 90)], target: [0, EYE, 0], far: 400,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/** The cathedral tower on the ground, its crown slabs lifted off and turned like a lid. */
export function tower(ctx: SketchContext): Slab[] {
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

/** The fewest raindrops (of the whole fall, most of it hidden or off the card) a smaller card keeps, so it still storms. */
const RAIN_FLOOR = 300;
const GOLDEN = 0.6180339887498949;

/**
 * The storm: slanted rain on a backdrop plane behind the tower, so the depth pass keeps it behind
 * everything. Dashes thicken toward the top of the sky into a cloud bank and thin out to the horizon;
 * a fixed 64-step rhythm breaks each fall. The drops are a density: a smaller card keeps fewer of the
 * same fall, as an even spread through it. Each dash shrinks with the card, so the count goes with the
 * scale rather than the area: that keeps the rain's tone on paper (by area it all but vanished).
 */
export function storm(ctx: SketchContext): Stroke[] {
  const amount = n(ctx, 'storm', 0.5, 0, 1);
  if (amount <= 0) return [];
  const rng = ctx.random('tower-card-storm');
  const pattern = barPattern(rng, 0.75);
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
  const keep = out.length ? scaledCount(out.length, RAIN_FLOOR, 'length') / out.length : 1;
  return keep >= 1 ? out : out.filter((_, i) => (i * GOLDEN) % 1 < keep);
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
  const pageAt = (p: THREE.Vector3): Point => pageOf(view, p);
  const lidSlabs = architecture.filter(s => s.role === 'fallen');
  const lidY = lidSlabs.length ? lidSlabs.reduce((t, s) => t + s.y, 0) / lidSlabs.length : CROWN;
  const { main: bolt, branch } = boltPath(ctx, pageAt(new THREE.Vector3(0, lidY, 0)), pageAt(new THREE.Vector3(0, 0, 4.5)));
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
        const p = pageAt(new THREE.Vector3(s.x, s.y, s.z + s.d / 2));
        const shaftX = pageAt(new THREE.Vector3(0, s.y, 0)).x;
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
    const tiers = [[18, 9], [12, 6], [8, 4], [8, 0]];
    const slogans = planSloganAttempts(ctx, env, [
      { surfaces: () => faces(18, 9) },
      ...tiers.flatMap((gaps, k) => Array.from({ length: 6 }, (_, j) => ({ surfaces: () => faces(gaps[0], gaps[1]), salt: `slogan-${k}-${j}` }))),
    ]);
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
    const buckets = new PartBuckets();
    const removeHidden = ctx.params.occlusion !== false;
    projectStrokes(strokes, { view, depth, width: W, height: H }, {
      // Lettering was placed against this depth pass already; the helix parts round it, so it is not hidden again.
      hidden: stroke => removeHidden && stroke.family !== 'text',
      // Words read on top: every other line, the helix and piers in front included, parts round each placed word.
      pieces: (c, stroke) => stroke.family === 'text' || allBands.length === 0 ? [c] : clearBands(c, allBands, MM_Y),
      begin: stroke => {
        const key = `${stroke.group}-${stroke.ink}`;
        const text = stroke.family === 'text';
        return runs => {
          for (const run of runs) {
            for (const inside of clipWindow(scalePoints(run, MM_X, MM_Y))) for (const path of shear(inside, bolt, slip, half)) {
              for (const kept of clipWindow(path)) buckets.add(key, kept, text);
            }
          }
        };
      },
    });
    const parts = buckets.toParts(['storm', 'system', 'helix', 'slogan', 'title'], INKS);
    parts.push({ id: 'bolt-carbon', pen: 'carbon', paths: [...bandMarks(bolt, half, CARD), ...bandMarks(branch, half * 0.35, CARD)].flatMap(p => clipWindow(p)) });
    // The shared horizon, drawn on this card as the ground line either side of the tower.
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: shear([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], bolt, slip, half) });
    parts.push(...cardFrame('XVI', 'THE TOWER'));
    return parts;
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}
