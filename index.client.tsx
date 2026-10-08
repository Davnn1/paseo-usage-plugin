import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
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

/**
 * Per-agent composer pill: usage of the linked provider session, falling back
 * to the global daily total when the session is untracked. Owned list
 * subscription pattern: agents.list({subscribe, signal}); snapshot re-list is
 * idempotent because register() drops the previous pill first.
 */
function contributeUsagePill(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const lifetime = new AbortController();
  const REFRESH_MS = 60_000;

  const drop = (agentId: string) => {
    const timer = timers.get(agentId);
    if (timer) clearInterval(timer);
    timers.delete(agentId);
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
            kind: "action",
            onPress() {
              try {
                client.openScreen({ screenId: "usage" });
              } catch (error) {
                console.error("[usage] openScreen failed", error);
              }
            },
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
  cleanups.push(safeCleanup("sidebar", () => client.addSidebarHeaderItem({ id: "usage", title: "Usage", Component: SafeUsageItem })));
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
