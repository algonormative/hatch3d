import * as THREE from 'three';
import type { Part, Point, SketchContext } from '../../../src/sketch/types.ts';
import { renderDepthBufferCPU } from '../../../src/sketch/depth-buffer.ts';
import { TABLOID_PAGE } from '../../phase-garden/poster.ts';
import { facetStrokes, rakingLight, slabGeometry, slabMatrix, solid, type Slab } from '../../kit/slabs.ts';
import { helixAlong } from '../../kit/helix.ts';
import { clearBands, planSlogans, sloganSettings, titleSettings, type SloganSurface } from '../../kit/lettering.ts';
import { bandMarks, sideOf } from '../../kit/fills.ts';
import { densify, keepAlong, meshCoverage } from '../../kit/page.ts';
import { n } from '../../kit/params.ts';
import { fitDepthRange, horizonCamera, pageOf } from '../../kit/perspective.ts';
import { barPattern } from '../../kit/rhythm.ts';
import { PartBuckets, projectStrokes, scalePoints } from '../../kit/strokes.ts';
import type { Ink, Stroke } from '../../kit/types.ts';
import { CARD, HORIZON_Y, cardFrame, clipWindow } from '../card.ts';
import { boltPath, shear, storm, tower, towerCamera } from './geometry.ts';

/**
 * XVI The Tower, `form: 'machine'`: the struck tower is the supercomputer of the Machine study (a
 * C of wedge columns of thin blades after the Cray, open toward us, a bench ring round its base,
 * a row of status ticks on every blade). It stands where the cantilever tower stood, on the same
 * paving, under the same storm, struck by the same bolt: the page is torn, and everything on the
 * far side of the tear has slipped like a misregistered print, blades, ticks and words with it.
 * The machine's top lifts off whole like a lid, and the helix rises out of the open core. Past the
 * tear its status ticks go dark (`machineTicks`). The clock it ran on, a hatched square wave across
 * the sky, can come too (`machineClock`), torn by the bolt like everything else.
 */
const W = 559, H = 864;
/** The machine's own depth pass: the same projection at twice the resolution, its range fitted. */
const W2 = 2 * W, H2 = 2 * H;
const MM_X = TABLOID_PAGE.width / W, MM_Y = TABLOID_PAGE.height / H;
const MM2_X = TABLOID_PAGE.width / W2, MM2_Y = TABLOID_PAGE.height / H2;
const INKS: Ink[] = ['carbon', 'ultramarine', 'vermilion', 'acid', 'violet', 'lettering'];
/** tower() pushes the ground last: the plinth, 18 × 9 paving stones and 7 pieces of debris. */
const GROUND_COUNT = 1 + 18 * 9 + 7;

/** The machine, in the Tower's frame (ground y = 0, the eye 2.2 up, 48 back). */
const M = { x: -1.3, z: -3, R: 8, inner: 0.62, height: 20.5, columns: 14, open: 1.2, turn: -0.75, plate: 0.55, gap: 0.11, lidDepth: 2.2, lidClear: 1, helixRadius: 1.9, helixWidth: 1.4 };

/**
 * Which side of the tear slips: the region left of the whole bolt, closed off above and below the card.
 * The cantilever card reads the side from the bolt's nearest leg, which can flip beyond a near-level leg
 * and open a false tear across the sky; the machine's lid stands right there, so it uses this instead.
 */
function slippedSide(bolt: Point[]): (p: Point) => boolean {
  const poly = [{ x: bolt[0].x, y: -1e4 }, ...bolt, { x: bolt.at(-1)!.x, y: 1e4 }, { x: -1e4, y: 1e4 }, { x: -1e4, y: -1e4 }];
  return p => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y)) inside = !inside;
    }
    return inside;
  };
}

/** `shear` from the cantilever card, with the slipped side read from the region (see `slippedSide`). */
function tear(path: Point[], bolt: Point[], slipped: (p: Point) => boolean, slip: Point, half: number): Point[][] {
  const out: Point[][] = [];
  let run: Point[] = [], last = 0;
  const flush = () => { if (run.length > 1) out.push(run); run = []; };
  for (const p of densify(path, 0.5)) {
    if (sideOf(bolt, p).dist < half + 0.6) { flush(); last = 0; continue; }
    const side = slipped(p) ? 1 : -1;
    if (last !== 0 && side !== last) flush();
    last = side;
    run.push(side > 0 ? { x: p.x + slip.x, y: p.y + slip.y } : p);
  }
  flush();
  return out.flatMap(r => keepAlong(r, q => sideOf(bolt, q).dist > half + 0.4, 0.3));
}

