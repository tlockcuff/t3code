import { useAtomValue } from "@effect/atom-react";
import type { SidebarUsageDisplayMode } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { primaryServerProvidersAtom } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "~/lib/utils";
import {
  displayUsagePercent,
  formatUsageDisplayLabel,
  formatUsagePercent,
  formatUsageReset,
  getProviderUsageSidebarEntries,
  remainingFromUsed,
  type ProviderUsageSidebarEntry,
} from "@t3tools/client-runtime/state/provider-usage";
import { usageBarClass, usageToneClass } from "../usageToneClasses";

/** Most recent provider usage snapshot timestamp across sidebar entries. */
function latestUsageUpdatedAt(
  entries: ReadonlyArray<ProviderUsageSidebarEntry>,
): string | undefined {
  let latest: string | undefined;
  let latestMs = -Infinity;
  for (const entry of entries) {
    const ms = Date.parse(entry.usage.updatedAt);
    if (!Number.isFinite(ms) || ms <= latestMs) continue;
    latestMs = ms;
    latest = entry.usage.updatedAt;
  }
  return latest;
}

function UsageWindowRow(props: {
  readonly label: string;
  readonly usedPercent: number;
  readonly displayMode: SidebarUsageDisplayMode;
  readonly resetsAt?: number | null;
}) {
  const remaining = remainingFromUsed(props.usedPercent);
  const displayPercent = displayUsagePercent(props.usedPercent, props.displayMode);
  const resetLabel = formatUsageReset(props.resetsAt, Date.now());
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-[11px] leading-none">
        <span className="truncate text-muted-foreground">{props.label}</span>
        <span className={cn("shrink-0 tabular-nums", usageToneClass(remaining))}>
          {formatUsageDisplayLabel(props.usedPercent, props.displayMode)}
          {resetLabel ? ` · ${resetLabel}` : ""}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted/60">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200",
            usageBarClass(remaining),
          )}
          style={{ width: `${displayPercent}%` }}
        />
      </div>
    </div>
  );
}

function ProviderUsageExpanded(props: {
  readonly entry: ProviderUsageSidebarEntry;
  readonly displayMode: SidebarUsageDisplayMode;
}) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[props.entry.driver];
  return (
    <div className="flex flex-col gap-2 rounded-md bg-sidebar-accent/40 px-2 py-2">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-sidebar-foreground">
        {Icon ? <Icon className="size-3 shrink-0" aria-hidden="true" /> : null}
        <span className="truncate">{props.entry.displayName}</span>
        {props.entry.planLabel ? (
          <span className="min-w-0 truncate font-normal text-muted-foreground/80">
            · {props.entry.planLabel}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        {props.entry.usage.windows.map((window) => (
          <UsageWindowRow
            key={window.id}
            label={window.label}
            usedPercent={window.usedPercent}
            displayMode={props.displayMode}
            {...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {})}
          />
        ))}
      </div>
    </div>
  );
}

function CompactSummary(props: {
  readonly entries: ReadonlyArray<ProviderUsageSidebarEntry>;
  readonly displayMode: SidebarUsageDisplayMode;
}) {
  return (
    <div className="grid min-w-0 flex-1 grid-cols-4 gap-x-2 gap-y-1">
      {props.entries.map((entry) => {
        const Icon = PROVIDER_ICON_BY_PROVIDER[entry.driver];
        const displayPercent = displayUsagePercent(entry.usedPercent, props.displayMode);
        const label = formatUsageDisplayLabel(entry.usedPercent, props.displayMode);
        return (
          <span
            key={entry.instanceId}
            className={cn(
              "inline-flex min-w-0 items-center gap-1 text-[11px] tabular-nums",
              usageToneClass(entry.remainingPercent),
            )}
            title={`${entry.displayName}${entry.planLabel ? ` · ${entry.planLabel}` : ""}: ${label}`}
          >
            {Icon ? <Icon className="size-3 shrink-0 opacity-80" aria-hidden="true" /> : null}
            <span className="whitespace-nowrap">{formatUsagePercent(displayPercent)}</span>
          </span>
        );
      })}
    </div>
  );
}

export function SidebarUsageStatus() {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const sidebarUsageDrivers = usePrimarySettings((settings) => settings.sidebarUsageDrivers);
  const displayMode = usePrimarySettings((settings) => settings.sidebarUsageDisplayMode);
  const entries = useMemo(
    () => getProviderUsageSidebarEntries(providers, sidebarUsageDrivers),
    [providers, sidebarUsageDrivers],
  );
  const lastUpdatedAt = useMemo(() => latestUsageUpdatedAt(entries), [entries]);
  const [open, setOpen] = useState(false);
  // Tick while expanded so "Updated Xm ago" stays fresh without polling when collapsed.
  const [, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [open]);

  if (entries.length === 0) {
    return null;
  }

  const updatedLabel =
    lastUpdatedAt !== undefined ? `Updated ${formatRelativeTimeLabel(lastUpdatedAt)}` : null;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left",
          "text-muted-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          "outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        )}
        aria-label={open ? "Collapse provider usage" : "Expand provider usage"}
      >
        <CompactSummary entries={entries} displayMode={displayMode} />
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-150",
            open && "rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-1.5 px-1 pb-1 pt-0.5">
          {entries.map((entry) => (
            <ProviderUsageExpanded key={entry.instanceId} entry={entry} displayMode={displayMode} />
          ))}
          <button
            type="button"
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[11px]",
              "text-muted-foreground/80",
              "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              "outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            )}
            onClick={() => void navigate({ to: "/settings/usage" })}
          >
            <span className="min-w-0 truncate text-left">View usage details</span>
            {updatedLabel ? (
              <span className="shrink-0 tabular-nums text-muted-foreground/60">{updatedLabel}</span>
            ) : null}
          </button>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
