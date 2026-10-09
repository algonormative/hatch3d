/**
 * Ink character, optional: a gentle pen look on the lines. Each stroke's width wanders a little along its length
 * (smooth seeded noise, `jitter` either side of the width, one wander about `correlationMm` long) and the ink pools
 * at both ends (`blob` times the width at the very end, falling away over `blobMm`).
 *
 * The effect is meant to be subtle: at plotted scale it is a few hundredths of a millimetre, below the registration
 * and dot-gain noise of print, so it only shows when kept this strong. A stroke the gap guard held back is left
 * as it is, so the effect never leans on a gap the guard protected. Strokes come back as runs of constant width
 * (to 0.005 mm) joined by round caps, which a 300 ppi raster cannot tell from a continuous taper.
 */
import type { Point } from '../../src/sketch/types.ts';
import { noise1 } from './noise.ts';
import type { PenLayer, Stroke } from './svg.ts';

export interface InkOptions {
  seed: number;
  /** Width wander, as a fraction of the width either side. */
  jitter: number;
  /** Length of one wander, mm. */
  correlationMm: number;
  /** Width multiplier at a line's very end. 1 turns pooling off. */
  blob: number;
  /** Length over which the pooling falls away, mm. */
  blobMm: number;
  /** Sampling along a stroke, mm. */
  stepMm: number;
}

export const INK_DEFAULTS: Omit<InkOptions, 'seed'> = { jitter: 0.08, correlationMm: 6, blob: 1.6, blobMm: 0.3, stepMm: 0.25 };

const QUANTUM = 0.005;

/** The stroke as runs of constant width. */
export function inkStroke(stroke: Stroke, key: number, o: InkOptions): Stroke[] {
  const pts = stroke.points;
  const at: number[] = [0];
  for (let i = 1; i < pts.length; i++) at.push(at[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const length = at[at.length - 1];
  if (!(length > 0)) return [stroke];
  // Where to cut: every vertex (the shape stays exact), a grid along the stroke, and finer near both ends.
  const cuts = new Set<number>(at);
  for (let s = o.stepMm; s < length; s += o.stepMm) cuts.add(s);
  for (let k = 1; k <= 4; k++) { cuts.add(Math.min(length, o.blobMm * k / 4)); cuts.add(Math.max(0, length - o.blobMm * k / 4)); }
  const sorted = [...cuts].filter(s => s >= 0 && s <= length).sort((a, b) => a - b);
  const pointAt = (() => {
    let seg = 1;
    return (s: number): Point => {
      while (seg < at.length - 1 && at[seg] < s) seg++;
      const span = at[seg] - at[seg - 1];
      const t = span > 0 ? Math.min(1, Math.max(0, (s - at[seg - 1]) / span)) : 0;
      return { x: pts[seg - 1].x + (pts[seg].x - pts[seg - 1].x) * t, y: pts[seg - 1].y + (pts[seg].y - pts[seg - 1].y) * t };
    };
  })();
  const pool = (s: number): number => s < o.blobMm ? (1 - s / o.blobMm) ** 2 : 0;
  const runs: Stroke[] = [];
  let run: Stroke | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (!(b - a > 1e-9)) continue;
    const mid = (a + b) / 2;
    const wander = 1 + o.jitter * noise1(o.seed, key, mid, o.correlationMm);
    const ends = 1 + (o.blob - 1) * Math.max(pool(mid), pool(length - mid));
    const width = Math.round(stroke.width * wander * ends / QUANTUM) * QUANTUM;
    if (run && Math.abs(run.width - width) < 1e-9) run.points.push(pointAt(b));
    else { run = { ...stroke, width, points: [pointAt(a), pointAt(b)] }; runs.push(run); }
  }
  return runs.length ? runs : [stroke];
}

/** The layers with ink character on every stroke the gap guard did not hold back. */
export function inkCharacter(layers: readonly PenLayer[], options: InkOptions): PenLayer[] {
  return layers.map((layer, li) => ({
    ...layer,
    strokes: layer.strokes.flatMap((s, si) => s.capped ? [s] : inkStroke(s, li * 1_000_003 + si, options)),
  }));
}
