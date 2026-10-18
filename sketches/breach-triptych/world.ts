import * as THREE from 'three';
import type { Control, Cut, Page, Pen, Point, SketchContext } from '../../src/sketch/types.ts';
import { inkPen } from '../../src/sketch/materials.ts';
import { strokeText, measureStrokeText } from '../../src/sketch/stroke-text.ts';
import { barCut, footprintOf } from '../kit/assembly.ts';
import { HEM, agentFigure, headCoil, type Agent } from '../kit/agent.ts';
import { hatchedBar } from '../kit/fills.ts';
import { n } from '../kit/params.ts';
import { keepAlong } from '../kit/page.ts';
import { pageOf } from '../kit/perspective.ts';
import { faceDarkness, facetStrokes, slabMatrix, solid, type FacetStroke, type Slab } from '../kit/slabs.ts';
import type { JointAngles, JointName, Proportions } from '../kit/mannequin/skeleton.ts';
import type { Ink } from '../kit/types.ts';

/**
 * The Breach triptych "Lintel": the world the three panels share. The censor bar is cut from the Plenipotentiary's
 * face (L); the same piece of paper is glued two panels away as the lintel of a gate (R); between them the gaze crosses
 * a plain at eye height (C). The hole, the sightline and the lintel sit at one height on the page.
 *
 * Everything here is deterministic from the seed and the params, and every panel takes the same seed and params (one
 * shared control list, `CONTROLS`), so R and C recompute L's bar exactly:
 *   - the bust's camera and head (`bustFrame`), and from them L's bar (`lintelBar`): its quad in page millimetres, its
 *     seeded tilt and its `part` cut;
 *   - the eye height, `bar.centre.y`: the one page height the three panels share;
 *   - R's lintel (`lintelPlacement`): the bar turned level (`rotate = -tilt`) and moved across the sheet, its height kept;
 *   - C's slot (`slotRect`): a long, thin, level window at that same height.
 */

// ── The sheet ────────────────────────────────────────────────────────

/** Every panel is an 11 x 17 in sheet, trimmed at crop marks 11 mm in (about 257 x 410 mm finished). */
export const PAGE: Page = { width: 279.4, height: 431.8, margin: 11 };
/** The trim: the crop marks' rectangle. */
export const TRIM = { x0: PAGE.margin!, y0: PAGE.margin!, x1: PAGE.width - PAGE.margin!, y1: PAGE.height - PAGE.margin! };
/** Where art is drawn: the trim (the render clips art to the page margin, the crop marks' line, in any case). */
export const ART = TRIM;

/** The depth raster, 11 x 17 in units of 148 px: 4.096 Mpx, under the CPU depth pass's 4.19 Mpx budget. */
const UNIT_PX = 148;
export const W = 11 * UNIT_PX, H = 17 * UNIT_PX;
export const MM_X = PAGE.width / W, MM_Y = PAGE.height / H;

// ── Pens and the assembly ────────────────────────────────────────────

/** Inked as each ply's cut ink by finishing. */
export const CUT_PEN: Pen = { id: 'cut', color: '#1c1c1e', width: 0.35 };
export const pensOf = (inks: string[]): Pen[] => [...inks.map(inkPen), CUT_PEN];
/** Shared by the three panels' specs. `margin` and `bleed` are provisional until the calibration plot. */
export const ASSEMBLY = { control: 'ply', cutPen: 'cut', margin: 0.8, bleed: 2 } as const;
export const PAPER = {
  black: { id: 'black', color: '#141416' },
  gold: { id: 'gold-yellow', color: '#e0b13a' },
  white: { id: 'white', color: '#f7f6f2' },
};

// ── Controls, shared by every panel ──────────────────────────────────

