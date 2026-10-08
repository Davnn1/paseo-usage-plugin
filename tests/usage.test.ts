import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateUsage,
  bucketDaily,
  bucketProviderCost,
  bucketWeekly,
  cacheHitRatio,
  dailyTokens,
  filterPeriod,
  mostActiveDay,
  usageSummaryOutputSchema,
  usageSummaryRpc,
  type UsageRow,
} from "../shared/usage";
import { parseCodexLines } from "../server/adapters/codex";
import { readSessionRowById } from "../server/adapters/opencode";
import { extractSessionId, resolveSessionSummary } from "../server/session-lookup";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backendForProvider, mapSourceStatus } from "../server/discovery";

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
    sources: [{ backend: "opencode", status: "used", sessions: 1, detail: "1 sessions" }],
  };
  const parsed = usageSummaryOutputSchema.parse(payload);
  assert.equal(parsed.totals.sessions, 1);
  assert.equal(usageSummaryRpc.input.parse({ period: "7d" }).period, "7d");
  assert.throws(() => usageSummaryRpc.input.parse({ period: "2h" }));
});

test("backendForProvider maps aliases and passes through unknown ids", () => {
  assert.equal(backendForProvider("codex"), "codex");
  assert.equal(backendForProvider("opencode"), "opencode");
  assert.equal(backendForProvider("antigravity"), "antigravity");
  assert.equal(backendForProvider("antigravity-acp"), "antigravity-acp");
  assert.equal(backendForProvider("claude"), "claude");
  assert.equal(backendForProvider("oh-my-pi"), "oh-my-pi");
});

test("mapSourceStatus: used when rows exist", () => {
  const source = mapSourceStatus({
    provider: { provider: "codex", label: "Codex", enabled: false },
    backendRows: 3,
  });
  assert.equal(source.status, "used");
  assert.equal(source.sessions, 3);
  assert.equal(source.backend, "codex");
  assert.equal(source.label, "Codex");
  assert.equal(source.enabled, false);
});

test("mapSourceStatus: no_data_source for antigravity with encrypted store", () => {
  const source = mapSourceStatus({
    provider: { provider: "antigravity", label: "Antigravity", enabled: true },
    backendRows: 0,
    unreadableDetail: "local store terenkripsi",
  });
  assert.equal(source.status, "no_data_source");
  assert.match(source.detail ?? "", /omniroute/);
});

test("mapSourceStatus: never_used for registered providers without rows", () => {
  for (const provider of ["claude", "copilot", "pi", "oh-my-pi", "muse", "kimi", "antigravity-acp"]) {
    const source = mapSourceStatus({ provider: { provider }, backendRows: 0 });
    assert.equal(source.status, "never_used", provider);
  }
  const opencode = mapSourceStatus({ provider: { provider: "opencode" }, backendRows: 0 });
  assert.equal(opencode.status, "never_used");
});

test("mapSourceStatus: not_implemented when usage exists but no adapter", () => {
  const source = mapSourceStatus({
    provider: { provider: "claude", label: "Claude" },
    backendRows: 0,
    unreadableBackends: new Set(["claude"]),
  });
  assert.equal(source.status, "not_implemented");
});

// ---------------------------------------------------------------------------
// Dashboard series
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW_DAY = Date.UTC(2026, 9, 8); // 2026-10-08T00:00:00Z, a Thursday

test("bucketDaily gap-fills missing days with zeros", () => {
  const rows = [
    row({ timestampMs: NOW_DAY, inputTokens: 100 }),
    row({ timestampMs: NOW_DAY - 2 * DAY, inputTokens: 50 }),
  ];
  const daily = bucketDaily(rows, 4, NOW_DAY + 12 * 3600 * 1000);
  assert.equal(daily.length, 4);
  assert.deepEqual(
    daily.map((point) => point.date),
    ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"],
  );
  assert.equal(daily[0].inputTokens, 0); // 10-05: no rows
  assert.equal(daily[1].inputTokens, 50); // 10-06
  assert.equal(daily[2].inputTokens, 0); // 10-07 gap
  assert.equal(daily[3].inputTokens, 100); // 10-08
  assert.equal(daily[3].sessions, 1);
});

test("bucketDaily sums same-day rows and handles empty input", () => {
  const rows = [row({ timestampMs: NOW_DAY, inputTokens: 10 }), row({ timestampMs: NOW_DAY + 3600_000, costUsd: 0.125 })];
  const daily = bucketDaily(rows, 1, NOW_DAY + 12 * 3600 * 1000);
  assert.equal(daily.length, 1);
  assert.equal(daily[0].inputTokens, 110); // default row carries 100 + explicit 10
  assert.equal(daily[0].costUsd, 0.63); // 0.5 default + 0.125 rounded
  assert.deepEqual(bucketDaily([], 3, NOW_DAY), [
    { date: "2026-10-06", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, sessions: 0 },
    { date: "2026-10-07", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, sessions: 0 },
    { date: "2026-10-08", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, sessions: 0 },
  ]);
});

test("bucketDaily with null window starts at earliest row", () => {
  const rows = [row({ timestampMs: NOW_DAY - 9 * DAY, inputTokens: 1 }), row({ timestampMs: NOW_DAY, inputTokens: 2 })];
  const daily = bucketDaily(rows, null, NOW_DAY + 12 * 3600 * 1000);
  assert.equal(daily.length, 10);
  assert.equal(daily[0].inputTokens, 1);
  assert.equal(daily[9].inputTokens, 2);
});

