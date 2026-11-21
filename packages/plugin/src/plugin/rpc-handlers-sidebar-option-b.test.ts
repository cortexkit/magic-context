import { afterEach, expect, spyOn, test } from "bun:test";
import { appendCompartments } from "../features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { runMigrations } from "../features/magic-context/migrations";
import { initializeDatabase } from "../features/magic-context/storage-db";
import { queuePendingDropForUnchangedTag } from "../features/magic-context/storage-ops";
import { getTagsBySession } from "../features/magic-context/storage-tags";
import { Database } from "../shared/sqlite";
import { buildSidebarSnapshot } from "./rpc-handlers";

const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});

function fixture() {
    const db = new Database(":memory:");
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    const directory = process.cwd();
    const project = resolveProjectIdentity(directory);
    const session = "sidebar-option-b";
    db.prepare("INSERT INTO session_meta(session_id) VALUES (?)").run(session);
    return { db, directory, project, session };
}

test("N3 exposes the proactive floor beside the resolved execute threshold", () => {
    const { db, directory, session } = fixture();
    const snapshot = buildSidebarSnapshot(db, session, directory, undefined, undefined, {
        execute_threshold_percentage: 65,
    });
    expect(snapshot.executeThreshold).toBe(65);
    expect(snapshot.proactiveFloor).toBe(63);
});

