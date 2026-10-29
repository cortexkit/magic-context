import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureContextStoreUuid } from "@magic-context/core/features/magic-context/context-store-uuid";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import {
    getPersistedSchemaVersion,
    initializeDatabase,
    inspectRpcServerDiscovery,
    LATEST_SUPPORTED_VERSION,
} from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import {
    inspectLivePiProcesses,
    inspectWindowsProcessesSync,
} from "@magic-context/core/shared/rpc-utils";
import { Database, type Database as DatabaseType } from "@magic-context/core/shared/sqlite";
import {
    copyStorageFileSync,
    openStorageFileSync,
} from "@magic-context/core/shared/storage-permissions";

import { CLI_SCHEMA_FLOOR_VERSION } from "../lib/database-access";
import { type PromptIO, promptIO } from "../lib/prompts";
import {
    type CachedPluginFence,
    listCachedOpenCodePluginFences,
} from "./doctor-cached-plugin-fence";
import { OPENCODE_V2_PLUGIN_UPDATE_HINT, probeHostProcessesUsing } from "./doctor-opencode2-cache";
import { PRUNE_DISCOVERY_COMMAND } from "./doctor-prune-discovery";
import { canonicalStoragePath, processReferencesStorage } from "./doctor-storage-holders";

const ROW_COUNT_TABLES = ["tags", "compartments", "memories", "notes", "dream_runs"] as const;
const DATABASE_SUFFIXES = ["", "-wal", "-shm"] as const;
const RECOGNIZABLE_TABLES = [...ROW_COUNT_TABLES, "schema_migrations"] as const;

export const REPAIR_DB_EXIT = {
    salvaged: 0,
    failed: 1,
    unsalvageable: 2,
    refused: 3,
} as const;

type RepairDbExitCode = (typeof REPAIR_DB_EXIT)[keyof typeof REPAIR_DB_EXIT];
type RowCounts = Record<(typeof ROW_COUNT_TABLES)[number], number | null>;

export interface DatabaseHolderInspection {
    safe: boolean;
    blockers: string[];
    uncertainty?: string;
}

interface RepairDbDeps {
    now: () => Date;
    sqliteExecutable: string;
    inspectHolders: (storageDir: string) => DatabaseHolderInspection;
    /** Cached Magic Context plugin copies and the schema each one accepts. */
    listPluginFences: () => CachedPluginFence[];
}

export interface RunRepairDbOptions {
    dbPath?: string;
    storageDir?: string;
    prompts?: PromptIO;
    deps?: Partial<RepairDbDeps>;
}

interface BackupBundle {
    basePath: string;
    copiedPaths: string[];
}

interface SalvageResult {
    ok: boolean;
    detail?: string;
    afterCounts?: RowCounts;
    schemaVersionBefore?: number;
    schemaVersionAfter?: number;
}

interface HolderInspectionDeps {
    defaultStorageDir: string;
    inspectRpc: typeof inspectRpcServerDiscovery;
    inspectPi: typeof inspectLivePiProcesses;
    probeFiles: typeof probeHostProcessesUsing;
    processReferences: typeof processReferencesStorage;
}

