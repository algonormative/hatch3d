import type { Point } from '../../src/sketch/types.ts';

/**
 * An octilinear router on the board's grid: A* over (node, heading), with a price on turning, so traces run straight,
 * bend at 45 degrees and queue up beside whatever was routed first. Diagonals may not cross.
 */

const DIRS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

export class Router {
  readonly nx: number; readonly ny: number;
  readonly blocked: Uint8Array;
  private readonly diagonal: Uint8Array;
  constructor(readonly pitch: number, width: number, height: number, solid: (x: number, y: number) => boolean) {
    this.nx = Math.floor(width / pitch) + 1; this.ny = Math.floor(height / pitch) + 1;
    this.blocked = new Uint8Array(this.nx * this.ny);
    this.diagonal = new Uint8Array(this.nx * this.ny);
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) if (solid(i * pitch, j * pitch)) this.blocked[j * this.nx + i] = 1;
  }
  node(p: Point): number { return Math.round(p.y / this.pitch) * this.nx + Math.round(p.x / this.pitch); }
  point(n: number): Point { const i = n % this.nx; return { x: i * this.pitch, y: (n - i) / this.nx * this.pitch }; }
  block(x0: number, y0: number, x1: number, y1: number): void {
    const a = Math.max(0, Math.floor(x0 / this.pitch)), c = Math.min(this.nx - 1, Math.ceil(x1 / this.pitch));
    const b = Math.max(0, Math.floor(y0 / this.pitch)), d = Math.min(this.ny - 1, Math.ceil(y1 / this.pitch));
    for (let j = b; j <= d; j++) for (let i = a; i <= c; i++) this.blocked[j * this.nx + i] = 1;
  }

  /** From `start`, heading `heading` (0-7), to the first node `goal` accepts. Null when none is reached within budget. */
  route(start: Point, heading: number, goal: (p: Point) => boolean, toward: Point, budget = 60000, turnCost = 3): Point[] | null {
    const { nx, ny, blocked, diagonal, pitch } = this;
    const s = this.node(start);
    if (s < 0 || s >= nx * ny) return null;
    const best = new Map<number, number>(), from = new Map<number, number>();
    const tx = toward.x / pitch, ty = toward.y / pitch;
    const h = (n: number) => {
      const i = n % nx, j = (n - i) / nx, dx = Math.abs(i - tx), dy = Math.abs(j - ty);
      return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * 1.2;
    };
    // A small binary heap of [f, state].
    const hf: number[] = [], hs: number[] = [];
    const push = (f: number, st: number) => {
      let i = hf.length;
      hf.push(f); hs.push(st);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hf[p] <= hf[i]) break;
        [hf[p], hf[i]] = [hf[i], hf[p]]; [hs[p], hs[i]] = [hs[i], hs[p]];
        i = p;
      }
    };
    const pop = () => {
      const st = hs[0], f = hf.pop()!, v = hs.pop()!;
      if (hf.length) {
        hf[0] = f; hs[0] = v;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < hf.length && hf[l] < hf[m]) m = l;
          if (r < hf.length && hf[r] < hf[m]) m = r;
          if (m === i) break;
          [hf[m], hf[i]] = [hf[i], hf[m]]; [hs[m], hs[i]] = [hs[i], hs[m]];
          i = m;
        }
      }
      return st;
    };
    const s0 = s * 8 + heading;
    best.set(s0, 0); push(h(s), s0);
    let found = -1;
    for (let spent = 0; hf.length && spent < budget; spent++) {
      const st = pop(), d = st & 7, n = (st - d) / 8, g0 = best.get(st)!;
      if (n !== s && goal(this.point(n))) { found = st; break; }
      const i = n % nx, j = (n - i) / nx;
      for (const turn of [0, 1, 7, 2, 6]) {
        const nd = (d + turn) & 7, [dx, dy] = DIRS[nd];
        const ni = i + dx, nj = j + dy;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const m = nj * nx + ni;
        if (blocked[m]) continue;
        if (dx && dy) {
          const cell = Math.min(j, nj) * nx + Math.min(i, ni);
          if (diagonal[cell]) continue;
        }
        const cost = g0 + (dx && dy ? Math.SQRT2 : 1) + (turn === 0 ? 0 : turn === 1 || turn === 7 ? turnCost : turnCost * 4);
        const ns = m * 8 + nd;
        if (cost < (best.get(ns) ?? Infinity)) { best.set(ns, cost); from.set(ns, st); push(cost + h(m), ns); }
      }
    }
    if (found < 0) return null;
    const states = [found];
    for (let c = found; from.has(c);) { c = from.get(c)!; states.push(c); }
    states.reverse();
    const nodes = states.map(v => (v - (v & 7)) / 8);
    for (let k = 0; k < nodes.length; k++) {
      blocked[nodes[k]] = 1;
      if (k) {
        const a = nodes[k - 1], b = nodes[k], ai = a % nx, aj = (a - ai) / nx, bi = b % nx, bj = (b - bi) / nx;
        if (ai !== bi && aj !== bj) diagonal[Math.min(aj, bj) * nx + Math.min(ai, bi)] = 1;
      }
    }
    // Keep only the corners.
    const out: Point[] = [this.point(nodes[0])];
    for (let k = 1; k < nodes.length - 1; k++) if ((states[k] & 7) !== (states[k + 1] & 7)) out.push(this.point(nodes[k]));
    if (nodes.length > 1) out.push(this.point(nodes[nodes.length - 1]));
    return out;
  }
}