/** Every panel declares these, so one params object draws all three (and R recomputes L's bar). */
export const CONTROLS: Control[] = [
  // The bust (L), and through it the bar, the eye height and the lintel.
  { type: 'slider', id: 'scale', label: 'World units per canon unit (6 or more)', default: 6, min: 2, max: 30, step: 0.5, group: 'Bust' },
  { type: 'slider', id: 'density', label: 'Suit line density', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Bust' },
  { type: 'slider', id: 'slack', label: 'Figure hidden-line slack (of its scale)', default: 0.15, min: 0.01, max: 2, step: 0.01, group: 'Bust' },
  { type: 'slider', id: 'elbow', label: 'Elbow bend (90: forearms forward, the kit\'s; low: they hang off the sheet)', default: 15, min: 0, max: 120, step: 1, units: '°', group: 'Bust' },
  { type: 'select', id: 'gaze', label: 'Where the head looks, and the camera', default: 'down', options: ['up', 'level', 'down', 'camera'],
    optionLabels: { up: 'Up: the seated pose\'s head (chin seen), camera 25° up', level: 'Level: head and neck straight, camera 25° up', down: 'Down: a slight nod toward us, camera 25° up', camera: 'Up, with the camera only 13° up' }, group: 'Bust' },
  { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 30, max: 80, step: 1, group: 'Bust' },
  { type: 'slider', id: 'fitMargin', label: 'Margin the shoulders are fitted inside', default: 40, min: 0, max: 60, step: 1, units: 'mm', group: 'Bust' },
  { type: 'slider', id: 'eyeAt', label: 'Eye height on the sheet (the line the three panels share)', default: 123.4, min: 60, max: 260, step: 0.1, units: 'mm', group: 'Bust' },
  { type: 'slider', id: 'reach', label: 'Reach of the head\'s light (canon units)', default: 2, min: 0.5, max: 8, step: 0.1, group: 'Bust' },
  { type: 'slider', id: 'value', label: 'Value far from the head', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Bust' },
  { type: 'slider', id: 'impression', label: 'Breakup of the value', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Bust' },
  { type: 'select', id: 'glare', label: 'Where the silver is', default: 'head', options: ['head', 'away'],
    optionLabels: { head: 'Densest at the head (the head is the light)', away: 'Bare at the head (the kit\'s value, on black)' }, group: 'Bust' },
  { type: 'slider', id: 'slabMm', label: 'Background slab hatch pitch', default: 7, min: 3, max: 20, step: 0.5, units: 'mm', group: 'Bust' },
  { type: 'slider', id: 'barPitch', label: 'Censor bar hatch pitch (the silver on the part that becomes the lintel)', default: 2.6, min: 0.6, max: 5, step: 0.1, units: 'mm', group: 'Bust' },
  { type: 'toggle', id: 'holeBar', label: 'The censor bar in black ink on the gold under the hole (else bare gold)', default: true, group: 'Bust' },
  // The plain (C).
  { type: 'slider', id: 'slotMm', label: 'Gold horizon band (the slot) height', default: 5, min: 4, max: 14, step: 0.5, units: 'mm', group: 'Plain' },
  { type: 'select', id: 'ground', label: 'What C\'s ground is', default: 'corridor', options: ['paving', 'corridor', 'field', 'water'],
    optionLabels: { paving: 'Paving (R1): a paved plain in raking light', corridor: 'Corridor: two rows of low stelae converging on the band', field: 'Restraint field: standing slabs in the bar\'s proportions, at its tilt', water: 'Still water: level ripples, a few monoliths and their reflections' }, group: 'Plain' },
  { type: 'slider', id: 'fieldCount', label: 'Restraint field: how many slabs', default: 70, min: 10, max: 120, step: 1, group: 'Plain' },
  { type: 'slider', id: 'plainFov', label: 'Plain field of view', default: 50, min: 30, max: 80, step: 1, group: 'Plain' },
  { type: 'slider', id: 'plainMm', label: 'Paving hatch pitch', default: 13, min: 3, max: 16, step: 0.5, units: 'mm', group: 'Plain' },
  { type: 'slider', id: 'lightUp', label: 'Sun elevation', default: 20, min: 4, max: 70, step: 1, units: '°', group: 'Plain' },
  { type: 'toggle', id: 'skyEcho', label: 'A sparse silver echo in the black sky (else bare black)', default: false, group: 'Plain' },
  { type: 'toggle', id: 'joints', label: 'The paving\'s courses and joints run on to the horizon (else it dissolves into glare short of it)', default: true, group: 'Plain' },
  { type: 'slider', id: 'rings', label: 'Most contour rings on a paver face', default: 3, min: 0, max: 30, step: 1, group: 'Plain' },
  { type: 'slider', id: 'gazeLines', label: 'Gaze lines in the slot', default: 5, min: 1, max: 9, step: 1, group: 'Plain' },
  // The gate (R).
  { type: 'select', id: 'piers', label: 'R\'s piers', default: 'low', options: ['thick', 'slim', 'low', 'crushed'],
    optionLabels: { thick: 'Thick (R1): four broad courses, level camera', slim: 'Slim: six tapering courses, a low horizon', low: 'Low camera: slim piers seen looking up, converging on the lintel', crushed: 'Crushed: low camera, the course under the lintel pressed out, spalls at the feet' }, group: 'Gate' },
  { type: 'slider', id: 'overhang', label: 'Lintel overhang past each pier', default: 6, min: 0, max: 20, step: 0.5, units: 'mm', group: 'Gate' },
  { type: 'slider', id: 'splay', label: 'Piers turned in, like splayed jambs', default: 22, min: 0, max: 45, step: 1, units: '°', group: 'Gate' },
  { type: 'slider', id: 'gateMm', label: 'Pier hatch pitch', default: 6.5, min: 3, max: 16, step: 0.5, units: 'mm', group: 'Gate' },
  { type: 'select', id: 'knot', label: 'What the helix does', default: 'all', options: ['joints', 'thread', 'lashings', 'all'],
    optionLabels: { joints: 'Joints: it lashes both ends of the lintel to the piers', thread: 'Thread: one strand from L\'s head across C\'s horizon to R\'s left joint', lashings: 'Lashings: it binds the piers\' courses', all: 'All: the thread binds both joints, and the courses are lashed' }, group: 'Gate' },
];

// ── The bust and the bar ─────────────────────────────────────────────

/** The Emperor's pose and proportions, the figure `agentFigure` was promoted from (`sketches/agent-bust`). */
const SIT: Partial<Record<JointName, JointAngles>> = {
  hip_l: { flex: 90, abduct: 3 }, hip_r: { flex: 90, abduct: 3 },
  knee_l: { flex: 90 }, knee_r: { flex: 90 },
  shoulder_l: { flex: 0, abduct: 12, twist: 6 }, shoulder_r: { flex: 0, abduct: 12, twist: 6 },
  elbow_l: { flex: 90 }, elbow_r: { flex: 90 },
  wrist_l: { flex: -70 }, wrist_r: { flex: -70 },
  neck: { flex: -24, twist: -30 }, head: { flex: -12, twist: -15 },
};
const BROAD: Proportions = { shoulderX: 1.28, hipX: 1.12 };

/**
 * The gaze readings: neck and head flex (degrees; negative tips the head back) and the camera's upward look. The
 * Emperor's seated pose tips the face about 28° above level and the camera sits about 35° below the head, so `up` shows
 * the underside of the jaw; `level` and `down` straighten or nod the head, `camera` keeps the pose and lowers the look.
 */
export const GAZE: Record<string, { neck: number; head: number; pitch: number }> = {
  up: { neck: -24, head: -12, pitch: 25 },
  level: { neck: -4, head: 0, pitch: 25 },
  down: { neck: 6, head: 10, pitch: 25 },
  camera: { neck: -24, head: -12, pitch: 13 },
};
export const gazeOf = (ctx: SketchContext) => GAZE[String(ctx.params.gaze)] ?? GAZE.down;
const BUILD = 1.3;

export interface BustFrame {
  fig: Agent;
  /** World units per canon unit. */
  K: number;
  view: THREE.PerspectiveCamera;
  eye: THREE.Vector3;
  forward: THREE.Vector3;
  /** Page millimetres per world unit at unit distance. */
  f: number;
  mmPerUnit: (p: THREE.Vector3) => number;
  /** Where the eyes are on the page, and the head's diameter there in millimetres. */
  eyes: Point;
  headMm: number;
}

/** A raw perspective camera at `D` from `target`, below it and looking up by `pitch`. */
function upCamera(fov: number, pitch: number, target: THREE.Vector3, D: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(fov, W / H, 1, 1e6);
  c.position.copy(target).add(new THREE.Vector3(0, -Math.sin(pitch), Math.cos(pitch)).multiplyScalar(D));
  c.lookAt(target);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

/**
 * The seated agent seen from below, fitted so the shoulders fill the sheet between `fitMargin` and the eyes sit on the
 * shared eye height `eyeAt` (the recipe of `sketches/agent-bust`, which fits the head's centre instead): the figure,
 * the camera and the eyes on the page.
 */
export function bustFrame(ctx: SketchContext): BustFrame {
  const K = n(ctx, 'scale', 6, 2, 30);
  const FOV = n(ctx, 'fov', 54, 30, 80);
  const gaze = gazeOf(ctx);
  const pitch = THREE.MathUtils.degToRad(gaze.pitch);
  const elbow = n(ctx, 'elbow', 15, 0, 120);
  const pose = { ...SIT, elbow_l: { flex: elbow }, elbow_r: { flex: elbow }, neck: { ...SIT.neck, flex: gaze.neck }, head: { ...SIT.head, flex: gaze.head } };
  const yaw = -THREE.MathUtils.degToRad(36);
  const fig = agentFigure({ height: 24 * K, anchor: new THREE.Vector3(), yaw, pose, proportions: BROAD, build: BUILD, facets: 6, bow: 0.015, hem: HEM });
  const { body, head } = fig;
  const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const bust: THREE.Vector3[] = [...headCoil(head)];
  for (let i = 0; i <= 16; i++) for (let j = 0; j < 24; j++) bust.push(body.trunk.point(0.62 + 0.38 * i / 16, j / 24));
  let target = head.centre.clone().lerp(fig.skeleton.at('chest'), 0.4), D = 40 * K;
  // The eyes, where the bar goes: fitted onto the shared eye height, whatever the gaze.
  const eyePoint = head.centre.clone().addScaledVector(head.face, 0.9 * head.r).addScaledVector(head.axis, 0.12 * head.r);
  const margin = n(ctx, 'fitMargin', 40, 0, 60), eyeAt = n(ctx, 'eyeAt', 123.4, 60, 260);
  for (let it = 0; it < 60; it++) {
    const c = upCamera(FOV, pitch, target, D);
    const ps = bust.map(p => pageOf(c, p, PAGE));
    const x0 = Math.min(...ps.map(p => p.x)), x1 = Math.max(...ps.map(p => p.x));
    const right = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 1);
    const dx = (x0 + x1) / 2 - PAGE.width / 2, dy = pageOf(c, eyePoint, PAGE).y - eyeAt;
    target = target.clone().addScaledVector(right, dx * D / f).addScaledVector(up, -dy * D / f);
    D *= (x1 - x0) / (PAGE.width - 2 * margin);
  }
  const view = upCamera(FOV, pitch, target, D);
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const mmPerUnit = (p: THREE.Vector3) => f / -p.clone().applyMatrix4(view.matrixWorldInverse).z;
  const eyes = pageOf(view, eyePoint, PAGE);
  return { fig, K, view, eye: view.position.clone(), forward, f, mmPerUnit, eyes, headMm: 2 * head.r * mmPerUnit(head.centre) };
}

export interface LintelBar {
  /** The bar's corners on L's page, clockwise, and its plotted marks (outline, rule, crossing hatch). */
  quad: Point[];
  paths: Point[][];
  /** Its seeded tilt, radians (+x toward +y, clockwise on the page). */
  tilt: number;
  /** Its centre on L's page: `centre.y` is the eye height the three panels share. */
  centre: Point;
  l: number;
  h: number;
  /** The bar as L's black ply cuts it: a part, cut out and kept. */
  cut: Cut;
}

/** The bar's id on L's black ply: R's onlay names it as `lintel-l/black/bar`. */
export const BAR_ID = 'bar';
/** The least paper between the bar and the trim on L (mm). */
const BAR_CLEAR = 8;

/**
 * L's censor bar: flat on the sheet across the eyes, 1.75 x 0.36 of the projected head, at a seeded tilt; its double
 * rule and two crossing families in silver, at `barPitch` and 1.3 times it, open enough that the black paper reads when
 * it is glued on R as the lintel (R1 had 0.62 mm).
 */
export function lintelBar(ctx: SketchContext, frame: BustFrame): LintelBar {
  const brng = ctx.random('bust-censor');
  const tilt = (brng() < 0.5 ? -1 : 1) * (0.06 + 0.1 * (0.5 + brng()));
  const l = 1.75 * frame.headMm, h = 0.36 * frame.headMm;
  const pitch = n(ctx, 'barPitch', 2.6, 0.6, 5);
  // Centred on the eyes, but held BAR_CLEAR inside the trim: a head turned to the side has its eyes near its edge, and
  // the bar, longer than the head is wide, still covers them when it moves along.
  const reach = l / 2 * Math.abs(Math.cos(tilt)) + h / 2 * Math.abs(Math.sin(tilt));
  const cx = Math.max(TRIM.x0 + BAR_CLEAR + reach, Math.min(TRIM.x1 - BAR_CLEAR - reach, frame.eyes.x));
  const centre = { x: cx, y: frame.eyes.y };
  const bar = hatchedBar({ cx, cy: centre.y, l, h }, tilt, [[Math.PI / 3, pitch], [-Math.PI / 3, 1.3 * pitch]], 1.1, 1.6, 0);
  return { quad: bar.quad, paths: bar.paths, tilt, centre, l, h, cut: barCut(BAR_ID, bar.quad, 'part') };
}

/**
 * The censor bar again, in black ink on L's gold sheet, seen through the hole the bar left: a double rule `rules` mm
 * inside the hole's edge and two crossing families (`pitch`, 1.3 times it) run out `bleed` mm past the edge under the
 * black paper, so a knife a little off never shows a bare gold rim. The hatch gives way between the two rules so they
 * read. Sparse, so the gold still glows.
 */
export function holeBarPaths(bar: LintelBar, bleed: number, pitch = 2, rules: [number, number] = [1.6, 2.7]): Point[][] {
  const { rings, between } = holeBarRules(bar, rules);
  const grown = hatchedBar({ cx: bar.centre.x, cy: bar.centre.y, l: bar.l + 2 * bleed, h: bar.h + 2 * bleed }, bar.tilt, [[Math.PI / 3, pitch], [-Math.PI / 3, 1.3 * pitch]], 0, 0.2, 1);
  const hatch = grown.paths.slice(1).flatMap(path => keepAlong(path, p => !between(p), 0.2));
  return [...rings, ...hatch];
}

/**
 * The bar's double rule, `rules` mm inside its edge, and the band about the rules where a fill gives way so they read;
 * `inside(p, grow)`: whether a page point lies in the bar grown by `grow` mm.
 */
export function holeBarRules(bar: Pick<LintelBar, 'centre' | 'tilt' | 'l' | 'h'>, rules: [number, number] = [1.6, 2.7]): { rings: Point[][]; between: (p: Point) => boolean; inside: (p: Point, grow: number) => boolean } {
  const ux = Math.cos(bar.tilt), uy = Math.sin(bar.tilt);
  const local = (p: Point) => { const dx = p.x - bar.centre.x, dy = p.y - bar.centre.y; return { s: dx * ux + dy * uy, t: -dx * uy + dy * ux }; };
  const at = (s: number, t: number): Point => ({ x: bar.centre.x + ux * s - uy * t, y: bar.centre.y + uy * s + ux * t });
  const inset = (p: Point) => { const q = local(p); return Math.min(bar.l / 2 - Math.abs(q.s), bar.h / 2 - Math.abs(q.t)); };
  const ring = (d: number): Point[] => { const a = bar.l / 2 - d, b = bar.h / 2 - d; return [at(-a, -b), at(a, -b), at(a, b), at(-a, b), at(-a, -b)]; };
  return {
    rings: [ring(rules[0]), ring(rules[1])],
    between: p => { const e = inset(p); return e > rules[0] - 0.6 && e < rules[1] + 0.6; },
    inside: (p, grow) => inset(p) > -grow,
  };
}

/** The eye height: the page y the hole, the slot and the lintel share. */
export const eyeHeight = (bar: LintelBar): number => bar.centre.y;

/**
 * Where R glues the bar: turned level (`rotate = -tilt`, in degrees) and moved to the middle of the sheet, its height
 * kept (`dy = 0`), so the lintel sits at the eye height. `footprintOf` of the part cut is its outline on R.
 */
export function lintelPlacement(bar: LintelBar): { dx: number; dy: number; rotate: number } {
  return { dx: PAGE.width / 2 - bar.centre.x, dy: 0, rotate: -THREE.MathUtils.radToDeg(bar.tilt) };
}

/** R's onlay footprint: L's part, placed. */
export const lintelFootprint = (bar: LintelBar): Cut => footprintOf(bar.cut, lintelPlacement(bar));

/** The level lintel on R's page: its rectangle (the footprint's bounds; it is level, so they are its corners). */
export function lintelRect(bar: LintelBar): { x0: number; x1: number; y0: number; y1: number } {
  const ring = lintelFootprint(bar).rings[0];
  return { x0: Math.min(...ring.map(p => p.x)), x1: Math.max(...ring.map(p => p.x)), y0: Math.min(...ring.map(p => p.y)), y1: Math.max(...ring.map(p => p.y)) };
}

/**
 * C's slot: the gold horizon band at the eye height, the width of the trim. The white ply's sky cut stops at its bottom
 * edge and the gold ply's at its top, so the band is gold between the black sky and the white plain.
 */
export function slotRect(ctx: SketchContext, bar: LintelBar): { x0: number; x1: number; y0: number; y1: number } {
  const h = n(ctx, 'slotMm', 5, 4, 14);
  const y = eyeHeight(bar);
  return { x0: TRIM.x0, x1: TRIM.x1, y0: y - h / 2, y1: y + h / 2 };
}

export const ringOf = (r: { x0: number; x1: number; y0: number; y1: number }): Point[] =>
  [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];

// ── The helix thread ─────────────────────────────────────────────────

/**
 * The thread: one strand of the helix through the three panels. It leaves L's head and crosses L's right edge at page
 * height `h1`, enters C's left edge at the same height (a hung triptych lines it up), stitches across C's horizon band,
 * crosses C's right edge at `h2` and enters R's left edge there, where it binds the lintel's joints. Its ribbon is
 * `widthMm` across on the sheet wherever it crosses an edge, and turns once in about `pitchMm`.
 */
export const THREAD = { h1: 70, h2: 166, widthMm: 8, pitchMm: 46 };

export type Knot = 'joints' | 'thread' | 'lashings' | 'all';
export const knotOf = (ctx: SketchContext): Knot => (['joints', 'thread', 'lashings', 'all'].includes(String(ctx.params.knot)) ? ctx.params.knot as Knot : 'all');
/** Whether the thread runs through the panels. */
export const threadOn = (knot: Knot): boolean => knot === 'thread' || knot === 'all';

/** A smooth curve through page points (centripetal Catmull-Rom), sampled about every `step` mm. */
export function smoothPath(points: Point[], step = 0.4): Point[] {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p.x, p.y, 0)), false, 'centripetal');
  return curve.getSpacedPoints(Math.max(2, Math.ceil(curve.getLength() / step))).map(v => ({ x: v.x, y: v.y }));
}

