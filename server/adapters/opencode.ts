import { DatabaseSync } from "node:sqlite";
import type { UsageRow } from "../../shared/usage";

const DB_PATH = `${process.env.HOME}/.local/share/opencode/opencode.db`;

interface SessionRecord {
  id?: string;
  title?: string;
  model: string | null;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  time_created: number;
}

const SESSION_COLUMNS = `id, title, model, cost, tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write, time_created`;

/**
 * OpenCode v1 stores sessions in `session`, v2 in `session_v2` (`session` is
 * kept as the legacy table; v2 migrates those rows into `session_v2`). Read
 * whichever exists and union legacy-only rows so neither generation is lost.
 */
function selectSessions(db: DatabaseSync): SessionRecord[] {
  const hasV2 = tableExists(db, "session_v2");
  const hasV1 = tableExists(db, "session");
  if (hasV2 && hasV1) {
    return db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM session_v2
         UNION ALL
         SELECT ${SESSION_COLUMNS} FROM session WHERE id NOT IN (SELECT id FROM session_v2)`,
      )
      .all() as unknown as SessionRecord[];
  }
  const table = hasV2 ? "session_v2" : "session";
  if (!hasV1 && !hasV2) throw new Error("opencode.db has no session table");
  return db.prepare(`SELECT ${SESSION_COLUMNS} FROM ${table}`).all() as unknown as SessionRecord[];
}

/** Look up one session in the v2 table first, then the legacy v1 table. */
function selectSessionById(db: DatabaseSync, sessionId: string): SessionRecord | undefined {
  const tables = ["session_v2", "session"].filter((table) => tableExists(db, table));
  for (const table of tables) {
    const row = db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM ${table} WHERE id = ?`)
      .get(sessionId) as SessionRecord | undefined;
    if (row) return row;
  }
  return undefined;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { present?: number } | undefined;
  return row?.present === 1;
}

interface MessageTime {
  created?: number;
  completed?: number;
  streamed?: number;
}

interface MessageTokens {
  output?: number;
}

interface MessageRecord {
  session_id: string;
  data: string;
}

/**
 * Sum measured generation time per session, in ms.
 *
 * v2 keeps messages in `session_message`; v1 used `message` (v2 migrates v1
 * messages into `session_message`, and v1 rows never carry completion times).
 * Duration is completed-at minus created-at, falling back to the last streamed
 * timestamp; rows without a positive duration contribute nothing.
 */
function generationMsBySession(db: DatabaseSync, sessionId?: string): Map<string, number> {
  const bySession = new Map<string, number>();
  const source = tableExists(db, "session_message")
    ? { table: "session_message", where: "type = 'assistant'" }
    : tableExists(db, "message")
      ? { table: "message", where: `data LIKE '%"tokens"%'` }
      : null;
  if (!source) return bySession;

  const filter = sessionId === undefined ? "" : " AND session_id = ?";
  const statement = db.prepare(
    `SELECT session_id, data FROM ${source.table} WHERE ${source.where}${filter}`,
  );
  const rows = (
    sessionId === undefined ? statement.all() : statement.all(sessionId)
  ) as unknown as MessageRecord[];
  for (const row of rows) {
    const parsed = parseMessageUsage(row.data);
    if (!parsed) continue;
    bySession.set(row.session_id, (bySession.get(row.session_id) ?? 0) + parsed.generationMs);
  }
  return bySession;
}

/** Extract output tokens + generation duration from one assistant message. */
export function parseMessageUsage(raw: string): { outputTokens: number; generationMs: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const tokens = record.tokens as MessageTokens | undefined;
  const time = record.time as MessageTime | undefined;
  const outputTokens = typeof tokens?.output === "number" ? tokens.output : 0;
  const created = typeof time?.created === "number" ? time.created : undefined;
  const finished =
    typeof time?.completed === "number"
      ? time.completed
      : typeof time?.streamed === "number"
        ? time.streamed
        : undefined;
  if (!created || finished === undefined) return null;
  const generationMs = finished - created;
  if (!(generationMs > 0)) return null;
  return { outputTokens, generationMs };
}

export function readOpenCodeRows(dbPath: string = DB_PATH): UsageRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessions = selectSessions(db);
    const generationMs = generationMsBySession(db);
    const result: UsageRow[] = [];
    for (const row of sessions) {
      const parsed = parseModelJson(row.model);
      if (!parsed) continue; // row without a model JSON contributes no attributable usage
      const generation = row.id ? generationMs.get(row.id) : undefined;
      result.push({
        backend: "opencode",
        provider: parsed.providerID || "unknown",
        model: parsed.id || "unknown",
        sessionId: row.id,
        inputTokens: row.tokens_input ?? 0,
        outputTokens: row.tokens_output ?? 0,
        reasoningTokens: row.tokens_reasoning ?? 0,
        cacheReadTokens: row.tokens_cache_read ?? 0,
        cacheWriteTokens: row.tokens_cache_write ?? 0,
        costUsd: row.cost ?? 0,
        timestampMs: row.time_created ?? 0,
        ...(generation ? { generationMs: generation } : {}),
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

export interface SessionRow {
  id: string;
  title: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  cacheHitRatio: number;
  timeCreated: number;
  generationMs?: number;
}

/** Map one raw session table row; null when the model JSON is unusable. */
export function mapSessionRow(raw: SessionRecord): Omit<SessionRow, "cacheHitRatio"> | null {
  const parsed = parseModelJson(raw.model);
  if (!parsed) return null;
  return {
    id: raw.id ?? "",
    title: raw.title ?? "",
    provider: parsed.providerID || "unknown",
    model: parsed.id || "unknown",
    inputTokens: raw.tokens_input ?? 0,
    outputTokens: raw.tokens_output ?? 0,
    reasoningTokens: raw.tokens_reasoning ?? 0,
    cacheReadTokens: raw.tokens_cache_read ?? 0,
    cacheWriteTokens: raw.tokens_cache_write ?? 0,
    costUsd: raw.cost ?? 0,
    timeCreated: raw.time_created ?? 0,
  };
}

/** Look up a single session row by id; null when absent or unparseable. */
export function readSessionRowById(sessionId: string, dbPath: string = DB_PATH): SessionRow | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const raw = selectSessionById(db, sessionId);
    if (!raw) return null;
    const mapped = mapSessionRow(raw);
    if (!mapped) return null;
    const generationMs = generationMsBySession(db, sessionId).get(sessionId);
    return {
      ...mapped,
      cacheHitRatio: cacheHit(mapped.cacheReadTokens, mapped.inputTokens),
      ...(generationMs ? { generationMs } : {}),
    };
  } finally {
    db.close();
  }
}

function cacheHit(cacheReadTokens: number, inputTokens: number): number {
  const denom = cacheReadTokens + inputTokens;
  return denom > 0 ? cacheReadTokens / denom : 0;
}
