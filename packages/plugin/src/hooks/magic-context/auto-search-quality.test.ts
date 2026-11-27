import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as embedding from "../../features/magic-context/memory/embedding";
import { getIndexableContent } from "../../features/magic-context/message-index";
import { runMigrations } from "../../features/magic-context/migrations";
import { unifiedSearch } from "../../features/magic-context/search";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { removeSystemReminders } from "../../shared/system-directive";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import * as hints from "./auto-search-hint";
import qualityCases from "./auto-search-quality.fixture.json";
import { _resetAutoSearchCache, runAutoSearchHint } from "./auto-search-runner";
import { autoSearchTestSnapshot } from "./auto-search-snapshot.fixture";
import * as workers from "./auto-search-worker-client";
import { searchAutoHint } from "./auto-search-worker-client";

const directories: string[] = [];
const databases: Database[] = [];
const { buildAutoSearchHint, selectAutoSearchResults } = hints;
let clock: ReturnType<typeof spyOn<typeof performance, "now">> | undefined;
afterEach(() => {
    _resetAutoSearchCache();
    clock?.mockRestore();
    clock = undefined;
    jest.useRealTimers();
    for (const db of databases.splice(0)) db.close();
    for (const directory of directories.splice(0)) cleanupTestTempDir(directory);
    _resetHarnessForTesting();
});

function useSearchClock() {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "performance"] });
    const started = Date.now();
    clock = spyOn(performance, "now").mockImplementation(() => Date.now() - started);
}

function expireVectorBudget(signal: AbortSignal | undefined) {
    expect(signal?.aborted).toBe(false);
    jest.advanceTimersByTime(199);
    expect(signal?.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(signal?.aborted).toBe(true);
}

function fixture() {
    const directory = createTestTempDirFromPath(join(tmpdir(), "auto-hint-quality-"));
    directories.push(directory);
    const db = new Database(join(directory, "context.db"));
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    const message = (ordinal: number, id: string, content: string) =>
        db
            .prepare(
                "INSERT INTO message_history_fts (session_id,message_ordinal,message_id,role,content) VALUES ('session',?,?, 'assistant',?)",
            )
            .run(ordinal, id, content);
    let sequence = 0;
    const compartment = (score: number, title: string) => {
        const current = sequence++;
        const id = Number(
            db
                .prepare(`INSERT INTO compartments (session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,created_at)
            VALUES ('session',?,?,?,'u1','a2',?,'stored','stored',1)`)
                .run(current, current * 2 + 1, current * 2 + 2, title).lastInsertRowid,
        );
        const vector = new Float32Array([score, Math.sqrt(1 - score * score)]);
        db.prepare(`INSERT INTO compartment_chunk_embeddings
            (compartment_id,session_id,project_path,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,harness,created_at)
            VALUES (?,'session','/synthetic',0,1,2,'hash','model',2,?,'opencode',1)`).run(
            id,
            new Uint8Array(vector.buffer),
        );
        return id;
    };
    return { db, message, compartment };
}
const options = {
    sources: ["message"] as "message"[],
    memoryEnabled: false,
    countRetrievals: false,
    measurementDisabled: true,
    chunkModelIdOverride: "model",
    embedQuery: async () => new Float32Array([1, 0]),
    isEmbeddingRuntimeEnabled: () => true,
};

for (const harness of ["opencode", "pi"] as const)
    test(`automatic hint worker excludes hosted reranking for ${harness} even with explicit options`, async () => {
        _resetHarnessForTesting();
        setHarness(harness);
        const f = fixture();
        f.message(1, "archived", "historian cache wiring budget explanation");
        f.message(2, "archived-two", "historian cache wiring budget reasoning");
        const query = "historian cache wiring budget";
        let calls = 0;
        const server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            async fetch(req) {
                calls++;
                const { documents } = (await req.json()) as { documents: string[] };
                return Response.json({
                    results: documents.map((_, index) => ({ index, relevance_score: index })),
                });
            },
        });
        const explicit = {
            sources: ["message" as const],
            embeddingEnabled: false,
            explicitSearch: true,
            countRetrievals: false,
            measurementDisabled: true,
            rerankConfig: {
                provider: "remote" as const,
                endpoint: String(server.url),
                model: "reranker",
                api_key: "FAKE_HINT_KEY_765",
                timeout_ms: 1500,
                top_n: 20,
            },
        };
        try {
            const direct = await unifiedSearch(f.db, "session", "/synthetic", query, explicit);
            expect(direct.length).toBeGreaterThan(0);
            expect(calls).toBe(1);
            calls = 0;
            const hinted = await searchAutoHint(f.db, "session", "/synthetic", query, explicit);
            expect(hinted.length).toBeGreaterThan(0);
            expect(calls).toBe(0);
        } finally {
            server.stop(true);
            workers.disposeIdleAutoSearchWorkers();
        }
    });

