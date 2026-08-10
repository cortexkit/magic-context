import {
    chmodSync,
    copyFileSync,
    cpSync,
    type Dirent,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { bootQuietRemainingMs, scheduleAfterBootQuiet } from "../../plugin/boot-quiet";
import {
    getLegacyOpenCodeMagicContextStorageDir,
    getMagicContextStorageDir,
} from "../../shared/data-path";
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import { isPidAlive, isPidIdentityPlausible, parseRpcPortFile } from "../../shared/rpc-utils";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { shouldEnforcePrivateStoragePermissions } from "../../shared/storage-permissions";
import { ensureContextStoreUuid } from "./context-authority";
import type { FailClosedBlockingProcess } from "./fail-closed-block";
import { FORK_MIGRATION_VERSION_FLOOR, runMigrations, runMigrationsWithRetry } from "./migrations";
import { ensureColumn, healAllNullColumns } from "./storage-schema-helpers";
import {
    loadToolDefinitionMeasurements,
    setDatabase as setToolDefinitionDatabase,
} from "./tool-definition-tokens";
import { runToolOwnerBackfill } from "./tool-owner-backfill";

// Re-exported so existing `from "./storage-db"` importers (and tests) keep
// resolving these; the definitions live in the leaf module to break the
// storage-db <-> migrations import cycle.
export { ensureColumn, FORK_MIGRATION_VERSION_FLOOR, healAllNullColumns };

const databases = new Map<string, Database>();
const pendingAsyncOpens = new Map<string, Promise<Database | null>>();
const persistenceByDatabase = new WeakMap<Database, boolean>();
const persistenceErrorByDatabase = new WeakMap<Database, string>();
const pathByDatabase = new WeakMap<Database, string>();

// Last schema-fence rejection, recorded so startup can surface a user-facing
// message (not just a log line). When OpenCode and Pi share context.db and one
// harness auto-updates first, it migrates the DB to a newer schema; the lagging
// harness's older binary then refuses to open the DB (fail-closed) and silently
// disables ALL of Magic Context until it too updates. The null openDatabase()
// return has no Database handle to key a WeakMap on, so we stash the detail in
// a module global the plugin entrypoint reads after a failed/empty open.
let lastSchemaFenceRejection: { persistedVersion: number; supportedVersion: number } | null = null;

// A fresh CLI/Pi/OpenCode process must not be the process that advances the
// shared schema while a live OpenCode server still holds the old build in memory.
// The port files are the server's durable liveness signal; this latch lets callers
// distinguish that intentional refusal from ordinary storage failures.
export interface MigrationOnOpenRefusal {
    persistedVersion: number;
    supportedVersion: number;
    serverPids: number[];
    unreadableFile?: string;
    unreadableArm?: "parse" | "io";
}

let lastMigrationOnOpenRefusal: MigrationOnOpenRefusal | null = null;

export function getSchemaFenceRejection(): {
    persistedVersion: number;
    supportedVersion: number;
} | null {
    return lastSchemaFenceRejection;
}

export function getMigrationOnOpenRefusal(): MigrationOnOpenRefusal | null {
    return lastMigrationOnOpenRefusal;
}

/** Test seam for isolated schema-fence and migration-guard scenarios. */
export function __resetSchemaFenceStateForTests(): void {
    lastSchemaFenceRejection = null;
    lastMigrationOnOpenRefusal = null;
}

export const LATEST_SUPPORTED_VERSION = 75;

// chmod is meaningless on Windows (POSIX modes are not honored), so all
// permission tightening is skipped there. mkdir's `mode` is likewise ignored.
const PERMISSIONS_ENFORCEABLE = process.platform !== "win32";

const defaultStoragePermissionFs = { chmodSync, mkdirSync };
let storagePermissionFs = defaultStoragePermissionFs;

/** Test seam: captures permission-changing calls without changing real fixture modes. */
export function __setStoragePermissionFsForTests(
    overrides: Partial<typeof defaultStoragePermissionFs>,
): void {
    storagePermissionFs = { ...defaultStoragePermissionFs, ...overrides };
}

export function __resetStoragePermissionFsForTests(): void {
    storagePermissionFs = defaultStoragePermissionFs;
}

/**
 * Create `dir` recursively. When private permissions are enabled, also create
 * and tighten it to owner-only 0o700. When an operator manages trusted-group
 * permissions, do not pass a mode or chmod an existing directory.
 */
function ensureSecureStorageDir(dir: string): void {
    if (!shouldEnforcePrivateStoragePermissions()) {
        storagePermissionFs.mkdirSync(dir, { recursive: true });
        return;
    }

    storagePermissionFs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!PERMISSIONS_ENFORCEABLE) return;
    try {
        storagePermissionFs.chmodSync(dir, 0o700);
    } catch (error) {
        log(
            `[magic-context] could not restrict storage dir permissions on ${dir}: ${getErrorMessage(error)}`,
        );
    }
}

/**
 * Restrict the SQLite DB file and its WAL/SHM sidecars to owner-only (0o600)
 * only when Magic Context owns storage permission management. A trusted-group
 * deployment keeps the operator's modes unchanged, including sidecars.
 */
