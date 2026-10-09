/**
 * Print export for the Breach Tarot: each card (and a test chart) as a print-ready PNG for a print-on-demand
 * printer that takes images, starting with MakePlayingCards (MPC). Files only; nothing is uploaded or ordered.
 *
 *   npm run print-export -- [stack.json] [--profile mpc] [--only 0-fool,xvi-tower,chart] [--no-chart] [--out dir]
 *       [--carbon 0.35] [--colour 0.42] [--lettering 0.26] [--gap 0.25] [--min-run 0.5]
 *       [--texture 0.04] [--grain 0.5] [--ink] [--ink-jitter 0.08] [--ink-blob 1.6] [--seed 1]
 *       [--back image.png] [--supersample 4]
 *
 * The stack (default `sketches/phase-garden/stacks/tarot-print.json`) sets the page to the trim and the border and
 * margin that keep the art in the safe zone. Each card then goes through small steps that a later profile can reuse:
 *
 *   1. render      the card at the trim size through the stack's finishing        (`previewPiece`, cli/finalize.ts)
 *   2. layout      read the pen layers; check the art stays `safeMm` inside the trim    (`layoutCard`)
 *   3. thicken     raise stroke widths per pen, holding back any that would close a gap  (`thicken.ts`)
 *   4. ink         optional ink character on the lines                                   (`ink.ts`)
 *   5. rasterize   the lines alone at `supersample` x the print resolution              (`raster.ts`)
 *   6. tint        the paper tint over the whole bleed canvas, optional grain on it only (`raster.ts`)
 *   7. composite   lines over tint, averaged down to the print resolution
 *   8. colour      `profile.colour.convert`: sRGB passes through (the hook for a CMYK profile)
 *   9. encode      8-bit sRGB PNG with its dpi
 *
 * Output: `.sketch-output/print/<profile>/NN-<card>.front.png` (NN is the deck order), `22-test-chart.front.png`,
 * `back.png` when `--back` gives one, and `manifest.json`. The thickened vectors are kept in `_work/` for a vector
 * profile to pick up.
 *
 * A CMYK profile (DriveThruCards, PrintNinja, Ivory) needs, that this machine lacks: an ICC engine (lcms2, or
 * ImageMagick/Ghostscript, none installed) and the printer's profile (GRACoL 2006 for US, FOGRA39 for Europe); a
 * conversion that makes carbon K-only and every other pen at most two inks; and a PDF/X-1a writer. It would reuse steps
 * 1-4 and take the vector widths (0.30 / 0.38 / 0.20 mm) instead of the raster ones, then place the lines as vector
 * strokes over a raster tint. Set `colour` on a new profile to do the conversion in step 8.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { previewPiece, resolveOptions, type Palette, type Piece, type Stack } from './finalize.ts';
import { buildChart } from './print-export/chart.ts';
import { INK_DEFAULTS, inkCharacter, type InkOptions } from './print-export/ink.ts';
import { compositeDownsample, encodePng, hexRgb, pngInfo, rasterizeSvg, readRgb, tintCanvas, type Grain } from './print-export/raster.ts';
import { canvasSvg, layersSvg, parseLayers, strokeBounds, svgPageMm, type Bounds, type PenLayer } from './print-export/svg.ts';
import { PEN_CLASSES, thickenLayers, type PenClass, type ThickenReport } from './print-export/thicken.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STACK = 'sketches/phase-garden/stacks/tarot-print.json';
const MM_PER_IN = 25.4;

/** The colour step: sRGB in, whatever the printer takes out. The default passes the pixels through. */
export interface ColourStage {
  id: string;
  space: 'sRGB' | 'CMYK';
  convert(rgb: Uint8Array, widthPx: number, heightPx: number): Uint8Array;
}
export const SRGB_PASSTHROUGH: ColourStage = { id: 'srgb', space: 'sRGB', convert: rgb => rgb };

/** What a printer takes: the trim, the canvas it wants around it, the safe zone, and the starting widths. */
export interface PrintProfile {
  id: string;
  label: string;
  trimMm: { width: number; height: number };
  ppi: number;
  /** Bleed per side, in pixels at `ppi` (MPC's own spec: 36 px, 3.048 mm). */
  bleedPx: number;
  /** Art and text stay this far inside the trim, mm. */
  safeMm: number;
  /** The paper tint, printed over the whole canvas. */
  tint: string;
  /** Starting stroke widths for the raster, mm. */
  widthsMm: Record<PenClass, number>;
  /** The paper gap a thickened line must leave, mm. */
  gapMinMm: number;
  supersample: number;
  colour: ColourStage;
}

