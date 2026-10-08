import type { Part, Point } from '../../src/sketch/types.ts';

/**
 * The density probe: the measurable form of "drops detail gracefully". Within each part (one pen), it finds
 * strokes that run alongside each other, near parallel, closer than `k` times the pen's width (twice, by
 * default). Lines that close on paper merge into one band of ink, so a hatch whose pitch shrank with the card
 * shows up here as a field of violations, while one held in real millimetres does not.
 *
 * What counts, for two strokes of one part (or two stretches of one stroke, folded back on itself):
 *   - they turn less than `angle` degrees from each other,
 *   - one runs beside the other (its points project onto the other's segments),
 *   - the gap between them is under `k × width`, but over `coincident × width`: closer than that they are the
 *     same line drawn twice, which costs plot time but adds no density,
 *   - and they stay that close for at least `minRun` millimetres.
 * Each stroke is cut into pieces no longer than the limit and binned on a grid, so the probe is linear in the
 * total length drawn (about 150 ms for a tabloid card, 20 ms for a 70 × 120 one).
 *
 * The report gives the violating pairs, worst first, with where they are, and per part the share of its drawn
 * length that runs too close to another stroke. A Breach card is not free of them even at tabloid: a low eye
 * sees every box's top face as a sliver, and receding walls converge, so the approved prints flag well over half
 * their length. A re-projected card is therefore held to its own print: `denserThan` names the parts that crowd
 * more than they do on the reference render, which is what a pitch that shrank with the card does.
 */

export interface DensityOptions {
  /** A pen's width in millimetres, by pen id. */
  penWidth: (pen: string) => number;
  /** The closest two strokes may sit, as a multiple of the pen width. Default 2. */
  k?: number;
  /** Below this multiple of the pen width two strokes are one line drawn twice, not neighbours. Default 0.2. */
  coincident?: number;
  /** The most two strokes may turn from parallel and still count, in degrees. Default 10. */
  angle?: number;
  /** The shortest stretch, in millimetres, two strokes must run that close to count. Default 1. */
  minRun?: number;
  /** How many of the worst violations to keep, per part and overall. Default 5. */
  worst?: number;
}

/** Two strokes of one part that run too close: their path indices, the narrowest gap and where it is, and how far they run that close. */
export interface DensityViolation {
  part: string;
  pen: string;
  paths: [number, number];
  /** Narrowest gap between them, in millimetres. */
  gap: number;
  /** How far they run closer than the limit, in millimetres. */
  run: number;
  /** Where the narrowest gap is, on the page. */
  at: Point;
}

export interface DensityPartReport {
  id: string;
  pen: string;
  /** `k × width`: the closest two strokes of this part may sit. */
  limit: number;
  /** Violating pairs of strokes. */
  violations: number;
  /** Length drawn, in millimetres. */
  drawn: number;
  /** Length that runs too close to another stroke of a violating pair, in millimetres. */
  crowded: number;
  /** `crowded / drawn`. */
  share: number;
  worst: DensityViolation[];
}

export interface DensityReport {
  k: number;
  violations: number;
  drawn: number;
  crowded: number;
  share: number;
  parts: DensityPartReport[];
  /** The worst violations over every part: narrowest gap first, then longest run. */
  worst: DensityViolation[];
}

const byWorst = (a: DensityViolation, b: DensityViolation) => a.gap - b.gap || b.run - a.run;

export function densityProbe(parts: readonly Part[], options: DensityOptions): DensityReport {
  const k = options.k ?? 2;
  const coincident = options.coincident ?? 0.2;
  const sinMax = Math.sin((options.angle ?? 10) * Math.PI / 180);
  const minRun = options.minRun ?? 1;
  const keep = options.worst ?? 5;
  const reports: DensityPartReport[] = [];
  const all: DensityViolation[] = [];
  for (const part of parts) {
    if (part.diagnostic) continue;
    const width = options.penWidth(part.pen);
    if (!(width > 0)) throw new Error(`No width for pen ${part.pen} (part ${part.id})`);
    const limit = k * width;
    const { violations, drawn, crowded } = probePart(part, limit, coincident * width, sinMax, minRun);
    violations.sort(byWorst);
    all.push(...violations);
    reports.push({ id: part.id, pen: part.pen, limit, violations: violations.length, drawn, crowded, share: drawn ? crowded / drawn : 0, worst: violations.slice(0, keep) });
  }
  all.sort(byWorst);
  const drawn = reports.reduce((s, p) => s + p.drawn, 0), crowded = reports.reduce((s, p) => s + p.crowded, 0);
  return { k, violations: all.length, drawn, crowded, share: drawn ? crowded / drawn : 0, parts: reports, worst: all.slice(0, keep) };
}

/** A part that crowds more than it does on the reference: its share, and the reference's (0 where the reference has no such part). */
export interface DenserPart { id: string; share: number; reference: number }

/**
 * The parts of `report` whose crowded share is more than `slack` (a fraction of drawn length, default 0.05) above
 * the same part's on `reference`, for example a re-projected card against its tabloid print. Empty when the card
 * holds every tone the reference holds.
 */
export function denserThan(report: DensityReport, reference: DensityReport, slack = 0.05): DenserPart[] {
  const shares = new Map(reference.parts.map(p => [p.id, p.share]));
  return report.parts.map(p => ({ id: p.id, share: p.share, reference: shares.get(p.id) ?? 0 })).filter(p => p.share > p.reference + slack);
}

