import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const periodSchema = z.enum(["1d", "7d", "30d", "all"]);
export type Period = z.infer<typeof periodSchema>;

export const PERIOD_MS: Record<Exclude<Period, "all">, number> = {
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** One session-shaped usage record produced by exactly one adapter. */
export const usageRowSchema = z.object({
  backend: z.string(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
  timestampMs: z.number(),
});
export type UsageRow = z.infer<typeof usageRowSchema>;

export const usageEntrySchema = z.object({
  backend: z.string(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
  sessions: z.number(),
  firstUsed: z.number(),
  lastUsed: z.number(),
  cacheHitRatio: z.number(),
});
export type UsageEntry = z.infer<typeof usageEntrySchema>;

export const usageTotalsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
  sessions: z.number(),
  cacheHitRatio: z.number(),
});
export type UsageTotals = z.infer<typeof usageTotalsSchema>;

export const sourceStatusSchema = z.object({
  backend: z.string(),
  status: z.enum(["used", "never_used", "no_data_source", "error"]),
  detail: z.string().optional(),
});
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

export const usageSummaryInputSchema = z.object({ period: periodSchema });
export const usageSummaryOutputSchema = z.object({
  period: periodSchema,
  generatedAtMs: z.number(),
  totals: usageTotalsSchema,
  byProvider: z.array(
    z.object({
      backend: z.string(),
      provider: z.string(),
      entries: z.array(usageEntrySchema),
    }),
  ),
  sources: z.array(sourceStatusSchema),
});
export type UsageSummaryOutput = z.infer<typeof usageSummaryOutputSchema>;

export const usageSummaryRpc = defineRpc({
  name: "usage.summary",
  input: usageSummaryInputSchema,
  output: usageSummaryOutputSchema,
});

export const usageRefreshRpc = defineRpc({
  name: "usage.refresh",
  input: z.object({ period: periodSchema }),
  output: usageSummaryOutputSchema,
});

/** cacheHit = cacheRead / (cacheRead + fresh input); 0 when denominator is 0. */
export function cacheHitRatio(cacheReadTokens: number, inputTokens: number): number {
  const denom = cacheReadTokens + inputTokens;
  return denom > 0 ? cacheReadTokens / denom : 0;
}

/** Keep rows whose timestamp falls inside the period window ending at nowMs. "all" keeps everything. */
export function filterPeriod(rows: UsageRow[], period: Period, nowMs: number): UsageRow[] {
  if (period === "all") return rows;
  const cutoff = nowMs - PERIOD_MS[period];
  return rows.filter((row) => row.timestampMs >= cutoff);
}

/**
 * Group rows by (backend, provider, model), sum counters, derive totals.
 * Entries are sorted by costUsd descending. Pure function, no I/O.
 */
export function aggregateUsage(rows: UsageRow[]): {
  totals: UsageTotals;
  entries: UsageEntry[];
} {
  const groups = new Map<string, UsageEntry>();
  for (const row of rows) {
    const key = `${row.backend}${row.provider}${row.model}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        backend: row.backend,
        provider: row.provider,
        model: row.model,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        sessions: 0,
        firstUsed: row.timestampMs,
        lastUsed: row.timestampMs,
        cacheHitRatio: 0,
      };
      groups.set(key, entry);
    }
    entry.inputTokens += row.inputTokens;
    entry.outputTokens += row.outputTokens;
    entry.reasoningTokens += row.reasoningTokens;
    entry.cacheReadTokens += row.cacheReadTokens;
    entry.cacheWriteTokens += row.cacheWriteTokens;
    entry.costUsd += row.costUsd;
    entry.sessions += 1;
    entry.firstUsed = Math.min(entry.firstUsed, row.timestampMs);
    entry.lastUsed = Math.max(entry.lastUsed, row.timestampMs);
  }

  const entries = [...groups.values()]
    .map((entry) => ({
      ...entry,
      costUsd: round2(entry.costUsd),
      cacheHitRatio: cacheHitRatio(entry.cacheReadTokens, entry.inputTokens),
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const totals = entries.reduce<UsageTotals>(
    (acc, entry) => ({
      inputTokens: acc.inputTokens + entry.inputTokens,
      outputTokens: acc.outputTokens + entry.outputTokens,
      reasoningTokens: acc.reasoningTokens + entry.reasoningTokens,
      cacheReadTokens: acc.cacheReadTokens + entry.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + entry.cacheWriteTokens,
      costUsd: acc.costUsd + entry.costUsd,
      sessions: acc.sessions + entry.sessions,
      cacheHitRatio: 0,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      sessions: 0,
      cacheHitRatio: 0,
    },
  );
  totals.costUsd = round2(totals.costUsd);
  totals.cacheHitRatio = cacheHitRatio(totals.cacheReadTokens, totals.inputTokens);

  return { totals, entries };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
