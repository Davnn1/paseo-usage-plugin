import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import type { PaseoApi } from "@getpaseo/client";
import { UsageAggregator } from "./server/aggregator";
import { listProviderEntries } from "./server/discovery";
import { usageDashboardRpc, usageRefreshRpc, usageSummaryRpc, type ProviderEntry } from "./shared/usage";

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
  server.handle(usageSummaryRpc, async ({ period }: RpcInput<typeof usageSummaryRpc>, { paseo }) =>
    aggregator.summarize(period, { providerEntries: await providerSnapshot(paseo) }),
  );
  server.handle(usageRefreshRpc, async ({ period }: RpcInput<typeof usageRefreshRpc>, { paseo }) =>
    aggregator.refresh(period, { providerEntries: await providerSnapshot(paseo) }).summary,
  );
  server.handle(usageDashboardRpc, async ({ period }: RpcInput<typeof usageDashboardRpc>, { paseo }) =>
    aggregator.dashboard(period, { providerEntries: await providerSnapshot(paseo) }),
  );
  console.log("Plugin ready");
  return () => {};
}
