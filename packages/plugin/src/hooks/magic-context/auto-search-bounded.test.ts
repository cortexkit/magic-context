import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as embedding from "../../features/magic-context/memory/embedding";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getAutoSearchHintDecisions } from "../../features/magic-context/storage-meta-persisted";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { deadlineClock, nextLoopTurn } from "./auto-search-clock.test";
import { persistAutoSearchSkip } from "./auto-search-deadline";
import { _resetAutoSearchCache, runAutoSearchHint } from "./auto-search-runner";
import { autoSearchTestSnapshot } from "./auto-search-snapshot.fixture";
import * as search from "./auto-search-worker-client";
import { searchAutoHint } from "./auto-search-worker-client";

const root = join(tmpdir(), "magic-context", "auto-search-deadline");
mkdirSync(root, { recursive: true });
const db = new Database(join(createTestTempDirFromPath(join(root, "test-")), "context.db"));
initializeDatabase(db);
runMigrations(db);
const options = {
    enabled: true,
    scoreThreshold: 0.6,
    minPromptChars: 10,
    projectPath: "git:deadline",
    memoryEnabled: true,
    embeddingEnabled: true,
};
const messages = () => [
    {
        info: { id: "user", role: "user" },
        parts: [{ type: "text", text: "explain historian cache wiring details" }],
    },
];
let snapshotSpy: ReturnType<typeof spyOn<typeof embedding, "getProjectEmbeddingSnapshot">>;
beforeEach(() => {
    snapshotSpy = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
        autoSearchTestSnapshot(options.projectPath),
    );
});
afterEach(() => {
    // A timed-out search can still hold the shared project's worker lease after one loop turn.
    // Cancel detached work before another test tries to acquire that worker.
    _resetAutoSearchCache();
    snapshotSpy.mockRestore();
});
afterAll(() => db.close());

test("slow embedding aborts at the deadline, freezes skip bytes, and cannot land late", async () => {
    const clock = deadlineClock();
    const entered = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    let release: ((value: null) => void) | undefined;
    const spy = spyOn(embedding, "embedTextForProject").mockImplementation(
        async (_project, _text, currentSignal) => {
            signal = currentSignal;
            return new Promise<null>((resolve) => {
                release = resolve;
                entered.resolve();
            });
        },
    );
    try {
        const wire = messages();
        const before = JSON.stringify(wire);
        const pending = runAutoSearchHint({ sessionId: "embedding", db, messages: wire, options });
        await entered.promise;
        expect(signal?.aborted).toBe(false);
        clock.expire();
        await pending;
        expect(signal?.aborted).toBe(true);
        expect(JSON.stringify(wire)).toBe(before);
        await persistAutoSearchSkip(db, "embedding", "user");
        expect(getAutoSearchHintDecisions(db, "embedding")).toEqual([
            { messageId: "user", decision: "no-hint", reason: "timeout" },
        ]);
        release?.(null);
        await nextLoopTurn();
        const retry = messages();
        await runAutoSearchHint({ sessionId: "embedding", db, messages: retry, options });
        expect(JSON.stringify(retry)).toBe(before);
        expect(spy).toHaveBeenCalledTimes(1);
    } finally {
        release?.(null);
        spy.mockRestore();
        clock.restore();
    }
}, 6000);

test("a blocked synchronous search worker yields the owner and is aborted at its deadline", async () => {
    const clock = deadlineClock();
    let searchSignal: AbortSignal | undefined;
    const workerEntered = Promise.withResolvers<void>();
    const embed = spyOn(embedding, "embedTextForProject").mockImplementation(
        async (_project, text) => {
            if (text === "synchronous-fixture-entered") workerEntered.resolve();
            return null;
        },
    );
    const realSearch = searchAutoHint;
    const spy = spyOn(search, "searchAutoHint").mockImplementation(
        (db, sessionId, projectPath, query, options) => {
            searchSignal = options.signal;
            return realSearch(
                db,
                sessionId,
                projectPath,
                query,
                options,
                new URL("./auto-search-blocking.fixture.ts", import.meta.url),
            );
        },
    );
    try {
        const wire = messages();
        const before = JSON.stringify(wire);
        let served = false;
        const pending = runAutoSearchHint({ sessionId: "sync", db, messages: wire, options }).then(
            () => {
                served = true;
            },
        );
        await workerEntered.promise;
        await nextLoopTurn();
        expect(served).toBe(false);
        clock.expire();
        expect(searchSignal?.aborted).toBe(true);
        await pending;
        expect(embed).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(wire)).toBe(before);
    } finally {
        spy.mockRestore();
        embed.mockRestore();
        clock.restore();
    }
}, 6000);

