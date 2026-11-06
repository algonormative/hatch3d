import type { Point } from '../../src/sketch/types.ts';
import { mulberry32 } from '../../packages/plot-core/src/prng.ts';
import { measureStrokeText, strokeText } from '../../src/sketch/stroke-text.ts';
import { valueNoise } from './field.ts';
import { Router } from './route.ts';

/**
 * The board: everything the figure is not. Rigid where the figure is fluid: a grid, right angles, 45-degree bends,
 * parts placed by an occupancy map so none overlap. A keep-out holds clear paper around the figure; only the buses
 * cross it, and they end at the robe or the halo. Chip bodies are left as bare paper, the board's dark masses.
 */

export type ChipLayout = 'opposed' | 'flanking' | 'ascending' | 'swarm' | 'crown' | 'none';
export type BusTarget = 'robe' | 'halo' | 'both' | 'none';

export interface BoardOptions {
  page: { width: number; height: number; margin: number };
  cx: number;
  /** Page points the parts may not use: the figure and halo, grown by their clearance. */
  keepOut: (x: number, y: number) => boolean;
  /** Page points nothing may enter, traces included. */
  solid: (x: number, y: number) => boolean;
  robe: (x: number, y: number) => boolean;
  haloEdge: (x: number, y: number) => boolean;
  /** A point to steer buses towards, on each kind of target. */
  robeTowards: (from: Point) => Point;
  haloTowards: (from: Point) => Point;
  chips: ChipLayout; chipSize: number; chipDrift: number; chipText: string; mirror: boolean; symmetric: boolean;
  bus: BusTarget; busWidth: number; liveNets: number;
  density: number; cluster: number; passives: number; skylines: number; power: number; vias: number; viaRadius: number; padPitch: number; routes: number;
  boardSeed: number;
}

const PITCH = 1.27;
const CELL = 0.5;

interface Port { p: Point; heading: number }
interface Chip { cx: number; cy: number; reach: number; ports: Record<'right' | 'left' | 'top' | 'bottom', Port[]> }

