import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { recordMessageFtsRowid } from "./message-fts-rowid-map";
import {
    MESSAGE_FTS_SESSION_FILTER_SQL,
    withMessageFtsSessionFilter,
} from "./message-fts-session-filter";
import { createUnifiedSearchDiagnostics, unifiedSearch } from "./search";
import { initializeDatabase } from "./storage-db";

const databases: Database[] = [];
const directories: string[] = [];

function createDb(path = ":memory:"): Database {
    const db = new Database(path);
    databases.push(db);
    initializeDatabase(db);
    return db;
}

function insert(
    db: Database,
    session: string,
    ordinal: number,
    id: string,
    content: string,
    mapped = true,
    time: number | null = 1000,
): void {
    const result = db
        .prepare(`INSERT INTO message_history_fts
        (session_id, message_ordinal, message_id, role, content)
        VALUES (?, ?, ?, 'user', ?)`)
        .run(session, ordinal, id, content);
    if (mapped) recordMessageFtsRowid(db, session, ordinal, result.lastInsertRowid, time);
}

function seed(db: Database): void {
    for (const session of ["mapped", "legacy"]) {
        insert(db, session, 12, `${session}-12`, "cache_timeout cache_timeout queue");
        insert(db, session, 2, `${session}-2`, "cache_timeout queue");
        insert(db, session, 1, `${session}-1`, "cache_timeout queue");
        insert(db, session, 3, `${session}-3`, "worker queue", true, null);
        insert(db, session, 4, `${session}-4`, "worker cache_timeout", true, 2000);
    }
    insert(db, "legacy", 5, "unmapped", "cache_timeout queue", false);
    // Upserting the sidecar replaces an ordinal, not a physical FTS row. Both
    // copies must remain searchable, even after the backfill claims completion.
    insert(db, "legacy", 2, "collision", "cache_timeout queue");
    db.exec("UPDATE message_fts_rowid_map_backfill_state SET completed = 1");
    for (let ordinal = 0; ordinal < 100; ordinal++) {
        insert(db, "noise", ordinal, `noise-${ordinal}`, "cache_timeout queue worker filler");
    }
}

afterEach(() => {
    for (const db of databases.splice(0)) closeQuietly(db);
    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});

/** Execute the actual production SQL, then the previous global query against
 * the same store. Removing only the rowid predicate reproduces the old SELECT,
 * including its bm25 corpus, projections, limits, and tie-ordering clauses. */
function compareWithGlobalQueries(db: Database): { filtered: string[]; global: string[] } {
    const prepare = db.prepare.bind(db);
    const seen = { filtered: [] as string[], global: [] as string[] };
    db.prepare = ((sql: string) => {
        const statement = prepare(sql);
        if (sql.includes("message_history_fts MATCH ?") && !sql.startsWith("EXPLAIN")) {
            const all = statement.all.bind(statement);
            statement.all = ((...bindings: unknown[]) => {
                const actual = all(...bindings);
                const baselineSql = sql.replaceAll(MESSAGE_FTS_SESSION_FILTER_SQL, "");
                // Removing a rowid predicate also removes its own session binding.
                const fragmentBindings = new Set<number>();
                let bindingIndex = 0;
                const segments = sql.split(MESSAGE_FTS_SESSION_FILTER_SQL);
                for (const segment of segments.slice(0, -1)) {
                    bindingIndex += (segment.match(/\?/g) ?? []).length;
                    fragmentBindings.add(bindingIndex++);
                }
                const baseline = prepare(baselineSql).all(
                    ...bindings.filter((_, index) => !fragmentBindings.has(index)),
                );
                expect(JSON.stringify(actual)).toBe(JSON.stringify(baseline));
                seen[sql.includes(MESSAGE_FTS_SESSION_FILTER_SQL) ? "filtered" : "global"].push(
                    sql,
                );
                return actual;
            }) as typeof statement.all;
        }
        return statement;
    }) as typeof db.prepare;
    return seen;
}

