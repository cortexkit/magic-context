import { afterEach, expect, spyOn, test } from "bun:test";
import { appendCompartments } from "../features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { runMigrations } from "../features/magic-context/migrations";
import { initializeDatabase } from "../features/magic-context/storage-db";
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
        "INSERT INTO tags(session_id, message_id, tag_number, type, token_count) VALUES (?, ?, ?, 'text', ?)",
    );
    const first = Number(insert.run(session, "m1", 1, 123).lastInsertRowid);
    const second = Number(insert.run(session, "m2", 2, 456).lastInsertRowid);
    db.prepare("INSERT INTO pending_ops(session_id, tag_id, operation) VALUES (?, ?, 'drop')").run(
        session,
        first,
    );
    db.prepare("INSERT INTO pending_ops(session_id, tag_id, operation) VALUES (?, ?, 'keep')").run(
        session,
        second,
    );
    db.prepare(
        "INSERT INTO pending_ops(session_id, tag_id, operation) VALUES ('other', ?, 'drop')",
    ).run(second);
    const prepared = spyOn(db, "prepare");
    const snapshot = buildSidebarSnapshot(db, session, directory);
    expect(snapshot.queuedDropTokens).toBe(123);
    const sql = prepared.mock.calls
        .map(([sql]) => sql)
        .find((sql) => /SUM\(.*token_count/.test(sql));
    expect(sql).toBeDefined();
    prepared.mockRestore();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(session) as { detail: string }[];
    console.log(
        "N4",
        plan.map((row) => row.detail),
    );
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
    for (const [label, pattern, params] of [
        ["N5 summaries", /COUNT\(\*\).*compartments.*sequence\s*>/s, [session, 0]],
        ["N5 memories", /COUNT\(\*\).*memories.*id\s*>/s, [project, 1, Date.now()]],
    ] as const) {
        const sql = queries.find((sql) => pattern.test(sql));
        expect(sql).toBeDefined();
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
        console.log(
            label,
            plan.map((row) => row.detail),
        );
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
    insert.run(project, "CODE", "own", "active", 0, "project");
    insert.run("git:foreign", "CONSTRAINTS", "shared", "active", 1, "ecosystem");
    insert.run("git:foreign", "CONSTRAINTS", "permanent", "permanent", 1, "universe");
    insert.run("git:foreign", "CONSTRAINTS", "private", "active", 0, "project");
    insert.run("git:foreign", "CODE", "not-shared", "active", 1, "ecosystem");
    insert.run("git:foreign", "CONSTRAINTS", "session-only", "active", 1, "session");
    expect(buildSidebarSnapshot(db, session, directory).memoriesSinceCache).toBe(3);
});
