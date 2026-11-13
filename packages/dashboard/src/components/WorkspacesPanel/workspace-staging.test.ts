import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkspaceListItem } from "../../lib/types";
import {
  createWorkspaceStage,
  DEFAULT_SHARE_CATEGORIES,
  toggleShareCategory,
  workspaceStageDirty,
  workspaceStageToPayload,
} from "./workspace-staging";

function workspace(overrides: Partial<WorkspaceListItem> = {}): WorkspaceListItem {
  return {
    id: 7,
    name: "team",
    created_at: 1,
    updated_at: 2,
    share_categories: DEFAULT_SHARE_CATEGORIES,
    members: [
      {
        project_path: "git:a",
        display_name: "svc-a",
        display_path: "/a",
        memory_count: 3,
        added_at: 1,
      },
    ],
    ...overrides,
  };
}

describe("workspace staged editor helpers", () => {
  it("#given a server card #then checkbox state is seeded from share_categories", () => {
    const stage = createWorkspaceStage(
      workspace({ share_categories: ["NAMING", "CONSTRAINTS", "NAMING"] }),
    );
    expect(stage.shareCategories).toEqual(["CONSTRAINTS", "NAMING"]);
  });

  it("#given a new workspace default #then constraints is checked", () => {
    expect(createWorkspaceStage(workspace()).shareCategories).toEqual(["CONSTRAINTS"]);
  });

  it("#given staged edits #then dirty, save payload, and discard reset are stable", () => {
    const ws = workspace();
    const stage = createWorkspaceStage(ws);
    expect(workspaceStageDirty(ws, stage)).toBe(false);

    stage.rename = " team-renamed ";
    stage.addMembers.push({ project_path: "git:b", display_name: "svc-b", display_path: "/b" });
    stage.removeMembers.push("git:a");
    stage.shareCategories = toggleShareCategory(stage.shareCategories, "NAMING");

    expect(workspaceStageDirty(ws, stage)).toBe(true);
    expect(workspaceStageToPayload(ws, stage)).toEqual({
      workspaceId: 7,
      rename: "team-renamed",
      addMembers: [{ project_path: "git:b", display_name: "svc-b", display_path: "/b" }],
      removeMembers: ["git:a"],
      setDisplayNames: [],
      shareCategories: ["CONSTRAINTS", "NAMING"],
    });
    expect(workspaceStageDirty(ws, createWorkspaceStage(ws))).toBe(false);
  });

  it("#given only members changed #then the save does not speak for share categories", () => {
    const ws = workspace({ share_categories: ["NAMING"] });
    const stage = createWorkspaceStage(ws);
    stage.addMembers.push({ project_path: "git:b", display_name: "svc-b", display_path: "/b" });

    const payload = workspaceStageToPayload(ws, stage);
    expect(workspaceStageDirty(ws, stage)).toBe(true);
    expect("shareCategories" in payload).toBe(false);
  });

  it("#given the panel source #then member rows use Index rather than For", () => {
    const source = readFileSync(resolve(import.meta.dir, "./WorkspacesPanel.tsx"), "utf-8");
    expect(source).toContain("<Index each={stagedMemberRows");
    expect(source).not.toContain("<For");
  });
});
