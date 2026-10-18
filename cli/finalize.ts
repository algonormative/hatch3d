/**
 * Finalize a stack of sketch renders for the plotter: palette → balanced placement → vpype preparation.
 *
 *   node --import tsx cli/finalize.ts run <stack.json> [--only name,name] [--palette id] [--params '{"sloganCount":1}'] [--merge] [--bump]
 *   node --import tsx cli/finalize.ts serve <stack.json> [--port 8796]
 *
 * The palette is applied through finishing (paper + pen colors), so the canonical render records it.
 * Placement moves only the artwork layers so their bounds sit centered inside the border's inner line.
 * vpype (Python, on PATH) merges, sorts, reloops and simplifies per layer; numbered layer labels,
 * pen ids and pass counts are restored onto the prepared SVG because vpype drops data-* attributes.
 * Nothing here talks to a plotter: the output is files only.
 */
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderSvgPng } from './sketch/export-png.ts';
import { targetPage } from '../src/sketch/render-target.ts';
import { DOUBLE_BORDER_INSET } from '../src/utils/page-finishing.ts';
import { checkInksRead, congruentFit, parseFrom, plyCuts, readPlyResult, registrationProblem, signatureBox, tryParseFrom, worldCuts, worldSha256, type AssemblyReport, type PlyResult } from './assembly-world.ts';
import type { AssemblySpec, Control, Page, Pen, PlySpec } from '../src/sketch/types.ts';
import { INKS } from '../src/sketch/materials.ts';
import { checkPrepared, paperIdOfColor, type InkCheckSummary } from './ink-check.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface Piece {
  name: string; sketch: string; seed: number; params?: Record<string, unknown>; title?: string;
  /** The panel (one artwork made of paper plies, see `assembly` in the sketch) this piece is a ply of, such as "lintel-r". The ply is the sketch's ply control. */
  assembly?: string;
}
export interface VpypeOptions { mergeTolerance: number; simplifyTolerance: number; minLength: number; reloop: boolean; sort: boolean }
export interface FinalizeOptions {
  palette: Palette;
  /** Center the artwork inside the border: vertical only, both axes, or leave it where the sketch put it. */
  center: 'vertical' | 'both' | 'none';
  /** Put layers that share an ink color on one layer, so the plot needs fewer pen changes. */
  mergeSameColor: boolean;
  vpype: VpypeOptions;
}
export interface Stack {
  title?: string; out: string; border?: Record<string, unknown>; pieces: Piece[];
  /** `trialInks`: for a ply of an assembly, also accept inks the catalog lists as on trial on its paper (the report names them). */
  defaults?: Partial<FinalizeOptions> & { palette?: string; trialInks?: boolean };
  /** The sheet every piece prints on (mm). A page-aware sketch draws on it; any other is fitted onto it. Default: each sketch's own page. */
  page?: { width: number; height: number; margin?: number };
  /** Params every piece shares (e.g. slogan and scratch settings); a piece's own params win. */
  params?: Record<string, unknown>;
  /** Print-run number; `run --bump` increments it. */
  edition?: number;
  /** Title drawn on each print when its sketch has title controls, e.g. "Breach Cathedral {version} {hash}". */
  printTitle?: string;
  /** The physical pen to show for a layer id when plotter-server asks for it ("Load pen"), e.g. { "carbon": "Micron 01 black" }. */
  penNames?: Record<string, string>;
}

export interface BuildVersion { version: string; hash: string; dirty: boolean }

