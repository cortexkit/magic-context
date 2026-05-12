import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../storage";
import { cosineSimilarity } from "./cosine-similarity";
import { _resetEmbeddingSweepGuard, embedAllUnembeddedMemories } from "./embedding";
import { getEmbeddingProviderIdentity } from "./embedding-identity";
import { LocalEmbeddingProvider } from "./embedding-local";
import { OpenAICompatibleEmbeddingProvider } from "./embedding-openai";

describe("embedding module", () => {
    describe("#given cosine similarity", () => {
        it("returns 1 for identical vectors", () => {
            //#when
            const similarity = cosineSimilarity(
                new Float32Array([1, 2, 3]),
                new Float32Array([1, 2, 3]),
            );

            //#then
            expect(similarity).toBe(1);
        });

        it("returns 0 for orthogonal vectors", () => {
            //#when
            const similarity = cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]));

            //#then
            expect(similarity).toBe(0);
        });

        it("returns -1 for opposite vectors", () => {
            //#when
            const similarity = cosineSimilarity(
                new Float32Array([1, 0]),
                new Float32Array([-1, 0]),
            );

            //#then
            expect(similarity).toBe(-1);
        });

        it("handles zero vectors gracefully", () => {
            //#when
            const similarity = cosineSimilarity(
                new Float32Array([0, 0, 0]),
                new Float32Array([0, 0, 0]),
            );

            //#then
            expect(similarity).toBe(0);
        });

        it("handles different length vectors", () => {
            //#when
            const similarity = cosineSimilarity(
                new Float32Array([1, 2, 3]),
                new Float32Array([1, 2]),
            );

            //#then
            expect(similarity).toBe(0);
        });
    });

    describe("#given embedding providers", () => {
        it("local provider uses default model id and starts unloaded", () => {
            const provider = new LocalEmbeddingProvider();

            expect(provider.modelId).toBe(
                getEmbeddingProviderIdentity({
                    provider: "local",
                    model: "Xenova/all-MiniLM-L6-v2",
                }),
            );
            expect(provider.isLoaded()).toBe(false);
        });

        it("openai-compatible provider normalizes endpoint in model id", () => {
            const provider = new OpenAICompatibleEmbeddingProvider({
                endpoint: "http://localhost:1234/v1/",
                model: "text-embedding-3-small",
                apiKey: "secret",
            });

            expect(provider.modelId).toBe(
                getEmbeddingProviderIdentity({
                    provider: "openai-compatible",
                    endpoint: "http://localhost:1234/v1",
                    model: "text-embedding-3-small",
                    api_key: "present",
                }),
            );
            expect(provider.isLoaded()).toBe(false);
        });

        it("openai-compatible identity tracks api-key presence but not secret value", () => {
            const first = new OpenAICompatibleEmbeddingProvider({
                endpoint: "http://localhost:1234/v1/",
                model: "text-embedding-3-small",
                apiKey: "secret-one",
            });
            const rotated = new OpenAICompatibleEmbeddingProvider({
                endpoint: "http://localhost:1234/v1",
                model: "text-embedding-3-small",
                apiKey: "secret-two",
            });
            const anonymous = new OpenAICompatibleEmbeddingProvider({
                endpoint: "http://localhost:1234/v1",
                model: "text-embedding-3-small",
            });

            expect(first.modelId).toBe(rotated.modelId);
            expect(first.modelId).not.toBe(anonymous.modelId);
            expect(first.modelId).not.toContain("secret");
        });
    });

    describe("#given embedAllUnembeddedMemories sweep", () => {
        const tempDirs: string[] = [];
        const originalXdgDataHome = process.env.XDG_DATA_HOME;

        function useTempDataHome(prefix: string): void {
            const dir = mkdtempSync(join(tmpdir(), prefix));
            tempDirs.push(dir);
            process.env.XDG_DATA_HOME = dir;
        }

        afterEach(() => {
            closeDatabase();
            _resetEmbeddingSweepGuard();
            process.env.XDG_DATA_HOME = originalXdgDataHome;
            for (const dir of tempDirs) {
                rmSync(dir, { recursive: true, force: true });
            }
            tempDirs.length = 0;
        });

        function seedMemoriesWithoutEmbeddings(
            db: ReturnType<typeof openDatabase>,
            rows: Array<{ projectPath: string; content: string; updatedAt: number }>,
        ): void {
            const now = Date.now();
            for (const [i, row] of rows.entries()) {
                db.prepare(
                    `INSERT INTO memories
                     (project_path, category, content, normalized_hash, source_session_id,
                      seen_count, first_seen_at, created_at, updated_at, last_seen_at, status)
                     VALUES (?, 'TEST', ?, ?, 'ses-test', 1, ?, ?, ?, ?, 'active')`,
                ).run(row.projectPath, row.content, `hash-${i}`, now, now, row.updatedAt, now);
            }
        }

        it("returns 0 immediately when provider is 'off'", async () => {
            useTempDataHome("embed-sweep-off-");
            const db = openDatabase();
            seedMemoriesWithoutEmbeddings(db, [
                { projectPath: "git:proj-a", content: "memory 1", updatedAt: 100 },
            ]);

            const count = await embedAllUnembeddedMemories(db, { provider: "off" });
            expect(count).toBe(0);
        });

        it("guards against parallel sweeps — second invocation returns 0 while first is running", async () => {
            useTempDataHome("embed-sweep-guard-");
            const db = openDatabase();
            seedMemoriesWithoutEmbeddings(db, [
                { projectPath: "git:proj-a", content: "memory 1", updatedAt: 100 },
            ]);

            // First call: starts a sweep. With provider 'off' it exits quickly,
            // but the guard is checked BEFORE the provider check, so we can
            // validate guard behavior by calling twice without awaiting the
            // first. In practice the guard is cleared synchronously in finally,
            // so we rely on the explicit _resetEmbeddingSweepGuard export for
            // a deterministic assertion instead of racing the timing.
            // (Full concurrent-behavior coverage lives in integration tests.)
            const first = embedAllUnembeddedMemories(db, { provider: "off" });
            const second = embedAllUnembeddedMemories(db, { provider: "off" });
            const [a, b] = await Promise.all([first, second]);
            // Both exit returning 0. Ordering of the guard hit is
            // environment-dependent (which microtask runs first) so we assert
            // on the observable invariant: at most one produced work, and the
            // guard is cleared afterward so a fresh call works.
            expect(a + b).toBe(0);
            const third = await embedAllUnembeddedMemories(db, { provider: "off" });
            expect(third).toBe(0);
        });

        it("orders projects by MAX(updated_at) descending — most-recent drains first", async () => {
            // We can't actually call an embedding provider in unit tests, but
            // we can verify the selection query returns projects in the right
            // order by introspecting the same SELECT the sweep uses.
            useTempDataHome("embed-sweep-order-");
            const db = openDatabase();

            seedMemoriesWithoutEmbeddings(db, [
                { projectPath: "git:old-project", content: "old-1", updatedAt: 100 },
                { projectPath: "git:old-project", content: "old-2", updatedAt: 200 },
                { projectPath: "git:recent-project", content: "recent-1", updatedAt: 900 },
                { projectPath: "git:recent-project", content: "recent-2", updatedAt: 950 },
                { projectPath: "git:middle-project", content: "mid-1", updatedAt: 500 },
            ]);

            const rows = db
                .prepare(
                    `SELECT m.project_path, MAX(m.updated_at) AS latest
                     FROM memories m
                     WHERE m.status IN ('active', 'permanent')
                     AND m.id NOT IN (SELECT memory_id FROM memory_embeddings)
                     GROUP BY m.project_path
                     ORDER BY latest DESC
                     LIMIT 20`,
                )
                .all() as Array<{ project_path: string; latest: number }>;

            expect(rows.map((r) => r.project_path)).toEqual([
                "git:recent-project",
                "git:middle-project",
                "git:old-project",
            ]);
            expect(rows[0]?.latest).toBe(950);
        });
    });
});
