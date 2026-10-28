import type { AssemblySpec, Cuts, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { thinRanked } from '../../kit/density.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, keepAlong, pathLength, type Rect } from '../../kit/page.ts';
import { ALONGSIDE_DEG, FILL_OVER, LINE_PITCH, LODESTONE_ASSEMBLY } from '../lodestone-world.ts';
import { ART, PAGE, PAPER, pensOf } from '../world.ts';
import { gpuMesher } from '../../kit/sculpt-gpu.ts';
import {
  CONTROLS, cpuMesher, erasure, METALLIC, panelStripes, previewHeadStage,
  type Erasure, type HeadStage, type Pen, type Seen,
} from './world.ts';

/**
 * Over the shoulder (a Lodestone study): see `./world.ts`. A turned android looks back over a long, twisted neck,
 * its magenta visor wrapped over the eyes and its close hair cap combed toward the nape. Silver, gold, fluoro pink
 * and one metallic-pink accent sit on the black front sheet; vertical scan bars tear through its shoulder and back,
 * with the few cut bars exposing black Micron work on the gold-yellow sheet behind.
 */

const plies = [
  { id: 'gold', paper: PAPER.gold, pens: ['black'], cutInk: 'black' },
  { id: 'black', paper: PAPER.black, pens: ['silver', 'gold', 'fluoro-pink', METALLIC], cutInk: 'silver' },
];
export const spec: AssemblySpec = { ...LODESTONE_ASSEMBLY, plies };
const pens = pensOf(['silver', 'gold', 'fluoro-pink', METALLIC, 'black']);

type Item = Seen & { piece: Point[] };
/** The two pink pens are physical accents: their rows and detail strokes are never thinned. */
const ACCENT: Pen[] = ['fluoro-pink', METALLIC];

/** Lines of one sheet kept apart at the gels' clean pitch, by pen and drawing rank. */
function thinned(items: Item[], pitch: number, skip = false): Map<string, Point[][]> {
  const out = new Map<string, Point[][]>();
  // A draft keeps every line until a full frame replaces it.
  if (skip) {
    for (const i of items) if (pathLength(i.piece) >= 0.6) {
      const paths = out.get(i.pen) ?? [];
      paths.push(i.piece);
      out.set(i.pen, paths);
    }
    return out;
  }
  for (const { item, runs } of thinRanked(items, pitch, { angle: ALONGSIDE_DEG })) {
    for (const run of runs) if (pathLength(run) >= 0.6) {
      const paths = out.get(item.pen) ?? [];
      paths.push(run);
      out.set(item.pen, paths);
    }
  }
  return out;
}

/** The two sheets' art, including the page-space scan-bar tears. */
export function sheets(e: Erasure, options: { thin?: boolean } = {}): { black: Part[]; gold: Part[] } {
  const black: Item[] = [], gold: Item[] = [];
  const scan = e.scan;
  const inBand = (p: Point, b: Erasure['scan'][number]) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
  // Only scan tears replace the drawing. Silver and pink columns are overlays, so they must leave the solid visor
  // and the underlying suit/head work intact beneath them.
  const inTearBand = (p: Point) => scan.some(b => (b.kind === 'shift' || b.kind === 'cut') && inBand(p, b));
  const bandRect = (b: Erasure['scan'][number]): Rect => ({ x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 });

  /**
   * Keep pieces of one visible mark on a sheet. Shifted scan pieces are clipped to their destination band as well as
   * the art rectangle, so a vertical tear never leaks from one bar into its neighbour.
   */
  const keep = (
    into: Item[], item: Item, test: (p: Point) => boolean, move?: (p: Point) => Point,
    pen: Pen = item.pen, destination?: Rect,
  ) => {
    for (const piece of keepAlong(item.piece, test, 0.15)) {
      const moved = move ? piece.map(move) : piece;
      const bounded = destination ? clipToRect(moved, destination) : [moved];
      for (const part of bounded.flatMap(path => clipToRect(path, ART))) {
        if (pathLength(part) >= 0.6) into.push({ ...item, pen, piece: part });
      }
    }
  };

  const head: Item[] = [];
  for (const s of e.head) head.push({ ...s, piece: s.piece });
  // `projectStrokes` has already depth-tested these surface rows against the projecting nose. Keeping that true
  // silhouette is cleaner than subtracting a coarse page bitmap and turning the wrapped lens into a rectangular bite.
  if (e.assembled) {
    for (const s of e.visor) head.push({ ...s, piece: s.piece });
  }

  const suit: { black: Item[]; gold: Item[] } = { black: [], gold: [] };
  if (e.assembled) {
    const grow = spec.bleed + FILL_OVER;
    for (const panel of e.panels) {
      const into = panel.window ? suit.gold : suit.black;
      for (const piece of panelStripes(panel, panel.window ? grow : 0)) {
        into.push({ pen: panel.pen, rank: 2, id: panel.id, piece });
      }
    }
    for (const line of e.suitLines) suit.black.push({ pen: line.pen, rank: 0, id: 'suit-line', piece: line.path });
  }

  /** Add a source group with standing drawing removed only where a shift or cut scan tear takes over. */
  const standing = (into: Item[], items: Item[], excludeSuit = false) => {
    for (const item of items) {
      // Keep the fused lens as one physical field rather than fragmenting its edge into a new pen path at every tear.
      // The scan still breaks the facial and suit drawing that surrounds it; guarded cut bars are placed below the lens.
      const protectedVisor = item.id.startsWith('visor');
      keep(into, item, p => (protectedVisor || !inTearBand(p)) && (!excludeSuit || !e.bySuit(p)));
    }
  };
  standing(black, head, true);
  standing(black, suit.black);
  standing(gold, suit.gold);

  /**
   * Shift and cut bars take their source from every visible family. A cut bar receives its displaced image in black
   * Micron on the rear gold sheet; a shift preserves the source pen on the front black sheet.
   */
  const sources = [
    ...head.filter(item => item.piece.length >= 2).map(item => ({ item, goldSource: false })),
    ...suit.black.map(item => ({ item, goldSource: false })),
    // Collar-window stripes live on the rear gold ply. A scan shift must carry them with the suit instead of leaving
    // an empty tear in that black-Micron drawing.
    ...suit.gold.map(item => ({ item, goldSource: true })),
  ];
  for (const band of scan) {
    if (band.kind !== 'shift' && band.kind !== 'cut') continue;
    const move = (p: Point): Point => ({ x: p.x, y: p.y - band.dv });
    for (const { item, goldSource } of sources) {
      // The visor is a fused field, not a collection of independent hatch marks. It stays continuous through a
      // displacement band while the surrounding facial contours jump; cut bars never reach this eye-height strip.
      const shiftVisor = band.kind === 'shift' && item.id.startsWith('visor');
      if (shiftVisor) continue;
      // Sample from the inverse-translated source interval. This replaces every point in the destination band (rather
      // than leaving a blank strip at one end), so a shifted fused visor remains a solid magenta field.
      const sourceTest = (p: Point) => {
        const destination = move(p);
        return inBand(destination, band) && (!head.includes(item) || !e.bySuit(destination));
      };
      keep(goldSource || band.kind === 'cut' ? gold : black, item, sourceTest, move, goldSource ? item.pen : band.kind === 'cut' ? 'black' : item.pen, bandRect(band));
    }
  }

  // Silver bars are deliberately open at the gels' 0.8 mm clean pitch; pink bars use 0.5 mm fused rows.
  for (const band of scan) {
    if (band.kind !== 'silver' && band.kind !== 'pink') continue;
    const pitch = band.kind === 'pink' ? 0.5 : LINE_PITCH.gel;
    const pen: Pen = band.kind === 'pink' ? 'fluoro-pink' : 'silver';
    const into = black;
    for (let x = band.x0 + pitch / 2; x <= band.x1 - pitch / 2 + 1e-6; x += pitch) {
      for (const piece of clipToRect([{ x, y: band.y0 }, { x, y: band.y1 }], ART)) {
        into.push({ pen, rank: 0, id: `scan-${band.kind}`, piece });
      }
    }
  }

  // Accent pens own their immediate space. This keeps silver and gold hatch out of the fused visor and pink scan bars.
  const accents = black.filter(item => ACCENT.includes(item.pen));
  // These are already laid at exactly the gels' 0.8 mm clean pitch. Keep that column rhythm rather than letting a
  // neighbouring head hatch thin a scan bar away; ordinary silver stays in the ranked density pass below.
  const scanSilver = black.filter(item => item.id === 'scan-silver');
  const byAccent = glyphMask(accents.map(item => item.piece), 0.9, 6, PAGE);
  const ordinary = black
    .filter(item => !ACCENT.includes(item.pen) && item.id !== 'scan-silver')
    .flatMap(item => keepAlong(item.piece, p => !byAccent(p), 0.15).map(piece => ({ ...item, piece })));
  const lines = thinned(ordinary, LINE_PITCH.gel, options.thin === false);
  for (const item of scanSilver) {
    for (const piece of keepAlong(item.piece, p => !byAccent(p), 0.15)) if (pathLength(piece) >= 0.3) {
      const paths = lines.get(item.pen) ?? [];
      paths.push(piece);
      lines.set(item.pen, paths);
    }
  }
  for (const item of accents) if (pathLength(item.piece) >= 0.3) {
    const paths = lines.get(item.pen) ?? [];
    paths.push(item.piece);
    lines.set(item.pen, paths);
  }
  const under = thinned(gold, LINE_PITCH.gel, options.thin === false);
  return {
    black: [...lines].map(([pen, paths]) => ({ id: `black-${pen}`, pen, paths })),
    gold: [...under].map(([pen, paths]) => ({ id: `gold-${pen}`, pen, paths })),
  };
}

/** The world for the last parameters drawn, shared by the lab's two ply requests. */
let lastWorld: { key: string; e: Erasure; art: ReturnType<typeof sheets> } | undefined;
function world(ctx: SketchContext, stage?: HeadStage, quality?: 'draft' | 'full'): { e: Erasure; art: ReturnType<typeof sheets> } {
  const key = JSON.stringify([
    quality ?? 'plot', ctx.seed,
    Object.entries(ctx.params).filter(([key]) => key !== spec.control).sort(([a], [b]) => (a < b ? -1 : 1)),
  ]);
  if (lastWorld?.key !== key) {
    const e = erasure(ctx, stage, { preview: quality !== undefined });
    lastWorld = { key, e, art: sheets(e, { thin: quality !== 'draft' }) };
  }
  return lastWorld;
}

/** The sketch lab's preview: each sheet's art and the front black sheet's knife windows. */
export async function labSheets(ctx: SketchContext, quality: 'draft' | 'full' = 'full'): Promise<{ ply: string; parts: Part[]; cuts: Point[][] }[]> {
  const mesher = (await gpuMesher()) ?? cpuMesher;
  const { e, art } = world(ctx, await previewHeadStage(ctx, mesher, quality === 'draft'), quality);
  return [{ ply: 'gold', parts: art.gold, cuts: [] }, { ply: 'black', parts: art.black, cuts: e.window }];
}

function draw(ctx: SketchContext): Part[] {
  const { e, art } = world(ctx);
  const cuts: Cuts = e.window.length > 0 ? { black: [{ id: 'windows', rings: e.window, label: 'W' }] } : {};
  const parts = renderPly(spec, ctx, pens, { cuts, art });
  return [...parts, ...landmarks(e)];
}

/** Named page points for the readability crops; diagnostics never appear in the plotted SVG. */
function landmarks(e: Erasure): Part[] {
  const { noseTip, chin, eyes } = e.page;
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const at: Record<string, Point> = { nose: noseTip, eyes: mid(eyes[0], eyes[1]), mouth: mid(noseTip, chin), chin };
  return Object.entries(at).map(([name, p]) => ({
    id: `landmark-${name}`,
    pen: 'cut',
    paths: [[{ x: p.x, y: p.y }, { x: p.x + 0.01, y: p.y }]],
    diagnostic: true,
  }));
}

const sketch: Sketch = {
  name: 'Breach / Lodestone: Over the shoulder (ka-codex-c)',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls: [plyControl(spec), ...CONTROLS],
  assembly: spec,
  draw,
};

export default sketch;
