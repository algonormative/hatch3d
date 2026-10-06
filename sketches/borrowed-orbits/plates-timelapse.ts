/**
 * Timelapse of the Orbit Plates: one segment per plate, concatenated into one timelapse.mp4.
 *
 *   npx tsx sketches/borrowed-orbits/plates-timelapse.ts <outDir> [--configs a.json,b.json,...] [--seconds 9] [--fps 24] [--jobs N]
 *
 * Defaults: plate-hohmann, plate-lagrange, plate-threebody-figure8, plate-threebody-butterfly (names or paths; a bare name is
 * looked up in sketches/borrowed-orbits/configs). Each segment lasts `--seconds` and then holds 1.5 s on the finished plate.
 *
 * Two panels at matched scale and position (the same poster page, the same mapping to it):
 * - LEFT "SYSTEM": the same integrated run in the INERTIAL frame. Bodies are filled dots at their current positions (attractors
 *   labelled by mass in kg), every moving body leaves a fading trail, a ring marks each Hohmann impulse when it fires, and the
 *   readouts give the step, the time and, for the Lagrange plate, the binary angle.
 * - RIGHT "PLOT": the pen drawing growing. Every integrated line is revealed up to the current time from the same traces the
 *   plate draws (the rotating-frame curves for Lagrange, the transfer arcs between their burns for Hohmann), simplified with the
 *   same RDP and clipped to the same plate box; the last frame is the plate (checked against extractPlate when it is rendered).
 *   Reference geometry (zero-velocity curves, L points, guide orbits) is faint from the start and reaches full weight at the end.
 * - LAGRANGE TIME: real time, not normalized. Every libration orbit starts at t = 0 and is drawn for its own period; it stops
 *   when it closes (491 to 560 s for the tadpoles, 1092 s for the horseshoe at the defaults). That keeps one physical clock for
 *   both panels, so the inertial binary on the left turns the same angle that the rotating frame on the right removes.
 *
 * Ledger against timelapse.ts (it runs main() on import and exports nothing; nothing could be imported):
 * - COPIED VERBATIM: `findFfmpeg`, the concat-list ffmpeg encode with a crf search under 14.5 MB, `parseArgs`' flag style.
 * - COPIED AND ADAPTED: the SVG-to-PNG rasterization with @resvg/resvg-js, and the worker pool (here separate processes, because
 *   resvg rasterizes synchronously; the cloud/orbits timelapse parallelizes the child renders instead).
 * - NEW: everything that draws the two panels. Frames are pure vector SVG (no pngjs canvas).
 */
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Resvg } from '@resvg/resvg-js';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { clipPolylineToRect } from '../../packages/plot-core/src/clip.ts';
import { mapFinishingPoint, resolveFinishing, resolveParams } from '../../packages/plot-core/src/index.ts';
import type { FinishingOptions, Params, Point } from '../../src/sketch/types.ts';
import type { Trace } from './libration.ts';
import type { Vec2 } from './model.ts';
import { extractPlate, glyphToArt, makeMapper, plateBox, plateScene, simplifyKeep, PLATE_SIMPLIFY_MM } from './plates-extract.ts';
import type { Glyph, Mapper, Scene, SceneLine } from './plates-extract.ts';
import { buildPlate, runPlate, CENTRE } from './plates-study.ts';
import type { PlateRun, PlateStudy } from './plates-study.ts';
import sketch from './plates.ts';
import { history } from './sim.ts';

const here = resolve('sketches/borrowed-orbits');
const entry = join(here, 'plates.ts');
const DEFAULT_CONFIGS = ['plate-hohmann', 'plate-lagrange', 'plate-threebody-figure8', 'plate-threebody-butterfly'];
const HOLD_SECONDS = 1.5;

interface Options { outDir: string; configs: string[]; seconds: number; fps: number; jobs: number; worker: number | null; workers: number }

