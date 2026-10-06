import type { Point } from './types.js';
import { HERSHEY_BASELINE, HERSHEY_CAP_TOP, HERSHEY_OFFSET, HERSHEY_SANS, HERSHEY_SCRIPT } from './hershey-data.js';

/**
 * Pure plotted geometry: no SVG text element or external font dependency.
 * `wire` and `matrix` are uppercase display faces; `sans` and `script` are thin
 * single-stroke Hershey faces with lowercase, covering printable ASCII 32–126.
 */
export type StrokeFace = 'wire' | 'matrix' | 'sans' | 'script' | 'cathedral';
type HersheyFace = 'sans' | 'script';
const isHershey = (face: StrokeFace): face is HersheyFace => face === 'sans' || face === 'script';

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

type HersheyGlyph = { left: number; right: number; paths: Point[][] };
const hersheyGlyphs: Record<HersheyFace, Map<string, HersheyGlyph>> = { sans: new Map(), script: new Map() };

function hersheyGlyph(char: string, face: HersheyFace): HersheyGlyph | undefined {
  const code = char.codePointAt(0)!;
  if (char.length !== 1 || code < 32 || code > 126) return undefined;
  const cache = hersheyGlyphs[face];
  const cached = cache.get(char);
  if (cached) return cached;
  const row = (face === 'sans' ? HERSHEY_SANS : HERSHEY_SCRIPT)[code - 32];
  const value = (i: number) => row.charCodeAt(i) - HERSHEY_OFFSET;
  const left = value(0);
  const paths = row.length > 2 ? row.slice(2).split(' ').map(stroke => {
    const points: Point[] = [];
    // Glyph-local units: x from the left bearing, y from the cap top downward.
    for (let i = 0; i < stroke.length; i += 2) {
      points.push({ x: stroke.charCodeAt(i) - HERSHEY_OFFSET - left, y: stroke.charCodeAt(i + 1) - HERSHEY_OFFSET - HERSHEY_CAP_TOP });
    }
    return points;
  }) : [];
  const glyph = { left, right: value(1), paths };
  cache.set(char, glyph);
  return glyph;
}

/**
 * "Breach Cathedral": a monoline face drawn in the architecture's own line language —
 * straight segments only, chamfered corners for bowls, condensed, with a slight forward lean
 * applied at layout. Grid units: cap top y = 0, x-height y = 2.5, baseline y = 8, descender y = 11;
 * one unit is 1/8 of the cap height. Advance = rightmost x + tracking (default 2.3 units). Bowls take a heavy
 * chamfer at the top-left and bottom-right and stay square at the other two corners, like a bevelled
 * slab seen from below.
 */
