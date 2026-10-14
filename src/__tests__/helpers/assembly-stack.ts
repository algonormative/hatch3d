import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
