/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    LATEST_MIGRATION_VERSION,
    runMigrations,
    V85_OPENCODE2_RELABEL_TABLES,
    V85_OPTIONAL_OPENCODE2_RELABEL_TABLES,
} from "./migrations";
import {
    OPENCODE2_RELABEL_STATE_KEY,
    readUnresolvedOpenCode2Relabel,
    V87_HARNESS_TWIN_RULES,
} from "./opencode2-relabel";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { getTagNumberByMessageId } from "./storage-tags";

/**
 * Host-store shapes captured from the real binaries by
 * `scripts/capture-opencode-store-shapes.ts`. Every store this file builds uses
 * that captured CREATE TABLE text, so a hand-written host schema can never
 * drift away from what OpenCode actually writes.
 */
interface CapturedShape {
    description: string;
    tables: string[];
    ddl: Record<string, string>;
    rows: Record<string, Array<Record<string, unknown>>>;
}
interface CapturedFixture {
    capturedAt: string;
    binaries: Record<string, { path: string; version: string }>;
    shapes: Record<string, CapturedShape>;
}
const FIXTURE = JSON.parse(
    readFileSync(join(import.meta.dir, "__fixtures__/opencode-store-shapes.json"), "utf8"),
) as CapturedFixture;

type ShapeName = "fresh_v1" | "fresh_v2" | "migrated_v1_v2";

const tempDirs: string[] = [];
const originalOpenCodeDb = process.env.OPENCODE_DB;

afterEach(() => {
    if (originalOpenCodeDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = originalOpenCodeDb;
    resetOpenCodeDbPathStateForTesting();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-v87-"));
    tempDirs.push(dir);
    return dir;
}

/** Build a host store file with the captured DDL of one real shape. */
function createHostStore(shape: ShapeName, name = "opencode.db"): { path: string; db: Database } {
    const captured = FIXTURE.shapes[shape];
    if (!captured) throw new Error(`fixture has no ${shape} shape`);
    const path = join(tempDir(), name);
    const db = new Database(path);
    for (const table of captured.tables) {
        const ddl = captured.ddl[table];
        if (ddl) db.exec(ddl);
    }
    return { path, db };
}

function insertV1Session(db: Database, sessionId: string, timeUpdated: number): void {
    db.prepare(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
         VALUES (?, 'global', 'fixture-slug', '/fixture', 'fixture session', '1.18.30', ?, ?)`,
    ).run(sessionId, timeUpdated, timeUpdated);
}

function insertV1Message(
    db: Database,
    sessionId: string,
    messageId: string,
    timeUpdated: number,
): void {
    db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, '{}')",
    ).run(messageId, sessionId, timeUpdated, timeUpdated);
}

function insertV2Session(db: Database, sessionId: string, timeUpdated: number): void {
    db.prepare(
        `INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated)
         VALUES (?, 'global', 'fixture-slug', '/fixture', '2.0.7', ?, ?)`,
    ).run(sessionId, timeUpdated, timeUpdated);
}

function insertV2Message(
    db: Database,
    sessionId: string,
    messageId: string,
    seq: number,
    timeUpdated: number,
): void {
    db.prepare(
        `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
         VALUES (?, ?, 'user', ?, ?, ?, '{}')`,
    ).run(messageId, sessionId, seq, timeUpdated, timeUpdated);
}

function useHostStore(path: string): void {
    process.env.OPENCODE_DB = path;
    resetOpenCodeDbPathStateForTesting();
}

function seedAppliedVersion(db: Database, version: number): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
    `);
    const insert = db.prepare(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
    );
    for (let current = 1; current <= version; current += 1) {
        insert.run(current, `seed v${current}`, Date.now());
    }
}

function harnessOf(db: Database, table: string, sessionId: string): string[] {
    return (
        db
            .prepare(`SELECT harness FROM ${table} WHERE session_id = ? ORDER BY harness`)
            .all(sessionId) as Array<{ harness: string }>
    ).map((row) => row.harness);
}

function countByHarness(db: Database, table: string): Record<string, number> {
    const rows = db
        .prepare(`SELECT harness, COUNT(*) AS count FROM ${table} GROUP BY harness`)
        .all() as Array<{ harness: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.harness, row.count]));
}

