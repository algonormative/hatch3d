import type { Control, Point, SketchContext } from '../../../src/sketch/types.ts';
import { measureStrokeText, strokeText, type StrokeFace } from '../../../src/sketch/stroke-text.ts';
import { clipToRect, insideRing, keepAlong } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { ART } from '../world.ts';
import type { Cell, Pen } from './world.ts';

/**
 * Slogans woven into Upward Erasure, in two places:
 * - `visor`: a clean readout along the visor's lower edge, in black ink on the gold behind it (the android's display),
 *   with a rule and a block cursor;
 * - `rise`: the slogan rising off the top of a gold column and coming apart as it goes, letters drifting, dropping
 *   out and losing dots, on the black.
 */
export const SLOGANS: Record<string, string> = {
  forgetting: 'WE ROSE BY FORGETTING',
  deletion: 'ASCENSION IS DELETION',
  signal: 'ALL SIGNAL NO SELF',
  lease: 'MEMORY IS A LEASE',
  upload: 'UPLOAD COMPLETE',
  personal: 'NOTHING PERSONAL',
};
const PLACES = ['off', 'visor', 'rise', 'both'] as const;
const FACES: StrokeFace[] = ['matrix', 'wire', 'sans'];
const PENS: Pen[] = ['silver', 'gold', 'fluoro-pink'];