export const MPC: PrintProfile = {
  id: 'mpc', label: 'MakePlayingCards tarot, 2.75 x 4.75 in',
  trimMm: { width: 69.85, height: 120.65 }, ppi: 300, bleedPx: 36, safeMm: 5, tint: '#f4f0e6',
  widthsMm: { carbon: 0.35, colour: 0.42, lettering: 0.26 }, gapMinMm: 0.25, supersample: 4, colour: SRGB_PASSTHROUGH,
};
export const PROFILES: Record<string, PrintProfile> = { mpc: MPC };

export interface Geometry {
  trimPx: { width: number; height: number };
  canvasPx: { width: number; height: number };
  bleedMm: number;
  canvasMm: { width: number; height: number };
}

/** Pixel and millimetre sizes of a profile's canvas: the trim plus the bleed on every side. */
export function geometry(p: PrintProfile): Geometry {
  const px = (mm: number) => Math.round(mm / MM_PER_IN * p.ppi);
  const trimPx = { width: px(p.trimMm.width), height: px(p.trimMm.height) };
  const canvasPx = { width: trimPx.width + 2 * p.bleedPx, height: trimPx.height + 2 * p.bleedPx };
  const toMm = (n: number) => n / p.ppi * MM_PER_IN;
  return { trimPx, canvasPx, bleedMm: toMm(p.bleedPx), canvasMm: { width: toMm(canvasPx.width), height: toMm(canvasPx.height) } };
}

export interface PrintOptions {
  widthsMm: Record<PenClass, number>;
  gapMinMm: number;
  /** The shortest stretch two strokes must run that close to hold a width back (the density probe's `minRun`), mm. */
  minRunMm: number;
  supersample: number;
  /** Paper grain on the tint only: `strength` is the tone fraction (0.04 is 4%), 0 for none. The chart's patches use the seed and size either way. */
  grain: { seed: number; grainMm: number; strength: number };
  ink: InkOptions | null;
}

export function printOptions(profile: PrintProfile, o: Partial<PrintOptions> = {}): PrintOptions {
  return {
    widthsMm: { ...profile.widthsMm, ...o.widthsMm }, gapMinMm: o.gapMinMm ?? profile.gapMinMm, minRunMm: o.minRunMm ?? 0.5,
    supersample: o.supersample ?? profile.supersample, grain: o.grain ?? { seed: 1, grainMm: 0.5, strength: 0 }, ink: o.ink ?? null,
  };
}

const MAJORS = ['the-fool', 'the-magician', 'the-high-priestess', 'the-empress', 'the-emperor', 'the-hierophant', 'the-lovers', 'the-chariot', 'strength',
  'the-hermit', 'wheel-of-fortune', 'justice', 'the-hanged-man', 'death', 'temperance', 'the-devil', 'the-tower', 'the-star', 'the-moon', 'the-sun', 'judgement', 'the-world'];
const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50 };
export const CHART_DECK = MAJORS.length;