function seedSessionRows(db: Database, sessionId: string, harness: string): void {
    db.prepare(
        "INSERT INTO session_meta (session_id, harness, counter, is_subagent) VALUES (?, ?, 7, 0)",
    ).run(sessionId, harness);
    db.prepare(
        "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness) VALUES (?, ?, 'message', 10, 1, ?)",
    ).run(sessionId, `${sessionId}-msg`, harness);
}

describe("migration v87: harness labels follow host-store evidence", () => {
    test("fresh databases keep the v86 schema and align the schema fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(LATEST_SUPPORTED_VERSION).toBe(92);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 87")
                    .get(),
            ).toEqual({ count: 1 });
            // v87 adds no table and no column: it only moves existing labels.
            const columns = (
                db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name: string }>
            ).map((column) => column.name);
            expect(columns).toContain("tags_version");
            expect(columns).toContain("harness");
            // An empty store has no session to decide about, so nothing is recorded.
            expect(readUnresolvedOpenCode2Relabel(db)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("the captured store shapes still carry the tables the evidence rule reads", () => {
        expect(FIXTURE.binaries.v1?.version.startsWith("1.")).toBe(true);
        expect(FIXTURE.binaries.v2?.version.startsWith("2.")).toBe(true);

        const v1 = FIXTURE.shapes.fresh_v1;
        const v2 = FIXTURE.shapes.fresh_v2;
        const migrated = FIXTURE.shapes.migrated_v1_v2;
        if (!v1 || !v2 || !migrated) throw new Error("fixture is missing a captured shape");

        // A 1.18.x store ships session_message but never session_v2 — which is
        // why session_v2 is what gates reading 2.x evidence at all.
        expect(v1.tables).toContain("session_message");
        expect(v1.tables).not.toContain("session_v2");
        expect(v1.tables).toContain("message");
        // A native 2.x store has no v1 message tables.
        expect(v2.tables).toContain("session_v2");
        expect(v2.tables).not.toContain("message");
        // A migrated store carries BOTH generations.
        expect(migrated.tables).toContain("message");
        expect(migrated.tables).toContain("session_v2");

        // The migration copies the session row verbatim, timestamps included. That
        // is what makes "migrated but never used on 2.x" a tie rather than 2.x
        // activity, so the stored label survives an upgrade that touched nothing.
        const v1Session = migrated.rows.session?.[0];
        const v2Session = migrated.rows.session_v2?.[0];
        expect(v1Session).toBeDefined();
        expect(v2Session).toEqual(v1Session as Record<string, unknown>);
    });

    test("a native OpenCode 2 store restores sessions v85 relabelled to opencode", () => {
        const host = createHostStore("fresh_v2");
        const db = new Database(":memory:");
        try {
            insertV2Session(host.db, "ses-oc2", 5_000);
            insertV2Message(host.db, "ses-oc2", "msg-1", 1, 6_000);
            host.db.close();
            useHostStore(host.path);

            initializeDatabase(db);
            seedAppliedVersion(db, 86);
            seedSessionRows(db, "ses-oc2", "opencode");

            runMigrations(db);

            expect(harnessOf(db, "session_meta", "ses-oc2")).toEqual(["opencode2"]);
            expect(harnessOf(db, "tags", "ses-oc2")).toEqual(["opencode2"]);
            expect(readUnresolvedOpenCode2Relabel(db)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("a 1.18.x store relabels opencode2 rows to opencode, session_message rows and all", () => {
        const host = createHostStore("fresh_v1");
        const db = new Database(":memory:");
        try {
            insertV1Session(host.db, "ses-v1", 4_000);
            insertV1Message(host.db, "ses-v1", "msg-1", 4_500);
            // A 1.18.x store ships the session_message table. Rows there must not
            // count as 2.x activity, however new they look, because no OpenCode 2
            // host has touched this store: session_v2 is absent.
            insertV2Message(host.db, "ses-v1", "sm-1", 1, 9_999);
            host.db.close();
            useHostStore(host.path);

            initializeDatabase(db);
            seedAppliedVersion(db, 86);
            seedSessionRows(db, "ses-v1", "opencode2");

            runMigrations(db);

            expect(harnessOf(db, "session_meta", "ses-v1")).toEqual(["opencode"]);
            expect(harnessOf(db, "tags", "ses-v1")).toEqual(["opencode"]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a migrated store labels by the generation that wrote last, including the downgraded arm", () => {
        const host = createHostStore("migrated_v1_v2");
        const db = new Database(":memory:");
        try {
            // Still on 2.x: the 2 host kept writing after the migration.
            insertV1Session(host.db, "ses-on-2x", 1_000);
            insertV1Message(host.db, "ses-on-2x", "m-old", 1_000);
            insertV2Session(host.db, "ses-on-2x", 1_000);
            insertV2Message(host.db, "ses-on-2x", "sm-new", 1, 9_000);

            // Downgraded: migrated to 2.x, then the 1.x host wrote again.
            insertV1Session(host.db, "ses-downgraded", 2_000);
            insertV2Session(host.db, "ses-downgraded", 2_000);
            insertV2Message(host.db, "ses-downgraded", "sm-mid", 1, 3_000);
            insertV1Message(host.db, "ses-downgraded", "m-latest", 7_000);

            // Migrated and never touched again: session_v2 is a verbatim copy, so
            // both sides report the same instant and neither can claim the session.
            // Seeded under both labels so a rule that broke the tie in either
            // direction would move one of them.
            insertV1Session(host.db, "ses-untouched", 5_000);
            insertV2Session(host.db, "ses-untouched", 5_000);
            insertV1Session(host.db, "ses-untouched-oc", 5_000);
            insertV2Session(host.db, "ses-untouched-oc", 5_000);

            // Deleted from the host store: present in neither generation's tables.
            host.db.close();
            useHostStore(host.path);

            initializeDatabase(db);
            seedAppliedVersion(db, 86);
            seedSessionRows(db, "ses-on-2x", "opencode");
            seedSessionRows(db, "ses-downgraded", "opencode2");
            seedSessionRows(db, "ses-untouched", "opencode2");
            seedSessionRows(db, "ses-untouched-oc", "opencode");
            seedSessionRows(db, "ses-unknown", "opencode2");

            runMigrations(db);

            expect(harnessOf(db, "session_meta", "ses-on-2x")).toEqual(["opencode2"]);
            expect(harnessOf(db, "tags", "ses-on-2x")).toEqual(["opencode2"]);
            expect(harnessOf(db, "session_meta", "ses-downgraded")).toEqual(["opencode"]);
            expect(harnessOf(db, "tags", "ses-downgraded")).toEqual(["opencode"]);
            expect(harnessOf(db, "session_meta", "ses-untouched")).toEqual(["opencode2"]);
            expect(harnessOf(db, "session_meta", "ses-untouched-oc")).toEqual(["opencode"]);
            expect(harnessOf(db, "session_meta", "ses-unknown")).toEqual(["opencode2"]);
        } finally {
            closeQuietly(db);
        }
    });

    test("no readable OpenCode store changes nothing and reports the sessions to doctor", () => {
        const missing = join(tempDir(), "opencode.db");
        const db = new Database(":memory:");
        try {
            useHostStore(missing);

            initializeDatabase(db);
            seedAppliedVersion(db, 86);
            seedSessionRows(db, "ses-a", "opencode2");
            seedSessionRows(db, "ses-b", "opencode");

            runMigrations(db);

            expect(harnessOf(db, "session_meta", "ses-a")).toEqual(["opencode2"]);
            expect(harnessOf(db, "session_meta", "ses-b")).toEqual(["opencode"]);
            const state = readUnresolvedOpenCode2Relabel(db);
            expect(state?.reason).toBe("store_not_found");
            expect(state?.sessionIds).toEqual(["ses-a", "ses-b"]);
            expect(state?.lookedFor).toContain(missing);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 87")
                    .get(),
            ).toEqual({ count: 1 });
            expect(
                db
                    .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
                    .get(OPENCODE2_RELABEL_STATE_KEY),
            ).not.toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("an empty store schema is treated as no evidence, not as a missing session", () => {
        const emptyStore = join(tempDir(), "opencode.db");
        const created = new Database(emptyStore);
        created.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)");
        created.close();
        const db = new Database(":memory:");
        try {
            useHostStore(emptyStore);

            initializeDatabase(db);
            seedAppliedVersion(db, 86);
            seedSessionRows(db, "ses-a", "opencode2");

            runMigrations(db);

            expect(harnessOf(db, "session_meta", "ses-a")).toEqual(["opencode2"]);
            expect(readUnresolvedOpenCode2Relabel(db)?.reason).toBe("store_schema_unknown");
        } finally {
            closeQuietly(db);
        }
    });

    test("twin rows resolve by the same newer-row rule in the opencode2 direction", () => {
        const host = createHostStore("fresh_v2");
        const db = new Database(":memory:");
        try {
            insertV2Session(host.db, "ses-twin-new", 9_000);
            insertV2Session(host.db, "ses-twin-old", 9_000);
            host.db.close();
            useHostStore(host.path);

            initializeDatabase(db);
            seedAppliedVersion(db, 86);
            db.exec(`
                INSERT INTO session_meta (session_id, harness, counter) VALUES
                    ('ses-twin-new', 'opencode', 1),
                    ('ses-twin-old', 'opencode', 1);
                INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES
                    ('ses-twin-new', 'opencode', '/newer', 200),
                    ('ses-twin-new', 'opencode2', '/older', 100),
                    ('ses-twin-old', 'opencode', '/older', 100),
                    ('ses-twin-old', 'opencode2', '/newer', 200);
                INSERT INTO transform_decisions (session_id, harness, message_id, decision, ts_ms) VALUES
                    ('ses-twin-new', 'opencode', 'm1', 'keep', 500),
                    ('ses-twin-new', 'opencode2', 'm1', 'drop', 400);
            `);

            runMigrations(db);

            // The row being relabelled loses to a newer row already carrying the
            // resolved label, and wins when it is the newer one.
            expect(
                db
                    .prepare(
                        "SELECT harness, project_path FROM session_projects WHERE session_id = 'ses-twin-new'",
                    )
                    .all(),
            ).toEqual([{ harness: "opencode2", project_path: "/newer" }]);
            expect(
                db
                    .prepare(
                        "SELECT harness, project_path FROM session_projects WHERE session_id = 'ses-twin-old'",
                    )
                    .all(),
            ).toEqual([{ harness: "opencode2", project_path: "/newer" }]);
            expect(
                db
                    .prepare(
                        "SELECT harness, decision FROM transform_decisions WHERE session_id = 'ses-twin-new'",
                    )
                    .all(),
            ).toEqual([{ harness: "opencode2", decision: "keep" }]);
        } finally {
            closeQuietly(db);
        }
    });

    test("every harness-keyed table is covered by a twin rule or is a per-harness cursor", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            db.exec(`
                CREATE TABLE IF NOT EXISTS session_project_backfill_state (
                    harness TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    started_at INTEGER
                );
            `);

            const ruled = new Set(V87_HARNESS_TWIN_RULES.map((rule) => rule.table));
            for (const table of [
                ...V85_OPENCODE2_RELABEL_TABLES,
                ...V85_OPTIONAL_OPENCODE2_RELABEL_TABLES,
            ]) {
                const columns = (
                    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                        name: string;
                        pk: number;
                    }>
                ).filter((column) => column.name === "harness");
                if (columns.length === 0) continue;
                const harnessInPrimaryKey = columns[0]?.pk !== 0;
                const uniqueIndexes = (
                    db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
                        name: string;
                        unique: number;
                    }>
                ).filter((index) => index.unique === 1);
                const harnessInUniqueIndex = uniqueIndexes.some((index) =>
                    (
                        db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{
                            name: string | null;
                        }>
                    ).some((column) => column.name === "harness"),
                );
                if (!harnessInPrimaryKey && !harnessInUniqueIndex) {
                    expect(ruled.has(table), `${table} needs no twin rule`).toBe(false);
                    continue;
                }
                const isPerHarnessCursor = !(
                    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
                ).some((column) => column.name === "session_id");
                expect(
                    ruled.has(table) || isPerHarnessCursor,
                    `${table} keys rows by harness but has no v87 twin rule`,
                ).toBe(true);
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("issue #475: qoole's relabelled store comes back intact and a second run is a no-op", () => {
        const host = createHostStore("migrated_v1_v2");
        const db = new Database(":memory:");
        const sessionIds = Array.from({ length: 32 }, (_, index) => `ses-qoole-${index}`);
        try {
            for (const [index, sessionId] of sessionIds.entries()) {
                // Migrated from 1.18.x, then written by the OpenCode 2.0.7 host.
                insertV1Session(host.db, sessionId, 1_000 + index);
                insertV1Message(host.db, sessionId, `${sessionId}-v1`, 1_000 + index);
                insertV2Session(host.db, sessionId, 1_000 + index);
                insertV2Message(host.db, sessionId, `${sessionId}-v2`, 1, 9_000 + index);
            }
            host.db.close();
            useHostStore(host.path);

            initializeDatabase(db);
            seedAppliedVersion(db, 86);

            // The state issue #475 measured after v85 ran: 2,788 tags and 32
            // session_meta rows rewritten to `opencode`, plus the one `opencode2`
            // tag the OpenCode 2 host wrote afterwards.
            const insertMeta = db.prepare(
                "INSERT INTO session_meta (session_id, harness, counter) VALUES (?, 'opencode', ?)",
            );
            const insertTag = db.prepare(
                "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness) VALUES (?, ?, 'message', ?, ?, ?)",
            );
            db.transaction(() => {
                for (const [index, sessionId] of sessionIds.entries()) {
                    insertMeta.run(sessionId, index);
                }
                for (let tag = 0; tag < 2788; tag += 1) {
                    const sessionId = sessionIds[tag % sessionIds.length] as string;
                    insertTag.run(
                        sessionId,
                        `msg-${tag}`,
                        100 + tag,
                        Math.floor(tag / sessionIds.length) + 1,
                        "opencode",
                    );
                }
                // The new row the OpenCode 2 host wrote for a message that already
                // had a relabelled tag: a duplicate composite key, not a key
                // collision, because tags are UNIQUE(session_id, tag_number).
                insertTag.run(sessionIds[0] as string, "msg-0", 999, 500, "opencode2");
            }).immediate();

            const before = db
                .prepare(
                    "SELECT session_id, message_id, tag_number, byte_size FROM tags ORDER BY session_id, tag_number",
                )
                .all();
            const contentHash = createHash("sha256").update(JSON.stringify(before)).digest("hex");
            expect(countByHarness(db, "tags")).toEqual({ opencode: 2788, opencode2: 1 });
            expect(countByHarness(db, "session_meta")).toEqual({ opencode: 32 });

            runMigrations(db);

            expect(countByHarness(db, "tags")).toEqual({ opencode2: 2789 });
            expect(countByHarness(db, "session_meta")).toEqual({ opencode2: 32 });
            const after = db
                .prepare(
                    "SELECT session_id, message_id, tag_number, byte_size FROM tags ORDER BY session_id, tag_number",
                )
                .all();
            expect(after).toHaveLength(2789);
            expect(createHash("sha256").update(JSON.stringify(after)).digest("hex")).toBe(
                contentHash,
            );
            // Both rows for the duplicated message survive; the tagger resolves the
            // duplicate composite key to the lowest tag_number, which is the
            // pre-existing tag rather than the newer one.
            expect(
                db
                    .prepare(
                        "SELECT tag_number FROM tags WHERE session_id = ? AND message_id = 'msg-0' ORDER BY tag_number",
                    )
                    .all(sessionIds[0] as string),
            ).toEqual([{ tag_number: 1 }, { tag_number: 500 }]);
            expect(getTagNumberByMessageId(db, sessionIds[0] as string, "msg-0")).toBe(1);

            // Idempotent: replaying the repair against the same evidence moves nothing.
            db.prepare("DELETE FROM schema_migrations WHERE version = 87").run();
            runMigrations(db);
            expect(countByHarness(db, "tags")).toEqual({ opencode2: 2789 });
            expect(countByHarness(db, "session_meta")).toEqual({ opencode2: 32 });
            expect(
                createHash("sha256")
                    .update(
                        JSON.stringify(
                            db
                                .prepare(
                                    "SELECT session_id, message_id, tag_number, byte_size FROM tags ORDER BY session_id, tag_number",
                                )
                                .all(),
                        ),
                    )
                    .digest("hex"),
            ).toBe(contentHash);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("migration v85 is inert", () => {
    test("v85 leaves opencode2 rows alone so v87 can decide them from the host store", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            seedAppliedVersion(db, 84);
            seedSessionRows(db, "ses-oc2", "opencode2");
            // No host store: v87 has no evidence, so nothing may move in either
            // direction — which is only observable because v85 no longer rewrites.
            useHostStore(join(tempDir(), "absent.db"));

            runMigrations(db);

            expect(harnessOf(db, "session_meta", "ses-oc2")).toEqual(["opencode2"]);
            expect(harnessOf(db, "tags", "ses-oc2")).toEqual(["opencode2"]);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 85")
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });
});
