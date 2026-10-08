import {
  aggregateUsage,
  bucketDaily,
  bucketProviderCost,
  bucketWeekly,
  dateRangeDays,
  filterPeriod,
  mostActiveDay,
  rangeEndMs,
  selectPeriodRows,
  type Period,
  type ProviderEntry,
  type SourceStatus,
  type UsageEntry,
  type UsageRow,
  type UsageDashboardOutput,
  type UsageSummaryOutput,
} from "../shared/usage";
import { readOpenCodeRows } from "./adapters/opencode";
import { readCodexRows } from "./adapters/codex";
import { collectAntigravity } from "./adapters/antigravity";
import { readAgyProxyRows } from "./adapters/agy-proxy";
import { resolveContextWindow } from "./context-windows";
import { backendForProvider, mapSourceStatus } from "./discovery";

const CACHE_TTL_MS = 5 * 60 * 1000;

const PERIOD_WINDOW_DAYS: Record<Period, number | null> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  all: null,
};

interface BuildResult {
  summary: UsageSummaryOutput;
  dashboard: UsageDashboardOutput;
}

interface RangeOptions {
  startDate?: string;
  endDate?: string;
}

interface CacheEntry {
  generatedAtMs: number;
  result: BuildResult;
}

function cacheKey(period: Period, range: RangeOptions): string {
  return `${period}|${range.startDate ?? ""}|${range.endDate ?? ""}`;
}

export class UsageAggregator {
  private readonly cache = new Map<string, CacheEntry>();

  /** Force re-aggregation and overwrite the cache entry for a period/range. */
  refresh(
    period: Period,
    options: { providerEntries?: ProviderEntry[]; nowMs?: number } & RangeOptions = {},
  ): BuildResult {
    const nowMs = options.nowMs ?? Date.now();
    const result = this.build(period, nowMs, options);
    this.cache.set(cacheKey(period, options), { generatedAtMs: nowMs, result });
    return result;
  }

  /** Cached read; re-aggregates when the entry is missing or older than the TTL. */
  private cached(
    period: Period,
    options: { providerEntries?: ProviderEntry[]; nowMs?: number } & RangeOptions = {},
  ): BuildResult {
    const nowMs = options.nowMs ?? Date.now();
    const hit = this.cache.get(cacheKey(period, options));
    if (hit && nowMs - hit.generatedAtMs < CACHE_TTL_MS) return hit.result;
    return this.refresh(period, { ...options, nowMs });
  }

  summarize(
    period: Period,
    options: { providerEntries?: ProviderEntry[]; nowMs?: number } & RangeOptions = {},
  ): UsageSummaryOutput {
    return this.cached(period, options).summary;
  }

  dashboard(
    period: Period,
    options: { providerEntries?: ProviderEntry[]; nowMs?: number } & RangeOptions = {},
  ): UsageDashboardOutput {
    return this.cached(period, options).dashboard;
  }

