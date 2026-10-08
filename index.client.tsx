import type { PluginButtonContentProps, PluginButtonMenuEntry, PluginButtonRegistration, PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
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

/**
 * Menu behavior is the surface that renders on every host (mobile included).
 * Minimal on purpose: the sheet shows the session title (host header) plus one
 * or two disabled info lines — no provider/model, no redirect action. The full
 * breakdown lives in the Usage panel/screen. `update({behavior})` replaces the
 * whole behavior on refresh.
 */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function buildPillMenu(data: PillData | undefined): PluginButtonMenuEntry[] {
  const noop = { kind: "action" as const, onPress() {} };
  const items: PluginButtonMenuEntry[] = [];
  if (data?.session?.found) {
    items.push({
      kind: "item",
      id: "title",
      title: truncate(data.session.title || "Session", 44),
      disabled: true,
      behavior: noop,
    });
    items.push({
      kind: "item",
      id: "totals",
      title:
        `in ${formatTokens(data.session.inputTokens)} · out ${formatTokens(data.session.outputTokens)} · ` +
        `hit ${(data.session.cacheHitRatio * 100).toFixed(0)}% · $${data.session.costUsd.toFixed(2)}`,
      disabled: true,
      behavior: noop,
    });
  } else if (data?.daily) {
    items.push({
      kind: "item",
      id: "title",
      title: truncate(`Daily fallback${data.session?.reason ? ` — ${data.session.reason}` : ""}`, 44),
      disabled: true,
      behavior: noop,
    });
    items.push({
      kind: "item",
      id: "totals",
      title:
        `in ${formatTokens(data.daily.inputTokens)} · out ${formatTokens(data.daily.outputTokens)} · ` +
        `hit ${(data.daily.cacheHitRatio * 100).toFixed(0)}% · $${data.daily.costUsd.toFixed(2)}`,
      disabled: true,
      behavior: noop,
    });
  } else {
    items.push({
      kind: "item",
      id: "empty",
      title: "usage unavailable",
      disabled: true,
      behavior: noop,
    });
  }
  return items;
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
    const data: PillData = { session, daily };
    latest.set(agentId, data);
    try {
      registration.update({
        ...buildPillText(session, daily),
        icon: "Gauge",
        behavior: { kind: "menu", items: buildPillMenu(data) },
      });
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
          behavior: { kind: "menu", items: buildPillMenu(latest.get(agentId)) },
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
  // Workspace panels render as tabs beside agents/terminals, the surface that
  // is reliably present on mobile hosts (unlike sidebar header items).
  cleanups.push(
    safeCleanup("workspace-panel", () =>
      client.addWorkspacePanel({
        id: "usage-panel",
        title: "Usage",
        icon: "Gauge",
        context: "workspace",
        Component: UsagePanel,
      }),
    ),
  );
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
