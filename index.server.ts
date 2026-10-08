import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import { UsageAggregator } from "./server/aggregator";
import { usageRefreshRpc, usageSummaryRpc } from "./shared/usage";

const aggregator = new UsageAggregator();

export default function contribute(server: PluginServerContext) {
  server.handle(usageSummaryRpc, ({ period }: RpcInput<typeof usageSummaryRpc>) =>
    aggregator.summarize(period),
  );
  server.handle(usageRefreshRpc, ({ period }: RpcInput<typeof usageRefreshRpc>) =>
    aggregator.refresh(period),
  );
  console.log("Plugin ready");
  return () => {};
}