/** A v* tag on HEAD wins over the edition; '+' marks uncommitted tracked changes (the stack file itself excepted). */
export function buildVersion(edition = 1): BuildVersion {
  const git = (args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const tag = git(['describe', '--tags', '--exact-match', '--match', 'v*', 'HEAD']);
  const head = git(['rev-parse', '--short', 'HEAD']);
  if (head.status !== 0) fail('finalize needs a git checkout to stamp the build hash');
  const status = git(['status', '--porcelain', '--untracked-files=no', '--', '.', ':!sketches/phase-garden/stacks']);
  return { version: tag.status === 0 ? tag.stdout.trim() : `v${edition}`, hash: head.stdout.trim(), dirty: status.stdout.trim().length > 0 };
}

/** Title overrides for sketches that declare title controls; explicit overrides still win. */
export function titleOverrides(stack: Stack, controls: Control[], build: BuildVersion): Record<string, unknown> {
  if (!stack.printTitle || !controls.some(c => c.id === 'title') || !controls.some(c => c.id === 'titleEnabled')) return {};
  const title = stack.printTitle.replace('{version}', build.version).replace('{hash}', build.hash + (build.dirty ? '+' : ''));
  return { titleEnabled: true, title };
}
/**
 * A palette assigns inks by pen order (structure, body, interruption, event, joining, ...) plus a paper color.
 * A 'lettering' pen is not part of that order: it takes the structure ink (inks[0]).
 */
export interface Palette { id: string; label: string; paper: string; inks: string[]; note?: string }

export const PALETTES: Palette[] = [
  { id: 'phase-garden', label: 'Phase Garden', paper: '#f4f0e6', inks: ['#22282c', '#3c49aa', '#d04b3c', '#a5a938', '#776090', '#6b8491', '#a48b8c', '#a69d84'], note: 'The original five inks on warm stock.' },
  { id: 'carbon', label: 'Carbon only', paper: '#f4f0e6', inks: ['#22282c', '#22282c', '#22282c', '#22282c', '#22282c', '#22282c', '#22282c', '#22282c'], note: 'One black pen. Merge gives a single layer.' },
  { id: 'two-tone', label: 'Carbon + ultramarine', paper: '#f4f0e6', inks: ['#22282c', '#3c49aa', '#3c49aa', '#22282c', '#3c49aa', '#3c49aa', '#22282c', '#22282c'], note: 'Two pens: structure black, everything living blue.' },
  { id: 'cyanotype', label: 'Cyanotype', paper: '#f3f1ea', inks: ['#16324f', '#2f6690', '#3a7ca5', '#81c3d7', '#1f4e79', '#3a7ca5', '#81c3d7', '#2f6690'], note: 'Prussian blues, darkest for structure.' },
  { id: 'sepia', label: 'Sepia drafting', paper: '#f5efe3', inks: ['#3b2a1e', '#7a4b2a', '#b5542d', '#a88b4a', '#5d4a66', '#7a4b2a', '#b5542d', '#a88b4a'], note: 'Brown inks, rust accents.' },
  { id: 'riso', label: 'Riso brights', paper: '#f7f5ef', inks: ['#1d1d1b', '#0078bf', '#ff48b0', '#ffb511', '#00a95c', '#0078bf', '#ff48b0', '#ffb511'], note: 'Fluorescent pink and yellow accents.' },
  { id: 'night', label: 'Night stock', paper: '#17181a', inks: ['#f2f0ea', '#9fb4ff', '#ff8a70', '#e4d27a', '#c7a8f0', '#9fb4ff', '#ff8a70', '#e4d27a'], note: 'Gel pens on black paper.' },
  { id: 'blueprint', label: 'Blueprint', paper: '#1d3b6e', inks: ['#f4f4ef', '#cfe0ff', '#ffd6c9', '#f4f4ef', '#cfe0ff', '#cfe0ff', '#ffd6c9', '#f4f4ef'], note: 'White pens on blue stock.' },
];

export const DEFAULT_OPTIONS: Omit<FinalizeOptions, 'palette'> = {
  center: 'vertical', mergeSameColor: true,
  vpype: { mergeTolerance: 0.4, simplifyTolerance: 0.03, minLength: 0.3, reloop: true, sort: true },
};

const MM_PER_PX = 25.4 / 96;
const DRAW_MM_S = 60, TRAVEL_MM_S = 200, SWAP_S = 60;
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function fail(message: string): never { throw new Error(message); }

/**
 * The one page a piece prints on: the stack's page when it sets one, else the sketch's own. A page-aware sketch
 * gets the page the render will draw it on (a margin the stack leaves out scales with the page, as in the render);
 * any other sketch gets the stack's page over its own, as finishing fits it.
 */
export function pageFor(stack: Pick<Stack, 'page'>, sketch: { page: Page; pageAware?: boolean }): Page {
  if (!stack.page) return sketch.page;
  return sketch.pageAware ? targetPage(sketch.page, stack.page) : { ...sketch.page, ...stack.page };
}

/**
 * The finishing for the art match's plain render: the piece's page for a page-aware sketch when the stack sets
 * one, since such a sketch draws differently on it. Otherwise none: the match fits the sketch's own render.
 */
export function plainFinishing(stack: Pick<Stack, 'page'>, sketch: { page: Page; pageAware?: boolean }): { page: Page } | undefined {
  if (!stack.page || !sketch.pageAware) return undefined;
  const { width, height, margin } = pageFor(stack, sketch);
  return { page: { width, height, ...(margin === undefined ? {} : { margin }) } };
}

export interface LoadedSketch { name: string; page: Page; pens: Pen[]; controls: Control[]; assembly?: AssemblySpec }

/** The piece's page (`pageFor`), pens, controls and, for an assembly sketch, its assembly spec. */
export async function loadSketch(stack: Stack, entry: string): Promise<LoadedSketch> {
  const mod = await import(pathToFileURL(resolve(ROOT, entry)).href);
  const sketch = mod.default;
  if (!sketch?.page || !Array.isArray(sketch.pens)) fail(`${entry} does not export a sketch with page and pens`);
  return { name: String(sketch.name ?? ''), page: pageFor(stack, sketch), pens: sketch.pens, controls: sketch.controls ?? [], ...(sketch.assembly ? { assembly: sketch.assembly as AssemblySpec } : {}) };
}

/**
 * Layering: stack-wide params, then the piece's own params, then title stamping and explicit overrides. Every layer
 * may only name controls the sketch declares, so a typo can't silently do nothing.
 */
function withOverrides(stack: Stack, piece: Piece, controls: Control[], overrides: Record<string, unknown>): Record<string, unknown> {
  const ids = new Set(controls.map(c => c.id));
  for (const key of Object.keys({ ...stack.params, ...piece.params, ...overrides })) if (!ids.has(key)) fail(`${piece.name} has no control named ${key}`);
  return { ...stack.params, ...piece.params, ...overrides };
}

const execFileAsync = promisify(execFile);
async function renderSource(piece: Piece, request: object, dir: string): Promise<string> {
  mkdirSync(join(dir, 'source'), { recursive: true });
  const requestPath = join(dir, 'request.json');
  writeFileSync(requestPath, JSON.stringify(request, null, 2));
  try {
    await execFileAsync(process.execPath, ['--import', 'tsx', join(ROOT, 'cli/sketch.ts'), 'render', resolve(ROOT, piece.sketch), '--config', requestPath, '--out', join(dir, 'source')],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    fail(`render failed for ${piece.name}: ${((e.stdout ?? '') + (e.stderr ?? '') || e.message).trim().slice(-400)}`);
  }
  return join(dir, 'source', 'render.svg');
}

/** Render only (no vpype), for previews: the page recolors layers itself. */
export async function previewPiece(stack: Stack, piece: Piece, palette: Palette, overrides: Record<string, unknown>, dir: string): Promise<string> {
  const loaded = await loadSketch(stack, piece.sketch);
  const { page, pens, controls } = loaded;
  const auto = titleOverrides(stack, controls, buildVersion(stack.edition));
  const asm = await planAssembly(stack, piece, loaded, overrides);
  const finishing = asm ? assemblyFinishing(stack, page, pens, asm) : finishingFor(stack, page, pens, palette);
  const request = { seed: piece.seed, params: withOverrides(stack, piece, controls, { ...auto, ...overrides }), finishing };
  return readFileSync(await renderSource(piece, request, dir), 'utf8');
}

export const inkFor = (penId: string, index: number, palette: Palette): string =>
  penId === 'lettering' ? palette.inks[0] : palette.inks[index % palette.inks.length];

function finishingFor(stack: Stack, page: Page, pens: Pen[], palette: Palette) {
  return {
    ...(stack.border ? { border: stack.border } : {}),
    page: { width: page.width, height: page.height, margin: page.margin ?? 18, paper: palette.paper },
    pens: Object.fromEntries(pens.map((pen, i) => [pen.id, { color: inkFor(pen.id, i, palette) }])),
  };
}

// ── Assembly: a panel made of plies ──────────────────────────────────
//
// A sketch that declares `assembly` is one panel; each piece of it is one ply, a render of the same world with the
// ply control set. The plies are plotted on different papers, cut and glued, so they must register: same seed and
// params, the same page fit (nothing moves them), crop marks to trim at, and inks that read on their paper.

/** The ply a piece is: the assembly control's value after layering, else the control's default (the top ply). */
export function plyOf(stack: Stack, piece: Piece, loaded: LoadedSketch, overrides: Record<string, unknown> = {}): { spec: AssemblySpec; ply: PlySpec; index: number } {
  const spec = loaded.assembly ?? fail(`${piece.sketch} does not declare an assembly`);
  const control = loaded.controls.find(c => c.id === spec.control);
  const given = { ...stack.params, ...piece.params, ...overrides }[spec.control];
  const id = given ?? (control && 'default' in control ? control.default : undefined);
  const index = spec.plies.findIndex(p => p.id === id);
  if (index < 0) fail(`${piece.name} is ply ${String(id)}, which assembly ${piece.assembly ?? spec.control} does not have (plies: ${spec.plies.map(p => p.id).join(', ')})`);
  return { spec, ply: spec.plies[index], index };
}

interface AssemblyPlan { name: string; spec: AssemblySpec; ply: PlySpec; index: number; siblings: Piece[]; trialPens: string[] }

const canonical = (value: Record<string, unknown>) => JSON.stringify(Object.keys(value).sort().map(k => [k, value[k]]));

/**
 * Checks a piece of an assembly before anything is rendered, and returns its plan; undefined for a plain sketch.
 * Throws when the sketch and the piece disagree about being an assembly, the piece is an onlay (never finalized), the
 * stack's border is not crop marks on the cut pen, an ink does not read on its paper (an ink only on trial there is
 * accepted when the stack sets `defaults.trialInks`, and named in the plan's `trialPens`), or the pieces that share the
 * assembly differ in sketch, seed or params (other than the ply), or make one ply twice.
 */
async function planAssembly(stack: Stack, piece: Piece, loaded: LoadedSketch, overrides: Record<string, unknown>): Promise<AssemblyPlan | undefined> {
  if (!loaded.assembly) {
    if (piece.assembly !== undefined) fail(`${piece.name} names assembly ${piece.assembly}, but ${piece.sketch} does not declare one`);
    return undefined;
  }
  const name = piece.assembly;
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) fail(`${piece.name} is a ply of an assembly sketch: its "assembly" must name the panel (letters, digits and hyphens), such as "lintel-r"`);
  const { spec, ply, index } = plyOf(stack, piece, loaded, overrides);
  if (ply.onlay) fail(`${piece.name} is ply ${ply.id}, an onlay plotted and cut on ${ply.onlay.from}: onlays are never finalized`);
  const border = stack.border as { style?: string; pen?: string } | undefined;
  if (border?.style !== 'cropmarks' || border.pen !== spec.cutPen) fail(`assembly ${name}: the stack border must be crop marks on the cut pen (${spec.cutPen}), since every ply is trimmed at them`);
  const trialPens = checkInksRead(ply, { trialInks: stack.defaults?.trialInks === true });
  const declared = (p: Piece) => Object.fromEntries(Object.entries({
    ...Object.fromEntries(loaded.controls.flatMap(c => ('default' in c ? [[c.id, c.default]] : []))), ...stack.params, ...p.params,
  }).filter(([k]) => k !== spec.control));
  const siblings = stack.pieces.filter(p => p.assembly === name && slug(p.name) !== slug(piece.name));
  for (const q of siblings) {
    if (resolve(ROOT, q.sketch) !== resolve(ROOT, piece.sketch)) fail(`assembly ${name}: ${q.name} is made from ${q.sketch}, but ${piece.name} from ${piece.sketch}`);
    if (q.seed !== piece.seed) fail(`assembly ${name}: ${q.name} has seed ${q.seed}, but ${piece.name} has seed ${piece.seed}`);
    const other = plyOf(stack, q, loaded).ply;
    if (other.id === ply.id) fail(`assembly ${name}: ply ${ply.id} is made by both ${piece.name} and ${q.name}`);
    if (other.onlay) fail(`assembly ${name}: ${q.name} is ply ${other.id}, an onlay plotted and cut on ${other.onlay.from}: onlays are never finalized`);
    if (canonical(declared(q)) !== canonical(declared(piece))) fail(`assembly ${name}: ${q.name} and ${piece.name} differ in params other than ${spec.control}, so they would not draw one world`);
  }
  return { name, spec, ply, index, siblings, trialPens };
}

/** The forced options of an assembly ply: its own paper as the palette, nothing recentred, nothing merged. */
function assemblyOptions(options: FinalizeOptions, ply: PlySpec): FinalizeOptions {
  const palette: Palette = { id: `ply-${ply.paper.id}`, label: `${ply.id} on ${ply.paper.id}`, paper: ply.paper.color, inks: [] };
  // Recentring would move each ply's art by its own bounds and break registration; merging puts layers on one pen,
  // which makes the pen plan differ from the canonical render, and then no config.json is written.
  return { ...options, palette, center: 'none', mergeSameColor: false };
}

/** Finishing for a ply: the sketch's own pen colours, the cut pen inked as the ply's cut ink, the ply's paper. */
function assemblyFinishing(stack: Stack, page: Page, pens: Pen[], plan: Pick<AssemblyPlan, 'spec' | 'ply'>) {
  const ink = pens.find(p => p.id === plan.ply.cutInk) ?? fail(`ply ${plan.ply.id} cutInk ${plan.ply.cutInk} is not a declared pen`);
  return {
    ...(stack.border ? { border: stack.border } : {}),
    page: { width: page.width, height: page.height, margin: page.margin ?? 18, paper: plan.ply.paper.color },
    pens: { [plan.spec.cutPen]: { color: ink.color, width: ink.width } },
  };
}

const pieceDir = (stack: Stack, piece: Piece) => resolve(ROOT, stack.out, slug(piece.name));
const hasResult = (stack: Stack, piece: Piece) => existsSync(join(pieceDir(stack, piece), 'source', 'result.json'));

/** The render request an assembly piece is asked for: what `request.json` records, and what a result on disk must still match. */
function assemblyRequest(stack: Stack, piece: Piece, loaded: LoadedSketch, overrides: Record<string, unknown>) {
  const plan = plyOf(stack, piece, loaded, overrides);
  const { page, pens, controls } = loaded;
  return { seed: piece.seed, params: withOverrides(stack, piece, controls, { ...titleOverrides(stack, controls, buildVersion(stack.edition)), ...overrides }), finishing: assemblyFinishing(stack, page, pens, plan) };
}

const deepCanonical = (value: unknown): string => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) : v));