export function defaultInspectHolders(
    storageDir: string,
    overrides: Partial<HolderInspectionDeps> = {},
): DatabaseHolderInspection {
    const deps: HolderInspectionDeps = {
        defaultStorageDir: join(homedir(), ".local", "share", "cortexkit", "magic-context"),
        inspectRpc: inspectRpcServerDiscovery,
        inspectPi: inspectLivePiProcesses,
        probeFiles: probeHostProcessesUsing,
        processReferences: processReferencesStorage,
        ...overrides,
    };
    // On Windows one process snapshot serves both the RPC and the Pi checks, so
    // the slow process listing runs once per doctor call.
    const processes = process.platform === "win32" ? inspectWindowsProcessesSync() : undefined;
    const rpc = deps.inspectRpc(storageDir, processes, {
        deadlineMs: 15_000,
        onProgress: (checked, total) =>
            console.error(`Inspecting RPC database holders: ${checked}/${total} records checked`),
    });
    if (rpc.state === "unreadable") {
        const arm = rpc.unreadableArm === "parse" ? "could not be parsed" : "could not be read";
        return {
            safe: false,
            blockers: [],
            uncertainty: `RPC discovery ${rpc.unreadableFile ?? join(storageDir, "rpc")} ${arm}`,
        };
    }

    const blockers =
        rpc.state === "live" ? rpc.serverPids.map((pid) => `OpenCode server (PID ${pid})`) : [];
    if (rpc.state === "inconclusive")
        return {
            safe: false,
            blockers: [],
            uncertainty: `RPC process liveness could not be determined (PID ${(rpc.inconclusivePids ?? []).join(", ")}). If none of these is a running host, review and remove their discovery records with \`${PRUNE_DISCOVERY_COMMAND}\`.`,
        };
    const pi = overrides.inspectPi ? deps.inspectPi() : (processes?.pi ?? deps.inspectPi());
    if (canonicalStoragePath(storageDir) !== canonicalStoragePath(deps.defaultStorageDir)) {
        // Non-default stores require an explicit host path. A process named Pi
        // is not enough: open target files or a configured storage path identify holders.
        const holders = deps.probeFiles({
            files: ["context.db", "store.db"].flatMap((name) =>
                DATABASE_SUFFIXES.map((suffix) => join(storageDir, `${name}${suffix}`)),
            ),
            directories: [],
        });
        if (holders.status === "unknown") {
            return { safe: false, blockers, uncertainty: holders.reason };
        }
        if (holders.status === "in_use") {
            blockers.push(...holders.pids.map((pid) => `database holder (PID ${pid})`));
        }
        const candidates = new Set([...pi.processIds, ...(pi.inconclusivePids ?? [])]);
        for (const pid of candidates) {
            if (deps.processReferences(pid, storageDir))
                blockers.push(`Pi/OMP harness (PID ${pid})`);
        }
        return { safe: blockers.length === 0, blockers };
    }
    if (pi.state === "unreadable" || pi.state === "inconclusive") {
        return {
            safe: false,
            blockers,
            uncertainty:
                pi.state === "inconclusive"
                    ? `Pi/OMP process image or command line was ambiguous (PID ${(pi.inconclusivePids ?? []).join(", ")})`
                    : `Pi/OMP process liveness could not be determined: ${pi.error ?? "process list unavailable"}`,
        };
    }
    blockers.push(...pi.processIds.map((pid) => `Pi/OMP harness (PID ${pid})`));
    return { safe: blockers.length === 0, blockers };
}

export function defaultSqliteExecutable(): string {
    return process.env.MAGIC_CONTEXT_SQLITE3 ?? "sqlite3";
}

const DEFAULT_DEPS: RepairDbDeps = {
    now: () => new Date(),
    sqliteExecutable: defaultSqliteExecutable(),
    inspectHolders: defaultInspectHolders,
    listPluginFences: () => listCachedOpenCodePluginFences(),
};

