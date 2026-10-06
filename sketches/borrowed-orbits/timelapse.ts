/**
 * Side-by-side timelapse of the Borrowed Orbits simulation.
 *
 *   npx tsx sketches/borrowed-orbits/timelapse.ts <request.json | inline-json> <outDir> [--every 10] [--fps 12] [--window 300,300] [--steps 2400] [--jobs 5]
 *
 * LEFT  "system" panel, the physics the plot never shows: the hidden masses as crosses labelled by mass in kg (with a
 *       dotted trail of their path, one dot per frame), every particle as a dot coloured by status (free, captured,
 *       escaped), the guides and forbidden solids (drawn polygon filled, simulation capture polygon dashed), a sparse
 *       arrow grid of the gravitational ACCELERATION in m/s² (arrow length is the square root of |a|, scale labelled),
 *       the apparent centre, step and time, status counts with capture causes, and energy readouts.
 * RIGHT "plot" panel: the real sketch render (renderSketch at that step), rasterized from its SVG.
 *
 * The simulation runs once, incrementally (advance between frame steps). The request is `{ seed, params, finishing }`
 * or a bare params object. With `--window start,delta` the frames at start, start+delta, start+2·delta get a coloured
 * border and a PRINT tag and are held for ~1 s in the video. Output: <outDir>/frames/*.png, timelapse.mp4, poster.png
 * (the frame at the window midpoint, or the last frame without a window), summary.json.
 *
 * Ledger against sketches/cloud-advection/timelapse.ts (that file runs main() on import and exports nothing, so
 * nothing in it can be imported; everything below is a copy):
 * - IMPORTED UNCHANGED from cloud-advection: nothing.
 * - COPIED VERBATIM (generic, would be shareable from a common module): `parseArgs` (flags, validation; the defaults
 *   and the limit differ), `loadRequest`, `findFfmpeg` (FFMPEG env var, else PATH), `pool`, `arrowSvg`, the frame list,
 *   the print-window logic and the progress bar, the concat-list ffmpeg encode with held print frames and a crf
 *   search under 14.5 MB, poster selection, summary.json. The `f1`/`signed` formatters.
 * - COPIED AND ADAPTED: the layout and the finishing-aware world-to-pixel mapping (`toPx`), and the static legend.
 *   The cloud study draws its left panel as a pngjs canvas (the concentration field) plus an SVG overlay; this study
 *   has no raster field, so the whole left panel is one SVG and the right panel is embedded in it as an image. That
 *   drops the `Canvas` class, the colormap and the per-pixel field lookup. The cloud's eddy layer, wind arrow and
 *   velocity grid are replaced by the attractor layer, the particle dots and the acceleration grid.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Resvg } from '@resvg/resvg-js';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { mapFinishingPoint, resolveFinishing } from '../../packages/plot-core/src/index.ts';
import type { FinishingOptions, Params } from '../../src/sketch/types.ts';
import { studyContext } from './evidence.ts';
import { LIMITS, REASON_CODE, STATUS_CODE } from './model.ts';
import type { OrbitSnapshot } from './model.ts';
import { accelerationAt, advance, initialSnapshot } from './sim.ts';
import sketch from './sketch.ts';
import { buildStudy } from './study.ts';

const entry = resolve('sketches/borrowed-orbits/sketch.ts');

interface Request { seed: number; params: Params; finishing?: FinishingOptions }
interface Options { every: number; fps: number; window: [number, number] | null; steps: number; jobs: number }

// ------------------------------------------------------------------ layout constants
const PANEL_W = 720;
const GUTTER = 16;
const HEADER_H = 56;
const FOOTER_H = 110;
const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const INK = '#243044';
const PRINT_COLOR = '#d6452b';
const BG = '#ece9e2';
const PAPER = '#fbf9f3';
const STATUS_FILL = { free: '#3c49aa', captured: '#d04b3c', escaped: '#8a8f99' } as const;
const MASS_COLOR = '#a02a6b';
/** Acceleration arrows: a fixed mapping, never normalized per frame. Length in metres of page = LEN_PER_ROOT · sqrt(|a| / A_REF), capped. */
const A_REF = 0.05;
const LEN_PER_ROOT_M = 1.6;
const LEN_CAP_M = 4.2;
const ARROW_GRID = 5;
const TRAIL_STEPS = 600;