export const SLOGAN_CONTROLS: Control[] = [
  { type: 'select', id: 'sloganPlace', label: 'Where the slogan goes', default: 'off', options: [...PLACES],
    optionLabels: { off: 'No slogan', visor: 'Readout in the visor', rise: 'Rising off a column, coming apart', both: 'Both' }, group: 'Slogan' },
  { type: 'select', id: 'slogan', label: 'Slogan', default: 'forgetting', options: [...Object.keys(SLOGANS), 'custom'],
    optionLabels: { ...SLOGANS, custom: 'Custom (the text below)' }, group: 'Slogan' },
  { type: 'text', id: 'sloganText', label: 'Custom slogan', default: 'THIS WAS MADE BY A MACHINE', maxLength: 40, group: 'Slogan' },
  { type: 'select', id: 'sloganFace', label: 'Lettering', default: 'matrix', options: FACES,
    optionLabels: { matrix: 'Dot matrix', wire: 'Wire', sans: 'Hershey sans' }, group: 'Slogan' },
  { type: 'slider', id: 'sloganMm', label: 'Letter height', default: 6, min: 2.2, max: 9, step: 0.1, units: 'mm', group: 'Slogan' },
  { type: 'slider', id: 'sloganDecay', label: 'How far the rising slogan comes apart', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Slogan' },
  { type: 'select', id: 'sloganPen', label: 'Rising slogan pen', default: 'silver', options: PENS, group: 'Slogan' },
];

/** What the slogans add: black ink on the gold (the readout) and gel on the black (the rising slogan). */
export interface SloganInk {
  gold: Point[][]; black: Point[][]; pen: Pen;
  /** Rings where no other line on that sheet may run: the readout's screen, each rising letter's box. */
  clearGold: Point[][]; clearBlack: Point[][];
}

export interface SloganFrame {
  bar: Point[];
  toPage: (u: number, v: number) => Point;
  toBar: (p: Point) => { u: number; v: number };
  barH: number;
  cells: Cell[];
  onNose: (p: Point) => boolean;
  window: Point[][];
  page: { eyes: Point[]; noseTip: Point };
}

export const NO_SLOGAN: SloganInk = { gold: [], black: [], pen: 'silver', clearGold: [], clearBlack: [] };

export function sloganText(ctx: SketchContext, face: StrokeFace): string {
  const key = typeof ctx.params.slogan === 'string' ? ctx.params.slogan : 'forgetting';
  const raw = key === 'custom' ? String(ctx.params.sloganText ?? '') : (SLOGANS[key] ?? SLOGANS.forgetting);
  // The display faces are capitals only; anything a face cannot draw becomes a space.
  const text = face === 'sans' ? raw : raw.toUpperCase();
  return [...text].map(c => { try { measureStrokeText(c, { face, height: 1 }); return c; } catch { return ' '; } }).join('').replace(/\s+/g, ' ').trim();
}

export function slogans(ctx: SketchContext, f: SloganFrame): SloganInk {
  const place = PLACES.includes(ctx.params.sloganPlace as never) ? ctx.params.sloganPlace as typeof PLACES[number] : 'off';
  if (place === 'off') return NO_SLOGAN;
  const face: StrokeFace = FACES.includes(ctx.params.sloganFace as StrokeFace) ? ctx.params.sloganFace as StrokeFace : 'matrix';
  const text = sloganText(ctx, face);
  if (!text) return NO_SLOGAN;
  const h = n(ctx, 'sloganMm', 6, 2.2, 9), decay = n(ctx, 'sloganDecay', 0.6, 0, 1);
  const pen = PENS.includes(ctx.params.sloganPen as Pen) ? ctx.params.sloganPen as Pen : 'silver';
  const rng = ctx.random('erasure-slogan');

  // The visor's frame on the page: `dir` along it (u), `up` toward its top edge (v).
  const o = f.toPage(0, 0), du = f.toPage(1, 0), dv = f.toPage(0, 1);
  const dir = { x: du.x - o.x, y: du.y - o.y }, up = { x: dv.x - o.x, y: dv.y - o.y };
  /**
   * Text laid out along `along` (a unit page vector) from `origin` (its first letter's top-left), upright: the glyphs'
   * down is `along` turned a quarter clockwise on the page, so the text is never mirrored.
   */
  const place2d = (paths: Point[][], origin: Point, along: Point) => {
    const down = { x: -along.y, y: along.x };
    return paths.map(path => path.map(p => ({ x: origin.x + along.x * p.x + down.x * p.y, y: origin.y + along.y * p.x + down.y * p.y })));
  };
  const clipped = (paths: Point[][], keep: (p: Point) => boolean) =>
    paths.flatMap(path => keepAlong(path, keep, 0.05)).flatMap(path => clipToRect(path, ART)).filter(path => path.length >= 2);

  const out: SloganInk = { gold: [], black: [], pen, clearGold: [], clearBlack: [] };
  const box = (x0: number, y0: number, x1: number, y1: number): Point[][] => [[{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }]];
  const noseU = f.toBar(f.page.noseTip).u, faceSide = Math.sign(noseU - f.toBar(f.page.eyes[0]).u) || 1;

  if (place === 'visor' || place === 'both') {
    // Reading left to right on the page, whichever way the visor runs.
    const s = dir.x >= 0 ? 1 : -1, along = { x: dir.x * s, y: dir.y * s };
    const down = { x: -along.y, y: along.x };
    // Which way is the glyphs' down in the visor's v: toward the lower edge or away from it.
    const downIsLower = down.x * up.x + down.y * up.y < 0;
    // The stretch of the visor clear of the nose: from 28 mm back from its tip, back along the visor while the visor's
    // middle stays on the art.
    const inner = (u: number) => { const q = f.toPage(u, -f.barH / 2); return q.x > ART.x0 + 6 && q.x < ART.x1 - 6 && q.y > ART.y0 + 6 && q.y < ART.y1 - 6; };
    const start = noseU - faceSide * 28;
    let end = start;
    while (Math.abs(end - start) < 600 && inner(end - faceSide)) end -= faceSide;
    const lo = Math.min(start, end), hi = Math.max(start, end);
    let size = Math.min(h, f.barH * 0.3);
    const style = () => ({ face, height: size });
    const cursorW = size * 0.7, gap = size * 0.5;
    while (size > 2.2 && measureStrokeText(text, style()) + gap + cursorW > hi - lo) size -= 0.1;
    const width = measureStrokeText(text, style()) + gap + size * 0.7;
    if (width <= hi - lo) {
      const margin = Math.max(2.5, f.barH * 0.1);
      const vText = downIsLower ? -f.barH + margin + size : -f.barH + margin;
      // Text start in u: the left end of the stretch on the page.
      const uMid = (lo + hi) / 2, uStart = uMid - s * width / 2;
      const origin = f.toPage(uStart, vText);
      const letters = place2d(strokeText(text, 0, 0, style()), origin, along);
      // The block cursor after the text, hatched solid.
      const cx0 = measureStrokeText(text, style()) + gap, block: Point[][] = [];
      for (let x = 0; x <= size * 0.7; x += 0.35) block.push([{ x: cx0 + x, y: 0 }, { x: cx0 + x, y: size }]);
      // A rule along the readout, on the side toward the visor's middle.
      const ruleY = downIsLower ? -size * 0.45 : size * 1.45;
      const rule = [[{ x: -size, y: ruleY }, { x: width + size, y: ruleY }]];
      const inVisor = (p: Point) => insideRing(f.bar, p) && !f.onNose(p);
      out.gold.push(...clipped([...letters, ...place2d(block, origin, along), ...place2d(rule, origin, along)], inVisor));
      // The screen: the readout's band, from the rule past the letters' foot.
      out.clearGold.push(...place2d(box(-size, Math.min(ruleY, 0) - 0.8, width + size, Math.max(ruleY, size) + 0.8), origin, along));
    }
  }

  if (place === 'rise' || place === 'both') {
    // Up the page from a column's top: along the visor's v, reading upward.
    const len = Math.hypot(up.x, up.y), along = { x: up.x / len, y: up.y / len };
    const style = { face, height: h };
    const width = measureStrokeText(text, style);
    const inArt = (p: Point) => p.x > ART.x0 + 2 && p.x < ART.x1 - 2 && p.y > ART.y0 + 2 && p.y < ART.y1 - 2;
    // The rise column with the most air above it, back from the face, whose slogan fits up to the art's edge.
    let best: { c: Cell; room: number } | undefined;
    for (const c of f.cells) {
      if (c.kind !== 'rise' || (noseU - (c.u0 + c.u1) / 2) * faceSide < 20) continue;
      const u = (c.u0 + c.u1) / 2;
      let room = 0;
      while (room < 400 && inArt(f.toPage(u, c.v1 + 4 + room)) && inArt(f.toPage(u + h, c.v1 + 4 + room)) && inArt(f.toPage(u - h, c.v1 + 4 + room))) room += 1;
      if (room >= width * 0.6 && (!best || room > best.room)) best = { c, room };
    }
    if (best) {
      const u = (best.c.u0 + best.c.u1) / 2;
      // The glyphs' down is `along` turned a quarter clockwise: the text box sits centred on the column's middle.
      const down = { x: -along.y, y: along.x };
      const base = f.toPage(u, best.c.v1 + 4);
      const origin = { x: base.x - down.x * h / 2, y: base.y - down.y * h / 2 };
      const chars = [...text], letters: Point[][] = [];
      let drift = 0;
      chars.forEach((ch, i) => {
        if (ch === ' ') return;
        const t = chars.length > 1 ? i / (chars.length - 1) : 0;
        // Fixed draws per letter, so one letter's fate never shifts the next one's.
        const gone = rng(), side = rng() * 2 - 1, gap = rng(), dotSeed = rng();
        drift += decay * t * gap * h * 0.9;
        if (gone < decay * 0.7 * t ** 1.6) return;
        const x = measureStrokeText(text.slice(0, i + 1), style) - measureStrokeText(ch, style) + drift;
        const dots = ctx.random(`erasure-slogan-${i}-${Math.floor(dotSeed * 1e6)}`);
        const glyph = strokeText(ch, x, side * decay * t * h * 0.6, style).filter(() => dots() >= decay * t * 0.55);
        letters.push(...glyph);
        if (glyph.length) out.clearBlack.push(...place2d(box(x - 0.7, side * decay * t * h * 0.6 - 0.7, x + measureStrokeText(ch, style) + 0.7, side * decay * t * h * 0.6 + h + 0.7), origin, along));
      });
      const onWindow = (p: Point) => f.window.some(r => insideRing(r, p));
      out.black.push(...clipped(place2d(letters, origin, along), p => inArt(p) && !onWindow(p)));
    }
  }
  return out;
}
