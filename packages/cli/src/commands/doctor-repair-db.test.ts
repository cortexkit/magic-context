/// <reference types="bun-types" />

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    closeSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    rmSync,
    statSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import {
    initializeDatabase,
    inspectRpcServerDiscovery,
    LATEST_SUPPORTED_VERSION,
} from "@magic-context/core/features/magic-context/storage-db";
import { rpcPortFilePath } from "@magic-context/core/shared/rpc-utils";
import { Database } from "@magic-context/core/shared/sqlite";
import { writeTestExecutable } from "@magic-context/core/shared/test-fake-executable";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";

import type { PromptIO, PromptSpinner, SelectOption } from "../lib/prompts";
import {
    copyDatabaseBundle,
    defaultSqliteExecutable,
    migrateAndCheckRecoveredDatabase,
    REPAIR_DB_EXIT,
    runRepairDb,
    schemaMigrationWarning,
} from "./doctor-repair-db";

setDefaultTimeout(60_000);

const tempDirs: string[] = [];

class MockPrompts implements PromptIO {
    readonly messages: string[] = [];
    private readonly confirmations: boolean[];

    constructor(confirmations: boolean[] = []) {
        this.confirmations = [...confirmations];
    }

    readonly log = {
        info: (message: string) => this.messages.push(`info:${message}`),
        success: (message: string) => this.messages.push(`success:${message}`),
        warn: (message: string) => this.messages.push(`warn:${message}`),
        error: (message: string) => this.messages.push(`error:${message}`),
        message: (message: string) => this.messages.push(`message:${message}`),
        step: (message: string) => this.messages.push(`step:${message}`),
    };

    intro(message: string): void {
        this.messages.push(`intro:${message}`);
    }

    outro(message: string): void {
        this.messages.push(`outro:${message}`);
    }

    note(message: string, title?: string): void {
        this.messages.push(`note:${title ?? ""}:${message}`);
    }

    spinner(): PromptSpinner {
        return {
            start: () => {},
            stop: () => {},
            message: () => {},
        };
    }

    async confirm(message: string): Promise<boolean> {
        this.messages.push(`confirm:${message}`);
        return this.confirmations.shift() ?? false;
    }

    async text(): Promise<string> {
        throw new Error("unexpected text prompt");
    }

    async selectOne(_message: string, _options: SelectOption[]): Promise<string> {
        throw new Error("unexpected select prompt");
    }

    async selectMany(): Promise<string[]> {
        throw new Error("unexpected multiselect prompt");
    }

    async selectAutocomplete(): Promise<string> {
        throw new Error("unexpected autocomplete prompt");
    }
}

function tempStorage(): string {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-repair-db-"));
    tempDirs.push(root);
    return root;
}

