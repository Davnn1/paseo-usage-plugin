import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateUsage,
  cacheHitRatio,
  filterPeriod,
  usageSummaryOutputSchema,
  usageSummaryRpc,
  type UsageRow,
} from "../shared/usage";
import { parseCodexLines } from "../server/adapters/codex";

const NOW = 1_800_000_000_000;

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    backend: "opencode",
    provider: "kimi",
    model: "kimi-for-coding",
    inputTokens: 100,
    outputTokens: 10,
    reasoningTokens: 5,
    cacheReadTokens: 900,
    cacheWriteTokens: 50,
    costUsd: 0.5,
    timestampMs: NOW,
    ...overrides,
  };
}

test("cacheHitRatio = cacheRead / (cacheRead + input)", () => {
  assert.equal(cacheHitRatio(900, 100), 0.9);
  assert.equal(cacheHitRatio(0, 0), 0);
  assert.equal(cacheHitRatio(0, 100), 0);
  assert.equal(cacheHitRatio(100, 0), 1);
});

test("filterPeriod keeps rows inside the window and everything for all", () => {
  const rows = [
    row({ timestampMs: NOW - 30 * 24 * 3600_000 }),
    row({ timestampMs: NOW - 2 * 24 * 3600_000 }),
    row({ timestampMs: NOW - 60_000 }),
  ];
  assert.equal(filterPeriod(rows, "all", NOW).length, 3);
  assert.equal(filterPeriod(rows, "30d", NOW).length, 3);
  assert.equal(filterPeriod(rows, "7d", NOW).length, 2);
  assert.equal(filterPeriod(rows, "1d", NOW).length, 1);
  // boundary: exactly at cutoff is included
  const boundary = row({ timestampMs: NOW - 24 * 3600_000 });
  assert.equal(filterPeriod([...rows, boundary], "1d", NOW).length, 2);
});

test("aggregateUsage groups by backend/provider/model and totals equal sum of entries", () => {
  const rows = [
    row({ model: "a", costUsd: 1, timestampMs: NOW - 10 }),
    row({ model: "a", costUsd: 2, timestampMs: NOW }),
    row({ model: "b", costUsd: 3.5 }),
    row({ backend: "codex", provider: "openai", model: "gpt", costUsd: 4 }),
  ];
  const { totals, entries } = aggregateUsage(rows);
  assert.equal(entries.length, 3);
  // sorted by costUsd desc
  assert.deepEqual(
    entries.map((entry) => entry.model),
    ["gpt", "b", "a"],
  );
  assert.equal(totals.costUsd, 10.5);
  assert.equal(totals.sessions, 4);
  assert.equal(
    totals.inputTokens,
    entries.reduce((sum, entry) => sum + entry.inputTokens, 0),
  );
  const a = entries.find((entry) => entry.model === "a");
  assert.equal(a?.sessions, 2);
  assert.equal(a?.costUsd, 3);
  assert.equal(a?.firstUsed, NOW - 10);
  assert.equal(a?.lastUsed, NOW);
  assert.equal(a?.cacheHitRatio, 0.9);
});

test("codex parser prefers total_token_usage over last_token_usage", () => {
  const lines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-04-09T04:21:53.422Z",
      payload: { model_provider: "openai" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-04-09T04:22:00.000Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 80,
            output_tokens: 10,
            reasoning_output_tokens: 2,
          },
          last_token_usage: { input_tokens: 50, output_tokens: 5 },
        },
      },
    }),
    JSON.stringify({ type: "response_item", payload: { model: "gpt-5.4" } }),
  ];
  const { row: parsed, malformedLines } = parseCodexLines(lines);
  assert.equal(malformedLines, 0);
  assert.equal(parsed?.inputTokens, 100);
  assert.equal(parsed?.cacheReadTokens, 80);
  assert.equal(parsed?.reasoningTokens, 2);
  assert.equal(parsed?.model, "gpt-5.4");
  assert.equal(parsed?.provider, "openai");
  assert.equal(parsed?.backend, "codex");
});

test("codex parser falls back to last_token_usage and skips malformed lines", () => {
  const lines = [
    "{broken json",
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 42, output_tokens: 7 } },
      },
    }),
  ];
  const { row: parsed, malformedLines } = parseCodexLines(lines);
  assert.equal(malformedLines, 1);
  assert.equal(parsed?.inputTokens, 42);
  assert.equal(parsed?.outputTokens, 7);
});

test("codex parser returns null when no token_count event exists", () => {
  const { row: parsed } = parseCodexLines([
    JSON.stringify({ type: "session_meta", payload: {} }),
    "not json at all",
  ]);
  assert.equal(parsed, null);
});

test("codex parser: later token_count event wins (cumulative)", () => {
  const event = (input: number) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: input, output_tokens: 1 },
          last_token_usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    });
  const { row: parsed } = parseCodexLines([event(10), event(20)]);
  assert.equal(parsed?.inputTokens, 20);
});

test("usage.summary contract validates a full aggregated payload", () => {
  assert.equal(usageSummaryRpc.name, "usage.summary");
  const { totals, entries } = aggregateUsage([row()]);
  const payload = {
    period: "30d",
    generatedAtMs: NOW,
    totals,
    byProvider: [
      { backend: "opencode", provider: "kimi", entries },
    ],
    sources: [{ backend: "opencode", status: "used", detail: "1 sessions" }],
  };
  const parsed = usageSummaryOutputSchema.parse(payload);
  assert.equal(parsed.totals.sessions, 1);
  assert.equal(usageSummaryRpc.input.parse({ period: "7d" }).period, "7d");
  assert.throws(() => usageSummaryRpc.input.parse({ period: "2h" }));
});
