import type { SidebarUsageDisplayMode } from "@t3tools/contracts";
import {
  displayUsagePercent,
  formatUsagePercent,
  type ProviderUsageSidebarEntry,
} from "@t3tools/client-runtime/state/provider-usage";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  UsageWindowRow,
  useProviderUsageEntries,
  useUsageColors,
  usageToneColor,
} from "./usage-shared";

function ProviderUsageExpanded(props: {
  readonly entry: ProviderUsageSidebarEntry;
  readonly displayMode: SidebarUsageDisplayMode;
}) {
  return (
    <View className="gap-2 rounded-md bg-card px-2 py-2">
      <View className="flex-row items-center gap-1.5">
        <ProviderIcon provider={props.entry.driver} size={12} />
        <Text className="text-[11px] font-t3-medium text-foreground" numberOfLines={1}>
          {props.entry.displayName}
        </Text>
        {props.entry.planLabel ? (
          <Text className="flex-1 text-[11px] text-foreground-muted" numberOfLines={1}>
            · {props.entry.planLabel}
          </Text>
        ) : null}
      </View>
      <View className="gap-2">
        {props.entry.usage.windows.map((window) => (
          <UsageWindowRow
            key={window.id}
            label={window.label}
            usedPercent={window.usedPercent}
            displayMode={props.displayMode}
            {...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {})}
          />
        ))}
      </View>
    </View>
  );
}

function CompactSummaryItem(props: {
  readonly entry: ProviderUsageSidebarEntry;
  readonly displayMode: SidebarUsageDisplayMode;
}) {
  const colors = useUsageColors();
  const displayPercent = displayUsagePercent(props.entry.usedPercent, props.displayMode);
  return (
    <View className="flex-row items-center gap-1">
      <ProviderIcon provider={props.entry.driver} size={12} />
      <Text
        className="text-[11px]"
        style={{ color: usageToneColor(props.entry.remainingPercent, colors) }}
      >
        {formatUsagePercent(displayPercent)}
      </Text>
    </View>
  );
}

/**
 * iPad sidebar footer usage summary — mirrors the web SidebarUsageStatus.
 * Collapsed: a row of provider icons + percent. Expanded: per-window bars.
 *
 * Renders its own top border + bottom safe-area inset so the whole footer
 * (border included) disappears when no provider reports usage.
 */
export function SidebarUsageStatus(props: {
  readonly displayMode?: SidebarUsageDisplayMode;
  readonly bottomInset?: number;
}) {
  const displayMode = props.displayMode ?? "used";
  const entries = useProviderUsageEntries();
  const [open, setOpen] = useState(false);
  const chevronColor = String(useThemeColor("--color-chevron"));
  const borderColor = String(useThemeColor("--color-border"));

  if (entries.length === 0) {
    return null;
  }

  return (
    <View
      className="w-full px-1.5 pt-1.5"
      style={{
        paddingBottom: props.bottomInset ?? 0,
        borderTopColor: borderColor,
        borderTopWidth: StyleSheet.hairlineWidth,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? "Collapse provider usage" : "Expand provider usage"}
        onPress={() => setOpen((value) => !value)}
        className="flex-row items-center gap-1 rounded-lg px-2 py-1.5"
      >
        <View className="flex-1 flex-row flex-wrap items-center gap-x-3 gap-y-1">
          {entries.map((entry) => (
            <CompactSummaryItem key={entry.instanceId} entry={entry} displayMode={displayMode} />
          ))}
        </View>
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={12}
          tintColor={chevronColor}
          type="monochrome"
        />
      </Pressable>
      {open ? (
        <View className="gap-1.5 px-1 pt-0.5 pb-1">
          {entries.map((entry) => (
            <ProviderUsageExpanded key={entry.instanceId} entry={entry} displayMode={displayMode} />
          ))}
        </View>
      ) : null}
    </View>
  );
}
