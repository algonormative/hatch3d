import type { Control, Page, Part, Point, SketchContext } from '../../src/sketch/types.ts';
import { measureStrokeText, strokeText, strokeTextOnPath, type StrokeFace } from '../../src/sketch/stroke-text.ts';

/** 11 × 17 inch stock in millimeters; source art is authored on 297 × 420. */
export const TABLOID_PAGE: Page = { width: 279.4, height: 431.8, margin: 18, paper: '#f4f0e6' };
export const AUTHORED_ART = { x: 18, y: 76, width: 261, height: 281 } as const;
/** Tall envelope for full-height works: exactly the abstract target, so abstract art is authored in page millimetres. */
export const TALL_ART = { x: 18, y: 18, width: 243.4, height: 395.8 } as const;
export type Rect = { x: number; y: number; width: number; height: number };

export function posterControls(subtitle: string, edition: string): Control[] {
  const lettered = { control: 'posterMode', equals: 'lettered' } as const;
  return [
    { type: 'select', id: 'posterMode', label: 'Poster mode', default: 'lettered', options: ['lettered', 'abstract'], optionLabels: { lettered: 'Lettered poster', abstract: 'Fully abstract' }, group: 'Lettering' },
    { type: 'select', id: 'posterFace', label: 'Stroke face', default: 'wire', options: ['wire', 'matrix'], optionLabels: { wire: 'Architectural wire', matrix: 'Diamond matrix' }, group: 'Lettering', showWhen: lettered },
    { type: 'text', id: 'posterTitle', label: 'Title', default: 'PHASE GARDEN', maxLength: 48, group: 'Lettering', showWhen: lettered },
    { type: 'text', id: 'posterKicker', label: 'Header line', default: 'LIVE ELECTRONIC SYSTEMS', maxLength: 64, group: 'Lettering', showWhen: lettered },
    { type: 'text', id: 'posterSubtitle', label: 'Subtitle', default: subtitle, maxLength: 64, group: 'Lettering', showWhen: lettered },
    { type: 'text', id: 'posterFooter', label: 'Footer', default: `CONCERT STUDY / ${edition}`, maxLength: 80, group: 'Lettering', showWhen: lettered },
  ];
}

function fittedText(text: string, x: number, y: number, height: number, maxWidth: number, face: StrokeFace, tracking?: number): Point[][] {
  if (!text) return [];
  const base = { face, height, tracking };
  const width = measureStrokeText(text, base);
  return strokeText(text, x, y, { ...base, height: width > maxWidth ? height * maxWidth / width : height });
}

/** Preserve the original wire headline's mitered hollow lettering. */
function outline(paths: Point[][]): Point[][] {
  return paths.map(path => {
    const sides = [-1, 1].map(sign => path.map((p, i) => {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
      const before = i ? { x: p.x - a.x, y: p.y - a.y } : { x: b.x - p.x, y: b.y - p.y };
      const after = i < path.length - 1 ? { x: b.x - p.x, y: b.y - p.y } : before;
      const l0 = Math.hypot(before.x, before.y), l1 = Math.hypot(after.x, after.y);
      if (l0 < 1e-9 || l1 < 1e-9) return { ...p };
      const n0 = { x: -before.y / l0, y: before.x / l0 };
      const n1 = { x: -after.y / l1, y: after.x / l1 };
      const scale = sign * 0.34 / Math.max(0.35, 1 + n0.x * n1.x + n0.y * n1.y);
      return { x: p.x + (n0.x + n1.x) * scale, y: p.y + (n0.y + n1.y) * scale };
    }));
    const ring = [...sides[0], ...sides[1].reverse()];
    return [...ring, ring[0]];
  });
}

export interface LetteringOptions {
  page: Page;
  pen?: string;
  face?: StrokeFace;
  title: string;
  kicker: string;
  subtitle: string;
  footer: string;
  /** Optional arbitrary polyline for the headline; must carry its measured width. */
  titleGuide?: Point[];
}

