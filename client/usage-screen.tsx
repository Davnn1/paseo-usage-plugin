import { useRpc } from "@getpaseo/plugin/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { Dashboard } from "./dashboard";
import { localDateKey, startOfLocalDay, usageDashboardRpc, usageRefreshRpc, usageSummaryRpc, type Period, type UsageEntry, type UsageSummaryOutput } from "../shared/usage";

const PERIODS: { id: Mode; label: string; hint: string }[] = [
  { id: "1d", label: "1d", hint: "Today" },
  { id: "7d", label: "7d", hint: "Last 7 days" },
  { id: "week", label: "Week", hint: "This week, Monday to Sunday" },
  { id: "month", label: "Month", hint: "This calendar month" },
  { id: "all", label: "All", hint: "All time" },
  { id: "custom", label: "Custom", hint: "Custom date range" },
];

type Mode = Period | "week" | "month" | "custom";

const DAY_MS = 24 * 60 * 60 * 1000;
const dateKeyOf = localDateKey;
/** Scalar for a YYYY-MM-DD key (see startOfLocalDay in shared). */
const scalarOf = (key: string) => Date.parse(`${key}T00:00:00.000Z`);

/** Monday-first week containing the anchor (local days). */
function weekRange(anchorMs: number): { startDate: string; endDate: string } {
  const day = startOfLocalDay(anchorMs);
  const mondayOffset = (new Date(day + 12 * 3600 * 1000).getUTCDay() + 6) % 7;
  const start = day - mondayOffset * DAY_MS;
  return { startDate: dateKeyOf(start), endDate: dateKeyOf(start + 6 * DAY_MS) };
}

/** Calendar month containing the anchor (local days). */
function monthRange(anchorMs: number): { startDate: string; endDate: string } {
  const key = localDateKey(anchorMs); // YYYY-MM-DD
  const start = scalarOf(`${key.slice(0, 7)}-01`);
  const probe = new Date(start + 40 * DAY_MS); // into the next month
  const end = scalarOf(localDateKey(probe.getTime())) - DAY_MS;
  return { startDate: dateKeyOf(start), endDate: dateKeyOf(end) };
}