test("mixed-lane hint scores preserve weak cosine instead of promoting rank one", async () => {
    const f = fixture();
    f.message(4, "archived", "historian cache wiring is archived separately");
    f.compartment(0.4, "Unrelated deployment notes");
    const results = await searchAutoHint(
        f.db,
        "session",
        "/synthetic",
        "historian cache wiring",
        options,
    );
    const weak = results.find((result) => result.source === "compartment");
    expect(weak?.score).toBeCloseTo(0.32, 5);
    const selected = selectAutoSearchResults(results, 0.6);
    expect(selected.some((result) => result.source === "message")).toBe(true);
    expect(selected.some((result) => result.source === "compartment")).toBe(false);
});

test("hint retrieval excludes live tail and current message before merging", async () => {
    const f = fixture();
    f.message(1, "archived", "historian cache wiring answer");
    f.message(2, "current", "historian cache wiring current prompt with an old ordinal");
    f.message(3, "visible", "historian cache wiring already visible");
    const results = await searchAutoHint(f.db, "session", "/synthetic", "historian cache wiring", {
        ...options,
        embeddingEnabled: false,
        maxMessageOrdinal: 2,
        excludeMessageId: "current",
    });
    expect(
        results.map((result) => (result.source === "message" ? result.messageId : "other")),
    ).toEqual(["archived"]);
});

for (const harness of ["opencode", "opencode2"] as const) {
    test(`${harness} new hint passes archive cutoff and current message exclusion`, async () => {
        setHarness(harness);
        const f = fixture();
        const search = spyOn(workers, "searchAutoHint").mockResolvedValue([]);
        const backfill = spyOn(workers, "queueAutoSearchBackfill").mockResolvedValue();
        const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
            autoSearchTestSnapshot("/synthetic"),
        );
        const invoke = (id: string) =>
            runAutoSearchHint({
                db: f.db,
                sessionId: "session",
                messages: [
                    {
                        info: { id, role: "user" },
                        parts: [{ type: "text", text: "historian cache wiring" }],
                    },
                ],
                options: {
                    enabled: true,
                    projectPath: "/synthetic",
                    minPromptChars: 10,
                    scoreThreshold: 0.6,
                },
            });
        try {
            await invoke("first");
            expect(search.mock.calls[0][4].maxMessageOrdinal).toBe(0);
            expect(search.mock.calls[0][4].excludeMessageId).toBe("first");
            f.compartment(0.9, "History");
            f.db.prepare("UPDATE compartments SET harness = ?").run(harness);
            await invoke("next");
            expect(search.mock.calls[1][4].maxMessageOrdinal).toBe(2);
            expect(search.mock.calls[1][4].excludeMessageId).toBe("next");
        } finally {
            search.mockRestore();
            backfill.mockRestore();
            snapshot.mockRestore();
        }
    });
}

