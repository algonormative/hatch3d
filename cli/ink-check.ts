/**
 * Where a pen's own lines run closer together than it can hold apart, and where art sits close to a cut guide.
 *
 *   node --import tsx cli/ink-check.ts [--out dir] [--cut-clearance mm] <piece-dir> [<piece-dir> ...]
 *
 * A piece dir is a finalize output (or a print-queue entry): `plot-ready.svg` plus, to name the paper, `config.json`
 * and `report.json` / `finalize-report.json`. For each ink layer (not the cut pen or the border) the check resamples
 * every stroke every 0.2 mm and gives each sample the distance to its nearest near-parallel neighbour: a sample on
 * another stroke, or on the same stroke more than three clean pitches away along it (a serpentine hatch counts), whose
 * direction is within about 20 degrees of its own. A sample is tight when that distance is under the pen's clean pitch
 * (less 0.02 mm) and fused when it is at or under the fuse pitch; both come from the calibration measurements for that
 * ink on that paper (`limitsOn`, with conservative defaults for a pair that was never plotted, which the report marks).
 * Crossings are not flagged: lines that cross at a steep angle are not parallel.
 *
 * Also counted, for information: open strokes shorter than the pen's shortest clean dash (strokes of 0.35 mm or less
 * are deliberate dots and left out) and closed loops smaller than its smallest clean circle.
 *
 * Cut clearance (assembly plies): the length of ink within `--cut-clearance` (default 1.0 mm) of the cut layer's outlines.
 * It is a coarse test. The cut layer holds guide marks and labels as well as outlines, so only its long strokes count
 * (any segment of 5 mm or more, and any closed stroke of 25 mm or more); a window drawn as many short segments with no
 * long closed outline is missed; the distance is to the drawn guide, which sits half a pen width inside the cut, not
 * to the cut itself; and art that bleeds under another ply's window is not told apart from art too near this ply's own.
 *
 * Writes `ink-check.png` (strokes faint on the paper colour, tight samples orange, fused red) and `ink-check.json`
 * into each piece dir, or into `<out>/<piece>/` with `--out`. It reports and never blocks: the exit code is 0 unless
 * the command line is wrong. Nothing here talks to a plotter.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderSvgPng } from './sketch/export-png.ts';
import { PAPERS, limitsOn, type Limits } from '../src/sketch/materials.ts';

/** Samples are taken every STEP millimetres along every stroke. */
export const STEP = 0.2;
/** A sample is tight when its nearest parallel neighbour is closer than the clean pitch less this much (mm). */
export const TIGHT_SLACK = 0.02;
/** Two directions are parallel when the absolute cosine of the angle between them is at least this (about 20 degrees). */
export const PARALLEL = 0.94;
/** Open strokes at most this long are dots, drawn on purpose. */
const DOT = 0.35;
/** Cut-layer strokes that count as outlines: any segment this long (mm), or a closed stroke this long. */
const OUTLINE_SEGMENT = 5, OUTLINE_LOOP = 25;
/** The prepared SVG's coordinates are rounded to 0.001 mm, so a pitch exactly at the fuse pitch measures a few microns either side of it. */
const FUSE_EPSILON = 0.005;
const CELL_MM = 10;
/** A layer is worth a warning in finalize's report when this share of it is tight, or this much of it fused (mm). */
const WARN_TIGHT_PCT = 1, WARN_FUSED_MM = 5, WARN_CUT_MM = 1;

type Stroke = Float64Array; // x0, y0, x1, y1, ...
export interface InkLayer { label: string; pen: string; strokes: Stroke[] }

/** Reads the numbered layer groups of a sketch-grammar SVG: absolute `M` and `L` (and `Z`) in millimetres. */
export function parseLayers(svg: string): InkLayer[] {
  const layers: InkLayer[] = [];
  for (const part of svg.split(/(?=<g\b[^>]*inkscape:groupmode="layer")/).slice(1)) {
    const open = /^<g\b([^>]*)>/.exec(part)?.[1] ?? '';
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(open)?.[1];
    const label = attr('inkscape:label') ?? '';
    const strokes: Stroke[] = [];
    const close = part.indexOf('</g>');
    for (const m of (close < 0 ? part : part.slice(0, close)).matchAll(/<path\b[^>]*\bd="([^"]*)"/g)) strokes.push(...parsePath(m[1]));
    layers.push({ label, pen: attr('data-pen-id') ?? label.replace(/^\d+-/, ''), strokes });
  }
  return layers;
}