function digest(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function seedCurrentDatabase(dbPath: string): void {
    const db = new Database(dbPath);
    initializeDatabase(db);
    runMigrations(db);
    const insertTag = db.prepare(
        "INSERT INTO tags (session_id, type, status, byte_size, tag_number, harness) VALUES (?, 'message', 'active', ?, ?, 'opencode')",
    );
    const insertCompartment = db.prepare(
        `INSERT INTO compartments
            (session_id, sequence, start_message, end_message, title, content, created_at, harness)
         VALUES ('session-main', ?, ?, ?, ?, ?, ?, 'opencode')`,
    );
    const insertMemory = db.prepare(
        `INSERT INTO memories
            (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
         VALUES ('/project', 'CONSTRAINTS', ?, ?, ?, ?, ?, ?)`,
    );
    const insertNote = db.prepare(
        `INSERT INTO notes
            (type, status, content, session_id, created_at, updated_at, harness)
         VALUES ('session', 'active', ?, 'session-main', ?, ?, 'opencode')`,
    );
    const insertDreamRun = db.prepare(
        `INSERT INTO dream_runs
            (project_path, started_at, finished_at, holder_id, tasks_json)
         VALUES ('/project', ?, ?, 'test-holder', '[]')`,
    );
    db.transaction(() => {
        for (let index = 1; index <= 300; index++) {
            const content = `tag-${index}-${"t".repeat(700)}`;
            insertTag.run("session-main", Buffer.byteLength(content), index);
            db.prepare(
                "INSERT INTO source_contents (tag_id, session_id, content, created_at, harness) VALUES (?, 'session-main', ?, ?, 'opencode')",
            ).run(index, content, index);
        }
        for (let index = 1; index <= 23; index++) {
            insertCompartment.run(
                index,
                index,
                index,
                `compartment-${index}`,
                `knowledge-${index}-${"c".repeat(200)}`,
                index,
            );
        }
        for (let index = 1; index <= 26; index++) {
            insertMemory.run(
                `memory-${index}-${"m".repeat(200)}`,
                `hash-${index}`,
                index,
                index,
                index,
                index,
            );
        }
        for (let index = 1; index <= 4; index++) insertNote.run(`note-${index}`, index, index);
        for (let index = 1; index <= 3; index++) insertDreamRun.run(index, index);
    })();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("PRAGMA journal_mode=DELETE");
    db.close();
}

function corruptLastTagLeaf(dbPath: string): void {
    // Damage the CELL CONTENT of one leaf page of the `tags` b-tree while leaving the page
    // header and cell pointer array intact, so `.recover` can still walk the tree and salvage
    // the other pages. Three things this deliberately avoids, each of which made the fixture
    // depend on the toolchain rather than on the code under test:
    //   - `dbstat` to find the page: a compile-time option (SQLITE_ENABLE_DBSTAT_VTAB) that
    //     some SQLite builds omit entirely.
    //   - scanning the file for row text: picks a different page depending on how the build
    //     packs cells, so a different page gets destroyed on each machine.
    //   - zeroing the whole page: destroys the header too, and whether `.recover` can still
    //     rebuild the tree after that varies by SQLite version — locally it salvaged, on CI
    //     it gave up and the command correctly reported the database unsalvageable.
    // Walking the documented on-disk format keeps page SELECTION deterministic, and damaging
    // only the cell area keeps the RESULT deterministic.
    const db = new Database(dbPath, { readonly: true });
    const { page_size: pageSize } = db.prepare("PRAGMA page_size").get() as { page_size: number };
    const { rootpage } = db
        .prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'tags'")
        .get() as { rootpage: number };
    db.close();

    const fd = openSync(dbPath, "r+");
    try {
        const buffer = Buffer.alloc(pageSize);
        let pageno = rootpage;
        // Page 1 carries the 100-byte database header before its b-tree header.
        for (let depth = 0; depth < 32; depth++) {
            readSync(fd, buffer, 0, pageSize, (pageno - 1) * pageSize);
            const headerAt = pageno === 1 ? 100 : 0;
            const pageType = buffer[headerAt];
            if (pageType === 0x0d) break; // leaf table page
            if (pageType !== 0x05)
                throw new Error(`unexpected page type 0x${pageType.toString(16)}`);
            // Interior table page: the rightmost child pointer lives at header offset 8.
            pageno = buffer.readUInt32BE(headerAt + 8);
        }
        const headerAt = pageno === 1 ? 100 : 0;
        readSync(fd, buffer, 0, pageSize, (pageno - 1) * pageSize);
        if (buffer[headerAt] !== 0x0d) throw new Error("no tags leaf page found");
        // Cell content begins at the offset in header bytes 5-6; everything from there to the
        // end of the page is row data. Overwrite it and leave the 8-byte header plus the cell
        // pointer array alone.
        const cellContentStart = buffer.readUInt16BE(headerAt + 5) || pageSize;
        const damage = Buffer.alloc(pageSize - cellContentStart, 0xff);
        writeSync(fd, damage, 0, damage.length, (pageno - 1) * pageSize + cellContentStart);
    } finally {
        closeSync(fd);
    }
}

function rowCount(db: Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function integrity(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
        return (
            db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>
        ).map((row) => row.integrity_check);
    } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
    } finally {
        db.close();
    }
}

