import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LATENCY_STAGES, LatencySample, type LatencyStage } from "@vair/shared";

/**
 * plan.md §16 — instrument stages, not totals.
 *
 * A single end-to-end number tells you the loop is slow. The stage breakdown
 * tells you whether that is upload, the STT provider, the model, or your own
 * scene application — which are four different projects.
 *
 * §17 open question, and §11 experiment 3: where is the noticing threshold?
 * If 400ms is indistinguishable from 80ms, a large chunk of planned
 * optimisation work is cancelled. These tables are the input to that call.
 *
 *   npm run latency -- server/data/latency.jsonl
 */

// The default is anchored to the repo, not to cwd: `npm run latency` executes
// with cwd inside the tools workspace. An explicit argument is taken as given.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const file = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(repoRoot, "server/data/latency.jsonl");

const samples = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line, i) => {
    const parsed = LatencySample.safeParse(JSON.parse(line));
    if (!parsed.success) {
      console.warn(`skipping malformed line ${i + 1}`);
      return null;
    }
    return parsed.data;
  })
  .filter((s): s is LatencySample => s !== null);

if (samples.length === 0) {
  console.error(`no samples in ${file}`);
  process.exit(1);
}

for (const path of ["local", "server"] as const) {
  const subset = samples.filter((s) => s.path === path);
  if (subset.length === 0) continue;

  console.log(`\n${path.toUpperCase()}  n=${subset.length}`);
  console.log(`${"stage".padEnd(36)}${"p50".padStart(8)}${"p95".padStart(8)}${"max".padStart(9)}`);

  // Consecutive stage deltas, plus the total, all relative to utterance_start.
  for (let i = 1; i < LATENCY_STAGES.length; i++) {
    const from = LATENCY_STAGES[i - 1] as LatencyStage;
    const to = LATENCY_STAGES[i] as LatencyStage;
    const deltas = subset
      .map((s) => {
        const a = s.stages[from];
        const b = s.stages[to];
        return a !== undefined && b !== undefined ? b - a : null;
      })
      .filter((d): d is number => d !== null);
    if (deltas.length === 0) continue;
    console.log(row(`${from} → ${to}`, deltas));
  }

  const totals = subset
    .map((s) => {
      const a = s.stages.utterance_start;
      const b = s.stages.frame_presented;
      return a !== undefined && b !== undefined ? b - a : null;
    })
    .filter((d): d is number => d !== null);
  if (totals.length > 0) {
    console.log(row("TOTAL", totals));
    // plan.md §13 — under 5s feels like magic, over 15s feels broken.
    const p95 = percentile(totals, 0.95);
    const verdict = p95 < 5000 ? "magic" : p95 < 15_000 ? "acceptable" : "broken";
    console.log(`  p95 ${(p95 / 1000).toFixed(2)}s — ${verdict} (§13)`);
  }
}

function row(label: string, values: number[]): string {
  const p = (q: number) => `${percentile(values, q).toFixed(0)}ms`.padStart(8);
  return `${label.padEnd(36)}${p(0.5)}${p(0.95)}${`${Math.max(...values).toFixed(0)}ms`.padStart(9)}`;
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}