function parsePath(d: string): Stroke[] {
  const out: Stroke[] = [];
  let current: number[] = [];
  const flush = () => { if (current.length >= 4) out.push(Float64Array.from(current)); current = []; };
  let numbers: number[] = [];
  let command = '';
  const apply = () => {
    if (command === 'M' || command === 'L') {
      if (numbers.length % 2) throw new Error(`ink-check: odd coordinate count in path "${d.slice(0, 40)}"`);
      for (let i = 0; i < numbers.length; i += 2) {
        if (command === 'M' && i === 0) flush();
        current.push(numbers[i], numbers[i + 1]);
      }
    } else if (command === 'Z' || command === 'z') {
      if (current.length >= 4) current.push(current[0], current[1]);
    } else if (command) throw new Error(`ink-check: unsupported path command ${command} (only absolute M, L and Z are read)`);
    numbers = [];
  };
  for (const token of d.matchAll(/([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/gi)) {
    if (token[1]) { apply(); command = token[1]; } else numbers.push(Number(token[2]));
  }
  apply();
  flush();
  return out;
}

const strokeLength = (s: Stroke): number => { let t = 0; for (let i = 2; i < s.length; i += 2) t += Math.hypot(s[i] - s[i - 2], s[i + 1] - s[i - 1]); return t; };

export interface Samples { n: number; x: Float64Array; y: Float64Array; dx: Float64Array; dy: Float64Array; s: Float64Array; stroke: Int32Array }

/** Points every `step` mm along each stroke (from its start, not past its end), with unit directions and arc positions. */
export function resample(strokes: Stroke[], step = STEP): Samples {
  const counts = strokes.map((s) => { const total = strokeLength(s); return total < step ? 0 : Math.ceil(total / step - 1e-9); });
  const n = counts.reduce((a, b) => a + b, 0);
  const out: Samples = { n, x: new Float64Array(n), y: new Float64Array(n), dx: new Float64Array(n), dy: new Float64Array(n), s: new Float64Array(n), stroke: new Int32Array(n) };
  let at = 0;
  strokes.forEach((p, id) => {
    const m = counts[id];
    if (!m) return;
    const first = at;
    let seg = 0, start = 0, end = Math.hypot(p[2] - p[0], p[3] - p[1]);
    for (let k = 0; k < m; k++) {
      const t = k * step;
      while (t > end && seg < p.length / 2 - 2) { seg++; start = end; end += Math.hypot(p[2 * seg + 2] - p[2 * seg], p[2 * seg + 3] - p[2 * seg + 1]); }
      const f = end > start ? Math.min(1, Math.max(0, (t - start) / (end - start))) : 0;
      out.x[at] = p[2 * seg] + (p[2 * seg + 2] - p[2 * seg]) * f;
      out.y[at] = p[2 * seg + 1] + (p[2 * seg + 3] - p[2 * seg + 1]) * f;
      out.s[at] = t;
      out.stroke[at] = id;
      at++;
    }
    for (let i = first; i < at; i++) {
      const a = Math.max(first, i - 1), b = Math.min(at - 1, i + 1);
      let vx = out.x[b] - out.x[a], vy = out.y[b] - out.y[a];
      if (a === b) { vx = p[p.length - 2] - p[0]; vy = p[p.length - 1] - p[1]; }
      const len = Math.hypot(vx, vy) || 1;
      out.dx[i] = vx / len;
      out.dy[i] = vy / len;
    }
  });
  return out;
}

interface Grid { cell: number; minX: number; minY: number; nx: number; ny: number; start: Int32Array; order: Int32Array }

/** A uniform grid over points: `order[start[c]..start[c+1])` are the points in cell c, where c = ix * ny + iy. */
function buildGrid(x: Float64Array, y: Float64Array, n: number, cell: number): Grid {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]); minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]); }
  if (!n) { minX = minY = maxX = maxY = 0; }
  // Larger cells only cost time, so a freak drawing never asks for a huge grid.
  const limit = 6_000_000;
  let size = cell;
  while (((maxX - minX) / size + 1) * ((maxY - minY) / size + 1) > limit) size *= 1.5;
  const nx = Math.floor((maxX - minX) / size) + 1, ny = Math.floor((maxY - minY) / size) + 1;
  const where = new Int32Array(n);
  const start = new Int32Array(nx * ny + 1);
  for (let i = 0; i < n; i++) { where[i] = Math.floor((x[i] - minX) / size) * ny + Math.floor((y[i] - minY) / size); start[where[i] + 1]++; }
  for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
  const fill = start.slice(0, nx * ny), order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[fill[where[i]]++] = i;
  return { cell: size, minX, minY, nx, ny, start, order };
}

