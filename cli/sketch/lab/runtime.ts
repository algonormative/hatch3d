/**
 * The sketch lab's worker runtime: a sketch run in a browser worker for a live tuning page (`npm run sketch -- lab`,
 * see `docs/sketch-lab.md`). It draws what the CLI draws, with the CLI's random streams (`cli/sketch/child.ts`), so a
 * parameter set saved from the page renders the same through `npm run sketch` and the finalize stack. The module stays
 * loaded between requests, so a sketch that caches a costly stage at module level (Upward Erasure's head) keeps it.
 *
 * Requests (each with an `id`, answered with the same `id`):
 * - `{ type: 'meta' }`: the sketch's name, page, pens, controls, and its assembly (plies bottom to top) if any.
 * - `{ type: 'render', params, seed }`: every sheet (each ply of an assembly, else the one sheet) as flat point buffers
 *   by pen, with its paper and the rings of its own cuts; an onlay ply comes back as its footprint and paper alone.
 * - `{ type: 'svg', params, seed, ply? }`: one sheet's SVG, as the CLI writes it (no finishing).
 *
 * Kept free of Node modules: it is bundled for the browser.
 */
import { finalParts, resolveParams, svgFor } from '../../../packages/plot-core/src/index.ts';
import type { Params, Part, Point, Sketch, SketchContext } from '../../../src/sketch/types.ts';

