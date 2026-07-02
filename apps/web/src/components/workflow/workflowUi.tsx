import type { ReactElement, ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  formatWorkflowDuration,
  formatWorkflowTokens,
  type WorkflowAgentStatus,
  type WorkflowRun,
  type WorkflowRunAgent,
  type WorkflowRunPhase,
  type WorkflowRunStatus,
} from "~/workflow-logic";

// ---------------------------------------------------------------------------
// Run-level status chip
// ---------------------------------------------------------------------------

interface RunStatusVisual {
  label: string;
  dotClass: string;
  textClass: string;
  pulse: boolean;
}

const RUN_STATUS_VISUALS: Record<WorkflowRunStatus, RunStatusVisual> = {
  running: { label: "Running", dotClass: "bg-info", textClass: "text-info", pulse: true },
  completed: {
    label: "Completed",
    dotClass: "bg-success",
    textClass: "text-success",
    pulse: false,
  },
  failed: {
    label: "Failed",
    dotClass: "bg-destructive",
    textClass: "text-destructive",
    pulse: false,
  },
  stopped: {
    label: "Stopped",
    dotClass: "bg-muted-foreground",
    textClass: "text-muted-foreground",
    pulse: false,
  },
};

export function WorkflowStatusChip({ status }: { status: WorkflowRunStatus }): ReactElement {
  const visual = RUN_STATUS_VISUALS[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-medium text-[11px]",
        visual.textClass,
      )}
    >
      <span className="relative flex size-1.5">
        {visual.pulse && (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-60",
              visual.dotClass,
            )}
          />
        )}
        <span className={cn("relative inline-flex size-1.5 rounded-full", visual.dotClass)} />
      </span>
      {visual.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Agent-level presentation
// ---------------------------------------------------------------------------

const AGENT_STATUS_DOT: Record<WorkflowAgentStatus, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-info animate-pulse",
  done: "bg-success",
  error: "bg-destructive",
};

export function AgentStatusDot({ status }: { status: WorkflowAgentStatus }): ReactElement {
  return <span className={cn("size-1.5 shrink-0 rounded-full", AGENT_STATUS_DOT[status])} />;
}

export function agentDisplayLabel(agent: WorkflowRunAgent): string {
  return agent.label ?? agent.agentType ?? `agent ${agent.index}`;
}

function AgentMetaBadges({ agent }: { agent: WorkflowRunAgent }): ReactElement | null {
  const badges: string[] = [];
  if (agent.cached) {
    badges.push("cached");
  }
  if (agent.attempt !== undefined && agent.attempt > 1) {
    badges.push(`retry ${agent.attempt}`);
  }
  if (badges.length === 0) {
    return null;
  }
  return (
    <>
      {badges.map((badge) => (
        <span
          key={badge}
          className="shrink-0 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground/80 leading-4"
        >
          {badge}
        </span>
      ))}
    </>
  );
}

/** "94.2k tok · 47 tools · 7m 03s" — cumulative per-agent stats from the
 * SDK snapshot. Tokens and tool counts update on every progress tick; the
 * duration is the reported total once the agent settles, and the elapsed
 * time between start and the latest tick while it runs (tick-driven, so no
 * client timer is needed). */
export function agentStatsLabel(agent: WorkflowRunAgent): string | undefined {
  const parts: string[] = [];
  if (agent.tokens !== undefined && agent.tokens > 0) {
    parts.push(`${formatWorkflowTokens(agent.tokens)} tok`);
  }
  if (agent.toolCalls !== undefined && agent.toolCalls > 0) {
    parts.push(`${agent.toolCalls} ${agent.toolCalls === 1 ? "tool" : "tools"}`);
  }
  const settled = agent.status === "done" || agent.status === "error";
  if (settled && agent.durationMs !== undefined && agent.durationMs > 0) {
    parts.push(formatWorkflowDuration(agent.durationMs));
  } else if (
    !settled &&
    agent.startedAt !== undefined &&
    agent.lastProgressAt !== undefined &&
    agent.lastProgressAt > agent.startedAt
  ) {
    parts.push(formatWorkflowDuration(agent.lastProgressAt - agent.startedAt));
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The shared inner content of an agent row. Two-line layout: the label owns
 * the first line and wraps freely (long workflow labels are common), and
 * model / stats / badges / error text sit on a muted meta line beneath —
 * nothing competes for horizontal space, so nothing clips.
 */
export function AgentRowContent({
  agent,
  leading,
}: {
  agent: WorkflowRunAgent;
  leading?: ReactNode;
}): ReactElement {
  const stats = agentStatsLabel(agent);
  // Failures often surface only in resultPreview (e.g. a thrown value the
  // runner stringified) — fall back to it so red rows always explain why.
  const errorText = agent.status === "error" ? (agent.error ?? agent.resultPreview) : undefined;
  const metaLabel = [agent.model, stats].filter((part) => part !== undefined).join(" · ");
  const hasBadges = agent.cached === true || (agent.attempt !== undefined && agent.attempt > 1);
  return (
    <div className="flex min-w-0 items-start gap-1.5 text-[12px] leading-5">
      {/* Fixed line-height boxes center the affordances on the first text line. */}
      {leading !== undefined && <span className="flex h-5 shrink-0 items-center">{leading}</span>}
      <span className="flex h-5 shrink-0 items-center">
        <AgentStatusDot status={agent.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "break-words font-medium",
            agent.status === "error" ? "text-destructive" : "text-foreground/82",
          )}
        >
          {agentDisplayLabel(agent)}
        </div>
        {(metaLabel.length > 0 || hasBadges || errorText !== undefined) && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground/60 leading-4">
            {metaLabel.length > 0 && <span className="tabular-nums">{metaLabel}</span>}
            <AgentMetaBadges agent={agent} />
            {errorText !== undefined && (
              <span className="min-w-0 break-words text-destructive/75">{errorText}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase header + rollup helpers
// ---------------------------------------------------------------------------

/**
 * Only web URLs may reach an anchor href. The server already filters the
 * scheme at ingestion; this guards payloads persisted before that filter
 * (and any other producer) as defense in depth.
 */
export function safeWorkflowSessionUrl(sessionUrl: string | undefined): string | undefined {
  if (sessionUrl === undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(sessionUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? sessionUrl : undefined;
  } catch {
    return undefined;
  }
}

/** Settled agents (done or error) — the x/y header is a progress counter,
 * and an errored agent has no work remaining. */
export function phaseDoneCount(phase: WorkflowRunPhase): number {
  return phase.agents.filter((agent) => agent.status === "done" || agent.status === "error").length;
}

export function PhaseHeader({ phase }: { phase: WorkflowRunPhase }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-2 px-0.5 pt-1.5 pb-0.5">
      <span className="truncate text-[10px] text-muted-foreground/65 uppercase tracking-[0.12em]">
        {phase.title}
      </span>
      {phase.agents.length > 0 && (
        <span className="shrink-0 text-[10px] text-muted-foreground/55 tabular-nums">
          {phaseDoneCount(phase)}/{phase.agents.length}
        </span>
      )}
    </div>
  );
}

export function agentRollupLabel(counts: WorkflowRun["agentCounts"]): string {
  return `${counts.done + counts.error}/${counts.total} agents`;
}
