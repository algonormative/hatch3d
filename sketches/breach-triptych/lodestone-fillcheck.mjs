// Lodestone's fill check (R7): per window cut in a panel's upper sheet, the ink on the sheet beneath, out over the
// window grown by the bleed, so a cut or a registration a little off never shows bare paper at the window's edge.
// It samples the ink beneath every 0.2 mm and, every 0.25 mm over the window and the band round it, the distance to the
// nearest ink: a dense window (a hatch or stripe fill) passes when the band is no emptier than the window's own pattern
// (no gap past 1.5 mm over its spacing). Sparse windows (field lines, pulse rings, the figure on black) are reported
// but exempt; "Infinity" there means no ink within 6 mm, bare sheet by design.
// The band runs out to the bleed less 0.5 mm (3.5 mm at the 4 mm bleed): renderPly clips the ink beneath to the window
// grown by the bleed, so the last half millimetre is short by construction.
// Usage: node sketches/breach-triptych/lodestone-fillcheck.mjs <finalize-out-dir> [band=3.5]; exits 1 on a FAIL.
// The trim is world.ts's TRIM (11 x 17 in, 11 mm margin).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [dir, bleedArg] = process.argv.slice(2);
const bleed = Number(bleedArg ?? 3.5), TRIM = { x0: 11, y0: 11, x1: 268.4, y1: 420.8 };
const panels = { 'lodestone-l': ['black', 'gold'], 'lodestone-c': ['gold', 'black'], 'lodestone-r': ['white', 'black'] };
const dense = { 'lodestone-l': ['bar', 'tie', 'shirtl', 'shirtr', 'corner', 'notch'], 'lodestone-c': ['bar'], 'lodestone-r': ['tie'] };
const read = (panel, ply) => JSON.parse(readFileSync(join(dir, `${panel}-${ply}`, 'source', 'result.json'), 'utf8'));
const inside = (ring, p) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
const segD = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0; return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t); };
const ringD = (ring, p) => { let d = Infinity; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) d = Math.min(d, segD(p, ring[j], ring[i])); return d; };
let failed = 0;
for (const [panel, [upper, lower]] of Object.entries(panels)) {
  if (!existsSync(join(dir, `${panel}-${upper}`))) continue;
  const up = read(panel, upper), low = read(panel, lower);
  const windows = up.parts.filter(p => p.id.startsWith(`asm-${upper}-`)).map(p => ({ id: p.id.slice(`asm-${upper}-`.length), ring: p.paths[0].slice(0, -1) }));
  // The ink beneath: every plotted path of the lower ply but the guides and diagnostics, sampled every 0.2 mm into a grid.
  const ink = low.parts.filter(p => !p.diagnostic && !/^(cut-|asm-|place-|finishing)/.test(p.id)).flatMap(p => p.paths);
  const cell = 2, grid = new Map(), key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const path of ink) for (let i = 1; i < path.length; i++) { const a = path[i - 1], b = path[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.2)); for (let k = 0; k <= n; k++) { const q = { x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n }, kk = key(q.x, q.y); (grid.get(kk) ?? grid.set(kk, []).get(kk)).push(q); } }
  const nearest = p => { let d = Infinity; const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell); for (let r = 0; r <= 3 && d > r * cell; r++) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) { if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue; for (const q of grid.get(`${cx + i},${cy + j}`) ?? []) d = Math.min(d, Math.hypot(q.x - p.x, q.y - p.y)); } return d; };
  for (const w of windows) {
    const xs = w.ring.map(p => p.x), ys = w.ring.map(p => p.y);
    // The pattern's own spacing (farthest from ink inside the window, a millimetre in from its edge) against the band
    // round its edge out to the bleed: the fill must reach the band no emptier than it is inside (and no gap past 1.5 mm
    // over its own spacing). Points beyond the trim are left out: they are cut away.
    let inner = 0, band = 0, at = null;
    for (let x = Math.max(TRIM.x0, Math.min(...xs) - bleed); x <= Math.min(TRIM.x1, Math.max(...xs) + bleed); x += 0.25) for (let y = Math.max(TRIM.y0, Math.min(...ys) - bleed); y <= Math.min(TRIM.y1, Math.max(...ys) + bleed); y += 0.25) {
      const p = { x, y }, ins = inside(w.ring, p), e = ringD(w.ring, p);
      if (!ins && e > bleed) continue;
      const d = nearest(p);
      if (ins && e > 1) inner = Math.max(inner, d); else if (d > band) { band = d; at = p; }
    }
    const kind = dense[panel].includes(w.id) ? 'dense' : 'sparse';
    const ok = band <= Math.max(inner, 1.5) + 0.25;
    if (kind === 'dense' && !ok) failed++;
    console.log(`${panel} ${upper} window ${w.id} (${kind}): pattern spacing inside ${inner.toFixed(2)} mm; at the edge out to ${bleed} mm ${band.toFixed(2)} mm${at ? ` (worst at ${at.x.toFixed(1)}, ${at.y.toFixed(1)})` : ''}${kind === 'dense' ? (ok ? '  PASS' : '  FAIL') : '  (exempt: sparse by design)'}`);
  }
}
if (failed) { console.log(`${failed} dense window(s) short of the band`); process.exit(1); }
