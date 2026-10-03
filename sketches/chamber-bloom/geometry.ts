import type { Part, Point, SketchContext } from '../../src/sketch/types.ts';

const TAU = Math.PI * 2;
const ART = { left: 18, right: 279, top: 76, bottom: 357 };
const RESTS = new Set([5, 6, 16, 17, 18, 29, 38, 39, 48, 49, 50, 51, 60]);
const RIM_RADII = [44.4, 45.1, 47.1, 47.8, 123.1, 123.8, 127.2, 127.9, 132.2, 132.9, 137.2, 137.9];
const EXTRA_RESTS = new Set([4, 7, 15, 19, 28, 30, 37, 40, 47, 52, 59, 61]);

type Terrace = { center: number; width: number; phase: number; dominant: boolean; left: Point[]; right: Point[]; polygon: Point[] };
type Layout = { cx: number; cy: number; lobes: number; chirality: number; phase: number; tilt: number; terraces: Terrace[]; rhythm: number };
const n = (ctx: SketchContext, id: string): number => ctx.params[id] as number;
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const mod = (v: number, m: number): number => ((v % m) + m) % m;

function length(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

function insideArt(p: Point): boolean {
  return p.x >= ART.left && p.x <= ART.right && p.y >= ART.top && p.y <= ART.bottom;
}

function inPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Split sampled strokes against the art aperture and the white terrace cutouts. */
export function collect(source: Point[], keep: (p: Point) => boolean, paths: Point[][]): void {
  let run: Point[] = [];
  const flush = () => {
    if (run.length > 1 && length(run) >= 0.5) {
      const reduced=run.filter((p,i)=>{
        if(i===0||i===run.length-1)return true;
        const a=run[i-1],b=run[i+1];
        return (p.x-a.x)*(b.x-p.x)+(p.y-a.y)*(b.y-p.y)<0
          || Math.abs((p.x-a.x)*(b.y-p.y)-(p.y-a.y)*(b.x-p.x))>1e-8;
      });
      paths.push(reduced);
    }
    run=[];
  };
  let previous: Point | undefined;
  for (const p of source) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { flush(); previous = undefined; continue; }
    if (!previous) { if (keep(p)) run.push(p); else flush(); }
    else {
      const steps = Math.max(1, Math.ceil(Math.hypot(p.x-previous.x,p.y-previous.y)/0.3));
      for (let j=1;j<=steps;j++) {
        const sample={x:previous.x+(p.x-previous.x)*j/steps,y:previous.y+(p.y-previous.y)*j/steps};
        if (keep(sample)) run.push(sample); else flush();
      }
    }
    previous=p;
  }
  flush();
}

function polar(layout: Layout, theta: number, radius: number): Point {
  const t = clamp((radius - 39) / 102, 0, 1);
  const petal = Math.sin(layout.lobes * theta + layout.phase + layout.chirality * t * 1.3);
  const scallop = 8.8 * petal + 2.6 * Math.sin((layout.lobes * 2) * theta - layout.phase * 0.6 - t * 2);
  const slow = (3 + 5 * t) * Math.sin((layout.lobes - 2) * theta - 0.4 + t * 0.8);
  const r = radius + scallop * (0.32 + t * 0.8) + slow;
  const x = r * Math.cos(theta) * (0.92 + 0.09 * Math.sin(theta - layout.phase));
  const y = r * Math.sin(theta) * 1.11;
  const c = Math.cos(layout.tilt), s = Math.sin(layout.tilt);
  return { x: layout.cx + x * c - y * s, y: layout.cy + x * s + y * c };
}

function terracePolygon(layout: Layout, center: number, width: number, phase: number, depth: number): Pick<Terrace, 'left' | 'right' | 'polygon'> {
  // Each slab has one straight local axis. Short station pairs create square
  // setbacks rather than following the scalloped shell's polar curvature.
  const origin = polar(layout, center, 56 + depth * 5);
  const far = polar(layout, center, 134);
  const distance = Math.hypot(far.x - origin.x, far.y - origin.y);
  const along = { x: (far.x - origin.x) / distance, y: (far.y - origin.y) / distance };
  const across = { x: -along.y, y: along.x };
  const stations = [0, 0.15, 0.158, 0.34, 0.348, 0.53, 0.538, 0.72, 0.728, 0.9, 0.908, 1];
  const profile = [0.78, 0.78, 1.17, 1.17, 0.91, 0.91, 1.29, 1.29, 0.94, 0.94, 1.08, 1.08];
  const stagger = Math.sin(phase) * 2.6;
  const left: Point[] = [], right: Point[] = [];
  for (let i = 0; i < stations.length; i++) {
    const travel = stations[i] * (distance + 16);
    const half = width * profile[i] * 0.5;
    const offset = stagger * (0.4 + stations[i] * 0.6);
    const middle = { x: origin.x + along.x * travel + across.x * offset, y: origin.y + along.y * travel + across.y * offset };
    left.push({ x: middle.x - across.x * half, y: middle.y - across.y * half });
    right.push({ x: middle.x + across.x * half, y: middle.y + across.y * half });
  }
  return { left, right, polygon: [...left, ...[...right].reverse()] };
}