test("N4 sums only this session's queued drop tokens with indexed lookups", () => {
    const { db, directory, session } = fixture();
    const insert = db.prepare(
        "INSERT INTO tags(session_id, message_id, tag_number, type, byte_size, token_count) VALUES (?, ?, ?, 'message', 10, ?)",
    );
    insert.run("other", "decoy", 101, 999);
    insert.run(session, "m1", 101, 123);
    insert.run(session, "m2", 102, 456);
    const first = getTagsBySession(db, session).find((tag) => tag.tagNumber === 101)!;
    expect(first.id).not.toBe(first.tagNumber);
    expect(queuePendingDropForUnchangedTag(db, session, first)).toBe(true);
    db.prepare("INSERT INTO pending_ops(session_id, tag_id, operation) VALUES (?, ?, 'keep')").run(
        session,
        102,
    );
    db.prepare(
        "INSERT INTO pending_ops(session_id, tag_id, operation) VALUES ('other', ?, 'drop')",
    ).run(101);
    const prepared = spyOn(db, "prepare");
    const snapshot = buildSidebarSnapshot(db, session, directory);
    expect(snapshot.queuedDropTokens).toBe(123);
    expect(snapshot.queuedDropCount).toBe(1);
    expect(snapshot.pendingOpsCount).toBe(2);
    const sql = prepared.mock.calls
        .map(([sql]) => sql)
        .find((sql) => /SUM\(.*token_count/.test(sql));
    expect(sql).toBeDefined();
    prepared.mockRestore();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(session) as { detail: string }[];
    expect(plan.every((row) => !/SCAN (?:p|t|pending_ops|tags)\b/.test(row.detail))).toBe(true);
    expect(plan.some((row) => /idx_pending_ops_session_tag_id/.test(row.detail))).toBe(true);
});

test("N5 counts post-cache compartments and visible unexpired active or permanent memories using indexes", () => {
    const { db, directory, project, session } = fixture();
    appendCompartments(
        db,
        session,
        [0, 1, 2].map((sequence) => ({
            sequence,
            startMessage: sequence + 1,
            endMessage: sequence + 1,
            title: "History",
            content: "History",
        })),
    );
    db.prepare(`UPDATE session_meta SET cached_m0_materialized_at = 1234,
        cached_m0_max_compartment_seq = 0, cached_m0_max_memory_id = 1 WHERE session_id = ?`).run(
        session,
    );
    const insert =
        db.prepare(`INSERT INTO memories(project_path, category, content, normalized_hash,
        status, expires_at, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?, 'CONSTRAINTS', 'memory', ?, ?, ?, 1, 1, 1, 1)`);
    insert.run(project, "old", "active", null);
    insert.run(project, "new", "active", null);
    insert.run(project, "permanent", "permanent", null);
    insert.run(project, "expired", "active", 1);
    insert.run(project, "archived", "archived", null);
    insert.run("other", "foreign", "active", null);
    const prepared = spyOn(db, "prepare");
    const snapshot = buildSidebarSnapshot(db, session, directory);
    expect(snapshot.cachedM0MaterializedAt).toBe(1234);
    expect(snapshot.summariesSinceCache).toBe(2);
    expect(snapshot.memoriesSinceCache).toBe(2);
    const queries = prepared.mock.calls.map(([sql]) => sql);
    prepared.mockRestore();
    for (const [, pattern, params] of [
        ["N5 summaries", /COUNT\(\*\).*compartments.*sequence\s*>/s, [session, 0]],
        ["N5 memories", /SELECT.*FROM memories.*id\s*>/s, [project, 1, Date.now()]],
    ] as const) {
        const sql = queries.find((sql) => pattern.test(sql));
        expect(sql).toBeDefined();
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
        expect(plan.some((row) => /SEARCH .*USING (?:COVERING )?INDEX/.test(row.detail))).toBe(
            true,
        );
        expect(plan.every((row) => !/SCAN (?:compartments|memories)\b/.test(row.detail))).toBe(
            true,
        );
    }
});

test("N5 uses workspace sharing and classification from the render policy", () => {
    const { db, directory, project, session } = fixture();
    const workspace = Number(
        db
            .prepare(
                "INSERT INTO workspaces(name, created_at, updated_at) VALUES ('sidebar', 1, 1)",
            )
            .run().lastInsertRowid,
    );
    const member = db.prepare(
        "INSERT INTO workspace_members(workspace_id, project_path, display_name, display_path, added_at) VALUES (?, ?, ?, ?, 1)",
    );
    member.run(workspace, project, "own", directory);
    member.run(workspace, "git:foreign", "foreign", "foreign");
    const insert =
        db.prepare(`INSERT INTO memories(project_path, category, content, normalized_hash,
        status, shareable, scope, first_seen_at, last_seen_at, created_at, updated_at)
        VALUES (?, ?, 'memory', ?, ?, ?, ?, 1, 1, 1, 1)`);
    insert.run(project, "ARCHITECTURE", "own", "active", 0, "project");
    insert.run("git:foreign", "CONSTRAINTS", "shared", "active", 1, "ecosystem");
    insert.run("git:foreign", "CONSTRAINTS", "permanent", "permanent", 1, "universe");
    insert.run("git:foreign", "CONSTRAINTS", "private", "active", 0, "project");
    insert.run("git:foreign", "ARCHITECTURE", "not-shared", "active", 1, "ecosystem");
    insert.run("git:foreign", "CONSTRAINTS", "session-only", "active", 1, "session");
    db.prepare("UPDATE session_meta SET cached_m0_materialized_at = 1 WHERE session_id = ?").run(
        session,
    );
    expect(buildSidebarSnapshot(db, session, directory).memoriesSinceCache).toBe(3);
});

function seedHistoryAndMemory(db: Database, project: string, session: string) {
    appendCompartments(db, session, [
        { sequence: 0, startMessage: 1, endMessage: 1, title: "History", content: "History" },
    ]);
    db.prepare(`INSERT INTO memories(project_path, category, content, normalized_hash,
        status, first_seen_at, last_seen_at, created_at, updated_at)
        VALUES (?, 'CONSTRAINTS', 'memory', 'seed', 'active', 1, 1, 1, 1)`).run(project);
}

test("N5 leaves the post-cache counts unknown before the first m[0] is built", () => {
    const { db, directory, project, session } = fixture();
    seedHistoryAndMemory(db, project, session);
    const prepared = spyOn(db, "prepare");
    const snapshot = buildSidebarSnapshot(db, session, directory);
    const queries = prepared.mock.calls.map(([sql]) => sql);
    prepared.mockRestore();
    expect(snapshot.cachedM0MaterializedAt).toBeNull();
    expect(snapshot.summariesSinceCache).toBeUndefined();
    expect(snapshot.memoriesSinceCache).toBeUndefined();
    expect(queries.some((sql) => /FROM memories[\s\S]*id\s*>/.test(sql))).toBe(false);
});

test("N5 leaves the cache rows unknown in Rust mode, where the TypeScript m[0] columns are not written", () => {
    const { db, directory, project, session } = fixture();
    seedHistoryAndMemory(db, project, session);
    db.prepare(`UPDATE session_meta SET cached_m0_materialized_at = 1234,
        cached_m0_max_compartment_seq = -1, cached_m0_max_memory_id = 0 WHERE session_id = ?`).run(
        session,
    );
    const snapshot = buildSidebarSnapshot(db, session, directory, undefined, undefined, {
        transform_mode: "rust",
    });
    expect(snapshot.cachedM0MaterializedAt).toBeNull();
    expect(snapshot.summariesSinceCache).toBeUndefined();
    expect(snapshot.memoriesSinceCache).toBeUndefined();
});

test("N4 leaves the drop estimate unknown when a queued drop has no token count", () => {
    const { db, directory, session } = fixture();
    const insert = db.prepare(
        "INSERT INTO tags(session_id, message_id, tag_number, type, byte_size, token_count) VALUES (?, ?, ?, 'message', 10, ?)",
    );
    insert.run(session, "m1", 101, 123);
    insert.run(session, "m2", 102, null);
    for (const tag of getTagsBySession(db, session))
        expect(queuePendingDropForUnchangedTag(db, session, tag)).toBe(true);
    const snapshot = buildSidebarSnapshot(db, session, directory);
    expect(snapshot.queuedDropCount).toBe(2);
    expect(snapshot.queuedDropTokens).toBeUndefined();
});

test("reports the persisted historian failure count, which survives a restart", () => {
    const { db, directory, session } = fixture();
    db.prepare("UPDATE session_meta SET historian_failure_count = 2 WHERE session_id = ?").run(
        session,
    );
    expect(buildSidebarSnapshot(db, session, directory).historianFailureCount).toBe(2);
});
