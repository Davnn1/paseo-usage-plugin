import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
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
  // Independent hover state per chart (round 11: no cross-chart linking).
  const [heatFocus, setHeatFocus] = useState<DailyPoint | null>(null);
  const [trendFocus, setTrendFocus] = useState<DailyPoint | null>(null);
  const focusLine = (focus: DailyPoint | null, hint: string) => (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
      {focus
        ? `${focus.date} · in ${formatTokens(focus.inputTokens)} · out ${formatTokens(focus.outputTokens)} · $${focus.costUsd.toFixed(2)} · ${focus.sessions} sessions`
        : hint}
    </Text>
  );

  return (
    <View style={stylesGrid(compact)}>
      <View style={stylesCard(theme, compact)}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={stylesCardTitle(theme)}>OVERVIEW</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>Last 365 days</Text>
        </View>
        <Heatmap points={data.heatmapDaily} theme={theme} compact={compact} focus={heatFocus} onFocus={setHeatFocus} />
        {focusLine(heatFocus, "Hover or press a day for details.")}
      </View>

      <View style={stylesCard(theme, compact)}>
        <Text style={stylesCardTitle(theme)}>MOST ACTIVE DAY</Text>
        <MostActiveAndWeekly series={data.series} theme={theme} compact={compact} />
      </View>

      <View style={stylesCard(theme, compact)}>
        <Text style={stylesCardTitle(theme)}>MODEL USAGE OVER TIME</Text>
        <TrendChart points={data.series.daily} theme={theme} compact={compact} focus={trendFocus} onFocus={setTrendFocus} />
        {focusLine(trendFocus, "Hover or press a bar for details.")}
      </View>

      <View style={stylesCard(theme, compact)}>
        <Text style={stylesCardTitle(theme)}>COST BY PROVIDER</Text>
        <CostByProvider data={data} theme={theme} compact={compact} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared style helpers (functions to keep theme access at call time)
// ---------------------------------------------------------------------------

function stylesGrid(compact: boolean) {
  return {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    gap: compact ? 8 : 12,
    width: "100%" as const,
  };
}

function stylesCard(theme: PluginHostProps["theme"], compact: boolean) {
  return {
    flexGrow: 1,
    flexBasis: compact ? ("100%" as const) : ("45%" as const),
    backgroundColor: theme.colors.surface1,
    borderRadius: 10,
    padding: compact ? 10 : 14,
    gap: 8,
  };
}

function stylesCardTitle(theme: PluginHostProps["theme"]) {
  return {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontWeight: "700" as const,
    letterSpacing: 0.5,
  };
}

// ---------------------------------------------------------------------------
// Heatmap: last 365 days, Monday-first columns, floating card near the cell.
// ---------------------------------------------------------------------------

function Heatmap({
  points,
  theme,
  compact,
  focus,
  onFocus,
}: {
  points: DailyPoint[];
  theme: PluginHostProps["theme"];
  compact: boolean;
  focus: DailyPoint | null;
  onFocus: (point: DailyPoint | null) => void;
}) {
  const cell = compact ? 9 : 11;
  const gap = 2;
  const labelWidth = 24;

  const { cells, weeks, monthLabels, activeDays, totalTokens, maxTokens, byDateKey } = useMemo(() => {
    const map = new Map(points.map((point) => [point.date, point]));
    const first = new Date(`${points[0]?.date ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    const anchor = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
    const anchorWeekday = first.getUTCDay();
    const start = anchor - ((anchorWeekday + 6) % 7) * 24 * 3600 * 1000;

    const cells: { date: string; week: number; weekday: number; tokens: number; point: DailyPoint | null }[] = [];
    const monthLabels: { week: number; label: string }[] = [];
    let lastMonth = -1;
    let maxTokens = 0;
    let activeDays = 0;
    let totalTokens = 0;

    for (let i = 0; i < points.length; i += 1) {
      const t = start + i * 24 * 3600 * 1000;
      const d = new Date(t);
      const point = map.get(d.toISOString().slice(0, 10));
      const tokens = point ? dailyTokens(point) : 0;
      const week = Math.floor(i / 7);
      if (d.getUTCMonth() !== lastMonth && d.getUTCDay() === 1) {
        monthLabels.push({ week, label: d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }) });
        lastMonth = d.getUTCMonth();
      }
      if (tokens > 0) activeDays += 1;
      totalTokens += tokens;
      if (tokens > maxTokens) maxTokens = tokens;
      cells.push({ date: d.toISOString().slice(0, 10), week, weekday: d.getUTCDay(), tokens, point: point ?? null });
    }
    const weeks = Math.max(1, Math.ceil(cells.length / 7));
    const byDateKey = new Map(cells.map((cellPoint) => [cellPoint.date, cellPoint]));
    return { cells, weeks, monthLabels, activeDays, totalTokens, maxTokens, byDateKey };
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

  const focusedCell = focus ? byDateKey.get(focus.date) : undefined;
  const floating = focus && focusedCell ? { cell: focusedCell, point: focus } : null;
  const gridWidth = weeks * (cell + gap);

  const cellAt = (cellPoint: (typeof cells)[number]) => {
    const level = intensity(cellPoint.tokens);
    const highlighted = focus?.date === cellPoint.date;
    const cellView = (
      <View
        style={{
          width: cell,
          height: cell,
          borderRadius: 2,
          backgroundColor: theme.colors.statusSuccess,
          opacity: level === 0 ? 0.12 : level,
          borderWidth: highlighted ? 1.5 : 0,
          borderColor: theme.colors.foreground,
        }}
      />
    );
    return cellPoint.point ? (
      <Pressable
        key={`${cellPoint.week}-${cellPoint.weekday}`}
        onHoverIn={() => onFocus(cellPoint.point)}
        onHoverOut={() => onFocus(null)}
        onPress={() => onFocus(focus?.date === cellPoint.date ? null : cellPoint.point)}
      >
        {cellView}
      </Pressable>
    ) : (
      <View key={`${cellPoint.week}-${cellPoint.weekday}`}>{cellView}</View>
    );
  };

  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {`${activeDays} active days · ${formatTokens(totalTokens)} tokens · 365 days`}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ gap }}>
          <View style={{ flexDirection: "row", marginLeft: labelWidth + gap, height: 12 }}>
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
            <View style={{ width: labelWidth, gap }}>
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
            <View style={{ width: gridWidth, gap }}>
              {Array.from({ length: weeks }, (_, week) => (
                <View key={week} style={{ flexDirection: "row", gap }}>
                  {WEEKDAY_MON_FIRST.map((weekday) => {
                    const cellPoint = grid[weekday]?.[week];
                    if (!cellPoint) return <View key={weekday} style={{ width: cell, height: cell }} />;
                    return cellAt(cellPoint);
                  })}
                </View>
              ))}
              {floating ? (
                <View
                  style={{
                    position: "absolute" as const,
                    top: floating.cell.weekday * (cell + gap) + cell + 4,
                    left: Math.min(floating.cell.week * (cell + gap), Math.max(0, gridWidth - 172)),
                    width: 168,
                    backgroundColor: theme.colors.surface2,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    padding: 8,
                    gap: 2,
                    zIndex: 10,
                  }}
                >
                  <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "700" as const }}>
                    {floating.cell.date}
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                    {`in ${formatTokens(floating.point.inputTokens)} · out ${formatTokens(floating.point.outputTokens)}`}
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                    {`$${floating.point.costUsd.toFixed(2)} · ${floating.point.sessions} sessions`}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginLeft: labelWidth + gap }}>
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

// ---------------------------------------------------------------------------
// Most active day + weekly strip with crosshair and floating tooltip.
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
  const [focusWeekday, setFocusWeekday] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const maxWeekly = Math.max(1, ...series.weekly.map((point) => point.tokens));
  const mad = series.mostActiveDay;
  const barHeight = compact ? 42 : 56;
  const slotWidth = width > 0 ? width / 7 : 0;

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
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={{ height: barHeight + (focusWeekday !== null ? 62 : 14) }}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, height: barHeight }}>
          {WEEKDAY_MON_FIRST.map((weekday) => {
            const point: WeeklyPoint | undefined = series.weekly[weekday];
            const ratio = point ? point.tokens / maxWeekly : 0;
            const bar = (
              <View
                style={{
                  width: "100%",
                  height: Math.max(2, Math.round(ratio * barHeight)),
                  borderRadius: 3,
                  backgroundColor: theme.colors.accent,
                  opacity: point && point.tokens > 0 ? 1 : 0.15,
                }}
              />
            );
            return (
              <View key={weekday} style={{ flex: 1, alignItems: "center", gap: 3 }}>
                {point && point.tokens > 0 ? (
                  <Pressable
                    onHoverIn={() => setFocusWeekday(weekday)}
                    onHoverOut={() => setFocusWeekday((current) => (current === weekday ? null : current))}
                    onPress={() => setFocusWeekday((current) => (current === weekday ? null : weekday))}
                    style={{ width: "100%", alignItems: "center" }}
                  >
                    {bar}
                  </Pressable>
                ) : (
                  bar
                )}
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>
                  {WEEKDAY_SHORT[weekday].slice(0, 2)}
                </Text>
              </View>
            );
          })}
        </View>
        {focusWeekday !== null && slotWidth > 0 ? (
          <>
            <View
              style={{
                position: "absolute" as const,
                top: 0,
                height: barHeight,
                left: WEEKDAY_MON_FIRST.indexOf(focusWeekday) * slotWidth + slotWidth / 2,
                width: 0,
                gap: 2,
              }}
            >
              {Array.from({ length: Math.floor(barHeight / 5) }, (_, i) => (
                <View key={i} style={{ width: 1, height: 3, backgroundColor: theme.colors.foregroundMuted }} />
              ))}
            </View>
            <View
              style={{
                position: "absolute" as const,
                top: barHeight + 14,
                left: Math.min(
                  Math.max(4, WEEKDAY_MON_FIRST.indexOf(focusWeekday) * slotWidth + slotWidth / 2 - 70),
                  Math.max(4, width - 148),
                ),
                width: 140,
                backgroundColor: theme.colors.surface2,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.colors.border,
                padding: 8,
                gap: 2,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "700" as const }}>
                {WEEKDAY_SHORT[focusWeekday]}
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                {`${formatTokens(series.weekly[focusWeekday]?.tokens ?? 0)} tokens · $${(series.weekly[focusWeekday]?.costUsd ?? 0).toFixed(2)}`}
              </Text>
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Trend: full-width flex bars (no scroll), dashed crosshair, floating tooltip.
// ---------------------------------------------------------------------------

function TrendChart({
  points,
  theme,
  compact,
  focus,
  onFocus,
}: {
  points: DailyPoint[];
  theme: PluginHostProps["theme"];
  compact: boolean;
  focus: DailyPoint | null;
  onFocus: (point: DailyPoint | null) => void;
}) {
  const chartHeight = compact ? 64 : 84;
  const [width, setWidth] = useState(0);

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

  const count = points.length;
  const gap = 1;
  // Bar width: fills the container when few segments, clamps to a readable
  // minimum when many (All period scrolls horizontally instead of shrinking).
  const distributed = width > 0 ? width / count : 8;
  const barWidth = Math.min(28, Math.max(8, distributed));
  const scroll = width > 0 && count * (barWidth + gap) > width;
  const slotWidth = scroll ? barWidth + gap : width > 0 ? width / count : barWidth + gap;

  const focusIndex = focus ? points.findIndex((point) => point.date === focus.date) : -1;
  const focused = focusIndex >= 0 ? points[focusIndex] : null;

  const renderBar = (point: DailyPoint, widthStyle: { width: number } | { flex: number }) => {
    const inRatio = point.inputTokens / maxTokens;
    const outRatio = point.outputTokens / maxTokens;
    const costRatio = point.costUsd / maxCost;
    const hasActivity = point.inputTokens + point.outputTokens > 0;
    const column = (
      <View style={[{ height: chartHeight, justifyContent: "flex-end" }, widthStyle]}>
        <View
          style={{
            position: "absolute" as const,
            left: 0,
            right: 0,
            bottom: Math.round(costRatio * (chartHeight - 6)),
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
    return hasActivity ? (
      <Pressable
        key={point.date}
        onHoverIn={() => onFocus(point)}
        onHoverOut={() => onFocus(null)}
        onPress={() => onFocus(focused?.date === point.date ? null : point)}
      >
        {column}
      </Pressable>
    ) : (
      <View key={point.date}>{column}</View>
    );
  };

  const inner = (
    <View
      style={{
        flexDirection: "row",
        gap,
        height: chartHeight,
        width: scroll ? count * (barWidth + gap) : "100%",
      }}
    >
      {points.map((point) => renderBar(point, scroll ? { width: barWidth } : { flex: 1 }))}
      {focused && focusIndex >= 0 ? (
        <>
          <View
            style={{
              position: "absolute" as const,
              top: 0,
              height: chartHeight,
              left: focusIndex * slotWidth + slotWidth / 2,
              width: 0,
              gap: 2,
            }}
          >
            {Array.from({ length: Math.floor(chartHeight / 5) }, (_, i) => (
              <View key={i} style={{ width: 1, height: 3, backgroundColor: theme.colors.foregroundMuted }} />
            ))}
          </View>
          <View
            style={{
              position: "absolute" as const,
              top: 2,
              left: Math.min(
                Math.max(4, focusIndex * slotWidth + slotWidth / 2 - 75),
                Math.max(4, (scroll ? count * (barWidth + gap) : width) - 154),
              ),
              width: 150,
              backgroundColor: theme.colors.surface2,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.border,
              padding: 8,
              gap: 2,
              zIndex: 10,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "700" as const }}>{focused.date}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
              {`in ${formatTokens(focused.inputTokens)} · out ${formatTokens(focused.outputTokens)}`}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
              {`$${focused.costUsd.toFixed(2)} · ${focused.sessions} sessions`}
            </Text>
          </View>
        </>
      ) : null}
    </View>
  );

  return (
    <View style={{ gap: 6 }}>
      <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        {scroll ? (
          <ScrollView horizontal showsHorizontalScrollIndicator style={{ height: chartHeight }}>
            {inner}
          </ScrollView>
        ) : (
          inner
        )}
      </View>
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
