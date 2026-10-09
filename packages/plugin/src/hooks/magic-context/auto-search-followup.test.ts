import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as embedding from "../../features/magic-context/memory/embedding";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { loadAllEmbeddings } from "../../features/magic-context/memory/storage-memory-embeddings";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getAutoSearchHintDecisions } from "../../features/magic-context/storage-meta-persisted";
import {
    clearSession,
    getOrCreateSessionMeta,
} from "../../features/magic-context/storage-meta-session";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { clearAutoSearchForSession, runAutoSearchHint } from "./auto-search-runner";
import { autoSearchTestSnapshot } from "./auto-search-snapshot.fixture";
import { persistAutoSearchDecision, queueAutoSearchBackfill } from "./auto-search-worker-client";

const root = join(tmpdir(), "magic-context", "auto-search-followup");
mkdirSync(root, { recursive: true });
const dbs: Database[] = [];
function fixture() {
    const path = join(createTestTempDirFromPath(join(root, "contract-")), "context.db");
    const db = new Database(path);
    dbs.push(db);
    initializeDatabase(db);
    runMigrations(db);
    return { db, path };
}
afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
});

for (const mismatch of ["provider", "dimensions"] as const) {
    test(`passage RPC rejects mismatched ${mismatch} before storing a vector`, async () => {
        const { db } = fixture();
        const project = `git:contract-${mismatch}`;
        const initial = autoSearchTestSnapshot(project);
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE_DECISIONS",
            content: "historian cache wiring",
        });
        const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(initial);
        const batch = spyOn(embedding, "embedBatchForProject").mockImplementation(async () => {
            if (mismatch === "provider")
                snapshot.mockReturnValue({ ...initial, providerIdentity: "another-provider" });
            return {
                vectors: [new Float32Array(mismatch === "dimensions" ? [1, 0, 0] : [1, 0])],
                modelId: initial.modelId,
                generation: initial.generation,
            };
        });
        try {
            const query = spyOn(embedding, "embedTextForProject").mockResolvedValue({
                vector: new Float32Array([1, 0]),
                modelId: initial.modelId,
                chunkModelId: initial.chunkModelId,
                generation: 1,
            });
            try {
                await queueAutoSearchBackfill(db, "contract", project, "historian cache wiring");
            } finally {
                query.mockRestore();
            }
            expect(batch).toHaveBeenCalledTimes(1);
            expect(loadAllEmbeddings(db, project, initial.modelId).has(memory.id)).toBe(false);
        } finally {
            batch.mockRestore();
            snapshot.mockRestore();
        }
    });
}

test("owner-persisted hint has identical SOFT replay on two connections", async () => {
    const { db, path } = fixture();
    const reader = new Database(path);
    dbs.push(reader);
    const sessionId = "accepted-two-connections";
    const decision = {
        messageId: "user",
        decision: "hint" as const,
        text: "\n\n<ctx-search-hint>accepted fragment</ctx-search-hint>",
    };
    expect((await persistAutoSearchDecision(db, sessionId, decision, performance.now()))?.ok).toBe(
        true,
    );
    expect(getAutoSearchHintDecisions(reader, sessionId)).toEqual([decision]);
    const raw = db
        .prepare(
            "SELECT auto_search_hint_decisions AS decisions FROM session_meta WHERE session_id=?",
        )
        .get(sessionId) as { decisions: string };
    expect(JSON.parse(raw.decisions)).toEqual([decision]);
    const outputs: string[] = [];
    for (const connection of [db, reader]) {
        const messages = [
            { info: { id: "user", role: "user" }, parts: [{ type: "text", text: "question" }] },
            {
                info: { id: "assistant", role: "assistant" },
                parts: [{ type: "text", text: "answer" }],
            },
        ];
        await runAutoSearchHint({
            db: connection,
            sessionId,
            messages,
            options: {
                enabled: true,
                projectPath: "git:accepted",
                scoreThreshold: 0,
                minPromptChars: 1,
            },
        });
        outputs.push(JSON.stringify(messages));
    }
    expect(outputs[1]).toBe(outputs[0]);
    expect(outputs[0]).toContain("accepted fragment");
});

