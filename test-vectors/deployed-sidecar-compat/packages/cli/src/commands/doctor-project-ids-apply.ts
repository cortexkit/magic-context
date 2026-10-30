import { createHash } from "node:crypto";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    statfsSync,
    statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readGitCheckoutMetadata } from "@magic-context/core/features/magic-context/memory/git-common-dir";
import {
    isPinnedProjectIdentity,
    projectDirectoryKey,
} from "@magic-context/core/features/magic-context/memory/project-identity-cache";
import {
    auditIdentityMerge,
    mergeProjectIdentities,
} from "@magic-context/core/features/magic-context/storage-identity-merge";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { configureContextDatabasePragmas } from "@magic-context/core/shared/sqlite-context-pragmas";
import {
    copyStorageTreeSync,
    ensureStorageDirectorySync,
    writeStorageFileAtomicSync,
} from "@magic-context/core/shared/storage-permissions";
import {
    CLI_SCHEMA_FLOOR_VERSION,
    getPersistedSchemaVersion,
    openExistingContextDatabase,
    openExistingDatabase,
} from "../lib/database-access";
import { type MergeIdentityDeps, observations } from "./doctor-merge-identity";
import { probeHostProcessesUsing } from "./doctor-opencode2-cache";
import type { ProjectIdPlan, ProjectIdPlanPair } from "./doctor-project-ids";
import { copyDatabaseBundle, defaultInspectHolders } from "./doctor-repair-db";

export interface ProjectIdsApplyDeps extends MergeIdentityDeps {
    freeBytes: (storageDir: string) => number;
}

export interface ProjectIdsApplyOptions {
    dbPath?: string;
    hostPath?: string;
}

export interface ProjectIdApplyPairPreview {
    pair: ProjectIdPlanPair;
    liveRowsByTable: Record<string, number>;
    liveRows: number;
}

export interface ProjectIdApplyPreflight {
    dbPath: string;
    hostDbPath: string | null;
    pairs: ProjectIdApplyPairPreview[];
    refusals: Array<{ code: string; message: string; from?: string }>;
    space: { bundleBytes: number; requiredBytes: number; freeBytes: number } | null;
}

export function parseProjectIdsApplyArgs(
    args: string[],
): ProjectIdsApplyOptions & { planPath: string; check: boolean } {
    const values = new Map<string, string>();
    let planPath: string | undefined;
    let checked = false;
    for (let i = 1; i < args.length; i++) {
        const flag = args[i];
        if (flag === "--check" && !checked) checked = true;
        else if (flag === "--db" || flag === "--host-db") {
            const value = args[++i];
            if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
            if (values.has(flag)) throw new Error(`Repeated option: ${flag}`);
            values.set(flag, value);
        } else if (!flag.startsWith("--") && !planPath) planPath = flag;
        else throw new Error(`Unknown doctor project-ids apply option: ${flag}`);
    }
    if (!planPath)
        throw new Error(
            "Usage: doctor project-ids apply [--check] <plan> [--db <path>] [--host-db <path>]",
        );
    return {
        planPath,
        check: checked,
        dbPath: values.get("--db"),
        hostPath: values.get("--host-db"),
    };
}

function validatePlan(plan: ProjectIdPlan): void {
    if (
        plan?.version !== 1 ||
        typeof plan.dbPath !== "string" ||
        (plan.hostDbPath !== null && typeof plan.hostDbPath !== "string") ||
        !Number.isSafeInteger(plan.schemaVersion) ||
        !Array.isArray(plan.pairs)
    )
        throw new Error("Invalid version 1 project identity plan");
    const sources = new Set<string>();
    for (const pair of plan.pairs) {
        if (
            !pair ||
            typeof pair.from !== "string" ||
            !/^(git|dir):.+/.test(pair.from) ||
            !isPinnedProjectIdentity(pair.to) ||
            sources.has(pair.from) ||
            !Array.isArray(pair.folders) ||
            pair.folders.some(
                (folder) =>
                    !folder ||
                    typeof folder.directory !== "string" ||
                    typeof folder.exists !== "boolean" ||
                    typeof folder.worktree !== "boolean" ||
                    (folder.gitCommonDir !== null && typeof folder.gitCommonDir !== "string"),
            ) ||
            (pair.staysOnLegacy !== undefined &&
                (!Array.isArray(pair.staysOnLegacy) ||
                    pair.staysOnLegacy.some(
                        (folder) =>
                            !folder ||
                            typeof folder.directory !== "string" ||
                            folder.reason !== "implicit",
                    ))) ||
            !pair.rowsByTable ||
            typeof pair.rowsByTable !== "object" ||
            Array.isArray(pair.rowsByTable) ||
            Object.values(pair.rowsByTable).some(
                (count) => !Number.isSafeInteger(count) || count < 0,
            )
        )
            throw new Error("Invalid project identity plan pair");
        sources.add(pair.from);
    }
}

