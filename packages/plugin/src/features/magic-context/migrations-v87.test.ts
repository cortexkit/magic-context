/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    LATEST_MIGRATION_VERSION,
    runMigrations,
    V85_OPENCODE2_RELABEL_TABLES,
    V85_OPTIONAL_OPENCODE2_RELABEL_TABLES,
} from "./migrations";
import {
    OPENCODE2_RELABEL_STATE_KEY,
    type RelabelHarness,
    readUnresolvedOpenCode2Relabel,
    repairOpenCode2HarnessLabels,
    V87_HARNESS_AGGREGATE_RULES,
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
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-v87-"));
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

// Independent of the relabel rules so the behavioral checks cannot silently
// omit a runner table if the rule's membership is accidentally shortened.
const RUNNER_TABLES = [
    "host_runner_entries",
    "host_runner_ids",
    "host_runner_views",
    "host_runner_state",
] as const;
const REPAIR_TABLES = [...V85_OPENCODE2_RELABEL_TABLES, ...V85_OPTIONAL_OPENCODE2_RELABEL_TABLES];

function seedRunnerRows(
    db: Database,
    sessionId: string,
    harness: string,
    marker: string,
    timestamp: number,
): void {
    const lineage = `${marker}-lineage`;
    for (const lineageId of [lineage, `${marker}-old-lineage`]) {
        for (const ordinal of [1, 2]) {
            const messageId = `${lineageId}-m${ordinal}`;
            db.prepare(`INSERT INTO host_runner_entries
                (session_id, harness, lineage_id, ordinal, message_id, ingest_json, hook_json,
                 op_version, ingested, race, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?)`).run(
                sessionId,
                harness,
                lineageId,
                ordinal,
                messageId,
                `"${marker}"`,
                "[]",
                timestamp,
            );
            db.prepare(`INSERT INTO host_runner_ids
                (session_id, harness, lineage_id, message_id, ordinal) VALUES (?, ?, ?, ?, ?)`).run(
                sessionId,
                harness,
                lineageId,
                messageId,
                ordinal,
            );
        }
    }
    db.prepare(`INSERT INTO host_runner_ids
        (session_id, harness, lineage_id, message_id, ordinal) VALUES (?, ?, ?, ?, NULL)`).run(
        sessionId,
        harness,
        lineage,
        `${marker}-elided`,
    );
    for (const version of [1, 2]) {
        db.prepare(`INSERT INTO host_runner_views
            (session_id, harness, lineage_id, compaction_id, version, range_from, range_to,
             replacement_json, coverage_json, state, applied_at)
            VALUES (?, ?, ?, ?, ?, 1, 2, ?, '[]', 'applied', ?)`).run(
            sessionId,
            harness,
            lineage,
            `${marker}-c${version}`,
            version,
            `"${marker}"`,
            timestamp,
        );
    }
    db.prepare(`INSERT INTO host_runner_state
        (session_id, harness, lineage_id, ancestry_json, plan_json, setup_json,
         next_ordinal, cursor, served_through_ordinal, issued_request_id, issued_newest,
         wait_json, bootstrap_cursor, unserved_json, record_version)
        VALUES (?, ?, ?, '[]', ?, ?, 3, 2, 2, ?, 2, ?, 1, '[2]', 7)`).run(
        sessionId,
        harness,
        lineage,
        `"${marker}-plan"`,
        `"${marker}-setup"`,
        `${marker}-fence`,
        `"${marker}-wait"`,
    );
}

function runnerRows(db: Database, sessionId: string, harness: string) {
    return Object.fromEntries(
        RUNNER_TABLES.map((table) => [
            table,
            db
                .prepare(
                    `SELECT * FROM ${table} WHERE session_id = ? AND harness = ? ORDER BY rowid`,
                )
                .all(sessionId, harness) as Array<Record<string, unknown>>,
        ]),
    );
}

function runnerEvidence(sessionId: string, target: RelabelHarness): void {
    const host = createHostStore(target === "opencode" ? "fresh_v1" : "fresh_v2");
    try {
        if (target === "opencode") insertV1Session(host.db, sessionId, 9_000);
        else insertV2Session(host.db, sessionId, 9_000);
    } finally {
        host.db.close();
    }
    useHostStore(host.path);
}

describe("migration v87: harness labels follow host-store evidence", () => {
    test("fresh databases keep the v86 schema and align the schema fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

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

    test.each([
        "opencode",
        "opencode2",
    ] as const)("a non-twin runner record moves all four tables together to %s", (target) => {
        const source = target === "opencode" ? "opencode2" : "opencode";
        const sessionId = "ses-runner-only";
        const db = new Database(":memory:");
        try {
            runnerEvidence(sessionId, target);
            initializeDatabase(db);
            seedAppliedVersion(db, 86);
            seedRunnerRows(db, sessionId, source, "incoming", 100);
            const before = runnerRows(db, sessionId, source);

            // Exercise the nested transaction used during migration replay,
            // with the runner tables as the only session candidates.
            runMigrations(db);

            for (const table of RUNNER_TABLES) {
                expect(runnerRows(db, sessionId, target)[table]).toEqual(
                    before[table]?.map((row) => ({ ...row, harness: target })),
                );
                expect(harnessOf(db, table, sessionId)).toEqual(before[table]?.map(() => target));
            }
            const replay = repairOpenCode2HarnessLabels(db, { tables: REPAIR_TABLES });
            expect(replay.relabelledSessions).toEqual([]);
            expect(replay.discardedRunnerRecords).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test.each([
        "opencode",
        "opencode2",
    ] as const)("a runner twin keeps the resolved %s record intact and discards all incoming rows", (target) => {
        const source = target === "opencode" ? "opencode2" : "opencode";
        const sessionId = "ses-runner-twin";
        const db = new Database(":memory:");
        try {
            runnerEvidence(sessionId, target);
            initializeDatabase(db);
            seedSessionRows(db, sessionId, source);
            // The resolved record is older, and the two records have different
            // lineages/message ids: neither timestamps nor per-row collisions
            // may choose survivors from the incoming record.
            seedRunnerRows(db, sessionId, target, "kept", 100);
            seedRunnerRows(db, sessionId, source, "discarded", 9_000);
            seedRunnerRows(db, sessionId, "pi", "pi", 10_000);
            seedRunnerRows(db, "ses-unrelated", source, "unrelated", 10_000);
            const kept = runnerRows(db, sessionId, target);
            const pi = runnerRows(db, sessionId, "pi");
            const unrelated = runnerRows(db, "ses-unrelated", source);

            const report = repairOpenCode2HarnessLabels(db, { tables: REPAIR_TABLES });

            expect(report.status).toBe("resolved");
            expect(report.discardedRunnerRecords).toEqual([sessionId]);
            expect(report.relabelledSessions).toEqual([{ sessionId, harness: target }]);
            expect(runnerRows(db, sessionId, target)).toEqual(kept);
            for (const table of RUNNER_TABLES) {
                expect(runnerRows(db, sessionId, source)[table]).toEqual([]);
            }
            expect(runnerRows(db, sessionId, "pi")).toEqual(pi);
            expect(runnerRows(db, "ses-unrelated", source)).toEqual(unrelated);
            expect(harnessOf(db, "tags", sessionId)).toEqual([target]);
            const replay = repairOpenCode2HarnessLabels(db, { tables: REPAIR_TABLES });
            expect(replay.discardedRunnerRecords).toEqual([]);
            expect(replay.relabelledSessions).toEqual([]);
            expect(runnerRows(db, sessionId, target)).toEqual(kept);
        } finally {
            closeQuietly(db);
        }
    });

    test.each([
        "opencode",
        "opencode2",
    ] as const)("split runner entries and state never form a hybrid under %s", (target) => {
        const source = target === "opencode" ? "opencode2" : "opencode";
        const sessionIds = ["ses-entries-target", "ses-state-target"];
        const host = createHostStore(target === "opencode" ? "fresh_v1" : "fresh_v2");
        for (const sessionId of sessionIds) {
            if (target === "opencode") insertV1Session(host.db, sessionId, 9_000);
            else insertV2Session(host.db, sessionId, 9_000);
        }
        host.db.close();
        useHostStore(host.path);
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            const kept = sessionIds.map((sessionId) => {
                seedRunnerRows(db, sessionId, source, "source", 9_000);
                seedRunnerRows(db, sessionId, target, "target", 100);
                for (const table of RUNNER_TABLES) {
                    const stateOnTarget = sessionId === "ses-state-target";
                    const keepOnTarget = (table === "host_runner_state") === stateOnTarget;
                    db.prepare(`DELETE FROM ${table} WHERE session_id = ? AND harness = ?`).run(
                        sessionId,
                        keepOnTarget ? source : target,
                    );
                }
                return runnerRows(db, sessionId, target);
            });

            const report = repairOpenCode2HarnessLabels(db, { tables: REPAIR_TABLES });

            expect(report.discardedRunnerRecords).toEqual(sessionIds);
            expect(report.relabelledSessions).toEqual([]);
            for (const [index, sessionId] of sessionIds.entries()) {
                expect(runnerRows(db, sessionId, target)).toEqual(kept[index]);
                for (const table of RUNNER_TABLES) {
                    expect(runnerRows(db, sessionId, source)[table]).toEqual([]);
                }
            }
        } finally {
            closeQuietly(db);
        }
    });

    test.each([
        "non-twin",
        "twin",
    ])("runner relabel and the rest of the session roll back together on failure (%s)", (kind) => {
        const twin = kind === "twin";
        const sessionId = "ses-runner-rollback";
        const db = new Database(":memory:");
        try {
            runnerEvidence(sessionId, "opencode2");
            initializeDatabase(db);
            seedSessionRows(db, sessionId, "opencode");
            seedRunnerRows(db, sessionId, "opencode", "source", 9_000);
            if (twin) seedRunnerRows(db, sessionId, "opencode2", "target", 100);
            db.prepare(`INSERT INTO session_projects (session_id, harness, project_path, updated_at)
                VALUES (?, 'opencode', '/newer', 9000), (?, 'opencode2', '/older', 100)`).run(
                sessionId,
                sessionId,
            );
            const source = runnerRows(db, sessionId, "opencode");
            const target = runnerRows(db, sessionId, "opencode2");
            // Fail after entries/ids/views have moved or been discarded.
            db.exec(`CREATE TRIGGER fail_runner_relabel BEFORE ${twin ? "DELETE" : "UPDATE"}
                    ON host_runner_state BEGIN SELECT RAISE(ABORT, 'runner relabel failed'); END`);

            expect(() => repairOpenCode2HarnessLabels(db, { tables: REPAIR_TABLES })).toThrow(
                "runner relabel failed",
            );

            expect(runnerRows(db, sessionId, "opencode")).toEqual(source);
            expect(runnerRows(db, sessionId, "opencode2")).toEqual(target);
            expect(harnessOf(db, "session_meta", sessionId)).toEqual(["opencode"]);
            expect(harnessOf(db, "tags", sessionId)).toEqual(["opencode"]);
            expect(harnessOf(db, "session_projects", sessionId)).toEqual(["opencode", "opencode2"]);
        } finally {
            closeQuietly(db);
        }
    });

    test("every harness-keyed table is covered by a twin rule, an aggregate group or is a per-harness cursor", () => {
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

            const ruled = new Set([
                ...V87_HARNESS_TWIN_RULES.map((rule) => rule.table),
                ...V87_HARNESS_AGGREGATE_RULES.flatMap((rule) => rule.tables),
            ]);
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
                    expect(ruled.has(table), `${table} needs no twin or aggregate rule`).toBe(
                        false,
                    );
                    continue;
                }
                const isPerHarnessCursor = !(
                    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
                ).some((column) => column.name === "session_id");
                expect(
                    ruled.has(table) || isPerHarnessCursor,
                    `${table} keys rows by harness but has no v87 twin or aggregate rule`,
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
