/**
 * What a finalized assembly ply says about its world, read back from its `source/result.json`, and the checks that
 * compare plies and panels. Pure functions over a render result: `cli/finalize.ts` runs them as it finalizes a ply,
 * `cli/assembly.ts` and `cli/print-queue.ts` read the same facts back.
 *
 * Every render of an assembly sketch draws the whole world and rides every ply's cuts along as diagnostic parts
 * (`asm-<ply>-<cut>`, in finished millimetres), so any one ply's result.json holds the cuts of all of them.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inkReads } from '../src/sketch/materials.ts';
import type { AssemblySpec, Box, FinishingOptions, Page, Part, PlySpec, Point } from '../src/sketch/types.ts';

export type CutKind = 'waste' | 'part' | 'footprint';

/** What `report.assembly` records for a finalized ply (see `finalizePiece`). */
export interface AssemblyReport {
  name: string;
  ply: string;
  /** 1-based position of the ply in the assembly, bottom to top, and the number of plies (onlays included). */
  index: number;
  plies: number;
  paper: { id: string; color: string };
  cutPen: string;
  cutInk: string;
  lift?: number;
  cuts: { id: string; kind: CutKind; label?: string }[];
  onlays: { ply: string; from: string }[];
  /** The pen and the box (finished millimetres) that the signature goes into, when this ply carries it. */
  signature?: { pen: string; box: Box };
  worldSha256: string;
}

