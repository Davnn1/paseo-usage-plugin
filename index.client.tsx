import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { UsageScreen } from "./client/usage-screen";
import { buildPillText, usageSessionSummaryRpc, usageSummaryRpc, type SessionSummaryOutput, type UsageTotals } from "./shared/usage";

function UsageItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Activity"
      active={currentScreen?.screenId === "usage"}
      onPress={() => openScreen({ screenId: "usage" })}
    />
  );
}

/** Workspace panel reuses the full screen body; panels carry no route params. */
function UsagePanel(props: PluginWorkspacePanelProps) {
  return <UsageScreen {...props} params={{}} />;
}

/** One contribution throwing must not kill the others. */
function SafeUsageItem(props: PluginSidebarItemProps) {
  try {
    return <UsageItem {...props} />;
  } catch (error) {
    console.error("[usage] sidebar item render failed", error);
    return (
      <View>
        <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>Monitoring</Text>
      </View>
    );
  }
}

function safeCleanup(label: string, fn: () => () => void): () => void {
  try {
    return fn();
  } catch (error) {
    console.error(`[usage] ${label} registration failed`, error);
    return () => {};
  }
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

interface PillData {
  session: SessionSummaryOutput | null;
  daily: UsageTotals | null;
}

interface MetricRow {
  id: string;
  label: string;
  value: string;
  dotColor: string;
  dotOpacity?: number;
  /** When set, renders a progress bar under the label instead of a plain value. */
  progressRatio?: number;
}

/**
 * Popover Content: a compact two-column metric card. Popovers render as a
 * bottom sheet on compact hosts. Data is read through the getter at render
 * time, so refresh only needs registration.update() for label/title.
 */
function formatCompactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatCompactWindow(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(value);
}

function PillDetailCard({ data }: { data: () => PillData | undefined }) {
  return function Content({ theme, layout }: PluginButtonContentProps) {
    const current = data();
    const compact = layout.compact;

    let rows: MetricRow[];
    if (current?.session?.found) {
      const session = current.session;
      rows = [
        { id: "input", label: "Input", value: formatTokens(session.inputTokens), dotColor: theme.colors.statusSuccess },
        { id: "output", label: "Output", value: formatTokens(session.outputTokens), dotColor: theme.colors.statusSuccess, dotOpacity: 0.55 },
        { id: "reasoning", label: "Reasoning", value: formatTokens(session.reasoningTokens), dotColor: theme.colors.foregroundMuted },
        { id: "cache-read", label: "Cache Read", value: formatTokens(session.cacheReadTokens), dotColor: theme.colors.border },
        { id: "cache-write", label: "Cache Write", value: formatTokens(session.cacheWriteTokens), dotColor: theme.colors.border, dotOpacity: 0.6 },
        { id: "cache-hit", label: "Cache Hit", value: `${(session.cacheHitRatio * 100).toFixed(1)}%`, dotColor: theme.colors.statusSuccess, progressRatio: session.cacheHitRatio },
        ...(session.ctx
          ? [
              {
                id: "context",
                label: "Context",
                value: `${Math.round(session.ctx.pct)}% (${formatCompactTokens(session.ctx.usedTokens)}/${formatCompactWindow(session.ctx.windowTokens)})`,
                dotColor: theme.colors.accent,
              },
            ]
          : []),
        { id: "cost", label: "Cost", value: `$${session.costUsd.toFixed(2)}`, dotColor: theme.colors.statusWarning },
      ];
    } else if (current?.daily) {
      const daily = current.daily;
      rows = [
        { id: "input", label: "Input", value: formatTokens(daily.inputTokens), dotColor: theme.colors.statusSuccess },
        { id: "output", label: "Output", value: formatTokens(daily.outputTokens), dotColor: theme.colors.statusSuccess, dotOpacity: 0.55 },
        { id: "reasoning", label: "Reasoning", value: formatTokens(daily.reasoningTokens), dotColor: theme.colors.foregroundMuted },
        { id: "cache-read", label: "Cache Read", value: formatTokens(daily.cacheReadTokens), dotColor: theme.colors.border },
        { id: "cache-write", label: "Cache Write", value: formatTokens(daily.cacheWriteTokens), dotColor: theme.colors.border, dotOpacity: 0.6 },
        { id: "cache-hit", label: "Cache Hit", value: `${(daily.cacheHitRatio * 100).toFixed(1)}%`, dotColor: theme.colors.statusSuccess, progressRatio: daily.cacheHitRatio },
        { id: "cost", label: "Cost", value: `$${daily.costUsd.toFixed(2)}`, dotColor: theme.colors.statusWarning },
      ];
    } else {
      return (
        <View style={{ alignSelf: "stretch" as const, padding: compact ? 12 : 14 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Monitoring unavailable</Text>
        </View>
      );
    }

    return (
      <View
        style={{
          alignSelf: "stretch" as const,
          width: "100%" as const,
          backgroundColor: theme.colors.surface1,
          borderRadius: 12,
          padding: compact ? 12 : 14,
          gap: compact ? 7 : 9,
        }}
      >
        {rows.map((rowMetric) => (
          <View key={rowMetric.id} style={{ gap: 3 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: rowMetric.dotColor,
                  opacity: rowMetric.dotOpacity ?? 1,
                }}
              />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 }}>{rowMetric.label}</Text>
              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const, textAlign: "right" as const }}>
                {rowMetric.value}
              </Text>
            </View>
            {rowMetric.progressRatio !== undefined ? (
              <View style={{ marginLeft: 15 }}>
                <View style={{ height: 3, borderRadius: 2, backgroundColor: theme.colors.border, overflow: "hidden" }}>
                  <View
                    style={{
                      height: 3,
                      width: `${Math.min(100, Math.max(0, rowMetric.progressRatio * 100))}%`,
                      borderRadius: 2,
                      backgroundColor: theme.colors.statusSuccess,
                    }}
                  />
                </View>
              </View>
            ) : null}
          </View>
        ))}
      </View>
    );
  };
}

