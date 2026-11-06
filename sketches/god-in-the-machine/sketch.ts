import type { Control, Params, Part, Pen, Point, Sketch, SketchContext } from '../../src/sketch/types.ts';
import { inkPen, PAPERS } from '../../src/sketch/materials.ts';
import { board } from './board.ts';
import type { BusTarget, ChipLayout } from './board.ts';
import { bodyLines, faceLines, frame, haloLines, haloRadius } from './figure.ts';
import type { Drape, Eroded, EyeMode, FaceMode, FaceShape, FigureShape, HaloForm, HaloShape } from './figure.ts';

/**
 * God in the Machine. A gold icon routed out of a silver circuit board: the figure's body is one stripe field, the
 * only smooth thing on the sheet is its face, and the board keeps its distance except for the buses that feed it.
 * The controls ask what the piece is, not what its numbers are; see brief.md for what each family of them means.
 */

const slider = (group: string, id: string, label: string, def: number, min: number, max: number, step: number, units?: string): Control =>
  ({ type: 'slider', id, label, default: def, min, max, step, group, ...(units ? { units } : {}) });
const select = (group: string, id: string, label: string, def: string, options: string[]): Control =>
  ({ type: 'select', id, label, default: def, group, options });
const toggle = (group: string, id: string, label: string, def: boolean): Control =>
  ({ type: 'toggle', id, label, default: def, group });

const ACCENTS = ['fluoro-pink', 'fluoro-yellow', 'fluoro-vermilion', 'fluoro-green'];
const SHEEN = ['gold', 'silver'];

export const controls: Control[] = [
  slider('Placement', 'figureX', 'Axis, across the sheet', 0.5, 0.2, 0.8, 0.005),
  slider('Placement', 'top', 'Crown height', 52, 14, 140, 1, 'mm'),
  slider('Placement', 'scale', 'Figure scale', 1, 0.5, 1.9, 0.01),

  slider('Figure', 'flare', 'Shoulders', 1, 0.15, 1.5, 0.01),
  slider('Figure', 'hair', 'Hair and veil', 1, 0.8, 1.7, 0.01),
  slider('Figure', 'neck', 'Neck length', 0, -8, 40, 1),
  slider('Figure', 'roll', 'Head tilt', 0, -14, 14, 0.5, 'deg'),

  select('Face', 'face', 'The face is', 'engraved', ['engraved', 'contour', 'void', 'die']),
  select('Face', 'eyes', 'Eyes', 'open', ['open', 'closed', 'lit', 'none']),
  slider('Face', 'eyeSize', 'Eye size', 1, 0.6, 1.5, 0.01),
  toggle('Face', 'mouth', 'Mouth', true),
  toggle('Face', 'thirdEye', 'Third eye', false),
  slider('Face', 'faceWidth', 'Face width', 1, 0.75, 1.2, 0.01),
  slider('Face', 'faceLength', 'Face length', 1, 0.85, 1.3, 0.01),
  slider('Face', 'light', 'Light from', -40, -120, 120, 1, 'deg'),
  slider('Face', 'lineAngle', 'Line angle', 0, -60, 60, 1, 'deg'),
  slider('Face', 'bend', 'Lines ride the relief', 0.5, 0, 1.2, 0.01),
  slider('Face', 'pitch', 'Line pitch', 0.85, 0.8, 1.6, 0.01, 'mm'),
  slider('Face', 'glitch', 'Lost sync', 0, 0, 1, 0.01),

  select('Body', 'drape', 'Lines run', 'fan', ['fan', 'plumb', 'cope', 'radial', 'tide']),
  slider('Body', 'wavelength', 'Ridge wavelength', 2.6, 1.8, 5, 0.05, 'mm'),
  slider('Body', 'taper', 'Coarser towards the hem', 1, 1, 2.6, 0.01),
  slider('Body', 'order', 'Labyrinth', 0.28, 0, 1, 0.01),
  slider('Body', 'rigid', 'Traces, not cloth', 0, 0, 1, 0.01),
  slider('Body', 'folds', 'Folds', 0.42, 0, 1.4, 0.01),
  slider('Body', 'swag', 'Swags', 1, 0, 2, 0.01),
  slider('Body', 'flaw', 'The flawed panel', 1, 0, 2, 0.01),
  slider('Body', 'ridge', 'Ridge weight', 0, -0.5, 0.5, 0.01),
  slider('Body', 'shade', 'Cloth shading', 0.35, 0, 1, 0.01),
  slider('Body', 'bodySeed', 'Body seed', 1, 1, 99, 1),

  select('Halo', 'halo', 'Form', 'round', ['round', 'octagon', 'square', 'none']),
  slider('Halo', 'haloY', 'Centre, down the figure', 36, 20, 200, 1),
  slider('Halo', 'reach', 'Reach', 70, 40, 280, 1, 'mm'),
  slider('Halo', 'span', 'Span of a full turn', 0.71, 0.3, 1, 0.01),
  slider('Halo', 'rays', 'Wires', 118, 30, 320, 1),
  slider('Halo', 'rhythm', 'A long wire every', 6, 2, 12, 2),
  slider('Halo', 'jog', 'Wires that jog', 0.34, 0, 1, 0.01),
  slider('Halo', 'rings', 'Guard rings', 0, 0, 8, 1),

  slider('Meeting', 'keepout', 'Keep-out', 9, 2, 30, 0.5, 'mm'),
  slider('Meeting', 'dissolve', 'The machine takes it', 0, 0, 1, 0.01),
  select('Meeting', 'eroded', 'From', 'hem', ['hem', 'left', 'right', 'centre']),
  slider('Meeting', 'block', 'In blocks of', 7, 2.54, 22, 0.01, 'mm'),
  select('Meeting', 'bus', 'Buses feed', 'robe', ['robe', 'halo', 'both', 'none']),
  slider('Meeting', 'busWidth', 'Traces per bus', 18, 0, 48, 1),

  select('Board', 'chips', 'Chips', 'opposed', ['opposed', 'flanking', 'ascending', 'crown', 'swarm', 'none']),
  slider('Board', 'chipSize', 'Chip size', 1, 0.5, 1.5, 0.01),
  slider('Board', 'chipDrift', 'Seed moves chips', 0.5, 0, 1, 0.01),
  { type: 'text', id: 'chipText', label: 'Marking on the great chip', default: '', maxLength: 28, group: 'Board' },
  toggle('Board', 'mirror', 'Mirror the layout', false),
  toggle('Board', 'symmetric', 'Bilateral board', false),
  slider('Board', 'density', 'Density', 1, 0, 1.6, 0.01),
  slider('Board', 'cluster', 'Cluster size', 1, 0.3, 3, 0.01),
  slider('Board', 'passives', 'Small parts', 1, 0, 2, 0.01),
  slider('Board', 'skylines', 'Pad columns', 1, 0, 3, 0.01),
  slider('Board', 'power', 'Power parts', 1, 0, 2, 0.01),
  slider('Board', 'vias', 'Vias', 1, 0, 2, 0.01),
  slider('Board', 'viaRadius', 'Via size', 1, 0.5, 1.6, 0.05, 'mm'),
  slider('Board', 'padPitch', 'Pad fill pitch', 0.45, 0.45, 1.2, 0.01, 'mm'),
  slider('Board', 'routes', 'Free routes', 30, 0, 200, 1),
  slider('Board', 'boardSeed', 'Board seed', 1, 1, 99, 1),

  select('Ink', 'figurePen', 'Figure', 'gold', SHEEN),
  select('Ink', 'boardPen', 'Board', 'silver', SHEEN),
  select('Ink', 'haloPen', 'Halo', 'gold', SHEEN),
  select('Ink', 'accent', 'Accent', 'none', ['none', ...ACCENTS]),
  slider('Ink', 'liveNets', 'Live nets', 0, 0, 12, 1),
];