export interface Scan { samples: Samples; /** Distance to the nearest parallel neighbour within the search radius, else Infinity. */ close: Float64Array }
export interface ScanOptions {
  /** Directions with an absolute cosine below this are not parallel (default `PARALLEL`). Injectable so a test can probe it. */
  minCos?: number;
}

/**
 * For every sample of the strokes, the distance to its nearest near-parallel neighbour. A neighbour counts when it is
 * the sample of another stroke (or of the same stroke far enough along it) that lies opposite this one, within a step
 * along its line: the distance is then measured across that line, so the spacing of parallel hatch does not depend on
 * where the two strokes' samples happen to fall. Neighbours farther than the clean pitch (less the slack)
 * are not looked for, so a sample with none has an infinite distance.
 */
export function scanSpacing(strokes: Stroke[], clean: number, { minCos = PARALLEL }: ScanOptions = {}): Scan {
  const samples = resample(strokes);
  const { n, x, y, dx, dy, s, stroke } = samples;
  const close = new Float64Array(n).fill(Infinity);
  const radius = clean - TIGHT_SLACK;
  if (!n || radius <= 0) return { samples, close };
  // A neighbour across `radius` can be a step off along its line: samples are a step apart, and the last sample of a
  // stroke can be a step short of the end the next stroke's first sample sits at.
  const reach = STEP + 0.02, reach2 = radius * radius + reach * reach, along = 3 * clean;
  const g = buildGrid(x, y, n, Math.sqrt(reach2));
  for (let a = 0; a < n; a++) {
    const ix = Math.floor((x[a] - g.minX) / g.cell), iy = Math.floor((y[a] - g.minY) / g.cell);
    let best = Infinity;
    for (let cx = Math.max(0, ix - 1); cx <= Math.min(g.nx - 1, ix + 1); cx++) {
      for (let cy = Math.max(0, iy - 1); cy <= Math.min(g.ny - 1, iy + 1); cy++) {
        const c = cx * g.ny + cy;
        for (let k = g.start[c]; k < g.start[c + 1]; k++) {
          const b = g.order[k];
          if (stroke[a] === stroke[b] && Math.abs(s[a] - s[b]) < along) continue;
          const ex = x[a] - x[b], ey = y[a] - y[b];
          if (ex * ex + ey * ey > reach2) continue;
          if (Math.abs(dx[a] * dx[b] + dy[a] * dy[b]) < minCos) continue;
          if (Math.abs(ex * dx[b] + ey * dy[b]) > reach) continue;
          const across = Math.abs(ex * dy[b] - ey * dx[b]);
          if (across < best) best = across;
        }
      }
    }
    close[a] = best;
  }
  return { samples, close };
}

export const isTight = (close: number, limits: Pick<Limits, 'cleanPitch'>): boolean => close < limits.cleanPitch - TIGHT_SLACK;
export const isFused = (close: number, limits: Pick<Limits, 'fusePitch'>): boolean => close <= limits.fusePitch + FUSE_EPSILON;

/** Open strokes shorter than `minDash` (dots excluded) and closed loops of equivalent radius (from the area) under `minRadius`. */
export function countShort(strokes: Stroke[], minDash: number, minRadius: number): { shortDashes: number; smallLoops: number } {
  let shortDashes = 0, smallLoops = 0;
  for (const p of strokes) {
    const length = strokeLength(p);
    if (length <= DOT) continue;
    if (p.length >= 8 && Math.hypot(p[p.length - 2] - p[0], p[p.length - 1] - p[1]) <= 0.05) {
      let area = 0;
      for (let i = 2; i < p.length; i += 2) area += p[i - 2] * p[i + 1] - p[i] * p[i - 1];
      if (Math.sqrt(Math.abs(area) / 2 / Math.PI) < minRadius) smallLoops++;
    } else if (length < minDash) shortDashes++;
  }
  return { shortDashes, smallLoops };
}

