import type { Part, Point } from '../../src/sketch/types.ts';
import { hatchAtmosphere, maskAtmospherePaths, type AtmosphereField } from '../../packages/plot-core/src/atmosphere.ts';
import type { CloudSnapshot, Vec2 } from './model.ts';
import type { CloudDomain } from './sim.ts';
import type { CloudStudy, StructureMember } from './study.ts';

/** Extraction-only settings that are not part of MarkSettings. */
export interface ExtractParams {
  /** false: draw the structure as authored and nothing else; the simulation is not needed. */
  cloudEnabled: boolean;
  /** Interior hatch pitch of structural members, final page mm. */
  hatchPitch: number;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
/** Passes of 8-neighbour averaging that carry fluid density into solid cells (stops early once every reachable cell is filled). */
const OBSCURANCE_PASSES = 40;
/** Page-mm sampling step and minimum run length for masking structure. */
const MASK_STEP_MM = 0.8;
const MASK_MIN_LENGTH_MM = 0.8;
/** Page-mm clearance kept around visible member linework, and sampling step used where cloud runs are cut. */
export const MEMBER_CLEARANCE_MM = 0.6;
const CUT_STEP_MM = 0.2;
/** Page-mm guard added to the core radius so quantization cannot leave a point inside it. */
const CORE_GUARD_MM = 0.02;

/** Closed outline plus interior hatch of one member, in art coordinates. */
export function memberPaths(member: StructureMember, study: CloudStudy, pitchMm: number): Point[][] {
  const ring = member.polygon.map(study.worldToArt);
  const outline = [...ring, { ...ring[0] }];
  const pitch = Math.max(pitchMm, 0.05) / study.fit.scale;
  return [outline, ...hatchPolygon(ring, member.hatchAngle, pitch)];
}

/** Parallel lines on a global lattice (so hatching registers across members), clipped to a simple polygon. */
function hatchPolygon(ring: Point[], angle: number, pitch: number): Point[][] {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const nx = -dy, ny = dx;
  const offsets = ring.map(p => p.x * nx + p.y * ny);
  const lo = Math.min(...offsets), hi = Math.max(...offsets);
  const lines: Point[][] = [];
  for (let k = Math.ceil(lo / pitch); k * pitch < hi; k++) {
    const off = k * pitch + 1e-9;
    const along: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const va = a.x * nx + a.y * ny - off, vb = b.x * nx + b.y * ny - off;
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      along.push(x * dx + y * dy);
    }
    along.sort((p, q) => p - q);
    for (let i = 0; i + 1 < along.length; i += 2) {
      if (along[i + 1] - along[i] < pitch * 0.15) continue;
      const base = { x: nx * off, y: ny * off };
      lines.push([
        { x: base.x + dx * along[i], y: base.y + dy * along[i] },
        { x: base.x + dx * along[i + 1], y: base.y + dy * along[i + 1] },
      ]);
    }
  }
  return lines;
}

/**
 * Fluid concentration carried into solid cells by a few passes of 8-neighbour
 * averaging, so a member can be read as sitting behind cloud. Computed on a
 * copy: the snapshot is never mutated. Solid cells out of reach stay at zero.
 */
export function obscuranceGrid(domain: CloudDomain, density: ArrayLike<number>, passes = OBSCURANCE_PASSES): Float64Array {
  const { cols, rows, solid } = domain;
  const grid = new Float64Array(cols * rows);
  const known = new Uint8Array(cols * rows);
  for (let c = 0; c < grid.length; c++) {
    if (!solid[c]) { grid[c] = density[c]; known[c] = 1; }
  }
  for (let pass = 0; pass < passes; pass++) {
    const fresh: number[] = [];
    const value: number[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const c = j * cols + i;
        if (known[c]) continue;
        let sum = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if ((di === 0 && dj === 0) || ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
            const q = jj * cols + ii;
            if (known[q]) { sum += grid[q]; n++; }
          }
        }
        if (n > 0) { fresh.push(c); value.push(sum / n); }
      }
    }
    if (fresh.length === 0) break;
    for (let k = 0; k < fresh.length; k++) { grid[fresh[k]] = value[k]; known[fresh[k]] = 1; }
  }
  return grid;
}

/** Plain bilinear read of a cell-centred grid in world metres; zero outside the domain. */
function bilinear(domain: CloudDomain, grid: Float64Array, p: Vec2): number {
  const { cols, rows, spacing } = domain;
  const o = domain.config.domain.origin;
  const fx = (p.x - o.x) / spacing - 0.5, fy = (p.y - o.y) / spacing - 0.5;
  if (fx < -0.5 || fy < -0.5 || fx > cols - 0.5 || fy > rows - 0.5) return 0;
  const i0 = Math.max(0, Math.min(cols - 1, Math.floor(fx))), j0 = Math.max(0, Math.min(rows - 1, Math.floor(fy)));
  const i1 = Math.min(cols - 1, i0 + 1), j1 = Math.min(rows - 1, j0 + 1);
  const tx = Math.max(0, Math.min(1, fx - i0)), ty = Math.max(0, Math.min(1, fy - j0));
  const top = grid[j0 * cols + i0] * (1 - tx) + grid[j0 * cols + i1] * tx;
  const bottom = grid[j1 * cols + i0] * (1 - tx) + grid[j1 * cols + i1] * tx;
  return top * (1 - ty) + bottom * ty;
}

