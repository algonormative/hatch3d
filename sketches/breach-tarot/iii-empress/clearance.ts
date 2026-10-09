import type { Point } from '../../../src/sketch/types.ts';

/**
 * Paper kept clear round what is already drawn, for marks drawn after it that must give way: a page-space index of the
 * drawn marks' points, sampled every `step` millimetres, and a test for whether a point lies within `gap` of any of
 * them. A card drawing near to far registers each mark as it keeps it; a background mark then keeps only the stretches
 * of itself that clear everything in front by `gap` (the format's `MIN_SPACING`, so no two strokes run closer than the
 * pens hold apart). A mark never gives way to itself: register it after testing it.
 */
export class Clearance {
  private readonly cells = new Map<string, number[]>();

  constructor(private readonly gap: number, private readonly step = 0.1) {}

  private key(x: number, y: number): string { return `${Math.floor(x / this.gap)},${Math.floor(y / this.gap)}`; }

  /** Whether `p` lies within `gap` of a registered mark. */
  near(p: Point): boolean {
    const ix = Math.floor(p.x / this.gap), iy = Math.floor(p.y / this.gap), g2 = this.gap * this.gap;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cell = this.cells.get(`${ix + i},${iy + j}`);
      if (cell) for (let k = 0; k < cell.length; k += 2) if ((cell[k] - p.x) ** 2 + (cell[k + 1] - p.y) ** 2 < g2) return true;
    }
    return false;
  }

  /** Register a drawn mark. */
  add(path: Point[]): void {
    const put = (x: number, y: number) => {
      const key = this.key(x, y);
      let cell = this.cells.get(key);
      if (!cell) this.cells.set(key, cell = []);
      cell.push(x, y);
    };
    if (path.length) put(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / this.step));
      for (let k = 1; k <= steps; k++) put(a.x + (b.x - a.x) * k / steps, a.y + (b.y - a.y) * k / steps);
    }
  }
}