function shiftAnchor(mode: Mode, anchorMs: number, direction: -1 | 1): number {
  if (mode === "week") return anchorMs + direction * 7 * DAY_MS;
  if (mode === "month") {
    const key = localDateKey(anchorMs);
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(5, 7)) - 1 + direction;
    return scalarOf(`${new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7)}-01`) + 12 * 3600 * 1000;
  }
  return anchorMs + direction * 7 * DAY_MS;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function UsageScreen({ theme, layout, host }: PluginScreenProps) {
  const [mode, setMode] = useState<Mode>("30d");
  const [anchorMs, setAnchorMs] = useState(() => Date.now());
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [appliedCustom, setAppliedCustom] = useState<{ startDate: string; endDate: string } | null>(null);
  const [showDisabled, setShowDisabled] = useState(false);
  const [tableWidth, setTableWidth] = useState(0);
  const dismissDashboardRef = useRef<(() => void) | null>(null);

  const range: { startDate?: string; endDate?: string } | undefined =
    mode === "week"
      ? weekRange(anchorMs)
      : mode === "month"
        ? monthRange(anchorMs)
        : mode === "custom"
          ? appliedCustom ?? undefined
          : undefined;
  const period: Period = mode === "week" || mode === "month" || mode === "custom" ? "all" : mode;
  const rangeKey = range ? `${range.startDate ?? ""}|${range.endDate ?? ""}` : "";
  const fetchSummary = useRpc(usageSummaryRpc);
  const fetchDashboard = useRpc(usageDashboardRpc);
  const fetchRefresh = useRpc(usageRefreshRpc);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["usage", "summary", period, rangeKey],
    queryFn: () => fetchSummary({ period, ...range }),
  });
  const dashboardQuery = useQuery({
    queryKey: ["usage", "dashboard", period, rangeKey],
    queryFn: () => fetchDashboard({ period, ...range }),
  });
  const refresh = useMutation({
    mutationFn: () => fetchRefresh({ period, ...range }),
    onSuccess: (data) => {
      queryClient.setQueryData(["usage", "summary", period, rangeKey], data);
      void queryClient.invalidateQueries({ queryKey: ["usage", "dashboard", period, rangeKey] });
    },
  });

  const compact = layout.compact;
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        width: "100%",
        backgroundColor: theme.colors.surface0,
      } as const,
      content: {
        width: "100%",
        padding: compact ? 12 : 20,
        gap: compact ? 10 : 14,
      } as const,
      periodRow: {
        flexDirection: "row" as const,
        gap: 8,
      },
      periodButton: (active: boolean) =>
        ({
          paddingHorizontal: 14,
          paddingVertical: 7,
          borderRadius: 8,
          backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
        }) as const,
      periodText: (active: boolean) =>
        ({
          color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted,
          fontWeight: "600" as const,
          fontSize: 13,
        }) as const,
      cardGrid: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: compact ? 8 : 10,
      } as const,
      card: {
        flexGrow: 1,
        flexBasis: compact ? "45%" : "22%",
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        padding: compact ? 10 : 14,
        gap: 4,
      } as const,
      cardLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      } as const,
      cardValue: {
        color: theme.colors.foreground,
        fontSize: compact ? 16 : 20,
        fontWeight: "700" as const,
      } as const,
      sectionTitle: {
        color: theme.colors.foreground,
        fontSize: compact ? 14 : 16,
        fontWeight: "700" as const,
        marginTop: 4,
      } as const,
      table: {
        gap: 2,
      } as const,
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        paddingVertical: 6,
        paddingHorizontal: 8,
        borderRadius: 6,
        gap: 8,
      } as const,
      rowAlt: {
        backgroundColor: theme.colors.surface1,
      } as const,
      cell: {
        color: theme.colors.foreground,
        fontSize: 12,
      } as const,
      cellMuted: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
      } as const,
      coverage: {
        gap: 6,
      } as const,
      coverageRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
      } as const,
      badge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
        minWidth: 86,
        alignItems: "center" as const,
      } as const,
      badgeText: {
        color: theme.colors.surface0,
        fontSize: 10,
        fontWeight: "700" as const,
      } as const,
      coverageName: {
        color: theme.colors.foreground,
        fontSize: 12,
        flexShrink: 1,
      } as const,
      coverageMeta: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        flex: 1,
        textAlign: "right" as const,
      } as const,
      footerText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      } as const,
      message: {
        color: theme.colors.foregroundMuted,
        fontSize: 13,
        textAlign: "center" as const,
        paddingVertical: 32,
      } as const,
      retry: {
        alignSelf: "center" as const,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      } as const,
      retryText: {
        color: theme.colors.accentForeground,
        fontWeight: "600" as const,
      } as const,
    }),
    [theme, compact],
  );

  const data: UsageSummaryOutput | undefined = query.data;

  // Fill the measured width (minus inter-column gaps); fall back to per-column
  // minimums and scroll horizontally when the window is too narrow.
  const columnWidths = useMemo(() => {
    const gap = 8;
    const gaps = gap * (COLUMNS.length - 1);
    const totalWeight = COLUMNS.reduce((sum, column) => sum + column.weight, 0);
    const minTotal = COLUMNS.reduce((sum, column) => sum + column.minWidth, 0) + gaps;
    return {
      widths: COLUMNS.map((column) =>
        tableWidth > gaps
          ? Math.max(column.minWidth, ((tableWidth - gaps) * column.weight) / totalWeight)
          : column.minWidth,
      ),
      tableMinWidth: Math.max(tableWidth, minTotal),
    };
  }, [tableWidth]);

  const activeSources = data?.sources.filter((source) => source.enabled !== false) ?? [];
  const disabledSources = data?.sources.filter((source) => source.enabled === false) ?? [];

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        onScrollBeginDrag={() => dismissDashboardRef.current?.()}
        refreshControl={
          <RefreshControl
            refreshing={refresh.isPending}
            onRefresh={() => refresh.mutate()}
            tintColor={theme.colors.foregroundMuted}
          />
        }
      >
        <View style={styles.periodRow}>
          {PERIODS.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={item.hint}
              onPress={() => setMode(item.id)}
              style={styles.periodButton(mode === item.id)}
            >
              <Text style={styles.periodText(mode === item.id)}>{item.label}</Text>
            </Pressable>
          ))}
        </View>

        {mode === "custom" ? (
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <TextInput
              value={customStart}
              onChangeText={setCustomStart}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 6,
                color: theme.colors.foreground,
                fontSize: 12,
              }}
            />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>→</Text>
            <TextInput
              value={customEnd}
              onChangeText={setCustomEnd}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 6,
                color: theme.colors.foreground,
                fontSize: 12,
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Apply custom date range"
              onPress={() => {
                if (/^\d{4}-\d{2}-\d{2}$/.test(customStart) && /^\d{4}-\d{2}-\d{2}$/.test(customEnd)) {
                  setAppliedCustom({ startDate: customStart, endDate: customEnd });
                }
              }}
              style={styles.periodButton(true)}
            >
              <Text style={styles.periodText(true)}>Apply</Text>
            </Pressable>
          </View>
        ) : null}


        {query.isError ? (
          <View>
            <Text style={styles.message}>Failed to load usage data.</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading usage data"
              onPress={() => query.refetch()}
              style={styles.retry}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : data ? (
          <>
            <View style={styles.cardGrid}>
              <OverviewCard label="Cost" value={formatCost(data.totals.costUsd)} styles={styles} />
              <OverviewCard
                label="Tokens in / out"
                value={`${formatTokens(data.totals.inputTokens)} / ${formatTokens(data.totals.outputTokens)}`}
                styles={styles}
              />
              <OverviewCard
                label="Cache hit"
                value={formatPercent(data.totals.cacheHitRatio)}
                styles={styles}
              />
              <OverviewCard
                label="Sessions"
                value={String(data.totals.sessions)}
                styles={styles}
              />
            </View>

            {dashboardQuery.isError ? (
              <View>
                <Text style={styles.message}>Dashboard failed to load.</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading dashboard"
                  onPress={() => dashboardQuery.refetch()}
                  style={styles.retry}
                >
                  <Text style={styles.retryText}>Retry</Text>
                </Pressable>
              </View>
            ) : dashboardQuery.data ? (
              <Dashboard
                data={dashboardQuery.data}
                theme={theme}
                layout={layout}
                host={host}
                registerDismiss={(dismiss) => {
                  dismissDashboardRef.current = dismiss;
                }}
              />
            ) : (
              <Text style={styles.message}>Loading dashboard…</Text>
            )}

            <Text style={styles.sectionTitle}>Usage by model</Text>
            {data.byProvider.length === 0 ? (
              <Text style={styles.message}>No usage recorded for this period.</Text>
            ) : (
              <View onLayout={(event) => setTableWidth(event.nativeEvent.layout.width)}>
                <ScrollView horizontal showsHorizontalScrollIndicator>
                  <View style={[styles.table, { width: columnWidths.tableMinWidth }]}>
                    <TableHeader styles={styles} widths={columnWidths.widths} />
                    {data.byProvider.flatMap((group) =>
                      group.entries.map((entry, index) => (
                        <EntryRow
                          key={`${group.backend}:${group.provider}:${entry.model}`}
                          entry={entry}
                          alt={index % 2 === 1}
                          styles={styles}
                          widths={columnWidths.widths}
                        />
                      )),
                    )}
                  </View>
                </ScrollView>
              </View>
            )}

            <Text style={styles.sectionTitle}>Coverage</Text>
            <View style={styles.coverage}>
              {activeSources.map((source) => (
                <CoverageRow key={source.backend} source={source} styles={styles} theme={theme} />
              ))}
              {disabledSources.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={showDisabled ? "Hide disabled providers" : `Show ${disabledSources.length} disabled providers`}
                  onPress={() => setShowDisabled((value) => !value)}
                >
                  <Text style={styles.footerText}>
                    {showDisabled
                      ? "Hide disabled"
                      : `Show disabled (${disabledSources.length})`}
                  </Text>
                </Pressable>
              ) : null}
              {showDisabled
                ? disabledSources.map((source) => (
                    <CoverageRow key={source.backend} source={source} styles={styles} theme={theme} />
                  ))
                : null}
              {data.sources.some((source) => source.status === "error") ? (
                <Text style={styles.footerText}>
                  One or more sources failed; shown totals may be incomplete.
                </Text>
              ) : null}
            </View>
          </>
        ) : (
          <Text style={styles.message}>Loading usage…</Text>
        )}
      </ScrollView>
    </View>
  );
}

