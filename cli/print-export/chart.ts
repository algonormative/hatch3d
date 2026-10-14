/**
 * The proof deck's test chart: one card-sized image at the same spec as the cards, so a physical proof answers the
 * questions the research left open (research/card-printing-export.md section 7): how wide a line prints, how small a
 * gap stays open, whether the five inks hold, what grain does, which border inset survives the cut, where the trim and
 * the 5 mm safe line fall, and what a 3 mm die corner takes.
 *
 * Everything is in page millimetres with the origin at the trim's corner, drawn as strokes in the card's own pens, and
 * every label is stroke lettering in the lettering pen (the cathedral face the cards use). The ladders are drawn at
 * explicit widths and do not go through the thickening; the labels and frames do.
 */
import type { Point } from '../../src/sketch/types.ts';
import { measureStrokeText, strokeText } from '../../src/sketch/stroke-text.ts';
import { INK_DEFAULTS, inkStroke, type InkOptions } from './ink.ts';
import type { Grain } from './raster.ts';
import type { PenLayer, Stroke } from './svg.ts';
import { thickenLayers, type PenClass } from './thicken.ts';

export interface ChartConfig {
  trim: { width: number; height: number };
  /** The five art pens in palette order, carbon first. */
  pens: { id: string; color: string }[];
  letteringColor: string;
  widths: Record<PenClass, number>;
  gapMin: number;
  /** The guard's shortest close stretch, mm (see `ThickenOptions.minRun`). */
  minRun?: number;
  safeMm: number;
  grainMm: number;
  grainSeed: number;
  /** The grain on the rest of the sheet (the cards' setting); the patches carry their own. */
  grainStrength: number;
  /** The ink character the sample row uses; the defaults when the deck has none. */
  ink: InkOptions | null;
  /** Lines of the title block under the name, in lettering-face characters. */
  summary: string[];
}

export interface Chart {
  /** Pen layers with their final widths, in paint order. */
  layers: PenLayer[];
  /** SVG elements (page millimetres) painted under the lines: the colour patches. */
  fills: string;
  grain: Grain;
  /** The lowest y the chart draws to, mm: it must clear the innermost frame. */
  endMm: number;
}

export const CHART_WIDTHS = [0.15, 0.2, 0.25, 0.3, 0.35, 0.42, 0.5, 0.6];
export const CHART_GAPS = [0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6];
export const CHART_FRAMES = [3, 4, 5, 6];
export const CHART_GRAIN = [0.02, 0.04, 0.06];
/** The width of the thin guide lines (trim, safe ticks, corner arcs, patch outlines), mm. */
const GUIDE = 0.15;
/** The lettering pen's plotted width, mm: what the chart's labels fall back to under the gap guard. */
const PLOTTED_LETTERING = 0.13;

const at = (x: number, y: number): Point => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)];
const hundredths = (mm: number): string => String(Math.round(mm * 100));

/** `path` as dashes `on` long with `off` between, from its first point, carried round its corners. */
function dashed(path: Point[], on: number, off: number): Point[][] {
  const out: Point[][] = [];
  let run: Point[] | null = null;
  let phase = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], len = Math.hypot(b.x - a.x, b.y - a.y);
    const lerp = (s: number): Point => at(a.x + (b.x - a.x) * s / len, a.y + (b.y - a.y) * s / len);
    let s = 0;
    while (s < len - 1e-9) {
      const inDash = phase < on;
      const boundary = inDash ? on : on + off;
      const next = Math.min(len - s, boundary - phase);
      if (inDash) { if (!run) run = [lerp(s)]; run.push(lerp(s + next)); }
      s += next; phase += next;
      if (phase >= boundary - 1e-9) {
        if (inDash && run) { out.push(run); run = null; }
        phase = inDash ? on : 0;
      }
    }
  }
  if (run) out.push(run);
  return out;
}