function treeBytes(path: string): number {
    if (!existsSync(path)) return 0;
    const stat = statSync(path);
    return stat.isDirectory()
        ? readdirSync(path).reduce((total, entry) => total + treeBytes(join(path, entry)), 0)
        : stat.size;
}

/** Check the plan's store, inventory, holders and backup capacity without writing. */
export function preflightProjectIdApply(
    plan: ProjectIdPlan,
    options: ProjectIdsApplyOptions = {},
    deps: Partial<ProjectIdsApplyDeps> = {},
): ProjectIdApplyPreflight {
    validatePlan(plan);
    const requestedDbPath = options.dbPath ?? join(getMagicContextStorageDir(), "context.db");
    const result: ProjectIdApplyPreflight = {
        dbPath: requestedDbPath,
        hostDbPath: plan.hostDbPath,
        pairs: [],
        refusals: [],
        space: null,
    };
    const refuse = (code: string, message: string, from?: string) => {
        result.refusals.push({ code, message, ...(from ? { from } : {}) });
    };
    try {
        result.dbPath = realpathSync.native(requestedDbPath);
        if (result.dbPath !== plan.dbPath) {
            refuse(
                "store_mismatch",
                "Context database path differs from the plan; re-plan for this store.",
            );
            return result;
        }
        if (options.hostPath && plan.hostDbPath === null) {
            refuse("host_mismatch", "--host-db cannot be supplied for a hostDbPath: null plan.");
            return result;
        }
        const hostPath = options.hostPath ?? plan.hostDbPath;
        if (hostPath !== null && hostPath !== undefined) {
            result.hostDbPath = realpathSync.native(hostPath);
            if (result.hostDbPath !== plan.hostDbPath) {
                refuse("host_mismatch", "Host database path differs from the plan.");
                return result;
            }
            const host = openExistingDatabase(result.hostDbPath, { readonly: true });
            if (!host) throw new Error(`Planned host database is missing: ${result.hostDbPath}`);
            try {
                host.prepare("PRAGMA schema_version").get();
            } finally {
                host.close();
            }
        }
    } catch (error) {
        refuse("database_unreadable", String(error));
        return result;
    }
    const storageDir = dirname(result.dbPath);
    const holders = (deps.inspectHolders ?? defaultInspectHolders)(storageDir);
    const probe = (deps.probe ?? probeHostProcessesUsing)({
        files: [result.dbPath, `${result.dbPath}-wal`, `${result.dbPath}-shm`],
        directories: [],
    });
    if (!holders.safe || probe.status !== "free") {
        refuse(
            "holders",
            `Close OpenCode, Pi, OpenCode 2, ck-mc and the dashboard. ${holders.blockers.join(", ")} ${holders.uncertainty ?? ""} ${probe.status === "in_use" ? `context.db holders: ${probe.pids.join(", ")}` : probe.status === "unknown" ? probe.reason : ""}`,
        );
        return result;
    }
    const db = openExistingContextDatabase(result.dbPath, {
        readonly: true,
        minimumSupportedVersion: CLI_SCHEMA_FLOOR_VERSION,
    });
    if (!db) {
        refuse("database_unreadable", "Context database disappeared.");
        return result;
    }
    try {
        if (getPersistedSchemaVersion(db) !== plan.schemaVersion) {
            refuse("schema_mismatch", "Context database schemaVersion differs from the plan.");
            return result;
        }
        const observed = observations(db, result.hostDbPath, storageDir);
        for (const pair of plan.pairs) {
            const mapped = db
                .prepare(
                    "SELECT new_project_path FROM v22_identity_rekey_map WHERE old_project_path = ?",
                )
                .get(pair.from) as { new_project_path: string } | undefined;
            if (mapped && mapped.new_project_path !== pair.to)
                refuse(
                    "rekey_conflict",
                    `${pair.from} is already mapped to ${mapped.new_project_path}, not ${pair.to}.`,
                    pair.from,
                );
            const audit = auditIdentityMerge(db, pair.from, pair.to);
            const liveRowsByTable = Object.fromEntries(
                audit.auditedTables
                    .filter((table) => !table.derived)
                    .map((table) => [table.tableName, table.sourceRows]),
            );
            const liveRows = Object.values(liveRowsByTable).reduce(
                (total, count) => total + count,
                0,
            );
            result.pairs.push({ pair, liveRowsByTable, liveRows });
            // Only folders still attributed to a source with rows can expand the data being moved.
            if (liveRows === 0) continue;
            // Legacy-only folders were observed during planning but are not pin destinations.
            const plannedFolders = new Set(
                [...pair.folders, ...(pair.staysOnLegacy ?? [])].map((folder) => folder.directory),
            );
            for (const row of observed) {
                if (
                    row.identities.some((item) => item.identity === pair.from) &&
                    !plannedFolders.has(row.directory)
                )
                    refuse(
                        "new_folder",
                        `${pair.from} gained recorded folder ${row.directory}; re-plan before applying.`,
                        pair.from,
                    );
            }
            try {
                mergeProjectIdentities(db, pair.from, pair.to, { dryRun: true });
            } catch (error) {
                refuse("merge_not_allowed", String(error), pair.from);
            }
        }
        const bundleBytes = [
            result.dbPath,
            `${result.dbPath}-wal`,
            `${result.dbPath}-shm`,
            join(storageDir, "project-identities"),
        ].reduce((total, path) => total + treeBytes(path), 0);
        const requiredBytes = Math.ceil((bundleBytes * 11) / 10);
        const freeBytes = (
            deps.freeBytes ??
            ((path) => {
                const stat = statfsSync(path);
                return stat.bavail * stat.bsize;
            })
        )(storageDir);
        result.space = { bundleBytes, requiredBytes, freeBytes };
        if (!Number.isFinite(freeBytes) || freeBytes < requiredBytes)
            refuse(
                "insufficient_space",
                `Backup needs ${requiredBytes} free bytes (bundle plus 10%); available: ${freeBytes}.`,
            );
    } finally {
        db.close();
    }
    return result;
}