function OverviewCard({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  styles: any;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>{label}</Text>
      <Text style={styles.cardValue}>{value}</Text>
    </View>
  );
}

function CoverageRow({
  source,
  styles,
  theme,
}: {
  source: UsageSummaryOutput["sources"][number];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  styles: any;
  theme: PluginScreenProps["theme"];
}) {
  return (
    <View style={styles.coverageRow}>
      <View style={[styles.badge, { backgroundColor: badgeColor(source.status, theme) }]}>
        <Text style={styles.badgeText}>{source.status}</Text>
      </View>
      <Text style={styles.coverageName} numberOfLines={1}>
        {source.label ?? source.backend}
      </Text>
      <Text style={styles.coverageMeta} numberOfLines={1}>
        {[source.sessions != null ? `${source.sessions} sessions` : null, source.detail ?? ""]
          .filter(Boolean)
          .join(" · ")}
      </Text>
    </View>
  );
}

function badgeColor(status: string, theme: PluginScreenProps["theme"]): string {
  switch (status) {
    case "used":
      return theme.colors.statusSuccess;
    case "error":
      return theme.colors.statusDanger;
    case "no_data_source":
      return theme.colors.statusWarning;
    default:
      return theme.colors.foregroundMuted;
  }
}

interface ColumnDef {
  key: keyof UsageEntry | "provider";
  label: string;
  weight: number;
  minWidth: number;
}

