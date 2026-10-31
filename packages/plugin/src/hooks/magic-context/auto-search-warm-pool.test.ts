import { afterEach, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutoSearchDiagnostics } from "../../features/magic-context/auto-search-diagnostics";
import { peekCompartmentChunkSearchPool } from "../../features/magic-context/compartment-chunk-embedding";
import * as embedding from "../../features/magic-context/memory/embedding";
import { runMigrations } from "../../features/magic-context/migrations";
import { type UnifiedSearchResult, unifiedSearch } from "../../features/magic-context/search";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getAutoSearchHintDecisions } from "../../features/magic-context/storage-meta-persisted";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { _resetAutoSearchCache, runAutoSearchHint } from "./auto-search-runner";
import { autoSearchTestSnapshot } from "./auto-search-snapshot.fixture";
import * as workers from "./auto-search-worker-client";
import { AutoSearchBusyError, searchAutoHint } from "./auto-search-worker-client";

const directories: string[] = [];
const databases: Database[] = [];
afterEach(() => {
    _resetAutoSearchCache();
    for (const db of databases.splice(0)) db.close();
    for (const directory of directories.splice(0)) cleanupTestTempDir(directory);
});

function fixture() {
    const directory = createTestTempDirFromPath(join(tmpdir(), "auto-hint-warm-pool-"));
    directories.push(directory);
    const db = new Database(join(directory, "context.db"));
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    db.prepare(
        "INSERT INTO message_history_fts (session_id,message_ordinal,message_id,role,content) VALUES ('session',1,'archived','assistant','historian cache wiring answer')",
    ).run();
    const id = Number(
        db
            .prepare(`INSERT INTO compartments (session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,created_at)
            VALUES ('session',0,1,2,'u1','a2','Historian cache wiring','stored','stored',1)`)
            .run().lastInsertRowid,
    );
    const vector = new Float32Array([0.91, Math.sqrt(1 - 0.91 * 0.91)]);
    db.prepare(`INSERT INTO compartment_chunk_embeddings
        (compartment_id,session_id,project_path,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,harness,created_at)
        VALUES (?,'session','/synthetic',0,1,2,'hash','model',2,?,'opencode',1)`).run(
        id,
        new Uint8Array(vector.buffer),
    );
    return db;
}

