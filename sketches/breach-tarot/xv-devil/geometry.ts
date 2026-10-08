import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { projectPolylinesClipped } from '../../../src/projection.ts';
import { clipProjectedPolyline, densifyProjectedPolyline, renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { measureStrokeText, strokeText } from '../../../src/sketch/stroke-text.ts';
import { PAGE, depthRaster } from '../../kit/format.ts';
import { slabGeometry, slabMatrix, type Slab } from '../../kit/slabs.ts';
import { glyphMask, sloganSettings } from '../../kit/lettering.ts';
import { keepAlong, meshCoverage } from '../../kit/page.ts';
import { clamp } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { type DoorPiece } from './doors.ts';
import { figureMeshes, figureStrokes } from './figures.ts';
import { devilLayout } from './layout.ts';
import { leashRope } from './leash.ts';
import { param } from './params.ts';
import { type Piece } from './pillar.ts';
import { stoneStrokes } from './stone.ts';

/**
 * XV The Devil: you can leave at any time. Lock-in, with no devil in it: the pillar is the power.
 * The set's one frontal card, camera square on and everything mirrored about the middle. A heavy
 * pedestal of plain stone courses stands dead centre, hatched dense and dark: the darkest mass on the
 * card (the traditional half-cube altar, on a stepped base), rising well above the horizon, with the
 * light behind it throwing its stepped shadow across the ground toward the eye. The helix is the
 * leash: its two strands come off the pillar, one to each side, as thin twisted ropes that hang in
 * slack curves, touch down on the ground in a loose coil and rise to a wrist of each of two figures
 * who stand at ease, facing the pillar. Each stands in a doorway: a big, near, pale door frame at
 * the edge of the card, taller than the pillar, its door swung wide open, so the horizon runs on
 * through the open doorway, paper beyond. The sky is a light ruling knocked out round all that
 * stands in it, black at the top as the traditional Devil's ground is. The phrase is cut into the
 * pillar's courses and the door lintels, a word to a face.
 */
const { W, H, MM_X, MM_Y } = depthRaster(1118, 1728);
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
const EYE = 6;

export function devilCamera(ctx: SketchContext): THREE.PerspectiveCamera {
  return horizonCamera({
    fov: param(ctx, 'fov'), eye: [0, EYE, 0], target: [0, EYE, -100], near: 8, far: 4000,
    page: PAGE, depth: { width: W, height: H }, horizonY: HORIZON_Y,
  });
}

/** A polyline cut into runs of at most `size` points, each sharing its end point with the next. */
function chunk<T>(points: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < points.length - 1; i += size - 1) out.push(points.slice(i, Math.min(points.length, i + size)));
  return out;
}

type Candidate = { sl: Slab };

/** Each mesh flattened onto the ground along the light: where it throws its shadow. */
function shadowOf(geos: THREE.BufferGeometry[], toLight: THREE.Vector3): THREE.BufferGeometry[] {
  return geos.map(g => {
    const out = g.clone();
    const pos = out.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      pos.setXYZ(i, pos.getX(i) - toLight.x * y / toLight.y, 0, pos.getZ(i) - toLight.z * y / toLight.y);
    }
    pos.needsUpdate = true;
    return out;
  });
}

