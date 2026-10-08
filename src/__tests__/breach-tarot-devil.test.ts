import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { renderSketch } from '../../cli/sketch/runner.ts';
import { CARD } from '../../sketches/breach-tarot/card.ts';
import { devilLayout } from '../../sketches/breach-tarot/xv-devil/layout.ts';

const entry = resolve('sketches/breach-tarot/xv-devil/sketch.ts');

type Pt = { x: number; y: number };
type Part = { id: string; paths: Pt[][] };

/** The runner's own seeded stream, so the layout here is the layout of a seed-1 render. */
function randomStream(seed: number, id: string): () => number {
  const digest = createHash('sha256').update(`${seed}\0${id}`).digest();
  let state = digest.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What each leash says about itself, from the route the card draws: its length against the straight line between its ends, and its lowest point. */
function leashes(params: Record<string, number> = {}) {
  const { routes } = devilLayout({ params, seed: 1, assets: {}, random: (id: string) => randomStream(1, id) } as never);
  return routes.map(route => {
    // From where it leaves the pillar (the point before it, inside the cap, is hidden) to the wrist.
    const visible = route.slice(1);
    const curve = new THREE.CatmullRomCurve3(visible, false, 'centripetal');
    const ends = [visible[0], visible[visible.length - 1]];
    const lowest = Math.min(...Array.from({ length: 401 }, (_, i) => curve.getPointAt(i / 400).y));
    return { stretch: curve.getLength() / ends[0].distanceTo(ends[1]), lowest, endsY: ends.map(p => p.y) };
  });
}
type Leash = ReturnType<typeof leashes>[number];
/** Slack, in three parts: at least 1.4 times as long as the straight line, its lowest point on the ground, and clear below both its ends. */
const longEnough = (l: Leash) => l.stretch >= 1.4;
const onGround = (l: Leash) => l.lowest > -0.3 && l.lowest < 0.4;
const belowEnds = (l: Leash) => l.endsY.every(y => y - l.lowest > 1);

const box = (parts: Part[], id: string) => {
  const points = parts.find(p => p.id === id)!.paths.flat();
  return { x0: Math.min(...points.map(p => p.x)), x1: Math.max(...points.map(p => p.x)), y0: Math.min(...points.map(p => p.y)), y1: Math.max(...points.map(p => p.y)) };
};
/** The two door frames mirror each other about the card's centre line: each one's extent is the other's reflected, within 2 mm. */
const mirrored = (parts: Part[]) => {
  const left = box(parts, 'door-left-carbon'), right = box(parts, 'door-right-carbon'), mid = (CARD.x0 + CARD.x1) / 2;
  return [left.x0 - (2 * mid - right.x1), left.x1 - (2 * mid - right.x0), left.y0 - right.y0, left.y1 - right.y1].every(d => Math.abs(d) <= 2);
};

describe('Breach Tarot: XV The Devil', () => {
  it('replays, stays inside the card, and draws the sky, the shadow, the pillar, both doors, both leashes, the figures, the echo, the phrase and the frame', async () => {
    const first = await renderSketch({ entry, seed: 1 });
    const replay = await renderSketch({ entry, seed: 1 });
    expect(replay.identity).toBe(first.identity);
    expect(first.diagnostics).toEqual([]);
    for (const part of first.parts) for (const path of part.paths) for (const p of path) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(CARD.x0 - 0.01);
      expect(p.x).toBeLessThanOrEqual(CARD.x1 + 0.01);
      expect(p.y).toBeGreaterThanOrEqual(CARD.top - 0.01);
      expect(p.y).toBeLessThanOrEqual(CARD.bottom + 0.01);
    }
    const ids = first.parts.map(p => p.id);
    for (const id of ['sky-carbon', 'shadow-carbon', 'pillar-carbon', 'door-left-carbon', 'door-right-carbon', 'figure-carbon', 'echo-acid', 'horizon-carbon', 'slogan-lettering', 'card-frame']) expect(ids).toContain(id);
    for (const side of ['left', 'right']) expect(ids.some(id => id.startsWith(`leash-${side}-`))).toBe(true);
  }, 60_000);

  it('is slack and frontal: each leash is 1.4 times its straight length and lies on the ground below both its ends, and the doors mirror about the centre line', async () => {
    for (const leash of leashes()) {
      expect(longEnough(leash)).toBe(true);
      expect(onGround(leash)).toBe(true);
      expect(belowEnds(leash)).toBe(true);
    }
    // A taut leash, the same cord pulled straight from the pillar to the wrist, fails all three.
    for (const leash of leashes({ leashSag: 0 })) {
      expect(longEnough(leash)).toBe(false);
      expect(onGround(leash)).toBe(false);
      expect(belowEnds(leash)).toBe(false);
    }
    const level = await renderSketch({ entry, seed: 1 });
    expect(mirrored(level.parts)).toBe(true);
    // One door moved 8 mm toward the pillar is no longer the other's reflection.
    expect(mirrored((await renderSketch({ entry, seed: 1, params: { doorShift: -8 } })).parts)).toBe(false);
  }, 120_000);
});