// ── The runner's random streams: SHA-256 of `${seed}\0${id}`, its first four bytes, then mulberry32 ──────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The first four bytes of a SHA-256 digest, read little-endian (as `digest.readUInt32LE(0)`). */
function sha256First32(bytes: Uint8Array): number {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = bytes.length, total = Math.ceil((len + 9) / 64) * 64;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[len] = 0x80;
  const bits = len * 8;
  for (let i = 0; i < 8; i++) msg[total - 1 - i] = Math.floor(bits / 2 ** (8 * i)) & 255;
  const w = new Uint32Array(64);
  const rot = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (msg[off + 4 * i] << 24) | (msg[off + 4 * i + 1] << 16) | (msg[off + 4 * i + 2] << 8) | msg[off + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const x = h[0];
  return (((x >>> 24) & 255) | (((x >>> 16) & 255) << 8) | (((x >>> 8) & 255) << 16) | ((x & 255) << 24)) >>> 0;
}

/** The runner's stream for one part id. */
export function randomStream(seed: number, partId: string): () => number {
  let state = sha256First32(new TextEncoder().encode(`${seed}\0${partId}`));
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Sheets ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Paths as x,y pairs, with where each path starts (the last entry is the end). */
export interface Flat { xy: Float32Array; starts: Uint32Array }
export function flatten(paths: Point[][]): Flat {
  const count = paths.reduce((t, p) => t + p.length, 0);
  const xy = new Float32Array(count * 2), starts = new Uint32Array(paths.length + 1);
  let k = 0;
  paths.forEach((p, i) => { starts[i] = k; for (const q of p) { xy[2 * k] = q.x; xy[2 * k + 1] = q.y; k++; } });
  starts[paths.length] = k;
  return { xy, starts };
}

/** One sheet as the page composes it: its paper, the rings cut out of it, and its ink by pen (bottom to top). */
export interface Sheet { id: string; paper: string; onlay: boolean; cuts: Flat; layers: { pen: string; color: string; width: number; paths: Flat }[] }

/** The rings of each ply's cuts, read from the `asm-<ply>-<cut>` diagnostics every assembly render carries. */
export function cutsByPly(parts: Part[], plies: string[]): Map<string, Point[][]> {
  const out = new Map<string, Point[][]>(plies.map(p => [p, []]));
  for (const part of parts) {
    if (!part.diagnostic || !part.id.startsWith('asm-') || part.id === 'asm-signature') continue;
    const owner = plies.filter(p => part.id.startsWith(`asm-${p}-`)).sort((a, b) => b.length - a.length)[0];
    if (owner) out.get(owner)!.push(...part.paths);
  }
  return out;
}

const contextFor = (sketch: Sketch, params: Params, seed: number): SketchContext => ({ params, seed, assets: {}, page: { ...sketch.page }, random: id => randomStream(seed, id) });

/** A sketch's final parts for these parameters (the CLI's `draw` and `finalParts`, no finishing). */
async function partsFor(sketch: Sketch, supplied: Params, seed: number): Promise<{ params: Params; parts: Part[] }> {
  const params = resolveParams(sketch.controls ?? [], supplied);
  return { params, parts: finalParts(await sketch.draw(contextFor(sketch, params, seed)), sketch, undefined, seed) };
}

/**
 * A sketch's optional preview for the lab: each ply's art unclipped and the rings cut out of it, which the page clips on
 * the canvas, so the lab skips the exact clipping `renderPly` does for plotting (exports still use `draw`). Exported
 * from the sketch's module as `labSheets`.
 */
export type LabSheets = (ctx: SketchContext) => { ply: string; parts: Part[]; cuts: Point[][] }[] | Promise<{ ply: string; parts: Part[]; cuts: Point[][] }[]>;

export async function renderSheets(sketch: Sketch, supplied: Params, seed: number, preview?: LabSheets): Promise<Sheet[]> {
  const pens = new Map(sketch.pens.map(p => [p.id, p]));
  const layersOf = (parts: Part[], skip?: string) => {
    const byPen = new Map<string, Point[][]>();
    for (const part of parts) if (!part.diagnostic && part.pen !== skip) byPen.set(part.pen, [...(byPen.get(part.pen) ?? []), ...part.paths]);
    return sketch.pens.filter(p => byPen.has(p.id)).map(p => ({ pen: p.id, color: pens.get(p.id)!.color, width: pens.get(p.id)!.width, paths: flatten(byPen.get(p.id)!) }));
  };
  const spec = sketch.assembly;
  if (spec && preview) {
    const params = resolveParams(sketch.controls ?? [], supplied);
    const drawn = await preview(contextFor(sketch, params, seed));
    return spec.plies.map(ply => {
      const d = drawn.find(x => x.ply === ply.id);
      return { id: ply.id, paper: ply.paper.color, onlay: !!ply.onlay, cuts: flatten(d?.cuts ?? []), layers: d ? layersOf(d.parts, spec.cutPen) : [] };
    });
  }
  if (!spec) {
    const { parts } = await partsFor(sketch, supplied, seed);
    return [{ id: 'sheet', paper: sketch.page.paper ?? '#ffffff', onlay: false, cuts: flatten([]), layers: layersOf(parts) }];
  }
  const sheets: Sheet[] = [];
  let cuts: Map<string, Point[][]> | undefined;
  for (const ply of spec.plies) {
    if (ply.onlay) continue;
    const { parts } = await partsFor(sketch, { ...supplied, [spec.control]: ply.id }, seed);
    cuts ??= cutsByPly(parts, spec.plies.map(p => p.id));
    sheets.push({ id: ply.id, paper: ply.paper.color, onlay: false, cuts: flatten(cuts.get(ply.id) ?? []), layers: layersOf(parts, spec.cutPen) });
  }
  // Onlays in stack order: each its footprint in its paper.
  const order = spec.plies.map(p => p.id);
  for (const ply of spec.plies) if (ply.onlay) sheets.push({ id: ply.id, paper: ply.paper.color, onlay: true, cuts: flatten(cuts?.get(ply.id) ?? []), layers: [] });
  return sheets.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

export async function sheetSvg(sketch: Sketch, supplied: Params, seed: number, ply?: string): Promise<string> {
  const spec = sketch.assembly;
  const { parts } = await partsFor(sketch, spec && ply ? { ...supplied, [spec.control]: ply } : supplied, seed);
  return svgFor({ page: sketch.page, pens: sketch.pens } as Parameters<typeof svgFor>[0], parts);
}

// ── The worker's message loop ────────────────────────────────────────────────────────────────────────────────

type Request = { type: 'meta' | 'render' | 'svg'; id: number; params?: Params; seed?: number; ply?: string };
interface Scope { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null }

/** Serve a sketch from inside a worker: answer the page's requests (see the module comment). */
export function serveLab(sketch: Sketch, preview?: LabSheets, scope: Scope = globalThis as unknown as Scope): void {
  scope.onmessage = async (e: MessageEvent) => {
    const req = e.data as Request;
    try {
      if (req.type === 'meta') {
        const spec = sketch.assembly;
        scope.postMessage({ id: req.id, type: 'meta', name: sketch.name, page: sketch.page, pens: sketch.pens, controls: sketch.controls ?? [],
          assembly: spec ? { control: spec.control, plies: spec.plies.map(p => ({ id: p.id, paper: p.paper, onlay: !!p.onlay })) } : undefined });
        return;
      }
      const seed = req.seed ?? 0, params = req.params ?? {};
      if (req.type === 'render') {
        const t0 = performance.now();
        const sheets = await renderSheets(sketch, params, seed, preview);
        const transfer: Transferable[] = [];
        for (const s of sheets) { transfer.push(s.cuts.xy.buffer, s.cuts.starts.buffer); for (const l of s.layers) transfer.push(l.paths.xy.buffer, l.paths.starts.buffer); }
        scope.postMessage({ id: req.id, type: 'render', sheets, ms: Math.round(performance.now() - t0) }, transfer);
        return;
      }
      if (req.type === 'svg') {
        scope.postMessage({ id: req.id, type: 'svg', svg: await sheetSvg(sketch, params, seed, req.ply) });
        return;
      }
      throw new Error(`Unknown request ${String(req.type)}`);
    } catch (err) {
      scope.postMessage({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };
}
