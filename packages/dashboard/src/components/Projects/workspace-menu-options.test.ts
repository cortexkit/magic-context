import { describe, expect, test } from "bun:test";
import type { ProjectCard, WorkspaceListItem } from "../../lib/types";
import {
  currentWorkspaceOf,
  HOME_PROJECT_REASON,
  projectWorkspaceMenu,
  unassignedMoveMessage,
  workspaceAssignmentPlan,
} from "./workspace-menu-options";

function card(overrides: Partial<ProjectCard> = {}): ProjectCard {
  return {
    identity: "git:alpha",
    display_name: "alpha",
    primary_path: "/work/alpha",
    harnesses: [],
    session_count: 1,
    memory_count: 0,
    workspace_name: null,
    last_activity_ms: 0,
    is_home_project: false,
    ...overrides,
  };
}

function workspace(
  id: number,
  name: string,
  members: { project_path: string; display_name: string; display_path?: string }[] = [],
): WorkspaceListItem {
  return {
    id,
    name,
    created_at: 0,
    updated_at: 0,
    share_categories: ["ARCHITECTURE"],
    members: members.map((m) => ({
      project_path: m.project_path,
      display_name: m.display_name,
      display_path: m.display_path ?? `/work/${m.display_name}`,
      memory_count: 0,
      added_at: 0,
    })),
  };
}

describe("projectWorkspaceMenu", () => {
  test("offers Add for a project in no workspace, with every workspace pickable", () => {
    const menu = projectWorkspaceMenu(card(), [workspace(1, "one"), workspace(2, "two")]);
    expect(menu.mode).toBe("add");
    expect(menu.label).toBe("Add to workspace");
    expect(menu.disabledReason).toBeNull();
    expect(menu.targets.map((t) => [t.workspace.id, t.current, t.disabledReason])).toEqual([
      [1, false, null],
      [2, false, null],
    ]);
  });

  test("offers Move once the project has a workspace, marking that one current and unpickable", () => {
    const workspaces = [
      workspace(1, "one", [{ project_path: "git:alpha", display_name: "alpha" }]),
      workspace(2, "two"),
    ];
    const menu = projectWorkspaceMenu(card({ workspace_name: "one" }), workspaces);
    expect(menu.mode).toBe("move");
    expect(menu.label).toBe("Move to workspace");
    expect(menu.targets[0]).toMatchObject({ current: true, disabledReason: "Current workspace" });
    expect(menu.targets[1]).toMatchObject({ current: false, disabledReason: null });
  });

  test("finds the current workspace by membership when two workspaces share a name", () => {
    const workspaces = [
      workspace(1, "shared"),
      workspace(2, "shared", [{ project_path: "git:alpha", display_name: "alpha" }]),
    ];
    expect(currentWorkspaceOf("git:alpha", workspaces)?.id).toBe(2);
    const menu = projectWorkspaceMenu(card({ workspace_name: "shared" }), workspaces);
    expect(menu.targets.map((t) => t.current)).toEqual([false, true]);
  });

  test("disables the entry for the home directory and says why", () => {
    const menu = projectWorkspaceMenu(card({ is_home_project: true }), [workspace(1, "one")]);
    expect(menu.mode).toBe("add");
    expect(menu.disabledReason).toBe(HOME_PROJECT_REASON);
    expect(menu.targets).toEqual([]);
  });

  test("disables a workspace that already has a member with the project's name", () => {
    const workspaces = [
      workspace(1, "one", [{ project_path: "git:other", display_name: "alpha" }]),
      workspace(2, "two"),
    ];
    const menu = projectWorkspaceMenu(card(), workspaces);
    expect(menu.targets[0].disabledReason).toBe('Already has a project named "alpha"');
    expect(menu.targets[1].disabledReason).toBeNull();
  });

  test("checks name clashes against the name the project carries from its workspace", () => {
    const workspaces = [
      workspace(1, "one", [{ project_path: "git:alpha", display_name: "renamed" }]),
      workspace(2, "two", [{ project_path: "git:other", display_name: "renamed" }]),
      workspace(3, "three", [{ project_path: "git:beta", display_name: "alpha" }]),
    ];
    const menu = projectWorkspaceMenu(card({ workspace_name: "one" }), workspaces);
    expect(menu.targets[1].disabledReason).toBe('Already has a project named "renamed"');
    expect(menu.targets[2].disabledReason).toBeNull();
  });

  test("before the list is read, the card's workspace name picks add or move", () => {
    expect(projectWorkspaceMenu(card({ workspace_name: "one" }), undefined).mode).toBe("move");
    expect(projectWorkspaceMenu(card(), undefined).mode).toBe("add");
    expect(projectWorkspaceMenu(card({ workspace_name: "one" }), null).targets).toEqual([]);
  });
});

