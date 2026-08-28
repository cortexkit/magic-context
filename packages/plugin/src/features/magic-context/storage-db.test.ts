/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { execFileSync } from "node:child_process";
import {
    type chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { __resetRpcIdentityTestHooks, __setRpcIdentityTestHooks } from "../../shared/rpc-utils";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    __resetStoragePrivatePermissionEnforcementForTests,
    setStoragePrivatePermissionEnforcement,
} from "../../shared/storage-permissions";
import {
    __resetRpcDiscoveryFsForTests,
    __resetSchemaFenceStateForTests,
    __resetStoragePermissionFsForTests,
    __setRpcDiscoveryFsForTests,
    __setStoragePermissionFsForTests,
    closeDatabase,
    enforceSchemaFence,
    FORK_MIGRATION_VERSION_FLOOR,
    formatInconclusiveOpenCodeMigrationWarning,
    formatLiveProcessMigrationRefusal,
    getLiveMigrationBlockingProcesses,
    getDatabasePath,
    getMigrationOnOpenRefusal,
    getPersistedSchemaVersion,
    getSchemaFenceRejection,
    inspectRpcServerDiscovery,
    isDatabasePersisted,
    LATEST_SUPPORTED_VERSION,
    openDatabase,
    resolveDatabasePath,
} from "./storage-db";
import { clearSession } from "./storage-meta-session";
import { SESSION_SCOPED_TABLES } from "./storage-session-tables";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
const originalStorageDir = process.env.MAGIC_CONTEXT_STORAGE_DIR;
const originalNodeEnv = process.env.NODE_ENV;

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function useTempDataHome(prefix: string): string {
    const dataHome = makeTempDir(prefix);
    process.env.XDG_DATA_HOME = dataHome;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dataHome;
    return dataHome;
}

function resolveDbPath(dataHome: string): string {
    // Plugin v0.16+ — shared cortexkit/magic-context path. See data-path.ts.
    return join(dataHome, "cortexkit", "magic-context", "context.db");
}

function seedPendingMigration(dataHome: string): string {
    openDatabase();
    closeDatabase();
    const dbPath = resolveDbPath(dataHome);
    const db = new Database(dbPath);
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(LATEST_SUPPORTED_VERSION);
    closeQuietly(db);
    return dbPath;
}

function readPersistedVersion(dbPath: string): number {
    const db = new Database(dbPath);
    try {
        return getPersistedSchemaVersion(db);
    } finally {
        closeQuietly(db);
    }
}

function setLinuxIdentityProbe(processStartTicks = 10_000): void {
    __setRpcIdentityTestHooks({
        platform: "linux",
        nowMs: () => 2_000_000,
        readFileSync: ((path: string | URL) => {
            if (String(path) === `/proc/${process.pid}/stat`) {
                return `${process.pid} (opencode) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${processStartTicks}`;
            }
            if (String(path) === "/proc/uptime") return "1000.0 0.0";
            throw new Error(`unexpected identity read: ${String(path)}`);
        }) as typeof readFileSync,
    });
}

afterEach(() => {
    closeDatabase();
    __resetRpcDiscoveryFsForTests();
    __resetSchemaFenceStateForTests();
    __resetStoragePermissionFsForTests();
    __resetRpcIdentityTestHooks();
    __resetStoragePrivatePermissionEnforcementForTests();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    if (originalStorageDir === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = originalStorageDir;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Ignore EBUSY on Windows
        }
    }
    tempDirs.length = 0;
});

