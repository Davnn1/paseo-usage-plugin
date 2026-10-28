import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  aggregateUsage,
  buildPillText,
  tokensPerSecond,
  type UsageRow,
} from "../shared/usage";
import {
  parseMessageUsage,
  readOpenCodeRows,
  readSessionRowById,
} from "../server/adapters/opencode";

const MODEL = JSON.stringify({ id: "deepseek-v4.1-flash", providerID: "omniroute-go" });

function tempDbPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "opencode-schema-")), name);
}

function sessionColumns(): string {
  return `id text PRIMARY KEY, title text, model text, cost real DEFAULT 0 NOT NULL,
    tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
    tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
    tokens_cache_write integer DEFAULT 0 NOT NULL, time_created integer NOT NULL`;
}

interface SessionSeed {
  id: string;
  output?: number;
  input?: number;
  created?: number;
}

function insertSession(db: DatabaseSync, table: string, seed: SessionSeed): void {
  db.prepare(
    `INSERT INTO ${table} (id, title, model, cost, tokens_input, tokens_output, tokens_reasoning,
       tokens_cache_read, tokens_cache_write, time_created) VALUES (?, ?, ?, 0.5, ?, ?, 0, 10, 2, ?)`,
  ).run(
    seed.id,
    `title ${seed.id}`,
    MODEL,
    seed.input ?? 1000,
    seed.output ?? 400,
    seed.created ?? 1_700_000_000_000,
  );
}

function assistantMessage(
  created: number,
  completed: number,
  output: number,
  streamed = completed,
): string {
  return JSON.stringify({
    time: { created, completed, streamed },
    tokens: { input: 100, output, reasoning: 0, cache: { read: 50, write: 0 } },
  });
}

/** v1 layout: `session` + `message` only. */
function buildV1Db(): string {
  const path = tempDbPath("opencode.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session (${sessionColumns()})`);
  db.exec(`CREATE TABLE message (id text PRIMARY KEY, session_id text, data text)`);
  insertSession(db, "session", { id: "ses_v1" });
  db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
    "msg_1",
    "ses_v1",
    assistantMessage(1_000, 3_000, 400),
  );
  db.close();
  return path;
}

/** v2 layout: `session` (legacy) + `session_v2` + `session_message`. */
function buildV2Db(): string {
  const path = tempDbPath("opencode.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session (${sessionColumns()})`);
  db.exec(`CREATE TABLE session_v2 (${sessionColumns()})`);
  db.exec(`CREATE TABLE session_message (
    id text PRIMARY KEY, session_id text, type text, seq integer,
    time_created integer, time_updated integer, data text)`);
  // migrated legacy session exists in both tables: must count once
  insertSession(db, "session", { id: "ses_legacy" });
  insertSession(db, "session_v2", { id: "ses_legacy" });
  // new v2-only session
  insertSession(db, "session_v2", { id: "ses_v2", output: 900 });
  const insertMessage = db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insertMessage.run("sm_1", "ses_v2", "assistant", 1, 1_000, 4_000, assistantMessage(1_000, 4_000, 500));
  insertMessage.run("sm_2", "ses_v2", "assistant", 2, 5_000, 6_000, assistantMessage(5_000, 6_000, 400));
  insertMessage.run("sm_3", "ses_v2", "user", 3, 7_000, 7_000, JSON.stringify({ text: "hi" }));
  db.close();
  return path;
}

test("parseMessageUsage: streamed window is the denominator, completed is ignored", () => {
  // Tool runtime lives between streamed and completed; it must not count.
  const withToolGap = JSON.stringify({
    time: { created: 1_000, streamed: 2_500, completed: 900_000 },
    tokens: { output: 150, reasoning: 50 },
  });
  assert.deepEqual(parseMessageUsage(withToolGap), {
    outputTokens: 150,
    reasoningTokens: 50,
    generationMs: 1_500,
  });
  assert.equal(parseMessageUsage(assistantMessage(1_000, 2_500, 150))?.generationMs, 1_500);
  // No streaming timestamp: unmeasured, never guessed from `completed`.
  const completedOnly = JSON.stringify({
    time: { created: 1_000, completed: 1_800 },
    tokens: { output: 80 },
  });
  assert.equal(parseMessageUsage(completedOnly), null);
  assert.equal(parseMessageUsage("not json"), null);
  assert.equal(parseMessageUsage(JSON.stringify({ tokens: { output: 10 } })), null);
});

test("readOpenCodeRows: reads the v1 session table and legacy messages", () => {
  const rows = readOpenCodeRows(buildV1Db());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, "ses_v1");
  assert.equal(rows[0].provider, "omniroute-go");
  assert.equal(rows[0].outputTokens, 400);
  assert.equal(rows[0].generationMs, 2_000);
});

