import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { finalizePiece, resolveOptions, type Piece, type Stack } from '../../../cli/finalize.ts';
import { lintelL, lintelR } from '../fixtures/assembly-fixture.ts';

/** The two fixture panels as stack pieces: panel L (white and black plies) and panel R (a white ply under an onlay of L's bar). */
export const FIXTURES = 'src/__tests__/fixtures';
export const L = `${FIXTURES}/assembly-lintel-l-sketch.ts`;
export const R = `${FIXTURES}/assembly-lintel-r-sketch.ts`;
export const lSpec = lintelL().assembly!;
export const rSpec = lintelR().assembly!;
export const border = { style: 'cropmarks', pen: 'black' };
export const piece = (name: string, assembly: string, sketch: string, ply: string, params: Record<string, unknown> = {}): Piece => ({ name, assembly, sketch, seed: 1, params: { ply, ...params } });
export const lWhite = piece('lintel-l-white', 'lintel-l', L, 'white');
export const lBlack = piece('lintel-l-black', 'lintel-l', L, 'black');
export const rWhite = piece('lintel-r-white', 'lintel-r', R, 'white');
export const stackIn = (out: string, pieces: Piece[], over: Partial<Stack> = {}): Stack => ({ out, border, pieces, ...over });
export const fresh = () => mkdtempSync(join(tmpdir(), 'assembly-cli-'));
export const finalize = (stack: Stack, p: Piece) => finalizePiece(stack, p, resolveOptions(stack));

/** Every file under `dir` with the sha256 of its bytes, keyed by path: a directory's whole content, for before-and-after comparisons. */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path); else out[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** Runs `cli/finalize.ts run` on a stack as the command line does, whole-stack unless `only` is given. */
export function runFinalize(stack: Stack, only?: string[]): { status: number | null; stdout: string; stderr: string } {
  const path = join(stack.out, '..', `${stack.out.split('/').pop()}-stack.json`);
  writeFileSync(path, JSON.stringify(stack));
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'cli/finalize.ts', 'run', path, ...(only ? ['--only', only.join(',')] : [])], { cwd: process.cwd(), encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}
