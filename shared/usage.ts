import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const periodSchema = z.enum(["1d", "7d", "30d", "all"]);
export type Period = z.infer<typeof periodSchema>;

const PERIOD_DAYS: Record<Exclude<Period, "all">, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
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

export const modelTokenSchema = z.object({
  model: z.string(),
  tokens: z.number(),
});
export type ModelTokens = z.infer<typeof modelTokenSchema>;

export const dailyPointSchema = z.object({
  /** YYYY-MM-DD local day key. */
  date: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  costUsd: z.number(),
  sessions: z.number(),
  /** Per-model token breakdown, top 8 plus an "other" bucket, descending. */
  models: z.array(modelTokenSchema),
});
export type DailyPoint = z.infer<typeof dailyPointSchema>;

const TOP_MODELS = 8;

/** Collapse a model->tokens map into a sorted top-N plus "other" list. */
export function topModels(byModel: Map<string, number>): ModelTokens[] {
  const sorted = [...byModel.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, TOP_MODELS).map(([model, tokens]) => ({ model, tokens }));
  const rest = sorted.slice(TOP_MODELS).reduce((sum, [, tokens]) => sum + tokens, 0);
  if (rest > 0) top.push({ model: "other", tokens: rest });
  return top;
}

export const weeklyPointSchema = z.object({
  /** 0 = Sunday … 6 = Saturday (local weekday). */
  weekday: z.number().int().min(0).max(6),
  tokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  /** Per-model cumulative breakdown for this weekday, top 8 + other. */
  models: z.array(modelTokenSchema),
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

/** Hardcoded daemon-local zone so day bucketing is deterministic per machine. */
export const LOCAL_TIME_ZONE = "Asia/Jakarta";

const LOCAL_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: LOCAL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD of the timestamp in the local zone (WIB on the daemon machine). */
export function localDateKey(ms: number): string {
  return LOCAL_DATE_FORMAT.format(new Date(ms)); // en-CA renders YYYY-MM-DD
}

/**
 * Epoch of the actual local midnight for ms's day: walk back from the day's
 * key until the local key changes. Days are contiguous 24h blocks (the zone
 * has no DST), so any ms on a local day is >= its scalar and < the next day's.
 */
export function startOfLocalDay(ms: number): number {
  const key = localDateKey(ms);
  let t = Date.parse(`${key}T00:00:00.000Z`);
  while (localDateKey(t - 60_000) === key) t -= 60_000;
  return t;
}

/** Weekday (0=Sun) of the timestamp's LOCAL day. */
export function localWeekday(ms: number): number {
  return new Date(startOfLocalDay(ms) + 12 * 3600 * 1000).getUTCDay();
}

/** YYYY-MM-DD (UTC) for an epoch-ms timestamp. */
export function dateKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
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
  const byDay = new Map<string, DailyPoint & { byModel: Map<string, number> }>();
  let earliest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const key = localDateKey(row.timestampMs);
    if (row.timestampMs < earliest) earliest = row.timestampMs;
    let point = byDay.get(key);
    if (!point) {
      point = { date: key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, sessions: 0, models: [], byModel: new Map() };
      byDay.set(key, point);
    }
    point.inputTokens += row.inputTokens;
    point.outputTokens += row.outputTokens;
    point.cacheReadTokens += row.cacheReadTokens;
    point.costUsd += row.costUsd;
    point.sessions += 1;
    point.byModel.set(row.model, (point.byModel.get(row.model) ?? 0) + row.inputTokens + row.outputTokens);
  }

  const last = endMs ?? nowMs;
  const today = startOfLocalDay(last);
  const start = windowDays === null
    ? (Number.isFinite(earliest) ? startOfLocalDay(earliest) : today)
    : today - (windowDays - 1) * DAY_MS;

  const result: DailyPoint[] = [];
  for (let t = start; t <= today; t += DAY_MS) {
    const key = localDateKey(t);
    const point = byDay.get(key);
    result.push(
      point
        ? { ...point, costUsd: Math.round(point.costUsd * 100) / 100, models: topModels(point.byModel) }
        : { date: key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, sessions: 0, models: [] },
    );
  }
  return result;
}

/** Aggregate daily points into 7 weekday slots (0=Sun … 6=Sat). */
export function bucketWeekly(daily: DailyPoint[]): WeeklyPoint[] {
  const slots: (WeeklyPoint & { byModel: Map<string, number> })[] = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    models: [],
    byModel: new Map(),
  }));
  for (const point of daily) {
    const weekday = localWeekday(Date.parse(`${point.date}T12:00:00Z`));
    slots[weekday].tokens += dailyTokens(point);
    slots[weekday].inputTokens += point.inputTokens;
    slots[weekday].outputTokens += point.outputTokens;
    slots[weekday].costUsd += point.costUsd;
    for (const model of point.models) {
      slots[weekday].byModel.set(model.model, (slots[weekday].byModel.get(model.model) ?? 0) + model.tokens);
    }
  }
  for (const slot of slots) {
    slot.costUsd = Math.round(slot.costUsd * 100) / 100;
    slot.models = topModels(slot.byModel);
  }
  return slots.map(({ byModel: _byModel, ...slot }) => slot);
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
    weekday: localWeekday(Date.parse(`${best.date}T12:00:00Z`)),
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

/**
 * Keep rows whose UTC calendar day falls inside the period ending today, so
 * the sliding filter and the daily bucketing cover exactly the same days
 * (sum of daily points equals totals for every period).
 */
export function filterPeriod(rows: UsageRow[], period: Period, nowMs: number): UsageRow[] {
  if (period === "all") return rows;
  const cutoff = startOfLocalDay(nowMs) - (PERIOD_DAYS[period] - 1) * DAY_MS;
  return rows.filter((row) => row.timestampMs >= cutoff);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Inclusive local-day range filter; either bound optional. Compares the
 * local YYYY-MM-DD keys lexicographically - a 06:00 WIB session lands on its
 * own local day, never the previous UTC day. Unparseable bounds are ignored.
 */
export function filterDateRange(
  rows: UsageRow[],
  startDate?: string,
  endDate?: string,
): UsageRow[] {
  if (!startDate && !endDate) return rows;
  const start = startDate && DATE_RE.test(startDate) ? startDate : "0000-01-01";
  const end = endDate && DATE_RE.test(endDate) ? endDate : "9999-12-31";
  return rows.filter((row) => {
    const key = localDateKey(row.timestampMs);
    return key >= start && key <= end;
  });
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

/**
 * Last epoch ms of a local-day bound: the final millisecond of endDate's
 * local day (falls back to nowMs). Bucket anchors derived from this stay on
 * endDate itself instead of rolling into the next local day.
 */
export function rangeEndMs(endDate: string | undefined, nowMs: number): number {
  if (endDate && DATE_RE.test(endDate)) {
    return startOfLocalDay(Date.parse(`${endDate}T00:00:00.000Z`)) + DAY_MS - 1;
  }
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
