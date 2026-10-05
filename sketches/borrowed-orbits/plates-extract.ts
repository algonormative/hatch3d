/**
 * Orbit Plates: from an integrated history to plotter lines. Lines only: orbits, bodies as small exact circles,
 * Lagrange points as small crosses, burns as short ticks. No text, no arrows, no dashes, no culling.
 *
 * Each plate is built as a `Scene` in world metres (the Lagrange plate in its rotating frame), then fitted to the
 * poster target: centred, scaled to fill it inside `plateMargin`, optionally rotated 90 degrees when that fills it
 * better. Integrated lines are simplified with RDP at 0.02 page mm; the sample counts (substeps for accuracy,
 * recorded steps for drawing) are chosen per plate in plates-study.ts so the chord error stays under 0.05 mm.
 */
import type { Part, Point } from '../../src/sketch/types.ts';
import { clipPolylineToRect } from '../../packages/plot-core/src/clip.ts';
import { circlePath, simplify } from './extract.ts';
import { criticalLevels, lagrangePoints, zeroVelocityCurves } from './lagrange.ts';
import type { History, Vec2 } from './model.ts';
import type { PlateMarks, PlateStudy } from './plates-study.ts';

/** RDP tolerance for every drawn line, page mm. */
export const PLATE_SIMPLIFY_MM = 0.02;
/** Distance of a burn tick from the orbit line it belongs to, page mm. */
export const TICK_OFFSET_MM = 2.4;
/** Chord error of the small exact circles, page mm. */
export const PLATE_CIRCLE_CHORD_MM = 0.02;

export type PenRole = 'orbit' | 'highlight' | 'reference';
export interface SceneLine { part: string; pen: PenRole; points: Vec2[] }
/** Items whose size is set in page mm, not metres. A tick is displaced along the world unit vector `side` by TICK_OFFSET_MM, so it stands beside the orbit instead of on it. */
export type Glyph =
  | { part: string; pen: PenRole; kind: 'circle'; at: Vec2; mm: number }
  | { part: string; pen: PenRole; kind: 'cross'; at: Vec2; mm: number }
  | { part: string; pen: PenRole; kind: 'tick'; at: Vec2; dir: Vec2; mm: number; side: Vec2 };
export interface Scene { lines: SceneLine[]; glyphs: Glyph[] }