const CATHEDRAL: Record<string, string> = {
  A:'0,8 0,2 1.5,0 2.5,0 4,2 4,8|0,4.5 4,4.5', B:'0,8 0,0 3,0 4,1 4,3 3,4 0,4|3,4 4,5 4,6.5 2.5,8 0,8',
  C:'4,0 1.5,0 0,1.5 0,8 2.5,8 4,6.5', D:'0,8 0,0 2.5,0 4,1.5 4,6.5 2.5,8 0,8',
  E:'4,0 0,0 0,8 4,8|0,4 3,4', F:'4,0 0,0 0,8|0,4 3,4', G:'4,0 1.5,0 0,1.5 0,8 2.5,8 4,6.5 4,4.5 2.2,4.5',
  H:'0,0 0,8|4,0 4,8|0,4 4,4', I:'0,0 2,0|1,0 1,8|0,8 2,8', J:'4,0 4,6.5 2.5,8 0,8 0,6',
  K:'0,0 0,8|4,0 0,5|1.6,3 4,8', L:'0,0 0,8 3.5,8', M:'0,8 0,0 2.5,4.5 5,0 5,8', N:'0,8 0,0 4,8 4,0',
  O:'1.5,0 4,0 4,6.5 2.5,8 0,8 0,1.5 1.5,0', P:'0,8 0,0 3,0 4,1 4,3.5 3,4.5 0,4.5',
  Q:'1.5,0 4,0 4,6.5 2.5,8 0,8 0,1.5 1.5,0|2.6,6.2 4.4,8.8', R:'0,8 0,0 3,0 4,1 4,3.5 3,4.5 0,4.5|3,4.5 4,8',
  S:'4,0 1.5,0 0,1.5 0,4 4,4 4,6.5 2.5,8 0,8', T:'0,0 4,0|2,0 2,8', U:'0,0 0,8 2.5,8 4,6.5 4,0',
  V:'0,0 2,8 4,0', W:'0,0 1,8 2.5,3 4,8 5,0', X:'0,0 4,8|4,0 0,8', Y:'0,0 2,4 4,0|2,4 2,8', Z:'0,0 4,0 0,8 4,8',
  a:'0.5,3 3.5,3 3.5,8|3.5,5.5 1.2,5.5 0,6.7 0,8 3.5,8', b:'0,0 0,8 2.3,8 3.5,6.8 3.5,3 0,3',
  c:'3.5,3 1.2,3 0,4.2 0,8 3.5,8', d:'3.5,0 3.5,8 0,8 0,4.2 1.2,3 3.5,3',
  e:'0,5.5 3.5,5.5 3.5,3 1.2,3 0,4.2 0,8 3.5,8', f:'3,0 2.2,0 1,1.2 1,8|0,3 3,3',
  g:'3.5,3 3.5,9.8 2.3,11 0.3,11|3.5,8 0,8 0,4.2 1.2,3 3.5,3', h:'0,0 0,8|0,4.2 1.2,3 3.5,3 3.5,8',
  i:'0,3 0,8|0,0.8 0,1.8', j:'1.5,3 1.5,9.8 0.3,11 0,11|1.5,0.8 1.5,1.8', k:'0,0 0,8|3.5,3 0,6|1.4,4.8 3.5,8',
  l:'0,0 0,7 1,8', m:'0,8 0,4.2 1.2,3 5.5,3 5.5,8|2.75,3 2.75,8',
  n:'0,8 0,4.2 1.2,3 3.5,3 3.5,8', o:'1.2,3 3.5,3 3.5,6.8 2.3,8 0,8 0,4.2 1.2,3',
  p:'0,3 0,11|0,3 3.5,3 3.5,6.8 2.3,8 0,8', q:'3.5,3 3.5,11|3.5,3 1.2,3 0,4.2 0,8 3.5,8',
  r:'0,3 0,8|0,4.2 1.2,3 3,3', s:'3.5,3 1.2,3 0,4.2 0,5.5 3.5,5.5 3.5,6.8 2.3,8 0,8',
  t:'1,0.5 1,8 3,8|0,3 3,3', u:'0,3 0,8 2.3,8 3.5,6.8|3.5,3 3.5,8', v:'0,3 1.75,8 3.5,3',
  w:'0,3 1,8 2.5,4.5 4,8 5,3', x:'0,3 3.5,8|3.5,3 0,8', y:'0,3 0,8 2.3,8 3.5,6.8|3.5,3 3.5,9.8 2.3,11 0.3,11',
  z:'0,3 3.5,3 0,8 3.5,8',
  '0':'1.5,0 3.5,0 3.5,6.5 2,8 0,8 0,1.5 1.5,0|1.1,5.4 2.4,2.6', '1':'0.5,1.5 2,0 2,8|0.5,8 3.5,8',
  '2':'0,1.5 1.5,0 4,0 4,3 0,7 0,8 4,8', '3':'0,0 4,0 4,3 3,4 1.5,4|3,4 4,5 4,6.5 2.5,8 0,8',
  '4':'3,8 3,0 0,5.5 4,5.5', '5':'4,0 0,0 0,3.5 2.5,3.5 4,5 4,6.5 2.5,8 0,8',
  '6':'4,0 1.5,0 0,1.5 0,8 2.5,8 4,6.5 4,4 0,4', '7':'0,0 4,0 4,1 1.5,8',
  '8':'1.5,0 4,0 4,3 3,4 1,4 0,3 0,1.5 1.5,0|1,4 0,5 0,8 2.5,8 4,6.5 4,5 3,4',
  '9':'4,4 0,4 0,1.5 1.5,0 4,0 4,6.5 2.5,8 0,8',
  '.':'0,7 0,8', ',':'0.6,7 0.6,8 0,9.4', ':':'0,3 0,4|0,7 0,8', ';':'0.6,3 0.6,4|0.6,7 0.6,8 0,9.4',
  "'":'0,0 0,2', '-':'0,5 2.5,5', '!':'0,0 0,5.5|0,7 0,8', '?':'0,1 1,0 3,0 4,1 4,2.5 2,4.5 2,5.5|2,7 2,8',
  '/':'0,8 3,0', '(':'1.5,-0.5 0,1 0,7 1.5,8.5', ')':'0,-0.5 1.5,1 1.5,7 0,8.5', '+':'0,4.5 4,4.5|2,2.5 2,6.5',
  '&':'4,8 0,3 0,1 1,0 2.5,0 3.5,1 3.5,2 0,5 0,8 2.5,8 4,6',
};
/** Every character the cathedral face draws (plus space). */
export const CATHEDRAL_CHARSET = Object.keys(CATHEDRAL).join('');
const CATHEDRAL_LEAN = 0.1; // forward lean: x shifts by 0.1 per unit of height above the baseline
const cathedralGlyphs = new Map<string, { paths: Point[][]; right: number }>();

