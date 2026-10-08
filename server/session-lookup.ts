import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionSummaryOutput } from "../shared/usage";
import { readSessionRowById } from "./adapters/opencode";

const AGENTS_DIR = `${process.env.HOME}/.paseo/agents`;

function notFound(reason: string): SessionSummaryOutput {
  return {
    found: false,
    reason,
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

/**
 * Extract the linked provider session id from a Paseo agent JSON file.
 * OpenCode sessions look like `ses_...`; anything else is not resolvable
 * against opencode.db and returns null.
 */
export function extractSessionId(agentJson: unknown): string | null {
  if (typeof agentJson !== "object" || agentJson === null) return null;
  const root = agentJson as Record<string, unknown>;
  for (const path of ["persistence", "runtimeInfo"] as const) {
    const section = root[path];
    if (typeof section !== "object" || section === null) continue;
    const sessionId = (section as Record<string, unknown>).sessionId;
    if (typeof sessionId === "string" && sessionId.startsWith("ses_")) return sessionId;
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

/**
 * Resolve the current usage of the session linked to a Paseo agent.
 * Honest fallbacks: missing agent file, missing/foreign session id, or a
 * session row absent from opencode.db all return found:false with a reason.
 */
export function resolveSessionSummary(
  agentId: string,
  deps: { agentsDir?: string; readSession?: typeof readSessionRowById } = {},
): SessionSummaryOutput {
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

  const provider =
    typeof agentJson === "object" && agentJson !== null
      ? (agentJson as Record<string, unknown>).provider
      : undefined;
  if (typeof provider === "string" && provider !== "opencode") {
    return notFound(`non-opencode agent (${provider})`);
  }

  const sessionId = extractSessionId(agentJson);
  if (!sessionId) return notFound("no linked opencode session");

  const row = readSession(sessionId);
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
