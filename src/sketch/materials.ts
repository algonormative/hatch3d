import type { Pen } from './types.ts';

/**
 * The physical materials of an assembly: the papers its plies are cut from and the inks they are drawn with.
 * Ids are safe pen and ply ids, so an ink's id is its pen id (see `inkPen`) and a paper's id names a ply's paper.
 *
 * What each pen does on each paper was measured on the assembly calibration plotted 2026-10-17 (R13); see `Measured`
 * and `limitsOn`. Three things hold for every pen, beyond the per-pen numbers: a label at 1.5 mm cap height or smaller
 * is illegible in every pen except the Micron 01 and 05; a hand knife cut lands within about 0.5 mm of its guide, so
 * art keeps 1.0 to 1.5 mm from a cut; and sheets register within 1.3 mm.
 */
export interface Paper { id: string; label: string; color: string }
/** The papers there are (the keys of `PAPERS`), which the measurements are keyed by. */
export type PaperId = 'black' | 'gold-yellow' | 'white';
/**
 * One ink on one paper, as the calibration plot measured it. `width` is the line width in millimetres, left out where
 * the pen's lines fused in the width test, so that only "at least 0.55" is known (a quirk then says so). Pitches are
 * centre to centre: lines drawn parallel at `cleanPitch` or wider stay apart and clean (hatch, a doubled or tripled
 * outline), and at `fusePitch` or closer they run together. `minSans` and `minScript` are the smallest cap heights
 * (mm) of the stroke fonts that read; `minDash` is the shortest dash that comes out clean (with the gap the same);
 * `minRadius` the smallest open circle that stays open. `quirks` are what a pen does that a number does not say.
 */
export interface Measured {
  width?: number; cleanPitch: number; fusePitch: number; minSans: number; minScript: number; minDash: number; minRadius: number;
  quirks?: string[]; source: string;
}
/**
 * `reads` lists the papers the ink shows up on well; `trial` the papers it is still being tried on (not yet trusted).
 * `width` is the line width in millimetres the art is drawn and cut-guided with. `pen` is the physical pen, as the
 * barrel names it (line, size, colour), and `nominal` the maker's line width in millimetres, where it is known: the
 * calibration plot prints both beside each ink, and its measurements replace `width`. `measured` holds those
 * measurements per paper, for the papers the ink was plotted on. The gels' `width` is their measured width on black
 * (their reading paper); the Microns keep the width the Breach cards were drawn with, and their measured widths live
 * only in `measured`.
 */
export interface Ink {
  id: string; label: string; color: string; width: number; reads: string[]; trial?: string[]; note?: string; pen?: string; nominal?: number;
  measured?: Partial<Record<PaperId, Measured>>;
  /** A gel pen. Gels starve after a dense fill and skip until they recover, which a stack's `defaults.prime` answers with a priming stroke. */
  gel?: boolean;
  /**
   * The pen-down speed in percent (1 to 100, as axicli's `--speed_pendown`) that finalize asks plotter-server for on this
   * ink's layers when the stack sets `defaults.gelSpeed`; without it the job's speed applies (the AxiDraw default, 25).
   * Provisional: chosen, not measured.
   */
  speedPendown?: number;
}

export const PAPERS: Record<string, Paper> = {
  black: { id: 'black', label: 'Black', color: '#141416' },
  'gold-yellow': { id: 'gold-yellow', label: 'Gold-yellow', color: '#e0b13a' },
  white: { id: 'white', label: 'White', color: '#f7f6f2' },
  // Hot magenta stock, for the plies behind a black sheet (Kawaii Aggro); not yet calibrated.
  magenta: { id: 'magenta', label: 'Magenta', color: '#d01f72' },
};

// ── Measurements (assembly calibration R13) ──────────────────────────

const R13 = 'assembly calibration R13, 2026-10-17';
type Reading = Omit<Measured, 'source'>;
type MeasuredTable = Partial<Record<PaperId, Measured>>;
const measure = (reading: Reading): Measured => ({ ...reading, source: R13 });

/** Every gel pen on black came out the same but for its width: clean at 0.8 mm pitch, fused at 0.55 and under. */
const GEL = { cleanPitch: 0.8, fusePitch: 0.55, minSans: 2.6, minScript: 3.5, minDash: 1.0, minRadius: 1.0 };
const GEL_SPREADS = 'gel ink spreads; solid fills pool';
const NO_WIDTH = 'line width not measured';
const SCRIPT_READS = 'script reads from 3.5 mm cap height, clean from 5 mm';
const onBlack = (width: number, ...quirks: string[]): MeasuredTable => ({ black: measure({ ...GEL, width, quirks: [...quirks, SCRIPT_READS, GEL_SPREADS] }) });
/** The same table with the fluorescent gel's reading on white, where it is on trial. */
const withWhite = (table: MeasuredTable, ...quirks: string[]): MeasuredTable => ({ ...table, white: measure({ ...GEL, quirks: [...quirks, NO_WIDTH, GEL_SPREADS] }) });

