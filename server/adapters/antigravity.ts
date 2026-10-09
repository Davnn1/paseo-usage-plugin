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
 * - 1.4.2  input tokens, 1.4.3 output tokens (per generation)
 * - 1.19   model name (string)
 * - 1.9.10 context occupancy message: field 1 = used, field 4 = max
 * Returns null when the blob lacks token fields or a model.
 */
export function decodeGenMetadata(data: Uint8Array): {
  model: string;
  inputTokens: number;
  outputTokens: number;
  contextUsed: number | null;
  contextMax: number | null;
} | null {
  const message = walkProtobuf(data);
  const inputTokens = varintAt(message, "1.4.2");
  const outputTokens = varintAt(message, "1.4.3");
  const model = stringAt(message, "1.19");
  if (inputTokens === null || outputTokens === null || !model) return null;
  const contextUsed = varintAt(message, "1.9.10.1");
  const contextMax = varintAt(message, "1.9.10.4") ?? varintAt(message, "1.9.10.2");
  return { model, inputTokens, outputTokens, contextUsed, contextMax };
}

/** Count steps and fold every decodable gen_metadata row into per-model totals. */
export function scanConversationDb(dbPath: string): {
  steps: number;
  byModel: Map<string, ModelTotals>;
} {
  const byModel = new Map<string, ModelTotals>();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let steps = 0;
    try {
      const row = db.prepare("SELECT COUNT(*) AS c FROM steps").get() as { c: number };
      steps = row.c;
    } catch {
      steps = 0;
    }
    let blobs: { data: Uint8Array }[] = [];
    try {
      blobs = db.prepare("SELECT data FROM gen_metadata WHERE data IS NOT NULL").all() as unknown as {
        data: Uint8Array;
      }[];
    } catch {
      blobs = [];
    }
    // gen_metadata.idx asc approximates generation order, so the last decoded
    // context occupancy per model is the most recent one.
    for (const { data } of blobs) {
      const decoded = decodeGenMetadata(new Uint8Array(data));
      if (!decoded) continue;
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
    return { steps, byModel };
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
  const stats: AntigravityStats = { sessions: 0, steps: 0, lastModifiedMs: 0, byModel: new Map() };
  for (const name of entries) {
    if (!name.endsWith(".db") || name.endsWith("-wal.db")) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      stats.sessions += 1;
      const { steps, byModel } = scanConversationDb(path);
      stats.steps += steps;
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
export function collectAntigravity(home: string = process.env.HOME ?? ""): AntigravityCollection {
  const cli = collectStats(storeDir(home, "cli"));
  const acp = collectStats(storeDir(home, "acp"));
  const rows: UsageRow[] = [];
  const pushRows = (stats: AntigravityStats | null, backend: string, provider: string) => {
    if (!stats) return;
    for (const [model, totals] of stats.byModel) {
      rows.push({
        backend,
        provider,
        model,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        reasoningTokens: 0, // not recorded separately in gen_metadata
        cacheReadTokens: 0, // cache columns carry no token data - honest zeros
        cacheWriteTokens: 0,
        costUsd: 0, // no cost recorded locally
        timestampMs: stats.lastModifiedMs,
      });
    }
  };
  pushRows(cli, "antigravity-cli", "agy");
  pushRows(acp, "antigravity-acp", "agy");
  return { cli, acp, rows };
}