function parseArgs(argv: string[]): Options {
  const options: Options = { outDir: '', configs: DEFAULT_CONFIGS, seconds: 9, fps: 24, jobs: Math.max(1, Math.min(4, cpus().length - 1)), worker: null, workers: 1 };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--configs') options.configs = argv[++i].split(',').filter(Boolean);
    else if (a === '--seconds') options.seconds = Number(argv[++i]);
    else if (a === '--fps') options.fps = Number(argv[++i]);
    else if (a === '--jobs') options.jobs = Number(argv[++i]);
    else if (a === '--worker') options.worker = Number(argv[++i]);
    else if (a === '--workers') options.workers = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) throw new Error('Usage: plates-timelapse.ts <outDir> [--configs a.json,b.json] [--seconds 9] [--fps 24] [--jobs N]');
  if (!(options.seconds > 0 && options.seconds <= 120)) throw new Error('--seconds must be between 0 and 120');
  if (!Number.isFinite(options.fps) || options.fps < 1 || options.fps > 60) throw new Error('--fps must be a number from 1 to 60');
  if (!Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > 16) throw new Error('--jobs must be an integer from 1 to 16');
  options.outDir = resolve(positional[0]);
  return options;
}

/** ffmpeg from the FFMPEG env var, else the first executable named ffmpeg on PATH. */
function findFfmpeg(): string {
  const fromEnv = process.env.FFMPEG?.trim();
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`FFMPEG is set to ${fromEnv}, which does not exist`);
    return fromEnv;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  throw new Error('ffmpeg not found: install it or set the FFMPEG environment variable to its path');
}

const configPath = (name: string): string => (existsSync(resolve(name)) ? resolve(name) : join(here, 'configs', name.endsWith('.json') ? name : `${name}.json`));
const plateId = (name: string): string => basename(name).replace(/\.json$/, '').replace(/^plate-/, '');

// ------------------------------------------------------------------ layout
const PANEL_W = 720;
const GUTTER = 16;
const HEADER_H = 98;
const FOOTER_H = 40;
const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const INK = '#243044';
const BG = '#ece9e2';
const f1 = (n: number): string => n.toFixed(1);
const sci = (n: number): string => n.toExponential(1).replace('e+', 'e');

interface Body {
  fill: string;
  /** Dot radius, px. */
  r: number;
  label?: string;
  /** Trail length in simulation seconds. */
  trailS: number;
  pos(t: number): Vec2;
  /** Trail samples (default 48). */
  samples?: number;
  /** The body stops here (its orbit closed). */
  stopAt?: number;
  hollow?: boolean;
}
interface Timed { line: SceneLine; art: Point[]; keep: number[]; guide: boolean }
interface Prepared {
  id: string;
  title: string;
  caption: string;
  note: string;
  study: PlateStudy;
  run: PlateRun;
  scene: Scene;
  map: Mapper;
  duration: number;
  /** Seconds of simulation per recorded step of the main run. */
  dt: number;
  timed: Timed[];
  staticLines: { line: SceneLine; art: Point[]; reference: boolean }[];
  glyphs: { glyph: Glyph; art: Point[][] }[];
  bodies: Body[];
  /** Left-panel decorations: burn markers and faint guide circles, in scene coordinates. */
  burns: { at: Vec2; time: number }[];
  guides: { centre: Vec2; radius: number }[];
  /** Right-panel body circles that move with the system (the three-body plate): scene positions at a time. */
  moving: ((t: number) => Vec2[]) | null;
  movingMm: number;
  readout(t: number): string[];
  pxPerMm: number;
  finishing: ReturnType<typeof resolveFinishing>;
  border: Point[][];
}

function sampleTrace(tr: Trace, kind: 'p' | 'a', index: number, t: number, dt: number): Vec2 {
  const last = tr.xs.length - 1;
  const k = Math.min(last, Math.max(0, t / dt));
  const k0 = Math.floor(k), k1 = Math.min(last, k0 + 1), f = k - k0;
  const X = kind === 'p' ? tr.xs : tr.ax, Y = kind === 'p' ? tr.ys : tr.ay;
  return { x: X[k0][index] * (1 - f) + X[k1][index] * f, y: Y[k0][index] * (1 - f) + Y[k1][index] * f };
}