export interface Mapper {
  /** Millimetres of page per metre. */
  mmPerM: number;
  /** Rotation applied, degrees. */
  rotation: number;
  toArt(p: Vec2): Point;
  toWorld(p: Point): Vec2;
  /** Page-mm position of a world point. */
  toPage(p: Vec2): Point;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;
const path = (h: History, particle: number, from: number, to: number): Vec2[] => {
  const out: Vec2[] = [];
  for (let s = from; s <= to; s++) out.push({ x: h.xs[s - h.fromStep][particle], y: h.ys[s - h.fromStep][particle] });
  return out;
};
const where = (h: History, particle: number, step: number): Vec2 => ({ x: h.xs[step - h.fromStep][particle], y: h.ys[step - h.fromStep][particle] });
const attractorPath = (h: History, index: number, from: number, to: number): Vec2[] => {
  const out: Vec2[] = [];
  for (let s = from; s <= to; s++) out.push({ x: h.ax[s - h.fromStep][index], y: h.ay[s - h.fromStep][index] });
  return out;
};

/** Hohmann plate: circles and transfer arcs integrated, burns from the scheduled impulses at the integrated burn points. */
function hohmannScene(study: PlateStudy, h: History | null): Scene {
  const plan = study.hohmann!;
  const marks = study.marks;
  const scene: Scene = { lines: [], glyphs: [] };
  const centre = h ? { x: h.ax[0][0], y: h.ay[0][0] } : plan.centre;
  scene.glyphs.push({ part: 'bodies', pen: 'orbit', kind: 'circle', at: centre, mm: marks.bodyRadius * 1.5 });
  if (!h) return scene;
  plan.orbitParticles.forEach((p, k) => scene.lines.push({ part: 'orbits', pen: 'orbit', points: path(h, p, 0, plan.periodSteps[k]) }));
  if (marks.showTransfers) {
    for (const hop of plan.hops) {
      scene.lines.push({ part: 'transfers', pen: 'highlight', points: path(h, hop.transfer, hop.departStep, hop.arriveStep) });
      for (const [step, dv] of [[hop.departStep, hop.dv1], [hop.arriveStep, hop.dv2]] as const) {
        const len = Math.hypot(dv.x, dv.y);
        const at = where(h, hop.transfer, step);
        const out = Math.hypot(at.x - centre.x, at.y - centre.y);
        scene.glyphs.push({
          part: 'burns', pen: 'highlight', kind: 'tick', at, dir: { x: dv.x / len, y: dv.y / len }, mm: marks.tickScale * len,
          side: { x: (at.x - centre.x) / out, y: (at.y - centre.y) / out },
        });
      }
    }
  }
  if (marks.showPlanets) {
    for (const hop of plan.hops) {
      scene.glyphs.push({ part: 'bodies', pen: 'orbit', kind: 'circle', at: where(h, hop.sourcePlanet, hop.departStep), mm: marks.bodyRadius });
      scene.glyphs.push({ part: 'bodies', pen: 'orbit', kind: 'circle', at: where(h, hop.targetPlanet, hop.arriveStep), mm: marks.bodyRadius });
    }
  }
  return scene;
}

/** Levels of the zero-velocity curves for a mode and count (see the brief). */
export function zeroVelocityLevels(mu: number, mode: PlateMarks['zvcMode'], count: number): number[] {
  if (mode === 'off') return [];
  const c = criticalLevels(mu);
  const ordered = [c.L1, c.L2, c.L3, c.L4];
  if (mode === 'critical') return ordered.slice(0, count);
  // Necks: between consecutive critical values, so the L1, then L2, then L3 necks open one at a time; a fourth level
  // above C(L1) shows every neck closed.
  const mid = (a: number, b: number): number => (a + b) / 2;
  return [mid(c.L1, c.L2), mid(c.L2, c.L3), mid(c.L3, c.L4), c.L1 + 0.5 * (c.L1 - c.L2)].slice(0, count);
}

/** Lagrange plate in the rotating frame: world metres are rotating-frame metres about the barycentre. */
function lagrangeScene(study: PlateStudy, h: History | null): Scene {
  const plan = study.lagrange!;
  const marks = study.marks;
  const { mu, a } = plan;
  const scene: Scene = { lines: [], glyphs: [] };
  const scale = (p: Vec2): Vec2 => ({ x: p.x * a, y: p.y * a });
  const masses = study.config.attractors.map(m => m.mass);
  const total = masses[0] + masses[1];
  const frameAt = (get: (index: number) => Vec2): { bary: Vec2; angle: number } => {
    const p1 = get(0), p2 = get(1);
    return { bary: { x: (masses[0] * p1.x + masses[1] * p2.x) / total, y: (masses[0] * p1.y + masses[1] * p2.y) / total }, angle: Math.atan2(p2.y - p1.y, p2.x - p1.x) };
  };
  // Rotate by minus the integrated binary angle about the integrated barycentre: the primaries stand still on the page.
  const toRotating = (p: Vec2, frame: { bary: Vec2; angle: number }): Vec2 => {
    const dx = p.x - frame.bary.x, dy = p.y - frame.bary.y, c = Math.cos(-frame.angle), s = Math.sin(-frame.angle);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  };
  if (h) {
    const frames = Array.from({ length: h.xs.length }, (_v, k) => frameAt(index => ({ x: h.ax[k][index], y: h.ay[k][index] })));
    for (const particle of plan.particles) {
      const points = path(h, particle.particle, h.fromStep, Math.min(h.toStep, particle.drawSteps)).map((p, k) => toRotating(p, frames[k]));
      scene.lines.push({ part: particle.kind === 'horseshoe' ? 'horseshoe' : 'tadpoles', pen: 'orbit', points });
    }
    const last = frames.length - 1;
    for (const index of [0, 1]) {
      scene.glyphs.push({ part: 'bodies', pen: 'orbit', kind: 'circle', at: toRotating({ x: h.ax[last][index], y: h.ay[last][index] }, frames[last]), mm: marks.bodyRadius * (index === 0 ? 1.5 : 1) });
    }
  } else {
    scene.glyphs.push({ part: 'bodies', pen: 'orbit', kind: 'circle', at: scale({ x: -mu, y: 0 }), mm: marks.bodyRadius * 1.5 });
    scene.glyphs.push({ part: 'bodies', pen: 'orbit', kind: 'circle', at: scale({ x: 1 - mu, y: 0 }), mm: marks.bodyRadius });
  }
  if (marks.showPoints) {
    for (const p of Object.values(lagrangePoints(mu))) scene.glyphs.push({ part: 'lagrange-points', pen: 'highlight', kind: 'cross', at: scale(p), mm: marks.crossSize });
  }
  const levels = zeroVelocityLevels(mu, marks.zvcMode, marks.zvcCount);
  const boundaryLevels = marks.orbitBoundaries && h ? plan.particles.map(p => p.jacobi) : [];
  const top = Math.max(0, ...levels, ...boundaryLevels);
  const half = Math.max(1.5, 1.12 * Math.sqrt(top));
  const box = { xMin: -half, xMax: half, yMin: -half, yMax: half };
  // A plate is at most about 120 page mm per unit of separation; 0.015 mm of chord error in those units.
  const tol = 0.015 / 120;
  for (const level of levels) for (const line of zeroVelocityCurves(mu, level, box, 900, tol)) scene.lines.push({ part: 'zero-velocity', pen: 'reference', points: line.map(scale) });
  for (const level of boundaryLevels) for (const line of zeroVelocityCurves(mu, level, box, 900, tol)) scene.lines.push({ part: 'orbit-boundaries', pen: 'reference', points: line.map(scale) });
  return scene;
}

/** Three-body plate: one full period of every body (or of body 1), bodies as circles at a phase. */
function threebodyScene(study: PlateStudy, h: History | null): Scene {
  const plan = study.threebody!;
  const marks = study.marks;
  const scene: Scene = { lines: [], glyphs: [] };
  if (!h) {
    study.config.attractors.forEach(m => scene.glyphs.push({ part: 'bodies', pen: 'orbit', kind: 'circle', at: m.position, mm: marks.bodyRadius }));
    return scene;
  }
  const count = marks.bodies === 'first' ? 1 : 3;
  for (let i = 0; i < count; i++) scene.lines.push({ part: 'orbits', pen: 'orbit', points: attractorPath(h, i, 0, plan.steps) });
  const step = Math.round(marks.bodyPhase * plan.steps) % plan.steps;
  for (let i = 0; i < 3; i++) scene.glyphs.push({ part: 'bodies', pen: 'orbit', kind: 'circle', at: attractorPath(h, i, step, step)[0], mm: marks.bodyRadius });
  return scene;
}

export function plateScene(study: PlateStudy, h: History | null): Scene {
  if (study.plate === 'lagrange') return lagrangeScene(study, h);
  if (study.plate === 'threebody') return threebodyScene(study, h);
  return hohmannScene(study, h);
}

/**
 * Fit a scene to the poster target: rotate about the middle of its extent, centre it, and scale it to fill the target
 * inside `margin` (a fraction of each side). With `autoOrient` the rotation or rotation + 90 degrees is used,
 * whichever gives the larger scale.
 */
export function makeMapper(study: PlateStudy, scene: Scene): Mapper {
  const { fit, marks } = study;
  const points: Vec2[] = [...scene.lines.flatMap(l => l.points), ...scene.glyphs.map(g => g.at)];
  const target = fit.target;
  const attempt = (rotationDeg: number) => {
    const c = Math.cos(rad(rotationDeg)), s = Math.sin(rad(rotationDeg));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
      const x = p.x * c - p.y * s, y = p.x * s + p.y * c;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const w = Math.max(x1 - x0, 1e-9), hh = Math.max(y1 - y0, 1e-9);
    const scale = Math.min((target.width * (1 - 2 * marks.margin)) / w, (target.height * (1 - 2 * marks.margin)) / hh);
    return { rotationDeg, c, s, scale, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  };
  const options = marks.autoOrient ? [attempt(marks.rotation), attempt(marks.rotation + 90)] : [attempt(marks.rotation)];
  const best = options.reduce((a, b) => (b.scale > a.scale * (1 + 1e-9) ? b : a));
  const tx = target.x + target.width / 2, ty = target.y + target.height / 2;
  const toPage = (p: Vec2): Point => ({ x: tx + best.scale * (p.x * best.c - p.y * best.s - best.cx), y: ty + best.scale * (p.x * best.s + p.y * best.c - best.cy) });
  return {
    mmPerM: best.scale, rotation: best.rotationDeg, toPage,
    toArt: p => fit.inverse(toPage(p)),
    toWorld: art => {
      const px = art.x * fit.scale + fit.dx, py = art.y * fit.scale + fit.dy;
      const x = (px - tx) / best.scale + best.cx, y = (py - ty) / best.scale + best.cy;
      return { x: x * best.c + y * best.s, y: -x * best.s + y * best.c };
    },
  };
}

const pens = (marks: PlateMarks): Record<PenRole, string> => ({ orbit: marks.orbitPen, highlight: marks.highlightPen, reference: marks.referencePen });
const PART_ORDER = ['zero-velocity', 'orbit-boundaries', 'orbits', 'tadpoles', 'horseshoe', 'transfers', 'burns', 'bodies', 'lagrange-points'];

/** Part id of the diagnostic that carries the state key (or the off marker). */
export const plateStateId = (plate: string, key: string | null): string => (key === null ? `plate-state-${plate}-off` : `plate-state-${plate}-key-${key.replace(/[^A-Za-z0-9]/g, '_')}`);

/** Draw one plate. All coordinates are art coordinates; composePoster maps them to the page. */
export function extractPlate(study: PlateStudy, h: History | null): Part[] {
  const scene = plateScene(study, h);
  const map = makeMapper(study, scene);
  const roles = pens(study.marks);
  const { fit, frame } = study;
  const tolerance = PLATE_SIMPLIFY_MM / fit.scale;
  const parts = new Map<string, { pen: string; paths: Point[][] }>();
  const bucket = (id: string, pen: PenRole): Point[][] => {
    if (!parts.has(id)) parts.set(id, { pen: roles[pen], paths: [] });
    return parts.get(id)!.paths;
  };
  const inFrame = (paths: Point[][]): Point[][] => paths.flatMap(p => clipPolylineToRect(p, frame));
  for (const line of scene.lines) bucket(line.part, line.pen).push(...inFrame([simplify(line.points.map(map.toArt), tolerance)]));
  for (const g of scene.glyphs) {
    const centre = map.toArt(g.at);
    const mm = g.mm / fit.scale;
    if (g.kind === 'circle') bucket(g.part, g.pen).push(...inFrame([circlePath(centre, mm, g.mm, PLATE_CIRCLE_CHORD_MM)]));
    else if (g.kind === 'cross') bucket(g.part, g.pen).push(...inFrame([
      [{ x: centre.x - mm / 2, y: centre.y }, { x: centre.x + mm / 2, y: centre.y }],
      [{ x: centre.x, y: centre.y - mm / 2 }, { x: centre.x, y: centre.y + mm / 2 }],
    ]));
    else {
      const unit = (v: Vec2): Point => {
        const a = map.toArt({ x: g.at.x + v.x * 1e-3, y: g.at.y + v.y * 1e-3 });
        const n = Math.hypot(a.x - centre.x, a.y - centre.y) || 1;
        return { x: (a.x - centre.x) / n, y: (a.y - centre.y) / n };
      };
      const u = unit(g.dir), side = unit(g.side);
      const c = { x: centre.x + (side.x * TICK_OFFSET_MM) / fit.scale, y: centre.y + (side.y * TICK_OFFSET_MM) / fit.scale };
      bucket(g.part, g.pen).push(...inFrame([[{ x: c.x - (u.x * mm) / 2, y: c.y - (u.y * mm) / 2 }, { x: c.x + (u.x * mm) / 2, y: c.y + (u.y * mm) / 2 }]]));
    }
  }
  const ordered = [...parts.keys()].sort((x, y) => PART_ORDER.indexOf(x) - PART_ORDER.indexOf(y));
  const out: Part[] = ordered.map(id => ({ id, pen: parts.get(id)!.pen, paths: parts.get(id)!.paths }));
  out.push({ id: plateStateId(study.plate, h ? h.final.hashes.stateKey : null), pen: roles.orbit, paths: [], diagnostic: true });
  return out;
}
