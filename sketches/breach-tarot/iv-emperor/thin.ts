import type { Point } from '../../../src/sketch/types.ts';

/**
 * Near-parallel neighbours thinned on the page, for a small card: the inverse of the density probe
 * (`kit/density.ts`). Paths are taken in order, and a stretch of one that would run beside a path already
 * kept, closer than `limit` and within `angle` degrees of parallel, is left out; the rest of it is kept, in
 * runs. A stretch counts as beside another only where it projects onto it, so a path that carries on from
 * where another ends, or crosses it, keeps its line. Order the paths by what should survive: an outline
 * before the planes inside it, and those before the cloth.
 *
 * Returns each path's kept runs, in its own order.
 */
export function thinParallel(paths: Point[][], limit: number, options: { angle?: number; step?: number } = {}): Point[][][] {
  const cos = Math.cos((options.angle ?? 12) * Math.PI / 180);
  const step = options.step ?? 0.2;
  type Seg = { ax: number; ay: number; bx: number; by: number; ux: number; uy: number; len: number };
  const grid = new Map<string, Seg[]>();
  const insert = (s: Seg) => {
    const x0 = Math.floor(Math.min(s.ax, s.bx) / limit), x1 = Math.floor(Math.max(s.ax, s.bx) / limit);
    const y0 = Math.floor(Math.min(s.ay, s.by) / limit), y1 = Math.floor(Math.max(s.ay, s.by) / limit);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const key = `${gx},${gy}`;
      const list = grid.get(key);
      if (list) list.push(s); else grid.set(key, [s]);
    }
  };
  const crowded = (mx: number, my: number, ux: number, uy: number) => {
    const cx = Math.floor(mx / limit), cy = Math.floor(my / limit);
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
      for (const s of grid.get(`${gx},${gy}`) ?? []) {
        if (Math.abs(ux * s.ux + uy * s.uy) < cos) continue;
        const t = ((mx - s.ax) * s.ux + (my - s.ay) * s.uy) / s.len;
        if (t < 0 || t > 1) continue;
        if (Math.abs((mx - s.ax) * s.uy - (my - s.ay) * s.ux) < limit) return true;
      }
    }
    return false;
  };
  return paths.map(path => {
    const runs: Point[][] = [];
    const kept: Seg[] = [];
    let run: Point[] = [];
    const flush = () => { if (run.length > 1) runs.push(run); run = []; };
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(len > 0)) continue;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k < n; k++) {
        const p0 = { x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n };
        const p1 = { x: a.x + (b.x - a.x) * (k + 1) / n, y: a.y + (b.y - a.y) * (k + 1) / n };
        if (crowded((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, ux, uy)) { flush(); continue; }
        if (!run.length) run.push(p0);
        run.push(p1);
        kept.push({ ax: p0.x, ay: p0.y, bx: p1.x, by: p1.y, ux, uy, len: len / n });
      }
    }
    flush();
    // Kept only once the whole path is through, so a path never crowds itself.
    for (const s of kept) insert(s);
    return runs;
  });
}
