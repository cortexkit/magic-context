import { expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as appliedProjection from "../../features/magic-context/memory/applied-projection";
import {
    writeHardProjection,
    writeSoftProjection,
} from "../../features/magic-context/memory/applied-projection";
import type { Memory } from "../../features/magic-context/memory/types";
import { runMigrations } from "../../features/magic-context/migrations";
import { getMural, upsertMural } from "../../features/magic-context/mural/storage-mural";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    ensureSessionMetaRow,
    persistCachedM0,
} from "../../features/magic-context/storage-meta-shared";
import { writeSessionRenderCache } from "../../features/magic-context/storage-session-cache";
import {
    readSessionMetaCollection,
    writeSessionMetaCollection,
} from "../../features/magic-context/storage-session-collections";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { stageManualBaseline } from "./manual-baseline";

const realReadStoredAppliedProjection = appliedProjection.readStoredAppliedProjection;

test("manual baseline staging holds back every cache field until admission commits", () => {
    const db = new Database(":memory:");
    try {
        db.exec(`CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY, cached_m0_bytes TEXT, cached_m1_bytes TEXT,
            cached_m0_last_baseline_end_message_id TEXT, memory_block_ids TEXT,
            memory_block_count INTEGER, last_response_time INTEGER
        ); INSERT INTO session_meta VALUES ('s', 'old head', 'old delta', 'row4', '[]', 0, 1)`);
        const read = () => db.prepare("SELECT * FROM session_meta").get();
        const before = read();
        const staged = stageManualBaseline(db, "s", () => {
            db.exec(
                "UPDATE session_meta SET cached_m0_bytes = 'new head', cached_m1_bytes = 'new delta', cached_m0_last_baseline_end_message_id = 'row12', memory_block_ids = '[42]', memory_block_count = 1",
            );
            return "new head";
        });
        expect(staged.summary).toBe("new head");
        expect(staged.boundaryID).toBe("row12");
        expect(read()).toEqual(before);
        db.exec("UPDATE session_meta SET last_response_time = 2");
        staged.commit();
        expect(read()).toEqual({
            ...(before as object),
            cached_m0_bytes: "new head",
            cached_m1_bytes: "new delta",
            cached_m0_last_baseline_end_message_id: "row12",
            memory_block_ids: "[42]",
            memory_block_count: 1,
            last_response_time: 2,
        });
        const stale = stageManualBaseline(db, "s", () => {
            db.exec("UPDATE session_meta SET cached_m0_bytes = 'stale'");
            return "stale";
        });
        db.exec("UPDATE session_meta SET cached_m0_bytes = 'concurrent request'");
        expect(() => stale.commit()).toThrow("baseline changed during admission");
        expect((read() as { cached_m0_bytes: string }).cached_m0_bytes).toBe("concurrent request");
        const stable = read();
        expect(() =>
            stageManualBaseline(db, "s", () => {
                db.exec("UPDATE session_meta SET cached_m0_bytes = 'partial'");
                throw new Error("render refused");
            }),
        ).toThrow("render refused");
        expect(read()).toEqual(stable);
    } finally {
        db.close();
    }
});

// Current stores keep a session's history head in four places: the markers in
// session_meta, the m[0]/m[1]/mural/upgrade-state payloads in
// session_render_cache, the ids of the memories it shows in the
// memory_block_ids collection, and the memory projection keyed to its m[0]
// bytes. Staging must hold back and publish all four together.

const UPGRADE = "ready|compartment-render:cre2|memory-render:mre3|mural-enabled:0";

/** A store migrated to the current schema; a file, so a second connection can lock it. */
function currentStore() {
    const base = join(tmpdir(), "magic-context", "manual-baseline");
    mkdirSync(base, { recursive: true });
    const root = createTestTempDirFromPath(join(base, "store-"));
    const path = join(root, "context.db");
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    ensureSessionMetaRow(db, "s");
    return {
        db,
        path,
        close() {
            db.close();
            cleanupTestTempDir(root);
        },
    };
}