test("backfill starts after the served decision and cannot change its bytes", async () => {
    const { db } = fixture();
    const project = "git:separate-backfill";
    const initial = autoSearchTestSnapshot(project);
    const memory = insertMemory(db, {
        projectPath: project,
        category: "ARCHITECTURE_DECISIONS",
        content: "historian cache wiring details",
    });
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(initial);
    const query = spyOn(embedding, "embedTextForProject").mockResolvedValue({
        vector: new Float32Array([1, 0]),
        modelId: initial.modelId,
        chunkModelId: initial.chunkModelId,
        generation: 1,
    });
    const batch = spyOn(embedding, "embedBatchForProject").mockImplementation(async () => {
        expect(getAutoSearchHintDecisions(db, "separate")[0]?.decision).toBe("hint");
        return { vectors: [new Float32Array([1, 0])], modelId: initial.modelId, generation: 1 };
    });
    try {
        const messages = [
            {
                info: { id: "user", role: "user" },
                parts: [{ type: "text", text: "historian cache wiring" }],
            },
        ];
        await runAutoSearchHint({
            db,
            sessionId: "separate",
            messages,
            options: { enabled: true, projectPath: project, minPromptChars: 1, scoreThreshold: 0 },
        });
        const served = JSON.stringify(messages);
        expect(batch).toHaveBeenCalledTimes(0);
        await queueAutoSearchBackfill(db, "separate", project, "historian cache wiring");
        expect(batch).toHaveBeenCalled();
        expect(loadAllEmbeddings(db, project, initial.modelId).has(memory.id)).toBe(true);
        expect(JSON.stringify(messages)).toBe(served);
    } finally {
        snapshot.mockRestore();
        query.mockRestore();
        batch.mockRestore();
    }
});

test("cleanup cancels queued backfill before it requests embeddings", async () => {
    const { db } = fixture();
    const batch = spyOn(embedding, "embedBatchForProject");
    try {
        const pending = queueAutoSearchBackfill(db, "queued-cleanup", "git:cleanup", "question");
        clearAutoSearchForSession("queued-cleanup");
        await pending;
        expect(batch).toHaveBeenCalledTimes(0);
        expect(getAutoSearchHintDecisions(db, "queued-cleanup")).toEqual([]);
    } finally {
        batch.mockRestore();
    }
});

