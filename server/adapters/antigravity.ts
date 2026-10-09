import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UsageRow } from "../../shared/usage";
import { stringAt, varintAt, walkProtobuf } from "../protobuf";

export interface AntigravityStats {
  /** Number of conversation database files. */
  sessions: number;
  /** Total rows across every `steps` table. */
  steps: number;
  lastModifiedMs: number;
  /** Per-model token totals decoded from gen_metadata protobuf blobs. */
  byModel: Map<string, ModelTotals>;
  /** One entry per decoded generation, stamped with its file mtime. */
  generations: Generation[];
}

export interface Generation {
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** Conversation UUID - the database file name this generation was read from. */
  conversation: string;
  /** Run/trajectory UUID from the blob; the conversation is the db file itself. */
  runId: string | null;
  /** Harness session id (1.4.8.2) - the reliable cross-source match anchor. */
  sessionId: string | null;
  contextUsed: number | null;
  contextMax: number | null;
  /** The blob carries no timestamp; the conversation file mtime is the
   *  per-generation fallback so rows bucket onto real days. */
  tsMs: number;
}

export interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  /** Number of decoded generations (LLM calls). */
  generations: number;
  /** Latest context occupancy observed for this model (null when never reported). */
  contextUsed: number | null;
  contextMax: number | null;
}

export interface AntigravityCollection {
  /** null when the store directory does not exist on this machine. */
  cli: AntigravityStats | null;
  acp: AntigravityStats | null;
  /** UsageRows derived from decoded gen_metadata, one row per (store, model). */
  rows: UsageRow[];
}

function storeDir(home: string, kind: "cli" | "acp"): string {
  return join(home, ".gemini", `antigravity-${kind}`, "conversations");
}

/**
 * Extract a conversation UUID from a Paseo agent sessionId. Current agents use
 * a plain UUID; older ones wrap it as plugin:{"version":1,"data":{"conversationId":...}}.
 */
export function extractConversationId(sessionId: string): string | null {
  if (!sessionId.startsWith("plugin:")) {
    return /^[0-9a-fA-F-]{36}$/.test(sessionId) ? sessionId : null;
  }
  try {
    const payload = JSON.parse(sessionId.slice("plugin:".length)) as Record<string, unknown>;
    const data = payload.data as Record<string, unknown> | undefined;
    const conversationId = data?.conversationId;
    return typeof conversationId === "string" ? conversationId : null;
  } catch {
    return null;
  }
}

/**
 * Decode one gen_metadata.data protobuf blob.
 *
 * Locked paths (validated against the live stores):
 * - 1.4.2  prompt tokens (cache-inclusive input)
 * - 1.4.3  candidates total = thinking + visible output
 * - 1.4.9  thinking tokens, 1.4.10 visible output tokens
 * - 1.19   model name (string)
 * - 1.9.10 context occupancy message: field 1 = used, field 4 = max
 * - 4      run/trajectory UUID for this generation (NOT the conversation id -
 *          conversation identity comes from the database file name)
 * Returns null when the blob lacks token fields or a model.
 */
export function decodeGenMetadata(data: Uint8Array): {
  model: string;
  /** Prompt tokens (cache-inclusive), matches the proxy promptTokens. */
  inputTokens: number;
  /** Visible output tokens (1.4.10); thinking is tracked separately. */
  outputTokens: number;
  /** Thinking tokens (1.4.9), a component of the candidates total 1.4.3. */
  thinkingTokens: number;
  /** Run/trajectory UUID of this generation, distinct from the conversation. */
  runId: string | null;
  /** Harness session id from 1.4.8.2, shared with the proxy metrics. */
  sessionId: string | null;
  contextUsed: number | null;
  contextMax: number | null;
} | null {
  const message = walkProtobuf(data);
  const inputTokens = varintAt(message, "1.4.2");
  const candidatesTotal = varintAt(message, "1.4.3");
  const model = stringAt(message, "1.19");
  if (inputTokens === null || candidatesTotal === null || !model) return null;
  const thinkingTokens = varintAt(message, "1.4.9") ?? 0;
  const visibleOutput = varintAt(message, "1.4.10") ?? candidatesTotal - thinkingTokens;
  const runId = stringAt(message, "4");
  const sessionId = stringAt(message, "1.4.8.2");
  const contextUsed = varintAt(message, "1.9.10.1");
  const contextMax = varintAt(message, "1.9.10.4") ?? varintAt(message, "1.9.10.2");
  return { model, inputTokens, outputTokens: visibleOutput, thinkingTokens, runId, sessionId, contextUsed, contextMax };
}

