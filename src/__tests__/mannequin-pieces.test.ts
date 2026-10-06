import { describe, expect, it } from 'vitest';
import { POSES, poseSkeleton } from '../../sketches/kit/mannequin/skeleton.ts';
import { buildBody } from '../../sketches/kit/mannequin/body.ts';
import { drape, drapeMesh } from '../../sketches/kit/mannequin/drape.ts';
import { grip, outfit, prop } from '../../sketches/kit/mannequin/pieces.ts';

const seeded = (s = 7) => () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };

describe('mannequin drapery', () => {
  it('hangs from the shoulders to the floor, clear of the trunk, flaring toward the hem', () => {
    const b = buildBody(poseSkeleton(POSES.stand));
    const d = drape(b, { rng: seeded() });
    const top = d.grid[0], hem = d.grid.at(-1)!;
    expect(top[0].y).toBeGreaterThan(hem[0].y + 15);
    expect(hem[0].y).toBeLessThan(1);
    const pelvis = b.skeleton.at('pelvis');
    const radius = (row: typeof top) => row.reduce((t, p) => t + Math.hypot(p.x - pelvis.x, p.z - pelvis.z), 0) / row.length;
    expect(radius(hem)).toBeGreaterThan(radius(top));
    expect(d.valleys.length).toBeGreaterThan(3);
  });

  it('opens a cloak at the front, wider at the hem than at the neck', () => {
    const d = drape(buildBody(poseSkeleton(POSES.stand)), { rng: seeded(), open: 1.1 });
    const gap = (row: boolean[]) => row.filter(c => !c).length;
    expect(gap(d.cloth.at(-1)!)).toBeGreaterThan(gap(d.cloth[1]));
    expect(drapeMesh(d).getAttribute('position').count).toBeGreaterThan(1000);
  });

  it('drapes a seated figure forward over the knees', () => {
    const b = buildBody(poseSkeleton(POSES.sit));
    const d = drape(b, { rng: seeded() });
    const knee = b.skeleton.at('knee_l');
    const front = Math.max(...d.grid.flat().map(p => p.z));
    expect(front).toBeGreaterThan(knee.z);
  });
});

describe('mannequin pieces', () => {
  it('fits an outfit of pauldrons, sleeves, collar and stepped skirt to the skeleton', () => {
    const p = outfit(poseSkeleton(POSES.dance));
    expect(p.slabs.length).toBe(6 + 3);
    expect(p.tubes.length).toBe(3);
  });

  it('puts props in the hand: a raised wand runs up past the hand, a lantern gives light below it', () => {
    const s = poseSkeleton(POSES.reach);
    const wand = prop(s, 'r', 'wand');
    const g = grip(s, 'r');
    expect(Math.max(...wand.tubes.map(t => t.centre(1).y))).toBeGreaterThan(g.at.y + 2);
    const lantern = prop(poseSkeleton(POSES.stand), 'r', 'lantern');
    expect(lantern.lights).toHaveLength(1);
    expect(lantern.lights[0].y).toBeLessThan(grip(poseSkeleton(POSES.stand), 'r').at.y);
    for (const kind of ['staff', 'sword', 'cup', 'scales'] as const) {
      const p = prop(s, 'l', kind);
      expect(p.slabs.length + p.tubes.length).toBeGreaterThan(0);
    }
  });
});
