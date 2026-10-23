import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { usageSummaryRpc } from "../shared/usage";
import { createOpencodeAdapter } from "./adapters/opencode";
import { aggregateUsage, cacheHitRatio, periodCutoff } from "./aggregator";
import type { AdapterResult } from "./types";

const FIXTURE = join(import.meta.dirname, "__fixtures__", "opencode-sessions.json");

interface FixtureRow {
  id: string;
  model: string;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost: number;
  time_created: number;
}

function buildFixtureDb(): string {
  const rows = JSON.parse(readFileSync(FIXTURE, "utf8")) as FixtureRow[];
  const dir = mkdtempSync(join(tmpdir(), "usage-test-"));
  const dbPath = join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session (
    id text PRIMARY KEY, model text, cost real DEFAULT 0 NOT NULL,
    tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
    tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
    tokens_cache_write integer DEFAULT 0 NOT NULL, time_created integer NOT NULL
  )`);
  const insert = db.prepare(
    `INSERT INTO session (id, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.model,
      row.cost,
      row.tokens_input,
      row.tokens_output,
      row.tokens_reasoning,
      row.tokens_cache_read,
      row.tokens_cache_write,
      row.time_created,
    );
  }
  db.close();
  return dbPath;
}

async function fixtureResults(): Promise<AdapterResult[]> {
  const adapter = createOpencodeAdapter(buildFixtureDb());
  return [await adapter.collect()];
}

test("opencode adapter reads fixture db with provider/model split", async () => {
  const [result] = await fixtureResults();
  assert.equal(result.status, "ok");
  assert.equal(result.rows.length, 19);
  const row = result.rows.find((r) => r.sessionId);
  assert.ok(row);
  assert.ok(row.provider.length > 0);
  assert.ok(row.model.length > 0);
  // Row with model JSON carrying the name in providerID falls back correctly.
  const odd = result.rows.find((r) => r.model === "kimi-k2.6");
  assert.ok(odd);
});

test("periodCutoff windows", () => {
  const now = 1_800_000_000_000;
  assert.equal(periodCutoff("all", now), 0);
  assert.equal(periodCutoff("1d", now), now - 86_400_000);
  assert.equal(periodCutoff("7d", now), now - 7 * 86_400_000);
  assert.equal(periodCutoff("30d", now), now - 30 * 86_400_000);
});

test("cacheHitRatio formula", () => {
  assert.equal(cacheHitRatio(90, 10), 0.9);
  assert.equal(cacheHitRatio(0, 0), 0);
  assert.equal(cacheHitRatio(50, 0), 1);
});

test("aggregation: totals equal sum of byProvider entries", async () => {
  const results = await fixtureResults();
  const newest = Math.max(...results[0].rows.map((r) => r.timeCreated));
  const data = aggregateUsage(results, "all", newest + 1);
  const sumInput = data.byProvider.flatMap((g) => g.entries).reduce((s, e) => s + e.inputTokens, 0);
  const sumCost = data.byProvider.flatMap((g) => g.entries).reduce((s, e) => s + e.costUsd, 0);
  const sumSessions = data.byProvider.flatMap((g) => g.entries).reduce((s, e) => s + e.sessions, 0);
  assert.equal(data.totals.inputTokens, sumInput);
  assert.ok(Math.abs(data.totals.costUsd - sumCost) < 1e-6);
  assert.equal(data.totals.sessions, sumSessions);
  assert.equal(data.sources[0].status, "used");
});

test("aggregation: 30d period filter excludes older rows", async () => {
  const results = await fixtureResults();
  const newest = Math.max(...results[0].rows.map((r) => r.timeCreated));
  const all = aggregateUsage(results, "all", newest + 1);
  const d30 = aggregateUsage(results, "30d", newest + 1);
  assert.ok(d30.totals.inputTokens <= all.totals.inputTokens);
  const cutoff = newest + 1 - 30 * 86_400_000;
  const expected = results[0].rows.filter((r) => r.timeCreated >= cutoff);
  assert.equal(d30.totals.sessions, new Set(expected.map((r) => r.sessionId)).size);
});

test("aggregation: firstUsed/lastUsed and per-entry sessions", async () => {
  const results = await fixtureResults();
  const newest = Math.max(...results[0].rows.map((r) => r.timeCreated));
  const data = aggregateUsage(results, "all", newest + 1);
  for (const group of data.byProvider) {
    for (const entry of group.entries) {
      assert.ok(entry.lastUsed >= entry.firstUsed);
      assert.ok(entry.sessions >= 1);
      assert.ok(entry.cacheHitRatio >= 0 && entry.cacheHitRatio <= 1);
    }
  }
});

test("aggregation: no_data_source adapter degrades without killing output", () => {
  const results: AdapterResult[] = [
    { backend: "opencode", status: "ok", rows: [] },
    { backend: "gemini", status: "no_data_source", detail: "protobuf only", rows: [] },
  ];
  const data = aggregateUsage(results, "all", Date.now());
  assert.equal(data.byProvider.length, 0);
  assert.equal(data.sources.find((s) => s.backend === "gemini")?.status, "no_data_source");
  assert.equal(data.sources.find((s) => s.backend === "opencode")?.status, "never_used");
});

test("contract: usage.summary rejects invalid period", () => {
  assert.ok(!usageSummaryRpc.input.safeParse({ period: "90d" }).success);
  assert.ok(!usageSummaryRpc.input.safeParse({}).success);
  assert.ok(usageSummaryRpc.input.safeParse({ period: "30d" }).success);
});
