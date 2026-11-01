import type { Control, Point, SketchContext } from '../../../src/sketch/types.ts';
import { measureStrokeText, strokeText, type StrokeFace } from '../../../src/sketch/stroke-text.ts';
import { clipToRect, insideRing, keepAlong, type Rect } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
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
  { type: 'text', id: 'sloganText', label: 'Custom slogan', default: 'THIS WAS MADE BY A MACHINE', maxLength: 64, group: 'Slogan' },
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
  /** Where the black's art may go (the trim, or inside the frame). */
  art: Rect;
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
    paths.flatMap(path => keepAlong(path, keep, 0.05)).flatMap(path => clipToRect(path, f.art)).filter(path => path.length >= 2);

  const out: SloganInk = { gold: [], black: [], pen, clearGold: [], clearBlack: [] };
  const box = (x0: number, y0: number, x1: number, y1: number): Point[][] => [[{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }]];
  const noseU = f.toBar(f.page.noseTip).u, faceSide = Math.sign(noseU - f.toBar(f.page.eyes[0]).u) || 1;

  if (place === 'visor' || place === 'both') {
    // Reading left to right on the page, whichever way the visor runs.
    const s = dir.x >= 0 ? 1 : -1, along = { x: dir.x * s, y: dir.y * s };
    const down = { x: -along.y, y: along.x };
    // Which way is the glyphs' down in the visor's v: toward the lower edge or away from it.
    const downIsLower = down.x * up.x + down.y * up.y < 0;
    const margin = Math.max(2.5, f.barH * 0.1), lead = 1.6;
    const inVisor = (p: Point) => insideRing(f.bar, p) && !f.onNose(p);
    const inArt = (p: Point) => p.x > f.art.x0 + 4 && p.x < f.art.x1 - 4 && p.y > f.art.y0 + 4 && p.y < f.art.y1 - 4;
    /** The readout's band, in the visor's v, for lines of `size` (lowest and highest v). */
    const band = (lines: number, size: number) => ({ v0: -f.barH + margin, v1: -f.barH + margin + size * (1 + lead * (lines - 1)) });
    /** The longest run of the visor along u where the whole band shows (inside the visor, clear of the nose, on the art). */
    const longestRun = (v0: number, v1: number) => {
      let best = { lo: 0, hi: 0 }, from: number | undefined;
      for (let u = -600; u <= 601; u += 1) {
        const shows = u <= 600 && [0, 0.25, 0.5, 0.75, 1].every(k => { const q = f.toPage(u, v0 + (v1 - v0) * k); return inArt(q) && inVisor(q); });
        if (shows) from ??= u;
        else if (from !== undefined) { if (u - 1 - from > best.hi - best.lo) best = { lo: from, hi: u - 1 }; from = undefined; }
      }
      return best;
    };
    // One line, or two split at the word nearest the middle, whichever lets the letters stand taller.
    const words = text.split(' ');
    const layouts: string[][] = [[text]];
    if (words.length > 1) {
      let split = 1, worst = Infinity;
      for (let i = 1; i < words.length; i++) {
        const w = Math.max(measureStrokeText(words.slice(0, i).join(' '), { face, height: 1 }), measureStrokeText(words.slice(i).join(' '), { face, height: 1 }));
        if (w < worst) { worst = w; split = i; }
      }
      layouts.push([words.slice(0, split).join(' '), words.slice(split).join(' ')]);
    }
    let pick: { lines: string[]; size: number; run: { lo: number; hi: number } } | undefined;
    for (const lines of layouts) {
      const tallest = Math.min(h, (f.barH - 2 * margin) / (1 + lead * (lines.length - 1)), f.barH * 0.3);
      const { v0, v1 } = band(lines.length, tallest);
      const run = longestRun(v0, v1);
      // The block's width at `size`: its widest line, and the cursor after the last line.
      const widthAt = (size: number) => Math.max(...lines.map((l, i) => measureStrokeText(l, { face, height: size }) + (i === lines.length - 1 ? size * 1.2 : 0)));
      let size = tallest;
      while (size > 2.2 && widthAt(size) > run.hi - run.lo - 4) size -= 0.1;
      if (widthAt(size) > run.hi - run.lo - 4) continue;
      if (!pick || size > pick.size + 0.05) pick = { lines, size, run };
    }
    if (pick) {
      const { lines, size, run } = pick;
      const style = { face, height: size };
      const widths = lines.map(l => measureStrokeText(l, style));
      const width = Math.max(...widths.map((w, i) => w + (i === lines.length - 1 ? size * 1.2 : 0)));
      const { v0, v1 } = band(lines.length, size);
      // The block's top-left on the page: centred on the run; its top is the band's edge the glyphs' tops face.
      const uStart = (run.lo + run.hi) / 2 - s * width / 2;
      const origin = f.toPage(uStart, downIsLower ? v1 : v0);
      const step = size * lead;
      // Lines stack down the block, read in order.
      const glyphs = lines.flatMap((l, i) => strokeText(l, 0, i * step, style));
      // The block cursor after the last line, hatched solid.
      const last = lines.length - 1, cx0 = widths[last] + size * 0.5, block: Point[][] = [];
      for (let x = 0; x <= size * 0.7; x += 0.35) block.push([{ x: cx0 + x, y: last * step }, { x: cx0 + x, y: last * step + size }]);
      // A rule along the readout, on the side toward the visor's middle.
      const blockH = last * step + size;
      const ruleY = downIsLower ? -size * 0.45 : blockH + size * 0.45;
      const rule = [[{ x: -size, y: ruleY }, { x: width + size, y: ruleY }]];
      out.gold.push(...clipped(place2d([...glyphs, ...block, ...rule], origin, along), inVisor));
      // The screen: the readout's band, from the rule past the letters' foot.
      out.clearGold.push(...place2d(box(-size, Math.min(ruleY, 0) - 0.8, width + size, Math.max(ruleY, blockH) + 0.8), origin, along));
    }
  }

  if (place === 'rise' || place === 'both') {
    // Up the page from a column's top: along the visor's v, reading upward.
    const len = Math.hypot(up.x, up.y), along = { x: up.x / len, y: up.y / len };
    // The slogan's run at height 1, with the drift its letters gather as they come apart (about a quarter of a letter
    // height per letter at full decay): its length scales with the letter height.
    const perMm = measureStrokeText(text, { face, height: 1 }) + decay * 0.25 * [...text].length;
    const inArt = (p: Point) => p.x > f.art.x0 + 2 && p.x < f.art.x1 - 2 && p.y > f.art.y0 + 2 && p.y < f.art.y1 - 2;
    // The rise column with the most air above it, back from the face, whose slogan fits up to the art's edge.
    let best: { c: Cell; room: number } | undefined;
    for (const c of f.cells) {
      if (c.kind !== 'rise' || (noseU - (c.u0 + c.u1) / 2) * faceSide < 20) continue;
      const u = (c.u0 + c.u1) / 2;
      let room = 0;
      while (room < 400 && inArt(f.toPage(u, c.v1 + 4 + room)) && inArt(f.toPage(u + h, c.v1 + 4 + room)) && inArt(f.toPage(u - h, c.v1 + 4 + room))) room += 1;
      if (room >= 30 && (!best || room > best.room)) best = { c, room };
    }
    if (best) {
      // As tall as asked, or smaller so the whole slogan rises within the art.
      const hs = Math.max(3, Math.min(h, best.room / perMm));
      const style = { face, height: hs };
      const u = (best.c.u0 + best.c.u1) / 2;
      // The glyphs' down is `along` turned a quarter clockwise: the text box sits centred on the column's middle.
      const down = { x: -along.y, y: along.x };
      const base = f.toPage(u, best.c.v1 + 4);
      const origin = { x: base.x - down.x * hs / 2, y: base.y - down.y * hs / 2 };
      const chars = [...text], letters: Point[][] = [];
      let drift = 0;
      chars.forEach((ch, i) => {
        if (ch === ' ') return;
        const t = chars.length > 1 ? i / (chars.length - 1) : 0;
        // Fixed draws per letter, so one letter's fate never shifts the next one's.
        const gone = rng(), side = rng() * 2 - 1, gap = rng(), dotSeed = rng();
        drift += decay * t * gap * hs * 0.9;
        if (gone < decay * 0.7 * t ** 1.6) return;
        const x = measureStrokeText(text.slice(0, i + 1), style) - measureStrokeText(ch, style) + drift;
        const dots = ctx.random(`erasure-slogan-${i}-${Math.floor(dotSeed * 1e6)}`);
        const glyph = strokeText(ch, x, side * decay * t * hs * 0.6, style).filter(() => dots() >= decay * t * 0.55);
        letters.push(...glyph);
        if (glyph.length) out.clearBlack.push(...place2d(box(x - 0.7, side * decay * t * hs * 0.6 - 0.7, x + measureStrokeText(ch, style) + 0.7, side * decay * t * hs * 0.6 + hs + 0.7), origin, along));
      });
      const onWindow = (p: Point) => f.window.some(r => insideRing(r, p));
      out.black.push(...clipped(place2d(letters, origin, along), p => inArt(p) && !onWindow(p)));
    }
  }
  return out;
}
