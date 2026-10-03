# Local sketch viewer

Open a sketch from the repository root:

```bash
npm run sketch -- open sketches/civic-weather/sketch.ts
```

The command prints a `http://127.0.0.1:<port>/` URL. The server binds only to loopback and uses an available port by default. `--port N` chooses a port; `--out DIRECTORY` chooses where pins are saved. The default is `.sketch-output/<sketch-folder>/pins`, outside the sketch source folder. The server watches that folder for local source and asset edits. Shared library edits require restarting the viewer.

The page displays the runner's SVG. Controls redraw the full sketch; costly sliders redraw on release. It keeps the last successful preview visible with a stale label if new inputs fail or time out. Pin and export are enabled only for the current successful result. Source edits reload control metadata; values survive when their ID, type, and range or options remain compatible. The page shows values reset because they no longer fit.

The **Paper & ink** section shows the paper stock and size from the displayed successful result, plus one row per physical pen pass with its color, width, and plotted path count. Uncheck any pen layer to hide it in the current preview; all layers can be hidden. The **Inspect** controls can also overlay declared raster assets or isolate one named drawing part. A part is distinct from a pen layer, and both visibility filters can be used together. These choices affect only the current inspection image. **Export full SVG** and **Pin this version** use the complete canonical runner SVG, including all ordered Inkscape pen layers. A pin creates a new immutable directory containing `art.svg`, `preview.png`, and `result.json` with parameters, seed, render identity, diagnostics, and geometry. Pins can be selected again after reopening the viewer, even if the sketch source has changed. A pin is an image and settings record; it does not preserve runnable source. Use a source checkpoint for replay.

In a sketch, declare one entry in `sketch.pens` for each physical ink or pass, and assign each drawing part's `pen` to one of those IDs. Multiple named parts can share a pen. The SVG keeps the pen layers in declaration order; change pen colors or paper stock (`page.paper`) in the sketch source.

The local HTTP API serves `GET /api/metadata`, `POST /api/render`, `GET /api/export.svg?identity=...`, `GET/POST /api/pins`, `GET /api/pins/:id`, and `GET /api/pins/:id/svg` or `/png`. A render request body is `{ "requestId": 1, "params": { ... }, "seed": 0 }`; the response echoes `requestId` and contains the runner result. A new render cancels the previous one. Export responds with the exact full SVG as an attachment only while that identity is the latest successful render. Pin requests contain `{ "identity": "..." }` and have the same current-render requirement. `GET /api/events` announces sketch-folder changes to the page.