/**
 * The result of a piece of an assembly on disk, for a piece that is not in this run: undefined when it has none, an
 * error when it is not what the stack now asks for (its request.json, which holds the seed, params, page, finishing and
 * border, or its sketch, differs), since a result from before an edit would be compared with the plies being drawn now.
 */
async function currentResult(stack: Stack, piece: Piece): Promise<PlyResult | undefined> {
  if (!hasResult(stack, piece)) return undefined;
  const dir = pieceDir(stack, piece);
  const loaded = await loadSketch(stack, piece.sketch);
  const asked = JSON.parse(JSON.stringify(assemblyRequest(stack, piece, loaded, {}))) as Record<string, unknown>;
  const requestPath = join(dir, 'request.json');
  const had = existsSync(requestPath) ? JSON.parse(readFileSync(requestPath, 'utf8')) as Record<string, unknown> : {};
  const result = readPlyResult(dir);
  const differs = ['seed', 'params', 'finishing'].filter(k => deepCanonical(had[k]) !== deepCanonical(asked[k]));
  if (result.metadata.name !== loaded.name) differs.push('sketch');
  if (differs.length) fail(`${piece.name} is stale on disk: finalize it in this run (changed since it was finalized: ${differs.join(', ')})`);
  return result;
}

/** A ply of an assembly in this run, rendered into staging and not yet checked or in place. */
interface Staged { piece: Piece; plan: AssemblyPlan; dir: string; live: string; report: PieceReport }

/**
 * Every onlay of every assembly in the stack that involves an assembly of this run, checked against the part it is cut
 * from: the part must exist (a part cut with that id on that ply of that assembly), and the footprint must be congruent
 * to it, which fits a rigid transform and bounds its residual. The assemblies of the run must be able to resolve their
 * own onlays (the source ply in the run, or finalized and current on disk); an assembly that merely supplies a part is
 * checked only against onlay panels that have a current result. Panels that do not involve the run are not looked at,
 * so a malformed onlay in one of them blocks nothing.
 */