describe("upstream migration version lane", () => {
    it("reports zero when the migrations table is absent", () => {
        const db = new Database(":memory:");
        try {
            expect(getPersistedSchemaVersion(db)).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    it("reports zero for an empty migrations table", () => {
        const db = new Database(":memory:");
        try {
            db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
            expect(getPersistedSchemaVersion(db)).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    it("is equivalent to the historical MAX for stock-only rows", () => {
        const db = new Database(":memory:");
        try {
            db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
            db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(1);
            db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(50);
            db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(
                LATEST_SUPPORTED_VERSION,
            );

            const historicalMax = (
                db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
                    version: number;
                }
            ).version;
            expect(getPersistedSchemaVersion(db)).toBe(historicalMax);
        } finally {
            closeQuietly(db);
        }
    });

    it("counts 9999 but ignores the reserved downstream floor and above", () => {
        const db = new Database(":memory:");
        try {
            db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
            db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(
                FORK_MIGRATION_VERSION_FLOOR - 1,
            );
            db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(
                FORK_MIGRATION_VERSION_FLOOR,
            );
            db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(
                FORK_MIGRATION_VERSION_FLOOR + 1,
            );

            expect(getPersistedSchemaVersion(db)).toBe(FORK_MIGRATION_VERSION_FLOOR - 1);
        } finally {
            closeQuietly(db);
        }
    });

    it("keeps future upstream rows fail-closed while allowing fork-only rows", () => {
        const future = new Database(":memory:");
        const forkOnly = new Database(":memory:");
        try {
            for (const db of [future, forkOnly]) {
                db.exec(
                    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT, applied_at INTEGER)",
                );
            }
            future
                .prepare("INSERT INTO schema_migrations(version) VALUES (?)")
                .run(LATEST_SUPPORTED_VERSION + 1);
            forkOnly
                .prepare("INSERT INTO schema_migrations(version) VALUES (?)")
                .run(FORK_MIGRATION_VERSION_FLOOR);

            expect(enforceSchemaFence(future, ":future:", LATEST_SUPPORTED_VERSION)).toBe(false);
            expect(getSchemaFenceRejection()).toEqual({
                persistedVersion: LATEST_SUPPORTED_VERSION + 1,
                supportedVersion: LATEST_SUPPORTED_VERSION,
            });
            expect(enforceSchemaFence(forkOnly, ":fork:", LATEST_SUPPORTED_VERSION)).toBe(true);
            expect(getSchemaFenceRejection()).toBeNull();
        } finally {
            closeQuietly(future);
            closeQuietly(forkOnly);
        }
    });
});

describe("explicit shared storage resolution", () => {
    it("keeps both path resolution and database opening inside test isolation", () => {
        const testDataDir = makeTempDir("storage-db-test-guard-");
        process.env.MAGIC_CONTEXT_TEST_DATA_DIR = testDataDir;
        process.env.XDG_DATA_HOME = makeTempDir("storage-db-preload-xdg-");
        process.env.MAGIC_CONTEXT_STORAGE_DIR = makeTempDir("storage-db-production-");

        const resolved = resolveDatabasePath();
        expect(resolved.dbPath).toBe(resolveDbPath(testDataDir));
        const db = openDatabase();
        expect(db).not.toBeNull();
        expect(getDatabasePath(db!)).toBe(resolved.dbPath);
        closeDatabase();
    });

    it("opens a fresh absolute override and applies private storage permissions", () => {
        if (process.platform === "win32") return;
        const override = makeTempDir("storage-db-explicit-");
        process.env.MAGIC_CONTEXT_TEST_DATA_DIR = "";
        process.env.NODE_ENV = "development";
        process.env.MAGIC_CONTEXT_STORAGE_DIR = join(override, "shared");
        __setRpcDiscoveryFsForTests({
            readdirSync: (_path, options) => (options?.withFileTypes ? [] : []),
        });
        __setRpcIdentityTestHooks({
            processListExecFileSync: (() => "") as typeof execFileSync,
        });
        const db = openDatabase();
        expect(db).not.toBeNull();
        const dbPath = join(override, "shared", "context.db");
        expect(existsSync(dbPath)).toBe(true);
        expect(statSync(join(override, "shared")).mode & 0o777).toBe(0o700);
        expect(statSync(dbPath).mode & 0o777).toBe(0o600);
        closeDatabase();
    });
});

describe("storage-db", () => {
    describe("#given openDatabase", () => {
        it("#when called first time #then creates DB with WAL mode and busy_timeout", () => {
            const dataHome = useTempDataHome("storage-db-wal-");

            const db = openDatabase();

            const wal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
            const timeout = db.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
            expect(wal.journal_mode.toLowerCase()).toBe("wal");
            expect(Object.values(timeout)[0]).toBe(5000);
            expect(existsSync(resolveDbPath(dataHome))).toBe(true);
            expect(isDatabasePersisted(db)).toBe(true);
        });

        it("#when called first time #then restricts storage dir to 0o700 and DB files to 0o600", () => {
            // POSIX-only: chmod is a no-op on Windows (modes are not honored).
            if (process.platform === "win32") return;
            const dataHome = useTempDataHome("storage-db-perms-");

            openDatabase();

            const dbPath = resolveDbPath(dataHome);
            const dbDir = dirname(dbPath);
            // Low 9 permission bits only (mask off file-type/setuid bits).
            expect(statSync(dbDir).mode & 0o777).toBe(0o700);
            expect(statSync(dbPath).mode & 0o777).toBe(0o600);
            for (const suffix of ["-wal", "-shm"]) {
                const sidecar = `${dbPath}${suffix}`;
                if (existsSync(sidecar)) {
                    expect(statSync(sidecar).mode & 0o777).toBe(0o600);
                }
            }
        });

        it("#when private permission enforcement is disabled #then a full storage open makes zero chmod calls", () => {
            const dataHome = useTempDataHome("storage-db-external-perms-");
            const chmodCalls: Array<[string, number]> = [];
            setStoragePrivatePermissionEnforcement(false);
            __setStoragePermissionFsForTests({
                chmodSync: ((path, mode) => {
                    chmodCalls.push([String(path), Number(mode)]);
                }) as typeof chmodSync,
            });

            openDatabase();

            expect(existsSync(resolveDbPath(dataHome))).toBe(true);
            expect(chmodCalls).toEqual([]);
        });

        it("#when private permission enforcement is enabled #then a full storage open restricts the directory and database", () => {
            if (process.platform === "win32") return;
            const dataHome = useTempDataHome("storage-db-private-perms-spy-");
            const dbPath = resolveDbPath(dataHome);
            const chmodCalls: Array<[string, number]> = [];
            setStoragePrivatePermissionEnforcement(true);
            __setStoragePermissionFsForTests({
                chmodSync: ((path, mode) => {
                    chmodCalls.push([String(path), Number(mode)]);
                }) as typeof chmodSync,
            });

            openDatabase();

            expect(chmodCalls).toEqual(
                expect.arrayContaining([
                    [dirname(dbPath), 0o700],
                    [dbPath, 0o600],
                ]),
            );
        });

        it("#when downstream rows share context.db #then opens without treating them as future upstream schema", () => {
            const dataHome = useTempDataHome("storage-db-fork-rows-");
            const first = openDatabase();
            expect(first).not.toBeNull();
            first
                ?.prepare(
                    "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?), (?, ?, ?)",
                )
                .run(
                    FORK_MIGRATION_VERSION_FLOOR,
                    "fork migration 10000",
                    0,
                    FORK_MIGRATION_VERSION_FLOOR + 1,
                    "fork migration 10001",
                    0,
                );
            closeDatabase();

            const reopened = openDatabase();
            expect(reopened).not.toBeNull();
            expect(readPersistedVersion(resolveDbPath(dataHome))).toBe(LATEST_SUPPORTED_VERSION);
            expect(
                reopened
                    ?.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version >= ?")
                    .get(FORK_MIGRATION_VERSION_FLOOR),
            ).toEqual({ count: 2 });
        });

        it("#when called first time #then creates required tables", () => {
            useTempDataHome("storage-db-tables-");

            const db = openDatabase();

            const tables = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all() as Array<{ name: string }>;
            const tableNames = tables.map((t) => t.name);
            expect(tableNames).toEqual(
                expect.arrayContaining([
                    "tags",
                    "pending_ops",
                    "source_contents",
                    "compression_depth",
                    "session_meta",
                ]),
            );
        });

        it("keeps the shared session table list in lockstep with the live schema", () => {
            useTempDataHome("storage-db-session-table-list-");
            const db = openDatabase();
            const schemaTables = (
                db
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                    )
                    .all() as Array<{ name: string }>
            )
                .map((row) => row.name)
                .filter((table) => {
                    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                        name: string;
                    }>;
                    return columns.some((column) => column.name === "session_id");
                })
                .sort();

            // Every exact session_id column denotes session-owned rows. Durable
            // provenance that must survive session deletion uses explicit names
            // such as migration_pending.source_session_id instead.
            expect(SESSION_SCOPED_TABLES.map((definition) => definition.table).sort()).toEqual(
                schemaTables,
            );
        });

        it("#when clearSession runs #then every session-scoped table is emptied", () => {
            // Discover the contract from schema shape instead of maintaining a
            // second table list. Any new table with session_id is seeded here and
            // must be cleared by clearSession, so lifecycle omissions fail loudly.
            useTempDataHome("storage-db-clearsession-");
            const db = openDatabase();
            const sessionId = "ses_clearsession_fresh";
            const tableNames = (
                db
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                    )
                    .all() as Array<{ name: string }>
            )
                .map((row) => row.name)
                .filter((table) => {
                    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                        name: string;
                    }>;
                    return columns.some((column) => column.name === "session_id");
                });

            db.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
            for (const table of tableNames) {
                const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                    name: string;
                    type: string;
                    notnull: number;
                    dflt_value: string | null;
                    pk: number;
                }>;
                const insertedColumns = columns.filter(
                    (column) =>
                        column.name === "session_id" ||
                        (column.dflt_value === null &&
                            (column.notnull === 1 ||
                                (column.pk > 0 && column.type.toUpperCase() !== "INTEGER"))),
                );
                const values = insertedColumns.map((column) => {
                    if (column.name === "session_id") return sessionId;
                    const type = column.type.toUpperCase();
                    if (type.includes("INT") || type.includes("REAL")) return 1;
                    if (type.includes("BLOB")) return new Uint8Array([1]);
                    return "seed";
                });
                const placeholders = insertedColumns.map(() => "?").join(", ");
                db.prepare(
                    `INSERT INTO ${table} (${insertedColumns.map((column) => column.name).join(", ")}) VALUES (${placeholders})`,
                ).run(...values);
                expect(
                    db
                        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
                        .get(sessionId),
                ).toEqual({ count: 1 });
            }
            db.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");

            clearSession(db, sessionId);

            for (const table of tableNames) {
                expect(
                    db
                        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
                        .get(sessionId),
                    `${table} retained session-scoped rows`,
                ).toEqual({ count: 0 });
            }
        });

        it("#when called first time #then creates required session-scoped indexes", () => {
            useTempDataHome("storage-db-indexes-");

            const db = openDatabase();
            const indexes = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
                .all() as Array<{ name: string }>;
            const indexNames = indexes.map((item) => item.name);

            expect(indexNames).toEqual(
                expect.arrayContaining([
                    "idx_tags_session_tag_number",
                    "idx_pending_ops_session",
                    "idx_source_contents_session",
                    "idx_compartments_session",
                    "idx_compression_depth_session",
                    "idx_session_facts_session",
                    "idx_notes_session_status",
                    "idx_notes_project_status",
                    "idx_notes_type_status",
                ]),
            );
        });

        it("#when called a second time #then returns cached instance (singleton)", () => {
            useTempDataHome("storage-db-cached-");

            const db1 = openDatabase();
            const db2 = openDatabase();

            expect(db1).toBe(db2);
        });

        it("#when the RPC port tree is empty #then allows a pending migration", () => {
            const dataHome = useTempDataHome("storage-db-empty-rpc-migration-");
            const dbPath = seedPendingMigration(dataHome);
            mkdirSync(join(dirname(dbPath), "rpc"), { recursive: true });

            expect(openDatabase()).not.toBeNull();
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION);
            expect(getMigrationOnOpenRefusal()).toBeNull();
        });

        for (const scenario of [
            {
                name: "a confirmed live OpenCode server",
                pid: () => process.pid,
                configure: () => setLinuxIdentityProbe(),
                blocksMigration: true,
            },
            {
                name: "a dead OpenCode server PID",
                pid: () => 2_147_483_647,
                configure: () => undefined,
                blocksMigration: false,
            },
            {
                name: "an OpenCode server probe that sandbox policy prevents from running",
                pid: () => process.pid,
                configure: () => {
                    const permissionDenied = new Error(
                        "sandbox denied process probe",
                    ) as NodeJS.ErrnoException;
                    permissionDenied.code = "EPERM";
                    __setRpcIdentityTestHooks({
                        platform: "linux",
                        processKill: (() => {
                            throw permissionDenied;
                        }) as typeof process.kill,
                        readFileSync: (() => {
                            throw permissionDenied;
                        }) as typeof readFileSync,
                    });
                },
                blocksMigration: false,
            },
        ]) {
            it(`#when RPC discovery finds ${scenario.name} #then only the confirmed server blocks migration`, () => {
                const dataHome = useTempDataHome("storage-db-rpc-probe-matrix-");
                const dbPath = seedPendingMigration(dataHome);
                const portDir = join(dirname(dbPath), "rpc", "test-project");
                mkdirSync(portDir, { recursive: true });
                const pid = scenario.pid();
                writeFileSync(
                    join(portDir, `port-${pid}.json`),
                    JSON.stringify({ port: 43123, pid, started_at: 1_200_000 }),
                );
                scenario.configure();

                const opened = openDatabase();

                expect(opened === null).toBe(scenario.blocksMigration);
                expect(readPersistedVersion(dbPath)).toBe(
                    scenario.blocksMigration
                        ? LATEST_SUPPORTED_VERSION - 1
                        : LATEST_SUPPORTED_VERSION,
                );
                if (!scenario.blocksMigration && pid === process.pid) {
                    expect(inspectRpcServerDiscovery(dirname(dbPath))).toMatchObject({
                        state: "inconclusive",
                        serverPids: [],
                        inconclusivePids: [process.pid],
                    });
                    // Sandbox uncertainty must not look like a real multi-instance
                    // refusal: users need to know that migration continued safely.
                    expect(
                        formatInconclusiveOpenCodeMigrationWarning(dbPath, [process.pid]),
                    ).toContain("continuing migration");
                    expect(
                        formatInconclusiveOpenCodeMigrationWarning(dbPath, [process.pid]),
                    ).toContain("OS sandbox denied kill(0) or ps");
                }
            });
        }

        it("#when an older Pi harness is live #then refuses a pending migration", () => {
            const dataHome = useTempDataHome("storage-db-live-pi-migration-");
            const dbPath = seedPendingMigration(dataHome);
            __setRpcIdentityTestHooks({
                processListExecFileSync: (() =>
                    " 41001 node /opt/node_modules/@mariozechner/pi-coding-agent/dist/cli.js\n") as typeof execFileSync,
            });

            expect(openDatabase()).toBeNull();
            expect(getMigrationOnOpenRefusal()).toEqual({
                persistedVersion: LATEST_SUPPORTED_VERSION - 1,
                supportedVersion: LATEST_SUPPORTED_VERSION,
                serverPids: [41001],
                blockingProcesses: [{ kind: "Pi", pid: 41001 }],
            });
            expect(getLiveMigrationBlockingProcesses(dirname(dbPath))).toEqual([
                { kind: "Pi", pid: 41001 },
            ]);
            expect(
                formatLiveProcessMigrationRefusal(
                    dbPath,
                    LATEST_SUPPORTED_VERSION - 1,
                    LATEST_SUPPORTED_VERSION,
                    [],
                    [41001],
                ),
            ).toContain("confirmed Pi harness PID 41001");
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION - 1);
        });

        it("#when an unrelated Pi harness is live #then opens a fresh explicit-path database", () => {
            const isolatedRoot = makeTempDir("storage-db-isolated-live-pi-");
            const dbPath = join(isolatedRoot, "profile", "context.db");
            __setRpcIdentityTestHooks({
                processListExecFileSync: (() =>
                    " 41001 node /opt/node_modules/@mariozechner/pi-coding-agent/dist/cli.js\n") as typeof execFileSync,
            });

            expect(openDatabase(dbPath)).not.toBeNull();
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION);
            expect(getMigrationOnOpenRefusal()).toBeNull();
        });

        it("#when an unrelated Pi harness is live #then opens a test-data-dir database", () => {
            const savedXdg = process.env.XDG_DATA_HOME;
            const savedTestDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
            const isolatedRoot = makeTempDir("storage-db-test-data-dir-live-pi-");
            const dbPath = join(isolatedRoot, "cortexkit", "magic-context", "context.db");
            mkdirSync(dirname(dbPath), { recursive: true });
            closeQuietly(new Database(dbPath));
            delete process.env.XDG_DATA_HOME;
            process.env.MAGIC_CONTEXT_TEST_DATA_DIR = isolatedRoot;
            __setRpcIdentityTestHooks({
                processListExecFileSync: (() =>
                    " 41001 node /opt/node_modules/@mariozechner/pi-coding-agent/dist/cli.js\n") as typeof execFileSync,
            });

            try {
                const db = openDatabase();
                expect(db).not.toBeNull();
                expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION);
                expect(getMigrationOnOpenRefusal()).toBeNull();
            } finally {
                if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
                else process.env.XDG_DATA_HOME = savedXdg;
                if (savedTestDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
                else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = savedTestDir;
            }
        });

        it("#when an explicit-path database has same-directory live RPC evidence #then refuses migration", () => {
            const isolatedRoot = makeTempDir("storage-db-isolated-same-dir-rpc-");
            const dbPath = join(isolatedRoot, "profile", "context.db");
            const portDir = join(dirname(dbPath), "rpc", "test-project");
            mkdirSync(portDir, { recursive: true });
            writeFileSync(
                join(portDir, `port-${process.pid}.json`),
                JSON.stringify({ port: 43123, pid: process.pid, started_at: 1_200_000 }),
            );
            setLinuxIdentityProbe();

            expect(openDatabase(dbPath)).toBeNull();
            expect(getMigrationOnOpenRefusal()).toMatchObject({
                persistedVersion: 0,
                supportedVersion: LATEST_SUPPORTED_VERSION,
                serverPids: [process.pid],
            });
            expect(readPersistedVersion(dbPath)).toBe(0);
        });

        it("#when sandbox policy prevents the Pi process-list probe #then allows a pending migration", () => {
            const dataHome = useTempDataHome("storage-db-inconclusive-pi-migration-");
            const dbPath = seedPendingMigration(dataHome);
            __setRpcIdentityTestHooks({
                processListExecFileSync: (() => {
                    const error = new Error("sandbox denied ps") as NodeJS.ErrnoException;
                    error.code = "EPERM";
                    throw error;
                }) as typeof execFileSync,
            });

            expect(openDatabase()).not.toBeNull();
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION);
            expect(getMigrationOnOpenRefusal()).toBeNull();
        });

        it("#when every advertised PID is stale #then deletes stale files and allows migration", () => {
            const dataHome = useTempDataHome("storage-db-stale-rpc-migration-");
            const dbPath = seedPendingMigration(dataHome);
            const portDir = join(dirname(dbPath), "rpc", "test-project");
            mkdirSync(portDir, { recursive: true });
            const portFile = join(portDir, "port-2147483647.json");
            writeFileSync(
                portFile,
                JSON.stringify({ port: 43123, pid: 2_147_483_647, started_at: 1 }),
            );

            expect(openDatabase()).not.toBeNull();
            expect(existsSync(portFile)).toBe(false);
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION);
        });

        it("#when a fresh port file is unparseable #then refuses migration during the grace window", () => {
            const dataHome = useTempDataHome("storage-db-invalid-rpc-migration-");
            const dbPath = seedPendingMigration(dataHome);
            const portDir = join(dirname(dbPath), "rpc", "test-project");
            mkdirSync(portDir, { recursive: true });
            const portFile = join(portDir, "port-12345.json");
            writeFileSync(portFile, "{not-json");

            // The writer uses temp-file-plus-rename, but the grace window is cheap
            // insurance for files left by older or interrupted installations.
            expect(openDatabase()).toBeNull();
            expect(getMigrationOnOpenRefusal()).toEqual({
                persistedVersion: LATEST_SUPPORTED_VERSION - 1,
                supportedVersion: LATEST_SUPPORTED_VERSION,
                serverPids: [],
                blockingProcesses: [],
                unreadableFile: portFile,
                unreadableArm: "parse",
            });
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION - 1);
        });

        it("#when old malformed and pidless records are discovered #then deletes them and allows migration", () => {
            const dataHome = useTempDataHome("storage-db-junk-rpc-migration-");
            const dbPath = seedPendingMigration(dataHome);
            const portDir = join(dirname(dbPath), "rpc", "test-project");
            mkdirSync(portDir, { recursive: true });
            const junk = [
                ["port-1001.json", ""],
                ["port-1002.json", '{"port":'],
                ["port-1003.json", JSON.stringify({ port: 43123, started_at: 1 })],
                ["port-1004.json", "\\u0000\\uffffbinary"],
                ["port-1005.json", JSON.stringify({ port: 43123, pid: 0 })],
            ].map(([name, content]) => {
                const file = join(portDir, name);
                writeFileSync(file, content);
                const old = new Date(Date.now() - 11 * 60 * 1000);
                utimesSync(file, old, old);
                return file;
            });

            expect(openDatabase()).not.toBeNull();
            for (const file of junk) expect(existsSync(file)).toBe(false);
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION);
            expect(getMigrationOnOpenRefusal()).toBeNull();
        });

        it("#when malformed records are fresh #then leaves them and refuses migration", () => {
            const dataHome = useTempDataHome("storage-db-fresh-junk-rpc-migration-");
            const dbPath = seedPendingMigration(dataHome);
            const portDir = join(dirname(dbPath), "rpc", "test-project");
            mkdirSync(portDir, { recursive: true });
            const junk = [
                ["port-1001.json", ""],
                ["port-1002.json", '{"port":'],
                ["port-1003.json", JSON.stringify({ port: 43123, started_at: 1 })],
                ["port-1004.json", "\\u0000\\uffffbinary"],
                ["port-1005.json", JSON.stringify({ port: 43123, pid: 0 })],
            ].map(([name, content]) => {
                const file = join(portDir, name);
                writeFileSync(file, content);
                return file;
            });

            expect(openDatabase()).toBeNull();
            expect(junk.some((file) => getMigrationOnOpenRefusal()?.unreadableFile === file)).toBe(
                true,
            );
            expect(getMigrationOnOpenRefusal()?.unreadableArm).toBe("parse");
            for (const file of junk) expect(existsSync(file)).toBe(true);
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION - 1);
        });

        it("#when a port path cannot be read as a file #then refuses migration and names the io arm", () => {
            const dataHome = useTempDataHome("storage-db-unreadable-rpc-migration-");
            const dbPath = seedPendingMigration(dataHome);
            const portDir = join(dirname(dbPath), "rpc", "test-project");
            const unreadableFile = join(portDir, "port-12345.json");
            mkdirSync(unreadableFile, { recursive: true });

            expect(openDatabase()).toBeNull();
            expect(getMigrationOnOpenRefusal()).toMatchObject({
                unreadableFile,
                unreadableArm: "io",
            });
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION - 1);
        });

        it("#when reading a port file returns EACCES #then refuses migration without deleting it", () => {
            const dataHome = useTempDataHome("storage-db-eacces-rpc-migration-");
            const dbPath = seedPendingMigration(dataHome);
            const portDir = join(dirname(dbPath), "rpc", "test-project");
            mkdirSync(portDir, { recursive: true });
            const unreadableFile = join(portDir, "port-12345.json");
            writeFileSync(unreadableFile, JSON.stringify({ port: 43123, pid: 12345 }));
            __setRpcDiscoveryFsForTests({
                readFileSync: (path) => {
                    if (path === unreadableFile) {
                        const error = new Error("permission denied") as NodeJS.ErrnoException;
                        error.code = "EACCES";
                        throw error;
                    }
                    throw new Error(`unexpected discovery read: ${path}`);
                },
            });

            expect(openDatabase()).toBeNull();
            expect(getMigrationOnOpenRefusal()).toMatchObject({
                unreadableFile,
                unreadableArm: "io",
            });
            expect(existsSync(unreadableFile)).toBe(true);
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION - 1);
        });

        it("#when stale junk cleanup returns EACCES #then refuses migration with the cleanup file named", () => {
            const dataHome = useTempDataHome("storage-db-unlink-eacces-rpc-migration-");
            const dbPath = seedPendingMigration(dataHome);
            const portDir = join(dirname(dbPath), "rpc", "test-project");
            mkdirSync(portDir, { recursive: true });
            const staleFile = join(portDir, "port-12345.json");
            writeFileSync(staleFile, "{not-json");
            const old = new Date(Date.now() - 11 * 60 * 1000);
            utimesSync(staleFile, old, old);
            __setRpcDiscoveryFsForTests({
                unlinkSync: (path) => {
                    if (path === staleFile) {
                        const error = new Error("permission denied") as NodeJS.ErrnoException;
                        error.code = "EACCES";
                        throw error;
                    }
                    throw new Error(`unexpected discovery unlink: ${path}`);
                },
            });

            expect(openDatabase()).toBeNull();
            expect(getMigrationOnOpenRefusal()).toMatchObject({
                unreadableFile: staleFile,
                unreadableArm: "io",
            });
            expect(existsSync(staleFile)).toBe(true);
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION - 1);
        });

        it("#when the RPC directory cannot be enumerated #then refuses migration", () => {
            const dataHome = useTempDataHome("storage-db-unreadable-rpc-dir-migration-");
            const dbPath = seedPendingMigration(dataHome);
            const rpcPath = join(dirname(dbPath), "rpc");
            writeFileSync(rpcPath, "not-a-directory");

            expect(openDatabase()).toBeNull();
            expect(getMigrationOnOpenRefusal()?.unreadableFile).toBe(rpcPath);
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION - 1);
        });

        it("#when an alive PID is reused by a newer process #then removes the record and allows migration", () => {
            const dataHome = useTempDataHome("storage-db-reused-pid-migration-");
            const dbPath = seedPendingMigration(dataHome);
            const portDir = join(dirname(dbPath), "rpc", "test-project");
            mkdirSync(portDir, { recursive: true });
            const portFile = join(portDir, `port-${process.pid}.json`);
            writeFileSync(
                portFile,
                JSON.stringify({ port: 43123, pid: process.pid, started_at: 500_000 }),
            );
            setLinuxIdentityProbe();

            // The mocked process starts at 1,100,000ms, far after this record's
            // timestamp, so process.kill(pid, 0) cannot make it look live.
            expect(inspectRpcServerDiscovery(dirname(dbPath))).toEqual({
                state: "stale",
                serverPids: [],
                staleFiles: [portFile],
            });
            expect(existsSync(portFile)).toBe(false);
            expect(openDatabase()).not.toBeNull();
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION);
            expect(getMigrationOnOpenRefusal()).toBeNull();
        });

        it("#when a live record shares a directory with old junk #then live wins, junk is cleaned, and migration stays blocked", () => {
            const dataHome = useTempDataHome("storage-db-live-with-junk-rpc-migration-");
            const dbPath = resolveDbPath(dataHome);
            mkdirSync(dirname(dbPath), { recursive: true });
            const legacy = new Database(dbPath);
            legacy.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
                INSERT INTO schema_migrations(version) VALUES (${LATEST_SUPPORTED_VERSION - 1});
            `);
            legacy.close();

            const portDir = join(dirname(dbPath), "rpc", "test-project");
            mkdirSync(portDir, { recursive: true });
            const livePortFile = join(portDir, `port-${process.pid}.json`);
            const junkFiles = [
                ["port-41001.json", ""],
                ["port-41002.json", "{not-json"],
                ["port-41003.json", JSON.stringify({ port: 43125, started_at: 1 })],
            ].map(([name, content]) => {
                const file = join(portDir, name);
                writeFileSync(file, content);
                const old = new Date(Date.now() - 11 * 60 * 1000);
                utimesSync(file, old, old);
                return file;
            });
            writeFileSync(
                livePortFile,
                JSON.stringify({ port: 43123, pid: process.pid, started_at: 1_200_000 }),
            );
            setLinuxIdentityProbe();

            expect(openDatabase()).toBeNull();
            expect(getMigrationOnOpenRefusal()).toMatchObject({
                serverPids: [process.pid],
            });
            for (const junkFile of junkFiles) expect(existsSync(junkFile)).toBe(false);
            expect(existsSync(livePortFile)).toBe(true);
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION - 1);
        });

        it("#when a discovery record provides a process kind #then it takes precedence over command probes", () => {
            const dataHome = useTempDataHome("storage-db-record-kind-migration-");
            const dbPath = resolveDbPath(dataHome);
            mkdirSync(dirname(dbPath), { recursive: true });
            const legacy = new Database(dbPath);
            legacy.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
                INSERT INTO schema_migrations(version) VALUES (${LATEST_SUPPORTED_VERSION - 1});
                INSERT INTO schema_migrations(version) VALUES (${FORK_MIGRATION_VERSION_FLOOR});
            `);
            legacy.close();

            const portDir = join(dirname(dbPath), "rpc", "test-project");
            mkdirSync(portDir, { recursive: true });
            writeFileSync(
                join(portDir, `port-${process.pid}.json`),
                JSON.stringify({
                    port: 43123,
                    pid: process.pid,
                    started_at: 1_200_000,
                    kind: "Pi",
                }),
            );
            setLinuxIdentityProbe();

            expect(openDatabase()).toBeNull();
            expect(getMigrationOnOpenRefusal()?.blockingProcesses).toEqual([
                { kind: "Pi", pid: process.pid },
            ]);
        });

        it("#when a live OpenCode server advertises a port #then refuses a pending migration", () => {
            const dataHome = useTempDataHome("storage-db-live-server-migration-");
            const dbPath = resolveDbPath(dataHome);
            mkdirSync(dirname(dbPath), { recursive: true });
            const legacy = new Database(dbPath);
            legacy.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
                INSERT INTO schema_migrations(version) VALUES (${LATEST_SUPPORTED_VERSION - 1});
                INSERT INTO schema_migrations(version) VALUES (${FORK_MIGRATION_VERSION_FLOOR});
            `);
            legacy.close();

            const portDir = join(dirname(dbPath), "rpc", "test-project");
            mkdirSync(portDir, { recursive: true });
            const livePortFile = join(portDir, `port-${process.pid}.json`);
            const stalePortFile = join(portDir, "port-2147483647.json");
            const junkFiles = [
                ["port-31001.json", ""],
                ["port-31002.json", "{not-json"],
                ["port-31003.json", JSON.stringify({ port: 43125, started_at: 1 })],
            ].map(([name, content]) => {
                const file = join(portDir, name);
                writeFileSync(file, content);
                const old = new Date(Date.now() - 11 * 60 * 1000);
                utimesSync(file, old, old);
                return file;
            });
            writeFileSync(
                livePortFile,
                JSON.stringify({ port: 43123, pid: process.pid, started_at: 1_200_000 }),
            );
            writeFileSync(
                stalePortFile,
                JSON.stringify({ port: 43124, pid: 2_147_483_647, started_at: 1 }),
            );
            setLinuxIdentityProbe();

            // The port file makes this test prove the pre-migration refusal. If the
            // guard is removed, openDatabase migrates this fixture and this assertion
            // goes red because the DB is no longer left at the previous version.
            expect(openDatabase()).toBeNull();
            expect(existsSync(stalePortFile)).toBe(false);
            for (const junkFile of junkFiles) expect(existsSync(junkFile)).toBe(false);
            expect(existsSync(livePortFile)).toBe(true);
            expect(getMigrationOnOpenRefusal()).toEqual({
                persistedVersion: LATEST_SUPPORTED_VERSION - 1,
                supportedVersion: LATEST_SUPPORTED_VERSION,
                serverPids: [process.pid],
                blockingProcesses: [{ kind: "process", pid: process.pid }],
            });
            expect(getLiveMigrationBlockingProcesses(dirname(dbPath))).toEqual([
                { kind: "process", pid: process.pid },
            ]);
            const unchanged = new Database(dbPath);
            expect(getPersistedSchemaVersion(unchanged)).toBe(LATEST_SUPPORTED_VERSION - 1);
            expect(
                unchanged
                    .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
                    .get(FORK_MIGRATION_VERSION_FLOOR),
            ).toEqual({ 1: 1 });
            unchanged.close();
        });

        it("#when file path setup fails #then throws so callers fail closed (no in-memory fallback)", () => {
            const dataHome = useTempDataHome("storage-db-fallback-");
            // Block mkdirSync by planting a file at the cortexkit segment of
            // the new shared path. See storage.test.ts for the same pattern.
            writeFileSync(join(dataHome, "cortexkit"), "not-a-directory", "utf-8");

            // Failing closed is intentional. Falling back to :memory: silently
            // disables persistent state (memories, historian compartments,
            // tags) but keeps the transform running, which on Pi/OpenCode can
            // let the full raw history reach the model and overflow context.
            // Callers must catch this and disable Magic Context for the run.
            expect(() => openDatabase()).toThrow(/storage unavailable/i);
        });

        it("#when an existing session_meta table lacks compartment_in_progress #then openDatabase adds the missing column", () => {
            const dataHome = useTempDataHome("storage-db-migrate-compartment-flag-");
            const dbPath = resolveDbPath(dataHome);
            mkdirSync(join(dataHome, "cortexkit", "magic-context"), {
                recursive: true,
            });
            const legacyDb = new Database(dbPath);
            legacyDb.run(`
        CREATE TABLE session_meta (
          session_id TEXT PRIMARY KEY,
          last_response_time INTEGER,
          cache_ttl TEXT,
          counter INTEGER DEFAULT 0,
          last_nudge_tokens INTEGER DEFAULT 0,
          last_nudge_band TEXT DEFAULT '',
          last_transform_error TEXT DEFAULT '',
          nudge_anchor_message_id TEXT DEFAULT '',
          nudge_anchor_text TEXT DEFAULT '',
          sticky_turn_reminder_text TEXT DEFAULT '',
          sticky_turn_reminder_message_id TEXT DEFAULT '',
          is_subagent INTEGER DEFAULT 0,
          last_context_percentage REAL DEFAULT 0,
          last_input_tokens INTEGER DEFAULT 0,
          observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_alert_sent INTEGER NOT NULL DEFAULT 0,
          times_execute_threshold_reached INTEGER DEFAULT 0,
          historian_failure_count INTEGER DEFAULT 0,
          historian_last_error TEXT DEFAULT NULL,
          historian_last_failure_at INTEGER DEFAULT NULL,
          cleared_reasoning_through_tag INTEGER DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
      `);
            closeQuietly(legacyDb);

            const db = openDatabase();
            const columns = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;

            expect(columns.map((column) => column.name)).toEqual(
                expect.arrayContaining([
                    "compartment_in_progress",
                    "historian_failure_count",
                    "historian_last_error",
                    "historian_last_failure_at",
                ]),
            );
        });

        it("#when an existing memory_embeddings table lacks model_id #then openDatabase adds the missing column", () => {
            const dataHome = useTempDataHome("storage-db-migrate-embedding-model-");
            const dbPath = resolveDbPath(dataHome);
            mkdirSync(join(dataHome, "cortexkit", "magic-context"), {
                recursive: true,
            });
            const legacyDb = new Database(dbPath);
            legacyDb.run(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          category TEXT NOT NULL,
          content TEXT NOT NULL,
          normalized_hash TEXT NOT NULL,
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
          superseded_by_memory_id INTEGER,
          merged_from TEXT,
          metadata_json TEXT,
          UNIQUE(project_path, category, normalized_hash)
        );

        CREATE TABLE memory_embeddings (
          memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL
        );
      `);
            closeQuietly(legacyDb);

            const db = openDatabase();
            const columns = db.prepare("PRAGMA table_info(memory_embeddings)").all() as Array<{
                name?: string;
            }>;

            expect(columns.map((column) => column.name)).toContain("model_id");
        });
    });

    describe("#given closeDatabase", () => {
        it("#when called after openDatabase #then clears the cached instance", () => {
            useTempDataHome("storage-db-close-");

            const db1 = openDatabase();
            closeDatabase();
            const db2 = openDatabase();

            expect(db1).not.toBe(db2);
        });

        it("#when called multiple times #then does not throw", () => {
            useTempDataHome("storage-db-multi-close-");

            openDatabase();
            expect(() => closeDatabase()).not.toThrow();
            expect(() => closeDatabase()).not.toThrow();
            expect(() => closeDatabase()).not.toThrow();
        });

        it("#when called without prior open #then does not throw", () => {
            expect(() => closeDatabase()).not.toThrow();
        });
    });

    // Regression guard for the 2026-06-01 (v26) / 2026-06-19 (v41) incidents:
    // a `bun test` run from a CWD whose bunfig lacks `[test] preload` ran the
    // package suites with NO isolation, so a bare openDatabase() migrated the
    // user's REAL shared DB. The NODE_ENV=test backstop in resolveDatabasePath
    // makes that structurally impossible from ANY CWD.
    describe("#given the test-isolation backstop", () => {
        const realStorageRoot = join(homedir(), ".local", "share", "cortexkit");

        it("#when NODE_ENV=test and XDG_DATA_HOME unset #then never resolves to the real shared DB", () => {
            // Simulate an UNISOLATED run: no preload-set vars at all.
            const savedXdg = process.env.XDG_DATA_HOME;
            const savedTestDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
            process.env.NODE_ENV = "test";
            delete process.env.XDG_DATA_HOME;
            delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
            try {
                const { dbPath } = resolveDatabasePath();
                expect(dbPath.startsWith(realStorageRoot)).toBe(false);
                expect(dbPath.includes("mc-test-db-backstop-")).toBe(true);
            } finally {
                if (savedXdg !== undefined) process.env.XDG_DATA_HOME = savedXdg;
                if (savedTestDir !== undefined)
                    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = savedTestDir;
            }
        });

        it("#when a test sets its own XDG_DATA_HOME #then that controlled dir is honored", () => {
            const dataHome = useTempDataHome("storage-db-backstop-xdg-");
            const { dbPath } = resolveDatabasePath();
            expect(dbPath).toBe(resolveDbPath(dataHome));
        });

        it("#then every test package wires the isolation preload (root + plugin + pi-plugin + cli)", () => {
            // Structural guard: a new test package that forgets its bunfig
            // `[test] preload` is the exact hole that caused both incidents.
            const repoRoot = join(__dirname, "..", "..", "..", "..", "..");
            const bunfigs = [
                "bunfig.toml",
                "packages/plugin/bunfig.toml",
                "packages/pi-plugin/bunfig.toml",
                "packages/cli/bunfig.toml",
            ];
            for (const rel of bunfigs) {
                const full = join(repoRoot, rel);
                expect(existsSync(full)).toBe(true);
                const body = readFileSync(full, "utf8");
                expect(body.includes("[test]")).toBe(true);
                expect(body.includes("preload")).toBe(true);
                expect(body.includes("test-preload.ts")).toBe(true);
            }
        });
    });
});