/** The points (every `STEP`) of the cut layer's outlines: any segment of 5 mm or more, and any closed stroke of 25 mm or more. */
export function outlinePoints(strokes: Stroke[]): { x: Float64Array; y: Float64Array; n: number; strokes: number } {
  const xs: number[] = [], ys: number[] = [];
  let kept = 0;
  for (const p of strokes) {
    const closed = p.length >= 8 && Math.hypot(p[p.length - 2] - p[0], p[p.length - 1] - p[1]) <= 0.05 && strokeLength(p) >= OUTLINE_LOOP;
    let any = false;
    for (let i = 2; i < p.length; i += 2) {
      const length = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
      if (!closed && length < OUTLINE_SEGMENT) continue;
      any = true;
      const m = Math.max(1, Math.ceil(length / STEP));
      for (let k = 0; k <= m; k++) { xs.push(p[i - 2] + ((p[i] - p[i - 2]) * k) / m); ys.push(p[i - 1] + ((p[i + 1] - p[i - 1]) * k) / m); }
    }
    if (any) kept++;
  }
  return { x: Float64Array.from(xs), y: Float64Array.from(ys), n: xs.length, strokes: kept };
}

/** Which of the samples are within `threshold` mm of some outline point. */
export function nearOutline(samples: Samples, outline: { x: Float64Array; y: Float64Array; n: number }, threshold: number): Uint8Array {
  const near = new Uint8Array(samples.n);
  if (!outline.n || !samples.n) return near;
  const g = buildGrid(outline.x, outline.y, outline.n, threshold);
  const t2 = threshold * threshold;
  for (let a = 0; a < samples.n; a++) {
    const ix = Math.floor((samples.x[a] - g.minX) / g.cell), iy = Math.floor((samples.y[a] - g.minY) / g.cell);
    found: for (let cx = Math.max(0, ix - 1); cx <= Math.min(g.nx - 1, ix + 1); cx++) {
      for (let cy = Math.max(0, iy - 1); cy <= Math.min(g.ny - 1, iy + 1); cy++) {
        const c = cx * g.ny + cy;
        for (let k = g.start[c]; k < g.start[c + 1]; k++) {
          const b = g.order[k], ex = samples.x[a] - outline.x[b], ey = samples.y[a] - outline.y[b];
          if (ex * ex + ey * ey <= t2) { near[a] = 1; break found; }
        }
      }
    }
  }
  return near;
}

export interface LayerCheck {
  label: string; pen: string;
  /** False when the ink was never plotted on this paper (or the paper is unknown): the limits are the conservative defaults. */
  measured: boolean; cleanPitch: number; fusePitch: number;
  /** Length of the resampled line, tight and fused length (mm), and the share that is tight (%). */
  lengthMm: number; tightMm: number; tightPct: number; fusedMm: number;
  /** The three 10 mm cells with the most fused line: their corner and the fused length in them. */
  topCells: { x: number; y: number; mm: number }[];
  shortDashes: number; smallLoops: number; minDash: number; minRadius: number;
  /** Ink within the cut clearance of the cut layer's outlines (mm); absent when the piece has no cut layer. */
  nearCutMm?: number;
}
export interface InkCheckReport {
  paper: string | null; stepMm: number; cutClearanceMm: number;
  layers: LayerCheck[];
  /** The cut layer the clearance was measured from, and how many of its strokes counted as outlines; null without one. */
  cut: { label: string; outlineStrokes: number; nearMm: number } | null;
  warnings: string[];
}
export interface InkCheckOptions {
  /** The paper's id in the materials catalog; without it every pen is checked against the defaults. */
  paper?: string;
  /** The paper's colour, for the overlay. */
  paperColor?: string;
  /** The pen id of the cut layer (default `cut`). */
  cutPen?: string;
  cutClearance?: number;
  /** Injected into the spacing scan; see `ScanOptions`. */
  minCos?: number;
}
export interface InkCheck { report: InkCheckReport; /** The overlay as an SVG string in millimetres, built on demand. */ overlay(): string; page: { width: number; height: number; paper: string } }

const round = (n: number, places = 1) => +n.toFixed(places);
const SKIPPED = new Set(['finishing-border']);

