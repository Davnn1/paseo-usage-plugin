import { DatabaseSync } from "node:sqlite";
import type { UsageRow } from "../../shared/usage";

const DB_PATH = `${process.env.HOME}/.local/share/opencode/opencode.db`;

interface SessionRecord {
  model: string | null;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  time_created: number;
}

export function readOpenCodeRows(dbPath: string = DB_PATH): UsageRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT model, cost, tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write, time_created
         FROM session`,
      )
      .all() as unknown as SessionRecord[];
    const result: UsageRow[] = [];
    for (const row of rows) {
      const parsed = parseModelJson(row.model);
      if (!parsed) continue; // row without a model JSON contributes no attributable usage
      result.push({
        backend: "opencode",
        provider: parsed.providerID || "unknown",
        model: parsed.id || "unknown",
        inputTokens: row.tokens_input ?? 0,
        outputTokens: row.tokens_output ?? 0,
        reasoningTokens: row.tokens_reasoning ?? 0,
        cacheReadTokens: row.tokens_cache_read ?? 0,
        cacheWriteTokens: row.tokens_cache_write ?? 0,
        costUsd: row.cost ?? 0,
        timestampMs: row.time_created ?? 0,
      });
    }
    return result;
  } finally {
    db.close();
  }
}

export function parseModelJson(
  raw: string | null,
): { id: string; providerID: string } | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    return {
      id: typeof record.id === "string" ? record.id : "",
      providerID: typeof record.providerID === "string" ? record.providerID : "",
    };
  } catch {
    return null;
  }
}
