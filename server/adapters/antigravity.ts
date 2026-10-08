import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AntigravityStats {
  /** Number of conversation database files. */
  sessions: number;
  /** Total rows across every `steps` table. */
  steps: number;
  lastModifiedMs: number;
}

export interface AntigravityCollection {
  /** null when the store directory does not exist on this machine. */
  cli: AntigravityStats | null;
  acp: AntigravityStats | null;
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

/** Count rows in one conversation database; unreadable/missing tables count 0. */
export function countSteps(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM steps").get() as { c: number };
    return row.c;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/** Scan one conversations directory: file count, total steps, newest mtime. */
export function collectStats(dir: string): AntigravityStats | null {
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const stats: AntigravityStats = { sessions: 0, steps: 0, lastModifiedMs: 0 };
  for (const name of entries) {
    if (!name.endsWith(".db") || name.endsWith("-wal.db")) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      stats.sessions += 1;
      stats.steps += countSteps(path);
      const mtime = statSync(path).mtimeMs;
      if (mtime > stats.lastModifiedMs) stats.lastModifiedMs = mtime;
    } catch {
      /* unreadable file: skip, honest counts only */
    }
  }
  return stats;
}

/**
 * Antigravity stores usage as plain SQLite conversation databases — readable,
 * but they record step counts, not token numbers. Token columns stay zero;
 * sessions and steps are real counts.
 */
export function collectAntigravity(home: string = process.env.HOME ?? ""): AntigravityCollection {
  return {
    cli: collectStats(storeDir(home, "cli")),
    acp: collectStats(storeDir(home, "acp")),
  };
}
