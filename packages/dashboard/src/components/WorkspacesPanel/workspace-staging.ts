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
  const currentCategories = normalizeShareCategories(workspace.share_categories);
  const stagedCategories = normalizeShareCategories(stage.shareCategories);
  return currentCategories.join("\u0000") !== stagedCategories.join("\u0000");
}

export function workspaceStageToPayload(workspace: WorkspaceListItem, stage: WorkspaceStage) {
  const rename = stage.rename.trim();
  const categoriesDirty =
    normalizeShareCategories(stage.shareCategories).join("\u0000") !==
    normalizeShareCategories(workspace.share_categories).join("\u0000");
  return {
    workspaceId: workspace.id,
    rename: rename !== workspace.name ? rename : null,
    addMembers: stage.addMembers.map((member) => ({ ...member })),
    removeMembers: [...stage.removeMembers],
    setDisplayNames: effectiveDisplayNameChanges(workspace, stage),
    // Only a save that actually edits the categories speaks for them: sending
    // the snapshot read when the panel opened would turn a category another
    // window disabled in the meantime back on.
    ...(categoriesDirty
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
