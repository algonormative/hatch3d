/** Shared physical page and border geometry, in millimeters. */
export const PAPER_SIZES: Record<string, { label: string; w: number; h: number }> = {
  a3: { label: "A3", w: 420, h: 297 },
  a4: { label: "A4", w: 297, h: 210 },
  a5: { label: "A5", w: 210, h: 148 },
  letter: { label: '8.5\u00d711"', w: 279.4, h: 215.9 },
  tabloid: { label: '11\u00d717"', w: 431.8, h: 279.4 },
};

export const BORDER_STYLES: Record<string, string> = {
  simple: "Simple",
  double: "Double",
  ticked: "Ticked",
  cropmarks: "Crop marks",
};

/** A double border's default distance between its two lines, in millimeters. */
export const DOUBLE_BORDER_INSET = 2;
export type BorderStyle = 'simple' | 'double' | 'ticked' | 'cropmarks';
export interface PagePoint { x: number; y: number }

/** Historical App SVG path generator; keep formatting stable for existing exports. */
export function generateBorderPaths(
  style: string, pageW: number, pageH: number, margin: number, _strokeWidth: number,
): string[] {
  const x = margin; const y = margin;
  const w = pageW - margin * 2; const h = pageH - margin * 2;
  const rect = (rx: number, ry: number, rw: number, rh: number) =>
    `M${rx},${ry}H${rx + rw}V${ry + rh}H${rx}Z`;
  switch (style) {
    case "simple": return [rect(x, y, w, h)];
    case "double": {
      const inset = DOUBLE_BORDER_INSET;
      return [rect(x, y, w, h), rect(x + inset, y + inset, w - inset * 2, h - inset * 2)];
    }
    case "ticked": {
      const paths = [rect(x, y, w, h)];
      const tickLen = 2; const spacing = 10;
      for (let tx = x + spacing; tx < x + w; tx += spacing) {
        paths.push(`M${tx},${y}V${y - tickLen}`);
        paths.push(`M${tx},${y + h}V${y + h + tickLen}`);
      }
      for (let ty = y + spacing; ty < y + h; ty += spacing) {
        paths.push(`M${x},${ty}H${x - tickLen}`);
        paths.push(`M${x + w},${ty}H${x + w + tickLen}`);
      }
      return paths;
    }
    case "cropmarks": {
      const markLen = 8; const gap = 2;
      const corners = [
        [`M${x - gap},${y}H${x - gap - markLen}`, `M${x},${y - gap}V${y - gap - markLen}`],
        [`M${x + w + gap},${y}H${x + w + gap + markLen}`, `M${x + w},${y - gap}V${y - gap - markLen}`],
        [`M${x - gap},${y + h}H${x - gap - markLen}`, `M${x},${y + h + gap}V${y + h + gap + markLen}`],
        [`M${x + w + gap},${y + h}H${x + w + gap + markLen}`, `M${x + w},${y + h + gap}V${y + h + gap + markLen}`],
      ];
      return corners.flat();
    }
    default: return [];
  }
}

/**
 * Real plotter polylines with the same coordinates and order as generateBorderPaths. `lineGap` is a double
 * border's distance between its two lines (the inner one's inset from the outer).
 */
export function generateBorderPolylines(style: BorderStyle, pageW: number, pageH: number, margin: number, lineGap = DOUBLE_BORDER_INSET): PagePoint[][] {
  const x = margin; const y = margin;
  const w = pageW - 2 * margin; const h = pageH - 2 * margin;
  const rect = (rx: number, ry: number, rw: number, rh: number): PagePoint[] => [
    { x: rx, y: ry }, { x: rx + rw, y: ry }, { x: rx + rw, y: ry + rh },
    { x: rx, y: ry + rh }, { x: rx, y: ry },
  ];
  if (style === 'simple') return [rect(x, y, w, h)];
  if (style === 'double') return [rect(x, y, w, h), rect(x + lineGap, y + lineGap, w - 2 * lineGap, h - 2 * lineGap)];
  if (style === 'ticked') {
    const paths = [rect(x, y, w, h)];
    for (let tx = x + 10; tx < x + w; tx += 10) {
      paths.push([{ x: tx, y }, { x: tx, y: y - 2 }], [{ x: tx, y: y + h }, { x: tx, y: y + h + 2 }]);
    }
    for (let ty = y + 10; ty < y + h; ty += 10) {
      paths.push([{ x, y: ty }, { x: x - 2, y: ty }], [{ x: x + w, y: ty }, { x: x + w + 2, y: ty }]);
    }
    return paths;
  }
  const len = 8; const gap = 2;
  return [
    [{ x: x - gap, y }, { x: x - gap - len, y }], [{ x, y: y - gap }, { x, y: y - gap - len }],
    [{ x: x + w + gap, y }, { x: x + w + gap + len, y }], [{ x: x + w, y: y - gap }, { x: x + w, y: y - gap - len }],
    [{ x: x - gap, y: y + h }, { x: x - gap - len, y: y + h }], [{ x, y: y + h + gap }, { x, y: y + h + gap + len }],
    [{ x: x + w + gap, y: y + h }, { x: x + w + gap + len, y: y + h }], [{ x: x + w, y: y + h + gap }, { x: x + w, y: y + h + gap + len }],
  ];
}
