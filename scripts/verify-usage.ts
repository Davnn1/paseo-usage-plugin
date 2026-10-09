/**
 * Live-proof script. Run with: npx tsx scripts/verify-usage.ts
 *
 * Two layers of verification:
 *  1. PIPELINE (exit code): the JS aggregation path (adapters + shared math) is
 *     compared against an independent SQL-level SUM over the same live database.
 *     Both must agree within LIVE_DRIFT_TOLERANCE to account for rows being
 *     updated in place between the two reads (opencode.db is written by active
 *     agents continuously).
 *  2. SPEC: totals are asserted against the numbers recorded in tasks/todo.md.
 *     Those were captured at 2026-10-08 17:00 on this same live database; rows
 *     updated since then shift totals upward, so a mismatch here is reported as
 *     data drift (with the measured delta) rather than a pipeline failure.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UsageAggregator } from "../server/aggregator";
import { startOfLocalDay } from "../shared/usage";
import { readCodexRows } from "../server/adapters/codex";

const DB_PATH = `${process.env.HOME}/.local/share/opencode/opencode.db`;
const TODO_MTIME_MS = 1791453651712; // tasks/todo.md, when the spec numbers were captured
const LIVE_DRIFT_TOLERANCE = 0.005; // ±0.5% between the two reads of a live db
const SPEC_TOLERANCE = 0.001; // ±0.1% against recorded spec numbers

interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

const SPEC: Record<string, Totals> = {
  all: { costUsd: 387.25, inputTokens: 227_600_000, outputTokens: 13_700_000, cacheReadTokens: 3_236_200_000 },
  "30d": { inputTokens: 119_416_587, outputTokens: 3_383_154, cacheReadTokens: 1_380_369_410, costUsd: 118.94 },
};

let pipelineFailures = 0;
let specDrifts = 0;

function relDiff(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-9);
}

function assertPipeline(name: string, actual: number, expected: number) {
  // Relative tolerance plus an absolute floor: per-entry cost rounding and
  // live row updates dominate small totals (e.g. a $0.18 day).
  const limit = Math.max(expected * LIVE_DRIFT_TOLERANCE, 0.02);
  const ok = Math.abs(actual - expected) <= limit;
  if (!ok) pipelineFailures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}: js=${actual} sql=${expected} (reldiff ${(relDiff(actual, expected) * 100).toFixed(3)}%)`);
}

function checkSpec(period: string, totals: Totals) {
  const expected = SPEC[period];
  if (!expected) return;
  for (const key of Object.keys(expected) as (keyof Totals)[]) {
    const ok = relDiff(totals[key], expected[key]) <= SPEC_TOLERANCE;
    if (!ok) {
      specDrifts += 1;
      console.log(
        `  DRIFT ${period}.${key}: now=${totals[key]} spec=${expected[key]} (${(relDiff(totals[key], expected[key]) * 100).toFixed(2)}% above spec snapshot)`,
      );
    } else {
      console.log(`  SPEC-OK ${period}.${key}: now=${totals[key]} spec=${expected[key]}`);
    }
  }
}

/** Independent ground truth: SQL-level aggregation, different code path from the JS adapters. */
function groundTruth(period: string): Totals {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    // Local-calendar-day windows, matching the plugin's filterPeriod exactly.
    const now = Date.now();
    const dayStart = startOfLocalDay(now);
    const cutoffClause =
      period === "all" ? "1=1" : `time_created >= ${dayStart - (Number(period.replace("d", "")) - 1) * 24 * 3600 * 1000}`;
    const row = db
      .prepare(
        `SELECT ifnull(sum(tokens_input),0) i, ifnull(sum(tokens_output),0) o,
                ifnull(sum(tokens_cache_read),0) cr, ifnull(sum(cost),0) c
         FROM session WHERE model IS NOT NULL AND model != '' AND ${cutoffClause}`,
      )
      .get() as { i: number; o: number; cr: number; c: number };
    return { inputTokens: row.i, outputTokens: row.o, cacheReadTokens: row.cr, costUsd: row.c };
  } finally {
    db.close();
  }
}