/** The Micron 05 blue and purple read alike on white and gold-yellow: clean at 0.66 mm, fused at 0.5 and under. */
const MICRON_05 = { cleanPitch: 0.66, fusePitch: 0.5, minSans: 2.0, minScript: 3.5, minDash: 1.0, minRadius: 1.0 };
/** The Micron 08 fused in the width test (a 0.6 mm hatch), so its width is only known to be at least 0.55 mm. */
const MICRON_08 = { cleanPitch: 0.8, fusePitch: 0.66, minSans: 2.6, minScript: 3.5, minDash: 1.0, minRadius: 1.0 };
const FUSED_WIDTH = 'fused in the width test at 0.6 mm pitch: the line is at least 0.55 mm wide';

const SIGNO_GOLD: MeasuredTable = {
  ...onBlack(0.39),
  'gold-yellow': measure({ ...GEL, width: 0.44, quirks: ['very low contrast (about 40% of Micron 08): texture only, never line work or labels', GEL_SPREADS] }),
};
const SIGNO_SILVER: MeasuredTable = {
  ...onBlack(0.42, 'starves after dense fills: skipped mid-run after a 0.3 mm strip'),
  white: measure({
    ...GEL, cleanPitch: 1.0, fusePitch: 0.66, quirks: ['low contrast and grainy on white; skips; does not belong on white', NO_WIDTH, GEL_SPREADS],
  }),
};
const MICRON_08_BLACK: MeasuredTable = {
  'gold-yellow': measure({ ...MICRON_08, quirks: [FUSED_WIDTH] }),
  white: measure({ ...MICRON_08, quirks: [FUSED_WIDTH] }),
};
const MICRON_01_BLACK: MeasuredTable = {
  white: measure({ width: 0.30, cleanPitch: 0.5, fusePitch: 0.4, minSans: 2.0, minScript: 3.5, minDash: 0.5, minRadius: 0.5, quirks: ['keeps the 0.8 mm cross and the r 0.5 mm circle open'] }),
};
const MICRON_05_BLUE: MeasuredTable = {
  white: measure({ ...MICRON_05, width: 0.37 }),
  'gold-yellow': measure({ ...MICRON_05, width: 0.36, quirks: ['reads as dark teal-green on gold-yellow, not blue'] }),
};
const MICRON_05_PURPLE: MeasuredTable = {
  white: measure({ ...MICRON_05, quirks: [NO_WIDTH] }),
  'gold-yellow': measure({ ...MICRON_05, width: 0.46, quirks: ['reads as dark brown on gold-yellow'] }),
};

// ── Inks ─────────────────────────────────────────────────────────────

const PLACEHOLDER = 'width is a placeholder until the calibration plot';
/** Provisional pen-down speed for every gel ink (percent): below the AxiDraw default of 25, chosen rather than measured. */
const GEL_SPEED_PENDOWN = 15;
type GelOptions = { reads?: string[]; trial?: string[]; nominal?: number; measured?: MeasuredTable };
/**
 * A gel pen: drawn at its measured width on black where there is one, else at a placeholder width (and noted as such);
 * marked `gel`, with the provisional `speedPendown` a stack that opts in plots it at.
 */
const gel = (id: string, label: string, color: string, pen: string, { reads = ['black'], trial, nominal, measured }: GelOptions = {}): Ink => {
  const width = measured?.black?.width;
  return { id, label, color, width: width ?? 0.5, reads, ...(trial ? { trial } : {}), ...(width === undefined ? { note: PLACEHOLDER } : {}), pen, ...(nominal ? { nominal } : {}), ...(measured ? { measured } : {}), gel: true, speedPendown: GEL_SPEED_PENDOWN };
};
/** Sakura Gelly Roll Moonlight 10: a 1.0 mm ball, a 0.5 mm line. Uni-ball Signo (UM-153): sold as 1.0 mm, its line narrower; the calibration measures it. */
const moonlight = (id: string, label: string, color: string, colour: string, options: GelOptions = {}): Ink =>
  gel(id, label, color, `Moonlight 10 ${colour}`, { nominal: 0.5, ...options });
const signo = (id: string, label: string, color: string, colour: string, trial: string[], measured: MeasuredTable): Ink => gel(id, label, color, `Signo 1.0mm ${colour}`, { trial, measured });

