import type { Part, Point } from '../../src/sketch/types.ts';
import { strokeText } from '../../src/sketch/stroke-text.ts';
import { concertLettering } from './composition.ts';
export { TABLOID_PAGE, AUTHORED_ART, posterControls, concertLettering, composePoster } from './composition.ts';

/** Compatibility entry point for the original wire alphabet. */
export function plotText(text: string, x: number, y: number, height: number, tracking = 1.8): Point[][] {
  return strokeText(text, x, y, { face: 'wire', height, tracking });
}

export function posterFrame({ subtitle, edition, pen = 'carbon' }: { subtitle: string; edition: string; pen?: string }): Part[] {
  return concertLettering({ page: { width: 297, height: 420, margin: 18 }, pen,
    title: 'PHASE GARDEN', kicker: 'LIVE ELECTRONIC SYSTEMS', subtitle,
    footer: `CONCERT STUDY / ${edition}` });
}