function makeLayout(ctx: SketchContext): Layout {
  const place = ctx.random('chamber-placement');
  const anatomy = ctx.random('chamber-anatomy');
  const rhythm = ctx.random('chamber-rhythm');
  const layout: Layout = {
    cx: 132 + n(ctx, 'focusX') * 50 + (place() - 0.5) * 24,
    cy: 170 + n(ctx, 'focusY') * 48 + (place() - 0.5) * 25,
    lobes: clamp(Math.round(n(ctx, 'lobeCount') + (anatomy() - 0.5) * 2.1), 4, 9),
    chirality: anatomy() < 0.5 ? -1 : 1,
    phase: anatomy() * TAU,
    tilt: mix(-0.42, 0.2, anatomy()),
    terraces: [],
    rhythm: Math.floor(rhythm() * 64),
  };
  const count = Math.round(n(ctx, 'terraceCount'));
  const dominant = Math.floor(ctx.random('terrace-dominance')() * count);
  for (let i = 0; i < count; i++) {
    const r = ctx.random(`terrace-${i}`);
    const center = (i + 0.37 + (r() - 0.5) * 0.37) * TAU / count;
    const large = i === dominant;
    const width = (large ? 36 + r() * 7 : 18 + r() * 8) * n(ctx, 'terraceDepth');
    const phase = r() * TAU;
    layout.terraces.push({ center, width, phase, dominant: large, ...terracePolygon(layout, center, width, phase, n(ctx, 'terraceDepth')) });
  }
  return layout;
}

function shellPoint(layout: Layout, theta: number, radius: number, warp: number): Point {
  const p = polar(layout, theta, radius);
  const t = clamp((radius - 39) / 102, 0, 1);
  p.x += warp * (0.4 + t) * Math.sin(theta * 3 + radius / 29 + layout.phase) * 3.2;
  p.y += warp * (0.4 + t) * Math.cos(theta * 2 - radius / 35 + layout.phase) * 3.6;
  return p;
}

