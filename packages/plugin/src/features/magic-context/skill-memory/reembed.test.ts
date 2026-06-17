import { expect, mock, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";

// Provider "up" with a deterministic model — MUST precede the reembed.ts import.
mock.module("../memory/embedding", () => ({
    embedTextForProject: async (_p: string, _text: string) => ({
        vector: new Float32Array([0.1, 0.2, 0.3]),
        modelId: "test-model",
        generation: 1,
    }),
}));
const { reembedStaleSkillNotes } = await import("./reembed");

test("reembedStaleSkillNotes fills NULL embeddings (bounded, idempotent)", async () => {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        runMigrations(db);
        db.prepare(
            `INSERT INTO skill_memory (skill_id,resolved_path,tier,project_identity,intent,kind,delta,normalized_hash,hit_count,pinned,created_at)
             VALUES ('s','/p','global','git:abc','fix auth','fix','mock Date','h1',0,0,1)`,
        ).run();
        const result1 = await reembedStaleSkillNotes(db, "git:abc");
        expect(result1.reembedded).toBe(1);
        const row = db
            .prepare(
                "SELECT intent_embedding, delta_embedding, embedding_model_version FROM skill_memory WHERE normalized_hash='h1'",
            )
            .get() as {
            intent_embedding: unknown;
            delta_embedding: unknown;
            embedding_model_version: string;
        };
        expect(row.intent_embedding).not.toBeNull();
        expect(row.delta_embedding).not.toBeNull();
        expect(row.embedding_model_version).toBe("test-model");
        const result2 = await reembedStaleSkillNotes(db, "git:abc");
        expect(result2.reembedded).toBe(0);
    } finally {
        closeQuietly(db);
    }
});