const GOLD = signo('gold', 'Gold gel', '#c9a54a', 'gold', ['gold-yellow'], SIGNO_GOLD);
export const INKS: Record<string, Ink> = {
  gold: GOLD,
  // The gold gel again, as a layer of its own: a fill a sheet may plot or leave out, apart from its gold line work. The
  // same pen, so the same readings.
  'gold-fill': { ...GOLD, id: 'gold-fill', label: 'Gold gel (a layer of its own)' },
  silver: signo('silver', 'Silver gel', '#c4c8cc', 'silver', ['white'], SIGNO_SILVER),
  'fluoro-pink': moonlight('fluoro-pink', 'Fluoro pink gel', '#ff4fa3', 'fl pink', { trial: ['white'], measured: withWhite(onBlack(0.45)) }),
  'fluoro-orange': moonlight('fluoro-orange', 'Fluoro orange gel', '#ff8a2a', 'fl orange', {
    trial: ['white'], measured: withWhite(onBlack(0.39, 'strip streaky at one end'), 'pen-down blob at the first corner'),
  }),
  'fluoro-green': moonlight('fluoro-green', 'Fluoro green gel', '#7dff5a', 'green', { measured: onBlack(0.39, 'strip fades at one end') }),
  'fluoro-yellow': moonlight('fluoro-yellow', 'Fluoro yellow gel', '#f2ff3a', 'fl yellow', { measured: onBlack(0.39) }),
  'fluoro-vermilion': moonlight('fluoro-vermilion', 'Fluoro vermilion gel', '#ff5a36', 'fl vermilion', { measured: onBlack(0.43) }),
  // The Moonlight colours that are not fluorescent: tried on black before they are trusted.
  'gel-red': moonlight('gel-red', 'Red gel', '#e8344e', 'red', { reads: [], trial: ['black'], measured: onBlack(0.30) }),
  'gel-rose': moonlight('gel-rose', 'Rose gel', '#e0409c', 'rose', { reads: [], trial: ['black'], measured: onBlack(0.34) }),
  'gel-purple': moonlight('gel-purple', 'Purple gel', '#8a4fd6', 'purple', { reads: [], trial: ['black'], measured: onBlack(0.35) }),
  'gel-blue': moonlight('gel-blue', 'Blue gel', '#3a6fe0', 'blue', { reads: [], trial: ['black'], measured: onBlack(0.32) }),
  'gel-teal': moonlight('gel-teal', 'Teal gel', '#1fb5a8', 'teal', { reads: [], trial: ['black'], measured: onBlack(0.24, 'thin, starved-looking') }),
  // Nick's copper gel: its make is not recorded yet, and it is tried on black before it is trusted.
  copper: gel('copper', 'Copper gel', '#c07a4a', 'Copper gel', { reads: [], trial: ['black'] }),
  // Nick's white gel pens are touchy; the Signo is tried first.
  'gel-white': gel('gel-white', 'White gel', '#f4f3ee', 'Signo 1.0mm white', { reads: [], trial: ['black'], measured: onBlack(0.36, 'streaky dropouts in fills; fine as lines') }),
  black: { id: 'black', label: 'Black fineliner', color: '#1c1c1e', width: 0.35, reads: ['gold-yellow', 'white'], trial: ['magenta'], pen: 'Micron 08 black', nominal: 0.5, measured: MICRON_08_BLACK },
  // The Breach cards' own inks (the colours and the 0.25 mm art pen of `sketches/kit/format.ts`), and the Pigma Micron
  // drawing each; vermilion and acid have no pen yet.
  carbon: { id: 'carbon', label: 'Carbon', color: '#22282c', width: 0.25, reads: ['white', 'gold-yellow'], pen: 'Micron 01 black', nominal: 0.25, measured: MICRON_01_BLACK },
  ultramarine: { id: 'ultramarine', label: 'Ultramarine', color: '#3c49aa', width: 0.25, reads: ['white'], trial: ['gold-yellow'], pen: 'Micron 05 blue', nominal: 0.45, measured: MICRON_05_BLUE },
  vermilion: { id: 'vermilion', label: 'Vermilion', color: '#d04b3c', width: 0.25, reads: ['white'] },
  acid: { id: 'acid', label: 'Acid', color: '#a5a938', width: 0.25, reads: ['white'] },
  violet: { id: 'violet', label: 'Violet', color: '#776090', width: 0.25, reads: ['white'], trial: ['gold-yellow'], pen: 'Micron 05 purple', nominal: 0.45, measured: MICRON_05_PURPLE },
};

const own = (table: object, id: string): boolean => Object.prototype.hasOwnProperty.call(table, id);

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

/**
 * What the calibration measured for the ink on the paper; undefined where it was not plotted. Unlike `inkReads` this does
 * not throw for an unknown id: a pen id a sketch made up simply has no measurements.
 */
export function measuredOn(ink: string, paper: string): Measured | undefined {
  if (!own(INKS, ink)) return undefined;
  const table = INKS[ink].measured;
  return table && own(table, paper) ? table[paper as PaperId] : undefined;
}

/** The numbers a check needs of a pen on a paper (`Measured` without the width, quirks and source), and whether they were measured. */
export interface Limits { cleanPitch: number; fusePitch: number; minSans: number; minScript: number; minDash: number; minRadius: number; measured: boolean }
/** What `limitsOn` assumes for an ink and paper that were not measured together: the worst of the gels on black. */
export const DEFAULT_LIMITS: Omit<Limits, 'measured'> = { cleanPitch: 0.8, fusePitch: 0.55, minSans: 2.6, minScript: 3.5, minDash: 1.0, minRadius: 1.0 };

/** The ink's measured limits on the paper, or the conservative `DEFAULT_LIMITS` flagged `measured: false` where it was not plotted. */
export function limitsOn(ink: string, paper: string): Limits {
  const m = measuredOn(ink, paper);
  if (!m) return { ...DEFAULT_LIMITS, measured: false };
  const { cleanPitch, fusePitch, minSans, minScript, minDash, minRadius } = m;
  return { cleanPitch, fusePitch, minSans, minScript, minDash, minRadius, measured: true };
}
