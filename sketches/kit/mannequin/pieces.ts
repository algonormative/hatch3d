import * as THREE from 'three';
import { facetStrokes, slabGeometry, solid, type Slab } from '../slabs.ts';
import { LOOK, type Look, type ToneEnv } from './hatch.ts';
import { contourTube } from './body.ts';
import type { JointName, Side, Skeleton } from './skeleton.ts';
import { Tube, silhouettes, type ClothStroke, type ViewEnv } from './tube.ts';

/**
 * Pieces worn or held: abstract postmodern outfit parts fixed to bones (slab pauldrons, cone sleeves,
 * a disc collar, a stepped plinth skirt, after the Triadic Ballet's geometry), and props held at the
 * hands (staff, wand, sword, lantern, cup, scales). Every piece is slabs, tubes and plain lines, drawn
 * with the kit's own hatches.
 */
export interface Pieces {
  slabs: Slab[];
  tubes: Tube[];
  lines: THREE.Vector3[][];
  /** Points that give light (a lantern's flame), for cards that light from them. */
  lights: THREE.Vector3[];
}

export const emptyPieces = (): Pieces => ({ slabs: [], tubes: [], lines: [], lights: [] });
export const mergePieces = (...all: Pieces[]): Pieces => ({
  slabs: all.flatMap(p => p.slabs), tubes: all.flatMap(p => p.tubes), lines: all.flatMap(p => p.lines), lights: all.flatMap(p => p.lights),
});

/** A slab placed in a frame: centre, and the frame's x, y, z axes as its width, height and depth. */
function framed(c: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, w: number, h: number, d: number, beat = 0): Slab {
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  const y2 = new THREE.Vector3().crossVectors(z, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x.clone().normalize(), y2, z);
  const e = new THREE.Euler().setFromRotationMatrix(m, 'XYZ');
  const s = solid(c.x, c.y, c.z, w, h, d, beat, 'stub');
  s.rx = e.x; s.ry = e.y; s.rz = e.z;
  return s;
}

// ------------------------------------------------------------------ outfits

export type OutfitPart = 'pauldrons' | 'sleeves' | 'collar' | 'skirt';

export function outfit(s: Skeleton, parts: OutfitPart[] = ['pauldrons', 'sleeves', 'collar', 'skirt']): Pieces {
  const p = emptyPieces();
  const k = s.height / 24;
  const chest = s.axes('chest'), pelvis = s.axes('pelvis');
  if (parts.includes('pauldrons')) for (const side of ['l', 'r'] as Side[]) {
    // Three stacked plates over each shoulder, stepping down the arm.
    const sh = s.at(`shoulder_${side}`), out = chest.x.clone().multiplyScalar(side === 'l' ? 1 : -1);
    for (let i = 0; i < 3; i++) {
      const c = sh.clone().addScaledVector(chest.y, (0.7 - 0.55 * i) * k).addScaledVector(out, (0.2 + 0.35 * i) * k);
      p.slabs.push(framed(c, out, chest.y, (2.6 - 0.45 * i) * k, 0.35 * k, (2.4 - 0.3 * i) * k));
    }
  }
  if (parts.includes('sleeves')) for (const side of ['l', 'r'] as Side[]) {
    // A cone from the shoulder flaring to an open bell past the wrist.
    const j = s.joints.get(`shoulder_${side}`)!, e = s.joints.get(`elbow_${side}`)!;
    p.tubes.push(new Tube(`sleeve_${side}`, [j.origin, e.origin, e.end], [[0, 1.0 * k, 1.0 * k], [0.5, 1.35 * k, 1.35 * k], [1, 2.3 * k, 2.3 * k]],
      s.axes(`shoulder_${side}`).z, side === 'l' ? 1 : -1, [0.6 * k, 0], undefined, 8));
  }
  if (parts.includes('collar')) {
    // A wide flat drum round the neck.
    const n = s.joints.get('neck')!;
    const c = n.origin.clone().addScaledVector(s.axes('neck').y, 0.1 * k);
    p.tubes.push(new Tube('collar', [c.clone().addScaledVector(s.axes('neck').y, -0.18 * k), c, c.clone().addScaledVector(s.axes('neck').y, 0.18 * k)],
      [[0, 3.1 * k, 2.6 * k], [1, 3.1 * k, 2.6 * k]], s.axes('neck').z, 1, [0, 0], undefined, 16));
  }
  if (parts.includes('skirt')) {
    // A stepped plinth: three tiers widening downward from the waist.
    const top = s.at('pelvis').addScaledVector(pelvis.y, 0.8 * k);
    for (let i = 0; i < 3; i++) {
      const c = top.clone().addScaledVector(pelvis.y, -(0.9 + 1.25 * i) * k);
      p.slabs.push(framed(c, pelvis.x, pelvis.y, (5 + 1.6 * i) * k, 1.15 * k, (3.6 + 1.3 * i) * k, 10 + i));
    }
  }
  return p;
}