test("worker hint bytes match the original search and the pre-change golden payload", async () => {
    const { insertMemory } = await import("../../features/magic-context/memory/storage-memory");
    const { unifiedSearch } = await import("../../features/magic-context/search");
    const { buildAutoSearchHint } = await import("./auto-search-hint");
    insertMemory(db, {
        projectPath: options.projectPath,
        category: "ARCHITECTURE_DECISIONS",
        content: "historian cache wiring details",
    });
    const original = await unifiedSearch(
        db,
        "bytes",
        options.projectPath,
        "historian cache wiring",
        {
            embeddingEnabled: false,
            countRetrievals: false,
            measurementDisabled: true,
            sources: ["memory", "message", "git_commit"],
        },
    );
    const golden =
        "\n\n<ctx-search-hint>\nYour memory may contain 1 related fragment:\n- historian cache wiring details\nIf the fragments above seem relevant to the current request, you may run ctx_search to retrieve full context. Otherwise ignore.\n</ctx-search-hint>";
    expect(`\n\n${buildAutoSearchHint(original)}`).toBe(golden);
    const wire = messages();
    const prompt = wire[0].parts[0].text;
    expect(
        await runAutoSearchHint({
            sessionId: "bytes",
            db,
            messages: wire,
            options: { ...options, embeddingEnabled: false, scoreThreshold: 0 },
        }),
    ).toEqual({ ok: true });
    expect(wire[0].parts[0].text).toBe(prompt + golden);
});

test("late search results cannot mutate this turn or a later pass's bytes", async () => {
    const clock = deadlineClock();
    const entered = Promise.withResolvers<void>();
    let release:
        | ((results: import("../../features/magic-context/search").UnifiedSearchResult[]) => void)
        | undefined;
    const spy = spyOn(search, "searchAutoHint").mockImplementation(
        () =>
            new Promise((resolve) => {
                release = resolve;
                entered.resolve();
            }),
    );
    try {
        const wire = messages();
        const before = JSON.stringify(wire);
        const pending = runAutoSearchHint({ sessionId: "late", db, messages: wire, options });
        await entered.promise;
        clock.expire();
        await pending;
        release?.([
            {
                source: "memory",
                content: "historian cache wiring details",
                score: 1,
                memoryId: 1,
                category: "ARCHITECTURE_DECISIONS",
                matchType: "fts",
            },
        ]);
        await nextLoopTurn();
        expect(JSON.stringify(wire)).toBe(before);
        const replay = messages();
        await runAutoSearchHint({ sessionId: "late", db, messages: replay, options });
        expect(JSON.stringify(replay)).toBe(before);
        expect(spy).toHaveBeenCalledTimes(1);
    } finally {
        spy.mockRestore();
        clock.restore();
    }
}, 6000);

test("cold synchronous preparation is deferred beyond the served stage", async () => {
    const snapshot = snapshotSpy.mockReturnValue(null);
    let prepared = false;
    const preparation = Promise.withResolvers<void>();
    const wire = messages();
    const before = JSON.stringify(wire);
    try {
        await runAutoSearchHint({
            db,
            sessionId: "cold-sync-preparation",
            messages: wire,
            options: {
                ...options,
                directory: "/synthetic-project",
                ensureProjectRegistered: async () => {
                    prepared = true;
                    preparation.resolve();
                },
            },
        });
        expect(prepared).toBe(false);
        expect(JSON.stringify(wire)).toBe(before);
        await preparation.promise;
        expect(prepared).toBe(true);
    } finally {
        snapshot.mockRestore();
    }
}, 7000);