function insideDomain(study: CloudStudy, w: Vec2): boolean {
  const { origin, size } = study.config.domain;
  return w.x >= origin.x && w.x <= origin.x + size.x && w.y >= origin.y && w.y <= origin.y + size.y;
}

/** Cut a polyline to its parts outside a circle. Cut points land on the circle. */
export function clipOutsideCircle(path: Point[], center: Point, radius: number): Point[][] {
  const runs: Point[][] = [];
  let current: Point[] = [];
  const flush = (): void => { if (current.length >= 2) runs.push(current); current = []; };
  const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const fx = a.x - center.x, fy = a.y - center.y;
    const A = dx * dx + dy * dy;
    const ts = [0];
    if (A > 0) {
      const B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - radius * radius;
      const disc = B * B - 4 * A * C;
      if (disc > 0) {
        const root = Math.sqrt(disc);
        for (const t of [(-B - root) / (2 * A), (-B + root) / (2 * A)]) if (t > 0 && t < 1) ts.push(t);
      }
    }
    ts.sort((p, q) => p - q);
    ts.push(1);
    for (let k = 0; k + 1 < ts.length; k++) {
      const pa = lerp(a, b, ts[k]), pb = lerp(a, b, ts[k + 1]);
      const mid = lerp(a, b, (ts[k] + ts[k + 1]) / 2);
      if (Math.hypot(mid.x - center.x, mid.y - center.y) >= radius) {
        if (current.length === 0) current.push(pa);
        current.push(pb);
      } else flush();
    }
  }
  flush();
  return runs;
}

const pathLength = (path: Point[]): number =>
  path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);


function pointInRing(ring: Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const sq = dx * dx + dy * dy;
  const t = sq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / sq));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/**
 * Cut cloud marks away from members that are drawn. A sample is blocked when it lies inside a member
 * where that member is visible, or within `clearance` of a visible outline run. Where the member is
 * concealed the cloud may cross it. Runs end exactly at the edge of the blocked zone.
 */
function cutByVisibleMembers(
  paths: Point[][], rings: Point[][], outlines: Point[][], visibleAt: (p: Point) => boolean,
  clearance: number, step: number,
): Point[][] {
  const reach = clearance + step;
  const boxes = rings.map(ring => ({
    x0: Math.min(...ring.map(p => p.x)) - reach, x1: Math.max(...ring.map(p => p.x)) + reach,
    y0: Math.min(...ring.map(p => p.y)) - reach, y1: Math.max(...ring.map(p => p.y)) + reach,
  }));
  const inBox = (p: Point): boolean => boxes.some(b => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1);
  const segments = outlines.flatMap(run => run.slice(1).map((q, i) => [run[i], q] as const));
  const blocked = (p: Point): boolean => {
    if (!inBox(p)) return false;
    for (const [a, b] of segments) if (distanceToSegment(p, a, b) < clearance) return true;
    return rings.some(ring => pointInRing(ring, p)) && visibleAt(p);
  };
  const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  // Last kept point on the way from a kept sample toward a blocked one.
  const edge = (kept: Point, gone: Point): Point => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (blocked(lerp(kept, gone, mid))) hi = mid; else lo = mid; }
    return lerp(kept, gone, lo);
  };
  const out: Point[][] = [];
  for (const path of paths) {
    const samples: Point[] = [path[0]];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const near = len > step && (inBox(a) || inBox(b) || inBox(lerp(a, b, 0.5)));
      const n = near ? Math.ceil(len / step) : 1;
      for (let k = 1; k <= n; k++) samples.push(k === n ? b : lerp(a, b, k / n));
    }
    let run: Point[] = [];
    let prev = samples[0];
    let prevBlocked = blocked(prev);
    if (!prevBlocked) run.push(prev);
    for (let i = 1; i < samples.length; i++) {
      const cur = samples[i];
      const curBlocked = blocked(cur);
      if (!prevBlocked && !curBlocked) run.push(cur);
      else if (!prevBlocked && curBlocked) { run.push(edge(prev, cur)); if (run.length >= 2) out.push(run); run = []; }
      else if (prevBlocked && !curBlocked) run = [edge(cur, prev), cur];
      prev = cur; prevBlocked = curBlocked;
    }
    if (run.length >= 2) out.push(run);
  }
  return out;
}

const safe = (text: string): string => text.replace(/[^A-Za-z0-9]/g, '_');

/** Diagnostic part id: carries snapshot identity into result.json. Ids may not hold spaces or `=`. */
export function cloudStateId(snapshot: CloudSnapshot): string {
  const drift = snapshot.mass.relativeDrift;
  const digits = Math.abs(drift).toFixed(6).replace('.', 'p');
  return `cloud-state-step-${snapshot.step}-key-${safe(snapshot.hashes.stateKey)}-dens-${safe(snapshot.densityHash)}-drift-${drift < 0 ? 'neg' : 'pos'}${digits}`;
}

