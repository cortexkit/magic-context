/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { computeNormalizedHash } from "./normalize-hash";
import { copyMemoriesToProject, rekeyMemoryRowWithCollisionMerge } from "./relocate-memory";
import {
    archiveMemory,
    deleteMemory,
    getMemoryById,
    insertMemoryIdempotent,
    ModuleMemoryAuthorityError,
    mergeMemoryStats,
    updateMemoryContent,
} from "./storage-memory";

type EvidenceRow = {
    memory_id: number;
    content_hash: string;
    source_session_id: string;
    source_message_id: string | null;
    source_type: string;
};

let db: Database;

function makeDatabase(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

function evidence(memoryId: number): EvidenceRow[] {
    return db
        .prepare(
            `SELECT memory_id, content_hash, source_session_id, source_message_id, source_type
               FROM memory_evidence
              WHERE memory_id = ?
              ORDER BY source_session_id`,
        )
        .all(memoryId) as EvidenceRow[];
}

function save(content: string, sessionId: string, messageId: string) {
    return insertMemoryIdempotent(db, {
        projectPath: "git:project",
        category: "CONSTRAINTS",
        content,
        sourceSessionId: sessionId,
        sourceMessageId: messageId,
        sourceType: "user",
    }).memory;
}

afterEach(() => {
    if (db) closeQuietly(db);
});

describe("memory evidence lifecycle", () => {
    it("counts one exact observation per session episode", () => {
        db = makeDatabase();

        const first = save("Use the shared store", "session-a", "user-a1");
        save("Use the shared store", "session-a", "user-a2");
        const corroborated = save("Use the shared store", "session-b", "user-b1");

        expect(corroborated.id).toBe(first.id);
        expect(corroborated.seenCount).toBe(2);
        expect(evidence(first.id)).toEqual([
            {
                memory_id: first.id,
                content_hash: first.normalizedHash,
                source_session_id: "session-a",
                source_message_id: "user-a1",
                source_type: "user",
            },
            {
                memory_id: first.id,
                content_hash: first.normalizedHash,
                source_session_id: "session-b",
                source_message_id: "user-b1",
                source_type: "user",
            },
        ]);
    });

    it("rejects MODULE-managed exact duplicates before recording evidence", () => {
        db = makeDatabase();
        const memory = save("Authority-owned fact", "session-a", "user-a1");
        db.prepare(
            "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, ?, ?)",
        ).run("git:project", "store-uuid", Date.now());

        expect(() => save("Authority-owned fact", "session-b", "user-b1")).toThrow(
            ModuleMemoryAuthorityError,
        );
        expect(evidence(memory.id)).toHaveLength(1);
        expect(getMemoryById(db, memory.id)?.seenCount).toBe(1);
    });

    it("advances a migrated legacy baseline for a new session without double counting", () => {
        db = makeDatabase();
        const memory = save("Migrated fact", "session-a", "user-a1");
        db.prepare("UPDATE memories SET seen_count = 10 WHERE id = ?").run(memory.id);

        save("Migrated fact", "session-a", "user-a2");
        expect(getMemoryById(db, memory.id)?.seenCount).toBe(10);

        save("Migrated fact", "session-b", "user-b1");
        expect(getMemoryById(db, memory.id)?.seenCount).toBe(11);
    });

    it("preserves evidence through update archive and delete lifecycle", () => {
        db = makeDatabase();
        const memory = save("Original fact", "session-a", "user-a1");

        updateMemoryContent(db, memory.id, "Updated fact", computeNormalizedHash("Updated fact"));
        save("Updated fact", "session-b", "assistant-b1");
        archiveMemory(db, memory.id);

        expect(evidence(memory.id).map((row) => row.content_hash)).toEqual([
            computeNormalizedHash("Original fact"),
            computeNormalizedHash("Updated fact"),
        ]);
        deleteMemory(db, memory.id);
        expect(evidence(memory.id)).toEqual([]);
    });

    it("counts one session once across content versions", () => {
        db = makeDatabase();
        const memory = save("Original fact", "session-a", "user-a1");

        updateMemoryContent(db, memory.id, "Updated fact", computeNormalizedHash("Updated fact"));
        const updated = save("Updated fact", "session-a", "user-a2");

        expect(evidence(memory.id)).toHaveLength(2);
        expect(updated.seenCount).toBe(1);
    });

    it("unions source evidence onto the canonical memory during merge", () => {
        db = makeDatabase();
        const canonical = save("First phrasing", "session-a", "user-a1");
        const source = save("Independent phrasing", "session-b", "user-b1");

        mergeMemoryStats(
            db,
            canonical.id,
            canonical.seenCount + source.seenCount,
            0,
            JSON.stringify([canonical.id, source.id]),
            "active",
        );

        expect(evidence(canonical.id).map((row) => row.source_session_id)).toEqual([
            "session-a",
            "session-b",
        ]);
        expect(getMemoryById(db, canonical.id)?.seenCount).toBe(2);
    });

    it("preserves a legacy seen count during a sparsely evidenced merge", () => {
        db = makeDatabase();
        const canonical = save("First phrasing", "session-a", "user-a1");
        const source = save("Independent phrasing", "session-b", "user-b1");
        db.prepare("UPDATE memories SET seen_count = 10 WHERE id = ?").run(canonical.id);

        mergeMemoryStats(
            db,
            canonical.id,
            canonical.seenCount + source.seenCount,
            0,
            JSON.stringify([canonical.id, source.id]),
            "active",
        );

        expect(getMemoryById(db, canonical.id)?.seenCount).toBe(11);
    });

    it("preserves evidence when identity relocation merges an exact collision", () => {
        db = makeDatabase();
        const target = save("Same fact", "session-a", "user-a1");
        const source = insertMemoryIdempotent(db, {
            projectPath: "git:old-project",
            category: "CONSTRAINTS",
            content: "Same fact",
            sourceSessionId: "session-b",
            sourceMessageId: "user-b1",
            sourceType: "user",
        }).memory;

        db.transaction(() => {
            rekeyMemoryRowWithCollisionMerge(db, source.id, "git:old-project", "git:project");
        })();

        expect(evidence(target.id).map((row) => row.source_session_id)).toEqual([
            "session-a",
            "session-b",
        ]);
        expect(getMemoryById(db, source.id)).toBeNull();
    });

    it("reconciles relocation collisions against unioned distinct-session evidence", () => {
        db = makeDatabase();
        const target = save("Same fact", "session-a", "user-a1");
        const source = insertMemoryIdempotent(db, {
            projectPath: "git:old-project",
            category: "CONSTRAINTS",
            content: "Same fact",
            sourceSessionId: "session-b",
            sourceMessageId: "user-b1",
            sourceType: "user",
        }).memory;
        db.prepare(
            `INSERT INTO memory_evidence (
                memory_id, content_hash, source_session_id, source_message_id, source_type, observed_at
            ) VALUES (?, ?, 'session-c', 'user-c1', 'user', ?)`,
        ).run(source.id, source.normalizedHash, Date.now());
        db.prepare("UPDATE memories SET seen_count = 2 WHERE id = ?").run(source.id);

        db.transaction(() => {
            rekeyMemoryRowWithCollisionMerge(db, source.id, "git:old-project", "git:project");
        })();

        expect(evidence(target.id)).toHaveLength(3);
        expect(getMemoryById(db, target.id)?.seenCount).toBe(3);
    });

    it("rolls back a new memory when evidence insertion fails", () => {
        db = makeDatabase();
        db.exec(`
            CREATE TRIGGER fail_memory_evidence BEFORE INSERT ON memory_evidence
            BEGIN
                SELECT RAISE(ABORT, 'injected evidence failure');
            END;
        `);

        expect(() => save("Atomic fact", "session-a", "assistant-a1")).toThrow(
            "injected evidence failure",
        );
        expect(db.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({ count: 0 });
    });

    it("unions evidence when a copy collides with an existing target", () => {
        db = makeDatabase();
        const target = save("Same fact", "session-a", "assistant-a1");
        const source = insertMemoryIdempotent(db, {
            projectPath: "git:source",
            category: "CONSTRAINTS",
            content: "Same fact",
            sourceSessionId: "session-b",
            sourceMessageId: "assistant-b1",
            sourceType: "agent",
        }).memory;

        db.transaction(() => copyMemoriesToProject(db, [source.id], "git:project"))();

        expect(evidence(target.id).map((row) => row.source_session_id)).toEqual([
            "session-a",
            "session-b",
        ]);
        expect(getMemoryById(db, target.id)?.seenCount).toBe(2);
    });
});
