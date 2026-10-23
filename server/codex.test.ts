import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createCodexAdapter, parseCodexFile } from "./adapters/codex";
import type { AdapterResult } from "./types";

const FIXTURE_DIR = join(import.meta.dirname, "__fixtures__");

test("codex adapter: last_token_usage precedence over cumulative totals", async () => {
  const parsed = await parseCodexFile(join(FIXTURE_DIR, "codex-b.jsonl"));
  // Sum of last_token_usage across entries must be used, not total_token_usage.
  assert.ok(parsed.rows.length > 10);
  // Every row comes from the per-turn usage; aggregated input must be far
  // below the final cumulative total (982941) because only per-turn deltas count.
  const totalInput = parsed.rows.reduce((s, r) => s + r.inputTokens, 0);
  assert.ok(totalInput > 0);
  // Model discovered from session payloads.
  assert.equal(parsed.model, "gpt-5.4");
  // Each row is attributed to exactly one session id (the file).
  assert.ok(parsed.rows.every((r) => r.backend === "codex" && r.provider === "codex"));
});

test("codex adapter: totals match sum of per-turn usage within one file", async () => {
  const parsed = await parseCodexFile(join(FIXTURE_DIR, "codex-b.jsonl"));
  const sumInput = parsed.rows.reduce((s, r) => s + r.inputTokens, 0);
  const sumOutput = parsed.rows.reduce((s, r) => s + r.outputTokens, 0);
  const sumCached = parsed.rows.reduce((s, r) => s + r.cacheReadTokens, 0);
  // Cross-check against the final cumulative snapshot in the file.
  assert.ok(sumInput > 900_000, `expected large input sum, got ${sumInput}`);
  assert.ok(sumOutput > 8_000, `expected large output sum, got ${sumOutput}`);
  assert.ok(sumCached > 900_000, `expected large cached sum, got ${sumCached}`);
  // Reasoning tokens captured.
  assert.ok(parsed.rows.some((r) => r.reasoningTokens > 0));
});

test("codex adapter: corrupt and empty files do not crash", async () => {
  const corrupt = await parseCodexFile(join(FIXTURE_DIR, "codex-corrupt.jsonl"));
  assert.equal(corrupt.rows.length, 0);
  assert.ok(corrupt.error);

  const empty = await parseCodexFile(join(FIXTURE_DIR, "codex-empty.jsonl"));
  assert.equal(empty.rows.length, 0);
});

test("codex adapter: collect over fixture directory aggregates both files", async () => {
  const adapter = createCodexAdapter(FIXTURE_DIR);
  const result: AdapterResult = await adapter.collect();
  assert.equal(result.status, "ok");
  const files = new Set(result.rows.map((r) => r.sessionId));
  assert.ok(files.size >= 2);
  const models = new Set(result.rows.map((r) => r.model));
  assert.ok(models.has("gpt-5.4"));
});

test("codex adapter: missing directory reports no_data_source", async () => {
  const adapter = createCodexAdapter("/nonexistent/codex/sessions");
  const result = await adapter.collect();
  assert.equal(result.status, "no_data_source");
  assert.equal(result.rows.length, 0);
});
