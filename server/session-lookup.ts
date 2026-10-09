import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionSummaryOutput } from "../shared/usage";
import { readSessionRowById } from "./adapters/opencode";
import { readAgyProxyRows, type AgyCall } from "./adapters/agy-proxy";
import { scanConversationDb } from "./adapters/antigravity";

const AGENTS_DIR = `${process.env.HOME}/.paseo/agents`;

function emptySummary(): SessionSummaryOutput {
  return {
    found: false,
    reason: undefined,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    cacheHitRatio: 0,
    timeCreated: 0,
  };
}

function notFound(reason: string): SessionSummaryOutput {
  return { ...emptySummary(), reason };
}

/**
 * Extract the linked provider session id from a Paseo agent JSON file.
 * OpenCode sessions look like `ses_...`; Antigravity uses a plain conversation
 * UUID or plugin:{"version":1,"data":{"conversationId":...}}.
 */
export function extractSessionId(agentJson: unknown): string | null {
  if (typeof agentJson !== "object" || agentJson === null) return null;
  const root = agentJson as Record<string, unknown>;
  for (const path of ["persistence", "runtimeInfo"] as const) {
    const section = root[path];
    if (typeof section !== "object" || section === null) continue;
    const sessionId = (section as Record<string, unknown>).sessionId;
    if (typeof sessionId === "string" && sessionId) return sessionId;
  }
  return null;
}

