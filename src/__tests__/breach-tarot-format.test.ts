import { describe, expect, it } from 'vitest';
import { TABLOID_PAGE, TALL_ART } from '../../sketches/phase-garden/poster.ts';
import {
  CARD, FORMAT, FRAME, HORIZON_Y, PAGE, PITCH_SCALE, SHEET, TABLOID_FORMAT, assertFormatPage, depthRaster, fitFov, formatFor,
  halo, layoutLength, layoutX, layoutY, tolerance,
} from '../../sketches/kit/format.ts';

describe('Breach Tarot format', () => {
  it('is the tabloid preset without a render target, and that preset is today’s constants', () => {
    expect(FORMAT).toBe(TABLOID_FORMAT);
    expect(PAGE).toBe(TABLOID_PAGE);
    expect(PAGE).toEqual({ width: 279.4, height: 431.8, margin: 18, paper: '#f4f0e6' });
    // The card rect and horizon as card.ts defined them before the format module existed.
    const before = {
      x0: TALL_ART.x, x1: TALL_ART.x + TALL_ART.width,
      top: TALL_ART.y, bottom: TALL_ART.y + TALL_ART.height,
      y0: TALL_ART.y + 24, y1: TALL_ART.y + TALL_ART.height - 24,
    };
    for (const key of Object.keys(before) as (keyof typeof before)[]) expect(Object.is(CARD[key], before[key])).toBe(true);
    expect(Object.keys(CARD)).toEqual(Object.keys(before));
    expect(Object.is(HORIZON_Y, before.y0 + 0.6 * (before.y1 - before.y0))).toBe(true);
    expect(FRAME).toEqual({ rule: 1.2, numeral: { height: 8, tracking: 2.2 }, name: { height: 6.5, tracking: 3.2 }, phraseHeight: 2.2 });
    expect(PITCH_SCALE).toBe(1);
    expect(SHEET).toEqual({ x: 1, y: 1 });
    expect(FORMAT.phrase).toBe('art');
  });

  it('leaves every tabloid measurement exactly as authored', () => {
    for (const [w, h] of [[559, 864], [1118, 1728]]) {
      expect(depthRaster(w, h)).toEqual({ W: w, H: h, MM_X: TABLOID_PAGE.width / w, MM_Y: TABLOID_PAGE.height / h });
    }
    for (const v of [0, 0.1, 0.4, 18, 42.37, 139.7, 250.68, 261.4, 389.8, 1e-9]) {
      expect(layoutX(v)).toBe(v);
      expect(layoutY(v)).toBe(v);
      expect(layoutLength(v)).toBe(v);
      expect(halo(v)).toBe(v);
      expect(tolerance(v)).toBe(v);
    }
    expect(fitFov(54)).toBe(54);
    expect(() => assertFormatPage(undefined)).not.toThrow();
    expect(() => assertFormatPage({ width: 279.4, height: 431.8 })).not.toThrow();
    expect(() => assertFormatPage({ width: 70, height: 120 })).toThrow(/70 × 120/);
  });

  it('a tabloid-sized page, whatever its margin or paper, is the preset itself', () => {
    expect(formatFor({ ...TABLOID_PAGE, paper: '#17181a' })).toBe(TABLOID_FORMAT);
    expect(formatFor({ width: 279.4, height: 431.8 }, { fit: 'width' })).toBe(TABLOID_FORMAT);
    const banded = formatFor(TABLOID_PAGE, { phrase: 'band' });
    expect(banded).not.toBe(TABLOID_FORMAT);
    expect(banded).toMatchObject({ tabloid: true, card: TABLOID_FORMAT.card, phrase: 'band' });
  });

  it('lays a 70 x 120 mm card out in tabloid proportions under one scale', () => {
    const page = { width: 70, height: 120, margin: 4.51, paper: '#f4f0e6' };
    const f = formatFor(page);
    const s = 120 / 431.8;
    expect(f).toMatchObject({ name: '70x120', tabloid: false, fit: 'height', phrase: 'band', minSpacing: 0.5 });
    expect(f.s).toBeCloseTo(s, 12);
    expect(f.pitchScale).toBeCloseTo(1 / s, 12);
    expect(f.card.x0).toBeCloseTo(18 * 70 / 279.4, 9);
    expect(f.card.x1 - f.card.x0).toBeCloseTo(61, 0);
    expect(f.card.y1 - f.card.y0).toBeCloseTo(97.6, 1);
    expect(f.horizonY).toBeCloseTo(f.card.y0 + 0.6 * (f.card.y1 - f.card.y0), 12);
    expect(f.frame.numeral.height).toBeCloseTo(8 * s, 12);
    expect(f.frame.name.height).toBeCloseTo(6.5 * s, 12);
    expect(f.frame.phraseHeight).toBe(1.6);
    const wide = formatFor(page, { fit: 'width', pen: 0.1 });
    expect(wide.s).toBeCloseTo(70 / 279.4, 12);
    expect(wide.minSpacing).toBeCloseTo(0.2, 12);
    expect(wide.pens.find(pen => pen.id === 'carbon')!.width).toBe(0.1);
    expect(() => formatFor(page, { fit: 'diagonal' })).toThrow(/fit/);
    expect(() => formatFor(page, { colour: 'red' })).toThrow(/Unknown format option/);
  });
});
