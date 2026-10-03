/**
 * Polyline-to-rectangle clipping using Cohen-Sutherland algorithm.
 */

export interface Rect {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface Point {
  x: number;
  y: number;
}

// Cohen-Sutherland outcode bits
const INSIDE = 0b0000;
const LEFT   = 0b0001;
const RIGHT  = 0b0010;
const BOTTOM = 0b0100;
const TOP    = 0b1000;

function outcode(x: number, y: number, rect: Rect): number {
  let code = INSIDE;
  if (x < rect.xMin) code |= LEFT;
  else if (x > rect.xMax) code |= RIGHT;
  if (y < rect.yMin) code |= BOTTOM;
  else if (y > rect.yMax) code |= TOP;
  return code;
}

/**
 * Clip a single line segment to a rectangle using Cohen-Sutherland.
 * Returns the clipped segment [x0, y0, x1, y1] or null if entirely outside.
 */
export function clipSegment(
  x0: number, y0: number, x1: number, y1: number,
  rect: Rect,
): [number, number, number, number] | null {
  let code0 = outcode(x0, y0, rect);
  let code1 = outcode(x1, y1, rect);

  while (true) {
    if ((code0 | code1) === 0) {
      // Both inside
      return [x0, y0, x1, y1];
    }
    if ((code0 & code1) !== 0) {
      // Both in same outside zone
      return null;
    }

    // Pick the point that is outside
    const codeOut = code0 !== 0 ? code0 : code1;
    let x: number, y: number;

    if (codeOut & TOP) {
      x = x0 + (x1 - x0) * (rect.yMax - y0) / (y1 - y0);
      y = rect.yMax;
    } else if (codeOut & BOTTOM) {
      x = x0 + (x1 - x0) * (rect.yMin - y0) / (y1 - y0);
      y = rect.yMin;
    } else if (codeOut & RIGHT) {
      y = y0 + (y1 - y0) * (rect.xMax - x0) / (x1 - x0);
      x = rect.xMax;
    } else {
      // LEFT
      y = y0 + (y1 - y0) * (rect.xMin - x0) / (x1 - x0);
      x = rect.xMin;
    }

    if (codeOut === code0) {
      x0 = x;
      y0 = y;
      code0 = outcode(x0, y0, rect);
    } else {
      x1 = x;
      y1 = y;
      code1 = outcode(x1, y1, rect);
    }
  }
}

/**
 * Clip a polyline (array of points) to a rectangle.
 * A single input polyline may produce multiple output polylines
 * (when the line exits and re-enters the rect).
 */
export function clipPolylineToRect(points: Point[], rect: Rect): Point[][] {
  if (points.length < 2) return [];

  const result: Point[][] = [];
  let current: Point[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const clipped = clipSegment(p0.x, p0.y, p1.x, p1.y, rect);

    if (clipped === null) {
      // Segment entirely outside -- break the current polyline
      if (current.length >= 2) {
        result.push(current);
      }
      current = [];
      continue;
    }

    const [cx0, cy0, cx1, cy1] = clipped;

    if (current.length === 0) {
      // Start a new polyline with the clipped start point
      current.push({ x: cx0, y: cy0 });
    } else {
      // Check if the clipped start connects to the end of current polyline
      const last = current[current.length - 1];
      if (last.x !== cx0 || last.y !== cy0) {
        // Discontinuity -- the segment was clipped at its start,
        // meaning the original start was outside. Break polyline.
        if (current.length >= 2) {
          result.push(current);
        }
        current = [{ x: cx0, y: cy0 }];
      }
    }

    current.push({ x: cx1, y: cy1 });
  }

  if (current.length >= 2) {
    result.push(current);
  }

  return result;
}

/**
 * Parse an SVG path d-string (M/L commands only) into an array of points.
 * Handles format: M0.00,0.00L1.00,1.00L2.00,2.00
 * Robust to whitespace around commands and coordinates.
 */
export function parseDString(d: string): Point[] {
  const points: Point[] = [];
  // Match M or L followed by coordinates (x,y)
  const re = /[ML]\s*([-\d.eE]+)\s*[,\s]\s*([-\d.eE]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(d)) !== null) {
    points.push({
      x: parseFloat(match[1]),
      y: parseFloat(match[2]),
    });
  }
  return points;
}

