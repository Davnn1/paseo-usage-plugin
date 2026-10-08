import type { PaseoApi } from "@getpaseo/client";
import type { ProviderEntry, SourceStatus } from "../shared/usage";
import type { AntigravityStats } from "./adapters/antigravity";

/** Backends with a working usage adapter. */
const ADAPTER_BACKENDS = new Set(["opencode", "codex"]);

const ANTIGRAVITY_BACKENDS = new Set(["antigravity-cli", "antigravity-acp"]);

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
  /**
   * Backends where usage is known to exist but no adapter can read it
   * (reserved for future providers; maps to not_implemented).
   */
  unreadableBackends?: ReadonlySet<string>;
}

/**
 * Honest status for one Paseo provider:
 * - used: usage rows exist, or (Antigravity) local sessions exist — with the
 *   caveat that token numbers are not recorded locally
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

  if (backendRows > 0) {
    return { ...base, status: "used", sessions: backendRows, detail: `${backendRows} sessions` };
  }
  if (ANTIGRAVITY_BACKENDS.has(backend)) {
    const stats = input.antigravity?.[backend as "antigravity-cli" | "antigravity-acp"];
    if (stats && stats.sessions > 0) {
      return {
        ...base,
        status: "used",
        sessions: stats.sessions,
        detail: `${stats.sessions} sessions · ${stats.steps} steps · token usage not recorded locally`,
      };
    }
    if (stats === undefined) {
      return { ...base, status: "no_data_source", detail: "local store unreadable" };
    }
    return { ...base, status: "never_used" };
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
