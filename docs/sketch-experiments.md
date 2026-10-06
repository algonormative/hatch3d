# Sketch experiment batches

`plot-sketch experiment matrix.json --out output/experiment` runs a bounded, sequential matrix. A matrix names executable sketch source files, parameter regimes, and seeds; optional finishing and PNG settings apply to every candidate. Paths in the JSON are relative to the matrix file. The equivalent Node API is `runExperimentBatch({ matrix, baseDir, outputDir, timeoutMs?, signal? })` from `@hatch3d/plot-host`.

```json
{
  "sources": [{ "id": "crossing", "entry": "../family/sketch.ts" }],
  "regimes": [
    { "id": "open", "params": { "spacing": 14, "drift": 3 } },
    { "id": "balanced", "params": { "spacing": 10, "drift": 3 } },
    { "id": "dense", "params": { "spacing": 6, "drift": 3 } }
  ],
  "seeds": [7],
  "png": { "theme": "paper", "scale": 2 }
}
```

The product of sources, regimes, and seeds is capped at 32. Source and regime IDs must be unique lowercase letter/digit/hyphen names without consecutive hyphens; seeds must be unique nonnegative safe integers. Render timeout defaults to 30 seconds and is capped at 60 seconds per candidate. To compare code variants at a matched seed, list each variant as a separate `sources` entry in the same family project. The [starter matrices](../examples/plot-family-starter/experiments/) demonstrate three regimes at a fixed seed and a three-seed sweep.

Each successful candidate gets `render.svg`, `render.png`, and `result.json` under `candidates/`. `manifest.json` records the exact matrix and request, source/dependency fingerprints, candidate status and identity, and hashes of all three artifacts. `contact-sheet.html` links the current successful previews and labels failed, stale, or cancelled candidates without ranking them. It is a local view; no upload, billed service, database, or model judgment is involved. Failed renders never reuse an earlier preview as a current success.

Rerunning a matrix skips a candidate only when its source, entry, request, PNG settings, pipeline version, runtime and dependency fingerprints match and all saved artifact hashes and SVG/result identity validate. Corrupt or incomplete artifacts are rendered again. A running or interrupted manifest is not treated as complete. A single exclusive output lock prevents concurrent writers; an abandoned `.experiment.lock` requires inspection and manual removal. Generated bundles are staged before publication, and the manifest is written after the contact sheet and source checks.

External matrices must be run by the same project's installed `@hatch3d/plot-host` package, for example its `node_modules/.bin/plot-sketch`. All source entries in one external matrix must belong to that project. The batch fingerprints family source/assets, original package and lock bytes, and the content of installed dependency packages, including the packed host and native optional modules. It rejects declared assets outside the family. In-repository matrices run through the Hatch3D source checkout; the shared tree must be clean at the retained Git revision, and the installed root dependency tree is content-hashed as well as the lockfile. Output must be outside every captured source directory. Input fingerprints are rechecked before and after each render and before an artifact is published; a change stops the batch and records a stale outcome.

This is reproducibility for trusted local sketches, not a sandbox for arbitrary Node code or network/file reads that a sketch does not declare as family assets. The [checkpoint contract](sketch-checkpoints.md) preserves a selected result and runnable source separately. Run `npm run plot-experiment:smoke` for a packed independent family, resume/corruption, failure, mutation and cancellation probes; it also writes a viewable contact sheet under `.sketch-output/extraction-proof/`.
