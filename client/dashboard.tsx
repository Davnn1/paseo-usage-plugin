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

/** Stable palette slot for a model name so its dot color never changes. */
function modelColorIndex(model: string): PaletteKey {
  let hash = 0;
  for (let i = 0; i < model.length; i += 1) hash = (hash * 31 + model.charCodeAt(i)) | 0;
  return PALETTE_KEYS[Math.abs(hash) % PALETTE_KEYS.length];
}

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
  rows: TipRow[];
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

function tipRowCount(tip: TipState | null): number {
  if (!tip) return 0;
  return (tip.data.total ? 1 : 0) + tip.data.rows.length;
}

export function Dashboard({
  data,
  theme,
  layout,
}: {
  data: UsageDashboardOutput;
} & PluginHostProps) {
  const compact = layout.compact;
  const [tip, setTip] = useState<TipState | null>(null);
  const tipRef = useRef<TipState | null>(null);
  tipRef.current = tip;
  const [rootWidth, setRootWidth] = useState(0);
  const [rootHeight, setRootHeight] = useState(0);
  const rootRef = useRef<View | null>(null);
  // measureInWindow returns WINDOW coordinates, but the tooltip layer renders
  // inside this container - position both and render the delta.
  const place = (key: string, anchor: TipAnchor | null, tipData: TipData) => {
    const apply = (originX: number, originY: number) => {
      if (anchor?.measureInWindow) {
        anchor.measureInWindow((x, y, w, h) => {
          setTip((current) =>
            current && current.key === key
              ? current
              : { key, x: x - originX + w / 2, y: y - originY + h, data: tipData },
          );
        });
      } else {
        setTip((current) => (current && current.key === key ? current : { key, x: 0, y: 0, data: tipData }));
      }
    };
    if (rootRef.current?.measureInWindow) {
      rootRef.current.measureInWindow(apply);
    } else {
      apply(0, 0);
    }
  };

  const controller: TipController = useMemo(
    () => ({
      show: (key, anchor, tipData) => place(key, anchor, tipData),
      hide: (key) => setTip((current) => (current && current.key === key ? null : current)),
      toggle: (key, anchor, tipData) => {
        if (tipRef.current?.key === key) {
          setTip(null);
        } else {
          place(key, anchor, tipData);
        }
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const tipLeft =
    tip === null ? 0 : Math.min(Math.max(4, tip.x - TIP_WIDTH / 2), Math.max(4, rootWidth - TIP_WIDTH - 4));
  // Flip the tooltip above the anchor when it would cross the dashboard's
  // bottom edge, so it stays whole even near the last card.
  const TIP_HEIGHT_EST = 30 + tipRowCount(tip) * 14;
  const tipLift = tip === null ? 0 : tip.y + 10 + TIP_HEIGHT_EST > rootHeight ? -(TIP_HEIGHT_EST + 20) : 0;

  return (
    <View
      ref={(node) => {
        rootRef.current = node;
      }}
      style={stylesGrid(compact)}
      onLayout={(event) => {
        setRootWidth(event.nativeEvent.layout.width);
        setRootHeight(event.nativeEvent.layout.height);
      }}
    >
      <View style={stylesCard(theme, compact)}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <Text style={stylesCardTitle(theme)}>OVERVIEW</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>Last 365 days</Text>
        </View>
        <Heatmap points={data.heatmapDaily} theme={theme} compact={compact} tips={controller} />
      </View>

      <View style={stylesCard(theme, compact)}>
        <Text style={stylesCardTitle(theme)}>WEEKLY ACTIVITY</Text>
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
            top: tip.y + 10 + tipLift,
            width: TIP_WIDTH,
            backgroundColor: theme.colors.surface2,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            padding: 8,
            gap: 2,
            // highest sibling zIndex and rendered last so cards never cover it
            zIndex: 1000,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "700" as const }} numberOfLines={1}>
            {tip.data.title}
          </Text>
          {tip.data.total ? (
            <Text style={{ color: theme.colors.foreground, fontSize: 10, fontWeight: "600" as const }}>{tip.data.total}</Text>
          ) : null}
          {tip.data.rows.map((row) => (
            <View key={row.label} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}>
                {row.dot ? (
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors[row.dot] }} />
                ) : null}
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
                  {row.label}
                </Text>
              </View>
              <Text style={{ color: theme.colors.foreground, fontSize: 10, fontWeight: "600" as const }}>{row.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

type PaletteKey = (typeof PALETTE_KEYS)[number];

interface TipRow {
  label: string;
  value: string;
  /** Optional stable palette key for a per-model dot. */
  dot?: PaletteKey;
}

function weeklyTip(weekday: number, point: WeeklyPoint, peakDate: string | null): TipData {
  return {
    title: peakDate ? `${WEEKDAY_SHORT[weekday]} · peak ${peakDate}` : WEEKDAY_SHORT[weekday],
    total: `${formatTokens(point.tokens)} tokens (cumulative)`,
    rows: [
      { label: "Input", value: formatTokens(point.inputTokens) },
      { label: "Output", value: formatTokens(point.outputTokens) },
      { label: "Cost", value: `$${point.costUsd.toFixed(2)}` },
    ],
  };
}

function dailyTip(point: DailyPoint): TipData {
  const rows: TipRow[] = point.models.slice(0, 6).map((model) => ({
    label: model.model,
    value: formatTokens(model.tokens),
    dot: modelColorIndex(model.model),
  }));
  rows.push(
    { label: "Input", value: formatTokens(point.inputTokens) },
    { label: "Output", value: formatTokens(point.outputTokens) },
    { label: "Cache Read", value: formatTokens(point.cacheReadTokens) },
    { label: "Cost", value: `$${point.costUsd.toFixed(2)}` },
  );
  return {
    title: point.date,
    total: `${formatTokens(dailyTokens(point))} tokens · ${point.sessions} sessions`,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Shared style helpers
// ---------------------------------------------------------------------------

function stylesGrid(compact: boolean) {
  return {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    // default cross-axis stretch: cards in a grid row share one height
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

/** Dashed vertical crosshair segments (RN has no stroke dash without svg). */
function crosshairSegments(theme: PluginHostProps["theme"], height: number, keyPrefix: string) {
  return Array.from({ length: Math.floor(height / 5) }, (_, i) => (
    <View key={`${keyPrefix}-${i}`} style={{ width: 1, height: 3, backgroundColor: theme.colors.foregroundMuted }} />
  ));
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
  const [width, setWidth] = useState(0);
  const [stripHeight, setStripHeight] = useState(0);
  const [cross, setCross] = useState<number | null>(null);
  const maxWeekly = Math.max(1, ...series.weekly.map((point) => point.tokens));
  const mad = series.mostActiveDay;
  const minBarHeight = compact ? 42 : 56;
  const barHeight = Math.max(minBarHeight, stripHeight - 14);
  const slotWidth = width > 0 ? width / 7 : 0;

  return (
    <View style={{ flex: 1, gap: 10, marginTop: 2 }}>
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
        onLayout={(event) => {
          setWidth(event.nativeEvent.layout.width);
          const h = event.nativeEvent.layout.height;
          setStripHeight((current) => (current === h ? current : h));
        }}
        style={{ flex: 1, minHeight: minBarHeight + 14, flexDirection: "row", alignItems: "flex-end", gap: 6 }}
      >
        {WEEKDAY_MON_FIRST.map((weekday) => {
          const point: WeeklyPoint | undefined = series.weekly[weekday];
          const ratio = point ? point.tokens / maxWeekly : 0;
          const inH = point ? Math.round((point.inputTokens / maxWeekly) * barHeight) : 0;
          const outH = point ? Math.max(0, Math.round(ratio * barHeight) - inH) : 0;
          const bar = (
            <View style={{ width: "100%", opacity: point && point.tokens > 0 ? 1 : 0.15, gap: 0 }}>
              <View style={{ height: Math.max(2, inH), borderTopLeftRadius: 3, borderTopRightRadius: 3, backgroundColor: theme.colors.statusSuccess }} />
              <View style={{ height: outH, backgroundColor: theme.colors.accent }} />
            </View>
          );
          return (
            <View key={weekday} style={{ flex: 1, alignItems: "center", gap: 3 }}>
              {point && point.tokens > 0 ? (
                <Pressable
                  ref={((node: View | null) => {
                    if (node) barRefs.current.set(weekday, node);
                    else barRefs.current.delete(weekday);
                  }) as never}
                  onHoverIn={() => {
                    setCross(weekday);
                    tips.show(
                      `week-${weekday}`,
                      barRefs.current.get(weekday) ?? null,
                      weeklyTip(weekday, point, mad && mad.weekday === weekday ? mad.date : null),
                    );
                  }}
                  onHoverOut={() => {
                    setCross((current) => (current === weekday ? null : current));
                    tips.hide(`week-${weekday}`);
                  }}
                  onPress={() =>
                    tips.toggle(
                      `week-${weekday}`,
                      barRefs.current.get(weekday) ?? null,
                      weeklyTip(weekday, point, mad && mad.weekday === weekday ? mad.date : null),
                    )
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
        {cross !== null && width > 0 ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              height: barHeight,
              left: WEEKDAY_MON_FIRST.indexOf(cross) * slotWidth + slotWidth / 2,
              width: 0,
              gap: 2,
            }}
          >
            {crosshairSegments(theme, barHeight, "weekly")}
          </View>
        ) : null}
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
  const minChartHeight = compact ? 64 : 84;
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const width = size.width;
  const chartHeight = Math.max(minChartHeight, size.height);
  const [cross, setCross] = useState<string | null>(null);
  const barRefs = useRef(new Map<string, View>());

  const { maxTokens, maxCost, maxModelTokens, active } = useMemo(() => {
    let maxTokens = 0;
    let maxCost = 0;
    let maxModelTokens = 0;
    let active = 0;
    for (const point of points) {
      const tokens = point.inputTokens + point.outputTokens;
      if (tokens > maxTokens) maxTokens = tokens;
      if (point.costUsd > maxCost) maxCost = point.costUsd;
      for (const model of point.models.slice(0, 5)) {
        if (model.tokens > maxModelTokens) maxModelTokens = model.tokens;
      }
      if (tokens > 0) active += 1;
    }
    return {
      maxTokens: Math.max(1, maxTokens),
      maxCost: Math.max(0.01, maxCost),
      maxModelTokens: Math.max(1, maxModelTokens),
      active,
    };
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
    // Per-model overlay dots (top 5), same hash palette as the tooltip dots -
    // thin markers on the bar's own scale, cost line pattern.
    const modelDots = point.models.slice(0, 5).map((model) => (
      <View
        key={model.model}
        style={{
          position: "absolute" as const,
          left: Math.max(0, exactBarWidth / 2 - 1.5),
          bottom: Math.round((model.tokens / maxModelTokens) * (chartHeight - 6)),
          width: 3,
          height: 3,
          borderRadius: 1.5,
          backgroundColor: theme.colors[modelColorIndex(model.model)],
          opacity: 0.95,
        }}
      />
    ));
    const column = (
      <View style={{ width: exactBarWidth, height: chartHeight, justifyContent: "flex-end" }}>
        {modelDots}
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
            backgroundColor: theme.colors.statusSuccess,
            opacity: point.inputTokens > 0 ? 0.9 : 0,
          }}
        />
        <View
          style={{
            height: Math.max(0, Math.round(outRatio * chartHeight)),
            backgroundColor: theme.colors.accent,
            opacity: point.outputTokens > 0 ? 0.9 : 0,
            borderTopLeftRadius: 1,
            borderTopRightRadius: 1,
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
        onHoverIn={() => {
          setCross(point.date);
          tips.show(key, barRefs.current.get(key) ?? null, dailyTip(point));
        }}
        onHoverOut={() => {
          setCross((current) => (current === point.date ? null : current));
          tips.hide(key);
        }}
        onPress={() => tips.toggle(key, barRefs.current.get(key) ?? null, dailyTip(point))}
      >
        {column}
      </Pressable>
    ) : (
      <View key={point.date}>{column}</View>
    );
  };

  const crossIndex = cross ? points.findIndex((point) => point.date === cross) : -1;

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
      {crossIndex >= 0 ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            height: chartHeight,
            left: crossIndex * slotWidth + slotWidth / 2,
            width: 0,
            gap: 2,
          }}
        >
          {crosshairSegments(theme, chartHeight, "trend")}
        </View>
      ) : null}
    </View>
  );

  if (width <= 0) {
    return (
      <View
        style={{ flex: 1, minHeight: minChartHeight }}
        onLayout={(event) => {
          const { width: w, height: h } = event.nativeEvent.layout;
          setSize((current) => (current.width === w && current.height === h ? current : { width: w, height: h }));
        }}
      />
    );
  }

  const topModels = (() => {
    const totals = new Map<string, number>();
    for (const point of points) {
      for (const model of point.models.slice(0, 5)) {
        totals.set(model.model, (totals.get(model.model) ?? 0) + model.tokens);
      }
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  })();

  return (
    <View style={{ flex: 1, gap: 6 }}>
      <View
        style={{ flex: 1, minHeight: minChartHeight }}
        onLayout={(event) => {
          const { width: w, height: h } = event.nativeEvent.layout;
          setSize((current) => (current.width === w && current.height === h ? current : { width: w, height: h }));
        }}
      >
        {scroll ? (
          <ScrollView horizontal showsHorizontalScrollIndicator style={{ height: chartHeight }}>
            {inner}
          </ScrollView>
        ) : (
          inner
        )}
      </View>
      <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" as const }}>
        <Legend color={theme.colors.statusSuccess} label="Input" theme={theme} />
        <Legend color={theme.colors.accent} label="Output" theme={theme} />
        <Legend color={theme.colors.statusWarning} label="Cost" theme={theme} />
        {topModels.map(([model]) => (
          <Legend key={model} color={theme.colors[modelColorIndex(model)]} label={model} theme={theme} />
        ))}
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
