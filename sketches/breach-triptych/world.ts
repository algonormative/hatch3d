import * as THREE from 'three';
import type { Control, Cut, Page, Pen, Point, SketchContext } from '../../src/sketch/types.ts';
import { inkPen } from '../../src/sketch/materials.ts';
import { strokeText, measureStrokeText } from '../../src/sketch/stroke-text.ts';
import { barCut, footprintOf } from '../kit/assembly.ts';
import { HEM, agentFigure, headCoil, type Agent } from '../kit/agent.ts';
import { hatchedBar } from '../kit/fills.ts';
import { n } from '../kit/params.ts';
import { pageOf } from '../kit/perspective.ts';
import { facetStrokes, slabMatrix, solid, type FacetStroke, type Slab } from '../kit/slabs.ts';
import type { JointAngles, JointName, Proportions } from '../kit/mannequin/skeleton.ts';

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
  { type: 'slider', id: 'fov', label: 'Field of view', default: 54, min: 30, max: 80, step: 1, group: 'Bust' },
  { type: 'slider', id: 'pitch', label: 'Looking up', default: 25, min: 0, max: 60, step: 1, units: '°', group: 'Bust' },
  { type: 'slider', id: 'fitMargin', label: 'Margin the shoulders are fitted inside', default: 40, min: 0, max: 60, step: 1, units: 'mm', group: 'Bust' },
  { type: 'slider', id: 'headAt', label: 'Head centre, share of the sheet down', default: 0.33, min: 0.1, max: 0.6, step: 0.01, group: 'Bust' },
  { type: 'slider', id: 'reach', label: 'Reach of the head\'s light (canon units)', default: 2, min: 0.5, max: 8, step: 0.1, group: 'Bust' },
  { type: 'slider', id: 'value', label: 'Value far from the head', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Bust' },
  { type: 'slider', id: 'impression', label: 'Breakup of the value', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Bust' },
  { type: 'select', id: 'glare', label: 'Where the silver is', default: 'head', options: ['head', 'away'],
    optionLabels: { head: 'Densest at the head (the head is the light)', away: 'Bare at the head (the kit\'s value, on black)' }, group: 'Bust' },
  { type: 'slider', id: 'slabMm', label: 'Background slab hatch pitch', default: 7, min: 3, max: 20, step: 0.5, units: 'mm', group: 'Bust' },
  { type: 'toggle', id: 'holeLines', label: 'Gaze lines on the gold under the hole', default: false, group: 'Bust' },
  // The plain (C).
  { type: 'slider', id: 'slotMm', label: 'Slot height', default: 5, min: 3.5, max: 14, step: 0.5, units: 'mm', group: 'Plain' },
  { type: 'slider', id: 'slotInset', label: 'Slot ends, in from the trim', default: 16, min: 8, max: 60, step: 1, units: 'mm', group: 'Plain' },
  { type: 'slider', id: 'plainFov', label: 'Plain field of view', default: 50, min: 30, max: 80, step: 1, group: 'Plain' },
  { type: 'slider', id: 'plainMm', label: 'Paving hatch pitch', default: 13, min: 3, max: 16, step: 0.5, units: 'mm', group: 'Plain' },
  { type: 'slider', id: 'lightUp', label: 'Sun elevation', default: 20, min: 4, max: 70, step: 1, units: '°', group: 'Plain' },
  { type: 'toggle', id: 'sky', label: 'Sky hatch above the plain', default: true, group: 'Plain' },
  { type: 'toggle', id: 'joints', label: 'Paving joints run on to the horizon (else the plain dissolves into the glare)', default: false, group: 'Plain' },
  { type: 'slider', id: 'gaze', label: 'Gaze lines in the slot', default: 5, min: 1, max: 9, step: 1, group: 'Plain' },
  // The gate (R).
  { type: 'slider', id: 'horizon', label: 'Gate horizon, share of the sheet down', default: 0.74, min: 0.45, max: 0.9, step: 0.01, group: 'Gate' },
  { type: 'slider', id: 'pierMm', label: 'Pier width on the sheet', default: 48, min: 24, max: 70, step: 1, units: 'mm', group: 'Gate' },
  { type: 'slider', id: 'overhang', label: 'Lintel overhang past each pier', default: 6, min: 0, max: 20, step: 0.5, units: 'mm', group: 'Gate' },
  { type: 'slider', id: 'splay', label: 'Piers turned in, like splayed jambs', default: 22, min: 0, max: 45, step: 1, units: '°', group: 'Gate' },
  { type: 'slider', id: 'courses', label: 'Courses per pier', default: 4, min: 3, max: 12, step: 1, group: 'Gate' },
  { type: 'slider', id: 'gateMm', label: 'Pier hatch pitch', default: 6.5, min: 3, max: 16, step: 0.5, units: 'mm', group: 'Gate' },
  { type: 'select', id: 'knot', label: 'The joint the helix knots', default: 'left', options: ['left', 'right'], group: 'Gate' },
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
 * The seated agent seen from below, fitted so the shoulders fill the sheet between `fitMargin` and the head's centre
 * sits `headAt` of the way down (the recipe of `sketches/agent-bust`): the figure, the camera and the eyes on the page.
 */
export function bustFrame(ctx: SketchContext): BustFrame {
  const K = n(ctx, 'scale', 6, 2, 30);
  const FOV = n(ctx, 'fov', 54, 30, 80);
  const pitch = THREE.MathUtils.degToRad(n(ctx, 'pitch', 25, 0, 60));
  const elbow = n(ctx, 'elbow', 15, 0, 120);
  const pose = { ...SIT, elbow_l: { flex: elbow }, elbow_r: { flex: elbow } };
  const yaw = -THREE.MathUtils.degToRad(36);
  const fig = agentFigure({ height: 24 * K, anchor: new THREE.Vector3(), yaw, pose, proportions: BROAD, build: BUILD, facets: 6, bow: 0.015, hem: HEM });
  const { body, head } = fig;
  const f = PAGE.height / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const bust: THREE.Vector3[] = [...headCoil(head)];
  for (let i = 0; i <= 16; i++) for (let j = 0; j < 24; j++) bust.push(body.trunk.point(0.62 + 0.38 * i / 16, j / 24));
  let target = head.centre.clone().lerp(fig.skeleton.at('chest'), 0.4), D = 40 * K;
  const margin = n(ctx, 'fitMargin', 40, 0, 60), headAt = n(ctx, 'headAt', 0.33, 0.1, 0.6);
  for (let it = 0; it < 60; it++) {
    const c = upCamera(FOV, pitch, target, D);
    const ps = bust.map(p => pageOf(c, p, PAGE));
    const x0 = Math.min(...ps.map(p => p.x)), x1 = Math.max(...ps.map(p => p.x));
    const right = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 1);
    const dx = (x0 + x1) / 2 - PAGE.width / 2, dy = pageOf(c, head.centre, PAGE).y - headAt * PAGE.height;
    target = target.clone().addScaledVector(right, dx * D / f).addScaledVector(up, -dy * D / f);
    D *= (x1 - x0) / (PAGE.width - 2 * margin);
  }
  const view = upCamera(FOV, pitch, target, D);
  const forward = new THREE.Vector3();
  view.getWorldDirection(forward);
  const mmPerUnit = (p: THREE.Vector3) => f / -p.clone().applyMatrix4(view.matrixWorldInverse).z;
  const eyes = pageOf(view, head.centre.clone().addScaledVector(head.face, 0.9 * head.r).addScaledVector(head.axis, 0.12 * head.r), PAGE);
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

/** L's censor bar: flat on the sheet across the eyes, 1.75 x 0.36 of the projected head, at a seeded tilt. */
export function lintelBar(ctx: SketchContext, frame: BustFrame): LintelBar {
  const brng = ctx.random('bust-censor');
  const tilt = (brng() < 0.5 ? -1 : 1) * (0.06 + 0.1 * (0.5 + brng()));
  const l = 1.75 * frame.headMm, h = 0.36 * frame.headMm;
  const bar = hatchedBar({ cx: frame.eyes.x, cy: frame.eyes.y, l, h }, tilt, [[Math.PI / 3, 0.62], [-Math.PI / 3, 0.9]], 1.1, 1.6, 0);
  return { quad: bar.quad, paths: bar.paths, tilt, centre: { ...frame.eyes }, l, h, cut: barCut(BAR_ID, bar.quad, 'part') };
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

/** C's slot: a long, thin, level window at the eye height. */
export function slotRect(ctx: SketchContext, bar: LintelBar): { x0: number; x1: number; y0: number; y1: number } {
  const h = n(ctx, 'slotMm', 5, 3.5, 14), inset = n(ctx, 'slotInset', 16, 8, 60);
  const y = eyeHeight(bar);
  return { x0: TRIM.x0 + inset, x1: TRIM.x1 - inset, y0: y - h / 2, y1: y + h / 2 };
}

export const ringOf = (r: { x0: number; x1: number; y0: number; y1: number }): Point[] =>
  [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];

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
    out.push({ slab: sl, strokes: facetStrokes(sl, o.light, o.eye, fade > 0 || deep < outlineMm, o.pitchMm / unit) });
  }
  return out;
}

/**
 * The joints of the paving beyond its last slab, as lines on the ground converging on the vanishing point, thinning
 * out with distance; none runs on where its neighbour would be closer than `minMm` on the sheet.
 */
export function farJoints(o: { pitch: number; from: number; f: number; halfWidth: number; minMm: number }): THREE.Vector3[][] {
  const lines: THREE.Vector3[][] = [];
  const ground = 0.01;
  const deep = o.pitch * o.f / o.minMm;
  const reach = Math.ceil(deep * Math.tan(o.halfWidth) / o.pitch) + 1;
  for (let col = -reach; col <= reach; col++) {
    const x = col * o.pitch;
    // Every joint runs a little way past the pavers; every second one twice as far, every fourth four times, and so on,
    // so the joints thin out toward the horizon without crowding.
    if (col % 2 !== 0) continue;
    let k = 1;
    while (k < 64 && col % (4 * k) === 0) k *= 2;
    const end = Math.min(deep, o.from * (1 + 0.6 * k));
    const start = Math.max(o.from, Math.abs(x) / Math.tan(o.halfWidth) - o.pitch);
    if (start < end) lines.push([new THREE.Vector3(x, ground, -start), new THREE.Vector3(x, ground, -end)]);
  }
  return lines;
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
