import { describe, expect, it } from 'vitest';
import { posterFrame } from '../../sketches/phase-garden/poster.ts';

describe('Phase Garden plotter lettering', () => {
 it('keeps all three poster identities inside their reserved type bands and margins', () => {
  for (const [subtitle,edition] of [['BREACH CATHEDRAL','01'],['CHAMBER BLOOM','02'],['LOAD BEARING SILENCE','03']]) {
   const parts=posterFrame({subtitle,edition});
   expect(parts.flatMap(p=>p.paths).length).toBeGreaterThan(40);
   for (const point of parts.flatMap(p=>p.paths).flat()) {
    expect(Number.isFinite(point.x)&&Number.isFinite(point.y)).toBe(true);
    expect(point.x).toBeGreaterThanOrEqual(18);
    expect(point.x).toBeLessThanOrEqual(279);
    expect(point.y).toBeGreaterThanOrEqual(18);
    expect(point.y).toBeLessThanOrEqual(402);
    expect(point.y<=70||point.y>=367).toBe(true);
   }
  }
 });
});