test("cleanup discards an active backfill's late passage result after session recreation", async () => {
    const { db } = fixture();
    const project = "git:active-cleanup";
    const initial = autoSearchTestSnapshot(project);
    const memory = insertMemory(db, {
        projectPath: project,
        category: "ARCHITECTURE_DECISIONS",
        content: "historian cache wiring details",
    });
    getOrCreateSessionMeta(db, "active-cleanup");
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(initial);
    const query = spyOn(embedding, "embedTextForProject").mockResolvedValue({
        vector: new Float32Array([1, 0]),
        modelId: initial.modelId,
        chunkModelId: initial.chunkModelId,
        generation: 1,
    });
    let started!: () => void;
    const reached = new Promise<void>((resolve) => {
        started = resolve;
    });
    let release!: (value: { vectors: Float32Array[]; modelId: string; generation: number }) => void;
    let signal: AbortSignal | undefined;
    const batch = spyOn(embedding, "embedBatchForProject").mockImplementation(
        async (_project, _texts, currentSignal) => {
            signal = currentSignal;
            started();
            return new Promise((resolve) => {
                release = resolve;
            });
        },
    );
    try {
        const pending = queueAutoSearchBackfill(db, "active-cleanup", project, "question");
        await reached;
        clearSession(db, "active-cleanup");
        getOrCreateSessionMeta(db, "active-cleanup");
        await pending;
        expect(signal?.aborted).toBe(true);
        release({ vectors: [new Float32Array([1, 0])], modelId: initial.modelId, generation: 1 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(loadAllEmbeddings(db, project, initial.modelId).has(memory.id)).toBe(false);
        expect(getAutoSearchHintDecisions(db, "active-cleanup")).toEqual([]);
    } finally {
        snapshot.mockRestore();
        query.mockRestore();
        batch.mockRestore();
    }
});

test("golden hybrid hint matches master's search for the same stored-vector snapshot", async () => {
    const { db } = fixture();
    const { unifiedSearch } = await import("../../features/magic-context/search");
    const { saveEmbedding } = await import(
        "../../features/magic-context/memory/storage-memory-embeddings"
    );
    const { buildAutoSearchHint } = await import("./auto-search-hint");
    const { searchAutoHint } = await import("./auto-search-worker-client");
    const project = "git:hybrid-golden";
    const initial = autoSearchTestSnapshot(project);
    const memory = insertMemory(db, {
        projectPath: project,
        category: "ARCHITECTURE_DECISIONS",
        content: "historian cache wiring details",
    });
    saveEmbedding(db, memory.id, new Float32Array([1, 0]), initial.modelId);
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(initial);
    const batch = spyOn(embedding, "embedBatchForProject");
    const options = {
        sources: ["memory" as const],
        countRetrievals: false,
        measurementDisabled: true,
        embeddingEnabled: true,
        isEmbeddingRuntimeEnabled: () => true,
        embedQuery: async () => ({
            vector: new Float32Array([1, 0]),
            modelId: initial.modelId,
            chunkModelId: initial.chunkModelId,
            generation: 1,
        }),
    };
    try {
        const master = await unifiedSearch(
            db,
            "golden",
            project,
            "historian cache wiring",
            options,
        );
        const worker = await searchAutoHint(
            db,
            "golden",
            project,
            "historian cache wiring",
            options,
        );
        expect(worker).toEqual(master);
        expect(worker[0]?.source === "memory" && worker[0].matchType).toBe("hybrid");
        const golden =
            "<ctx-search-hint>\nYour memory may contain 1 related fragment:\n- historian cache wiring details\nIf the fragments above seem relevant to the current request, you may run ctx_search to retrieve full context. Otherwise ignore.\n</ctx-search-hint>";
        expect(buildAutoSearchHint(master)).toBe(golden);
        expect(buildAutoSearchHint(worker)).toBe(golden);
        expect(batch).toHaveBeenCalledTimes(0);
    } finally {
        snapshot.mockRestore();
        batch.mockRestore();
    }
});

test("background backfill keeps a 250ms writer lease without touching hint decisions", async () => {
    const { Worker } = await import("node:worker_threads");
    const { db, path } = fixture();
    const project = "git:bounded-backfill";
    const initial = autoSearchTestSnapshot(project);
    const memory = insertMemory(db, {
        projectPath: project,
        category: "ARCHITECTURE_DECISIONS",
        content: "historian cache wiring details",
    });
    const lock = new Worker(new URL("./auto-search-long-lock-review.fixture.ts", import.meta.url), {
        workerData: { path },
    });
    const unlocked = new Promise<void>((resolve, reject) => {
        lock.once("exit", () => resolve());
        lock.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
        lock.once("message", () => resolve());
        lock.once("error", reject);
    });
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(initial);
    const query = spyOn(embedding, "embedTextForProject").mockResolvedValue({
        vector: new Float32Array([1, 0]),
        modelId: initial.modelId,
        chunkModelId: initial.chunkModelId,
        generation: 1,
    });
    const batch = spyOn(embedding, "embedBatchForProject").mockImplementation(async () => {
        lock.postMessage("release");
        return { vectors: [new Float32Array([1, 0])], modelId: initial.modelId, generation: 1 };
    });
    try {
        await queueAutoSearchBackfill(db, "bounded-backfill", project, "historian cache wiring");
        expect(batch).toHaveBeenCalledTimes(1);
        await unlocked;
        expect(loadAllEmbeddings(db, project, initial.modelId).has(memory.id)).toBe(false);
        expect(getAutoSearchHintDecisions(db, "bounded-backfill")).toEqual([]);
        expect(
            db.prepare("SELECT 1 FROM session_meta WHERE session_id='bounded-backfill'").get(),
        ).toBeFalsy();
    } finally {
        await lock.terminate();
        snapshot.mockRestore();
        query.mockRestore();
        batch.mockRestore();
    }
});
