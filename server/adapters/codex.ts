import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { UsageRow } from "../../shared/usage";

const SESSIONS_DIR = `${process.env.HOME}/.codex/sessions`;

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexFileResult {
  row: UsageRow | null;
  /** Raw lines that failed JSON.parse; the file is still used when possible. */
  malformedLines: number;
}

/**
 * Parse one codex rollout JSONL file (passed as raw lines for testability).
 * Token precedence per file: the LAST token_count event wins because its
 * `total_token_usage` is the session cumulative sum; `last_token_usage` is the
 * fallback when the cumulative field is absent. Per-entry token fields on other
 * records are ignored to avoid double counting (one row = one adapter = one session).
 */
export function parseCodexLines(lines: string[]): CodexFileResult {
  let model = "";
  let modelProvider = "";
  let timestampMs = 0;
  let sessionTimestampMs = 0;
  let usage: TokenUsage | null = null;
  let malformedLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      malformedLines += 1;
      continue;
    }
    const payload = (obj.payload ?? {}) as Record<string, unknown>;

    if (obj.type === "session_meta") {
      if (typeof payload.model_provider === "string") modelProvider = payload.model_provider;
      const ts = Date.parse(String(obj.timestamp ?? payload.timestamp ?? ""));
      if (Number.isFinite(ts)) sessionTimestampMs = ts;
      continue;
    }

    if (typeof payload.model === "string" && payload.model) model = payload.model;

    if (obj.type === "event_msg" && payload.type === "token_count") {
      const info = (payload.info ?? {}) as Record<string, unknown>;
      const total = info.total_token_usage as TokenUsage | undefined;
      const last = info.last_token_usage as TokenUsage | undefined;
      const chosen = total ?? last ?? null;
      if (chosen) usage = chosen;
      const ts = Date.parse(String(obj.timestamp ?? ""));
      if (Number.isFinite(ts)) timestampMs = ts;
    }
  }

  if (!usage) return { row: null, malformedLines };

  return {
    row: {
      backend: "codex",
      provider: modelProvider || "codex",
      model: model || "unknown",
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      reasoningTokens: usage.reasoning_output_tokens ?? 0,
      cacheReadTokens: usage.cached_input_tokens ?? 0,
      cacheWriteTokens: 0,
      costUsd: 0, // codex sessions do not carry per-turn cost
      timestampMs: timestampMs || sessionTimestampMs,
    },
    malformedLines,
  };
}

function listJsonlFiles(dir: string, depth: number): string[] {
  if (depth > 8) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsonlFiles(path, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Read every codex rollout file. Corrupt files are skipped individually so one
 * bad JSONL never kills the whole source.
 */
export function readCodexRows(sessionsDir: string = SESSIONS_DIR): {
  rows: UsageRow[];
  filesRead: number;
  filesSkipped: number;
} {
  const rows: UsageRow[] = [];
  let filesRead = 0;
  let filesSkipped = 0;
  for (const path of listJsonlFiles(sessionsDir, 0)) {
    try {
      if (statSync(path).size === 0) {
        filesSkipped += 1;
        continue;
      }
      const content = readFileSync(path, "utf8");
      const { row } = parseCodexLines(content.split("\n"));
      if (row) {
        rows.push(row);
        filesRead += 1;
      } else {
        filesSkipped += 1;
      }
    } catch {
      filesSkipped += 1;
    }
  }
  return { rows, filesRead, filesSkipped };
}