function timestamp(date: Date): string {
    return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

function uniqueBase(preferred: string): string {
    if (!DATABASE_SUFFIXES.some((suffix) => existsSync(`${preferred}${suffix}`))) return preferred;
    for (let attempt = 1; attempt < 10_000; attempt++) {
        const candidate = `${preferred}-${attempt}`;
        if (!DATABASE_SUFFIXES.some((suffix) => existsSync(`${candidate}${suffix}`)))
            return candidate;
    }
    throw new Error(`Could not allocate a unique recovery path beside ${preferred}`);
}

function copyBackupBundle(dbPath: string, stamp: string): BackupBundle {
    const basePath = uniqueBase(`${dbPath}.corrupt-backup-${stamp}`);
    const copiedPaths = copyDatabaseBundle(dbPath, basePath);
    return { basePath, copiedPaths };
}

export function databaseBundleSizeBytes(sourceBase: string): number {
    let size = 0;
    for (const suffix of DATABASE_SUFFIXES) {
        const source = `${sourceBase}${suffix}`;
        if (existsSync(source)) size += statSync(source).size;
    }
    return size;
}

export function copyDatabaseBundle(
    sourceBase: string,
    destinationBase: string,
    forcePrivate = false,
): string[] {
    const copiedPaths: string[] = [];
    for (const suffix of DATABASE_SUFFIXES) {
        const source = `${sourceBase}${suffix}`;
        if (!existsSync(source)) continue;
        const destination = `${destinationBase}${suffix}`;
        copyStorageFileSync(source, destination, forcePrivate);
        copiedPaths.push(destination);
    }
    return copiedPaths;
}

function readRowCounts(path: string): RowCounts {
    const counts = Object.fromEntries(ROW_COUNT_TABLES.map((table) => [table, null])) as RowCounts;
    let db: DatabaseType | null = null;
    try {
        db = new Database(path, { readonly: true });
        for (const table of ROW_COUNT_TABLES) {
            try {
                const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
                    | { count?: unknown }
                    | undefined;
                counts[table] = typeof row?.count === "number" ? row.count : null;
            } catch {
                counts[table] = null;
            }
        }
    } catch {
        // Every table remains n/a when SQLite cannot open the damaged file.
    } finally {
        db?.close();
    }
    return counts;
}

function reportCounts(prompts: PromptIO, label: "BEFORE" | "AFTER", counts: RowCounts): void {
    prompts.log.info(`Row counts ${label} recovery:`);
    for (const table of ROW_COUNT_TABLES) {
        prompts.log.info(`  ${table}=${counts[table] ?? "n/a"}`);
    }
}

function reportSchemaTransition(prompts: PromptIO, result: SalvageResult): void {
    prompts.log.info(
        `Schema migration: v${result.schemaVersionBefore ?? "unknown"} → v${result.schemaVersionAfter ?? "unknown"}`,
    );
}

function reportSalvageRates(prompts: PromptIO, before: RowCounts, after: RowCounts): void {
    prompts.log.info("Salvage rates (readable rows before → rows after):");
    for (const table of ROW_COUNT_TABLES) {
        const beforeCount = before[table];
        const afterCount = after[table];
        if (beforeCount === null || afterCount === null) {
            prompts.log.info(`  ${table}: n/a`);
            continue;
        }
        const rate =
            beforeCount === 0 ? (afterCount === 0 ? 100 : 0) : (afterCount / beforeCount) * 100;
        const lost = Math.max(0, beforeCount - afterCount);
        prompts.log.info(
            `  ${table}: ${beforeCount} → ${afterCount} (${rate.toFixed(1)}%, lost ${lost})`,
        );
    }
}

function integrityErrors(db: DatabaseType): string[] {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{
        integrity_check?: unknown;
    }>;
    return rows
        .map((row) => String(row.integrity_check ?? "unknown"))
        .filter((result) => result !== "ok");
}

function sqliteError(result: ReturnType<typeof spawnSync>): string {
    if (result.error) return result.error.message;
    const stderr = String(result.stderr ?? "").trim();
    if (stderr) return stderr;
    return `sqlite3 exited with status ${String(result.status)}`;
}

// `.recover` reads raw database pages through the sqlite_dbpage virtual table.
// That table is a compile-time option (SQLITE_ENABLE_DBPAGE_VTAB); a shell built
// without it dies the moment `.recover` reaches for it, with one of the first two
// errors below. Shells older than SQLite 3.29 have no `.recover` command at all
// and answer "unknown command". All three mean THIS SQLITE3 LACKS A FEATURE, not
// that the data is gone: the same database may salvage fine on a full build, so
// the command must stop without claiming it is unsalvageable and without offering
// the destructive reset. Kept deliberately narrow — a genuine data-level failure
// of `.recover` must still reach the normal failure path.
const RECOVER_UNAVAILABLE_PATTERNS = [
    /no such table: sqlite_dbpage/i,
    /no such module: sqlite_dbpage/i,
    /unknown command[^\n]*\.recover/i,
] as const;

function isRecoverCapabilityMissing(errorDetail: string): boolean {
    return RECOVER_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(errorDetail));
}

