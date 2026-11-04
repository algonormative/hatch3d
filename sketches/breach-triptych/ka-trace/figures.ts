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
export interface Stream { from: Px; to: Px; dir: number; reachMm: number; backMm?: number; gaps?: number; widths?: number; fragments?: number }
/** Where a slogan may go: from `at` along `dir` (degrees), up to `room` mm long; `stack` sets it a word a line at each `lines`. */
export interface SloganSpot { at: Px; dir: number; mm: number; room: number; apart?: boolean; lines?: Px[]; curve?: Px[] }
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
  /** A sculpted face behind the visor, set by the traced nose tip and chin. */
  hidden?: { noseTip: Px; chin: Px; yaw: number; tilt: number };
  /** The visor as its own field: it and its streams slide in slices of their own, and this stays in front of it (the nose). */
  field?: { deg: number; inFront?: Px[]; frontLines?: Px[][] };
  /** The slices' direction, the band of the sheet (the face) they barely move, and how few of them move there (1 = as many as anywhere). */
  sliceDeg?: number; face?: [Px, Px]; faceShare?: number; sliceMinMm?: number;
  body?: { ring: Px[]; plateMm?: number; angle?: number; flow?: number; bare?: number; pitch?: number }[];
  /** The dress as long panels between seams (each three points, neck to hem), its neckline a gold line. */
  gores?: { seams: Px[][]; neckline: Px[]; fills: { angle: number; pitch: number; cross?: number; bare?: boolean }[] };
  /** Choices for what is cut below the figure: panels of the dress in colour, or a shape of its own. */
  lowers?: Record<string, { gores?: number[]; ring?: Px[] }>;
  /** Traced windows taken out, whose lines are joined back across the gap they leave. */
  heal?: number[];
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
    // The traced visor and the slits above the bun give way to a larger bar with straight edges.
    dropWindows: [0, 1, 2, 3, 4, 5],
    visor: [[378, 322], [1000, 505], [1000, 700], [378, 517]], visorDeg: 16,
    field: {
      deg: 16.4,
      inFront: [[770, 672], [772, 606], [798, 580], [826, 590], [848, 642], [806, 676]],
      frontLines: [[[772, 612], [798, 582], [826, 592], [846, 636]]],
    },
    hidden: { noseTip: [850, 702], chin: [760, 914], yaw: 46, tilt: -6 },
    // Two strands of hair falling across the bar.
    under: [
      [[652, 372], [628, 430], [612, 500], [590, 560]],
      [[692, 372], [668, 440], [640, 520], [602, 590]],
    ],
    sliceDeg: 16.4, face: [[760, 40], [760, 1060]], faceShare: 0.1, sliceMinMm: 4,
    body: [
      { ring: [[335, 640], [300, 720], [265, 850], [200, 960], [80, 1140], [380, 1110], [520, 900], [470, 740], [430, 640]], plateMm: 42, angle: 70, flow: 0.55 },
      { ring: [[520, 905], [640, 882], [780, 874], [890, 960], [945, 1060], [760, 1085], [380, 1110]], plateMm: 58, angle: 25, flow: 0.5 },
    ],
    heal: [0, 1, 2],
    gores: {
      neckline: [[0, 1228], [80, 1150], [280, 1122], [520, 1092], [760, 1088], [948, 1082]],
      seams: [
        [[0, 1228], [-20, 1380], [-40, 1536]],
        [[80, 1150], [130, 1340], [205, 1536]],
        [[280, 1122], [300, 1330], [352, 1536]],
        [[520, 1092], [502, 1320], [476, 1536]],
        [[760, 1088], [706, 1320], [640, 1536]],
        [[948, 1082], [972, 1300], [1016, 1536]],
      ],
      fills: [
        { angle: 62, pitch: 1.2 },
        { angle: 0, pitch: 0, bare: true },
        { angle: 104, pitch: 1.5, cross: 28 },
        { angle: 0, pitch: 0, bare: true },
        { angle: 118, pitch: 2.2 },
      ],
    },
    lowers: {
      gores: {},
      one: { gores: [2] },
      two: { gores: [1, 3] },
      sash: { ring: [[0, 1140], [1016, 1440], [1016, 1530], [0, 1236]] },
    },
    colourDeg: 118, massMm: 60,
    streams: [
      { from: [386, 330], to: [1000, 512], dir: -73.6, reachMm: 24, backMm: 2, gaps: 0.55, widths: 0.9, fragments: 0.35 },
      { from: [378, 517], to: [760, 630], dir: 106.4, reachMm: 9, backMm: 2, gaps: 0.78, widths: 0.7, fragments: 0 },
    ],
    spots: {
      visor: { at: [430, 468], dir: 16.4, mm: 6.5, room: 84 },
      visorHigh: { at: [650, 426], dir: 16.4, mm: 6.5, room: 84 },
      mass: { at: [120, 1212], dir: 16.4, mm: 11, room: 240 },
      spine: { at: [372, 742], dir: 108, mm: 5.5, room: 92 },
      jaw: { at: [0, 0], dir: 0, mm: 5.5, room: 90, curve: [[500, 806], [600, 868], [700, 898], [800, 884], [860, 840]] },
      bun: { at: [0, 0], dir: 0, mm: 6, room: 170, curve: [[36, 600], [18, 470], [50, 320], [130, 210], [250, 140], [360, 118]] },
      garment: { at: [0, 0], dir: 0, mm: 13, room: 170, lines: [[300, 1300], [300, 1400], [300, 1490]] },
      hem: { at: [60, 1486], dir: 0, mm: 5.5, room: 200 },
    },
  },
};