async function checkOnlays(stack: Stack, run: Piece[], resultOf: (piece: Piece, optional?: boolean) => Promise<PlyResult | undefined>): Promise<void> {
  const runGroups = new Set(run.flatMap(p => (p.assembly ? [p.assembly] : [])));
  const groups = new Map<string, { spec: AssemblySpec; loaded: LoadedSketch; pieces: Piece[] }>();
  for (const name of new Set(stack.pieces.flatMap(p => (p.assembly ? [p.assembly] : [])))) {
    const pieces = stack.pieces.filter(p => p.assembly === name);
    const loaded = await loadSketch(stack, pieces[0].sketch);
    if (loaded.assembly) groups.set(name, { spec: loaded.assembly, loaded, pieces });
  }
  const plyIdOf = (group: { loaded: LoadedSketch }, piece: Piece) => plyOf(stack, piece, group.loaded).ply.id;
  for (const [name, group] of groups) {
    for (const onlay of group.spec.plies.filter(p => p.onlay)) {
      const from = onlay.onlay!.from;
      const strict = runGroups.has(name);
      // Only the panels that involve this run are read at all, so the source is parsed after that is known.
      const ref = strict ? parseFrom(from) : tryParseFrom(from);
      if (!ref || (!strict && !runGroups.has(ref.assembly))) continue;
      const label = `onlay ${onlay.id} of ${name} (${from})`;
      const source = groups.get(ref.assembly);
      if (!source) { if (strict) fail(`${label}: no piece of assembly ${ref.assembly} is in the stack`); continue; }
      const sourcePly = source.spec.plies.find(p => p.id === ref.ply);
      if (!sourcePly || sourcePly.onlay) fail(`${label}: assembly ${ref.assembly} has no sheet ply ${ref.ply}`);
      const sourcePiece = source.pieces.find(m => plyIdOf(source, m) === ref.ply);
      const sourceResult = sourcePiece ? await resultOf(sourcePiece) : undefined;
      if (!sourcePiece || !sourceResult) {
        if (strict) fail(`${label}: finalize ${sourcePiece?.name ?? `ply ${ref.ply} of ${ref.assembly}`} first, so the part can be checked`);
        continue;
      }
      let targetResult: PlyResult | undefined;
      if (strict) targetResult = await resultOf(run.find(p => p.assembly === name)!);
      else for (const m of group.pieces) if ((targetResult = await resultOf(m, true))) break;
      if (!targetResult) continue;
      const cut = plyCuts(sourceResult.parts, source.spec, ref.ply).find(c => c.id === ref.cut);
      if (cut?.kind !== 'part') fail(`${label}: ply ${ref.ply} of ${ref.assembly} has no part cut ${ref.cut}${cut ? ` (it is a ${cut.kind} cut)` : ''}`);
      const part = worldCuts(sourceResult.parts, source.spec).find(c => c.ply === ref.ply && c.id === ref.cut)!;
      const footprints = worldCuts(targetResult.parts, group.spec).filter(c => c.ply === onlay.id);
      if (footprints.length !== 1) fail(`${label}: the render has ${footprints.length} footprint cuts for ply ${onlay.id}, not one`);
      congruentFit(part.rings, footprints[0].rings, label);
    }
  }
}

/**
 * The checks across the plies of a run, once every one of them is staged: against the other plies of their panel, staged
 * or current on disk, each ply must have been finished on the same page and border and draw one world (every ply's cuts
 * and the signature box, in finished millimetres); then the onlays are checked (see `checkOnlays`). Throws on the first
 * problem; nothing has been moved into place.
 */
async function checkAssemblyRun(stack: Stack, staged: Staged[]): Promise<void> {
  const resultOf = async (piece: Piece, optional = false): Promise<PlyResult | undefined> => {
    const inRun = staged.find(s => slug(s.piece.name) === slug(piece.name));
    if (inRun) return readPlyResult(inRun.dir);
    try { return await currentResult(stack, piece); } catch (error) { if (optional) return undefined; throw error; }
  };
  for (const s of staged) {
    const mine = readPlyResult(s.dir);
    const world = worldSha256(mine.parts);
    for (const q of s.plan.siblings) {
      const theirs = await resultOf(q);
      if (!theirs) continue;
      const apart = registrationProblem(mine, theirs);
      if (apart) fail(`assembly ${s.plan.name}: ${q.name} and ${s.piece.name} were not finalized on the same page and border: ${apart}`);
      if (worldSha256(theirs.parts) !== world) {
        const border = stack.border as { inset?: number; contentGap?: number } | undefined;
        const spaced = border?.inset !== undefined || border?.contentGap !== undefined;
        fail(`assembly ${s.plan.name}: ${q.name} and ${s.piece.name} do not draw one world: their cuts differ (same seed and params, so the sketch's cuts depend on the ply${spaced
          ? ', or the stack border sets inset or contentGap, which fits the page to the width of the cut ink and so moves the plies whose cut inks differ in width: leave both out'
          : ', or the page fit moved'}, or ${q.name} was finalized from an older version of the sketch: finalize every ply in one run)`);
      }
    }
  }
  await checkOnlays(stack, staged.map(s => s.piece), resultOf);
}

/** The report's assembly record for a ply that has been rendered into `dir`. */
function assemblyReportOf(plan: AssemblyPlan, result: PlyResult): AssemblyReport {
  const { spec, ply, name } = plan;
  const signature = spec.signature?.ply === ply.id ? { pen: spec.signature.pen, box: signatureBox(result.parts) ?? fail(`ply ${ply.id} has no signature box in its render`) } : undefined;
  return {
    name, ply: ply.id, index: plan.index + 1, plies: spec.plies.length, paper: { ...ply.paper }, cutPen: spec.cutPen, cutInk: ply.cutInk, trialPens: plan.trialPens,
    ...(ply.lift === undefined ? {} : { lift: ply.lift }),
    cuts: plyCuts(result.parts, spec, ply.id),
    onlays: spec.plies.filter(p => p.onlay).map(p => ({ ply: p.id, from: p.onlay!.from })),
    ...(signature ? { signature } : {}),
    worldSha256: worldSha256(result.parts),
  };
}