/** Store a complete head the way a HARD fold does, labelled so each part is recognizable. */
function storeHead(db: Database, label: string, seq: number, ids: number[]) {
    db.transaction(() => {
        persistCachedM0(db, "s", {
            m0Bytes: Buffer.from(`${label} m0`),
            m1Bytes: Buffer.from(`${label} m1`),
            muralDataUrl: `data:image/png;base64,${label}`,
            muralHash: `${label}-mural`,
            projectMemoryEpoch: 0,
            projectUserProfileVersion: 0,
            maxCompartmentSeq: seq,
            maxMemoryId: Math.max(0, ...ids),
            maxMutationId: 0,
            maxMemoryMutationId: 0,
            projectDocsHash: null,
            materializedAt: seq,
            sessionFactsVersion: 0,
            upgradeState: `${UPGRADE}|m0-memory-ids:${JSON.stringify(ids)}|request-tool-definitions:${label}`,
            systemHash: "system",
            toolSetHash: "tools",
            modelKey: "openai/gpt-4.1",
            projectIdentity: null,
        });
        writeHardProjection(db, {
            sessionId: "s",
            projectPath: undefined,
            m0Text: `${label} m0`,
            hardMemoryBlock: JSON.stringify({ updateLines: [], newMemories: label }),
            fragmentWatermark: seq,
            revisions: new Map(ids.map((id) => [id, 1])),
            textMemories: ids.map((id) => ({ id, content: `${label} memory ${id}` }) as Memory),
            cueMemories: [],
            deltaMemories: [],
        });
        writeSessionMetaCollection(db, "s", "memory_block_ids", JSON.stringify(ids));
        db.prepare(
            "UPDATE session_meta SET memory_block_count = ?, cached_m0_last_baseline_end_message_id = ? WHERE session_id = 's'",
        ).run(ids.length, `row${seq}`);
    }).immediate();
}

/** Every stored part of the head, with bytes decoded so a difference is readable. */
function storedHead(db: Database) {
    const decode = (rows: unknown[]) =>
        (rows as Record<string, unknown>[]).map((row) =>
            Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                    key,
                    value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value,
                ]),
            ),
        );
    const meta = db.prepare("SELECT * FROM session_meta WHERE session_id = 's'").get() as Record<
        string,
        unknown
    >;
    return {
        markers: Object.fromEntries(
            Object.entries(meta).filter(
                ([key]) =>
                    key.startsWith("cached_m0_") ||
                    key.startsWith("cached_m1_") ||
                    key === "memory_block_count",
            ),
        ),
        payloads: decode(
            db
                .prepare(
                    "SELECT cache_key, value FROM session_render_cache WHERE session_id = 's' ORDER BY cache_key",
                )
                .all(),
        ),
        memoryBlockIds: decode(
            db
                .prepare(
                    "SELECT chunk, body FROM session_meta_chunks WHERE session_id = 's' AND column_name = 'memory_block_ids' ORDER BY chunk",
                )
                .all(),
        ),
        snapshots: db
            .prepare("SELECT * FROM memory_applied_snapshots WHERE session_id = 's'")
            .all(),
        rows: db
            .prepare("SELECT * FROM memory_applied_rows WHERE session_id = 's' ORDER BY memory_id")
            .all(),
    };
}

test("on a current store, staging holds back every part of the head until admission commits it", () => {
    const store = currentStore();
    const { db } = store;
    const fresh = new Database(store.path);
    try {
        storeHead(db, "old", 1, [7]);
        const before = storedHead(db);
        let rendered: ReturnType<typeof storedHead> | undefined;
        const staged = stageManualBaseline(db, "s", () => {
            storeHead(db, "new", 2, [7, 9]);
            rendered = storedHead(db);
            return "new m0";
        });
        expect(staged.summary).toBe("new m0");
        expect(staged.boundaryID).toBe("row2");
        // Every part changed in the render, and none of it was committed: this
        // connection and a fresh one both read the old head byte for byte, the
        // projection generation included.
        for (const part of ["markers", "payloads", "memoryBlockIds", "snapshots", "rows"] as const)
            expect(rendered?.[part]).not.toEqual(before[part]);
        expect(storedHead(db)).toEqual(before);
        expect(storedHead(fresh)).toEqual(before);
        // The collection cache this connection keeps does not serve the
        // rolled-back id manifest either.
        expect(readSessionMetaCollection(db, "s", "memory_block_ids")).toBe("[7]");
        expect(staged.headCommit().changed).toBe(false);
        staged.commit();
        // The commit publishes exactly what the render stored, the projection's
        // generation included; nothing is rendered again.
        expect(storedHead(db)).toEqual(rendered!);
        expect(storedHead(fresh)).toEqual(rendered!);
        expect(readSessionMetaCollection(db, "s", "memory_block_ids")).toBe("[7,9]");
        expect(staged.headCommit()).toEqual({ changed: true, previousCoverage: 1 });
    } finally {
        fresh.close();
        store.close();
    }
});