function restrictDatabaseFilePermissions(dbPath: string): void {
    if (!PERMISSIONS_ENFORCEABLE || !shouldEnforcePrivateStoragePermissions()) return;
    for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${dbPath}${suffix}`;
        if (!existsSync(file)) continue;
        try {
            storagePermissionFs.chmodSync(file, 0o600);
        } catch (error) {
            log(
                `[magic-context] could not restrict DB file permissions on ${file}: ${getErrorMessage(error)}`,
            );
        }
    }
}

export interface OpenDatabaseOptions {
    dbPath?: string;
    latestSupportedVersion?: number;
}

// Exported for the test-isolation guard test. Returns a PATH only — opens no DB —
// so a regression assertion is safe even if the resolution is wrong.
export function resolveDatabasePath(dbPathOverride?: string): { dbDir: string; dbPath: string } {
    if (dbPathOverride) {
        return { dbDir: dirname(dbPathOverride), dbPath: dbPathOverride };
    }
    // Test-isolation guards (MAGIC_CONTEXT_TEST_DATA_DIR + the CWD-independent
    // NODE_ENV backstop) both live in getMagicContextStorageDir(), so this
    // resolver and every direct caller of that helper are covered by one
    // implementation. See its doc comment for the incident history.
    const dbDir = getMagicContextStorageDir();
    return { dbDir, dbPath: join(dbDir, "context.db") };
}

export function getDatabasePath(db: Database): string | null {
    return pathByDatabase.get(db) ?? null;
}

/**
 * One-time migration of pre-cortexkit OpenCode plugin data into the shared
 * cortexkit/magic-context location. Runs lazily on first openDatabase() call.
 *
 * Safety guarantees:
 *   - Only runs when target DB does not yet exist (idempotent on subsequent
 *     boots; never overwrites newer state).
 *   - Only runs when legacy DB exists (no-op for fresh installs and Pi).
 *   - Copies WAL/SHM sidecars too — WAL mode means uncheckpointed writes live
 *     there, so omitting them would lose recent data.
 *   - Copies the embedding model cache subdirectory if present, avoiding
 *     re-download on first post-migration boot.
 *   - Leaves legacy files in place as a manual rollback path. Manual cleanup
 *     is safe after one stable release.
 */
function migrateLegacyStorageIfNeeded(targetDbPath: string, targetDbDir: string): void {
    if (existsSync(targetDbPath)) return;

    const legacyDir = getLegacyOpenCodeMagicContextStorageDir();
    const legacyDbPath = join(legacyDir, "context.db");
    if (!existsSync(legacyDbPath)) return;

    log(
        `[magic-context] migrating legacy plugin storage: ${legacyDir} -> ${targetDbDir} (legacy left in place as backup)`,
    );
    ensureSecureStorageDir(targetDbDir);

    // Fold the legacy WAL into the main DB FIRST so the copied target is one
    // crash-consistent file. Copying .db/-wal/-shm as three separate files is
    // not atomic: if a legacy process is concurrently writing (or the -wal/-shm
    // are mid-update), the three snapshots can be mutually inconsistent and the
    // target opens corrupt or loses recent writes. wal_checkpoint(TRUNCATE)
    // writes all committed WAL frames back into the main file and empties the
    // WAL, after which the .db alone is complete. Best-effort: if the checkpoint
    // fails (legacy locked by a live writer), we still fall back to copying all
    // three sidecars below.
    try {
        const legacyDb = new Database(legacyDbPath);
        try {
            legacyDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally {
            closeQuietly(legacyDb);
        }
    } catch (error) {
        log(
            `[magic-context] legacy WAL checkpoint before copy failed (continuing with sidecar copy): ${getErrorMessage(error)}`,
        );
    }

    // Copy main DB + WAL/SHM sidecars. After a successful checkpoint the -wal is
    // empty and the .db is self-contained, but we still copy the sidecars in
    // case the checkpoint was skipped (legacy locked) so uncheckpointed writes
    // aren't lost.
    for (const suffix of ["", "-wal", "-shm"]) {
        const src = `${legacyDbPath}${suffix}`;
        const dst = join(targetDbDir, `context.db${suffix}`);
        if (existsSync(src)) {
            try {
                copyFileSync(src, dst);
            } catch (error) {
                log(`[magic-context] failed to copy ${src}:`, getErrorMessage(error));
            }
        }
    }

    // Copy the embedding model cache subdir to avoid re-downloading on first boot.
    const legacyModelsDir = join(legacyDir, "models");
    const targetModelsDir = join(targetDbDir, "models");
    if (existsSync(legacyModelsDir) && !existsSync(targetModelsDir)) {
        try {
            cpSync(legacyModelsDir, targetModelsDir, { recursive: true });
        } catch (error) {
            log("[magic-context] failed to copy embedding model cache:", getErrorMessage(error));
        }
    }
}

export function getPersistedSchemaVersion(db: Database): number {
    const hasMigrationsTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get();
    if (!hasMigrationsTable) {
        return 0;
    }
    const row = db
        .prepare(
            "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE version < ?",
        )
        .get(FORK_MIGRATION_VERSION_FLOOR) as { version: number } | undefined;
    return row?.version ?? 0;
}

export function schemaVersionIsSupported(
    db: Database,
    latestSupportedVersion = LATEST_SUPPORTED_VERSION,
): boolean {
    return getPersistedSchemaVersion(db) <= latestSupportedVersion;
}

/** Log the upstream-lane version so operators can compare it to this build's fence. */
export function formatSchemaFenceBootLog(
    persistedVersion: number,
    supportedVersion: number,
): string {
    return `[magic-context] upstream migration lane at boot: database=v${persistedVersion}, supported_fence=v${supportedVersion}`;
}

function getRuntimeLatestSupportedVersion(options?: OpenDatabaseOptions): number {
    if (options?.latestSupportedVersion !== undefined) {
        return options.latestSupportedVersion;
    }
    const override = process.env.MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION;
    if (override) {
        const parsed = Number.parseInt(override, 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return LATEST_SUPPORTED_VERSION;
}

export function enforceSchemaFence(
    db: Database,
    dbPath: string,
    latestSupportedVersion: number,
): boolean {
    const persistedVersion = getPersistedSchemaVersion(db);
    if (persistedVersion <= latestSupportedVersion) {
        lastSchemaFenceRejection = null;
        return true;
    }
    lastSchemaFenceRejection = { persistedVersion, supportedVersion: latestSupportedVersion };
    log(
        `[magic-context] storage fatal: refusing to open ${dbPath}; upstream migration lane v${persistedVersion} is newer than this binary supports (max v${latestSupportedVersion}). A pinned or stale plugin is likely sharing this database with a newer instance; update or unpin Magic Context with 'npx @cortexkit/magic-context@latest doctor --force', then restart.`,
    );
    return false;
}

export type RpcDiscoveryUnreadableArm = "parse" | "io";

export interface RpcServerDiscovery {
    state: "absent" | "stale" | "live" | "unreadable";
    serverPids: number[];
    staleFiles: string[];
    unreadableFile?: string;
    unreadableArm?: RpcDiscoveryUnreadableArm;
}

function unreadableDiscovery(path: string, arm: RpcDiscoveryUnreadableArm): RpcServerDiscovery {
    return {
        state: "unreadable",
        serverPids: [],
        staleFiles: [],
        unreadableFile: path,
        unreadableArm: arm,
    };
}

const RPC_DISCOVERY_PARSE_GRACE_MS = 10 * 60 * 1000;

export interface RpcDiscoveryFs {
    readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | Dirent[];
    readFileSync(path: string, encoding: "utf8"): string;
    statSync(path: string): { mtimeMs: number };
    unlinkSync(path: string): void;
}

const defaultRpcDiscoveryFs: RpcDiscoveryFs = {
    readdirSync: (path, options) =>
        options?.withFileTypes
            ? (readdirSync(path, { withFileTypes: true }) as Dirent[])
            : (readdirSync(path) as string[]),
    readFileSync: (path, encoding) => String(readFileSync(path, encoding)),
    statSync: (path) => ({ mtimeMs: statSync(path).mtimeMs }),
    unlinkSync: (path) => unlinkSync(path),
};
let rpcDiscoveryFs = defaultRpcDiscoveryFs;

/** Allows tests to simulate discovery filesystem errors and verify they reject the result rather than treating it as a valid server record. */
export function __setRpcDiscoveryFsForTests(overrides: Partial<RpcDiscoveryFs>): void {
    rpcDiscoveryFs = { ...defaultRpcDiscoveryFs, ...overrides };
}

export function __resetRpcDiscoveryFsForTests(): void {
    rpcDiscoveryFs = defaultRpcDiscoveryFs;
}

type RpcDiscoveryJunkReason = "parse-invalid" | "invalid-pid";

function invalidDiscoveryReason(raw: string): RpcDiscoveryJunkReason {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed) as { pid?: unknown };
            if ("pid" in parsed) {
                const pid = Number(parsed.pid);
                if (!Number.isInteger(pid) || pid <= 0) return "invalid-pid";
            }
        } catch {
            // The malformed JSON is a parse-invalid record, not an I/O failure.
        }
    }
    // A legacy file containing only a port, with no server PID, is invalid and
    // cannot be accepted while deciding whether migration is safe.
    return "parse-invalid";
}

function classifyJunkDiscovery(
    portFile: string,
    raw: string,
    staleFiles: string[],
): RpcServerDiscovery | null {
    let mtimeMs: number;
    try {
        mtimeMs = rpcDiscoveryFs.statSync(portFile).mtimeMs;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        return unreadableDiscovery(portFile, "io");
    }
    const ageMs = Date.now() - mtimeMs;
    if (!Number.isFinite(ageMs) || ageMs < RPC_DISCOVERY_PARSE_GRACE_MS) {
        return unreadableDiscovery(portFile, "parse");
    }

    staleFiles.push(portFile);
    const reason = invalidDiscoveryReason(raw);
    log(
        `[magic-context] removing stale RPC discovery file ${portFile}: ${reason} record older than 10 minutes`,
    );
    return null;
}

/**
 * Inspect the shared RPC discovery tree without treating partial evidence as
 * proof that no server is running. A missing/empty tree is a clean machine;
 * dead-PID and old malformed files are removed; fresh malformed or unreadable
 * evidence is fail-closed because it could be a concurrent write or an I/O
 * permission problem.
 */
export function inspectRpcServerDiscovery(storageDir: string): RpcServerDiscovery {
    const rpcRoot = join(storageDir, "rpc");
    let projectEntries: Dirent[];
    try {
        projectEntries = rpcDiscoveryFs.readdirSync(rpcRoot, { withFileTypes: true }) as Dirent[];
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { state: "absent", serverPids: [], staleFiles: [] };
        }
        return unreadableDiscovery(rpcRoot, "io");
    }

    const portFiles: string[] = [];
    for (const projectEntry of projectEntries) {
        if (!projectEntry.isDirectory()) continue;
        const projectDir = join(rpcRoot, projectEntry.name);
        let entries: string[];
        try {
            entries = rpcDiscoveryFs.readdirSync(projectDir) as string[];
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            return unreadableDiscovery(projectDir, "io");
        }
        for (const entry of entries) {
            if (entry === "port" || (entry.startsWith("port-") && entry.endsWith(".json"))) {
                portFiles.push(join(projectDir, entry));
            }
        }
    }
    if (portFiles.length === 0) {
        return { state: "absent", serverPids: [], staleFiles: [] };
    }

    const pids = new Set<number>();
    const staleFiles: string[] = [];
    for (const portFile of portFiles) {
        let raw: string;
        try {
            raw = rpcDiscoveryFs.readFileSync(portFile, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            return unreadableDiscovery(portFile, "io");
        }
        const filename = basename(portFile);
        const pidFromName = /^port-(\d+)/.exec(filename)?.[1];
        const fallbackPid = pidFromName ? Number(pidFromName) : 0;
        const record = parseRpcPortFile(raw, fallbackPid);
        if (!record || !Number.isInteger(record.pid) || record.pid <= 0) {
            const junk = classifyJunkDiscovery(portFile, raw, staleFiles);
            if (junk) return junk;
            continue;
        }
        if (isPidAlive(record.pid) && isPidIdentityPlausible(record)) pids.add(record.pid);
        else staleFiles.push(portFile);
    }

    // Remove stale evidence even when another record still proves that a server
    // is live. Leaving reused-PID files behind expands the collision surface on
    // every subsequent database-open guard pass.
    for (const staleFile of staleFiles) {
        try {
            rpcDiscoveryFs.unlinkSync(staleFile);
        } catch {
            return unreadableDiscovery(staleFile, "io");
        }
    }

    const serverPids = [...pids].sort((a, b) => a - b);
    if (serverPids.length > 0) {
        return { state: "live", serverPids, staleFiles };
    }
    return { state: "stale", serverPids: [], staleFiles };
}

/** Return the live OpenCode servers that would block an on-open migration. */
export function getLiveMigrationBlockingProcesses(storageDir: string): FailClosedBlockingProcess[] {
    const discovery = inspectRpcServerDiscovery(storageDir);
    if (discovery.state !== "live") return [];
    return discovery.serverPids.map((pid) => ({ harness: "OpenCode server", pid }));
}

/**
 * Refuse an on-open migration when another live OpenCode server still has this
 * shared DB open. That server loaded its plugin dist at boot and cannot observe
 * the new fence, so migrating here would strand every session it creates later.
 */
function enforceMigrationOnOpenGuard(
    db: Database,
    dbPath: string,
    dbDir: string,
    latestSupportedVersion: number,
): boolean {
    const persistedVersion = getPersistedSchemaVersion(db);
    if (persistedVersion >= latestSupportedVersion) {
        lastMigrationOnOpenRefusal = null;
        return true;
    }
    const discovery = inspectRpcServerDiscovery(dbDir);
    if (discovery.state === "absent" || discovery.state === "stale") {
        lastMigrationOnOpenRefusal = null;
        return true;
    }
    lastMigrationOnOpenRefusal = {
        persistedVersion,
        supportedVersion: latestSupportedVersion,
        serverPids: discovery.serverPids,
        ...(discovery.unreadableFile ? { unreadableFile: discovery.unreadableFile } : {}),
        ...(discovery.unreadableArm ? { unreadableArm: discovery.unreadableArm } : {}),
    };
    if (discovery.state === "unreadable") {
        const unreadableFile = discovery.unreadableFile ?? "<unknown>";
        const arm = discovery.unreadableArm ?? "io";
        const recovery =
            arm === "io"
                ? `If no OpenCode server is running, it is safe to delete ${unreadableFile} and retry.`
                : `Retry after the file is older than the ten-minute grace window, or stop OpenCode before deleting it.`;
        log(
            `[magic-context] storage fatal: refusing to migrate ${dbPath} from upstream migration v${persistedVersion} to v${latestSupportedVersion} because RPC discovery file ${unreadableFile} is uncertain (${arm} arm), so the absence of a live OpenCode server cannot be proven. ${recovery}`,
        );
    } else {
        log(
            `[magic-context] storage fatal: refusing to migrate ${dbPath} from upstream migration v${persistedVersion} to v${latestSupportedVersion} while live OpenCode server PID(s) ${discovery.serverPids.join(", ")} may still use the old plugin build. Restart OpenCode, then retry this process.`,
        );
    }
    return false;
}

// Per-connection SQLite tuning, settable once at plugin init (before the first
// openDatabase) so the 27 openDatabase call sites don't each need config
// threading. Defaults match the config schema (64 MiB cache, mmap disabled) so
// tests and early-init opens still get sane values.
let sqlitePragmaConfig: { cacheSizeMb: number; mmapSizeMb: number } = {
    cacheSizeMb: 64,
    mmapSizeMb: 0,
};

export function setSqlitePragmaConfig(config: { cacheSizeMb: number; mmapSizeMb: number }): void {
    sqlitePragmaConfig = config;
}

/**
 * Apply the tunable per-connection PRAGMAs (cache_size, mmap_size,
 * analysis_limit) from the current `sqlitePragmaConfig`. Idempotent and safe on
 * an already-open connection — cache_size/mmap_size take effect immediately —
 * so harnesses that open the DB before loading config (Pi) can call this once
 * config is available without reopening.
 */
export function applySqliteTuningPragmas(db: Database): void {
    // cache_size negative value = KiB of page cache (e.g. -65536 = 64 MiB).
    db.exec(`PRAGMA cache_size=-${Math.round(sqlitePragmaConfig.cacheSizeMb * 1024)}`);
    db.exec(`PRAGMA mmap_size=${Math.round(sqlitePragmaConfig.mmapSizeMb * 1024 * 1024)}`);
    // Bound any ANALYZE that a later PRAGMA optimize triggers on this connection.
    db.exec("PRAGMA analysis_limit=400");
}

/**
 * Run SQLite's self-gating planner-stats refresh. `analysis_limit=400` caps the
 * rows sampled per index so even a huge table can't cause a multi-second
 * ANALYZE; `optimize` then re-analyzes only tables whose row counts drifted
 * since the last ANALYZE (a no-op otherwise). Cheap to call periodically.
 */
export function runSqliteOptimize(db: Database): void {
    try {
        db.exec("PRAGMA analysis_limit=400");
        db.exec("PRAGMA optimize");
    } catch {
        // Best-effort maintenance; never fail a caller over stats refresh.
    }
}

function finishDatabaseOpen(
    db: Database,
    dbPath: string,
    explicitDbPath: boolean,
    latestSupportedVersion: number,
): Database | null {
    if (!enforceSchemaFence(db, dbPath, latestSupportedVersion)) {
        closeQuietly(db);
        return null;
    }
    // Recover any Channel-2 ceiling-nudge lease left at `claimed` by a crash
    // mid-delivery (see healWedgedChannel2Claims). Fresh opens and later
    // cached-handle reuses both run this TTL-scoped heal so long-lived
    // processes eventually unwind stuck stale claims without a restart.
    healWedgedChannel2Claims(db);
    // Initial boot-time backfill populates tool_owner_message_id on legacy tool
    // tags. The module short-circuits when every session is already complete or
    // skipped, so re-running it is cheap.
    //
    // The backfill is best-effort: missing OpenCode DB, transient
    // SQLite errors, and per-session failures are logged but
    // never fail-close the plugin. Lazy adoption covers rows the backfill could
    // not reach.
    if (!explicitDbPath) {
        const runBackfill = () => {
            try {
                runToolOwnerBackfill(db);
            } catch (error) {
                log(
                    `[magic-context] tool-owner backfill failed (continuing with lazy adoption fallback): ${getErrorMessage(error)}`,
                );
            }
        };
        if (bootQuietRemainingMs() > 0) scheduleAfterBootQuiet(runBackfill);
        else runBackfill();
    }
    // Wire the persistence-backed tool-definition measurement store and
    // rehydrate the in-memory map from any prior writes. Doing this here
    // (after migrations) means migration v9 has already created the
    // `tool_definition_measurements` table, so loadToolDefinitionMeasurements
    // never hits a missing-table failure path.
    setToolDefinitionDatabase(db);
    loadToolDefinitionMeasurements(db);
    // When enabled, tighten the DB + WAL/SHM sidecars now that WAL mode has
    // created them. Externally managed trusted-group storage skips this entirely.
    restrictDatabaseFilePermissions(dbPath);
    databases.set(dbPath, db);
    pathByDatabase.set(db, dbPath);
    persistenceByDatabase.set(db, true);
    persistenceErrorByDatabase.delete(db);
    if (!explicitDbPath) {
        log(formatSchemaFenceBootLog(getPersistedSchemaVersion(db), latestSupportedVersion));
    }
    return db;
}

export function initializeDatabase(db: Database): void {
    // Install the busy timeout BEFORE any file-level PRAGMAs like WAL. Two
    // processes can cold-open the same DB at once (real OpenCode/Pi startup, or
    // the subprocess lease tests); without the timeout this connection can throw
    // SQLITE_BUSY immediately while the sibling is switching journal mode.
    db.exec("PRAGMA busy_timeout=5000");
    // SQLite per-connection PRAGMAs. foreign_keys MUST run before any reads
    // or writes: it defaults to OFF, which silently breaks every ON DELETE
    // CASCADE / SET NULL declared in the schema below and in migrations.
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA journal_mode=WAL");
    applySqliteTuningPragmas(db);
    db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      byte_size INTEGER,
      tag_number INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode',
      entry_fingerprint TEXT,
      token_count INTEGER,
      input_token_count INTEGER,
      reasoning_token_count INTEGER,
      UNIQUE(session_id, tag_number)
    );

    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

    CREATE TABLE IF NOT EXISTS source_contents (
      tag_id INTEGER,
      session_id TEXT,
      content TEXT,
      created_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode',
      PRIMARY KEY(session_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      start_message INTEGER NOT NULL,
      end_message INTEGER NOT NULL,
      start_message_id TEXT DEFAULT '',
      end_message_id TEXT DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      p1 TEXT,
      p2 TEXT,
      p3 TEXT,
      p4 TEXT,
      importance INTEGER NOT NULL DEFAULT 50,
      episode_type TEXT,
      p1_embedding BLOB,
      p1_embedding_model_id TEXT,
      legacy INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      UNIQUE(session_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_compartments_session ON compartments(session_id);

    CREATE TABLE IF NOT EXISTS compartment_chunk_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      window_index INTEGER NOT NULL DEFAULT 0,
      start_ordinal INTEGER NOT NULL,
      end_ordinal INTEGER NOT NULL,
      chunk_hash TEXT NOT NULL,
      model_id TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(compartment_id, model_id, window_index)
    );
    CREATE INDEX IF NOT EXISTS idx_cce_session ON compartment_chunk_embeddings(session_id);
    CREATE INDEX IF NOT EXISTS idx_cce_project_model ON compartment_chunk_embeddings(project_path, model_id);

    CREATE TABLE IF NOT EXISTS session_projects (
      session_id TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      project_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, harness)
    );
    CREATE INDEX IF NOT EXISTS idx_session_projects_project
      ON session_projects(project_path);

    CREATE TABLE IF NOT EXISTS compartment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      compartment_id INTEGER,
      kind TEXT NOT NULL,
      at_compartment INTEGER,
      fields_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
    CREATE INDEX IF NOT EXISTS idx_compartment_events_session
      ON compartment_events(session_id);

    CREATE TABLE IF NOT EXISTS compartment_state_lease (
      session_id TEXT PRIMARY KEY NOT NULL,
      holder_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_compartment_state_lease_expires
      ON compartment_state_lease(expires_at);

    CREATE TABLE IF NOT EXISTS compression_depth (
      session_id TEXT NOT NULL,
      message_ordinal INTEGER NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode',
      PRIMARY KEY(session_id, message_ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_compression_depth_session ON compression_depth(session_id);

    CREATE TABLE IF NOT EXISTS session_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

    CREATE TABLE IF NOT EXISTS primer_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      session_id TEXT NOT NULL,
      question TEXT NOT NULL,
      normalized_question TEXT NOT NULL,
      source_compartment_start INTEGER,
      source_compartment_end INTEGER,
      source_start_message_id TEXT NOT NULL DEFAULT '',
      source_end_message_id TEXT NOT NULL DEFAULT '',
      source_message_time INTEGER NOT NULL,
      question_embedding BLOB,
      question_embedding_model_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(project_path, harness, session_id, source_start_message_id, source_end_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_primer_candidates_project_time
      ON primer_candidates(project_path, source_message_time);
    CREATE INDEX IF NOT EXISTS idx_primer_candidates_session
      ON primer_candidates(session_id, harness);
    CREATE INDEX IF NOT EXISTS idx_primer_candidates_embedding_model
      ON primer_candidates(project_path, question_embedding_model_id);

    CREATE TABLE IF NOT EXISTS primers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      question TEXT NOT NULL,
      question_embedding BLOB,
      question_embedding_model_id TEXT,
      answer TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
      total_support INTEGER NOT NULL DEFAULT 0,
      last_observed_at INTEGER,
      answer_refreshed_at INTEGER,
      source_candidate_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_primers_project_status_observed
      ON primers(project_path, status, last_observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_primers_embedding_model
      ON primers(project_path, question_embedding_model_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS primers_fts USING fts5(
      question,
      answer,
      project_path UNINDEXED,
      content='primers',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS primers_ai AFTER INSERT ON primers BEGIN
      INSERT INTO primers_fts(rowid, question, answer, project_path)
      VALUES (new.id, new.question, new.answer, new.project_path);
    END;

    CREATE TRIGGER IF NOT EXISTS primers_ad AFTER DELETE ON primers BEGIN
      INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
      VALUES ('delete', old.id, old.question, old.answer, old.project_path);
    END;

    CREATE TRIGGER IF NOT EXISTS primers_au AFTER UPDATE ON primers BEGIN
      INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
      VALUES ('delete', old.id, old.question, old.answer, old.project_path);
      INSERT INTO primers_fts(rowid, question, answer, project_path)
      VALUES (new.id, new.question, new.answer, new.project_path);
    END;

    -- session_notes and smart_notes were merged into the unified notes table
    -- by migration v1 (see features/magic-context/migrations.ts). The old tables
    -- are never recreated; fresh DBs create only notes, upgraded DBs have
    -- their old tables migrated and dropped by the migration runner.

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      importance INTEGER,
      scope TEXT NOT NULL DEFAULT 'project',
      shareable INTEGER NOT NULL DEFAULT 0,
      source_session_id TEXT,
      source_type TEXT DEFAULT 'historian',
      seen_count INTEGER DEFAULT 1,
      retrieval_count INTEGER DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_retrieved_at INTEGER,
      status TEXT DEFAULT 'active',
      expires_at INTEGER,
      verification_status TEXT DEFAULT 'unverified',
      verified_at INTEGER,
      classified_at INTEGER,
      superseded_by_memory_id INTEGER,
      merged_from TEXT,
      metadata_json TEXT,
      mural_cue TEXT,
      mural_cue_hash TEXT,
      mural_cue_at INTEGER,
      mural_cue_rejection_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(project_path, category, normalized_hash)
    );

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      -- FK-cascade audit (v12): memory_embeddings.memory_id -> memories.id
      -- uses ON DELETE CASCADE, so SQLite PRAGMA foreign_keys must be ON on
      -- every connection and v12 cleans historical orphan rows.
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model_id TEXT NOT NULL,
      PRIMARY KEY(memory_id, model_id)
    );

    CREATE TABLE IF NOT EXISTS embedding_identity_active (
      project_path TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('memory', 'commit', 'chunk')),
      model_id TEXT NOT NULL,
      last_active_at INTEGER NOT NULL,
      PRIMARY KEY(project_path, scope, model_id)
    );

    CREATE TABLE IF NOT EXISTS embedding_registrations (
      project_path TEXT PRIMARY KEY,
      provider_identity TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      chunk_model_id TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL DEFAULT '',
      table_epoch INTEGER NOT NULL DEFAULT 0,
      dims INTEGER NOT NULL DEFAULT 0,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      generation INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS synapse_batch_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      manifest_json TEXT NOT NULL DEFAULT '{}',
      request_key TEXT NOT NULL DEFAULT '',
      job_id TEXT,
      cursor TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, request_key)
    );
    CREATE INDEX IF NOT EXISTS idx_synapse_batch_ledger_session
      ON synapse_batch_ledger(session_id, updated_at);

    CREATE TABLE IF NOT EXISTS shadow_embedding_registrations (
      project_path TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('memory', 'commit', 'chunk')),
      model_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT NOT NULL DEFAULT '',
      table_epoch INTEGER NOT NULL DEFAULT 0,
      dims INTEGER NOT NULL DEFAULT 0,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_path, scope, model_id)
    );

    CREATE TABLE IF NOT EXISTS embedding_measurement_corpus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL DEFAULT '',
      dedup_key TEXT NOT NULL DEFAULT '',
      cohort_key TEXT NOT NULL DEFAULT '',
      query_text_hash TEXT NOT NULL DEFAULT '',
      primary_result_ids_json TEXT NOT NULL DEFAULT '[]',
      shadow_result_ids_json TEXT NOT NULL DEFAULT '[]',
      primary_latency_ms INTEGER,
      shadow_latency_ms INTEGER,
      primary_failed INTEGER NOT NULL DEFAULT 0,
      shadow_failed INTEGER NOT NULL DEFAULT 0,
      primary_model_id TEXT NOT NULL DEFAULT '',
      shadow_model_id TEXT NOT NULL DEFAULT '',
      primary_fingerprint TEXT NOT NULL DEFAULT '',
      shadow_fingerprint TEXT NOT NULL DEFAULT '',
      primary_epoch INTEGER NOT NULL DEFAULT 0,
      shadow_epoch INTEGER NOT NULL DEFAULT 0,
      corpus_hash TEXT NOT NULL DEFAULT '',
      coverage_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(dedup_key, cohort_key)
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_measurement_session
      ON embedding_measurement_corpus(session_id, created_at);

    CREATE TABLE IF NOT EXISTS memory_verifications (
      memory_id    INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      file_path    TEXT NOT NULL,
      -- verified_at=0 means "mapped (files known) but not yet content-verified".
      -- map-memories sets mapped_at + verified_at=0; verify sets verified_at=now.
      verified_at  INTEGER NOT NULL,
      mapped_at    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (memory_id, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_verifications_memory ON memory_verifications(memory_id);

    CREATE TABLE IF NOT EXISTS memory_mutation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      mutation_type TEXT NOT NULL CHECK (mutation_type IN ('archive', 'delete', 'update', 'superseded')),
      target_memory_id INTEGER NOT NULL,
      superseded_by_id INTEGER,
      category TEXT,
      new_content TEXT,
      queued_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
      ON memory_mutation_log(project_path, id);
    CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_visibility
      ON memory_mutation_log(project_path, category, id, target_memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_target
      ON memory_mutation_log(project_path, target_memory_id, id);

    CREATE TABLE IF NOT EXISTS dream_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dream_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      reason TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      started_at INTEGER,
      retry_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dream_queue_project ON dream_queue(project_path);
CREATE INDEX IF NOT EXISTS idx_dream_queue_pending ON dream_queue(started_at, enqueued_at);

    CREATE TABLE IF NOT EXISTS dream_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      holder_id TEXT NOT NULL,
      tasks_json TEXT NOT NULL,
      tasks_succeeded INTEGER NOT NULL DEFAULT 0,
      tasks_failed INTEGER NOT NULL DEFAULT 0,
      smart_notes_surfaced INTEGER NOT NULL DEFAULT 0,
      smart_notes_pending INTEGER NOT NULL DEFAULT 0,
      memory_changes_json TEXT,
      parent_session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dream_runs_project ON dream_runs(project_path, finished_at DESC);

    CREATE TABLE IF NOT EXISTS task_schedule_state (
      project_path  TEXT    NOT NULL,
      task          TEXT    NOT NULL,
      last_run_at   INTEGER,
      next_due_at   INTEGER,
      schedule      TEXT,
      last_status   TEXT,
      last_error    TEXT,
      last_checked_commit TEXT,
      last_broad_run_at INTEGER,
      retrospective_watermark_ms INTEGER,
      retry_count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_path, task)
    );
    CREATE INDEX IF NOT EXISTS idx_task_schedule_due ON task_schedule_state(next_due_at);

    CREATE TABLE IF NOT EXISTS retrospective_processed_windows (
      project_path TEXT NOT NULL,
      window_key   TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      PRIMARY KEY (project_path, window_key)
    );

    CREATE TABLE IF NOT EXISTS project_key_files (
      project_path           TEXT    NOT NULL,
      path                   TEXT    NOT NULL,
      content                TEXT    NOT NULL,
      content_hash           TEXT    NOT NULL,
      local_token_estimate   INTEGER NOT NULL,
      generated_at           INTEGER NOT NULL,
      generated_by_model     TEXT,
      generation_config_hash TEXT    NOT NULL,
      stale_reason           TEXT,
      PRIMARY KEY (project_path, path)
    );
    CREATE INDEX IF NOT EXISTS idx_project_key_files_project ON project_key_files(project_path);
    CREATE INDEX IF NOT EXISTS idx_project_key_files_generated_at ON project_key_files(project_path, generated_at);

    CREATE TABLE IF NOT EXISTS project_key_files_version (
      project_path TEXT    PRIMARY KEY,
      version      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS schema_migrations_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_state (
      project_path TEXT PRIMARY KEY,
      project_memory_epoch INTEGER NOT NULL DEFAULT 0,
      project_user_profile_version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS git_sweep_coordinator (
      project_path TEXT PRIMARY KEY,
      lease_holder TEXT,
      lease_expires_at INTEGER,
      last_swept_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_lease_expires
      ON git_sweep_coordinator(lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_last_swept
      ON git_sweep_coordinator(last_swept_at);

    CREATE TABLE IF NOT EXISTS m0_mutation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      mutation_type TEXT NOT NULL CHECK (mutation_type IN (
        'compartment_delete', 'compartment_merge', 'recomp_boundary_change', 'compartment_upgrade'
      )),
      target_id INTEGER,
      queued_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_m0_mutation_log_session ON m0_mutation_log(session_id);

    CREATE TABLE IF NOT EXISTS v22_identity_rekey_map (
      old_project_path TEXT PRIMARY KEY,
      new_project_path TEXT NOT NULL,
      rekeyed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'
    );

    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      display_path TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, project_path)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_unique ON workspace_members(project_path);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_name ON workspace_members(workspace_id, display_name);

    CREATE TABLE IF NOT EXISTS v22_backfill_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      raw_project_path TEXT NOT NULL,
      error_class TEXT NOT NULL CHECK (error_class IN ('not_git_repo', 'git_missing', 'git_timeout', 'permission_denied', 'unknown')),
      error_message TEXT,
      failed_at INTEGER NOT NULL,
      UNIQUE(table_name, row_id)
    );

    -- (smart_notes: see note above; merged into unified notes table by migration v1)

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      category,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS message_history_fts USING fts5(
      session_id UNINDEXED,
      message_ordinal UNINDEXED,
      message_id UNINDEXED,
      role,
      content,
      tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS message_history_index (
      session_id TEXT PRIMARY KEY,
      last_indexed_ordinal INTEGER NOT NULL DEFAULT 0,
      dirty_floor_ordinal INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
    CREATE INDEX IF NOT EXISTS idx_message_history_index_orphan_sweep
      ON message_history_index(harness, session_id, updated_at);

    CREATE TABLE IF NOT EXISTS message_history_source (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      message_ordinal INTEGER NOT NULL,
      source_version TEXT NOT NULL,
      normalized_content_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_history_source_session_ordinal
      ON message_history_source(session_id, message_ordinal);

    CREATE TABLE IF NOT EXISTS pending_session_cleanup (
      session_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL DEFAULT 'opencode',
      requested_at INTEGER NOT NULL,
      last_attempt_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS message_history_orphan_sweep (
      harness TEXT PRIMARY KEY,
      cursor_session_id TEXT NOT NULL DEFAULT '',
      last_swept_at INTEGER
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;

    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL DEFAULT 'opencode',
      last_response_time INTEGER,
      cache_ttl TEXT,
      counter INTEGER DEFAULT 0,
      last_nudge_tokens INTEGER DEFAULT 0,
      last_nudge_band TEXT DEFAULT '',
      last_nudge_undropped INTEGER DEFAULT 0,
      last_nudge_level TEXT DEFAULT '',
      channel2_nudge_state TEXT DEFAULT '',
      channel2_nudge_claimed_at INTEGER DEFAULT 0,
      channel2_nudge_claim_token TEXT DEFAULT '',
      last_emergency_input_sample INTEGER DEFAULT 0,
      last_transform_error TEXT DEFAULT '',
      nudge_anchor_message_id TEXT DEFAULT '',
      nudge_anchor_text TEXT DEFAULT '',
      sticky_turn_reminder_text TEXT DEFAULT '',
      sticky_turn_reminder_message_id TEXT DEFAULT '',
      note_nudge_trigger_pending INTEGER DEFAULT 0,
      note_nudge_trigger_message_id TEXT DEFAULT '',
      note_nudge_sticky_text TEXT DEFAULT '',
      note_nudge_sticky_message_id TEXT DEFAULT '',
      note_nudge_anchors TEXT NOT NULL DEFAULT '[]',
      auto_search_hint_decisions TEXT NOT NULL DEFAULT '[]',
      last_todo_state TEXT DEFAULT '',
      todo_permission_denied INTEGER NOT NULL DEFAULT 2,
      todo_synthetic_call_id TEXT DEFAULT '',
      todo_synthetic_anchor_message_id TEXT DEFAULT '',
      todo_synthetic_state_json TEXT DEFAULT '',
      is_subagent INTEGER DEFAULT 0,
      last_context_percentage REAL DEFAULT 0,
      last_input_tokens INTEGER DEFAULT 0,
      detected_context_limit_provenance TEXT NOT NULL DEFAULT 'unknown',
      observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_alert_sent INTEGER NOT NULL DEFAULT 0,
      times_execute_threshold_reached INTEGER DEFAULT 0,
      compartment_in_progress INTEGER DEFAULT 0,
      historian_failure_count INTEGER DEFAULT 0,
      historian_last_error TEXT DEFAULT NULL,
      historian_last_failure_at INTEGER DEFAULT NULL,
      system_prompt_hash TEXT DEFAULT '',
      memory_block_cache TEXT DEFAULT '',
      memory_block_count INTEGER DEFAULT 0,
      memory_block_ids TEXT DEFAULT '',
      -- pending_compaction_marker_state: intentionally NULLABLE without a
      -- default. Absence of a deferred marker is SQL NULL; presence is a
      -- valid JSON blob written via setPendingCompactionMarkerState.
      -- Excluded from the healAllNullColumns fallback list. Readers filter
      -- IS NOT NULL AND != empty-string defensively. Plan v6 section 3.
      pending_compaction_marker_state TEXT,
      -- Target OpenCode message id used to inject the current compaction marker.
      -- Nullable for legacy persisted markers; repaired on the next marker move.
      compaction_marker_target_end_message_id TEXT,
      -- pending_pi_compaction_marker_state: intentionally NULLABLE without a
      -- default. Absence of a deferred Pi-native marker is SQL NULL; presence
      -- is a valid JSON blob written via setPendingPiCompactionMarkerState.
      -- Excluded from the healAllNullColumns fallback list.
      pending_pi_compaction_marker_state TEXT,
      new_work_tokens INTEGER NOT NULL DEFAULT 0,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      -- deferred_execute_state: intentionally NULLABLE without a default.
      -- Absence is SQL NULL; presence is a JSON blob written via
      -- setDeferredExecutePendingIfAbsent. Excluded from the
      -- healAllNullColumns fallback list.
      deferred_execute_state TEXT,
      cached_m0_bytes BLOB,
      cached_m0_project_memory_epoch INTEGER,
      cached_m0_workspace_fingerprint TEXT,
      cached_m0_project_user_profile_version INTEGER,
      cached_m0_max_compartment_seq INTEGER,
      cached_m0_max_memory_id INTEGER,
      cached_m0_max_mutation_id INTEGER,
      cached_m0_max_memory_mutation_id INTEGER,
      cached_m0_project_docs_hash TEXT,
      cached_m1_bytes BLOB,
      last_observed_model_key TEXT,
      last_usage_context_limit INTEGER NOT NULL DEFAULT 0,
      prior_boundary_ordinal INTEGER NOT NULL DEFAULT 1,
      protected_tail_policy_version INTEGER NOT NULL DEFAULT 0,
      protected_tail_drain_window_started_at INTEGER NOT NULL DEFAULT 0,
      protected_tail_drain_tokens INTEGER NOT NULL DEFAULT 0,
      recovery_no_eligible_head_count INTEGER NOT NULL DEFAULT 0,
      force_emergency_bypass_window_start INTEGER NOT NULL DEFAULT 0,
      force_emergency_bypass_used INTEGER NOT NULL DEFAULT 0,
      emergency_drain_active INTEGER NOT NULL DEFAULT 0,
      historian_drain_failure_at INTEGER NOT NULL DEFAULT 0,
      wrapup_in_progress_state TEXT,
      compaction_mode_record TEXT,
      cached_m0_materialized_at INTEGER,
      cached_m0_session_facts_version INTEGER,
      cached_m0_upgrade_state TEXT,
      cached_m0_system_hash TEXT,
      cached_m0_tool_set_hash TEXT,
      cached_m0_model_key TEXT,
      cached_m0_project_identity TEXT,
      cached_m0_last_baseline_end_message_id TEXT,
       upgrade_reminded_at INTEGER,
       pi_stable_id_scheme INTEGER
    );

    CREATE TABLE IF NOT EXISTS tool_owner_backfill_state (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'skipped')),
      started_at INTEGER,
      lease_expires_at INTEGER,
      completed_at INTEGER,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_owner_backfill_state_status
      ON tool_owner_backfill_state(status);

    CREATE TABLE IF NOT EXISTS subagent_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      harness TEXT NOT NULL,
      subagent TEXT NOT NULL,
      task TEXT,
      provider_id TEXT,
      model_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      parent_invocation_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sai_session_started
      ON subagent_invocations(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sai_subagent
      ON subagent_invocations(subagent, started_at DESC);

    CREATE TABLE IF NOT EXISTS historian_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      subagent_invocation_id INTEGER,
      run_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_reason TEXT,
      chunk_start_ordinal INTEGER,
      chunk_end_ordinal INTEGER,
      unprocessed_from INTEGER,
      compartments_produced INTEGER NOT NULL DEFAULT 0,
      compartment_id_min INTEGER,
      compartment_id_max INTEGER,
      facts_emitted INTEGER NOT NULL DEFAULT 0,
      facts_by_category_json TEXT,
      events_emitted INTEGER NOT NULL DEFAULT 0,
      importance_min INTEGER,
      importance_max INTEGER,
      importance_avg REAL,
      discarded_last INTEGER NOT NULL DEFAULT 0,
      legacy INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_historian_runs_session
      ON historian_runs(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_historian_runs_status
      ON historian_runs(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS transform_decisions (
      session_id         TEXT    NOT NULL,
      harness            TEXT    NOT NULL DEFAULT 'opencode',
      message_id         TEXT    NOT NULL,
      ts_ms              INTEGER NOT NULL,
      decision           TEXT    NOT NULL,
      materialized       INTEGER NOT NULL DEFAULT 0,
      materialize_reason TEXT,
      emergency          INTEGER NOT NULL DEFAULT 0,
      dropped_tokens     INTEGER NOT NULL DEFAULT 0,
      dropped_count      INTEGER NOT NULL DEFAULT 0,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, harness, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transform_decisions_session_harness
      ON transform_decisions(session_id, harness);

    CREATE INDEX IF NOT EXISTS idx_tags_session_tag_number ON tags(session_id, tag_number);
    CREATE INDEX IF NOT EXISTS idx_tags_session_message_id ON tags(session_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_pending_ops_session ON pending_ops(session_id);
    CREATE INDEX IF NOT EXISTS idx_pending_ops_session_tag_id ON pending_ops(session_id, tag_id);
    CREATE INDEX IF NOT EXISTS idx_source_contents_session ON source_contents(session_id);
    
    CREATE TABLE IF NOT EXISTS recomp_compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      start_message INTEGER NOT NULL,
      end_message INTEGER NOT NULL,
      start_message_id TEXT DEFAULT '',
      end_message_id TEXT DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      p1 TEXT,
      p2 TEXT,
      p3 TEXT,
      p4 TEXT,
      importance INTEGER NOT NULL DEFAULT 50,
      episode_type TEXT,
      pass_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      UNIQUE(session_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS recomp_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      pass_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

    CREATE INDEX IF NOT EXISTS idx_session_facts_session ON session_facts(session_id);
    CREATE INDEX IF NOT EXISTS idx_recomp_compartments_session ON recomp_compartments(session_id);
    CREATE INDEX IF NOT EXISTS idx_recomp_facts_session ON recomp_facts(session_id);
    CREATE INDEX IF NOT EXISTS idx_memories_project_status_category ON memories(project_path, status, category);
    CREATE INDEX IF NOT EXISTS idx_memories_project_status_expires ON memories(project_path, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_memories_project_category_hash ON memories(project_path, category, normalized_hash);
    CREATE INDEX IF NOT EXISTS idx_message_history_index_updated_at ON message_history_index(updated_at);
  `);

    ensureColumn(db, "primer_candidates", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "primer_candidates", "source_start_message_id", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "primer_candidates", "source_end_message_id", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "primer_candidates", "question_embedding", "BLOB");
    ensureColumn(db, "primer_candidates", "question_embedding_model_id", "TEXT");
    ensureColumn(db, "primers", "question_embedding_model_id", "TEXT");
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_primer_candidates_occurrence
        ON primer_candidates(project_path, harness, session_id, source_start_message_id, source_end_message_id);
      CREATE INDEX IF NOT EXISTS idx_primer_candidates_project_time
        ON primer_candidates(project_path, source_message_time);
      CREATE INDEX IF NOT EXISTS idx_primer_candidates_session
        ON primer_candidates(session_id, harness);
      CREATE INDEX IF NOT EXISTS idx_primer_candidates_embedding_model
        ON primer_candidates(project_path, question_embedding_model_id);
      CREATE INDEX IF NOT EXISTS idx_primers_project_status_observed
        ON primers(project_path, status, last_observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_primers_embedding_model
        ON primers(project_path, question_embedding_model_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS primers_fts USING fts5(
        question,
        answer,
        project_path UNINDEXED,
        content='primers',
        content_rowid='id',
        tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS primers_ai AFTER INSERT ON primers BEGIN
        INSERT INTO primers_fts(rowid, question, answer, project_path)
        VALUES (new.id, new.question, new.answer, new.project_path);
      END;
      CREATE TRIGGER IF NOT EXISTS primers_ad AFTER DELETE ON primers BEGIN
        INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
        VALUES ('delete', old.id, old.question, old.answer, old.project_path);
      END;
      CREATE TRIGGER IF NOT EXISTS primers_au AFTER UPDATE ON primers BEGIN
        INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
        VALUES ('delete', old.id, old.question, old.answer, old.project_path);
        INSERT INTO primers_fts(rowid, question, answer, project_path)
        VALUES (new.id, new.question, new.answer, new.project_path);
      END;
    `);

    ensureColumn(db, "session_meta", "last_nudge_band", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "last_nudge_undropped", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "last_nudge_level", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "channel2_nudge_state", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "channel2_nudge_claimed_at", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "channel2_nudge_claim_token", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "last_emergency_input_sample", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "last_transform_error", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "nudge_anchor_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "nudge_anchor_text", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "sticky_turn_reminder_text", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "sticky_turn_reminder_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "note_nudge_trigger_pending", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "note_nudge_trigger_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "note_nudge_sticky_text", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "note_nudge_sticky_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "note_nudge_anchors", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, "session_meta", "auto_search_hint_decisions", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, "session_meta", "last_todo_state", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "todo_permission_denied", "INTEGER NOT NULL DEFAULT 2");
    ensureColumn(db, "session_meta", "todo_synthetic_call_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "todo_synthetic_anchor_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "todo_synthetic_state_json", "TEXT DEFAULT ''");
    // Timestamp of last ctx_note(read) call for this session. Used by note-nudger
    // to suppress nudges when the agent has already seen notes in recent context
    // and no new notes have been created or updated since.
    ensureColumn(db, "session_meta", "note_last_read_at", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "times_execute_threshold_reached", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "observed_safe_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "cache_alert_sent", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "compartment_in_progress", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "historian_failure_count", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "historian_last_error", "TEXT DEFAULT NULL");
    ensureColumn(db, "session_meta", "historian_last_failure_at", "INTEGER DEFAULT NULL");
    ensureColumn(db, "session_meta", "system_prompt_hash", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "cleared_reasoning_through_tag", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "tool_reclaim_watermark", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "stripped_placeholder_ids", "TEXT DEFAULT ''");
    // Frozen replay watermark for the stale-ctx_reduce strip: message ids whose
    // ctx_reduce parts have aged past the protected window. The set only grows on
    // cache-busting passes and is replayed verbatim on defer passes, so the strip
    // never recomputes a volatile messages.length boundary that would silently
    // strip newly-aged calls mid-prefix on a defer pass (Anthropic cache bust).
    ensureColumn(db, "session_meta", "stale_reduce_stripped_ids", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "processed_image_stripped_ids", "TEXT DEFAULT ''");
    ensureColumn(db, "compartments", "start_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "compartments", "end_message_id", "TEXT DEFAULT ''");
    ensureColumn(db, "memory_embeddings", "model_id", "TEXT");
    ensureColumn(db, "session_meta", "memory_block_cache", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "memory_block_count", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "pi_stable_id_scheme", "INTEGER");
    // JSON array of memory ids currently rendered in the cached <session-history>
    // memory block. Used by ctx_search to hard-filter memories the agent can
    // already see in context — they're wasted tokens and crowd out high-signal
    // raw-history hits.
    ensureColumn(db, "session_meta", "memory_block_ids", "TEXT DEFAULT ''");
    ensureColumn(db, "dream_queue", "retry_count", "INTEGER DEFAULT 0");
    ensureColumn(db, "tags", "reasoning_byte_size", "INTEGER DEFAULT 0");
    ensureColumn(db, "tags", "drop_mode", "TEXT DEFAULT 'full'");
    ensureColumn(db, "tags", "tool_name", "TEXT");
    ensureColumn(db, "tags", "input_byte_size", "INTEGER DEFAULT 0");
    // Caveman compression depth applied to a tag's text part (user/assistant).
    // 0 = untouched, 1 = lite, 2 = full, 3 = ultra. Used by age-tier caveman
    // heuristic (experimental.caveman_text_compression). Source of truth for
    // the ORIGINAL pre-caveman text is source_contents.content — caveman
    // always compresses from the original, never from an already-cavemaned
    // intermediate, so repeated tier shifts converge to the target depth.
    ensureColumn(db, "tags", "caveman_depth", "INTEGER DEFAULT 0");
    // tool_owner_message_id is the third axis of tool-tag identity
    // (plan v3.3.1 / migration v10). For pre-existing rows, NULL means
    // "legacy orphan" — runtime lazy-adoption + the v10 backfill pass
    // populate it post-upgrade. Migration v10 also creates the partial
    // UNIQUE and lookup indexes; ensureColumn here covers the bare
    // column-existence path for fresh DBs and tests that bypass
    // runMigrations.
    ensureColumn(db, "tags", "tool_owner_message_id", "TEXT DEFAULT NULL");
    // Pi fallback-tag adoption: fingerprint of the raw message a tag was first
    // created for, so a later pass can migrate the tag's message_id from the
    // unstable pi-msg-* fallback to the real SessionEntry id without changing
    // tag_number (hence §N§). NULL on OpenCode and on any tag created before v27.
    ensureColumn(db, "tags", "entry_fingerprint", "TEXT");
    db.exec(
        `CREATE INDEX IF NOT EXISTS idx_tags_pi_adopt
            ON tags(session_id, entry_fingerprint)
            WHERE type='message' AND entry_fingerprint IS NOT NULL`,
    );
    db.exec(
        `CREATE INDEX IF NOT EXISTS idx_tags_pi_fallback_tool_owner
            ON tags(session_id, tool_owner_message_id)
            WHERE type='tool'`,
    );
    // Per-tag token counts (real Claude tokenizer), computed once when a tag is
    // first inserted and never recomputed — the content a tag covers is final on
    // first sight (assistant text is complete in history; a tool tag is created
    // only once its output is present). These supersede byte_size as the size
    // signal for token-budget consumers: the sidebar conversation/tool-call
    // breakdown and the historian protected-tail true-raw measurement both SUM
    // these instead of re-tokenizing the raw session every pass. NULL on rows
    // created before this column existed; backfilled lazily on next tag insert
    // for that session is not needed — readers treat NULL as "not yet measured"
    // and fall back per-call. byte_size stays for caveman (char-count) thresholds.
    ensureColumn(db, "tags", "token_count", "INTEGER");
    ensureColumn(db, "tags", "input_token_count", "INTEGER");
    ensureColumn(db, "tags", "reasoning_token_count", "INTEGER");
    // Dreamer v2: the cron string next_due_at was computed from, so the scheduler
    // can detect a config schedule change and recompute (config-authoritative).
    ensureColumn(db, "task_schedule_state", "schedule", "TEXT");
    ensureColumn(db, "task_schedule_state", "last_checked_commit", "TEXT");
    ensureColumn(db, "task_schedule_state", "last_broad_run_at", "INTEGER");
    ensureColumn(db, "task_schedule_state", "retrospective_watermark_ms", "INTEGER");
    // Dreamer v2: parent (dreamer child) session that produced this run, so the
    // dashboard token join can scope to THIS run's invocations instead of every
    // dreamer invocation in the time window (concurrent same-name cross-project
    // runs would otherwise cross-sum tokens).
    ensureColumn(db, "dream_runs", "parent_session_id", "TEXT");
    ensureColumn(db, "session_meta", "system_prompt_tokens", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "compaction_marker_state", "TEXT DEFAULT ''");
    ensureColumn(db, "session_meta", "compaction_marker_target_end_message_id", "TEXT");
    ensureColumn(db, "session_meta", "key_files", "TEXT DEFAULT ''");
    // Token estimate of output.messages[] after transform manipulation. Used by
    // the sidebar / dashboard to split inputTokens into Conversation vs Tools
    // segments, since Anthropic's usage data rolls system + tools + messages
    // together into cache.write but we want to attribute them separately.
    ensureColumn(db, "session_meta", "conversation_tokens", "INTEGER DEFAULT 0");
    // Token estimate of tool-call parts (tool_use, tool_result, tool, tool-invocation)
    // inside messages. Separate from conversation_tokens so the sidebar can show an
    // actionable "Tool Calls" slice that users can reduce via ctx_reduce.
    ensureColumn(db, "session_meta", "tool_call_tokens", "INTEGER DEFAULT 0");
    // Partial recomp staging: when non-zero, the active recomp staging is for a
    // partial range rebuild (snapStart..snapEnd). Used to discriminate staging
    // resume between full and partial recomp, and to refuse resume if the user
    // requests a different range than what is already staged.
    ensureColumn(db, "session_meta", "recomp_partial_range_start", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "recomp_partial_range_end", "INTEGER DEFAULT 0");
    // Context limit reported by the provider in an overflow error message. When
    // non-zero, this overrides all other resolution sources (models.dev cache,
    // user config, defaults) because it's the most authoritative signal we can
    // get — the model itself told us what fits. Set by overflow event handler
    // when parseReportedLimit() extracts a number; cleared on model switch.
    ensureColumn(db, "session_meta", "detected_context_limit", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "detected_context_limit_model_key", "TEXT");
    ensureColumn(
        db,
        "session_meta",
        "detected_context_limit_provenance",
        "TEXT NOT NULL DEFAULT 'unknown'",
    );
    // True when the session needs emergency recovery after either a provider
    // overflow or proactive model shrink. The persisted origin distinguishes
    // provider-proven abort eligibility from best-effort proactive recovery.
    ensureColumn(db, "session_meta", "needs_emergency_recovery", "INTEGER DEFAULT 0");
    ensureColumn(db, "session_meta", "emergency_recovery_origin", "TEXT DEFAULT ''");
    // Deferred compaction-marker drain (plan v6). Intentionally NO DEFAULT
    // clause — absence is SQL NULL, presence is a JSON blob. Reader must
    // filter `IS NOT NULL AND != ''`. This column MUST NOT be added to the
    // healAllNullColumns fallback list (NULL is the load-bearing absence sentinel).
    ensureColumn(db, "session_meta", "pending_compaction_marker_state", "TEXT");
    // Pi-native deferred compaction marker queue. Intentionally NO DEFAULT;
    // NULL is the load-bearing absence sentinel and this column MUST NOT be
    // added to the healAllNullColumns fallback list.
    ensureColumn(db, "session_meta", "pending_pi_compaction_marker_state", "TEXT");
    ensureColumn(db, "session_meta", "new_work_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "total_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    // Boundary-execution deferred intent (plan v8). Intentionally NO DEFAULT
    // clause — absence is SQL NULL, presence is a JSON blob. This column MUST
    // NOT be added to the healAllNullColumns fallback list.
    ensureColumn(db, "session_meta", "deferred_execute_state", "TEXT");

    ensureColumn(db, "compartments", "p1", "TEXT");
    ensureColumn(db, "compartments", "p2", "TEXT");
    ensureColumn(db, "compartments", "p3", "TEXT");
    ensureColumn(db, "compartments", "p4", "TEXT");
    ensureColumn(db, "compartments", "importance", "INTEGER NOT NULL DEFAULT 50");
    ensureColumn(db, "compartments", "episode_type", "TEXT");
    ensureColumn(db, "compartments", "p1_embedding", "BLOB");
    ensureColumn(db, "compartments", "p1_embedding_model_id", "TEXT");
    ensureColumn(db, "compartments", "legacy", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "recomp_compartments", "p1", "TEXT");
    ensureColumn(db, "recomp_compartments", "p2", "TEXT");
    ensureColumn(db, "recomp_compartments", "p3", "TEXT");
    ensureColumn(db, "recomp_compartments", "p4", "TEXT");
    ensureColumn(db, "recomp_compartments", "importance", "INTEGER NOT NULL DEFAULT 50");
    ensureColumn(db, "recomp_compartments", "episode_type", "TEXT");
    ensureColumn(db, "memories", "importance", "INTEGER");
    ensureColumn(db, "memories", "classified_at", "INTEGER");
    // Per-memory mural cue cache (v65): the compress-cues dreamer task writes a
    // compressed pidgin cue per memory content version; resolveMural reads them.
    ensureColumn(db, "memories", "mural_cue", "TEXT");
    ensureColumn(db, "memories", "mural_cue_hash", "TEXT");
    ensureColumn(db, "memories", "mural_cue_at", "INTEGER");
    ensureColumn(db, "memory_verifications", "mapped_at", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "cached_m0_bytes", "BLOB");
    ensureColumn(db, "session_meta", "cached_m0_project_memory_epoch", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_workspace_fingerprint", "TEXT");
    ensureColumn(db, "session_meta", "cached_m0_project_user_profile_version", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_max_compartment_seq", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_max_memory_id", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_max_mutation_id", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_max_memory_mutation_id", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_project_docs_hash", "TEXT");
    ensureColumn(db, "session_meta", "cached_m1_bytes", "BLOB");
    ensureColumn(db, "session_meta", "last_observed_model_key", "TEXT");
    ensureColumn(db, "session_meta", "last_usage_context_limit", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "prior_boundary_ordinal", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "session_meta", "protected_tail_policy_version", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(
        db,
        "session_meta",
        "protected_tail_drain_window_started_at",
        "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(db, "session_meta", "protected_tail_drain_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(
        db,
        "session_meta",
        "recovery_no_eligible_head_count",
        "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
        db,
        "session_meta",
        "force_emergency_bypass_window_start",
        "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(db, "session_meta", "force_emergency_bypass_used", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "emergency_drain_active", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "historian_drain_failure_at", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "wrapup_in_progress_state", "TEXT");
    // v72: per-session compaction mode record. NULL means no record (treated
    // as "on" by the transition logic); "on"/"off" are the recorded values.
    // Helpers live in storage-meta-persisted.ts; no transition logic reads or
    // writes this column yet.
    ensureColumn(db, "session_meta", "compaction_mode_record", "TEXT");
    ensureColumn(db, "session_meta", "cached_m0_materialized_at", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_session_facts_version", "INTEGER");
    ensureColumn(db, "session_meta", "cached_m0_upgrade_state", "TEXT");
    ensureColumn(db, "session_meta", "cached_m0_system_hash", "TEXT");
    ensureColumn(db, "session_meta", "cached_m0_tool_set_hash", "TEXT");
    ensureColumn(db, "session_meta", "cached_m0_model_key", "TEXT");
    ensureColumn(db, "session_meta", "cached_m0_project_identity", "TEXT");
    // Pi-only: frozen baseline boundary (end_message_id) captured at
    // materialization so Pi trims against the snapshot boundary that produced
    // m[0], not a live-recomputed one a concurrent recomp could have moved.
    // Declared centrally (shared session_meta table) rather than via an ad-hoc
    // ALTER in the Pi plugin.
    ensureColumn(db, "session_meta", "cached_m0_last_baseline_end_message_id", "TEXT");
    ensureColumn(db, "session_meta", "upgrade_reminded_at", "INTEGER");
    // Keep migration order canonical: v66 reminder fields precede v67 mural cache fields.
    ensureColumn(db, "session_meta", "upgrade_reminder_last_sent_at", "INTEGER");
    ensureColumn(db, "session_meta", "upgrade_reminder_count", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "session_meta", "cached_m0_mural_data_url", "TEXT");
    ensureColumn(db, "session_meta", "cached_m0_mural_hash", "TEXT");

    db.exec(`
      CREATE TABLE IF NOT EXISTS project_state (
        project_path TEXT PRIMARY KEY,
        project_memory_epoch INTEGER NOT NULL DEFAULT 0,
        project_user_profile_version INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS session_projects (
        session_id TEXT NOT NULL,
        harness TEXT NOT NULL DEFAULT 'opencode',
        project_path TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, harness)
      );
      CREATE INDEX IF NOT EXISTS idx_session_projects_project
        ON session_projects(project_path);
      CREATE TABLE IF NOT EXISTS m0_mutation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        mutation_type TEXT NOT NULL CHECK (mutation_type IN (
          'compartment_delete', 'compartment_merge', 'recomp_boundary_change', 'compartment_upgrade'
        )),
        target_id INTEGER,
        queued_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_m0_mutation_log_session ON m0_mutation_log(session_id);
      CREATE TABLE IF NOT EXISTS memory_mutation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        mutation_type TEXT NOT NULL CHECK (mutation_type IN ('archive', 'delete', 'update', 'superseded')),
        target_memory_id INTEGER NOT NULL,
        superseded_by_id INTEGER,
        category TEXT,
        new_content TEXT,
        queued_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
        ON memory_mutation_log(project_path, id);
       CREATE TABLE IF NOT EXISTS v22_identity_rekey_map (
         old_project_path TEXT PRIMARY KEY,
         new_project_path TEXT NOT NULL,
         rekeyed_at INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS identity_merge_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         from_identity TEXT NOT NULL,
         to_identity TEXT NOT NULL,
         table_name TEXT NOT NULL,
         row_id TEXT NOT NULL,
         action TEXT NOT NULL,
         target_row_id TEXT,
         merged_at INTEGER NOT NULL
       );
       CREATE INDEX IF NOT EXISTS idx_identity_merge_log_identities
         ON identity_merge_log(from_identity, to_identity, merged_at);
       CREATE INDEX IF NOT EXISTS idx_identity_merge_log_table_row
         ON identity_merge_log(table_name, row_id);
      CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'
      );
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        display_path TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, project_path)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_unique ON workspace_members(project_path);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_name ON workspace_members(workspace_id, display_name);
      CREATE TABLE IF NOT EXISTS v22_backfill_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        row_id INTEGER NOT NULL,
        raw_project_path TEXT NOT NULL,
        error_class TEXT NOT NULL CHECK (error_class IN ('not_git_repo', 'git_missing', 'git_timeout', 'permission_denied', 'unknown')),
        error_message TEXT,
        failed_at INTEGER NOT NULL,
        UNIQUE(table_name, row_id)
      );
      CREATE TABLE IF NOT EXISTS transform_decisions (
        session_id         TEXT    NOT NULL,
        harness            TEXT    NOT NULL DEFAULT 'opencode',
        message_id         TEXT    NOT NULL,
        ts_ms              INTEGER NOT NULL,
        decision           TEXT    NOT NULL,
        materialized       INTEGER NOT NULL DEFAULT 0,
        materialize_reason TEXT,
        emergency          INTEGER NOT NULL DEFAULT 0,
        dropped_tokens     INTEGER NOT NULL DEFAULT 0,
        dropped_count      INTEGER NOT NULL DEFAULT 0,
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, harness, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_transform_decisions_session_harness
        ON transform_decisions(session_id, harness);
    `);

    // NULL-column healing runs in migration v5 and again in v51 to repair
    // databases where the old v5 healer swallowed a transient write error.
    // It stays out of the startup path so healed databases do not issue dozens
    // of no-op UPDATE statements on every launch.

    // Plugin v0.16+ — `harness` column on every session-scoped table.
    // SQLite ALTER TABLE ADD COLUMN ... NOT NULL DEFAULT physically backfills
    // existing rows with the default, so OpenCode users transparently get
    // harness='opencode' on all pre-existing data. Pi will be added later
    // by its own plugin entry, also writing to the same shared DB.
    //
    // We don't (yet) include harness in WHERE clauses — OpenCode session IDs
    // never collide with Pi session IDs in practice (different ID formats).
    // The column captures origin for the dashboard and unblocks future
    // cross-harness session migration. Defensive query scoping by harness
    // ships in a later commit once Pi can write to the same DB concurrently
    // and we can validate the safety property end-to-end.
    ensureColumn(db, "tags", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "message_history_index", "dirty_floor_ordinal", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "pending_ops", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "source_contents", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "compartments", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "compression_depth", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "session_facts", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "session_meta", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "recomp_compartments", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "recomp_facts", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "message_history_index", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
    ensureColumn(db, "workspaces", "share_categories", `TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'`);
    // notes table is created by migration v1 (not initializeDatabase). It
    // exists by the time runMigrations() returns, but ensureColumn's PRAGMA
    // table_info check needs the table to exist. Order: initializeDatabase()
    // runs before runMigrations(), so notes won't exist yet on a fresh DB
    // here. Migration v6 handles `notes` separately (see migrations.ts).
    // notes.anchor_ordinal is added by migration v29 for the same reason — it
    // cannot go here because the table doesn't exist yet on a fresh DB.
}

