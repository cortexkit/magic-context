import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import * as embedding from "../../features/magic-context/memory/embedding";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { loadAllEmbeddings } from "../../features/magic-context/memory/storage-memory-embeddings";
import { runMigrations } from "../../features/magic-context/migrations";
import { unifiedSearch } from "../../features/magic-context/search";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { loadPostprocessReplaySnapshot } from "../../features/magic-context/storage-meta-persisted";
import {
    clearSession,
    getOrCreateSessionMeta,
} from "../../features/magic-context/storage-meta-session";
import { Database, withSqliteTransformPass } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    clearAutoSearchTimeoutForSession,
    persistAutoSearchSkip,
    wasAutoSearchSkipped,
} from "./auto-search-deadline";
import { buildAutoSearchHint } from "./auto-search-hint";
import { clearAutoSearchForSession, runAutoSearchHint } from "./auto-search-runner";
import { autoSearchTestSnapshot } from "./auto-search-snapshot.fixture";
import * as search from "./auto-search-worker-client";
import { persistAutoSearchDecision, searchAutoHint } from "./auto-search-worker-client";
import { appendReminderToUserMessageById } from "./transform-message-helpers";

const root = join(tmpdir(), "magic-context", "bg_a8d894f629e2c52f");
mkdirSync(root, { recursive: true });
const connections: Database[] = [];
function fixture() {
    const path = join(createTestTempDirFromPath(join(root, "review-")), "context.db");
    const db = new Database(path);
    connections.push(db);
    initializeDatabase(db);
    runMigrations(db);
    return { db, path };
}
afterEach(() => {
    clearAutoSearchTimeoutForSession();
    for (const db of connections.splice(0)) db.close();
});

test("review: background skip persistence must not resurrect a deleted session", async () => {
    const { db } = fixture();
    const sessionId = "deleted-before-worker-start";
    getOrCreateSessionMeta(db, sessionId);
    const persistence = persistAutoSearchSkip(db, sessionId, "user");
    clearSession(db, sessionId);
    clearAutoSearchForSession(sessionId);
    expect(
        db.prepare("SELECT 1 FROM session_meta WHERE session_id = ?").get(sessionId),
    ).toBeFalsy();
    await persistence;
    expect(
        db.prepare("SELECT 1 FROM session_meta WHERE session_id = ?").get(sessionId),
    ).toBeFalsy();
});

test("review: read-only worker bytes match the stored snapshot under a short writer lock", async () => {
    const project = "git:review-backfill-lock";
    const initial = autoSearchTestSnapshot(project);
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(initial);
    let lock: Worker | undefined;
    const batch = spyOn(embedding, "embedBatchForProject").mockImplementation(
        async (_project, texts) => {
            lock?.postMessage("release");
            return {
                vectors: texts.map(
                    (text) => new Float32Array(text.includes("details") ? [-1, 0] : [1, 0]),
                ),
                modelId: initial.modelId,
                generation: 1,
            };
        },
    );
    const hints: string[] = [];
    try {
        for (const offThread of [false, true]) {
            const { db, path } = fixture();
            db.exec("PRAGMA busy_timeout = 2000");
            insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE_DECISIONS",
                content: "historian cache wiring details",
            });
            insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE_DECISIONS",
                content: "historian cache wiring retry correctness budgeting",
            });
            const { invalidateProject } = await import(
                "../../features/magic-context/memory/embedding-cache"
            );
            invalidateProject(project);
            lock = new Worker(new URL("./auto-search-lock-review.fixture.ts", import.meta.url), {
                workerData: { path },
            });
            const finished = new Promise<void>((resolve, reject) => {
                lock!.on("exit", (code) =>
                    code === 0 ? resolve() : reject(new Error(`lock worker exited ${code}`)),
                );
                lock!.on("error", reject);
            });
            await new Promise<void>((resolve, reject) => {
                lock!.once("message", () => resolve());
                lock!.once("error", reject);
            });
            const startedAt = performance.now();
            let payload = "";
            try {
                const results = await withSqliteTransformPass(() =>
                    (offThread ? searchAutoHint : unifiedSearch)(
                        db,
                        "backfill-lock",
                        project,
                        "historian cache wiring",
                        {
                            backfillMemoryEmbeddings: false,
                            sources: ["memory"],
                            embeddingEnabled: true,
                            countRetrievals: false,
                            measurementDisabled: true,
                            isEmbeddingRuntimeEnabled: () => true,
                            embedQuery: async () => ({
                                vector: new Float32Array([1, 0]),
                                modelId: initial.modelId,
                                chunkModelId: initial.chunkModelId,
                                generation: 1,
                            }),
                        },
                    ),
                );
                expect(results.length).toBeGreaterThan(0);
                expect(results[0].score).toBeGreaterThan(0.6);
                payload = `\n\n${buildAutoSearchHint(results)}`;
            } finally {
                lock.postMessage("release");
                await finished;
            }
            // Isolate search parity from decision-lock failure: the short writer
            // finishes before persistence, and both accepted hints meet the budget.
            const { appendAutoSearchHintDecision } = await import(
                "../../features/magic-context/storage-meta-persisted"
            );
            const decision = { messageId: "user", decision: "hint" as const, text: payload };
            const outcome = offThread
                ? await persistAutoSearchDecision(db, "backfill-lock", decision, startedAt)
                : appendAutoSearchHintDecision(db, "backfill-lock", decision);
            expect(outcome?.ok).toBe(true);
            const messages = [
                {
                    info: { id: "user", role: "user" },
                    parts: [{ type: "text", text: "historian cache wiring" }],
                },
            ];
            if (outcome?.ok && outcome.decision.decision === "hint")
                appendReminderToUserMessageById(messages, "user", outcome.decision.text);
            hints.push(JSON.stringify(messages));
        }
        expect(batch).toHaveBeenCalledTimes(0);
        expect(hints[1]).toBe(hints[0]);
    } finally {
        batch.mockRestore();
        snapshot.mockRestore();
    }
});

