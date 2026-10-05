/**
 * Side-by-side timelapse of the Prescribed Weather simulation.
 *
 *   npx tsx sketches/cloud-advection/timelapse.ts <request.json | inline-json> <outDir> [--every 2] [--fps 12] [--window 56,32] [--steps 240] [--jobs 5]
 *
 * LEFT  "system" panel: the raw concentration field on a fixed scale (0 = paper, referenceDensity = deep
 *       blue-grey, never normalized per frame), solid members, quiet core, eddy centres (at the frame's own
 *       positions, with a dotted trail of the last 60 steps and an edge chevron if one leaves the page) with rotation
 *       direction, a sparse arrow grid of the prescribed velocity, wind arrow, step/time and mass readouts.
 *       The field and colour bar are written into a pngjs canvas; the vector annotations (members, rings,
 *       arrows, text) are one transparent SVG overlay rasterized by @resvg/resvg-js.
 * RIGHT "plot" panel: the real sketch render (renderSketch at that step), rasterized from its SVG.
 *
 * The request is either `{ seed, params, finishing }` or a bare params object (no finishing). With
 * `--window start,delta` the frames at start, start+delta, start+2·delta get a coloured border and a PRINT
 * tag and are held for ~1 s in the video. Output: <outDir>/frames/*.png, timelapse.mp4, poster.png
 * (the frame at the window midpoint, or the last frame without a window).
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { mapFinishingPoint, resolveFinishing } from '../../packages/plot-core/src/index.ts';
import type { FinishingOptions, Params } from '../../src/sketch/types.ts';
import { studyContext } from './evidence.ts';
import { advance, buildDomain, initialSnapshot, velocityAtTime } from './sim.ts';
import { LIMITS } from './model.ts';
import type { ActiveVortex, CloudSnapshot } from './model.ts';
import sketch from './sketch.ts';
import { buildStudy } from './study.ts';

const entry = resolve('sketches/cloud-advection/sketch.ts');

interface Request { seed: number; params: Params; finishing?: FinishingOptions }
interface Options { every: number; fps: number; window: [number, number] | null; steps: number; jobs: number }

// ------------------------------------------------------------------ layout constants
const PANEL_W = 720;
const GUTTER = 16;
const HEADER_H = 56;
const FOOTER_H = 104;
const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const INK = '#243044';
const PRINT_COLOR = '#d6452b';
const BG: [number, number, number] = [236, 233, 226];

type RGB = [number, number, number];
const hex = (c: string): RGB => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)) as RGB;

/** Calm sequential map: paper → pale blue-grey → deep blue-grey. t in [0, 1]. */
const STOPS: Array<[number, RGB]> = [
  [0, [0xfb, 0xf9, 0xf3]], [0.15, hex('#e3e9ee')], [0.4, hex('#aebfce')], [0.7, hex('#5f7a96')], [1, hex('#1f3550')],
];
const PAPER: RGB = STOPS[0][1];
function colormap(t: number): RGB {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    if (x <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      const f = (x - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

// ------------------------------------------------------------------ pngjs helpers
class Canvas {
  readonly data: Buffer;
  constructor(readonly width: number, readonly height: number, fill: RGB) {
    this.data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) { this.data[i * 4] = fill[0]; this.data[i * 4 + 1] = fill[1]; this.data[i * 4 + 2] = fill[2]; this.data[i * 4 + 3] = 255; }
  }
  rect(x0: number, y0: number, w: number, h: number, c: RGB): void {
    for (let y = Math.max(0, y0); y < Math.min(this.height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(this.width, x0 + w); x++) {
        const o = (y * this.width + x) * 4;
        this.data[o] = c[0]; this.data[o + 1] = c[1]; this.data[o + 2] = c[2]; this.data[o + 3] = 255;
      }
    }
  }
  /** Copy an opaque RGBA buffer of size w×h to (x0, y0). */
  blit(src: Uint8Array, w: number, h: number, x0: number, y0: number): void {
    for (let y = 0; y < h; y++) {
      if (y + y0 < 0 || y + y0 >= this.height) continue;
      for (let x = 0; x < w; x++) {
        if (x + x0 < 0 || x + x0 >= this.width) continue;
        const s = (y * w + x) * 4;
        const d = ((y + y0) * this.width + x + x0) * 4;
        this.data[d] = src[s]; this.data[d + 1] = src[s + 1]; this.data[d + 2] = src[s + 2]; this.data[d + 3] = 255;
      }
    }
  }
  /** Straight-alpha RGBA over this canvas. */
  over(src: Uint8Array): void {
    for (let i = 0; i < this.width * this.height; i++) {
      const a = src[i * 4 + 3] / 255;
      if (a === 0) continue;
      for (let k = 0; k < 3; k++) this.data[i * 4 + k] = Math.round(src[i * 4 + k] * a + this.data[i * 4 + k] * (1 - a));
    }
  }
  png(): Buffer { const png = new PNG({ width: this.width, height: this.height }); this.data.copy(png.data); return PNG.sync.write(png, { deflateLevel: 3 }); }
}

// ------------------------------------------------------------------ geometry
interface Frame { step: number; snapshot: CloudSnapshot; printIndex: number | null }

const f1 = (n: number): string => n.toFixed(1);
const signed = (n: number, d = 1): string => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(d)}`;

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
  const options: Options = { every: 2, fps: 12, window: null, steps: 240, jobs: 5 };
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
  if (positional.length !== 2) throw new Error('Usage: timelapse.ts <request.json | inline-json> <outDir> [--every N] [--fps F] [--window start,delta] [--steps 240] [--jobs 5]');
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
  const ctx = studyContext(request);
  const study = buildStudy(ctx);
  const config = study.config;
  const domain = buildDomain(config);
  const finishing = resolveFinishing(sketch.page, sketch.pens, request.finishing ?? {});
  const page = finishing.page;
  const pxPerMm = PANEL_W / page.width;
  const panelH = 2 * Math.ceil(page.height * pxPerMm / 2);
  const ref = study.marks.referenceDensity;
  const wtp = config.transforms.worldToPage;
  /** World metres → pixel inside a panel. */
  const toPx = (x: number, y: number): [number, number] => {
    const p = mapFinishingPoint({ x: wtp.offset.x + wtp.scale * x, y: wtp.offset.y + wtp.scale * y }, finishing);
    return [p.x * pxPerMm, p.y * pxPerMm];
  };
  const pxPerM = wtp.scale * finishing.scale * pxPerMm;
  const frameW = 2 * PANEL_W + 3 * GUTTER;
  const frameH = HEADER_H + panelH + FOOTER_H;
  const leftX = GUTTER, rightX = 2 * GUTTER + PANEL_W, panelY = HEADER_H;

  // Frame list: multiples of --every plus the window steps, ascending.
  const stepSet = new Set<number>();
  for (let s = 0; s <= options.steps; s += options.every) stepSet.add(s);
  const printSteps = options.window ? [0, 1, 2].map(k => options.window![0] + k * options.window![1]) : [];
  for (const s of printSteps) stepSet.add(s);
  const stepList = [...stepSet].sort((a, b) => a - b);

  // Simulate once, incrementally; keep the snapshots (density arrays are 23,400 doubles each).
  const tSim = performance.now();
  const frames: Frame[] = [];
  let snap = initialSnapshot(config);
  for (const step of stepList) {
    if (step > snap.step) snap = advance(snap, config, step - snap.step);
    const pi = printSteps.indexOf(step);
    frames.push({ step, snapshot: snap, printIndex: pi >= 0 ? pi : null });
  }
  const simMs = performance.now() - tSim;
  const massInitial = frames[0].snapshot.mass.initial;

  // Per-pixel bilinear lookup of the cell-centred grid for the panel (constant across frames).
  const { cols, rows, spacing } = domain;
  const lookup = new Int32Array(PANEL_W * panelH * 4);
  const weights = new Float32Array(PANEL_W * panelH * 4);
  const inside = new Uint8Array(PANEL_W * panelH);
  const inv = (px: number, py: number): [number, number] => {
    const mx = px / pxPerMm, my = py / pxPerMm;
    const fx = (mx - finishing.offsetX) / finishing.scale, fy = (my - finishing.offsetY) / finishing.scale;
    return [(fx - wtp.offset.x) / wtp.scale, (fy - wtp.offset.y) / wtp.scale];
  };
  for (let py = 0; py < panelH; py++) {
    for (let px = 0; px < PANEL_W; px++) {
      const [wx, wy] = inv(px + 0.5, py + 0.5);
      const o = py * PANEL_W + px;
      if (wx < 0 || wy < 0 || wx > config.domain.size.x || wy > config.domain.size.y) { inside[o] = 0; continue; }
      inside[o] = 1;
      const gu = Math.min(cols - 1, Math.max(0, wx / spacing - 0.5)), gv = Math.min(rows - 1, Math.max(0, wy / spacing - 0.5));
      const i0 = Math.min(cols - 2, Math.floor(gu)), j0 = Math.min(rows - 2, Math.floor(gv));
      const fu = gu - i0, fv = gv - j0;
      lookup[o * 4] = j0 * cols + i0; lookup[o * 4 + 1] = j0 * cols + i0 + 1; lookup[o * 4 + 2] = (j0 + 1) * cols + i0; lookup[o * 4 + 3] = (j0 + 1) * cols + i0 + 1;
      weights[o * 4] = (1 - fu) * (1 - fv); weights[o * 4 + 1] = fu * (1 - fv); weights[o * 4 + 2] = (1 - fu) * fv; weights[o * 4 + 3] = fu * fv;
    }
  }
  const cm = Array.from({ length: 1024 }, (_, i) => colormap(i / 1023));
  const content = finishing.contentRect;
  const contentPx = { x0: content.xMin * pxPerMm, y0: content.yMin * pxPerMm, x1: content.xMax * pxPerMm, y1: content.yMax * pxPerMm };

  /** Raw concentration → panel RGBA. Outside the domain: paper. Outside the drawn area: washed toward paper. */
  const fieldPanel = (density: ArrayLike<number>): Uint8Array => {
    const out = new Uint8Array(PANEL_W * panelH * 4);
    for (let py = 0; py < panelH; py++) {
      for (let px = 0; px < PANEL_W; px++) {
        const o = py * PANEL_W + px;
        let c: RGB = PAPER;
        if (inside[o]) {
          const v = density[lookup[o * 4]] * weights[o * 4] + density[lookup[o * 4 + 1]] * weights[o * 4 + 1]
            + density[lookup[o * 4 + 2]] * weights[o * 4 + 2] + density[lookup[o * 4 + 3]] * weights[o * 4 + 3];
          c = cm[Math.round(Math.max(0, Math.min(1, v / ref)) * 1023)];
          if (px < contentPx.x0 || px > contentPx.x1 || py < contentPx.y0 || py > contentPx.y1) c = [c[0] * 0.45 + PAPER[0] * 0.55, c[1] * 0.45 + PAPER[1] * 0.55, c[2] * 0.45 + PAPER[2] * 0.55];
        }
        out[o * 4] = c[0]; out[o * 4 + 1] = c[1]; out[o * 4 + 2] = c[2]; out[o * 4 + 3] = 255;
      }
    }
    return out;
  };

  // ---- static overlay pieces (identical every frame)
  // Simulation solids are filled dark; drawn-only members (`solid: false`) are thin light outlines.
  const solids = study.structure.map(m => {
    const pts = m.polygon.map(p => toPx(p.x, p.y).map(f1).join(',')).join(' ');
    if (m.solid === false) return `<polygon points="${pts}" fill="none" stroke="#9a9fa8" stroke-width="1" stroke-linejoin="round"/>`;
    return `<polygon points="${pts}" fill="#4d5159" stroke="#4d5159" stroke-width="1.2" stroke-linejoin="round"/>`;
  }).join('');
  const core = study.marks.core;
  const corePx = mapFinishingPoint(core.center, finishing);
  const coreSvg = `<circle cx="${f1(corePx.x * pxPerMm)}" cy="${f1(corePx.y * pxPerMm)}" r="${f1(core.radius * finishing.scale * pxPerMm)}" fill="none" stroke="#b5372a" stroke-width="2" stroke-dasharray="10 7"/>`;
  /** Static `eddy-a` → A; `train-3` → T3. */
  const eddyName = (key: string): string => (key === 'eddy-a' ? 'A' : key === 'eddy-b' ? 'B' : key.startsWith('train-') ? `T${key.slice(6)}` : key.replace('eddy-', ''));
  /**
   * Rings at this frame's ACTIVE vortices (spin from the sign of circulation), a dotted trail per vortex key
   * (it ends when the key leaves the active list), a "+" flash on the frame where a key first appears, and an edge
   * chevron for an eddy off the drawn area. Only on-page eddies and static eddies get a text label, so a train
   * of a dozen does not clutter.
   */
  const eddyLayer = (frame: Frame, frameIndex: number): string => {
    let out = '';
    const TRAIL_STEPS = 60;
    const previous = frameIndex > 0 ? new Set(frames[frameIndex - 1].snapshot.vortices.map(v => v.key)) : null;
    for (const v of frame.snapshot.vortices) {
      const isTrain = v.key.startsWith('train-');
      const name = eddyName(v.key);
      // trail: the same key's centres in earlier frames within TRAIL_STEPS, stopping where the key was absent
      const trail: Array<[number, number]> = [];
      for (let i = frameIndex; i >= 0 && frame.step - frames[i].step <= TRAIL_STEPS; i--) {
        const prev = frames[i].snapshot.vortices.find(w => w.key === v.key);
        if (!prev) break;
        trail.unshift(toPx(prev.center.x, prev.center.y));
      }
      if (trail.length > 1 && trail.some((q, i) => i > 0 && Math.hypot(q[0] - trail[i - 1][0], q[1] - trail[i - 1][1]) > 0.5)) {
        out += `<polyline points="${trail.map(q => `${f1(q[0])},${f1(q[1])}`).join(' ')}" fill="none" stroke="#a02a6b" stroke-width="2.4" stroke-dasharray="1.5 6" stroke-linecap="round" opacity="0.55"/>`;
      }
      const [cx, cy] = toPx(v.center.x, v.center.y);
      const outside = cx < contentPx.x0 || cx > contentPx.x1 || cy < contentPx.y0 || cy > contentPx.y1;
      if (outside) {
        // chevron on the drawn-area edge, pointing at the eddy
        const mx = (contentPx.x0 + contentPx.x1) / 2, my = (contentPx.y0 + contentPx.y1) / 2;
        const dx = cx - mx, dy = cy - my;
        const halfW = (contentPx.x1 - contentPx.x0) / 2 - 26, halfH = (contentPx.y1 - contentPx.y0) / 2 - 26;
        const t = Math.min(halfW / (Math.abs(dx) || 1e-9), halfH / (Math.abs(dy) || 1e-9));
        const ex = mx + dx * t, ey = my + dy * t;
        const ang = Math.atan2(dy, dx);
        const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
        const k = isTrain ? 0.6 : 1;
        const tip = [ex + ux * 16 * k, ey + uy * 16 * k], l = [ex - ux * 10 * k + nx * 14 * k, ey - uy * 10 * k + ny * 14 * k], r = [ex - ux * 10 * k - nx * 14 * k, ey - uy * 10 * k - ny * 14 * k];
        out += `<polygon points="${f1(tip[0])},${f1(tip[1])} ${f1(l[0])},${f1(l[1])} ${f1(r[0])},${f1(r[1])}" fill="#a02a6b" opacity="${isTrain ? 0.6 : 1}" stroke="#fbf9f3" stroke-width="2" stroke-linejoin="round"/>`;
        if (previous && !previous.has(v.key)) out += `<circle cx="${f1(ex + ux * 4)}" cy="${f1(ey + uy * 4)}" r="20" fill="none" stroke="#e08a00" stroke-width="3"/>`;
        if (!isTrain) {
          out += `<text x="${f1(ex - ux * 22 + (ux > 0.3 ? -14 : ux < -0.3 ? 14 : 0))}" y="${f1(ey - uy * 22 + (uy > 0.3 ? -6 : 14))}" font-size="14" font-weight="700" fill="#7d1f52" stroke="#fbf9f3" stroke-width="4" paint-order="stroke" text-anchor="middle" font-family="${FONT}">${name} off page</text>`;
        }
        continue;
      }
      const r = Math.max(7, v.coreRadius * pxPerM);
      const sgn = v.circulation >= 0 ? 1 : -1; // positive circulation = clockwise on the y-down page
      const a0 = -Math.PI / 2 - sgn * 0.2, sweep = sgn * 1.55 * Math.PI;
      const a1 = a0 + sweep;
      const R = r + 6;
      const sx = cx + R * Math.cos(a0), sy = cy + R * Math.sin(a0), ex = cx + R * Math.cos(a1), ey = cy + R * Math.sin(a1);
      const arc = `<path d="M${f1(sx)},${f1(sy)} A${f1(R)},${f1(R)} 0 1 ${sgn > 0 ? 1 : 0} ${f1(ex)},${f1(ey)}" fill="none" stroke="#a02a6b" stroke-width="2.6" stroke-linecap="round"/>`;
      // arrowhead at the end of the arc, pointing along the tangent
      const tx = -Math.sin(a1) * sgn, ty = Math.cos(a1) * sgn;
      const nx = -ty, ny = tx, hs = 9;
      const head = `<polygon fill="#a02a6b" points="${f1(ex + tx * hs)},${f1(ey + ty * hs)} ${f1(ex - tx * 2 + nx * hs * 0.6)},${f1(ey - ty * 2 + ny * hs * 0.6)} ${f1(ex - tx * 2 - nx * hs * 0.6)},${f1(ey - ty * 2 - ny * hs * 0.6)}"/>`;
      out += `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" fill="rgba(255,255,255,0.35)" stroke="#a02a6b" stroke-width="2.2"/>${arc}${head}`
        + `<text x="${f1(cx)}" y="${f1(cy + 5)}" font-size="13" font-weight="700" fill="#a02a6b" text-anchor="middle" font-family="${FONT}">${name}</text>`;
      // circulation label on every on-page eddy (the sign is the spin: + clockwise on the page)
      out += `<text x="${f1(cx + R + 10)}" y="${f1(cy + 5)}" font-size="13" font-weight="600" fill="#7d1f52" stroke="#fbf9f3" stroke-width="4" paint-order="stroke" stroke-linejoin="round" font-family="${FONT}">${isTrain ? '' : `${name} `}Γ ${signed(v.circulation, 0)}</text>`;
      // spawn flash: a "+" ring on the first frame this key appears
      if (previous && !previous.has(v.key)) {
        out += `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(R + 14)}" fill="none" stroke="#e08a00" stroke-width="3"/>`
          + `<path d="M${f1(cx - R - 22)},${f1(cy)} h${f1(2 * R + 44)} M${f1(cx)},${f1(cy - R - 22)} v${f1(2 * R + 44)}" stroke="#e08a00" stroke-width="3" stroke-linecap="round"/>`;
      }
    }
    return out;
  };
  // Sparse velocity arrows every ~5 m: the prescribed field with the vortices at this frame's centres (faint).
  const ARROW_GRID = 5;
  const arrowLayer = (active: ReadonlyArray<ActiveVortex>): string => {
    let arrows = '';
    for (let y = ARROW_GRID / 2; y < config.domain.size.y; y += ARROW_GRID) {
      for (let x = ARROW_GRID / 2; x < config.domain.size.x; x += ARROW_GRID) {
        const [px, py] = toPx(x, y);
        if (px < contentPx.x0 - 20 || px > contentPx.x1 + 20 || py < contentPx.y0 - 20 || py > contentPx.y1 + 20) continue;
        const v = velocityAtTime(config, active, { x, y });
        const speed = Math.hypot(v.x, v.y);
        const lenM = Math.min(4.2, 1.7 * speed); // metres of page-length for a given speed
        const L = lenM * pxPerM;
        const ux = v.x / (speed || 1), uy = v.y / (speed || 1);
        arrows += arrowSvg(px - ux * L / 2, py - uy * L / 2, px + ux * L / 2, py + uy * L / 2, 8, '#2d4a6b', 1.4, 0.38);
      }
    }
    return arrows;
  };
  const contentBox = `<rect x="${f1(contentPx.x0)}" y="${f1(contentPx.y0)}" width="${f1(contentPx.x1 - contentPx.x0)}" height="${f1(contentPx.y1 - contentPx.y0)}" fill="none" stroke="#8a8f99" stroke-width="1" stroke-dasharray="2 4"/>`;
  const wind = config.wind.velocity;
  const windSpeed = Math.hypot(wind.x, wind.y);
  const windArrow = (() => {
    const cx = PANEL_W - 100, cy = 56, L = 54;
    const ux = wind.x / (windSpeed || 1), uy = wind.y / (windSpeed || 1);
    return `<rect x="${PANEL_W - 204}" y="12" width="192" height="112" rx="6" fill="rgba(251,249,243,0.9)"/>`
      + arrowSvg(cx - ux * L / 2, cy - uy * L / 2, cx + ux * L / 2, cy + uy * L / 2, 14, '#1f3550', 4, 1)
      + `<text x="${cx}" y="${cy + 56}" font-size="15" text-anchor="middle" fill="${INK}" font-family="${FONT}">wind ${signed(wind.x)}, ${signed(wind.y)} m/s</text>`;
  })();
  const staticLeftOver = `${contentBox}${coreSvg}`;

  const holdFrames = Math.round(options.fps);
  const tRender = performance.now();
  const writeFrame = async (frame: Frame, index: number): Promise<string> => {
    const result = await renderSketch({ entry, seed: request.seed, params: { ...request.params, step: frame.step }, finishing: request.finishing, timeoutMs: 240_000 });
    const rightPx = new Resvg(result.svg, { background: result.metadata.page.paper ?? '#ffffff', fitTo: { mode: 'width', value: PANEL_W }, font: { loadSystemFonts: false } }).render();
    const canvas = new Canvas(frameW, frameH, BG);
    canvas.rect(leftX, panelY, PANEL_W, panelH, PAPER);
    canvas.blit(fieldPanel(frame.snapshot.density), PANEL_W, panelH, leftX, panelY);
    canvas.rect(rightX, panelY, PANEL_W, panelH, PAPER);
    canvas.blit(rightPx.pixels, rightPx.width, Math.min(rightPx.height, panelH), rightX, panelY);
    // fixed-scale colour bar
    const barX = leftX, barY = panelY + panelH + 14, barW = 300, barH = 16;
    for (let x = 0; x < barW; x++) canvas.rect(barX + x, barY, 1, barH, colormap(x / (barW - 1)));

    const s = frame.snapshot;
    const timeS = s.timeS;
    const printed = frame.printIndex !== null;
    const massNow = s.mass.current;
    let peak = 0;
    for (let i = 0; i < s.density.length; i++) if (s.density[i] > peak) peak = s.density[i];
    const progX0 = GUTTER, progW = frameW - 2 * GUTTER, progY = frameH - 12;
    const lastStep = options.steps;
    const progAt = (st: number): number => progX0 + (st / lastStep) * progW;
    const ticks = printSteps.map(st => `<rect x="${f1(progAt(st) - 2)}" y="${progY - 6}" width="4" height="16" fill="${PRINT_COLOR}"/>`).join('');
    const printLabel = options.window
      ? `<text x="${f1(progAt(options.window[0] + options.window[1]))}" y="${progY - 8}" font-size="13" text-anchor="middle" fill="${PRINT_COLOR}" font-family="${FONT}">print window ${printSteps.join(' / ')}</text>` : '';
    const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${frameW}" height="${frameH}" viewBox="0 0 ${frameW} ${frameH}">
<text x="${leftX}" y="30" font-size="22" font-weight="700" fill="${INK}" font-family="${FONT}">SYSTEM</text>
<text x="${leftX + 100}" y="30" font-size="16" fill="#555d6b" font-family="${FONT}">concentration c, fixed scale (paper = 0, deep = ${ref.toFixed(2)})</text>
<text x="${rightX}" y="30" font-size="22" font-weight="700" fill="${INK}" font-family="${FONT}">PLOT</text>
<text x="${rightX + 80}" y="30" font-size="16" fill="#555d6b" font-family="${FONT}">what the pen draws at this moment</text>
${printed ? `<text x="${frameW - GUTTER}" y="30" font-size="22" font-weight="700" fill="${PRINT_COLOR}" text-anchor="end" font-family="${FONT}">PRINT ${frame.printIndex! + 1}/3 · step ${frame.step}</text>` : ''}
<g transform="translate(${leftX} ${panelY})">
<defs><clipPath id="pc"><rect width="${PANEL_W}" height="${panelH}"/></clipPath><clipPath id="cc"><rect x="${f1(contentPx.x0)}" y="${f1(contentPx.y0)}" width="${f1(contentPx.x1 - contentPx.x0)}" height="${f1(contentPx.y1 - contentPx.y0)}"/></clipPath></defs>
<g clip-path="url(#pc)"><g clip-path="url(#cc)">${arrowLayer(frame.snapshot.vortices)}${solids}</g>${staticLeftOver}${eddyLayer(frame, index)}${windArrow}
<rect x="12" y="12" width="276" height="86" rx="6" fill="rgba(251,249,243,0.9)"/>
<text x="24" y="46" font-size="30" font-weight="700" fill="${INK}" font-family="${FONT}">step ${frame.step} · ${f1(timeS)} s</text>
<text x="24" y="72" font-size="16" fill="${INK}" font-family="${FONT}">mass ${massNow.toFixed(1)} m² (step 0: ${massInitial.toFixed(1)})</text>
<text x="24" y="92" font-size="16" fill="${INK}" font-family="${FONT}">net change ${signed(s.mass.relativeDrift * 100)}% · peak c ${peak.toFixed(2)}</text>
</g></g>
<g transform="translate(${rightX} ${panelY})"><text x="14" y="${panelH - 12}" font-size="14" fill="#6b6f77" font-family="${FONT}">step ${frame.step} · ${f1(timeS)} s</text></g>
<text x="${barX}" y="${barY + barH + 18}" font-size="14" fill="${INK}" font-family="${FONT}">0</text>
<text x="${barX + barW}" y="${barY + barH + 18}" font-size="14" fill="${INK}" text-anchor="end" font-family="${FONT}">c ≥ ${ref.toFixed(2)} (clamped)</text>
<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" fill="none" stroke="#777" stroke-width="1"/>
<g font-size="14" fill="#444c59" font-family="${FONT}">
<rect x="${barX + 340}" y="${barY + 1}" width="16" height="14" fill="#4d5159"/><text x="${barX + 362}" y="${barY + 13}">solid (absorbs)</text>
<circle cx="${barX + 540}" cy="${barY + 8}" r="6.5" fill="none" stroke="#a02a6b" stroke-width="2"/><text x="${barX + 554}" y="${barY + 13}">eddy: spin on page, dotted trail, orange + = spawned</text>
<line x1="${barX + 930}" y1="${barY + 8}" x2="${barX + 960}" y2="${barY + 8}" stroke="#b5372a" stroke-width="2" stroke-dasharray="6 4"/><text x="${barX + 968}" y="${barY + 13}">quiet core</text>
<line x1="${barX + 340}" y1="${barY + 34}" x2="${barX + 366}" y2="${barY + 34}" stroke="#2d4a6b" stroke-width="1.6" opacity="0.5"/><text x="${barX + 374}" y="${barY + 39}">prescribed velocity (every ${ARROW_GRID} m)</text>
<polygon points="${barX + 920},${barY + 42} ${barX + 950},${barY + 42} ${barX + 950},${barY + 28} ${barX + 920},${barY + 28}" fill="none" stroke="#9a9fa8" stroke-width="1.2"/><text x="${barX + 958}" y="${barY + 39}">drawn only, not a solid</text>
<rect x="${barX + 640}" y="${barY + 26}" width="30" height="16" fill="none" stroke="#8a8f99" stroke-dasharray="2 3"/><text x="${barX + 678}" y="${barY + 39}">drawn area (washed outside)</text>
</g>
<rect x="${progX0}" y="${progY}" width="${progW}" height="4" fill="#c7c4bc"/>
<rect x="${progX0}" y="${progY}" width="${f1(progAt(frame.step) - progX0)}" height="4" fill="${INK}"/>${ticks}${printLabel}
${printed ? `<rect x="${leftX - 5}" y="${panelY - 5}" width="${PANEL_W + 10}" height="${panelH + 10}" fill="none" stroke="${PRINT_COLOR}" stroke-width="8"/><rect x="${rightX - 5}" y="${panelY - 5}" width="${PANEL_W + 10}" height="${panelH + 10}" fill="none" stroke="${PRINT_COLOR}" stroke-width="8"/>` : ''}
</svg>`;
    const over = PNG.sync.read(Buffer.from(new Resvg(overlay, { fitTo: { mode: 'original' }, font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' } }).render().asPng()));
    canvas.over(over.data);
    const name = `frame-${String(index).padStart(4, '0')}-step-${String(frame.step).padStart(3, '0')}.png`;
    writeFileSync(join(framesDir, name), canvas.png());
    return name;
  };

  const names: string[] = new Array(frames.length);
  let done = 0;
  await pool(frames.map((frame, index) => ({ frame, index })), options.jobs, async ({ frame, index }) => {
    names[index] = await writeFrame(frame, index);
    if (++done % 10 === 0 || done === frames.length) console.error(`frames ${done}/${frames.length}`);
  });
  const renderMs = performance.now() - tRender;

  // Video: concat list with held print frames (≈1 s each); encode H.264 yuv420p, web-playable, < 15 MB.
  const lines: string[] = [];
  const frameDur = 1 / options.fps;
  frames.forEach((frame, i) => {
    lines.push(`file '${join(framesDir, names[i]).replace(/'/g, "'\\''")}'`, `duration ${(frame.printIndex !== null ? holdFrames * frameDur : frameDur).toFixed(6)}`);
  });
  lines.push(`file '${join(framesDir, names[names.length - 1]).replace(/'/g, "'\\''")}'`);
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
  writeFileSync(join(outDir, 'poster.png'), readFileSync(join(framesDir, names[posterIndex])));
  const duration = frames.reduce((n, f) => n + (f.printIndex !== null ? holdFrames : 1), 0) / options.fps;
  const summary = {
    outDir, frames: frames.length, size: `${frameW}x${frameH}`, durationS: Number(duration.toFixed(2)), crf,
    mp4Bytes: statSync(mp4).size, printSteps, posterStep,
    secondsTotal: Number(((performance.now() - t0) / 1000).toFixed(1)), simulateS: Number((simMs / 1000).toFixed(1)),
    renderFramesS: Number((renderMs / 1000).toFixed(1)), encodeS: Number((encodeMs / 1000).toFixed(1)), jobs: options.jobs,
  };
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (!existsSync(mp4)) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