const STATE_ID = /^cloud-state-step-(\d+)-key-([A-Za-z0-9_]+)-dens-([A-Za-z0-9_]+)-drift-(pos|neg)(\d+)p(\d+)$/;
export function parseCloudStateId(id: string): { step: number; stateKey: string; densityHash: string; relativeDrift: number } | null {
  const m = STATE_ID.exec(id);
  if (!m) return null;
  return { step: Number(m[1]), stateKey: m[2], densityHash: m[3], relativeDrift: (m[4] === 'neg' ? -1 : 1) * Number(`${m[5]}.${m[6]}`) };
}

/**
 * Draw one snapshot. All coordinates are art coordinates; composePoster maps
 * them to the page. The concentration → contour mapping is fixed for every step
 * (field = clamp01(concentration / referenceDensity)); nothing is normalized by
 * the frame's own maximum.
 */
export function extractMarks(
  domain: CloudDomain | null,
  snapshot: CloudSnapshot | null,
  study: CloudStudy,
  params: ExtractParams,
): Part[] {
  const { marks, fit } = study;
  const members = study.structure.map(member => ({ member, paths: memberPaths(member, study, params.hatchPitch) }));
  const live = params.cloudEnabled && domain !== null && snapshot !== null;

  if (!live) {
    return [
      ...members.map(({ member, paths }) => ({ id: `structure-${member.name}`, pen: member.pen, paths })),
      { id: 'cloud-state-off', pen: marks.structurePen, paths: [], diagnostic: true },
    ];
  }

  // One field drives everything: fluid concentration spread into the solid cells so it passes smoothly
  // through members, mapped with the fixed rule clamp01(c / referenceDensity). It contours the cloud,
  // conceals structure, and decides where members are visible.
  const referenceDensity = marks.referenceDensity;
  const grid = obscuranceGrid(domain, snapshot.density);
  const field = ((art: Point): number => {
    const w = study.artToWorld(art);
    return insideDomain(study, w) ? clamp01(bilinear(domain, grid, w) / referenceDensity) : 0;
  }) as AtmosphereField;
  const concealThreshold = 1 - 0.98 * Math.sqrt(marks.obscure);
  const visibleAt = (p: Point): boolean => marks.obscure === 0 || field(p) < concealThreshold;
  // The minimum length drops only fragments the cut created; an untouched path (returned by
  // reference) survives however short it is, so a clear sky leaves the structure as authored.
  const mask = (path: Point[]): Point[][] => marks.obscure > 0
    ? maskAtmospherePaths([path], field, { amount: marks.obscure, sampleStep: MASK_STEP_MM / fit.scale, minLength: 0 })
      .filter(run => run === path || pathLength(run) >= MASK_MIN_LENGTH_MM / fit.scale)
    : [path];

  // Structure: concealed where cloud is dense. The first path of each member is its outline.
  const visibleOutlines: Point[][] = [];
  const structureParts: Part[] = members.map(({ member, paths }) => {
    const outline = mask(paths[0]);
    visibleOutlines.push(...outline);
    return { id: `structure-${member.name}`, pen: member.pen, paths: [...outline, ...paths.slice(1).flatMap(mask)] };
  });

  // Cloud: contour wisps of the field, cut away from visible members, then the quiet-core extraction mask.
  const a = study.worldToArt({ x: study.config.domain.origin.x, y: study.config.domain.origin.y });
  const b = study.worldToArt({
    x: study.config.domain.origin.x + study.config.domain.size.x,
    y: study.config.domain.origin.y + study.config.domain.size.y,
  });
  const bounds = { xMin: Math.min(a.x, b.x), xMax: Math.max(a.x, b.x), yMin: Math.min(a.y, b.y), yMax: Math.max(a.y, b.y) };
  const cloudField = Object.assign((art: Point): number => field(art), {
    scale: marks.featureScale / fit.scale, bounds, seed: marks.wispSeed,
  }) as AtmosphereField;
  const wisps = hatchAtmosphere(bounds, cloudField, {
    spacing: marks.hatchSpacing / fit.scale, angle: marks.hatchAngle,
  });
  let cloud = cutByVisibleMembers(
    wisps, study.structure.map(m => m.polygon.map(study.worldToArt)), visibleOutlines, visibleAt,
    MEMBER_CLEARANCE_MM / fit.scale, CUT_STEP_MM / fit.scale,
  );
  if (marks.core.radius > 0) {
    const center = fit.inverse(marks.core.center);
    const radius = (marks.core.radius + CORE_GUARD_MM) / fit.scale;
    cloud = cloud.flatMap(path => clipOutsideCircle(path, center, radius));
  }
  const minLength = (marks.hatchSpacing * 0.75) / fit.scale;
  cloud = cloud.filter(path => pathLength(path) >= minLength);

  return [
    ...structureParts,
    { id: `cloud-${marks.cloudPen}`, pen: marks.cloudPen, paths: cloud },
    { id: cloudStateId(snapshot), pen: marks.structurePen, paths: [], diagnostic: true },
  ];
}