/** Count steps and fold every decodable gen_metadata row into totals and generations. */
export function scanConversationDb(dbPath: string, conversation?: string): {
  steps: number;
  byModel: Map<string, ModelTotals>;
  generations: Generation[];
} {
  const conversationId = conversation ?? dbPath.split("/").pop()?.replace(/\.db$/, "") ?? "";
  const byModel = new Map<string, ModelTotals>();
  const generations: Generation[] = [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let steps = 0;
    try {
      const row = db.prepare("SELECT COUNT(*) AS c FROM steps").get() as { c: number };
      steps = row.c;
    } catch {
      steps = 0;
    }
    // The blob has no timestamp (1.9.2 is a 2^64 sentinel) - per-file mtime
    // is the per-generation fallback, and idx order approximates recency.
    const tsMs = statSync(dbPath).mtimeMs;
    let blobs: { data: Uint8Array }[] = [];
    try {
      blobs = db.prepare("SELECT data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx").all() as unknown as {
        data: Uint8Array;
      }[];
    } catch {
      blobs = [];
    }
    for (const { data } of blobs) {
      let decoded: ReturnType<typeof decodeGenMetadata> = null;
      try {
        decoded = decodeGenMetadata(new Uint8Array(data));
      } catch {
        decoded = null; // one corrupt blob must not kill the whole database
      }
      if (!decoded) continue;
      generations.push({
        model: decoded.model,
        inputTokens: decoded.inputTokens,
        outputTokens: decoded.outputTokens,
        thinkingTokens: decoded.thinkingTokens,
        conversation: conversationId,
        runId: decoded.runId,
        sessionId: decoded.sessionId,
        contextUsed: decoded.contextUsed,
        contextMax: decoded.contextMax,
        tsMs,
      });
      let totals = byModel.get(decoded.model);
      if (!totals) {
        totals = { inputTokens: 0, outputTokens: 0, generations: 0, contextUsed: null, contextMax: null };
        byModel.set(decoded.model, totals);
      }
      totals.inputTokens += decoded.inputTokens;
      totals.outputTokens += decoded.outputTokens;
      totals.generations += 1;
      if (decoded.contextUsed !== null) {
        totals.contextUsed = decoded.contextUsed;
        totals.contextMax = decoded.contextMax;
      }
    }
    return { steps, byModel, generations };
  } finally {
    db.close();
  }
}

/** Scan one conversations directory: file count, steps, per-model totals. */
export function collectStats(dir: string): AntigravityStats | null {
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const stats: AntigravityStats = { sessions: 0, steps: 0, lastModifiedMs: 0, byModel: new Map(), generations: [] };
  for (const name of entries) {
    if (!name.endsWith(".db") || name.endsWith("-wal.db")) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      stats.sessions += 1;
      const { steps, byModel, generations } = scanConversationDb(path, name.replace(/\.db$/, ""));
      stats.steps += steps;
      stats.generations.push(...generations);
      for (const [model, totals] of byModel) {
        const existing = stats.byModel.get(model);
        if (!existing) {
          stats.byModel.set(model, { ...totals });
        } else {
          existing.inputTokens += totals.inputTokens;
          existing.outputTokens += totals.outputTokens;
          existing.generations += totals.generations;
          if (totals.contextUsed !== null) {
            existing.contextUsed = totals.contextUsed;
            existing.contextMax = totals.contextMax;
          }
        }
      }
      const mtime = statSync(path).mtimeMs;
      if (mtime > stats.lastModifiedMs) stats.lastModifiedMs = mtime;
    } catch {
      /* unreadable file: skip, honest counts only */
    }
  }
  return stats;
}

/**
 * Antigravity stores usage inside plain SQLite conversation databases. The
 * gen_metadata blobs are protobuf and carry real per-generation token counts;
 * conversation cache columns hold no token data and stay zero - never invented.
 */
export interface CacheEnrichment {
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Strict match key shared with the aggregator's proxy enrichment map.
 * Anchored on (conversation, harness sessionId, output, thinking): model
 * names differ across sources (requested vs served suffixes) and cached
 * calls record different input splits, but the harness session id matches.
 */
export function enrichmentKey(conversation: string, sessionId: string, output: number, thinking: number): string {
  return `${conversation}|${sessionId}|${output}|${thinking}`;
}

export function collectAntigravity(
  home: string = process.env.HOME ?? "",
  enrichment?: Map<string, CacheEnrichment>,
): AntigravityCollection {
  const cli = collectStats(storeDir(home, "cli"));
  const acp = collectStats(storeDir(home, "acp"));
  const rows: UsageRow[] = [];
  const pushRows = (stats: AntigravityStats | null, backend: string, provider: string) => {
    if (!stats) return;
    // One row per generation so daily bucketing lands on real days; token
    // sums per model are identical either way.
    for (const generation of stats.generations) {
      // Cache columns are absent from the protobuf blob; the agy-usage-proxy
      // fills them via a strict (conversation, model, input, output,
      // thinking) match - columns only, never rows or token aggregates.
      const cache = generation.sessionId
        ? enrichment?.get(enrichmentKey(generation.conversation, generation.sessionId, generation.outputTokens, generation.thinkingTokens))
        : undefined;
      rows.push({
        backend,
        provider,
        model: generation.model,
        inputTokens: generation.inputTokens,
        outputTokens: generation.outputTokens,
        reasoningTokens: generation.thinkingTokens,
        cacheReadTokens: cache?.cacheReadTokens ?? 0,
        cacheWriteTokens: cache?.cacheWriteTokens ?? 0,
        costUsd: 0, // no cost recorded locally
        timestampMs: generation.tsMs,
      });
    }
  };
  pushRows(cli, "antigravity-cli", "agy");
  pushRows(acp, "antigravity-acp", "agy");
  return { cli, acp, rows };
}