/** Arc length along a polyline to its point nearest `x` crossing (the first sample at or past it). */
function lengthTo(path: Point[], x: number): number {
  let s = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], d = Math.hypot(b.x - a.x, b.y - a.y);
    if ((a.x - x) * (b.x - x) <= 0 && a.x !== b.x) return s + d * (x - a.x) / (b.x - a.x);
    s += d;
  }
  return s;
}

export interface ThreadPath { path: Point[]; phase0: number; enter: number }

/**
 * The thread's centreline on each panel's sheet, and its twist phase where it starts. L: from the crown of the head's
 * coil up and out across the right edge at THREAD.h1, level as it leaves. C: in across the left edge at h1, down
 * through the horizon band and back several times (the stitches), out across the right edge at h2. R: in across the
 * left edge at h2 to the left pier. Each path runs a few millimetres past the trim, and the twist is continuous across
 * the panels: C's phase at its left trim is L's at its right trim, and R's at its left is C's at its right, so the
 * ribbon's width matches where the panels meet. `enter` is the arc length to the panel's left trim (0 on L). `pierEdge`
 * is the page x where R's path meets the left pier (it moves no phase).
 */
export function threadPaths(frame: BustFrame, bar: LintelBar, pierEdge = 60): { l: ThreadPath; c: ThreadPath; r: ThreadPath } {
  const crown = pageOf(frame.view, headCoil(frame.fig.head).at(-1)!, PAGE);
  const { h1, h2 } = THREAD, y = eyeHeight(bar);
  const l = smoothPath([crown, { x: crown.x + 22, y: crown.y - 14 }, { x: TRIM.x1 - 40, y: h1 - 4 }, { x: TRIM.x1 - 14, y: h1 }, { x: TRIM.x1, y: h1 }, { x: TRIM.x1 + 6, y: h1 }]);
  const c = smoothPath([{ x: TRIM.x0 - 6, y: h1 }, { x: TRIM.x0, y: h1 }, { x: TRIM.x0 + 16, y: h1 }, ...STITCHES.map(([x, dy]) => ({ x, y: y + dy })),
    { x: TRIM.x1 - 16, y: h2 }, { x: TRIM.x1, y: h2 }, { x: TRIM.x1 + 6, y: h2 }]);
  const r = smoothPath([{ x: TRIM.x0 - 6, y: h2 }, { x: TRIM.x0, y: h2 }, { x: (TRIM.x0 + pierEdge) / 2, y: h2 + 1 }, { x: pierEdge + 3, y: h2 + 2 }]);
  const turn = (mm: number) => 2 * Math.PI * mm / THREAD.pitchMm;
  const sL = lengthTo(l, TRIM.x1);
  const cIn = lengthTo(c, TRIM.x0), cOut = lengthTo(c, TRIM.x1);
  const rIn = lengthTo(r, TRIM.x0);
  return {
    l: { path: l, phase0: 0, enter: 0 },
    c: { path: c, phase0: turn(sL - cIn), enter: cIn },
    r: { path: r, phase0: turn(sL - cIn + cOut - rIn), enter: rIn },
  };
}
/** C's stitches: page x of each turn of the thread, and how far above (negative) or below the horizon it swings. */
const STITCHES: [x: number, dy: number][] = [[48, 26], [92, -24], [136, 26], [180, -24], [222, 26]];