describe("workspaceAssignmentPlan", () => {
  test("a membership write leaves the target's share categories alone", () => {
    const target = workspace(2, "two", [{ project_path: "git:beta", display_name: "beta" }]);
    target.share_categories = ["ARCHITECTURE", "CONSTRAINTS"];
    const plan = workspaceAssignmentPlan(card(), [target], target);
    expect(plan.leave).toBeNull();
    expect(plan.restore).toBeNull();
    expect(plan.join).toEqual({
      workspaceId: 2,
      rename: null,
      addMembers: [
        { project_path: "git:alpha", display_name: "alpha", display_path: "/work/alpha" },
      ],
      removeMembers: [],
      setDisplayNames: [],
    });
    // Carrying the categories the menu read back would undo a change made in
    // another window between that read and this write, so nothing is sent.
    expect("shareCategories" in plan.join).toBe(false);
  });

  test("a move leaves the current workspace, joins the target, and can restore the old membership", () => {
    const current = workspace(1, "one", [
      { project_path: "git:alpha", display_name: "renamed", display_path: "/old/alpha" },
    ]);
    const target = workspace(2, "two");
    const plan = workspaceAssignmentPlan(
      card({ workspace_name: "one" }),
      [current, target],
      target,
    );
    expect(plan.leave).toEqual({
      workspaceId: 1,
      rename: null,
      addMembers: [],
      removeMembers: ["git:alpha"],
      setDisplayNames: [],
    });
    expect(plan.join.workspaceId).toBe(2);
    expect(plan.join.addMembers).toEqual([
      { project_path: "git:alpha", display_name: "renamed", display_path: "/work/alpha" },
    ]);
    expect(plan.restore?.workspaceId).toBe(1);
    expect(plan.restore?.addMembers).toEqual([
      { project_path: "git:alpha", display_name: "renamed", display_path: "/old/alpha" },
    ]);
  });

  test("keeps the recorded path when the card has no resolved directory", () => {
    const current = workspace(1, "one", [
      { project_path: "git:alpha", display_name: "alpha", display_path: "/old/alpha" },
    ]);
    const target = workspace(2, "two");
    const plan = workspaceAssignmentPlan(card({ primary_path: "" }), [current, target], target);
    expect(plan.join.addMembers[0].display_path).toBe("/old/alpha");
  });
});

describe("unassignedMoveMessage", () => {
  test("says the project is in none only when the refreshed list agrees", () => {
    const message = unassignedMoveMessage("two", "Locked.", [workspace(1, "one")], "git:alpha");
    expect(message).toContain("is now in none");
  });

  test("names the workspace another window put it in", () => {
    const other = workspace(3, "three", [{ project_path: "git:alpha", display_name: "alpha" }]);
    const message = unassignedMoveMessage("two", "Locked.", [other], "git:alpha");
    expect(message).toContain("put the project in three");
    expect(message).not.toContain("in none");
  });

  test("admits it does not know when the list cannot be re-read", () => {
    const message = unassignedMoveMessage("two", "Locked.", null, "git:alpha");
    expect(message).toContain("could not be re-read");
    expect(message).not.toContain("in none");
  });
});