export function drawDevil(ctx: SketchContext): Part[] {
  const view = devilCamera(ctx);
  const eye = view.position.clone();
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const mmPerUnit = (p: THREE.Vector3) => f / Math.max(1, eye.z - p.z);
  const { pillar, figures, doors, routes } = devilLayout(ctx);
  const doorPieces: (DoorPiece & { side: -1 | 1 })[] = doors.flatMap(d => d.pieces.map(p => ({ ...p, side: d.side })));
  // The leashes: the helix as two thin ropes, one to each side, built larger and scaled back.
  const leashes = routes.map(route => leashRope(ctx, view, route, {
    radius: param(ctx, 'leashR'), width: 0.95, pitch: param(ctx, 'leashPitch'), density: param(ctx, 'leashDensity'), scale: param(ctx, 'helixScale'),
  }));

  // Strokes. The pillar is lit from behind, so its faces fall dark and heavy; the doors from the front, evenly, so they stay paler.
  const backlight = new THREE.Vector3(0, 0.55, -0.8).normalize();
  const pillarSlabs = pillar.pieces.map(p => p.sl);
  const doorSlabs = doorPieces.map(p => p.sl);
  const stonePitch = param(ctx, 'stonePitch');
  const pillarStrokes = pillar.pieces.flatMap(p => stoneStrokes(p.sl, eye, stonePitch / mmPerUnit(new THREE.Vector3(p.sl.x, p.sl.y, p.sl.z)), p.course, 'pillar'));
  // Door hatch: the frame's members at `doorHatch`; the leaf, whose broad face shows, more open still, so it stays pale.
  const doorStrokes = doorPieces.flatMap(p => stoneStrokes(p.sl, eye, param(ctx, 'doorHatch') * (p.part === 'leaf' ? 3 : 1) / mmPerUnit(new THREE.Vector3(p.sl.x, p.sl.y, p.sl.z)), p.sl.beat, p.side === -1 ? 'door-left' : 'door-right', 1));
  const lit = (_p: THREE.Vector3, normal: THREE.Vector3) => clamp(0.9 * (1 - Math.max(0, normal.dot(new THREE.Vector3(-0.5, 0.55, 0.7).normalize()))) ** 1.3 + 0.04, 0, 1);
  const env = { forward, density: 0.4, dark: lit, screen: (p: THREE.Vector3) => { const q = pageOf(view, p); return { x: q.x, y: q.y }; } };
  const figureLines = figures.flatMap(fig => figureStrokes(fig, env));

  const pillarGeos = pillarSlabs.map(slabGeometry), doorGeos = doorSlabs.map(slabGeometry);
  const figureGeos = figures.flatMap(figureMeshes);
  const leashGeos = leashes.flatMap(l => l.meshes);
  const geometries = [...pillarGeos, ...doorGeos, ...figureGeos, ...leashGeos];
  const shadowGeos = shadowOf(pillarGeos, backlight);
  try {
    fitDepthRange(view, geometries);
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    // The ropes are drawn as open wire, a twist of lines with nothing hidden by its own turns, so a thin cord stays whole; the
    // pillar, the figures and the doors still hide it.
    const ropeDepth = renderDepthBufferCPU([...pillarGeos, ...doorGeos, ...figureGeos], view, W, H);
    const biasAt = (tol: number, d: number) => tol * view.far * view.near / ((view.far - view.near) * d * d);
    const slabSlack = param(ctx, 'slabSlack');
    const solids = meshCoverage(geometries, view, PAGE, param(ctx, 'knockout'));
    const pocket = meshCoverage(figureGeos, view, PAGE, param(ctx, 'pocket'));

    // The phrase, a word to a face: first and last on the door lintels, the rest down across the pillar.
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
    const wrng = ctx.random('devil-words');
    const style = { face: settings.face, height: settings.size };
    const textStrokes: THREE.Vector3[][] = [];
    const visible = (lines3: THREE.Vector3[][], d: number) => {
      let total = 0, seen = 0;
      const count = (hidden: boolean, addTo: (k: number) => void) => projectStrokes(lines3.map(points => ({ points })), { view, depth, width: W, height: H, bias: biasAt(slabSlack, d) }, {
        hidden: () => hidden, begin: () => runs => { for (const r of runs) addTo(r.length); },
      });
      count(false, k => { total += k; });
      count(true, k => { seen += k; });
      return total > 0 && seen >= total * 0.97;
    };
    const place = (word: string, cands: Candidate[], across: number): boolean => {
      for (const { sl } of cands) {
        const centre = new THREE.Vector3(sl.x, sl.y, sl.z);
        const unit = 1 / mmPerUnit(centre);
        const ww = measureStrokeText(word, style) * unit, hh = style.height * unit;
        if (ww > sl.w - 0.5 || hh > sl.h - 0.3) continue;
        const x0 = -ww / 2 + across * (sl.w - ww - 0.5) / 2, y0 = hh / 2;
        const m = slabMatrix(sl);
        const word3 = strokeText(word, 0, 0, style).map(path => path.map(q => new THREE.Vector3(x0 + q.x * unit, y0 - q.y * unit, sl.d / 2 + 0.03).applyMatrix4(m)));
        if (!visible(word3, eye.z - sl.z) || word3.some(path => path.some(q => pocket(pageOf(view, q))))) continue;
        textStrokes.push(...word3);
        return true;
      }
      return false;
    };
    const lintel = (side: -1 | 1): Candidate[] => doors.find(d => d.side === side)!.pieces.filter(p => p.part === 'lintel').map(p => ({ sl: p.sl }));
    const onPillar = (target: number, tol: number): Candidate[] => pillar.pieces
      .filter((p: Piece) => Math.abs(p.height - target) < tol)
      .sort((a, b) => Math.abs(a.height - target) - Math.abs(b.height - target))
      .map(p => ({ sl: p.sl }));
    const plan: Record<string, () => { cands: Candidate[]; across: number }> = {
      you: () => ({ cands: lintel(-1), across: -0.35 + 0.2 * wrng() }),
      can: () => ({ cands: onPillar(0.875, 0.06), across: -0.3 + 0.2 * wrng() }),
      leave: () => ({ cands: onPillar(0.66, 0.12), across: 0.1 + 0.3 * wrng() }),
      at: () => ({ cands: onPillar(0.34, 0.12), across: -0.4 + 0.2 * wrng() }),
      any: () => ({ cands: onPillar(0.12, 0.06), across: 0.1 + 0.3 * wrng() }),
      time: () => ({ cands: lintel(1), across: 0.1 + 0.3 * wrng() }),
    };
    for (const word of words) {
      const spec = plan[word];
      if (spec) { const { cands, across } = spec(); place(word, cands, across); }
    }
    const glyphPaths: Point[][] = [];
    for (const l of projectPolylinesClipped(textStrokes, view, W, H).polylines) for (const c of clipProjectedPolyline(l, W, H)) {
      glyphPaths.push(...clipWindow(scalePoints(densifyProjectedPolyline(c), MM_X, MM_Y)));
    }
    const onGlyph = glyphMask(glyphPaths, 0.7);
    const buckets = new PartBuckets(0.4);
    const add = (key: string, run: Point[], extra: (p: Point) => boolean = () => true, min?: number) => {
      for (const inside of clipWindow(run)) for (const piece of keepAlong(inside, p => !onGlyph(p) && extra(p), 0.15)) buckets.add(key, piece, false, min);
    };
    const draw = (strokes: Stroke[], tol: number, d: number, extra?: (p: Point) => boolean, min?: number, buffer = depth) => {
      if (!strokes.length) return;
      projectStrokes(strokes, { view, depth: buffer, width: W, height: H, bias: biasAt(tol, d) }, {
        begin: st => runs => { for (const run of runs) add(`${st.group}-${st.ink}`, scalePoints(run, MM_X, MM_Y), extra, min); },
      });
    };
    draw(pillarStrokes, slabSlack, param(ctx, 'pillarDist'), p => !pocket(p));
    draw(doorStrokes, slabSlack, param(ctx, 'doorDist'), undefined, 1.5);
    draw(figureLines, param(ctx, 'figSlack'), param(ctx, 'figDist'));
    // The leashes, in depth bands so the slack stays the same distance in the world near and far.
    const bands = new Map<number, Stroke[]>();
    leashes.forEach((leash, i) => { for (const st of leash.strokes) for (const piece of chunk(st.points, 12)) {
      const band = Math.floor((eye.z - piece[Math.floor(piece.length / 2)].z) / 3);
      bands.set(band, [...(bands.get(band) ?? []), { ink: st.ink, group: i === 0 ? 'leash-left' : 'leash-right', family: 'membrane', points: piece }]);
    } });
    for (const [band, mine] of bands) draw(mine, param(ctx, 'leashHide'), band * 3 + 1.5, undefined, 1.2, ropeDepth);

    // The pillar's shadow, thrown toward the eye across the ground by the light behind it: ruled flat on the sheet,
    // left clear round the leashes, the figures and the doors.
    const shade = meshCoverage(shadowGeos, view, PAGE, 0, 4);
    const standingMask = meshCoverage([...pillarGeos, ...leashGeos, ...figureGeos, ...doorGeos], view, PAGE, 1.2, 4);
    for (let y = HORIZON_Y + 1.2; y < CARD.y1; y += param(ctx, 'shadowPitch')) {
      add('shadow-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => shade(p) && !standingMask(p), 3);
    }

    // The sky: a light ruling, thinning and breaking as it comes down to the horizon, knocked out round everything standing in it.
    const skyTop = CARD.y0, skyBottom = HORIZON_Y - 1;
    const band = param(ctx, 'groundBand'), tight = param(ctx, 'groundPitch');
    // The echo: the pillar's one outer outline (stepped base, shaft and cap, no course lines inside), scaled up about the
    // middle of the horizon and looming flat behind the whole scene, as the Fool's flat echo of the Sun fills his sky: a
    // bare line in the lightest pen, its sides running down toward the horizon, never over the black ground at the top,
    // and kept clear of everything standing in front of it. The sky's ruling stands off the line by a millimetre, so the
    // thin line holds on paper.
    const echoPaths: Point[][] = [];
    if (ctx.params.echo !== false) {
      const k = param(ctx, 'echoScale');
      const cx = PAGE.width / 2;
      const window = { x0: CARD.x0, x1: CARD.x1, y0: skyTop + band * (skyBottom - skyTop) + 3, y1: HORIZON_Y - 5 };
      const clearOf = meshCoverage(geometries, view, PAGE, 2.2);
      const clear = (p: Point) => !clearOf(p) && !onGlyph(p);
      const up = (p: Point): Point => ({ x: cx + k * (p.x - cx), y: HORIZON_Y + k * (p.y - HORIZON_Y) });
      // Each course's front face on the sheet, foot to top; every course stands on the middle, so the outline is the right side
      // going up (a vertical along each course, a step across to the next), across the top, and the left side coming down.
      const faces = [...pillar.pieces].sort((a, b) => a.sl.y - b.sl.y).map(({ sl }) => {
        const at = (sx: number, sy: number) => pageOf(view, new THREE.Vector3(sl.x + sx * sl.w / 2, sl.y + sy * sl.h / 2, sl.z + sl.d / 2));
        const [tl, tr, bl] = [at(-1, 1), at(1, 1), at(-1, -1)];
        return { left: tl.x, right: tr.x, top: tl.y, foot: bl.y };
      });
      const right: Point[] = [{ x: faces[0].right, y: faces[0].foot }], left: Point[] = [{ x: faces[0].left, y: faces[0].foot }];
      faces.forEach((face, i) => {
        const next = faces[i + 1];
        const joint = next ? (face.top + next.foot) / 2 : face.top;
        right.push({ x: face.right, y: joint });
        left.push({ x: face.left, y: joint });
        if (next) { right.push({ x: next.right, y: joint }); left.push({ x: next.left, y: joint }); }
      });
      const outline = [...left, ...right.reverse()].map(up);
      for (const inside of clipWindow(outline, window)) for (const kept of keepAlong(inside, clear, 0.15)) if (kept.length > 1) echoPaths.push(kept);
    }
    const onEcho = glyphMask(echoPaths, 1.1);
    const reach = param(ctx, 'sky');
    const pitch = param(ctx, 'skyPitch');
    const rhythm = barPattern(ctx.random('devil-sky'), 0.86);
    if (reach > 0) for (let y = skyTop + 0.3, i = 0; y < skyBottom; i++, y += pitch) {
      const t = (y - skyTop) / (skyBottom - skyTop);
      const tier = i % 8 === 0 ? 0 : i % 4 === 0 ? 1 : i % 2 === 0 ? 2 : 3;
      const limit = [0.95, 0.72, 0.5, 0.28][tier];
      if (t > limit * reach * 1.6) continue;
      const broken = t > 0.3 * limit;
      add('sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => !solids(p) && !onEcho(p) && (!broken || rhythm[Math.floor((p.x - CARD.x0) / 3.2 + i) % 64]));
    }
    // The black ground: the top of the sky ruled close, as the traditional Devil's ground is black, its lines
    // dropping out one by one (by a fixed irrational stride, so no two neighbours go together) as it comes down to the sky.
    if (band > 0) for (let k = 0, y = skyTop + tight / 2; y < skyTop + band * (skyBottom - skyTop); k++, y += tight) {
      const t = (y - skyTop) / (band * (skyBottom - skyTop));
      if ((k * 0.6180339887) % 1 > (1 - t) ** 0.7) continue;
      add('sky-carbon', [{ x: CARD.x0, y }, { x: CARD.x1, y }], p => !solids(p));
    }
    for (const path of echoPaths) buckets.add('echo-acid', path);
    for (const path of glyphPaths) buckets.add('slogan-lettering', path, true);
    const parts = buckets.toParts(['sky', 'shadow', 'pillar', 'door-left', 'door-right', 'leash-left', 'leash-right', 'figure', 'figure-edge', 'echo', 'slogan'], INKS);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: keepAlong([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], p => !solids(p), 0.3) });
    parts.push(...cardFrame('XV', 'THE DEVIL'));
    return parts;
  } finally {
    for (const geo of [...geometries, ...shadowGeos]) geo.dispose();
  }
}