/** A card's place in the deck, from its piece name's numeral (`0-fool`, `xvi-tower`), and its file stem. */
export function deckEntry(pieceName: string): { deck: number; card: string; stem: string } {
  const prefix = /^(0|[ivxl]+)-/.exec(pieceName)?.[1];
  if (prefix === undefined) throw new Error(`print-export: ${pieceName} does not start with its numeral (0-fool, xvi-tower)`);
  let deck = 0;
  if (prefix !== '0') {
    const values = [...prefix].map(ch => ROMAN[ch]);
    values.forEach((v, i) => { deck += v < (values[i + 1] ?? 0) ? -v : v; });
  }
  if (!(deck >= 0 && deck < MAJORS.length)) throw new Error(`print-export: ${pieceName} is numeral ${deck}, outside the Major Arcana`);
  return { deck, card: MAJORS[deck], stem: `${String(deck).padStart(2, '0')}-${MAJORS[deck]}` };
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const round = (v: number, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;

export interface CardLayout {
  layers: PenLayer[];
  /** The art's extent (everything but the border), centrelines, mm. */
  artMm: Bounds | null;
  /** The border's outer edge from the trim, mm, or null with no border. */
  borderOuterMm: number | null;
  /** Whether the art, to its stroke edges, stays `safeMm` inside the trim. */
  safeOk: boolean;
}

const isBorder = (l: PenLayer) => l.penId === 'finishing-border';

/** Step 2: the card's pen layers from its sketch SVG, checked against the trim and the safe zone. */
export function layoutCard(sourceSvg: string, profile: PrintProfile, widthsMm: Record<PenClass, number>): CardLayout {
  const page = svgPageMm(sourceSvg);
  const { width, height } = profile.trimMm;
  if (Math.abs(page.width - width) > 0.001 || Math.abs(page.height - height) > 0.001) {
    throw new Error(`print-export: the card renders at ${page.width} x ${page.height} mm, not the ${profile.id} trim ${width} x ${height} mm: set the stack's page to the trim`);
  }
  const layers = parseLayers(sourceSvg);
  const artMm = strokeBounds(layers, { skip: isBorder });
  const border = strokeBounds(layers.filter(isBorder));
  const borderOuterMm = border ? Math.min(border.x0, border.y0, width - border.x1, height - border.y1) - widthsMm.carbon / 2 : null;
  const edge = strokeBounds(layers, { skip: isBorder, widened: true });
  const safe = profile.safeMm - 1e-6;
  const safeOk = !edge || (edge.x0 >= safe && edge.y0 >= safe && width - edge.x1 >= safe && height - edge.y1 >= safe);
  return { layers, artMm, borderOuterMm, safeOk };
}

export interface PrintImage { rgb: Uint8Array; widthPx: number; heightPx: number }

/**
 * Steps 5-8: the pen layers (final widths, page millimetres) and any fills under them, rasterized and laid over the
 * tint on the bleed canvas, then through the profile's colour step.
 */
export function renderPrint(layers: readonly PenLayer[], fills: string, profile: PrintProfile, options: PrintOptions, grain?: Grain): PrintImage {
  const g = geometry(profile);
  const { width: w, height: h } = g.canvasPx, ss = options.supersample;
  const svg = canvasSvg(`${fills}\n${layersSvg(layers)}`, g.canvasMm, g.bleedMm, w * ss, h * ss);
  const lines = rasterizeSvg(svg);
  const tint = tintCanvas({ widthPx: w, heightPx: h, ppi: profile.ppi, bleedPx: profile.bleedPx }, hexRgb(profile.tint), grain);
  const rgb = profile.colour.convert(compositeDownsample(lines, tint, w, h, ss), w, h);
  return { rgb, widthPx: w, heightPx: h };
}

/** The grain a card gets: one strength over the whole sheet. */
export function cardGrain(options: PrintOptions): Grain | undefined {
  const g = options.grain;
  return g.strength > 0 ? { seed: g.seed, grainMm: g.grainMm, strength: () => g.strength } : undefined;
}

export interface PrintedFile {
  file: string;
  kind: 'front' | 'chart' | 'back';
  deck?: number;
  card?: string;
  seed?: number;
  identity?: string | null;
  widthPx: number;
  heightPx: number;
  ppi: number;
  sha256: string;
  trimMm: { width: number; height: number };
  bleedMm: number;
  bleedPx: number;
  safeMm: number;
  strokeWidthsMm?: Record<PenClass, number>;
  paths?: number;
  cappedPaths?: number;
  cappedAtPlottedWidth?: number;
  thickenedPaths?: number;
  cappedByPen?: ThickenReport['byClass'];
  artBoundsMm?: Bounds | null;
  artInsideSafeZone?: boolean;
  borderOuterEdgeMm?: number | null;
}

function fileEntry(profile: PrintProfile, options: PrintOptions, file: string, kind: PrintedFile['kind'], png: Buffer, extra: Partial<PrintedFile> = {}): PrintedFile {
  const g = geometry(profile), info = pngInfo(png);
  return {
    file, kind, ...extra, widthPx: info.width, heightPx: info.height, ppi: info.ppi ?? profile.ppi, sha256: sha256(png),
    trimMm: profile.trimMm, bleedMm: round(g.bleedMm), bleedPx: profile.bleedPx, safeMm: profile.safeMm,
    ...(kind === 'back' ? {} : { strokeWidthsMm: options.widthsMm }),
  };
}

/** The thickened vectors as a standalone SVG at the trim, for a vector profile and for looking at. */
function vectorMaster(layers: readonly PenLayer[], profile: PrintProfile): string {
  const { width, height } = profile.trimMm;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">\n${layersSvg(layers)}\n</svg>\n`;
}

export interface CardResult { file: PrintedFile; png: Buffer; svg: string }

export interface PrintedSvg { png: Buffer; layout: CardLayout; thicken: ThickenReport; /** The layers as drawn: final widths, with ink character if asked. */ layers: PenLayer[] }

/** Steps 2-9 on a card's sketch SVG: lay out, thicken, ink, rasterize, composite, encode. */
export function printSvg(source: string, profile: PrintProfile, options: PrintOptions): PrintedSvg {
  const layout = layoutCard(source, profile, options.widthsMm);
  const thick = thickenLayers(layout.layers, { widths: options.widthsMm, gapMin: options.gapMinMm, minRun: options.minRunMm });
  const layers = options.ink ? inkCharacter(thick.layers, options.ink) : thick.layers;
  const image = renderPrint(layers, '', profile, options, cardGrain(options));
  return { png: encodePng(image.rgb, image.widthPx, image.heightPx, profile.ppi), layout, thicken: thick.report, layers };
}

/** One card: render it at the trim through the stack's finishing, then `printSvg`. */
export async function printCard(stack: Stack, piece: Piece, palette: Palette, profile: PrintProfile, options: PrintOptions, workDir: string): Promise<CardResult> {
  const { deck, card, stem } = deckEntry(piece.name);
  const dir = join(workDir, slug(piece.name));
  const printed = printSvg(await previewPiece(stack, piece, palette, {}, dir), profile, options);
  let identity: string | null = null;
  try { identity = (JSON.parse(readFileSync(join(dir, 'source', 'result.json'), 'utf8')) as { identity?: string }).identity ?? null; } catch { /* the render keeps no result */ }
  const { layout, thicken: r } = printed;
  const file = fileEntry(profile, options, `${stem}.front.png`, 'front', printed.png, {
    deck, card, seed: piece.seed, identity, paths: r.paths, cappedPaths: r.capped, cappedAtPlottedWidth: r.heldAtPlotted, thickenedPaths: r.thickened, cappedByPen: r.byClass,
    artBoundsMm: layout.artMm && { x0: round(layout.artMm.x0), y0: round(layout.artMm.y0), x1: round(layout.artMm.x1), y1: round(layout.artMm.y1) },
    artInsideSafeZone: layout.safeOk, borderOuterEdgeMm: layout.borderOuterMm === null ? null : round(layout.borderOuterMm),
  });
  return { file, png: printed.png, svg: vectorMaster(printed.layers, profile) };
}

/** The test chart at the profile's spec, as the last card of the proof deck. */
export function printChart(palette: Palette, profile: PrintProfile, options: PrintOptions): CardResult {
  const g = geometry(profile);
  const inks = palette.inks;
  const names = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'];
  const w = options.widthsMm;
  const grain = options.grain;
  const chart = buildChart({
    trim: profile.trimMm, pens: names.map((id, i) => ({ id, color: inks[i] })), letteringColor: inks[0], widths: w, gapMin: options.gapMinMm, minRun: options.minRunMm, safeMm: profile.safeMm,
    grainMm: grain.grainMm, grainSeed: grain.seed, grainStrength: grain.strength, ink: options.ink,
    summary: [`${profile.ppi} PPI  ${g.canvasPx.width} X ${g.canvasPx.height} PX`, `CARBON ${w.carbon} COLOUR ${w.colour} TEXT ${w.lettering}`, `GAP ${options.gapMinMm} MM  LADDERS IN 0.01 MM`, 'FRAMES 3 4 5 6 MM FROM TRIM', `TRIM DASH  SAFE ${profile.safeMm} TICK  R3 ARC`],
  });
  const image = renderPrint(chart.layers, chart.fills, profile, options, chart.grain);
  const png = encodePng(image.rgb, image.widthPx, image.heightPx, profile.ppi);
  const file = fileEntry(profile, options, `${String(CHART_DECK).padStart(2, '0')}-test-chart.front.png`, 'chart', png, { deck: CHART_DECK, card: 'test-chart' });
  return { file, png, svg: vectorMaster(chart.layers, profile) };
}

/** A back image dropped into the pipeline: it must already be the canvas size; it is re-written with the dpi and sRGB tag. */
export function printBack(path: string, profile: PrintProfile, options: PrintOptions): CardResult {
  const g = geometry(profile);
  const { width, height, rgb } = readRgb(readFileSync(path));
  if (width !== g.canvasPx.width || height !== g.canvasPx.height) {
    throw new Error(`print-export: the back is ${width} x ${height} px; ${profile.id} wants ${g.canvasPx.width} x ${g.canvasPx.height} (the trim ${g.trimPx.width} x ${g.trimPx.height} plus ${profile.bleedPx} px of bleed on every side)`);
  }
  const png = encodePng(profile.colour.convert(rgb, width, height), width, height, profile.ppi);
  return { file: fileEntry(profile, options, 'back.png', 'back', png), png, svg: '' };
}

export interface Manifest {
  schema: 1;
  profile: string;
  label: string;
  colour: { space: string; paperTint: string; pens: { id: string; color: string }[] };
  gapMinMm: number;
  minRunMm: number;
  supersample: number;
  grain: PrintOptions['grain'];
  inkCharacter: Omit<InkOptions, 'seed'> | null;
  stack: string;
  files: PrintedFile[];
}

function loadStack(path: string): Stack {
  const stack = JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as Stack;
  if (!Array.isArray(stack.pieces) || !stack.pieces.length) throw new Error('print-export: the stack needs pieces');
  return stack;
}

/** The stack must draw on the trim, with a border that keeps its outer edge in the safe zone. */
export function checkStack(stack: Stack, profile: PrintProfile, options: PrintOptions): void {
  const { width, height } = profile.trimMm;
  if (!stack.page || Math.abs(stack.page.width - width) > 0.001 || Math.abs(stack.page.height - height) > 0.001) {
    throw new Error(`print-export: the stack's page must be the ${profile.id} trim, ${width} x ${height} mm`);
  }
  const inset = (stack.border as { inset?: number } | undefined)?.inset;
  if (inset !== undefined && inset - options.widthsMm.carbon / 2 < profile.safeMm - 1e-6) {
    throw new Error(`print-export: the border's outer edge is ${round(inset - options.widthsMm.carbon / 2)} mm from the trim, inside the ${profile.safeMm} mm safe zone: raise the stack's border inset to ${round(profile.safeMm + options.widthsMm.carbon / 2)} mm or more`);
  }
}

export interface RunOptions {
  stackPath: string;
  profile: PrintProfile;
  options: PrintOptions;
  only?: string[];
  chart: boolean;
  back?: string;
  out?: string;
}

/** Print the stack's cards (and the chart, and a back) into the profile's folder; returns the manifest. */
export async function run(r: RunOptions, log: (line: string) => void = () => {}): Promise<Manifest> {
  const stack = loadStack(r.stackPath);
  checkStack(stack, r.profile, r.options);
  const palette = resolveOptions(stack).palette;
  const out = resolve(ROOT, r.out ?? join('.sketch-output', 'print', r.profile.id));
  const workDir = join(out, '_work');
  mkdirSync(workDir, { recursive: true });
  const wanted = (name: string) => !r.only || r.only.includes(slug(name)) || r.only.includes(deckEntry(name).stem) || r.only.includes(String(deckEntry(name).deck));
  const made: PrintedFile[] = [];
  const save = (result: CardResult) => {
    writeFileSync(join(out, result.file.file), result.png);
    if (result.svg) writeFileSync(join(workDir, result.file.file.replace(/\.png$/, '.svg')), result.svg);
    made.push(result.file);
    log(JSON.stringify({ file: result.file.file, px: `${result.file.widthPx}x${result.file.heightPx}`, ppi: result.file.ppi, paths: result.file.paths, capped: result.file.cappedPaths, sha256: result.file.sha256.slice(0, 12) }));
  };
  for (const piece of stack.pieces.filter(p => wanted(p.name))) save(await printCard(stack, piece, palette, r.profile, r.options, workDir));
  if (r.chart && (!r.only || r.only.includes('chart'))) save(printChart(palette, r.profile, r.options));
  if (r.back) save(printBack(r.back, r.profile, r.options));

  // A run of a few cards keeps the files the earlier runs made.
  const manifestPath = join(out, 'manifest.json');
  const kept: PrintedFile[] = [];
  if (existsSync(manifestPath)) {
    for (const f of (JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest).files) if (!made.some(m => m.file === f.file) && existsSync(join(out, f.file))) kept.push(f);
  }
  const manifest: Manifest = {
    schema: 1, profile: r.profile.id, label: r.profile.label,
    colour: { space: r.profile.colour.space, paperTint: r.profile.tint, pens: ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet'].map((id, i) => ({ id, color: palette.inks[i] })) },
    gapMinMm: r.options.gapMinMm, minRunMm: r.options.minRunMm, supersample: r.options.supersample, grain: r.options.grain,
    inkCharacter: r.options.ink ? (({ seed: _seed, ...rest }) => rest)(r.options.ink) : null,
    stack: relative(ROOT, resolve(ROOT, r.stackPath)),
    files: [...kept, ...made].sort((a, b) => a.file.localeCompare(b.file)),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  log(`manifest: ${relative(ROOT, manifestPath)} (${manifest.files.length} files)`);
  return manifest;
}

function main(argv: string[]): Promise<void> {
  const { values: a, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      profile: { type: 'string' }, only: { type: 'string' }, out: { type: 'string' }, 'no-chart': { type: 'boolean', default: false }, back: { type: 'string' },
      carbon: { type: 'string' }, colour: { type: 'string' }, lettering: { type: 'string' }, gap: { type: 'string' }, 'min-run': { type: 'string' }, supersample: { type: 'string' },
      texture: { type: 'string' }, grain: { type: 'string' }, seed: { type: 'string' },
      ink: { type: 'boolean', default: false }, 'ink-jitter': { type: 'string' }, 'ink-blob': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (a.help) {
    console.log(`print-export: print-ready PNGs of the Breach Tarot cards and a test chart

Usage: npm run print-export -- [stack.json] [--profile mpc] [--only 0-fool,xvi-tower,chart] [--no-chart] [--out dir]
         [--carbon 0.35] [--colour 0.42] [--lettering 0.26] [--gap 0.25] [--min-run 0.5] [--supersample 4]
         [--texture 0.04] [--grain 0.5] [--ink] [--ink-jitter 0.08] [--ink-blob 1.6] [--seed 1] [--back image.png]

Writes .sketch-output/print/<profile>/NN-<card>.front.png, 22-test-chart.front.png and manifest.json.
--texture is paper grain on the tint only, as a tone fraction (0.04 is 4%); off by default. --ink adds ink character
to the lines; off by default.`);
    return Promise.resolve();
  }
  const profile = PROFILES[a.profile ?? 'mpc'];
  if (!profile) throw new Error(`print-export: unknown profile ${a.profile}; known: ${Object.keys(PROFILES).join(', ')}`);
  const num = (name: string, value: string | undefined, min: number, max: number): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!(n >= min && n <= max)) throw new Error(`print-export: --${name} must be a number from ${min} to ${max}`);
    return n;
  };
  const widthsMm = { ...profile.widthsMm };
  for (const cls of PEN_CLASSES) widthsMm[cls] = num(cls, a[cls], 0.05, 2) ?? widthsMm[cls];
  const seed = num('seed', a.seed, 0, 2 ** 31) ?? 1;
  const strength = num('texture', a.texture, 0, 0.2) ?? 0;
  const ink: InkOptions | null = a.ink ? { seed, ...INK_DEFAULTS, jitter: num('ink-jitter', a['ink-jitter'], 0, 0.5) ?? INK_DEFAULTS.jitter, blob: num('ink-blob', a['ink-blob'], 1, 3) ?? INK_DEFAULTS.blob } : null;
  const options = printOptions(profile, {
    widthsMm, gapMinMm: num('gap', a.gap, 0, 2), minRunMm: num('min-run', a['min-run'], 0.01, 5), supersample: num('supersample', a.supersample, 1, 8),
    grain: { seed, grainMm: num('grain', a.grain, 0.1, 5) ?? 0.5, strength }, ink,
  });
  return run({
    stackPath: positionals[0] ?? DEFAULT_STACK, profile, options, chart: !a['no-chart'], back: a.back, out: a.out,
    only: a.only?.split(',').map(s => slug(s.trim())).filter(Boolean),
  }, console.log).then(() => undefined);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(e => { console.error((e as Error).message); process.exitCode = 1; });
}