const PENS: Pen[] = [inkPen('silver'), inkPen('gold'), ...ACCENTS.map(inkPen)];

/** Costly stages, kept while their own settings hold: the lab moves one slider at a time. */
const cached = new Map<string, unknown>();
function once<T>(stage: string, key: unknown, make: () => T): T {
  const k = JSON.stringify(key), slot = `${stage}:${k}`;
  if (!cached.has(slot)) {
    for (const old of cached.keys()) if (old.startsWith(`${stage}:`)) cached.delete(old);
    cached.set(slot, make());
  }
  return cached.get(slot) as T;
}

export function draw(ctx: SketchContext, page: { width: number; height: number; margin: number }): Part[] {
  const p = ctx.params as Params & Record<string, number & string & boolean>;
  const cx = page.width * Number(p.figureX);
  const shape: FigureShape = {
    cx, top: Number(p.top), scale: Number(p.scale), flare: Number(p.flare), hair: Number(p.hair), neck: Number(p.neck), roll: Number(p.roll), page,
    dissolve: Number(p.dissolve), eroded: String(p.eroded) as Eroded, block: Number(p.block),
    drape: String(p.drape) as Drape, wavelength: Number(p.wavelength), taper: Number(p.taper), order: Number(p.order), rigid: Number(p.rigid),
    folds: Number(p.folds), swag: Number(p.swag), flaw: Number(p.flaw), ridge: Number(p.ridge), shade: Number(p.shade), bodySeed: Number(p.bodySeed) + ctx.seed * 101,
  };
  const face: FaceShape = {
    face: String(p.face) as FaceMode, eyes: String(p.eyes) as EyeMode, eyeSize: Number(p.eyeSize), mouth: Boolean(p.mouth), thirdEye: Boolean(p.thirdEye),
    faceWidth: Number(p.faceWidth), faceLength: Number(p.faceLength), light: Number(p.light), lineAngle: Number(p.lineAngle),
    pitch: Number(p.pitch), glitch: Number(p.glitch), bend: Number(p.bend),
  };
  const halo: HaloShape = {
    form: String(p.halo) as HaloForm, y: Number(p.haloY), reach: Number(p.reach), span: Number(p.span), count: Number(p.rays),
    rhythm: Number(p.rhythm), jog: Number(p.jog), rings: Number(p.rings),
  };
  const shapeKey = { shape, width: face.faceWidth, length: face.faceLength };
  const fr = once('frame', shapeKey, () => frame(shape, face));
  const body = once('body', shapeKey, () => bodyLines(shape, fr));
  const f = once('face', { shapeKey, face }, () => faceLines(shape, face, fr));
  const h = haloLines(shape, halo, fr, ctx.random('halo'));

  const keep = Number(p.keepout);
  const nearestOnRobe = (from: Point): Point => {
    // The closest robe point below the neck: a bus steers for the shoulder, not the hair.
    let best = { x: cx, y: page.height }, d = Infinity;
    const yNeck = fr.world(0, 110 + shape.neck).y;
    for (let y = yNeck; y < page.height - page.margin; y += 5) for (let x = page.margin; x < page.width - page.margin; x += 5) {
      if (!fr.near(x, y, 0)) continue;
      const v = Math.hypot(x - from.x, y - from.y);
      if (v < d) { d = v; best = { x, y }; }
    }
    return best;
  };
  const nearestOnHalo = (from: Point): Point => {
    const a = Math.atan2(from.y - h.centre.y, from.x - h.centre.x), r = haloRadius(halo, a);
    return { x: h.centre.x + Math.cos(a) * r, y: h.centre.y + Math.sin(a) * r };
  };
  const lower = fr.world(0, 96 + shape.neck).y;
  const b = board({
    page, cx, boardSeed: Number(p.boardSeed) + ctx.seed * 103,
    keepOut: (x, y) => h.inHalo(x, y, keep) || fr.near(x, y, keep),
    solid: (x, y) => h.inHalo(x, y, 1.6) || fr.near(x, y, 1.6),
    robe: (x, y) => y > lower && fr.near(x, y, 3.2),
    haloEdge: (x, y) => h.inHalo(x, y, 3.2),
    robeTowards: nearestOnRobe, haloTowards: nearestOnHalo,
    chips: String(p.chips) as ChipLayout, chipSize: Number(p.chipSize), chipDrift: Number(p.chipDrift), chipText: String(p.chipText), mirror: Boolean(p.mirror), symmetric: Boolean(p.symmetric) && Math.abs(cx - page.width / 2) < 1,
    bus: String(p.bus) as BusTarget, busWidth: Number(p.busWidth), liveNets: String(p.accent) === 'none' ? 0 : Number(p.liveNets),
    density: Number(p.density), cluster: Number(p.cluster), passives: Number(p.passives), skylines: Number(p.skylines), power: Number(p.power), vias: Number(p.vias), viaRadius: Number(p.viaRadius), padPitch: Number(p.padPitch), routes: Number(p.routes),
  });

  const figurePen = String(p.figurePen), haloPen = String(p.haloPen), boardPen = String(p.boardPen), accent = String(p.accent);
  const parts: Part[] = [
    { id: 'parts', pen: boardPen, paths: b.lines },
    { id: 'traces', pen: boardPen, paths: b.traces },
    { id: 'body', pen: figurePen, paths: body },
    { id: 'face', pen: figurePen, paths: f.lines },
    { id: 'features', pen: figurePen, paths: f.features },
    { id: 'halo', pen: haloPen, paths: h.wires },
    { id: 'halo-pads', pen: haloPen, paths: h.pads.map(c => Array.from({ length: 11 }, (_, i) => ({ x: c.x + 0.7 * Math.cos(i / 10 * 2 * Math.PI), y: c.y + 0.7 * Math.sin(i / 10 * 2 * Math.PI) }))) },
    { id: 'accent', pen: accent === 'none' ? figurePen : accent, paths: f.accent },
    { id: 'live', pen: accent === 'none' ? boardPen : accent, paths: b.live },
  ];
  return parts.filter(part => part.paths.length > 0);
}

const LANDSCAPE = { width: 431.8, height: 279.4, margin: 14 };

const sketch: Sketch = {
  name: 'God in the Machine',
  page: { ...LANDSCAPE, paper: PAPERS.black.color },
  pageAware: true,
  pens: PENS,
  controls,
  navigators: [
    { id: 'presence', label: 'Saint against machine', axes: ['scale', 'keepout', 'dissolve', 'density', 'rigid'] },
    { id: 'axis', label: 'Placement', type: 'xy', axes: ['figureX', 'top'], yDirection: 'down' },
  ],
  draw(ctx) {
    const { width, height, margin } = { ...LANDSCAPE, ...ctx.page };
    return draw(ctx, { width, height, margin });
  },
};
export default sketch;
