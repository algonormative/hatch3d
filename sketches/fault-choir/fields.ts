import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';

const W = 420;
const H = 297;
const M = 18;
const TAU = Math.PI * 2;
const PENS = ['carbon', 'cobalt', 'lagoon', 'ember', 'brass'] as const;

interface Domain {
  id: number;
  cx: number;
  cy: number;
  angle: number;
  ax: number;
  ay: number;
  weight: number;
  phase: number;
  grammar: number;
  pen: string;
  secondary: string;
  rhythm: number;
}

interface Layout {
  domains: Domain[];
  corridor: { y: number; slope: number; amplitude: number; phase: number };
  windows: { x: number; y: number; rx: number; ry: number; angle: number }[];
}

function value(ctx: SketchContext, id: string): number { return ctx.params[id] as number; }
function mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
function clamp(v: number, a: number, b: number): number { return Math.max(a, Math.min(b, v)); }
function modulo(v: number, divisor: number): number { return ((v % divisor) + divisor) % divisor; }
function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 17, 0x85ebca77) ^ Math.imul(c + 113, 0xc2b2ae3d);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Layout streams are independent of mark sampling and of every other domain. */
function makeLayout(ctx: SketchContext): Layout {
  const global = ctx.random('field-layout');
  const count = 7 + Math.floor(global() * 4);
  const angleBias = mix(-0.38, 0.38, global());
  const order = Array.from({ length: 12 }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(global() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const domains: Domain[] = [];
  for (let i = 0; i < count; i++) {
    const r = ctx.random(`field-domain-${i}`);
    const cell = order[i];
    const col = cell % 4;
    const row = Math.floor(cell / 4);
    const cx = i === 0 ? mix(134, 273, r()) : 65 + col * 96 + (r() - 0.5) * 45;
    const cy = i === 0 ? mix(88, 207, r()) : 53 + row * 91 + (r() - 0.5) * 42;
    const angle = (r() - 0.5) * 1.5 + angleBias + (row === 1 ? 0.12 : 0);
    const ax = mix(85, 155, r());
    const ay = mix(62, 115, r());
    const weight = i === 0 ? 0.35 : mix(0.84, 1.23, r());
    const grammar = i === 2 ? 2 : Math.floor(r() * 4);
    const phase = r() * TAU;
    const rhythm = Math.floor(r() * 4);
    domains.push({ id: i, cx, cy, angle, ax, ay, weight, phase, grammar,
      pen: PENS[i % PENS.length], secondary: PENS[(i + 2) % PENS.length], rhythm });
  }
  const corridor = { y: mix(118, 177, global()), slope: mix(-0.19, 0.19, global()),
    amplitude: mix(7, 19, global()), phase: global() * TAU };
  const windows = Array.from({ length: 2 + Math.floor(global() * 2) }, (_, i) => {
    const r = ctx.random(`field-window-${i}`);
    return { x: mix(55, 365, r()), y: mix(43, 254, r()), rx: mix(9, 21, r()),
      ry: mix(6, 13, r()), angle: r() * TAU };
  });
  return { domains, corridor, windows };
}

function toLocal(d: Domain, x: number, y: number): Point {
  const dx = x - d.cx, dy = y - d.cy;
  const c = Math.cos(d.angle), s = Math.sin(d.angle);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

function toPage(d: Domain, u: number, v: number): Point {
  const c = Math.cos(d.angle), s = Math.sin(d.angle);
  return { x: d.cx + u * c - v * s, y: d.cy + u * s + v * c };
}

function domainAt(layout: Layout, x: number, y: number): number {
  let best = Infinity, id = -1;
  const wx = x + 9 * Math.sin(y / 47 + x / 92);
  const wy = y + 8 * Math.sin(x / 58 - y / 81);
  for (const d of layout.domains) {
    const p = toLocal(d, wx, wy);
    const base = (p.x / d.ax) ** 2 + (p.y / d.ay) ** 2;
    const scallop = 1 + 0.16 * Math.sin(p.x / 36 + d.phase) * Math.cos(p.y / 42 - d.phase);
    const score = d.weight * base * scallop;
    if (score < best) { best = score; id = d.id; }
  }
  return id;
}

function inside(layout: Layout, x: number, y: number, corridorWidth: number): boolean {
  if (x < M || x > W - M || y < M || y > H - M) return false;
  const c = layout.corridor;
  const faultY = c.y + c.slope * (x - W / 2)
    + c.amplitude * Math.sin(x / 68 + c.phase) + 3.5 * Math.sin(x / 22 + c.phase * 0.7);
  if (Math.abs(y - faultY) < corridorWidth * (0.5 + 0.12 * Math.sin(x / 47 + c.phase))) return false;
  for (const window of layout.windows) {
    const dx = x - window.x, dy = y - window.y;
    const c0 = Math.cos(window.angle), s0 = Math.sin(window.angle);
    const u = dx * c0 + dy * s0, v = -dx * s0 + dy * c0;
    if ((u / window.rx) ** 2 + (v / window.ry) ** 2 < 1) return false;
  }
  return true;
}

function contourPoint(d: Domain, u: number, lane: number, turbulence: number): Point {
  const v = lane;
  const a = (5 + 14 * turbulence) * Math.sin(u / 56 + d.phase);
  const b = (2 + 5 * turbulence) * Math.sin(u / 25 + d.phase * 0.63);
  let vv: number;
  switch (d.grammar) {
    case 0: vv = v + a + b; break;
    case 1: vv = v * (1 + (u / 220) * (0.17 + 0.28 * turbulence)) + a * 0.65 + b; break;
    case 2: vv = v + (u * u / 3900) * (turbulence + 0.25) * Math.sin(d.phase) + a * 0.5; break;
    default: vv = v + a * Math.exp(-((u / 155) ** 2)) + b * 1.3; break;
  }
  return toPage(d, u + (2 + 4 * turbulence) * Math.sin(v / 31 + u / 96 + d.phase), vv);
}

function annularPoint(d: Domain, angle: number, radius: number, turbulence: number): Point {
  const ripple = (2 + 5 * turbulence) * Math.sin(angle * 3 + d.phase)
    + (1 + 3 * turbulence) * Math.sin(angle * 7 - d.phase * 0.5);
  const r = radius + ripple;
  const u = r * Math.cos(angle) * 1.22;
  const v = r * Math.sin(angle) * 0.86 + (r / 130) * 8 * Math.sin(angle + d.phase);
  return toPage(d, u, v);
}

function weavePoint(d: Domain, u: number, v: number, turbulence: number): Point {
  const curvedU = u + (4 + 8 * turbulence) * Math.sin(v / 53 + d.phase)
    + 2 * Math.sin(v / 21 + u / 39);
  return contourPoint(d, curvedU, v, turbulence * 0.62);
}

/** Split at every sampled exclusion. Densification prevents a long segment bridging thin folds. */
function collectPath(source: Point[], keep: (p: Point) => boolean, output: Point[][]): void {
  let segment: Point[] = [];
  const flush = () => {
    if (segment.length >= 2) {
      let length = 0;
      for (let j = 1; j < segment.length; j++) length += Math.hypot(segment[j].x - segment[j - 1].x, segment[j].y - segment[j - 1].y);
      if (length >= 0.35) output.push(segment);
    }
    segment = [];
  };
  for (let i = 0; i < source.length; i++) {
    const a = source[i];
    const b = source[i + 1];
    if (a.x < -500 || b?.x < -500) { flush(); continue; }
    const steps = b ? Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.6)) : 1;
    for (let k = 0; k < steps; k++) {
      const p = b ? { x: mix(a.x, b.x, k / steps), y: mix(a.y, b.y, k / steps) } : a;
      if (keep(p)) segment.push(p); else flush();
    }
  }
  const last = source[source.length - 1];
  if (last && last.x > -500 && keep(last)) segment.push(last);
  flush();
}

export function drawFields(ctx: SketchContext, occludes: (x: number, y: number) => boolean): Part[] {
  const layout = makeLayout(ctx);
  const pitch = value(ctx, 'contourPitch');
  const weavePitch = value(ctx, 'weavePitch');
  const turbulence = value(ctx, 'fieldTurbulence');
  const breakup = value(ctx, 'breakup');
  const links = value(ctx, 'linkChance');
  const corridorWidth = value(ctx, 'corridorWidth');
  const focusX = value(ctx, 'fieldFocusX') * W;
  const focusY = value(ctx, 'fieldFocusY') * H;
  const focused = (x: number, y: number) => {
    const distance = Math.hypot((x - focusX) / 185, (y - focusY) / 140);
    return clamp(1.1 - 0.28 * distance, 0.68, 1.06);
  };
  const parts: Part[] = [];
  for (const d of layout.domains) {
    const contour: Point[][] = [];
    const weave: Point[][] = [];
    const bridges: Point[][] = [];
    const domainKeep = (p: Point) => domainAt(layout, p.x, p.y) === d.id
      && inside(layout, p.x, p.y, corridorWidth) && !occludes(p.x, p.y);
    // The lane lattice is fixed. Pitch changes select a subset without moving domains or rest windows.
    for (let laneIndex = -72; laneIndex <= 72; laneIndex++) {
      if (d.grammar === 2 && laneIndex < 0) continue;
      const v = laneIndex * 1.55;
      const retain = clamp(1.55 / pitch * (d.id === 0 ? 1.08 : 0.95), 0.32, 1);
      if (hash(ctx.seed, d.id * 1000 + laneIndex, 1) > retain) continue;
      const bundled = hash(ctx.seed, d.id * 1000 + laneIndex, 41) < (d.id === 0 ? 0.58 : 0.37);
      const offsets = bundled ? (d.id === 0 ? [-0.6, -0.2, 0.2, 0.6] : [-0.55, 0, 0.55]) : [0];
      for (const offset of offsets) {
        const source: Point[] = [];
        const annular = d.grammar === 2;
        const first = annular ? 0 : -245;
        const last = annular ? TAU : 245;
        const increment = annular ? 0.028 : 1.8;
        for (let u = first; u <= last; u += increment) {
          const p = annular ? annularPoint(d, u, 10 + laneIndex * 2.15 + offset, turbulence)
            : contourPoint(d, u, v + offset, turbulence);
          // A measured repeated rest rhythm makes packets, rather than full-bleed parallel hair.
          const beat = annular ? Math.floor((u / TAU) * (17 + d.rhythm * 3))
            : Math.floor((u + 245 + d.rhythm * 7) / (19 + d.rhythm * 5));
          const rest = hash(ctx.seed + d.id, laneIndex, beat) < breakup * 0.36
            || (beat + d.rhythm) % (7 + d.grammar) === 0;
          source.push(rest ? { x: -1000, y: -1000 } : p);
        }
        const keep = (p: Point) => p.x > -500 && focused(p.x, p.y) > hash(ctx.seed, laneIndex, d.id + 131)
          && domainKeep(p);
        collectPath(source, keep, contour);
      }
    }
    for (let column = -55; column <= 55; column++) {
      const u = column * 4.35;
      const retain = clamp(4.35 / weavePitch * (d.id === 0 ? 0.8 : 0.67), 0.18, 0.9)
        * (d.grammar === 2 ? 0.32 : 1);
      if (hash(ctx.seed, d.id * 1000 + column, 2) > retain) continue;
      const source: Point[] = [];
      for (let v = -145; v <= 145; v += 1.8) {
        const p = weavePoint(d, u, v, turbulence);
        const beat = Math.floor((v + 145 + d.rhythm * 11) / 23);
        const active = modulo(beat + column + d.rhythm, 5) <= (d.grammar === 1 ? 2 : 1)
          && hash(ctx.seed + d.id, column, beat) > breakup * 0.3;
        source.push(active ? p : { x: -1000, y: -1000 });
      }
      collectPath(source, domainKeep, weave);
    }
    // Local rungs link nearby contour lanes; their pattern has its own stream.
    for (let column = -37; column <= 37; column++) {
      const u = column * 6.5 + 2.5;
      for (let lane = -38; lane <= 38; lane += 2) {
        if (hash(ctx.seed + d.id, column, lane + 500) > links * (d.id === 0 ? 0.9 : 0.65)) continue;
        const a = contourPoint(d, u, lane * 1.55, turbulence);
        const b = contourPoint(d, u + 1.3, (lane + 1.7) * 1.55, turbulence);
        collectPath([a, b], domainKeep, bridges);
      }
    }
    parts.push({ id: `domain-${d.id}-contours`, pen: d.pen, paths: contour });
    parts.push({ id: `domain-${d.id}-weave`, pen: d.secondary, paths: weave });
    parts.push({ id: `domain-${d.id}-links`, pen: d.pen, paths: bridges });
  }
  return parts;
}