export function pageOf(svg: string): { width: number; height: number } {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  const box = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(root);
  if (box) return { width: Number(box[1]), height: Number(box[2]) };
  const size = (name: string) => Number(new RegExp(`\\b${name}="([\\d.]+)mm"`).exec(root)?.[1]);
  const width = size('width'), height = size('height');
  if (!width || !height) throw new Error('ink-check: the SVG has neither a viewBox nor a size in mm');
  return { width, height };
}

/** Runs the spacing, cut-clearance, dash and loop checks on a plot-ready SVG. */
export function inkCheck(svg: string, options: InkCheckOptions = {}): InkCheck {
  const { paper, paperColor = '#ffffff', cutPen = 'cut', cutClearance = 1.0, minCos } = options;
  const page = pageOf(svg);
  const layers = parseLayers(svg);
  const cutLayers = layers.filter((l) => l.pen === cutPen || l.pen === 'cut');
  const outline = outlinePoints(cutLayers.flatMap((l) => l.strokes));
  const hasCut = cutLayers.length > 0;
  const checks: LayerCheck[] = [];
  const scans: { layer: InkLayer; limits: Limits; scan: Scan }[] = [];
  for (const layer of layers) {
    if (cutLayers.includes(layer) || SKIPPED.has(layer.pen)) continue;
    const limits = limitsOn(layer.pen, paper ?? '');
    const scan = scanSpacing(layer.strokes, limits.cleanPitch, { minCos });
    const { n, x, y } = scan.samples, { close } = scan;
    let tight = 0, fused = 0;
    const cells = new Map<string, { x: number; y: number; n: number }>();
    for (let i = 0; i < n; i++) {
      if (!isTight(close[i], limits)) continue;
      tight++;
      if (!isFused(close[i], limits)) continue;
      fused++;
      const cx = Math.floor(x[i] / CELL_MM) * CELL_MM, cy = Math.floor(y[i] / CELL_MM) * CELL_MM, key = `${cx},${cy}`;
      const cell = cells.get(key) ?? { x: cx, y: cy, n: 0 };
      cell.n++;
      cells.set(key, cell);
    }
    const { shortDashes, smallLoops } = countShort(layer.strokes, limits.minDash, limits.minRadius);
    const check: LayerCheck = {
      label: layer.label, pen: layer.pen, measured: limits.measured, cleanPitch: limits.cleanPitch, fusePitch: limits.fusePitch,
      lengthMm: round(n * STEP), tightMm: round(tight * STEP), tightPct: n ? round((100 * tight) / n) : 0, fusedMm: round(fused * STEP),
      topCells: [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 3).map((c) => ({ x: c.x, y: c.y, mm: round(c.n * STEP) })),
      shortDashes, smallLoops, minDash: limits.minDash, minRadius: limits.minRadius,
    };
    if (hasCut) {
      const near = nearOutline(scan.samples, outline, cutClearance);
      check.nearCutMm = round(near.reduce((t, v) => t + v, 0) * STEP);
    }
    checks.push(check);
    scans.push({ layer, limits, scan });
  }
  const cut = hasCut ? { label: cutLayers.map((l) => l.label).join('+'), outlineStrokes: outline.strokes, nearMm: round(checks.reduce((t, c) => t + (c.nearCutMm ?? 0), 0)) } : null;
  const report: InkCheckReport = { paper: paper ?? null, stepMm: STEP, cutClearanceMm: cutClearance, layers: checks, cut, warnings: [] };
  report.warnings = warningsOf(report);
  return { report, page: { ...page, paper: paperColor }, overlay: () => overlaySvg(layers, scans, page, paperColor) };
}

/** One plain line per layer worth a look (tight on at least 1% of its length, or 5 mm fused), and one for ink near the cut. */
export function warningsOf(report: InkCheckReport): string[] {
  const out: string[] = [];
  for (const c of report.layers) {
    if (c.tightPct < WARN_TIGHT_PCT && c.fusedMm < WARN_FUSED_MM) continue;
    const basis = c.measured ? '' : ' (limits assumed: this ink was never plotted on this paper)';
    out.push(`${c.label}: ${c.tightPct}% of its ${Math.round(c.lengthMm)} mm runs closer than ${c.cleanPitch} mm to a parallel line, ${Math.round(c.fusedMm)} mm of it at ${c.fusePitch} mm or closer, where the pen fuses lines${basis}`);
  }
  if (report.cut && report.cut.nearMm >= WARN_CUT_MM) out.push(`${Math.round(report.cut.nearMm)} mm of ink within ${report.cutClearanceMm} mm of the cut outlines`);
  return out;
}