const CHANNEL2_CLAIM_TTL_MS = 120_000;

/**
 * Boot heal for a wedged Channel-2 ceiling-nudge lease.
 *
 * The delivery path CAS-claims `pending → claimed` before sending the synthetic
 * user message. A crash can strand that claim and burn the one-shot cap, but a
 * sibling process can also be legitimately mid-send against the shared DB. The
 * claimed_at lease timestamp is the liveness boundary: only old/legacy claims are
 * rewound to `pending`; fresh claims are left alone so boot recovery never steals
 * an in-flight delivery.
 */
function healWedgedChannel2Claims(db: Database): void {
    try {
        const staleBefore = Date.now() - CHANNEL2_CLAIM_TTL_MS;
        db.prepare(
            "UPDATE session_meta SET channel2_nudge_state = 'pending', channel2_nudge_claimed_at = 0, channel2_nudge_claim_token = '' WHERE channel2_nudge_state = 'claimed' AND (channel2_nudge_claimed_at IS NULL OR channel2_nudge_claimed_at = 0 OR channel2_nudge_claimed_at <= ?)",
        ).run(staleBefore);
    } catch {
        // Columns may be missing on a very fresh DB before ensureColumn/migration
        // adds them; fresh rows seed the state as '' so there is nothing to heal.
    }
}

