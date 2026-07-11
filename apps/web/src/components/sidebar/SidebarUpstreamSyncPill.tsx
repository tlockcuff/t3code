import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { GitBranchIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { primaryServerUpstreamSyncAtom } from "../../state/server";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  formatUpstreamSyncBadgeDescription,
  formatUpstreamSyncBadgeTitle,
  shouldShowUpstreamSyncBadge,
} from "./SidebarUpstreamSync.logic";

export function SidebarUpstreamSyncPill() {
  const navigate = useNavigate();
  const state = useAtomValue(primaryServerUpstreamSyncAtom);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const visible = shouldShowUpstreamSyncBadge(state);
  const badgeKey =
    state && visible
      ? `${state.status}:${state.behindBy}:${state.aheadBy}:${state.upstreamSha ?? ""}`
      : null;
  const dismissed = badgeKey !== null && dismissedKey === badgeKey;

  const handleOpenSettings = useCallback(() => {
    void navigate({ to: "/settings/general" });
  }, [navigate]);

  const handleCopyCommand = useCallback(() => {
    const command = state?.suggestedCommand;
    if (!command || typeof navigator === "undefined" || !navigator.clipboard) {
      handleOpenSettings();
      return;
    }
    void navigator.clipboard.writeText(command).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Merge command copied",
          description: command,
        });
      },
      () => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not copy merge command",
            description: command,
          }),
        );
      },
    );
  }, [handleOpenSettings, state?.suggestedCommand]);

  if (!state || !visible || dismissed || !badgeKey) {
    return null;
  }

  const title = formatUpstreamSyncBadgeTitle(state);
  const description = formatUpstreamSyncBadgeDescription(state);

  return (
    <div className="group/upstream-sync relative flex h-7 w-full items-center rounded-lg bg-primary/15 text-xs font-medium text-primary">
      <div className="pointer-events-none absolute inset-0 rounded-lg transition-colors group-has-[button.upstream-sync-main:hover]/upstream-sync:bg-primary/22" />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={description}
              className="upstream-sync-main relative flex h-full flex-1 items-center gap-2 px-2 text-left enabled:cursor-pointer"
              onClick={handleCopyCommand}
            >
              <GitBranchIcon className="size-3.5" />
              <span>{title}</span>
            </button>
          }
        />
        <TooltipPopup side="top">{description}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Dismiss upstream sync notice"
              className="mr-1 inline-flex size-5 items-center justify-center rounded-md text-primary/60 transition-colors hover:text-primary"
              onClick={() => setDismissedKey(badgeKey)}
            >
              <XIcon className="size-3.5" />
            </button>
          }
        />
        <TooltipPopup side="top">Dismiss until upstream status changes</TooltipPopup>
      </Tooltip>
    </div>
  );
}
