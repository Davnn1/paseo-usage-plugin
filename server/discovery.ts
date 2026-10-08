import type { PaseoApi } from "@getpaseo/client";
import type { ProviderEntry, SourceStatus } from "../shared/usage";

/** Backends with a working usage adapter. */
const ADAPTER_BACKENDS = new Set(["opencode", "codex"]);

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
      // Antigravity usage routed through OmniRoute lands in opencode.db under
      // provider `omniroute`, but the local Antigravity store is its own backend.
      // antigravity-acp stays its own backend: nothing readable, zero rows.
      return "antigravity";
    default:
      return providerId;
  }
}

export interface SourceStatusInput {
  provider: ProviderEntry;
  /** Usage rows collected for this provider's backend. */
  backendRows: number;
  /** Detail from the local-store probe when the backend has data we cannot read. */
  unreadableDetail?: string;
  /**
   * Backends where usage is known to exist but no adapter can read it
   * (reserved for future providers; maps to not_implemented).
   */
  unreadableBackends?: ReadonlySet<string>;
}

/**
 * Honest status for one Paseo provider:
 * - used: usage rows exist for its backend
 * - no_data_source: local store exists but is unreadable (encrypted protobuf)
 * - not_implemented: usage known to exist but no adapter (future)
 * - never_used: registered in Paseo, zero attributable rows
 */
export function mapSourceStatus(input: SourceStatusInput): SourceStatus {
  const { provider, backendRows } = input;
  const backend = backendForProvider(provider.provider);
  const base: Omit<SourceStatus, "status"> = {
    backend: provider.provider,
    label: provider.label ?? provider.provider,
    enabled: provider.enabled,
  };

  if (backendRows > 0) {
    return { ...base, status: "used", sessions: backendRows, detail: `${backendRows} sessions` };
  }
  if (backend === "antigravity") {
    return {
      ...base,
      status: "no_data_source",
      detail: `${input.unreadableDetail ?? "local store unreadable"}; usage via OmniRoute is counted under provider omniroute`,
    };
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