/** Staging directories of runs that are no longer alive (killed before they could clean up). */
function clearDeadStaging(out: string): void {
  if (!existsSync(out)) return;
  for (const name of readdirSync(out)) {
    const pid = /^\.staging-(\d+)$/.exec(name)?.[1];
    if (!pid) continue;
    let alive = true;
    try { process.kill(Number(pid), 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code === 'EPERM'; }
    if (!alive) rmSync(join(out, name), { recursive: true, force: true });
  }
}

/** Moves each staged ply over its live directory, all or none: on a failure the directories it replaced are put back. */
function commitStaged(staged: Staged[], staging: string): void {
  const previous = join(staging, '.previous');
  const done: { live: string; old?: string }[] = [];
  try {
    for (const s of staged) {
      let old: string | undefined;
      if (existsSync(s.live)) { mkdirSync(previous, { recursive: true }); old = join(previous, slug(s.piece.name)); renameSync(s.live, old); }
      done.push({ live: s.live, old });
      mkdirSync(dirname(s.live), { recursive: true });
      renameSync(s.dir, s.live);
    }
  } catch (error) {
    for (const d of done.reverse()) {
      rmSync(d.live, { recursive: true, force: true });
      if (d.old) renameSync(d.old, d.live);
    }
    throw error;
  }
}

interface Layer { index: number; label: string; color: string; attrs: Record<string, string>; bounds: Bounds | null }
interface Bounds { x0: number; y0: number; x1: number; y1: number }

/** Read numbered layer groups and the bounds of their path coordinates (sketch SVGs use absolute M/L in mm). */
export function readLayers(svg: string): Layer[] {
  const layers: Layer[] = [];
  const parts = svg.split(/(?=<g\b[^>]*inkscape:groupmode="layer")/).slice(1);
  for (const part of parts) {
    const open = /^<g\b([^>]*)>/.exec(part)?.[1] ?? '';
    const attrs: Record<string, string> = {};
    for (const m of open.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
    const label = attrs['inkscape:label'] ?? '';
    const index = Number(/^(\d+)/.exec(label)?.[1]);
    let b: Bounds | null = null;
    for (const m of part.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) {
      const x = Number(m[1]), y = Number(m[2]);
      b = b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
    }
    layers.push({ index, label, color: attrs.stroke ?? '#000000', attrs, bounds: b });
  }
  return layers;
}

/**
 * Remove pen layers that hold no path. vpype drops an empty layer from the prepared file, so a canonical
 * render that kept it would disagree with the prepared SVG and the config on the pen-layer count, which
 * plotter-server rejects. Layer labels and numbers are left as they were, so the plan keeps its pen order
 * and a gap in the numbering is harmless. Returns the input untouched when no layer is empty.
 */
export function dropEmptyPenLayers(svg: string): string {
  const chunks = svg.split(/(?=<g\b[^>]*inkscape:groupmode="layer")/);
  let changed = false;
  const kept = chunks.map((chunk, i) => {
    if (i === 0) return chunk;
    // The layer ends at the close that balances its own open tag; what follows (the root's end) is kept.
    let depth = 0, end = -1;
    for (const m of chunk.matchAll(/<g\b[^>]*?(\/?)>|<\/g>/g)) {
      if (m[0] === '</g>') depth--; else if (m[1] !== '/') depth++;
      if (depth === 0) { end = m.index! + m[0].length; break; }
    }
    if (end < 0 || /<path\b/.test(chunk.slice(0, end))) return chunk;
    changed = true;
    return chunk.slice(end).replace(/^\n/, '');
  });
  return changed ? kept.join('') : svg;
}

const isBorder = (l: Layer) => /finishing-border$/.test(l.label);
function union(bs: (Bounds | null)[]): Bounds | null {
  return bs.reduce<Bounds | null>((a, b) => !b ? a : !a ? { ...b } : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }, null);
}

/** Offset (mm) that centers the art bounds inside the area it may occupy. */
export function placementOffset(layers: Layer[], page: Page, stack: Stack, center: FinalizeOptions['center']): { dx: number; dy: number; art: Bounds | null; area: Bounds } {
  const art = union(layers.filter(l => !isBorder(l)).map(l => l.bounds));
  const border = stack.border as { inset?: number; contentGap?: number; style?: string; lineGap?: number } | undefined;
  // Mirrors finishing's content inset: the border's inner line plus half its 0.25 mm stroke.
  const inner = border ? (border.inset ?? 12) + (border.style === 'double' ? border.lineGap ?? DOUBLE_BORDER_INSET : 0) + (border.contentGap ?? 6) + 0.25 : page.margin ?? 18;
  const area = { x0: inner, y0: inner, x1: page.width - inner, y1: page.height - inner };
  if (!art || center === 'none') return { dx: 0, dy: 0, art, area };
  const dy = (area.y0 + area.y1) / 2 - (art.y0 + art.y1) / 2;
  const dx = center === 'both' ? (area.x0 + area.x1) / 2 - (art.x0 + art.x1) / 2 : 0;
  return { dx: Math.round(dx * 1000) / 1000, dy: Math.round(dy * 1000) / 1000, art, area };
}

function vpype(args: string[]): string {
  const run = spawnSync('vpype', args, { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (run.error) fail(`vpype is not available on PATH: ${run.error.message}`);
  if (run.status !== 0) fail(`vpype failed (${run.status}): ${run.stderr.trim().split('\n').slice(-3).join(' ')}`);
  return run.stdout;
}

export interface LayerStats { layer: number; label: string; color: string; passes: number; paths: number; drawMm: number; travelMm: number; minutes: number }
export function parseStat(text: string): Omit<LayerStats, 'label' | 'color' | 'passes' | 'minutes'>[] {
  const out: Omit<LayerStats, 'label' | 'color' | 'passes' | 'minutes'>[] = [];
  for (const block of text.split(/\n(?=Layer \d+)/).slice(1)) {
    const num = (name: string) => Number(new RegExp(`${name}:\\s*([\\d.]+)`).exec(block)?.[1] ?? 0);
    out.push({ layer: Number(/^Layer (\d+)/.exec(block)![1]), paths: num('Path count'), drawMm: num('Length') * MM_PER_PX, travelMm: num('Pen-up length') * MM_PER_PX });
  }
  return out;
}

/**
 * Re-emit vpype's geometry in the sketch SVG grammar that plotter-server accepts: the canonical root tag,
 * one canonical layer tag per layer (label, pen id, passes, stroke, width), and plain <path d> in millimetres.
 * vpype writes px units, <line>/<polyline>/<polygon>, metadata and style attributes, which the server rejects.
 */
export function toSketchGrammar(vpypeSvg: string, sourceSvg: string, plan: Map<number, { label: string; penId?: string; passes: number }>): string {
  const root = /<svg\b[^>]*>/.exec(sourceSvg)?.[0] ?? fail('Source SVG has no root');
  const sourceTags = new Map<number, string>();
  for (const m of sourceSvg.matchAll(/<g\b[^>]*inkscape:groupmode="layer"[^>]*>/g)) {
    const n = Number(/inkscape:label="(\d+)-/.exec(m[0])?.[1]);
    if (Number.isFinite(n)) sourceTags.set(n, m[0]);
  }
  const mm = (v: string) => String(Math.round(Number(v) * MM_PER_PX * 1000) / 1000);
  const pairs = (points: string) => points.trim().split(/\s+/).map(pair => pair.split(',').map(mm).join(','));
  const layers: string[] = [];
  for (const part of vpypeSvg.split(/(?=<g\b[^>]*inkscape:groupmode="layer")/).slice(1)) {
    const n = Number(/id="layer(\d+)"/.exec(part)?.[1]);
    const meta = plan.get(n);
    const tag = sourceTags.get(n);
    if (!meta || !tag) fail(`Prepared layer ${n} has no source layer`);
    const body = part.slice(0, part.indexOf('</g>'));
    const paths: string[] = [];
    for (const el of body.matchAll(/<(polyline|polygon|line|path)\b([^>]*)\/?>/g)) {
      const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(el[2])?.[1] ?? '';
      let pts: string[];
      if (el[1] === 'line') pts = [`${mm(attr('x1'))},${mm(attr('y1'))}`, `${mm(attr('x2'))},${mm(attr('y2'))}`];
      else if (el[1] === 'path') fail('Unexpected <path> in vpype output; extend toSketchGrammar before using it');
      else { pts = pairs(attr('points')); if (el[1] === 'polygon') pts.push(pts[0]); }
      paths.push(`<path d="M${pts.join('L')}"/>`);
    }
    const open = tag.replace(/inkscape:label="[^"]*"/, `inkscape:label="${meta.label}"`).replace(/data-passes="[^"]*"/, `data-passes="${meta.passes}"`);
    layers.push(`${open}\n${paths.join('\n')}\n</g>`);
  }
  return `${root}\n${layers.join('\n')}\n</svg>\n`;
}

/**
 * plotter-server's sketch queue config (format hatch3d-sketch-v1), as the viewer's upload plugin writes it:
 * page and pens must match the prepared SVG's units and layers, which the server checks on import.
 */
/**
 * The pen plotter-server names when it asks for a layer ("Load pen", and the phone notice), as `name` on the layer:
 * the stack's `penNames` first; then, for a ply of an assembly, the catalog's physical pen for its ink, the cut guides
 * and crop marks being drawn with the ply's cut ink. Undefined leaves the server showing the layer id.
 */
export function penName(id: string, stack: Pick<Stack, 'penNames'>, assembly?: Pick<AssemblyReport, 'cutPen' | 'cutInk'>): string | undefined {
  const own = stack.penNames && Object.prototype.hasOwnProperty.call(stack.penNames, id) ? stack.penNames[id] : undefined;
  if (own) return own;
  if (!assembly) return undefined;
  const role = id === assembly.cutPen ? ' (cut guides)' : id === 'finishing-border' ? ' (crop marks)' : '';
  const ink = role ? assembly.cutInk : id;
  const pen = Object.prototype.hasOwnProperty.call(INKS, ink) ? INKS[ink].pen : undefined;
  return pen ? `${pen}${role}` : undefined;
}

export function serverConfig(resultPath: string, sourceSvg: string, report: PieceReport, name: (id: string) => string | undefined = () => undefined): Record<string, unknown> {
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { identity: string; metadata: { name: string; page: Page; pens: (Pen & { passes?: number })[] }; params: unknown; effectiveParams?: unknown; seed: number; finishing?: unknown };
  const partsByPen = new Map<string, string[]>();
  for (const layer of sourceSvg.split(/(?=<g\b[^>]*inkscape:groupmode="layer")/).slice(1)) {
    const pen = /data-pen-id="([^"]*)"/.exec(layer)?.[1];
    if (pen) partsByPen.set(pen, [...layer.matchAll(/data-part-id="([^"]*)"/g)].map(m => m[1]));
  }
  // Only the pens that still have a layer in the canonical SVG (dropEmptyPenLayers removes the ones that draw nothing).
  const pens = result.metadata.pens.filter(pen => partsByPen.has(pen.id));
  return {
    format: 'hatch3d-sketch-v1', identity: result.identity, composition: 'sketch', presetName: `${report.title} · seed ${report.seed}`,
    page: result.metadata.page, pens,
    layers: pens.map(pen => { const label = name(pen.id); return { id: pen.id, ...(label ? { name: label } : {}), color: pen.color, width: pen.width, passes: pen.passes ?? 1, parts: partsByPen.get(pen.id) ?? [] }; }),
    params: result.params, ...(result.effectiveParams ? { effectiveParams: result.effectiveParams } : {}), seed: result.seed,
    ...(result.finishing ? { finishing: result.finishing } : {}),
    stats: { pathCount: report.layers.reduce((t, l) => t + l.paths, 0), lengthMm: Math.round(report.layers.reduce((t, l) => t + l.drawMm, 0)) },
    preparation: { schema_version: 1, tool: 'hatch3d finalize (python vpype)', source_sha256: report.sourceSha256, prepared_sha256: report.preparedSha256 },
  };
}

export interface PieceReport {
  name: string; title: string; seed: number; palette: string; paper: string; offset: { dx: number; dy: number };
  build: BuildVersion; printedTitle: string | null;
  margins: { top: number; bottom: number } | null; layers: LayerStats[]; pens: number; minutes: number;
  /** Same numbered layers, labels and passes as the canonical source, so plotter-server's pen-plan check can pass. */
  serverCompatible: boolean;
  files: { source: string; sourcePng: string; prepared: string; preparedPng: string }; sourceSha256: string; preparedSha256: string;
  /** Only for a ply of an assembly: which ply of which panel, its cuts, and the fingerprint of the world it drew. */
  assembly?: AssemblyReport;
  /**
   * What `cli/ink-check.ts` found in the prepared SVG: parallel lines closer than the pen holds apart, and ink near the
   * cut outlines, with its warnings (the same report is in `ink-check.json` beside an overlay, `ink-check.png`).
   * Never fails a finalize. Absent when the piece's paper is not one the materials catalog has measurements for.
   */
  inkCheck?: InkCheckSummary;
}

/**
 * Renders and prepares one piece into `dir`, which is its live directory except when it is staged (then `liveDir` is
 * where it will be moved, and what the report records). A ply of an assembly is finished with its own paper and the
 * sketch's own pens; any other piece gets the palette.
 */
async function produce(stack: Stack, piece: Piece, loaded: LoadedSketch, asm: AssemblyPlan | undefined, requested: FinalizeOptions, overrides: Record<string, unknown>, dir: string, liveDir: string): Promise<PieceReport> {
  const { page, pens, controls } = loaded;
  const options = asm ? assemblyOptions(requested, asm.ply) : requested;
  if (!asm) {
    const inked = pens.filter(p => p.id !== 'lettering').length;
    if (options.palette.inks.length < inked) fail(`Palette ${options.palette.id} has ${options.palette.inks.length} inks for ${inked} pens`);
  }
  const build = buildVersion(stack.edition);
  const request = asm ? assemblyRequest(stack, piece, loaded, overrides)
    : { seed: piece.seed, params: withOverrides(stack, piece, controls, { ...titleOverrides(stack, controls, build), ...overrides }), finishing: finishingFor(stack, page, pens, options.palette) };
  const sourcePath = await renderSource(piece, request, dir);
  const assembly = asm ? assemblyReportOf(asm, readPlyResult(dir)) : undefined;
  const rendered = readFileSync(sourcePath, 'utf8');
  // A pen that draws nothing on this piece (an empty part on a small card) is not a layer to plot: drop it from the
  // canonical render, so that render, the prepared SVG and the config agree on the pen layers.
  const source = dropEmptyPenLayers(rendered);
  if (source !== rendered) writeFileSync(sourcePath, source);
  const layers = readLayers(source);
  // The signature goes into a layer that already exists, since plotter-server rejects a changed layer count.
  const signing = asm?.spec.signature;
  if (asm && signing?.ply === asm.ply.id && !layers.some(l => l.attrs['data-pen-id'] === signing.pen)) {
    fail(`ply ${asm.ply.id} has no ${signing.pen} layer to sign into: its signature pen draws nothing here, and a signature would need a new layer, which plotter-server rejects`);
  }
  const finalPage: Page = { ...page, paper: options.palette.paper };
  const { dx, dy, art, area } = placementOffset(layers, finalPage, stack, options.center);

  // Merge layers that share a color into the lowest-numbered one; the border joins its ink's layer too.
  // Same ink, same pass count and same width only: merging must not change how any stroke is drawn.
  const byColor = new Map<string, Layer[]>();
  for (const l of layers) {
    const key = [l.color.toLowerCase(), l.attrs['data-passes'] ?? '1', l.attrs['stroke-width'] ?? ''].join('|');
    byColor.set(key, [...(byColor.get(key) ?? []), l]);
  }
  const moves: string[][] = [];
  const plan = new Map<number, { label: string; penId?: string; passes: number }>();
  for (const group of byColor.values()) {
    const sorted = [...group].sort((a, b) => a.index - b.index);
    const keep = sorted[0];
    const merged = options.mergeSameColor ? sorted : [keep];
    if (options.mergeSameColor && sorted.length > 1) moves.push(['lmove', sorted.slice(1).map(l => l.index).join(','), String(keep.index)]);
    const names = merged.map(l => l.label.replace(/^\d+-/, ''));
    plan.set(keep.index, { label: `${keep.index}-${names.join('+')}`, penId: keep.attrs['data-pen-id'], passes: Number(keep.attrs['data-passes'] ?? 1) });
    if (!options.mergeSameColor) for (const l of sorted.slice(1)) plan.set(l.index, { label: l.label, penId: l.attrs['data-pen-id'], passes: Number(l.attrs['data-passes'] ?? 1) });
  }
  const artLayers = layers.filter(l => !isBorder(l)).map(l => l.index).join(',');
  const preparedPath = join(dir, 'plot-ready.svg');
  const v = options.vpype;
  const args = ['read', sourcePath,
    ...(dx || dy ? ['translate', '-l', artLayers, '--', `${dx}mm`, `${dy}mm`] : []),
    ...moves.flat(),
    'linemerge', '--tolerance', `${v.mergeTolerance}mm`,
    ...(v.sort ? ['linesort'] : []),
    ...(v.reloop ? ['reloop'] : []),
    'linesimplify', '--tolerance', `${v.simplifyTolerance}mm`,
    'filter', '--min-length', `${v.minLength}mm`,
    'write', '--page-size', `${page.width}mmx${page.height}mm`, preparedPath];
  vpype(args);
  const prepared = toSketchGrammar(readFileSync(preparedPath, 'utf8'), source, plan);
  writeFileSync(preparedPath, prepared);
  const stats = parseStat(vpype(['read', preparedPath, 'stat']));
  const layerStats: LayerStats[] = stats.map(s => {
    const meta = plan.get(s.layer);
    const color = layers.find(l => l.index === s.layer)?.color ?? '#000000';
    const passes = meta?.passes ?? 1;
    return { ...s, label: meta?.label ?? `${s.layer}`, color, passes, minutes: passes * 1.1 * (s.drawMm / DRAW_MM_S + s.travelMm / TRAVEL_MM_S) / 60 };
  });
  const minutes = layerStats.reduce((t, l) => t + l.minutes, 0) + Math.max(0, layerStats.length - 1) * SWAP_S / 60;
  writeFileSync(join(dir, 'plot-ready.png'), renderSvgPng(prepared, finalPage, 'paper', 3));
  const inkCheck = checkPrepared(prepared, dir, { paper: asm ? asm.ply.paper.id : paperIdOfColor(options.palette.paper), paperColor: options.palette.paper, ...(asm ? { cutPen: asm.spec.cutPen } : {}) });
  const after = art ? { y0: art.y0 + dy, y1: art.y1 + dy } : null;
  const report: PieceReport = {
    name: piece.name, title: piece.title ?? piece.name, seed: piece.seed, palette: options.palette.id, paper: options.palette.paper,
    build, printedTitle: request.params.titleEnabled === true ? String(request.params.title) : null,
    offset: { dx, dy }, margins: after ? { top: +(after.y0 - area.y0).toFixed(2), bottom: +(area.y1 - after.y1).toFixed(2) } : null,
    layers: layerStats, pens: layerStats.length, minutes: Math.round(minutes), serverCompatible: moves.length === 0,
    files: { source: relative(ROOT, join(liveDir, 'source', 'render.svg')), sourcePng: relative(ROOT, join(liveDir, 'source', 'render.png')), prepared: relative(ROOT, join(liveDir, 'plot-ready.svg')), preparedPng: relative(ROOT, join(liveDir, 'plot-ready.png')) },
    sourceSha256: sha256(source), preparedSha256: sha256(prepared),
    ...(assembly ? { assembly } : {}),
    ...(inkCheck ? { inkCheck } : {}),
  };
  if (report.serverCompatible) writeFileSync(join(dir, 'config.json'), JSON.stringify(serverConfig(join(dir, 'source', 'result.json'), source, report, (id) => penName(id, stack, report.assembly)), null, 2));
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ ...report, options, overrides, vpypeArgs: args.map(a => (dir !== liveDir && a.startsWith(dir) ? liveDir + a.slice(dir.length) : a)).map(a => a.startsWith(ROOT) ? relative(ROOT, a) : a) }, null, 2));
  return report;
}