function runRecoverShell(
    sqliteExecutable: string,
    sourcePath: string,
    recoveredPath: string,
    dumpPath: string,
): { ok: true } | { ok: false; detail: string; attempted: boolean; unavailable: boolean } {
    let dumpWriteFd: number | null = null;
    try {
        dumpWriteFd = openStorageFileSync(dumpPath, "wx");
        const recovered = spawnSync(sqliteExecutable, [sourcePath, ".recover"], {
            stdio: ["ignore", dumpWriteFd, "pipe"],
            encoding: "utf8",
            windowsHide: true,
        });
        closeSync(dumpWriteFd);
        dumpWriteFd = null;
        if (recovered.error || recovered.status !== 0) {
            const errorDetail = sqliteError(recovered);
            const attempted = recovered.error === undefined;
            return {
                ok: false,
                detail: `.recover failed: ${errorDetail}`,
                attempted,
                // Only a shell that actually ran can report a missing capability;
                // a spawn failure is the could-not-start case, handled separately.
                unavailable: attempted && isRecoverCapabilityMissing(errorDetail),
            };
        }

        const recoveredSeedFd = openStorageFileSync(recoveredPath, "wx");
        closeSync(recoveredSeedFd);
        const dumpReadFd = openSync(dumpPath, "r");
        try {
            // .recover enables writable_schema to restore internal tables and virtual
            // table definitions. Defensive mode makes that pragma a no-op in some
            // shells, so disable it only on the fresh, isolated replay database.
            const replayed = spawnSync(
                sqliteExecutable,
                [recoveredPath, "-cmd", ".dbconfig defensive off"],
                {
                    stdio: [dumpReadFd, "ignore", "pipe"],
                    encoding: "utf8",
                    windowsHide: true,
                },
            );
            if (replayed.error || replayed.status !== 0) {
                return {
                    ok: false,
                    detail: `replaying .recover output failed: ${sqliteError(replayed)}`,
                    attempted: true,
                    // The replay step only executes the SQL `.recover` emitted, so a
                    // failure here is about the recovered data, never about the shell.
                    unavailable: false,
                };
            }
        } finally {
            closeSync(dumpReadFd);
        }
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
            attempted: false,
            unavailable: false,
        };
    } finally {
        if (dumpWriteFd !== null) closeSync(dumpWriteFd);
        rmSync(dumpPath, { force: true });
    }
}

/**
 * Warning printed before repair-db migrates a salvaged database that is older
 * than this CLI. Salvage must finish (the database is otherwise unusable), so
 * it still migrates to this CLI's schema, but every other CLI write refuses to
 * outrun the plugin: a plugin built for an older schema refuses the repaired
 * database until it is updated. Empty when the database is already current.
 */
export function schemaMigrationWarning(
    schemaVersionBefore: number,
    fences: CachedPluginFence[],
): string[] {
    if (schemaVersionBefore >= CLI_SCHEMA_FLOOR_VERSION) return [];
    const lines = [
        `Schema migration ahead: the salvaged database is at schema v${schemaVersionBefore}; this CLI migrates it from v${schemaVersionBefore} to v${LATEST_SUPPORTED_VERSION}. An older Magic Context plugin refuses a database newer than it supports, so update the plugin before restarting OpenCode, Pi or OMP.`,
    ];
    for (const fence of fences) {
        if (fence.supportedVersion === null || fence.supportedVersion >= LATEST_SUPPORTED_VERSION) {
            continue;
        }
        const label =
            fence.host === "opencode1"
                ? "OpenCode 1"
                : fence.spec && fence.spec !== "latest"
                  ? `OpenCode 2 (@${fence.spec})`
                  : "OpenCode 2";
        lines.push(
            `${label} has Magic Context ${fence.version ?? "(unknown version)"} cached, which supports only schema v${fence.supportedVersion}; it will refuse the repaired database until updated (${fence.directory}).`,
            fence.host === "opencode1"
                ? "  To update: quit OpenCode 1, then run `npx @cortexkit/magic-context@latest doctor --force` (or delete that directory); OpenCode 1 installs the current release on its next start."
                : `  To update, ${OPENCODE_V2_PLUGIN_UPDATE_HINT}.`,
        );
    }
    return lines;
}

