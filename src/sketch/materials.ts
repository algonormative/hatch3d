import type { Pen } from './types.ts';

/**
 * The physical materials of an assembly: the papers its plies are cut from and the inks they are drawn with.
 * Ids are safe pen and ply ids, so an ink's id is its pen id (see `inkPen`) and a paper's id names a ply's paper.
 */
export interface Paper { id: string; label: string; color: string }
/**
 * `reads` lists the papers the ink shows up on well; `trial` the papers it is still being tried on (not yet trusted).
 * `width` is the line width in millimetres.
 */
export interface Ink { id: string; label: string; color: string; width: number; reads: string[]; trial?: string[]; note?: string }

export const PAPERS: Record<string, Paper> = {
  black: { id: 'black', label: 'Black', color: '#141416' },
  'gold-yellow': { id: 'gold-yellow', label: 'Gold-yellow', color: '#e0b13a' },
  white: { id: 'white', label: 'White', color: '#f7f6f2' },
};

const PLACEHOLDER = 'width is a placeholder until the calibration plot';
const gel = (id: string, label: string, color: string, trial?: string[]): Ink => ({ id, label, color, width: 0.5, reads: ['black'], ...(trial ? { trial } : {}), note: PLACEHOLDER });

export const INKS: Record<string, Ink> = {
  gold: gel('gold', 'Gold gel', '#c9a54a', ['gold-yellow']),
  silver: gel('silver', 'Silver gel', '#c4c8cc', ['white']),
  'fluoro-pink': gel('fluoro-pink', 'Fluoro pink gel', '#ff4fa3', ['white']),
  'fluoro-orange': gel('fluoro-orange', 'Fluoro orange gel', '#ff8a2a', ['white']),
  'fluoro-green': gel('fluoro-green', 'Fluoro green gel', '#7dff5a'),
  'fluoro-yellow': gel('fluoro-yellow', 'Fluoro yellow gel', '#f2ff3a'),
  black: { id: 'black', label: 'Black fineliner', color: '#1c1c1e', width: 0.35, reads: ['gold-yellow', 'white'] },
  // The Breach cards' own inks (the colours and the 0.25 mm art pen of `sketches/kit/format.ts`).
  carbon: { id: 'carbon', label: 'Carbon', color: '#22282c', width: 0.25, reads: ['white', 'gold-yellow'] },
  ultramarine: { id: 'ultramarine', label: 'Ultramarine', color: '#3c49aa', width: 0.25, reads: ['white'] },
  vermilion: { id: 'vermilion', label: 'Vermilion', color: '#d04b3c', width: 0.25, reads: ['white'] },
  acid: { id: 'acid', label: 'Acid', color: '#a5a938', width: 0.25, reads: ['white'] },
  violet: { id: 'violet', label: 'Violet', color: '#776090', width: 0.25, reads: ['white'] },
};

const own = (table: Record<string, unknown>, id: string): boolean => Object.prototype.hasOwnProperty.call(table, id);

/** The ink as a pen a sketch can declare: its id, color and width. Throws for an unknown ink. */
export function inkPen(id: string): Pen {
  if (!own(INKS, id)) throw new Error(`Unknown ink: ${id}`);
  const { color, width } = INKS[id];
  return { id, color, width };
}

/** Does the ink read on the paper (not merely being tried on it)? Throws for an unknown ink or paper. */
export function inkReads(ink: string, paper: string): boolean {
  if (!own(INKS, ink)) throw new Error(`Unknown ink: ${ink}`);
  if (!own(PAPERS, paper)) throw new Error(`Unknown paper: ${paper}`);
  return INKS[ink].reads.includes(paper);
}