// ------------------------------------------------------------------ props

export type PropKind = 'staff' | 'wand' | 'sword' | 'lantern' | 'cup' | 'scales';

/** The grip: a point in the palm, the direction toward the fingertips, and the hand's axes. */
export function grip(s: Skeleton, side: Side) {
  const j = s.joints.get(`wrist_${side}` as JointName)!;
  return { at: j.origin.clone().lerp(j.end, 0.55), along: j.end.clone().sub(j.origin).normalize(), axes: s.axes(`wrist_${side}`) };
}

export function prop(s: Skeleton, side: Side, kind: PropKind): Pieces {
  const p = emptyPieces();
  const k = s.height / 24;
  const g = grip(s, side);
  const up = new THREE.Vector3(0, 1, 0);
  const rod = (id: string, from: THREE.Vector3, to: THREE.Vector3, r: number, facets = 6) => {
    const ref = Math.abs(to.clone().sub(from).normalize().y) > 0.9 ? new THREE.Vector3(0, 0, 1) : up;
    p.tubes.push(new Tube(id, [from, from.clone().lerp(to, 0.5), to], [[0, r, r], [1, r, r]], ref, 1, [0, 0], undefined, facets));
  };
  // Held objects run across the palm (the hand's x), so they stand clear of the fingers.
  const across = g.axes.x.clone();
  switch (kind) {
    case 'staff': {
      // Upright, its foot on the ground, its head above the hand.
      const foot = new THREE.Vector3(g.at.x, 0, g.at.z);
      rod('staff', foot, foot.clone().add(new THREE.Vector3(0, Math.max(g.at.y + 4 * k, 0.75 * s.height), 0)), 0.22 * k);
      break;
    }
    case 'wand': {
      // Short, along the line of the hand, bound at both ends.
      const dir = g.along.clone();
      const a = g.at.clone().addScaledVector(dir, -1.6 * k), b = g.at.clone().addScaledVector(dir, 5.2 * k);
      rod('wand', a, b, 0.2 * k, 8);
      for (const end of [a, b]) p.tubes.push(new Tube('wand-knot', [end.clone().addScaledVector(dir, -0.25 * k), end, end.clone().addScaledVector(dir, 0.25 * k)],
        [[0, 0.42 * k, 0.42 * k], [1, 0.42 * k, 0.42 * k]], up, 1, [0.2 * k, 0.2 * k], undefined, 8));
      break;
    }
    case 'sword': {
      // The blade runs on from the fist past the fingertips, a crossguard across it.
      const dir = g.along.clone();
      const hilt = g.at.clone().addScaledVector(dir, 0.6 * k);
      p.slabs.push(framed(hilt.clone().addScaledVector(dir, 5.4 * k), across, dir, 0.75 * k, 9.6 * k, 0.14 * k));
      p.slabs.push(framed(hilt, across, dir, 3.2 * k, 0.32 * k, 0.4 * k));
      p.slabs.push(framed(g.at.clone().addScaledVector(dir, -0.6 * k), across, dir, 0.36 * k, 1.6 * k, 0.36 * k));
      break;
    }
    case 'lantern': {
      // A box hung below the hand on a short line, its light inside.
      const hang = g.at.clone().add(new THREE.Vector3(0, -2.2 * k, 0));
      p.lines.push([g.at.clone(), hang.clone().add(new THREE.Vector3(0, 0.9 * k, 0))]);
      p.slabs.push(framed(hang, new THREE.Vector3(1, 0, 0), up, 1.6 * k, 1.8 * k, 1.6 * k));
      p.slabs.push(framed(hang.clone().add(new THREE.Vector3(0, 1.05 * k, 0)), new THREE.Vector3(1, 0, 0), up, 1.9 * k, 0.28 * k, 1.9 * k));
      p.lights.push(hang);
      break;
    }
    case 'cup': {
      // A goblet standing in the open hand.
      const base = g.at.clone().add(new THREE.Vector3(0, 0.25 * k, 0));
      p.tubes.push(new Tube('cup', [base, base.clone().add(new THREE.Vector3(0, 1.2 * k, 0)), base.clone().add(new THREE.Vector3(0, 2.6 * k, 0))],
        [[0, 0.75 * k, 0.75 * k], [0.12, 0.2 * k, 0.2 * k], [0.45, 0.2 * k, 0.2 * k], [0.62, 0.9 * k, 0.9 * k], [1, 1.15 * k, 1.15 * k]],
        new THREE.Vector3(0, 0, 1), 1, [0, 0], undefined, 0));
      break;
    }
    case 'scales': {
      // A beam across the hand, two pans hung from its ends on three cords each.
      const beamC = g.at.clone().add(new THREE.Vector3(0, 1.6 * k, 0));
      p.lines.push([g.at.clone(), beamC.clone()]);
      const beamDir = new THREE.Vector3(across.x, 0, across.z).normalize();
      p.slabs.push(framed(beamC, beamDir, up, 7.5 * k, 0.28 * k, 0.28 * k));
      for (const end of [-1, 1]) {
        const tip = beamC.clone().addScaledVector(beamDir, end * 3.6 * k);
        const pan = tip.clone().add(new THREE.Vector3(0, -3.4 * k, 0));
        p.tubes.push(new Tube('pan', [pan.clone().add(new THREE.Vector3(0, -0.12 * k, 0)), pan, pan.clone().add(new THREE.Vector3(0, 0.12 * k, 0))],
          [[0, 1.2 * k, 1.2 * k], [1, 1.25 * k, 1.25 * k]], new THREE.Vector3(0, 0, 1), 1, [0, 0], undefined, 0));
        for (let c = 0; c < 3; c++) {
          const a = c / 3 * Math.PI * 2;
          p.lines.push([tip.clone(), pan.clone().add(new THREE.Vector3(Math.cos(a) * 1.15 * k, 0.12 * k, Math.sin(a) * 1.15 * k))]);
        }
      }
      break;
    }
  }
  return p;
}

