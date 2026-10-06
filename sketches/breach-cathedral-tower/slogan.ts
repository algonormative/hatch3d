import * as THREE from 'three';
import type { Control, Point, SketchContext } from '../../src/sketch/types.ts';
import type { ProjectedPoint } from '../../src/projection.ts';
import type { PackedDepthBuffer } from '../../src/sketch/depth-buffer.ts';
import { splitPolylineByDepth } from '../../src/occlusion.ts';
import { measureStrokeText, roughMargin, strokeFaceSupports, strokeText } from '../../src/sketch/stroke-text.ts';

/**
 * Slogans painted on slab front faces, shared by Breach Cathedral and its Tower fork.
 * Text is laid out in a slab's local face plane, so the ordinary camera projection maps it
 * onto the face and the ordinary depth pass hides it behind anything in front.
 */
export const SLOGAN_DEFAULT = 'this was made by a machine';
/** Lettering gets its own finer pen and layer, so it can be plotted last or with a fineliner. */
export const LETTERING_PEN = { id: 'lettering', color: '#22282c', width: 0.13 };
const PENS = ['lettering', 'carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
export type LetterFace = 'cathedral' | 'sans' | 'script';
const FACES: LetterFace[] = ['cathedral', 'sans', 'script'];
const FACE_LABELS = { cathedral: 'Breach Cathedral', sans: 'Hershey sans', script: 'Hershey script' };
export const TITLE_DEFAULT = 'Breach Cathedral v1';

function letterFace(v: unknown): LetterFace {
  return FACES.includes(v as LetterFace) ? v as LetterFace : 'cathedral';
}

/** Printable text for a face: characters it cannot draw become spaces rather than render errors. */
function cleanText(raw: string, face: LetterFace): string {
  return [...raw].map(c => strokeFaceSupports(c, face) ? c : ' ').join('').replace(/\s+/g, ' ').trim();
}

export function sloganControls(count: number): Control[] {
  const g = 'Slogan';
  return [
    { type: 'text', id: 'slogan', label: 'Slogan', default: SLOGAN_DEFAULT, maxLength: 64, group: g },
    { type: 'slider', id: 'sloganCount', label: 'Slogan count', default: count, min: 0, max: 3, step: 1, group: g },
    { type: 'toggle', id: 'sloganSpread', label: 'Spread words over the structure', default: true, group: g },
    { type: 'select', id: 'sloganFace', label: 'Slogan face', default: 'cathedral', options: FACES, optionLabels: FACE_LABELS, group: g },
    { type: 'slider', id: 'sloganSize', label: 'Slogan cap height', default: 2.2, min: 1.6, max: 3, step: 0.05, units: 'mm', group: g },
    { type: 'select', id: 'sloganPlacement', label: 'Slogan placement', default: 'face', options: ['face', 'edge'],
      optionLabels: { face: 'Painted face', edge: 'Top-edge caption' }, group: g },
    { type: 'select', id: 'sloganPen', label: 'Slogan pen', default: 'lettering', options: PENS, group: g },
    { type: 'slider', id: 'sloganRough', label: 'Slogan scratch', default: 0, min: 0, max: 1, step: 0.01, group: g },
  ];
}

/** The print's title line, set whole on one intact face; the finalizer fills in edition and hash. */
export function titleControls(): Control[] {
  const g = 'Title';
  const on = { control: 'titleEnabled', equals: true } as const;
  return [
    { type: 'toggle', id: 'titleEnabled', label: 'Title on the structure', default: false, group: g },
    { type: 'text', id: 'title', label: 'Title', default: TITLE_DEFAULT, maxLength: 64, group: g, showWhen: on },
    { type: 'slider', id: 'titleSize', label: 'Title cap height', default: 3, min: 1.6, max: 4.5, step: 0.05, units: 'mm', group: g, showWhen: on },
    { type: 'select', id: 'titleFace', label: 'Title face', default: 'cathedral', options: FACES, optionLabels: FACE_LABELS, group: g, showWhen: on },
    { type: 'slider', id: 'titleRough', label: 'Title scratch', default: 0, min: 0, max: 1, step: 0.01, group: g, showWhen: on },
  ];
}

export interface TitleSettings { enabled: boolean; text: string; size: number; face: LetterFace; rough: number }

export function titleSettings(ctx: SketchContext): TitleSettings {
  const p = ctx.params;
  const face = letterFace(p.titleFace);
  const text = cleanText(typeof p.title === 'string' ? p.title : TITLE_DEFAULT, face);
  const size = typeof p.titleSize === 'number' && Number.isFinite(p.titleSize) ? Math.max(1.6, Math.min(4.5, p.titleSize)) : 3;
  return { enabled: p.titleEnabled === true && text.length > 0, text, size, face, rough: unit(p.titleRough) };
}

export interface SloganSettings {
  text: string; count: number; spread: boolean; face: LetterFace; size: number;
  placement: 'face' | 'edge'; pen: string; rough: number;
}

/** A 0–1 control value; anything else is 0 (clean). */
function unit(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

export function sloganSettings(ctx: SketchContext): SloganSettings {
  const p = ctx.params;
  const num = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
  const face = letterFace(p.sloganFace);
  const text = cleanText(typeof p.slogan === 'string' ? p.slogan : SLOGAN_DEFAULT, face);
  return {
    text,
    count: text ? Math.round(num(p.sloganCount, 0, 0, 3)) : 0,
    spread: p.sloganSpread !== false,
    face,
    size: num(p.sloganSize, 2.2, 1.6, 3),
    placement: p.sloganPlacement === 'edge' ? 'edge' : 'face',
    pen: typeof p.sloganPen === 'string' && PENS.includes(p.sloganPen) ? p.sloganPen : 'lettering',
    rough: unit(p.sloganRough),
  };
}

/** A candidate box: its front face is the local z = +d/2 plane, x ∈ ±w/2, y ∈ ±h/2. */
export interface SloganSurface { id: number; matrix: THREE.Matrix4; w: number; h: number; d: number }

export interface SloganEnv {
  view: THREE.Camera; depth: PackedDepthBuffer; width: number; height: number;
  /** Final page millimetres per depth pixel (authored mm per pixel × poster scale). */
  mmPerPx: number;
  /** The art clip rectangle in depth pixels. */
  art: { x0: number; y0: number; x1: number; y1: number };
  bias: number;
}

export interface SloganPlan {
  /** World-space text strokes, ready for the shared projection and depth pass. */
  strokes: THREE.Vector3[][];
  /** Per surface id, convex knock-out quads in depth pixels: that slab's own hatch is cleared inside. */
  knockouts: Map<number, Point[][]>;
  placed: { id: number; text: string; sizeMm: number; visible: number; y: number }[];
  /** The title line's strokes (always the fine lettering pen) and where it landed. */
  titleStrokes: THREE.Vector3[][];
  title?: { id: number; text: string; sizeMm: number; visible: number; y: number };
}

type Placement = {
  surface: SloganSurface; text: string; sizeMm: number; strokes: THREE.Vector3[][]; band: Point[];
  visible: number; area: number; y: number;
};

const DESCENT = { cathedral: 0.4, sans: 0.36, script: 0.6 };
const ASCENT = { cathedral: 0.07, sans: 0.2, script: 0.2 };
const PAD_MM = 0.75, INSET_MM = 0.9, MIN_MM = 1.6;

function place(env: SloganEnv, s: SloganSurface, text: string, sizeMm: number, face: LetterFace,
  mode: 'face' | 'edge', align: number, offset: number, padMm = PAD_MM, rough = 0): Placement | null {
  const zf = s.d / 2 + 0.006;
  const px = (x: number, y: number, z = zf): ProjectedPoint => {
    const v = new THREE.Vector3(x, y, z).applyMatrix4(s.matrix).project(env.view);
    return { x: (v.x * 0.5 + 0.5) * env.width, y: (-v.y * 0.5 + 0.5) * env.height, depth: v.z * 0.5 + 0.5 };
  };
  const dist = (a: ProjectedPoint, b: ProjectedPoint) => Math.hypot(a.x - b.x, a.y - b.y) * env.mmPerPx;
  const sy = dist(px(0, -s.h / 2), px(0, s.h / 2)) / s.h;
  const sx = dist(px(-s.w / 2, 0), px(s.w / 2, 0)) / s.w;
  if (!(sx > 0 && sy > 0)) return null;
  const insetX = INSET_MM / sx, insetY = INSET_MM / sy;
  for (let size = sizeMm; size >= MIN_MM - 1e-9; size -= 0.2) {
    const cap = size / sy;
    // Scratched marks wander past the clean glyph box; the band grows to keep them on clean concrete.
    const padX = padMm / sx + roughMargin(cap, rough), padY = padMm / sy + roughMargin(cap, rough);
    // The cathedral face leans forward: its tops overhang the measured advance by 0.1 cap.
    const width = measureStrokeText(text, { face, height: cap }) + (face === 'cathedral' ? 0.1 * cap : 0);
    const bandW = width + 2 * padX;
    const bandH = cap * (1 + DESCENT[face] + ASCENT[face]) + 2 * padY;
    const roomX = s.w - 2 * insetX - bandW, roomY = s.h - 2 * insetY - bandH;
    if (roomX < 0 || roomY < 0) continue;
    const bx0 = -s.w / 2 + insetX + roomX * align;
    const by1 = mode === 'edge' ? s.h / 2 - insetY : s.h / 2 - insetY - roomY * (0.5 + 0.35 * offset);
    // Edge captions sit in a full-width fascia strip; painted text gets a tight band.
    const band = mode === 'edge'
      ? [[-s.w / 2 + insetX, by1], [s.w / 2 - insetX, by1], [s.w / 2 - insetX, by1 - bandH], [-s.w / 2 + insetX, by1 - bandH]]
      : [[bx0, by1], [bx0 + bandW, by1], [bx0 + bandW, by1 - bandH], [bx0, by1 - bandH]];
    const capTop = by1 - padY - cap * ASCENT[face];
    const x0 = (mode === 'edge' ? -s.w / 2 + insetX + roomX * align : bx0) + padX;
    const zt = s.d / 2 + 0.009;
    const strokes = strokeText(text, 0, 0, { face, height: cap, rough, seed: s.id })
      .map(path => path.map(p => new THREE.Vector3(x0 + p.x, capTop - p.y, zt).applyMatrix4(s.matrix)));
    // Visibility: sample the band and ask the shared depth buffer.
    let seen = 0, total = 0;
    for (let r = 0; r < 4; r++) {
      const y = by1 - bandH * (r + 0.5) / 4;
      const row: ProjectedPoint[] = [];
      for (let c = 0; c < 16; c++) row.push(px(x0 - padX + bandW * (c + 0.5) / 16, y));
      total += row.length;
      for (const q of row) {
        if (q.x < env.art.x0 || q.x > env.art.x1 || q.y < env.art.y0 || q.y > env.art.y1) continue;
        if (splitPolylineByDepth([q, q], env.depth, env.bias).visible.length) seen++;
      }
    }
    const corners = band.map(([x, y]) => px(x, y, zt));
    const area = Math.abs(corners.reduce((sum, a, i) => {
      const b = corners[(i + 1) % corners.length];
      return sum + a.x * b.y - b.x * a.y;
    }, 0)) / 2;
    const centre = px(0, 0);
    return { surface: s, text, sizeMm: size, strokes, band: corners.map(c => ({ x: c.x, y: c.y })),
      visible: seen / total, area, y: centre.y };
  }
  return null;
}

/** Split a phrase into words, merging a short word into its neighbour now and then. */
function wordGroups(text: string, rng: () => number): string[] {
  const words = text.split(' ').filter(Boolean);
  const groups: string[] = [];
  for (const word of words) {
    const last = groups.at(-1);
    if (last !== undefined && (word.length <= 2 || last.length <= 1) && rng() < 0.45) groups[groups.length - 1] = `${last} ${word}`;
    else groups.push(word);
  }
  return groups;
}

export function planSlogans(ctx: SketchContext, surfaces: SloganSurface[], env: SloganEnv, salt = 'slogan'): SloganPlan {
  const settings = sloganSettings(ctx);
  const title = titleSettings(ctx);
  const plan: SloganPlan = { strokes: [], knockouts: new Map(), placed: [], titleStrokes: [] };
  if ((settings.count === 0 && !title.enabled) || surfaces.length === 0) return plan;
  const rng = ctx.random(salt);
  const used = new Set<number>();
  const commit = (p: Placement) => {
    used.add(p.surface.id);
    plan.strokes.push(...p.strokes);
    plan.knockouts.set(p.surface.id, [...(plan.knockouts.get(p.surface.id) ?? []), p.band]);
    plan.placed.push({ id: p.surface.id, text: p.text, sizeMm: p.sizeMm, visible: p.visible, y: p.y });
  };
  const best = (text: string, size: number, minVisible: number, accept: (p: Placement) => boolean, flip: boolean): Placement | null => {
    let choice: Placement | null = null, score = -Infinity;
    for (const s of surfaces) {
      if (used.has(s.id)) continue;
      const mode = flip ? (settings.placement === 'face' ? 'edge' : 'face') : settings.placement;
      const p = place(env, s, text, size, settings.face, mode, rng(), rng() - 0.5, PAD_MM, settings.rough);
      if (!p || p.visible < minVisible || !accept(p)) continue;
      const value = p.visible ** 3 * Math.sqrt(p.area) * (0.55 + 0.9 * rng());
      if (value > score) { score = value; choice = p; }
    }
    return choice;
  };
  const sizes = [1, 0.74, 0.86];
  let echoes = settings.count;
  if (settings.spread && settings.count > 0) {
    // One phrase scattered top to bottom so it reads in order once found.
    for (let attempt = 0; attempt < 4; attempt++) {
      let groups = wordGroups(settings.text, rng);
      for (let m = 0; m < attempt; m++) {
        if (groups.length < 2) break;
        let k = 0;
        for (let i = 1; i < groups.length - 1; i++) if (groups[i].length + groups[i + 1].length < groups[k].length + groups[k + 1].length) k = i;
        groups = [...groups.slice(0, k), `${groups[k]} ${groups[k + 1]}`, ...groups.slice(k + 2)];
      }
      const ys = surfaces.map(s => new THREE.Vector3().applyMatrix4(s.matrix).project(env.view))
        .map(v => (-v.y * 0.5 + 0.5) * env.height).filter(y => y >= env.art.y0 && y <= env.art.y1);
      const top = Math.min(...ys), span = Math.max(...ys) - top;
      const chosen: Placement[] = [];
      let prev = -Infinity;
      for (let i = 0; i < groups.length; i++) {
        const size = settings.size * (0.78 + 0.5 * rng());
        // Each word owns roughly its share of the height, so the phrase spreads top to bottom.
        const lo = top + span * (i - 0.25) / groups.length, hi = top + span * (i + 1.25) / groups.length;
        const gap = env.height * 0.035;
        const flip = rng() < 0.3;
        const pick = best(groups[i], size, 0.82, p => p.y > Math.max(prev + gap, lo) && p.y <= hi, flip)
          ?? best(groups[i], size, 0.82, p => p.y > prev + gap && p.y <= hi, flip)
          ?? best(groups[i], size, 0.82, p => p.y > prev + gap, flip);
        if (!pick) break;
        chosen.push(pick);
        used.add(pick.surface.id);
        prev = pick.y;
      }
      for (const p of chosen) used.delete(p.surface.id);
      if (chosen.length === groups.length) { chosen.forEach(commit); break; }
    }
    echoes -= 1;
  }
  // Whole-phrase placements (or small echoes of the spread phrase).
  for (let k = 0; k < echoes; k++) {
    const size = settings.size * (settings.spread ? 0.8 : sizes[k]);
    const far = (p: Placement) => plan.placed.every(q => Math.abs(q.y - p.y) > env.height * (settings.spread ? 0.05 : 0.14));
    const pick = best(settings.text, size, 0.9, far, false);
    if (pick) commit(pick);
  }
  if (title.enabled) {
    // The title takes its own stream, so turning it on never moves a slogan word.
    const trng = ctx.random(`${salt}-title`);
    const span = Math.max(1, env.art.y1 - env.art.y0);
    let choice: Placement | null = null, score = -Infinity;
    for (const s of surfaces) {
      if (used.has(s.id)) continue;
      // A wider clear margin than slogan words: the title should never brush the hatch.
      const p = place(env, s, title.text, title.size, title.face, 'face', 0.08 + 0.3 * trng(), 0, 1.2 - 0.5 * title.rough, title.rough);
      if (!p || p.visible < 0.92) continue;
      // Prefer low, large, clear faces: the title reads like a foundation stone.
      const low = Math.max(0, Math.min(1, (p.y - env.art.y0) / span));
      const value = p.visible ** 3 * Math.sqrt(p.area) * (p.sizeMm / title.size) ** 2 * (0.3 + 0.7 * low) * (0.85 + 0.3 * trng());
      if (value > score) { score = value; choice = p; }
    }
    if (choice) {
      used.add(choice.surface.id);
      plan.titleStrokes.push(...choice.strokes);
      plan.knockouts.set(choice.surface.id, [...(plan.knockouts.get(choice.surface.id) ?? []), choice.band]);
      plan.title = { id: choice.surface.id, text: choice.text, sizeMm: choice.sizeMm, visible: choice.visible, y: choice.y };
    }
  }
  return plan;
}

/** Remove the parts of a projected polyline inside convex quads (Cyrus–Beck per segment). */
export function knockOut(points: ProjectedPoint[], quads: Point[][]): ProjectedPoint[][] {
  let runs = [points];
  for (const quad of quads) {
    const area = quad.reduce((s, a, i) => { const b = quad[(i + 1) % quad.length]; return s + a.x * b.y - b.x * a.y; }, 0);
    const sign = area > 0 ? 1 : -1;
    const next: ProjectedPoint[][] = [];
    for (const run of runs) {
      let current: ProjectedPoint[] = [];
      const flush = () => { if (current.length >= 2) next.push(current); current = []; };
      const lerp = (a: ProjectedPoint, b: ProjectedPoint, t: number): ProjectedPoint =>
        ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, depth: a.depth + (b.depth - a.depth) * t });
      for (let i = 1; i < run.length; i++) {
        const a = run[i - 1], b = run[i];
        let enter = 0, exit = 1;
        for (let e = 0; e < quad.length && enter <= exit; e++) {
          const p = quad[e], q = quad[(e + 1) % quad.length];
          // Inside when the cross product has the polygon's winding sign.
          const fa = sign * ((q.x - p.x) * (a.y - p.y) - (q.y - p.y) * (a.x - p.x));
          const fb = sign * ((q.x - p.x) * (b.y - p.y) - (q.y - p.y) * (b.x - p.x));
          if (fa < 0 && fb < 0) { enter = 1; exit = 0; break; }
          if (fa < 0) enter = Math.max(enter, fa / (fa - fb));
          else if (fb < 0) exit = Math.min(exit, fa / (fa - fb));
        }
        if (!current.length) current.push(a);
        if (enter >= exit || enter >= 1 || exit <= 0) { current.push(b); continue; }
        if (enter > 0) current.push(lerp(a, b, enter));
        flush();
        if (exit < 1) { current.push(lerp(a, b, exit), b); }
      }
      flush();
    }
    runs = next;
  }
  return runs;
}

/**
 * Knock a slab's own strokes out of its slogan bands, dropping the short ticks a cut leaves
 * behind (under `minMm` on the page) so the band edge reads clean. Uncut strokes pass through.
 */
export function clearBands(points: ProjectedPoint[], quads: Point[][], mmPerPx: number, minMm = 2.5): ProjectedPoint[][] {
  const length = (run: ProjectedPoint[]) => {
    let total = 0;
    for (let i = 1; i < run.length; i++) total += Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y);
    return total * mmPerPx;
  };
  const pieces = knockOut(points, quads);
  const before = length(points);
  const after = pieces.reduce((sum, run) => sum + length(run), 0);
  if (pieces.length === 1 && Math.abs(before - after) < 1e-9) return [points];
  return pieces.filter(run => length(run) >= minMm);
}
