"use client";

import type {
  EnvironmentId,
  ImportableSession,
  ProjectId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, LoaderIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { newThreadId } from "../lib/utils";
import { cn } from "../lib/utils";
import { orchestrationEnvironment } from "../state/orchestration";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import {
  formatSessionSubtitle,
  formatWorkspaceLabel,
  groupImportableSessions,
  listSessionProviders,
  listSessionWorkspaces,
  PROVIDER_LABELS,
  resolveImportModelSelection,
} from "./ImportSessionDialog.logic";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";

type ProviderValue = ImportableSession["provider"] | typeof ALL_VALUE;

const ALL_VALUE = "__all__";

export interface ImportSessionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectName: string;
  /** Sessions run in this directory sort first. */
  readonly projectRoot: string | null;
  /** Configured provider instances, used to run the imported thread on its own provider. */
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onImported: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}

/** Shared shell for the two filter dropdowns: a trigger, a search box, and a filtered list. */
function FilterCombobox(props: {
  readonly label: string;
  readonly value: string;
  readonly triggerLabel: string;
  readonly items: ReadonlyArray<string>;
  readonly filteredItems: ReadonlyArray<string>;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onValueChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly searchPlaceholder: string;
  readonly emptyLabel: string;
  readonly renderItem: (value: string) => React.ReactNode;
}) {
  return (
    <Combobox
      items={props.items as Array<string>}
      filteredItems={props.filteredItems as Array<string>}
      value={props.value}
      onOpenChange={(open) => {
        if (!open) props.onQueryChange("");
      }}
      onValueChange={(value) => {
        if (typeof value === "string") props.onValueChange(value);
      }}
    >
      <ComboboxTrigger
        aria-label={props.label}
        disabled={props.disabled ?? false}
        className={cn(
          "inline-flex min-w-0 flex-1 items-center justify-between gap-1 rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none transition-colors",
          "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        <span className="min-w-0 truncate">{props.triggerLabel}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-72 min-w-0 max-w-[calc(100vw-2rem)]">
        <div className="min-w-0 shrink-0 px-3 pt-2.5">
          <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
            />
            <ComboboxInput
              className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:leading-6.5"
              inputClassName="rounded-none bg-transparent text-sm"
              placeholder={props.searchPlaceholder}
              showTrigger={false}
              size="sm"
              unstyled
              value={props.query}
              onChange={(event) => props.onQueryChange(event.target.value)}
            />
          </div>
        </div>
        <ComboboxEmpty>{props.emptyLabel}</ComboboxEmpty>
        <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden p-1">
          {props.items.map((item) => (
            <ComboboxItem
              key={item}
              value={item}
              className="min-w-0"
              contentClassName="w-full min-w-0 overflow-hidden"
            >
              {props.renderItem(item)}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

export function ImportSessionDialog({
  open,
  onOpenChange,
  environmentId,
  projectId,
  projectName,
  projectRoot,
  providers,
  onImported,
}: ImportSessionDialogProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<ProviderValue>(ALL_VALUE);
  const [cwd, setCwd] = useState<string>(ALL_VALUE);
  const [providerQuery, setProviderQuery] = useState("");
  const [cwdQuery, setCwdQuery] = useState("");
  const [importingSessionId, setImportingSessionId] = useState<string | null>(null);

  // Scanning the session directories is only worth doing while the picker is actually open.
  const sessionsQuery = useEnvironmentQuery(
    open ? orchestrationEnvironment.importableSessions({ environmentId, input: {} }) : null,
  );
  const sessions = useMemo(
    () => sessionsQuery.data?.sessions ?? [],
    [sessionsQuery.data?.sessions],
  );

  const importSession = useAtomCommand(orchestrationEnvironment.importSession);

  const selectedProvider = provider === ALL_VALUE ? null : provider;
  const selectedCwd = cwd === ALL_VALUE ? null : cwd;

  const providerItems = useMemo(() => [ALL_VALUE, ...listSessionProviders(sessions)], [sessions]);
  const workspaces = useMemo(
    () => listSessionWorkspaces(sessions, selectedProvider),
    [sessions, selectedProvider],
  );
  const workspaceItems = useMemo(
    () => [ALL_VALUE, ...workspaces.map((workspace) => workspace.cwd)],
    [workspaces],
  );
  const workspaceCountByCwd = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.cwd, workspace.count])),
    [workspaces],
  );

  const filterItems = useCallback(
    (items: ReadonlyArray<string>, search: string, label: (value: string) => string) => {
      const trimmed = search.trim().toLowerCase();
      if (trimmed.length === 0) return items;
      return items.filter(
        (item) => item === ALL_VALUE || label(item).toLowerCase().includes(trimmed),
      );
    },
    [],
  );

  const providerLabel = useCallback(
    (value: string) =>
      value === ALL_VALUE
        ? "All providers"
        : (PROVIDER_LABELS[value as ImportableSession["provider"]] ?? value),
    [],
  );
  const workspaceLabelFor = useCallback(
    (value: string) => (value === ALL_VALUE ? "All folders" : value),
    [],
  );

  const groups = useMemo(
    () =>
      groupImportableSessions(sessions, {
        query,
        preferredCwd: projectRoot,
        provider: selectedProvider,
        cwd: selectedCwd,
      }),
    [sessions, query, projectRoot, selectedProvider, selectedCwd],
  );

  const handleImport = useCallback(
    (session: ImportableSession) => {
      // An imported session can only be resumed by the provider that wrote it, so the thread runs
      // on that provider's instance rather than whatever the project defaults to.
      const modelSelection = resolveImportModelSelection(providers, session.provider);
      if (modelSelection === null) {
        toastManager.add({
          type: "error",
          title: "Could not import session",
          description: `${PROVIDER_LABELS[session.provider]} is not enabled, so this session cannot be resumed.`,
        });
        return;
      }

      void (async () => {
        setImportingSessionId(session.sessionId);
        const threadId = newThreadId();
        const result = await importSession({
          environmentId,
          input: {
            projectId,
            threadId,
            provider: session.provider,
            sessionId: session.sessionId,
            filePath: session.filePath,
            modelSelection,
          },
        });
        setImportingSessionId(null);

        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "Could not import session",
            description:
              result.cause instanceof Error
                ? result.cause.message
                : "The session could not be resumed.",
          });
          return;
        }

        onOpenChange(false);
        setQuery("");
        onImported(environmentId, threadId);
      })();
    },
    [environmentId, importSession, onImported, onOpenChange, projectId, providers],
  );

  // A session whose provider has no enabled instance can be listed but never resumed, so the row is
  // disabled with the reason shown rather than failing only once the user clicks it.
  const unavailableProviders = useMemo(() => {
    const unavailable = new Set<ImportableSession["provider"]>();
    for (const candidate of listSessionProviders(sessions)) {
      if (resolveImportModelSelection(providers, candidate) === null) unavailable.add(candidate);
    }
    return unavailable;
  }, [providers, sessions]);

  const isEmpty = !sessionsQuery.isPending && groups.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import a session</DialogTitle>
          <DialogDescription>
            Continue an existing Claude Code or Codex session in {projectName}. The agent keeps its
            original context.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 px-6">
          <div className="flex items-center gap-2">
            <FilterCombobox
              label="Filter by provider"
              value={provider}
              triggerLabel={providerLabel(provider)}
              items={providerItems}
              filteredItems={filterItems(providerItems, providerQuery, providerLabel)}
              query={providerQuery}
              onQueryChange={setProviderQuery}
              onValueChange={(value) => {
                setProvider(value as ProviderValue);
                // The folder list is scoped to the provider, so a stale folder would filter to nothing.
                setCwd(ALL_VALUE);
              }}
              searchPlaceholder="Search providers…"
              emptyLabel="No matching providers."
              renderItem={(value) => (
                <span className="block min-w-0 truncate">{providerLabel(value)}</span>
              )}
            />
            <FilterCombobox
              label="Filter by project folder"
              value={cwd}
              triggerLabel={cwd === ALL_VALUE ? "All folders" : formatWorkspaceLabel(cwd)}
              items={workspaceItems}
              filteredItems={filterItems(workspaceItems, cwdQuery, workspaceLabelFor)}
              query={cwdQuery}
              onQueryChange={setCwdQuery}
              onValueChange={setCwd}
              disabled={workspaces.length === 0}
              searchPlaceholder="Search folders…"
              emptyLabel="No matching folders."
              renderItem={(value) =>
                value === ALL_VALUE ? (
                  <span className="block min-w-0 truncate">All folders</span>
                ) : (
                  <span className="flex w-full min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 truncate" title={value}>
                      {formatWorkspaceLabel(value)}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground text-xs">
                      {workspaceCountByCwd.get(value) ?? 0}
                    </span>
                  </span>
                )
              }
            />
          </div>

          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              className="pl-8"
              placeholder="Search sessions by title or folder…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>

        <div className="mt-3 max-h-[24rem] min-h-0 overflow-y-auto px-6 pb-6">
          {sessionsQuery.isPending ? (
            <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-sm">
              <LoaderIcon className="size-4 animate-spin" />
              Scanning local sessions…
            </div>
          ) : isEmpty ? (
            <p className="py-10 text-center text-muted-foreground text-sm">
              {query.length > 0 || selectedProvider !== null || selectedCwd !== null
                ? "No sessions match your filters."
                : "No local sessions found."}
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.provider} className="mb-4 last:mb-0">
                <h3 className="pb-1.5 font-medium text-muted-foreground text-xs">
                  {PROVIDER_LABELS[group.provider]} ({group.sessionCount})
                  {unavailableProviders.has(group.provider) ? (
                    <span className="ps-1.5 font-normal text-muted-foreground/70">
                      — not enabled, cannot be resumed
                    </span>
                  ) : null}
                </h3>
                {group.workspaces.map((workspace) => (
                  <div key={workspace.cwd} className="mb-3 last:mb-0">
                    <p
                      className="pb-1 font-mono text-[11px] text-muted-foreground/80"
                      title={workspace.cwd}
                    >
                      {formatWorkspaceLabel(workspace.cwd)}
                    </p>
                    <ul className="flex flex-col gap-0.5">
                      {workspace.sessions.map((session) => (
                        <li key={session.sessionId}>
                          <button
                            type="button"
                            disabled={
                              importingSessionId !== null ||
                              unavailableProviders.has(session.provider)
                            }
                            onClick={() => handleImport(session)}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">
                                {session.title ?? "Untitled session"}
                              </span>
                              <span className="block text-muted-foreground text-xs">
                                {formatSessionSubtitle(session)}
                              </span>
                            </span>
                            {importingSessionId === session.sessionId ? (
                              <LoaderIcon className="size-4 shrink-0 animate-spin" />
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            ))
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