const f1 = (n: number): string => n.toFixed(1);
const signed = (n: number, d = 1): string => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(d)}`;
const sci = (n: number): string => n.toExponential(2).replace('e+', 'e');

function arrowSvg(x0: number, y0: number, x1: number, y1: number, head: number, stroke: string, width: number, opacity: number): string {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return '';
  const ux = dx / len, uy = dy / len;
  const h = Math.min(head, len * 0.6);
  const bx = x1 - ux * h, by = y1 - uy * h;
  const nx = -uy * h * 0.45, ny = ux * h * 0.45;
  return `<g opacity="${opacity}" stroke="${stroke}" fill="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">`
    + `<line x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(bx)}" y2="${f1(by)}"/>`
    + `<polygon stroke-width="0.5" points="${f1(x1)},${f1(y1)} ${f1(bx + nx)},${f1(by + ny)} ${f1(bx - nx)},${f1(by - ny)}"/></g>`;
}

function parseArgs(argv: string[]): { requestArg: string; outDir: string; options: Options } {
  const positional: string[] = [];
  const options: Options = { every: 10, fps: 12, window: null, steps: LIMITS.maxSteps, jobs: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--every') options.every = Number(argv[++i]);
    else if (a === '--fps') options.fps = Number(argv[++i]);
    else if (a === '--steps') options.steps = Number(argv[++i]);
    else if (a === '--jobs') options.jobs = Number(argv[++i]);
    else if (a === '--window') {
      const [s, d] = argv[++i].split(',').map(Number);
      if (!Number.isInteger(s) || !Number.isInteger(d) || s < 0 || d < 1) throw new Error('--window needs integer start,delta');
      options.window = [s, d];
    } else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 2) throw new Error('Usage: timelapse.ts <request.json | inline-json> <outDir> [--every N] [--fps F] [--window start,delta] [--steps 2400] [--jobs 5]');
  const integerIn = (name: string, value: number, min: number, max: number): void => {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  };
  integerIn('--steps', options.steps, 1, LIMITS.maxSteps);
  integerIn('--every', options.every, 1, options.steps);
  if (!Number.isFinite(options.fps) || options.fps < 1 || options.fps > 60) throw new Error('--fps must be a number from 1 to 60');
  integerIn('--jobs', options.jobs, 1, 16);
  if (options.window && options.window[0] + 2 * options.window[1] > options.steps) throw new Error('--window start+2·delta exceeds --steps');
  return { requestArg: positional[0], outDir: resolve(positional[1]), options };
}

function loadRequest(arg: string): Request {
  const text = arg.trim().startsWith('{') ? arg : readFileSync(resolve(arg), 'utf8');
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (parsed.params && typeof parsed.params === 'object') {
    return { seed: typeof parsed.seed === 'number' ? parsed.seed : 0, params: parsed.params as Params, finishing: parsed.finishing as FinishingOptions | undefined };
  }
  return { seed: typeof parsed.seed === 'number' ? parsed.seed : 0, params: Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'seed')) as Params };
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