/**
 * Open the persistent Magic Context SQLite database.
 *
 * Fails closed: if the database cannot be opened (binary ABI mismatch,
 * unwritable path, corrupted file, etc.), this throws. Magic Context CANNOT
 * silently fall back to an in-memory database, because:
 *   1. An in-memory DB has no project memories, no historian state, no
 *      tag persistence — features that depend on durable storage become
 *      silently broken instead of explicitly disabled.
 *   2. More importantly, an in-memory DB across process restarts effectively
 *      means "no Magic Context", but the plugin still tags messages and
 *      tries to drive transforms. On Pi/OpenCode this can let the full
 *      raw history reach the model and overflow the context window — the
 *      exact failure mode that broke a real test session.
 *
 * Two failure modes, both fail-closed:
 *   - **Schema fence** (the on-disk DB is newer than this binary supports, e.g.
 *     a stale process after a rolling upgrade): returns `null`. This is an
 *     expected, recoverable condition (restart onto the newer binary), so it is
 *     not exceptional.
 *   - **Fatal open error** (ABI mismatch, unwritable path, corrupt file):
 *     throws. The thrown message carries the failure detail for surfacing.
 *
 * The return type is therefore `Database | null`, and callers MUST both
 * null-check the result AND be prepared for a throw (typically a try/catch that
 * also treats a null result as "storage unavailable"). On either outcome the
 * caller disables Magic Context for that run (server plugin: registers a
 * startup warning + skips the runtime; Pi plugin: logs warning + skips the
 * extension). There is NEVER a silent in-memory fallback.
 */