/**
 * Per-agent composer pill: usage of the linked provider session, falling back
 * to the global daily total when the session is untracked. Owned list
 * subscription pattern: agents.list({subscribe, signal}); snapshot re-list is
 * idempotent because register() drops the previous pill first.
 */
function contributeUsagePill(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const latest = new Map<string, PillData>();
  const lifetime = new AbortController();
  const REFRESH_MS = 60_000;

  const drop = (agentId: string) => {
    const timer = timers.get(agentId);
    if (timer) clearInterval(timer);
    timers.delete(agentId);
    latest.delete(agentId);
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  const refreshPill = async (agentId: string) => {
    const registration = pills.get(agentId);
    if (!registration || lifetime.signal.aborted) return;
    let session: SessionSummaryOutput | null = null;
    let daily: UsageTotals | null = null;
    try {
      session = await client.rpc(usageSessionSummaryRpc, { agentId });
    } catch {
      session = null;
    }
    if (!session?.found) {
      try {
        daily = (await client.rpc(usageSummaryRpc, { period: "1d" })).totals;
      } catch {
        daily = null;
      }
    }
    if (lifetime.signal.aborted || !pills.has(agentId)) return;
    latest.set(agentId, { session, daily });
    try {
      registration.update({ label: buildPillText(session, daily).label, title: "Monitoring", icon: "Activity" });
    } catch (error) {
      console.error("[usage] pill update failed", error);
    }
  };

  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    drop(agentId);
    try {
      const registration = client.addComposerPill({
        id: "session-usage",
        workspaceId,
        agentId,
        button: {
          title: "Monitoring",
          icon: "Activity",
          label: "…",
          behavior: { kind: "popover", Content: PillDetailCard({ data: () => latest.get(agentId) }) },
        },
      });
      pills.set(agentId, registration);
      void refreshPill(agentId);
      timers.set(agentId, setInterval(() => void refreshPill(agentId), REFRESH_MS));
    } catch (error) {
      console.error("[usage] addComposerPill failed", error);
    }
  };

  const removeAll = () => {
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
    for (const pill of pills.values()) {
      try {
        pill.remove();
      } catch {
        /* idempotent best effort */
      }
    }
    pills.clear();
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return register(update.agent);
          drop(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("Usage pill agent observation failed", error);
    });

  return () => {
    lifetime.abort();
    removeAll();
  };
}

export default function contribute(client: PluginClientContext) {
  const cleanups: (() => void)[] = [];
  cleanups.push(safeCleanup("screen", () => client.addScreen({ id: "usage", title: "Monitoring", Component: UsageScreen })));
  // Workspace panels render as tabs beside agents/terminals, the surface that
  // is reliably present on mobile hosts (unlike sidebar header items).
  cleanups.push(
    safeCleanup("workspace-panel", () =>
      client.addWorkspacePanel({
        id: "usage-panel",
        title: "Monitoring",
        icon: "Activity",
        context: "workspace",
        Component: UsagePanel,
      }),
    ),
  );
  cleanups.push(safeCleanup("sidebar-header", () => client.addSidebarHeaderItem({ id: "usage", title: "Monitoring", Component: SafeUsageItem })));
  cleanups.push(
    safeCleanup("command-center", () =>
      client.addCommandCenterItem({
        id: "open-usage",
        title: "Open Monitoring",
        icon: "Activity",
        keywords: ["usage", "tokens", "cost", "dashboard"],
        context: "workspace",
        onSelect({ openPanel }) {
          try {
            openPanel("usage-panel");
          } catch (error) {
            console.error("[usage] command center openPanel failed, falling back to screen", error);
            try {
              client.openScreen({ screenId: "usage" });
            } catch (inner) {
              console.error("[usage] command center openScreen failed", inner);
            }
          }
        },
      }),
    ),
  );
  cleanups.push(safeCleanup("pill", () => contributeUsagePill(client)));
  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        /* best effort */
      }
    }
  };
}
