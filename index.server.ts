import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import type { PaseoApi } from "@getpaseo/client";
import { UsageAggregator } from "./server/aggregator";
import { listProviderEntries } from "./server/discovery";
import { applyGatewayInjection, probeProxy } from "./server/gateway-guard";
import { resolveSessionSummary } from "./server/session-lookup";
import { usageDashboardRpc, usageRefreshRpc, usageSessionSummaryRpc, usageSummaryRpc, type ProviderEntry } from "./shared/usage";

const aggregator = new UsageAggregator();
const proxyBase = () => process.env.AGY_PROXY_URL ?? "http://127.0.0.1:9880";
let proxyHealthy = false;
let warnedUnhealthy = false;

async function refreshProxyHealth(): Promise<void> {
  proxyHealthy = await probeProxy(proxyBase());
  if (proxyHealthy) warnedUnhealthy = false;
}

async function providerSnapshot(paseo: PaseoApi): Promise<ProviderEntry[] | undefined> {
  try {
    return await listProviderEntries(paseo);
  } catch (error) {
    console.error("provider snapshot failed, falling back to adapter sources", error);
    return undefined;
  }
}

export default function contribute(server: PluginServerContext) {
  // Route Antigravity harness LLM traffic through agy-usage-proxy so token
  // usage is recorded. Only new spawns; an explicit AGY_LLM_GATEWAY_URL in the
  // agent env or provider options always wins. Skipped when the proxy is
  // unreachable (agents run direct instead of failing to connect).
  server.before("agent.create", ({ request }) => {
    const outcome = applyGatewayInjection(request, proxyBase(), proxyHealthy);
    if (outcome === "skipped-unhealthy") {
      if (!warnedUnhealthy) {
        console.warn(`[usage] agy-proxy unreachable at ${proxyBase()}; Antigravity spawns run without AGY_LLM_GATEWAY_URL`);
        warnedUnhealthy = true;
      }
      return;
    }
    if (outcome === "injected") warnedUnhealthy = false;
    return request;
  });

  server.handle(usageSummaryRpc, async ({ period, startDate, endDate }: RpcInput<typeof usageSummaryRpc>, { paseo }) =>
    aggregator.summarize(period, { providerEntries: await providerSnapshot(paseo), startDate, endDate }),
  );
  server.handle(usageRefreshRpc, async ({ period, startDate, endDate }: RpcInput<typeof usageRefreshRpc>, { paseo }) =>
    aggregator.refresh(period, { providerEntries: await providerSnapshot(paseo), startDate, endDate }).summary,
  );
  server.handle(usageDashboardRpc, async ({ period, startDate, endDate }: RpcInput<typeof usageDashboardRpc>, { paseo }) =>
    aggregator.dashboard(period, { providerEntries: await providerSnapshot(paseo), startDate, endDate }),
  );
  server.handle(usageSessionSummaryRpc, ({ agentId }: RpcInput<typeof usageSessionSummaryRpc>) =>
    resolveSessionSummary(agentId),
  );
  void refreshProxyHealth();
  const healthTimer = setInterval(() => void refreshProxyHealth(), 30_000);
  healthTimer.unref?.();
  console.log("Plugin ready");
  return () => clearInterval(healthTimer);
}
