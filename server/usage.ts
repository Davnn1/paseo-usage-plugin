import type { RpcInput } from "@getpaseo/plugin";
import type { UsagePeriod, UsageSummaryOutput } from "../shared/usage";
import { usageRefreshRpc, usageSummaryRpc } from "../shared/usage";
import { aggregateUsage } from "./aggregator";
import { createCodexAdapter } from "./adapters/codex";
import { createGeminiAdapter } from "./adapters/gemini";
import { createOpencodeAdapter } from "./adapters/opencode";
import type { AdapterResult, UsageAdapter } from "./types";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  at: number;
  data: UsageSummaryOutput;
}

export class UsageService {
  private adapters: UsageAdapter[];
  private cache = new Map<UsagePeriod, CacheEntry>();
  private inflight: Promise<AdapterResult[]> | null = null;

  constructor(adapters?: UsageAdapter[]) {
    this.adapters = adapters ?? [
      createOpencodeAdapter(),
      createCodexAdapter(),
      createGeminiAdapter(),
    ];
  }

  private async collectAll(): Promise<AdapterResult[]> {
    // Concurrent summary/refresh calls share one collection pass.
    if (this.inflight) return this.inflight;
    this.inflight = Promise.all(
      this.adapters.map(async (adapter) => {
        try {
          return await adapter.collect();
        } catch (error) {
          return {
            backend: adapter.backend,
            status: "error" as const,
            detail: error instanceof Error ? error.message : String(error),
            rows: [],
          };
        }
      }),
    ).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async summary(input: RpcInput<typeof usageSummaryRpc>): Promise<UsageSummaryOutput> {
    const { period } = input;
    const now = Date.now();
    const cached = this.cache.get(period);
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.data;
    const results = await this.collectAll();
    const data = aggregateUsage(results, period, now);
    this.cache.set(period, { at: now, data });
    return data;
  }

  async refresh(input: RpcInput<typeof usageRefreshRpc>) {
    if (input.period) this.cache.delete(input.period);
    else this.cache.clear();
    const now = Date.now();
    const results = await this.collectAll();
    const data = aggregateUsage(results, input.period ?? "all", now);
    this.cache.set(input.period ?? "all", { at: now, data });
    return { refreshed: true, at: now };
  }

  /** Test hook: inject pre-collected adapter results. */
  static forTesting(adapters: UsageAdapter[]): UsageService {
    return new UsageService(adapters);
  }
}