export interface RibbonStroke { ink: Ink; points: Point[] }

/**
 * The helix as a flat twisted ribbon along a page path: two edges that cross where the ribbon turns edge-on, laminations
 * along it (fewer on its back face), a spine down the middle and ribs across. `phase0` is its twist at the path's start;
 * it turns once every `pitch` mm (times `pitchAt` of the point, where given). `skip(s)` drops everything at arc length `s` (where the thread passes under
 * something). The laminations show only where they lie `minMm` apart or more (0.6 mm by default). Returns its strokes
 * in the kit's helix inks and `mask`, lines that fill it, for a page mask of where it lies (`glyphMask`).
 */
export function flatRibbon(path: Point[], o: { width: number; pitch: number; phase0?: number; laminations?: number; ribMm?: number; skip?: (s: number) => boolean; pitchAt?: (p: Point) => number; minMm?: number }): { strokes: RibbonStroke[]; mask: Point[][] } {
  const half = o.width / 2, L = o.laminations ?? 6, ribMm = o.ribMm ?? 2.4;
  const s: number[] = [0];
  for (let i = 1; i < path.length; i++) s.push(s[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  const normal = path.map((_, i) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)], d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: -(b.y - a.y) / d, y: (b.x - a.x) / d };
  });
  // With `pitchAt` the twist's pitch varies along the path (a multiple of `pitch` at each point): its phase is integrated.
  let phase = o.phase0 ?? 0;
  const twist = o.pitchAt
    ? s.map((v, i) => { if (i) phase += 2 * Math.PI * (v - s[i - 1]) / (o.pitch * o.pitchAt!(path[i])); return Math.cos(phase); })
    : s.map(v => Math.cos((o.phase0 ?? 0) + 2 * Math.PI * v / o.pitch));
  const at = (i: number, v: number): Point => ({ x: path[i].x + normal[i].x * v * half * twist[i], y: path[i].y + normal[i].y * v * half * twist[i] });
  const hidden = (i: number) => o.skip?.(s[i]) ?? false;
  const strokes: RibbonStroke[] = [];
  const line = (ink: Ink | ((i: number) => Ink | null), v: number, show: (i: number) => boolean = () => true) => {
    let run: Point[] = [], inkOf: Ink | null = null;
    const flush = () => { if (run.length > 1 && inkOf) strokes.push({ ink: inkOf, points: run }); run = []; };
    for (let i = 0; i < path.length; i++) {
      const here = hidden(i) || !show(i) ? null : typeof ink === 'function' ? ink(i) : ink;
      if (here !== inkOf) { flush(); inkOf = here; }
      if (here) run.push(at(i, v));
    }
    flush();
  };
  line('vermilion', -1); line('vermilion', 1); line('acid', 0);
  for (let k = 1; k < L; k++) {
    const v = -1 + 2 * k / L;
    if (Math.abs(v) < 1e-9) continue;
    line(i => (twist[i] > 0 ? (k % 3 === 0 ? 'violet' : 'ultramarine') : k % 2 === 0 ? 'violet' : null), v, i => Math.abs(twist[i]) * o.width >= (o.minMm ?? 0.6) * L);
  }
  let next = 0, n = 0;
  for (let i = 0; i < path.length; i++) {
    if (s[i] < next) continue;
    next = s[i] + ribMm;
    n++;
    if (hidden(i) || Math.abs(twist[i]) * o.width < 1.2) continue;
    strokes.push({ ink: n % 8 === 0 ? 'vermilion' : n % 3 === 0 ? 'violet' : 'ultramarine', points: [at(i, -1), at(i, 1)] });
  }
  const mask: Point[][] = [];
  for (let k = 0; k <= 20; k++) {
    const v = -1 + k / 10;
    let run: Point[] = [];
    for (let i = 0; i < path.length; i++) { if (hidden(i)) { if (run.length > 1) mask.push(run); run = []; } else run.push(at(i, v)); }
    if (run.length > 1) mask.push(run);
  }
  return { strokes, mask };
}