async function prepare(name: string): Promise<Prepared> {
  const path = configPath(name);
  const request = JSON.parse(readFileSync(path, 'utf8')) as { seed: number; params: Params; finishing?: FinishingOptions };
  const params = resolveParams(sketch.controls, request.params);
  const study = buildPlate({ params: params as Params, seed: request.seed, assets: {}, random: () => () => 0.5 });
  const run = runPlate(study, history);
  const scene = plateScene(study, run);
  const map = makeMapper(study, scene);
  const finishing = resolveFinishing(sketch.page, sketch.pens, request.finishing ?? {});
  const pxPerMm = PANEL_W / finishing.page.width;
  const { fit } = study;
  const tolerance = PLATE_SIMPLIFY_MM / fit.scale;
  const timed: Timed[] = [];
  const staticLines: Prepared['staticLines'] = [];
  for (const line of scene.lines) {
    const art = line.points.map(map.toArt);
    if (line.timing) timed.push({ line, art, keep: simplifyKeep(art, tolerance), guide: study.plate === 'hohmann' && line.part === 'orbits' });
    else staticLines.push({ line, art: simplifyKeep(art, tolerance).map(i => art[i]), reference: true });
  }
  const glyphs = scene.glyphs.map(glyph => ({ glyph, art: glyphToArt(study, map, glyph) }));
  const rendered = await renderSketch({ entry, seed: request.seed, params: request.params, finishing: request.finishing, timeoutMs: 240_000 });
  const border = rendered.parts.filter(p => p.id === 'finishing-border').flatMap(p => p.paths);

  const base = { id: plateId(name), study, run, scene, map, timed, staticLines, glyphs, burns: [] as Prepared['burns'], guides: [] as Prepared['guides'], moving: null as Prepared['moving'], movingMm: 0, pxPerMm, finishing, border };
  const bodies: Body[] = [];

  if (study.plate === 'hohmann') {
    const plan = study.hohmann!;
    const h = run.histories[0];
    const dt = study.config.settings.dt;
    bodies.push({ fill: INK, r: 7, label: `${sci(study.config.attractors[0].mass)} kg`, trailS: 0, pos: () => ({ x: h.ax[0][0], y: h.ay[0][0] }) });
    plan.orbitParticles.forEach((p, k) => bodies.push({ fill: '#7b8696', r: 3, trailS: 0.14 * plan.periodSteps[k] * dt, pos: t => sampleTrace(h, 'p', p, t, dt) }));
    for (const hop of plan.hops) {
      bodies.push({ fill: '#d04b3c', r: 4.5, trailS: 0.35 * (hop.arriveStep - hop.departStep) * dt, pos: t => sampleTrace(h, 'p', hop.transfer, t, dt), stopAt: undefined });
      bodies.push({ fill: '#ffffff', hollow: true, r: 4, trailS: 0, pos: t => sampleTrace(h, 'p', hop.sourcePlanet, t, dt) });
      bodies.push({ fill: '#ffffff', hollow: true, r: 4, trailS: 0, pos: t => sampleTrace(h, 'p', hop.targetPlanet, t, dt) });
      for (const [step] of [[hop.departStep], [hop.arriveStep]]) base.burns.push({ at: sampleTrace(h, 'p', hop.transfer, step * dt, dt), time: step * dt });
    }
    plan.radii.forEach(r => base.guides.push({ centre: plan.centre, radius: r }));
    const duration = Math.max(...timed.map(t => t.line.timing!.t0 + (t.art.length - 1) * t.line.timing!.dt));
    return { ...base, title: 'HOHMANN TRANSFER', caption: 'two burns, half an ellipse', note: `${plan.radii.length} circular orbits and ${plan.hops.length} chained transfers, each burn an integrated impulse`, duration, dt, bodies,
      readout: t => [`t ${t.toFixed(0)} s   step ${Math.round(t / dt)}`, `burns fired ${base.burns.filter(b => b.time <= t).length} of ${base.burns.length}`] };
  }

  if (study.plate === 'lagrange') {
    const plan = study.lagrange!;
    const orbits = plan.orbits;
    const periods = run.solved.map(s => s.periodS);
    const lead = periods.indexOf(Math.max(...periods));
    const dtOf = (i: number): number => run.solved[i].periodS / run.solved[i].steps;
    const bin = run.histories[lead];
    const masses = study.config.attractors.map(m => m.mass);
    const binaryAt = (t: number): [Vec2, Vec2] => [sampleTrace(bin, 'a', 0, t, dtOf(lead)), sampleTrace(bin, 'a', 1, t, dtOf(lead))];
    const rel = (p: Vec2): Vec2 => ({ x: p.x - CENTRE.x, y: p.y - CENTRE.y });
    bodies.push({ fill: INK, r: 8, label: `${sci(masses[0])} kg`, trailS: 0, pos: t => rel(binaryAt(t)[0]) });
    bodies.push({ fill: INK, r: 4.5, label: `${sci(masses[1])} kg`, trailS: 0.3 * (2 * Math.PI) / plan.omega, pos: t => rel(binaryAt(t)[1]) });
    orbits.forEach((o, i) => {
      if (!run.solved[i].converged) return;
      const T = run.solved[i].periodS;
      bodies.push({ fill: o.kind === 'horseshoe' ? '#776090' : '#3c49aa', r: 3.4, trailS: 0.3 * (2 * Math.PI) / plan.omega, pos: t => rel(sampleTrace(run.histories[i], 'p', 0, Math.min(t, T), dtOf(i))), stopAt: T });
    });
    base.guides.push({ centre: { x: 0, y: 0 }, radius: (1 - plan.mu) * plan.a });
    const duration = Math.max(...periods);
    const closed = (t: number): number => periods.filter(T => T <= t + 1e-9).length;
    return { ...base, title: 'LAGRANGE SYSTEM', caption: 'restricted three-body, tadpoles and a horseshoe in the rotating frame', note: `real time: every orbit starts at t = 0 and stops when it closes (${[...new Set(periods.map(T => Math.round(T)))].join(' / ')} s)`, duration, dt: dtOf(lead), bodies,
      readout: t => [`t ${t.toFixed(0)} s   binary angle ${(((plan.omega * t * 180) / Math.PI) % 360).toFixed(0)}°  (turn ${Math.floor((plan.omega * t) / (2 * Math.PI))})`, `orbits closed ${closed(t)} of ${periods.length}`] };
  }

  const plan = study.threebody!;
  const h = run.histories[0];
  const dt = study.config.settings.dt;
  const duration = plan.steps * dt;
  study.config.attractors.forEach((m, i) => bodies.push({ fill: INK, r: 6, label: `${sci(m.mass)} kg`, trailS: 0.22 * duration, samples: 200, pos: t => sampleTrace(h, 'a', i, t, dt) }));
  const label = plan.entry.id === 'figure-eight' ? 'three equal masses chase one curve' : 'free-fall start, three bodies, one period';
  return { ...base, glyphs: glyphs.filter(g => g.glyph.part !== 'bodies'), moving: t => [0, 1, 2].map(i => sampleTrace(h, 'a', i, t, dt)), movingMm: study.marks.bodyRadius,
    title: `THREE-BODY ${plan.entry.label.toUpperCase()}`, caption: label, note: `G = m = 1 units, 1 period = ${duration.toFixed(1)} s, ${plan.segments} chained run${plan.segments > 1 ? 's' : ''} of 2400 steps`, duration, dt, bodies,
    readout: t => [`t ${t.toFixed(1)} s of ${duration.toFixed(1)} s   step ${Math.round(t / dt)}`, `${(100 * t / duration).toFixed(0)}% of the period`] };
}