export function board(o: BoardOptions): { lines: Point[][]; traces: Point[][]; live: Point[][] } {
  const { page } = o;
  const R = mulberry32(o.boardSeed * 6151 + 3);
  const w = Math.ceil(page.width / CELL), h = Math.ceil(page.height / CELL);
  const used = new Uint8Array(w * h);
  const noise = valueNoise(o.boardSeed + 41), fine = valueNoise(o.boardSeed + 43);
  const half = o.symmetric ? o.cx - 0.8 : Infinity;
  const m = page.margin;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = (i + 0.5) * CELL, y = (j + 0.5) * CELL;
    if (x < m || y < m || x > page.width - m || y > page.height - m || x > half || o.keepOut(x, y)) used[j * w + i] = 1;
  }
  const router = new Router(PITCH, page.width, page.height, (x, y) => x < m + 1 || y < m + 1 || x > page.width - m - 1 || y > page.height - m - 1 || x > half || o.solid(x, y));
  const cellRange = (x0: number, y0: number, x1: number, y1: number) => [Math.max(0, Math.floor(x0 / CELL)), Math.max(0, Math.floor(y0 / CELL)), Math.min(w - 1, Math.ceil(x1 / CELL)), Math.min(h - 1, Math.ceil(y1 / CELL))];
  const free = (x0: number, y0: number, x1: number, y1: number) => {
    if (x0 < 0 || y0 < 0 || x1 > page.width || y1 > page.height) return false;
    const [a, b, c, d] = cellRange(x0, y0, x1, y1);
    for (let j = b; j <= d; j++) for (let i = a; i <= c; i++) if (used[j * w + i]) return false;
    return true;
  };
  const take = (x0: number, y0: number, x1: number, y1: number, blockRoutes = true) => {
    const [a, b, c, d] = cellRange(x0, y0, x1, y1);
    for (let j = b; j <= d; j++) for (let i = a; i <= c; i++) used[j * w + i] = 1;
    if (blockRoutes) router.block(x0, y0, x1, y1);
  };
  const snap = (v: number) => Math.round(v / PITCH) * PITCH;
  const lines: Point[][] = [], traces: Point[][] = [], live: Point[][] = [];

  const rect = (x0: number, y0: number, x1: number, y1: number) => lines.push([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }]);
  /** A pad as a boustrophedon at the pad pitch: at the fuse pitch or under it reads solid, wider stays open and spares the pen. */
  const solid = (x0: number, y0: number, x1: number, y1: number) => {
    const inset = 0.2, line: Point[] = [], p = o.padPitch;
    if (x1 - x0 < 0.5 || y1 - y0 < 0.5) { lines.push([{ x: x0, y: (y0 + y1) / 2 }, { x: x1, y: (y0 + y1) / 2 }]); return; }
    const rows = Math.max(1, Math.floor((y1 - y0 - 2 * inset) / p + 1e-6) + 1);
    for (let i = 0; i < rows; i++) {
      const y = (y0 + y1) / 2 + (i - (rows - 1) / 2) * p;
      const a = { x: x0 + inset, y }, b = { x: x1 - inset, y };
      line.push(...(i % 2 ? [b, a] : [a, b]));
    }
    lines.push(line);
  };
  const ring = (x: number, y: number, r: number, n = 12) => {
    const l: Point[] = [];
    for (let i = 0; i <= n; i++) l.push({ x: x + r * Math.cos(i / n * 2 * Math.PI), y: y + r * Math.sin(i / n * 2 * Math.PI) });
    lines.push(l);
  };
  const resistor = (x: number, y: number, vertical: boolean, l: number, t: number) => {
    const cap = l * 0.26;
    // Open pads have no room for a fill inside the outline: a band across each end instead, clear of the end and joining the sides.
    const bands = o.padPitch > 0.55 ? [-1, 1].map(end => end * (l / 2 - Math.max(cap, 0.8))) : [];
    if (vertical) {
      rect(x - t / 2, y - l / 2, x + t / 2, y + l / 2);
      if (bands.length) for (const d of bands) lines.push([{ x: x - t / 2, y: y + d }, { x: x + t / 2, y: y + d }]);
      else { solid(x - t / 2, y - l / 2, x + t / 2, y - l / 2 + cap); solid(x - t / 2, y + l / 2 - cap, x + t / 2, y + l / 2); }
    } else {
      rect(x - l / 2, y - t / 2, x + l / 2, y + t / 2);
      if (bands.length) for (const d of bands) lines.push([{ x: x + d, y: y - t / 2 }, { x: x + d, y: y + t / 2 }]);
      else { solid(x - l / 2, y - t / 2, x - l / 2 + cap, y + t / 2); solid(x + l / 2 - cap, y - t / 2, x + l / 2, y + t / 2); }
    }
  };
  const inductor = (x: number, y: number, s: number) => {
    const c = s * 0.16, a = s / 2;
    lines.push([{ x: x - a + c, y: y - a }, { x: x + a - c, y: y - a }, { x: x + a, y: y - a + c }, { x: x + a, y: y + a - c }, { x: x + a - c, y: y + a }, { x: x - a + c, y: y + a }, { x: x - a, y: y + a - c }, { x: x - a, y: y - a + c }, { x: x - a + c, y: y - a }]);
    ring(x, y, a * 0.72, 28);
    ring(x, y, a * 0.72 - 0.9, 28);
    solid(x - a * 0.5, y - a - 1.4, x + a * 0.5, y - a - 0.3);
    solid(x - a * 0.5, y + a + 0.3, x + a * 0.5, y + a + 1.4);
  };
  const can = (x: number, y: number, r: number) => {
    const a = r + 1.2, c = 2.2;
    lines.push([{ x: x - a + c, y: y - a }, { x: x + a, y: y - a }, { x: x + a, y: y + a }, { x: x - a + c, y: y + a }, { x: x - a, y: y + a - c }, { x: x - a, y: y - a + c }, { x: x - a + c, y: y - a }]);
    ring(x, y, r, 32);
    lines.push([{ x: x - r * 0.7, y }, { x: x + r * 0.7, y }]);
    lines.push([{ x, y: y - r * 0.7 }, { x, y: y + r * 0.7 }]);
  };
  const sot = (x: number, y: number) => {
    rect(x - 2.4, y - 1.5, x + 2.4, y + 1.5);
    for (const d of [-1.6, 1.6]) lines.push([{ x: x + d, y: y + 1.5 }, { x: x + d, y: y + 3 }]);
    lines.push([{ x, y: y - 1.5 }, { x, y: y - 3 }]);
  };
  const crystal = (x: number, y: number) => {
    rect(x - 7, y - 2.8, x + 7, y + 2.8);
    rect(x - 5.8, y - 1.6, x + 5.8, y + 1.6);
    for (const d of [-8.5, 7.1]) solid(x + d, y - 1.1, x + d + 1.4, y + 1.1);
  };
  const via = (x: number, y: number) => ring(x, y, o.viaRadius, 14);

  /** A quad flat pack; the body is bare paper. Its ports are the leads' tips, on the routing grid. */
  const qfp = (cx: number, cy: number, s: number): Chip => {
    const a = s / 2, lead = 5, n = Math.floor((s - 8) / PITCH / 2) * 2 + 1;
    const ports: Chip['ports'] = { right: [], left: [], top: [], bottom: [] };
    const c = 3.2;
    lines.push([{ x: cx - a + c, y: cy - a }, { x: cx + a, y: cy - a }, { x: cx + a, y: cy + a }, { x: cx - a, y: cy + a }, { x: cx - a, y: cy - a + c }, { x: cx - a + c, y: cy - a }]);
    ring(cx - a + 7, cy - a + 7, 1.4, 20);
    for (let i = 0; i < n; i++) {
      const d = (i - (n - 1) / 2) * PITCH;
      lines.push([{ x: cx + a, y: cy + d }, { x: cx + a + lead, y: cy + d }], [{ x: cx - a, y: cy + d }, { x: cx - a - lead, y: cy + d }], [{ x: cx + d, y: cy - a }, { x: cx + d, y: cy - a - lead }], [{ x: cx + d, y: cy + a }, { x: cx + d, y: cy + a + lead }]);
      ports.right.push({ p: { x: cx + a + lead, y: cy + d }, heading: 0 });
      ports.left.push({ p: { x: cx - a - lead, y: cy + d }, heading: 4 });
      ports.top.push({ p: { x: cx + d, y: cy - a - lead }, heading: 6 });
      ports.bottom.push({ p: { x: cx + d, y: cy + a + lead }, heading: 2 });
    }
    take(cx - a - lead - 0.4, cy - a - lead - 0.4, cx + a + lead + 0.4, cy + a + lead + 0.4);
    return { cx, cy, reach: a + lead, ports };
  };
  const bga = (cx: number, cy: number, s: number): Chip => {
    const p = 2.54, n = Math.floor((s - 6) / p / 2) * 2 + 1, a = (n - 1) * p / 2 + 3;
    rect(cx - a, cy - a, cx + a, cy + a);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      if (Math.abs(i - (n - 1) / 2) < n * 0.14 && Math.abs(j - (n - 1) / 2) < n * 0.14) continue;
      ring(cx + (i - (n - 1) / 2) * p, cy + (j - (n - 1) / 2) * p, 0.6, 8);
    }
    const ports: Chip['ports'] = { right: [], left: [], top: [], bottom: [] };
    for (let i = 0; i < n; i++) {
      const d = (i - (n - 1) / 2) * p;
      ports.right.push({ p: { x: cx + a, y: cy + d }, heading: 0 });
      ports.left.push({ p: { x: cx - a, y: cy + d }, heading: 4 });
      ports.top.push({ p: { x: cx + d, y: cy - a }, heading: 6 });
      ports.bottom.push({ p: { x: cx + d, y: cy + a }, heading: 2 });
    }
    take(cx - a - 0.4, cy - a - 0.4, cx + a + 0.4, cy + a + 0.4);
    return { cx, cy, reach: a, ports };
  };
  /** The nearest clear place to a wished-for one, shrinking only if nothing is near. */
  const place = (fx: number, fy: number, s: number, make: (x: number, y: number, s: number) => Chip): Chip | null => {
    // The seed moves each chip: the layout says roughly where, the seed says exactly.
    const jx = fx + (R() - 0.5) * 0.09 * o.chipDrift, jy = fy + (R() - 0.5) * 0.16 * o.chipDrift;
    const X = o.mirror ? page.width - jx * page.width : jx * page.width, Y = jy * page.height;
    for (let size = s; size >= s * 0.5; size *= 0.85) {
      const r = size / 2 + 6;
      for (let d = 0; d < 110; d += 2.54) for (let a = 0; a < 16; a++) {
        const x = snap(X + d * Math.cos(a / 8 * Math.PI)), y = snap(Y + d * Math.sin(a / 8 * Math.PI));
        if (free(x - r - 1, y - r - 1, x + r + 1, y + r + 1)) return make(x, y, size);
      }
    }
    return null;
  };
  const chips: (Chip | null)[] = [];
  const S = o.chipSize;
  switch (o.chips) {
    case 'opposed': chips.push(place(0.135, 0.26, 70 * S, qfp), place(0.865, 0.72, 44 * S, bga)); break;
    case 'flanking': chips.push(place(0.13, 0.3, 58 * S, qfp), place(0.87, 0.3, 58 * S, qfp)); break;
    case 'ascending': chips.push(place(0.11, 0.8, 58 * S, qfp), place(0.11, 0.42, 38 * S, bga), place(0.13, 0.14, 24 * S, qfp)); break;
    case 'crown': chips.push(place(0.27, 0.13, 34 * S, bga), place(0.73, 0.13, 34 * S, bga), place(0.08, 0.5, 40 * S, qfp), place(0.92, 0.5, 40 * S, qfp)); break;
    case 'swarm':
      for (let i = 0; i < 9; i++) chips.push(place(R(), R(), (14 + R() * 22) * S, R() < 0.6 ? qfp : bga));
      break;
    default:
  }

  const biggest = chips.reduce<Chip | null>((a, c) => (c && (!a || c.reach > a.reach) ? c : a), null);
  if (biggest && o.chipText) {
    const style = { face: 'sans', height: 3.2 } as const;
    const width = measureStrokeText(o.chipText, style);
    if (width < biggest.reach * 1.5) lines.push(...strokeText(o.chipText, biggest.cx - width / 2, biggest.cy + 1.6, style));
  }

  // ── Buses: the traces that cross the keep-out. A chip feeds the target from the side facing it. ──
  const ends: Point[] = [];
  const drawTrace = (path: Point[], from: Point, into: Point[][]) => {
    const line = [from, ...path];
    into.push(line);
    const end = line[line.length - 1];
    // Traces landing side by side share one via in a few: rings at the grid's pitch would run together.
    if (!ends.some(e => Math.hypot(e.x - end.x, e.y - end.y) < 2.2 * o.viaRadius + 1.4)) { via(end.x, end.y); ends.push(end); }
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], l = Math.hypot(b.x - a.x, b.y - a.y);
      for (let t = 0; t <= l; t += 0.5) { const q = t / (l || 1), x = a.x + (b.x - a.x) * q, y = a.y + (b.y - a.y) * q; take(x - 0.7, y - 0.7, x + 0.7, y + 0.7, false); }
    }
  };
  /** The first free grid point straight out of a port. */
  const clearOf = (port: Port, chip: Chip): Point => {
    const { p } = port;
    const dx = [1, 0, -1, 0][port.heading / 2], dy = [0, 1, 0, -1][port.heading / 2];
    if (dx) { const x = dx > 0 ? Math.ceil((chip.cx + chip.reach + 0.8) / PITCH) * PITCH : Math.floor((chip.cx - chip.reach - 0.8) / PITCH) * PITCH; return { x, y: snap(p.y) }; }
    const y = dy > 0 ? Math.ceil((chip.cy + chip.reach + 0.8) / PITCH) * PITCH : Math.floor((chip.cy - chip.reach - 0.8) / PITCH) * PITCH;
    return { x: snap(p.x), y };
  };
  let liveLeft = o.liveNets;
  if (o.bus !== 'none') {
    let flip = 0;
    for (const chip of chips) {
      if (!chip) continue;
      const toHalo = o.bus === 'halo' || (o.bus === 'both' && flip++ % 2 === 1);
      const reached = toHalo ? o.haloEdge : o.robe;
      const goal = (p: Point) => reached(p.x, p.y);
      const target = (toHalo ? o.haloTowards : o.robeTowards)({ x: chip.cx, y: chip.cy });
      const dx = target.x - chip.cx, dy = target.y - chip.cy;
      const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
      const ports = chip.ports[side];
      const count = Math.min(Math.round(o.busWidth), Math.floor(ports.length / 2));
      const step = Math.max(1, Math.round(2.54 / (Math.hypot((ports[1]?.p.x ?? 0) - ports[0].p.x, (ports[1]?.p.y ?? 0) - ports[0].p.y) || 2.54)));
      const mid = (ports.length - 1) / 2;
      const chosen: Port[] = [];
      for (let k = 0; k < count; k++) { const i = Math.round(mid + (k - (count - 1) / 2) * step); if (ports[i]) chosen.push(ports[i]); }
      chosen.sort((a, b) => Math.hypot(a.p.x - target.x, a.p.y - target.y) - Math.hypot(b.p.x - target.x, b.p.y - target.y));
      for (const port of chosen) {
        const start = clearOf(port, chip);
        const path = router.route(start, port.heading, goal, target, 40000);
        if (!path) continue;
        drawTrace(path, port.p, liveLeft > 0 && R() < 0.35 ? (liveLeft--, live) : traces);
      }
    }
  }

  // ── Fan-outs and free routes: the board's own business, which never reaches the figure. ──
  for (const chip of chips) {
    if (!chip) continue;
    for (const side of ['right', 'left', 'top', 'bottom'] as const) chip.ports[side].forEach((port, i) => {
      if (i % 3 || R() > 0.75) return;
      const dx = [1, 0, -1, 0][port.heading / 2], dy = [0, 1, 0, -1][port.heading / 2];
      const l = 2.5 + (i % 9) * 1.3 + R() * 2;
      const x = port.p.x + dx * l, y = port.p.y + dy * l;
      if (!free(Math.min(port.p.x + dx * 0.8, x) - 0.6, Math.min(port.p.y + dy * 0.8, y) - 0.6, Math.max(port.p.x + dx * 0.8, x) + 0.6, Math.max(port.p.y + dy * 0.8, y) + 0.6)) return;
      traces.push([port.p, { x, y }]);
      via(x, y);
      take(Math.min(port.p.x, x) - 0.5, Math.min(port.p.y, y) - 0.5, Math.max(port.p.x, x) + 0.5, Math.max(port.p.y, y) + 0.5);
    });
  }
  for (let n = 0; n < o.routes; n++) {
    const x = snap(R() * page.width), y = snap(R() * page.height);
    if (!free(x - 2, y - 2, x + 2, y + 2)) continue;
    const a = R() * 2 * Math.PI, far = 25 + R() * 70;
    const to = { x: snap(x + Math.cos(a) * far), y: snap(y + Math.sin(a) * far) };
    if (to.x < m || to.y < m || to.x > page.width - m || to.y > page.height - m || !free(to.x - 2, to.y - 2, to.x + 2, to.y + 2)) continue;
    const heading = Math.floor(R() * 4) * 2;
    const width = 1 + Math.floor(R() * R() * 7);
    const vertical = Math.abs(to.y - y) > Math.abs(to.x - x);
    for (let k = 0; k < width; k++) {
      const ox = vertical ? k * PITCH * 2 : 0, oy = vertical ? 0 : k * PITCH * 2;
      const s = { x: x + ox, y: y + oy }, t = { x: to.x + ox, y: to.y + oy };
      if (!free(s.x - 1, s.y - 1, s.x + 1, s.y + 1) || !free(t.x - 1, t.y - 1, t.x + 1, t.y + 1)) continue;
      const path = router.route(s, heading, p => Math.abs(p.x - t.x) < 0.1 && Math.abs(p.y - t.y) < 0.1, t, 6000, 4);
      if (!path) continue;
      // A free route keeps to open board: refuse any leg through the keep-out.
      const line = [...path];
      let ok = true;
      for (let i = 1; i < line.length && ok; i++) {
        const A = line[i - 1], B = line[i], L = Math.hypot(B.x - A.x, B.y - A.y);
        for (let q = 0; q <= L; q += 1) { const X = A.x + (B.x - A.x) * q / (L || 1), Y = A.y + (B.y - A.y) * q / (L || 1); if (o.keepOut(X, Y)) { ok = false; break; } }
      }
      if (!ok) continue;
      via(line[0].x, line[0].y);
      drawTrace(line.slice(1), line[0], traces);
    }
  }

  // ── Fill: big to small, into whatever the map still allows, thinning where the slow noise says rest. ──
  const scale = o.cluster;
  const open = (x: number, y: number, bias: number) => noise(x / (46 * scale), y / (46 * scale)) * 0.75 + fine(x / 11, y / 11) * 0.25 > bias - 0.28 * o.density;
  const tries = (n: number, placeOne: (x: number, y: number) => void) => { for (let i = 0; i < Math.round(n); i++) placeOne(snap(R() * page.width), snap(R() * page.height)); };
  tries(70 * o.power, (x, y) => { const s = 9 + Math.floor(R() * 3) * 2.54; if (open(x, y, 0.72) && free(x - s / 2 - 2, y - s / 2 - 3, x + s / 2 + 2, y + s / 2 + 3)) { inductor(x, y, s); take(x - s / 2 - 2, y - s / 2 - 3, x + s / 2 + 2, y + s / 2 + 3); } });
  tries(40 * o.power, (x, y) => { const r = 4.5 + R() * 2.5; if (open(x, y, 0.78) && free(x - r - 3, y - r - 3, x + r + 3, y + r + 3)) { can(x, y, r); take(x - r - 3, y - r - 3, x + r + 3, y + r + 3); } });
  tries(40 * o.power, (x, y) => { if (open(x, y, 0.74) && free(x - 10, y - 4, x + 10, y + 4)) { crystal(x, y); take(x - 10, y - 4, x + 10, y + 4); } });
  // Skylines: columns of pads, the board's own architecture.
  tries(420 * o.skylines, (x0, y0) => {
    if (!open(x0, y0, 0.66)) return;
    const cols = 2 + Math.floor(R() * 7), rows = 3 + Math.floor(R() * 26), p = 2.54;
    const tall = y0 + rows * p;
    if (!free(x0 - 1, y0 - 1, x0 + cols * p, tall)) return;
    take(x0 - 1.4, y0 - 1.4, x0 + cols * p + 0.4, tall + 0.4);
    const cut = R() < 0.5;
    for (let c = 0; c < cols; c++) {
      const start = cut ? Math.floor(R() * rows * 0.35) : 0;
      for (let r = start; r < rows; r++) {
        if (R() < 0.04) continue;
        const px = x0 + c * p, py = y0 + r * p;
        solid(px, py, px + 1.5, py + 1.5);
      }
    }
  });
  tries(2600 * o.passives, (x, y) => {
    const v = R() < 0.5, l = 4 + Math.floor(R() * 3) * 1.27, t = 2 + Math.floor(R() * 2) * 0.6;
    const a = v ? t : l, b = v ? l : t;
    if (open(x, y, 0.56) && free(x - a / 2 - 0.9, y - b / 2 - 0.9, x + a / 2 + 0.9, y + b / 2 + 0.9)) { resistor(x, y, v, l, t); take(x - a / 2 - 0.9, y - b / 2 - 0.9, x + a / 2 + 0.9, y + b / 2 + 0.9); }
  });
  tries(500 * o.passives, (x, y) => { if (open(x, y, 0.6) && free(x - 3.2, y - 3.8, x + 3.2, y + 3.8)) { sot(x, y); take(x - 3.2, y - 3.8, x + 3.2, y + 3.8); } });
  tries(2400 * o.vias, (x, y) => { const r = o.viaRadius + 0.7; if (open(x, y, 0.52) && free(x - r, y - r, x + r, y + r)) { via(x, y); take(x - r, y - r, x + r, y + r); } });

  if (o.symmetric) {
    const flip = (l: Point[]) => l.map(p => ({ x: 2 * o.cx - p.x, y: p.y }));
    for (const set of [lines, traces, live]) { const n = set.length; for (let i = 0; i < n; i++) set.push(flip(set[i])); }
  }
  return { lines, traces, live };
}
