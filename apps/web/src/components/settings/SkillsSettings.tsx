import type { SkillEntry } from "@t3tools/contracts";
import {
  LoaderIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import ChatMarkdown from "../ChatMarkdown";
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
import { toastManager } from "../ui/toast";
import { useAtomCommand } from "../../state/use-atom-command";
import { groupSkills, skillMatchesQuery, stripFrontmatter } from "./SkillsSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Read-only browser for the Agent Skills installed on this machine.
 *
 * Claude has no `skills/list` RPC (unlike Codex), so the server reads
 * `~/.claude/skills` and the plugin tree off disk. Rows are keyed by `path`,
 * never by `name`: skill names genuinely collide across plugins.
 */
export function SkillsSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SkillEntry | null>(null);

  const skillsQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.skills({ environmentId, input: {} }),
  );

  const skills = skillsQuery.data?.skills ?? [];
  const groups = useMemo(
    () => groupSkills(skills.filter((skill) => skillMatchesQuery(skill, query))),
    [skills, query],
  );

  const totalLabel =
    skills.length === 1 ? "1 skill installed" : `${skills.length} skills installed`;

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Skills"
        icon={<SparklesIcon className="size-3.5" />}
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh skills"
            onClick={skillsQuery.refresh}
          >
            {skillsQuery.isPending ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3" />
            )}
          </Button>
        }
      >
        <SettingsRow
          title={totalLabel}
          description={skillsQuery.data?.sourcePath ?? "Skills discovered on this machine."}
          control={
            <div className="relative w-full sm:w-64">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search skills…"
                className="h-8 pl-8 text-xs"
                aria-label="Search skills"
              />
            </div>
          }
        />

        {skillsQuery.error !== null ? (
          <SettingsRow title="Could not read skills" description={skillsQuery.error} />
        ) : null}

        {skillsQuery.error === null && skills.length === 0 && !skillsQuery.isPending ? (
          <SettingsRow
            title="No skills found"
            description="Install a skill into ~/.claude/skills, or add a plugin that ships skills."
          />
        ) : null}

        {skillsQuery.error === null && skills.length > 0 && groups.length === 0 ? (
          <SettingsRow title="No matches" description={`Nothing matches “${query}”.`} />
        ) : null}
      </SettingsSection>

      {groups.map((group) => (
        <SettingsSection
          key={group.key}
          title={group.label}
          icon={group.key.startsWith("plugin:") ? <PuzzleIcon className="size-3.5" /> : undefined}
          headerAction={
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {group.skills.length}
            </span>
          }
        >
          {group.skills.map((skill) => (
            // Key on `path`: names collide (three distinct `access` skills ship
            // across the official plugins).
            <SettingsRow
              key={skill.path}
              title={formatProviderSkillDisplayName(skill)}
              description={skill.description ?? "No description provided."}
              control={
                <Button size="sm" variant="outline" onClick={() => setSelected(skill)}>
                  View
                </Button>
              }
            />
          ))}
        </SettingsSection>
      ))}

      <SkillDetailDialog
        skill={selected}
        onClose={() => setSelected(null)}
        onDeleted={skillsQuery.refresh}
        environmentId={environmentId}
      />
    </SettingsPageContainer>
  );
}

function SkillDetailDialog({
  skill,
  onClose,
  onDeleted,
  environmentId,
}: {
  skill: SkillEntry | null;
  onClose: () => void;
  onDeleted: () => void;
  environmentId: ReturnType<typeof usePrimaryEnvironmentId>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState<SkillEntry | null>(null);

  const deleteSkill = useAtomCommand(serverEnvironment.deleteSkill, { reportFailure: false });

  const detailQuery = useEnvironmentQuery(
    skill === null || environmentId === null
      ? null
      : serverEnvironment.skillDetail({ environmentId, input: { path: skill.path } }),
  );

  // Deleting removes the skill's directory from disk and cannot be undone, so
  // it goes through an explicit confirm rather than firing on first click.
  const handleDelete = useCallback((target: SkillEntry) => {
    setConfirming(target);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (confirming === null || environmentId === null) return;

    setDeleting(true);
    try {
      const result = await deleteSkill({
        environmentId,
        input: { path: confirming.path },
      });

      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not delete ${confirming.name}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return;
      }

      toastManager.add({ type: "success", title: `Deleted ${confirming.name}` });
      setConfirming(null);
      onClose();
      onDeleted();
    } finally {
      setDeleting(false);
    }
  }, [confirming, deleteSkill, environmentId, onClose, onDeleted]);

  const body = useMemo(
    () => (detailQuery.data === null ? "" : stripFrontmatter(detailQuery.data.content)),
    [detailQuery.data],
  );

  // Strip the trailing `/SKILL.md` to get the skill's directory.
  const skillDirectory = useMemo(
    () => (skill === null ? "" : skill.path.replace(/[/\\]SKILL\.md$/, "")),
    [skill],
  );

  return (
    <Dialog open={skill !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-3xl">
        {skill === null ? null : (
          <>
            {/* Padding comes from DialogHeader/DialogFooter — DialogPopup has none. */}
            <DialogHeader>
              <DialogTitle>{formatProviderSkillDisplayName(skill)}</DialogTitle>
              <DialogDescription>
                {skill.description ?? "No description provided."}
              </DialogDescription>
              <p className="truncate font-mono text-[11px] text-muted-foreground/70">
                {skill.path}
              </p>
            </DialogHeader>

            <div className="px-6">
              <div className="max-h-[55vh] overflow-y-auto rounded-lg border bg-muted/30 p-4">
                {detailQuery.isPending ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <LoaderIcon className="size-3 animate-spin" />
                    Loading skill…
                  </div>
                ) : detailQuery.error !== null ? (
                  <p className="text-xs text-destructive">{detailQuery.error}</p>
                ) : (
                  // `cwd` is the skill's own directory so relative links inside
                  // SKILL.md (e.g. `references/palette.md`) resolve correctly.
                  <ChatMarkdown text={body} cwd={skillDirectory} />
                )}
              </div>
            </div>

            <DialogFooter variant="bare">
              {skill.scope === "personal" ? (
                <Button
                  variant="destructive"
                  disabled={deleting}
                  onClick={() => void handleDelete(skill)}
                  className="sm:mr-auto"
                >
                  {deleting ? (
                    <LoaderIcon className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2Icon className="size-3.5" />
                  )}
                  Delete skill
                </Button>
              ) : (
                // Plugin skills live under the plugin manager's tree; deleting
                // one here would be undone on the next sync.
                <span className="text-[11px] text-muted-foreground sm:mr-auto">
                  Remove this by uninstalling the {skill.pluginName ?? "plugin"} plugin.
                </span>
              )}
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>

            <Dialog
              open={confirming !== null}
              onOpenChange={(open) => (open ? undefined : setConfirming(null))}
            >
              <DialogPopup className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Delete {confirming?.name}?</DialogTitle>
                  <DialogDescription>
                    This permanently removes the skill's folder from disk. It can't be undone.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter variant="bare">
                  <Button variant="outline" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={deleting}
                    onClick={() => void confirmDelete()}
                  >
                    {deleting ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
                    Delete
                  </Button>
                </DialogFooter>
              </DialogPopup>
            </Dialog>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
