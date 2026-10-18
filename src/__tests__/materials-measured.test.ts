import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, INKS, PAPERS, limitsOn, measuredOn } from '../sketch/materials.ts';

const pairs = Object.values(INKS).flatMap((ink) => Object.entries(ink.measured ?? {}).map(([paper, m]) => ({ ink: ink.id, paper, m: m! })));

describe('measured pen data (assembly calibration R13)', () => {
  it('is keyed by known inks and papers, with sane numbers and a source', () => {
    expect(pairs).toHaveLength(24); // 13 on black, 4 on gold-yellow, 7 on white
    for (const { ink, paper, m } of pairs) {
      const at = `${ink} on ${paper}`;
      expect(Object.keys(PAPERS), at).toContain(paper);
      expect(m.cleanPitch, `${at}: cleanPitch above fusePitch`).toBeGreaterThan(m.fusePitch);
      expect(m.fusePitch, at).toBeGreaterThan(0.3);
      for (const key of ['minSans', 'minScript', 'minDash', 'minRadius'] as const) expect(m[key], `${at} ${key}`).toBeGreaterThan(0);
      if (m.width !== undefined) expect(m.width, `${at} width`).toBeGreaterThan(0.2);
      expect(m.source).toBe('assembly calibration R13, 2026-10-17');
    }
  });

  it('measures only on the papers an ink reads on or is on trial on', () => {
    for (const { ink, paper } of pairs) {
      const { reads, trial = [] } = INKS[ink];
      expect([...reads, ...trial], `${ink} on ${paper}`).toContain(paper);
    }
  });

  it('says why a width is missing', () => {
    for (const { ink, paper, m } of pairs.filter((p) => p.m.width === undefined)) {
      expect(m.quirks?.join(' '), `${ink} on ${paper}`).toMatch(/at least 0\.55 mm wide|width not measured/);
    }
  });

  it('keeps the gels’ drawn width at their measured width on black, and the Microns’ at the cards’ width', () => {
    const gels = Object.values(INKS).filter((ink) => ink.pen?.startsWith('Signo') || ink.pen?.startsWith('Moonlight'));
    expect(gels).toHaveLength(13);
    for (const ink of gels) {
      expect(ink.width, ink.id).toBe(ink.measured?.black?.width);
      expect(ink.note, ink.id).toBeUndefined();
    }
    expect(['carbon', 'ultramarine', 'violet'].map((id) => INKS[id].width)).toEqual([0.25, 0.25, 0.25]);
    expect(INKS.black.width).toBe(0.35);
  });

  it('records spot values from the calibration sheets', () => {
    expect(measuredOn('silver', 'black')).toMatchObject({ width: 0.42, cleanPitch: 0.8, fusePitch: 0.55, minSans: 2.6, minScript: 3.5 });
    expect(measuredOn('silver', 'black')?.quirks).toContain('starves after dense fills: skipped mid-run after a 0.3 mm strip');
    expect(measuredOn('gel-teal', 'black')?.width).toBe(0.24);
    expect(measuredOn('carbon', 'white')).toMatchObject({ width: 0.3, cleanPitch: 0.5, fusePitch: 0.4, minSans: 2.0, minDash: 0.5, minRadius: 0.5 });
    expect(measuredOn('black', 'white')).toMatchObject({ cleanPitch: 0.8, fusePitch: 0.66 });
    expect(measuredOn('black', 'white')?.width).toBeUndefined();
    expect(measuredOn('ultramarine', 'white')).toMatchObject({ width: 0.37, cleanPitch: 0.66, fusePitch: 0.5 });
    expect(measuredOn('violet', 'gold-yellow')).toMatchObject({ width: 0.46 });
    expect(measuredOn('violet', 'gold-yellow')?.quirks).toContain('reads as dark brown on gold-yellow');
    expect(measuredOn('silver', 'white')).toMatchObject({ cleanPitch: 1.0, fusePitch: 0.66 });
    expect(measuredOn('gold', 'gold-yellow')).toMatchObject({ width: 0.44, cleanPitch: 0.8, fusePitch: 0.55 });
    expect(measuredOn('fluoro-orange', 'white')?.quirks).toContain('pen-down blob at the first corner');
  });

  it('answers undefined for an ink that was not plotted on a paper, or an id that is not one', () => {
    expect(measuredOn('gold', 'white')).toBeUndefined();
    expect(measuredOn('carbon', 'black')).toBeUndefined();
    expect(measuredOn('vermilion', 'white')).toBeUndefined();
    expect(measuredOn('nope', 'white')).toBeUndefined();
    expect(measuredOn('gold', 'constructor')).toBeUndefined();
    expect(measuredOn('constructor', 'black')).toBeUndefined();
  });
});

describe('limitsOn', () => {
  it('returns the measured numbers, flagged measured', () => {
    expect(limitsOn('carbon', 'white')).toEqual({ cleanPitch: 0.5, fusePitch: 0.4, minSans: 2.0, minScript: 3.5, minDash: 0.5, minRadius: 0.5, measured: true });
    expect(limitsOn('silver', 'white')).toMatchObject({ cleanPitch: 1.0, fusePitch: 0.66, measured: true });
  });

  it('falls back to the worst gel numbers, flagged unmeasured, for a pair that was not plotted', () => {
    expect(DEFAULT_LIMITS).toEqual({ cleanPitch: 0.8, fusePitch: 0.55, minSans: 2.6, minScript: 3.5, minDash: 1.0, minRadius: 1.0 });
    for (const [ink, paper] of [['gold', 'white'], ['carbon', 'black'], ['vermilion', 'white'], ['structure', 'white'], ['gold', 'unknown-paper']]) {
      expect(limitsOn(ink, paper), `${ink} on ${paper}`).toEqual({ ...DEFAULT_LIMITS, measured: false });
    }
  });
});