const COLUMNS: ColumnDef[] = [
  { key: "provider", label: "Provider", weight: 1.5, minWidth: 96 },
  { key: "model", label: "Model", weight: 1.7, minWidth: 120 },
  { key: "inputTokens", label: "In", weight: 1, minWidth: 56 },
  { key: "outputTokens", label: "Out", weight: 1, minWidth: 56 },
  { key: "reasoningTokens", label: "Reason", weight: 1, minWidth: 60 },
  { key: "cacheReadTokens", label: "Cache-R", weight: 1.1, minWidth: 66 },
  { key: "cacheWriteTokens", label: "Cache-W", weight: 1.1, minWidth: 66 },
  { key: "cacheHitRatio", label: "Hit %", weight: 0.8, minWidth: 52 },
  { key: "costUsd", label: "Cost", weight: 1, minWidth: 60 },
  { key: "sessions", label: "Sesi", weight: 0.7, minWidth: 44 },
];

function TableHeader({ styles, widths }: { styles: any; widths: number[] }) {
  return (
    <View style={styles.row}>
      {COLUMNS.map((column, index) => (
        <Text key={column.key} style={[styles.cellMuted, { width: widths[index] }]}>
          {column.label}
        </Text>
      ))}
    </View>
  );
}

function EntryRow({
  entry,
  alt,
  styles,
  widths,
}: {
  entry: UsageEntry;
  alt: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  styles: any;
  widths: number[];
}) {
  const valueFor = (key: keyof UsageEntry | "provider"): string => {
    switch (key) {
      case "provider":
        return `${entry.backend} / ${entry.provider}`;
      case "inputTokens":
      case "outputTokens":
      case "reasoningTokens":
      case "cacheReadTokens":
      case "cacheWriteTokens":
        return formatTokens(entry[key]);
      case "cacheHitRatio":
        return formatPercent(entry.cacheHitRatio);
      case "costUsd":
        return formatCost(entry.costUsd);
      case "sessions":
        return String(entry.sessions);
      default:
        return String(entry[key]);
    }
  };
  return (
    <View style={[styles.row, alt ? styles.rowAlt : null]}>
      {COLUMNS.map((column, index) => (
        <Text
          key={column.key}
          style={[styles.cell, { width: widths[index] }]}
          numberOfLines={column.key === "provider" ? undefined : 1}
        >
          {valueFor(column.key)}
        </Text>
      ))}
    </View>
  );
}
