#!/usr/bin/env bun
/** Generate ck-mc workspace trim/render vectors using the plugin's own pool and renderer.
 * Run from the repository root: bun packages/plugin/scripts/generate-workspace-memory-vectors.ts
 * Add --check to verify the checked-in JSON without rewriting it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkspaceRenderContext } from "../src/hooks/magic-context/inject-compartments";

const root = resolve(import.meta.dir, "../../..");
const home = resolve(root, "target/scratch/workspace-memory-generator");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = resolve(home, "config");
process.env.XDG_DATA_HOME = resolve(home, "data");
const { Database } = await import("../src/shared/sqlite");
const { getMemoriesByProjects } = await import("../src/features/magic-context/memory/storage-memory");
const { trimWorkspaceMemoriesToBudgetV2, renderMemoryBlockV2 } = await import(
    "../src/hooks/magic-context/inject-compartments"
);
const { resolveWorkspaceIdentitySet, expandWorkspaceIdentitySetWithAliases,
    resolveWorkspaceShareCategories, sourceNameForMemory } = await import(
    "../src/features/magic-context/workspaces"
);

const db = new Database(":memory:");
db.exec(readFileSync(resolve(root, "crates/mc-module/testdata/context-schema.sql"), "utf8")
    .replaceAll(":applied_at", "0"));
db.exec(`INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(1,'Example',0,0);
INSERT INTO workspace_members VALUES(1,'pj-a','Alpha','/a',0),(1,'pj-b','Beta & Co','/b',0),(1,'pj-c','Gamma','/c',0);`);
const inputs = [
    [1, "pj-a", "PROJECT_RULES", "Keep permanent rules.", 1, "permanent"],
    [2, "pj-b", "CONSTRAINTS", "Permanent foreign constraint.", 2, "permanent"],
    [3, "pj-a", "CONSTRAINTS", "Alpha's high priority constraint.", 100, "active"],
    [4, "pj-a", "CONSTRAINTS", "Alpha's second high priority constraint.", 99, "active"],
    [5, "pj-a", "CONSTRAINTS", "Alpha exceeds its member floor with another constraint.", 98, "active"],
    [6, "pj-b", "CONSTRAINTS", "Beta requires <review> & approval.\nNo exceptions.", 20, "active"],
    [7, "pj-c", "CONSTRAINTS", "Gamma's low priority constraint.", 10, "active"],
    [8, "pj-c", "NAMING", "Category miss must never render.", 100, "permanent"],
];
const insert = db.prepare(`INSERT INTO memories(id,project_path,category,content,importance,status,
    normalized_hash,shareable,scope,first_seen_at,created_at,updated_at,last_seen_at)
    VALUES(?,?,?,?,?,?,?,1,'project',0,0,0,0)`);
for (const [id, project, category, content, importance, status] of inputs) {
    insert.run(id, project, category, content, importance, status, `hash-${id}`);
}
const identitySet = resolveWorkspaceIdentitySet(db, "pj-a");
const expanded = expandWorkspaceIdentitySetWithAliases(db, identitySet.identities);
const workspace: WorkspaceRenderContext = {
    identities: identitySet.identities,
    expandedIdentities: expanded.expandedIdentities,
    ownIdentities: ["pj-a"],
    shareCategories: resolveWorkspaceShareCategories(db, "pj-a"),
    namesByIdentity: identitySet.namesByIdentity,
    canonicalIdentityByStoredPath: expanded.canonicalIdentityByStoredPath,
    isWorkspaced: true,
};
const memories = getMemoriesByProjects(db, workspace.expandedIdentities,
    ["active", "permanent"], 1, workspace.ownIdentities, workspace.shareCategories);
const sourceNameByMemoryId = new Map<number, string>();
for (const memory of memories) {
    const name = sourceNameForMemory(memory.projectPath, "pj-a", workspace.identities,
        workspace.namesByIdentity, workspace.canonicalIdentityByStoredPath);
    if (name) sourceNameByMemoryId.set(memory.id, name);
}
const options = { sourceNameByMemoryId };
const vectors = [60, 110, 150, 220, 1000].map((budget) => {
    const trimmed = trimWorkspaceMemoriesToBudgetV2("workspace-vectors", memories, budget, workspace, options);
    return { budget, selected: trimmed.selected.map((memory) => memory.id),
        rendered: renderMemoryBlockV2(trimmed.renderOrder, "project-memory", options) };
});
const output = `${JSON.stringify({ inputs, pool: memories.map((memory) => memory.id), vectors }, null, 2)}\n`;
const path = resolve(root, "crates/mc-module/testdata/workspace-memory-vectors.json");
if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== output) throw new Error("workspace memory vectors drifted; regenerate");
} else {
    writeFileSync(path, output);
}
db.close();
console.log(`Workspace memory vectors: ${vectors.length} budgets, ${memories.length} eligible memories, passed.`);