// ── Words ────────────────────────────────────────────────────────────

/**
 * A word painted on one face of a slab, in the face's own plane, so the camera foreshortens it with the face and the
 * depth pass hides it behind whatever stands in front. `normal` is the face's outward normal and `up` the text's up,
 * both in the slab's own frame along its axes; `at` is where the word's centre sits, as fractions (-1..1) of the face's
 * half extents along the text's right and up; `cap` the cap height in world units. Returns world-space strokes, lifted
 * a hair off the face.
 */
export function faceWord(sl: Slab, word: string, o: { normal: THREE.Vector3; up: THREE.Vector3; at: [number, number]; cap: number }): THREE.Vector3[][] {
  const m = slabMatrix(sl);
  const half = new THREE.Vector3(sl.w / 2, sl.h / 2, sl.d / 2);
  const right = o.up.clone().cross(o.normal);
  const extent = (axis: THREE.Vector3) => Math.abs(axis.x) * half.x + Math.abs(axis.y) * half.y + Math.abs(axis.z) * half.z;
  const style = { face: 'sans' as const, height: o.cap };
  const width = measureStrokeText(word, style);
  const x0 = o.at[0] * extent(right) - width / 2, top = o.at[1] * extent(o.up) + o.cap / 2;
  const face = o.normal.clone().multiplyScalar(extent(o.normal) + 0.004);
  return strokeText(word, 0, 0, style).map(path => path.map(g => face.clone()
    .addScaledVector(right, x0 + g.x).addScaledVector(o.up, top - g.y).applyMatrix4(m)));
}