export function buildChart(c: ChartConfig): Chart {
  const [carbon, ...colours] = c.pens;
  const layers = new Map<string, PenLayer>(c.pens.map((p, i) => [p.id, { label: `${i + 1}-${p.id}`, penId: p.id, color: p.color, strokes: [] }]));
  const draw = (pen: string, points: Point[], width: number) => layers.get(pen)!.strokes.push({ points, part: 'chart', width });
  const thick = (id: string): number => id === carbon.id ? c.widths.carbon : c.widths.colour;
  const letters: Stroke[] = [];
  const text = (s: string, x: number, y: number, height: number, tracking?: number): number => {
    const style = { face: 'cathedral' as const, height, ...(tracking === undefined ? {} : { tracking }) };
    for (const points of strokeText(s, x, y, style)) letters.push({ points, part: 'chart-text', width: c.widths.lettering });
    return measureStrokeText(s, style);
  };
  const centred = (s: string, cx: number, y: number, height: number) => text(s, cx - measureStrokeText(s, { face: 'cathedral', height }) / 2, y, height);

  const { width: W, height: H } = c.trim;
  const X0 = 8.5, X1 = W - 8.5;

  // Border test: frames at 3, 4, 5 and 6 mm from the trim, in carbon.
  for (const inset of CHART_FRAMES) draw(carbon.id, rect(inset, inset, W - inset, H - inset), c.widths.carbon);
  // The trim line, dashed, on the cut itself; the safe line as ticks in each corner, `safeMm` in from both edges; a 3 mm
  // die-corner arc at each corner.
  const violet = c.pens[c.pens.length - 1].id, blue = colours[0].id, red = colours[1].id;
  for (const path of dashed([at(0, 0), at(W, 0), at(W, H), at(0, H), at(0, 0)], 2, 1)) draw(violet, path, GUIDE);
  const s = c.safeMm;
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    const ox = sx > 0 ? 0 : W, oy = sy > 0 ? 0 : H;
    draw(blue, [at(ox + sx * s, oy), at(ox + sx * s, oy + sy * 2)], GUIDE);
    draw(blue, [at(ox, oy + sy * s), at(ox + sx * 2, oy + sy * s)], GUIDE);
    const arc: Point[] = [];
    for (let k = 0; k <= 24; k++) {
      const a = Math.PI / 2 * k / 24;
      arc.push(at(ox + sx * (3 - 3 * Math.cos(a)), oy + sy * (3 - 3 * Math.sin(a))));
    }
    draw(red, arc, GUIDE);
  }

  // Title block.
  let y = 8.6;
  text('PRINT CHART', X0, y, 2.2); y += 3.8;
  for (const line of c.summary) { text(line, X0, y, 1.6); y += 2.9; }

  // Line-width ladder: per pen, a vertical line at each width.
  const labelW = 17.5, colW = 4.0, ladderH = 3.0, pitch = 4.6;
  y += 1.4;
  text('WIDTH', X0, y, 1.6);
  CHART_WIDTHS.forEach((w, k) => centred(hundredths(w), X0 + labelW + colW * (k + 0.5), y, 1.6));
  y += 3.4;
  for (const pen of c.pens) {
    text(pen.id.toUpperCase(), X0, y + (ladderH - 1.6) / 2, 1.6);
    CHART_WIDTHS.forEach((w, k) => { const x = X0 + labelW + colW * (k + 0.5); draw(pen.id, [at(x, y), at(x, y + ladderH)], w); });
    y += pitch;
  }

  // Gap ladder, at the thickened widths: per pen, a cluster of three parallel lines for each clear gap.
  y += 1.2;
  text('GAP', X0, y, 1.6);
  const gapW = 4.8;
  CHART_GAPS.forEach((g, k) => centred(hundredths(g), X0 + labelW + gapW * (k + 0.5), y, 1.6));
  y += 3.4;
  for (const pen of c.pens) {
    text(pen.id.toUpperCase(), X0, y + (ladderH - 1.6) / 2, 1.6);
    const w = thick(pen.id);
    CHART_GAPS.forEach((g, k) => {
      const cx = X0 + labelW + gapW * (k + 0.5);
      for (const j of [-1, 0, 1]) draw(pen.id, [at(cx + j * (w + g), y), at(cx + j * (w + g), y + ladderH)], w);
    });
    y += pitch;
  }

  // The five inks, a column each: a solid patch, a line at the pen's width, and the same line with ink character.
  y += 1.2;
  text('INK', X0, y, 1.6);
  const inkW = (X1 - X0 - labelW) / c.pens.length, patchW = inkW - 1.2;
  c.pens.forEach((pen, k) => centred(pen.id.slice(0, 4).toUpperCase(), X0 + labelW + inkW * (k + 0.5) - 0.6, y, 1.6));
  y += 3.4;
  const ink = c.ink ?? { seed: c.grainSeed, ...INK_DEFAULTS };
  let fills = '';
  text('PATCH', X0, y + 1.3, 1.6);
  text('LINE', X0, y + 5.4, 1.6);
  text('INKED', X0, y + 8.2, 1.6);
  c.pens.forEach((pen, k) => {
    const x = X0 + labelW + inkW * k, w = thick(pen.id);
    fills += `<rect x="${+x.toFixed(3)}" y="${y}" width="${+patchW.toFixed(3)}" height="4.2" fill="${pen.color}"/>`;
    draw(pen.id, [at(x + 0.3, y + 6.2), at(x + patchW - 0.3, y + 6.2)], w);
    const sample: Stroke = { points: [at(x + 0.3, y + 9.0), at(x + patchW - 0.3, y + 9.0)], part: 'chart', width: w };
    for (const run of inkStroke(sample, k + 1, ink)) layers.get(pen.id)!.strokes.push(run);
  });
  y += 11.8;

  // Grain: three strengths on the paper, each with a flat tab for its label.
  y += 0.6;
  text(`GRAIN ${c.grainMm} MM`, X0, y, 1.6);
  y += 3.0;
  const zoneW = (X1 - X0 + 1.0) / CHART_GRAIN.length - 1.0, zoneTop = y, tab = 2.6, zoneH = 9.2;
  const zones = CHART_GRAIN.map((strength, k) => {
    const x = X0 + (zoneW + 1.0) * k;
    draw(carbon.id, rect(x, zoneTop, x + zoneW, zoneTop + zoneH), GUIDE);
    text(`${Math.round(strength * 100)} PCT`, x + 0.8, zoneTop + 0.5, 1.6);
    return { x0: x, y0: zoneTop + tab, x1: x + zoneW, y1: zoneTop + zoneH, strength };
  });

  const grain: Grain = {
    seed: c.grainSeed, grainMm: c.grainMm,
    strength: (x, yy) => zones.find(z => x >= z.x0 && x < z.x1 && yy >= z.y0 && yy < z.y1)?.strength ?? c.grainStrength,
  };

  // The labels take the lettering width and the same gap guard as a card's lettering.
  const lettering: PenLayer = { label: `${c.pens.length + 1}-lettering`, penId: 'lettering', color: c.letteringColor, strokes: letters.map(l => ({ ...l, width: PLOTTED_LETTERING })) };
  const { layers: [labels] } = thickenLayers([lettering], { widths: c.widths, gapMin: c.gapMin, minRun: c.minRun });
  return { layers: [...layers.values(), labels], fills, grain, endMm: zoneTop + zoneH };
}
