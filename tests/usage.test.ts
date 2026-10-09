import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateUsage,
  buildPillText,
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
  assert.equal(backendForProvider("antigravity"), "antigravity-cli");
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

test("mapSourceStatus: antigravity used from store stats, never_used when empty", () => {
  const used = mapSourceStatus({
    provider: { provider: "antigravity", label: "Antigravity", enabled: true },
    backendRows: 0,
    antigravity: { "antigravity-cli": { sessions: 3, steps: 42, lastModifiedMs: 1, byModel: new Map() } },
  });
  assert.equal(used.status, "used");
  assert.equal(used.sessions, 3);
  assert.equal(used.label, "Antigravity (CLI)");
  assert.match(used.detail ?? "", /3 sessions · 42 steps/);

  const empty = mapSourceStatus({
    provider: { provider: "antigravity-acp" },
    backendRows: 0,
    antigravity: { "antigravity-acp": { sessions: 0, steps: 0, lastModifiedMs: 0, byModel: new Map() } },
  });
  assert.equal(empty.status, "never_used");
  assert.equal(empty.label, "Antigravity (ACP)");
});

test("mapSourceStatus: never_used for registered providers without rows", () => {
  for (const provider of ["claude", "copilot", "pi", "oh-my-pi", "muse", "kimi", "antigravity-acp"]) {
    const source = mapSourceStatus({ provider: { provider }, backendRows: 0, antigravity: { "antigravity-acp": { sessions: 0, steps: 0, lastModifiedMs: 0, byModel: new Map() } } });
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

test("bucketProviderCost groups by providerID and sorts desc", () => {  const rows = [
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

test("extractSessionId reads persistence then runtimeInfo, ignores non-strings", () => {
  assert.equal(
    extractSessionId({ persistence: { sessionId: "ses_abc" }, runtimeInfo: { sessionId: "ses_def" } }),
    "ses_abc",
  );
  assert.equal(extractSessionId({ runtimeInfo: { sessionId: "ses_def" } }), "ses_def");
  assert.equal(extractSessionId({ persistence: { sessionId: "9ba0609a-37ba-47e0-9eb4-3a2776e787d4" } }), "9ba0609a-37ba-47e0-9eb4-3a2776e787d4");
  assert.equal(extractSessionId({ persistence: {} }), null);
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
  writeFileSync(join(ws, "agent-4.json"), JSON.stringify({ provider: "opencode", persistence: { sessionId: "ses_y" } }));
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

// ---------------------------------------------------------------------------
// Pill fallback chain
// ---------------------------------------------------------------------------

const sessionFound = {
  found: true as const,
  reason: undefined,
  title: "Fix the thing",
  inputTokens: 1_500_000,
  outputTokens: 60_000,
  reasoningTokens: 5_000,
  cacheReadTokens: 900_000,
  cacheWriteTokens: 1_000,
  cacheHitRatio: 0.9,
  costUsd: 1.2345,
  provider: "kimi",
  model: "kimi-for-coding",
};

const dailyTotals = {
  inputTokens: 3_000_000,
  outputTokens: 300_000,
  reasoningTokens: 50_000,
  cacheReadTokens: 9_000_000,
  cacheWriteTokens: 10_000,
  costUsd: 12.34,
  sessions: 7,
  cacheHitRatio: 0.75,
};

test("buildPillText: session found → session numbers, Session: title", () => {
  const text = buildPillText(sessionFound, dailyTotals);
  assert.equal(text.label, "1.5M/60.0K·90%");
  assert.match(text.title, /^Session: Fix the thing/);
  assert.match(text.title, /kimi\/kimi-for-coding/);
});

test("buildPillText: session not found → daily fallback with reason in title", () => {
  const text = buildPillText({ ...sessionFound, found: false, reason: "no linked opencode session" }, dailyTotals);
  assert.equal(text.label, "3.0M/300.0K·75%");
  assert.match(text.title, /^Daily fallback — session not tracked: no linked opencode session/);
  assert.match(text.title, /7 sessions/);
});

test("buildPillText: null session with daily still falls back", () => {
  const text = buildPillText(null, dailyTotals);
  assert.match(text.title, /^Daily fallback — session not tracked\./);
});

test("buildPillText: no session and no daily → honest placeholder", () => {
  const text = buildPillText(null, null);
  assert.equal(text.label, "—");
  assert.equal(text.title, "Monitoring unavailable");
});

// ---------------------------------------------------------------------------
// Antigravity store stats
// ---------------------------------------------------------------------------

import { collectStats, extractConversationId, scanConversationDb } from "../server/adapters/antigravity";

test("extractConversationId parses plain UUID and plugin: JSON", () => {
  assert.equal(extractConversationId("9ba0609a-37ba-47e0-9eb4-3a2776e787d4"), "9ba0609a-37ba-47e0-9eb4-3a2776e787d4");
  assert.equal(
    extractConversationId('plugin:{"version":1,"data":{"conversationId":"9ba0609a-37ba-47e0-9eb4-3a2776e787d4"}}'),
    "9ba0609a-37ba-47e0-9eb4-3a2776e787d4",
  );
  assert.equal(extractConversationId("plugin:{broken"), null);
  assert.equal(extractConversationId("ses_opencode123"), null);
  assert.equal(extractConversationId('plugin:{"version":1,"data":{}}'), null);
});

test("countSteps and collectStats read a fixture conversations directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-agy-"));
  const db1 = join(dir, "aaaa1111-2222-4333-8444-555566667777.db");
  const db2 = join(dir, "bbbb1111-2222-4333-8444-555566667777.db");
  for (const [path, steps] of [[db1, 3], [db2, 0]] as const) {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE steps (id INTEGER)");
    for (let i = 0; i < steps; i += 1) db.prepare("INSERT INTO steps VALUES (?)").run(i);
    db.close();
  }
  writeFileSync(join(dir, "ignore.txt"), "x");
  const scan1 = scanConversationDb(db1);
  assert.equal(scan1.steps, 3);
  assert.equal(scanConversationDb(db2).steps, 0);
  const stats = collectStats(dir);
  assert.equal(stats?.sessions, 2);
  assert.equal(stats?.steps, 3);
  assert.equal(stats?.byModel.size, 0); // no gen_metadata table -> no decoded models
  assert.equal(collectStats(join(dir, "missing")), null);
});

// ---------------------------------------------------------------------------
// agy-usage-proxy metrics adapter
// ---------------------------------------------------------------------------

import { callsToRows, parseAgyLine, readAgyProxyRows } from "../server/adapters/agy-proxy";

const AGY_LINES = [
  '{"ts":"2026-10-08T10:00:00.000Z","source":"cli","model":"gemini-3-flash","status":200,"stream":true,"promptTokens":100,"outputTokens":20,"thinkingTokens":5,"cacheReadTokens":80,"cacheWriteTokens":10,"totalTokens":215,"durationMs":1234}',
  '{"ts":"2026-10-08T10:01:00.000Z","source":"cli","model":"gemini-3-flash","status":200,"promptTokens":50,"outputTokens":null,"thinkingTokens":null,"cacheReadTokens":null,"cacheWriteTokens":null,"totalTokens":null,"durationMs":600}',
  '{"ts":"2026-10-08T10:02:00.000Z","source":"acp","model":"claude-sonnet-4","status":200,"stream":true,"promptTokens":700,"outputTokens":300,"thinkingTokens":0,"cacheReadTokens":650,"cacheWriteTokens":0,"totalTokens":1650,"durationMs":9000}',
  '{"ts":"2026-10-08T10:03:00.000Z","source":"agy","model":"gemini-3-flash","status":200,"stream":true,"promptTokens":10,"outputTokens":1,"thinkingTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":11,"durationMs":100}',
  "not json at all",
  '{"ts":"2026-10-08T10:04:00.000Z","source":"other","model":"x","status":200}',
].join("\n");

test("parseAgyLine accepts locked contract and rejects foreign lines", () => {
  const ok = parseAgyLine(AGY_LINES.split("\n")[0]);
  assert.equal(ok?.source, "cli");
  assert.equal(ok?.model, "gemini-3-flash");
  assert.equal(ok?.promptTokens, 100);
  assert.equal(parseAgyLine(""), null);
  assert.equal(parseAgyLine("broken"), null);
  assert.equal(parseAgyLine(AGY_LINES.split("\n")[5]), null);
  const nulls = parseAgyLine(AGY_LINES.split("\n")[1]);
  assert.equal(nulls?.outputTokens, 0); // null fields coerce to 0
});

test("callsToRows maps sources to backends without touching other rows", () => {
  const calls = AGY_LINES.split("\n").map(parseAgyLine).filter((c) => c !== null);
  const rows = callsToRows(calls);
  assert.equal(rows.length, 4);
  const cli = rows.filter((r) => r.backend === "antigravity-cli");
  assert.equal(cli.length, 2);
  assert.equal(cli[0].provider, "antigravity");
  assert.equal(cli.reduce((sum, r) => sum + r.inputTokens, 0), 150);
  assert.equal(cli.reduce((sum, r) => sum + r.cacheReadTokens, 0), 80);
  const acp = rows.find((r) => r.backend === "antigravity-acp");
  assert.equal(acp?.model, "claude-sonnet-4");
  assert.equal(acp?.outputTokens, 300);
  const agy = rows.find((r) => r.backend === "agy-proxy");
  assert.equal(agy?.provider, "harness");
  assert.equal(agy?.costUsd, 0);
  assert.ok(rows.every((r) => r.timestampMs > 0));
});

test("readAgyProxyRows aggregates a fixture file and handles missing/empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-agy-proxy-"));
  const path = join(dir, "metrics.jsonl");
  writeFileSync(path, AGY_LINES);
  const result = readAgyProxyRows(path);
  assert.equal(result.status, "ok");
  assert.equal(result.callsBySource.cli, 2);
  assert.equal(result.callsBySource.acp, 1);
  assert.equal(result.callsBySource.agy, 1);
  assert.equal(result.rows.length, 4);

  const missing = readAgyProxyRows(join(dir, "nope.jsonl"));
  assert.equal(missing.status, "no_data_source");
  assert.equal(missing.rows.length, 0);

  const emptyPath = join(dir, "empty.jsonl");
  writeFileSync(emptyPath, "");
  assert.equal(readAgyProxyRows(emptyPath).status, "no_data_source");
});

test("mapSourceStatus: antigravity used via proxied calls when store is empty", () => {
  const source = mapSourceStatus({
    provider: { provider: "antigravity" },
    backendRows: 7,
    antigravity: { "antigravity-cli": { sessions: 0, steps: 0, lastModifiedMs: 0, byModel: new Map() } },
    proxyCalls: { "antigravity-cli": 7 },
  });
  assert.equal(source.status, "used");
  assert.match(source.detail ?? "", /proxied LLM calls/);
});

// ---------------------------------------------------------------------------
// Date-range filter (Week/Month/Custom)
// ---------------------------------------------------------------------------

import { dateRangeDays, dateKeyUtc, filterDateRange, rangeEndMs, selectPeriodRows } from "../shared/usage";

test("filterDateRange is inclusive on both bounds and optional per side", () => {
  const dayRows = [
    row({ timestampMs: Date.parse("2026-10-05T00:00:00.000Z") }),
    row({ timestampMs: Date.parse("2026-10-05T23:59:59.999Z") }),
    row({ timestampMs: Date.parse("2026-10-06T12:00:00.000Z") }),
    row({ timestampMs: Date.parse("2026-10-07T00:00:00.000Z") }),
  ];
  assert.equal(filterDateRange(dayRows, "2026-10-05", "2026-10-07").length, 4);
  assert.equal(filterDateRange(dayRows, "2026-10-06", "2026-10-06").length, 1);
  assert.equal(filterDateRange(dayRows, undefined, "2026-10-05").length, 2);
  assert.equal(filterDateRange(dayRows, "2026-10-06", undefined).length, 2);
  assert.equal(filterDateRange(dayRows, "bogus", "also-bogus").length, 4); // unparseable ignored
});

test("selectPeriodRows: range overrides the sliding period window", () => {
  const rows = [
    row({ timestampMs: NOW - 40 * DAY }), // outside 30d window, inside range
    row({ timestampMs: NOW - 2 * DAY }), // inside both
  ];
  assert.equal(selectPeriodRows(rows, "30d", NOW).length, 1);
  const start = dateKeyUtc(NOW - 45 * DAY);
  const end = dateKeyUtc(NOW);
  const ranged = selectPeriodRows(rows, "30d", NOW, start, end);
  assert.equal(ranged.length, 2); // override pulls the older row in
});

test("dateRangeDays and rangeEndMs helpers", () => {
  assert.equal(dateRangeDays("2026-10-01", "2026-10-07"), 7);
  assert.equal(dateRangeDays("2026-10-07", "2026-10-01"), 1); // invalid -> 1
  assert.equal(rangeEndMs("2026-10-07", NOW), Date.parse("2026-10-07T23:59:59.999Z"));
  assert.equal(rangeEndMs(undefined, NOW), NOW);
});

test("aggregator honors startDate/endDate with inclusive boundaries (live db)", async () => {
  const { UsageAggregator } = await import("../server/aggregator");
  const aggregator = new UsageAggregator();
  const today = dateKeyUtc(Date.now());
  const single = aggregator.summarize("all", { startDate: today, endDate: today });
  const summary = aggregator.summarize("all", {});
  assert.ok(single.totals.sessions <= summary.totals.sessions);
  assert.ok(single.totals.inputTokens <= summary.totals.inputTokens);
  // boundary: yesterday-only range must not include today's rows
  const yesterday = dateKeyUtc(Date.now() - DAY);
  const yOnly = aggregator.summarize("all", { startDate: yesterday, endDate: yesterday });
  const yPlusToday = aggregator.summarize("all", { startDate: yesterday, endDate: today });
  assert.ok(yOnly.totals.sessions <= yPlusToday.totals.sessions);
  const withFuture = aggregator.summarize("all", { startDate: "2999-01-01", endDate: "2999-01-02" });
  assert.equal(withFuture.totals.sessions, 0);
});

// ---------------------------------------------------------------------------
// Context window occupancy
// ---------------------------------------------------------------------------



test("session resolve stays honest for antigravity agents (no opencode session)", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-agents-agy-"));
  const ws = join(dir, "ws1");
  mkdirSync(ws);
  writeFileSync(
    join(ws, "agent-agy.json"),
    JSON.stringify({ provider: "antigravity", runtimeInfo: { sessionId: "9ba0609a-37ba-47e0-9eb4-3a2776e787d4" } }),
  );
  const result = resolveSessionSummary("agent-agy", {
    agentsDir: dir,
    readAgyCalls: () => ({ calls: [] }), // proxy has no calls for this conversation
  });
  assert.equal(result.found, false);
  assert.match(result.reason ?? "", /no proxied calls/);
});

// ---------------------------------------------------------------------------
// Per-session context occupancy
// ---------------------------------------------------------------------------




test("antigravity session attribution matches conversationId or agentId", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-ctx-agy-"));
  const ws = join(dir, "ws1");
  mkdirSync(ws);
  writeFileSync(
    join(ws, "agent-agy.json"),
    JSON.stringify({
      provider: "antigravity",
      title: "Agy session",
      persistence: { sessionId: 'plugin:{"version":1,"data":{"conversationId":"conv-1"}}' },
    }),
  );
  const calls = [
    { ts: "2026-10-08T09:00:00.000Z", source: "cli" as const, model: "gemini-3-flash", status: 200, promptTokens: 100_000, outputTokens: 10, thinkingTokens: 0, cacheReadTokens: 90_000, cacheWriteTokens: 0, conversationId: "conv-1" },
    { ts: "2026-10-08T10:00:00.000Z", source: "cli" as const, model: "gemini-3-flash", status: 200, promptTokens: 209_715, outputTokens: 20, thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, conversationId: "conv-1" },
    { ts: "2026-10-08T11:00:00.000Z", source: "cli" as const, model: "gemini-3-flash", status: 200, promptTokens: 999, outputTokens: 1, thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, conversationId: "conv-other" },
    { ts: "2026-10-08T12:00:00.000Z", source: "acp" as const, model: "gemini-3-flash", status: 200, promptTokens: 5, outputTokens: 1, thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, agentId: "agent-tagged" },
  ];
  const byConversation = resolveSessionSummary("agent-agy", {
    agentsDir: dir,
    readAgyCalls: () => ({ calls }),
  });
  assert.equal(byConversation.found, true);
  assert.equal(byConversation.backend, "antigravity-cli");
  assert.equal(byConversation.inputTokens, 100_000 + 209_715); // conv-other excluded

  writeFileSync(
    join(ws, "agent-tagged.json"),
    JSON.stringify({ provider: "antigravity-acp", persistence: { sessionId: "tag-uuid-1234-5678-90abcdef0123" } }),
  );
  const byAgentTag = resolveSessionSummary("agent-tagged", {
    agentsDir: dir,
    readAgyCalls: () => ({ calls }),
  });
  assert.equal(byAgentTag.found, true);
  assert.equal(byAgentTag.backend, "antigravity-acp");
  assert.equal(byAgentTag.inputTokens, 5);
});

