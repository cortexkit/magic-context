// Bundle with Bun, then run the bundle under real Node to exercise node:sqlite:
// bun build packages/plugin/src/tools/ctx-memory/sqlite-backends.test.ts --target node --format esm --splitting \
//   --outdir packages/plugin/tmp/ctx-memory-sqlite --entry-naming '[name].mjs' --external onnxruntime-node --external sharp
// node --test packages/plugin/tmp/ctx-memory-sqlite/sqlite-backends.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { getMemoryById, insertMemory } from "../../features/magic-context/memory/storage-memory";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database, detectSqliteRuntime } from "../../shared/sqlite";
import { createCtxMemoryTools } from "./tools";

const project = "git:ctx-memory-sqlite-review";
async function exerciseUpdate(authorityGuard: boolean): Promise<void> {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        const existing = insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "timeout=5s",
        });
        const source = insertMemory(db, {
            projectPath: project,
            category: "CONFIG_VALUES",
            content: "cache_ttl=5m",
        });
        if (authorityGuard)
            db.exec(
                "CREATE TRIGGER review_authority_guard BEFORE UPDATE ON memories BEGIN SELECT RAISE(ABORT, 'authority is draining'); END",
            );
        // Hide only the first duplicate probe so the real database, not the preflight, refuses the write.
        const prepare = db.prepare.bind(db);
        let nativeError: unknown;
        let probes = 0;
        db.prepare = ((sql: string) => {
            const statement = prepare(sql);
            if (
                sql.includes(
                    "FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ?",
                )
            ) {
                const get = statement.get.bind(statement);
                statement.get = (...args: unknown[]) => (++probes === 1 ? undefined : get(...args));
            }
            if (sql.startsWith("UPDATE memories SET")) {
                const run = statement.run.bind(statement);
                statement.run = (...args: unknown[]) => {
                    try {
                        return run(...args);
                    } catch (error) {
                        nativeError = error;
                        throw error;
                    }
                };
            }
            return statement;
        }) as typeof db.prepare;
        const tool = createCtxMemoryTools({
            db,
            resolveProjectPath: () => project,
            memoryEnabled: true,
            embeddingEnabled: false,
        }).ctx_memory;
        const update = () =>
            tool.execute(
                {
                    action: "update",
                    ids: [source.id],
                    category: "PROJECT_RULES",
                    content: "timeout=5s",
                },
                { sessionID: "review", agent: "general", directory: "/review" } as never,
            );
        if (authorityGuard) {
            await assert.rejects(update, (error: unknown) => {
                assert.equal(error, nativeError);
                assert.match((error as Error).message, /authority is draining/);
                return true;
            });
            assert.equal(probes, 1);
        } else {
            assert.equal(
                await update(),
                `Error: Memory content already exists as ID ${existing.id}; merge or archive duplicates instead.`,
            );
            assert.equal(probes, 2);
        }
        assert.ok(nativeError instanceof Error, "the agent write must reach the real SQLite guard");
        assert.equal(
            (nativeError as Error & { code: string }).code,
            detectSqliteRuntime() === "Node.js"
                ? "ERR_SQLITE_ERROR"
                : authorityGuard
                  ? "SQLITE_CONSTRAINT_TRIGGER"
                  : "SQLITE_CONSTRAINT_UNIQUE",
        );
        assert.deepEqual(getMemoryById(db, source.id), source);
        assert.deepEqual(getMemoryById(db, existing.id), existing);
        assert.equal(
            (db.prepare("SELECT COUNT(*) AS n FROM memory_mutation_log").get() as { n: number }).n,
            0,
        );
        assert.equal(
            (db.prepare("SELECT COUNT(*) AS n FROM memory_history").get() as { n: number }).n,
            0,
        );
    } finally {
        db.close();
    }
}
console.log(`SQLite review checks: ${process.version}, ${detectSqliteRuntime()}`);
test("ctx_memory returns the friendly duplicate response after a native UNIQUE violation", () =>
    exerciseUpdate(false));
test("ctx_memory preserves a native authority refusal even when a duplicate exists", () =>
    exerciseUpdate(true));