/**
 * Convert an array of points back to an SVG path d-string.
 * Output format: M{x},{y}L{x},{y}L... with 2 decimal places.
 */
export function pointsToDString(points: Point[]): string {
  if (points.length === 0) return "";
  const parts = points.map((p, i) => {
    const cmd = i === 0 ? "M" : "L";
    return `${cmd}${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  });
  return parts.join("");
}

/**
 * Compute the convex hull of a set of 2D points using Andrew's monotone-chain
 * algorithm. Returns vertices in counter-clockwise order. Returns `[]` when
 * fewer than 3 distinct non-collinear points exist (covers fewer-than-3 input,
 * single point, two points, and all-collinear inputs).
 */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return [];

  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);

  const cross = (o: Point, a: Point, b: Point): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point[] = [];
  for (const p of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper];

  return hull.length >= 3 ? hull : [];
}

/**
 * Clip a polyline against a single half-plane defined by a directed edge
 * (CCW orientation: interior is on the left). Splits on exit so a polyline
 * that crosses the edge yields multiple output polylines.
 */
function clipPolylineToHalfPlane(
  points: Point[],
  edgeStart: Point,
  edgeEnd: Point,
): Point[][] {
  if (points.length < 2) return [];

  const dx = edgeEnd.x - edgeStart.x;
  const dy = edgeEnd.y - edgeStart.y;
  const dist = (p: Point): number =>
    dx * (p.y - edgeStart.y) - dy * (p.x - edgeStart.x);
  const intersect = (p0: Point, p1: Point, d0: number, d1: number): Point => {
    const t = d0 / (d0 - d1);
    return { x: p0.x + t * (p1.x - p0.x), y: p0.y + t * (p1.y - p0.y) };
  };

  const result: Point[][] = [];
  let current: Point[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const d0 = dist(p0);
    const d1 = dist(p1);
    const in0 = d0 >= 0;
    const in1 = d1 >= 0;

    if (in0 && in1) {
      if (current.length === 0) current.push(p0);
      current.push(p1);
    } else if (in0 && !in1) {
      if (current.length === 0) current.push(p0);
      current.push(intersect(p0, p1, d0, d1));
      if (current.length >= 2) result.push(current);
      current = [];
    } else if (!in0 && in1) {
      current = [intersect(p0, p1, d0, d1), p1];
    } else {
      if (current.length >= 2) result.push(current);
      current = [];
    }
  }

  if (current.length >= 2) result.push(current);

  return result;
}

/**
 * Clip a polyline against a convex polygon (vertices in CCW order) using
 * iterative half-plane clipping. This is the polyline analog of
 * Sutherland–Hodgman: each polygon edge is treated as a half-plane and
 * every input polyline is clipped against it, splitting on exit/re-entry.
 * A single input polyline may yield multiple output polylines.
 *
 * Returns `[]` when `polygon.length < 3` or `points.length < 2`.
 * Inside convention: a point is inside an edge's half-plane when
 * `dx*(p.y - start.y) - dy*(p.x - start.x) >= 0` (left of or on edge),
 * so vertices lying exactly on an edge are kept.
 */
export function clipPolylineToConvexPolygon(
  points: Point[],
  polygon: Point[],
): Point[][] {
  if (polygon.length < 3 || points.length < 2) return [];

  let polylines: Point[][] = [points];
  for (let i = 0; i < polygon.length; i++) {
    const start = polygon[i];
    const end = polygon[(i + 1) % polygon.length];
    const next: Point[][] = [];
    for (const pl of polylines) {
      next.push(...clipPolylineToHalfPlane(pl, start, end));
    }
    polylines = next;
    if (polylines.length === 0) break;
  }
  return polylines;
}

/**
 * Full pipeline: parse d-string, apply transform (translate + scale), clip to rect,
 * return new d-strings. A single input path may become multiple output paths after clipping.
 */
export function clipSVGPath(
  d: string,
  transform: { cx: number; cy: number; scale: number },
  clipRect: Rect,
): string[] {
  const points = parseDString(d);
  if (points.length < 2) return [];

  // Apply transform: scale then translate
  const transformed = points.map((p) => ({
    x: p.x * transform.scale + transform.cx,
    y: p.y * transform.scale + transform.cy,
  }));

  const clippedPolylines = clipPolylineToRect(transformed, clipRect);

  return clippedPolylines
    .map(pointsToDString)
    .filter((s) => s.length > 0);
}