test("buildPillText: session label is the usage summary", () => {
  const text = buildPillText(sessionFound, null);
  assert.equal(text.label, "1.5M/60.0K·90%");
  assert.match(text.title, /Session: Fix the thing/);
});

test("dashboard 7d bucketing: 7 daily points, active days, no rows lost", async () => {
  const { UsageAggregator } = await import("../server/aggregator");
  const aggregator = new UsageAggregator();
  // Sliding 7d window spans 8 calendar days, so exact-sum checks use an
  // explicit 7-calendar-day range where filter and bucket share boundaries.
  const end = dateKeyUtc(Date.now());
  const start = dateKeyUtc(Date.now() - 6 * DAY);
  const dashboard = aggregator.dashboard("all", { startDate: start, endDate: end });
  assert.equal(dashboard.series.daily.length, 7);
  assert.equal(dashboard.series.daily[0].date, start);
  assert.equal(dashboard.series.daily[6].date, end);
  assert.ok(
    dashboard.series.daily.some((point) => point.inputTokens + point.outputTokens > 0),
    "expected active days within the 7-day range",
  );
  const summary = aggregator.summarize("all", { startDate: start, endDate: end });
  const dailyTokensSum = dashboard.series.daily.reduce(
    (sum, point) => sum + point.inputTokens + point.outputTokens,
    0,
  );
  assert.equal(dailyTokensSum, summary.totals.inputTokens + summary.totals.outputTokens);

  // The 7d period chip itself still buckets exactly 7 points ending today.
  const sliding = aggregator.dashboard("7d", {});
  assert.equal(sliding.series.daily.length, 7);
  assert.equal(sliding.series.daily[6].date, dateKeyUtc(Date.now()));
});