// ------------------------------------------------------------------ drawing

/** Depth-pass meshes for pieces. */
export function piecesMeshes(p: Pieces, detail = 0.6): THREE.BufferGeometry[] {
  return [...p.slabs.map(slabGeometry), ...p.tubes.map(t => t.mesh(Math.round(120 * detail), t.facets >= 3 ? t.facets * 4 : Math.round(32 * detail)))];
}

/** Draw pieces: slabs in the raking-light facet hatch, tubes in contour rings, lines as edges. */
export function piecesStrokes(p: Pieces, env: ToneEnv & ViewEnv & { eye: THREE.Vector3; light: THREE.Vector3 }, look: Look = LOOK): ClothStroke[] {
  const out: ClothStroke[] = [];
  for (const slab of p.slabs) {
    slab.tone = 0.8;
    for (const st of facetStrokes(slab, env.light, env.eye, false)) out.push({ ink: st.ink, group: st.family === 'edge' ? look.contour : look.figure, family: look.family, points: st.points });
  }
  for (const t of p.tubes) {
    out.push(...contourTube(t, env, look));
    out.push(...silhouettes(t, env, { ink: look.edge, group: look.contour, family: look.family }));
  }
  for (const line of p.lines) out.push({ ink: look.crease, group: look.contour, family: look.family, points: line });
  return out;
}