/**
 * `faceWord` with the word's centre placed by where it lands on the sheet: the ray through page point `at` meets the
 * face's plane there. The cap height is `capMm` page millimetres at that point. Undefined when the point is not on the
 * face (off its edges, or the face turned away).
 */
export function faceWordAt(sl: Slab, word: string, view: THREE.Camera, at: Point, o: { normal: THREE.Vector3; up: THREE.Vector3; capMm: number }): THREE.Vector3[][] | undefined {
  const m = slabMatrix(sl), inverse = m.clone().invert();
  const rot = new THREE.Matrix4().extractRotation(m);
  const half = new THREE.Vector3(sl.w / 2, sl.h / 2, sl.d / 2);
  const extent = (axis: THREE.Vector3) => Math.abs(axis.x) * half.x + Math.abs(axis.y) * half.y + Math.abs(axis.z) * half.z;
  const normal = o.normal.clone().applyMatrix4(rot);
  const point = o.normal.clone().multiplyScalar(extent(o.normal)).applyMatrix4(m);
  const ray = new THREE.Vector3(at.x / PAGE.width * 2 - 1, -(at.y / PAGE.height * 2 - 1), 0.5).unproject(view).sub(view.position).normalize();
  const along = ray.dot(normal);
  if (along >= 0) return undefined;
  const hit = view.position.clone().addScaledVector(ray, point.clone().sub(view.position).dot(normal) / along);
  const local = hit.clone().applyMatrix4(inverse);
  const right = o.up.clone().cross(o.normal);
  const u = local.dot(right) / extent(right), v = local.dot(o.up) / extent(o.up);
  if (Math.abs(u) > 1 || Math.abs(v) > 1) return undefined;
  // Page millimetres per world unit at the hit, along the face's less foreshortened axis (the text's right or up).
  const here = pageOf(view, hit, PAGE);
  const scale = (axis: THREE.Vector3) => { const p = pageOf(view, hit.clone().addScaledVector(axis.clone().applyMatrix4(rot), 1e-3), PAGE); return Math.hypot(p.x - here.x, p.y - here.y) / 1e-3; };
  return faceWord(sl, word, { normal: o.normal, up: o.up, at: [u, v], cap: o.capMm / Math.max(scale(right), scale(o.up)) });
}

/**
 * Whether `facetStrokes` hatches a slab face under every one of `points` (world points on the face): a face dark enough
 * for its field hatch (darkness 0.32 or more) is hatched all over; a lighter one only in its band of contour rings, which
 * reaches `0.12 + 0.6 * darkness` of the face's smaller half extent in from its edges.
 */
export function hatchedUnder(sl: Slab, normal: THREE.Vector3, up: THREE.Vector3, light: THREE.Vector3, points: THREE.Vector3[]): boolean {
  const m = slabMatrix(sl), inverse = m.clone().invert();
  const d = faceDarkness(normal.clone().applyMatrix4(new THREE.Matrix4().extractRotation(m)), light, sl.tone);
  if (d >= 0.32) return true;
  const half = new THREE.Vector3(sl.w / 2, sl.h / 2, sl.d / 2);
  const right = up.clone().cross(normal);
  const extent = (axis: THREE.Vector3) => Math.abs(axis.x) * half.x + Math.abs(axis.y) * half.y + Math.abs(axis.z) * half.z;
  const a = extent(right), b = extent(up), band = Math.min(a, b) * (0.12 + 0.6 * d);
  return points.every(p => { const q = p.clone().applyMatrix4(inverse); return Math.min(a - Math.abs(q.dot(right)), b - Math.abs(q.dot(up))) < band; });
}

/** A word laid flat in page millimetres: its left end at `x`, cap top at `top`, turned `angle` radians about its start. */
export function pageWord(word: string, x: number, top: number, cap: number, angle = 0): Point[][] {
  const c = Math.cos(angle), s = Math.sin(angle);
  return strokeText(word, 0, 0, { face: 'sans', height: cap }).map(path => path.map(g => ({ x: x + c * g.x - s * g.y, y: top + s * g.x + c * g.y })));
}

