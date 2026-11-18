import type { WorkspaceMemberChange } from "../../lib/api";
import type { ProjectCard, WorkspaceListItem, WorkspaceShareCategory } from "../../lib/types";

/** The arguments `applyWorkspaceChanges` takes, built here so the menu's
 *  writes can be checked without a backend. */
export interface WorkspaceChangePayload {
  workspaceId: number;
  rename: string | null;
  addMembers: WorkspaceMemberChange[];
  removeMembers: string[];
  setDisplayNames: { project_path: string; display_name: string }[];
  /** Absent on purpose: a membership write must not restate the categories it
   *  read earlier, or a category disabled in the meantime would come back on. */
  shareCategories?: WorkspaceShareCategory[];
}

export interface WorkspaceMenuTarget {
  workspace: WorkspaceListItem;
  /** The project's own workspace: shown with a check, never selectable. */
  current: boolean;
  /** Why this target cannot be picked, or null when it can. */
  disabledReason: string | null;
}

export interface ProjectWorkspaceMenu {
  /** "add" while the project is in no workspace, "move" once it is in one. */
  mode: "add" | "move";
  label: string;
  /** Set when the whole entry is unavailable (the home directory). */
  disabledReason: string | null;
  targets: WorkspaceMenuTarget[];
}

export const HOME_PROJECT_REASON =
  "Home directory projects stay isolated from workspace memory sharing.";

/** The workspace a project belongs to, found by membership rather than by the
 *  card's workspace name: two workspaces may share a name, an identity cannot
 *  be in two workspaces. */
export function currentWorkspaceOf(
  identity: string,
  workspaces: readonly WorkspaceListItem[],
): WorkspaceListItem | null {
  return (
    workspaces.find((ws) => ws.members.some((member) => member.project_path === identity)) ?? null
  );
}

/** The name the project carries into a workspace: the one the user gave it in
 *  its current workspace when moving, else the card's name. */
export function memberDisplayName(
  card: ProjectCard,
  workspaces: readonly WorkspaceListItem[],
): string {
  const current = currentWorkspaceOf(card.identity, workspaces);
  const member = current?.members.find((m) => m.project_path === card.identity);
  return member?.display_name ?? card.display_name;
}

export function projectWorkspaceMenu(
  card: ProjectCard,
  // undefined: not read yet; null: could not be read.
  workspaces: readonly WorkspaceListItem[] | null | undefined,
): ProjectWorkspaceMenu {
  const known = workspaces ?? [];
  const current = currentWorkspaceOf(card.identity, known);
  // Until the list is known, the card's own workspace name says which it is.
  const inWorkspace = workspaces ? current !== null : card.workspace_name != null;
  const mode = inWorkspace ? "move" : "add";
  const label = inWorkspace ? "Move to workspace" : "Add to workspace";
  if (card.is_home_project) {
    return { mode, label, disabledReason: HOME_PROJECT_REASON, targets: [] };
  }
  const displayName = memberDisplayName(card, known);
  const targets = known.map((workspace) => {
    if (workspace.id === current?.id) {
      return { workspace, current: true, disabledReason: "Current workspace" };
    }
    // The backend rejects two members sharing a display name; say so here
    // rather than leaving the project out of every workspace after a move.
    const clash = workspace.members.some((member) => member.display_name === displayName);
    return {
      workspace,
      current: false,
      disabledReason: clash ? `Already has a project named "${displayName}"` : null,
    };
  });
  return { mode, label, disabledReason: null, targets };
}

function memberChange(
  workspace: WorkspaceListItem,
  change: { add?: WorkspaceMemberChange; remove?: string },
): WorkspaceChangePayload {
  return {
    workspaceId: workspace.id,
    rename: null,
    addMembers: change.add ? [{ ...change.add }] : [],
    removeMembers: change.remove ? [change.remove] : [],
    setDisplayNames: [],
    // shareCategories is left out: this write only moves a membership and must
    // not restate categories read earlier, which could re-enable sharing that
    // someone turned off in another window in the meantime.
  };
}

/** What to tell the user when a move failed, the old membership could not be
 *  restored, and the refreshed list (null: could not be read) is all we know.
 *  The claim "now in none" is made only when the refreshed membership agrees:
 *  another window may have assigned the project between the leave and the join. */
export function unassignedMoveMessage(
  targetName: string,
  reason: string,
  workspaces: readonly WorkspaceListItem[] | null | undefined,
  identity: string,
): string {
  const head = `Could not move to ${targetName}: ${reason}`;
  if (!workspaces) {
    return `${head} Restoring the old workspace failed and the workspace list could not be re-read; the grid shows where the project is now.`;
  }
  const current = currentWorkspaceOf(identity, workspaces);
  if (current) return `${head} Another change has since put the project in ${current.name}.`;
  return `${head} It has left its old workspace and is now in none.`;
}

/** The writes that put `card` into `target`, in the order they must run.
 *  A project can be in one workspace at a time, so a move first leaves the
 *  current workspace; `restore` puts it back if joining the target fails. */
export function workspaceAssignmentPlan(
  card: ProjectCard,
  workspaces: readonly WorkspaceListItem[],
  target: WorkspaceListItem,
): {
  leave: WorkspaceChangePayload | null;
  join: WorkspaceChangePayload;
  restore: WorkspaceChangePayload | null;
} {
  const current = currentWorkspaceOf(card.identity, workspaces);
  const member = current?.members.find((m) => m.project_path === card.identity);
  const join = memberChange(target, {
    add: {
      project_path: card.identity,
      display_name: member?.display_name ?? card.display_name,
      // A card may carry no resolved directory; keep the path the old
      // workspace recorded rather than blanking it.
      display_path: card.primary_path || member?.display_path || "",
    },
  });
  if (!current || !member) return { leave: null, join, restore: null };
  return {
    leave: memberChange(current, { remove: card.identity }),
    join,
    restore: memberChange(current, {
      add: {
        project_path: member.project_path,
        display_name: member.display_name,
        display_path: member.display_path,
      },
    }),
  };
}