export function drawChamber(ctx: SketchContext): Part[] {
  const layout = makeLayout(ctx);
  const keep = (p: Point) => insideArt(p) && !layout.terraces.some(t => inPolygon(p, t.polygon));
  const rings: Record<string, Point[][]> = { carbon: [], ultramarine: [], vermilion: [], acid: [], violet: [] };
  const pitch = n(ctx, 'lamellaPitch');
  const warp = n(ctx, 'shellWarp');
  const gap = n(ctx, 'rhythmGap');
  const count = Math.floor((137 - 43) / pitch);
  for (let lane = 0; lane <= count; lane++) {
    const radius = 43 + lane * pitch;
    // Fixed rim engraving owns this band; avoid almost coincident regular contours.
    if (RIM_RADII.some(rim => Math.abs(rim - radius) < 0.4)) continue;
    const pen = lane % 9 === 0 ? 'carbon' : lane % 7 === 0 ? 'violet' : 'ultramarine';
    const source: Point[] = [];
    for (let j = 0; j <= 576; j++) {
      const theta = j / 576 * TAU;
      const step = Math.floor(j / 9);
      const group = mod(step + layout.rhythm + Math.floor(lane / 4) * 3, 64);
      const rest = lane % 4 === 2 && ((RESTS.has(group) && gap >= 0.2) || (EXTRA_RESTS.has(group) && gap >= 0.6));
      source.push(rest ? { x: NaN, y: NaN } : shellPoint(layout, theta, radius, warp));
    }
    collect(source, keep, rings[pen]);
    if (lane % 11 === 5 && !RIM_RADII.some(rim => Math.abs(rim - radius - 0.62) < 0.4)) {
      const echo: Point[] = [];
      for (let j = 0; j <= 576; j++) {
        const beat = mod(Math.floor(j / 9) + layout.rhythm, 64);
        const active = (beat >= 9 && beat <= 15) || (beat >= 27 && beat <= 32) || (beat >= 44 && beat <= 49);
        echo.push(active ? shellPoint(layout, j / 576 * TAU, radius + 0.62, warp) : { x: NaN, y: NaN });
      }
      collect(echo, keep, rings.carbon);
    }
  }

  // Close-set paired engraving gives the shell a dark edge without filling it.
  for (const radius of RIM_RADII) {
    const source: Point[] = [];
    for (let j = 0; j <= 576; j++) source.push(shellPoint(layout, j / 576 * TAU, radius, warp));
    collect(source, keep, rings.carbon);
  }

  // The 64-step lattice joins bands only in measured groups, leaving rests.
  const ribs = Math.round(n(ctx, 'filamentDensity'));
  for (let step = 0; step < 64; step++) {
    const beat = mod(step + layout.rhythm, 64);
    if (RESTS.has(beat) || step % 4 === 3 || step >= ribs) continue;
    const theta = (step + 0.5) / 64 * TAU + 0.06 * Math.sin(step * 0.7 + layout.phase);
    for (let band = 0; band < 7; band++) {
      if ((band + Math.floor(step / 8)) % 4 === 3) continue;
      const start = 53 + band * 11.7;
      const a = shellPoint(layout, theta, start, warp);
      const b = shellPoint(layout, theta + layout.chirality * 0.012, start + 8.8, warp);
      collect([a, b], keep, rings[step % 5 === 0 ? 'carbon' : 'acid']);
    }
  }

  // Unequal chromatic passages: a hot inner lip and sparse purple outer murmurs.
  const accents = ctx.random('chamber-accent-sectors');
  const accentPhase = accents() * TAU;
  for (let band = 0; band < 8; band++) {
    const radius = 49 + band * 3.0;
    for (let section = 0; section < 5; section++) {
      const center = accentPhase + section * TAU / 5 + 0.13 * Math.sin(band + section);
      const span = 0.32 + 0.14 * ((section + band) % 3);
      const source: Point[] = [];
      for (let j = 0; j <= 64; j++) source.push(shellPoint(layout, center - span / 2 + span * j / 64, radius, warp));
      collect(source, keep, rings.vermilion);
    }
  }
  for (let band = 0; band < 6; band++) {
    const radius = 109 + band * 3.1;
    for (let section = 0; section < 4; section++) {
      const center = accentPhase + 0.42 + section * TAU / 4;
      const source: Point[] = [];
      for (let j = 0; j <= 72; j++) source.push(shellPoint(layout, center - 0.19 + j * 0.38 / 72, radius, warp));
      collect(source, keep, rings.violet);
    }
  }

  const terraceLines: Point[][] = [];
  const sideface: Point[][] = [];
  const slits: Point[][] = [];
  const registration: Point[][] = [];
  for (const terrace of layout.terraces) {
    const polygon = [...terrace.polygon, terrace.polygon[0]];
    // Sample boundary edges so every point remains inside the page aperture.
    for (let i = 1; i < polygon.length; i++) {
      const a = polygon[i - 1], b = polygon[i];
      const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.65));
      const source = Array.from({ length: steps + 1 }, (_, j) => ({ x: mix(a.x, b.x, j / steps), y: mix(a.y, b.y, j / steps) }));
      collect(source, insideArt, terraceLines);
    }
    const section = (bay: number, radial: number, cross: number): Point => {
      const l = { x: mix(terrace.left[bay].x, terrace.left[bay + 1].x, radial), y: mix(terrace.left[bay].y, terrace.left[bay + 1].y, radial) };
      const r = { x: mix(terrace.right[bay].x, terrace.right[bay + 1].x, radial), y: mix(terrace.right[bay].y, terrace.right[bay + 1].y, radial) };
      return { x: mix(l.x, r.x, cross), y: mix(l.y, r.y, cross) };
    };
    const stroke = (a: Point, b: Point, output: Point[][]) => {
      const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.6));
      collect(Array.from({ length: steps + 1 }, (_, j) => ({ x: mix(a.x, b.x, j / steps), y: mix(a.y, b.y, j / steps) })), insideArt, output);
    };
    for (let bay = 0; bay < terrace.left.length - 1; bay++) {
      if (bay > 0) stroke(terrace.left[bay], terrace.right[bay], terraceLines);
      // Engraved concrete faces get denser on the dominant buttress. The
      // short station pairs are abrupt masonry setbacks, not hatch bays.
      const run = Math.hypot(terrace.left[bay + 1].x - terrace.left[bay].x, terrace.left[bay + 1].y - terrace.left[bay].y);
      if (run < 2) continue;
      const hatchCount = terrace.dominant ? 20 + (bay % 4) : 13 + (bay % 3);
      for (let h = 1; h < hatchCount; h++) {
        if (h % 11 === 7 || h % 11 === 8) continue;
        const v = h / hatchCount;
        stroke(section(bay, v, 0.045), section(bay, Math.min(0.98, v + 0.05), terrace.dominant ? 0.7 : 0.56), sideface);
      }
      if (bay === 1 || bay === 5 || bay === 9) {
        const slit = [section(bay, 0.24, 0.73), section(bay, 0.73, 0.73), section(bay, 0.73, 0.86), section(bay, 0.24, 0.86)];
        for (let k = 0; k < slit.length; k++) stroke(slit[k], slit[(k + 1) % slit.length], slits);
        stroke(section(bay, 0.19, 0.9), section(bay, 0.78, 0.9), registration);
      }
    }
  }
  return [
    { id: 'structural-lamellae', pen: 'carbon', paths: rings.carbon },
    { id: 'blue-shell', pen: 'ultramarine', paths: rings.ultramarine },
    { id: 'hot-inner-lip', pen: 'vermilion', paths: rings.vermilion },
    { id: 'reconstructed-ribs', pen: 'acid', paths: rings.acid },
    { id: 'violet-passages', pen: 'violet', paths: rings.violet },
    { id: 'stepped-terraces', pen: 'carbon', paths: terraceLines },
    { id: 'terrace-sidefaces', pen: 'carbon', paths: sideface },
    { id: 'terrace-slits', pen: 'carbon', paths: slits },
    { id: 'registration-offsets', pen: 'vermilion', paths: registration },
  ];
}