async function pool<T>(items: T[], jobs: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

interface Frame { step: number; snapshot: OrbitSnapshot; printIndex: number | null }

// ------------------------------------------------------------------ main
async function main(): Promise<void> {
  const t0 = performance.now();
  const { requestArg, outDir, options } = parseArgs(process.argv.slice(2));
  const request = loadRequest(requestArg);
  const ffmpeg = findFfmpeg(); // fail before the long render, not after
  const framesDir = join(outDir, 'frames');
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  // Same context the runner builds, so the left panel integrates exactly the config the sketch draws.
  const study = buildStudy(studyContext(request));
  const config = study.config;
  const finishing = resolveFinishing(sketch.page, sketch.pens, request.finishing ?? {});
  const page = finishing.page;
  const pxPerMm = PANEL_W / page.width;
  const panelH = 2 * Math.ceil(page.height * pxPerMm / 2);
  const wtp = config.transforms.worldToPage;
  /** World metres → pixel inside a panel (through the poster mapping and the finishing pass). */
  const toPx = (x: number, y: number): [number, number] => {
    const p = mapFinishingPoint({ x: wtp.offset.x + wtp.scale * x, y: wtp.offset.y + wtp.scale * y }, finishing);
    return [p.x * pxPerMm, p.y * pxPerMm];
  };
  const pxPerM = wtp.scale * finishing.scale * pxPerMm;
  const frameW = 2 * PANEL_W + 3 * GUTTER;
  const frameH = HEADER_H + panelH + FOOTER_H;
  const leftX = GUTTER, rightX = 2 * GUTTER + PANEL_W, panelY = HEADER_H;
  const content = finishing.contentRect;
  const contentPx = { x0: content.xMin * pxPerMm, y0: content.yMin * pxPerMm, x1: content.xMax * pxPerMm, y1: content.yMax * pxPerMm };
  const offContent = (px: number, py: number): boolean => px < contentPx.x0 || px > contentPx.x1 || py < contentPx.y0 || py > contentPx.y1;

  // Frame list: multiples of --every plus the window steps, ascending.
  const stepSet = new Set<number>();
  for (let s = 0; s <= options.steps; s += options.every) stepSet.add(s);
  const printSteps = options.window ? [0, 1, 2].map(k => options.window![0] + k * options.window![1]) : [];
  for (const s of printSteps) stepSet.add(s);
  const stepList = [...stepSet].sort((a, b) => a - b);

  // Simulate once, incrementally; snapshots are small (struct-of-arrays of the particles).
  const tSim = performance.now();
  const frames: Frame[] = [];
  let snap = initialSnapshot(config);
  for (const step of stepList) {
    if (step > snap.step) snap = advance(config, snap, step - snap.step);
    const pi = printSteps.indexOf(step);
    frames.push({ step, snapshot: snap, printIndex: pi >= 0 ? pi : null });
  }
  const simMs = performance.now() - tSim;
  const first = frames[0].snapshot;
  const massOf = config.attractors.map(a => a.mass);
  const names = config.attractors.map(a => (a.id === 'mass-primary' ? 'hidden mass' : a.id === 'mass-perturber' ? 'perturber' : a.id));

  // ---- static overlay pieces (identical every frame)
  const polygonPx = (ring: { x: number; y: number }[]): string => ring.map(p => toPx(p.x, p.y).map(f1).join(',')).join(' ');
  const forbiddenSvg = study.forbidden.map(m =>
    `<polygon points="${polygonPx(m.capture)}" fill="none" stroke="#4d5159" stroke-width="1" stroke-dasharray="3 3" stroke-linejoin="round"/>`
    + `<polygon points="${polygonPx(m.polygon)}" fill="#4d5159" stroke="#4d5159" stroke-width="1" stroke-linejoin="round"/>`).join('');
  const [ccx, ccy] = toPx(study.guides.centre.x, study.guides.centre.y);
  const guidesSvg = study.guides.radii.map(r => `<circle cx="${f1(ccx)}" cy="${f1(ccy)}" r="${f1(r * pxPerM)}" fill="none" stroke="#d04b3c" stroke-width="1.3" opacity="0.85"/>`).join('')
    + `<circle cx="${f1(ccx)}" cy="${f1(ccy)}" r="4" fill="none" stroke="#d04b3c" stroke-width="1.5"/>`
    + `<text x="${f1(ccx + 8)}" y="${f1(ccy - 7)}" font-size="12" fill="#a8362a" stroke="${PAPER}" stroke-width="3" paint-order="stroke" font-family="${FONT}">apparent centre</text>`;
  const contentBox = `<rect x="${f1(contentPx.x0)}" y="${f1(contentPx.y0)}" width="${f1(contentPx.x1 - contentPx.x0)}" height="${f1(contentPx.y1 - contentPx.y0)}" fill="none" stroke="#8a8f99" stroke-width="1" stroke-dasharray="2 4"/>`;

  /** Acceleration grid at this frame's attractor positions: sqrt-compressed length, fixed mapping. */
  const accelerationLayer = (s: OrbitSnapshot): string => {
    const positions = s.attractors.map(a => a.position);
    let out = '';
    for (let y = ARROW_GRID / 2; y < config.domain.size.y; y += ARROW_GRID) {
      for (let x = ARROW_GRID / 2; x < config.domain.size.x; x += ARROW_GRID) {
        const [px, py] = toPx(x, y);
        if (offContent(px, py)) continue;
        const a = accelerationAt(config, positions, { x, y });
        const mag = Math.hypot(a.x, a.y);
        if (mag === 0) continue;
        const L = Math.min(LEN_CAP_M, LEN_PER_ROOT_M * Math.sqrt(mag / A_REF)) * pxPerM;
        const ux = a.x / mag, uy = a.y / mag;
        out += arrowSvg(px - ux * L / 2, py - uy * L / 2, px + ux * L / 2, py + uy * L / 2, 8, '#2d4a6b', 1.3, 0.4);
      }
    }
    return out;
  };

  const particleLayer = (s: OrbitSnapshot): string => {
    const groups: Record<string, string[]> = { free: [], captured: [], escaped: [] };
    for (let i = 0; i < s.px.length; i++) {
      const [px, py] = toPx(s.px[i], s.py[i]);
      if (px < -10 || px > PANEL_W + 10 || py < -10 || py > panelH + 10) continue;
      const key = s.status[i] === STATUS_CODE.free ? 'free' : s.status[i] === STATUS_CODE.captured ? 'captured' : 'escaped';
      groups[key].push(`<circle cx="${f1(px)}" cy="${f1(py)}" r="${key === 'free' ? 2.4 : 2}"/>`);
    }
    return (['escaped', 'captured', 'free'] as const).map(k => `<g fill="${STATUS_FILL[k]}" opacity="${k === 'free' ? 0.95 : 0.7}">${groups[k].join('')}</g>`).join('');
  };

  /** Crosses labelled by mass, a dotted trail (one dot per earlier frame, last TRAIL_STEPS steps), an edge chevron if off the drawn area. */
  const attractorLayer = (frame: Frame, index: number): string => {
    let out = '';
    frame.snapshot.attractors.forEach((a, j) => {
      const trail: Array<[number, number]> = [];
      for (let i = index; i >= 0 && frame.step - frames[i].step <= TRAIL_STEPS; i--) {
        const p = frames[i].snapshot.attractors[j].position;
        trail.unshift(toPx(p.x, p.y));
      }
      // Keep only what lands on the panel: resvg panics (an empty bounding box under a clip path) on shapes far outside it.
      const onPanel = (q: [number, number]): boolean => q[0] > -20 && q[0] < PANEL_W + 20 && q[1] > -20 && q[1] < panelH + 20;
      let run: Array<[number, number]> = [];
      const runs: Array<Array<[number, number]>> = [];
      for (const q of trail) { if (onPanel(q)) run.push(q); else { if (run.length > 1) runs.push(run); run = []; } }
      if (run.length > 1) runs.push(run);
      for (const r of runs) {
        out += `<polyline points="${r.map(q => `${f1(q[0])},${f1(q[1])}`).join(' ')}" fill="none" stroke="${MASS_COLOR}" stroke-width="2" stroke-dasharray="1 5" stroke-linecap="round" opacity="0.6"/>`;
      }
      out += trail.filter(onPanel).map(q => `<circle cx="${f1(q[0])}" cy="${f1(q[1])}" r="1.8" fill="${MASS_COLOR}" opacity="0.5"/>`).join('');
      const [cx, cy] = toPx(a.position.x, a.position.y);
      const label = `${names[j]} ${sci(massOf[j])} kg`;
      if (offContent(cx, cy)) {
        const mx = (contentPx.x0 + contentPx.x1) / 2, my = (contentPx.y0 + contentPx.y1) / 2;
        const dx = cx - mx, dy = cy - my;
        const halfW = (contentPx.x1 - contentPx.x0) / 2 - 26, halfH = (contentPx.y1 - contentPx.y0) / 2 - 26;
        const t = Math.min(halfW / (Math.abs(dx) || 1e-9), halfH / (Math.abs(dy) || 1e-9));
        const ex = mx + dx * t, ey = my + dy * t;
        const ang = Math.atan2(dy, dx);
        const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
        const dist = Math.hypot(a.position.x - study.guides.centre.x, a.position.y - study.guides.centre.y);
        out += `<polygon points="${f1(ex + ux * 16)},${f1(ey + uy * 16)} ${f1(ex - ux * 10 + nx * 14)},${f1(ey - uy * 10 + ny * 14)} ${f1(ex - ux * 10 - nx * 14)},${f1(ey - uy * 10 - ny * 14)}" fill="${MASS_COLOR}" stroke="${PAPER}" stroke-width="2" stroke-linejoin="round"/>`;
        const anchor = ex > PANEL_W * 0.55 ? 'end' : ex < PANEL_W * 0.45 ? 'start' : 'middle';
        out += `<text x="${f1(ex - ux * 24)}" y="${f1(ey - uy * 24 + (uy > 0 ? -6 : 16))}" font-size="13" font-weight="700" fill="#7d1f52" stroke="${PAPER}" stroke-width="4" paint-order="stroke" text-anchor="${anchor}" font-family="${FONT}">${label}, ${dist.toFixed(0)} m from centre</text>`;
        return;
      }
      out += `<path d="M${f1(cx - 9)},${f1(cy)} h18 M${f1(cx)},${f1(cy - 9)} v18" stroke="${MASS_COLOR}" stroke-width="3" stroke-linecap="round"/>`
        + `<text x="${f1(cx + 13)}" y="${f1(cy - 9)}" font-size="13" font-weight="700" fill="#7d1f52" stroke="${PAPER}" stroke-width="4" paint-order="stroke" font-family="${FONT}">${label}</text>`;
    });
    return out;
  };

  const e0 = first.energy.attractorTotal;
  const holdFrames = Math.round(options.fps);
  const tRender = performance.now();
  const writeFrame = async (frame: Frame, index: number): Promise<string> => {
    const result = await renderSketch({ entry, seed: request.seed, params: { ...request.params, step: frame.step }, finishing: request.finishing, timeoutMs: 240_000 });
    const right = new Resvg(result.svg, { background: result.metadata.page.paper ?? '#ffffff', fitTo: { mode: 'width', value: PANEL_W }, font: { loadSystemFonts: false } }).render();
    const rightPng = Buffer.from(right.asPng()).toString('base64');
    const s = frame.snapshot;
    const free = s.status.filter(v => v === STATUS_CODE.free).length;
    const captured = s.status.filter(v => v === STATUS_CODE.captured).length;
    const escaped = s.status.filter(v => v === STATUS_CODE.escaped).length;
    const by = (reason: number): number => s.reason.filter((r, i) => r === reason && s.status[i] === STATUS_CODE.captured).length;
    const printed = frame.printIndex !== null;
    const dE = (s.energy.attractorTotal - e0) / Math.abs(e0);
    const momentum = Math.hypot(s.energy.attractorMomentum.x, s.energy.attractorMomentum.y);
    const barX = leftX, barY = panelY + panelH + 12;
    const progX0 = GUTTER, progW = frameW - 2 * GUTTER, progY = frameH - 12;
    const progAt = (st: number): number => progX0 + (st / options.steps) * progW;
    const ticks = printSteps.map(st => `<rect x="${f1(progAt(st) - 2)}" y="${progY - 6}" width="4" height="16" fill="${PRINT_COLOR}"/>`).join('');
    const printLabel = options.window
      ? `<text x="${f1(progAt(options.window[0] + options.window[1]))}" y="${progY - 8}" font-size="13" text-anchor="middle" fill="${PRINT_COLOR}" font-family="${FONT}">print window ${printSteps.join(' / ')}</text>` : '';
    const legendLen = Math.min(LEN_CAP_M, LEN_PER_ROOT_M) * pxPerM;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${frameW}" height="${frameH}" viewBox="0 0 ${frameW} ${frameH}">
<rect width="${frameW}" height="${frameH}" fill="${BG}"/>
<rect x="${leftX}" y="${panelY}" width="${PANEL_W}" height="${panelH}" fill="${PAPER}"/>
<image x="${rightX}" y="${panelY}" width="${PANEL_W}" height="${Math.min(right.height, panelH)}" xlink:href="data:image/png;base64,${rightPng}"/>
<text x="${leftX}" y="30" font-size="22" font-weight="700" fill="${INK}" font-family="${FONT}">SYSTEM</text>
<text x="${leftX + 100}" y="30" font-size="16" fill="#555d6b" font-family="${FONT}">hidden masses, particles and the gravitational acceleration the plot never shows</text>
<text x="${rightX}" y="30" font-size="22" font-weight="700" fill="${INK}" font-family="${FONT}">PLOT</text>
<text x="${rightX + 80}" y="30" font-size="16" fill="#555d6b" font-family="${FONT}">what the pen draws at this moment</text>
${printed ? `<text x="${frameW - GUTTER}" y="30" font-size="22" font-weight="700" fill="${PRINT_COLOR}" text-anchor="end" font-family="${FONT}">PRINT ${frame.printIndex! + 1}/3 · step ${frame.step}</text>` : ''}
<g transform="translate(${leftX} ${panelY})">
<defs><clipPath id="pc"><rect width="${PANEL_W}" height="${panelH}"/></clipPath><clipPath id="cc"><rect x="${f1(contentPx.x0)}" y="${f1(contentPx.y0)}" width="${f1(contentPx.x1 - contentPx.x0)}" height="${f1(contentPx.y1 - contentPx.y0)}"/></clipPath></defs>
<g clip-path="url(#pc)"><g clip-path="url(#cc)">${accelerationLayer(s)}</g>${contentBox}${forbiddenSvg}${guidesSvg}${particleLayer(s)}${attractorLayer(frame, index)}
<rect x="12" y="12" width="330" height="158" rx="6" fill="rgba(251,249,243,0.92)"/>
<text x="24" y="46" font-size="30" font-weight="700" fill="${INK}" font-family="${FONT}">step ${frame.step} · ${f1(s.timeS)} s</text>
<text x="24" y="70" font-size="16" fill="${INK}" font-family="${FONT}"><tspan fill="${STATUS_FILL.free}" font-weight="700">free ${free}</tspan> · <tspan fill="${STATUS_FILL.captured}" font-weight="700">captured ${captured}</tspan> · <tspan fill="#6b6f77" font-weight="700">escaped ${escaped}</tspan></text>
<text x="24" y="90" font-size="14" fill="#555d6b" font-family="${FONT}">captured by: masses ${by(REASON_CODE.attractor)} · forbidden ${by(REASON_CODE.forbidden)} · edge ${by(REASON_CODE.edge)}</text>
<text x="24" y="114" font-size="14" fill="${INK}" font-family="${FONT}">masses E ${sci(s.energy.attractorTotal)} J (${signed(dE * 100, 3)}% vs step 0)</text>
<text x="24" y="134" font-size="14" fill="${INK}" font-family="${FONT}">masses momentum ${sci(momentum)} kg·m/s</text>
<text x="24" y="154" font-size="14" fill="${INK}" font-family="${FONT}">free particles Σ E/m ${sci(s.energy.particleSpecific)} J/kg</text>
</g></g>
<g transform="translate(${rightX} ${panelY})"><text x="14" y="${panelH - 12}" font-size="14" fill="#6b6f77" font-family="${FONT}">step ${frame.step} · ${f1(s.timeS)} s</text></g>
<g font-size="14" fill="#444c59" font-family="${FONT}">
${arrowSvg(barX, barY + 14, barX + legendLen, barY + 14, 8, '#2d4a6b', 1.6, 0.8)}
<text x="${f1(barX + legendLen + 10)}" y="${barY + 19}">acceleration |a| = ${A_REF} m/s² (arrow length is √|a|, capped at ${LEN_CAP_M} m of page at ${(A_REF * (LEN_CAP_M / LEN_PER_ROOT_M) ** 2).toFixed(2)} m/s²; grid every ${ARROW_GRID} m)</text>
<path d="M${barX + 4},${barY + 40} h14 M${barX + 11},${barY + 33} v14" stroke="${MASS_COLOR}" stroke-width="2.6"/><text x="${barX + 26}" y="${barY + 44}">hidden mass (never drawn on the plot), dotted path</text>
<circle cx="${barX + 380}" cy="${barY + 40}" r="4" fill="${STATUS_FILL.free}"/><text x="${barX + 390}" y="${barY + 44}">free</text>
<circle cx="${barX + 440}" cy="${barY + 40}" r="4" fill="${STATUS_FILL.captured}"/><text x="${barX + 450}" y="${barY + 44}">captured</text>
<circle cx="${barX + 530}" cy="${barY + 40}" r="4" fill="${STATUS_FILL.escaped}"/><text x="${barX + 540}" y="${barY + 44}">escaped</text>
<line x1="${barX + 620}" y1="${barY + 40}" x2="${barX + 650}" y2="${barY + 40}" stroke="#d04b3c" stroke-width="2"/><text x="${barX + 658}" y="${barY + 44}">guide</text>
<rect x="${barX + 720}" y="${barY + 33}" width="26" height="14" fill="#4d5159"/><text x="${barX + 754}" y="${barY + 44}">forbidden (dashed: capture edge)</text>
</g>
<rect x="${progX0}" y="${progY}" width="${progW}" height="4" fill="#c7c4bc"/>
<rect x="${progX0}" y="${progY}" width="${f1(progAt(frame.step) - progX0)}" height="4" fill="${INK}"/>${ticks}${printLabel}
${printed ? `<rect x="${leftX - 5}" y="${panelY - 5}" width="${PANEL_W + 10}" height="${panelH + 10}" fill="none" stroke="${PRINT_COLOR}" stroke-width="8"/><rect x="${rightX - 5}" y="${panelY - 5}" width="${PANEL_W + 10}" height="${panelH + 10}" fill="none" stroke="${PRINT_COLOR}" stroke-width="8"/>` : ''}
</svg>`;
    const png = new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' } }).render().asPng();
    const name = `frame-${String(index).padStart(4, '0')}-step-${String(frame.step).padStart(4, '0')}.png`;
    writeFileSync(join(framesDir, name), png);
    return name;
  };

  const names2: string[] = new Array(frames.length);
  let done = 0;
  await pool(frames.map((frame, index) => ({ frame, index })), options.jobs, async ({ frame, index }) => {
    names2[index] = await writeFrame(frame, index);
    if (++done % 10 === 0 || done === frames.length) console.error(`frames ${done}/${frames.length}`);
  });
  const renderMs = performance.now() - tRender;

  // Video: concat list with held print frames (≈1 s each); encode H.264 yuv420p, web-playable, < 15 MB.
  const lines: string[] = [];
  const frameDur = 1 / options.fps;
  frames.forEach((frame, i) => {
    lines.push(`file '${join(framesDir, names2[i]).replace(/'/g, "'\\''")}'`, `duration ${(frame.printIndex !== null ? holdFrames * frameDur : frameDur).toFixed(6)}`);
  });
  lines.push(`file '${join(framesDir, names2[names2.length - 1]).replace(/'/g, "'\\''")}'`);
  const listPath = join(outDir, 'frames.txt');
  writeFileSync(listPath, `${lines.join('\n')}\n`);
  const mp4 = join(outDir, 'timelapse.mp4');
  const tEnc = performance.now();
  let crf = 20;
  for (;;) {
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vf', `fps=${options.fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
    if (statSync(mp4).size < 14.5e6 || crf >= 34) break;
    crf += 3;
  }
  const encodeMs = performance.now() - tEnc;

  const posterStep = options.window ? options.window[0] + options.window[1] : frames[frames.length - 1].step;
  const posterIndex = Math.max(0, frames.findIndex(f => f.step === posterStep));
  writeFileSync(join(outDir, 'poster.png'), readFileSync(join(framesDir, names2[posterIndex])));
  const duration = frames.reduce((n, f) => n + (f.printIndex !== null ? holdFrames : 1), 0) / options.fps;
  const summary = {
    outDir, frames: frames.length, size: `${frameW}x${frameH}`, durationS: Number(duration.toFixed(2)), crf,
    mp4Bytes: statSync(mp4).size, printSteps, posterStep,
    secondsTotal: Number(((performance.now() - t0) / 1000).toFixed(1)), simulateS: Number((simMs / 1000).toFixed(2)),
    renderFramesS: Number((renderMs / 1000).toFixed(1)), encodeS: Number((encodeMs / 1000).toFixed(1)), jobs: options.jobs,
  };
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (!existsSync(mp4)) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
