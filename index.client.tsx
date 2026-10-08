import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { UsageScreen } from "./client/usage-screen";

function UsageItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="BarChart3"
      active={currentScreen?.screenId === "usage"}
      onPress={() => openScreen({ screenId: "usage" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "usage", title: "Usage", Component: UsageScreen });
  client.addSidebarHeaderItem({ id: "usage", title: "Usage", Component: UsageItem });
  return () => {};
}
