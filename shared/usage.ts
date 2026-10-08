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
  label: z.string().optional(),
  status: z.enum(["used", "never_used", "no_data_source", "not_implemented", "error"]),
  sessions: z.number().optional(),
  enabled: z.boolean().optional(),
  detail: z.string().optional(),
});
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

/** Provider row from paseo.providers.snapshot(), shape-stable subset. */
export const providerEntrySchema = z.object({
  provider: z.string(),
  label: z.string().optional(),
  enabled: z.boolean().optional(),
});
export type ProviderEntry = z.infer<typeof providerEntrySchema>;

const dateBoundSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
export const usageSummaryInputSchema = z.object({
  period: periodSchema,
  /** Inclusive YYYY-MM-DD (UTC) range; overrides the sliding period window. */
  startDate: dateBoundSchema,
  endDate: dateBoundSchema,
});
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
  input: usageSummaryInputSchema,
  output: usageSummaryOutputSchema,
});

// ---------------------------------------------------------------------------
// Dashboard series
// ---------------------------------------------------------------------------

export const dailyPointSchema = z.object({
  /** YYYY-MM-DD in UTC. */
  date: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  costUsd: z.number(),
  sessions: z.number(),
});
export type DailyPoint = z.infer<typeof dailyPointSchema>;

export const weeklyPointSchema = z.object({
  /** 0 = Sunday … 6 = Saturday (Date.getUTCDay). */
  weekday: z.number().int().min(0).max(6),
  tokens: z.number(),
  costUsd: z.number(),
});
export type WeeklyPoint = z.infer<typeof weeklyPointSchema>;

export const providerCostSchema = z.object({
  provider: z.string(),
  costUsd: z.number(),
});
export type ProviderCost = z.infer<typeof providerCostSchema>;

export const mostActiveDaySchema = z.object({
  weekday: z.number().int().min(0).max(6),
  date: z.string(),
  tokens: z.number(),
});
export type MostActiveDay = z.infer<typeof mostActiveDaySchema>;

export const usageSeriesSchema = z.object({
  daily: z.array(dailyPointSchema),
  weekly: z.array(weeklyPointSchema),
  byProviderCost: z.array(providerCostSchema),
  mostActiveDay: mostActiveDaySchema.nullable(),
});
export type UsageSeries = z.infer<typeof usageSeriesSchema>;

export const usageDashboardOutputSchema = z.object({
  period: periodSchema,
  generatedAtMs: z.number(),
  /** Charts follow the selected period. */
  series: usageSeriesSchema,
  /** Always the last 365 days, regardless of period. */
  heatmapDaily: z.array(dailyPointSchema),
  sources: z.array(sourceStatusSchema),
});
export type UsageDashboardOutput = z.infer<typeof usageDashboardOutputSchema>;

export const usageDashboardRpc = defineRpc({
  name: "usage.dashboard",
  input: usageSummaryInputSchema,
  output: usageDashboardOutputSchema,
});

// ---------------------------------------------------------------------------
// Per-session summary (composer pill)
// ---------------------------------------------------------------------------

export const sessionSummaryOutputSchema = z.object({
  found: z.boolean(),
  reason: z.string().optional(),
  backend: z.string().optional(),
  sessionId: z.string().optional(),
  title: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
  cacheHitRatio: z.number(),
  timeCreated: z.number(),
});
export type SessionSummaryOutput = z.infer<typeof sessionSummaryOutputSchema>;

export const usageSessionSummaryRpc = defineRpc({
  name: "usage.session_summary",
  input: z.object({ agentId: z.string() }),
  output: sessionSummaryOutputSchema,
});

// ---------------------------------------------------------------------------
// Composer pill text: session-first with daily fallback
// ---------------------------------------------------------------------------

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export interface PillText {
  label: string;
  title: string;
}

/**
 * Pill copy: linked session usage when available, otherwise the global daily
 * total. Title always names the mode so the fallback is never silent. The
 * label is deliberately minimal (in/out·hit%) because composer track bars are
 * crowded; cost and the full breakdown live in the title/menu.
 */