/** The parts of `source/result.json` that the assembly tools read. */
export interface PlyResult {
  identity: string;
  seed: number;
  params: Record<string, unknown>;
  metadata: { name: string; page: Page };
  finishing?: FinishingOptions;
  parts: Part[];
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export function readPlyResult(pieceDir: string): PlyResult {
  const path = join(pieceDir, 'source', 'result.json');
  if (!existsSync(path)) throw new Error(`no ${path}: finalize the ply first`);
  return JSON.parse(readFileSync(path, 'utf8')) as PlyResult;
}

/** `"<assembly>/<ply>/<cut>"`, which names the part a ply is an onlay of. */
export function parseFrom(from: string): { assembly: string; ply: string; cut: string } {
  const parts = from.split('/');
  if (parts.length !== 3 || parts.some(p => !p.trim())) throw new Error(`onlay source ${JSON.stringify(from)} must read "<assembly>/<ply>/<cut>"`);
  return { assembly: parts[0], ply: parts[1], cut: parts[2] };
}

// ── The cuts, as diagnostics ─────────────────────────────────────────

export interface WorldCut { ply: string; id: string; /** Open rings: the closing repeat of the diagnostic path is dropped. */ rings: Point[][] }

const samePoint = (a: Point, b: Point, tolerance = 0): boolean => Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;

/** The diagnostic `asm-*` parts: every ply's cuts and the signature box, in finished millimetres. */
export const diagnosticParts = (parts: Part[]): Part[] => parts.filter(p => p.diagnostic && p.id.startsWith('asm-'));

/** Every cut of every ply, read from the diagnostics. Throws when a cut's ring was clipped by the page fit. */
export function worldCuts(parts: Part[], spec: AssemblySpec): WorldCut[] {
  const cuts: WorldCut[] = [];
  for (const part of diagnosticParts(parts)) {
    if (part.id === 'asm-signature') continue;
    const owners = spec.plies.filter(p => part.id.startsWith(`asm-${p.id}-`) && part.id.length > `asm-${p.id}-`.length);
    if (owners.length !== 1) throw new Error(`diagnostic ${part.id} names ${owners.length ? 'more than one ply' : 'no ply'} of the assembly`);
    const ply = owners[0].id;
    const id = part.id.slice(`asm-${ply}-`.length);
    const rings = part.paths.map(path => {
      if (path.length < 4 || !samePoint(path[0], path[path.length - 1])) {
        throw new Error(`cut ${id} of ply ${ply} is clipped by the page fit: keep every cut inside the content area, clear of the border`);
      }
      return path.slice(0, -1);
    });
    cuts.push({ ply, id, rings });
  }
  return cuts;
}

/** The signature box on the signing ply, as the bounds of its diagnostic ring. */
export function signatureBox(parts: Part[]): Box | undefined {
  const part = parts.find(p => p.diagnostic && p.id === 'asm-signature');
  if (!part) return undefined;
  const points = part.paths.flat();
  const x0 = Math.min(...points.map(p => p.x)), x1 = Math.max(...points.map(p => p.x));
  const y0 = Math.min(...points.map(p => p.y)), y1 = Math.max(...points.map(p => p.y));
  const q = (n: number) => Math.round(n * 1000) / 1000;
  return { x: q(x0), y: q(y0), width: q(x1 - x0), height: q(y1 - y0) };
}

/** The one-world fingerprint: the sha256 of every `asm-*` diagnostic (id and path), in id order. */
export function worldSha256(parts: Part[]): string {
  const diag = diagnosticParts(parts).map(p => [p.id, p.paths] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(JSON.stringify(diag));
}

/**
 * The kind of each cut on the ply this render is. The diagnostics do not name it, so it is read from the guide
 * the cut has on the page: a part's guide is its own rings, closed and uninset, and nothing else; a window's is an
 * inset outline with X marks. An onlay ply's single cut is its footprint.
 */
export function plyCuts(parts: Part[], spec: AssemblySpec, plyId: string): { id: string; kind: CutKind }[] {
  const ply = spec.plies.find(p => p.id === plyId);
  if (!ply) throw new Error(`Unknown ply: ${plyId}`);
  return worldCuts(parts, spec).filter(c => c.ply === plyId).map(cut => {
    if (ply.onlay) return { id: cut.id, kind: 'footprint' as const };
    const guide = parts.find(p => p.id === `cut-${cut.id}`);
    if (!guide?.boundary) throw new Error(`cut ${cut.id} of ply ${plyId} has no guide in the render`);
    const same = guide.paths.length === cut.rings.length && guide.paths.every((path, i) => path.length === cut.rings[i].length + 1
      && path.every((p, k) => samePoint(p, cut.rings[i][k % cut.rings[i].length], 0.002)));
    return { id: cut.id, kind: same ? 'part' as const : 'waste' as const };
  });
}

// ── Congruence ───────────────────────────────────────────────────────

export interface RigidFit { cos: number; sin: number; tx: number; ty: number; rms: number }

/**
 * The rotation and translation (no reflection) that carry `from` onto `to` with the least squared distance between
 * corresponding vertices (Kabsch, in the plane), and the RMS residual. The rings must have the same count and the same
 * vertex count, in the same order. Throws when they do not.
 */
export function fitRigid(from: Point[][], to: Point[][]): RigidFit {
  if (from.length !== to.length || from.some((ring, i) => ring.length !== to[i].length)) {
    throw new Error(`rings do not correspond: ${from.map(r => r.length).join('+')} vertices against ${to.map(r => r.length).join('+')}`);
  }
  const a = from.flat(), b = to.flat();
  if (a.length === 0) throw new Error('rings do not correspond: no vertices');
  const centre = (points: Point[]) => ({ x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length });
  const ca = centre(a), cb = centre(b);
  let dot = 0, cross = 0;
  for (let i = 0; i < a.length; i++) {
    const px = a[i].x - ca.x, py = a[i].y - ca.y, qx = b[i].x - cb.x, qy = b[i].y - cb.y;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
  }
  const theta = Math.atan2(cross, dot);
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const tx = cb.x - (cos * ca.x - sin * ca.y), ty = cb.y - (sin * ca.x + cos * ca.y);
  let squares = 0;
  for (let i = 0; i < a.length; i++) squares += (cos * a[i].x - sin * a[i].y + tx - b[i].x) ** 2 + (sin * a[i].x + cos * a[i].y + ty - b[i].y) ** 2;
  return { cos, sin, tx, ty, rms: Math.sqrt(squares / a.length) };
}

/** An onlay's footprint must be its part's outline to within this RMS residual, millimetres. */
export const CONGRUENT_RMS_MM = 0.05;

/** The fit from the part's rings to the footprint's, or a thrown error naming both when they are not congruent. */
export function congruentFit(part: Point[][], footprint: Point[][], label: string): RigidFit {
  let fit: RigidFit;
  try { fit = fitRigid(part, footprint); } catch (error) { throw new Error(`${label}: footprint is not congruent to the part (${(error as Error).message})`); }
  if (!(fit.rms < CONGRUENT_RMS_MM)) throw new Error(`${label}: footprint is not congruent to the part (rigid fit leaves an RMS of ${fit.rms.toFixed(3)} mm, limit ${CONGRUENT_RMS_MM} mm)`);
  return fit;
}

/** The SVG `matrix(a b c d e f)` of a fit: it maps part coordinates onto the footprint. */
export const fitMatrix = (fit: RigidFit): string => `matrix(${[fit.cos, fit.sin, -fit.sin, fit.cos, fit.tx, fit.ty].map(n => +n.toFixed(9)).join(' ')})`;

// ── Materials ────────────────────────────────────────────────────────

/** Every pen a ply uses (its own and its cut ink) must read on its paper, by the catalog's pen id = ink id. */
export function checkInksRead(ply: PlySpec): void {
  const bad: string[] = [];
  for (const ink of new Set([...ply.pens, ply.cutInk])) {
    let reads: boolean;
    try { reads = inkReads(ink, ply.paper.id); } catch (error) { bad.push(`${ink} on ${ply.paper.id}: ${(error as Error).message}`); continue; }
    if (!reads) bad.push(`ink ${ink} does not read on paper ${ply.paper.id}`);
  }
  if (bad.length) throw new Error(`ply ${ply.id}: ${bad.join('; ')}`);
}