// ------------------------------------------------------------------ frame drawing
const pathD = (pts: { x: number; y: number }[]): string => `M${pts.map(p => `${f1(p.x)} ${f1(p.y)}`).join('L')}`;

function renderFrame(prep: Prepared, t: number, index: number, total: number, plateIndex: number, plates: number, finalFrame: boolean): string {
  const { study, map, finishing, pxPerMm } = prep;
  const { fit } = study;
  const box = plateBox(study);
  const panelH = 2 * Math.ceil(finishing.page.height * pxPerMm / 2);
  const frameW = 2 * PANEL_W + 3 * GUTTER, frameH = HEADER_H + panelH + FOOTER_H;
  const leftX = GUTTER, rightX = 2 * GUTTER + PANEL_W, panelY = HEADER_H;
  const sceneToPx = (p: Vec2): { x: number; y: number } => {
    const page = map.toPage(p);
    const f = mapFinishingPoint(page, finishing);
    return { x: f.x * pxPerMm, y: f.y * pxPerMm };
  };
  const artToPx = (a: Point): { x: number; y: number } => {
    const f = mapFinishingPoint({ x: a.x * fit.scale + fit.dx, y: a.y * fit.scale + fit.dy }, finishing);
    return { x: f.x * pxPerMm, y: f.y * pxPerMm };
  };
  const pen = (id: string): string => sketch.pens.find(p => p.id === id)?.color ?? '#22282c';
  const roles = { orbit: pen(study.marks.orbitPen), highlight: pen(study.marks.highlightPen), reference: pen(study.marks.referencePen) };
  const progress = Math.min(1, t / prep.duration);
  const ramp = Math.max(0, Math.min(1, (progress - 0.8) / 0.2));
  const refOpacity = 0.2 + 0.8 * ramp * ramp * (3 - 2 * ramp);
  const border = prep.border.map(p => `<path d="${pathD(p.map(q => ({ x: q.x * pxPerMm, y: q.y * pxPerMm })))}" fill="none" stroke="${INK}" stroke-width="1"/>`).join('');

  // ---- right panel: the pen drawing
  let right = '';
  const stroke = (paths: Point[][], color: string, width: number, opacity = 1): string =>
    paths.map(p => `<path d="${pathD(p.map(artToPx))}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  const clip = (pts: Point[]): Point[][] => clipPolylineToRect(pts, box);
  for (const s of prep.staticLines) right += stroke(clip(s.art), roles[s.line.pen], 1, refOpacity);
  for (const { glyph, art } of prep.glyphs) {
    if (glyph.kind === 'cross') right += stroke(art.flatMap(clip), roles[glyph.pen], 1.1, refOpacity);
  }
  for (const tl of prep.timed) {
    const { t0, dt } = tl.line.timing!;
    if (tl.guide) right += stroke(clip(tl.keep.map(i => tl.art[i])), roles.orbit, 1, 0.16 + 0.5 * ramp);
    const n = tl.art.length;
    const f = (t - t0) / dt;
    if (f < 0) continue;
    const j = Math.min(n - 1, Math.floor(f));
    const frac = j >= n - 1 ? 0 : f - j;
    const pts: Point[] = [];
    for (const i of tl.keep) { if (i <= j) pts.push(tl.art[i]); else break; }
    if (frac > 0) pts.push({ x: tl.art[j].x + (tl.art[j + 1].x - tl.art[j].x) * frac, y: tl.art[j].y + (tl.art[j + 1].y - tl.art[j].y) * frac });
    if (pts.length >= 2) right += stroke(clip(pts), roles[tl.line.pen], 1.15);
  }
  for (const { glyph, art } of prep.glyphs) {
    if (glyph.kind === 'cross') continue;
    if (glyph.time !== undefined && glyph.time > t + 1e-9) continue;
    right += stroke(art.flatMap(clip), roles[glyph.pen], 1.15);
  }
  if (prep.moving) {
    // Bodies of a choreography ride the curve: small exact circles at their current positions.
    for (const p of prep.moving(t)) {
      const centre = map.toArt(p);
      const r = prep.movingMm / fit.scale;
      const ring = Array.from({ length: 49 }, (_v, i) => ({ x: centre.x + r * Math.cos((i * Math.PI) / 24), y: centre.y + r * Math.sin((i * Math.PI) / 24) }));
      right += stroke([ring], roles.orbit, 1.15);
    }
  }

  // ---- left panel: the inertial system
  let left = '';
  for (const g of prep.guides) {
    const c = sceneToPx(g.centre);
    // Radius on the page: the scene scale (mm per unit) through the finishing scale.
    left += `<circle cx="${f1(c.x)}" cy="${f1(c.y)}" r="${f1(g.radius * map.mmPerM * finishing.scale * pxPerMm)}" fill="none" stroke="#9aa0a8" stroke-width="1" stroke-opacity="0.45" stroke-dasharray="2 5"/>`;
  }
  for (const tl of prep.timed.filter(x => x.guide)) left += `<path d="${pathD(tl.keep.map(i => artToPx(tl.art[i])))}" fill="none" stroke="#9aa0a8" stroke-width="1" stroke-opacity="0.3"/>`;
  for (const burn of prep.burns) {
    if (burn.time > t + 1e-9) continue;
    const c = sceneToPx(burn.at);
    // A flash ring grows and fades over 4% of the run; a small ring stays where the burn happened.
    const age = (t - burn.time) / (0.04 * prep.duration);
    if (age < 1) left += `<circle cx="${f1(c.x)}" cy="${f1(c.y)}" r="${f1(6 + 16 * age)}" fill="none" stroke="#d04b3c" stroke-width="${f1(2.4 * (1 - age) + 0.6)}" stroke-opacity="${f1(1 - age)}"/>`;
    left += `<circle cx="${f1(c.x)}" cy="${f1(c.y)}" r="5" fill="none" stroke="#d04b3c" stroke-width="1.2" stroke-opacity="0.8"/>`;
  }
  for (const body of prep.bodies) {
    const tt = body.stopAt !== undefined ? Math.min(t, body.stopAt) : t;
    if (body.trailS > 0) {
      const N = body.samples ?? 48;
      const pts = Array.from({ length: N + 1 }, (_v, j) => sceneToPx(body.pos(Math.max(0, tt - body.trailS * (1 - j / N)))));
      for (let j = 0; j < N; j++) {
        left += `<path d="M${f1(pts[j].x)} ${f1(pts[j].y)}L${f1(pts[j + 1].x)} ${f1(pts[j + 1].y)}" stroke="${body.fill === '#ffffff' ? '#7b8696' : body.fill}" stroke-width="${f1(1.2 + 2 * (j / N))}" stroke-opacity="${f1(0.85 * ((j + 1) / N) ** 1.3)}" stroke-linecap="round"/>`;
      }
    }
    const c = sceneToPx(body.pos(tt));
    left += body.hollow
      ? `<circle cx="${f1(c.x)}" cy="${f1(c.y)}" r="${body.r}" fill="#fbf9f3" stroke="${INK}" stroke-width="1.3"/>`
      : `<circle cx="${f1(c.x)}" cy="${f1(c.y)}" r="${body.r}" fill="${body.fill}"/>`;
    if (body.label) left += `<text x="${f1(c.x + body.r + 5)}" y="${f1(c.y - body.r - 3)}" font-size="13" font-weight="600" fill="${INK}" stroke="#fbf9f3" stroke-width="3" paint-order="stroke" font-family="${FONT}">${body.label}</text>`;
  }
  const readout = prep.readout(t);
  const bar = (frameW - 2 * GUTTER);
  const segW = bar / plates;
  const overall = plateIndex * segW + segW * Math.min(1, index / Math.max(1, total - 1));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frameW}" height="${frameH}" viewBox="0 0 ${frameW} ${frameH}">
<rect width="${frameW}" height="${frameH}" fill="${BG}"/>
<text x="${leftX}" y="34" font-size="24" font-weight="700" fill="${INK}" font-family="${FONT}">${prep.title}</text>
<text x="${leftX}" y="62" font-size="18" fill="#3a4658" font-family="${FONT}">${prep.caption}</text>
<text x="${leftX}" y="86" font-size="14" fill="#6b7280" font-family="${FONT}">${prep.note}</text>
<text x="${leftX + PANEL_W - 4}" y="${HEADER_H - 8}" font-size="14" font-weight="700" fill="#555d6b" text-anchor="end" font-family="${FONT}">SYSTEM  inertial frame</text>
<text x="${rightX + PANEL_W - 4}" y="${HEADER_H - 8}" font-size="14" font-weight="700" fill="#555d6b" text-anchor="end" font-family="${FONT}">PLOT  ${prep.study.plate === 'lagrange' ? 'rotating frame, what the pen draws' : 'what the pen draws'}</text>
<defs><clipPath id="pc"><rect width="${PANEL_W}" height="${panelH}"/></clipPath></defs>
<g transform="translate(${leftX} ${panelY})"><rect width="${PANEL_W}" height="${panelH}" fill="#fbf9f3"/><g clip-path="url(#pc)" opacity="1">${left}</g><g opacity="0.35">${border}</g>
<rect x="12" y="12" width="${readout.some(s => s.length > 40) ? 400 : 300}" height="50" rx="6" fill="rgba(251,249,243,0.92)"/>
<text x="22" y="32" font-size="15" font-weight="600" fill="${INK}" font-family="${FONT}">${readout[0]}</text><text x="22" y="52" font-size="14" fill="#555d6b" font-family="${FONT}">${readout[1]}</text></g>
<g transform="translate(${rightX} ${panelY})"><rect width="${PANEL_W}" height="${panelH}" fill="#f4f0e6"/><g clip-path="url(#pc)">${right}</g>${border}</g>
<rect x="${GUTTER}" y="${frameH - 20}" width="${bar}" height="4" fill="#c7c4bc"/>
<rect x="${GUTTER}" y="${frameH - 20}" width="${f1(overall)}" height="4" fill="${INK}"/>
${Array.from({ length: plates + 1 }, (_v, i) => `<rect x="${f1(GUTTER + i * segW - 1)}" y="${frameH - 24}" width="2" height="12" fill="#8a8f99"/>`).join('')}
${finalFrame ? `<text x="${frameW - GUTTER}" y="${frameH - 26}" font-size="12" fill="#6b7280" text-anchor="end" font-family="${FONT}">finished plate</text>` : ''}
</svg>`;
  return svg;
}

/** The last frame's drawing against extractPlate: the same polylines, to rounding. */
function checkFinal(prep: Prepared): { parts: number; maxDiff: number } {
  const real = extractPlate(prep.study, prep.run);
  const { fit } = prep.study;
  const box = plateBox(prep.study);
  const mine = new Map<string, Point[][]>();
  const add = (id: string, paths: Point[][]): void => { mine.set(id, [...(mine.get(id) ?? []), ...paths]); };
  for (const s of prep.staticLines) add(s.line.part, clipPolylineToRect(s.art, box));
  for (const tl of prep.timed) add(tl.line.part, clipPolylineToRect(tl.keep.map(i => tl.art[i]), box));
  for (const { glyph, art } of prep.glyphs) add(glyph.part, art.flatMap(p => clipPolylineToRect(p, box)));
  if (prep.moving) {
    const r = prep.movingMm / fit.scale;
    for (const p of prep.moving(prep.duration)) {
      const centre = prep.map.toArt(p);
      add('bodies', clipPolylineToRect(Array.from({ length: 49 }, (_v, i) => ({ x: centre.x + r * Math.cos((i * Math.PI) / 24), y: centre.y + r * Math.sin((i * Math.PI) / 24) })), box));
    }
  }
  let maxDiff = 0, parts = 0;
  for (const part of real.filter(p => !p.diagnostic)) {
    const got = mine.get(part.id) ?? [];
    parts++;
    if (got.length !== part.paths.length) { maxDiff = Infinity; continue; }
    part.paths.forEach((path, i) => {
      if (got[i].length !== path.length && part.id !== 'bodies') { maxDiff = Infinity; return; }
      if (got[i].length === path.length) path.forEach((p, k) => { maxDiff = Math.max(maxDiff, Math.hypot(p.x - got[i][k].x, p.y - got[i][k].y) * fit.scale); });
    });
  }
  return { parts, maxDiff };
}

// ------------------------------------------------------------------ main
interface Job { plate: number; frame: number }

async function runWorker(options: Options): Promise<void> {
  const framesDir = join(options.outDir, 'frames');
  const plates: Prepared[] = [];
  for (const name of options.configs) plates.push(await prepare(name));
  const perPlate = Math.round(options.seconds * options.fps);
  const jobs: Job[] = plates.flatMap((_p, plate) => Array.from({ length: perPlate }, (_v, frame) => ({ plate, frame })));
  const mine = jobs.filter((_j, i) => i % options.workers === options.worker);
  for (const job of mine) {
    const prep = plates[job.plate];
    const final = job.frame === perPlate - 1;
    const t = (job.frame / (perPlate - 1)) * prep.duration;
    const svg = renderFrame(prep, t, job.frame, perPlate, job.plate, plates.length, final);
    const png = new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' } }).render().asPng();
    writeFileSync(join(framesDir, `${prep.id}-${String(job.frame).padStart(4, '0')}.png`), png);
    if (final) console.log(JSON.stringify({ plate: prep.id, finalFrameMatchesPlate: checkFinal(prep) }));
  }
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const options = parseArgs(process.argv.slice(2));
  if (options.worker !== null) { await runWorker(options); return; }
  const ffmpeg = findFfmpeg();
  const framesDir = join(options.outDir, 'frames');
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  mkdirSync(join(options.outDir, 'posters'), { recursive: true });
  const ids = options.configs.map(plateId);
  const perPlate = Math.round(options.seconds * options.fps);
  // Frames are rendered by worker processes (resvg rasterizes synchronously): each prepares the plates, renders every k-th frame.
  const workers = Math.min(options.jobs, perPlate * ids.length);
  const started = performance.now();
  await Promise.all(Array.from({ length: workers }, (_v, k) => new Promise<void>((done, fail) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], options.outDir, '--configs', options.configs.join(','), '--seconds', String(options.seconds), '--fps', String(options.fps), '--worker', String(k), '--workers', String(workers)], { stdio: 'inherit' });
    child.on('exit', code => (code === 0 ? done() : fail(new Error(`worker ${k} exited with ${code}`))));
  })));
  const renderS = (performance.now() - started) / 1000;

  // One concat list: every frame for 1/fps, the finished plate held for HOLD_SECONDS.
  const lines: string[] = [];
  const file = (id: string, frame: number): string => `file '${join(framesDir, `${id}-${String(frame).padStart(4, '0')}.png`).replace(/'/g, "'\\''")}'`;
  ids.forEach(id => {
    for (let frame = 0; frame < perPlate; frame++) lines.push(file(id, frame), `duration ${(frame === perPlate - 1 ? HOLD_SECONDS + 1 / options.fps : 1 / options.fps).toFixed(6)}`);
  });
  lines.push(file(ids[ids.length - 1], perPlate - 1));
  const listPath = join(options.outDir, 'frames.txt');
  writeFileSync(listPath, `${lines.join('\n')}\n`);
  const mp4 = join(options.outDir, 'timelapse.mp4');
  let crf = 21;
  for (;;) {
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vf', `fps=${options.fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
    if (statSync(mp4).size < 14.5e6 || crf >= 36) break;
    crf += 3;
  }

  // Posters: each plate's finished frame, and a 2 x 2 sheet of them.
  const posters = ids.map(id => {
    const png = readFileSync(join(framesDir, `${id}-${String(perPlate - 1).padStart(4, '0')}.png`));
    writeFileSync(join(options.outDir, 'posters', `${id}.png`), png);
    return png;
  });
  const frameW = 2 * PANEL_W + 3 * GUTTER;
  const dims = readPngSize(posters[0]);
  const cols = 2, rows = Math.ceil(posters.length / cols);
  const cell = { w: Math.round(dims.width / 2), h: Math.round(dims.height / 2) };
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${cols * cell.w}" height="${rows * cell.h}">`
    + posters.map((png, i) => `<image x="${(i % cols) * cell.w}" y="${Math.floor(i / cols) * cell.h}" width="${cell.w}" height="${cell.h}" xlink:href="data:image/png;base64,${png.toString('base64')}"/>`).join('') + '</svg>';
  writeFileSync(join(options.outDir, 'poster.png'), new Resvg(sheet, { fitTo: { mode: 'original' } }).render().asPng());
  const duration = ids.length * (perPlate / options.fps + HOLD_SECONDS);
  const summary = {
    outDir: options.outDir, plates: ids, frames: ids.length * perPlate, frameSize: `${frameW}x${dims.height}`, durationS: Number(duration.toFixed(2)), crf,
    mp4Bytes: statSync(mp4).size, secondsTotal: Number(((performance.now() - t0) / 1000).toFixed(1)), renderFramesS: Number(renderS.toFixed(1)), workers,
  };
  writeFileSync(join(options.outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

/** Width and height of a PNG from its header. */
function readPngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