const isDark = (hex: string): boolean => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? (0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16)) / 255 < 0.35 : false;
};
const fmt = (n: number) => String(+n.toFixed(2));

/** Every stroke faint on the paper colour; over it, each ink layer's tight stretches in orange and its fused ones in red. */
function overlaySvg(layers: InkLayer[], scans: { limits: Limits; scan: Scan }[], page: { width: number; height: number }, paperColor: string): string {
  const faint = layers.flatMap((l) => l.strokes).map((p) => {
    let d = '';
    for (let i = 0; i < p.length; i += 2) d += `${i ? 'L' : 'M'}${fmt(p[i])},${fmt(p[i + 1])}`;
    return d;
  }).join('');
  let tightPath = '', fusedPath = '';
  for (const { limits, scan } of scans) {
    const { n, x, y, stroke } = scan.samples;
    let run: { fused: boolean; d: string } | null = null;
    const end = () => { if (run) { if (run.fused) fusedPath += run.d; else tightPath += run.d; run = null; } };
    for (let i = 0; i < n; i++) {
      const c = scan.close[i];
      if (!isTight(c, limits)) { end(); continue; }
      const fused = isFused(c, limits);
      if (run && (run.fused !== fused || stroke[i] !== stroke[i - 1])) end();
      // A lone sample is drawn as a tiny segment so that the round cap makes it a dot.
      run = run ?? { fused, d: `M${fmt(x[i])},${fmt(y[i])}L${fmt(x[i] + 0.01)},${fmt(y[i])}` };
      run.d += `L${fmt(x[i])},${fmt(y[i])}`;
    }
    end();
  }
  const style = (stroke: string, width: number) => `fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}mm" height="${page.height}mm" viewBox="0 0 ${page.width} ${page.height}">`,
    `<rect width="${page.width}" height="${page.height}" fill="${paperColor}"/>`,
    `<path ${style(isDark(paperColor) ? '#5b5b60' : '#8f8f88', 0.2)} d="${faint}"/>`,
    `<path ${style('#ff9600', 0.5)} d="${tightPath}"/>`,
    `<path ${style('#ff2828', 0.5)} d="${fusedPath}"/>`,
    '</svg>',
  ].join('\n');
}

/** The overlay as a PNG at 3 px/mm. */
export function overlayPng(check: InkCheck): Buffer {
  return renderSvgPng(check.overlay(), check.page, 'paper', 3);
}

/** Writes `ink-check.json` (the report, with the piece's name if given) and `ink-check.png` into `dir`, which is made if need be. */
export function writeCheck(check: InkCheck, dir: string, piece?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ink-check.json'), JSON.stringify({ ...(piece ? { piece } : {}), ...check.report }, null, 2));
  writeFileSync(join(dir, 'ink-check.png'), overlayPng(check));
}

export type InkCheckSummary = InkCheckReport | { error: string };

/**
 * The check as finalize runs it on a piece it has just prepared: written into `dir`, its report returned for the
 * piece's own report. Undefined when the piece's paper is not in the catalog (nothing was measured on it, so the
 * limits would all be guesses); an error becomes `{ error }` and never throws, since this must not fail a finalize.
 */
export function checkPrepared(svg: string, dir: string, options: InkCheckOptions): InkCheckSummary | undefined {
  if (!options.paper) return undefined;
  try {
    const check = inkCheck(svg, options);
    writeCheck(check, dir);
    return check.report;
  } catch (e) {
    return { error: `ink-check skipped: ${(e as Error).message}` };
  }
}

// ── Pieces on disk ───────────────────────────────────────────────────

/** The fields of a piece's `report.json` and `config.json` that name its paper. */
interface PieceFile { palette?: string; paper?: string; assembly?: { paper?: { id?: string; color?: string }; cutPen?: string }; page?: { paper?: string } }
const readJson = (file: string): PieceFile | undefined => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as PieceFile : undefined);

/** The catalog paper whose colour this is, if any. */
export function paperIdOfColor(color: string | undefined): string | undefined {
  return color ? Object.values(PAPERS).find((p) => p.color.toLowerCase() === color.toLowerCase())?.id : undefined;
}