/** A summary of a report's worst offenders, for test failures and the CLI. */
export function describeDensity(report: DensityReport): string {
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  if (!report.violations) return `no strokes closer than ${report.k} × the pen width`;
  const lines = report.worst.map(v => `${v.part} paths ${v.paths[0]}/${v.paths[1]}: ${v.gap.toFixed(3)} mm apart for ${v.run.toFixed(2)} mm at (${v.at.x.toFixed(2)}, ${v.at.y.toFixed(2)})`);
  const parts = report.parts.filter(p => p.violations).map(p => `${p.id} ${p.violations} (${pct(p.share)})`).join(', ');
  return `${report.violations} pairs closer than ${report.k} × the pen width, ${pct(report.share)} of the length drawn: ${parts}; worst:\n  ${lines.join('\n  ')}`;
}

function probePart(part: Part, limit: number, floor: number, sinMax: number, minRun: number): { violations: DensityViolation[]; drawn: number; crowded: number } {
  // Pieces no longer than the limit: midpoint, unit direction, length, owning path, arclength of the midpoint.
  const mx: number[] = [], my: number[] = [], ux: number[] = [], uy: number[] = [], len: number[] = [], owner: number[] = [], along: number[] = [];
  let drawn = 0;
  part.paths.forEach((path, pi) => {
    let s = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
      if (!(l > 1e-9)) continue;
      const n = Math.ceil(l / limit), step = l / n;
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n;
        mx.push(a.x + dx * t); my.push(a.y + dy * t); ux.push(dx / l); uy.push(dy / l); len.push(step); owner.push(pi); along.push(s + step * (j + 0.5));
      }
      s += l;
    }
    drawn += s;
  });
  const count = mx.length;
  if (count < 2) return { violations: [], drawn, crowded: 0 };
  // A piece within `limit` of another's segment has its midpoint within `limit + limit / 2` of the other's.
  const cell = limit * 1.5;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < count; i++) { x0 = Math.min(x0, mx[i]); y0 = Math.min(y0, my[i]); x1 = Math.max(x1, mx[i]); y1 = Math.max(y1, my[i]); }
  const cols = Math.floor((x1 - x0) / cell) + 1, rows = Math.floor((y1 - y0) / cell) + 1;
  const cellOf = new Int32Array(count);
  const start = new Int32Array(cols * rows + 1);
  for (let i = 0; i < count; i++) { cellOf[i] = Math.floor((my[i] - y0) / cell) * cols + Math.floor((mx[i] - x0) / cell); start[cellOf[i] + 1]++; }
  for (let c = 0; c < cols * rows; c++) start[c + 1] += start[c];
  const order = new Int32Array(count), fill = start.slice(0, cols * rows);
  for (let i = 0; i < count; i++) order[fill[cellOf[i]]++] = i;

  // Per ordered pair of paths (this one beside that one): how far this one runs too close, and its narrowest gap.
  type Pair = { run: number; gap: number; at: Point };
  const pairs = new Map<number, Pair>();
  const stride = part.paths.length;
  // The other paths each piece runs too close to, for the crowded length once the pairs are known.
  const besides: { piece: number; others: number[] }[] = [];
  // Two stretches of one path closer than this along it are the same stretch, turning.
  const sameStretch = 3 * limit;
  const gapTo = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const cx = Math.floor((mx[i] - x0) / cell), cy = Math.floor((my[i] - y0) / cell);
    gapTo.clear();
    for (let yy = Math.max(0, cy - 1); yy <= Math.min(rows - 1, cy + 1); yy++) for (let xx = Math.max(0, cx - 1); xx <= Math.min(cols - 1, cx + 1); xx++) {
      const c = yy * cols + xx;
      for (let q = start[c]; q < start[c + 1]; q++) {
        const j = order[q];
        if (j === i) continue;
        if (owner[j] === owner[i] && Math.abs(along[j] - along[i]) < sameStretch) continue;
        if (Math.abs(ux[i] * uy[j] - uy[i] * ux[j]) > sinMax) continue;
        const rx = mx[i] - mx[j], ry = my[i] - my[j];
        if (Math.abs(rx * ux[j] + ry * uy[j]) > len[j] / 2) continue;
        const gap = Math.abs(rx * uy[j] - ry * ux[j]);
        if (gap <= floor || gap >= limit) continue;
        const prev = gapTo.get(owner[j]);
        if (prev === undefined || gap < prev) gapTo.set(owner[j], gap);
      }
    }
    if (!gapTo.size) continue;
    besides.push({ piece: i, others: [...gapTo.keys()] });
    for (const [other, gap] of gapTo) {
      const key = owner[i] * stride + other;
      const pair = pairs.get(key);
      if (!pair) pairs.set(key, { run: len[i], gap, at: { x: mx[i], y: my[i] } });
      else {
        pair.run += len[i];
        if (gap < pair.gap) { pair.gap = gap; pair.at = { x: mx[i], y: my[i] }; }
      }
    }
  }
  // A pair of paths counts once, when either side runs `minRun` too close: the longer run, the narrower gap.
  const out: DensityViolation[] = [];
  const violating = new Set<number>();
  for (const [key, pair] of pairs) {
    const a = Math.floor(key / stride), b = key % stride;
    const other = a === b ? undefined : pairs.get(b * stride + a);
    const run = Math.max(pair.run, other?.run ?? 0);
    if (run < minRun) continue;
    violating.add(key);
    if (b < a && other) continue;
    const narrow = other && other.gap < pair.gap ? other : pair;
    out.push({ part: part.id, pen: part.pen, paths: [Math.min(a, b), Math.max(a, b)], gap: narrow.gap, run, at: narrow.at });
  }
  let crowded = 0;
  for (const { piece, others } of besides) if (others.some(o => violating.has(owner[piece] * stride + o))) crowded += len[piece];
  return { violations: out, drawn, crowded };
}
