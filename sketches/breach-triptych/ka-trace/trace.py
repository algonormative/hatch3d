"""
Trace a concept image into a two-sheet plot: silver and gold lines for the black sheet, cut rings for its windows and
black lines for the magenta sheet behind them, all in page millimetres (the image fills the trim's height, centred, its sides cropped by the trim).

  uv run --no-project --with scikit-image --with pillow --with scipy --with numpy --with shapely python -I trace.py concept.png out/name [--close N] [--bridge MM] [--speck MM2] [--min MM]

--close is how far (in upscaled pixels) a dark line across the magenta still counts as drawn on it rather than as a gap
between windows; 0 keeps every gap. --bridge is the least paper to leave between windows (mm), set square to the image
so shapes square to it keep their corners; a sliver of thin paper under --speck mm² is left alone. --min is the shortest silver line kept (mm). Writes out/name.json and a quick
out/name.png. The traces here were made with these settings:

  02a-slipped      --close 2  --bridge 3  --speck 1.5
  02c-hem          --close 4  --bridge 2.6  --min 4
  03b-collar       --close 4  --bridge 1.8
  03c-magenta-bob  --close 4  --bridge 1.8
  04a-quiet        --close 12
  04c-close        --close 12
"""
import json
import math
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage.color import rgb2hsv
from skimage.measure import approximate_polygon, find_contours
from skimage.morphology import (
    binary_closing,
    disk,
    remove_small_holes,
    remove_small_objects,
    skeletonize,
)

src, out = sys.argv[1], sys.argv[2]
CLOSE = int(sys.argv[sys.argv.index('--close') + 1]) if '--close' in sys.argv else 4
BRIDGE = float(sys.argv[sys.argv.index('--bridge') + 1]) if '--bridge' in sys.argv else 0
SPECK = float(sys.argv[sys.argv.index('--speck') + 1]) if '--speck' in sys.argv else 0.1
MIN_SILVER = float(sys.argv[sys.argv.index('--min') + 1]) if '--min' in sys.argv else 1.6
UP = 3
PAGE = (279.4, 431.8); TRIM = 11.0
img = Image.open(src).convert('RGB')
W0, H0 = img.size
MM = (PAGE[1] - 2 * TRIM) / H0  # the concept fills the trim's height
X0 = (PAGE[0] - W0 * MM) / 2  # centred
big = np.asarray(img.resize((W0 * UP, H0 * UP), Image.LANCZOS)).astype(float) / 255
hsv = rgb2hsv(big); hue, sat, val = hsv[..., 0], hsv[..., 1], hsv[..., 2]

magenta = ((hue > 0.86) | (hue < 0.02)) & (sat > 0.6) & (val > 0.55)
# Thin dark lines across the magenta close up; what closing added is the black-on-magenta drawing.
closed = binary_closing(magenta, disk(max(2, CLOSE)))
closed = remove_small_holes(closed, max_size=20 * UP * UP)
closed = remove_small_objects(closed, max_size=60 * UP * UP)
closed = ndi.binary_opening(closed, disk(UP))
# The image's soft, ragged edges settle first, or the bridge pass below would read each speck as thin paper.
closed = ndi.gaussian_filter(closed.astype(float), 0.6 * UP) > 0.5
if BRIDGE:
    # Paper thinner than a square of the bridge's width is widened to it, at the windows' expense.
    r = round(BRIDGE / 2 / MM * UP)
    paper = np.pad(~closed, r + 2, constant_values=True)
    within = lambda m: ndi.distance_transform_cdt(~m, metric='chessboard') <= r
    core = ndi.distance_transform_cdt(paper, metric='chessboard') > r
    # Only a real strip of paper: a speck of it at a window's edge is noise, and widening it would bite a notch out.
    thin = remove_small_objects(paper & ~within(core), max_size=int(SPECK / MM ** 2 * UP ** 2))
    # (With no thin paper at all the transform has nothing to measure from, and answers -1 everywhere.)
    grown = ndi.distance_transform_cdt(~thin, metric='chessboard') <= r // 2 if thin.any() else np.zeros_like(thin)
    closed = closed & ~grown[r + 2:-(r + 2), r + 2:-(r + 2)]
    # What the widening left of a corner (a nib) goes, square to the image.
    nib = round(0.5 / MM * UP)
    square = np.ones((2 * nib + 1, 2 * nib + 1), bool)
    closed = ndi.binary_opening(closed, square)
