import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type {
  OrchestrationContextUsageThread,
  ProviderDriverKind,
  SidebarUsageDisplayMode,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ArchiveIcon,
  ChevronDownIcon,
  FolderGit2Icon,
  LoaderIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import {
  displayUsagePercent,
  formatUsageDisplayLabel,
  formatUsageReset,
  remainingFromUsed,
} from "@t3tools/client-runtime/state/provider-usage";
import { usageBarClass, usageToneClass } from "../usageToneClasses";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import {
  formatContextUsageTokens,
  formatEstimatedUsd,
  formatFillPercent,
  getProviderUsageDetailEntries,
  groupContextUsageByProject,
  HISTORY_WINDOW_META,
  machineProviderDriver,
  summarizeHistoryWindows,
  summarizeLedgerByProvider,
  summarizeMachineUsageByProvider,
  usedFillPercent,
  type HistoryWindowTotals,
  type ProviderHistorySummary,
} from "./UsageSettings.logic";

function UsageMetric(props: {
  readonly tokens: number;
  readonly estimatedCostUsd: number;
  readonly emphasize?: boolean;
  readonly align?: "left" | "right";
}) {
  return (
    <div
      className={cn("min-w-0 tabular-nums", props.align === "left" ? "text-left" : "text-right")}
    >
      <div
        className={cn(
          "font-semibold tracking-[-0.02em] text-foreground",
          props.emphasize ? "text-[15px]" : "text-[13px]",
        )}
      >
        {formatEstimatedUsd(props.estimatedCostUsd)}
      </div>
      <div className="text-[11px] text-muted-foreground/70">
        {formatContextUsageTokens(props.tokens)}
      </div>
    </div>
  );
}

function HistoryWindowStrip(props: {
  readonly windows: HistoryWindowTotals;
  readonly compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden bg-border/50 sm:grid-cols-4",
        props.compact ? "rounded-xl" : "rounded-none",
      )}
    >
      {HISTORY_WINDOW_META.map((window) => {
        const totals = props.windows[window.key];
        return (
          <div
            key={window.key}
            className={cn(
              "flex flex-col gap-1.5 bg-card px-3 py-3 sm:px-4",
              props.compact ? "py-2.5" : "sm:py-3.5",
            )}
          >
            <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/65">
              <span className="sm:hidden">{window.shortLabel}</span>
              <span className="hidden sm:inline">{window.label}</span>
            </div>
            <UsageMetric
              tokens={totals.tokens}
              estimatedCostUsd={totals.estimatedCostUsd}
              emphasize={!props.compact}
              align="left"
            />
          </div>
        );
      })}
    </div>
  );
}

