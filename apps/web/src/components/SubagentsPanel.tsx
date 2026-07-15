import { memo } from "react";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { BotIcon, CheckIcon, CircleSlashIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { SubagentState, SubagentStatus } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";

function statusIcon(status: SubagentStatus): React.ReactNode {
  if (status === "running") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <LoaderIcon className="size-3 animate-spin" />
      </span>
    );
  }
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/10 text-success-foreground">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlertIcon className="size-3" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-muted-foreground/50">
      <CircleSlashIcon className="size-3" />
    </span>
  );
}

function formatDuration(startedAt: string, updatedAt: string): string | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatTokens(totalTokens: number): string {
  if (totalTokens < 1000) {
    return `${totalTokens}`;
  }
  return `${(totalTokens / 1000).toFixed(1)}k`;
}

interface SubagentsPanelProps {
  subagents: ReadonlyArray<SubagentState>;
  timestampFormat: TimestampFormat;
  mode?: "sheet" | "sidebar" | "embedded";
}

const SubagentsPanel = memo(function SubagentsPanel({
  subagents,
  timestampFormat,
  mode = "sidebar",
}: SubagentsPanelProps) {
  const runningCount = subagents.filter((subagent) => subagent.status === "running").length;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="info"
            size="sm"
            className="rounded-md px-1.5 py-0 font-semibold tracking-wide uppercase"
          >
            Subagents
          </Badge>
          {runningCount > 0 ? (
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
              {runningCount} running
            </span>
          ) : null}
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-3">
          {subagents.map((subagent) => {
            const duration = formatDuration(subagent.startedAt, subagent.updatedAt);
            return (
              <div
                key={subagent.taskId}
                className={cn(
                  "flex gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200",
                  subagent.status === "running" && "bg-blue-500/5",
                  subagent.status === "completed" && "bg-emerald-500/5",
                  subagent.status === "failed" && "bg-destructive/5",
                )}
              >
                {statusIcon(subagent.status)}
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <p
                      className={cn(
                        "min-w-0 flex-1 truncate text-[13px] leading-snug",
                        subagent.status === "running"
                          ? "text-foreground/90"
                          : "text-muted-foreground/70",
                      )}
                      title={subagent.description}
                    >
                      {subagent.description}
                    </p>
                    <span className="shrink-0 text-[11px] text-muted-foreground/50 tabular-nums">
                      {duration ?? formatTimestamp(subagent.startedAt, timestampFormat)}
                    </span>
                  </div>

                  {subagent.subagentType || subagent.workflowName ? (
                    <div className="flex flex-wrap items-center gap-1">
                      {subagent.workflowName ? (
                        <Badge
                          variant="secondary"
                          size="sm"
                          className="rounded px-1 py-0 text-[10px]"
                        >
                          {subagent.workflowName}
                        </Badge>
                      ) : null}
                      {subagent.subagentType ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/55">
                          <BotIcon className="size-3 shrink-0" />
                          {subagent.subagentType}
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {subagent.summary ? (
                    <p className="text-[12px] leading-relaxed text-muted-foreground/65">
                      {subagent.summary}
                    </p>
                  ) : null}

                  {subagent.lastToolName || subagent.usage ? (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground/45 tabular-nums">
                      {subagent.lastToolName ? (
                        <span className="truncate font-mono">{subagent.lastToolName}</span>
                      ) : null}
                      {subagent.usage?.toolUses !== undefined ? (
                        <span>
                          {subagent.usage.toolUses}{" "}
                          {subagent.usage.toolUses === 1 ? "tool call" : "tool calls"}
                        </span>
                      ) : null}
                      {subagent.usage?.totalTokens !== undefined ? (
                        <span>{formatTokens(subagent.usage.totalTokens)} tokens</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}

          {/* Empty state */}
          {subagents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">No subagents yet.</p>
              <p className="mt-1 text-[11px] text-muted-foreground/30">
                Subagents will appear here when the agent delegates work.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

export default SubagentsPanel;
export type { SubagentsPanelProps };
