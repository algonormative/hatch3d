import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { faceDarkness, facetStrokes, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { hatchedBar } from '../../kit/fills.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';

/**
 * IV The Emperor: you are already standing on it. Power is order: a one-point avenue of identical
 * cubes in a perfect grid, every row receding exactly to the vanishing point, the paving under them
 * jointed in the same grid, all of it aligned to what stands at the end. Three readings share that
 * camera and avenue:
 * - agent: a seated colossus of box planes on a cube throne, towering from the horizon at its knees
 *   to a head in the top quarter. It is lit from its own head (power is the light source), suited in
 *   pinstripes, and its head is struck out by a flat hatched censor bar, the card's one flat mark.
 * - empty: the same suit on the same throne with nobody in it: no head (the throne's back shows
 *   where it would be), a hollow collar, hollow cuffs and no hands.
 * - ziggurat: a stepped pyramid at the end, one big block on top and each tier below made of more,
 *   smaller blocks, like an org chart. Its bottom tier is the paving itself, which runs all the way
 *   under the viewer's feet.
 */
const W = 1118, H = 1728;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const GROUPS = ['sky', 'ground', 'avenue', 'ziggurat', 'throne', 'figure', 'bar', 'slogan'] as const;
const EYE = 6;
const HALF_CARD = (CARD.x1 - CARD.x0) / 2;
const MID_X = (CARD.x0 + CARD.x1) / 2;

export type Reading = 'agent' | 'empty' | 'ziggurat';
type Group = 'avenue' | 'throne' | 'figure' | 'ziggurat';

interface Block {
  slab: Slab;
  group: Group;
  /** A suit face: pinstripes in place of the diagonal field on its front. */
  pin?: boolean;
  /** The light source itself (the head, the top block): lit from the front, so it reads pale. */
  source?: boolean;
  /** A fixed light direction (the hollows), instead of the direction to the source. */
  light?: THREE.Vector3;
  tone?: number;
  /** The inside of a hollow: hatched closer, so it reads as the darkest thing there. */
  void?: boolean;
}

/** The figure's proportions, in modules u: the head's top and the depth of its front face. */
const HEAD_TOP = 6.4, HEAD_FRONT = 1.75;
/** The head's centre in figure space (x, y, z in u, z toward the viewer from the seat's front). */
const HEAD_CENTRE = [0, 5.675, -2.35] as const;

export function readingOf(ctx: SketchContext): Reading {
  const r = ctx.params.reading;
  return r === 'empty' || r === 'ziggurat' ? r : 'agent';
}

export function emperorCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: n(ctx, 'fov', 54, 36, 75), eye: [0, EYE, 0], target: [0, EYE, -100], near: 2, far: 4000,
    page: TABLOID_PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/** Where everything sits, shared by all three readings so they compare like for like. */
export interface Layout {
  /** Page millimetres per world unit at unit distance. */
  f: number;
  /** Distance from the eye to the end of the avenue (the throne's front, the ziggurat's first riser). */
  zEnd: number;
  /** The figure's module, solved so the head's top lands on `headTop`. */
  u: number;
  /** How far above the horizon the head (or apex) rises, per unit of distance. */
  rise: number;
  /** Avenue cube, paving stone (half a cube), cube pitch, and the lane's half-width. */
  c: number; b: number; pitch: number; lane: number;
}

export function layout(ctx: SketchContext, view: THREE.PerspectiveCamera): Layout {
  const f = TABLOID_PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const zEnd = EYE * f / n(ctx, 'throneDrop', 64, 30, 110);
  const rise = (HORIZON_Y - n(ctx, 'headTop', 78, 50, 140)) / f;
  const u = (EYE + rise * zEnd) / (HEAD_TOP - HEAD_FRONT * rise);
  const c = n(ctx, 'cube', 2.4, 1.2, 5), b = c / 2;
  // The lane is as wide as the colossus's feet, on the paving grid.
  const lane = Math.ceil(1.12 * u / b) * b;
  return { f, zEnd, u, rise, c, b, pitch: c + b * Math.round(n(ctx, 'gap', 2, 1, 4)), lane };
}

/** Is a world box (centre x, half-width) at distance z at least partly within the card's width? */
const onCard = (L: Layout, x: number, half: number, z: number) => Math.abs(x) - half < (HALF_CARD + 4) * z / L.f;

/** The avenue: identical cubes in rows on both sides of a lane, the last row one stone short of the end. */
export function avenue(ctx: SketchContext, L: Layout): Block[] {
  const cols = Math.round(n(ctx, 'cols', 4, 1, 8));
  const out: Block[] = [];
  for (let r = 0; ; r++) {
    const z = L.zEnd - L.b - L.c / 2 - r * L.pitch;
    if (z - L.c / 2 < 7) break;
    for (let i = 0; i < cols; i++) for (const s of [-1, 1]) {
      const x = s * (L.lane + L.c / 2 + i * L.pitch);
      if (!onCard(L, x, L.c / 2, z + L.c / 2)) continue;
      out.push({ slab: solid(x, L.c / 2, -z, L.c, L.c, L.c, out.length, 'stack'), group: 'avenue', tone: 0.5 });
    }
  }
  return out;
}

/**
 * The colossus on its throne, built in figure space (modules u; z toward the viewer from the seat's
 * front, which stands at the end of the avenue). `empty` leaves the suit with nobody in it.
 */
export function colossus(L: Layout, empty: boolean): { blocks: Block[]; head: THREE.Vector3 } {
  const { u, zEnd } = L;
  const out: Block[] = [];
  const box = (group: Group, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, extra: Partial<Block> = {}) => {
    out.push({ slab: solid((x0 + x1) / 2 * u, (y0 + y1) / 2 * u, -zEnd + (z0 + z1) / 2 * u, (x1 - x0) * u, (y1 - y0) * u, (z1 - z0) * u, out.length, 'stack'), group, ...extra });
  };
  /** A mirrored pair, `x0`..`x1` on the right and its reflection on the left; `side` lets extras depend on it. */
  const pair = (group: Group, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, extra: (side: number) => Partial<Block> = () => ({})) => {
    box(group, -x1, -x0, y0, y1, z0, z1, extra(-1));
    box(group, x0, x1, y0, y1, z0, z1, extra(1));
  };
  const suit = { pin: true };
  // The throne: a big plain block, armrests flush with its front, and a high back.
  box('throne', -1.85, 1.85, 0, 1.4, -3.2, 0, { tone: 0.5 });
  pair('throne', 1.05, 1.85, 1.4, 2.5, -3.2, 0, () => ({ tone: 0.5 }));
  box('throne', -1.6, 1.6, 0, 7.3, -4.0, -3.2, { tone: 0.5 });
  // The body, all planes: torso, shoulders, thighs coming toward us, shins, arms hanging, forearms along the rests.
  box('figure', -1.0, 1.0, 1.4, 4.1, -3.0, -1.75, suit);
  box('figure', -1.55, 1.55, 4.05, 4.6, -3.0, -1.75);
  pair('figure', 0.12, 0.92, 1.4, 2.25, -1.9, 0.9);
  pair('figure', 0.17, 0.88, empty ? 0.03 : 0.38, 1.45, 0.06, 0.82, () => suit);
  pair('figure', 1.07, 1.6, 2.75, 4.3, -2.75, -2.0);
  if (!empty) {
    pair('figure', 1.1, 1.62, 2.5, 2.95, -2.75, -0.45);
    // Flat hands on the ends of the rests, the fingers laid down over the front edge.
    pair('figure', 1.06, 1.66, 2.5, 2.68, -0.75, 0.14);
    pair('figure', 1.06, 1.66, 1.95, 2.68, 0.02, 0.14);
    pair('figure', 0.12, 0.94, 0, 0.38, 0.06, 1.5);
    box('figure', -0.35, 0.35, 4.55, 5.0, -2.7, -2.05);
    box('figure', -0.62, 0.62, 4.95, HEAD_TOP, -2.95, -HEAD_FRONT, { source: true, tone: 0.5 });
  } else {
    // Hollow cuffs: four thin walls round a dark recess, each wall lit on its rim and dark inside.
    // The sleeve starts just in front of the hanging upper arm, so the two never cut through each other.
    const t = 0.09;
    pair('figure', 1.1, 1.62, 2.95 - t, 2.95, -1.98, -0.45, () => ({ light: new THREE.Vector3(0, 1, 1).normalize() }));
    pair('figure', 1.1, 1.62, 2.5, 2.5 + t, -1.98, -0.45, () => ({ light: new THREE.Vector3(0, -1, 1).normalize() }));
    pair('figure', 1.1, 1.1 + t, 2.5 + t, 2.95 - t, -1.98, -0.45, s => ({ light: new THREE.Vector3(-s, 0, 1).normalize() }));
    pair('figure', 1.62 - t, 1.62, 2.5 + t, 2.95 - t, -1.98, -0.45, s => ({ light: new THREE.Vector3(s, 0, 1).normalize() }));
    pair('figure', 1.1 + t, 1.62 - t, 2.5 + t, 2.95 - t, -1.98, -1.05, () => ({ light: new THREE.Vector3(0, 0, -1), tone: 1.3, void: true }));
    // The hollow collar: a low front, a high back whose inside shows above it, and sloped sides.
    const c = 0.12;
    box('figure', -0.72, 0.72, 4.6, 4.8, -1.88 - c, -1.88);
    box('figure', -0.72, 0.72, 4.6, 5.95, -2.92, -2.92 + c, { light: new THREE.Vector3(0, 0, -1), tone: 1.3, void: true });
    pair('figure', 0.72 - c, 0.72, 4.6, 5.4, -2.92 + c, -1.88 - c, s => ({ light: new THREE.Vector3(s, 0, 0), tone: 1.3, void: true }));
  }
  const head = new THREE.Vector3(HEAD_CENTRE[0] * u, HEAD_CENTRE[1] * u, -zEnd + HEAD_CENTRE[2] * u);
  return { blocks: out, head };
}

/**
 * The ziggurat: risers from one big block on top down to the lowest, whose blocks are the avenue's
 * own cubes; below that the paving (half a cube) is the bottom tier, running under the viewer's feet.
 * Tier k has 2^k × 2^k blocks. Only the rows the eye can reach are cut into blocks; the rest of each
 * tier is one core slab for the depth pass.
 */
export function ziggurat(ctx: SketchContext, L: Layout): { blocks: Block[]; apex: THREE.Vector3 } {
  const tiers = Math.round(n(ctx, 'tiers', 6, 5, 7));
  const low = tiers - 2;
  const sLow = 2 ** low * L.c, s0 = Math.min(sLow * 0.9, n(ctx, 'topBlock', 3.5, 2, 6) * L.c);
  const step = (sLow - s0) / (2 * low);
  const span = (k: number) => s0 + (sLow - s0) * k / low;
  const block = (k: number) => span(k) / 2 ** k;
  const front = (k: number) => L.zEnd + step * (low - k);
  // Heights in proportion to the blocks, scaled so the apex rises to the head's mark.
  let sum = 0;
  for (let k = 0; k <= low; k++) sum += block(k);
  const scale = (EYE + L.rise * front(0)) / sum;
  const out: Block[] = [];
  let base = 0;
  for (let k = low; k >= 0; k--) {
    const b = block(k), h = b * scale, S = span(k), count = 2 ** k;
    const rows = base + h < EYE ? Math.min(count, Math.ceil(step / b - 1e-6)) : 1;
    for (let r = 0; r < rows; r++) {
      const z = front(k) + (r + 0.5) * b;
      for (let i = 0; i < count; i++) {
        const x = -S / 2 + (i + 0.5) * b;
        if (!onCard(L, x, b / 2, z)) continue;
        out.push({ slab: solid(x, base + h / 2, -z, b, h, b, out.length, 'stack'), group: 'ziggurat', source: k === 0, tone: k === 0 ? 0.5 : 0.58 });
      }
    }
    if (rows < count) {
      const z0 = front(k) + rows * b, z1 = front(k) + S;
      out.push({ slab: solid(0, base + h / 2, -(z0 + z1) / 2, S, h, z1 - z0, out.length, 'stack'), group: 'ziggurat', tone: 0.58 });
    }
    base += h;
  }
  const top = block(0) * scale;
  return { blocks: out, apex: new THREE.Vector3(0, base - top / 2, -(front(0) + s0 / 2)) };
}

/** The point inside a convex page quad (clockwise on the sheet), grown by `margin`. */
const inQuad = (quad: Point[], margin: number) => (p: Point) => quad.every((a, i) => {
  const b2 = quad[(i + 1) % quad.length];
  const ex = b2.x - a.x, ey = b2.y - a.y;
  return (ex * (p.y - a.y) - ey * (p.x - a.x)) / Math.hypot(ex, ey) > -margin;
});

/** Number of times 2 divides k (a big number for 0): how long a paving joint survives into the distance. */
const twos = (k: number) => { if (k === 0) return 12; let t = 0; while (k % 2 === 0) { k /= 2; t++; } return t; };

export function drawEmperor(ctx: SketchContext): Part[] {
  const view = emperorCamera(ctx);
  const eye = view.position.clone();
  const L = layout(ctx, view);
  const reading = readingOf(ctx);
  const mmPerUnit = (p: THREE.Vector3) => L.f / Math.max(1, eye.z - p.z);

  const blocks: Block[] = avenue(ctx, L);
  let light: THREE.Vector3;
  let head: Block | undefined;
  if (reading === 'ziggurat') {
    const z = ziggurat(ctx, L);
    light = z.apex;
    blocks.push(...z.blocks);
  } else {
    const fig = colossus(L, reading === 'empty');
    light = fig.head;
    blocks.push(...fig.blocks);
    head = reading === 'agent' ? blocks.find(bl => bl.source) : undefined;
  }

  // The hatch: every slab by its light, the direction from its centre to the source (the head, or
  // the top block); the source itself is lit from the front and reads pale.
  const facet = n(ctx, 'facet', 12, 6, 18);
  const pinMin = n(ctx, 'pin', 0.9, 0.6, 2);
  const strokes: Stroke[] = [];
  for (const [owner, bl] of blocks.entries()) {
    const sl = bl.slab;
    const at = new THREE.Vector3(sl.x, sl.y, sl.z);
    sl.tone = bl.tone ?? 0.68;
    const dir = bl.source ? new THREE.Vector3(0, 0.3, 1).normalize() : bl.light ?? light.clone().sub(at).normalize();
    const mpu = mmPerUnit(at);
    const m = slabMatrix(sl);
    const inv = m.clone().invert();
    const onFront = (p: THREE.Vector3) => Math.abs(p.clone().applyMatrix4(inv).z - sl.d / 2) < 0.02;
    for (const st of facetStrokes(sl, dir, eye, Math.max(sl.w, sl.h) * mpu < 1.5, (bl.void ? 0.6 : 1) * facet / mpu)) {
      // On a suit's front the rings and the diagonal field give way to pinstripes.
      if (bl.pin && st.family === 'hatch' && onFront(st.points[0])) continue;
      strokes.push({ ink: 'carbon', group: bl.group, family: st.family, points: st.points, owner });
    }
    if (bl.pin) {
      const normal = new THREE.Vector3(0, 0, 1).applyMatrix4(new THREE.Matrix4().extractRotation(m));
      const d = faceDarkness(normal, dir, sl.tone);
      const pitch = (pinMin + (2.6 - pinMin) * (1 - d)) / mpu;
      const inset = 0.04 * Math.min(sl.w, sl.h);
      const across = Math.floor((sl.w - 2 * inset) / pitch);
      for (let j = 0; j <= across; j++) {
        const x = -sl.w / 2 + inset + (sl.w - 2 * inset) * (j + 0.5) / (across + 1);
        strokes.push({ ink: 'carbon', group: bl.group, family: 'hatch', owner, points: [
          new THREE.Vector3(x, -sl.h / 2 + inset, sl.d / 2 + 0.01).applyMatrix4(m), new THREE.Vector3(x, sl.h / 2 - inset, sl.d / 2 + 0.01).applyMatrix4(m)] });
      }
    }
  }

  const geometries = blocks.map(bl => slabGeometry(bl.slab));
  // Small blocks hide their own back edges only if the depth range fits the scene.
  fitDepthRange(view, geometries);
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    const solids = meshCoverage(geometries, view, TABLOID_PAGE, n(ctx, 'knockout', 1.1, 0.3, 3));
    const glowAt = pageOf(view, light);

    // The censor bar: flat on the sheet over the head, slightly turned, knocking out what it covers.
    let onBar: (p: Point) => boolean = () => false;
    const barPaths: Point[][] = [];
    if (head) {
      const hs = head.slab;
      const corners = [-1, 1].flatMap(x => [-1, 1].map(y => pageOf(view, new THREE.Vector3(hs.x + x * hs.w / 2, hs.y + y * hs.h / 2, hs.z + hs.d / 2))));
      const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
      const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
      const brng = ctx.random('emperor-censor');
      const tilt = (brng() < 0.5 ? -1 : 1) * (0.035 + 0.05 * brng());
      const bar = hatchedBar({ cx: (Math.max(...xs) + Math.min(...xs)) / 2 + (brng() - 0.5) * 0.08 * w, cy: Math.min(...ys) + 0.42 * h, l: 1.55 * w, h: 0.36 * h },
        tilt, [[Math.PI / 3, 0.62], [-Math.PI / 3, 0.9]]);
      onBar = inQuad(bar.quad, 1.4);
      barPaths.push(...bar.paths);
    }

    // The phrase, a word at a time cut into the front of a block of the throne, the ziggurat or the
    // avenue: staggered down the card from the end of the avenue toward you, alternating sides, so
    // "on it" lands at your feet. Low cubes in a grid hide all but a sliver of each other's fronts,
    // so each face is tried at several places and only a word wholly in view is kept.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
    const wrng = ctx.random('emperor-words');
    const style = { face: settings.face, height: settings.size };
    const textStrokes: THREE.Vector3[][] = [];
    const visible = (lines3: THREE.Vector3[][], share = 0.98) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth, width: W, height: H }, {
        hidden: () => hidden, begin: () => runs => { for (const r of runs) addTo(r.length); },
      });
      count(false, k => { total += k; });
      count(true, k => { seen += k; });
      return total > 0 && seen >= total * share;
    };
    // Candidate faces: every front that shows some of itself inside the card, with where it shows.
    const fronts = blocks.filter(bl => bl.group !== 'figure' && !bl.source).map(bl => {
      const sl = bl.slab, m = slabMatrix(sl);
      const ps = [-1, 1].flatMap(x => [-1, 1].map(y => pageOf(view, new THREE.Vector3(x * sl.w / 2, y * sl.h / 2, sl.d / 2).applyMatrix4(m))));
      const x0 = Math.max(CARD.x0, Math.min(...ps.map(p => p.x))), x1 = Math.min(CARD.x1, Math.max(...ps.map(p => p.x)));
      const y0 = Math.max(CARD.y0, Math.min(...ps.map(p => p.y))), y1 = Math.min(CARD.y1, Math.max(...ps.map(p => p.y)));
      return { bl, m, box: { x0, x1, y0, y1 } };
    }).filter(({ box }) => box.x1 - box.x0 > 12 && box.y1 - box.y0 > 5);
    const yTop = reading === 'ziggurat' ? HORIZON_Y - 70 : HORIZON_Y - 95, yBottom = CARD.y1 - 14;
    const placed: Point[] = [];
    let side = wrng() < 0.5 ? -1 : 1;
    const tryWord = (word: string, target: number, side: number, reach: number): boolean => {
      const pick = fronts.filter(({ box }) => side === 0 || (side < 0 ? box.x0 < MID_X - 8 : box.x1 > MID_X + 8))
        .map(f => ({ f, score: Math.max(0, f.box.y0 - target, target - f.box.y1) + 25 * wrng() }))
        .sort((a, b) => a.score - b.score).slice(0, 16).map(({ f }) => f);
      for (const { bl, m } of pick) {
        const sl = bl.slab;
        const unit = 1 / mmPerUnit(new THREE.Vector3(sl.x, sl.y, sl.z + sl.d / 2));
        const ww = measureStrokeText(word, style) * unit, hh = style.height * unit;
        const margin = 1.2 * hh;
        if (ww > sl.w - 2 * margin || hh > sl.h - 2 * margin) continue;
        for (let attempt = 0; attempt < 90; attempt++) {
          const x0 = -ww / 2 + (wrng() - 0.5) * (sl.w - ww - 2 * margin), y0 = hh / 2 + (wrng() - 0.5) * (sl.h - hh - 2 * margin);
          const centre = pageOf(view, new THREE.Vector3(x0 + ww / 2, y0 - hh / 2, sl.d / 2).applyMatrix4(m));
          const half = measureStrokeText(word, style) / 2;
          if (centre.x - half < CARD.x0 + 5 || centre.x + half > CARD.x1 - 5 || centre.y < CARD.y0 + 5 || centre.y > CARD.y1 - 5) continue;
          if (Math.abs(centre.x - MID_X) < 15 || (side !== 0 && (centre.x - MID_X) * side < 0) || Math.abs(centre.y - target) > reach) continue;
          if (placed.some(p => Math.hypot(p.x - centre.x, p.y - centre.y) < 32) || onBar(centre)) continue;
          const word3 = strokeText(word, 0, 0, style).map(path => path.map(q => new THREE.Vector3(x0 + q.x * unit, y0 - q.y * unit, sl.d / 2 + 0.02).applyMatrix4(m)));
          // A frame round the word must be in view too, so no word sits tight against an edge in front of it.
          const pad = 0.5 * hh;
          const frame = [[x0 - pad, y0 + pad], [x0 + ww + pad, y0 + pad], [x0 + ww + pad, y0 - hh - pad], [x0 - pad, y0 - hh - pad], [x0 - pad, y0 + pad]]
            .map(([x, y]) => new THREE.Vector3(x, y, sl.d / 2 + 0.02).applyMatrix4(m));
          if (!visible(word3) || !visible([frame], 0.995)) continue;
          textStrokes.push(...word3);
          placed.push(centre);
          return true;
        }
      }
      return false;
    };
    words.forEach((word, i) => {
      const target = yTop + (yBottom - yTop) * (words.length > 1 ? i / (words.length - 1) : 0.5);
      // Its own side near its own height first; then either side, anywhere down the card.
      if (!tryWord(word, target, side, 40)) tryWord(word, target, 0, 160);
      side = -side;
    });
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, 0.6);

    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], keep: (p: Point) => boolean = () => true) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && !onBar(p) && keep(p), 0.15)) buckets.add(key, piece);
    };

    // Every slab's strokes against the depth pass, each with about half a unit of hidden-line slack
    // turned into window depth at its own distance.
    const biasAt = (tol: number, d: number) => tol * view.far * view.near / ((view.far - view.near) * d * d);
    const byOwner = new Map<number, Stroke[]>();
    for (const st of strokes) {
      const list = byOwner.get(st.owner!) ?? [];
      list.push(st);
      byOwner.set(st.owner!, list);
    }
    for (const [owner, mine] of byOwner) {
      const sl = blocks[owner].slab;
      const d = eye.distanceTo(new THREE.Vector3(sl.x, sl.y, sl.z));
      const tol = Math.min(0.5, 0.25 * Math.min(sl.w, sl.h, sl.d));
      projectStrokes(mine, { view, depth, width: W, height: H, bias: biasAt(Math.max(0.12, tol), d) }, {
        begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y)); },
      });
    }

    // The paving, drawn on the sheet: joints in the avenue's grid, half a cube apart, running to the
    // horizon. As they crowd into the distance they drop out in halves (every second, fourth, eighth
    // joint goes on), so the grid keeps an even weight; knocked out round everything standing.
    const gap = n(ctx, 'groundGap', 3.2, 1.5, 8);
    const zNearest = EYE * L.f / (CARD.y1 - HORIZON_Y) * 0.97, zFarthest = 2500;
    const ground = (x: number, z: number) => pageOf(view, new THREE.Vector3(x, 0, -z));
    const clear = (p: Point) => !solids(p);
    const kMax = Math.ceil(HALF_CARD * zFarthest / L.f / L.b);
    for (let k = -kMax; k <= kMax; k++) {
      const x = k * L.b;
      const z0 = Math.max(zNearest, Math.abs(x) * L.f / (HALF_CARD + 2));
      // Joints through the vanishing point: their spacing across the line, not along the horizon.
      const z1 = Math.min(zFarthest, L.b * 2 ** twos(Math.abs(k)) * L.f * EYE / (gap * Math.hypot(x, EYE)));
      if (z1 <= z0) continue;
      add('ground-carbon', [ground(x, z0), ground(x, z1)], clear);
    }
    for (let j = Math.floor((L.zEnd - zNearest) / L.b); ; j--) {
      const z = L.zEnd - j * L.b;
      if (z > zFarthest) break;
      if (z < zNearest) continue;
      if (EYE * L.f * L.b * 2 ** twos(Math.abs(j)) / (z * z) < gap) continue;
      const y = ground(0, z).y;
      add('ground-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], clear);
    }

    // The sky: a ruled night, densest at the top and opening toward the horizon, knocked out round
    // all that stands, and opening round the light: power is the source.
    const pattern = barPattern(ctx.random('emperor-sky'), 0.86);
    const glowR = n(ctx, 'glow', 80, 0, 140);
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - 1;
    const skyPitch = n(ctx, 'skyPitch', 0.9, 0.5, 1.5);
    for (let y = skyTop + 0.3, i = 0; y < skyBottom; i++, y += skyPitch) {
      const t = (y - skyTop) / (skyBottom - skyTop);
      const tier = i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2;
      if (!(t < 0.3 || tier === 0 || (tier === 1 && t < 0.7))) continue;
      const broken = t > 0.5;
      add(i % 4 === 0 ? 'sky-ultramarine' : 'sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => {
        if (solids(p)) return false;
        const r = Math.hypot(p.x - glowAt.x, p.y - glowAt.y) / Math.max(1, glowR);
        const step = pattern[Math.floor((p.x - CARD.x0) / 3.2 + i) % 64];
        if (r < 0.55) return false;
        if (r < 1) return step && (r - 0.55) / 0.45 > ((i * 7 + Math.floor(p.x / 3.2) * 13) % 17) / 17;
        return !broken || step;
      });
    }
    for (const path of barPaths) buckets.add('bar-carbon', path, true);
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(GROUPS, INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p) && !onBar(p), 0.3) });
    parts.push(...cardFrame('IV', 'THE EMPEROR'));
    return parts;
  } finally {
    for (const geo of geometries) geo.dispose();
  }
}
