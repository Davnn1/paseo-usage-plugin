import type { PaseoApi } from "@getpaseo/client";
import type { ProviderEntry, SourceStatus } from "../shared/usage";
import type { AntigravityStats } from "./adapters/antigravity";

/** Backends with a working usage adapter. */
const ADAPTER_BACKENDS = new Set(["opencode", "codex"]);

const ANTIGRAVITY_BACKENDS = new Set(["antigravity-cli", "antigravity-acp"]);

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

const ANTIGRAVITY_LABELS: Record<string, string> = {
  "antigravity-cli": "Antigravity (CLI)",
  "antigravity-acp": "Antigravity (ACP)",
};

/**
 * Map a Paseo provider id to the local usage backend that records its usage.
 * Most providers read as themselves; only aliases live here.
 */
export function backendForProvider(providerId: string): string {
  switch (providerId) {
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    case "antigravity":
      return "antigravity-cli";
    default:
      return providerId;
  }
}

export interface SourceStatusInput {
  provider: ProviderEntry;
  /** Usage rows collected for this provider's backend. */
  backendRows: number;
  /** Antigravity store stats; undefined means the store was not probed. */
  antigravity?: Partial<Record<"antigravity-cli" | "antigravity-acp", AntigravityStats | null>>;
  /** Proxied LLM call counts per backend, from agy-usage-proxy. */
  proxyCalls?: Partial<Record<string, number>>;
  /**
   * Backends where usage is known to exist but no adapter can read it
   * (reserved for future providers; maps to not_implemented).
   */
  unreadableBackends?: ReadonlySet<string>;
}

/**
 * Honest status for one Paseo provider:
 * - used: usage rows exist, or (Antigravity) local sessions/proxied calls exist
 * - no_data_source: store unreadable/encrypted (probe failed)
 * - not_implemented: usage known to exist but no adapter (future)
 * - never_used: registered in Paseo, zero attributable local activity
 */
export function mapSourceStatus(input: SourceStatusInput): SourceStatus {
  const { provider, backendRows } = input;
  const backend = backendForProvider(provider.provider);
  const base: Omit<SourceStatus, "status"> = {
    backend: provider.provider,
    label: ANTIGRAVITY_LABELS[backend] ?? provider.label ?? provider.provider,
    enabled: provider.enabled,
  };

  if (ANTIGRAVITY_BACKENDS.has(backend)) {
    const key = backend as "antigravity-cli" | "antigravity-acp";
    const stats = input.antigravity?.[key];
    const calls = input.proxyCalls?.[key] ?? 0;
    if (stats && stats.sessions > 0) {
      const decoded = [...stats.byModel.values()].reduce(
        (sum, totals) => sum + totals.inputTokens + totals.outputTokens,
        0,
      );
      const latestCtx = [...stats.byModel.values()].find((totals) => totals.contextUsed !== null);
      return {
        ...base,
        status: "used",
        sessions: stats.sessions,
        detail:
          `${stats.sessions} sessions · ${stats.steps} steps · tokens decoded` +
          (decoded > 0 ? ` (${formatCompact(decoded)})` : "") +
          (calls > 0 ? ` · ${calls} proxied calls` : "") +
          (latestCtx?.contextUsed != null && latestCtx.contextMax
            ? ` · ctx ${latestCtx.contextUsed}/${latestCtx.contextMax} latest`
            : ""),
      };
    }
    if (backendRows > 0 || calls > 0) {
      return {
        ...base,
        status: "used",
        sessions: backendRows || calls,
        detail: `${backendRows || calls} proxied LLM calls · cost not recorded`,
      };
    }
    if (stats === undefined) {
      return { ...base, status: "no_data_source", detail: "local store unreadable" };
    }
    return { ...base, status: "never_used" };
  }
  if (backendRows > 0) {
    return { ...base, status: "used", sessions: backendRows, detail: `${backendRows} sessions` };
  }
  if (input.unreadableBackends?.has(backend)) {
    return { ...base, status: "not_implemented", detail: "usage exists but no adapter" };
  }
  if (ADAPTER_BACKENDS.has(backend)) {
    return { ...base, status: "never_used" };
  }
  return { ...base, status: "never_used" };
}

/** Enumerate every provider known to the daemon, including disabled ones. */
export async function listProviderEntries(paseo: PaseoApi): Promise<ProviderEntry[]> {
  const snapshot = await paseo.providers.snapshot();
  const entries = snapshot.entries ?? [];
  const seen = new Set<string>();
  const result: ProviderEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.provider)) continue;
    seen.add(entry.provider);
    result.push({ provider: entry.provider, label: entry.label, enabled: entry.enabled });
  }
  return result;
}
