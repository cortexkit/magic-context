import type {
  ProjectRow,
  WorkspaceListItem,
  WorkspaceMemberView,
  WorkspaceShareCategory,
} from "../../lib/types";

export const SHARE_CATEGORY_OPTIONS: { value: WorkspaceShareCategory; label: string }[] = [
  { value: "PROJECT_RULES", label: "Project rules" },
  { value: "ARCHITECTURE", label: "Architecture" },
  { value: "CONSTRAINTS", label: "Constraints" },
  { value: "CONFIG_VALUES", label: "Config values" },
  { value: "NAMING", label: "Naming" },
];

export const DEFAULT_SHARE_CATEGORIES: WorkspaceShareCategory[] = ["CONSTRAINTS"];

const SHARE_CATEGORY_ORDER = SHARE_CATEGORY_OPTIONS.map((option) => option.value);

export interface WorkspaceStageAddMember {
  project_path: string;
  display_name: string;
  display_path: string;
}

export interface WorkspaceStage {
  rename: string;
  addMembers: WorkspaceStageAddMember[];
  removeMembers: string[];
  setNames: Record<string, string>;
  shareCategories: WorkspaceShareCategory[];
  /** True only when the user has explicitly toggled at least one category checkbox.
   * Used to decide whether this save "speaks for" the sharing config.
   * We never infer intent from a comparison to the live workspace — after a refetch
   * the live value may have changed from another window, and sending the stale
   * snapshot would re-enable a category the other window just turned off. */
  categoriesEdited: boolean;
}

export interface StagedWorkspaceMemberRow extends WorkspaceMemberView {
  pending: boolean;
  removed: boolean;
}

export function normalizeShareCategories(
  categories: readonly WorkspaceShareCategory[],
): WorkspaceShareCategory[] {
  const selected = new Set(categories);
  return SHARE_CATEGORY_ORDER.filter((category) => selected.has(category));
}

export function createWorkspaceStage(workspace: WorkspaceListItem): WorkspaceStage {
  return {
    rename: workspace.name,
    addMembers: [],
    removeMembers: [],
    setNames: {},
    shareCategories: normalizeShareCategories(workspace.share_categories),
    categoriesEdited: false,
  };
}

export function toggleShareCategory(
  categories: readonly WorkspaceShareCategory[],
  category: WorkspaceShareCategory,
): WorkspaceShareCategory[] {
  const selected = new Set(categories);
  if (selected.has(category)) selected.delete(category);
  else selected.add(category);
  return normalizeShareCategories([...selected]);
}

export function stagedMemberRows(
  workspace: WorkspaceListItem,
  stage: WorkspaceStage,
): StagedWorkspaceMemberRow[] {
  const removed = new Set(stage.removeMembers);
  const rows: StagedWorkspaceMemberRow[] = workspace.members.map((member) => ({
    ...member,
    display_name: stage.setNames[member.project_path] ?? member.display_name,
    pending: false,
    removed: removed.has(member.project_path),
  }));
  rows.push(
    ...stage.addMembers.map((member) => ({
      project_path: member.project_path,
      display_name: member.display_name,
      display_path: member.display_path,
      memory_count: 0,
      added_at: 0,
      pending: true,
      removed: false,
    })),
  );
  return rows;
}

export function finalMemberCount(workspace: WorkspaceListItem, stage: WorkspaceStage): number {
  const removed = new Set(stage.removeMembers);
  return (
    workspace.members.filter((member) => !removed.has(member.project_path)).length +
    stage.addMembers.length
  );
}

export function categorySummary(categories: readonly WorkspaceShareCategory[]): string {
  const normalized = normalizeShareCategories(categories);
  if (normalized.length === 0) return "none";
  return normalized.join(", ");
}

function effectiveDisplayNameChanges(workspace: WorkspaceListItem, stage: WorkspaceStage) {
  const removed = new Set(stage.removeMembers);
  return Object.entries(stage.setNames)
    .map(([project_path, display_name]) => ({ project_path, display_name: display_name.trim() }))
    .filter(({ project_path, display_name }) => {
      if (removed.has(project_path) || !display_name) return false;
      const current = workspace.members.find((member) => member.project_path === project_path);
      return current !== undefined && current.display_name !== display_name;
    });
}

export function workspaceStageDirty(workspace: WorkspaceListItem, stage: WorkspaceStage): boolean {
  if (stage.rename.trim() !== workspace.name) return true;
  if (stage.addMembers.length > 0) return true;
  if (stage.removeMembers.length > 0) return true;
  if (effectiveDisplayNameChanges(workspace, stage).length > 0) return true;
  return stage.categoriesEdited;
}

export function workspaceStageToPayload(workspace: WorkspaceListItem, stage: WorkspaceStage) {
  const rename = stage.rename.trim();
  return {
    workspaceId: workspace.id,
    rename: rename !== workspace.name ? rename : null,
    addMembers: stage.addMembers.map((member) => ({ ...member })),
    removeMembers: [...stage.removeMembers],
    setDisplayNames: effectiveDisplayNameChanges(workspace, stage),
    // Only a save where the user explicitly toggled a checkbox speaks for the
    // sharing config.  We do not compare against the live workspace: after a
    // refetch the workspace value may have been changed from another window, and
    // sending the stale snapshot would re-enable a category that was just turned
    // off.  categoriesEdited is set to true only by the UI toggle handler.
    ...(stage.categoriesEdited
      ? { shareCategories: normalizeShareCategories(stage.shareCategories) }
      : {}),
  };
}

export function availableProjectsForWorkspace(
  workspace: WorkspaceListItem,
  projects: readonly ProjectRow[],
  stage: WorkspaceStage,
): ProjectRow[] {
  const unavailable = new Set(workspace.members.map((member) => member.project_path));
  for (const member of stage.addMembers) unavailable.add(member.project_path);
  return projects.filter((project) => !unavailable.has(project.identity));
}