/** Locate ~/.paseo/agents/<workspace>/<agentId>.json across workspaces. */
export function findAgentFile(agentsDir: string, agentId: string): string | null {
  if (!existsSync(agentsDir)) return null;
  let workspaces;
  try {
    workspaces = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const candidate = join(agentsDir, workspace.name, `${agentId}.json`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface SessionSummaryDeps {
  agentsDir?: string;
  readSession?: typeof readSessionRowById;
  readAgyCalls?: () => { calls: AgyCall[] };
  /** Override the antigravity store home (tests point this at fixtures). */
  agyHome?: string;
}

/**
 * Resolve the current usage of the session linked to a Paseo agent.
 * - opencode: session table row + live context from the last message
 * - antigravity / antigravity-acp: agy-usage-proxy calls attributed by
 *   conversation id (or proxy agentId tag)
 * Honest fallbacks everywhere: missing file, missing id, no matching calls.
 */
export function resolveSessionSummary(agentId: string, deps: SessionSummaryDeps = {}): SessionSummaryOutput {
  const agentsDir = deps.agentsDir ?? AGENTS_DIR;
  const readSession = deps.readSession ?? readSessionRowById;

  const file = findAgentFile(agentsDir, agentId);
  if (!file) return notFound("agent file not found");

  let agentJson: unknown;
  try {
    agentJson = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return notFound("agent file unreadable");
  }
  const agent = (typeof agentJson === "object" && agentJson !== null ? agentJson : {}) as Record<string, unknown>;
  const provider = typeof agent.provider === "string" ? agent.provider : undefined;
  const title = typeof agent.title === "string" ? agent.title : undefined;

  if (provider === "opencode") return resolveOpenCode(agentJson, { readSession });
  if (provider === "antigravity" || provider === "antigravity-acp") {
    return resolveAntigravity(agentId, agentJson, provider, title, deps);
  }
  return notFound(provider ? `non-opencode agent (${provider})` : "provider unknown");
}

function resolveOpenCode(
  agentJson: unknown,
  deps: { readSession: NonNullable<SessionSummaryDeps["readSession"]> },
): SessionSummaryOutput {
  const sessionId = extractSessionId(agentJson);
  if (!sessionId || !sessionId.startsWith("ses_")) return notFound("no linked opencode session");
  const row = deps.readSession(sessionId);
  if (!row) return notFound(`session ${sessionId} not in opencode.db`);

  return {
    found: true,
    backend: "opencode",
    sessionId,
    title: row.title,
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.costUsd,
    cacheHitRatio: row.cacheHitRatio,
    timeCreated: row.timeCreated,
  };
}

function resolveAntigravity(
  agentId: string,
  agentJson: unknown,
  provider: "antigravity" | "antigravity-acp",
  title: string | undefined,
  deps: SessionSummaryDeps,
): SessionSummaryOutput {
  const sessionId = extractSessionId(agentJson);
  const conversationId = sessionId?.startsWith("plugin:") ? extractPluginConversationId(sessionId) : sessionId;
  if (!conversationId) return notFound("no linked antigravity conversation");

  const agy = deps.readAgyCalls ? deps.readAgyCalls() : readAgyProxyRows();
  const matched = agy.calls.filter(
    (call) => call.conversationId === conversationId || call.agentId === agentId,
  );
  if (matched.length === 0) {
    // Proxy knows nothing yet (or predates it) - fall back to the decoded
    // conversation store so the pill reflects real session usage.
    return resolveAntigravityFromStore(agentId, conversationId, provider, title, deps);
  }

  const sums = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let latest: AgyCall | null = null;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const call of matched) {
    sums.inputTokens += call.promptTokens;
    sums.outputTokens += call.outputTokens;
    sums.reasoningTokens += call.thinkingTokens;
    sums.cacheReadTokens += call.cacheReadTokens;
    sums.cacheWriteTokens += call.cacheWriteTokens;
    const tsMs = Date.parse(call.ts);
    if (Number.isFinite(tsMs) && tsMs < earliestMs) earliestMs = tsMs;
    if (!latest || Date.parse(call.ts) > Date.parse(latest.ts)) latest = call;
  }

  const denom = sums.cacheReadTokens + sums.inputTokens;

  return {
    found: true,
    backend: provider === "antigravity" ? "antigravity-cli" : "antigravity-acp",
    sessionId: conversationId,
    title,
    provider,
    model: latest?.model ?? "unknown",
    ...sums,
    costUsd: 0,
    cacheHitRatio: denom > 0 ? sums.cacheReadTokens / denom : 0,
    timeCreated: Number.isFinite(earliestMs) ? earliestMs : 0,
  };
}

function resolveAntigravityFromStore(
  agentId: string,
  conversationId: string,
  provider: "antigravity" | "antigravity-acp",
  title: string | undefined,
  deps: SessionSummaryDeps,
): SessionSummaryOutput {
  const home = deps.agyHome ?? process.env.HOME ?? "";
  const dirs =
    provider === "antigravity"
      ? [join(home, ".gemini", "antigravity-cli", "conversations")]
      : [join(home, ".gemini", "antigravity-acp", "conversations")];
  let generations: ReturnType<typeof scanConversationDb>["generations"] = [];
  for (const dir of dirs) {
    const candidate = join(dir, `${conversationId}.db`);
    if (!existsSync(candidate)) continue;
    try {
      generations = scanConversationDb(candidate).generations.filter(
        (generation) => generation.conversationId === null || generation.conversationId === conversationId,
      );
      if (generations.length > 0) break;
    } catch {
      /* unreadable store: stay honest */
    }
  }
  if (generations.length === 0) return notFound("no usage recorded for this session");

  const sums = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let earliestMs = Number.POSITIVE_INFINITY;
  let latestModel = "unknown";
  let context: { used: number; max: number } | null = null;
  for (const generation of generations) {
    sums.inputTokens += generation.inputTokens;
    sums.outputTokens += generation.outputTokens;
    if (generation.tsMs < earliestMs) earliestMs = generation.tsMs;
    latestModel = generation.model;
    if (generation.contextUsed !== null && generation.contextMax !== null) {
      context = { used: generation.contextUsed, max: generation.contextMax };
    }
  }
  return {
    found: true,
    backend: provider === "antigravity" ? "antigravity-cli" : "antigravity-acp",
    sessionId: conversationId,
    title,
    provider,
    model: latestModel,
    ...sums,
    costUsd: 0,
    cacheHitRatio: 0,
    timeCreated: Number.isFinite(earliestMs) ? earliestMs : 0,
    ...(context ? { detail: `ctx ${context.used}/${context.max} latest` } : {}),
  };
}

function extractPluginConversationId(sessionId: string): string | null {
  try {
    const payload = JSON.parse(sessionId.slice("plugin:".length)) as Record<string, unknown>;
    const data = payload.data as Record<string, unknown> | undefined;
    return typeof data?.conversationId === "string" ? data.conversationId : null;
  } catch {
    return null;
  }
}
