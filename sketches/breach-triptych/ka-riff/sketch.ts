import type { AssemblySpec, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';
import { plyControl, renderPly } from '../../../src/sketch/assembly.ts';
import { thinRanked } from '../../kit/density.ts';
import { glyphMask } from '../../kit/lettering.ts';
import { clipToRect, keepAlong, pathLength } from '../../kit/page.ts';
import { ALONGSIDE_DEG, FILL_OVER, LINE_PITCH, LODESTONE_ASSEMBLY } from '../lodestone-world.ts';
import { ART, PAGE, PAPER, pensOf } from '../world.ts';
import { gpuMesher } from '../../kit/sculpt-gpu.ts';
import { CONTROLS, cpuMesher, erasure, panelStripes, previewHeadStage, type Erasure, type HeadStage, type Seen, type Slice } from './world.ts';

/**
 * Kawaii Aggro riff (from Codex take A) — black and gold sheets for a restrained android portrait. The magenta visor is opaque gel on the
 * front sheet; every mark and both sets of shirt windows are cut into horizontal datamosh slices before plotting.
 */

const plies = [
  { id: 'gold', paper: PAPER.gold, pens: ['black'], cutInk: 'black' },
  { id: 'black', paper: PAPER.black, pens: ['silver', 'gold', 'fluoro-pink', 'gel-rose'], cutInk: 'silver' },
];
export const spec: AssemblySpec = { ...LODESTONE_ASSEMBLY, plies };
const pens = pensOf(['silver', 'gold', 'fluoro-pink', 'gel-rose', 'black']);

type Item = Seen & { piece: Point[] };

/** Lines of one physical sheet, kept apart at the gel pitch by rank. */
function thinned(items: Item[], pitch: number, skip = false): Map<string, Point[][]> {
  const out = new Map<string, Point[][]>();
  if (skip) {
    for (const item of items) if (pathLength(item.piece) >= 0.6) {
      const paths = out.get(item.pen) ?? [];
      paths.push(item.piece);
      out.set(item.pen, paths);
    }
    return out;
  }
  for (const { item, runs } of thinRanked(items, pitch, { angle: ALONGSIDE_DEG })) for (const piece of runs) if (pathLength(piece) >= 0.6) {
    const paths = out.get(item.pen) ?? [];
    paths.push(piece);
    out.set(item.pen, paths);
  }
  return out;
}

/** The two sheets' art: source paths are split at each slice edge, then translated once, never echoed. */
export function sheets(e: Erasure, options: { thin?: boolean } = {}): { black: Part[]; gold: Part[] } {
  const black: Item[] = [], gold: Item[] = [];
  const vOf = (p: Point) => e.toBar(p).v;
  const eyeU = (e.toBar(e.page.eyes[0]).u + e.toBar(e.page.eyes[1]).u) / 2;
  const faceDir = Math.sign(e.toBar(e.page.noseTip).u - eyeU) || 1;

  /** The interval lookup is logarithmic; a long stroke visits only the slices it crosses. */
  const sliceAt = (v: number): number => {
    let lo = 0, hi = e.slices.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (e.slices[mid].v0 <= v) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const shifted = (piece: Point[], slice: Slice): Point[] => piece.map(p => {
    const q = e.toBar(p);
    return e.toPage(q.u + slice.du, q.v);
  });
  const addPiece = (into: Item[], item: Omit<Item, 'piece'>, piece: Point[], slice: Slice, visor = false) => {
    let moved = shifted(piece, slice);
    // A live slice stretches only the noseward end of the opaque bar. It stays a 0.5 mm row rather than becoming an
    // outlined decoration, and the source clip around the nose moves with the same slice.
    if (visor && slice.active && slice.smear > 0 && moved.length >= 2) {
      let end = 0, best = -Infinity;
      for (let i = 0; i < moved.length; i++) {
        const u = e.toBar(moved[i]).u * faceDir;
        if (u > best) { best = u; end = i; }
      }
      const q = e.toBar(moved[end]);
      const extension = e.toPage(q.u + faceDir * slice.smear, q.v);
      moved = end === 0 ? [extension, ...moved] : end === moved.length - 1 ? [...moved, extension] : moved;
    }
    // Re-test after translation too: the stationary nose remains in front of every displaced visor slice.
    const foreground = visor ? keepAlong(moved, p => !e.onNose(p), 0.1) : [moved];
    // In a cut slice nothing of the black is left over the cut; the gold there shows the drawing where it was before the
    // slice moved (its ghost), in black ink (the magenta and the metallic pink not: the gold shows plain for them).
    const cut = slice.cut;
    const overCut = (p: Point) => { const q = e.toBar(p); return !!cut && q.u >= cut.u0 && q.u <= cut.u1 && !e.onNose(p); };
    if (cut && item.pen !== 'fluoro-pink' && item.pen !== 'gel-rose') for (const ghost of keepAlong(piece, overCut, 0.15)) for (const clipped of clipToRect(ghost, ART)) {
      if (pathLength(clipped) >= 0.3) gold.push({ ...item, pen: 'black', piece: clipped });
    }
    for (const candidate of foreground) {
      const parts = cut ? keepAlong(candidate, p => !overCut(p), 0.15) : [candidate];

      for (const part of parts) for (const clipped of clipToRect(part, ART)) {
        if (pathLength(clipped) >= 0.3) into.push({ ...item, piece: clipped });
      }
    }
  };
  const sliced = (into: Item[], item: Omit<Item, 'piece'>, piece: Point[], visor = false) => {
    if (piece.length < 2 || !e.slices.length) return;
    let k = sliceAt(vOf(piece[0]));
    let run: Point[] = [piece[0]];
    const flush = () => {
      if (run.length >= 2) addPiece(into, item, run, e.slices[k], visor);
      run = [];
    };
    for (let i = 1; i < piece.length; i++) {
      const a = piece[i - 1], b = piece[i], va = vOf(a), vb = vOf(b);
      const kb = sliceAt(vb);
      while (k !== kb) {
        const up = kb > k;
        const edge = up ? e.slices[k + 1].v0 : e.slices[k].v0;
        const t = (edge - va) / (vb - va);
        const cut = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        run.push(cut);
        flush();
        k += up ? 1 : -1;
        run = [cut];
      }
      run.push(b);
    }
    flush();
  };
  const inVisor = (p: Point) => {
    if (e.wrap) return e.onBand(p);
    const q = e.toBar(p);
    return q.v >= -e.barH && q.v <= 0;
  };
  const add = (into: Item[], item: Omit<Item, 'piece'>, piece: Point[], visor = false) => sliced(into, item, piece, visor);

  // The portrait is first cleared where the physical suit and opaque visor sit. In the head study neither assembly
  // mask applies, so it remains an uninterrupted base portrait rather than a visor-shaped absence.
  for (const mark of e.head) {
    const visible = keepAlong(mark.piece, p => (!e.assembled || !e.bySuit(p)) && (!e.assembled || !inVisor(p) || e.onNose(p)), 0.15);
    for (const piece of visible) add(black, mark, piece);
  }

  if (e.assembled) {
    const grow = spec.bleed + FILL_OVER;
    for (const panel of e.panels) {
      const into = panel.window ? gold : black;
      for (const piece of panelStripes(panel, panel.window ? grow : 0)) add(into, { pen: panel.pen, rank: 2, id: panel.id }, piece);
    }
    for (const line of e.suitLines) add(black, { pen: line.pen, rank: 0, id: 'suit-line' }, line.path);
  }

  // The magenta rows bypass density thinning below. Clip them at the original nose before slicing so the lower nose
  // remains in front even when the surrounding data shifts sideways.
  if (e.assembled) for (const row of e.visorRows) for (const piece of keepAlong(row, p => !e.onNose(p), 0.1)) {
    add(black, { pen: 'fluoro-pink', rank: 0, id: 'visor' }, piece, true);
  }
  for (const mark of e.visor) add(black, mark, mark.piece, mark.id === 'visor-row');

  // Fluoro pink is a fused fill. It clears all other black-sheet engraving but is never itself passed through the
  // 0.8 mm gel thinning. The metallic rose remains a sparse, direct accent after the same clearing.
  const pink = black.filter(item => item.pen === 'fluoro-pink').map(item => item.piece);
  const byPink = glyphMask(pink, 0.9, 6, PAGE);
  const rose = black.filter(item => item.pen === 'gel-rose')
    .flatMap(item => keepAlong(item.piece, p => !byPink(p), 0.15).map(piece => ({ ...item, piece })));
  // Hair is a disjoint SDF zone. Thin its own flow lines at the regular pen pitch, separately from the face plates,
  // so plate fragments at the cap boundary cannot cut ragged polygonal cracks through the strands.
  const hair = black.filter(item => item.id.startsWith('hair-'))
    .flatMap(item => keepAlong(item.piece, p => !byPink(p), 0.15).map(piece => ({ ...item, piece })));
  const ordinary = black.filter(item => item.pen !== 'fluoro-pink' && item.pen !== 'gel-rose' && !item.id.startsWith('hair-'))
    .flatMap(item => keepAlong(item.piece, p => !byPink(p), 0.15).map(piece => ({ ...item, piece })));
  const lines = thinned(ordinary, LINE_PITCH.gel, options.thin === false);
  const hairLines = thinned(hair, LINE_PITCH.gel, options.thin === false);
  if (hairLines.size) lines.set('silver', [...(lines.get('silver') ?? []), ...(hairLines.get('silver') ?? [])]);
  lines.set('fluoro-pink', pink);
  if (rose.length) lines.set('gel-rose', rose.map(item => item.piece));
  const under = thinned(gold, LINE_PITCH.gel, options.thin === false);
  return {
    black: [...lines].map(([pen, paths]) => ({ id: 'black-' + pen, pen, paths })),
    gold: [...under].map(([pen, paths]) => ({ id: 'gold-' + pen, pen, paths })),
  };
}

/** The world is shared by the two plies and by lab previews. */
let lastWorld: { key: string; e: Erasure; art: ReturnType<typeof sheets> } | undefined;
function world(ctx: SketchContext, stage?: HeadStage, quality?: 'draft' | 'full'): { e: Erasure; art: ReturnType<typeof sheets> } {
  const key = JSON.stringify([quality ?? 'plot', ctx.seed, Object.entries(ctx.params).filter(([id]) => id !== spec.control).sort(([a], [b]) => (a < b ? -1 : 1))]);
  if (lastWorld?.key !== key) {
    const e = erasure(ctx, stage, { preview: quality !== undefined });
    lastWorld = { key, e, art: sheets(e, { thin: quality !== 'draft' }) };
  }
  return lastWorld;
}

/** The lab gets the same two plies and the front sheet's shifted knife paths. */
export async function labSheets(ctx: SketchContext, quality: 'draft' | 'full' = 'full'): Promise<{ ply: string; parts: Part[]; cuts: Point[][] }[]> {
  const mesher = (await gpuMesher()) ?? cpuMesher;
  const { e, art } = world(ctx, await previewHeadStage(ctx, mesher, quality === 'draft'), quality);
  return [{ ply: 'gold', parts: art.gold, cuts: [] }, { ply: 'black', parts: art.black, cuts: e.window }];
}

function draw(ctx: SketchContext): Part[] {
  const { e, art } = world(ctx);
  const parts = renderPly(spec, ctx, pens, { cuts: { black: [{ id: 'windows', rings: e.window, label: 'W' }] }, art });
  return [...parts, ...landmarks(e)];
}

/** Named page points support diagnostic crops without appearing in exported SVG. */
function landmarks(e: Erasure): Part[] {
  const { noseTip, chin, eyes } = e.page;
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const points: Record<string, Point> = { nose: noseTip, eyes: mid(eyes[0], eyes[1]), mouth: mid(noseTip, chin), chin };
  return Object.entries(points).map(([name, p]) => ({ id: 'landmark-' + name, pen: 'cut', paths: [[p, { x: p.x + 0.01, y: p.y }]], diagnostic: true }));
}

const sketch: Sketch = {
  name: 'Breach / Lodestone: Kawaii Aggro (riff)',
  page: { ...PAGE },
  pageAware: true,
  pens,
  controls: [plyControl(spec), ...CONTROLS],
  assembly: spec,
  draw,
};

export default sketch;
