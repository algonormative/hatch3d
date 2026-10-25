import { describe, expect, it } from 'vitest';
import { CUT_RATES, cutEffort, describeCutEffort } from '../../cli/cut-effort.ts';

const square = (x: number, y: number, s: number) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];

describe('cut effort', () => {
  it('counts outlines, length and corners, and the narrowest window and bridge', () => {
    // A 10 mm and a 4 mm square window, 3 mm of paper between them, one given closed (its first point repeated).
    const big = square(0, 0, 10), small = square(13, 0, 4);
    const e = cutEffort([big, [...small, small[0]]]);
    expect(e.pieces).toBe(2);
    expect(e.lengthMm).toBe(56);
    expect(e.corners).toBe(8);
    expect(e.narrowestWindowMm).toBeCloseTo(4, 0);
    expect(e.narrowestBridgeMm).toBeCloseTo(3, 5);
    expect(e.narrowestBridgeAt!.x === 10 || e.narrowestBridgeAt!.x === 13).toBe(true);
    expect(e.minutes).toBeCloseTo((56 / CUT_RATES.mmPerSecond + 8 * CUT_RATES.secondsPerCorner + 2 * CUT_RATES.secondsPerPiece) / 60, 1);
    expect(describeCutEffort(e)).toContain('2 outlines');
  });

  it('reads a ring inside another as kept paper: the bridge is the island\'s margin, the window the band round it', () => {
    const e = cutEffort([square(0, 0, 20), square(6, 6, 8)]);
    expect(e.narrowestBridgeMm).toBeCloseTo(6, 5);
    // The band is 6 mm wide along its sides; the largest circle fits in its corners: 2·6/(1+1/√2) ≈ 7.03 mm.
    expect(e.narrowestWindowMm).toBeCloseTo(7.03, 0);
  });

  it('is empty for no cuts', () => {
    expect(cutEffort([])).toEqual({ pieces: 0, lengthMm: 0, corners: 0, minutes: 0 });
  });
});
