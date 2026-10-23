import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  usageRefreshRpc,
  usageSummaryRpc,
  type UsageEntry,
  type UsagePeriod,
  type UsageSummaryOutput,
} from "../shared/usage";

const PERIODS: UsagePeriod[] = ["1d", "7d", "30d", "all"];

function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return `${Math.round(value)}`;
}

function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatDate(epochMs: number): string {
  if (!epochMs) return "-";
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function StatCard(props: { label: string; value: string; sub?: string; styles: ReturnType<typeof makeStyles> }) {
  return (
    <View style={props.styles.card}>
      <Text style={props.styles.cardLabel}>{props.label}</Text>
      <Text style={props.styles.cardValue}>{props.value}</Text>
      {props.sub ? <Text style={props.styles.cardSub}>{props.sub}</Text> : null}
    </View>
  );
}

function EntryRow({ entry, compact, styles }: { entry: UsageEntry; compact: boolean; styles: ReturnType<typeof makeStyles> }) {
  const cells: Array<[string, string]> = [
    ["in", formatNumber(entry.inputTokens)],
    ["out", formatNumber(entry.outputTokens)],
    ["reason", formatNumber(entry.reasoningTokens)],
    ["c-rd", formatNumber(entry.cacheReadTokens)],
    ["c-wr", formatNumber(entry.cacheWriteTokens)],
    ["hit", formatPct(entry.cacheHitRatio)],
    ["cost", formatCost(entry.costUsd)],
    ["sesi", `${entry.sessions}`],
  ];
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.modelName} numberOfLines={1}>
          {entry.model}
        </Text>
        <Text style={styles.costHighlight}>{formatCost(entry.costUsd)}</Text>
      </View>
      <View style={styles.cellGrid}>
        {cells.map(([label, value]) => (
          <View key={label} style={styles.cell}>
            <Text style={styles.cellValue}>{value}</Text>
            <Text style={styles.cellLabel}>{label}</Text>
          </View>
        ))}
      </View>
      {!compact ? (
        <Text style={styles.rowDates}>
          {formatDate(entry.firstUsed)} - {formatDate(entry.lastUsed)}
        </Text>
      ) : null}
    </View>
  );
}

function makeStyles(theme: PluginScreenProps["theme"], compact: boolean) {
  const gap = compact ? 8 : 12;
  const pad = compact ? 12 : 20;
  return {
    screen: {
      flex: 1,
      backgroundColor: theme.colors.surface0,
    } as const,
    content: {
      padding: pad,
      gap,
    } as const,
    periodRow: {
      flexDirection: "row",
      gap: 8,
    } as const,
    periodChip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1 ?? theme.colors.surface0,
    } as const,
    periodChipActive: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    } as const,
    periodChipText: {
      color: theme.colors.foreground,
      fontWeight: "600" as const,
    } as const,
    periodChipTextActive: {
      color: theme.colors.accentForeground,
    } as const,
    cardsRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap,
    } as const,
    card: {
      flexGrow: 1,
      flexBasis: compact ? "45%" : "22%",
      minWidth: compact ? 140 : 150,
      padding: 12,
      borderRadius: 10,
      backgroundColor: theme.colors.surface1 ?? theme.colors.surface0,
      borderWidth: 1,
      borderColor: theme.colors.border,
      gap: 2,
    } as const,
    cardLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      textTransform: "uppercase" as const,
    } as const,
    cardValue: {
      color: theme.colors.foreground,
      fontSize: compact ? 18 : 22,
      fontWeight: "700" as const,
    } as const,
    cardSub: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
    } as const,
    sectionTitle: {
      color: theme.colors.foreground,
      fontSize: compact ? 14 : 16,
      fontWeight: "700" as const,
      marginTop: 4,
    } as const,
    providerHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 6,
    } as const,
    providerName: {
      color: theme.colors.foreground,
      fontSize: 13,
      fontWeight: "700" as const,
      textTransform: "capitalize" as const,
    } as const,
    backendBadge: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 1,
      overflow: "hidden" as const,
    } as const,
    row: {
      padding: 10,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1 ?? theme.colors.surface0,
      borderWidth: 1,
      borderColor: theme.colors.border,
      gap: 6,
    } as const,
    rowHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 8,
    } as const,
    modelName: {
      color: theme.colors.foreground,
      fontSize: 13,
      fontWeight: "600" as const,
      flexShrink: 1,
    } as const,
    costHighlight: {
      color: theme.colors.foreground,
      fontSize: 13,
      fontWeight: "700" as const,
    } as const,
    cellGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
    } as const,
    cell: {
      minWidth: compact ? 56 : 70,
    } as const,
    cellValue: {
      color: theme.colors.foreground,
      fontSize: 12,
    } as const,
    cellLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
    } as const,
    rowDates: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
    } as const,
    footer: {
      marginTop: 8,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      gap: 4,
    } as const,
    sourceRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    } as const,
    sourceStatus: {
      fontSize: 11,
      fontWeight: "700" as const,
    } as const,
    sourceName: {
      color: theme.colors.foreground,
      fontSize: 12,
      flexShrink: 1,
    } as const,
    sourceDetail: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      flexShrink: 1,
    } as const,
    message: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
      textAlign: "center" as const,
      marginTop: 40,
    } as const,
    refreshButton: {
      alignSelf: "flex-start" as const,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
    } as const,
    refreshText: {
      color: theme.colors.foreground,
      fontSize: 12,
    } as const,
  };
}

