import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    type ProjectEmbeddingRegistrationSnapshot,
    registerProjectEmbedding,
} from "../memory/embedding";
import type { EmbeddingProvider, EmbeddingPurpose } from "../memory/embedding-provider";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { reembedStaleSkillNotes } from "./reembed";

const embedCalls: string[] = [];

function installReembedTestProvider(): void {
    _setTestProviderFactoryForProject(
        (): EmbeddingProvider => ({
            modelId: "test-provider-model",
            initialize: async () => true,
            embed: async (text: string, _signal?: AbortSignal, _purpose?: EmbeddingPurpose) => {
                embedCalls.push(text);
                return new Float32Array([0.1, 0.2, 0.3]);
            },
            embedBatch: async (
                texts: string[],
                _signal?: AbortSignal,
                _purpose?: EmbeddingPurpose,
            ) => texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
            dispose: async () => {},
            isLoaded: () => true,
        }),
    );
}

function registerReembedTestProject(
    db: Database,
    identity: string,
): ProjectEmbeddingRegistrationSnapshot {
    return registerProjectEmbedding(
        db,
        identity,
        { provider: "local", model: "mock-model" },
        { memoryEnabled: true, gitCommitEnabled: false },
        identity,
    );
}

describe("reembed", () => {
    test("reembedStaleSkillNotes fills NULL embeddings (bounded, idempotent)", async () => {
        _resetProjectEmbeddingRegistryForTests();
        _setTestProviderFactoryForProject(null);
        installReembedTestProvider();

        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const snapshot = registerReembedTestProject(db, "git:abc");
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
            expect(row.embedding_model_version).toBe(snapshot.modelId);
            const result2 = await reembedStaleSkillNotes(db, "git:abc");
            expect(result2.reembedded).toBe(0);
        } finally {
            closeQuietly(db);
            _resetProjectEmbeddingRegistryForTests();
            _setTestProviderFactoryForProject(null);
        }
    });

    test("reembed selects global '*' notes and embeds them under the real identity", async () => {
        _resetProjectEmbeddingRegistryForTests();
        _setTestProviderFactoryForProject(null);
        installReembedTestProvider();

        const { promoteSkillObservations } = await import("./promote");
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            registerReembedTestProject(db, "git:repoA");
            promoteSkillObservations(db, "git:repoA", [
                { skillId: "council", kind: "fix", lesson: "L7" },
            ]);
            embedCalls.length = 0;

            const res = await reembedStaleSkillNotes(db, "git:repoA");

            expect(res.reembedded).toBe(1);
            // Only the registered identity succeeds — structural proof that
            // embedTextForProject is called with "git:repoA".
            expect(embedCalls.length).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
            _resetProjectEmbeddingRegistryForTests();
            _setTestProviderFactoryForProject(null);
        }
    });
});