// ── The plain: shared by C (to the horizon) and R (up to the gate) ──

/** The sun, low from the left and a little behind the scene, toward which `facetStrokes` lights faces. */
export function sun(ctx: SketchContext): THREE.Vector3 {
  const e = THREE.MathUtils.degToRad(n(ctx, 'lightUp', 20, 4, 70));
  return new THREE.Vector3(-0.8 * Math.cos(e), Math.sin(e), -0.6 * Math.cos(e)).normalize();
}

export interface PavingOptions {
  /** Paving pitch (slab plus joint), world units, and the joint. */
  pitch: number;
  joint: number;
  /** The slabs run from `near` to `far` in front of the eye (distances along -z). */
  near: number;
  far: number;
  /** Half the horizontal field of view, radians: columns cover it. */
  halfWidth: number;
  /** Where no paver is laid (a pier's footing), by its centre. */
  keepOut?: (x: number, z: number) => boolean;
  /** The grid's shift across, in modules, so no joint runs straight up the middle to the vanishing point (default 0.37). */
  shift?: number;
  salt: string;
}

/**
 * A paved plain: slab pavers on the ground (the eye looks down -z from x = 0) on a grid of `pitch` modules, some of them
 * laid as double or square slabs so the plain is not a tiled floor, each a little heaved and tilted so the raking light
 * finds it, the joints running straight to the vanishing point.
 */
export function paving(ctx: SketchContext, o: PavingOptions): Slab[] {
  const rng = ctx.random(o.salt);
  const out: Slab[] = [];
  const taken = new Set<string>();
  const first = Math.floor(o.near / o.pitch), last = Math.ceil(o.far / o.pitch);
  const reachAt = (row: number) => Math.ceil(((row + 2) * o.pitch * Math.tan(o.halfWidth) + o.pitch) / o.pitch);
  for (let row = first; row < last; row++) {
    const reach = reachAt(row);
    for (let col = -reach; col < reach; col++) {
      if (taken.has(`${row},${col}`)) continue;
      // The slab's size in modules: across (columns) and deep (rows).
      const r = rng();
      let across = r < 0.14 ? 2 : r < 0.32 ? 2 : 1, deep = r < 0.14 ? 2 : r > 0.32 && r < 0.46 ? 2 : 1;
      if (across === 2 && (col + 1 >= reach || taken.has(`${row},${col + 1}`))) across = 1;
      if (deep === 2 && row + 1 >= last) deep = 1;
      for (let i = 0; i < across; i++) for (let j = 0; j < deep; j++) taken.add(`${row + j},${col + i}`);
      const x = (col + across / 2 + (o.shift ?? 0.37)) * o.pitch, z = -(row + deep / 2) * o.pitch;
      const heave = (rng() - 0.45) * 0.1, rx = (rng() - 0.5) * 0.04, rz = (rng() - 0.5) * 0.04;
      if (o.keepOut?.(x, z)) continue;
      const t = 0.2 + heave;
      const sl = solid(x, t / 2, z, across * o.pitch - o.joint, t, deep * o.pitch - o.joint, out.length, 'stub');
      sl.rx = rx; sl.rz = rz;
      out.push(sl);
    }
  }
  return out;
}

/**
 * A paver's tone in the raking light: heavier near the eye and fading toward the horizon, where the sun's glare lies
 * along the gaze, with a seeded scatter so the plain is not a gradient. `t` is the paver's distance as a share of the
 * paving's depth (0 nearest).
 */
export const paverTone = (t: number, r: number): number => Math.max(0, 0.45 - 0.45 * t ** 0.8 + 0.4 * (r - 0.5));

export interface PlainOptions {
  /** The paving's depth: its nearest and farthest paver distances (along -z). */
  near: number;
  far: number;
  /** Eye height above the plain, world units. */
  eyeH: number;
  light: THREE.Vector3;
  eye: THREE.Vector3;
  /** Page millimetres per world unit at a point. */
  mmPerUnit: (p: THREE.Vector3) => number;
  /** The raking hatch's pitch on the sheet, mm. */
  pitchMm: number;
  salt: string;
  /** Past this share of the depth a paver is an outline, and more and more of them are left out (default 0.5). */
  dissolve?: number;
  /** A paver shallower than this on the sheet (its foreshortened depth, mm) is an outline (default 5). */
  outlineMm?: number;
  /** The most contour rings kept on one face (the outermost); the field hatch inside stays (default: all). */
  rings?: number;
}

/** A slab's raking hatch with at most `rings` contour rings per face (the outermost ones), the rest of it kept. */
export function fewerRings(strokes: FacetStroke[], rings: number): FacetStroke[] {
  const count = new Map<number, number>();
  return strokes.filter(st => {
    if (st.family !== 'hatch' || st.points.length !== 5 || st.face === undefined) return true;
    const k = (count.get(st.face) ?? 0) + 1;
    count.set(st.face, k);
    return k <= rings;
  });
}

/**
 * The plain, paver by paver: each in the raking light at a page-millimetre pitch, its tone falling off with distance
 * (`paverTone`). Past `dissolve` of the paving's depth a paver is drawn as its outline only, and more and more of them
 * are left out toward the far end, so the plain dissolves into the glare along the horizon instead of stopping at a
 * line. Returns the pavers kept and their strokes.
 */
