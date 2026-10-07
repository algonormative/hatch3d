/**
 * Is this print the approved art? Compare a plain render of a sketch with its finished print and
 * report whether every art path appears in the print under one uniform scale and offset: the fit
 * that finishing applies to sit the art inside the border. Paths of the finishing itself (layers
 * whose label or pen mentions `finishing`) are left out.
 *
 *   node --import tsx cli/art-match.ts <plain.svg> <print.svg>
 *
 * Exit 0 when every path matches one-to-one within `tolerance` millimetres (default 0.01).
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type P = [number, number];

/** Art paths of a sketch SVG, as point lists, skipping finishing layers. */
export function artPaths(svg: string): P[][] {
  const out: P[][] = [];
  for (const m of svg.matchAll(/<g([^>]*)>([\s\S]*?)<\/g>/g)) {
    if (m[1].includes('finishing')) continue;
    for (const d of m[2].matchAll(/ d="([^"]+)"/g)) {
      const nums = (d[1].match(/-?\d+\.?\d*(?:e-?\d+)?/g) ?? []).map(Number);
      const pts: P[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
      if (pts.length) out.push(pts);
    }
  }
  return out;
}

export interface ArtMatch { scale: number; dx: number; dy: number; total: number; matched: number; worst: number; ok: boolean }

/** Fit the scale and offset from the two drawings' bounds, then match path to path. */
export function artMatch(plainSvg: string, printSvg: string, tolerance = 0.01): ArtMatch {
  const a = artPaths(plainSvg), b = artPaths(printSvg);
  const bounds = (paths: P[][]) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of paths) for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { x0, y0, x1, y1 };
  };
  const ba = bounds(a), bb = bounds(b);
  const scale = (bb.x1 - bb.x0) / (ba.x1 - ba.x0 || 1);
  const dx = bb.x0 - scale * ba.x0, dy = bb.y0 - scale * ba.y0;
  // Index the print's paths by start cell; claim each match once.
  const grid = new Map<string, number[]>();
  b.forEach((p, i) => { const k = `${Math.floor(p[0][0])},${Math.floor(p[0][1])}`; grid.set(k, [...(grid.get(k) ?? []), i]); });
  const used = new Set<number>();
  let matched = 0, worst = 0;
  for (const p of a) {
    const q = p.map(([x, y]): P => [scale * x + dx, scale * y + dy]);
    const gx = Math.floor(q[0][0]), gy = Math.floor(q[0][1]);
    let best = Infinity, at = -1;
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (const i of grid.get(`${gx + ox},${gy + oy}`) ?? []) {
      if (used.has(i) || b[i].length !== q.length) continue;
      let e = 0;
      for (let k = 0; k < q.length && e < best; k++) e = Math.max(e, Math.abs(q[k][0] - b[i][k][0]), Math.abs(q[k][1] - b[i][k][1]));
      if (e < best) { best = e; at = i; }
    }
    if (at >= 0 && best <= tolerance) { used.add(at); matched++; worst = Math.max(worst, best); }
  }
  return { scale, dx, dy, total: a.length, matched, worst, ok: a.length > 0 && matched === a.length && b.length === a.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [plain, print] = process.argv.slice(2);
  if (!plain || !print) { console.error('usage: node --import tsx cli/art-match.ts <plain.svg> <print.svg>'); process.exitCode = 2; }
  else {
    const r = artMatch(readFileSync(plain, 'utf8'), readFileSync(print, 'utf8'));
    console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.matched}/${r.total} art paths match under scale ${r.scale.toFixed(5)}, offset (${r.dx.toFixed(3)}, ${r.dy.toFixed(3)}) mm; worst ${r.worst.toFixed(4)} mm`);
    process.exitCode = r.ok ? 0 : 1;
  }
}