test("bucketWeekly buckets tokens by UTC weekday", () => {
  // 2026-10-08 is Thursday (4). One day before = Wednesday (3).
  const daily = bucketDaily(
    [row({ timestampMs: NOW_DAY, inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 })],
    2,
    NOW_DAY + 12 * 3600 * 1000,
  );
  const weekly = bucketWeekly(daily);
  assert.equal(weekly.length, 7);
  assert.equal(weekly[4].tokens, 125); // Thu
  assert.equal(weekly.reduce((sum, slot) => sum + slot.tokens, 0), 125);
  assert.equal(dailyTokens(daily[1]), 125);
});

test("mostActiveDay picks the highest-token day", () => {
  const daily = bucketDaily(
    [
      row({ timestampMs: NOW_DAY, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 }),
      row({ timestampMs: NOW_DAY - DAY, inputTokens: 999, outputTokens: 0, cacheReadTokens: 0 }),
    ],
    2,
    NOW_DAY + 12 * 3600 * 1000,
  );
  const mad = mostActiveDay(daily);
  assert.deepEqual(mad, { weekday: 3, date: "2026-10-07", tokens: 999 });
  const allZero = bucketDaily([], 2, NOW_DAY);
  assert.equal(mostActiveDay(allZero), null);
});

test("bucketProviderCost groups by providerID and sorts desc", () => {
  const rows = [
    row({ backend: "opencode", provider: "kimi", model: "a", costUsd: 2 }),
    row({ backend: "opencode", provider: "kimi", model: "b", costUsd: 1 }),
    row({ backend: "opencode", provider: "deepseek", model: "c", costUsd: 5 }),
    row({ backend: "codex", provider: "openai", model: "gpt", costUsd: 3.5 }),
  ];
  const { entries } = aggregateUsage(rows);
  const costs = bucketProviderCost(entries);
  assert.deepEqual(costs, [
    { provider: "deepseek", costUsd: 5 },
    { provider: "codex", costUsd: 3.5 },
    { provider: "kimi", costUsd: 3 },
  ]);
});

// ---------------------------------------------------------------------------
// Session summary lookup (composer pill)
// ---------------------------------------------------------------------------

test("extractSessionId reads persistence then runtimeInfo, rejects foreign ids", () => {
  assert.equal(
    extractSessionId({ persistence: { sessionId: "ses_abc" }, runtimeInfo: { sessionId: "ses_def" } }),
    "ses_abc",
  );
  assert.equal(extractSessionId({ runtimeInfo: { sessionId: "ses_def" } }), "ses_def");
  assert.equal(extractSessionId({ persistence: {}, runtimeInfo: {} }), null);
  assert.equal(extractSessionId({ persistence: { sessionId: "rollout-uuid" } }), null);
  assert.equal(extractSessionId({ persistence: { sessionId: 42 } }), null);
  assert.equal(extractSessionId(null), null);
});

test("readSessionRowById finds a session in a temp db and misses unknown ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-test-"));
  const dbPath = join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, model TEXT, cost REAL DEFAULT 0,
      tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0,
      tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0, time_created INTEGER)`,
  );
  db.prepare(
    `INSERT INTO session VALUES ('ses_found', 'Test session', '{"id":"kimi-for-coding","providerID":"kimi"}', 1.5, 100, 10, 5, 900, 50, 12345)`,
  ).run();
  db.close();

  const found = readSessionRowById("ses_found", dbPath);
  assert.equal(found?.title, "Test session");
  assert.equal(found?.provider, "kimi");
  assert.equal(found?.inputTokens, 100);
  assert.equal(found?.cacheHitRatio, 0.9);
  assert.equal(readSessionRowById("ses_missing", dbPath), null);
});

test("resolveSessionSummary: found / missing field / not found / non-opencode", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-agents-"));
  const ws = join(dir, "ws1");
  mkdirSync(ws);

  // found
  writeFileSync(
    join(ws, "agent-1.json"),
    JSON.stringify({ provider: "opencode", persistence: { sessionId: "ses_x" } }),
  );
  const stubRead = (sessionId: string) =>
    sessionId === "ses_x"
      ? {
          id: "ses_x",
          title: "T",
          provider: "kimi",
          model: "m",
          inputTokens: 1,
          outputTokens: 2,
          reasoningTokens: 0,
          cacheReadTokens: 9,
          cacheWriteTokens: 0,
          costUsd: 0.5,
          cacheHitRatio: 0.9,
          timeCreated: 1,
        }
      : null;
  const found = resolveSessionSummary("agent-1", { agentsDir: dir, readSession: stubRead });
  assert.equal(found.found, true);
  assert.equal(found.sessionId, "ses_x");
  assert.equal(found.title, "T");

  // missing sessionId field
  writeFileSync(join(ws, "agent-2.json"), JSON.stringify({ provider: "opencode" }));
  const missing = resolveSessionSummary("agent-2", { agentsDir: dir, readSession: stubRead });
  assert.equal(missing.found, false);
  assert.match(missing.reason ?? "", /no linked opencode session/);

  // agent file absent
  const absent = resolveSessionSummary("agent-3", { agentsDir: dir, readSession: stubRead });
  assert.equal(absent.found, false);
  assert.match(absent.reason ?? "", /agent file not found/);

  // session row absent from db
  writeFileSync(join(ws, "agent-4.json"), JSON.stringify({ persistence: { sessionId: "ses_y" } }));
  const rowMissing = resolveSessionSummary("agent-4", { agentsDir: dir, readSession: stubRead });
  assert.equal(rowMissing.found, false);
  assert.match(rowMissing.reason ?? "", /not in opencode\.db/);

  // non-opencode provider
  writeFileSync(
    join(ws, "agent-5.json"),
    JSON.stringify({ provider: "codex", persistence: { sessionId: "ses_z" } }),
  );
  const foreign = resolveSessionSummary("agent-5", { agentsDir: dir, readSession: stubRead });
  assert.equal(foreign.found, false);
  assert.match(foreign.reason ?? "", /non-opencode/);
});