function pinUpdates(
    pair: ProjectIdPlanPair,
    storageDir: string,
): Array<{ path: string; content: string }> {
    const updates: Array<{ path: string; content: string }> = [];
    for (const folder of pair.folders) {
        if (!existsSync(folder.directory) || !statSync(folder.directory).isDirectory()) continue;
        const metadata = readGitCheckoutMetadata(folder.directory);
        if (metadata?.linkedWorktree) continue;
        const directory = projectDirectoryKey(folder.directory);
        const pin = {
            directory,
            identity: pair.to,
            ...(metadata?.gitCommonDir ? { gitCommonDir: metadata.gitCommonDir } : {}),
        };
        const path = join(
            storageDir,
            "project-identities",
            `${createHash("sha256").update(directory).digest("hex")}.json`,
        );
        let existing: typeof pin | undefined;
        try {
            existing = JSON.parse(readFileSync(path, "utf8"));
        } catch (error) {
            if (
                !(error instanceof SyntaxError) &&
                (error as NodeJS.ErrnoException).code !== "ENOENT"
            )
                throw error;
        }
        if (
            existing?.directory === directory &&
            existing.identity === pair.to &&
            existing.gitCommonDir === pin.gitCommonDir
        )
            continue;
        updates.push({ path, content: JSON.stringify(pin) });
    }
    return updates;
}

