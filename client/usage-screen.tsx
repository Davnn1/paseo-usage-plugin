import { useRpc } from "@getpaseo/plugin/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { usageRefreshRpc, usageSummaryRpc, type Period, type UsageEntry, type UsageSummaryOutput } from "../shared/usage";

const PERIODS: { id: Period; label: string }[] = [
  { id: "1d", label: "1d" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "all", label: "All" },
];

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

export function UsageScreen({ theme, layout }: PluginScreenProps) {
  const [period, setPeriod] = useState<Period>("30d");
  const fetchSummary = useRpc(usageSummaryRpc);
  const fetchRefresh = useRpc(usageRefreshRpc);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["usage", "summary", period],
    queryFn: () => fetchSummary({ period }),
  });
  const refresh = useMutation({
    mutationFn: (target: Period) => fetchRefresh({ period: target }),
    onSuccess: (data, target) => {
      queryClient.setQueryData(["usage", "summary", target], data);
    },
  });

  const compact = layout.compact;
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      } as const,
      content: {
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
      },
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
      tableScroll: {} as const,
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
      footer: {
        gap: 4,
        paddingTop: 6,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
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

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refresh.isPending}
            onRefresh={() => refresh.mutate(period)}
            tintColor={theme.colors.foregroundMuted}
          />
        }
      >
        <View style={styles.periodRow}>
          {PERIODS.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`Period ${item.label}`}
              onPress={() => setPeriod(item.id)}
              style={styles.periodButton(period === item.id)}
            >
              <Text style={styles.periodText(period === item.id)}>{item.label}</Text>
            </Pressable>
          ))}
        </View>

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

            <Text style={styles.sectionTitle}>Usage by model</Text>
            {data.byProvider.length === 0 ? (
              <Text style={styles.message}>No usage recorded for this period.</Text>
            ) : (
              <ScrollView horizontal style={styles.tableScroll}>
                <View style={styles.table}>
                  <TableHeader styles={styles} />
                  {data.byProvider.flatMap((group) =>
                    group.entries.map((entry, index) => (
                      <EntryRow
                        key={`${group.backend}:${group.provider}:${entry.model}`}
                        entry={entry}
                        alt={index % 2 === 1}
                        styles={styles}
                      />
                    )),
                  )}
                </View>
              </ScrollView>
            )}

            <Text style={styles.sectionTitle}>Coverage</Text>
            <View style={styles.coverage}>
              {data.sources.map((source) => (
                <View key={source.backend} style={styles.coverageRow}>
                  <View style={[styles.badge, { backgroundColor: badgeColor(source.status, theme) }]}>
                    <Text style={styles.badgeText}>{source.status}</Text>
                  </View>
                  <Text style={styles.coverageName} numberOfLines={1}>
                    {source.label ?? source.backend}
                  </Text>
                  <Text style={styles.coverageMeta} numberOfLines={1}>
                    {[
                      source.enabled === false ? "disabled" : null,
                      source.sessions != null ? `${source.sessions} sessions` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || (source.detail ?? "")}
                  </Text>
                </View>
              ))}
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

const COLUMNS: { key: keyof UsageEntry | "provider"; label: string; width: number }[] = [
  { key: "provider", label: "Provider", width: 110 },
  { key: "model", label: "Model", width: 150 },
  { key: "inputTokens", label: "In", width: 70 },
  { key: "outputTokens", label: "Out", width: 70 },
  { key: "reasoningTokens", label: "Reason", width: 70 },
  { key: "cacheReadTokens", label: "Cache-R", width: 80 },
  { key: "cacheWriteTokens", label: "Cache-W", width: 80 },
  { key: "cacheHitRatio", label: "Hit %", width: 60 },
  { key: "costUsd", label: "Cost", width: 70 },
  { key: "sessions", label: "Sesi", width: 50 },
];

function TableHeader({ styles }: { styles: any }) {
  return (
    <View style={styles.row}>
      {COLUMNS.map((column) => (
        <Text key={column.key} style={[styles.cellMuted, { width: column.width }]}>
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
}: {
  entry: UsageEntry;
  alt: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  styles: any;
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
      {COLUMNS.map((column) => (
        <Text
          key={column.key}
          style={[styles.cell, { width: column.width }]}
          numberOfLines={1}
        >
          {valueFor(column.key)}
        </Text>
      ))}
    </View>
  );
}