const options = {
    sources: ["message"] as "message"[],
    memoryEnabled: false,
    countRetrievals: false,
    measurementDisabled: true,
    chunkModelIdOverride: "model",
    chunkPoolWarmOnly: true,
    embedQuery: async () => new Float32Array([1, 0]),
    isEmbeddingRuntimeEnabled: () => true,
};
const query = "historian cache wiring";
const hasChunkHit = (results: UnifiedSearchResult[]) =>
    results.some((result) => result.source === "compartment");

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const started = performance.now();
    while (!condition()) {
        if (performance.now() - started > timeoutMs) throw new Error("condition not met in time");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** A first search whose query embedding only settles when its deadline aborts it. */
async function searchUntilDeadline(db: Database): Promise<UnifiedSearchResult[]> {
    const deadline = new AbortController();
    const entered = Promise.withResolvers<void>();
    const pending = searchAutoHint(db, "session", "/synthetic", query, {
        ...options,
        signal: deadline.signal,
        embedQuery: (_text, signal) =>
            new Promise((resolve) => {
                entered.resolve();
                signal?.addEventListener("abort", () => resolve(null), { once: true });
            }),
    });
    await entered.promise;
    deadline.abort();
    return pending;
}

test("a deadline stops waiting but keeps the worker, and the next turn finds the pool warm", async () => {
    const db = fixture();
    const before = workers.getAutoSearchWorkerStats();
    expect(await searchUntilDeadline(db)).toEqual([]);
    // The abandoned search finishes in the background; until then the session
    // is skipped rather than queued. Then the same worker serves the next turn
    // from the pool that search warmed.
    let warm: UnifiedSearchResult[] = [];
    async function poll() {
        try {
            warm = await searchAutoHint(db, "session", "/synthetic", query, options);
        } catch (error) {
            if (!(error instanceof AutoSearchBusyError)) throw error;
        }
    }
    for (let attempt = 0; attempt < 100 && !hasChunkHit(warm); attempt++) {
        await poll();
        if (!hasChunkHit(warm)) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(hasChunkHit(warm)).toBe(true);
    expect(workers.getAutoSearchWorkerStats().created - before.created).toBe(1);
}, 15000);

test("a search of a session whose earlier search is still running is skipped, not queued", async () => {
    const db = fixture();
    const deadline = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<null>();
    // A provider that ignores cancellation holds the first job past its deadline.
    const first = searchAutoHint(db, "session", "/synthetic", query, {
        ...options,
        signal: deadline.signal,
        embedQuery: () => {
            entered.resolve();
            return release.promise;
        },
    });
    await entered.promise;
    deadline.abort();
    expect(await first).toEqual([]);
    const started = performance.now();
    try {
        await expect(
            searchAutoHint(db, "session", "/synthetic", query, options),
        ).rejects.toBeInstanceOf(AutoSearchBusyError);
        expect(performance.now() - started).toBeLessThan(150);
    } finally {
        release.resolve(null);
    }
}, 15000);

test("a deadline logs where the abandoned search spent its time, without its text", async () => {
    const db = fixture();
    const log = spyOn(logger, "log");
    try {
        await searchUntilDeadline(db);
        const late = () =>
            log.mock.calls
                .map(([message]) => String(message))
                .find((message) => message.includes("deadline passed after"));
        await until(() => late() !== undefined);
        const line = late() ?? "";
        for (const step of ["message FTS", "vector wait", "chunk lane", "pool"])
            expect(line).toContain(step);
        expect(line).not.toContain(query);
        expect(line).not.toContain("answer");
    } finally {
        log.mockRestore();
    }
}, 15000);

test("a turn with a cold pool skips the chunk lane at once and warms it in the background", async () => {
    const db = fixture();
    const search = () =>
        unifiedSearch(db, "session", "/synthetic", query, { ...options, autoHint: true });
    const cold = await search();
    // The search returned before any pool row was read or decoded.
    expect(peekCompartmentChunkSearchPool(db, "session", "/synthetic", "model")).toBeNull();
    expect(hasChunkHit(cold)).toBe(false);
    expect(cold.some((result) => result.source === "message")).toBe(true);
    await until(
        () => peekCompartmentChunkSearchPool(db, "session", "/synthetic", "model") !== null,
    );
    expect(hasChunkHit(await search())).toBe(true);
});

test("worker diagnostics report cold starts, warm reuse and signature-invalidated peeks without content", async () => {
    const db = fixture();
    const search = async () => {
        const diagnostics = createAutoSearchDiagnostics(0.6);
        const results = await searchAutoHint(db, "session", "/synthetic", query, {
            ...options,
            autoSearchDiagnostics: diagnostics,
        });
        return { diagnostics, results };
    };
    const cold = await search();
    expect(cold.diagnostics.workerStarted).toBe(true);
    expect(cold.diagnostics.pool).toBe("cold");
    expect(cold.diagnostics.peek).toBe("missing");
    expect(cold.diagnostics.lanes.summaries).toEqual({ top: null, nearMisses: 0 });
    let warm = cold;
    for (let attempt = 0; attempt < 100 && !hasChunkHit(warm.results); attempt++) {
        warm = await search();
        if (!hasChunkHit(warm.results)) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(warm.diagnostics.workerStarted).toBe(false);
    expect(warm.diagnostics.pool).toBe("warm");
    expect(warm.diagnostics.poolRows).toBe(1);
    expect(warm.diagnostics.peek).toBe("hit");
    expect(warm.diagnostics.lanes.summaries?.top).toBeCloseTo(0.728, 3);
    expect(JSON.stringify(warm.diagnostics)).not.toContain(query);
    expect(JSON.stringify(warm.diagnostics)).not.toContain("stored");
    db.prepare("DELETE FROM compartment_chunk_embeddings").run();
    const invalidated = await search();
    expect(invalidated.diagnostics.pool).toBe("cold");
    expect(invalidated.diagnostics.peek).toBe("signature-changed");
}, 15000);

test("a session still searching serves the turn without a hint and freezes that", async () => {
    const db = fixture();
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
        autoSearchTestSnapshot("/synthetic"),
    );
    const busy = spyOn(workers, "searchAutoHint").mockRejectedValue(new AutoSearchBusyError());
    try {
        const messages = [
            { info: { id: "turn", role: "user" }, parts: [{ type: "text", text: query }] },
        ];
        const before = JSON.stringify(messages);
        const outcome = await runAutoSearchHint({
            db,
            sessionId: "session",
            messages,
            options: {
                enabled: true,
                projectPath: "/synthetic",
                scoreThreshold: 0,
                minPromptChars: 1,
            },
        });
        expect(outcome).toEqual({ ok: false, kind: "timeout" });
        expect(JSON.stringify(messages)).toBe(before);
        expect(getAutoSearchHintDecisions(db, "session")).toEqual([
            { messageId: "turn", decision: "no-hint", reason: "timeout" },
        ]);
    } finally {
        busy.mockRestore();
        snapshot.mockRestore();
    }
});

test("the decision log reports lane relevance, not the rank score", async () => {
    const db = fixture();
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
        autoSearchTestSnapshot("/synthetic"),
    );
    const results = spyOn(workers, "searchAutoHint").mockImplementation(
        async (_db, _session, _project, _query, options) => {
            options.autoSearchDiagnostics!.lanes.messages = { top: 0.8, nearMisses: 0 };
            return [
                {
                    source: "message",
                    content: "historian cache wiring answer",
                    score: 1,
                    relevanceScore: 0.8,
                    messageOrdinal: 1,
                    messageId: "archived",
                    role: "assistant",
                },
            ];
        },
    );
    const backfill = spyOn(workers, "queueAutoSearchBackfill").mockResolvedValue();
    const sessionLog = spyOn(logger, "sessionLog");
    try {
        await runAutoSearchHint({
            db,
            sessionId: "session",
            messages: [
                { info: { id: "logged", role: "user" }, parts: [{ type: "text", text: query }] },
            ],
            options: {
                enabled: true,
                projectPath: "/synthetic",
                scoreThreshold: 0.6,
                minPromptChars: 1,
            },
        });
        const attached = sessionLog.mock.calls
            .map(([, message]) => String(message))
            .find((message) => message.includes("outcome=attached"));
        expect(attached).toContain("lanes=messages:0.800");
    } finally {
        sessionLog.mockRestore();
        backfill.mockRestore();
        results.mockRestore();
        snapshot.mockRestore();
    }
});

test("no backfill worker is started when the project's memory feature is off", async () => {
    const db = fixture();
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue({
        ...autoSearchTestSnapshot("/synthetic"),
        features: { memoryEnabled: false, gitCommitEnabled: false },
    });
    const embed = spyOn(embedding, "embedTextForProject").mockResolvedValue(null);
    try {
        const before = workers.getAutoSearchWorkerStats().created;
        await workers.queueAutoSearchBackfill(db, "session", "/synthetic", query);
        expect(workers.getAutoSearchWorkerStats().created).toBe(before);
    } finally {
        embed.mockRestore();
        snapshot.mockRestore();
    }
});