test("bucketDaily with a 7d window: 7 gap-filled entries ending today", () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0); // 2026-10-09T12:00:00Z
  const rows = [
    row({ timestampMs: Date.UTC(2026, 9, 2, 8, 0, 0), inputTokens: 111 }), // 8 days ago: outside the 7-day window
    row({ timestampMs: Date.UTC(2026, 9, 4, 8, 0, 0), inputTokens: 10 }), // day 1
    row({ timestampMs: Date.UTC(2026, 9, 8, 23, 0, 0), inputTokens: 20 }), // day 5
    row({ timestampMs: Date.UTC(2026, 9, 9, 1, 0, 0), inputTokens: 30 }), // day 7 (today)
  ];
  const daily = bucketDaily(rows, 7, now);
  assert.equal(daily.length, 7);
  assert.equal(daily[0].date, "2026-10-03"); // today - 6 days
  assert.equal(daily[6].date, "2026-10-09");
  assert.equal(daily[0].inputTokens, 0); // 10-02 row excluded
  assert.equal(daily[1].inputTokens, 10);
  assert.equal(daily[5].inputTokens, 20);
  assert.equal(daily[6].inputTokens, 30);
  const active = daily.filter((point) => point.inputTokens > 0).length;
  assert.equal(active, 3);
});

