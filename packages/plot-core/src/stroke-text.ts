import type { Point } from './types.js';

/** Pure plotted geometry: no SVG text element or external font dependency. */
export type StrokeFace = 'wire' | 'matrix';

// The original Phase Garden 4 × 6 open-stroke alphabet, kept byte-for-byte in shape.
const WIRE: Record<string, string> = {
  A:'0,6 0,2 2,0 4,2 4,6|0,4 4,4', B:'0,6 0,0 3,0 4,1 4,2 3,3 0,3|3,3 4,4 4,5 3,6 0,6',
  C:'4,0 1,0 0,1 0,5 1,6 4,6', D:'0,6 0,0 2,0 4,2 4,4 2,6 0,6', E:'4,0 0,0 0,6 4,6|0,3 3,3',
  F:'0,6 0,0 4,0|0,3 3,3', G:'4,0 1,0 0,1 0,5 1,6 4,6 4,3 2,3', H:'0,0 0,6|4,0 4,6|0,3 4,3',
  I:'0,0 4,0|2,0 2,6|0,6 4,6', J:'4,0 4,5 3,6 1,6 0,5', K:'0,0 0,6|4,0 0,3 4,6', L:'0,0 0,6 4,6',
  M:'0,6 0,0 2,3 4,0 4,6', N:'0,6 0,0 4,6 4,0', O:'1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0',
  P:'0,6 0,0 3,0 4,1 4,2 3,3 0,3', Q:'1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|2,4 4,6',
  R:'0,6 0,0 3,0 4,1 4,2 3,3 0,3|2,3 4,6', S:'4,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 0,6',
  T:'0,0 4,0|2,0 2,6', U:'0,0 0,5 1,6 3,6 4,5 4,0', V:'0,0 2,6 4,0', W:'0,0 0,6 2,3 4,6 4,0',
  X:'0,0 4,6|4,0 0,6', Y:'0,0 2,3 4,0|2,3 2,6', Z:'0,0 4,0 0,6 4,6',
  '0':'1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|1,5 3,1', '1':'1,1 2,0 2,6|0,6 4,6',
  '2':'0,1 1,0 3,0 4,1 4,2 0,6 4,6', '3':'0,0 3,0 4,1 4,2 2,3 4,4 4,5 3,6 0,6',
  '4':'3,6 3,0 0,4 4,4', '5':'4,0 0,0 0,3 3,3 4,4 4,5 3,6 0,6',
  '6':'4,0 1,0 0,1 0,5 1,6 3,6 4,5 4,4 3,3 0,3', '7':'0,0 4,0 1,6',
  '8':'1,0 3,0 4,1 4,2 3,3 1,3 0,2 0,1 1,0|1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3',
  '9':'4,3 1,3 0,2 0,1 1,0 3,0 4,1 4,5 3,6 0,6', '-':'0,3 4,3', '/':'0,6 4,0', '.':'2,5.5 2,6',
  ':':'2,1.5 2,2|2,4.5 2,5', ',':'2,5 2,6 1,6.5', '!':'2,0 2,4|2,5.5 2,6',
  '?':'0,1 1,0 3,0 4,1 4,2 2,3 2,4|2,5.5 2,6', '+':'0,3 4,3|2,1 2,5',
  '&':'4,5 3,6 1,6 0,5 0,4 4,1 4,0 2,0 1,1 1,2 4,6',
  "'":'2,0 2,1.5', '(': '3,0 1,2 1,4 3,6', ')':'1,0 3,2 3,4 1,6',
};

