import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { ChevronsUpDownIcon, LayersIcon } from "lucide-react";
import { useMemo } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

// Sentinel radio value for "All projects" — the menu radio group needs a
// non-null string, so null <-> this token at the boundary.
const ALL_SPACES_VALUE = "__all__";

/** Distinct, sorted space labels across all projects (labels are global). */
export function deriveSpaceLabels(
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyArray<string> {
  const labels = new Set<string>();
  for (const project of projects) {
    if (project.space !== null) {
      labels.add(project.space);
    }
  }
  return [...labels].sort((left, right) => left.localeCompare(right));
}

/**
 * Header control that selects the active Space. The selection lives in the
 * primary server's settings, so it follows the user across devices connected
 * to that server. Selecting a space filters the sidebar to projects carrying
 * that label; "All projects" clears the filter. A set-but-stale label (no
 * current project carries it) renders and behaves as "All projects" — see
 * SidebarV2 for the matching filter rule.
 */
export function SpaceSwitcher({ className }: { className?: string }) {
  const projects = useProjects();
  const activeSpace = usePrimarySettings((settings) => settings.activeSpace);
  const updateSettings = useUpdatePrimarySettings();

  const spaceLabels = useMemo(() => deriveSpaceLabels(projects), [projects]);

  // Stale or unset selection collapses to "All projects".
  const effectiveSpace =
    activeSpace !== null && spaceLabels.includes(activeSpace) ? activeSpace : null;
  const triggerLabel = effectiveSpace ?? "All projects";

  return (
    <Menu>
      <MenuTrigger
        aria-label="Switch space"
        className={cn(
          "flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground outline-hidden ring-ring transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2",
          className,
        )}
      >
        <LayersIcon className="size-3.5 shrink-0" />
        <span className="truncate text-xs font-medium">{triggerLabel}</span>
        <ChevronsUpDownIcon className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="min-w-44">
        <MenuRadioGroup
          value={effectiveSpace ?? ALL_SPACES_VALUE}
          onValueChange={(value) => {
            updateSettings({ activeSpace: value === ALL_SPACES_VALUE ? null : (value as string) });
          }}
        >
          <MenuRadioItem value={ALL_SPACES_VALUE} className="min-h-7 py-1 sm:text-xs">
            All projects
          </MenuRadioItem>
          {spaceLabels.map((label) => (
            <MenuRadioItem key={label} value={label} className="min-h-7 py-1 sm:text-xs">
              {label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