/** Paper, paper colour and cut pen of a finalized piece, from its report (an assembly ply names its paper) and config. */
export function pieceContext(dir: string): { paper?: string; paperColor: string; cutPen?: string } {
  const report = readJson(join(dir, 'report.json')) ?? readJson(join(dir, 'finalize-report.json'));
  const config = readJson(join(dir, 'config.json'));
  const paperColor: string = report?.assembly?.paper?.color ?? config?.page?.paper ?? report?.paper ?? '#ffffff';
  const ply = /^ply-(.+)$/.exec(String(report?.palette ?? ''))?.[1];
  const paper = report?.assembly?.paper?.id ?? (ply && Object.hasOwn(PAPERS, ply) ? ply : undefined) ?? paperIdOfColor(paperColor);
  return { paper, paperColor, cutPen: report?.assembly?.cutPen };
}

const pad = (s: string, n: number) => s.length >= n ? s : s + ' '.repeat(n - s.length);
const num = (n: number, w: number) => String(Math.round(n)).padStart(w);

/** One line per layer, as the command prints it. */
export function layerLine(name: string, c: LayerCheck, clearance: number): string {
  const cells = c.topCells.map((t) => `(${t.x},${t.y}) ${Math.round(t.mm)} mm`).join('; ');
  return `${pad(name, 22)} ${pad(c.label, 20)} line ${num(c.lengthMm, 6)} mm  tight (<${+(c.cleanPitch - TIGHT_SLACK).toFixed(2)}): ${num(c.tightMm, 5)} mm (${c.tightPct.toFixed(1).padStart(4)}%)  fused (<=${c.fusePitch}): ${num(c.fusedMm, 5)} mm`
    + `  dashes<${c.minDash}: ${c.shortDashes}  loops<r${c.minRadius}: ${c.smallLoops}${c.nearCutMm === undefined ? '' : `  near cut (<${clearance}): ${Math.round(c.nearCutMm)} mm`}${c.measured ? '' : '  [default limits]'}`
    + (cells ? `  top cells ${cells}` : '');
}

interface CliOptions { out?: string; cutClearance: number; dirs: string[] }
function parseArgs(argv: string[]): CliOptions | string {
  const options: CliOptions = { cutClearance: 1.0, dirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') options.out = argv[++i];
    else if (a === '--cut-clearance') {
      options.cutClearance = Number(argv[++i]);
      if (!(options.cutClearance > 0)) return '--cut-clearance needs a positive number of millimetres';
    } else if (a.startsWith('-')) return `unknown option ${a}`;
    else options.dirs.push(resolve(a));
  }
  if (options.out === '') return '--out needs a directory';
  return options.dirs.length ? options : 'no piece dir given';
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === 'string') {
    console.error(`ink-check: ${options}\nusage: node --import tsx cli/ink-check.ts [--out dir] [--cut-clearance mm] <piece-dir> [<piece-dir> ...]`);
    return 2;
  }
  const used = new Set<string>();
  for (const dir of options.dirs) {
    const name = basename(dir);
    const file = join(dir, 'plot-ready.svg');
    if (!existsSync(file)) { console.log(`SKIP  ${name}: no plot-ready.svg`); continue; }
    try {
      const context = pieceContext(dir);
      const started = Date.now();
      const check = inkCheck(readFileSync(file, 'utf8'), { ...context, cutClearance: options.cutClearance });
      for (const c of check.report.layers) console.log(layerLine(name, c, options.cutClearance));
      if (!context.paper) console.log(`${pad(name, 22)} (paper not in the catalog: every pen checked against the default limits)`);
      if (check.report.cut) console.log(`${pad(name, 22)} cut layer ${check.report.cut.label}: ${check.report.cut.outlineStrokes} outline strokes, ${Math.round(check.report.cut.nearMm)} mm of ink within ${options.cutClearance} mm`);
      let target = dir;
      if (options.out) {
        const base = resolve(options.out);
        target = join(base, used.has(name) ? `${basename(dirname(dir))}-${name}` : name);
        used.add(name);
      }
      writeCheck(check, target, name);
      console.log(`${pad(name, 22)} wrote ${join(target, 'ink-check.png')} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    } catch (e) {
      console.log(`SKIP  ${name}: ${(e as Error).message}`);
    }
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error((e as Error).message); process.exitCode = 2; });
}