test("message hints show the matched passage rather than the first line", async () => {
    const f = fixture();
    f.message(
        1,
        "archived",
        `Unrelated introductory boilerplate. ${"padding ".repeat(120)}Historian cache wiring uses a scope-local incremental pool. ${"trailer ".repeat(100)}`,
    );
    const results = await unifiedSearch(f.db, "session", "/synthetic", "historian cache wiring", {
        ...options,
        embeddingEnabled: false,
    });
    const hint = buildAutoSearchHint(results, { query: "historian cache wiring" });
    expect(hint).toContain("Historian cache wiring");
    expect(hint).not.toContain("introductory");
});

test("nested reminders are removed completely at indexing", () => {
    const nested =
        "<system-reminder>outer <system-reminder>inner</system-reminder> leaked tail</system-reminder>";
    expect(removeSystemReminders(`before ${nested} after`)).toBe("before  after");
    for (const role of ["user", "assistant"]) {
        expect(getIndexableContent(role, [{ type: "text", text: nested }])).toBe("");
        expect(getIndexableContent(role, [{ type: "text", text: `Actual answer ${nested}` }])).toBe(
            "Actual answer",
        );
    }
});

test("task notifications are removed at indexing and rendering", () => {
    const noise =
        '<task_cohort id="cohort"><task id="child"><summary>Background task finished</summary></task></task_cohort>';
    for (const role of ["user", "assistant"]) {
        expect(getIndexableContent(role, [{ type: "text", text: noise }])).toBe("");
        expect(getIndexableContent(role, [{ type: "text", text: `Actual answer ${noise}` }])).toBe(
            "Actual answer",
        );
    }
    expect(
        buildAutoSearchHint(
            [
                {
                    source: "message",
                    messageOrdinal: 1,
                    messageId: "legacy",
                    role: "assistant",
                    score: 1,
                    content: noise,
                },
            ],
            { query: "background task" },
        ),
    ).toBeNull();
    expect(
        buildAutoSearchHint(
            [
                {
                    source: "compartment",
                    compartmentId: 1,
                    sessionId: "session",
                    title: "Historian cache wiring",
                    startOrdinal: 1,
                    endOrdinal: 2,
                    matchType: "hybrid",
                    snippet: noise,
                    score: 0.8,
                    content: "ignored",
                },
            ],
            { query: "historian cache" },
        ),
    ).toContain("Historian cache wiring");
});

test("late vectors fall back to keyword results without discarding the hint", async () => {
    const f = fixture();
    f.message(1, "archived", "historian cache wiring answer");
    useSearchClock();
    const embeddingEntered = Promise.withResolvers<AbortSignal | undefined>();
    const search = searchAutoHint(f.db, "session", "/synthetic", "historian cache wiring", {
        ...options,
        embedQuery: async (_text, signal) =>
            new Promise((resolve) => {
                signal?.addEventListener("abort", () => resolve(null), { once: true });
                embeddingEntered.resolve(signal);
            }),
    });
    const signal = await Promise.race([embeddingEntered.promise, search.then(() => undefined)]);
    expireVectorBudget(signal);
    const results = await search;
    expect(selectAutoSearchResults(results, 0.6).map((result) => result.source)).toEqual([
        "message",
    ]);
});

test("warm hints reuse the worker and observe appended vectors without rebuilding the scope", async () => {
    const f = fixture();
    const id = f.compartment(0.91, "Historian cache wiring");
    const before = workers.getAutoSearchWorkerStats();
    const first = await searchAutoHint(
        f.db,
        "session",
        "/synthetic",
        "historian cache wiring",
        options,
    );
    const afterFirst = workers.getAutoSearchWorkerStats();
    expect(afterFirst.created - before.created).toBe(1);
    const vector = new Float32Array([1, 0]);
    f.db
        .prepare(`INSERT INTO compartment_chunk_embeddings
        (compartment_id,session_id,project_path,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,harness,created_at)
        VALUES (?,'session','/synthetic',1,1,2,'new-window','model',2,?,'opencode',1)`)
        .run(id, new Uint8Array(vector.buffer));
    const second = await searchAutoHint(
        f.db,
        "session",
        "/synthetic",
        "historian cache wiring",
        options,
    );
    const afterSecond = workers.getAutoSearchWorkerStats();
    expect(afterSecond.created).toBe(afterFirst.created);
    expect(afterSecond.reused - afterFirst.reused).toBe(1);
    expect(first[0].score).toBeCloseTo(0.728, 5);
    expect(second[0].score).toBeCloseTo(0.8, 5);
});