  private build(
    period: Period,
    nowMs: number,
    options: { providerEntries?: ProviderEntry[] } & RangeOptions,
  ): BuildResult {
    const { startDate, endDate, providerEntries } = options;
    const adapterSources: SourceStatus[] = [];
    const rows: UsageRow[] = [];

    try {
      const opencodeRows = readOpenCodeRows();
      rows.push(...opencodeRows);
      adapterSources.push({
        backend: "opencode",
        status: opencodeRows.length > 0 ? "used" : "never_used",
        sessions: opencodeRows.length,
        detail: `${opencodeRows.length} sessions`,
      });
    } catch (error) {
      adapterSources.push({ backend: "opencode", status: "error", detail: String(error) });
    }

    try {
      const { rows: codexRows, filesRead, filesSkipped } = readCodexRows();
      rows.push(...codexRows);
      adapterSources.push({
        backend: "codex",
        status: codexRows.length > 0 ? "used" : "never_used",
        sessions: codexRows.length,
        detail: `${filesRead} sessions${filesSkipped > 0 ? `, ${filesSkipped} skipped` : ""}`,
      });
    } catch (error) {
      adapterSources.push({ backend: "codex", status: "error", detail: String(error) });
    }

    const antigravity = collectAntigravity();
    const agyProxy = readAgyProxyRows();
    rows.push(...agyProxy.rows);

    const sources = providerEntries
      ? this.discoveredSources(providerEntries, rows, antigravity, agyProxy, adapterSources)
      : [
          ...adapterSources,
          ...(["cli", "acp"] as const).map((kind) => {
            const stats = antigravity[kind];
            const calls = agyProxy.callsBySource[kind];
            const backend = `antigravity-${kind}` as const;
            const label = kind === "cli" ? "Antigravity (CLI)" : "Antigravity (ACP)";
            if (stats && stats.sessions > 0) {
              return {
                backend,
                label,
                status: "used",
                sessions: stats.sessions,
                detail: `${stats.sessions} sessions · ${stats.steps} steps${calls > 0 ? ` · ${calls} proxied calls` : ""}`,
              } as SourceStatus;
            }
            if (calls > 0) {
              return {
                backend,
                label,
                status: "used",
                sessions: calls,
                detail: `${calls} proxied LLM calls · cost not recorded`,
              } as SourceStatus;
            }
            return { backend, label, status: "never_used" } as SourceStatus;
          }),
          ...(agyProxy.callsBySource.agy > 0
            ? [
                {
                  backend: "agy-proxy",
                  label: "Antigravity (harness)",
                  status: "used",
                  sessions: agyProxy.callsBySource.agy,
                  detail: `${agyProxy.callsBySource.agy} proxied LLM calls · cost not recorded`,
                } as SourceStatus,
              ]
            : []),
        ];

    const filtered = selectPeriodRows(rows, period, nowMs, startDate, endDate);
    const { totals, entries } = aggregateUsage(filtered);

    // Live context occupancy: latest cache-inclusive prompt per harness model.
    for (const entry of entries) {
      if (entry.backend !== "antigravity-cli" && entry.backend !== "antigravity-acp" && entry.backend !== "agy-proxy") {
        continue;
      }
      const latest = agyProxy.latestPromptByKey.get(`${entry.backend}${entry.provider}${entry.model}`);
      const windowTokens = resolveContextWindow(entry.model);
      if (latest && windowTokens && windowTokens > 0) {
        entry.ctx = { usedTokens: latest.promptTokens, windowTokens };
      }
    }

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

    const summary: UsageSummaryOutput = {
      period,
      generatedAtMs: nowMs,
      totals,
      byProvider: [...byProviderMap.values()],
      sources,
    };

    const rangeDays = startDate && endDate ? dateRangeDays(startDate, endDate) : null;
    const daily = bucketDaily(
      filtered,
      rangeDays ?? PERIOD_WINDOW_DAYS[period],
      nowMs,
      rangeEndMs(endDate, nowMs),
    );
    const dashboard: UsageDashboardOutput = {
      period,
      generatedAtMs: nowMs,
      series: {
        daily,
        weekly: bucketWeekly(daily),
        byProviderCost: bucketProviderCost(entries),
        mostActiveDay: mostActiveDay(daily),
      },
      heatmapDaily: bucketDaily(rows, 365, nowMs),
      sources,
    };

    return { summary, dashboard };
  }

  /**
   * One source row per Paseo provider from the daemon snapshot. Adapter-level
   * errors (a backend that failed to read) are merged in so they still surface.
   */
  private discoveredSources(
    providerEntries: ProviderEntry[],
    rows: UsageRow[],
    antigravity: { cli: unknown; acp: unknown },
    agyProxy: { callsBySource: { cli: number; acp: number; agy: number } },
    adapterSources: SourceStatus[],
  ): SourceStatus[] {
    const rowsByBackend = new Map<string, number>();
    for (const row of rows) {
      rowsByBackend.set(row.backend, (rowsByBackend.get(row.backend) ?? 0) + 1);
    }
    const sources = providerEntries.map((provider) => {
      const backend = backendForProvider(provider.provider);
      return mapSourceStatus({
        provider,
        backendRows: rowsByBackend.get(backend) ?? 0,
        antigravity: antigravity as never,
        proxyCalls: {
          "antigravity-cli": agyProxy.callsBySource.cli,
          "antigravity-acp": agyProxy.callsBySource.acp,
        },
      });
    });
    const covered = new Set(providerEntries.map((provider) => backendForProvider(provider.provider)));
    for (const source of adapterSources) {
      if (!covered.has(source.backend)) sources.push(source);
    }
    return sources;
  }
}
