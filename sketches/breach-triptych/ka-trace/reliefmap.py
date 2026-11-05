"""
A clay render on flat green (see the prompts beside the concept images) as a relief map for `behind.ts`: its brightness on a
grid of page millimetres over the trim, 0 where the green is, 1 to 255 on the form. The image fills the trim's height, as in
`trace.py`.

  uv run --no-project --with pillow --with scipy --with numpy python -I reliefmap.py render.png out.json
"""
import base64
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

src, out = sys.argv[1], sys.argv[2]
PAGE = (279.4, 431.8); TRIM = 11.0; CELL = 1.0
img = np.asarray(Image.open(src).convert('RGB')).astype(float) / 255
H0, W0 = img.shape[:2]
MM = (PAGE[1] - 2 * TRIM) / H0
X0 = (PAGE[0] - W0 * MM) / 2
r, g, b = img[..., 0], img[..., 1], img[..., 2]
ground = (g > r + 0.18) & (g > b + 0.18)
form = ndi.binary_opening(~ndi.binary_dilation(ground, iterations=2), iterations=2)
luma = r * 0.3 + g * 0.59 + b * 0.11
lo, hi = np.percentile(luma[form], [1, 99])
tone = np.clip((luma - lo) / max(hi - lo, 1e-3), 0, 1)
# Each grid cell, the average of the form's pixels under it; a cell mostly off the form is off it.
nx, ny = int((PAGE[0] - 2 * TRIM) / CELL), int((PAGE[1] - 2 * TRIM) / CELL)
xs = ((TRIM + (np.arange(nx) + 0.5) * CELL - X0) / MM)
ys = ((np.arange(ny) + 0.5) * CELL / MM)
coords = np.meshgrid(ys, xs, indexing='ij')
sigma = CELL / MM / 2.5
weight = ndi.gaussian_filter(form.astype(float), sigma)
total = ndi.gaussian_filter(tone * form, sigma)
w = ndi.map_coordinates(weight, coords, order=1)
t = ndi.map_coordinates(total, coords, order=1) / np.maximum(w, 1e-3)
data = np.where(w > 0.5, 1 + np.round(np.clip(t, 0, 1) * 254), 0).astype(np.uint8)
with open(out, 'w') as f:
    json.dump({'w': nx, 'h': ny, 'x0': TRIM, 'y0': TRIM, 'cell': CELL, 'data': base64.b64encode(data.tobytes()).decode()}, f)
print({'w': nx, 'h': ny, 'form': round(float((data > 0).mean()), 3), 'tone_mean': round(float(data[data > 0].mean() / 255), 3)})