test("the commit accepts a re-encoded but equal head and refuses a really changed one", () => {
    const store = currentStore();
    const { db } = store;
    const stage = () =>
        stageManualBaseline(db, "s", () => {
            storeHead(db, "new", 2, [7, 9]);
            return "new m0";
        });
    try {
        storeHead(db, "old", 1, [7, 8]);
        const upgrade = `${UPGRADE}|m0-memory-ids:[7,8]|request-tool-definitions:old`;
        // Re-encoded: the same marker fields in another order, the same ids in
        // another order and repeated, the same m[1] bytes stored as text instead
        // of a blob, and the projection's memory block with its keys reordered.
        const equal = stage();
        db.transaction(() => {
            writeSessionRenderCache(
                db,
                "s",
                "cached_m0_upgrade_state",
                `${UPGRADE}|request-tool-definitions:old|m0-memory-ids:[7,8]`,
            );
            writeSessionMetaCollection(db, "s", "memory_block_ids", "[8,7,7]");
            writeSessionRenderCache(db, "s", "cached_m1_bytes", "old m1");
            db.prepare(
                "UPDATE memory_applied_snapshots SET hard_memory_block = ? WHERE session_id = 's'",
            ).run('{"newMemories":"old","updateLines":[]}');
        }).immediate();
        expect(() => equal.commit()).not.toThrow();
        expect(storedHead(db).payloads).toContainEqual({
            cache_key: "cached_m0_upgrade_state",
            value: `${UPGRADE}|m0-memory-ids:[7,9]|request-tool-definitions:new`,
        });

        // Really changed: one marker field, the id set, the m[1] bytes, a value
        // in the projection's memory block, or a projection write (its
        // generation advances) each refuse the commit and leave the concurrent
        // write in place.
        storeHead(db, "old", 1, [7, 8]);
        const changes: Array<[string, () => void]> = [
            [
                "upgrade-state field",
                () =>
                    writeSessionRenderCache(
                        db,
                        "s",
                        "cached_m0_upgrade_state",
                        upgrade.replace("cre2", "cre1"),
                    ),
            ],
            ["memory ids", () => writeSessionMetaCollection(db, "s", "memory_block_ids", "[7]")],
            [
                "m[1] bytes",
                () => writeSessionRenderCache(db, "s", "cached_m1_bytes", Buffer.from("old m1!")),
            ],
            [
                "projection memory block",
                () =>
                    db
                        .prepare(
                            "UPDATE memory_applied_snapshots SET hard_memory_block = ? WHERE session_id = 's'",
                        )
                        .run('{"newMemories":"other","updateLines":[]}'),
            ],
            [
                "projection generation",
                () =>
                    writeSoftProjection(db, {
                        sessionId: "s",
                        projectPath: undefined,
                        m0Text: "old m0",
                        projection: {
                            generation: 1,
                            hardMemoryBlock: JSON.stringify({
                                updateLines: [],
                                newMemories: "old",
                            }),
                            fragmentWatermark: 1,
                            committed: [],
                            legacy: false,
                        },
                    }),
            ],
        ];
        const outcomes: Record<string, unknown> = {};
        for (const [name, change] of changes) {
            storeHead(db, "old", 1, [7, 8]);
            const staged = stage();
            db.transaction(change).immediate();
            const concurrent = storedHead(db);
            let error = "";
            try {
                staged.commit();
            } catch (caught) {
                error = String(caught);
            }
            outcomes[name] = {
                refused: error.includes("baseline changed during admission"),
                keptConcurrentWrite: JSON.stringify(storedHead(db)) === JSON.stringify(concurrent),
                headChanged: staged.headCommit().changed,
            };
        }
        expect(outcomes).toEqual(
            Object.fromEntries(
                changes.map(([name]) => [
                    name,
                    { refused: true, keptConcurrentWrite: true, headChanged: false },
                ]),
            ),
        );
    } finally {
        store.close();
    }
});