// The salvage test needs exactly what `runRepairDb` uses by default: a sqlite3
// whose `.recover` works. `.recover` reads raw pages through the sqlite_dbpage
// virtual table, a compile-time option (SQLITE_ENABLE_DBPAGE_VTAB) that distro
// builds may omit, so probe the executable once at load time and skip the
// salvage test when the capability is absent. The probe returns a verdict only
// when sqlite3 gave an unambiguous answer; anything else throws and fails this
// file loudly — a skip must never hide a broken probe.
function probeRecoverCapability(sqliteExecutable: string): {
    available: boolean;
    reason: string;
} {
    const result = spawnSync(
        sqliteExecutable,
        [":memory:", "SELECT 1 FROM sqlite_dbpage LIMIT 1"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    if (result.error) {
        return { available: false, reason: `sqlite3 could not start (${result.error.message})` };
    }
    if (result.status === 0) return { available: true, reason: "sqlite_dbpage is available" };
    const stderr = String(result.stderr ?? "").trim();
    if (/no such table: sqlite_dbpage|no such module: sqlite_dbpage/i.test(stderr)) {
        return {
            available: false,
            reason: `this sqlite3 build lacks SQLITE_ENABLE_DBPAGE_VTAB (${stderr})`,
        };
    }
    throw new Error(
        `recover capability probe got an unrecognized answer from sqlite3 (exit ${String(result.status)}): ${stderr || "no stderr"}`,
    );
}

const salvageCapability = probeRecoverCapability(defaultSqliteExecutable());
const salvageIt = salvageCapability.available ? it : it.skip;
// The .recover-dependent test names live in consts so their salvageIt(...)
// registrations fit the formatter's 100-column limit.
const salvageTestName =
    "backs up and salvages readable rows from a genuinely corrupted SQLite page";
const unsalvageableTestName =
    "reports an unsalvageable database distinctly and preserves every source sidecar";

afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("doctor repair-db", () => {
    it("creates private database backup files", () => {
        if (process.platform === "win32") return;
        const root = createTestTempDirFromPath(
            join(tmpdir(), "magic-context/doctor-backup-permissions-"),
        );
        tempDirs.push(root);
        const source = join(root, "context.db");
        const destination = join(root, "backups", "context.db");
        writeFileSync(source, "backup fixture");
        chmodSync(source, 0o644);

        expect(copyDatabaseBundle(source, destination)).toEqual([destination]);
        expect(statSync(destination).mode & 0o777).toBe(0o600);
    });

    if (!salvageCapability.available) {
        // The salvage test below is registered as skipped; this test states why
        // and proves the skip came from a deliberate probe verdict rather than a
        // probe that merely guessed — a green suite that never ran the salvage
        // path must at least show its reason.
        it(`salvage test skipped: ${salvageCapability.reason}`, () => {
            expect(salvageCapability.reason).toMatch(/SQLITE_ENABLE_DBPAGE_VTAB|could not start/);
        });
    }

    salvageIt(salvageTestName, async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        seedCurrentDatabase(dbPath);
        corruptLastTagLeaf(dbPath);
        expect(integrity(dbPath)).not.toEqual(["ok"]);
        const corruptDigest = digest(dbPath);
        const prompts = new MockPrompts();

        const code = await runRepairDb({
            dbPath,
            storageDir,
            prompts,
            deps: { now: () => new Date("2026-08-11T12:34:56.789Z") },
        });

        // Report WHY salvage failed rather than just the exit code. The command captures its
        // reason in prompts.messages, and without surfacing it a failure here says only
        // "expected 0, received 2" — which cost several CI round-trips diagnosing a fixture
        // whose behaviour differed by SQLite version.
        expect({ code, why: prompts.messages.filter((m) => m.startsWith("error:")) }).toEqual({
            code: REPAIR_DB_EXIT.salvaged,
            why: [],
        });
        expect(integrity(dbPath)).toEqual(["ok"]);
        const recovered = new Database(dbPath, { readonly: true });
        const recoveredTags = rowCount(recovered, "tags");
        expect(recoveredTags).toBeGreaterThan(0);
        expect(recoveredTags).toBeLessThan(300);
        expect(rowCount(recovered, "compartments")).toBe(23);
        expect(rowCount(recovered, "memories")).toBe(26);
        expect(rowCount(recovered, "notes")).toBe(4);
        expect(rowCount(recovered, "dream_runs")).toBe(3);
        const version = recovered
            .prepare(
                "SELECT MAX(version) AS version FROM schema_migrations WHERE version < 1000000",
            )
            .get() as { version: number };
        recovered.close();
        expect(version.version).toBe(LATEST_SUPPORTED_VERSION);

        const files = readdirSync(storageDir);
        const backup = files.find((name) => name.startsWith("context.db.corrupt-backup-"));
        const original = files.find((name) => name.startsWith("context.db.corrupt-original-"));
        expect(backup).toBeDefined();
        expect(original).toBeDefined();
        expect(digest(join(storageDir, backup as string))).toBe(corruptDigest);
        expect(digest(join(storageDir, original as string))).toBe(corruptDigest);
        const output = prompts.messages.join("\n");
        expect(output).toContain(`Database: ${dbPath}`);
        expect(output).toContain("Attempting SQLite .recover");
        expect(output).toContain("Row counts BEFORE recovery");
        expect(output).toContain(
            `Schema migration: v${LATEST_SUPPORTED_VERSION} → v${LATEST_SUPPORTED_VERSION}`,
        );
        expect(output).toContain("Row counts AFTER recovery");
        expect(output).toContain("Salvage rates");
        for (const table of ["tags", "compartments", "memories", "notes", "dream_runs"]) {
            expect(output).toContain(`${table}=`);
        }
        expect(output).toContain("Backup:");
    });

    salvageIt(
        "preserves SQLite sequence high-water marks and FTS schema during salvage",
        async () => {
            const storageDir = tempStorage();
            const dbPath = join(storageDir, "context.db");
            seedCurrentDatabase(dbPath);
            const source = new Database(dbPath);
            source.exec(`CREATE TABLE salvage_sequence(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT);
            INSERT INTO salvage_sequence VALUES(1000, 'deleted high water');
            DELETE FROM salvage_sequence;
            INSERT INTO salvage_sequence VALUES(2, 'kept');`);
            // Complete the source statistics before salvage. Missing trim-index
            // estimates are intentionally repaired on open, not preserved as stale data.
            source.exec("ANALYZE tags");
            const sourceStatistics = source
                .prepare("SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx")
                .all() as Array<{ tbl: string; idx: string | null; stat: string }>;
            expect(sourceStatistics.map((row) => row.idx)).toContain(
                "idx_tags_session_message_nocase",
            );
            expect(sourceStatistics.map((row) => row.idx)).toContain("idx_tags_session_tool_owner");
            source.close();
            corruptLastTagLeaf(dbPath);
            const prompts = new MockPrompts();
            expect(await runRepairDb({ dbPath, storageDir, prompts })).toBe(
                REPAIR_DB_EXIT.salvaged,
            );
            const recovered = new Database(dbPath);
            try {
                recovered.exec("INSERT INTO salvage_sequence(value) VALUES('next')");
                expect(
                    recovered.prepare("SELECT id FROM salvage_sequence WHERE value='next'").get(),
                ).toEqual({ id: 1001 });
                expect(
                    recovered
                        .prepare(
                            "SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'memory'",
                        )
                        .get(),
                ).toEqual({ n: 26 });
                expect(
                    recovered
                        .prepare("SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx")
                        .all(),
                ).toEqual(sourceStatistics);
            } finally {
                recovered.close();
            }
        },
    );

    salvageIt(
        "replays internal schema, statistics and sequence rows without losing user rows",
        async () => {
            const storageDir = tempStorage();
            const dbPath = join(storageDir, "context.db");
            seedCurrentDatabase(dbPath);
            const source = new Database(dbPath);
            source.exec("CREATE TABLE replay_rows(id INTEGER PRIMARY KEY, contents TEXT)");
            source.prepare("INSERT INTO replay_rows VALUES (?, ?)").run(1, "sqlite_sequence");
            source
                .prepare("INSERT INTO replay_rows VALUES (?, ?)")
                .run(2, "CREATE TABLE sqlite_stat1(tbl,idx,stat);\nINSERT INTO sqlite_master");
            // The sequence high-water mark must survive even when no row has that id.
            source.exec("UPDATE sqlite_sequence SET seq = 10000 WHERE name = 'dream_runs'");
            source.exec("ANALYZE");
            const userTables = [
                "tags",
                "compartments",
                "memories",
                "notes",
                "dream_runs",
                "replay_rows",
            ];
            const rowsBefore = userTables.map((table) =>
                source.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
            );
            const statsBefore = source
                .prepare("SELECT * FROM sqlite_stat1 WHERE tbl = 'replay_rows'")
                .all();
            const ftsSchemaBefore = source
                .prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'")
                .get();
            expect(ftsSchemaBefore).toMatchObject({
                sql: expect.stringContaining("CREATE VIRTUAL TABLE"),
            });
            expect(statsBefore).toEqual([{ tbl: "replay_rows", idx: null, stat: "2" }]);
            expect(
                source.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'dream_runs'").get(),
            ).toEqual({
                seq: 10000,
            });
            source.close();
            const originalDigest = digest(dbPath);
            const prompts = new MockPrompts();

            const code = await runRepairDb({ dbPath, storageDir, prompts });

            expect({
                code,
                errors: prompts.messages.filter((message) => message.startsWith("error:")),
            }).toEqual({
                code: REPAIR_DB_EXIT.salvaged,
                errors: [],
            });
            expect(prompts.messages.filter((message) => message.startsWith("confirm:"))).toEqual(
                [],
            );
            expect(integrity(dbPath)).toEqual(["ok"]);
            const recovered = new Database(dbPath);
            expect(
                userTables.map((table) =>
                    recovered.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
                ),
            ).toEqual(rowsBefore);
            expect(
                recovered.prepare("SELECT * FROM sqlite_stat1 WHERE tbl = 'replay_rows'").all(),
            ).toEqual(statsBefore);
            expect(
                recovered
                    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'dream_runs'")
                    .get(),
            ).toEqual({ seq: 10000 });
            expect(
                recovered
                    .prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'")
                    .get(),
            ).toEqual(ftsSchemaBefore);
            expect(recovered.prepare("SELECT count(*) AS count FROM memories_fts").get()).toEqual({
                count: 26,
            });
            recovered.close();
            const backup = readdirSync(storageDir).find((name) =>
                /^context\.db\.corrupt-backup-[^.]+$/.test(name),
            );
            expect(backup).toBeDefined();
            expect(digest(join(storageDir, backup!))).toBe(originalDigest);
        },
    );

    // Like the salvage test above, this test exercises a REAL `.recover` run
    // (here: one that must fail on the data), so it needs a capability-bearing
    // sqlite3 and is skipped the same way when the shell lacks it.
    salvageIt(unsalvageableTestName, async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        writeFileSync(dbPath, Buffer.alloc(8192, 0x7f));
        writeFileSync(`${dbPath}-wal`, "synthetic corrupt wal");
        writeFileSync(`${dbPath}-shm`, "synthetic corrupt shm");
        const sourceDigests = Object.fromEntries(
            [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((path) => [path, digest(path)]),
        );
        const prompts = new MockPrompts([false]);

        const code = await runRepairDb({
            dbPath,
            storageDir,
            prompts,
            deps: { now: () => new Date("2026-08-11T12:35:56.789Z") },
        });

        expect(code).toBe(REPAIR_DB_EXIT.unsalvageable);
        for (const [path, hash] of Object.entries(sourceDigests)) expect(digest(path)).toBe(hash);
        const backups = readdirSync(storageDir).filter((name) =>
            name.startsWith("context.db.corrupt-backup-"),
        );
        expect(backups).toHaveLength(3);
        expect(backups.some((path) => path.endsWith("-wal"))).toBe(true);
        expect(backups.some((path) => path.endsWith("-shm"))).toBe(true);
        const output = prompts.messages.join("\n");
        expect(output).toContain("SQLite salvage was unsuccessful");
        expect(output).toContain("Row counts BEFORE recovery");
        expect(output).toContain("Row counts AFTER recovery");
        expect(output).toContain("Reset declined");
        expect(output).toContain(`Database remains unchanged: ${dbPath}`);
    });

    it("does not offer destructive reset when the .recover shell could not start", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        writeFileSync(dbPath, Buffer.alloc(8192, 0x55));
        const originalDigest = digest(dbPath);
        const prompts = new MockPrompts([true]);

        const code = await runRepairDb({
            dbPath,
            storageDir,
            prompts,
            deps: {
                now: () => new Date("2026-08-11T12:36:56.789Z"),
                sqliteExecutable: join(storageDir, "missing-sqlite3"),
            },
        });

        expect(code).toBe(REPAIR_DB_EXIT.failed);
        expect(digest(dbPath)).toBe(originalDigest);
        const output = prompts.messages.join("\n");
        expect(output).toContain("SQLite .recover could not be started");
        expect(output).toContain("Reset was not offered because salvage did not run");
        expect(output).not.toContain("confirm:");
    });

    it("does not offer destructive reset when sqlite3 lacks the capability .recover needs", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        // A real, populated database: on a full sqlite3 build it would be
        // salvageable, which is precisely why the command must not declare it
        // unsalvageable just because THIS shell lacks a feature.
        seedCurrentDatabase(dbPath);
        const originalDigest = digest(dbPath);
        // Stand-in for a sqlite3 built without SQLITE_ENABLE_DBPAGE_VTAB: the
        // shell starts, but `.recover` dies the moment it reaches for
        // sqlite_dbpage — the exact stderr seen on the CI runner. Injected
        // through the same sqliteExecutable seam as the could-not-start test;
        // no real sqlite3 is invoked. The stub is a shared content-addressed
        // file outside storageDir (see writeTestExecutable), reused across runs.
        const stubSqlite = writeTestExecutable(
            "sqlite3-without-dbpage",
            "#!/bin/sh\necho 'sql error: no such table: sqlite_dbpage (1)' >&2\nexit 1\n",
        );
        // confirmations=[true]: if the command DID offer the destructive reset,
        // the mock would accept it and wipe the database — so a green test also
        // proves no reset was ever offered.
        const prompts = new MockPrompts([true]);

        const code = await runRepairDb({
            dbPath,
            storageDir,
            prompts,
            deps: {
                now: () => new Date("2026-08-12T09:00:00.000Z"),
                sqliteExecutable: stubSqlite,
            },
        });

        // Self-describing: on failure this prints the exit code alongside every
        // error message the command produced.
        expect({ code, why: prompts.messages.filter((m) => m.startsWith("error:")) }).toEqual({
            code: REPAIR_DB_EXIT.failed,
            why: [expect.stringContaining("no such table: sqlite_dbpage")],
        });
        expect(code).not.toBe(REPAIR_DB_EXIT.salvaged);
        expect(code).not.toBe(REPAIR_DB_EXIT.unsalvageable);
        const output = prompts.messages.join("\n");
        expect(output).not.toContain("confirm:");
        expect(output).toContain("Reset was not offered because salvage did not run");
        // The message names the missing capability and what to do about it.
        expect(output).toContain("SQLITE_ENABLE_DBPAGE_VTAB");
        expect(output).toContain("Database remains unchanged");
        expect(output).toContain("Backup base:");
        // The database bytes are untouched.
        expect(digest(dbPath)).toBe(originalDigest);
    });

    it("refuses a live RPC holder without changing any file", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        writeFileSync(dbPath, "do not touch");
        writeFileSync(`${dbPath}-wal`, "wal do not touch");
        writeFileSync(`${dbPath}-shm`, "shm do not touch");
        const rpcPath = rpcPortFilePath(storageDir, "/project", process.pid, "repair-test");
        mkdirSync(join(rpcPath, ".."), { recursive: true });
        writeFileSync(
            rpcPath,
            JSON.stringify({
                port: 43123,
                pid: process.pid,
                started_at: 0,
                instance_id: "repair-test",
            }),
        );
        const beforeFiles = readdirSync(storageDir, { recursive: true }).map(String).sort();
        const snapshots = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, rpcPath].map((path) => ({
            path,
            digest: digest(path),
            mtimeMs: statSync(path).mtimeMs,
        }));
        const prompts = new MockPrompts();
        expect(inspectRpcServerDiscovery(storageDir)).toMatchObject({
            state: "live",
            serverPids: [process.pid],
        });

        const code = await runRepairDb({ dbPath, storageDir, prompts });

        expect(code).toBe(REPAIR_DB_EXIT.refused);
        expect(readdirSync(storageDir, { recursive: true }).map(String).sort()).toEqual(
            beforeFiles,
        );
        for (const snapshot of snapshots) {
            expect(digest(snapshot.path)).toBe(snapshot.digest);
            expect(statSync(snapshot.path).mtimeMs).toBe(snapshot.mtimeMs);
        }
        const output = prompts.messages.join("\n");
        expect(output).toContain(`Refusing to repair the live database: ${dbPath}`);
        expect(output).toContain(`OpenCode server (PID ${process.pid})`);
        expect(output).toContain("Backup: not created");
    });
});