export function openDatabase(): Database | null;
export function openDatabase(dbPath: string): Database | null;
export function openDatabase(options: OpenDatabaseOptions): Database | null;
export function openDatabase(dbPathOrOptions?: string | OpenDatabaseOptions): Database | null {
    const options =
        typeof dbPathOrOptions === "string" ? { dbPath: dbPathOrOptions } : dbPathOrOptions;
    const explicitDbPath = options?.dbPath !== undefined;
    const { dbDir, dbPath } = resolveDatabasePath(options?.dbPath);
    const latestSupportedVersion = getRuntimeLatestSupportedVersion(options);
    lastSchemaFenceRejection = null;
    lastMigrationOnOpenRefusal = null;
    const existing = databases.get(dbPath);
    if (existing) {
        if (!enforceSchemaFence(existing, dbPath, latestSupportedVersion)) {
            return null;
        }
        if (!persistenceByDatabase.has(existing)) {
            persistenceByDatabase.set(existing, true);
        }
        // Re-run the TTL-scoped lease heal on cache hits too. Long-lived
        // processes keep this handle for hours, and a revert/confirm DB lock can
        // leave a stale `claimed` lease behind until some later openDatabase()
        // call. The heal is one idempotent UPDATE gated by claimed_at age.
        healWedgedChannel2Claims(existing);
        return existing;
    }

    try {
        if (!explicitDbPath) {
            migrateLegacyStorageIfNeeded(dbPath, dbDir);
        }
        ensureSecureStorageDir(dbDir);

        const db = new Database(dbPath);
        if (!enforceSchemaFence(db, dbPath, latestSupportedVersion)) {
            closeQuietly(db);
            return null;
        }
        if (!enforceMigrationOnOpenGuard(db, dbPath, dbDir, latestSupportedVersion)) {
            closeQuietly(db);
            return null;
        }
        initializeDatabase(db);
        runMigrations(db);
        ensureContextStoreUuid(db);
        return finishDatabaseOpen(db, dbPath, explicitDbPath, latestSupportedVersion);
    } catch (error) {
        const detail = getErrorMessage(error);
        log(`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}`);
        // No silent in-memory fallback — see comment above. Caller must
        // catch and disable Magic Context for that run.
        throw new Error(
            `[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.`,
        );
    }
}

