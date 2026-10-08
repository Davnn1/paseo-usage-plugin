import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  dailyTokens,
  type DailyPoint,
  type UsageDashboardOutput,
  type WeeklyPoint,
} from "../shared/usage";

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Column order: Monday first, matching the heatmap grid. */
const WEEKDAY_MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

const PALETTE_KEYS = ["accent", "statusSuccess", "statusWarning", "statusDanger", "surface2", "foregroundMuted"] as const;

export function Dashboard({
  data,
  theme,
  layout,
}: {
  data: UsageDashboardOutput;
} & PluginHostProps) {
  const compact = layout.compact;
  const styles = useMemo(
    () => ({
      grid: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: compact ? 8 : 12,
        width: "100%" as const,
      } as const,
      card: {
        flexGrow: 1,
        flexBasis: compact ? "100%" : "45%",
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        padding: compact ? 10 : 14,
        gap: 8,
      } as const,
      cardTitle: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "700" as const,
        letterSpacing: 0.5,
      } as const,
      cardValue: {
        color: theme.colors.foreground,
        fontSize: compact ? 15 : 18,
        fontWeight: "700" as const,
      } as const,
      muted: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      } as const,
    }),
    [theme, compact],
  );

  return (
    <View style={styles.grid}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>OVERVIEW</Text>
        <Heatmap points={data.heatmapDaily} theme={theme} compact={compact} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>MOST ACTIVE DAY</Text>
        <MostActiveAndWeekly series={data.series} theme={theme} compact={compact} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>MODEL USAGE OVER TIME</Text>
        <TrendChart points={data.series.daily} theme={theme} compact={compact} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>COST BY PROVIDER</Text>
        <CostByProvider data={data} theme={theme} compact={compact} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Heatmap: last 365 days, Monday-first columns, month labels on top.
// ---------------------------------------------------------------------------

function Heatmap({
  points,
  theme,
  compact,
}: {
  points: DailyPoint[];
  theme: PluginHostProps["theme"];
  compact: boolean;
}) {
  const cell = compact ? 9 : 11;
  const gap = 2;
  const weekMs = 7 * 24 * 3600 * 1000;

  const { cells, weeks, monthLabels, activeDays, totalTokens, maxTokens } = useMemo(() => {
    const byDate = new Map(points.map((point) => [point.date, point]));
    // Anchor grid start to the Monday on/before the first day.
    const first = new Date(`${points[0]?.date ?? dateKeyNow()}T00:00:00Z`);
    const anchor = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
    const anchorWeekday = first.getUTCDay();
    const start = anchor - ((anchorWeekday + 6) % 7) * 24 * 3600 * 1000;

    const cells: { date: string; week: number; weekday: number; tokens: number }[] = [];
    const monthLabels: { week: number; label: string }[] = [];
    let lastMonth = -1;
    let maxTokens = 0;
    let activeDays = 0;
    let totalTokens = 0;

    for (let i = 0; i < points.length; i += 1) {
      const t = start + i * 24 * 3600 * 1000;
      const d = new Date(t);
      const point = byDate.get(d.toISOString().slice(0, 10));
      const tokens = point ? dailyTokens(point) : 0;
      const week = Math.floor(i / 7);
      if (d.getUTCMonth() !== lastMonth && d.getUTCDay() === 1) {
        monthLabels.push({ week, label: d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }) });
        lastMonth = d.getUTCMonth();
      }
      if (tokens > 0) activeDays += 1;
      totalTokens += tokens;
      if (tokens > maxTokens) maxTokens = tokens;
      cells.push({ date: d.toISOString().slice(0, 10), week, weekday: d.getUTCDay(), tokens });
    }
    const weeks = Math.max(1, Math.ceil(cells.length / 7));
    return { cells, weeks, monthLabels, activeDays, totalTokens, maxTokens };
  }, [points]);

  const intensity = (tokens: number): number => {
    if (tokens <= 0 || maxTokens <= 0) return 0;
    const ratio = tokens / maxTokens;
    if (ratio > 0.75) return 0.95;
    if (ratio > 0.5) return 0.7;
    if (ratio > 0.25) return 0.45;
    return 0.22;
  };

  const grid: (typeof cells)[number][][] = [];
  for (const cellPoint of cells) {
    (grid[cellPoint.weekday] ?? (grid[cellPoint.weekday] = [])).push(cellPoint);
  }

  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {`${activeDays} active days · ${formatTokens(totalTokens)} tokens · 365 days`}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ gap }}>
          <View style={{ flexDirection: "row", marginLeft: 24 + gap, height: 12 }}>
            {monthLabels.map((label) => (
              <Text
                key={`${label.week}-${label.label}`}
                style={{
                  position: "absolute" as const,
                  left: label.week * (cell + gap),
                  color: theme.colors.foregroundMuted,
                  fontSize: 9,
                  width: 28,
                }}
              >
                {label.label}
              </Text>
            ))}
          </View>
          <View style={{ flexDirection: "row", gap }}>
            <View style={{ width: 24, gap }}>
              {WEEKDAY_MON_FIRST.map((weekday) => (
                <Text
                  key={weekday}
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 8,
                    height: cell,
                    textAlignVertical: "center" as const,
                  }}
                >
                  {weekday % 2 === 1 ? WEEKDAY_SHORT[weekday].slice(0, 3) : ""}
                </Text>
              ))}
            </View>
            <View style={{ flexDirection: "row", gap }}>
              {Array.from({ length: weeks }, (_, week) => (
                <View key={week} style={{ gap }}>
                  {WEEKDAY_MON_FIRST.map((weekday) => {
                    const cellPoint = grid[weekday]?.[week];
                    if (!cellPoint) {
                      return <View key={weekday} style={{ width: cell, height: cell }} />;
                    }
                    const level = intensity(cellPoint.tokens);
                    return (
                      <View
                        key={weekday}
                        style={{
                          width: cell,
                          height: cell,
                          borderRadius: 2,
                          backgroundColor: theme.colors.statusSuccess,
                          opacity: level === 0 ? 0.12 : level,
                        }}
                      />
                    );
                  })}
                </View>
              ))}
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginLeft: 24 + gap }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>Less</Text>
            {[0, 0.22, 0.45, 0.7, 0.95].map((level) => (
              <View
                key={level}
                style={{
                  width: cell,
                  height: cell,
                  borderRadius: 2,
                  backgroundColor: theme.colors.statusSuccess,
                  opacity: level === 0 ? 0.12 : level,
                }}
              />
            ))}
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>More</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function dateKeyNow(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Most active day + weekly strip (Monday-first bars).
// ---------------------------------------------------------------------------

function MostActiveAndWeekly({
  series,
  theme,
  compact,
}: {
  series: UsageDashboardOutput["series"];
  theme: PluginHostProps["theme"];
  compact: boolean;
}) {
  const maxWeekly = Math.max(1, ...series.weekly.map((point) => point.tokens));
  const mad = series.mostActiveDay;
  const barHeight = compact ? 42 : 56;

  return (
    <View style={{ gap: 10 }}>
      <View>
        {mad ? (
          <>
            <Text style={{ color: theme.colors.foreground, fontSize: compact ? 15 : 18, fontWeight: "700" }}>
              {WEEKDAY_SHORT[mad.weekday]}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {`${mad.date} · ${formatTokens(mad.tokens)} tokens`}
            </Text>
          </>
        ) : (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>No usage in this period.</Text>
        )}
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, height: barHeight + 14 }}>
        {WEEKDAY_MON_FIRST.map((weekday) => {
          const point: WeeklyPoint | undefined = series.weekly[weekday];
          const ratio = point ? point.tokens / maxWeekly : 0;
          return (
            <View key={weekday} style={{ flex: 1, alignItems: "center", gap: 3 }}>
              <View
                style={{
                  width: "100%",
                  height: Math.max(2, Math.round(ratio * barHeight)),
                  borderRadius: 3,
                  backgroundColor: theme.colors.accent,
                  opacity: point && point.tokens > 0 ? 1 : 0.15,
                }}
              />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>
                {WEEKDAY_SHORT[weekday].slice(0, 2)}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Trend: stacked input/output bars with a cost dot overlay. Pure Views.
// ---------------------------------------------------------------------------

function TrendChart({
  points,
  theme,
  compact,
}: {
  points: DailyPoint[];
  theme: PluginHostProps["theme"];
  compact: boolean;
}) {
  const chartHeight = compact ? 64 : 84;
  const colWidth = compact ? 5 : 7;
  const colGap = 1;

  const { maxTokens, maxCost, active } = useMemo(() => {
    let maxTokens = 0;
    let maxCost = 0;
    let active = 0;
    for (const point of points) {
      const tokens = point.inputTokens + point.outputTokens;
      if (tokens > maxTokens) maxTokens = tokens;
      if (point.costUsd > maxCost) maxCost = point.costUsd;
      if (tokens > 0) active += 1;
    }
    return { maxTokens: Math.max(1, maxTokens), maxCost: Math.max(0.01, maxCost), active };
  }, [points]);

  if (points.length === 0 || active === 0) {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>No usage in this period.</Text>;
  }

  return (
    <View style={{ gap: 6 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: colGap, height: chartHeight }}>
          {points.map((point) => {
            const inRatio = point.inputTokens / maxTokens;
            const outRatio = point.outputTokens / maxTokens;
            const costRatio = point.costUsd / maxCost;
            return (
              <View
                key={point.date}
                style={{
                  width: colWidth,
                  height: chartHeight,
                  justifyContent: "flex-end",
                }}
              >
                <View
                  style={{
                    position: "absolute" as const,
                    left: 0,
                    right: 0,
                    bottom: Math.round(costRatio * (chartHeight - 6)),
                    width: colWidth,
                    height: 3,
                    borderRadius: 1,
                    backgroundColor: theme.colors.statusWarning,
                    opacity: point.costUsd > 0 ? 1 : 0,
                  }}
                />
                <View
                  style={{
                    height: Math.max(0, Math.round(inRatio * chartHeight)),
                    backgroundColor: theme.colors.accent,
                    opacity: point.inputTokens > 0 ? 0.9 : 0,
                    borderTopLeftRadius: 1,
                    borderTopRightRadius: 1,
                  }}
                />
                <View
                  style={{
                    height: Math.max(0, Math.round(outRatio * chartHeight)),
                    backgroundColor: theme.colors.statusSuccess,
                    opacity: point.outputTokens > 0 ? 0.9 : 0,
                  }}
                />
              </View>
            );
          })}
        </View>
      </ScrollView>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Legend color={theme.colors.accent} label="Input" theme={theme} />
        <Legend color={theme.colors.statusSuccess} label="Output" theme={theme} />
        <Legend color={theme.colors.statusWarning} label="Cost" theme={theme} />
      </View>
    </View>
  );
}

function Legend({ color, label, theme }: { color: string; label: string; theme: PluginHostProps["theme"] }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color }} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Cost by provider: stacked horizontal bar + legend + total.
// ---------------------------------------------------------------------------

function CostByProvider({
  data,
  theme,
  compact,
}: {
  data: UsageDashboardOutput;
  theme: PluginHostProps["theme"];
  compact: boolean;
}) {
  const segments = data.series.byProviderCost.filter((segment) => segment.costUsd > 0);
  const total = segments.reduce((sum, segment) => sum + segment.costUsd, 0);

  if (total <= 0) {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>No cost in this period.</Text>;
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: compact ? 15 : 18, fontWeight: "700" }}>
        {`$${total.toFixed(2)}`}
      </Text>
      <View style={{ flexDirection: "row", height: 14, borderRadius: 7, overflow: "hidden" }}>
        {segments.map((segment, index) => (
          <View
            key={segment.provider}
            style={{
              width: `${(segment.costUsd / total) * 100}%`,
              backgroundColor: theme.colors[PALETTE_KEYS[index % PALETTE_KEYS.length]],
            }}
          />
        ))}
      </View>
      <View style={{ gap: 3 }}>
        {segments.map((segment, index) => (
          <View key={segment.provider} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                backgroundColor: theme.colors[PALETTE_KEYS[index % PALETTE_KEYS.length]],
              }}
            />
            <Text style={{ color: theme.colors.foreground, fontSize: 11, flexShrink: 1 }} numberOfLines={1}>
              {segment.provider}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginLeft: "auto" }}>
              {`$${segment.costUsd.toFixed(2)} · ${Math.round((segment.costUsd / total) * 100)}%`}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
