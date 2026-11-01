import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { loadPluginConfig } from "@magic-context/core/config";
import {
    type EntorhinalResolveResult,
    resolveEntorhinalProject,
} from "@magic-context/core/features/magic-context/memory/entorhinal-resolve";
import { readGitCheckoutMetadata } from "@magic-context/core/features/magic-context/memory/git-common-dir";
import { isPinnedProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity-cache";
import {
    auditIdentityMerge,
    mergeProjectIdentities,
} from "@magic-context/core/features/magic-context/storage-identity-merge";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { resolveOpenCodeDbPath } from "@magic-context/core/shared/opencode-db-path";
import type { Database } from "@magic-context/core/shared/sqlite";
import { writeStorageFileAtomicSync } from "@magic-context/core/shared/storage-permissions";
import {
    CLI_SCHEMA_FLOOR_VERSION,
    getPersistedSchemaVersion,
    openExistingContextDatabase,
} from "../lib/database-access";
import { observations } from "./doctor-merge-identity";
import { type ProjectIdsApplyDeps, runProjectIdsApplyCli } from "./doctor-project-ids-apply";

export interface ProjectIdPlanFolder {
    directory: string;
    exists: boolean;
    gitCommonDir: string | null;
    worktree: boolean;
}

export interface ProjectIdPlanPair {
    from: string;
    to: string;
    rowsByTable: Record<string, number>;
    // Apply may pin these folders; unmatched implicit folders must stay on legacy instead.
    folders: ProjectIdPlanFolder[];
    inherited: Array<{ directory: string; gitCommonDir: string }>;
    staysOnLegacy: Array<{ directory: string; reason: "implicit" }>;
}

export type ProjectIdUnchangedReason =
    | "implicit"
    | "not_answering"
    | "conflicting_targets"
    | "no_existing_folder"
    | "rust_managed"
    | "workspace_conflict";

export interface ProjectIdPlan {
    version: 1;
    plannedAt: string;
    dbPath: string;
    hostDbPath: string | null;
    schemaVersion: number;
    pairs: ProjectIdPlanPair[];
    unchanged: Array<{ identity: string; reason: ProjectIdUnchangedReason }>;
}

export interface ProjectIdsPlanDeps {
    resolve: (directory: string) => Promise<EntorhinalResolveResult>;
    now: () => Date;
}

export function parseProjectIdsPlanArgs(args: string[]): { dbPath?: string; hostPath?: string } {
    if (args[0] !== "plan")
        throw new Error("Usage: doctor project-ids plan [--db <path>] [--host-db <path>]");
    const values = new Map<string, string>();
    for (let i = 1; i < args.length; i++) {
        const flag = args[i];
        if (flag !== "--db" && flag !== "--host-db")
            throw new Error(`Unknown doctor project-ids plan option: ${flag}`);
        const value = args[++i];
        if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
        if (values.has(flag)) throw new Error(`Repeated option: ${flag}`);
        values.set(flag, value);
    }
    return { dbPath: values.get("--db"), hostPath: values.get("--host-db") };
}

function rustManaged(db: Database, identity: string): boolean {
    return Boolean(
        db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'authority_managed'",
            )
            .get() &&
            db
                .prepare("SELECT 1 FROM authority_managed WHERE project_path = ? LIMIT 1")
                .get(identity),
    );
}

function workspaces(db: Database, identity: string): number[] {
    return (
        db
            .prepare("SELECT workspace_id FROM workspace_members WHERE project_path = ?")
            .all(identity) as Array<{ workspace_id: number }>
    ).map((row) => row.workspace_id);
}

function planFolder(directory: string): ProjectIdPlanFolder {
    let exists = true;
    try {
        statSync(directory);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Permission failures are not missing folders: they must block eligibility.
        exists = code !== "ENOENT" && code !== "ENOTDIR";
    }
    const metadata = readGitCheckoutMetadata(directory);
    return {
        directory,
        exists,
        gitCommonDir: metadata?.gitCommonDir ?? null,
        worktree: metadata?.linkedWorktree ?? false,
    };
}

