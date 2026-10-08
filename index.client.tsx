import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { UsageScreen } from "./client/usage-screen";
import { usageSessionSummaryRpc, type SessionSummaryOutput } from "./shared/usage";

function UsageItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="BarChart3"
      active={currentScreen?.screenId === "usage"}
      onPress={() => openScreen({ screenId: "usage" })}
    />
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatCost(value: number): string {
  if (value >= 100) return `$${Math.round(value)}`;
  if (value >= 10) return `$${value.toFixed(1)}`;
  return `$${value.toFixed(2)}`;
}

/** Densest per-character label; width is host chrome, so detail lives in title. */
function sessionLabel(summary: SessionSummaryOutput): { label: string; title: string } {
  if (!summary.found) {
    return { label: "—", title: `Session usage unavailable: ${summary.reason ?? "unknown"}` };
  }
  const label = `${formatTokens(summary.inputTokens)}/${formatTokens(summary.outputTokens)}·${(summary.cacheHitRatio * 100).toFixed(0)}%·${formatCost(summary.costUsd)}`;
  const title =
    `${summary.title || "Session"} — ${formatTokens(summary.inputTokens)} in / ${formatTokens(summary.outputTokens)} out ` +
    `(reasoning ${formatTokens(summary.reasoningTokens)}), cache read ${formatTokens(summary.cacheReadTokens)}, ` +
    `write ${formatTokens(summary.cacheWriteTokens)}, hit ${(summary.cacheHitRatio * 100).toFixed(1)}%, ` +
    `cost $${summary.costUsd.toFixed(4)} · ${summary.provider}/${summary.model}`;
  return { label, title };
}

/**
 * Per-agent composer pill showing the usage of the provider session linked to
 * that agent. Registration follows the owned list subscription pattern:
 * agents.list({subscribe, signal}) delivers a snapshot then updates; a snapshot
 * re-list is idempotent because register() removes the previous pill first.
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
    try {
      const summary = await client.rpc(usageSessionSummaryRpc, { agentId });
      if (lifetime.signal.aborted || !pills.has(agentId)) return;
      registration.update({ ...sessionLabel(summary), icon: "BarChart3" });
    } catch {
      if (!lifetime.signal.aborted && pills.has(agentId)) {
        registration.update({ label: "—", title: "Session usage unavailable", icon: "BarChart3" });
      }
    }
  };

  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    drop(agentId);
    const registration = client.addComposerPill({
      id: "session-usage",
      workspaceId,
      agentId,
      button: {
        title: "Session usage",
        icon: "BarChart3",
        label: "…",
        behavior: {
          kind: "action",
          onPress() {
            client.openScreen({ screenId: "usage" });
          },
        },
      },
    });
    pills.set(agentId, registration);
    void refreshPill(agentId);
    timers.set(agentId, setInterval(() => void refreshPill(agentId), REFRESH_MS));
  };

  const removeAll = () => {
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
    for (const pill of pills.values()) pill.remove();
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
  client.addScreen({ id: "usage", title: "Usage", Component: UsageScreen });
  client.addSidebarHeaderItem({ id: "usage", title: "Usage", Component: UsageItem });
  const cleanupPill = contributeUsagePill(client);
  return () => {
    cleanupPill();
  };
}