describe("doctor repair-db schema migration warning", () => {
    const behindCopy = {
        host: "opencode1" as const,
        directory: "/cache/opencode/packages/@cortexkit/opencode-magic-context@latest",
        version: "0.40.0",
        supportedVersion: LATEST_SUPPORTED_VERSION - 1,
    };
    const currentCopy = {
        host: "opencode2" as const,
        directory: "/cache/opencode/npm/@cortexkit/opencode-magic-context@latest",
        spec: "latest",
        version: "0.44.4",
        supportedVersion: LATEST_SUPPORTED_VERSION,
    };

    it("warns when the salvaged database is below this CLI's schema floor", () => {
        const lines = schemaMigrationWarning(LATEST_SUPPORTED_VERSION - 1, [
            behindCopy,
            currentCopy,
        ]);
        const text = lines.join("\n");
        expect(text).toContain(`v${LATEST_SUPPORTED_VERSION - 1} to v${LATEST_SUPPORTED_VERSION}`);
        // Names the cached copy that will refuse the database, with how to update it.
        expect(text).toContain("OpenCode 1 has Magic Context 0.40.0 cached");
        expect(text).toContain(behindCopy.directory);
        expect(text).toContain("doctor --force");
        // A copy that already supports the new schema is not flagged.
        expect(text).not.toContain("0.44.4");
    });

    it("still warns, without naming a plugin, when no cached plugin is found", () => {
        const text = schemaMigrationWarning(LATEST_SUPPORTED_VERSION - 3, []).join("\n");
        expect(text).toContain(`v${LATEST_SUPPORTED_VERSION - 3} to v${LATEST_SUPPORTED_VERSION}`);
        expect(text).toContain("older Magic Context plugin");
    });

    it("says nothing when the salvaged database is already current", () => {
        expect(schemaMigrationWarning(LATEST_SUPPORTED_VERSION, [behindCopy])).toEqual([]);
    });

    it("reports the salvaged version before migrating it", () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        seedCurrentDatabase(dbPath);
        const seen: number[] = [];

        const result = migrateAndCheckRecoveredDatabase(dbPath, (before) => seen.push(before));

        expect(result.ok).toBe(true);
        expect(seen).toEqual([LATEST_SUPPORTED_VERSION]);
    });
});
