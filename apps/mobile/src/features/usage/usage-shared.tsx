import type { ServerProvider, SidebarUsageDisplayMode } from "@t3tools/contracts";
import {
  displayUsagePercent,
  formatUsageDisplayLabel,
  formatUsageReset,
  getProviderUsageSidebarEntries,
  remainingFromUsed,
  type ProviderUsageSidebarEntry,
} from "@t3tools/client-runtime/state/provider-usage";
import { useMemo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { useServerConfigs } from "../../state/entities";

// Urgency always keys off remaining capacity, matching web. Mobile has no
// `warning` theme token, so the middle tier uses a literal amber.
const WARNING_COLOR = "#d97706";

export function useUsageColors() {
  return {
    muted: String(useThemeColor("--color-foreground-muted")),
    danger: String(useThemeColor("--color-danger")),
    primary: String(useThemeColor("--color-primary")),
    track: String(useThemeColor("--color-border")),
  };
}

export function usageToneColor(
  remainingPercent: number,
  colors: { readonly muted: string; readonly danger: string },
): string {
  if (remainingPercent <= 10) return colors.danger;
  if (remainingPercent <= 25) return WARNING_COLOR;
  return colors.muted;
}

export function usageBarColor(
  remainingPercent: number,
  colors: { readonly primary: string; readonly danger: string },
): string {
  if (remainingPercent <= 10) return colors.danger;
  if (remainingPercent <= 25) return WARNING_COLOR;
  return colors.primary;
}

/**
 * Provider usage across every connected environment, deduped by instance id.
 * Uses the same allowlist + ok-status filtering the web sidebar applies.
 */
export function useProviderUsageEntries(): ReadonlyArray<ProviderUsageSidebarEntry> {
  const serverConfigs = useServerConfigs();
  return useMemo(() => {
    const seen = new Set<string>();
    const providers: Array<ServerProvider> = [];
    for (const config of serverConfigs.values()) {
      for (const provider of config.providers) {
        if (seen.has(provider.instanceId)) continue;
        seen.add(provider.instanceId);
        providers.push(provider);
      }
    }
    return getProviderUsageSidebarEntries(providers);
  }, [serverConfigs]);
}

/** A single usage window: label, percent + reset on the right, bar underneath. */
export function UsageWindowRow(props: {
  readonly label: string;
  readonly usedPercent: number;
  readonly displayMode: SidebarUsageDisplayMode;
  readonly resetsAt?: number | null;
  readonly size?: "compact" | "regular";
}) {
  const colors = useUsageColors();
  const regular = props.size === "regular";
  const remaining = remainingFromUsed(props.usedPercent);
  const displayPercent = displayUsagePercent(props.usedPercent, props.displayMode);
  const resetLabel = formatUsageReset(props.resetsAt, Date.now());
  return (
    <View className={regular ? "gap-1.5" : "gap-1"}>
      <View className="flex-row items-center justify-between gap-2">
        <Text
          className={
            regular
              ? "flex-1 text-base text-foreground"
              : "flex-1 text-[11px] text-foreground-muted"
          }
          numberOfLines={1}
        >
          {props.label}
        </Text>
        <Text
          className={regular ? "shrink-0 text-base" : "shrink-0 text-[11px]"}
          style={{ color: usageToneColor(remaining, colors) }}
        >
          {formatUsageDisplayLabel(props.usedPercent, props.displayMode)}
          {resetLabel ? ` · ${resetLabel}` : ""}
        </Text>
      </View>
      <View
        className={
          regular ? "h-1.5 overflow-hidden rounded-full" : "h-1 overflow-hidden rounded-full"
        }
        style={{ backgroundColor: colors.track }}
      >
        <View
          className="h-full rounded-full"
          style={{
            width: `${displayPercent}%`,
            backgroundColor: usageBarColor(remaining, colors),
          }}
        />
      </View>
    </View>
  );
}