# A black island in a window would fall out of the sheet: it is filled, and counted.
labels, count = ndi.label(np.pad(~closed, 1, constant_values=True))
sizes = ndi.sum(np.ones_like(labels), labels, range(1, count + 1))
main = 1 + int(np.argmax(sizes))
islands = (labels != main) & (labels != 0)
islands = islands[1:-1, 1:-1]
n_islands = count - 1
closed = closed | islands
inside = ndi.binary_erosion(closed, disk(2))
luma = big @ np.array([0.3, 0.59, 0.11])
blur = ndi.gaussian_filter(luma, 8 * UP)
contrast = luma - blur

gold = (hue > 0.07) & (hue < 0.17) & (sat > 0.32) & (val > 0.32) & ~closed
# Silver and gold stop short of the windows, as the plot's margin does; this also drops bright bevels along a cut's edge.
clear = ndi.distance_transform_edt(~closed) > 1.0 / MM * UP
silver = (contrast > 0.07) & (sat < 0.38) & clear & ~gold
gold = ndi.binary_closing(gold, disk(1)) & clear
# Lines across a window: anything off-magenta, inside it.
dark = inside & ~ndi.binary_dilation(magenta, disk(0))
dark = remove_small_objects(dark, max_size=8 * UP * UP)

def skeleton(mask, min_px):
    return skeletonize(remove_small_objects(mask, max_size=min_px))

N8 = [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]
def walk(sk):
    """Skeleton pixels to segments between ends and junctions."""
    ys, xs = np.nonzero(sk)
    px = set(zip(ys.tolist(), xs.tolist()))
    deg = {p: sum((p[0]+d[0], p[1]+d[1]) in px for d in N8) for p in px}
    nodes = {p for p, d in deg.items() if d != 2}
    segs, seen = [], set()
    def step(path):
        while True:
            cur = path[-1]
            if cur in nodes and len(path) > 1: return path
            nxt = [(cur[0]+d[0], cur[1]+d[1]) for d in N8]
            nxt = [q for q in nxt if q in px and (cur, q) not in seen and (len(path) < 2 or q != path[-2])]
            if not nxt: return path
            # Prefer 4-neighbours so a staircase is not cut short.
            nxt.sort(key=lambda q: abs(q[0]-cur[0]) + abs(q[1]-cur[1]))
            q = nxt[0]; seen.add((cur, q)); seen.add((q, cur)); path.append(q)
    for n in nodes:
        for d in N8:
            q = (n[0]+d[0], n[1]+d[1])
            if q in px and (n, q) not in seen:
                seen.add((n, q)); seen.add((q, n))
                segs.append(step([n, q]))
    # Closed loops with no node.
    for p in px:
        if deg[p] == 2 and not any(((p, (p[0]+d[0], p[1]+d[1])) in seen) for d in N8):
            nb = [(p[0]+d[0], p[1]+d[1]) for d in N8 if (p[0]+d[0], p[1]+d[1]) in px]
            seen.add((p, nb[0])); seen.add((nb[0], p))
            segs.append(step([p, nb[0]]))
    return [np.array(s, float)[:, ::-1] for s in segs if len(s) >= 3]

def tangent(s, end, k=10):
    k = min(k, len(s) - 1)
    a, b = (s[k], s[0]) if end == 0 else (s[-1-k], s[-1])
    t = b - a
    return t / (np.hypot(*t) or 1)

def merge(segs, reach, cos_min):
    """Join segment ends that point at each other: lines carry on through crossings and small gaps."""
    segs = [s for s in segs]
    changed = True
    while changed:
        changed = False
        ends = []
        for i, s in enumerate(segs):
            if s is None: continue
            ends.append((i, 0, s[0], tangent(s, 0))); ends.append((i, 1, s[-1], tangent(s, 1)))
        if not ends: break
        pts = np.array([e[2] for e in ends])
        from scipy.spatial import cKDTree
        tree = cKDTree(pts)
        cand = []
        for a, b in tree.query_pairs(reach):
            ea, eb = ends[a], ends[b]
            if ea[0] == eb[0]: continue
            align = -(ea[3] @ eb[3])
            if align < cos_min: continue
            gap = np.hypot(*(ea[2] - eb[2]))
            if gap > 1.5:
                link = (eb[2] - ea[2]) / gap
                if link @ ea[3] < cos_min: continue
            cand.append((gap - 6 * align, a, b))
        cand.sort()
        used = set()
        for _, a, b in cand:
            ea, eb = ends[a], ends[b]
            if ea[0] in used or eb[0] in used: continue
            used |= {ea[0], eb[0]}
            sa = segs[ea[0]] if ea[1] == 1 else segs[ea[0]][::-1]
            sb = segs[eb[0]] if eb[1] == 0 else segs[eb[0]][::-1]
            segs[ea[0]] = np.vstack([sa, sb]); segs[eb[0]] = None
            changed = True
        segs = [s for s in segs if s is not None]
    return segs

