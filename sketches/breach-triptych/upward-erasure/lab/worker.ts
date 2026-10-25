/**
 * Upward Erasure lab: the sketch run in a browser worker, for the live tuning page (`lab/page.html`, built by
 * `lab/build.mjs`). It draws what the CLI draws, with the CLI's random streams, so a parameter set saved from the page
 * renders the same through `npm run sketch` and the finalize stack. The head stage stays cached in the worker between
 * requests (see `headStage` in `../world.ts`), so moving the visor and glitch controls redraws without rebuilding it.
 *
 * Requests: `{ type: 'meta' }`, `{ type: 'render', id, params, seed }` (the assembled preview: windows, and each
 * sheet's art by pen, as flat point buffers), `{ type: 'svg', id, params, seed, ply }` (one sheet's plot SVG).
 */
import type { Params, Part, Point, SketchContext } from '../../../../src/sketch/types.ts';
import { finalParts, resolveParams, svgFor } from '../../../../packages/plot-core/src/index.ts';
import { PAGE } from '../../world.ts';
import sketch, { sheets } from '../sketch.ts';
import { CONTROLS, PARAMS, erasure } from '../world.ts';

// ── The runner's random streams (cli/sketch/child.ts): SHA-256 of `${seed}\0${id}`, then mulberry32 ────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of a byte string, the first four bytes of the digest as a little-endian uint32. */
function sha256First32(bytes: Uint8Array): number {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = bytes.length, total = Math.ceil((len + 9) / 64) * 64;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[len] = 0x80;
  const bits = len * 8;
  msg[total - 4] = (bits >>> 24) & 255; msg[total - 3] = (bits >>> 16) & 255; msg[total - 2] = (bits >>> 8) & 255; msg[total - 1] = bits & 255;
  msg[total - 5] = Math.floor(bits / 2 ** 32) & 255;
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
  // The digest's bytes 0..3 are h[0] big-endian; read little-endian.
  const x = h[0];
  return (((x >>> 24) & 255) | (((x >>> 16) & 255) << 8) | (((x >>> 8) & 255) << 16) | ((x & 255) << 24)) >>> 0;
}

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

const contextFor = (params: Params, seed: number): SketchContext => ({ params, seed, assets: {}, page: { ...PAGE }, random: id => randomStream(seed, id) });

// ── Flat buffers: every path of a pen as x,y pairs, with where each path starts ────────────────────────────

interface Flat { xy: Float32Array; starts: Uint32Array }
function flatten(paths: Point[][]): Flat {
  const count = paths.reduce((t, p) => t + p.length, 0);
  const xy = new Float32Array(count * 2), starts = new Uint32Array(paths.length + 1);
  let k = 0;
  paths.forEach((p, i) => { starts[i] = k; for (const q of p) { xy[2 * k] = q.x; xy[2 * k + 1] = q.y; k++; } });
  starts[paths.length] = k;
  return { xy, starts };
}
const byPen = (parts: Part[]) => {
  const out: Record<string, Point[][]> = {};
  for (const part of parts) (out[part.pen] ??= []).push(...part.paths);
  return out;
};

// ── Requests ────────────────────────────────────────────────────────────────────────────────────────────────

const post = (msg: unknown, transfer: Transferable[] = []) => (globalThis as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(msg, transfer);

(globalThis as unknown as { onmessage: (e: MessageEvent) => void }).onmessage = (e: MessageEvent) => {
  const req = e.data as { type: string; id?: number; params?: Params; seed?: number; ply?: string };
  try {
    if (req.type === 'meta') {
      post({ type: 'meta', page: PAGE, params: PARAMS, controls: CONTROLS, pens: sketch.pens });
      return;
    }
    const seed = req.seed ?? 1;
    if (req.type === 'render') {
      const t0 = performance.now();
      const params = resolveParams(CONTROLS, req.params ?? {});
      const e = erasure(contextFor(params, seed));
      const t1 = performance.now();
      const art = sheets(e);
      const transfer: Transferable[] = [];
      const pack = (paths: Point[][]) => { const f = flatten(paths); transfer.push(f.xy.buffer, f.starts.buffer); return f; };
      const black = Object.fromEntries(Object.entries(byPen(art.black)).map(([pen, paths]) => [pen, pack(paths)]));
      const gold = Object.fromEntries(Object.entries(byPen(art.gold)).map(([pen, paths]) => [pen, pack(paths)]));
      const windows = pack(e.window.map(r => [...r, r[0]]));
      post({ type: 'render', id: req.id, black, gold, windows, ms: { world: Math.round(t1 - t0), total: Math.round(performance.now() - t0) } }, transfer);
      return;
    }
    if (req.type === 'svg') {
      const params = resolveParams(sketch.controls, { ...(req.params ?? {}), ply: req.ply ?? 'black' });
      const parts = finalParts(sketch.draw(contextFor(params, seed)), sketch, undefined, seed);
      post({ type: 'svg', id: req.id, svg: svgFor({ page: sketch.page, pens: sketch.pens } as Parameters<typeof svgFor>[0], parts) });
      return;
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
