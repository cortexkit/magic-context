import { describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as formatting from "../../hooks/magic-context/read-session-formatting";
import { estimateTokens, formatBlock } from "../../hooks/magic-context/read-session-formatting";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    _resetCompartmentChunkCoverageMemoForTests,
    _resetCompartmentChunkSearchCacheForTests,
    buildCanonicalChunkTextFromFts,
    CHUNK_WINDOW_SAFETY_RATIO,
    canonicalizeInMemoryChunkTextForEmbedding,
    chunkCanonicalText,
    chunkEmbeddingWindowsAreCurrent,
    chunkWindowSourceKey,
    countSessionCompartmentEmbedCoverage,
    countSessionCompartmentEmbedCoveragePolite,
    countUnembeddedSessionCompartments,
    countUnembeddedSessionCompartmentsPolite,
    loadCompartmentChunkEmbeddingsForSearch,
    loadUnembeddedCompartmentChunkCandidates,
    loadUnembeddedSessionChunkCandidates,
    loadUnembeddedSessionChunkCandidatesPolite,
    MESSAGE_FTS_CHUNK_LOAD_SQL,
    recordChunkEmbedBackoff,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import { embedAndStoreCompartmentChunks } from "./compartment-embedding";
import { appendCompartments, getCompartments } from "./compartment-storage";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
import { backfillMessageFtsRowidMapBatch, recordMessageFtsRowid } from "./message-fts-rowid-map";
import { runMigrations } from "./migrations";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    embedSessionCompartmentChunks,
    getProjectEmbeddingSnapshot,
    registerProjectEmbedding,
} from "./project-embedding-registry";
import { recordSessionProjectIdentity } from "./session-project-storage";
import { initializeDatabase } from "./storage-db";
import { clearSession } from "./storage-meta-session";

class CapturingEmbeddingProvider implements EmbeddingProvider {
    readonly modelId = "mock:model";
    readonly maxInputTokens = 10_000;
    readonly texts: string[];

    constructor(texts: string[]) {
        this.texts = texts;
    }

    async initialize(): Promise<boolean> {
        return true;
    }

