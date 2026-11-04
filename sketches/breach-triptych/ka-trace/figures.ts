import slipped from './traces/02a-slipped.json';
import hem from './traces/02c-hem.json';
import collar from './traces/03b-collar.json';
import bob from './traces/03c-magenta-bob.json';
import quiet from './traces/04a-quiet.json';
import close from './traces/04c-close.json';

/**
 * The figures. What each adds to its trace is set in the concept image's pixels (1024 x 1536), so it can be read straight
 * off the image: the body's plates, the visor, the streams of columns.
 */

export type Px = [number, number];
export interface Trace { silver: number[][][]; gold: number[][][]; black: number[][][]; windows: number[][][] }
/** Columns off the line `from`-`to`, running along `dir` (degrees, 0 = to the right, 90 = down the sheet). */
export interface Stream { from: Px; to: Px; dir: number; reachMm: number; backMm?: number; gaps?: number; widths?: number }
/** Where a slogan may go: from `at` along `dir` (degrees), up to `room` mm long; `stack` sets it a word a line at each `lines`. */
export interface SloganSpot { at: Px; dir: number; mm: number; room: number; apart?: boolean; lines?: Px[] }
export interface Figure {
  trace: Trace;
  treated?: boolean;
  /** A visor cut anew, and traced windows it replaces (by index). */
  visor?: Px[]; dropWindows?: number[];
  /** Or the traced windows that are the visor. */
  visorWindows?: number[];
  visorDeg?: number;
  /** Lines of the head the visor hides, drawn on it. */
  under?: Px[][];
  /** The slices' direction, the band of the sheet (the face) they barely move, and how few of them move there (1 = as many as anywhere). */
  sliceDeg?: number; face?: [Px, Px]; faceShare?: number;
  body?: { ring: Px[]; plateMm?: number; angle?: number; flow?: number }[];
  /** Traced windows covered in plates of black ink. */
  colour?: number[]; colourDeg?: number;
  /** Big shapes of colour cut anew, drawn as curves through these points and covered the same way. */
  masses?: Px[][]; massMm?: number;
  streams?: Stream[];
  spots?: Record<string, SloganSpot>;
}

export const FIGURES: Record<string, Figure> = {
  slipped: {
    trace: slipped, treated: true,
    visor: [[268, 252], [618, 178], [618, 240], [268, 315]], visorDeg: -12,
    under: [
      [[300, 300], [322, 290], [352, 288]], [[452, 262], [478, 254], [508, 254]],
      [[292, 276], [326, 266], [362, 264]], [[446, 240], [482, 232], [516, 232]],
    ],
    face: [[0, 210], [0, 420]],
    body: [{ ring: [[420, 405], [437, 480], [443, 545], [400, 568], [330, 590], [305, 640], [318, 735], [345, 700], [420, 665], [510, 648], [590, 660], [628, 700], [625, 790], [600, 870], [640, 850], [690, 700], [700, 620], [680, 570], [600, 550], [545, 520], [530, 400], [505, 380]], plateMm: 24, angle: 70 }],
    colour: [0, 1, 2, 3], colourDeg: 30,
    streams: [
      { from: [618, 150], to: [618, 270], dir: 0, reachMm: 75, backMm: 2 },
      { from: [268, 240], to: [268, 330], dir: 180, reachMm: 52, backMm: 2 },
      { from: [282, 860], to: [282, 1050], dir: 180, reachMm: 56, backMm: 6 },
      { from: [690, 1060], to: [690, 1250], dir: 0, reachMm: 62, backMm: 6 },
    ],
    spots: {
      visor: { at: [292, 282], dir: -12, mm: 5.5, room: 82 },
      mass: { at: [0, 0], dir: 0, mm: 13, room: 90, lines: [[470, 800], [430, 975], [520, 1160], [470, 1380]] },
      stream: { at: [640, 118], dir: 0, mm: 5.5, room: 92, apart: true },
      edge: { at: [62, 1470], dir: -90, mm: 6, room: 300 },
    },
  },
  hem: { trace: hem },
  collar: {
    trace: collar, treated: true,
    visor: [[400, 446], [978, 446], [978, 508], [400, 508]], visorDeg: 12,
    face: [[0, 500], [0, 730]],
    body: [{ ring: [[312, 640], [305, 712], [500, 788], [525, 702], [470, 640]], plateMm: 22, angle: 85 }],
    colour: [6], colourDeg: 35,
    streams: [{ from: [412, 390], to: [412, 650], dir: 180, reachMm: 118, backMm: 2 }],
    spots: {
      visor: { at: [716, 470], dir: 0, mm: 6, room: 66 },
      mass: { at: [0, 0], dir: 0, mm: 16, room: 150, lines: [[300, 1120], [300, 1215], [300, 1310]] },
      stream: { at: [28, 372], dir: 0, mm: 5.5, room: 95, apart: true },
      edge: { at: [962, 1490], dir: -90, mm: 6, room: 230 },
    },
  },
  bob: { trace: bob },
  quiet: { trace: quiet },
  close: {
    trace: close, treated: true,
    visorWindows: [3, 5], visorDeg: 16,
    under: [
      [[636, 508], [670, 524], [706, 526], [734, 516]], [[636, 508], [622, 500]],
      [[846, 552], [876, 566], [906, 568], [928, 560]],
      [[612, 450], [660, 448], [716, 464], [752, 484]], [[838, 498], [884, 508], [924, 526]],
    ],
    sliceDeg: 16, face: [[760, 40], [760, 1000]], faceShare: 0.22,
    body: [
      { ring: [[335, 640], [300, 720], [265, 850], [200, 960], [80, 1140], [380, 1150], [520, 900], [470, 740], [430, 640]], plateMm: 42, angle: 70, flow: 0.55 },
      { ring: [[520, 905], [640, 882], [780, 874], [890, 960], [945, 1060], [905, 1150], [385, 1150]], plateMm: 58, angle: 25, flow: 0.5 },
    ],
    masses: [[[170, 1536], [430, 1352], [720, 1236], [1024, 1176], [1024, 1536]]], massMm: 78, colourDeg: 118,
    streams: [{ from: [190, 268], to: [640, 400], dir: -74, reachMm: 62, backMm: 2, gaps: 0.6, widths: 0.6 }],
    spots: {
      visor: { at: [590, 470], dir: 16, mm: 6, room: 92 },
      mass: { at: [0, 0], dir: 0, mm: 13, room: 150, lines: [[700, 1340], [700, 1440]] },
      stream: { at: [660, 300], dir: -74, mm: 5.5, room: 80, apart: true },
      edge: { at: [40, 1190], dir: -90, mm: 6, room: 280 },
    },
  },
};