test("labeled synthetic hint calibration separates useful passages from reported noise classes", async () => {
    for (const entry of qualityCases) {
        const f = fixture();
        let wanted: number | string;
        if (entry.cosine !== undefined && entry.title) {
            wanted = f.compartment(entry.cosine, entry.title);
            f.message(4, "anchor", "historian cache wiring archived evidence");
        } else {
            wanted = "candidate";
            f.message(1, wanted, entry.text ?? "");
        }
        const results = await searchAutoHint(
            f.db,
            "session",
            "/synthetic",
            "historian cache wiring",
            options,
        );
        const selected = selectAutoSearchResults(results, 0.6);
        expect(
            selected.some((result) =>
                result.source === "compartment"
                    ? result.compartmentId === wanted
                    : result.source === "message" && result.messageId === wanted,
            ),
            entry.label,
        ).toBe(entry.accepted);
    }
});

// Wall-clock latency on shared CI runners is too noisy for a hard bound; the 300 ms p95
// target is measured by scripts/auto-search-benchmark.ts. This test pins the mechanism the
// target depends on: a query embedding that never answers is abandoned at the vector budget,
// and the hint is still served from keyword search instead of waiting for the turn deadline.
test("a query embedding that never answers is abandoned at the vector budget and the hint is still served", async () => {
    const f = fixture();
    f.db
        .transaction(() => {
            for (let i = 0; i < 2200; i++) f.compartment(0.91, `Historian cache wiring ${i}`);
        })
        .immediate();
    f.message(1, "archived", "historian cache wiring uses an incremental pool");
    await searchAutoHint(f.db, "session", "/synthetic", "historian cache wiring", {
        ...options,
        embeddingEnabled: false,
    });
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
        autoSearchTestSnapshot("/synthetic"),
    );
    const backfill = spyOn(workers, "queueAutoSearchBackfill").mockResolvedValue();
    let calls = 0;
    let embeddingEntered = Promise.withResolvers<AbortSignal | undefined>();
    const embed = spyOn(embedding, "embedTextForProject").mockImplementation(
        async (_project, _text, signal) =>
            new Promise((resolve) => {
                calls += 1;
                // Only an abort can release this call, so a served hint proves the
                // search stopped waiting for it.
                signal?.addEventListener("abort", () => resolve(null), { once: true });
                embeddingEntered.resolve(signal);
            }),
    );
    try {
        useSearchClock();
        for (let index = 0; index < 5; index++) {
            embeddingEntered = Promise.withResolvers<AbortSignal | undefined>();
            const messages = [
                {
                    info: { id: `warm-${index}`, role: "user" },
                    parts: [{ type: "text", text: "historian cache wiring" }],
                },
            ];
            const search = runAutoSearchHint({
                db: f.db,
                sessionId: "session",
                messages,
                options: {
                    enabled: true,
                    projectPath: "/synthetic",
                    scoreThreshold: 0.6,
                    minPromptChars: 10,
                },
            });
            const signal = await Promise.race([
                embeddingEntered.promise,
                search.then(() => undefined),
            ]);
            expireVectorBudget(signal);
            await search;
            expect(messages[0].parts[0].text).toContain("<ctx-search-hint>");
        }
        expect(calls).toBe(5);
    } finally {
        embed.mockRestore();
        backfill.mockRestore();
        snapshot.mockRestore();
    }
}, 15000);
