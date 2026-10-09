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
        if (authorityGuard) {
            db.exec(`CREATE TRIGGER review_authority_guard BEFORE UPDATE ON memories
                BEGIN SELECT RAISE(ABORT, 'authority is draining'); END`);
        }

        const prepare = db.prepare.bind(db);
        let canonicalWrites = 0;
        db.prepare = ((sql: string) => {
            if (sql.includes("UPDATE memories SET content")) canonicalWrites++;
            return prepare(sql);
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

        assert.match(String(await update()), /MEMORY_PENDING_PROPOSAL/);
        assert.equal(canonicalWrites, 0);
        assert.deepEqual(getMemoryById(db, existing.id), existing);
        assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM memory_tool_proposals").get(), {
            n: 1,
        });
        assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM memory_mutation_log").get(), {
            n: 0,
        });
        let nativeError: unknown;
        try {
            prepare("UPDATE memories SET content=?,category=?,normalized_hash=? WHERE id=?").run(
                existing.content,
                existing.category,
                existing.normalizedHash,
                source.id,
            );
        } catch (error) {
            nativeError = error;
        }
        assert.ok(
            nativeError instanceof Error,
            "the canonical write still reaches the native guard",
        );
        assert.equal(
            (nativeError as Error & { code: string }).code,
            detectSqliteRuntime() === "Node.js"
                ? "ERR_SQLITE_ERROR"
                : authorityGuard
                  ? "SQLITE_CONSTRAINT_TRIGGER"
                  : "SQLITE_CONSTRAINT_UNIQUE",
        );
        assert.equal(getMemoryById(db, source.id)?.category, "CONFIG_VALUES");
        assert.equal(getMemoryById(db, source.id)?.content, "cache_ttl=5m");
    } finally {
        db.close();
    }
}

console.log(`SQLite review checks: ${process.version}, ${detectSqliteRuntime()}`);
test("ctx_memory records duplicate updates as pending without reaching a native UNIQUE violation", () =>
    exerciseUpdate(false));
test("ctx_memory records pending work without exercising native memory authority writes", () =>
    exerciseUpdate(true));
