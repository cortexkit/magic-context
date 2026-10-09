import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { initializeDatabase } from "../storage-db";
import { getProjectEmbeddings, resetEmbeddingCacheForTests } from "./embedding-cache";
import { applyAgentMemoryMutation, getMemoryRevision } from "./lifecycle-applier";
import { getMemoryById, insertMemory } from "./storage-memory";
import { saveEmbedding } from "./storage-memory-embeddings";
import { recordMemoryMapping } from "./storage-memory-verifications";

function store() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    resetEmbeddingCacheForTests();
    return db;
}
const input = {
    projectPath: "agent-test",
    category: "CONFIG_VALUES" as const,
    content: "cache_ttl=5m",
};
function request(id: number, operation: "update" | "archive" | "merge" = "update") {
    return {
        key: "operation",
        projectPath: input.projectPath,
        sourceSessionId: "session",
        operation,
        targets: [{ id, revision: 1 }],
        content: "cache_ttl=10m",
    };
}
function row(db: Database, id: number) {
    return db.prepare("SELECT * FROM memories WHERE id=?").get(id) as Record<string, unknown>;
}

describe("immediate agent memory mutations", () => {
    test("agent update queues a live memory-updates mutation with complete undo history and no epoch", () => {
        const db = store();
        try {
            const memory = insertMemory(db, input);
            db.prepare("UPDATE memories SET shareable=1,classified_at=42 WHERE id=?").run(
                memory.id,
            );
            recordMemoryMapping(db, memory.id, ["src/old.ts"], 42, "mapper");
            saveEmbedding(db, memory.id, new Float32Array([1, 2]), "model");
            const cached = getProjectEmbeddings(db, input.projectPath, "model");
            expect(cached.has(memory.id)).toBe(true);
            const before = row(db, memory.id);
            const receipt = applyAgentMemoryMutation(db, request(memory.id));
            expect(receipt).toMatchObject({
                state: "applied",
                reason: "update",
                memoryId: memory.id,
                adoptionClass: "live",
            });
            expect(getMemoryById(db, memory.id)).toMatchObject({
                content: "cache_ttl=10m",
                shareable: 0,
            });
            expect(row(db, memory.id)).toMatchObject({ revision: 2, classified_at: null });
            expect(cached.has(memory.id)).toBe(false);
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get()).toEqual({
                n: 0,
            });
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_verifications").get()).toEqual({
                n: 0,
            });
            expect(
                db
                    .prepare(
                        "SELECT mutation_type,target_memory_id,new_content,adoption_class FROM memory_mutation_log",
                    )
                    .all(),
            ).toEqual([
                {
                    mutation_type: "update",
                    target_memory_id: memory.id,
                    new_content: "cache_ttl=10m",
                    adoption_class: "live",
                },
            ]);
            expect(db.prepare("SELECT * FROM project_state").all()).toEqual([]);
            const history = db
                .prepare(
                    "SELECT previous_text,after_text,before_json,after_json FROM memory_history",
                )
                .get() as {
                previous_text: string;
                after_text: string;
                before_json: string;
                after_json: string;
            };
            expect(history.previous_text).toBe(input.content);
            expect(history.after_text).toBe("cache_ttl=10m");
            expect(JSON.parse(history.before_json)).toEqual(before);
            expect(JSON.parse(history.after_json)).toEqual(row(db, memory.id));
            const journal = db
                .prepare("SELECT operation,before_json,after_json FROM memory_journal")
                .get() as { operation: string; before_json: string; after_json: string };
            expect(journal.operation).toBe("ctx_memory_update");
            expect(JSON.parse(journal.before_json)).toEqual([before]);
            expect(JSON.parse(journal.after_json)).toEqual([row(db, memory.id)]);
            expect(applyAgentMemoryMutation(db, request(memory.id))).toEqual(receipt);
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_mutation_log").get()).toEqual({
                n: 1,
            });
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_history").get()).toEqual({ n: 1 });
        } finally {
            db.close();
            resetEmbeddingCacheForTests();
        }
    });
    test("stale target revisions refuse all agent operations without rows history or mutations", () => {
        const db = store();
        try {
            const first = insertMemory(db, input);
            const second = insertMemory(db, { ...input, content: "other config" });
            db.prepare("UPDATE memories SET revision=2 WHERE id=?").run(first.id);
            const before = db.prepare("SELECT * FROM memories ORDER BY id").all();
            for (const operation of ["update", "archive", "merge"] as const) {
                const proposed = request(first.id, operation);
                proposed.key = operation;
                if (operation === "merge") proposed.targets.push({ id: second.id, revision: 1 });
                expect(applyAgentMemoryMutation(db, proposed)).toMatchObject({
                    state: "decided_pending",
                    reason: "stale_revision",
                });
            }
            expect(db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(before);
            for (const table of [
                "memory_history",
                "memory_journal",
                "memory_mutation_log",
                "memory_successor_links",
            ])
                expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        } finally {
            db.close();
        }
    });
    test("a lost merge source CAS rolls back the earlier source revision", () => {
        const db = store();
        try {
            const first = insertMemory(db, input);
            const second = insertMemory(db, { ...input, content: "other config" });
            db.exec(
                `CREATE TRIGGER cas_loser BEFORE UPDATE OF revision ON memories WHEN old.id=${second.id} BEGIN SELECT RAISE(IGNORE); END`,
            );
            expect(() =>
                applyAgentMemoryMutation(db, {
                    ...request(first.id, "merge"),
                    targets: [
                        { id: first.id, revision: 1 },
                        { id: second.id, revision: 1 },
                    ],
                }),
            ).toThrow("revision changed");
            expect(getMemoryRevision(db, first.id)).toBe(1);
            expect(getMemoryRevision(db, second.id)).toBe(1);
            expect(getMemoryById(db, first.id)?.content).toBe(input.content);
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_history").get()).toEqual({ n: 0 });
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_mutation_log").get()).toEqual({
                n: 0,
            });
        } finally {
            db.close();
        }
    });
    test("journal failure rolls back content revisions verification and embeddings", () => {
        const db = store();
        try {
            const memory = insertMemory(db, input);
            recordMemoryMapping(db, memory.id, ["old.ts"], 42, "mapper");
            saveEmbedding(db, memory.id, new Float32Array([1]), "model");
            const before = row(db, memory.id);
            db.exec(
                "CREATE TRIGGER refuse_journal BEFORE INSERT ON memory_journal BEGIN SELECT RAISE(ABORT,'audit failure'); END",
            );
            expect(() => applyAgentMemoryMutation(db, request(memory.id))).toThrow("audit failure");
            expect(row(db, memory.id)).toEqual(before);
            for (const table of ["memory_verifications", "memory_embeddings"])
                expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
            for (const table of [
                "memory_history",
                "memory_mutation_log",
                "memory_decision_receipts",
            ])
                expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        } finally {
            db.close();
        }
    });
    test("merge creates a canonical agent row with stats successors and reversible source snapshots", () => {
        const db = store();
        try {
            const first = insertMemory(db, input);
            const second = insertMemory(db, { ...input, content: "another TTL" });
            db.prepare(
                "UPDATE memories SET seen_count=4,retrieval_count=3,status='permanent' WHERE id=?",
            ).run(second.id);
            const before = db.prepare("SELECT * FROM memories ORDER BY id").all();
            const mutation = {
                ...request(first.id, "merge"),
                targets: [
                    { id: first.id, revision: 1 },
                    { id: second.id, revision: 1 },
                ],
            };
            const receipt = applyAgentMemoryMutation(db, mutation);
            expect(receipt).toMatchObject({
                state: "applied",
                adoptionClass: "live",
                supersededIds: [first.id, second.id],
            });
            const canonical = getMemoryById(db, receipt.memoryId!)!;
            expect(canonical).toMatchObject({
                content: "cache_ttl=10m",
                sourceType: "agent",
                seenCount: 5,
                retrievalCount: 3,
                status: "permanent",
            });
            expect(JSON.parse(canonical.mergedFrom!)).toEqual([first.id, second.id]);
            for (const source of [first, second])
                expect(getMemoryById(db, source.id)).toMatchObject({
                    status: "archived",
                    supersededByMemoryId: canonical.id,
                });
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_history").get()).toEqual({ n: 2 });
            expect(
                db.prepare("SELECT mutation_type,adoption_class FROM memory_mutation_log").all(),
            ).toEqual(Array(2).fill({ mutation_type: "superseded", adoption_class: "live" }));
            const journal = db
                .prepare("SELECT before_json,after_json FROM memory_journal")
                .get() as { before_json: string; after_json: string };
            expect(JSON.parse(journal.before_json)).toEqual([...before, null]);
            expect(JSON.parse(journal.after_json)).toEqual(
                db.prepare("SELECT * FROM memories ORDER BY id").all(),
            );
            expect(db.prepare("SELECT * FROM project_state").all()).toEqual([]);
        } finally {
            db.close();
        }
    });
    test("merge can reuse a source canonical id without a self-successor link", () => {
        const db = store();
        try {
            const first = insertMemory(db, input);
            const second = insertMemory(db, { ...input, content: "another TTL" });
            const receipt = applyAgentMemoryMutation(db, {
                ...request(first.id, "merge"),
                content: input.content,
                targets: [
                    { id: first.id, revision: 1 },
                    { id: second.id, revision: 1 },
                ],
            });
            expect(receipt).toMatchObject({ memoryId: first.id, supersededIds: [second.id] });
            expect(
                db.prepare("SELECT source_id,successor_id FROM memory_successor_links").all(),
            ).toEqual([{ source_id: second.id, successor_id: first.id }]);
        } finally {
            db.close();
        }
    });
    test("archive saves exact before and after state and cleans derived data", () => {
        const db = store();
        try {
            const memory = insertMemory(db, input);
            db.prepare("UPDATE memories SET shareable=1,classified_at=42 WHERE id=?").run(
                memory.id,
            );
            recordMemoryMapping(db, memory.id, ["old.ts"], 42, "mapper");
            saveEmbedding(db, memory.id, new Float32Array([1]), "model");
            const before = row(db, memory.id);
            const receipt = applyAgentMemoryMutation(db, {
                ...request(memory.id, "archive"),
                reason: "obsolete",
            });
            expect(receipt).toMatchObject({ state: "applied", adoptionClass: "live" });
            expect(row(db, memory.id)).toMatchObject({
                status: "archived",
                revision: 2,
                shareable: 0,
                classified_at: null,
            });
            const history = db
                .prepare("SELECT before_json,after_json FROM memory_history")
                .get() as { before_json: string; after_json: string };
            expect(JSON.parse(history.before_json)).toEqual(before);
            expect(JSON.parse(history.after_json)).toEqual(row(db, memory.id));
            expect(getMemoryById(db, memory.id)?.metadataJson).toContain("obsolete");
            expect(
                db.prepare("SELECT mutation_type,adoption_class FROM memory_mutation_log").all(),
            ).toEqual([{ mutation_type: "archive", adoption_class: "live" }]);
            for (const table of ["memory_verifications", "memory_embeddings"])
                expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        } finally {
            db.close();
        }
    });
});
