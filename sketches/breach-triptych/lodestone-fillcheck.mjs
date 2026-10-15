// Lodestone's fill check (R7, R9): per window cut in a panel's upper sheet, the ink on the sheet beneath, out over the
// window grown by the bleed, so a cut or a registration a little off never shows bare paper at the window's edge; and
// (R9) the emphasis lines on every sheet, kept apart from the sheet's other lines.
//
// Windows. The ink beneath is sampled every 0.2 mm; every 0.25 mm over the window and the band round it, the distance
// to the nearest ink is measured.
// - Dense (a hatch or stripe fill: the farthest point from ink inside, a millimetre in from the edge, 2.5 mm or less)
//   passes when the band is no emptier than the window's own pattern (no gap past 1.5 mm over its spacing).
// - Sparse (field lines, the cosmos, a lens, the figure on black) need not fill the band, but must not be cropped short
//   of it: the lines beneath (2 mm long or more) that enter the window and stop in the band (not at the trim, and not where another
//   line takes over within 0.3 mm; a line cut on the window's own edge counts at 0) are binned by how far out they stop, and a bin holding at least 8 of them and 40% of all is a hard crop line, FAIL. Its largest empty disc
//   inside is reported (radius; "reads empty" past 10 mm, a warning).
// The band runs out to the bleed less 0.5 mm (3.5 mm at the 4 mm bleed): renderPly clips the ink beneath to the window
// grown by the bleed, so the last half millimetre is short by construction.
//
// Emphasis. Every line of a part whose id holds "emph" against every other line on its sheet: a stretch over 1.5 mm
// where it runs nearer than 0.55 mm (centre to centre; the gel line is about 0.5 mm) to another line would fuse, FAIL.
// A crossing is short and does not count.
//
// Usage: node sketches/breach-triptych/lodestone-fillcheck.mjs <finalize-out-dir> [band=3.5]; exits 1 on a FAIL.
// The trim is world.ts's TRIM (11 x 17 in, 11 mm margin).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const [dir, bleedArg] = process.argv.slice(2);
const bleed = Number(bleedArg ?? 3.5), TRIM = { x0: 11, y0: 11, x1: 268.4, y1: 420.8 }, SPACING = 0.55;
const panels = { 'lodestone-l': ['black', 'gold'], 'lodestone-c': ['gold', 'black'], 'lodestone-r': ['white', 'black'] };
const read = piece => JSON.parse(readFileSync(join(dir, piece, 'source', 'result.json'), 'utf8'));
const inside = (ring, p) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
const segD = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0; return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t); };
const ringD = (ring, p) => { let d = Infinity; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) d = Math.min(d, segD(p, ring[j], ring[i])); return d; };
const atTrim = p => Math.min(p.x - TRIM.x0, TRIM.x1 - p.x, p.y - TRIM.y0, TRIM.y1 - p.y) < 0.6;
const plotted = r => r.parts.filter(p => !p.diagnostic && !/^(cut-|asm-|place-|finishing)/.test(p.id));
/** Ink sampled every 0.2 mm into a 2 mm grid, each sample tagged with its path; `nearest(p, skip)` searches out to 16 mm. */
function sampled(paths) {
  const cell = 2, grid = new Map(), key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  paths.forEach((path, k) => { for (let i = 1; i < path.length; i++) { const a = path[i - 1], b = path[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.2)); for (let j = 0; j <= n; j++) { const q = { x: a.x + (b.x - a.x) * j / n, y: a.y + (b.y - a.y) * j / n, k }, kk = key(q.x, q.y); (grid.get(kk) ?? grid.set(kk, []).get(kk)).push(q); } } });
  return (p, skip = -1) => {
    let d = Infinity;
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
    for (let r = 0; r <= 8 && d > (r - 1) * cell; r++) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
      for (const q of grid.get(`${cx + i},${cy + j}`) ?? []) if (q.k !== skip) d = Math.min(d, Math.hypot(q.x - p.x, q.y - p.y));
    }
    return d;
  };
}
let failed = 0;
for (const [panel, [upper, lower]] of Object.entries(panels)) {
  if (!existsSync(join(dir, `${panel}-${upper}`))) continue;
  const up = read(`${panel}-${upper}`), low = read(`${panel}-${lower}`);
  const windows = up.parts.filter(p => p.id.startsWith(`asm-${upper}-`)).map(p => ({ id: p.id.slice(`asm-${upper}-`.length), ring: p.paths[0].slice(0, -1) }));
  const ink = plotted(low).flatMap(p => p.paths), nearest = sampled(ink);
  for (const w of windows) {
    const xs = w.ring.map(p => p.x), ys = w.ring.map(p => p.y);
    // The pattern's own spacing (farthest from ink inside the window, a millimetre in from its edge) against the band
    // round its edge out to the bleed. Points beyond the trim are left out: they are cut away.
    let inner = 0, band = 0, at = null, innerAt = null;
    for (let x = Math.max(TRIM.x0, Math.min(...xs) - bleed); x <= Math.min(TRIM.x1, Math.max(...xs) + bleed); x += 0.25) for (let y = Math.max(TRIM.y0, Math.min(...ys) - bleed); y <= Math.min(TRIM.y1, Math.max(...ys) + bleed); y += 0.25) {
      const p = { x, y }, ins = inside(w.ring, p), e = ringD(w.ring, p);
      if (!ins && e > bleed) continue;
      const d = nearest(p);
      if (ins && e > 1) { if (d > inner) { inner = d; innerAt = p; } } else if (d > band) { band = d; at = p; }
    }
    const fmt = v => (Number.isFinite(v) ? v.toFixed(2) : 'over 16');
    if (inner <= 2.5) {
      const ok = band <= Math.max(inner, 1.5) + 0.25;
      if (!ok) failed++;
      console.log(`${panel} ${upper} window ${w.id} (dense): pattern spacing inside ${fmt(inner)} mm; at the edge out to ${bleed} mm ${fmt(band)} mm${at ? ` (worst at ${at.x.toFixed(1)}, ${at.y.toFixed(1)})` : ''}  ${ok ? 'PASS' : 'FAIL'}`);
      continue;
    }
    // Sparse: where the lines that enter the window stop, out in the band; a crop shows as many stopping at one distance.
    const stops = [];
    let entering = 0;
    const ends = new Map(), endKey = q => `${Math.round(q.x / 0.3)},${Math.round(q.y / 0.3)}`;
    ink.forEach((path, k) => { for (const q of [path[0], path[path.length - 1]]) for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const kk = `${Math.round(q.x / 0.3) + i},${Math.round(q.y / 0.3) + j}`; (ends.get(kk) ?? ends.set(kk, []).get(kk)).push({ q, k }); } });
    const carriedOn = (end, k) => (ends.get(endKey(end)) ?? []).some(o => o.k !== k && Math.hypot(o.q.x - end.x, o.q.y - end.y) < 0.3);
    for (const [k, path] of ink.entries()) {
      // (Stars, filings and dashes, under 2 mm, are marks, not lines: they make no crop line.)
      if (!path.some(q => inside(w.ring, q)) || path.slice(1).reduce((t, q, i) => t + Math.hypot(q.x - path[i].x, q.y - path[i].y), 0) < 2) continue;
      entering++;
      for (const end of [path[0], path[path.length - 1]]) {
        if (atTrim(end) || carriedOn(end, k)) continue;
        // (A line cut at the window's own edge stops on it, a hair inside or out: that is the worst crop, at 0.)
        const e = ringD(w.ring, end);
        if (inside(w.ring, end) ? e < 0.3 : e < bleed) stops.push(inside(w.ring, end) ? 0 : e);
      }
    }
    const bins = new Map();
    for (const e of stops) { const b = Math.floor(e / 0.25); bins.set(b, (bins.get(b) ?? 0) + 1); }
    const [crop, count] = [...bins.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
    const cropped = count >= 8 && count >= 0.4 * stops.length;
    if (cropped) failed++;
    const empty = inner > 10 ? '  (reads empty)' : '';
    console.log(`${panel} ${upper} window ${w.id} (sparse): largest empty disc inside, radius ${fmt(inner)} mm${innerAt ? ` at (${innerAt.x.toFixed(1)}, ${innerAt.y.toFixed(1)})` : ''}${empty}; ${entering} lines enter, ${stops.length} stop short in the band${stops.length ? ` (most at ${(crop * 0.25).toFixed(2)} to ${(crop * 0.25 + 0.25).toFixed(2)} mm out: ${count})` : ''}  ${cropped ? 'FAIL: cropped short of the bleed' : 'PASS'}`);
  }
}
// The emphasis on every sheet.
for (const piece of readdirSync(dir).filter(d => d.startsWith('lodestone-') && existsSync(join(dir, d, 'source', 'result.json'))).sort()) {
  const parts = plotted(read(piece)), lines = parts.flatMap(p => p.paths.map(path => ({ part: p.id, path })));
  const emph = lines.map((l, k) => ({ ...l, k })).filter(l => /emph/.test(l.part));
  if (!emph.length) continue;
  const nearest = sampled(lines.map(l => l.path));
  let fused = 0, length = 0;
  const where = [];
  for (const { part, path, k } of emph) {
    let run = 0, from = null;
    const close = () => { if (run > 1.5) { fused++; where.push(`${part} ${run.toFixed(1)} mm at (${from.x.toFixed(1)}, ${from.y.toFixed(1)})`); } run = 0; from = null; };
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], l = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(l / 0.2));
      length += l;
      for (let j = 0; j < n; j++) {
        const q = { x: a.x + (b.x - a.x) * j / n, y: a.y + (b.y - a.y) * j / n };
        if (nearest(q, k) < SPACING) { run += l / n; from ??= q; } else close();
      }
    }
    close();
  }
  if (fused) failed++;
  console.log(`${piece} emphasis: ${emph.length} lines, ${length.toFixed(0)} mm; ${fused} stretches over 1.5 mm nearer than ${SPACING} mm to another line  ${fused ? 'FAIL' : 'PASS'}${where.length ? '\n  ' + where.slice(0, 8).join('\n  ') : ''}`);
}
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
