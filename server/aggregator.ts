import {
  aggregateUsage,
  filterPeriod,
  type Period,
  type SourceStatus,
  type UsageEntry,
  type UsageRow,
  type UsageSummaryOutput,
} from "../shared/usage";
import { readOpenCodeRows } from "./adapters/opencode";
import { readCodexRows } from "./adapters/codex";
import { probeGemini } from "./adapters/gemini";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  generatedAtMs: number;
  result: UsageSummaryOutput;
}

export class UsageAggregator {
  private readonly cache = new Map<Period, CacheEntry>();

  /** Force re-aggregation and overwrite the cache entry for a period. */
  refresh(period: Period, nowMs: number = Date.now()): UsageSummaryOutput {
    const result = this.build(period, nowMs);
    this.cache.set(period, { generatedAtMs: nowMs, result });
    return result;
  }

  /** Cached read; re-aggregates when the entry is missing or older than the TTL. */
  summarize(period: Period, nowMs: number = Date.now()): UsageSummaryOutput {
    const hit = this.cache.get(period);
    if (hit && nowMs - hit.generatedAtMs < CACHE_TTL_MS) return hit.result;
    return this.refresh(period, nowMs);
  }

  private build(period: Period, nowMs: number): UsageSummaryOutput {
    const sources: SourceStatus[] = [];
    const rows: UsageRow[] = [];

    try {
      const opencodeRows = readOpenCodeRows();
      rows.push(...opencodeRows);
      sources.push({
        backend: "opencode",
        status: opencodeRows.length > 0 ? "used" : "never_used",
        detail: `${opencodeRows.length} sessions`,
      });
    } catch (error) {
      sources.push({ backend: "opencode", status: "error", detail: String(error) });
    }

    try {
      const { rows: codexRows, filesRead, filesSkipped } = readCodexRows();
      rows.push(...codexRows);
      sources.push({
        backend: "codex",
        status: codexRows.length > 0 ? "used" : "never_used",
        detail: `${filesRead} sessions${filesSkipped > 0 ? `, ${filesSkipped} skipped` : ""}`,
      });
    } catch (error) {
      sources.push({ backend: "codex", status: "error", detail: String(error) });
    }

    const gemini = probeGemini();
    sources.push({ backend: "gemini", status: gemini.status, detail: gemini.detail });

    const filtered = filterPeriod(rows, period, nowMs);
    const { totals, entries } = aggregateUsage(filtered);

    const byProviderMap = new Map<string, { backend: string; provider: string; entries: UsageEntry[] }>();
    for (const entry of entries) {
      const key = `${entry.backend}${entry.provider}`;
      let group = byProviderMap.get(key);
      if (!group) {
        group = { backend: entry.backend, provider: entry.provider, entries: [] };
        byProviderMap.set(key, group);
      }
      group.entries.push(entry);
    }

    return {
      period,
      generatedAtMs: nowMs,
      totals,
      byProvider: [...byProviderMap.values()],
      sources,
    };
  }
}