describe("session-first message FTS", () => {
    test("preserves global ranked rows for complete and unmapped sessions across all query variants", async () => {
        const db = createDb();
        seed(db);
        expect(withMessageFtsSessionFilter(db, "mapped", (value) => value)).toBe(true);
        expect(withMessageFtsSessionFilter(db, "legacy", (value) => value)).toBe(false);
        const seen = compareWithGlobalQueries(db);
        let searches = 0;
        for (const session of ["mapped", "legacy"]) {
            for (const query of ["queue", "cache_timeout", "cache_timeout missing"]) {
                for (const cutoff of [undefined, 4, 0]) {
                    for (const dated of [false, true]) {
                        for (const explicitSearch of [false, true]) {
                            const diagnostics = explicitSearch
                                ? createUnifiedSearchDiagnostics()
                                : undefined;
                            await unifiedSearch(db, session, "git:fixture", query, {
                                sources: ["message"],
                                embeddingEnabled: false,
                                explicitSearch,
                                maxMessageOrdinal: cutoff,
                                from: dated ? 500 : undefined,
                                to: dated ? 1500 : undefined,
                                diagnostics,
                                limit: 2,
                                countRetrievals: false,
                                measurementDisabled: true,
                            });
                            searches++;
                        }
                    }
                }
            }
        }
        const legacy = await unifiedSearch(db, "legacy", "git:fixture", "queue", {
            sources: ["message"],
            embeddingEnabled: false,
            limit: 25,
            measurementDisabled: true,
        });
        expect(legacy.map((row) => (row.source === "message" ? row.messageId : ""))).toContain(
            "unmapped",
        );
        expect(legacy.map((row) => (row.source === "message" ? row.messageId : ""))).toContain(
            "legacy-2",
        );
        expect(legacy.map((row) => (row.source === "message" ? row.messageId : ""))).toContain(
            "collision",
        );
        expect(searches).toBe(72);
        expect(seen.filtered.length).toBeGreaterThan(30);
        expect(seen.global.length).toBeGreaterThan(10);
    });

    test("production message queries constrain FTS rowids through the session index", async () => {
        const db = createDb();
        seed(db);
        const seen = compareWithGlobalQueries(db);
        for (const explicitSearch of [false, true]) {
            for (const dated of [false, true]) {
                await unifiedSearch(db, "mapped", "git:fixture", "cache_timeout", {
                    sources: ["message"],
                    embeddingEnabled: false,
                    explicitSearch,
                    maxMessageOrdinal: 4,
                    diagnostics: explicitSearch ? createUnifiedSearchDiagnostics() : undefined,
                    from: dated ? 500 : undefined,
                    to: dated ? 1500 : undefined,
                    measurementDisabled: true,
                });
            }
        }
        expect(seen.global).toHaveLength(0);
        expect(seen.filtered.length).toBeGreaterThanOrEqual(6);
        const plan = db
            .prepare(`EXPLAIN QUERY PLAN SELECT content FROM message_history_fts
            WHERE ${MESSAGE_FTS_SESSION_FILTER_SQL}session_id = ? AND message_history_fts MATCH ?`)
            .all("mapped", "mapped", "queue") as Array<{ detail: string }>;
        // One postings cursor, not a MATCH restart for every sidecar rowid.
        expect(plan.some(({ detail }) => /VIRTUAL TABLE INDEX 0:M/.test(detail))).toBe(true);
        expect(
            plan.some(({ detail }) => /SEARCH message_fts_rowid_map.*session_id=/.test(detail)),
        ).toBe(true);
        const bytecode = db
            .prepare(`EXPLAIN SELECT content FROM message_history_fts
            WHERE ${MESSAGE_FTS_SESSION_FILTER_SQL}session_id = ? AND message_history_fts MATCH ?`)
            .all("mapped", "mapped", "queue") as Array<{ opcode: string }>;
        const membership = bytecode.findIndex(({ opcode }) => opcode === "NotFound");
        const contentRead = bytecode.findIndex(({ opcode }) => opcode === "VColumn");
        expect(membership).toBeGreaterThan(0);
        expect(contentRead).toBeGreaterThan(membership);
    });

    test("invalidates coverage for local writes, backfill, external commits, and rollback", () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "message-session-filter-"));
        directories.push(directory);
        const path = join(directory, "context.db");
        const db = createDb(path);
        db.exec("PRAGMA journal_mode = WAL");
        seed(db);
        const coverage = () => withMessageFtsSessionFilter(db, "mapped", (value) => value);
        expect(coverage()).toBe(true);
        insert(db, "mapped", 20, "local-legacy", "queue", false);
        expect(coverage()).toBe(false);
        // Discover the actual rowid rather than trusting the fixture's insert count.
        const local = db
            .prepare(
                "SELECT rowid AS id FROM message_history_fts WHERE message_id = 'local-legacy'",
            )
            .get() as { id: number };
        recordMessageFtsRowid(db, "mapped", 20, local.id);
        expect(coverage()).toBe(true);
        db.exec("BEGIN");
        insert(db, "mapped", 21, "rolled-back", "queue", false);
        expect(coverage()).toBe(false);
        db.exec("ROLLBACK");
        expect(coverage()).toBe(true);
        const writer = new Database(path);
        databases.push(writer);
        insert(writer, "mapped", 22, "external", "queue", false);
        expect(coverage()).toBe(false);
        writer.exec("DELETE FROM message_history_fts WHERE message_id = 'external'");
        expect(coverage()).toBe(true);
        db.exec(
            "DELETE FROM message_fts_rowid_map WHERE session_id = 'mapped' AND message_ordinal = 1",
        );
        expect(coverage()).toBe(false);
    });

    test("reads coverage and results in one snapshot and supports read-only handles", () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "message-session-snapshot-"));
        directories.push(directory);
        const path = join(directory, "context.db");
        const writer = createDb(path);
        writer.exec("PRAGMA journal_mode = WAL");
        seed(writer);
        const reader = new Database(path, { readonly: true });
        databases.push(reader);
        expect(withMessageFtsSessionFilter(reader, "mapped", (value) => value)).toBe(true);
        withMessageFtsSessionFilter(reader, "mapped", (sessionFirst) => {
            expect(sessionFirst).toBe(true);
            insert(writer, "mapped", 30, "concurrent", "queue", false);
            const rows = reader
                .prepare(
                    "SELECT message_id FROM message_history_fts WHERE message_id = 'concurrent'",
                )
                .all();
            expect(rows).toHaveLength(0);
        });
        expect(withMessageFtsSessionFilter(reader, "mapped", (value) => value)).toBe(false);
    });

    test("falls back when the physical rowid inventory is unavailable", () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.exec(`CREATE VIRTUAL TABLE message_history_fts USING fts5(session_id UNINDEXED, content, columnsize=0);
            CREATE TABLE message_fts_rowid_map(session_id TEXT, fts_rowid INTEGER);`);
        expect(withMessageFtsSessionFilter(db, "legacy", (value) => value)).toBe(false);
    });
});
