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
import { persistAutoSearchSkip } from "./auto-search-deadline";
import { runAutoSearchHint } from "./auto-search-runner";
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
afterEach(() => snapshotSpy.mockRestore());
afterAll(() => db.close());

test("slow embedding aborts at the deadline, freezes skip bytes, and cannot land late", async () => {
    let signal: AbortSignal | undefined;
    let release: ((value: null) => void) | undefined;
    const spy = spyOn(embedding, "embedTextForProject").mockImplementation(
        async (_project, _text, currentSignal) => {
            signal = currentSignal;
            return new Promise<null>((resolve) => {
                release = resolve;
            });
        },
    );
    try {
        const wire = messages();
        const before = JSON.stringify(wire);
        const start = performance.now();
        await runAutoSearchHint({ sessionId: "embedding", db, messages: wire, options });
        expect(performance.now() - start).toBeLessThan(3150);
        expect(signal?.aborted).toBe(true);
        expect(JSON.stringify(wire)).toBe(before);
        await persistAutoSearchSkip(db, "embedding", "user");
        expect(getAutoSearchHintDecisions(db, "embedding")).toEqual([
            { messageId: "user", decision: "no-hint", reason: "timeout" },
        ]);
        release?.(null);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const retry = messages();
        await runAutoSearchHint({ sessionId: "embedding", db, messages: retry, options });
        expect(JSON.stringify(retry)).toBe(before);
        expect(spy).toHaveBeenCalledTimes(1);
    } finally {
        release?.(null);
        spy.mockRestore();
    }
}, 6000);

test("slow synchronous search returns the stage within deadline plus 150ms", async () => {
    const embed = spyOn(embedding, "embedTextForProject").mockResolvedValue(null);
    const realSearch = searchAutoHint;
    const spy = spyOn(search, "searchAutoHint").mockImplementation(
        (db, sessionId, projectPath, query, options) =>
            realSearch(
                db,
                sessionId,
                projectPath,
                query,
                options,
                new URL("./auto-search-blocking.fixture.ts", import.meta.url),
            ),
    );
    try {
        const wire = messages();
        const before = JSON.stringify(wire);
        const start = performance.now();
        await runAutoSearchHint({ sessionId: "sync", db, messages: wire, options });
        expect(performance.now() - start).toBeLessThan(3150);
        expect(embed).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(wire)).toBe(before);
    } finally {
        spy.mockRestore();
        embed.mockRestore();
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
    await runAutoSearchHint({
        sessionId: "bytes",
        db,
        messages: wire,
        options: { ...options, embeddingEnabled: false, scoreThreshold: 0 },
    });
    expect(wire[0].parts[0].text).toBe(prompt + golden);
});

test("late search results cannot mutate this turn or a later pass's bytes", async () => {
    let release:
        | ((results: import("../../features/magic-context/search").UnifiedSearchResult[]) => void)
        | undefined;
    const spy = spyOn(search, "searchAutoHint").mockImplementation(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    try {
        const wire = messages();
        const before = JSON.stringify(wire);
        await runAutoSearchHint({ sessionId: "late", db, messages: wire, options });
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
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(JSON.stringify(wire)).toBe(before);
        const replay = messages();
        const start = performance.now();
        await runAutoSearchHint({ sessionId: "late", db, messages: replay, options });
        expect(performance.now() - start).toBeLessThan(100);
        expect(JSON.stringify(replay)).toBe(before);
        expect(spy).toHaveBeenCalledTimes(1);
    } finally {
        spy.mockRestore();
    }
}, 6000);

test("cold synchronous preparation is deferred beyond the served stage", async () => {
    const snapshot = snapshotSpy.mockReturnValue(null);
    let prepared = false;
    const wire = messages();
    const before = JSON.stringify(wire);
    const start = performance.now();
    try {
        await runAutoSearchHint({
            db,
            sessionId: "cold-sync-preparation",
            messages: wire,
            options: {
                ...options,
                directory: "/synthetic-project",
                ensureProjectRegistered: async () => {
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3600);
                    prepared = true;
                },
            },
        });
        expect(performance.now() - start).toBeLessThan(3150);
        expect(prepared).toBe(false);
        expect(JSON.stringify(wire)).toBe(before);
        await new Promise((resolve) => setTimeout(resolve, 0));
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
    let release:
        | ((results: import("../../features/magic-context/search").UnifiedSearchResult[]) => void)
        | undefined;
    const results = spyOn(search, "searchAutoHint").mockImplementation(
        () =>
            new Promise((resolve) => {
                release = resolve;
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
        await new Promise((resolve) => setTimeout(resolve, 0));
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
    const results = spyOn(search, "searchAutoHint").mockImplementation(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    try {
        const wire = messages();
        const before = JSON.stringify(wire);
        const pending = runAutoSearchHint({ db, sessionId, messages: wire, options });
        await new Promise((resolve) => setTimeout(resolve, 0));
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