/**
 * Finalizes pieces. A plain piece is written straight to its directory. The plies of an assembly are staged: every one
 * of them is rendered and prepared into `<out>/.staging-<pid>/`, checked against each other and against the plies of
 * their panels that are not in the run (read from disk only while they are current), and only then moved into place,
 * all together. A run that fails leaves every live directory as it was. `onReport` hears each report as its piece is done.
 */
export async function finalizeRun(stack: Stack, pieces: Piece[], requested: FinalizeOptions, overrides: Record<string, unknown> = {}, onReport?: (report: PieceReport) => void): Promise<PieceReport[]> {
  const prepared: { piece: Piece; loaded: LoadedSketch; asm: AssemblyPlan | undefined }[] = [];
  for (const piece of pieces) {
    const loaded = await loadSketch(stack, piece.sketch);
    prepared.push({ piece, loaded, asm: await planAssembly(stack, piece, loaded, overrides) });
  }
  const out = resolve(ROOT, stack.out);
  const staging = join(out, `.staging-${process.pid}`);
  const reports = new Map<Piece, PieceReport>();
  const staged: Staged[] = [];
  if (prepared.some(p => p.asm)) clearDeadStaging(out);
  try {
    for (const { piece, loaded, asm } of prepared) {
      const live = pieceDir(stack, piece);
      if (!asm) {
        const report = await produce(stack, piece, loaded, undefined, requested, overrides, live, live);
        reports.set(piece, report);
        onReport?.(report);
        continue;
      }
      const dir = join(staging, slug(piece.name));
      staged.push({ piece, plan: asm, dir, live, report: await produce(stack, piece, loaded, asm, requested, overrides, dir, live) });
    }
    if (staged.length) {
      await checkAssemblyRun(stack, staged);
      commitStaged(staged, staging);
      for (const s of staged) { reports.set(s.piece, s.report); onReport?.(s.report); }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return pieces.map(p => reports.get(p)!);
}

export async function finalizePiece(stack: Stack, piece: Piece, requested: FinalizeOptions, overrides: Record<string, unknown> = {}): Promise<PieceReport> {
  return (await finalizeRun(stack, [piece], requested, overrides))[0];
}

export function resolveOptions(stack: Stack, override: Partial<Omit<FinalizeOptions, 'palette'>> & { palette?: Palette | string } = {}): FinalizeOptions {
  const pick = override.palette ?? stack.defaults?.palette ?? 'phase-garden';
  const palette = typeof pick === 'string' ? PALETTES.find(p => p.id === pick) ?? fail(`Unknown palette ${pick}`) : pick;
  if (!/^#[0-9a-f]{6}$/i.test(palette.paper) || !palette.inks.length || palette.inks.some(c => !/^#[0-9a-f]{6}$/i.test(c))) fail('Palette colors must be #rrggbb');
  const d = stack.defaults ?? {};
  return {
    palette,
    center: override.center ?? d.center ?? DEFAULT_OPTIONS.center,
    mergeSameColor: override.mergeSameColor ?? d.mergeSameColor ?? DEFAULT_OPTIONS.mergeSameColor,
    vpype: { ...DEFAULT_OPTIONS.vpype, ...d.vpype, ...override.vpype },
  };
}

export function loadStack(path: string): Stack {
  const stack = JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as Stack;
  if (!stack.out || !Array.isArray(stack.pieces) || !stack.pieces.length) fail('Stack needs out and pieces');
  const sheet = stack.page as Record<string, unknown> | undefined;
  const mm = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (sheet !== undefined && (typeof sheet !== 'object' || sheet === null || !mm(sheet.width) || !mm(sheet.height) || (sheet.margin !== undefined && !(mm(sheet.margin) || sheet.margin === 0))
    || Object.keys(sheet).some(k => !['width', 'height', 'margin'].includes(k)))) fail('Stack page must be { width, height, margin? } in millimetres');
  if (stack.defaults?.trialInks !== undefined && typeof stack.defaults.trialInks !== 'boolean') fail('Stack defaults.trialInks must be true or false');
  if (stack.penNames !== undefined && (typeof stack.penNames !== 'object' || stack.penNames === null || Array.isArray(stack.penNames) ||
      Object.values(stack.penNames).some((v) => typeof v !== 'string' || !v.trim()))) fail('Stack penNames must map layer ids to pen names');
  const names = new Set<string>();
  for (const p of stack.pieces) {
    if (!p.name || !p.sketch || !Number.isSafeInteger(p.seed)) fail('Each piece needs name, sketch and an integer seed');
    if (names.has(slug(p.name))) fail(`Duplicate piece ${p.name}`);
    names.add(slug(p.name));
  }
  return stack;
}

const TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.html': 'text/html; charset=utf-8' };

async function serve(stackPath: string, port: number) {
  const stack = loadStack(stackPath);
  const outRoot = resolve(ROOT, stack.out);
  const ui = readFileSync(join(ROOT, 'cli/finalize/ui.html'), 'utf8');
  // Preview renders in the default palette; the page recolors layers live. Variants are keyed by their overrides.
  const basePalette = resolveOptions(stack).palette;
  const pieceInfo = new Map<string, { pens: Pen[]; controls: Control[] }>();
  for (const piece of stack.pieces) pieceInfo.set(slug(piece.name), await loadSketch(stack, piece.sketch));
  const variants = new Map<string, Map<string, string>>();
  const variantKey = (overrides: Record<string, unknown>) => sha256(JSON.stringify(Object.keys(overrides).sort().map(k => [k, overrides[k]]))).slice(0, 12);
  async function renderVariant(overrides: Record<string, unknown>, slugs: string[]): Promise<{ key: string; svgs: Record<string, string> }> {
    const key = variantKey(overrides);
    const cache = variants.get(key) ?? new Map<string, string>();
    variants.set(key, cache);
    const todo = stack.pieces.filter(p => slugs.includes(slug(p.name)) && !cache.has(slug(p.name)));
    for (let i = 0; i < todo.length; i += 3) {
      await Promise.all(todo.slice(i, i + 3).map(async piece => {
        cache.set(slug(piece.name), await previewPiece(stack, piece, basePalette, overrides, resolve(ROOT, stack.out, '_preview', key, slug(piece.name))));
      }));
    }
    return { key, svgs: Object.fromEntries(slugs.filter(s => cache.has(s)).map(s => [s, cache.get(s)!])) };
  }
  await renderVariant({}, stack.pieces.map(p => slug(p.name)));
  console.log(`previews ready: ${stack.pieces.length} pieces`);
  // Slogan controls are offered only when every piece declares them.
  const sloganControls = stack.pieces.every(p => pieceInfo.get(slug(p.name))!.controls.some(c => c.group === 'Slogan'))
    ? pieceInfo.get(slug(stack.pieces[0].name))!.controls.filter(c => c.group === 'Slogan')
      // The panel starts from the stack's own settings, so regenerating never silently reverts them.
      .map(c => stack.params && c.id in stack.params ? { ...c, default: stack.params[c.id] } as Control : c) : [];
  let busy = false;
  const readJson = async (req: AsyncIterable<unknown>) => {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 1 << 20) fail('Request too large'); }
    return JSON.parse(body);
  };
  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (code: number, body: string | Buffer, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(200, ui, TYPES['.html']);
      if (req.method === 'GET' && url.pathname === '/api/stack') {
        return send(200, JSON.stringify({ title: stack.title ?? 'Finalize', palettes: PALETTES, defaults: resolveOptions(stack), build: buildVersion(stack.edition), printTitle: stack.printTitle ?? null, borderPen: (stack.border as { pen?: string } | undefined)?.pen ?? null, sloganControls,
          pieces: stack.pieces.map(p => ({ ...p, slug: slug(p.name), pens: pieceInfo.get(slug(p.name))!.pens })) }));
      }
      const preview = /^\/api\/preview\/([a-z0-9-]+)\.svg$/.exec(url.pathname);
      const base = variants.get(variantKey({}));
      if (req.method === 'GET' && preview && base?.has(preview[1])) return send(200, base.get(preview[1])!, TYPES['.svg']);
      if (req.method === 'GET' && url.pathname.startsWith('/out/')) {
        const file = resolve(outRoot, decodeURIComponent(url.pathname.slice(5)));
        if (!file.startsWith(outRoot + '/') || !existsSync(file)) return send(404, '{"error":"not found"}');
        return send(200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
      }
      if (req.method === 'POST' && (url.pathname === '/api/finalize' || url.pathname === '/api/preview')) {
        if (busy) return send(409, JSON.stringify({ error: 'Another run is already in progress' }));
        // Local-only tool: refuse cross-site form posts.
        if (!String(req.headers['content-type']).startsWith('application/json') || (req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(req.headers.origin))) {
          return send(403, JSON.stringify({ error: 'JSON from this page only' }));
        }
        busy = true;
        try {
          const input = await readJson(req) as { pieces: string[]; params?: Record<string, unknown>; palette: Palette; center: FinalizeOptions['center']; mergeSameColor: boolean; vpype: Partial<VpypeOptions> };
          const overrides = input.params && typeof input.params === 'object' ? input.params : {};
          if (url.pathname === '/api/preview') return send(200, JSON.stringify(await renderVariant(overrides, input.pieces ?? [])));
          const options = resolveOptions(stack, { palette: input.palette, center: input.center, mergeSameColor: input.mergeSameColor, vpype: input.vpype as VpypeOptions });
          const chosen = stack.pieces.filter(p => input.pieces.includes(slug(p.name)));
          if (!chosen.length) return send(400, '{"error":"no pieces selected"}');
          const reports = await finalizeRun(stack, chosen, options, overrides);
          return send(200, JSON.stringify({ reports: reports.map(r => ({ ...r, url: `/out/${slug(r.name)}/` })) }));
        } finally { busy = false; }
      }
      send(404, '{"error":"not found"}');
    } catch (error) {
      send(500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }).listen(port, '127.0.0.1', () => console.log(`finalize: http://127.0.0.1:${port}/  (stack ${stackPath}, output ${relative(ROOT, outRoot)})`));
}

async function main(argv: string[]) {
  const [command, stackPath, ...rest] = argv;
  const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (!stackPath || (command !== 'run' && command !== 'serve')) fail('Usage: finalize.ts <run|serve> <stack.json> [--only a,b] [--palette id] [--params json] [--merge] [--bump] [--port 8796]');
  if (command === 'serve') return serve(stackPath, Number(flag('port') ?? 8796));
  const stack = loadStack(stackPath);
  if (rest.includes('--bump')) {
    stack.edition = (stack.edition ?? 0) + 1;
    const path = resolve(ROOT, stackPath);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), edition: stack.edition }, null, 2) + '\n');
  }
  const only = flag('only')?.split(',').map(slug);
  const options = resolveOptions(stack, { ...(flag('palette') ? { palette: flag('palette') } : {}), ...(rest.includes('--merge') ? { mergeSameColor: true } : {}) });
  const overrides = flag('params') ? JSON.parse(flag('params')!) as Record<string, unknown> : {};
  await finalizeRun(stack, stack.pieces.filter(p => !only || only.includes(slug(p.name))), options, overrides, r =>
    console.log(JSON.stringify({ name: r.name, title: r.printedTitle, palette: r.palette, offset: r.offset, margins: r.margins, pens: r.pens, minutes: r.minutes, serverCompatible: r.serverCompatible, prepared: r.files.prepared,
      ...(r.inkCheck && ('error' in r.inkCheck ? { inkCheck: r.inkCheck.error } : r.inkCheck.warnings.length ? { inkCheck: r.inkCheck.warnings } : {})) })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exit(1); });
}