const STATUS_COLORS: Record<string, "ok" | "warning" | "danger" | "muted"> = {
  used: "ok",
  never_used: "muted",
  no_data_source: "warning",
  error: "danger",
};

function statusColor(theme: PluginScreenProps["theme"], status: string): string {
  switch (STATUS_COLORS[status] ?? "muted") {
    case "ok":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function UsageScreen({ theme, layout }: PluginScreenProps) {
  const [period, setPeriod] = useState<UsagePeriod>("30d");
  const summary = useRpc(usageSummaryRpc);
  const refresh = useRpc(usageRefreshRpc);
  const queryClient = useQueryClient();

  const query = useQuery<UsageSummaryOutput>({
    queryKey: ["usage", "summary", period],
    queryFn: () => summary({ period }),
  });
  const refreshMutation = useMutation({
    mutationFn: () => refresh({ period }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["usage", "summary"] });
    },
  });

  const compact = layout.compact;
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const data = query.data;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.periodRow}>
        {PERIODS.map((p) => (
          <Pressable
            key={p}
            accessibilityRole="button"
            accessibilityLabel={`Period ${p}`}
            accessibilityState={{ selected: period === p }}
            onPress={() => setPeriod(p)}
            style={[styles.periodChip, period === p && styles.periodChipActive]}
          >
            <Text style={[styles.periodChipText, period === p && styles.periodChipTextActive]}>{p}</Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh usage data"
          onPress={() => refreshMutation.mutate()}
          style={styles.refreshButton}
        >
          <Text style={styles.refreshText}>{refreshMutation.isPending ? "Refreshing..." : "Refresh"}</Text>
        </Pressable>
      </View>

      {query.isError ? (
        <Text style={styles.message}>Failed to load usage: {String(query.error)}</Text>
      ) : !data ? (
        <Text style={styles.message}>Loading usage...</Text>
      ) : data.byProvider.length === 0 ? (
        <Text style={styles.message}>No usage recorded for this period.</Text>
      ) : (
        <>
          <View style={styles.cardsRow}>
            <StatCard
              styles={styles}
              label="Cost"
              value={formatCost(data.totals.costUsd)}
              sub={`${formatNumber(data.totals.inputTokens + data.totals.outputTokens)} tokens`}
            />
            <StatCard
              styles={styles}
              label="Cache hit"
              value={formatPct(data.totals.cacheHitRatio)}
              sub={`${formatNumber(data.totals.cacheReadTokens)} cached`}
            />
            <StatCard
              styles={styles}
              label="Sessions"
              value={`${data.totals.sessions}`}
              sub={`in ${data.totals.reasoningTokens > 0 ? `${formatNumber(data.totals.reasoningTokens)} reasoning` : "period"}`}
            />
          </View>

          <Text style={styles.sectionTitle}>By provider and model</Text>
          {data.byProvider.map((group) => (
            <View key={`${group.backend}${group.provider}`} style={{ gap: 6 }}>
              <View style={styles.providerHeader}>
                <Text style={styles.providerName}>{group.provider}</Text>
                <Text style={styles.backendBadge}>{group.backend}</Text>
              </View>
              {group.entries.map((entry) => (
                <EntryRow key={entry.model} entry={entry} compact={compact} styles={styles} />
              ))}
            </View>
          ))}
        </>
      )}

      {data ? (
        <View style={styles.footer}>
          <Text style={styles.sectionTitle}>Sources</Text>
          {data.sources.map((source) => (
            <View key={source.backend} style={styles.sourceRow}>
              <Text style={[styles.sourceStatus, { color: statusColor(theme, source.status) }]}>
                {source.status.replace("_", " ")}
              </Text>
              <Text style={styles.sourceName}>{source.backend}</Text>
              {source.detail ? (
                <Text style={styles.sourceDetail} numberOfLines={2}>
                  {source.detail}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