// A second, deliberately different face: five-by-seven diamond cells.
const MATRIX: Record<string, string> = {
  A:'01110/10001/10001/11111/10001/10001/10001', B:'11110/10001/10001/11110/10001/10001/11110',
  C:'01111/10000/10000/10000/10000/10000/01111', D:'11110/10001/10001/10001/10001/10001/11110',
  E:'11111/10000/10000/11110/10000/10000/11111', F:'11111/10000/10000/11110/10000/10000/10000',
  G:'01111/10000/10000/10111/10001/10001/01111', H:'10001/10001/10001/11111/10001/10001/10001',
  I:'11111/00100/00100/00100/00100/00100/11111', J:'00111/00010/00010/00010/10010/10010/01100',
  K:'10001/10010/10100/11000/10100/10010/10001', L:'10000/10000/10000/10000/10000/10000/11111',
  M:'10001/11011/10101/10101/10001/10001/10001', N:'10001/11001/10101/10011/10001/10001/10001',
  O:'01110/10001/10001/10001/10001/10001/01110', P:'11110/10001/10001/11110/10000/10000/10000',
  Q:'01110/10001/10001/10001/10101/10010/01101', R:'11110/10001/10001/11110/10100/10010/10001',
  S:'01111/10000/10000/01110/00001/00001/11110', T:'11111/00100/00100/00100/00100/00100/00100',
  U:'10001/10001/10001/10001/10001/10001/01110', V:'10001/10001/10001/10001/10001/01010/00100',
  W:'10001/10001/10001/10101/10101/10101/01010', X:'10001/10001/01010/00100/01010/10001/10001',
  Y:'10001/10001/01010/00100/00100/00100/00100', Z:'11111/00001/00010/00100/01000/10000/11111',
  '0':'01110/10011/10101/10101/11001/10001/01110', '1':'00100/01100/00100/00100/00100/00100/01110',
  '2':'01110/10001/00001/00010/00100/01000/11111', '3':'11110/00001/00001/01110/00001/00001/11110',
  '4':'00010/00110/01010/10010/11111/00010/00010', '5':'11111/10000/10000/11110/00001/00001/11110',
  '6':'01111/10000/10000/11110/10001/10001/01110', '7':'11111/00001/00010/00100/01000/01000/01000',
  '8':'01110/10001/10001/01110/10001/10001/01110', '9':'01110/10001/10001/01111/00001/00001/11110',
  '-':'00000/00000/00000/11111/00000/00000/00000', '/':'00001/00001/00010/00100/01000/10000/10000',
  '.':'00000/00000/00000/00000/00000/00110/00110', ':':'00000/00110/00110/00000/00110/00110/00000',
  ',':'00000/00000/00000/00000/00110/00110/00100', '!':'00100/00100/00100/00100/00100/00000/00100',
  '?':'01110/10001/00001/00010/00100/00000/00100', '+':'00000/00100/00100/11111/00100/00100/00000',
  '&':'01100/10010/10100/01000/10101/10010/01101', "'":'00100/00100/00000/00000/00000/00000/00000',
  '(':'00010/00100/01000/01000/01000/00100/00010', ')':'01000/00100/00010/00010/00010/00100/01000',
};

const wireGlyphs = new Map<string, Point[][]>();
const matrixGlyphs = new Map<string, Point[][]>();

function glyph(char: string, face: StrokeFace): Point[][] {
  const cache = face === 'wire' ? wireGlyphs : matrixGlyphs;
  const cached = cache.get(char);
  if (cached) return cached;
  let paths: Point[][];
  if (face === 'wire') {
    paths = WIRE[char].split('|').map(stroke => stroke.split(' ').map(pair => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    }));
  } else {
    paths = [];
    MATRIX[char].split('/').forEach((row, y) => [...row].forEach((bit, x) => {
      if (bit === '1') paths.push([
        { x: x + 0.5, y: y + 0.08 }, { x: x + 0.92, y: y + 0.5 },
        { x: x + 0.5, y: y + 0.92 }, { x: x + 0.08, y: y + 0.5 },
        { x: x + 0.5, y: y + 0.08 },
      ]);
    }));
  }
  cache.set(char, paths);
  return paths;
}

function validated(text: string, face: StrokeFace): string[] {
  if (typeof text !== 'string') throw new TypeError('Text must be a string');
  if (face !== 'wire' && face !== 'matrix') throw new RangeError(`Unknown stroke face: ${String(face)}`);
  if ([...text].length > 256) throw new RangeError('Stroke text exceeds 256 characters');
  const chars = [...text.toUpperCase()];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== ' ' && !(face === 'wire' ? WIRE : MATRIX)[chars[i]]) {
      throw new RangeError(`Unsupported stroke character U+${chars[i].codePointAt(0)!.toString(16).toUpperCase()} at position ${i + 1}`);
    }
  }
  return chars;
}

export interface TextStyle { face?: StrokeFace; height: number; tracking?: number }