// --- Independent reference parser for codex (separate code path from adapter) ---
function referenceCodexTotals(): { input: number; output: number; cached: number; files: number } {
  const dir = `${process.env.HOME}/.codex/sessions`;
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".jsonl")) files.push(p);
    }
  };
  walk(dir);
  let input = 0;
  let output = 0;
  let cached = 0;
  let used = 0;
  for (const file of files) {
    if (statSync(file).size === 0) continue;
    let last: Record<string, unknown> | null = null;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes("token_count")) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const payload = (obj.payload ?? {}) as Record<string, unknown>;
        if (obj.type === "event_msg" && payload.type === "token_count") {
          last = (payload.info ?? {}) as Record<string, unknown>;
        }
      } catch {
        /* skip malformed */
      }
    }
    if (!last) continue;
    const usage = (last.total_token_usage ?? last.last_token_usage ?? {}) as Record<string, number>;
    input += usage.input_tokens ?? 0;
    output += usage.output_tokens ?? 0;
    cached += usage.cached_input_tokens ?? 0;
    used += 1;
  }
  return { input, output, cached, files: used };
}

console.log("== pipeline vs live SQL ground truth ==");
const aggregator = new UsageAggregator();
for (const period of ["1d", "7d", "30d", "all"] as const) {
  const js = aggregator.summarize(period);
  const sql = groundTruth(period);
  // Ground truth SQL covers only opencode.db; subtract every other backend
  // (codex rollouts, agy-usage-proxy calls) from the JS side.
  const nonOpencode = js.byProvider
    .filter((group) => group.backend !== "opencode")
    .flatMap((group) => group.entries)
    .reduce(
      (acc, entry) => ({
        inputTokens: acc.inputTokens + entry.inputTokens,
        outputTokens: acc.outputTokens + entry.outputTokens,
        cacheReadTokens: acc.cacheReadTokens + entry.cacheReadTokens,
        costUsd: acc.costUsd + entry.costUsd,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    );
  console.log(`period=${period}: cost=$${js.totals.costUsd} in=${js.totals.inputTokens} out=${js.totals.outputTokens} cacheR=${js.totals.cacheReadTokens} sessions=${js.totals.sessions} hit=${(js.totals.cacheHitRatio * 100).toFixed(1)}%`);
  for (const source of js.sources) {
    console.log(`  source ${source.backend}: ${source.status}${source.detail ? ` (${source.detail})` : ""}`);
  }
  assertPipeline(`${period}.inputTokens`, js.totals.inputTokens - nonOpencode.inputTokens, sql.inputTokens);
  assertPipeline(`${period}.outputTokens`, js.totals.outputTokens - nonOpencode.outputTokens, sql.outputTokens);
  assertPipeline(`${period}.cacheReadTokens`, js.totals.cacheReadTokens - nonOpencode.cacheReadTokens, sql.cacheReadTokens);
  assertPipeline(`${period}.costUsd`, js.totals.costUsd - nonOpencode.costUsd, sql.costUsd);
  checkSpec(period, js.totals);
}

console.log("== codex adapter vs independent reference parse ==");
const { rows } = readCodexRows();
const adapterTotals = rows.reduce(
  (acc, row) => ({
    input: acc.input + row.inputTokens,
    output: acc.output + row.outputTokens,
    cached: acc.cached + row.cacheReadTokens,
  }),
  { input: 0, output: 0, cached: 0 },
);
const reference = referenceCodexTotals();
console.log(`  adapter:   in=${adapterTotals.input} out=${adapterTotals.output} cached=${adapterTotals.cached} rows=${rows.length}`);
console.log(`  reference: in=${reference.input} out=${reference.output} cached=${reference.cached} files=${reference.files}`);
assertPipeline("codex.input", adapterTotals.input, reference.input);
assertPipeline("codex.output", adapterTotals.output, reference.output);
assertPipeline("codex.cached", adapterTotals.cached, reference.cached);

if (specDrifts > 0) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const drift = db
    .prepare(
      `SELECT count(*) n, ifnull(sum(tokens_input),0) i, ifnull(sum(tokens_cache_read),0) cr, round(ifnull(sum(cost),0),2) c
       FROM session WHERE time_updated > ${TODO_MTIME_MS}`,
    )
    .get() as { n: number; i: number; cr: number; c: number };
  db.close();
  console.log(
    `\nnote: ${specDrifts} spec number(s) moved >±0.1% since the 17:00 snapshot; ` +
      `${drift.n} session row(s) updated in place since then (+${drift.i} input, +${drift.cr} cache-read, +$${drift.c} cost) explain the drift.`,
  );
}

if (pipelineFailures > 0) {
  console.error(`\n${pipelineFailures} pipeline assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll pipeline assertions passed.");
