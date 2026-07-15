import type { McpHealth, McpServerEntry, McpTransport } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  LoaderIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  groupMcpServers,
  mcpMatchesQuery,
  mcpServerKey,
  mcpTargetLabel,
  parseKeyValueLines,
  MCP_HEALTH_LABEL,
} from "./SkillsSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Manage the MCP servers this machine's Claude connects to.
 *
 * Reads come from `.claude.json`; writes go through the `claude mcp` CLI so we
 * never rewrite a config file we don't own. Secret material (bearer tokens in
 * `headers`, values in `env`) is stripped server-side — only key NAMES arrive.
 */
export function McpSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  const mcpQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.mcpServers({ environmentId, input: {} }),
  );

  const removeServer = useAtomCommand(serverEnvironment.removeMcpServer, {
    reportFailure: false,
  });

  const servers = mcpQuery.data?.servers ?? [];
  const cliAvailable = mcpQuery.data?.cliAvailable ?? false;

  const groups = useMemo(
    () => groupMcpServers(servers.filter((server) => mcpMatchesQuery(server, query))),
    [servers, query],
  );

  const handleRemove = useCallback(
    async (server: McpServerEntry) => {
      if (environmentId === null) return;

      const result = await removeServer({
        environmentId,
        input: {
          name: server.name,
          ...(server.scope !== undefined ? { scope: server.scope } : {}),
        },
      });

      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not remove ${server.name}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return;
      }

      toastManager.add({ type: "success", title: `Removed ${server.name}` });
      mcpQuery.refresh();
    },
    [environmentId, removeServer, mcpQuery],
  );

  const totalLabel =
    servers.length === 1 ? "1 server configured" : `${servers.length} servers configured`;

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="MCP"
        icon={<PlugIcon className="size-3.5" />}
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh MCP servers"
            onClick={mcpQuery.refresh}
          >
            {mcpQuery.isPending ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3" />
            )}
          </Button>
        }
      >
        <SettingsRow
          title={totalLabel}
          description={mcpQuery.data?.sourcePath ?? "MCP servers configured for Claude."}
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <div className="relative w-full sm:w-56">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search servers…"
                  className="h-8 pl-8 text-xs"
                  aria-label="Search MCP servers"
                />
              </div>
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <PlusIcon className="size-3.5" />
                Add
              </Button>
            </div>
          }
        />

        {mcpQuery.error !== null ? (
          <SettingsRow title="Could not read MCP config" description={mcpQuery.error} />
        ) : null}

        {mcpQuery.data !== null && !cliAvailable ? (
          <SettingsRow
            title="Claude CLI unavailable"
            description="Connection status can't be checked and servers can't be added or removed. Set the Claude binary path in Providers."
          />
        ) : null}

        {mcpQuery.error === null && servers.length === 0 && !mcpQuery.isPending ? (
          <SettingsRow
            title="No MCP servers"
            description="Add a server to connect Claude to external tools and data."
          />
        ) : null}
      </SettingsSection>

      {groups.map((group) => (
        <SettingsSection
          key={group.key}
          title={group.label}
          headerAction={
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {group.servers.length}
            </span>
          }
        >
          {group.servers.map((server) => (
            // Key on scope+project+name: the same server name legitimately
            // appears in more than one project.
            <SettingsRow
              key={mcpServerKey(server)}
              title={
                <span className="flex items-center gap-2">
                  {server.name}
                  <span className="rounded border px-1 py-px text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                    {server.transport}
                  </span>
                </span>
              }
              description={
                <span className="truncate font-mono text-[11px]">{mcpTargetLabel(server)}</span>
              }
              status={<McpStatus server={server} />}
              control={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${server.name}`}
                  disabled={!cliAvailable}
                  onClick={() => void handleRemove(server)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              }
            />
          ))}
        </SettingsSection>
      ))}

      <AddMcpServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        environmentId={environmentId}
        onAdded={mcpQuery.refresh}
      />
    </SettingsPageContainer>
  );
}

const HEALTH_TONE: Record<McpHealth, string> = {
  connected: "text-emerald-600 dark:text-emerald-400",
  needs_auth: "text-amber-600 dark:text-amber-400",
  failed: "text-destructive",
  pending: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

function McpStatus({ server }: { server: McpServerEntry }) {
  const secrets = [
    ...(server.headerKeys ?? []).map((key) => `header ${key}`),
    ...(server.envKeys ?? []).map((key) => `env ${key}`),
  ];

  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {server.health !== undefined ? (
        <span className={cn("flex items-center gap-1", HEALTH_TONE[server.health])}>
          {server.health === "connected" ? (
            <CircleCheckIcon className="size-3" />
          ) : server.health === "needs_auth" || server.health === "failed" ? (
            <CircleAlertIcon className="size-3" />
          ) : (
            <CircleDashedIcon className="size-3" />
          )}
          {MCP_HEALTH_LABEL[server.health]}
        </span>
      ) : null}

      {server.health === "needs_auth" ? (
        // t3code can't run the OAuth browser flow from a settings panel, so
        // point at the one place that can rather than pretending otherwise.
        <span className="text-muted-foreground">Run /mcp in a Claude session to authorize.</span>
      ) : null}

      {secrets.length > 0 ? (
        <span className="text-muted-foreground/70">Configured: {secrets.join(", ")}</span>
      ) : null}
    </span>
  );
}

const TRANSPORTS: ReadonlyArray<McpTransport> = ["stdio", "http", "sse"];

function AddMcpServerDialog({
  open,
  onOpenChange,
  environmentId,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: ReturnType<typeof usePrimaryEnvironmentId>;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("http");
  const [target, setTarget] = useState("");
  const [extra, setExtra] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const addServer = useAtomCommand(serverEnvironment.addMcpServer, { reportFailure: false });

  const isStdio = transport === "stdio";

  const reset = useCallback(() => {
    setName("");
    setTransport("http");
    setTarget("");
    setExtra("");
  }, []);

  const handleSubmit = useCallback(async () => {
    if (environmentId === null || name.trim().length === 0 || target.trim().length === 0) return;

    setSubmitting(true);
    try {
      // stdio: the target is a command, and everything after the first token is
      // an argument. http/sse: the target is a URL.
      const [command = "", ...args] = target.trim().split(/\s+/);

      const result = await addServer({
        environmentId,
        input: {
          name: name.trim(),
          transport,
          // `user` scope = available in every project, which is what a settings
          // screen should default to (the CLI itself defaults to `local`).
          scope: "user",
          target: isStdio ? command : target.trim(),
          ...(isStdio && args.length > 0 ? { args } : {}),
          ...(isStdio
            ? { env: parseKeyValueLines(extra, "=") }
            : { headers: parseKeyValueLines(extra, ": ") }),
        },
      });

      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not add ${name.trim()}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return;
      }

      toastManager.add({ type: "success", title: `Added ${name.trim()}` });
      reset();
      onOpenChange(false);
      onAdded();
    } finally {
      setSubmitting(false);
    }
  }, [
    addServer,
    environmentId,
    extra,
    isStdio,
    name,
    onAdded,
    onOpenChange,
    reset,
    target,
    transport,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        {/* DialogPopup has no padding of its own — it comes from
            DialogHeader/DialogFooter, with the body supplying its own. */}
        <DialogHeader>
          <DialogTitle>Add MCP server</DialogTitle>
          <DialogDescription>Connect Claude to an external tool or data source.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-6 pb-2">
          <div className="space-y-1.5">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-server"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Transport</Label>
            <div className="flex gap-1.5">
              {TRANSPORTS.map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant={transport === option ? "default" : "outline"}
                  onClick={() => setTransport(option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-target">{isStdio ? "Command" : "URL"}</Label>
            <Input
              id="mcp-target"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={isStdio ? "npx my-mcp-server" : "https://mcp.example.com/mcp"}
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-extra">
              {isStdio ? "Environment variables" : "Headers"}
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="mcp-extra"
              value={extra}
              onChange={(event) => setExtra(event.target.value)}
              placeholder={isStdio ? "API_KEY=xxx" : "Authorization: Bearer xxx"}
              rows={3}
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">One per line.</p>
          </div>

          {!isStdio ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-muted-foreground">
              Servers that use OAuth can't be authorized from here. After adding, run{" "}
              <code className="font-mono">/mcp</code> in a Claude session to sign in.
            </p>
          ) : null}
        </div>

        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={submitting || name.trim().length === 0 || target.trim().length === 0}
          >
            {submitting ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            Add server
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
