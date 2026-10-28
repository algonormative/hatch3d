import type { AssemblySpec, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { thinRanked } from '../../kit/density.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, insideRing, keepAlong, pathLength } from '../../kit/page.ts';
import { distanceToRings, offsetRing, ringsSimple } from '../../../packages/plot-core/src/region.ts';
import { ALONGSIDE_DEG, FILL_OVER, LINE_PITCH, LODESTONE_ASSEMBLY } from '../lodestone-world.ts';
import { ART, PAGE, PAPER, pensOf } from '../world.ts';
import { gpuMesher } from '../../kit/sculpt-gpu.ts';
import { CONTROLS, cpuMesher, erasure, METALLIC, panelStripes, previewHeadStage, type Erasure, type HeadStage, type Pen, type Seen } from './world.ts';

/**
 * Ka-Codex B, a cut-paper bob variation of Upward Erasure. The gold-yellow sheet shows through the hair and a sparse
 * pixel mosaic, while the black sheet holds the silver face, quiet suit and a fused magenta visor. `world.ts` owns the
 * geometry; this file keeps its source drawing clear of every cut and gives the accent gels their own, unthinned pass.
 */

const plies = [
  { id: 'gold', paper: PAPER.gold, pens: ['black'], cutInk: 'black' },
  { id: 'black', paper: PAPER.black, pens: ['silver', 'gold', 'fluoro-pink', 'gel-rose'], cutInk: 'silver' },
];
export const spec: AssemblySpec = { ...LODESTONE_ASSEMBLY, plies };
// Rose's measured 0.34 mm stroke is faithful for a single line, but the renderer has no model of the gel pooling that
// fuses 0.5 mm rows into a fill. This is an effective display width only: the plotted rose centre lines below still sit
// exactly 0.5 mm apart, while the sweep PNG reads the intended solid rather than six hairlines.
const pens = pensOf(['silver', 'gold', 'fluoro-pink', 'gel-rose', 'black']).map(pen => pen.id === 'gel-rose' ? { ...pen, width: 0.5 } : pen);

type Item = Seen & { piece: Point[] };
type Block = Erasure['blocks'][number];
type BlockBox = Pick<Block, 'x0' | 'x1' | 'y0' | 'y1'>;
const FILL_PITCH = 0.5;
const GEL_CLEAR = 0.8;

/** Fused fills and the rose rule stay whole; only the ordinary engraved marks are density-thinned. */
const ACCENT: Pen[] = ['fluoro-pink', METALLIC];

/** Lines of one sheet kept apart at the pens' pitch (outlines first, then seams and creases, then hatch), by pen. */
function thinned(items: Item[], pitch: number, skip = false): Map<string, Point[][]> {
  const out = new Map<string, Point[][]>();
  // A draft keeps every line (it is on screen for a moment, until the full frame replaces it).
  if (skip) {
    for (const i of items) if (pathLength(i.piece) >= 0.6) {
      const paths = out.get(i.pen) ?? [];
      paths.push(i.piece);
      out.set(i.pen, paths);
    }
    return out;
  }
  for (const { item, runs } of thinRanked(items, pitch, { angle: ALONGSIDE_DEG })) for (const run of runs) if (pathLength(run) >= 0.6) {
    const paths = out.get(item.pen) ?? [];
    paths.push(run);
    out.set(item.pen, paths);
  }
  return out;
}

const inBlock = (block: BlockBox, p: Point, inset = 0) =>
  p.x >= block.x0 + inset && p.x <= block.x1 - inset && p.y >= block.y0 + inset && p.y <= block.y1 - inset;

type Insets = { left: number; right: number; top: number; bottom: number };

/** Fused 0.5 mm gel rows make a rectangular pixel solid; a different grid cell still keeps the physical pitch. */
function blockFill(block: Block, inset: Insets = { left: 0, right: 0, top: 0, bottom: 0 }): Point[][] {
  const rows: Point[][] = [];
  const x0 = block.x0 + inset.left, x1 = block.x1 - inset.right;
  if (x1 - x0 < 0.3) return rows;
  for (let y = block.y0 + FILL_PITCH / 2; y <= block.y1 - FILL_PITCH / 2 + 1e-9; y += FILL_PITCH) {
    if (y >= block.y0 + inset.top && y <= block.y1 - inset.bottom) rows.push([{ x: x0, y }, { x: x1, y }]);
  }
  return rows;
}

/** An inset rose rule has a black-paper gutter to either side, so it remains a line instead of fusing into the visor. */
function visorRule(e: Erasure): Point[][] {
  if (e.visor.length < 3) return e.visorEdge;
  const inset = offsetRing(e.visor, -0.9);
  return inset.length >= 3 && ringsSimple([inset]) ? [[...inset, inset[0]]] : e.visorEdge;
}

/** Coalesce only a fully rectangular gold-cell component: an L shape must not gain ink over its black-paper corner. */
function goldRegions(blocks: Block[]): Block[] {
  const gold = blocks.filter(block => !block.source && block.kind === 'gold');
  const joins = (a: Block, b: Block) => {
    const yOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    const xOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    return (yOverlap > 1e-6 && (Math.abs(a.x1 - b.x0) < 1e-6 || Math.abs(b.x1 - a.x0) < 1e-6))
      || (xOverlap > 1e-6 && (Math.abs(a.y1 - b.y0) < 1e-6 || Math.abs(b.y1 - a.y0) < 1e-6));
  };
  const out: Block[] = [], pending = new Set(gold);
  while (pending.size) {
    const first = pending.values().next().value as Block;
    pending.delete(first);
    const component = [first];
    for (let i = 0; i < component.length; i++) for (const other of [...pending]) if (joins(component[i], other)) {
      component.push(other);
      pending.delete(other);
    }
    const x0 = Math.min(...component.map(block => block.x0)), x1 = Math.max(...component.map(block => block.x1));
    const y0 = Math.min(...component.map(block => block.y0)), y1 = Math.max(...component.map(block => block.y1));
    const rectangular = Math.abs(component.reduce((area, block) => area + (block.x1 - block.x0) * (block.y1 - block.y0), 0) - (x1 - x0) * (y1 - y0)) < 1e-5;
    const sameMove = component.every(block => Math.abs(block.dx - first.dx) < 1e-6 && Math.abs(block.dy - first.dy) < 1e-6);
    if (component.length > 1 && rectangular && sameMove) out.push({ ...first, x0, x1, y0, y1 });
    else out.push(...component);
  }
  return out;
}

/** Keep a solid visor solid even if an exploratory UI value spaces its supplied rows too widely to fuse. */
function fusedVisorRows(e: Erasure): Point[][] {
  if (e.visorRows.length < 2) return e.visorRows;
  const levels = e.visorRows.map(row => e.toBar(row[0]).v).sort((a, b) => a - b);
  if (levels.slice(1).every((v, i) => v - levels[i] <= 0.55 + 1e-6)) return e.visorRows;
  const us = e.visor.map(p => e.toBar(p).u);
  if (!us.length) return e.visorRows;
  const rows: Point[][] = [], u0 = Math.min(...us), u1 = Math.max(...us);
  for (let v = -e.barH + 0.25; v <= -0.25 + 1e-9; v += 0.5) rows.push([e.toPage(u0, v), e.toPage(u1, v)]);
  return rows;
}

/** The two sheets' art, including displaced drawing copies in the mosaic's target cells. */
export function sheets(e: Erasure, options: { thin?: boolean } = {}): { black: Part[]; gold: Part[] } {
  const black: Item[] = [], gold: Item[] = [];
  const inAny = (rings: Point[][], p: Point) => rings.some(ring => insideRing(ring, p));
  const inBob = (p: Point) => inAny(e.bob, p);
  const inWindow = (p: Point) => inAny(e.window, p);
  const inVisor = (p: Point) => e.visor.length > 2 && insideRing(e.visor, p);
  const inAnyBlock = (p: Point) => e.blocks.some(block => inBlock(block, p));
  const inSourceBlock = (p: Point) => e.blocks.some(block => block.source && inBlock(block, p));
  const shared = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) >= Math.max(a0, b0) - 1e-6;
  /** Opposing gel colours each stop 0.4 mm short, keeping a 0.8 mm black-paper rule between cells that share an edge. */
  const fillInset = (block: Block): Insets => {
    const inset: Insets = { left: 0, right: 0, top: 0, bottom: 0 };
    if (block.source || (block.kind !== 'pink' && block.kind !== 'rose')) return inset;
    for (const other of e.blocks) {
      if (other === block || other.source || (other.kind !== 'pink' && other.kind !== 'rose') || other.kind === block.kind) continue;
      if (Math.abs(block.x0 - other.x1) < 1e-6 && shared(block.y0, block.y1, other.y0, other.y1)) inset.left = 0.4;
      if (Math.abs(block.x1 - other.x0) < 1e-6 && shared(block.y0, block.y1, other.y0, other.y1)) inset.right = 0.4;
      if (Math.abs(block.y0 - other.y1) < 1e-6 && shared(block.x0, block.x1, other.x0, other.x1)) inset.top = 0.4;
      if (Math.abs(block.y1 - other.y0) < 1e-6 && shared(block.x0, block.x1, other.x0, other.x1)) inset.bottom = 0.4;
    }
    return inset;
  };
  // Bob and cut rings are holes; the visor is black paper under a fused fill. The nose can remain in front of it.
  const fixedClear = (p: Point) => inBob(p) || inWindow(p) || (inVisor(p) && !e.onNose(p));

  const add = (into: Item[], item: Omit<Item, 'piece'>, path: Point[]) => {
    for (const piece of clipToRect(path, ART)) if (pathLength(piece) >= 0.3) into.push({ ...item, piece });
  };
  const addKept = (into: Item[], item: Omit<Item, 'piece'>, path: Point[], keep: (p: Point) => boolean) => {
    for (const piece of keepAlong(path, keep, 0.15)) add(into, item, piece);
  };

  // `source` is the visible base. `echoSource` retains silver/gold marks hidden behind the visor so an origin bite can
  // genuinely carry a displaced fragment of the face rather than copying an already empty visor cell.
  const source: Item[] = [], echoSource: Item[] = [], under: Item[] = [];
  for (const h of e.head) {
    addKept(source, h, h.piece, p => !e.bySuit(p) && !fixedClear(p));
    addKept(echoSource, h, h.piece, p => !e.bySuit(p) && !inBob(p) && !inWindow(p));
  }
  const grow = spec.bleed + FILL_OVER;
  for (const panel of e.panels) {
    const into = panel.window ? under : source;
    const panelGrow = panel.window ? grow : 0;
    for (const path of panelStripes(panel, panelGrow)) {
      if (panel.window) add(into, { pen: 'black', rank: 2, id: panel.id }, path);
      else {
        addKept(into, { pen: panel.pen, rank: 2, id: panel.id }, path, p => !fixedClear(p));
        addKept(echoSource, { pen: panel.pen, rank: 2, id: panel.id }, path, p => !inBob(p) && !inWindow(p));
      }
    }
  }
  for (const line of e.suitLines) {
    const item = { pen: line.pen, rank: 0, id: 'suit-line' };
    addKept(source, item, line.path, p => !fixedClear(p));
    addKept(echoSource, item, line.path, p => !inBob(p) && !inWindow(p));
  }

  // The untouched visible drawing gives way to every target/source cell. Gold's paper is still prepared separately,
  // because the optional window panels deliberately bleed under their cuts.
  for (const item of source) for (const piece of keepAlong(item.piece, p => !inAnyBlock(p), 0.15)) add(black, item, piece);
  for (const item of under) add(gold, item, item.piece);

  // Gold windows carry a Micron echo; black-sheet echo pixels retain their silver/gold source ink. A gold chip may be
  // represented as neighboring grid cells, so coalesce a rectangular run before applying the 1.25 mm cut-edge inset.
  // Source records are bites only, never a target to fill or redraw.
  const insetBox = (box: BlockBox, inset: number): BlockBox | undefined => {
    const inner = { x0: box.x0 + inset, x1: box.x1 - inset, y0: box.y0 + inset, y1: box.y1 - inset };
    return inner.x1 > inner.x0 && inner.y1 > inner.y0 ? inner : undefined;
  };
  const boxCentre = (box: BlockBox): Point => ({ x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 });
  const nearestPoint = (path: Point[], target: Point): Point => path.length ? path.reduce((best, point) =>
    (point.x - target.x) ** 2 + (point.y - target.y) ** 2 < (best.x - target.x) ** 2 + (best.y - target.y) ** 2 ? point : best) : target;
  const putEcho = (into: Item[], item: Item, path: Point[], box: BlockBox): number => {
    let count = 0;
    for (const piece of clipToRect(path, box)) if (pathLength(piece) >= 0.6) {
      add(into, item, piece);
      count++;
    }
    return count;
  };
  /** A fallback stays a real copied mark: choose the nearest candidate that spans enough of the target to survive thinning. */
  const fallbackEcho = (items: Item[], sourceCentre: Point, targetCentre: Point, targetBox: BlockBox): { item: Item; path: Point[] } | undefined => {
    let best: { item: Item; path: Point[]; distance: number; length: number } | undefined;
    for (const item of items) {
      if (!item.piece.length) continue;
      const anchor = nearestPoint(item.piece, sourceCentre);
      const path = item.piece.map(point => ({ x: point.x + targetCentre.x - anchor.x, y: point.y + targetCentre.y - anchor.y }));
      const length = clipToRect(path, targetBox).reduce((sum, piece) => sum + pathLength(piece), 0);
      if (length < 0.6) continue;
      const distance = Math.hypot(anchor.x - sourceCentre.x, anchor.y - sourceCentre.y);
      if (!best || distance < best.distance - 1e-6 || (Math.abs(distance - best.distance) < 1e-6 && length > best.length)) best = { item, path, distance, length };
    }
    return best;
  };
  const echoBlocks = [...goldRegions(e.blocks), ...e.blocks.filter(block => !block.source && block.kind === 'echo')];
  for (const block of echoBlocks) {
    const inset = block.kind === 'gold' ? 1.25 : 0.35;
    const targetBox = insetBox(block, inset);
    if (!targetBox) continue;
    // A bare 3 mm gold cell cannot hold a meaningful line while staying 1.2 mm off its cut. A 2+ cell chip can.
    if (block.kind === 'gold' && Math.max(targetBox.x1 - targetBox.x0, targetBox.y1 - targetBox.y0) < 1) continue;
    const sourceBox = { x0: block.x0 - block.dx, x1: block.x1 - block.dx, y0: block.y0 - block.dy, y1: block.y1 - block.dy };
    const sourceInner = insetBox(sourceBox, inset);
    const move = (point: Point): Point => ({ x: point.x + block.dx, y: point.y + block.dy });
    let copied = 0;
    if (sourceInner) for (const item of echoSource) {
      if (item.pen !== 'silver' && item.pen !== 'gold') continue;
      for (const piece of keepAlong(item.piece, point => inBlock(sourceInner, point), 0.1)) {
        copied += putEcho(block.kind === 'gold' ? gold : black, {
          ...item,
          pen: block.kind === 'gold' ? 'black' : item.pen,
          rank: 0,
          id: `mosaic-${block.kind}-echo`,
        }, piece.map(move), targetBox);
      }
    }
    // A sparse exact source cell can genuinely contain no stroke. Keep the fragment a drawing echo, but re-centre the
    // nearest available source mark rather than leaving a conspicuous empty target. Gold prefers a bob strand, which is
    // already black ink and visually belongs to the cut-paper hair.
    if (!copied) {
      const sourceCentre = boxCentre(sourceBox), targetCentre = boxCentre(targetBox);
      const fallback = fallbackEcho(block.kind === 'gold'
        ? [...e.bobInk.map(piece => ({ pen: 'black' as Pen, rank: 0, id: 'bob-echo-source', piece })), ...echoSource.filter(item => item.pen === 'silver' || item.pen === 'gold')]
        : echoSource.filter(item => item.pen === 'silver' || item.pen === 'gold'), sourceCentre, targetCentre, targetBox);
      if (fallback) {
        putEcho(block.kind === 'gold' ? gold : black, {
          ...fallback.item,
          pen: block.kind === 'gold' ? 'black' : fallback.item.pen,
          rank: 0,
          id: `mosaic-${block.kind}-echo-fallback`,
        }, fallback.path, targetBox);
      }
    }
  }

  // The magenta visor has intentional fused rows. Its nose opening exposes the retained face marks in front. A rose
  // rule sits 0.9 mm inside its actual edge; the 0.8 mm black gutter keeps the two gel colours distinct and legible.
  const roseRule = visorRule(e);
  const clearOfRoseRule = (point: Point) => !roseRule.length || distanceToRings(point, roseRule) >= GEL_CLEAR;
  for (const row of fusedVisorRows(e)) addKept(black, { pen: 'fluoro-pink', rank: 0, id: 'visor-fill' }, row,
    point => !e.onNose(point) && !inSourceBlock(point) && clearOfRoseRule(point));
  for (const edge of roseRule) addKept(black, { pen: METALLIC, rank: 0, id: 'visor-edge' }, edge,
    point => !e.onNose(point) && !inSourceBlock(point));
  for (const block of e.blocks) {
    if (block.source || (block.kind !== 'pink' && block.kind !== 'rose')) continue;
    const pen: Pen = block.kind === 'pink' ? 'fluoro-pink' : METALLIC;
    // The visor edge is rose gel; detached pink/rose pixels both stay off it instead of touching a different gel colour.
    const clearOfVisor = e.visor.length ? (p: Point) => distanceToRings(p, [e.visor]) >= GEL_CLEAR : () => true;
    for (const row of blockFill(block, fillInset(block))) addKept(black, { pen, rank: 0, id: `${block.kind}-pixel` }, row, clearOfVisor);
  }

  // The hair is a window, so its sparse long strands are black ink on the gold stock rather than black-sheet hatching.
  for (const path of e.bobInk) addKept(gold, { pen: 'black', rank: 1, id: 'bob-strand' }, path, p => inBob(p));

  // Accent gels are deliberately not thinned. They first mask 0.9 mm around themselves, protecting the fill's hard
  // graphic edges from nearby silver and gold hatch (and preserving separation between gel colours).
  const accents = black.filter(item => ACCENT.includes(item.pen));
  const byAccent = glyphMask(accents.map(item => item.piece), 0.9, 6, PAGE);
  const lines = thinned(
    black
      .filter(item => !ACCENT.includes(item.pen))
      .flatMap(item => keepAlong(item.piece, p => !byAccent(p), 0.15).map(piece => ({ ...item, piece }))),
    LINE_PITCH.gel,
    options.thin === false,
  );
  for (const item of accents) if (pathLength(item.piece) >= 0.3) {
    const paths = lines.get(item.pen) ?? [];
    paths.push(item.piece);
    lines.set(item.pen, paths);
  }
  const underLines = thinned(gold, LINE_PITCH.gel, options.thin === false);
  return {
    black: [...lines].map(([pen, paths]) => ({ id: `black-${pen}`, pen, paths })),
    gold: [...underLines].map(([pen, paths]) => ({ id: `gold-${pen}`, pen, paths })),
  };
}