export async function buildProjectIdPlan(
    db: Database,
    dbPath: string,
    hostDbPath: string | null,
    deps: Partial<ProjectIdsPlanDeps> = {},
): Promise<ProjectIdPlan> {
    const sources = new Map<string, ProjectIdPlanFolder[]>();
    for (const row of observations(db, hostDbPath, dirname(dbPath))) {
        for (const { identity } of row.identities) {
            if (!/^(git|dir):/.test(identity)) continue;
            const folders = sources.get(identity) ?? [];
            if (!folders.some((folder) => folder.directory === row.directory))
                folders.push(planFolder(row.directory));
            sources.set(identity, folders);
        }
    }
    // Include stored identities with no recorded folder in the plan's unchanged list.
    // The merge audit identifies project-scoped tables, so planning and merging cover the same data.
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    for (const table of auditIdentityMerge(db, "", "").auditedTables) {
        if (table.derived) continue;
        for (const row of db
            .prepare(
                `SELECT DISTINCT ${quote(table.identityColumn)} AS identity FROM ${quote(table.tableName)}`,
            )
            .all() as Array<{ identity: unknown }>) {
            if (
                typeof row.identity === "string" &&
                (/^(git|dir):/.test(row.identity) || isAbsolute(row.identity)) &&
                !sources.has(row.identity)
            )
                sources.set(
                    row.identity,
                    isAbsolute(row.identity) ? [planFolder(row.identity)] : [],
                );
        }
    }
    const connectionFile = deps.resolve
        ? undefined
        : loadPluginConfig(process.cwd()).subc?.connection_file;
    const resolve =
        deps.resolve ??
        ((directory: string) => resolveEntorhinalProject(directory, { connectionFile }));
    const candidates = new Map<string, ProjectIdPlanPair>();
    const reasons = new Map<string, ProjectIdUnchangedReason>();
    for (const [from, folders] of sources) {
        if (rustManaged(db, from)) {
            reasons.set(from, "rust_managed");
            continue;
        }
        const existing = folders.filter((folder) => folder.exists);
        if (!existing.length) {
            reasons.set(from, "no_existing_folder");
            continue;
        }
        const targets = new Set<string>();
        const implicitFolders: ProjectIdPlanFolder[] = [];
        const resolvedCommonDirs = new Set<string>();
        let notAnswering = false;
        for (const folder of existing) {
            try {
                if (!statSync(folder.directory).isDirectory()) {
                    notAnswering = true;
                    continue;
                }
                const answer = await resolve(folder.directory);
                if (
                    answer.status === "resolved" &&
                    ["root", "walk", "containment", "worktree"].includes(answer.via) &&
                    isPinnedProjectIdentity(answer.projectId)
                ) {
                    targets.add(answer.projectId);
                    if (folder.gitCommonDir) resolvedCommonDirs.add(folder.gitCommonDir);
                } else if (answer.status === "implicit") implicitFolders.push(folder);
                else notAnswering = true;
            } catch {
                // A folder or transport becoming unreadable online cannot authorize a merge.
                notAnswering = true;
            }
        }
        if (targets.size > 1) reasons.set(from, "conflicting_targets");
        else if (notAnswering) reasons.set(from, "not_answering");
        else if (!targets.size && implicitFolders.length) reasons.set(from, "implicit");
        else {
            const to = [...targets][0];
            if (!to) reasons.set(from, "not_answering");
            else if (rustManaged(db, to)) reasons.set(from, "rust_managed");
            else {
                const inherited: ProjectIdPlanPair["inherited"] = [];
                const staysOnLegacy: ProjectIdPlanPair["staysOnLegacy"] = [];
                for (const folder of implicitFolders) {
                    // Runtime sessions inherit a main checkout's pin through their git common dir.
                    if (folder.gitCommonDir && resolvedCommonDirs.has(folder.gitCommonDir))
                        inherited.push({
                            directory: folder.directory,
                            gitCommonDir: folder.gitCommonDir,
                        });
                    else staysOnLegacy.push({ directory: folder.directory, reason: "implicit" });
                }
                // Folder observations come back in database order, which varies between
                // stores; sort so the same store always produces byte-identical plans.
                const byDirectory = (a: { directory: string }, b: { directory: string }) =>
                    a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0;
                inherited.sort(byDirectory);
                staysOnLegacy.sort(byDirectory);
                candidates.set(from, {
                    from,
                    to,
                    folders: folders
                        .filter(
                            (folder) =>
                                !staysOnLegacy.some(
                                    (legacy) => legacy.directory === folder.directory,
                                ),
                        )
                        .sort(byDirectory),
                    inherited,
                    staysOnLegacy,
                    rowsByTable: {},
                });
            }
        }
    }
    const groups = new Map<string, ProjectIdPlanPair[]>();
    for (const pair of candidates.values()) {
        const group = groups.get(pair.to) ?? [];
        group.push(pair);
        groups.set(pair.to, group);
    }
    for (const [to, group] of groups) {
        // A new registered-project target has no workspace membership, so each source
        // can pass a pairwise merge check while disagreeing with another source's workspace.
        const memberships = new Set(
            [to, ...group.map((pair) => pair.from)].flatMap((identity) => workspaces(db, identity)),
        );
        if (memberships.size > 1) {
            for (const pair of group) reasons.set(pair.from, "workspace_conflict");
            continue;
        }
        for (const pair of group) {
            const preview = mergeProjectIdentities(db, pair.from, pair.to, { dryRun: true });
            pair.rowsByTable = Object.fromEntries(
                preview.auditedTables
                    .filter((table) => !table.derived)
                    .map((table) => [table.tableName, table.sourceRows]),
            );
        }
    }
    return {
        version: 1,
        plannedAt: (deps.now ?? (() => new Date()))().toISOString(),
        dbPath,
        hostDbPath,
        schemaVersion: getPersistedSchemaVersion(db),
        pairs: [...candidates.values()].filter((pair) => !reasons.has(pair.from)),
        unchanged: [...sources.keys()].flatMap((identity) => {
            const reason = reasons.get(identity);
            return reason ? [{ identity, reason }] : [];
        }),
    };
}

