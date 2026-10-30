import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
    __resetMessageIndexAsyncForTests,
    clearSessionTracking,
    scheduleClearAndReindex,
} from "../../features/magic-context/message-index-async";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { setBootQuietPeriodForTests } from "../../plugin/boot-quiet";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { disposeIdleAutoSearchWorkers, searchAutoHint } from "./auto-search-worker-client";

const sessionId = "auto-search-tree";
afterEach(() => {
    clearSessionTracking(sessionId);
    __resetMessageIndexAsyncForTests();
    setBootQuietPeriodForTests(null);
    disposeIdleAutoSearchWorkers();
});

for (const navigation of ["before search", "during search", "none"] as const) {
    test(`automatic message hints respect the owner's rebuild epoch: ${navigation}`, async () => {
        const temp = createTestTempDir("auto-search-tree-");
        const db = new Database(join(temp.dir, "context.db"));
        initializeDatabase(db);
        runMigrations(db);
        setBootQuietPeriodForTests(Date.now());
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const reset = () => scheduleClearAndReindex(db, sessionId, () => []);
        try {
            if (navigation === "before search") reset();
            const pending = searchAutoHint(
                db,
                sessionId,
                process.cwd(),
                "branch",
                {
                    sources: ["message", "note"],
                    embeddingEnabled: true,
                    isEmbeddingRuntimeEnabled: () => true,
                    embedQuery: async () => {
                        entered.resolve();
                        await release.promise;
                        return null;
                    },
                    measurementDisabled: true,
                    signal: AbortSignal.timeout(10000),
                },
                new URL("./auto-search-branch-index.fixture.ts", import.meta.url),
            );
            await entered.promise;
            if (navigation === "during search") reset();
            release.resolve();
            const results = await pending;
            expect(results.map((result) => result.source)).toEqual(
                navigation === "none" ? ["message", "note"] : ["note"],
            );
            expect(results.at(-1)?.content).toBe("retained note");
        } finally {
            release.resolve();
            clearSessionTracking(sessionId);
            db.close();
            disposeIdleAutoSearchWorkers();
            temp.cleanup();
        }
    });
}
