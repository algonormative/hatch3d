import type { Point } from '../../../src/sketch/types.ts';
import { traceMask } from '../../kit/outline.ts';
import { insideRing, keepAlong, pathLength } from '../../kit/page.ts';

/**
 * Patterns for a big shape of colour: open line work in black on the magenta, with shapes of its own rather than a flat
 * hatch. `pitch` is how far apart its lines run, `scale` the size of its figure (a scale, a zigzag, a fold), `angle` which
 * way it lies. All are drawn over the ring's box and clipped to it.
 */
export type PatternKind = 'contour' | 'pleats' | 'scales' | 'chevron' | 'moire' | 'field';
export const PATTERNS: Record<PatternKind, string> = {
  contour: 'Contours following the shape\'s edge',
  pleats: 'Pleats fanning from a fold',
  scales: 'Overlapping scales (seigaiha)',
  chevron: 'Chevrons',
  moire: 'Moiré of two line sets',
  field: 'Magnetic field lines between two poles',
};

interface Options { pitch: number; scale: number; angle: number; focus?: Point; poles?: [Point, Point] }

function frameOf(ring: Point[], angle: number) {
  const ux = Math.cos(angle), uy = Math.sin(angle), xs = ring.map(q => q.x), ys = ring.map(q => q.y);
  const c = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  const reach = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 + 2;
  return { c, reach, at: (u: number, v: number): Point => ({ x: c.x + ux * u - uy * v, y: c.y + uy * u + ux * v }) };
}
const box = (ring: Point[]) => { const xs = ring.map(q => q.x), ys = ring.map(q => q.y); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };

function chevron(ring: Point[], o: Options): Point[][] {
  const f = frameOf(ring, o.angle), out: Point[][] = [], per = o.scale, amp = o.scale * 0.42;
  const tri = (u: number) => { const t = ((u / per) % 1 + 1) % 1; return Math.abs(t * 2 - 1) * 2 - 1; };
  for (let v = -f.reach - amp; v < f.reach + amp; v += o.pitch * 1.5) {
    const line: Point[] = [];
    for (let u = -f.reach; u <= f.reach; u += per / 2) line.push(f.at(Math.round(u / (per / 2)) * (per / 2), v + amp * tri(Math.round(u / (per / 2)) * (per / 2))));
    out.push(line);
  }
  return out;
}

function moire(ring: Point[], o: Options): Point[][] {
  const out: Point[][] = [];
  for (const [turn, stretch, sway] of [[0, 1, 5], [0.085, 1.045, -5]] as const) {
    const f = frameOf(ring, o.angle + turn);
    for (let v = -f.reach; v < f.reach; v += o.pitch * stretch) {
      const line: Point[] = [];
      for (let u = -f.reach; u <= f.reach; u += 3) line.push(f.at(u, v + sway * Math.sin(u / (o.scale * 3))));
      out.push(line);
    }
  }
  return out;
}

function scales(ring: Point[], o: Options): Point[][] {
  // Rows of arcs, each row in front of the one above: an arc shows only where no scale of the next two rows covers it.
  const f = frameOf(ring, o.angle), r = o.scale, rowH = r * 0.5, out: Point[][] = [], rings = Math.max(2, Math.round(r / (o.pitch * 1.4)));
  const centre = (row: number, col: number) => ({ u: col * 2 * r + (row % 2 ? r : 0), v: row * rowH });
  const rows = Math.ceil(f.reach / rowH) + 3, cols = Math.ceil(f.reach / (2 * r)) + 2;
  for (let row = -rows; row <= rows; row++) for (let col = -cols; col <= cols; col++) {
    const c = centre(row, col);
    if (Math.abs(c.u) > f.reach + r || Math.abs(c.v) > f.reach + r) continue;
    const covered = (u: number, v: number) => {
      for (const dRow of [1, 2]) {
        const nCol = (u - (((row + dRow) % 2 + 2) % 2 ? r : 0)) / (2 * r), n = centre(row + dRow, Math.round(nCol));
        if (Math.hypot(u - n.u, v - n.v) < r - 1e-6) return true;
      }
      return false;
    };
    for (let k = rings; k >= 1; k--) {
      const rad = r * k / rings;
      let run: Point[] = [];
      const flush = () => { if (run.length >= 2) out.push(run); run = []; };
      for (let a = 0; a <= 36; a++) {
        const t = Math.PI + Math.PI * a / 36, u = c.u + rad * Math.cos(t), v = c.v + rad * Math.sin(t);
        if (covered(u, v)) flush(); else run.push(f.at(u, v));
      }
      flush();
    }
  }
  return out;
}