function backupProjectIds(dbPath: string): void {
    const storageDir = dirname(dbPath);
    const backup = mkdtempSync(join(storageDir, "project-ids-backup-"));
    const sidecars = join(storageDir, "project-identities");
    const savedSidecars = join(backup, "project-identities");
    if (existsSync(sidecars)) copyStorageTreeSync(sidecars, savedSidecars);
    else ensureStorageDirectorySync(savedSidecars);
    copyDatabaseBundle(dbPath, join(backup, "context.db"));
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    console.log(`Backup directory: ${backup}`);
    console.log(
        "store.db was not changed. Restoring context.db and identity sidecars is safe only before further use; close all hosts first.",
    );
    console.log(
        `Restore with hosts closed: rm -f ${quote(`${dbPath}-wal`)} ${quote(`${dbPath}-shm`)}; cp ${quote(join(backup, "context.db"))} ${quote(dbPath)}; for suffix in -wal -shm; do if test -f ${quote(join(backup, "context.db"))}"$suffix"; then cp ${quote(join(backup, "context.db"))}"$suffix" ${quote(dbPath)}"$suffix"; fi; done`,
    );
    console.log(
        `Restore identity sidecars too: rm -rf ${quote(sidecars)}; cp -R ${quote(savedSidecars)} ${quote(sidecars)}`,
    );
}

export function runProjectIdsApplyCli(
    args: string[],
    deps: Partial<ProjectIdsApplyDeps> = {},
): number {
    const options = parseProjectIdsApplyArgs(args);
    const plan = JSON.parse(readFileSync(options.planPath, "utf8")) as ProjectIdPlan;
    const result = preflightProjectIdApply(plan, options, deps);
    if (result.hostDbPath === null)
        console.log(
            "Skipped host session observations: plan has no host database; re-plan with --host-db <path> to include them.",
        );
    for (const { pair, liveRowsByTable } of result.pairs) {
        console.log(`${pair.from} → ${pair.to}: planned / live row counts`);
        for (const table of new Set([
            ...Object.keys(pair.rowsByTable),
            ...Object.keys(liveRowsByTable),
        ]))
            console.log(
                `  ${table}: planned ${pair.rowsByTable[table] ?? 0}; live ${liveRowsByTable[table] ?? 0}`,
            );
    }
    if (result.space)
        console.log(
            `Backup space: bundle ${result.space.bundleBytes}; required ${result.space.requiredBytes}; free ${result.space.freeBytes} bytes.`,
        );
    for (const refusal of result.refusals)
        console.error(`Refused [${refusal.code}]: ${refusal.message}`);
    if (options.check || result.refusals.length) {
        console.log(
            `Apply ${options.check ? "check " : ""}${result.refusals.length ? "refused" : "passed"}. Nothing was changed.`,
        );
        return result.refusals.length ? 1 : 0;
    }
    const storageDir = dirname(result.dbPath);
    const pendingWrites = result.pairs.some(
        ({ pair, liveRows }) => liveRows > 0 || pinUpdates(pair, storageDir).length > 0,
    );
    // A finished plan needs neither another backup nor a writable database handle.
    if (pendingWrites) backupProjectIds(result.dbPath);
    const db = openExistingDatabase(result.dbPath, { readonly: !pendingWrites });
    if (!db) throw new Error(`Context database disappeared: ${result.dbPath}`);
    try {
        if (pendingWrites) configureContextDatabasePragmas(db);
        for (const { pair } of result.pairs) {
            // Only validated plan pairs bypass the manual CLI's pair checks. The shared
            // merge keeps its safety fences and commits its rekey map with this pair.
            const merged = mergeProjectIdentities(db, pair.from, pair.to);
            const pins = pinUpdates(pair, storageDir);
            for (const pin of pins) writeStorageFileAtomicSync(pin.path, pin.content);
            const status =
                merged.changedRows > 0
                    ? "applied"
                    : pins.length
                      ? "pins repaired"
                      : "already applied";
            console.log(`${pair.from} → ${pair.to}: ${status}`);
        }
    } finally {
        db.close();
    }
    return 0;
}

export const __compatPinUpdates = pinUpdates;