def smooth(s, sigma):
    if len(s) < 5: return s
    closed_loop = np.hypot(*(s[0] - s[-1])) < 2
    mode = 'wrap' if closed_loop else 'nearest'
    x = ndi.gaussian_filter1d(s[:, 0], sigma, mode=mode); y = ndi.gaussian_filter1d(s[:, 1], sigma, mode=mode)
    r = np.stack([x, y], 1)
    if not closed_loop: r[0], r[-1] = s[0], s[-1]
    return r

def simplify(s, tol):
    return approximate_polygon(s, tol) if len(s) > 3 else s

def to_mm(s):
    return [[round(float(p[0]) / UP * MM + X0, 3), round(float(p[1]) / UP * MM + TRIM, 3)] for p in s]

def length_mm(s):
    return float(np.hypot(*np.diff(s, axis=0).T).sum()) / UP * MM

result = {}
stats = {}
depth = ndi.distance_transform_edt(closed)
for name, mask, min_px, min_mm in [('silver', silver, 6*UP, MIN_SILVER), ('gold', gold, 6*UP, 2.5), ('black', dark, 6*UP, 10)]:
    segs = walk(skeleton(mask, min_px))
    n0 = len(segs)
    # Spurs at junctions first, then join across crossings, then across real gaps.
    segs = [s for s in segs if length_mm(s) > 0.5]
    segs = merge(segs, 2.5*UP, 0.75)
    segs = merge(segs, 6*UP, 0.9)
    segs = merge(segs, 12*UP, 0.94)
    segs = [simplify(smooth(s, 2.2*UP/3*1.4), 0.25) for s in segs if length_mm(s) >= min_mm]
    if name == 'black' and sum(length_mm(s) for s in segs) < 30:
        segs = []  # Not worth a sheet's pen.
    if name == 'black':
        # Run on under the sheet at both ends, so a hand-registered window shows no line ends.
        def deep(p):
            return depth[int(np.clip(p[1], 0, depth.shape[0] - 1)), int(np.clip(p[0], 0, depth.shape[1] - 1))]
        def run_on(s):
            ta, tb = tangent(s, 0), tangent(s, 1)
            reach, shore = 5 / MM * UP, 2.5 / MM * UP
            return np.vstack(([[s[0] + ta * reach]] if deep(s[0]) < shore else []) + [s] + ([[s[-1] + tb * reach]] if deep(s[-1]) < shore else []))
        # A strand runs on; what is left of a stepped edge turns too much to be one.
        straight = lambda s: np.hypot(*(s[-1] - s[0])) / (length_mm(s) / MM * UP) > 0.88
        segs = [run_on(s) for s in segs if straight(s)]
    result[name] = [to_mm(s) for s in segs]
    stats[name] = {'raw': n0, 'kept': len(segs), 'mm': round(sum(length_mm(s) for s in segs)), 'median': round(float(np.median([length_mm(s) for s in segs])) if segs else 0, 1)}

