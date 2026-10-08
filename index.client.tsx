import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import type { ReactNode } from "react";
import { UsageScreen } from "./client/usage-screen";
import { buildPillText, usageSessionSummaryRpc, usageSummaryRpc, type SessionSummaryOutput, type UsageTotals } from "./shared/usage";

function UsageItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Gauge"
      active={currentScreen?.screenId === "usage"}
      onPress={() => openScreen({ screenId: "usage" })}
    />
  );
}

/** One contribution throwing must not kill the others. */
function SafeUsageItem(props: PluginSidebarItemProps) {
  try {
    return <UsageItem {...props} />;
  } catch (error) {
    console.error("[usage] sidebar item render failed", error);
    return (
      <View>
        <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>Usage</Text>
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

/** Detail card shown in the pill popover: full breakdown without navigation. */
function PillPopoverContent({
  agentId,
  data,
  openScreen,
}: {
  agentId: string;
  data: () => PillData | undefined;
  openScreen: () => void;
}) {
  return function Content({ theme, layout, close }: PluginButtonContentProps) {
    const current = data();
    const compact = layout.compact;
    const row = (label: string, value: string) => (
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 24 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
        <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const }}>{value}</Text>
      </View>
    );
    const divider = <View style={{ height: 1, backgroundColor: theme.colors.border, marginVertical: 6 }} />;

    let body: ReactNode;
    if (current?.session?.found) {
      const session = current.session;
      body = (
        <>
          <Text style={{ color: theme.colors.foreground, fontSize: compact ? 14 : 15, fontWeight: "700" as const }} numberOfLines={2}>
            {session.title || "Session"}
          </Text>
          <Text style={{ color: theme.colors.statusSuccess, fontSize: 11, fontWeight: "600" as const }}>Session mode</Text>
          {divider}
          {row("Provider", `${session.provider}/${session.model}`)}
          {row("Input", formatTokens(session.inputTokens))}
          {row("Output", formatTokens(session.outputTokens))}
          {row("Reasoning", formatTokens(session.reasoningTokens))}
          {row("Cache read", formatTokens(session.cacheReadTokens))}
          {row("Cache write", formatTokens(session.cacheWriteTokens))}
          {row("Cache hit", `${(session.cacheHitRatio * 100).toFixed(1)}%`)}
          {row("Cost", `$${session.costUsd.toFixed(4)}`)}
        </>
      );
    } else if (current?.daily) {
      const daily = current.daily;
      body = (
        <>
          <Text style={{ color: theme.colors.foreground, fontSize: compact ? 14 : 15, fontWeight: "700" as const }}>Today (all providers)</Text>
          <Text style={{ color: theme.colors.statusWarning, fontSize: 11, fontWeight: "600" as const }}>
            Daily fallback{current.session?.reason ? ` — ${current.session.reason}` : ""}
          </Text>
          {divider}
          {row("Input", formatTokens(daily.inputTokens))}
          {row("Output", formatTokens(daily.outputTokens))}
          {row("Reasoning", formatTokens(daily.reasoningTokens))}
          {row("Cache read", formatTokens(daily.cacheReadTokens))}
          {row("Cache write", formatTokens(daily.cacheWriteTokens))}
          {row("Cache hit", `${(daily.cacheHitRatio * 100).toFixed(1)}%`)}
          {row("Cost", `$${daily.costUsd.toFixed(2)}`)}
          {row("Sessions", String(daily.sessions))}
        </>
      );
    } else {
      body = (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Usage unavailable — session not tracked and daily totals failed to load.
        </Text>
      );
    }

    return (
      <View style={{ padding: 14, gap: 5, minWidth: 220, maxWidth: 320 }}>
        {body}
        {divider}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open Usage screen"
          onPress={() => {
            try {
              close();
            } catch {
              /* best effort */
            }
            try {
              openScreen();
            } catch (error) {
              console.error("[usage] pill popover openScreen failed", error);
            }
          }}
          style={{ paddingVertical: 7, borderRadius: 8, backgroundColor: theme.colors.accent, alignItems: "center" }}
        >
          <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "700" as const }}>Open Usage screen</Text>
        </Pressable>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>{agentId.slice(0, 8)}</Text>
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
      registration.update({ ...buildPillText(session, daily), icon: "Gauge" });
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
          title: "Session usage",
          icon: "Gauge",
          label: "…",
          behavior: {
            kind: "popover",
            Content: PillPopoverContent({
              agentId,
              data: () => latest.get(agentId),
              openScreen: () => {
                try {
                  client.openScreen({ screenId: "usage" });
                } catch (error) {
                  console.error("[usage] openScreen failed", error);
                }
              },
            }),
          },
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
  cleanups.push(safeCleanup("screen", () => client.addScreen({ id: "usage", title: "Usage", Component: UsageScreen })));
  // Header items are not rendered by every host layout (mobile shows the
  // footer area instead), so register both plus a Command Center entry.
  cleanups.push(safeCleanup("sidebar-header", () => client.addSidebarHeaderItem({ id: "usage", title: "Usage", Component: SafeUsageItem })));
  cleanups.push(safeCleanup("sidebar-footer", () => client.addSidebarFooterItem({ id: "usage-footer", title: "Usage", Component: SafeUsageItem })));
  cleanups.push(
    safeCleanup("command-center", () =>
      client.addCommandCenterItem({
        id: "open-usage",
        title: "Open Usage",
        icon: "Gauge",
        keywords: ["usage", "tokens", "cost", "dashboard"],
        context: "global",
        onSelect({ openScreen }) {
          try {
            openScreen({ screenId: "usage" });
          } catch (error) {
            console.error("[usage] command center openScreen failed", error);
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