test("worker preserves the owner's busy-host backfill gate and hint bytes", async () => {
    const { setEmbeddingSessionBusy } = await import("../../shared/embedding-activity");
    const { insertMemory } = await import("../../features/magic-context/memory/storage-memory");
    const { unifiedSearch } = await import("../../features/magic-context/search");
    const { buildAutoSearchHint } = await import("./auto-search-hint");
    insertMemory(db, {
        projectPath: options.projectPath,
        category: "ARCHITECTURE_DECISIONS",
        content: "explain historian cache wiring details for busy host",
    });
    const vector = {
        vector: new Float32Array([1, 0]),
        modelId: "fixture-provider",
        chunkModelId: "fixture-chunks",
        generation: 1,
    };
    const query = spyOn(embedding, "embedTextForProject").mockResolvedValue(vector);
    const batch = spyOn(embedding, "embedBatchForProject").mockResolvedValue({
        vectors: [vector.vector, vector.vector],
        modelId: vector.modelId,
        generation: 1,
    });
    setEmbeddingSessionBusy("fixture-owner", true);
    try {
        const original = await unifiedSearch(
            db,
            "busy-host",
            options.projectPath,
            "explain historian cache wiring details",
            {
                countRetrievals: false,
                measurementDisabled: true,
                sources: ["memory", "message", "git_commit"],
                embedQuery: async () => vector,
                isEmbeddingRuntimeEnabled: () => true,
            },
        );
        expect(original.length).toBeGreaterThan(0);
        const wire = messages();
        const prompt = wire[0].parts[0].text;
        await runAutoSearchHint({
            db,
            sessionId: "busy-host",
            messages: wire,
            options: { ...options, scoreThreshold: 0 },
        });
        expect(batch).toHaveBeenCalledTimes(0);
        expect(wire[0].parts[0].text).toBe(`${prompt}\n\n${buildAutoSearchHint(original)}`);
    } finally {
        setEmbeddingSessionBusy("fixture-owner", false);
        query.mockRestore();
        batch.mockRestore();
    }
});

test("concurrent passes join one read and replay the owner's decision", async () => {
    const entered = Promise.withResolvers<void>();
    let release:
        | ((results: import("../../features/magic-context/search").UnifiedSearchResult[]) => void)
        | undefined;
    const results = spyOn(search, "searchAutoHint").mockImplementation(
        () =>
            new Promise((resolve) => {
                release = resolve;
                entered.resolve();
            }),
    );
    const firstWire = messages();
    const secondWire = messages();
    const first = runAutoSearchHint({
        db,
        sessionId: "concurrent-read",
        messages: firstWire,
        options,
    });
    const second = runAutoSearchHint({
        db,
        sessionId: "concurrent-read",
        messages: secondWire,
        options,
    });
    try {
        await entered.promise;
        expect(getAutoSearchHintDecisions(db, "concurrent-read")).toEqual([]);
        release?.([
            {
                source: "memory",
                content: "historian cache wiring details",
                score: 1,
                memoryId: 1,
                category: "ARCHITECTURE_DECISIONS",
                matchType: "fts",
            },
        ]);
        expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
        expect(JSON.stringify(secondWire)).toBe(JSON.stringify(firstWire));
        expect(firstWire[0].parts[0].text).toContain("ctx-search-hint");
        expect(results).toHaveBeenCalledTimes(1);
    } finally {
        results.mockRestore();
    }
});

test("session cleanup discards a pending search result without recreating its decision row", async () => {
    const { clearSession, getOrCreateSessionMeta } = await import(
        "../../features/magic-context/storage-meta-session"
    );
    const { clearAutoSearchForSession } = await import("./auto-search-runner");
    const sessionId = "cleanup-pending-read";
    getOrCreateSessionMeta(db, sessionId);
    let release!: (
        results: import("../../features/magic-context/search").UnifiedSearchResult[],
    ) => void;
    const entered = Promise.withResolvers<void>();
    const results = spyOn(search, "searchAutoHint").mockImplementation(
        () =>
            new Promise((resolve) => {
                release = resolve;
                entered.resolve();
            }),
    );
    try {
        const wire = messages();
        const before = JSON.stringify(wire);
        const pending = runAutoSearchHint({ db, sessionId, messages: wire, options });
        await entered.promise;
        clearSession(db, sessionId);
        clearAutoSearchForSession(sessionId);
        release([
            {
                source: "memory",
                content: "late",
                score: 1,
                memoryId: 1,
                category: "ARCHITECTURE_DECISIONS",
                matchType: "fts",
            },
        ]);
        await pending;
        expect(JSON.stringify(wire)).toBe(before);
        expect(
            db.prepare("SELECT 1 FROM session_meta WHERE session_id=?").get(sessionId),
        ).toBeFalsy();
    } finally {
        results.mockRestore();
    }
});