export async function runProjectIdsCli(
    args: string[],
    deps: Partial<ProjectIdsPlanDeps & ProjectIdsApplyDeps> = {},
): Promise<number> {
    if (args[0] === "apply") return runProjectIdsApplyCli(args, deps);
    const options = parseProjectIdsPlanArgs(args);
    const requestedDbPath = options.dbPath ?? join(getMagicContextStorageDir(), "context.db");
    const db = openExistingContextDatabase(requestedDbPath, {
        readonly: true,
        minimumSupportedVersion: CLI_SCHEMA_FLOOR_VERSION,
    });
    if (!db) throw new Error(`Context database does not exist: ${requestedDbPath}`);
    try {
        const dbPath = realpathSync.native(requestedDbPath);
        const storageDir = dirname(dbPath);
        const requestedHostPath =
            options.hostPath ??
            (options.dbPath ? join(storageDir, "host.db") : resolveOpenCodeDbPath().path);
        if (options.hostPath && !existsSync(requestedHostPath))
            throw new Error(`Host database does not exist: ${requestedHostPath}`);
        const hostDbPath = existsSync(requestedHostPath)
            ? realpathSync.native(requestedHostPath)
            : null;
        if (hostDbPath === null)
            console.log(
                "Skipped host session observations: no host database; use --host-db <path> to include them.",
            );
        const plan = await buildProjectIdPlan(db, dbPath, hostDbPath, deps);
        const path = join(
            storageDir,
            `project-id-plan-${plan.plannedAt.replaceAll(":", "-")}.json`,
        );
        writeStorageFileAtomicSync(path, `${JSON.stringify(plan, null, 2)}\n`);
        console.log(`Project identity plan: ${path}`);
        console.log(
            `  ${plan.pairs.length} pair(s); ${plan.unchanged.length} unchanged source(s). No database or pin changes.`,
        );
        for (const pair of plan.pairs) {
            for (const folder of pair.inherited)
                console.log(
                    `  Inherited ${pair.to}: ${folder.directory} (git common dir: ${folder.gitCommonDir})`,
                );
            for (const folder of pair.staysOnLegacy)
                console.log(
                    `  Stays on legacy: ${folder.directory} (${folder.reason}; fresh legacy identity after remap ${pair.from} -> ${pair.to})`,
                );
        }
        return 0;
    } finally {
        db.close();
    }
}