test("readOpenCodeRows: reads session_v2 and counts migrated legacy rows once", () => {
  const rows = readOpenCodeRows(buildV2Db());
  const ids = rows.map((row) => row.sessionId).sort();
  assert.deepEqual(ids, ["ses_legacy", "ses_v2"]);
  const v2 = rows.find((row) => row.sessionId === "ses_v2");
  assert.equal(v2?.generationMs, 4_000); // 3000ms + 1000ms, user message ignored
  assert.equal(v2?.outputTokens, 900);
});

test("readSessionRowById: finds v2 sessions and their measured generation time", () => {
  const path = buildV2Db();
  const v2 = readSessionRowById("ses_v2", path);
  assert.equal(v2?.title, "title ses_v2");
  assert.equal(v2?.generationMs, 4_000);
  const legacy = readSessionRowById("ses_legacy", path);
  assert.equal(legacy?.id, "ses_legacy");
  assert.equal(readSessionRowById("ses_missing", path), null);
});

test("tokensPerSecond: undefined without measured durations", () => {
  assert.equal(tokensPerSecond(400, 2_000), 200);
  assert.equal(tokensPerSecond(400, 0), undefined);
  assert.equal(tokensPerSecond(0, 2_000), undefined);
  assert.equal(tokensPerSecond(400, -1), undefined);
});

test("aggregateUsage: totals TPS uses summed measured tokens over summed streaming time", () => {
  const rows: UsageRow[] = [
    {
      backend: "opencode",
      provider: "p",
      model: "m",
      sessionId: "a",
      inputTokens: 0,
      outputTokens: 300,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 1,
      timestampMs: 1_700_000_000_000,
      generationMs: 1_000,
    },
    {
      backend: "opencode",
      provider: "p",
      model: "m",
      sessionId: "b",
      inputTokens: 0,
      outputTokens: 300,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 1,
      timestampMs: 1_700_000_100_000,
      generationMs: 2_000,
    },
    {
      backend: "opencode",
      provider: "p",
      model: "other",
      sessionId: "c",
      inputTokens: 0,
      outputTokens: 500,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 1,
      timestampMs: 1_700_000_200_000,
    },
  ];
  const { totals, entries } = aggregateUsage(rows);
  assert.equal(totals.tokensPerSecond, 200); // 600 output / 3s, unmeasured row excluded
  assert.equal(entries.find((entry) => entry.model === "m")?.tokensPerSecond, 200);
  assert.equal(entries.find((entry) => entry.model === "other")?.tokensPerSecond, undefined);
});

test("aggregateUsage: TPS counts reasoning tokens like opencode native", () => {
  const rows: UsageRow[] = [
    {
      backend: "opencode",
      provider: "p",
      model: "m",
      sessionId: "a",
      inputTokens: 0,
      outputTokens: 100,
      reasoningTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 1,
      timestampMs: 1_700_000_000_000,
      generationMs: 2_000,
    },
  ];
  const { totals, entries } = aggregateUsage(rows);
  assert.equal(totals.tokensPerSecond, 200); // (100 output + 300 reasoning) / 2s
  assert.equal(entries[0]?.tokensPerSecond, 200);
});

test("buildPillText: session title carries TPS, label stays compact", () => {
  const base = {
    found: true,
    title: "t",
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRatio: 0,
    costUsd: 0,
    provider: "p",
    model: "m",
  };
  const measured = buildPillText({ ...base, tokensPerSecond: 42.5 }, null);
  assert.match(measured.title, /42\.5 tok\/s/);
  assert.equal(measured.label, "10/20·0%");

  const unmeasured = buildPillText(base, null);
  assert.doesNotMatch(unmeasured.title, /tok\/s/);
});