/** The cached world lets the lab render each ply without re-meshing the same head. */
let lastWorld: { key: string; e: Erasure; art: ReturnType<typeof sheets> } | undefined;
function world(ctx: SketchContext, stage?: HeadStage, quality?: 'draft' | 'full'): { e: Erasure; art: ReturnType<typeof sheets> } {
  const key = JSON.stringify([quality ?? 'plot', ctx.seed, Object.entries(ctx.params).filter(([key]) => key !== spec.control).sort(([a], [b]) => (a < b ? -1 : 1))]);
  if (lastWorld?.key !== key) {
    const e = erasure(ctx, stage, { preview: quality !== undefined });
    lastWorld = { key, e, art: sheets(e, { thin: quality !== 'draft' }) };
  }
  return lastWorld;
}

/** The sketch lab's preview: draw each ply unclipped, using the GPU mesher where it is available. */
export async function labSheets(ctx: SketchContext, quality: 'draft' | 'full' = 'full'): Promise<{ ply: string; parts: Part[]; cuts: Point[][] }[]> {
  const mesher = (await gpuMesher()) ?? cpuMesher;
  const { e, art } = world(ctx, await previewHeadStage(ctx, mesher, quality === 'draft'), quality);
  return [{ ply: 'gold', parts: art.gold, cuts: [] }, { ply: 'black', parts: art.black, cuts: e.window }];
}

function draw(ctx: SketchContext): Part[] {
  const { e, art } = world(ctx);
  return [...renderPly(spec, ctx, pens, { cuts: { black: [{ id: 'windows', rings: e.window, label: 'W' }] }, art }), ...landmarks(e)];
}

/** Named page points for the readability crops: diagnostic paths never appear in the plot SVG. */
function landmarks(e: Erasure): Part[] {
  const { noseTip, chin, eyes, mouth } = e.page;
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const at: Record<string, Point> = { nose: noseTip, eyes: mid(eyes[0], eyes[1]), mouth, chin };
  return Object.entries(at).map(([name, p]) => ({ id: `landmark-${name}`, pen: 'cut', paths: [[p, { x: p.x + 0.01, y: p.y }]], diagnostic: true }));
}

const sketch: Sketch = {
  name: 'Breach / Lodestone: Ka-Codex B (cut-paper bob)',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls: [plyControl(spec), ...CONTROLS],
  assembly: spec,
  draw,
};

export default sketch;