export function buildPillText(
  session: Pick<SessionSummaryOutput, "found" | "reason" | "title" | "inputTokens" | "outputTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens" | "cacheHitRatio" | "costUsd" | "provider" | "model"> | null,
  daily: UsageTotals | null,
): PillText {
  if (session?.found) {
    return {
      label: `${compactTokens(session.inputTokens)}/${compactTokens(session.outputTokens)}·${(session.cacheHitRatio * 100).toFixed(0)}%`,
      title:
        `Session: ${session.title || "untitled"} — ${compactTokens(session.inputTokens)} in / ${compactTokens(session.outputTokens)} out ` +
        `(reasoning ${compactTokens(session.reasoningTokens)}), cache read ${compactTokens(session.cacheReadTokens)}, ` +
        `write ${compactTokens(session.cacheWriteTokens)}, hit ${(session.cacheHitRatio * 100).toFixed(1)}%, ` +
        `cost $${session.costUsd.toFixed(4)} · ${session.provider}/${session.model}`,
    };
  }
  if (daily) {
    return {
      label: `${compactTokens(daily.inputTokens)}/${compactTokens(daily.outputTokens)}·${(daily.cacheHitRatio * 100).toFixed(0)}%`,
      title:
        `Daily fallback — session not tracked${session?.reason ? `: ${session.reason}` : ""}. ` +
        `${compactTokens(daily.inputTokens)} in / ${compactTokens(daily.outputTokens)} out, ` +
        `cache hit ${(daily.cacheHitRatio * 100).toFixed(1)}%, cost $${daily.costUsd.toFixed(2)}, ${daily.sessions} sessions`,
    };
  }
  return { label: "—", title: "Monitoring unavailable" };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD (UTC) for an epoch-ms timestamp. */
export function dateKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC day bucket key -> start-of-day epoch ms. */
function dayStartUtc(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Total token volume for a daily point: input + output + cache-read. */
export function dailyTokens(point: Pick<DailyPoint, "inputTokens" | "outputTokens" | "cacheReadTokens">): number {
  return point.inputTokens + point.outputTokens + point.cacheReadTokens;
}

/**
 * Bucket rows into per-day points with gap-filling (missing days = 0).
 * windowDays null covers everything from the earliest row through today;
 * otherwise the window ends at nowMs. All dates UTC.
 */
export function bucketDaily(rows: UsageRow[], windowDays: number | null, nowMs: number, endMs?: number): DailyPoint[] {
  const byDay = new Map<string, DailyPoint>();
  let earliest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const key = dateKeyUtc(row.timestampMs);
    if (row.timestampMs < earliest) earliest = row.timestampMs;
    let point = byDay.get(key);
    if (!point) {
      point = { date: key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, sessions: 0 };
      byDay.set(key, point);
    }
    point.inputTokens += row.inputTokens;
    point.outputTokens += row.outputTokens;
    point.cacheReadTokens += row.cacheReadTokens;
    point.costUsd += row.costUsd;
    point.sessions += 1;
  }

  const last = endMs ?? nowMs;
  const today = dayStartUtc(last);
  const start = windowDays === null
    ? (Number.isFinite(earliest) ? dayStartUtc(earliest) : today)
    : today - (windowDays - 1) * DAY_MS;

  const result: DailyPoint[] = [];
  for (let t = start; t <= today; t += DAY_MS) {
    const key = dateKeyUtc(t);
    const point = byDay.get(key);
    result.push(
      point
        ? { ...point, costUsd: Math.round(point.costUsd * 100) / 100 }
        : { date: key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, sessions: 0 },
    );
  }
  return result;
}

/** Aggregate daily points into 7 weekday slots (0=Sun … 6=Sat). */
export function bucketWeekly(daily: DailyPoint[]): WeeklyPoint[] {
  const slots: WeeklyPoint[] = Array.from({ length: 7 }, (_, weekday) => ({ weekday, tokens: 0, costUsd: 0 }));
  for (const point of daily) {
    const weekday = new Date(`${point.date}T00:00:00Z`).getUTCDay();
    slots[weekday].tokens += dailyTokens(point);
    slots[weekday].costUsd += point.costUsd;
  }
  for (const slot of slots) slot.costUsd = Math.round(slot.costUsd * 100) / 100;
  return slots;
}

/** Highest-token day, or null when the period has no usage. */
export function mostActiveDay(daily: DailyPoint[]): MostActiveDay | null {
  let best: DailyPoint | null = null;
  for (const point of daily) {
    if (dailyTokens(point) === 0) continue;
    if (!best || dailyTokens(point) > dailyTokens(best)) best = point;
  }
  if (!best) return null;
  return {
    weekday: new Date(`${best.date}T00:00:00Z`).getUTCDay(),
    date: best.date,
    tokens: dailyTokens(best),
  };
}

/** Cost grouped by provider. OpenCode rows already carry the providerID; other
 * backends fall back to the backend name. Sorted by costUsd descending. */
export function bucketProviderCost(entries: UsageEntry[]): ProviderCost[] {
  const groups = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.backend === "opencode" ? entry.provider : entry.backend;
    groups.set(key, (groups.get(key) ?? 0) + entry.costUsd);
  }
  return [...groups.entries()]
    .map(([provider, costUsd]) => ({ provider, costUsd: Math.round(costUsd * 100) / 100 }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive UTC date-range filter; either bound optional. Unparseable bounds are ignored. */
export function filterDateRange(
  rows: UsageRow[],
  startDate?: string,
  endDate?: string,
): UsageRow[] {
  if (!startDate && !endDate) return rows;
  const startMs = startDate && DATE_RE.test(startDate) ? Date.parse(`${startDate}T00:00:00.000Z`) : Number.NEGATIVE_INFINITY;
  const endMs = endDate && DATE_RE.test(endDate) ? Date.parse(`${endDate}T23:59:59.999Z`) : Number.POSITIVE_INFINITY;
  return rows.filter((row) => row.timestampMs >= startMs && row.timestampMs <= endMs);
}

/**
 * The aggregator's row selection: an explicit YYYY-MM-DD range overrides the
 * sliding period window. Range bounds are inclusive.
 */
export function selectPeriodRows(
  rows: UsageRow[],
  period: Period,
  nowMs: number,
  startDate?: string,
  endDate?: string,
): UsageRow[] {
  if (startDate || endDate) return filterDateRange(rows, startDate, endDate);
  return filterPeriod(rows, period, nowMs);
}

/** Inclusive day count of a date range (both bounds required). */
export function dateRangeDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.round((end - start) / DAY_MS) + 1;
}

/** End-of-day epoch ms for a YYYY-MM-DD bound (falls back to nowMs). */
export function rangeEndMs(endDate: string | undefined, nowMs: number): number {
  if (endDate && DATE_RE.test(endDate)) return Date.parse(`${endDate}T23:59:59.999Z`);
  return nowMs;
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