type Machine = { solids: Slab[]; kind: ('blade' | 'panel' | 'bench')[]; column: number[]; lid: Set<number>; core: THREE.Vector3; lidCentre: THREE.Vector3 };

/** The supercomputer: wedge columns of blades in a C, a few double blades for panels, the bench ring, and the top lifted off as one lid. */
function machine(ctx: SketchContext, lidY: number): Machine {
  const rng = ctx.random('tower-card-machine');
  const lidAmount = n(ctx, 'lid', 0.5, 0, 1);
  const { R, height, columns, open, turn, plate, gap } = M;
  const inner = R * M.inner, rm = (R + inner) / 2;
  const base = new THREE.Vector3(M.x, 0, M.z);
  const step = (Math.PI * 2 - open) / columns;
  const solids: Slab[] = [], kind: Machine['kind'] = [], column: number[] = [];
  const lid = new Set<number>();
  let c = 0;
  const add = (s: Slab, k: Machine['kind'][number]) => { solids.push(s); kind.push(k); column.push(c); return solids.length - 1; };
  for (; c < columns; c++) {
    const a = turn + open / 2 + (c + 0.5) * step;
    const u = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    const chord = 2 * rm * Math.sin(step / 2) * 0.97;
    // A double blade every so often, staggered column to column: the panels the words are cut into.
    const phase = Math.floor(rng() * 5);
    for (let y = plate / 2 + 0.05, k = 0; y + plate / 2 < height; k++) {
      const panel = k > 3 && (k + phase) % 5 === 0 && y + 1.5 * plate + gap < height - M.lidDepth;
      const h = panel ? 2 * plate + gap : plate;
      const yc = y - plate / 2 + h / 2;
      const s = solid(base.x + u.x * rm, yc, base.z + u.z * rm, chord, h, R - inner, 0, 'stack');
      s.ry = a;
      s.tone = 0.85;
      const id = add(s, panel ? 'panel' : 'blade');
      if (yc + h / 2 > height - M.lidDepth) lid.add(id);
      y += h + gap;
    }
    // The bench: a low base and a cushion round the outside of each column.
    const b0 = R + 0.12, b1 = R + 2, bm = (b0 + b1) / 2, bchord = 2 * bm * Math.sin(step / 2) * 0.97;
    const lower = solid(base.x + u.x * bm, 0.6, base.z + u.z * bm, bchord, 1.2, b1 - b0, 0, 'stack');
    const cushion = solid(base.x + u.x * (bm + 0.07), 1.47, base.z + u.z * (bm + 0.07), bchord * 1.02, 0.52, b1 - b0 + 0.15, 0, 'stack');
    lower.ry = a; cushion.ry = a;
    lower.tone = 0.8; cushion.tone = 0.8;
    add(lower, 'bench'); add(cushion, 'bench');
  }
  // The lid: the top courses come away as one rigid piece, raised to where the bolt strikes and tipped.
  const pivot = new THREE.Vector3(base.x, height - M.lidDepth / 2, base.z);
  const lidCentre = new THREE.Vector3(base.x + 0.6 + 0.8 * lidAmount, lidY, base.z);
  const tip = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.14 + 0.2 * lidAmount, 0, -(0.08 + 0.16 * lidAmount) * (0.8 + 0.4 * rng()), 'XYZ'));
  for (const id of lid) {
    const s = solids[id];
    const m = new THREE.Matrix4().makeTranslation(lidCentre.x, lidCentre.y, lidCentre.z)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(tip))
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
      .multiply(slabMatrix(s));
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    m.decompose(p, q, new THREE.Vector3());
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    Object.assign(s, { x: p.x, y: p.y, z: p.z, rx: e.x, ry: e.y, rz: e.z, role: 'fallen' });
  }
  // However far the lid tips, it stays well clear of the body it came off.
  let lowest = Infinity;
  for (const id of lid) {
    const s = solids[id], mat = slabMatrix(s);
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) lowest = Math.min(lowest, new THREE.Vector3(x * s.w / 2, -s.h / 2, z * s.d / 2).applyMatrix4(mat).y);
  }
  const raise = height + M.lidClear - lowest;
  if (raise > 0) {
    for (const id of lid) solids[id].y += raise;
    lidCentre.y += raise;
  }
  return { solids, kind, column, lid, core: base, lidCentre };
}

