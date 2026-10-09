#!/usr/bin/env node
/**
 * hatch3d density CLI: the density probe (sketches/kit/density.ts) over a sketch render's result.json.
 * Reports strokes that run parallel closer than k × the pen width, per part, worst first, with positions, and the
 * share of each part's length that runs that close. With --against, compares each part with the same part of a
 * reference render (a card's tabloid print) and names the parts that crowd more.
 *
 * Usage:
 *   npm run -s density -- sketch-output/0-fool/result.json
 *   npm run -s density -- small/result.json --against tabloid/result.json
 *   npm run -s density -- result.json --k 2 --pen carbon=0.25,lettering=0.13 --worst 10 --json
 *
 * Pen widths come from each result's declared pens; --pen overrides them (a bare number sets every pen).
 * Exits 1 when there are violations, or, with --against, when a part is denser than the reference's.
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import type { Part } from "../src/sketch/types.ts";
import { denserThan, densityProbe, describeDensity, type DensityReport } from "../sketches/kit/density.ts";

const { values: args, positionals } = parseArgs({
  options: {
    against: { type: "string" },
    k: { type: "string" },
    pen: { type: "string" },
    "min-run": { type: "string" },
    angle: { type: "string" },
    worst: { type: "string" },
    slack: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (args.help || positionals.length !== 1) {
  console.log(`hatch3d density: strokes closer than k x the pen width, per part

Usage: npm run -s density -- <result.json> [--against reference.json] [--k 2] [--pen id=mm,...|mm]
         [--min-run 1] [--angle 10] [--worst 5] [--slack 0.05] [--json]`);
  process.exit(args.help ? 0 : 2);
}

const number = (name: string, value: string | undefined, zero = false): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!(n > 0 || (zero && n === 0))) { console.error(`--${name} must be a ${zero ? "nonnegative" : "positive"} number`); process.exit(2); }
  return n;
};

const overrides = new Map<string, number>();
let every: number | undefined;
for (const item of (args.pen ?? "").split(",").filter(Boolean)) {
  const [id, mm] = item.includes("=") ? item.split("=") : [undefined, item];
  const width = number("pen", mm)!;
  if (id) overrides.set(id, width); else every = width;
}
const options = { k: number("k", args.k), minRun: number("min-run", args["min-run"]), angle: number("angle", args.angle), worst: number("worst", args.worst) };

function probe(file: string): DensityReport {
  let result: { parts: Part[]; metadata?: { pens?: { id: string; width: number }[] } };
  try { result = JSON.parse(readFileSync(file, "utf-8")); } catch (e) { fail(`cannot read ${file}: ${(e as Error).message}`); }
  if (!Array.isArray(result.parts)) fail(`${file} has no parts: pass a sketch render's result.json`);
  const widths = new Map((result.metadata?.pens ?? []).map(p => [p.id, p.width]));
  const missing = [...new Set(result.parts.map(part => part.pen))].filter(pen => (every ?? overrides.get(pen) ?? widths.get(pen)) === undefined);
  if (missing.length) fail(`${file} declares no width for pen ${missing.join(", ")}: give one with --pen ${missing[0]}=0.25`);
  return densityProbe(result.parts, { ...options, penWidth: pen => every ?? overrides.get(pen) ?? widths.get(pen)! });
}

function fail(message: string): never {
  console.error(`density: ${message}`);
  process.exit(2);
}

const report = probe(positionals[0]);
const denser = args.against ? denserThan(report, probe(args.against), number("slack", args.slack, true)) : undefined;
if (args.json) console.log(JSON.stringify(denser ? { ...report, denser } : report, null, 2));
else {
  console.log(describeDensity(report));
  if (denser) {
    const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
    console.log(denser.length ? `denser than the reference: ${denser.map(p => `${p.id} ${pct(p.share)} (reference ${pct(p.reference)})`).join(", ")}` : "no part denser than the reference");
  }
}
process.exit((denser ? denser.length : report.violations) ? 1 : 0);
