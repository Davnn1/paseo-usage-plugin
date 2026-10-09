import { existsSync, readFileSync } from "node:fs";
import type { UsageRow } from "../../shared/usage";

const DEFAULT_PATH = `${process.env.HOME}/.local/share/agy-usage-proxy/metrics.jsonl`;

export interface AgyCall {
  ts: string;
  source: "cli" | "acp" | "agy";
  model: string;
  status: number;
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Optional proxy tag (path /cli/<tag>); extra fields are ignore-safe. */
  agentId?: string;
  /** Optional Antigravity conversation id for per-session attribution. */
  conversationId?: string;
  /** Harness session id, shared with the gen_metadata blob (1.4.8.2). */
  sessionId?: string;
}

export interface AgyProxyResult {
  /** "no_data_source" when the metrics file is missing or empty. */
  status: "ok" | "no_data_source";
  /** One UsageRow per proxied LLM call; each row counts exactly one call. */
  rows: UsageRow[];
  callsBySource: Record<"cli" | "acp" | "agy", number>;
  /** Parsed calls (ignore-safe extras included) for per-session attribution. */
  calls: AgyCall[];
}

const SOURCE_BACKENDS: Record<AgyCall["source"], { backend: string; provider: string }> = {
  // Coverage maps Paseo provider "antigravity" to backend "antigravity-cli"
  // and "antigravity-acp" to itself, so proxy rows share those backends and
  // the Coverage rows describe the same identity as the token table.
  cli: { backend: "antigravity-cli", provider: "antigravity" },
  acp: { backend: "antigravity-acp", provider: "antigravity-acp" },
  // Harness-level calls that cannot be attributed to cli or acp stay their
  // own honest identity instead of being folded into either one.
  agy: { backend: "agy-proxy", provider: "harness" },
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Parse one metrics line; null for blank/malformed/foreign lines. */
export function parseAgyLine(line: string): AgyCall | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const source = obj.source;
  if (source !== "cli" && source !== "acp" && source !== "agy") return null;
  const ts = typeof obj.ts === "string" ? obj.ts : "";
  const parsedTs = Date.parse(ts);
  return {
    ts,
    source,
    model: typeof obj.model === "string" && obj.model ? obj.model : "unknown",
    agentId: typeof obj.agentId === "string" && obj.agentId ? obj.agentId : undefined,
  conversationId: typeof obj.conversationId === "string" && obj.conversationId ? obj.conversationId : undefined,
  sessionId: typeof obj.sessionId === "string" && obj.sessionId ? obj.sessionId : undefined,
    status: num(obj.status),
    promptTokens: num(obj.promptTokens),
    outputTokens: num(obj.outputTokens),
    thinkingTokens: num(obj.thinkingTokens),
    cacheReadTokens: num(obj.cacheReadTokens),
    cacheWriteTokens: num(obj.cacheWriteTokens),
  };
}

/** Aggregate parsed calls into one UsageRow per call (aggregation happens in shared/aggregateUsage). */
export function callsToRows(calls: AgyCall[]): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const call of calls) {
    const target = SOURCE_BACKENDS[call.source];
    rows.push({
      backend: target.backend,
      provider: target.provider,
      model: call.model,
      inputTokens: call.promptTokens,
      outputTokens: call.outputTokens,
      reasoningTokens: call.thinkingTokens,
      cacheReadTokens: call.cacheReadTokens,
      cacheWriteTokens: call.cacheWriteTokens,
      costUsd: 0, // agy-usage-proxy does not record cost
      timestampMs: Number.isFinite(Date.parse(call.ts)) ? Date.parse(call.ts) : 0,
    });
  }
  return rows;
}

/** Read the metrics jsonl; a missing or empty file is no_data_source, never an error. */
export function readAgyProxyRows(
  path: string = process.env.AGY_PROXY_METRICS ?? DEFAULT_PATH,
): AgyProxyResult {
  const empty: AgyProxyResult = {
    status: "no_data_source",
    rows: [],
    callsBySource: { cli: 0, acp: 0, agy: 0 },
    calls: [],
  };
  if (!existsSync(path)) return empty;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return empty;
  }
  if (!content.trim()) return empty;

  const calls: AgyCall[] = [];
  const callsBySource: AgyProxyResult["callsBySource"] = { cli: 0, acp: 0, agy: 0 };
  for (const line of content.split("\n")) {
    const call = parseAgyLine(line);
    if (!call) continue;
    calls.push(call);
    callsBySource[call.source] += 1;
  }
  if (calls.length === 0) return { ...empty, callsBySource };
  return { status: "ok", rows: callsToRows(calls), callsBySource, calls };
}