export function migrateAndCheckRecoveredDatabase(
    path: string,
    /** Called with the salvaged schema version before any migration runs. */
    beforeMigrate?: (schemaVersionBefore: number) => void,
): SalvageResult {
    let db: DatabaseType | null = null;
    try {
        db = new Database(path);
        const recognized = db
            .prepare(
                `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${RECOGNIZABLE_TABLES.map(() => "?").join(",")})`,
            )
            .all(...RECOGNIZABLE_TABLES) as Array<{ name?: string }>;
        if (recognized.length === 0) {
            return {
                ok: false,
                detail: ".recover found no recognizable Magic Context schema or user tables",
            };
        }

        const schemaVersionBefore = getPersistedSchemaVersion(db);
        beforeMigrate?.(schemaVersionBefore);
        initializeDatabase(db);
        runMigrations(db);
        ensureContextStoreUuid(db);
        const schemaVersionAfter = getPersistedSchemaVersion(db);
        const errors = integrityErrors(db);
        if (errors.length > 0) {
            return {
                ok: false,
                detail: `recovered database integrity_check failed: ${errors.slice(0, 3).join("; ")}`,
            };
        }
        const afterCounts = readCountsFromOpenDatabase(db);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.exec("PRAGMA synchronous=FULL");
        db.exec("PRAGMA journal_mode=DELETE");
        return { ok: true, afterCounts, schemaVersionBefore, schemaVersionAfter };
    } catch (error) {
        return {
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
        };
    } finally {
        db?.close();
    }
}

function readCountsFromOpenDatabase(db: DatabaseType): RowCounts {
    const counts = Object.fromEntries(ROW_COUNT_TABLES.map((table) => [table, null])) as RowCounts;
    for (const table of ROW_COUNT_TABLES) {
        try {
            const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
                | { count?: unknown }
                | undefined;
            counts[table] = typeof row?.count === "number" ? row.count : null;
        } catch {
            counts[table] = null;
        }
    }
    return counts;
}

function prepareFreshDatabase(path: string): SalvageResult {
    let db: DatabaseType | null = null;
    try {
        const seedFd = openStorageFileSync(path, "wx");
        closeSync(seedFd);
        db = new Database(path);
        const schemaVersionBefore = getPersistedSchemaVersion(db);
        initializeDatabase(db);
        runMigrations(db);
        ensureContextStoreUuid(db);
        const schemaVersionAfter = getPersistedSchemaVersion(db);
        const errors = integrityErrors(db);
        if (errors.length > 0) {
            return {
                ok: false,
                detail: `fresh database integrity_check failed: ${errors.join("; ")}`,
            };
        }
        const afterCounts = readCountsFromOpenDatabase(db);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.exec("PRAGMA synchronous=FULL");
        db.exec("PRAGMA journal_mode=DELETE");
        return { ok: true, afterCounts, schemaVersionBefore, schemaVersionAfter };
    } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    } finally {
        db?.close();
    }
}

function removeRecoveryBundle(basePath: string): void {
    for (const suffix of DATABASE_SUFFIXES) rmSync(`${basePath}${suffix}`, { force: true });
}