/** One cathedral glyph in upright grid units (before the lean), or undefined when unsupported. */
export function cathedralGlyph(char: string): { paths: Point[][]; right: number } | undefined {
  const cached = cathedralGlyphs.get(char);
  if (cached) return cached;
  const source = CATHEDRAL[char];
  if (source === undefined) return undefined;
  // Lowercase is drawn on an x-height of 3 and opened up to 2.5 (69% of the cap) for small sizes;
  // ascenders compress to match, descenders stay put.
  const lower = char >= 'a' && char <= 'z';
  const paths = source.split('|').map(stroke => stroke.split(' ').map(pair => {
    const [x, y] = pair.split(',').map(Number);
    return { x, y: !lower || y > 8 ? y : y >= 3 ? 8 - (8 - y) * 1.1 : y * 2.5 / 3 };
  }));
  const glyph = { paths, right: Math.max(...paths.flat().map(p => p.x)) };
  cathedralGlyphs.set(char, glyph);
  return glyph;
}

/** True when `face` can draw every character of `text`. */
export function strokeFaceSupports(text: string, face: StrokeFace): boolean {
  try { validated(text, face); return true; } catch { return false; }
}

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
  if (face !== 'wire' && face !== 'matrix' && face !== 'cathedral' && !isHershey(face)) throw new RangeError(`Unknown stroke face: ${String(face)}`);
  if ([...text].length > 256) throw new RangeError('Stroke text exceeds 256 characters');
  if (face === 'cathedral') {
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] !== ' ' && !cathedralGlyph(chars[i])) {
        throw new RangeError(`Unsupported stroke character U+${chars[i].codePointAt(0)!.toString(16).toUpperCase()} at position ${i + 1}`);
      }
    }
    return chars;
  }
  if (isHershey(face)) {
    // Case-preserving: the Hershey faces carry their own lowercase.
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      if (!hersheyGlyph(chars[i], face)) {
        throw new RangeError(`Unsupported stroke character U+${chars[i].codePointAt(0)!.toString(16).toUpperCase()} at position ${i + 1}`);
      }
    }
    return chars;
  }
  const chars = [...text.toUpperCase()];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== ' ' && !(face === 'wire' ? WIRE : MATRIX)[chars[i]]) {
      throw new RangeError(`Unsupported stroke character U+${chars[i].codePointAt(0)!.toString(16).toUpperCase()} at position ${i + 1}`);
    }
  }
  return chars;
}

export interface TextStyle { face?: StrokeFace; height: number; tracking?: number }

/** Hershey layout: `height` is the cap height; tracking is extra space in cap-height units of 1/21. */
function hersheyLayout(chars: string[], face: HersheyFace, style: TextStyle): { paths: Point[][]; width: number } {
  const tracking = style.tracking ?? 0;
  if (!Number.isFinite(tracking) || tracking < 0 || tracking > 100) throw new RangeError('Text tracking must be finite and nonnegative');
  const unit = style.height / (HERSHEY_BASELINE - HERSHEY_CAP_TOP);
  const paths: Point[][] = [];
  let cursor = 0;
  chars.forEach((char, i) => {
    const glyph = hersheyGlyph(char, face)!;
    for (const path of glyph.paths) paths.push(path.map(p => ({ x: cursor + p.x * unit, y: p.y * unit })));
    cursor += (glyph.right - glyph.left + (i < chars.length - 1 ? tracking : 0)) * unit;
  });
  return { paths, width: cursor };
}

/** Cathedral layout: `height` is the cap height (8 grid units); tracking is in grid units. */
function cathedralLayout(chars: string[], style: TextStyle): { paths: Point[][]; width: number } {
  const tracking = style.tracking ?? 2.3;
  if (!Number.isFinite(tracking) || tracking < 0 || tracking > 100) throw new RangeError('Text tracking must be finite and nonnegative');
  const unit = style.height / 8;
  const paths: Point[][] = [];
  let cursor = 0;
  chars.forEach((char, i) => {
    const glyph = char === ' ' ? undefined : cathedralGlyph(char)!;
    if (glyph) for (const path of glyph.paths) {
      paths.push(path.map(p => ({ x: cursor + (p.x + (8 - p.y) * CATHEDRAL_LEAN) * unit, y: p.y * unit })));
    }
    cursor += ((glyph ? glyph.right : 1.4) + (i < chars.length - 1 ? tracking : 0)) * unit;
  });
  return { paths, width: cursor };
}

function layout(text: string, style: TextStyle): { paths: Point[][]; width: number } {
  const face = style.face ?? 'wire';
  const chars = validated(text, face);
  if (!Number.isFinite(style.height) || style.height <= 0 || style.height > 1000) throw new RangeError('Text height must be positive and finite');
  if (isHershey(face)) return hersheyLayout(chars, face, style);
  if (face === 'cathedral') return cathedralLayout(chars, style);
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