function pleats(ring: Point[], o: Options): Point[][] {
  const b = box(ring), focus = o.focus ?? { x: (b.x0 + b.x1) / 2, y: b.y0 - 8 }, out: Point[][] = [];
  const far = Math.max(...ring.map(q => Math.hypot(q.x - focus.x, q.y - focus.y))) + 2;
  const angles = ring.map(q => Math.atan2(q.y - focus.y, q.x - focus.x)), a0 = Math.min(...angles) - 0.1, a1 = Math.max(...angles) + 0.1;
  const step = o.pitch * 1.4 / far;
  let a = a0, i = 0;
  while (a < a1) {
    // Bowed as cloth falls, in groups of lines with a wider gap between folds.
    const bow = Math.sin(i * 0.31) * o.scale * 0.9, line: Point[] = [];
    for (let k = 0; k <= 30; k++) {
      const t = k / 30, r = far * t, side = bow * Math.sin(Math.PI * t);
      line.push({ x: focus.x + Math.cos(a) * r - Math.sin(a) * side, y: focus.y + Math.sin(a) * r + Math.cos(a) * side });
    }
    out.push(line);
    i++;
    a += i % 7 === 0 ? step * 3.6 : step;
  }
  return out;
}

/** The ring's distance field, cell by cell, for lines at set distances from its edge. */
function contour(ring: Point[], o: Options): Point[][] {
  const b = box(ring), cell = 0.5, nx = Math.ceil((b.x1 - b.x0) / cell) + 2, ny = Math.ceil((b.y1 - b.y0) / cell) + 2, d = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) d[j * nx + i] = insideRing(ring, { x: b.x0 + i * cell, y: b.y0 + j * cell }) ? 1e6 : 0;
  const relax = (k: number, o2: number, c: number) => { if (d[o2] + c < d[k]) d[k] = d[o2] + c; };
  for (let j = 1; j < ny; j++) for (let i = 1; i < nx - 1; i++) { const k = j * nx + i; relax(k, k - 1, 1); relax(k, k - nx, 1); relax(k, k - nx - 1, 1.414); relax(k, k - nx + 1, 1.414); }
  for (let j = ny - 2; j >= 0; j--) for (let i = nx - 2; i >= 1; i--) { const k = j * nx + i; relax(k, k + 1, 1); relax(k, k + nx, 1); relax(k, k + nx + 1, 1.414); relax(k, k + nx - 1, 1.414); }
  const at = (q: Point) => { const i = Math.round((q.x - b.x0) / cell), j = Math.round((q.y - b.y0) / cell); return i < 0 || j < 0 || i >= nx || j >= ny ? 0 : d[j * nx + i] * cell; };
  const out: Point[][] = [];
  for (let level = o.pitch * 1.6, n = 0; n < 60; level += o.pitch * 1.6, n++) {
    const rings = traceMask(q => at(q) > level, b, cell, { simplify: 0.12 });
    if (!rings.length) break;
    out.push(...rings.map(r => [...r, r[0]]));
  }
  return out;
}

function field(ring: Point[], o: Options): Point[][] {
  // Field lines of two poles: the level sets of cos a - cos b, the angles at the poles measured from the line between them.
  const f = frameOf(ring, o.angle), b = box(ring), span = o.scale * 2.4, [p, q] = o.poles ?? [f.at(-span, 0), f.at(span, 0)], dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy);
  const psi = (s: Point) => {
    const ax = s.x - p.x, ay = s.y - p.y, bx = s.x - q.x, by = s.y - q.y;
    return (ax * dx + ay * dy) / (len * (Math.hypot(ax, ay) || 1)) - (bx * dx + by * dy) / (len * (Math.hypot(bx, by) || 1));
  };
  const out: Point[][] = [], levels = Math.max(24, Math.min(64, Math.round(len / (o.pitch * 1.5))));
  // Each level is traced as an area; only its curved edge is a field line, not the box's edge or the line between the poles.
  const interior = (s: Point) => s.x > b.x0 + 0.6 && s.x < b.x1 - 0.6 && s.y > b.y0 + 0.6 && s.y < b.y1 - 0.6 && Math.abs((s.x - p.x) * dy - (s.y - p.y) * dx) / len > 0.9;
  for (let i = 1; i < levels; i++) {
    const level = 2 * i / levels * 0.98 + 0.01;
    // Above and below the line between the poles, each a line of its own.
    for (const side of [1, -1]) {
      const test = (s: Point) => psi(s) > level && ((s.x - p.x) * -dy + (s.y - p.y) * dx) * side > 0;
      for (const r of traceMask(test, b, 0.5, { simplify: 0.12 })) out.push(...keepAlong([...r, r[0]], interior, 0.3));
    }
  }
  // The lines stop short of each pole, which is a small ring of its own: where they would meet, no pen could keep them apart.
  const clear = o.scale * 0.42, off = (s: Point) => Math.hypot(s.x - p.x, s.y - p.y) > clear && Math.hypot(s.x - q.x, s.y - q.y) > clear;
  const kept = out.flatMap(line => keepAlong(line, off, 0.3));
  for (const pole of [p, q]) for (const rad of [clear, clear * 0.5]) kept.push(Array.from({ length: 41 }, (_, k) => ({ x: pole.x + rad * Math.cos(k / 40 * 2 * Math.PI), y: pole.y + rad * Math.sin(k / 40 * 2 * Math.PI) })));
  return kept;
}

/** The pattern's lines inside the ring, long enough to draw. */
export function patternIn(kind: PatternKind, ring: Point[], o: Options): Point[][] {
  const make = { chevron, moire, scales, pleats, contour, field }[kind];
  return make(ring, o).flatMap(line => keepAlong(line, q => insideRing(ring, q), 0.3)).filter(line => pathLength(line) >= 1.2);
}