function activateReplacement(
    dbPath: string,
    replacementPath: string,
    originalAsidePath: string,
): string[] {
    const movedOriginals: Array<{ from: string; to: string }> = [];
    try {
        for (const suffix of DATABASE_SUFFIXES) {
            const from = `${dbPath}${suffix}`;
            if (!existsSync(from)) continue;
            const to = `${originalAsidePath}${suffix}`;
            renameSync(from, to);
            movedOriginals.push({ from, to });
        }
        renameSync(replacementPath, dbPath);
        return movedOriginals.map(({ to }) => to);
    } catch (error) {
        for (const moved of movedOriginals.reverse()) {
            if (existsSync(moved.to) && !existsSync(moved.from)) renameSync(moved.to, moved.from);
        }
        throw error;
    }
}

function reportSafetyRefusal(
    prompts: PromptIO,
    dbPath: string,
    inspection: DatabaseHolderInspection,
    backupBase?: string,
): RepairDbExitCode {
    prompts.log.error(`Refusing to repair the live database: ${dbPath}`);
    if (inspection.blockers.length > 0) {
        prompts.log.error(`Active database holder(s): ${inspection.blockers.join(", ")}`);
    }
    if (inspection.uncertainty) prompts.log.error(inspection.uncertainty);
    prompts.log.info("Close every OpenCode, Pi, and OMP process, then run the command again.");
    if (backupBase) prompts.log.info(`Backup base: ${backupBase}`);
    else prompts.log.info("Backup: not created (repair refused before database access)");
    prompts.outro("Database repair refused; the original database files were not modified");
    return REPAIR_DB_EXIT.refused;
}

function printHelp(): void {
    console.log("Usage: magic-context doctor repair-db");
    console.log("");
    console.log("Back up and salvage the shared context.db using SQLite .recover.");
    console.log(
        "If salvage is impossible, an empty reset is offered with a separate confirmation.",
    );
    console.log(
        "Salvage needs a sqlite3 shell built with SQLITE_ENABLE_DBPAGE_VTAB; without one, the command backs up and stops without modifying the database.",
    );
}

