import type { SidebarUsageDisplayMode } from "@t3tools/contracts";
import type { ProviderUsageSidebarEntry } from "@t3tools/client-runtime/state/provider-usage";
import { SymbolView } from "expo-symbols";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useThemeColor } from "../../lib/useThemeColor";
import { UsageWindowRow, useProviderUsageEntries } from "../usage/usage-shared";
import { SettingsSection } from "./components/SettingsSection";

const DISPLAY_MODE: SidebarUsageDisplayMode = "used";

function ProviderUsageCard(props: {
  readonly entry: ProviderUsageSidebarEntry;
  readonly first: boolean;
}) {
  return (
    <View className={props.first ? "gap-4 p-4" : "border-t border-border gap-4 p-4"}>
      <View className="flex-row items-center gap-2">
        <ProviderIcon provider={props.entry.driver} size={20} />
        <Text className="shrink text-lg text-foreground" numberOfLines={1}>
          {props.entry.displayName}
        </Text>
        {props.entry.planLabel ? (
          <Text className="min-w-0 flex-1 text-base text-foreground-muted" numberOfLines={1}>
            {props.entry.planLabel}
          </Text>
        ) : null}
      </View>
      <View className="gap-4">
        {props.entry.usage.windows.map((window) => (
          <UsageWindowRow
            key={window.id}
            label={window.label}
            usedPercent={window.usedPercent}
            displayMode={DISPLAY_MODE}
            size="regular"
            {...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {})}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * Provider usage detail — the phone-facing counterpart to the iPad sidebar
 * footer, which no compact layout can show. One card per provider reporting
 * usage, each listing every rate-limit window it exposes.
 */
export function SettingsUsageRouteScreen() {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const entries = useProviderUsageEntries();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-3">
          <SettingsSection title="Providers">
            {entries.length === 0 ? (
              <View className="items-center gap-2 px-6 py-8">
                <SymbolView
                  name="chart.bar"
                  size={28}
                  tintColor={iconColor}
                  type="monochrome"
                  weight="regular"
                />
                <Text className="text-center text-base text-foreground">No usage reported</Text>
                <Text className="text-center text-sm text-foreground-muted">
                  Usage appears here once a connected environment has a provider that reports rate
                  limits, such as Claude, Codex, Cursor, or Grok.
                </Text>
              </View>
            ) : (
              entries.map((entry, index) => (
                <ProviderUsageCard key={entry.instanceId} entry={entry} first={index === 0} />
              ))
            )}
          </SettingsSection>
          {entries.length > 0 ? (
            <Text className="px-2 text-sm leading-normal text-foreground-muted">
              Percentages show how much of each window has been used. Values refresh with the
              environment&rsquo;s server config.
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