export function plainStrokes(ctx: SketchContext, pavers: Slab[], o: PlainOptions): { slab: Slab; strokes: FacetStroke[] }[] {
  const rng = ctx.random(o.salt);
  const dissolve = o.dissolve ?? 0.5, outlineMm = o.outlineMm ?? 5;
  const out: { slab: Slab; strokes: FacetStroke[] }[] = [];
  for (const sl of pavers) {
    const t = Math.max(0, (-sl.z - o.near) / (o.far - o.near));
    const tone = rng(), keep = rng();
    const fade = Math.max(0, (t - dissolve) / (1 - dissolve));
    if (keep < fade ** 0.8) continue;
    const at = new THREE.Vector3(sl.x, sl.y, sl.z), unit = o.mmPerUnit(at);
    // The paver's depth on the sheet: the ground foreshortened by the eye's height over its distance.
    const deep = sl.d * unit * o.eyeH / Math.max(1e-6, -sl.z);
    sl.tone = paverTone(t, tone);
    const made = facetStrokes(sl, o.light, o.eye, fade > 0 || deep < outlineMm, o.pitchMm / unit);
    out.push({ slab: sl, strokes: o.rings === undefined ? made : fewerRings(made, o.rings) });
  }
  return out;
}

/**
 * The paving on to the horizon, as lines on the ground beyond (and between) its last pavers: courses across, each drawn
 * where it stands at least `minMm` on the sheet below the last one drawn, and joints along, converging on the vanishing
 * point, every second one stopping where its neighbours close up, every fourth further on, and so on. Both run until
 * they are `stopMm` from the horizon on the sheet, where the slot's cut takes them. The grid is shifted `shift` modules
 * across, as `paving` lays it.
 */
export function farLines(o: { pitch: number; from: number; eyeH: number; f: number; halfWidth: number; minMm: number; stopMm?: number; shift?: number }): { courses: THREE.Vector3[][]; joints: THREE.Vector3[][] } {
  const ground = 0.01, stop = o.eyeH * o.f / (o.stopMm ?? 0.5), shift = o.shift ?? 0.37;
  const courses: THREE.Vector3[][] = [];
  let last = Infinity;
  for (let z = Math.ceil(o.from / o.pitch) * o.pitch; z < stop; z += o.pitch) {
    const y = o.eyeH * o.f / z;
    if (last - y < o.minMm) continue;
    last = y;
    const half = (z + o.pitch) * Math.tan(o.halfWidth) + o.pitch;
    courses.push([new THREE.Vector3(-half, ground, -z), new THREE.Vector3(half, ground, -z)]);
  }
  const joints: THREE.Vector3[][] = [];
  const reach = Math.ceil(stop * Math.tan(o.halfWidth) / o.pitch) + 1;
  for (let col = -reach; col <= reach; col++) {
    const x = (col + shift) * o.pitch;
    let k = 1;
    while (k < 4096 && col % (2 * k) === 0) k *= 2;
    const end = Math.min(stop, o.pitch * k * o.f / (1.5 * o.minMm));
    const start = Math.max(o.from, Math.abs(x) / Math.tan(o.halfWidth) - o.pitch);
    if (start < end) joints.push([new THREE.Vector3(x, ground, -start), new THREE.Vector3(x, ground, -end)]);
  }
  return { courses, joints };
}

/**
 * Sky: level dashes on the sheet from `bottom` up to `top`, rows sparse low down where the light is and closing up toward
 * the top (`open` to `close` mm apart), the dashes lengthening and their rests shortening as they climb.
 */
export function skyLines(ctx: SketchContext, salt: string, area: { x0: number; x1: number; top: number; bottom: number }, open = 18, close = 6): Point[][] {
  const rng = ctx.random(salt);
  const out: Point[][] = [];
  const span = area.bottom - area.top;
  for (let y = area.bottom; y > area.top;) {
    const t = (area.bottom - y) / span;
    let x = area.x0 + 30 * rng();
    while (x < area.x1) {
      const run = 10 + 50 * rng() * (0.4 + t), rest = 4 + 26 * rng() * (1.2 - t);
      out.push([{ x, y }, { x: Math.min(area.x1, x + run), y }]);
      x += run + rest;
    }
    y -= open + (close - open) * t ** 0.7;
  }
  return out;
}

// ── R's sky cut ──────────────────────────────────────────────────────

/** The convex hull of page points (Andrew's monotone chain), counter-clockwise in page coordinates (y down). */
export function convexHull(points: Point[]): Point[] {
  const ps = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (ps.length < 3) return ps;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [], upper: Point[] = [];
  for (const p of ps) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...ps].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** A convex polygon cut to the part with y at most `y` (above that line on the page). */
function above(poly: Point[], y: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ina = a.y <= y, inb = b.y <= y;
    if (ina) out.push(a);
    if (ina !== inb) { const t = (y - a.y) / (b.y - a.y); out.push({ x: a.x + (b.x - a.x) * t, y }); }
  }
  return out;
}

/**
 * The sky as one simple polygon: the trim's rectangle down to the horizon `y`, less the forms that rise from below the
 * horizon into it (each given by its page points, taken as their convex hull, so the cut runs on straight edges along
 * the form's outer silhouette). The forms must stand clear of each other and of the trim's sides, and cross the horizon.
 */
export function skyRing(y: number, forms: Point[][]): Point[] {
  const ring: Point[] = [{ x: TRIM.x0, y: TRIM.y0 }, { x: TRIM.x1, y: TRIM.y0 }, { x: TRIM.x1, y }];
  const notches = forms.map(points => above(convexHull(points), y)).filter(p => p.length >= 3)
    .sort((a, b) => Math.max(...b.map(p => p.x)) - Math.max(...a.map(p => p.x)));
  for (const notch of notches) {
    // Its two corners on the horizon, then the chain between them that rises into the sky, from the right one round to the left.
    const onLine = notch.map((p, i) => ({ p, i })).filter(({ p }) => Math.abs(p.y - y) < 1e-6);
    const right = onLine.reduce((a, b) => (b.p.x > a.p.x ? b : a)), left = onLine.reduce((a, b) => (b.p.x < a.p.x ? b : a));
    const walk = (step: number) => { const chain: Point[] = []; for (let i = right.i; ; i = (i + step + notch.length) % notch.length) { chain.push(notch[i]); if (i === left.i) break; } return chain; };
    const forward = walk(1), backward = walk(-1);
    // The chain along the horizon itself is the two corners alone (or only points on the line).
    const rises = (chain: Point[]) => chain.some(p => p.y < y - 1e-6);
    ring.push(...(rises(forward) ? forward : backward));
  }
  ring.push({ x: TRIM.x0, y });
  return ring;
}