function ProviderHistoryRow(props: {
  readonly summary: ProviderHistorySummary;
  readonly total30dCost: number;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const driver = machineProviderDriver(props.summary.key);
  const Icon =
    driver !== null ? PROVIDER_ICON_BY_PROVIDER[driver as ProviderDriverKind] : undefined;
  const isOk = props.summary.status === "ok";
  const isEmpty =
    isOk &&
    props.summary.windows.last30Days.tokens <= 0 &&
    props.summary.windows.last30Days.estimatedCostUsd <= 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-border/60">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/25 sm:px-5",
          open && "bg-muted/15",
        )}
      >
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground">
          {Icon ? (
            <Icon className="size-3.5" />
          ) : (
            <span className="text-[11px] font-semibold">?</span>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[13px] font-semibold tracking-[-0.01em]">
                  {props.summary.label}
                </span>
                {!isOk ? (
                  <span className="rounded-md bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                    {props.summary.status === "missing" ? "Missing" : "Error"}
                  </span>
                ) : isEmpty ? (
                  <span className="rounded-md bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                    Idle
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {isOk && !isEmpty ? (
                <UsageMetric
                  tokens={props.summary.windows.last30Days.tokens}
                  estimatedCostUsd={props.summary.windows.last30Days.estimatedCostUsd}
                />
              ) : (
                <span className="text-[12px] text-muted-foreground/60">—</span>
              )}
              <ChevronDownIcon
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200",
                  open && "rotate-180",
                )}
              />
            </div>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-t border-border/50 bg-muted/10 px-3 pt-2 pb-3 sm:px-4">
          {isOk ? (
            <>
              <HistoryWindowStrip windows={props.summary.windows} compact />
            </>
          ) : (
            <div className="px-1 py-2 text-[12px] text-muted-foreground">
              {props.summary.detail ?? "No historical spend available for this provider."}
            </div>
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ProviderHistoryList(props: {
  readonly summaries: ReadonlyArray<ProviderHistorySummary>;
  readonly emptyLabel?: string;
}) {
  const total30dCost = useMemo(
    () =>
      props.summaries.reduce(
        (sum, summary) =>
          summary.status === "ok" ? sum + summary.windows.last30Days.estimatedCostUsd : sum,
        0,
      ),
    [props.summaries],
  );

  if (props.summaries.length === 0) {
    return (
      <div className="border-t border-border/60 px-4 py-3 text-[12px] text-muted-foreground sm:px-5">
        {props.emptyLabel ?? "No provider breakdown yet."}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between border-t border-border/60 px-4 py-2 sm:px-5">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
          By provider
        </div>
        <div className="text-[10px] text-muted-foreground/55">30d share</div>
      </div>
      {props.summaries.map((summary) => (
        <ProviderHistoryRow
          key={summary.key}
          summary={summary}
          total30dCost={total30dCost}
          defaultOpen={false}
        />
      ))}
    </div>
  );
}

function ContextFillBar(props: { readonly usedTokens: number; readonly maxTokens: number | null }) {
  const fill = usedFillPercent(props.usedTokens, props.maxTokens);
  if (fill === null) {
    return (
      <span className="tabular-nums text-muted-foreground">
        {formatContextUsageTokens(props.usedTokens)}
      </span>
    );
  }
  const remaining = 100 - fill;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums">
        <span className={usageToneClass(remaining)}>{formatFillPercent(fill)}</span>
        <span className="text-muted-foreground/70">
          {formatContextUsageTokens(props.usedTokens)}/{formatContextUsageTokens(props.maxTokens)}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted/60">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200",
            usageBarClass(remaining),
          )}
          style={{ width: `${Math.max(0, Math.min(100, fill))}%` }}
        />
      </div>
    </div>
  );
}

function ThreadContextRow(props: {
  readonly thread: OrchestrationContextUsageThread;
  readonly environmentId: string;
}) {
  return (
    <div className="border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              to="/$environmentId/$threadId"
              params={{
                environmentId: props.environmentId,
                threadId: props.thread.threadId,
              }}
              className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground hover:underline"
            >
              {props.thread.title}
            </Link>
            {props.thread.archivedAt ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                <ArchiveIcon className="size-2.5" />
                Archived
              </span>
            ) : null}
          </div>
          <div className="text-[11px] text-muted-foreground/70">
            Updated {formatRelativeTimeLabel(props.thread.updatedAt)}
          </div>
          {props.thread.totalProcessedTokens !== null &&
          props.thread.totalProcessedTokens > props.thread.usedTokens ? (
            <div className="text-[11px] text-muted-foreground/60">
              Total processed {formatContextUsageTokens(props.thread.totalProcessedTokens)}
            </div>
          ) : null}
        </div>
        <div className="w-full sm:w-44">
          <ContextFillBar usedTokens={props.thread.usedTokens} maxTokens={props.thread.maxTokens} />
        </div>
      </div>
    </div>
  );
}

function ProviderPlanUsageSection(props: {
  readonly displayMode: SidebarUsageDisplayMode;
  readonly nowMs: number;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}) {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const entries = useMemo(() => getProviderUsageDetailEntries(providers), [providers]);

  return (
    <SettingsSection
      title="Provider plan limits"
      headerAction={
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={props.refreshing}
          onClick={props.onRefresh}
          aria-label="Refresh provider usage"
        >
          <RefreshCwIcon className={cn("size-3", props.refreshing && "animate-spin")} />
          Refresh
        </Button>
      }
    >
      {entries.length === 0 ? (
        <SettingsRow
          title="No providers"
          description="Enable a provider to see plan rate-limit usage."
        />
      ) : (
        entries.map((entry) => {
          const Icon = PROVIDER_ICON_BY_PROVIDER[entry.driver as ProviderDriverKind];
          const usage = entry.usage;
          return (
            <div
              key={entry.instanceId}
              className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5"
            >
              <div className="mb-2 flex min-w-0 items-center gap-2">
                {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold tracking-[-0.01em]">
                    {entry.displayName}
                    {entry.planLabel ? (
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        · {entry.planLabel}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[11px] text-muted-foreground/70">
                    {!entry.installed
                      ? "Not installed"
                      : usage === undefined
                        ? "Usage not reported yet"
                        : usage.status === "ok"
                          ? `Updated ${formatRelativeTimeLabel(usage.updatedAt)}`
                          : usage.status === "unavailable"
                            ? (usage.error ?? "Unavailable")
                            : (usage.error ?? "Error loading usage")}
                  </div>
                </div>
              </div>
              {usage?.status === "ok" && usage.windows.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {usage.windows.map((window) => {
                    const remaining = remainingFromUsed(window.usedPercent);
                    const resetLabel = formatUsageReset(window.resetsAt, props.nowMs);
                    return (
                      <div key={window.id} className="flex flex-col gap-1">
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="truncate text-muted-foreground">{window.label}</span>
                          <span className={cn("shrink-0 tabular-nums", usageToneClass(remaining))}>
                            {formatUsageDisplayLabel(window.usedPercent, props.displayMode)}
                            {resetLabel ? ` · ${resetLabel}` : ""}
                          </span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-muted/60">
                          <div
                            className={cn(
                              "h-full rounded-full transition-[width] duration-200",
                              usageBarClass(remaining),
                            )}
                            style={{
                              width: `${displayUsagePercent(window.usedPercent, props.displayMode)}%`,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </SettingsSection>
  );
}

export function UsageSettingsPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const displayMode = usePrimarySettings((settings) => settings.sidebarUsageDisplayMode);
  const nowMs = useRelativeTimeTick(30_000);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [refreshingProviders, setRefreshingProviders] = useState(false);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const contextUsageQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : orchestrationEnvironment.contextUsage({
          environmentId,
          input: { includeArchived },
        }),
  );

  const t3LedgerQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : orchestrationEnvironment.tokenUsageLedger({
          environmentId,
          input: {},
        }),
  );

  const machineUsageQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : orchestrationEnvironment.machineUsageHistory({
          environmentId,
          input: {},
        }),
  );

  const projectGroups = useMemo(
    () => groupContextUsageByProject(contextUsageQuery.data?.threads ?? []),
    [contextUsageQuery.data?.threads],
  );

  const t3Windows = useMemo(
    () => summarizeHistoryWindows(t3LedgerQuery.data?.rows ?? [], nowMs),
    [t3LedgerQuery.data?.rows, nowMs],
  );

  const t3ProviderSummaries = useMemo(
    () => summarizeLedgerByProvider(t3LedgerQuery.data?.rows ?? [], nowMs),
    [t3LedgerQuery.data?.rows, nowMs],
  );

  const machineWindows = useMemo(() => {
    const rows =
      machineUsageQuery.data?.sources.flatMap((source) =>
        source.status === "ok" ? source.daily : [],
      ) ?? [];
    return summarizeHistoryWindows(rows, nowMs);
  }, [machineUsageQuery.data?.sources, nowMs]);

  const machineProviderSummaries = useMemo(
    () => summarizeMachineUsageByProvider(machineUsageQuery.data?.sources ?? [], nowMs),
    [machineUsageQuery.data?.sources, nowMs],
  );

  const handleRefreshProviders = useCallback(() => {
    if (environmentId === null || refreshingProviders) return;
    setRefreshingProviders(true);
    void (async () => {
      try {
        const result = await refreshProviders({ environmentId, input: {} });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Could not refresh provider usage",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      } finally {
        setRefreshingProviders(false);
      }
    })();
  }, [environmentId, refreshProviders, refreshingProviders]);

  return (
    <SettingsPageContainer>
      <ProviderPlanUsageSection
        displayMode={displayMode}
        nowMs={nowMs}
        onRefresh={handleRefreshProviders}
        refreshing={refreshingProviders}
      />

      <SettingsSection
        title="T3 Code usage"
        headerAction={
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={t3LedgerQuery.isPending || environmentId === null}
            onClick={() => t3LedgerQuery.refresh()}
            aria-label="Refresh T3 usage"
          >
            <RefreshCwIcon className={cn("size-3", t3LedgerQuery.isPending && "animate-spin")} />
            Refresh
          </Button>
        }
      >
        {environmentId === null ? (
          <SettingsRow
            title="No environment"
            description="Connect to a server environment to load T3 usage."
          />
        ) : t3LedgerQuery.error ? (
          <SettingsRow title="Could not load T3 usage" description={t3LedgerQuery.error} />
        ) : (t3LedgerQuery.data?.rows.length ?? 0) === 0 ? (
          <SettingsRow
            title="No T3 ledger yet"
            description="New token deltas are recorded as threads report usage. Existing history is backfilled on first open when possible."
          />
        ) : (
          <>
            <HistoryWindowStrip windows={t3Windows} />
            <ProviderHistoryList
              summaries={t3ProviderSummaries}
              emptyLabel="No T3 provider breakdown yet."
            />
            <div className="border-t border-border/60 px-4 py-3 sm:px-5">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
                By day
              </div>
              <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
                {t3LedgerQuery.data?.rows.slice(0, 30).map((row) => (
                  <div
                    key={`${row.day}-${row.projectId ?? ""}-${row.model ?? ""}`}
                    className="flex items-center justify-between gap-3 text-[11px]"
                  >
                    <span className="min-w-0 truncate text-muted-foreground">
                      {row.day}
                      {row.projectTitle ? ` · ${row.projectTitle}` : ""}
                      {row.model ? ` · ${row.model}` : ""}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground/80">
                      {formatEstimatedUsd(row.estimatedCostUsd)} ·{" "}
                      {formatContextUsageTokens(row.totalTokens)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        title="Machine-wide usage"
        headerAction={
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={machineUsageQuery.isPending || environmentId === null}
            onClick={() => machineUsageQuery.refresh()}
            aria-label="Refresh machine usage"
          >
            <RefreshCwIcon
              className={cn("size-3", machineUsageQuery.isPending && "animate-spin")}
            />
            Refresh
          </Button>
        }
      >
        {environmentId === null ? (
          <SettingsRow
            title="No environment"
            description="Connect to a server environment to load local provider history."
          />
        ) : machineUsageQuery.error ? (
          <SettingsRow title="Could not load machine usage" description={machineUsageQuery.error} />
        ) : (
          <>
            <p className="px-4 pt-3 text-xs text-muted-foreground/80 sm:px-5">
              Estimated at API list prices, so it is not what you were billed — subscription plans
              (Claude Max, ChatGPT Plus) cover this usage. Token counts include cache reads, which
              typically dominate agent sessions.
            </p>
            <HistoryWindowStrip windows={machineWindows} />
            <ProviderHistoryList summaries={machineProviderSummaries} />
          </>
        )}
      </SettingsSection>

      <SettingsSection
        title="Context by project"
        headerAction={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Switch
                checked={includeArchived}
                onCheckedChange={setIncludeArchived}
                aria-label="Include archived threads"
              />
              Archived
            </label>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={contextUsageQuery.isPending || environmentId === null}
              onClick={() => contextUsageQuery.refresh()}
              aria-label="Refresh context usage"
            >
              <RefreshCwIcon
                className={cn("size-3", contextUsageQuery.isPending && "animate-spin")}
              />
              Refresh
            </Button>
          </div>
        }
      >
        {environmentId === null ? (
          <SettingsRow
            title="No environment"
            description="Connect to a server environment to load context usage."
          />
        ) : contextUsageQuery.isPending && contextUsageQuery.data === null ? (
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                Loading context usage
              </span>
            }
            description="Reading latest context-window snapshots from disk."
          />
        ) : contextUsageQuery.error ? (
          <SettingsRow title="Could not load context usage" description={contextUsageQuery.error} />
        ) : projectGroups.length === 0 ? (
          <SettingsRow
            title="No context usage yet"
            description="Context fill appears here after threads report token usage."
          />
        ) : (
          projectGroups.map((group) => (
            <section
              key={group.projectId}
              aria-label={`Project ${group.projectTitle}`}
              className="mx-2 my-2 overflow-hidden rounded-xl border border-border/70 bg-muted/[0.16] first:mt-2 last:mb-2"
            >
              <div className="flex flex-col gap-2 border-b border-border/60 bg-muted/35 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                <div className="flex min-w-0 items-start gap-2.5">
                  <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/70 text-muted-foreground">
                    <FolderGit2Icon className="size-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-[0.11em] text-muted-foreground/65">
                      Project
                    </div>
                    <h3 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                      {group.projectTitle}
                    </h3>
                    <div className="text-[11px] text-muted-foreground/70">
                      {group.threadCount} thread{group.threadCount === 1 ? "" : "s"}
                      {" · "}
                      {formatContextUsageTokens(group.totalUsedTokens)} in context
                      {group.totalProcessedTokens > 0
                        ? ` · ${formatContextUsageTokens(group.totalProcessedTokens)} processed`
                        : ""}
                    </div>
                  </div>
                </div>
                <div className="self-end rounded-md bg-background/65 px-2 py-1 text-[11px] tabular-nums text-muted-foreground sm:self-auto">
                  Peak fill {formatFillPercent(group.maxFillPercent)}
                </div>
              </div>
              <div className="bg-card/35">
                {group.threads.map((thread) => (
                  <ThreadContextRow
                    key={thread.threadId}
                    thread={thread}
                    environmentId={environmentId}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
