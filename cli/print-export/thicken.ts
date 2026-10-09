/**
 * Thicken: raise each pen's stroke width for a raster print, never closing a gap below `gapMin`.
 *
 * The widths are per pen class (carbon, the four coloured pens, lettering), each at least the stroke's own plotted
 * width. The gap guard uses the density probe (`sketches/kit/density.ts`) over every stroke of the card at once: two
 * strokes that run beside each other, near parallel and closer than `gapMin` plus their widths' mean, would have their
 * paper gap closed by the new width, so both keep the widest width that leaves the gap (centre distance less `gapMin`),
 * and never less than the plotted width. A capped stroke is flagged `capped`; the report counts them.
 *
 * What the probe sees is strokes side by side. The end-to-end gaps of dashes, and gaps a line's own bend closes, are
 * not parallel neighbours, so they are not guarded here.
 */
import type { Part } from '../../src/sketch/types.ts';
import { densityProbe } from '../../sketches/kit/density.ts';
import type { PenLayer } from './svg.ts';

export type PenClass = 'carbon' | 'colour' | 'lettering';
export const PEN_CLASSES: readonly PenClass[] = ['carbon', 'colour', 'lettering'];

/** The class a pen's width setting comes from: the border is drawn in carbon, the lettering pen alone is lettering. */
export function penClass(penId: string): PenClass {
  return penId === 'lettering' ? 'lettering' : penId === 'carbon' || penId === 'finishing-border' ? 'carbon' : 'colour';
}

export interface ThickenOptions {
  /** Target stroke width per pen class, mm. */
  widths: Record<PenClass, number>;
  /** The paper gap a thickened line must leave beside its neighbour, mm. */
  gapMin: number;
  /** The shortest stretch two strokes must run that close to count (the probe's `minRun`), mm. Default 0.5. */
  minRun?: number;
  /** The most two strokes may turn from parallel and still count, degrees. Default 10. */
  angle?: number;
  /** Strokes nearer than this are one line drawn twice, not neighbours, mm. Default 0.05. */
  coincident?: number;
}

export interface ThickenReport {
  /** Strokes on the card. */
  paths: number;
  /** Strokes that took a wider width than they were drawn at. */
  thickened: number;
  /** Strokes the gap guard held below their class width, including those held at the plotted width. */
  capped: number;
  /** Of those, strokes held at exactly the plotted width. */
  heldAtPlotted: number;
  byClass: Record<PenClass, { paths: number; capped: number }>;
  /** Pairs of strokes the probe found too close at the class widths. */
  violations: number;
}

const EPS = 1e-9;

/** Two strokes (by index into the card's strokes) that run closer than `need` allows, at their narrowest `gap` (centre to centre, mm). */
export interface CloseStrokes { a: number; b: number; gap: number; need: number }

/** Pairs of strokes that run beside each other closer than their `widths` (mean) plus `gapMin`, by the density probe. */
function closePairs(paths: readonly Part['paths'][number][], widths: readonly number[], options: ThickenOptions): CloseStrokes[] {
  const { gapMin } = options;
  if (paths.length < 2 || !(gapMin > 0)) return [];
  let widest = 0;
  for (const w of widths) widest = Math.max(widest, w);
  // One probe at the widest width: a pair counts when its narrowest gap is under its own need.
  const limit = widest + gapMin;
  const report = densityProbe([{ id: 'card', pen: 'card', paths: paths as Part['paths'] }], {
    penWidth: () => limit, k: 1, coincident: (options.coincident ?? 0.05) / limit,
    angle: options.angle ?? 10, minRun: options.minRun ?? 0.5, worst: Infinity,
  });
  const out: CloseStrokes[] = [];
  for (const v of report.parts[0]?.worst ?? []) {
    const [a, b] = v.paths, need = (widths[a] + widths[b]) / 2 + gapMin;
    if (v.gap < need) out.push({ a, b, gap: v.gap, need });
  }
  return out;
}

/** The layers with every stroke's width set: class width, held back by the gap guard where a neighbour is too close. */
export function thickenLayers(layers: readonly PenLayer[], options: ThickenOptions): { layers: PenLayer[]; report: ThickenReport } {
  const { widths, gapMin } = options;
  const flat = layers.flatMap(layer => layer.strokes.map(stroke => ({ layer, stroke, cls: penClass(layer.penId) })));
  const target = flat.map(f => Math.max(f.stroke.width, widths[f.cls]));
  const cap = target.slice();
  const close = closePairs(flat.map(f => f.stroke.points), target, options);
  for (const { a, b, gap } of close) {
    const room = gap - gapMin;
    for (const i of [a, b]) cap[i] = Math.min(cap[i], Math.max(flat[i].stroke.width, room));
  }
  const byClass: ThickenReport['byClass'] = { carbon: { paths: 0, capped: 0 }, colour: { paths: 0, capped: 0 }, lettering: { paths: 0, capped: 0 } };
  let thickened = 0, capped = 0, heldAtPlotted = 0;
  const out = new Map<PenLayer, PenLayer>(layers.map(l => [l, { ...l, strokes: [] }]));
  flat.forEach((f, i) => {
    const width = Math.min(target[i], cap[i]);
    const held = width < target[i] - EPS;
    byClass[f.cls].paths++;
    if (width > f.stroke.width + EPS) thickened++;
    if (held) { capped++; byClass[f.cls].capped++; if (Math.abs(width - f.stroke.width) < EPS) heldAtPlotted++; }
    out.get(f.layer)!.strokes.push({ ...f.stroke, width, capped: held });
  });
  return { layers: layers.map(l => out.get(l)!), report: { paths: flat.length, thickened, capped, heldAtPlotted, byClass, violations: close.length } };
}

/**
 * The guard's own postcondition, for `after` = `thickenLayers(before)`: pairs still closer than their widths allow,
 * other than those no width can help (a stroke already at its plotted width in `before`, drawn that close). Empty for
 * a card the guard has been through, to a small tolerance for the probe's sampling along a slightly tilted pair.
 */
export function unguardedPairs(before: readonly PenLayer[], after: readonly PenLayer[], options: ThickenOptions): CloseStrokes[] {
  const plotted = before.flatMap(l => l.strokes).map(s => s.width);
  const strokes = after.flatMap(l => l.strokes);
  return closePairs(strokes.map(s => s.points), strokes.map(s => s.width), options)
    .filter(p => strokes[p.a].width > plotted[p.a] + EPS || strokes[p.b].width > plotted[p.b] + EPS);
}
