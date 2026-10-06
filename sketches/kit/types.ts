import type * as THREE from 'three';

/** The pens the Breach sketches draw with. Lettering is the finer, separate layer. */
export type Ink = 'carbon' | 'ultramarine' | 'vermilion' | 'acid' | 'violet' | 'lettering';

/** What a 3D stroke is for, so the page pass can treat outlines, fills, helix membrane and words differently. */
export type Family = 'edge' | 'hatch' | 'membrane' | 'text';

/** A world-space stroke tagged for the page pass; `owner` is the index of the solid it belongs to. */
export type Stroke = { ink: Ink; group: string; family: Family; points: THREE.Vector3[]; owner?: number };