// ---------------------------------------------------------------------------
// Protobuf walker + gen_metadata decoding
// ---------------------------------------------------------------------------

import { decodeGenMetadata } from "../server/adapters/antigravity";
import { varintAt, walkProtobuf } from "../server/protobuf";

function varintBytes(value: number): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}

function tag(field: number, wire: number): number[] {
  return varintBytes(field * 8 + wire);
}

function lenDelim(field: number, payload: number[]): number[] {
  return [...tag(field, 2), ...varintBytes(payload.length), ...payload];
}

function varintField(field: number, value: number): number[] {
  return [...tag(field, 0), ...varintBytes(value)];
}

/** Build a synthetic gen_metadata blob with the same paths as the real store. */
function buildGenBlob(input: number, output: number, model: string, used: number, max: number): Uint8Array {
  const usage = [...varintField(1, 1), ...varintField(2, input), ...varintField(3, output)];
  const context = [...varintField(1, used), ...varintField(4, max)];
  const inner = [
    ...varintField(3, 1298),
    ...lenDelim(4, usage),
    ...lenDelim(9, lenDelim(10, context)),
    ...lenDelim(19, [...new TextEncoder().encode(model)]),
  ];
  return new Uint8Array(lenDelim(1, inner));
}

test("protobuf walker decodes synthetic blobs at locked paths", () => {
  const blob = buildGenBlob(20_000, 260, "gemini-3.8-flash", 21_073, 256_000);
  const message = walkProtobuf(blob);
  assert.equal(varintAt(message, "1.4.2"), 20_000);
  assert.equal(varintAt(message, "1.4.3"), 260);
  assert.equal(varintAt(message, "1.9.10.1"), 21_073);
  assert.equal(varintAt(message, "1.9.10.4"), 256_000);
  assert.equal(walkProtobuf(new Uint8Array([0xff, 0xff])).size, 0); // malformed -> empty, no throw
});