test("review: a provider generation change must not label new passage vectors with the old model", async () => {
    const { db } = fixture();
    const project = "git:review-generation";
    const memory = insertMemory(db, {
        projectPath: project,
        category: "ARCHITECTURE_DECISIONS",
        content: "historian cache wiring details",
    });
    const initial = autoSearchTestSnapshot(project);
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(initial);
    const newVector = new Float32Array([0, 1]);
    const batch = spyOn(embedding, "embedBatchForProject").mockImplementation(async () => {
        snapshot.mockReturnValue({ ...initial, generation: 2, modelId: "new-provider" });
        return { vectors: [newVector], modelId: "new-provider", generation: 2 };
    });
    try {
        const result = await searchAutoHint(db, "generation", project, "historian cache wiring", {
            sources: ["memory"],
            embeddingEnabled: true,
            isEmbeddingRuntimeEnabled: () => true,
            embedQuery: async () => ({
                vector: new Float32Array([1, 0]),
                modelId: initial.modelId,
                chunkModelId: initial.chunkModelId,
                generation: 1,
            }),
        });
        const query = spyOn(embedding, "embedTextForProject").mockResolvedValue({
            vector: new Float32Array([1, 0]),
            modelId: initial.modelId,
            chunkModelId: initial.chunkModelId,
            generation: 1,
        });
        try {
            await search.queueAutoSearchBackfill(
                db,
                "generation",
                project,
                "historian cache wiring",
            );
        } finally {
            query.mockRestore();
        }
        expect(batch).toHaveBeenCalledTimes(1);
        expect(result.length).toBeGreaterThan(0);
        // Discarding the final hint is insufficient: the passage bridge must retain
        // the provider contract before a guarded embedding write can occur.
        expect(loadAllEmbeddings(db, project, initial.modelId).has(memory.id)).toBe(false);
    } finally {
        batch.mockRestore();
        snapshot.mockRestore();
    }
});

test("review: search readers cannot publish an unacknowledged hint on another connection", async () => {
    const { db, path } = fixture();
    const reader = new Database(path);
    connections.push(reader);
    const result = await searchAutoHint(
        db,
        "review-second-owner",
        "git:reader",
        "historian cache wiring",
        { embeddingEnabled: false },
    );
    expect(result).toEqual([]);
    expect(
        loadPostprocessReplaySnapshot(reader, "review-second-owner").autoSearchHintDecisions,
    ).toEqual([]);
    const messages = [
        { info: { id: "user", role: "user" }, parts: [{ type: "text", text: "question" }] },
        { info: { id: "assistant", role: "assistant" }, parts: [{ type: "text", text: "answer" }] },
    ];
    const before = JSON.stringify(messages);
    await runAutoSearchHint({
        db: reader,
        sessionId: "review-second-owner",
        messages,
        options: { enabled: true, projectPath: "git:reader", minPromptChars: 1, scoreThreshold: 0 },
    });
    expect(JSON.stringify(messages)).toBe(before);
});

test("review: a failed durable skip remains frozen after another turn skips", async () => {
    const { db, path } = fixture();
    const writer = new Database(path);
    connections.push(writer);
    writer.exec("BEGIN IMMEDIATE");
    try {
        expect(await persistAutoSearchSkip(db, "rewound-session", "user-one")).toBe(false);
        expect(wasAutoSearchSkipped(db, "rewound-session", "user-one")).toBe(true);
        expect(await persistAutoSearchSkip(db, "rewound-session", "user-two")).toBe(false);
        // Pi branch navigation or an OpenCode rewind can make the earlier raw
        // user turn the tail again without closing the database or process.
    } finally {
        writer.exec("ROLLBACK");
    }
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
        autoSearchTestSnapshot("git:rewind"),
    );
    const results = spyOn(search, "searchAutoHint").mockResolvedValue([
        {
            source: "memory",
            content: "historian cache wiring details",
            score: 1,
            memoryId: 1,
            category: "ARCHITECTURE_DECISIONS",
            matchType: "fts",
        },
    ]);
    try {
        const messages = [
            {
                info: { id: "user-one", role: "user" },
                parts: [{ type: "text", text: "historian cache wiring details" }],
            },
        ];
        const before = JSON.stringify(messages);
        await runAutoSearchHint({
            db,
            sessionId: "rewound-session",
            messages,
            options: {
                enabled: true,
                projectPath: "git:rewind",
                scoreThreshold: 0,
                minPromptChars: 1,
            },
        });
        expect({
            frozen: wasAutoSearchSkipped(db, "rewound-session", "user-one"),
            bytes: JSON.stringify(messages),
        }).toEqual({ frozen: true, bytes: before });
    } finally {
        results.mockRestore();
        snapshot.mockRestore();
    }
});
