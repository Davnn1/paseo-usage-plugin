import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  dailyTokens,
  localDateKey,
  localWeekday,
  type DailyPoint,
  type UsageDashboardOutput,
  type WeeklyPoint,
} from "../shared/usage";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

// ---------------------------------------------------------------------------
// Global tooltip: one layer at the dashboard root, free-floating across cards.
// ---------------------------------------------------------------------------

interface TipData {
  title: string;
  total?: string;
  rows: { label: string; value: string }[];
}

interface TipState {
  key: string;
  x: number;
  y: number;
  data: TipData;
}

interface TipAnchor {
  measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void;
}

interface TipController {
  show: (key: string, anchor: TipAnchor | null, data: TipData) => void;
  hide: (key: string) => void;
  toggle: (key: string, anchor: TipAnchor | null, data: TipData) => void;
}

const TIP_WIDTH = 172;

export function Dashboard({
  data,
  theme,
  layout,
}: {
  data: UsageDashboardOutput;
} & PluginHostProps) {
  const compact = layout.compact;
  const [tip, setTip] = useState<TipState | null>(null);
  const [rootWidth, setRootWidth] = useState(0);

  const controller: TipController = useMemo(
    () => ({
      show: (key, anchor, tipData) => {
        if (anchor?.measureInWindow) {
          anchor.measureInWindow((x, y, w, h) => {
            setTip((current) =>
              current && current.key === key ? current : { key, x: x + w / 2, y: y + h, data: tipData },
            );
          });
        } else {
          setTip((current) => (current && current.key === key ? current : { key, x: 0, y: 0, data: tipData }));
        }
      },
      hide: (key) => setTip((current) => (current && current.key === key ? null : current)),
      toggle: (key, anchor, tipData) => {
        setTip((current) => {
          if (current && current.key === key) return null;
          return { key, x: 0, y: 0, data: tipData };
        });
        if (anchor?.measureInWindow) {
          anchor.measureInWindow((x, y, w, h) => {
            setTip((current) =>
              current && current.key === key ? { ...current, x: x + w / 2, y: y + h } : current,
            );
          });
        }
      },
    }),
    [],
  );

  const tipLeft =
    tip === null ? 0 : Math.min(Math.max(4, tip.x - TIP_WIDTH / 2), Math.max(4, rootWidth - TIP_WIDTH - 4));

  return (
    <View style={stylesGrid(compact)} onLayout={(event) => setRootWidth(event.nativeEvent.layout.width)}>
      <View style={stylesCard(theme, compact)}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <Text style={stylesCardTitle(theme)}>OVERVIEW</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>Last 365 days</Text>
        </View>
        <Heatmap points={data.heatmapDaily} theme={theme} compact={compact} tips={controller} />
      </View>

      <View style={stylesCard(theme, compact)}>
        <Text style={stylesCardTitle(theme)}>MOST ACTIVE DAY</Text>
        <MostActiveAndWeekly series={data.series} theme={theme} compact={compact} tips={controller} />
      </View>

      <View style={stylesCard(theme, compact)}>
        <Text style={stylesCardTitle(theme)}>MODEL USAGE OVER TIME</Text>
        <TrendChart points={data.series.daily} theme={theme} compact={compact} tips={controller} />
      </View>

      <View style={stylesCard(theme, compact)}>
        <Text style={stylesCardTitle(theme)}>COST BY PROVIDER</Text>
        <CostByProvider data={data} theme={theme} compact={compact} />
      </View>

      {tip ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: tipLeft,
            top: tip.y + 10,
            width: TIP_WIDTH,
            backgroundColor: theme.colors.surface2,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            padding: 8,
            gap: 2,
            zIndex: 100,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "700" as const }} numberOfLines={1}>
            {tip.data.title}
          </Text>
          {tip.data.total ? (
            <Text style={{ color: theme.colors.foreground, fontSize: 10, fontWeight: "600" as const }}>{tip.data.total}</Text>
          ) : null}
          {tip.data.rows.map((row) => (
            <View key={row.label} style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{row.label}</Text>
              <Text style={{ color: theme.colors.foreground, fontSize: 10, fontWeight: "600" as const }}>{row.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function dailyTip(point: DailyPoint): TipData {
  return {
    title: point.date,
    total: `${formatTokens(dailyTokens(point))} tokens`,
    rows: [
      { label: "Input", value: formatTokens(point.inputTokens) },
      { label: "Output", value: formatTokens(point.outputTokens) },
      { label: "Cache Read", value: formatTokens(point.cacheReadTokens) },
      { label: "Cost", value: `$${point.costUsd.toFixed(2)}` },
      { label: "Sessions", value: String(point.sessions) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Shared style helpers
// ---------------------------------------------------------------------------

function stylesGrid(compact: boolean) {
  return {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    alignItems: "flex-start" as const,
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
// Heatmap: fixed-size cells, Monday-first rows x week columns, anchored tips.
// ---------------------------------------------------------------------------

function Heatmap({
  points,
  theme,
  compact,
  tips,
}: {
  points: DailyPoint[];
  theme: PluginHostProps["theme"];
  compact: boolean;
  tips: TipController;
}) {
  const cell = compact ? 9 : 11;
  const gap = 2;
  const labelWidth = 24;
  const cellRefs = useRef(new Map<string, View>());

  const { cells, weeks, monthLabels, activeDays, totalTokens, maxTokens, byDateKey } = useMemo(() => {
    const map = new Map(points.map((point) => [point.date, point]));
    // Day keys are local-date scalars (see startOfLocalDay in shared).
    const anchor = Date.parse(`${points[0]?.date ?? localDateKey(Date.now())}T00:00:00.000Z`);
    const anchorWeekday = localWeekday(anchor + 12 * 3600 * 1000);
    const start = anchor - ((anchorWeekday + 6) % 7) * 24 * 3600 * 1000;

    const cells: { date: string; week: number; weekday: number; tokens: number; point: DailyPoint | null }[] = [];
    const monthLabels: { week: number; label: string }[] = [];
    let lastMonth = "";
    let maxTokens = 0;
    let activeDays = 0;
    let totalTokens = 0;

    for (let i = 0; i < points.length; i += 1) {
      const t = start + i * 24 * 3600 * 1000;
      const key = localDateKey(t);
      const point = map.get(key);
      const tokens = point ? dailyTokens(point) : 0;
      const week = Math.floor(i / 7);
      const monthKey = key.slice(0, 7);
      if (monthKey !== lastMonth && localWeekday(t) === 1) {
        monthLabels.push({ week, label: MONTH_NAMES[Number(key.slice(5, 7)) - 1] });
        lastMonth = monthKey;
      }
      if (tokens > 0) activeDays += 1;
      totalTokens += tokens;
      if (tokens > maxTokens) maxTokens = tokens;
      cells.push({ date: key, week, weekday: localWeekday(t), tokens, point: point ?? null });
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
  const gridWidth = weeks * (cell + gap);

  const setCellRef = (date: string) => (node: View | null) => {
    if (node) cellRefs.current.set(date, node);
    else cellRefs.current.delete(date);
  };

  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 2, marginBottom: 2 }}>
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
              {WEEKDAY_MON_FIRST.map((weekday) => (
                <View key={weekday} style={{ flexDirection: "row", gap }}>
                  {Array.from({ length: weeks }, (_, week) => {
                    const cellPoint = grid[weekday]?.[week];
                    if (!cellPoint) return <View key={week} style={{ width: cell, height: cell }} />;
                    const level = intensity(cellPoint.tokens);
                    const cellView = (
                      <View
                        style={{
                          width: cell,
                          height: cell,
                          borderRadius: 2,
                          backgroundColor: theme.colors.statusSuccess,
                          opacity: level === 0 ? 0.12 : level,
                        }}
                      />
                    );
                    return cellPoint.point ? (
                      <Pressable
                        key={week}
                        ref={setCellRef(cellPoint.date) as never}
                        onHoverIn={() => tips.show(cellPoint.date, cellRefs.current.get(cellPoint.date) ?? null, dailyTip(cellPoint.point as DailyPoint))}
                        onHoverOut={() => tips.hide(cellPoint.date)}
                        onPress={() => tips.toggle(cellPoint.date, cellRefs.current.get(cellPoint.date) ?? null, dailyTip(cellPoint.point as DailyPoint))}
                      >
                        {cellView}
                      </Pressable>
                    ) : (
                      <View key={week}>{cellView}</View>
                    );
                  })}
                </View>
              ))}
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
// Most active day + weekly strip (constant height; tips via the global layer).
// ---------------------------------------------------------------------------

function MostActiveAndWeekly({
  series,
  theme,
  compact,
  tips,
}: {
  series: UsageDashboardOutput["series"];
  theme: PluginHostProps["theme"];
  compact: boolean;
  tips: TipController;
}) {
  const barRefs = useRef(new Map<number, View>());
  const maxWeekly = Math.max(1, ...series.weekly.map((point) => point.tokens));
  const mad = series.mostActiveDay;
  const barHeight = compact ? 42 : 56;

  return (
    <View style={{ gap: 10, marginTop: 2 }}>
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
                  ref={((node: View | null) => {
                    if (node) barRefs.current.set(weekday, node);
                    else barRefs.current.delete(weekday);
                  }) as never}
                  onHoverIn={() =>
                    tips.show(`week-${weekday}`, barRefs.current.get(weekday) ?? null, {
                      title: WEEKDAY_SHORT[weekday],
                      total: `${formatTokens(point.tokens)} tokens`,
                      rows: [{ label: "Cost", value: `$${point.costUsd.toFixed(2)}` }],
                    })
                  }
                  onHoverOut={() => tips.hide(`week-${weekday}`)}
                  onPress={() =>
                    tips.toggle(`week-${weekday}`, barRefs.current.get(weekday) ?? null, {
                      title: WEEKDAY_SHORT[weekday],
                      total: `${formatTokens(point.tokens)} tokens`,
                      rows: [{ label: "Cost", value: `$${point.costUsd.toFixed(2)}` }],
                    })
                  }
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
    </View>
  );
}

// ---------------------------------------------------------------------------
// Trend: explicit pixel geometry, dashed crosshair, global tooltip.
// ---------------------------------------------------------------------------

function TrendChart({
  points,
  theme,
  compact,
  tips,
}: {
  points: DailyPoint[];
  theme: PluginHostProps["theme"];
  compact: boolean;
  tips: TipController;
}) {
  const chartHeight = compact ? 64 : 84;
  const [width, setWidth] = useState(0);
  const barRefs = useRef(new Map<string, View>());

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
  const distributed = width > 0 ? width / count : 8;
  const barWidth = Math.min(28, Math.max(8, distributed));
  const scroll = width > 0 && count * (barWidth + gap) > width;
  const contentWidth = scroll ? count * (barWidth + gap) : width;
  const slotWidth = scroll ? barWidth + gap : width > 0 ? width / count : barWidth + gap;
  const exactBarWidth = scroll ? barWidth : Math.max(1, slotWidth - gap);

  const renderBar = (point: DailyPoint) => {
    const inRatio = point.inputTokens / maxTokens;
    const outRatio = point.outputTokens / maxTokens;
    const costRatio = point.costUsd / maxCost;
    const hasActivity = point.inputTokens + point.outputTokens > 0;
    const column = (
      <View style={{ width: exactBarWidth, height: chartHeight, justifyContent: "flex-end" }}>
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
    const key = `trend-${point.date}`;
    return hasActivity ? (
      <Pressable
        key={point.date}
        ref={((node: View | null) => {
          if (node) barRefs.current.set(key, node);
          else barRefs.current.delete(key);
        }) as never}
        onHoverIn={() => tips.show(key, barRefs.current.get(key) ?? null, dailyTip(point))}
        onHoverOut={() => tips.hide(key)}
        onPress={() => tips.toggle(key, barRefs.current.get(key) ?? null, dailyTip(point))}
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
        width: Math.max(1, contentWidth),
      }}
    >
      {points.map((point) => renderBar(point))}
    </View>
  );

  if (width <= 0) {
    return (
      <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ height: chartHeight }} />
    );
  }

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