    async embed(
        text: string,
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array> {
        this.texts.push(text);
        return new Float32Array([1, 0]);
    }

    async embedBatch(
        texts: string[],
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array[]> {
        this.texts.push(...texts);
        return texts.map(() => new Float32Array([1, 0]));
    }

    async dispose(): Promise<void> {}

    isLoaded(): boolean {
        return true;
    }
}

function createDb(filename = ":memory:"): Database {
    const db = new Database(filename);
    initializeDatabase(db);
    runMigrations(db);
    backfillMessageFtsRowidMapBatch(db);
    return db;
}

function insertFtsRow(
    db: Database,
    sessionId: string,
    ordinal: number,
    role: "user" | "assistant",
    content: string,
): void {
    const result = db
        .prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
        )
        .run(sessionId, ordinal, `${role}-${ordinal}`, role, content) as {
        lastInsertRowid: number | bigint;
    };
    recordMessageFtsRowid(db, sessionId, ordinal, result.lastInsertRowid);
}

function currentChunkModelId(projectIdentity: string): string {
    return getProjectEmbeddingSnapshot(projectIdentity)?.chunkModelId ?? "off";
}

describe("compartment chunk embedding core", () => {
    test("FTS reconstruction and in-memory stripping produce the same canonical bytes", () => {
        const db = createDb();
        try {
            insertFtsRow(db, "ses-canon", 1, "user", "How should semantic search work?");
            insertFtsRow(db, "ses-canon", 2, "user", "Keep adjacent user lines grouped.");
            insertFtsRow(db, "ses-canon", 3, "assistant", "Embed raw compartment chunks.");

            const fromFts = buildCanonicalChunkTextFromFts(db, "ses-canon", 1, 4);
            const fromMemory = canonicalizeInMemoryChunkTextForEmbedding(
                [
                    "[1-2] U: How should semantic search work? / Keep adjacent user lines grouped.",
                    "[3-4] A: Embed raw compartment chunks. / TC: read(packages/plugin/src/features/magic-context/search.ts)",
                ].join("\n"),
                1,
                4,
            );

            expect(fromFts).toBe(fromMemory);
            expect(fromFts).toBe(
                "[1-2] U: How should semantic search work? / Keep adjacent user lines grouped.\n[3] A: Embed raw compartment chunks.",
            );

            const clippedFromFts = buildCanonicalChunkTextFromFts(db, "ses-canon", 2, 3);
            const clippedFromMemory = canonicalizeInMemoryChunkTextForEmbedding(
                [
                    "[1-2] U: How should semantic search work? / Keep adjacent user lines grouped.",
                    "[3-4] A: Embed raw compartment chunks. / TC: read(packages/plugin/src/features/magic-context/search.ts)",
                ].join("\n"),
                2,
                3,
            );
            expect(clippedFromMemory).toBe(clippedFromFts);
            expect(clippedFromFts).toBe(
                "[2] U: Keep adjacent user lines grouped.\n[3] A: Embed raw compartment chunks.",
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("chunker uses one whole-compartment row when it fits and windows on line boundaries otherwise", () => {
        const text = [
            "[1] U: alpha beta gamma",
            "[2] A: delta epsilon zeta",
            "[3] U: eta theta iota",
        ].join("\n");

        const whole = chunkCanonicalText(text, 1, 3, 10_000);
        expect(whole).toHaveLength(1);
        expect(whole[0]).toMatchObject({ windowIndex: 0, startOrdinal: 1, endOrdinal: 3 });
        expect(whole[0]?.text).toBe(text);

        // Budget that fits any single line but not two together → one window per
        // line on line boundaries. effectiveMax = floor(budget * 0.9); each line is
        // ~7 tokens, so a budget of ~9 (effective 8) holds exactly one line.
        const perLineBudget = Math.ceil(
            (estimateTokens("[1] U: alpha beta gamma") + 1) / CHUNK_WINDOW_SAFETY_RATIO,
        );
        const windowed = chunkCanonicalText(text, 1, 3, perLineBudget);
        expect(windowed.map((window) => window.windowIndex)).toEqual([0, 1, 2]);
        expect(windowed.map((window) => [window.startOrdinal, window.endOrdinal])).toEqual([
            [1, 1],
            [2, 2],
            [3, 3],
        ]);
    });

    test("chunker rejects canonical line ranges outside the compartment", () => {
        expect(() => chunkCanonicalText("[1-5] A: foreign text", 2, 4, 10_000)).toThrow(
            "Canonical chunk range 1-5 lies outside compartment 2-4",
        );
    });

    test("every window stays under the safety-margined budget (never exceeds the provider ceiling)", () => {
        // Many short lines so windowing is driven by the token budget, not by
        // line count. With a ceiling of 200, the effective budget is 180 (90%),
        // leaving headroom for cross-tokenizer drift below the hard ceiling.
        const maxInputTokens = 200;
        const effective = Math.floor(maxInputTokens * CHUNK_WINDOW_SAFETY_RATIO);
        const lines = Array.from(
            { length: 60 },
            (_, i) => `[${i + 1}] U: lorem ipsum dolor sit amet consectetur adipiscing elit ${i}`,
        );
        const windows = chunkCanonicalText(lines.join("\n"), 1, 60, maxInputTokens);
        expect(windows.length).toBeGreaterThan(1);
        for (const window of windows) {
            // Each window's own estimate stays at/under the 90% budget, so the
            // real provider count (which drifts only slightly) stays under the
            // configured ceiling.
            expect(estimateTokens(window.text)).toBeLessThanOrEqual(effective);
        }
    });

    test("splits a single oversized canonical line so no window exceeds the budget (#206)", () => {
        // One canonical line (a single A: span) far larger than the budget — e.g.
        // a big file dump rendered into one message. The old chunker emitted this
        // whole, producing one window that blew past the provider's context window.
        const maxInputTokens = 200;
        const effective = Math.floor(maxInputTokens * CHUNK_WINDOW_SAFETY_RATIO);
        const huge = Array.from(
            { length: 4000 },
            (_, i) => `word${i} alpha beta gamma delta epsilon`,
        ).join(" ");
        const line = `[1] A: ${huge}`;
        expect(estimateTokens(line)).toBeGreaterThan(effective * 10); // genuinely oversized

        const windows = chunkCanonicalText(line, 1, 1, maxInputTokens);

        expect(windows.length).toBeGreaterThan(1);
        // The invariant that #206 violated: NO window may exceed the budget.
        for (const window of windows) {
            expect(estimateTokens(window.text)).toBeLessThanOrEqual(effective);
        }
        // Sub-windows all carry the owning line's ordinal range.
        for (const window of windows) {
            expect(window.startOrdinal).toBe(1);
            expect(window.endOrdinal).toBe(1);
        }
        // windowIndex stays zero-based and contiguous.
        expect(windows.map((w) => w.windowIndex)).toEqual(windows.map((_, i) => i));
    });

    test("mixes split sub-windows with normal line windows without index gaps", () => {
        const maxInputTokens = 200;
        const effective = Math.floor(maxInputTokens * CHUNK_WINDOW_SAFETY_RATIO);
        const huge = Array.from({ length: 2000 }, (_, i) => `tok${i}`).join(" ");
        const text = ["[1] U: short opener", `[2] A: ${huge}`, "[3] U: short closer"].join("\n");

        const windows = chunkCanonicalText(text, 1, 3, maxInputTokens);

        expect(windows.length).toBeGreaterThan(2);
        for (const window of windows) {
            expect(estimateTokens(window.text)).toBeLessThanOrEqual(effective);
        }
        expect(windows.map((w) => w.windowIndex)).toEqual(windows.map((_, i) => i));
    });

    test("storage replaces chunks idempotently and clearSession removes rows", async () => {
        const db = createDb();
        try {
            appendCompartments(db, "ses-store", [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "u1",
                    endMessageId: "a2",
                    title: "Chunk storage",
                    content: "P1 content",
                    p1: "P1 content",
                },
            ]);
            const compartment = getCompartments(db, "ses-store")[0];
            expect(compartment).toBeDefined();
            const windows = chunkCanonicalText("[1] U: hello\n[2] A: world", 1, 2, 10_000);
            replaceCompartmentChunkEmbeddings(
                db,
                windows.map((window) => ({
                    compartmentId: compartment.id,
                    sessionId: "ses-store",
                    projectPath: "/repo/store",
                    window,
                    modelId: "mock:model",
                    vector: new Float32Array([1, 0]),
                })),
            );

            expect(chunkEmbeddingWindowsAreCurrent(db, compartment.id, "mock:model", windows)).toBe(
                true,
            );
            expect(
                await loadCompartmentChunkEmbeddingsForSearch(
                    db,
                    "ses-store",
                    "/repo/store",
                    "mock:model",
                ),
            ).toHaveLength(1);

            clearSession(db, "ses-store");
            expect(
                await loadCompartmentChunkEmbeddingsForSearch(
                    db,
                    "ses-store",
                    "/repo/store",
                    "mock:model",
                ),
            ).toHaveLength(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("search pool reflects compartment ranges rewritten after the pool was cached", async () => {
        const db = createDb();
        try {
            appendCompartments(db, "ses-rebased", [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "u1",
                    endMessageId: "a2",
                    title: "Rebased range",
                    content: "P1 content",
                    p1: "P1 content",
                },
            ]);
            const compartment = getCompartments(db, "ses-rebased")[0];
            replaceCompartmentChunkEmbeddings(
                db,
                chunkCanonicalText("[1] U: hello\n[2] A: world", 1, 2, 10_000).map((window) => ({
                    compartmentId: compartment.id,
                    sessionId: "ses-rebased",
                    projectPath: "/repo/rebased",
                    window,
                    modelId: "mock:model",
                    vector: new Float32Array([1, 0]),
                })),
            );
            const ranges = async () =>
                (
                    await loadCompartmentChunkEmbeddingsForSearch(
                        db,
                        "ses-rebased",
                        "/repo/rebased",
                        "mock:model",
                    )
                ).map((row) => [row.startOrdinal, row.endOrdinal]);
            expect(await ranges()).toEqual([[1, 2]]);

            // A coordinate rebase rewrites compartment ranges in place and leaves
            // the embedding rows untouched.
            db.prepare(
                "UPDATE compartments SET start_message = 5, end_message = 6 WHERE id = ?",
            ).run(compartment.id);

            expect(await ranges()).toEqual([[5, 6]]);
        } finally {
            closeQuietly(db);
        }
    });

    test("coverage stays read-only before the drain renumbers matching one-based rows", async () => {
        const tempDirectory = createTestTempDirFromPath(join(tmpdir(), "chunk-window-renumber-"));
        const databasePath = join(tempDirectory, "store.db");
        const db = createDb(databasePath);
        const embeddedTexts: string[] = [];
        const sessionId = "ses-shifted-window";
        const projectPath = "/repo/shifted-window";
        let observer: Database | null = null;
        try {
            _setTestProviderFactoryForProject(() => new CapturingEmbeddingProvider(embeddedTexts));
            registerProjectEmbedding(
                db,
                projectPath,
                { provider: "local", model: "mock-local", max_input_tokens: 64 },
                { memoryEnabled: true, gitCommitEnabled: false },
                projectPath,
            );
            recordSessionProjectIdentity(db, sessionId, projectPath);
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "a1",
                    endMessageId: "a1",
                    title: "Legacy shifted keys",
                    content: "shifted",
                    p1: "shifted",
                },
            ]);
            insertFtsRow(
                db,
                sessionId,
                1,
                "assistant",
                Array.from({ length: 320 }, (_, index) => `legacy-token-${index}`).join(" "),
            );
            const [compartment] = getCompartments(db, sessionId);
            const modelId = currentChunkModelId(projectPath);
            const expectedWindows = chunkCanonicalText(
                buildCanonicalChunkTextFromFts(db, sessionId, 1, 1) ?? "",
                1,
                1,
                64,
            );
            expect(expectedWindows.length).toBeGreaterThan(1);
            replaceCompartmentChunkEmbeddings(
                db,
                expectedWindows.map((window) => ({
                    compartmentId: compartment.id,
                    sessionId,
                    projectPath,
                    window: { ...window, windowIndex: window.windowIndex + 1 },
                    modelId,
                    vector: new Float32Array([1, 0]),
                })),
            );

            observer = new Database(databasePath);
            const beforeDataVersion = (
                observer.prepare("PRAGMA data_version").get() as { data_version: number }
            ).data_version;
            expect(
                countSessionCompartmentEmbedCoverage(db, projectPath, sessionId, modelId, 64),
            ).toEqual({ embedded: 1, total: 1 });
            const afterDataVersion = (
                observer.prepare("PRAGMA data_version").get() as { data_version: number }
            ).data_version;
            expect(afterDataVersion).toBe(beforeDataVersion);

            expect(await embedSessionCompartmentChunks(db, projectPath, sessionId)).toEqual({
                status: "nothing",
                embedded: 0,
                total: 0,
            });
            expect(embeddedTexts).toEqual([]);
            const stored = await loadCompartmentChunkEmbeddingsForSearch(
                db,
                sessionId,
                projectPath,
                modelId,
            );
            expect(stored.map((row) => row.windowIndex)).toEqual(
                expectedWindows.map((window) => window.windowIndex),
            );
            expect(stored.map((row) => row.chunkHash)).toEqual(
                expectedWindows.map((window) => window.chunkHash),
            );
            expect(stored.map((row) => [row.windowStartOrdinal, row.windowEndOrdinal])).toEqual(
                expectedWindows.map((window) => [window.startOrdinal, window.endOrdinal]),
            );
        } finally {
            _resetProjectEmbeddingRegistryForTests();
            if (observer) closeQuietly(observer);
            closeQuietly(db);
            rmSync(tempDirectory, { recursive: true, force: true });
        }
    });

    test("classification keeps a hash-mismatched one-based window set stale", async () => {
        const db = createDb();
        const sessionId = "ses-shifted-stale";
        const projectPath = "/repo/shifted-stale";
        const modelId = "mock:shifted-stale";
        try {
            recordSessionProjectIdentity(db, sessionId, projectPath);
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "a1",
                    endMessageId: "a1",
                    title: "Stale shifted keys",
                    content: "stale",
                    p1: "stale",
                },
            ]);
            insertFtsRow(
                db,
                sessionId,
                1,
                "assistant",
                Array.from({ length: 320 }, (_, index) => `stale-token-${index}`).join(" "),
            );
            const [compartment] = getCompartments(db, sessionId);
            const expectedWindows = chunkCanonicalText(
                buildCanonicalChunkTextFromFts(db, sessionId, 1, 1) ?? "",
                1,
                1,
                64,
            );
            expect(expectedWindows.length).toBeGreaterThan(1);
            replaceCompartmentChunkEmbeddings(
                db,
                expectedWindows.map((window, index) => ({
                    compartmentId: compartment.id,
                    sessionId,
                    projectPath,
                    window: {
                        ...window,
                        windowIndex: window.windowIndex + 1,
                        chunkHash: index === 0 ? `stale-${window.chunkHash}` : window.chunkHash,
                    },
                    modelId,
                    vector: new Float32Array([1, 0]),
                })),
            );

            expect(
                loadUnembeddedSessionChunkCandidates(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    1,
                    undefined,
                    64,
                ).map((candidate) => candidate.id),
            ).toEqual([compartment.id]);
            expect(
                (
                    await loadCompartmentChunkEmbeddingsForSearch(
                        db,
                        sessionId,
                        projectPath,
                        modelId,
                    )
                ).map((row) => row.windowIndex),
            ).toEqual(expectedWindows.map((window) => window.windowIndex + 1));
        } finally {
            closeQuietly(db);
        }
    });

    test("reuses decoded search vectors until the pool probe changes", async () => {
        const db = createDb();
        try {
            appendCompartments(db, "ses-cache", [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "u1",
                    endMessageId: "a2",
                    title: "Cached chunks",
                    content: "P1 content",
                    p1: "P1 content",
                },
            ]);
            const compartment = getCompartments(db, "ses-cache")[0];
            const [window] = chunkCanonicalText("[1] U: hello\n[2] A: world", 1, 2, 10_000);
            const writeVector = (vector: Float32Array) =>
                replaceCompartmentChunkEmbeddings(db, [
                    {
                        compartmentId: compartment.id,
                        sessionId: "ses-cache",
                        projectPath: "/repo/cache",
                        window,
                        modelId: "mock:model",
                        vector,
                    },
                ]);

            writeVector(new Float32Array([1, 0]));
            const first = await loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-cache",
                "/repo/cache",
                "mock:model",
            );
            const cached = await loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-cache",
                "/repo/cache",
                "mock:model",
            );
            expect(cached).toBe(first);

            // Replacement preserves the row count but advances the maximum id,
            // so the cheap probe must invalidate the decoded pool.
            writeVector(new Float32Array([0, 1]));
            const replaced = await loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-cache",
                "/repo/cache",
                "mock:model",
            );
            expect(replaced).not.toBe(first);
            expect([...replaced[0].vector]).toEqual([0, 1]);
        } finally {
            _resetCompartmentChunkSearchCacheForTests();
            closeQuietly(db);
        }
    });

    test("publish helper embeds chunks with TC lines stripped", async () => {
        const db = createDb();
        const embeddedTexts: string[] = [];
        try {
            _setTestProviderFactoryForProject(() => new CapturingEmbeddingProvider(embeddedTexts));
            registerProjectEmbedding(
                db,
                "/repo/publish",
                { provider: "local", model: "mock-local" },
                { memoryEnabled: true, gitCommitEnabled: false },
                "/repo/publish",
            );
            appendCompartments(db, "ses-publish", [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "u1",
                    endMessageId: "a2",
                    title: "Publish chunks",
                    content: "P1 content",
                    p1: "P1 content",
                },
            ]);
            const compartment = getCompartments(db, "ses-publish")[0];

            await embedAndStoreCompartmentChunks(db, "ses-publish", "/repo/publish", [
                {
                    id: compartment.id,
                    startMessage: 1,
                    endMessage: 2,
                    sourceChunkText: "[1] U: Keep this line\n[2] A: TC: bash(Run tests)",
                },
            ]);

            expect(embeddedTexts).toEqual(["[1] U: Keep this line"]);
            expect(
                await loadCompartmentChunkEmbeddingsForSearch(
                    db,
                    "ses-publish",
                    "/repo/publish",
                    currentChunkModelId("/repo/publish"),
                ),
            ).toHaveLength(1);
        } finally {
            _resetProjectEmbeddingRegistryForTests();
            closeQuietly(db);
        }
    });

    test("publish helper isolates five compartments from one unattributable runner block", async () => {
        const db = createDb();
        const embeddedTexts: string[] = [];
        const sessionId = "ses-publish-five";
        const projectPath = "/repo/publish-five";
        const ranges = [
            [35408, 35460],
            [35461, 35510],
            [35511, 35610],
            [35611, 35670],
            [35671, 35700],
        ] as const;
        try {
            _setTestProviderFactoryForProject(() => new CapturingEmbeddingProvider(embeddedTexts));
            registerProjectEmbedding(
                db,
                projectPath,
                { provider: "local", model: "mock-local", max_input_tokens: 64 },
                { memoryEnabled: true, gitCommitEnabled: false },
                projectPath,
            );
            appendCompartments(
                db,
                sessionId,
                ranges.map(([startMessage, endMessage], sequence) => ({
                    sequence,
                    startMessage,
                    endMessage,
                    startMessageId: `a${startMessage}`,
                    endMessageId: `a${endMessage}`,
                    title: `Published compartment ${sequence}`,
                    content: `Compartment ${sequence} content`,
                    p1: `Compartment ${sequence} content`,
                })),
            );
            for (const [sequence, [startMessage, endMessage]] of ranges.entries()) {
                for (let ordinal = startMessage; ordinal <= endMessage; ordinal++) {
                    insertFtsRow(
                        db,
                        sessionId,
                        ordinal,
                        "assistant",
                        `compartment-${sequence} ordinal-${ordinal}`,
                    );
                }
            }

            const historianBody = Array.from(
                { length: 320 },
                (_, index) => `merged-assistant-token-${index}`,
            ).join(" ");
            const sourceChunkText = formatBlock({
                role: "A",
                startOrdinal: 35409,
                endOrdinal: 35710,
                parts: [historianBody],
                meta: [],
                commitHashes: [],
                isToolOnly: false,
            });
            expect(sourceChunkText).toBe(`[35409-35710] A: ${historianBody}`);

            const compartments = getCompartments(db, sessionId);
            await embedAndStoreCompartmentChunks(
                db,
                sessionId,
                projectPath,
                compartments.map((compartment) => ({
                    id: compartment.id,
                    startMessage: compartment.startMessage,
                    endMessage: compartment.endMessage,
                    sourceChunkText,
                })),
            );

            const stored = await loadCompartmentChunkEmbeddingsForSearch(
                db,
                sessionId,
                projectPath,
                currentChunkModelId(projectPath),
            );
            const rowsByCompartment = compartments.map((compartment) =>
                stored.filter((row) => row.compartmentId === compartment.id),
            );
            expect(rowsByCompartment.every((rows) => rows.length > 0)).toBe(true);
            expect(
                new Set(rowsByCompartment.map((rows) => rows.map((row) => row.chunkHash).join(",")))
                    .size,
            ).toBe(ranges.length);

            for (const [index, rows] of rowsByCompartment.entries()) {
                const [startMessage, endMessage] = ranges[index];
                expect(rows.map((row) => row.windowIndex)).toEqual(
                    rows.map((_, windowIndex) => windowIndex),
                );
                for (const row of rows) {
                    expect(row.windowStartOrdinal).toBeGreaterThanOrEqual(startMessage);
                    expect(row.windowEndOrdinal).toBeLessThanOrEqual(endMessage);
                }
            }
        } finally {
            _resetProjectEmbeddingRegistryForTests();
            closeQuietly(db);
        }
    });

    test("empty raw span falls back to embedding the compartment summary (title + p1)", async () => {
        const db = createDb();
        const embeddedTexts: string[] = [];
        try {
            _setTestProviderFactoryForProject(() => new CapturingEmbeddingProvider(embeddedTexts));
            registerProjectEmbedding(
                db,
                "/repo/fallback",
                { provider: "local", model: "mock-local" },
                { memoryEnabled: true, gitCommitEnabled: false },
                "/repo/fallback",
            );
            // A thin notification/tool-only compartment: no FTS rows for its span,
            // and the in-memory source strips to empty (system-reminder + TC line).
            appendCompartments(db, "ses-fallback", [
                {
                    sequence: 0,
                    startMessage: 5,
                    endMessage: 6,
                    startMessageId: "u5",
                    endMessageId: "a6",
                    title: "Executed background oracle audit for oxc engine",
                    content: "Ran the background oracle audit to verify the oxc cutover.",
                    p1: "Ran the background oracle audit to verify the oxc cutover.",
                },
            ]);
            const compartment = getCompartments(db, "ses-fallback")[0];

            await embedAndStoreCompartmentChunks(db, "ses-fallback", "/repo/fallback", [
                {
                    id: compartment.id,
                    startMessage: 5,
                    endMessage: 6,
                    // Both lines strip away: no [ord] U:/A: meaningful text survives.
                    sourceChunkText: "[5] A: TC: task(Audit oxc engine)",
                },
            ]);

            // Embedded the summary (title + p1), not the empty raw span.
            expect(embeddedTexts).toEqual([
                "Executed background oracle audit for oxc engine\nRan the background oracle audit to verify the oxc cutover.",
            ]);
            expect(
                await loadCompartmentChunkEmbeddingsForSearch(
                    db,
                    "ses-fallback",
                    "/repo/fallback",
                    currentChunkModelId("/repo/fallback"),
                ),
            ).toHaveLength(1);
        } finally {
            _resetProjectEmbeddingRegistryForTests();
            closeQuietly(db);
        }
    });

    test("hash-complete drain cannot report vacuous coverage for missing-window or stale-hash rows", () => {
        const db = createDb();
        const projectPath = "/repo/hash-complete";
        const sessionId = "ses-hash-complete";
        const modelId = "mock:hash-complete";
        const maxInputTokens = 9;
        try {
            recordSessionProjectIdentity(db, sessionId, projectPath);
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "u1",
                    endMessageId: "a2",
                    title: "Missing one expected window",
                    content: "missing",
                    p1: "missing",
                },
                {
                    sequence: 1,
                    startMessage: 3,
                    endMessage: 3,
                    startMessageId: "u3",
                    endMessageId: "u3",
                    title: "Clean current row",
                    content: "clean",
                    p1: "clean",
                },
                {
                    sequence: 2,
                    startMessage: 4,
                    endMessage: 4,
                    startMessageId: "u4",
                    endMessageId: "u4",
                    title: "Stale hash row",
                    content: "stale",
                    p1: "stale",
                },
            ]);
            insertFtsRow(db, sessionId, 1, "user", "alpha beta gamma");
            insertFtsRow(db, sessionId, 2, "assistant", "delta epsilon zeta");
            insertFtsRow(db, sessionId, 3, "user", "clean");
            insertFtsRow(db, sessionId, 4, "user", "stale");

            const [missing, clean, stale] = getCompartments(db, sessionId);
            const expectedWindows = (compartment: typeof missing) =>
                chunkCanonicalText(
                    buildCanonicalChunkTextFromFts(
                        db,
                        sessionId,
                        compartment.startMessage,
                        compartment.endMessage,
                    ) ?? "",
                    compartment.startMessage,
                    compartment.endMessage,
                    maxInputTokens,
                );
            const write = (
                compartment: typeof missing,
                windows: ReturnType<typeof chunkCanonicalText>,
            ) =>
                replaceCompartmentChunkEmbeddings(
                    db,
                    windows.map((window) => ({
                        compartmentId: compartment.id,
                        sessionId,
                        projectPath,
                        window,
                        modelId,
                        vector: new Float32Array([1, 0]),
                    })),
                );

            const missingWindows = expectedWindows(missing);
            const cleanWindows = expectedWindows(clean);
            const staleWindows = expectedWindows(stale);
            expect(missingWindows.length).toBeGreaterThan(1);
            write(missing, missingWindows.slice(0, 1));
            write(clean, cleanWindows);
            write(
                stale,
                staleWindows.map((window) => ({
                    ...window,
                    chunkHash: `stale-${window.chunkHash}`,
                })),
            );

            // Although the stale row sorts first, a result limited to one item
            // must select the missing window instead of the stale replacement.
            expect(
                loadUnembeddedCompartmentChunkCandidates(
                    db,
                    projectPath,
                    modelId,
                    1,
                    maxInputTokens,
                ).map((candidate) => candidate.id),
            ).toEqual([missing.id]);
            expect(
                loadUnembeddedSessionChunkCandidates(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    3,
                    undefined,
                    maxInputTokens,
                ).map((candidate) => candidate.id),
            ).toEqual([missing.id, stale.id]);
            expect(
                countUnembeddedSessionCompartments(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    maxInputTokens,
                ),
            ).toBe(2);
            expect(
                countSessionCompartmentEmbedCoverage(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    maxInputTokens,
                ),
            ).toEqual({ embedded: 1, total: 3 });

            // Test each condition independently: repairing the missing windows
            // must leave the stale hash outstanding, and repairing the stale hash
            // must leave the missing window outstanding. Checking only whether a
            // model row exists would fail both assertions.
            write(missing, missingWindows);
            expect(
                countUnembeddedSessionCompartments(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    maxInputTokens,
                ),
            ).toBe(1);
            write(missing, missingWindows.slice(0, 1));
            write(stale, staleWindows);
            expect(
                countUnembeddedSessionCompartments(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    maxInputTokens,
                ),
            ).toBe(1);

            write(missing, missingWindows);
            expect(
                countUnembeddedSessionCompartments(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    maxInputTokens,
                ),
            ).toBe(0);
            expect(
                countSessionCompartmentEmbedCoverage(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    maxInputTokens,
                ),
            ).toEqual({ embedded: 3, total: 3 });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("issue 564 coverage catch-up", () => {
    test("coverage reuses canonical FTS text only while its range and database revision are unchanged", async () => {
        const db = createDb();
        const session = "ses-source-memo";
        const project = "git:source-memo";
        const model = "mock:source-memo";
        const prepare = spyOn(db, "prepare");
        try {
            recordSessionProjectIdentity(db, session, project);
            appendCompartments(db, session, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "u1",
                    endMessageId: "u1",
                    title: "Memo",
                    content: "Memo",
                    p1: "Memo",
                },
            ]);
            insertFtsRow(db, session, 1, "user", "Original transcript");
            const compartmentId = getCompartments(db, session)[0].id;
            const text = buildCanonicalChunkTextFromFts(db, session, 1, 1)!;
            replaceCompartmentChunkEmbeddings(
                db,
                chunkCanonicalText(text, 1, 1, 512).map((window) => ({
                    compartmentId,
                    sessionId: session,
                    projectPath: project,
                    modelId: model,
                    window,
                    vector: new Float32Array([1, 0]),
                })),
                chunkWindowSourceKey(text, 1, 1, 512),
            );
            const count = () =>
                countSessionCompartmentEmbedCoveragePolite(db, project, session, model);
            expect(await count()).toEqual({ embedded: 1, total: 1 });
            const index = prepare.mock.calls.findIndex(
                ([sql]) => sql === MESSAGE_FTS_CHUNK_LOAD_SQL,
            );
            expect(index).toBeGreaterThanOrEqual(0);
            const loads = spyOn(prepare.mock.results[index].value, "all");
            try {
                expect(await count()).toEqual({ embedded: 1, total: 1 });
                expect(loads).toHaveBeenCalledTimes(0);
                db.prepare(
                    "UPDATE message_history_fts SET content = 'Reindexed transcript' WHERE session_id = ?",
                ).run(session);
                expect(await count()).toEqual({ embedded: 0, total: 1 });
                expect(loads).toHaveBeenCalledTimes(1);
                db.prepare("UPDATE compartments SET end_message = 2 WHERE id = ?").run(
                    compartmentId,
                );
                insertFtsRow(db, session, 2, "assistant", "Extended transcript");
                expect(await count()).toEqual({ embedded: 0, total: 1 });
                expect(loads).toHaveBeenCalledTimes(2);
                db.exec("BEGIN");
                db.prepare(
                    "UPDATE message_history_fts SET content = 'Rolled back' WHERE session_id = ?",
                ).run(session);
                await count();
                db.exec("ROLLBACK");
                await count();
                expect(loads).toHaveBeenCalledTimes(4);
                await count();
                expect(loads).toHaveBeenCalledTimes(4);
            } finally {
                loads.mockRestore();
            }
        } finally {
            prepare.mockRestore();
            closeQuietly(db);
        }
    });

    test("steady-state coverage and count do not re-tokenize unchanged compartments", async () => {
        const db = createDb();
        const sessionId = "ses-coverage-memo";
        const project = "/repo/coverage-memo";
        const model = "mock:coverage-memo";
        try {
            recordSessionProjectIdentity(db, sessionId, project);
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "u1",
                    endMessageId: "u1",
                    title: "Memo",
                    content: "Memo",
                    p1: "Memo",
                },
            ]);
            insertFtsRow(db, sessionId, 1, "user", "A unique message for the coverage memo");
            const tokens = spyOn(formatting, "estimateTokens");
            try {
                expect(
                    (
                        await countSessionCompartmentEmbedCoveragePolite(
                            db,
                            project,
                            sessionId,
                            model,
                        )
                    ).total,
                ).toBe(1);
                expect(tokens.mock.calls.length).toBeGreaterThan(0);
                tokens.mockClear();
                expect(
                    await countUnembeddedSessionCompartmentsPolite(db, project, sessionId, model),
                ).toBe(1);
                expect(
                    (
                        await loadUnembeddedSessionChunkCandidatesPolite(
                            db,
                            project,
                            sessionId,
                            model,
                            1,
                        )
                    ).length,
                ).toBe(1);
                expect(
                    (
                        await countSessionCompartmentEmbedCoveragePolite(
                            db,
                            project,
                            sessionId,
                            model,
                        )
                    ).embedded,
                ).toBe(0);
                expect(tokens).toHaveBeenCalledTimes(0);
            } finally {
                tokens.mockRestore();
            }
            // Replacing indexed message text must invalidate cached window hashes
            // even when the owning compartment row remains unchanged.
            insertFtsRow(db, sessionId, 1, "assistant", "New text");
            expect(
                (await countSessionCompartmentEmbedCoveragePolite(db, project, sessionId, model))
                    .embedded,
            ).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("recorded window sources skip re-chunking after a restart", () => {
    const MAX_TOKENS = 64;
    type Seeded = ReturnType<typeof getCompartments>[number];

    // One compartment per ordinal, each long enough to need several windows.
    function seed(db: Database, sessionId: string, projectPath: string, count: number): Seeded[] {
        recordSessionProjectIdentity(db, sessionId, projectPath);
        appendCompartments(
            db,
            sessionId,
            Array.from({ length: count }, (_, index) => ({
                sequence: index,
                startMessage: index + 1,
                endMessage: index + 1,
                startMessageId: `u${index + 1}`,
                endMessageId: `u${index + 1}`,
                title: `Compartment ${index + 1}`,
                content: "summary",
                p1: "summary",
            })),
        );
        for (let index = 0; index < count; index++) {
            insertFtsRow(
                db,
                sessionId,
                index + 1,
                "user",
                Array.from({ length: 320 }, (_, word) => `c${index}-token-${word}`).join(" "),
            );
        }
        return getCompartments(db, sessionId);
    }

    function currentInput(db: Database, sessionId: string, compartment: Seeded) {
        const text =
            buildCanonicalChunkTextFromFts(
                db,
                sessionId,
                compartment.startMessage,
                compartment.endMessage,
            ) ?? "";
        const windows = chunkCanonicalText(
            text,
            compartment.startMessage,
            compartment.endMessage,
            MAX_TOKENS,
        );
        expect(windows.length).toBeGreaterThan(1);
        const sourceKey = chunkWindowSourceKey(
            text,
            compartment.startMessage,
            compartment.endMessage,
            MAX_TOKENS,
        );
        return { windows, sourceKey };
    }

    function writeRows(
        db: Database,
        sessionId: string,
        projectPath: string,
        modelId: string,
        compartment: Seeded,
        windows: ReturnType<typeof chunkCanonicalText>,
        sourceKey?: string,
    ): void {
        replaceCompartmentChunkEmbeddings(
            db,
            windows.map((window) => ({
                compartmentId: compartment.id,
                sessionId,
                projectPath,
                window,
                modelId,
                vector: new Float32Array([1, 0]),
            })),
            sourceKey,
        );
    }

    function windowSourceKeys(db: Database): string[] {
        return (
            db
                .prepare(
                    "SELECT key FROM schema_migrations_meta WHERE key LIKE 'chunk_embed_windows:%' ORDER BY key",
                )
                .all() as Array<{ key: string }>
        ).map((row) => row.key);
    }

    async function countWithTokenSpy(
        run: () => Promise<unknown> | unknown,
    ): Promise<{ result: unknown; tokenCalls: number }> {
        const tokens = spyOn(formatting, "estimateTokens");
        try {
            const result = await run();
            return { result, tokenCalls: tokens.mock.calls.length };
        } finally {
            tokens.mockRestore();
        }
    }

    test("a cold coverage count confirms recorded rows without chunking", async () => {
        const db = createDb();
        const sessionId = "ses-window-source-cold";
        const projectPath = "/repo/window-source-cold";
        const modelId = "mock:window-source";
        try {
            const compartments = seed(db, sessionId, projectPath, 2);
            for (const compartment of compartments) {
                const { windows, sourceKey } = currentInput(db, sessionId, compartment);
                writeRows(db, sessionId, projectPath, modelId, compartment, windows, sourceKey);
            }
            _resetCompartmentChunkCoverageMemoForTests();

            const polite = await countWithTokenSpy(() =>
                countSessionCompartmentEmbedCoveragePolite(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    MAX_TOKENS,
                ),
            );
            expect(polite.result).toEqual({ embedded: 2, total: 2 });
            expect(polite.tokenCalls).toBe(0);
            const sync = await countWithTokenSpy(() =>
                countSessionCompartmentEmbedCoverage(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    MAX_TOKENS,
                ),
            );
            expect(sync.result).toEqual({ embedded: 2, total: 2 });
            expect(sync.tokenCalls).toBe(0);

            clearSession(db, sessionId);
            expect(windowSourceKeys(db)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("changed transcript text is detected despite a recorded source", async () => {
        const db = createDb();
        const sessionId = "ses-window-source-text";
        const projectPath = "/repo/window-source-text";
        const modelId = "mock:window-source";
        try {
            const [compartment] = seed(db, sessionId, projectPath, 1);
            const { windows, sourceKey } = currentInput(db, sessionId, compartment);
            writeRows(db, sessionId, projectPath, modelId, compartment, windows, sourceKey);
            // Re-indexing the message replaces the text the windows were cut from.
            insertFtsRow(
                db,
                sessionId,
                1,
                "user",
                Array.from({ length: 320 }, (_, word) => `edited-token-${word}`).join(" "),
            );
            _resetCompartmentChunkCoverageMemoForTests();

            expect(
                await countSessionCompartmentEmbedCoveragePolite(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    MAX_TOKENS,
                ),
            ).toEqual({ embedded: 0, total: 1 });
            expect(
                loadUnembeddedSessionChunkCandidates(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    5,
                    undefined,
                    MAX_TOKENS,
                ).map((candidate) => candidate.id),
            ).toEqual([compartment.id]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a different model id is detected despite a recorded source", async () => {
        const db = createDb();
        const sessionId = "ses-window-source-model";
        const projectPath = "/repo/window-source-model";
        try {
            const [compartment] = seed(db, sessionId, projectPath, 1);
            const { windows, sourceKey } = currentInput(db, sessionId, compartment);
            writeRows(db, sessionId, projectPath, "mock:model-a", compartment, windows, sourceKey);
            _resetCompartmentChunkCoverageMemoForTests();

            expect(
                countSessionCompartmentEmbedCoverage(
                    db,
                    projectPath,
                    sessionId,
                    "mock:model-a",
                    MAX_TOKENS,
                ),
            ).toEqual({ embedded: 1, total: 1 });
            expect(
                await countSessionCompartmentEmbedCoveragePolite(
                    db,
                    projectPath,
                    sessionId,
                    "mock:model-b",
                    MAX_TOKENS,
                ),
            ).toEqual({ embedded: 0, total: 1 });
            expect(
                countUnembeddedSessionCompartments(
                    db,
                    projectPath,
                    sessionId,
                    "mock:model-b",
                    MAX_TOKENS,
                ),
            ).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("a different token budget re-chunks instead of trusting the recorded source", async () => {
        const db = createDb();
        const sessionId = "ses-window-source-budget";
        const projectPath = "/repo/window-source-budget";
        const modelId = "mock:window-source";
        try {
            const [compartment] = seed(db, sessionId, projectPath, 1);
            const { windows, sourceKey } = currentInput(db, sessionId, compartment);
            writeRows(db, sessionId, projectPath, modelId, compartment, windows, sourceKey);
            _resetCompartmentChunkCoverageMemoForTests();

            const wider = await countWithTokenSpy(() =>
                countSessionCompartmentEmbedCoveragePolite(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    MAX_TOKENS * 4,
                ),
            );
            expect(wider.result).toEqual({ embedded: 0, total: 1 });
            expect(wider.tokenCalls).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("rows without a recorded source are classified by chunking, and counts write nothing", async () => {
        const tempDirectory = createTestTempDirFromPath(join(tmpdir(), "chunk-window-source-"));
        const databasePath = join(tempDirectory, "store.db");
        const db = createDb(databasePath);
        const sessionId = "ses-window-source-legacy";
        const projectPath = "/repo/window-source-legacy";
        const modelId = "mock:window-source";
        let observer: Database | null = null;
        try {
            const [current, stale] = seed(db, sessionId, projectPath, 2);
            const currentRows = currentInput(db, sessionId, current);
            writeRows(db, sessionId, projectPath, modelId, current, currentRows.windows);
            const staleRows = currentInput(db, sessionId, stale);
            writeRows(
                db,
                sessionId,
                projectPath,
                modelId,
                stale,
                staleRows.windows.map((window, index) =>
                    index === 0 ? { ...window, chunkHash: `stale-${window.chunkHash}` } : window,
                ),
            );
            expect(windowSourceKeys(db)).toEqual([]);
            _resetCompartmentChunkCoverageMemoForTests();

            observer = new Database(databasePath);
            const dataVersion = () =>
                (observer?.prepare("PRAGMA data_version").get() as { data_version: number })
                    .data_version;
            const before = dataVersion();
            const counted = await countWithTokenSpy(() =>
                countSessionCompartmentEmbedCoveragePolite(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    MAX_TOKENS,
                ),
            );
            expect(counted.result).toEqual({ embedded: 1, total: 2 });
            expect(counted.tokenCalls).toBeGreaterThan(0);
            expect(
                countSessionCompartmentEmbedCoverage(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    MAX_TOKENS,
                ),
            ).toEqual({ embedded: 1, total: 2 });
            expect(
                loadUnembeddedSessionChunkCandidates(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    5,
                    undefined,
                    MAX_TOKENS,
                ).map((candidate) => candidate.id),
            ).toEqual([stale.id]);
            expect(dataVersion()).toBe(before);
            expect(windowSourceKeys(db)).toEqual([]);
        } finally {
            if (observer) closeQuietly(observer);
            closeQuietly(db);
            rmSync(tempDirectory, { recursive: true, force: true });
        }
    });

    test("a lease-held scan records sources for current and renumbered legacy rows", async () => {
        const db = createDb();
        const sessionId = "ses-window-source-backfill";
        const projectPath = "/repo/window-source-backfill";
        const modelId = "mock:window-source";
        try {
            const [current, oneBased] = seed(db, sessionId, projectPath, 2);
            const currentRows = currentInput(db, sessionId, current);
            writeRows(db, sessionId, projectPath, modelId, current, currentRows.windows);
            const oneBasedRows = currentInput(db, sessionId, oneBased);
            writeRows(
                db,
                sessionId,
                projectPath,
                modelId,
                oneBased,
                oneBasedRows.windows.map((window) => ({
                    ...window,
                    windowIndex: window.windowIndex + 1,
                })),
            );
            _resetCompartmentChunkCoverageMemoForTests();

            expect(
                await loadUnembeddedSessionChunkCandidatesPolite(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    5,
                    [],
                    MAX_TOKENS,
                    true,
                ),
            ).toEqual([]);
            expect(windowSourceKeys(db)).toEqual(
                [current.id, oneBased.id].map((id) => `chunk_embed_windows:${id}`).sort(),
            );
            expect(
                (await loadCompartmentChunkEmbeddingsForSearch(db, sessionId, projectPath, modelId))
                    .filter((row) => row.compartmentId === oneBased.id)
                    .map((row) => row.windowIndex),
            ).toEqual(oneBasedRows.windows.map((window) => window.windowIndex));

            _resetCompartmentChunkCoverageMemoForTests();
            const restarted = await countWithTokenSpy(() =>
                countSessionCompartmentEmbedCoveragePolite(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    MAX_TOKENS,
                ),
            );
            expect(restarted.result).toEqual({ embedded: 2, total: 2 });
            expect(restarted.tokenCalls).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("classification with recorded sources equals classification by re-chunking", async () => {
        const db = createDb();
        const sessionId = "ses-window-source-mixed";
        const projectPath = "/repo/window-source-mixed";
        const modelId = "mock:window-source";
        try {
            const compartments = seed(db, sessionId, projectPath, 9);
            const [
                recordedCurrent,
                recordedTextChanged,
                recordedRowsStale,
                recordedRowMissing,
                recordedOtherModel,
                legacyCurrent,
                legacyOneBased,
                legacyStale,
                unembedded,
            ] = compartments;
            const inputs = new Map(
                compartments.map((compartment) => [
                    compartment.id,
                    currentInput(db, sessionId, compartment),
                ]),
            );
            const input = (compartment: Seeded) => {
                const value = inputs.get(compartment.id);
                if (!value) throw new Error("missing fixture input");
                return value;
            };
            for (const compartment of [
                recordedCurrent,
                recordedTextChanged,
                recordedRowsStale,
                recordedRowMissing,
            ]) {
                const { windows, sourceKey } = input(compartment);
                writeRows(db, sessionId, projectPath, modelId, compartment, windows, sourceKey);
            }
            writeRows(
                db,
                sessionId,
                projectPath,
                "mock:other-model",
                recordedOtherModel,
                input(recordedOtherModel).windows,
                input(recordedOtherModel).sourceKey,
            );
            // Later writes without a source leave the old record in place.
            writeRows(
                db,
                sessionId,
                projectPath,
                modelId,
                recordedRowsStale,
                input(recordedRowsStale).windows.map((window, index) =>
                    index === 1 ? { ...window, chunkHash: `stale-${window.chunkHash}` } : window,
                ),
            );
            writeRows(
                db,
                sessionId,
                projectPath,
                modelId,
                recordedRowMissing,
                input(recordedRowMissing).windows.slice(0, -1),
            );
            insertFtsRow(
                db,
                sessionId,
                recordedTextChanged.startMessage,
                "user",
                // Same shape as the seeded text, so only the window hashes change.
                Array.from({ length: 320 }, (_, word) => `x1-token-${word}`).join(" "),
            );
            writeRows(
                db,
                sessionId,
                projectPath,
                modelId,
                legacyCurrent,
                input(legacyCurrent).windows,
            );
            writeRows(
                db,
                sessionId,
                projectPath,
                modelId,
                legacyOneBased,
                input(legacyOneBased).windows.map((window) => ({
                    ...window,
                    windowIndex: window.windowIndex + 1,
                })),
            );
            writeRows(
                db,
                sessionId,
                projectPath,
                modelId,
                legacyStale,
                input(legacyStale).windows.map((window, index) =>
                    index === 0 ? { ...window, chunkHash: `stale-${window.chunkHash}` } : window,
                ),
            );
            expect(unembedded.id).toBeGreaterThan(0);

            const classify = async () => {
                _resetCompartmentChunkCoverageMemoForTests();
                return {
                    coverage: countSessionCompartmentEmbedCoverage(
                        db,
                        projectPath,
                        sessionId,
                        modelId,
                        MAX_TOKENS,
                    ),
                    politeCoverage: await countSessionCompartmentEmbedCoveragePolite(
                        db,
                        projectPath,
                        sessionId,
                        modelId,
                        MAX_TOKENS,
                    ),
                    unembedded: countUnembeddedSessionCompartments(
                        db,
                        projectPath,
                        sessionId,
                        modelId,
                        MAX_TOKENS,
                    ),
                    candidates: loadUnembeddedSessionChunkCandidates(
                        db,
                        projectPath,
                        sessionId,
                        modelId,
                        20,
                        undefined,
                        MAX_TOKENS,
                    ).map((candidate) => candidate.id),
                };
            };

            const withRecords = await classify();
            expect(windowSourceKeys(db).length).toBe(5);
            db.prepare(
                "DELETE FROM schema_migrations_meta WHERE key LIKE 'chunk_embed_windows:%'",
            ).run();
            const byChunking = await classify();

            expect(withRecords).toEqual(byChunking);
            // Missing windows sort ahead of stale ones; each group keeps ordinal order.
            expect(byChunking).toEqual({
                coverage: { embedded: 3, total: 9 },
                politeCoverage: { embedded: 3, total: 9 },
                unembedded: 6,
                candidates: [
                    recordedRowMissing.id,
                    recordedOtherModel.id,
                    unembedded.id,
                    recordedTextChanged.id,
                    recordedRowsStale.id,
                    legacyStale.id,
                ],
            });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("issue 564 failed-compartment backoff", () => {
    test("persists a content- and identity-scoped retry delay and removes it with the session", async () => {
        const db = createDb();
        const sessionId = "ses-backoff";
        const project = "/repo/backoff";
        try {
            recordSessionProjectIdentity(db, sessionId, project);
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "u1",
                    endMessageId: "u1",
                    title: "Retry",
                    content: "Retry",
                    p1: "Retry",
                },
            ]);
            insertFtsRow(db, sessionId, 1, "user", "Original text");
            const candidate = getCompartments(db, sessionId)[0];
            expect(
                await countUnembeddedSessionCompartmentsPolite(db, project, sessionId, "model:a"),
            ).toBe(1);
            recordChunkEmbedBackoff(db, candidate, project, "model:a");
            expect(
                await countUnembeddedSessionCompartmentsPolite(db, project, sessionId, "model:a"),
            ).toBe(0);
            expect(
                await countUnembeddedSessionCompartmentsPolite(db, project, sessionId, "model:b"),
            ).toBe(1);
            insertFtsRow(db, sessionId, 1, "assistant", "Repaired text");
            expect(
                await countUnembeddedSessionCompartmentsPolite(db, project, sessionId, "model:a"),
            ).toBe(1);
            clearSession(db, sessionId);
            expect(
                db
                    .prepare("SELECT key FROM schema_migrations_meta WHERE key = ?")
                    .get(`chunk_embed_backoff:${candidate.id}`),
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
