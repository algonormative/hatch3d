import type { Pen } from './types.ts';

/**
 * The physical materials of an assembly: the papers its plies are cut from and the inks they are drawn with.
 * Ids are safe pen and ply ids, so an ink's id is its pen id (see `inkPen`) and a paper's id names a ply's paper.
 */
export interface Paper { id: string; label: string; color: string }
/**
 * `reads` lists the papers the ink shows up on well; `trial` the papers it is still being tried on (not yet trusted).
 * `width` is the line width in millimetres the art is drawn and cut-guided with. `pen` is the physical pen, as the
 * barrel names it (line, size, colour), and `nominal` the maker's line width in millimetres, where it is known: the
 * calibration plot prints both beside each ink, and its measurements replace `width`.
 */
export interface Ink { id: string; label: string; color: string; width: number; reads: string[]; trial?: string[]; note?: string; pen?: string; nominal?: number }

export const PAPERS: Record<string, Paper> = {
  black: { id: 'black', label: 'Black', color: '#141416' },
  'gold-yellow': { id: 'gold-yellow', label: 'Gold-yellow', color: '#e0b13a' },
  white: { id: 'white', label: 'White', color: '#f7f6f2' },
};

const PLACEHOLDER = 'width is a placeholder until the calibration plot';
type GelOptions = { reads?: string[]; trial?: string[]; nominal?: number };
const gel = (id: string, label: string, color: string, pen: string, { reads = ['black'], trial, nominal }: GelOptions = {}): Ink =>
  ({ id, label, color, width: 0.5, reads, ...(trial ? { trial } : {}), note: PLACEHOLDER, pen, ...(nominal ? { nominal } : {}) });
/** Sakura Gelly Roll Moonlight 10: a 1.0 mm ball, a 0.5 mm line. Uni-ball Signo (UM-153): sold as 1.0 mm, its line narrower; the calibration measures it. */
const moonlight = (id: string, label: string, color: string, colour: string, options: GelOptions = {}): Ink =>
  gel(id, label, color, `Moonlight 10 ${colour}`, { nominal: 0.5, ...options });
const signo = (id: string, label: string, color: string, colour: string, trial: string[]): Ink => gel(id, label, color, `Signo 1.0mm ${colour}`, { trial });

export const INKS: Record<string, Ink> = {
  gold: signo('gold', 'Gold gel', '#c9a54a', 'gold', ['gold-yellow']),
  silver: signo('silver', 'Silver gel', '#c4c8cc', 'silver', ['white']),
  'fluoro-pink': moonlight('fluoro-pink', 'Fluoro pink gel', '#ff4fa3', 'fl pink', { trial: ['white'] }),
  'fluoro-orange': moonlight('fluoro-orange', 'Fluoro orange gel', '#ff8a2a', 'fl orange', { trial: ['white'] }),
  'fluoro-green': moonlight('fluoro-green', 'Fluoro green gel', '#7dff5a', 'green'),
  'fluoro-yellow': moonlight('fluoro-yellow', 'Fluoro yellow gel', '#f2ff3a', 'fl yellow'),
  'fluoro-vermilion': moonlight('fluoro-vermilion', 'Fluoro vermilion gel', '#ff5a36', 'fl vermilion'),
  // The Moonlight colours that are not fluorescent: tried on black before they are trusted.
  'gel-red': moonlight('gel-red', 'Red gel', '#e8344e', 'red', { reads: [], trial: ['black'] }),
  'gel-rose': moonlight('gel-rose', 'Rose gel', '#e0409c', 'rose', { reads: [], trial: ['black'] }),
  'gel-purple': moonlight('gel-purple', 'Purple gel', '#8a4fd6', 'purple', { reads: [], trial: ['black'] }),
  'gel-blue': moonlight('gel-blue', 'Blue gel', '#3a6fe0', 'blue', { reads: [], trial: ['black'] }),
  'gel-teal': moonlight('gel-teal', 'Teal gel', '#1fb5a8', 'teal', { reads: [], trial: ['black'] }),
  // Nick's white gel pens are touchy; the Signo is tried first.
  'gel-white': gel('gel-white', 'White gel', '#f4f3ee', 'Signo 1.0mm white', { reads: [], trial: ['black'] }),
  black: { id: 'black', label: 'Black fineliner', color: '#1c1c1e', width: 0.35, reads: ['gold-yellow', 'white'], pen: 'Micron 08 black', nominal: 0.5 },
  // The Breach cards' own inks (the colours and the 0.25 mm art pen of `sketches/kit/format.ts`), and the Pigma Micron
  // drawing each; vermilion and acid have no pen yet.
  carbon: { id: 'carbon', label: 'Carbon', color: '#22282c', width: 0.25, reads: ['white', 'gold-yellow'], pen: 'Micron 01 black', nominal: 0.25 },
  ultramarine: { id: 'ultramarine', label: 'Ultramarine', color: '#3c49aa', width: 0.25, reads: ['white'], trial: ['gold-yellow'], pen: 'Micron 05 blue', nominal: 0.45 },
  vermilion: { id: 'vermilion', label: 'Vermilion', color: '#d04b3c', width: 0.25, reads: ['white'] },
  acid: { id: 'acid', label: 'Acid', color: '#a5a938', width: 0.25, reads: ['white'] },
  violet: { id: 'violet', label: 'Violet', color: '#776090', width: 0.25, reads: ['white'], trial: ['gold-yellow'], pen: 'Micron 05 purple', nominal: 0.45 },
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

/** Is the ink still on trial on the paper (listed in the ink's `trial`, not in its `reads`)? Throws for an unknown ink or paper. */
export function inkOnTrial(ink: string, paper: string): boolean {
  if (!own(INKS, ink)) throw new Error(`Unknown ink: ${ink}`);
  if (!own(PAPERS, paper)) throw new Error(`Unknown paper: ${paper}`);
  return !INKS[ink].reads.includes(paper) && (INKS[ink].trial ?? []).includes(paper);
}