export function concertLettering(options: LetteringOptions): Part[] {
  const { page, title, kicker, subtitle, footer } = options;
  const face = options.face ?? 'wire';
  const pen = options.pen ?? 'carbon';
  const margin = page.margin ?? 18;
  const left = margin + 1, right = page.width - margin - 1;
  const usable = right - left;
  const titlePaths = options.titleGuide
    ? strokeTextOnPath(title, options.titleGuide, { face, height: 22, align: 'center' })
    : fittedText(title, left, margin + 7, 23, usable, face, face === 'wire' ? 1.8 : undefined);
  const baseline = page.height - 52;
  return [
    { id: 'poster-title', pen, paths: face === 'wire' ? outline(titlePaths) : titlePaths },
    { id: 'poster-caption', pen, paths: [
      ...fittedText(kicker, left, 60, 3.2, usable, face),
      ...fittedText(subtitle, left, page.height - 42, 5, usable, face),
      ...fittedText(footer, left, page.height - 26, 3.2, usable - 18, face),
    ] },
    { id: 'poster-rules', pen, paths: [
      [{ x: left, y: 69 }, { x: right, y: 69 }],
      [{ x: left, y: baseline }, { x: right, y: baseline }],
      [{ x: right - 13, y: page.height - 26 }, { x: right, y: page.height - 26 }],
    ] },
  ];
}

export function posterArtTransform(ctx: SketchContext, page: Page, authored: Rect = AUTHORED_ART) {
  const margin = page.margin ?? 18;
  const abstract = ctx.params.posterMode === 'abstract';
  const target: Rect = abstract
    ? { x: margin, y: margin, width: page.width - 2 * margin, height: page.height - 2 * margin }
    : { x: margin, y: 76, width: page.width - 2 * margin, height: page.height - 136 };
  const scale = Math.min(target.width / authored.width, target.height / authored.height);
  const dx = target.x + (target.width - authored.width * scale) / 2 - authored.x * scale;
  const dy = target.y + (target.height - authored.height * scale) / 2 - authored.y * scale;
  return { target, scale, dx, dy, inverse: (p: Point): Point => ({ x: (p.x - dx) / scale, y: (p.y - dy) / scale }) };
}

function fitParts(parts: Part[], source: Rect, target: Rect): Part[] {
  if (![source.x, source.y, source.width, source.height, target.x, target.y, target.width, target.height].every(Number.isFinite)
    || source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) {
    throw new RangeError('Poster fit rectangles must be finite with positive size');
  }
  const scale = Math.min(target.width / source.width, target.height / source.height);
  const dx = target.x + (target.width - source.width * scale) / 2 - source.x * scale;
  const dy = target.y + (target.height - source.height * scale) / 2 - source.y * scale;
  const map = (p: Point): Point => ({ x: dx + p.x * scale, y: dy + p.y * scale });
  return parts.map(part => ({ ...part, paths: part.paths.map(path => path.map(map)),
    ...(part.boundary ? { boundary: part.boundary.map(path => path.map(map)) } : {}) }));
}

export interface ComposePosterOptions {
  page: Page;
  subtitle: string;
  edition: string;
  pen?: string;
  /** Authored art envelope; defaults to the original wide AUTHORED_ART. */
  authored?: Rect;
}

/** Fit the fixed authored envelope without cropping or stretching; abstract centers it in the full sheet interior. */
export function composePoster(ctx: SketchContext, art: Part[], options: ComposePosterOptions): Part[] {
  const page = options.page;
  const abstract = ctx.params.posterMode === 'abstract';
  const authored = options.authored ?? AUTHORED_ART;
  const mapped = fitParts(art, authored, posterArtTransform(ctx, page, authored).target);
  if (abstract) return mapped;
  return [
    ...concertLettering({
      page, pen: options.pen, subtitle: String(ctx.params.posterSubtitle ?? options.subtitle),
      title: String(ctx.params.posterTitle ?? 'PHASE GARDEN'),
      kicker: String(ctx.params.posterKicker ?? 'LIVE ELECTRONIC SYSTEMS'),
      footer: String(ctx.params.posterFooter ?? `CONCERT STUDY / ${options.edition}`),
      face: ctx.params.posterFace === 'matrix' ? 'matrix' : 'wire',
    }),
    ...mapped,
  ];
}