/**
 * Async boot variant of openDatabase. SQLite calls remain synchronous, but the
 * bounded migration-lock waits yield to the host between attempts so a busy
 * sibling cannot freeze plugin startup for the whole retry budget.
 */
export async function openDatabaseAsync(
    dbPathOrOptions?: string | OpenDatabaseOptions,
): Promise<Database | null> {
    const options =
        typeof dbPathOrOptions === "string" ? { dbPath: dbPathOrOptions } : dbPathOrOptions;
    const explicitDbPath = options?.dbPath !== undefined;
    const { dbDir, dbPath } = resolveDatabasePath(options?.dbPath);
    const latestSupportedVersion = getRuntimeLatestSupportedVersion(options);
    lastSchemaFenceRejection = null;
    lastMigrationOnOpenRefusal = null;
    const existing = databases.get(dbPath);
    if (existing) {
        if (!enforceSchemaFence(existing, dbPath, latestSupportedVersion)) return null;
        if (!persistenceByDatabase.has(existing)) persistenceByDatabase.set(existing, true);
        healWedgedChannel2Claims(existing);
        return existing;
    }

    const pending = pendingAsyncOpens.get(dbPath);
    if (pending) return pending;

    const opening = (async (): Promise<Database | null> => {
        let db: Database | undefined;
        try {
            if (!explicitDbPath) migrateLegacyStorageIfNeeded(dbPath, dbDir);
            ensureSecureStorageDir(dbDir);

            db = new Database(dbPath);
            if (!enforceSchemaFence(db, dbPath, latestSupportedVersion)) {
                closeQuietly(db);
                return null;
            }
            if (!enforceMigrationOnOpenGuard(db, dbPath, dbDir, latestSupportedVersion)) {
                closeQuietly(db);
                return null;
            }
            initializeDatabase(db);
            await runMigrationsWithRetry(db);
            ensureContextStoreUuid(db);
            return finishDatabaseOpen(db, dbPath, explicitDbPath, latestSupportedVersion);
        } catch (error) {
            if (db) closeQuietly(db);
            const detail = getErrorMessage(error);
            log(`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}`);
            throw new Error(
                `[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.`,
            );
        }
    })();
    pendingAsyncOpens.set(dbPath, opening);
    try {
        return await opening;
    } finally {
        if (pendingAsyncOpens.get(dbPath) === opening) pendingAsyncOpens.delete(dbPath);
    }
}

export function isDatabasePersisted(db: Database | null): boolean {
    if (!db) return false;
    return persistenceByDatabase.get(db) ?? false;
}

export function getDatabasePersistenceError(db: Database | null): string | null {
    if (!db) return null;
    return persistenceErrorByDatabase.get(db) ?? null;
}

export function closeDatabase(): void {
    pendingAsyncOpens.clear();
    for (const [key, db] of databases) {
        try {
            closeQuietly(db);
        } catch (error) {
            log("[magic-context] storage error:", error);
        } finally {
            databases.delete(key);
        }
    }
}

export type ContextDatabase = Database;
