import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import type { PaseoApi } from "@getpaseo/client";
import { UsageAggregator } from "./server/aggregator";
import { listProviderEntries } from "./server/discovery";
import { resolveSessionSummary } from "./server/session-lookup";
import { usageDashboardRpc, usageRefreshRpc, usageSessionSummaryRpc, usageSummaryRpc, type ProviderEntry } from "./shared/usage";

const aggregator = new UsageAggregator();

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
  // agent env or provider options always wins.
  server.before("agent.create", ({ request }) => {
    const provider = request.config.provider;
    if (provider !== "antigravity" && provider !== "antigravity-acp") return;
    const base = process.env.AGY_PROXY_URL ?? "http://127.0.0.1:9880";
    const gateway = provider === "antigravity" ? `${base}/cli` : `${base}/acp`;
    const configured =
      request.env?.["AGY_LLM_GATEWAY_URL"] ??
      (request.config.providerOptions?.env as Record<string, unknown> | undefined)?.["AGY_LLM_GATEWAY_URL"];
    if (typeof configured === "string" && configured) return;
    request.env = { ...(request.env ?? {}), AGY_LLM_GATEWAY_URL: gateway };
    return request;
  });

  server.handle(usageSummaryRpc, async ({ period }: RpcInput<typeof usageSummaryRpc>, { paseo }) =>
    aggregator.summarize(period, { providerEntries: await providerSnapshot(paseo) }),
  );
  server.handle(usageRefreshRpc, async ({ period }: RpcInput<typeof usageRefreshRpc>, { paseo }) =>
    aggregator.refresh(period, { providerEntries: await providerSnapshot(paseo) }).summary,
  );
  server.handle(usageDashboardRpc, async ({ period }: RpcInput<typeof usageDashboardRpc>, { paseo }) =>
    aggregator.dashboard(period, { providerEntries: await providerSnapshot(paseo) }),
  );
  server.handle(usageSessionSummaryRpc, ({ agentId }: RpcInput<typeof usageSessionSummaryRpc>) =>
    resolveSessionSummary(agentId),
  );
  console.log("Plugin ready");
  return () => {};
}