export async function runRepairDb(options: RunRepairDbOptions = {}): Promise<RepairDbExitCode> {
    const prompts = options.prompts ?? promptIO;
    const deps: RepairDbDeps = { ...DEFAULT_DEPS, ...options.deps };
    const storageDir =
        options.storageDir ??
        dirname(options.dbPath ?? join(getMagicContextStorageDir(), "context.db"));
    const dbPath = options.dbPath ?? join(storageDir, "context.db");
    const stamp = timestamp(deps.now());

    prompts.intro("Magic Context — Repair shared database");
    prompts.log.info(`Database: ${dbPath}`);
    if (!existsSync(dbPath)) {
        prompts.log.error(`Database not found: ${dbPath}`);
        prompts.log.info("Backup: not created (database does not exist)");
        prompts.outro("Database repair failed");
        return REPAIR_DB_EXIT.failed;
    }

    const initialInspection = deps.inspectHolders(storageDir);
    if (!initialInspection.safe) return reportSafetyRefusal(prompts, dbPath, initialInspection);

    let backup: BackupBundle;
    try {
        backup = copyBackupBundle(dbPath, stamp);
    } catch (error) {
        prompts.log.error(
            `Could not complete the required backup: ${error instanceof Error ? error.message : String(error)}`,
        );
        prompts.log.info(`Backup base: ${dbPath}.corrupt-backup-${stamp}`);
        prompts.outro("Database repair stopped before salvage");
        return REPAIR_DB_EXIT.failed;
    }
    for (const path of backup.copiedPaths) prompts.log.info(`Backup: ${path}`);

    const workingBase = uniqueBase(`${dbPath}.recovering-${stamp}-${process.pid}`);
    const countSourcePath = `${workingBase}.count-source`;
    const recoverSourcePath = `${workingBase}.recover-source`;
    try {
        copyDatabaseBundle(backup.basePath, countSourcePath);
    } catch (error) {
        removeRecoveryBundle(countSourcePath);
        prompts.log.error(
            `Could not prepare the isolated row-count snapshot: ${error instanceof Error ? error.message : String(error)}`,
        );
        prompts.log.info(`Database remains unchanged: ${dbPath}`);
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database repair stopped before salvage");
        return REPAIR_DB_EXIT.failed;
    }
    const beforeCounts = readRowCounts(countSourcePath);
    removeRecoveryBundle(countSourcePath);
    reportCounts(prompts, "BEFORE", beforeCounts);

    try {
        copyDatabaseBundle(backup.basePath, recoverSourcePath);
    } catch (error) {
        removeRecoveryBundle(recoverSourcePath);
        prompts.log.error(
            `Could not prepare the isolated salvage snapshot: ${error instanceof Error ? error.message : String(error)}`,
        );
        prompts.log.info(`Database remains unchanged: ${dbPath}`);
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database repair stopped before salvage");
        return REPAIR_DB_EXIT.failed;
    }
    const recoveredPath = `${workingBase}.db`;
    const dumpPath = `${workingBase}.sql`;
    prompts.log.info(`Attempting SQLite .recover into fresh database: ${recoveredPath}`);
    const salvage = runRecoverShell(
        deps.sqliteExecutable,
        recoverSourcePath,
        recoveredPath,
        dumpPath,
    );
    removeRecoveryBundle(recoverSourcePath);
    if (!salvage.ok && !salvage.attempted) {
        removeRecoveryBundle(recoveredPath);
        const unavailableAfter = Object.fromEntries(
            ROW_COUNT_TABLES.map((table) => [table, null]),
        ) as RowCounts;
        reportCounts(prompts, "AFTER", unavailableAfter);
        reportSalvageRates(prompts, beforeCounts, unavailableAfter);
        prompts.log.error(`SQLite .recover could not be started: ${salvage.detail}`);
        prompts.log.info(
            "Install the SQLite command-line shell (sqlite3), then rerun this command. Reset was not offered because salvage did not run.",
        );
        prompts.log.info(`Database remains unchanged: ${dbPath}`);
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database repair stopped before salvage could run");
        return REPAIR_DB_EXIT.failed;
    }
    if (!salvage.ok && salvage.unavailable) {
        // Same posture as the could-not-start branch above: no verdict about the
        // DATA may be drawn from a tool that lacks a feature. The database stays
        // untouched, the backup is named, and the destructive reset is never
        // offered — exit code `failed`, not `unsalvageable`.
        removeRecoveryBundle(recoveredPath);
        const unavailableAfter = Object.fromEntries(
            ROW_COUNT_TABLES.map((table) => [table, null]),
        ) as RowCounts;
        reportCounts(prompts, "AFTER", unavailableAfter);
        reportSalvageRates(prompts, beforeCounts, unavailableAfter);
        prompts.log.error(`SQLite .recover is unavailable on this machine: ${salvage.detail}`);
        prompts.log.info(
            "This sqlite3 was built without SQLITE_ENABLE_DBPAGE_VTAB, the compile-time option .recover needs. That is a limitation of the tool, not a verdict about your data: the database may be perfectly salvageable with a full sqlite3 build. Install the official SQLite command-line binary (sqlite.org/download.html) or a distro package built with SQLITE_ENABLE_DBPAGE_VTAB, then rerun this command. Reset was not offered because salvage did not run.",
        );
        prompts.log.info(`Database remains unchanged: ${dbPath}`);
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database repair stopped: this sqlite3 cannot run .recover");
        return REPAIR_DB_EXIT.failed;
    }
    let salvageResult: SalvageResult;
    if (salvage.ok) {
        salvageResult = migrateAndCheckRecoveredDatabase(recoveredPath, (before) => {
            if (before >= CLI_SCHEMA_FLOOR_VERSION) return;
            let fences: CachedPluginFence[] = [];
            try {
                fences = deps.listPluginFences();
            } catch {
                // An unreadable plugin cache only loses the per-copy detail.
            }
            for (const line of schemaMigrationWarning(before, fences)) prompts.log.warn(line);
        });
    } else {
        salvageResult = salvage;
    }

    if (salvageResult.ok && salvageResult.afterCounts) {
        const finalInspection = deps.inspectHolders(storageDir);
        if (!finalInspection.safe) {
            removeRecoveryBundle(recoveredPath);
            return reportSafetyRefusal(prompts, dbPath, finalInspection, backup.basePath);
        }
        try {
            const originalAsidePath = uniqueBase(`${dbPath}.corrupt-original-${stamp}`);
            const moved = activateReplacement(dbPath, recoveredPath, originalAsidePath);
            reportSchemaTransition(prompts, salvageResult);
            reportCounts(prompts, "AFTER", salvageResult.afterCounts);
            reportSalvageRates(prompts, beforeCounts, salvageResult.afterCounts);
            for (const path of moved) prompts.log.info(`Corrupt original preserved: ${path}`);
            prompts.log.success(`Salvaged database installed: ${dbPath}`);
            prompts.log.info(`Backup base: ${backup.basePath}`);
            prompts.outro("Database salvage complete; restart your harness");
            return REPAIR_DB_EXIT.salvaged;
        } catch (error) {
            salvageResult = {
                ok: false,
                detail: `could not install recovered database: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    removeRecoveryBundle(recoveredPath);
    const unavailableAfter = Object.fromEntries(
        ROW_COUNT_TABLES.map((table) => [table, null]),
    ) as RowCounts;
    reportCounts(prompts, "AFTER", unavailableAfter);
    reportSalvageRates(prompts, beforeCounts, unavailableAfter);
    prompts.log.error(
        `SQLite salvage was unsuccessful: ${salvageResult.detail ?? "unknown error"}`,
    );
    prompts.log.info(`Database remains unchanged: ${dbPath}`);
    prompts.log.info(`Backup base: ${backup.basePath}`);

    const confirmed = await prompts.confirm(
        "Salvage failed. Move the corrupt database aside and create a fresh empty database? This discards all unrecovered data from the active database.",
        false,
    );
    if (!confirmed) {
        prompts.log.info("Reset declined. The corrupt database remains in place.");
        prompts.outro("Database is unsalvageable by this command; backup retained");
        return REPAIR_DB_EXIT.unsalvageable;
    }

    const resetInspection = deps.inspectHolders(storageDir);
    if (!resetInspection.safe) {
        return reportSafetyRefusal(prompts, dbPath, resetInspection, backup.basePath);
    }

    const freshPath = `${workingBase}.fresh.db`;
    const fresh = prepareFreshDatabase(freshPath);
    if (!fresh.ok || !fresh.afterCounts) {
        removeRecoveryBundle(freshPath);
        prompts.log.error(`Could not create a fresh database: ${fresh.detail ?? "unknown error"}`);
        prompts.log.info(`Database remains unchanged: ${dbPath}`);
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database reset failed");
        return REPAIR_DB_EXIT.failed;
    }

    try {
        const originalAsidePath = uniqueBase(`${dbPath}.corrupt-original-${stamp}`);
        const moved = activateReplacement(dbPath, freshPath, originalAsidePath);
        reportSchemaTransition(prompts, fresh);
        reportCounts(prompts, "AFTER", fresh.afterCounts);
        reportSalvageRates(prompts, beforeCounts, fresh.afterCounts);
        for (const path of moved) prompts.log.info(`Corrupt original preserved: ${path}`);
        prompts.log.success(
            `Fresh database installed after explicit reset confirmation: ${dbPath}`,
        );
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database reset complete; restart your harness");
        return REPAIR_DB_EXIT.salvaged;
    } catch (error) {
        prompts.log.error(
            `Could not install the fresh database: ${error instanceof Error ? error.message : String(error)}`,
        );
        prompts.log.info(`Database remains unchanged: ${dbPath}`);
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database reset failed");
        return REPAIR_DB_EXIT.failed;
    }
}

export async function runRepairDbCli(
    args: string[],
    options: RunRepairDbOptions = {},
): Promise<RepairDbExitCode> {
    if (args.includes("--help") || args.includes("-h")) {
        printHelp();
        return REPAIR_DB_EXIT.salvaged;
    }
    return runRepairDb(options);
}