// The whole stage is one write transaction. When another connection holds the
// write lock, the stage fails before anything renders, the hook refuses the
// compaction, and the store is untouched.
test("when the stage cannot take the write lock, nothing renders and the store is unchanged", () => {
    const store = currentStore();
    const { db } = store;
    const other = new Database(store.path);
    try {
        storeHead(db, "old", 1, [7]);
        const before = storedHead(db);
        db.exec("PRAGMA busy_timeout = 0");
        other.exec("PRAGMA busy_timeout = 0");
        other.exec("BEGIN IMMEDIATE");
        let renders = 0;
        expect(() =>
            stageManualBaseline(db, "s", () => {
                renders++;
                storeHead(db, "new", 2, [7, 9]);
                return "new m0";
            }),
        ).toThrow(/locked|busy/i);
        other.exec("ROLLBACK");
        expect(renders).toBe(0);
        expect(storedHead(db)).toEqual(before);
    } finally {
        other.close();
        store.close();
    }
});

// A render that throws, or a failure right after it, rolls the stage back with
// everything the render wrote.
test("a stage that fails during or right after the render leaves the store unchanged", () => {
    const store = currentStore();
    const { db } = store;
    try {
        storeHead(db, "old", 1, [7]);
        const before = storedHead(db);
        expect(() =>
            stageManualBaseline(db, "s", () => {
                storeHead(db, "new", 2, [7, 9]);
                throw new Error("render refused");
            }),
        ).toThrow("render refused");
        expect(storedHead(db)).toEqual(before);
        const read = spyOn(appliedProjection, "readStoredAppliedProjection");
        let reads = 0;
        read.mockImplementation((...args) => {
            // The second read is the rendered head's, right after the render.
            if (++reads === 2) throw new Error("read after render failed");
            return realReadStoredAppliedProjection(...args);
        });
        try {
            expect(() =>
                stageManualBaseline(db, "s", () => {
                    storeHead(db, "new", 2, [7, 9]);
                    return "new m0";
                }),
            ).toThrow("read after render failed");
        } finally {
            read.mockRestore();
        }
        expect(storedHead(db)).toEqual(before);
    } finally {
        store.close();
    }
});

// The render stores the project's mural row (a project-wide cache of the
// rendered image) together with the head. The stage rolls that write back too,
// so the commit stores it, unless another fold replaced the row meanwhile.
test("the commit stores the mural row the render wrote, unless another fold replaced it", () => {
    const store = currentStore();
    const { db } = store;
    const mural = (hash: string) => ({
        projectPath: "git:project",
        image: Buffer.from(`png ${hash}`),
        contentHash: hash,
        renderedAt: hash.length,
        model: "deterministic",
        memoryIds: [7],
        width: 1092,
        height: 1092,
    });
    const stage = () =>
        stageManualBaseline(db, "s", () => {
            storeHead(db, "new", 2, [7, 9]);
            upsertMural(db, mural("rendered"));
            return "new m0";
        });
    try {
        // No row before: the render's row appears only with the commit.
        storeHead(db, "old", 1, [7]);
        const first = stage();
        expect(getMural(db, "git:project")).toBeNull();
        first.commit();
        expect(getMural(db, "git:project")).toEqual(mural("rendered"));

        // An older row: the stage keeps it, the commit replaces it.
        storeHead(db, "old", 1, [7]);
        upsertMural(db, mural("older"));
        const second = stage();
        expect(getMural(db, "git:project")).toEqual(mural("older"));
        second.commit();
        expect(getMural(db, "git:project")).toEqual(mural("rendered"));

        // Another fold stored a newer row during admission: it stays, and the
        // head is still committed.
        storeHead(db, "old", 1, [7]);
        upsertMural(db, mural("older"));
        const third = stage();
        upsertMural(db, mural("newer one"));
        third.commit();
        expect(getMural(db, "git:project")).toEqual(mural("newer one"));
        expect(third.headCommit().changed).toBe(true);
    } finally {
        store.close();
    }
});