function layout(text: string, style: TextStyle): { paths: Point[][]; width: number } {
  const face = style.face ?? 'wire';
  const chars = validated(text, face);
  if (!Number.isFinite(style.height) || style.height <= 0 || style.height > 1000) throw new RangeError('Text height must be positive and finite');
  const tracking = style.tracking ?? (face === 'wire' ? 1.8 : 1.2);
  if (!Number.isFinite(tracking) || tracking < 0 || tracking > 100) throw new RangeError('Text tracking must be finite and nonnegative');
  const unit = style.height / (face === 'wire' ? 6 : 7);
  const glyphWidth = face === 'wire' ? 4 : 5;
  const paths: Point[][] = [];
  let cursor = 0;
  chars.forEach((char, i) => {
    if (char !== ' ') for (const path of glyph(char, face)) {
      paths.push(path.map(p => ({ x: cursor + p.x * unit, y: p.y * unit })));
    }
    cursor += ((char === ' ' ? 3 : glyphWidth) + (i < chars.length - 1 ? tracking : 0)) * unit;
  });
  return { paths, width: cursor };
}

export function measureStrokeText(text: string, style: TextStyle): number { return layout(text, style).width; }

export function strokeText(text: string, x: number, y: number, style: TextStyle): Point[][] {
  if (![x, y].every(Number.isFinite)) throw new RangeError('Text origin must be finite');
  return layout(text, style).paths.map(path => path.map(p => ({ x: p.x + x, y: p.y + y })));
}

export interface PathTextStyle extends TextStyle {
  align?: 'start' | 'center' | 'end';
  normalOffset?: number;
}

/** Bend every stroke over the guide's arclength; glyph segments are sampled before mapping. */
export function strokeTextOnPath(text: string, guide: Point[], style: PathTextStyle): Point[][] {
  if (!Array.isArray(guide) || guide.length < 2 || guide.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    throw new RangeError('Text guide needs at least two finite points');
  }
  const segments: { from: Point; dx: number; dy: number; start: number; length: number }[] = [];
  let total = 0;
  for (let i = 1; i < guide.length; i++) {
    const from = guide[i - 1], to = guide[i];
    const dx = to.x - from.x, dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length > 1e-9) { segments.push({ from, dx, dy, start: total, length }); total += length; }
  }
  if (!Number.isFinite(total) || total <= 0) throw new RangeError('Text guide has no finite length');
  const rendered = layout(text, style);
  if (rendered.width > total + 1e-8) throw new RangeError(`Text width ${rendered.width.toFixed(2)} mm exceeds guide length ${total.toFixed(2)} mm`);
  const align = style.align ?? 'start';
  if (align !== 'start' && align !== 'center' && align !== 'end') throw new RangeError('Unknown text path alignment');
  const normalOffset = style.normalOffset ?? 0;
  if (!Number.isFinite(normalOffset)) throw new RangeError('Text path offset must be finite');
  const lead = align === 'center' ? (total - rendered.width) / 2 : align === 'end' ? total - rendered.width : 0;
  const sample = (distance: number): { point: Point; tangent: Point } => {
    const d = Math.max(0, Math.min(total, distance));
    const segment = segments.find(s => d <= s.start + s.length) ?? segments.at(-1)!;
    const t = (d - segment.start) / segment.length;
    return { point: { x: segment.from.x + t * segment.dx, y: segment.from.y + t * segment.dy },
      tangent: { x: segment.dx / segment.length, y: segment.dy / segment.length } };
  };
  const spacing = Math.max(0.3, Math.min(1.5, style.height / 5));
  return rendered.paths.map(path => {
    const sampled: Point[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const steps = Math.max(1, Math.ceil(Math.abs(b.x - a.x) / spacing));
      for (let j = 0; j < steps; j++) {
        const t = j / steps;
        const local = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const { point, tangent } = sample(lead + local.x);
        const normal = local.y + normalOffset;
        sampled.push({ x: point.x - tangent.y * normal, y: point.y + tangent.x * normal });
      }
    }
    const last = path.at(-1)!;
    const { point, tangent } = sample(lead + last.x);
    sampled.push({ x: point.x - tangent.y * (last.y + normalOffset), y: point.y + tangent.x * (last.y + normalOffset) });
    return sampled;
  });
}