test("decodeGenMetadata extracts tokens, model, and context", () => {
  const decoded = decodeGenMetadata(buildGenBlob(12_345, 678, "gemini-3.8-flash", 15_000, 256_000));
  assert.deepEqual(decoded, {
    model: "gemini-3.8-flash",
    inputTokens: 12_345,
    outputTokens: 678,
    contextUsed: 15_000,
    contextMax: 256_000,
  });
  // missing model -> null, never invented
  const noModel = new Uint8Array(lenDelim(1, [...varintField(3, 1), ...lenDelim(4, [...varintField(2, 5), ...varintField(3, 6)])]));
  assert.equal(decodeGenMetadata(noModel), null);
  assert.equal(decodeGenMetadata(new Uint8Array([1, 2, 3])), null);
});

test("scanConversationDb aggregates per model and keeps cache columns honest", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-genscan-"));
  const dbPath = join(dir, "conv1.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE steps (id INTEGER)");
  db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0)");
  const insert = db.prepare("INSERT INTO gen_metadata VALUES (?, ?, 0)");
  insert.run(0, Buffer.from(buildGenBlob(2_000, 74, "gemini-3.8-flash", 2_100, 256_000)));
  insert.run(1, Buffer.from(buildGenBlob(123_000, 5_500, "gemini-3.8-flash", 130_000, 256_000)));
  insert.run(2, Buffer.from(buildGenBlob(700, 90, "claude-sonnet-4-6", 800, 200_000)));
  insert.run(3, Buffer.from(new Uint8Array([9, 9, 9]))); // undecodable row is skipped
  db.prepare("INSERT INTO steps VALUES (1)").run();
  db.close();

  const { steps, byModel } = scanConversationDb(dbPath);
  assert.equal(steps, 1);
  const flash = byModel.get("gemini-3.8-flash");
  assert.equal(flash?.inputTokens, 125_000);
  assert.equal(flash?.outputTokens, 5_574);
  assert.equal(flash?.generations, 2);
  assert.equal(flash?.contextUsed, 130_000); // latest gen wins
  assert.equal(flash?.contextMax, 256_000);
  const claude = byModel.get("claude-sonnet-4-6");
  assert.equal(claude?.generations, 1);
  assert.equal(claude?.inputTokens, 700);
});