# Padded, so a window running off the image closes along the image's edge.
# Windows stop 0.2 mm inside the trim, closing along it where they run off.
soft = ndi.gaussian_filter(closed.astype(float), 0.6 * UP, mode='nearest')
px = lambda mm: (mm) / MM * UP
x_a, x_b = math.ceil(px(TRIM + 0.2 - X0)), math.floor(px(PAGE[0] - TRIM - 0.2 - X0))
y_a, y_b = math.ceil(px(0.2)), math.floor(px(PAGE[1] - 2 * TRIM - 0.2))
held = np.zeros_like(soft)
held[y_a:y_b, x_a:x_b] = soft[y_a:y_b, x_a:x_b]
def rectangle(r):
    """The ring's least-area rectangle, and how much of that rectangle the ring fills."""
    from scipy.spatial import ConvexHull
    hull = r[ConvexHull(r).vertices]
    area = abs(np.sum(r[:, 0] * np.roll(r[:, 1], -1) - np.roll(r[:, 0], -1) * r[:, 1])) / 2
    best = None
    for a, b in zip(hull, np.roll(hull, -1, axis=0)):
        u = (b - a) / (np.hypot(*(b - a)) or 1); v = np.array([-u[1], u[0]])
        pu, pv = hull @ u, hull @ v
        w, h = pu.max() - pu.min(), pv.max() - pv.min()
        if best is None or w * h < best[0]:
            best = (w * h, np.array([u * pu.min() + v * pv.min(), u * pu.max() + v * pv.min(), u * pu.max() + v * pv.max(), u * pu.min() + v * pv.max()]), min(w, h))
    return best[1], area / best[0], best[2] / UP * MM

from shapely.geometry import LinearRing, Point, Polygon

PAPER_MM = 1.5  # The least paper left between two windows, once they are squared up.
shapes = []
n_rect = 0
for c in find_contours(held, 0.5):
    r = c[:, ::-1]
    if length_mm(r) < 8: continue
    # A small shape that is nearly a rectangle (a pixel, a slot, a visor slit) is cut as one; the big curves stay as traced.
    rect, fill, short = rectangle(r)
    rectangular = (fill > 0.86 and short < 24) or short < 3.5 or abs(Polygon(r).area) / (UP / MM) ** 2 < 150
    n_rect += rectangular
    shapes.append({'rect': rectangular, 'ring': rect if rectangular else simplify(r, 0.15 / MM * UP)})
poly = lambda ring: Polygon(ring).buffer(0)
# A ring inside a ring is a black island the smoothing pinched off: it is filled too.
held_rings = [poly(s['ring']) for s in shapes]
kept = [s for i, s in enumerate(shapes) if not any(j != i and o.contains(Point(s['ring'][0])) for j, o in enumerate(held_rings))]
n_islands += len(shapes) - len(kept)
shapes = kept
# Squared up, a rectangle may reach a neighbour: it draws in until the paper is back, and goes if too little of it is left.
n_gone = 0
for shape in sorted(shapes, key=lambda s: abs(poly(s['ring']).area)):
    if not shape['rect']: continue
    ring = shape['ring']
    others = [LinearRing(o['ring']) for o in shapes if o is not shape and o.get('ring') is not None]
    limit = PAPER_MM / MM * UP
    while ring is not None and any(LinearRing(ring).distance(o) < limit for o in others):
        mid = ring.mean(axis=0)
        u, v = ring[1] - ring[0], ring[3] - ring[0]
        lu, lv = np.hypot(*u), np.hypot(*v)
        if min(lu, lv) < 3.0 / MM * UP:
            ring = None
            break
        step = 0.2 / MM * UP
        ring = np.array([mid + (u / lu) * ((p - mid) @ (u / lu)) * (lu - 2 * step) / lu + (v / lv) * ((p - mid) @ (v / lv)) * (lv - 2 * step) / lv for p in ring])
    shape['ring'] = ring
    if ring is None: n_gone += 1
rings = [to_mm(s['ring']) for s in shapes if s['ring'] is not None]
result['windows'] = rings
stats['windows'] = len(rings); stats['thin_paper_mm2'] = round(float(thin.sum()) * (MM / UP) ** 2) if BRIDGE else 0; stats['islands_filled'] = n_islands; stats['rectangles'] = n_rect; stats['squares_dropped'] = n_gone
with open(out + '.json', 'w') as f:
    json.dump(result, f)
print(stats)

S = 3
pw, ph = int(PAGE[0] * S), int(PAGE[1] * S)
prev = Image.new('RGB', (pw, ph), '#141416'); d = ImageDraw.Draw(prev)
for r in rings: d.polygon([(x*S, y*S) for x, y in r], fill='#d01f72')
col = {'silver': '#dfe2e6', 'gold': '#d7ae4e', 'black': '#141416'}
for name in ('black', 'silver', 'gold'):
    for s in result[name]:
        d.line([(x*S, y*S) for x, y in s], fill=col[name], width=1)
prev.save(out + '.png')
