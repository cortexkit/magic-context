import { describe, expect, test } from "bun:test";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    buildCanonicalChunkTextFromFts,
    CHUNK_WINDOW_SAFETY_RATIO,
    canonicalizeInMemoryChunkTextForEmbedding,
    chunkCanonicalText,
    chunkEmbeddingWindowsAreCurrent,
    loadCompartmentChunkEmbeddingsForSearch,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import { embedAndStoreCompartmentChunks } from "./compartment-embedding";
import { appendCompartments, getCompartments } from "./compartment-storage";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
import { runMigrations } from "./migrations";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    getProjectEmbeddingSnapshot,
    registerProjectEmbedding,
} from "./project-embedding-registry";
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

function createDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function insertFtsRow(
    db: Database,
    sessionId: string,
    ordinal: number,
    role: "user" | "assistant",
    content: string,
): void {
    db.prepare(
        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
    ).run(sessionId, ordinal, `${role}-${ordinal}`, role, content);
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
        expect(windowed.map((window) => window.windowIndex)).toEqual([1, 2, 3]);
        expect(windowed.map((window) => [window.startOrdinal, window.endOrdinal])).toEqual([
            [1, 1],
            [2, 2],
            [3, 3],
        ]);
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
        // windowIndex stays 1-based and contiguous (stable chunk identity).
        expect(windows.map((w) => w.windowIndex)).toEqual(windows.map((_, i) => i + 1));
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
        expect(windows.map((w) => w.windowIndex)).toEqual(windows.map((_, i) => i + 1));
    });

    test("storage replaces chunks idempotently and clearSession removes rows", () => {
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
                loadCompartmentChunkEmbeddingsForSearch(
                    db,
                    "ses-store",
                    "/repo/store",
                    "mock:model",
                ),
            ).toHaveLength(1);

            clearSession(db, "ses-store");
            expect(
                loadCompartmentChunkEmbeddingsForSearch(
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
                loadCompartmentChunkEmbeddingsForSearch(
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
                loadCompartmentChunkEmbeddingsForSearch(
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
});