export function drawMachineTower(ctx: SketchContext): Part[] {
  // The ground pass keeps the cantilever card's own camera and depth pass, so the paving and storm
  // are hidden exactly as before wherever the machine does not stand in front of them.
  const view = towerCamera(ctx);
  const viewB = horizonCamera({
    fov: n(ctx, 'fov', 56, 40, 80), eye: [0, 2.2, n(ctx, 'distance', 48, 30, 90)], target: [0, 2.2, 0], far: 400,
    page: TABLOID_PAGE, depth: { width: W2, height: H2 }, horizonY: HORIZON_Y,
  });
  const eye = view.position.clone();
  const all = tower(ctx);
  const fallen = all.filter(s => s.role === 'fallen');
  // The bolt strikes where the cantilever's lid was, so the bolt, the tear and the horizon stay put.
  const lidY = fallen.reduce((t, s) => t + s.y, 0) / fallen.length;
  // The ground as the cantilever card has it, less any debris that would sit inside the machine's footprint.
  const footprint = M.R + 2.4;
  if (all[all.length - GROUND_COUNT].role !== 'pier') throw new Error('xvi-tower machine: tower() no longer ends with plinth, paving and debris');
  const ground = all.slice(all.length - GROUND_COUNT).filter(s => s.role !== 'debris' || Math.hypot(s.x - M.x, s.z - M.z) > footprint + Math.max(s.w, s.d) / 2);
  // The lid rises to the height on the card where the bolt strikes, whatever the machine's depth (or higher, to clear the body).
  const dist = n(ctx, 'distance', 48, 30, 90);
  const m = machine(ctx, 2.2 + (lidY - 2.2) * (dist - M.z) / dist);
  const light = rakingLight(ctx);
  const density = n(ctx, 'hatchDensity', 0.6, 0, 1);
  const interruption = n(ctx, 'interruption', 0.32, 0, 1);

  // The helix, rising out of the open core, up through the gap under the lid and on out of the card.
  const core = m.core;
  const rise = helixAlong(ctx, viewB, new THREE.CatmullRomCurve3([
    core.clone().setY(2.4), core.clone().setY(M.height - 1), m.lidCentre.clone().add(new THREE.Vector3(-0.1, 0.4, 0)), m.lidCentre.clone().add(new THREE.Vector3(-0.3, 3.6, 0)), m.lidCentre.clone().add(new THREE.Vector3(-0.6, 9, 0)),
  ], false, 'centripetal'), { radius: M.helixRadius, width: M.helixWidth, pitch: 8.5, spread: 0.22, narrow: 0.15, density, interruption });

  // Ground strokes: the paving in outline, plinth and debris hatched, and the storm behind.
  const groundStrokes: Stroke[] = [];
  for (const s of ground) for (const st of facetStrokes(s, light, eye, s.role === 'stub')) groundStrokes.push({ ...st, group: 'system' });
  groundStrokes.push(...storm(ctx));

  // Machine strokes, each owned by its solid; the status ticks on every blade's outer face.
  const strokes: Stroke[] = [];
  m.solids.forEach((s, owner) => {
    for (const st of facetStrokes(s, light, eye, false)) strokes.push({ ...st, group: 'machine', owner });
  });
  const lrng = ctx.random('tower-card-lights');
  const patterns = Array.from({ length: 8 }, () => barPattern(lrng, 0.62));
  m.solids.forEach((s, i) => {
    if (m.kind[i] === 'bench') return;
    const mat = slabMatrix(s), K = 5, pattern = patterns[i % 8];
    for (let k = 0; k < K; k++) {
      if (!pattern[(i * 5 + k) % 64]) continue;
      const x0 = -s.w / 2 + (k + 0.14) * s.w / K, x1 = -s.w / 2 + (k + 0.86) * s.w / K;
      strokes.push({ ink: (i + k) % 3 === 2 ? 'acid' : 'vermilion', group: 'lights', family: 'hatch', owner: i,
        points: [new THREE.Vector3(x0, 0, s.d / 2 + 0.02).applyMatrix4(mat), new THREE.Vector3(x1, 0, s.d / 2 + 0.02).applyMatrix4(mat)] });
    }
  });
  for (const h of rise.strokes) strokes.push({ ink: h.ink, group: 'helix', family: 'membrane', points: h.points });

  const machineGeoms = m.solids.map(slabGeometry).concat(rise.meshes);
  const groundGeoms = ground.map(slabGeometry);
  const geometries = [...groundGeoms, ...machineGeoms];
  const pageAt = (p: THREE.Vector3): Point => pageOf(view, p);
  const { main: bolt, branch } = boltPath(ctx, pageAt(new THREE.Vector3(0, lidY, 0)), pageAt(new THREE.Vector3(0, 0, 4.5)));
  const half = 3 + 4 * n(ctx, 'bolt', 0.5, 0, 1);
  const along = { x: bolt.at(-1)!.x - bolt[0].x, y: bolt.at(-1)!.y - bolt[0].y };
  const al = Math.hypot(along.x, along.y);
  const amount = 3 + 8 * n(ctx, 'slip', 0.5, 0, 1);
  const slip = { x: along.x / al * amount + along.y / al * amount * 0.25, y: along.y / al * amount - along.x / al * amount * 0.25 };
  const ticks = ctx.params.machineTicks === 'lit' ? 'lit' : 'dead';
  try {
    const depth = renderDepthBufferCPU(geometries, view, W, H);
    // The machine's pass: everything that can stand in front of it, the depth range fitted round it.
    const near = [...machineGeoms, ...groundGeoms.filter((_, i) => ground[i].role !== 'stub')];
    fitDepthRange(viewB, near);
    const depthB = renderDepthBufferCPU(near, viewB, W2, H2);

    // The phrase, a word to a panel, each in a column of its own and in reading order top to bottom:
    // on whichever face of the panel sees the eye (the outer faces of the near columns, the inner faces
    // of the far ones through the open C), off the bolt (no word torn in two), off the helix, inside the card.
    type Face = SloganSurface & { col: number; y: number };
    // A face behind the helix's axis must stand clear of where the helix crosses the sheet.
    const onHelix = meshCoverage(rise.meshes, view, TABLOID_PAGE, 2.5);
    const axisDepth = eye.distanceTo(core);
    // Each panel offers whichever of its four upright faces sees the eye best: outer, inner, or the
    // radial ends at the mouth of the C; each bench base offers its outer face.
    const turns = [0, Math.PI, Math.PI / 2, -Math.PI / 2].map(a => new THREE.Matrix4().makeRotationY(a));
    const faces = (boltGap: number): Face[] => {
      const out: Face[] = [];
      m.solids.forEach((s, id) => {
        const bench = m.kind[id] === 'bench' && s.h > 1;
        if (!(m.kind[id] === 'panel' || bench) || m.lid.has(id)) return;
        const matrix = slabMatrix(s), centre = new THREE.Vector3(s.x, s.y, s.z), toEye = eye.clone().sub(centre).normalize();
        let best: { face: THREE.Matrix4; w: number; d: number; sees: number } | null = null;
        for (const [k, turn] of turns.entries()) {
          if (bench && k > 0) break;
          const face = matrix.clone().multiply(turn);
          const sees = new THREE.Vector3(0, 0, 1).transformDirection(face).dot(toEye);
          const [w, d] = k < 2 ? [s.w, s.d] : [s.d, s.w];
          if (sees >= 0.45 && (!best || sees > best.sees)) best = { face, w, d, sees };
        }
        if (!best) return;
        const { face, w, d } = best;
        const at = (x: number) => pageAt(new THREE.Vector3(x, 0, d / 2).applyMatrix4(face));
        const p = at(0);
        const behind = eye.distanceTo(new THREE.Vector3(0, 0, d / 2).applyMatrix4(face)) > axisDepth;
        const clear = !behind || [-0.5, -0.25, 0, 0.25, 0.5].every(t => !onHelix(at(t * w)));
        if (clear && sideOf(bolt, p).dist > half + boltGap && p.x > CARD.x0 + 8 && p.x < CARD.x1 - 8) {
          out.push({ id, matrix: face, w, h: s.h, d, col: m.column[id], y: p.y });
        }
      });
      return out;
    };
    const env = {
      view: viewB, depth: depthB, width: W2, height: H2, bias: 0.0014, mmPerPx: MM2_Y,
      art: { x0: CARD.x0 / MM2_X, x1: CARD.x1 / MM2_X, y0: CARD.y0 / MM2_Y, y1: CARD.y1 / MM2_Y },
    };
    const settings = sloganSettings(ctx);
    const words = settings.count > 0 ? settings.text.split(' ').filter(Boolean) : [];
    const one = (params: Record<string, unknown>): SketchContext => ({ ...ctx, params: { ...ctx.params, ...params } as SketchContext['params'] });
    const slogans = { strokes: [] as THREE.Vector3[][], titleStrokes: [] as THREE.Vector3[][], knockouts: new Map<number, Point[][]>() };
    const keep = (plan: ReturnType<typeof planSlogans>) => {
      slogans.strokes.push(...plan.strokes);
      slogans.titleStrokes.push(...plan.titleStrokes);
      for (const [id, quads] of plan.knockouts) slogans.knockouts.set(id, [...(slogans.knockouts.get(id) ?? []), ...quads]);
    };
    const offered = faces(12);
    const top = Math.min(...offered.map(f => f.y)), span = Math.max(1, Math.max(...offered.map(f => f.y)) - top);
    const usedCols = new Set<number>(), usedIds = new Set<number>(), colYs = new Map<number, number[]>();
    let prev = -Infinity, prevX = -Infinity;
    words.forEach((word, i) => {
      // Each word owns its share of the height, so the phrase spreads top to bottom and saves room for the rest.
      const lo = top + span * (i - 0.3) / words.length, hi = top + span * (i + 1) / words.length;
      // A column's panels and its bench segment count apart: the bench is a row of its own.
      const key = (f: Face) => m.kind[f.id] === 'bench' ? 100 + f.col : f.col;
      const xOf = (f: Face) => pageAt(new THREE.Vector3(0, 0, f.d / 2).applyMatrix4(f.matrix)).x;
      // Dropping down a row, keep the rightmost faces back for the words still to come.
      const roomRight = (pool: Face[]) => pool.length > words.length - 1 - i ? [...pool].sort((a, b) => xOf(a) - xOf(b)).slice(0, pool.length - (words.length - 1 - i)) : pool;
      const tries: [(f: Face) => boolean, boolean][] = [
        [f => !usedCols.has(key(f)) && f.y > Math.max(prev + 8, lo) && f.y <= hi, false],
        [f => !usedCols.has(key(f)) && f.y > prev + 8 && f.y <= top + span * (i + 1.6) / words.length, false],
        // Reading on along a row: level with the word before, further right.
        [f => !usedCols.has(key(f)) && Math.abs(f.y - prev) < 6 && xOf(f) > prevX + 20, false],
        // A column may carry a second word when the two stand well apart.
        [f => !usedIds.has(f.id) && f.y > prev + 8 && f.y <= top + span * (i + 1.6) / words.length && (colYs.get(key(f)) ?? []).every(y => Math.abs(y - f.y) > 40), false],
        [f => !usedCols.has(key(f)) && f.y > prev + 8, true],
        [f => !usedIds.has(f.id) && f.y > prev + 6, true],
      ];
      for (const [k, gap] of [12, 8, 6].entries()) for (const [j, [test, room]] of tries.entries()) {
        const pool = room ? roomRight(faces(gap).filter(test)) : faces(gap).filter(test);
        if (!pool.length) continue;
        const plan = planSlogans(one({ slogan: word, sloganCount: 1, sloganSpread: false, titleEnabled: false }), pool, env, `machine-word-${i}-${k}-${j}`);
        if (!plan.placed.length) continue;
        keep(plan);
        const at = pool.find(f => f.id === plan.placed[0].id)!;
        usedCols.add(key(at)); usedIds.add(at.id); prev = at.y; prevX = xOf(at);
        colYs.set(key(at), [...(colYs.get(key(at)) ?? []), at.y]);
        return;
      }
    });
    if (titleSettings(ctx).enabled) keep(planSlogans(one({ sloganCount: 0 }), faces(6).filter(f => !usedIds.has(f.id)), env, 'machine-title'));
    for (const points of slogans.strokes) strokes.push({ ink: settings.pen as Ink, group: 'slogan', family: 'text', points });
    for (const points of slogans.titleStrokes) strokes.push({ ink: 'lettering', group: 'title', family: 'text', points });
    // A face that carries a word drops its coloured field and its ticks, so the word sits on clean metal.
    const lettered = new Set(slogans.knockouts.keys());
    for (let k = strokes.length - 1; k >= 0; k--) {
      const st = strokes[k];
      if (st.owner !== undefined && lettered.has(st.owner) && st.family === 'hatch' && st.ink !== 'carbon') strokes.splice(k, 1);
    }
    const bandsB = [...slogans.knockouts.values()].flat();
    const bandsA = bandsB.map(q => q.map(p => ({ x: p.x * W / W2, y: p.y * H / H2 })));

    const buckets = new PartBuckets();
    const removeHidden = ctx.params.occlusion !== false;
    const slipped = slippedSide(bolt);
    // The ground and storm tear exactly as on the cantilever card; the machine reads the side by region.
    const put = (key: string, run: Point[], text: boolean, robust = false) => {
      for (const inside of clipWindow(run)) for (const path of robust ? tear(inside, bolt, slipped, slip, half) : shear(inside, bolt, slip, half)) {
        for (const kept of clipWindow(path)) buckets.add(key, kept, text);
      }
    };
    // The clock the machine ran on: a hatched square wave across the sky, torn by the bolt; the rain parts round it.
    const clock = ctx.params.machineClock === true;
    const cy = CARD.y0 + 0.03 * (CARD.y1 - CARD.y0), amp = 3.5, period = 22, clockHalf = 0.8;
    const wave: Point[] = [];
    for (let x = CARD.x0 - period, k = 0; x < CARD.x1 + period; x += period / 2, k++) {
      const y = cy + (k % 2 ? amp : -amp);
      wave.push({ x, y }, { x: x + period / 2, y });
    }
    projectStrokes(groundStrokes, { view, depth, width: W, height: H }, {
      hidden: () => removeHidden,
      pieces: c => bandsA.length === 0 ? [c] : clearBands(c, bandsA, MM_Y),
      begin: st => runs => {
        for (const run of runs) {
          const pts = scalePoints(run, MM_X, MM_Y);
          const pieces = clock && st.group === 'storm' ? keepAlong(pts, p => sideOf(wave, p).dist > clockHalf + 1.2, 0.2) : [pts];
          for (const piece of pieces) put(`${st.group}-${st.ink}`, piece, false);
        }
      },
    });
    projectStrokes(strokes, { view: viewB, depth: depthB, width: W2, height: H2 }, {
      hidden: st => removeHidden && st.family !== 'text',
      pieces: (c, st) => st.family === 'text' || bandsB.length === 0 ? [c] : clearBands(c, bandsB, MM2_Y),
      begin: st => runs => {
        for (const run of runs) {
          const pts = scalePoints(run, MM2_X, MM2_Y);
          let key = `${st.group}-${st.ink}`;
          // Dead on the slipped side: past the tear the machine's ticks go dark.
          if (st.group === 'lights' && ticks === 'dead' && pts.length && slipped(pts[Math.floor(pts.length / 2)])) key = 'lights-carbon';
          put(key, pts, st.family === 'text', true);
        }
      },
    });

    // The clock stands behind everything standing.
    if (clock) {
      const solidThings = meshCoverage(machineGeoms, view, TABLOID_PAGE, 1.6);
      const box = { x0: CARD.x0, x1: CARD.x1, y0: cy - amp - 4, y1: cy + amp + 4 };
      for (const path of bandMarks(wave, clockHalf, box, { pitch: 0.8, angle: Math.PI / 4 })) {
        for (const inside of clipWindow(path)) for (const piece of keepAlong(inside, p => !solidThings(p), 0.12)) {
          for (const torn of tear(piece, bolt, slipped, slip, half)) for (const kept of clipWindow(torn)) buckets.add('clock-carbon', kept, true);
        }
      }
    }

    const parts = buckets.toParts(['storm', 'clock', 'system', 'machine', 'lights', 'helix', 'slogan', 'title'], INKS);
    parts.push({ id: 'bolt-carbon', pen: 'carbon', paths: [...bandMarks(bolt, half, CARD), ...bandMarks(branch, half * 0.35, CARD)].flatMap(p => clipWindow(p)) });
    // The shared horizon, torn like everything else, and hidden behind the machine.
    const standing = meshCoverage(machineGeoms, view, TABLOID_PAGE, 0.6);
    parts.push({ id: 'horizon-carbon', pen: 'carbon', paths: shear([{ x: CARD.x0, y: HORIZON_Y }, { x: CARD.x1, y: HORIZON_Y }], bolt, slip, half)
      .flatMap(path => keepAlong(path, p => !standing(p), 0.3)) });
    parts.push(...cardFrame('XVI', 'THE TOWER'));
    return parts;
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}
