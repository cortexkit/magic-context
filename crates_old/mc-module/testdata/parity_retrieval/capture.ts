// Capture production search results and rendered-memory visibility using a temporary context.db.
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../../packages/plugin/src/shared/sqlite";
import { initializeDatabase } from "../../../../packages/plugin/src/features/magic-context/storage-db";
import { runMigrations } from "../../../../packages/plugin/src/features/magic-context/migrations";
import { insertMemory, saveEmbedding, updateMemoryContent } from "../../../../packages/plugin/src/features/magic-context/memory";
import { computeNormalizedHash } from "../../../../packages/plugin/src/features/magic-context/memory/normalize-hash";
import { appendCompartments, getCompartments } from "../../../../packages/plugin/src/features/magic-context/compartment-storage";
import { chunkCanonicalText, replaceCompartmentChunkEmbeddings } from "../../../../packages/plugin/src/features/magic-context/compartment-chunk-embedding";
import { getOrCreateSessionMeta } from "../../../../packages/plugin/src/features/magic-context/storage";
import { getVisibleMemoryIds, materializeM0, injectM0M1 } from "../../../../packages/plugin/src/hooks/magic-context/inject-compartments";
import { createUnifiedSearchDiagnostics, unifiedSearch, type UnifiedSearchOptions } from "../../../../packages/plugin/src/features/magic-context/search";

const directory = mkdtempSync(join(tmpdir(), "mc-parity-retrieval-"));
const path = join(directory, "context.db");
const out = import.meta.dir;
const db = new Database(path);
const now = Date.UTC(2026, 0, 10);
const realNow = Date.now;
Date.now = () => now;
const project = "git:parity-own";
const session = "retrieval-session";
const model = "fixture:model";
const vector = [1, 0, 0];

try {
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, session);
    const seedMemory = (content: string, values: number[] | null, options: { project?: string; category?: Parameters<typeof insertMemory>[1]["category"]; created?: number; status?: string; model?: string; expires?: number } = {}) => {
        const memory = insertMemory(db, { projectPath: options.project ?? project, category: options.category ?? "ARCHITECTURE", content, importance: 80 });
        db.prepare("UPDATE memories SET created_at=?, updated_at=?, status=?, expires_at=? WHERE id=?")
            .run(options.created ?? now, options.created ?? now, options.status ?? "active", options.expires ?? null, memory.id);
        if (values) saveEmbedding(db, memory.id, new Float32Array(values), options.model ?? model);
        return memory.id;
    };
    const baseline = seedMemory("queue backpressure baseline already rendered", [1, 0, 0]);
    const stale = seedMemory("queue original text at fold time", [0.8, 0.6, 0]);
    const renderOptions = () => ({ db, state: getOrCreateSessionMeta(db, session), sessionId: session,
        projectPath: project, projectDirectory: directory, injectDocs: false,
        historyBudgetTokens: 10000, memoryInjectionBudgetTokens: 4000,
        hardSignals: { systemHash: "system", modelKey: "anthropic/claude", lastResponseTime: 1, cacheExpired: false } });
    let delta = 0;
    const folded = materializeM0({ ...renderOptions(), afterM0InputsReadForTest: () => {
        delta = seedMemory("queue delta already rendered", [1, 0, 0]);
    }});
    const served = injectM0M1({ ...renderOptions(), isCacheBustingPass: false });
    if (!folded.m0Text.includes("baseline already rendered") || !served.m1Text?.includes("delta already rendered"))
        throw new Error(`Fixture must contain real baseline and delta memory text: ${JSON.stringify({ folded: folded.m0Text, served: served.m1Text, rematerialized: served.m0RematerializedThisPass, decision: served.decision })}`);
    updateMemoryContent(db, stale, "queue corrected text remains searchable", computeNormalizedHash("queue corrected text remains searchable"));
    saveEmbedding(db, stale, new Float32Array([0.8, 0.6, 0]), model);
    const visible = [...(getVisibleMemoryIds(db, session) ?? [])].sort((a, b) => a - b);
    if (!visible.includes(baseline) || !visible.includes(delta) || visible.includes(stale))
        throw new Error(`Wrong rendered visibility: ${visible}`);

    seedMemory("queue pressure exact identifier", [0.6, 0.8, 0]);
    seedMemory("bounded drains absorb saturation", [0.99, 0.1, 0]);
    seedMemory("queue fts only fallback", null);
    seedMemory("queue wrong model must not score semantically", [1, 0, 0], { model: "fixture:other" });
    seedMemory("queue negative cosine still has lexical hybrid", [-1, 0, 0]);
    seedMemory("queue zero vector retains hybrid match type", [0, 0, 0]);
    seedMemory("queue archived semantic perfect", [1, 0, 0], { status: "archived" });
    seedMemory("queue expired semantic perfect", [1, 0, 0], { expires: now - 1 });
    seedMemory("queue dated inclusive lower", [1, 0, 0], { created: now - 2000 });
    seedMemory("queue dated inclusive upper", [1, 0, 0], { created: now + 2000 });
    seedMemory("queue dated outside interval", [1, 0, 0], { created: now - 2001 });
    seedMemory("pkg::worker.retry() handles transient saturation", [0.9, 0.1, 0]);
    seedMemory("queue " + "🙂 spaced\n".repeat(35), [0.4, 0.9, 0]);
    for (let i = 0; i < 70; i++) seedMemory(`capstone candidate ${i}`, null, { created: now + i });

    db.prepare("INSERT INTO workspaces(id, name, share_categories, created_at, updated_at) VALUES(?, ?, ?, ?, ?)")
        .run(1, "Retrieval", '["CONSTRAINTS"]', now, now);
    for (const [identity, name] of [[project, "Own"], ["git:parity-foreign", "Foreign"]])
        db.prepare("INSERT INTO workspace_members(workspace_id, project_path, display_name, display_path, added_at) VALUES(?, ?, ?, ?, ?)")
            .run(1, identity, name, directory, now);
    const shared = seedMemory("queue shared workspace constraint", [1, 0, 0], { project: "git:parity-foreign", category: "CONSTRAINTS" });
    db.prepare("UPDATE memories SET scope='project', shareable=1 WHERE id=?").run(shared);
    seedMemory("queue hidden workspace architecture", [1, 0, 0], { project: "git:parity-foreign" });
    seedMemory("queue unclassified foreign constraint", [1, 0, 0], { project: "git:parity-foreign", category: "CONSTRAINTS" });
    seedMemory("queue totally unrelated project", [1, 0, 0], { project: "git:unrelated" });

    const seedChunk = (seq: number, start: number, end: number, title: string, values: number[][], chunkModel = model) => {
        appendCompartments(db, session, [{ sequence: seq, startMessage: start, endMessage: end,
            startMessageId: `m${start}`, endMessageId: `m${end}`, title, content: "compressed summary", p1: "compressed summary" }]);
        const compartment = getCompartments(db, session).find(c => c.sequence === seq)!;
        const windows = values.map((v, index) => {
            const window = chunkCanonicalText(`[${start}] U: ${title} ${index}`, start, end, 10000)[0];
            return { compartmentId: compartment.id, sessionId: session, projectPath: project,
                window: { ...window, windowIndex: index }, modelId: chunkModel, vector: new Float32Array(v) };
        });
        replaceCompartmentChunkEmbeddings(db, windows);
        return compartment.id;
    };
    seedChunk(0, 1, 5, "Saturation and bounded drains", [[0.6, 0.8, 0], [1, 0, 0]]);
    seedChunk(1, 6, 10, "Same score later ordinal", [[1, 0, 0]]);
    seedChunk(2, 11, 20, "Unrelated title semantic recall", [[0.99, 0.1, 0]]);
    seedChunk(3, 21, 25, "queue literal title but wrong model", [[1, 0, 0]], "fixture:other");
    seedChunk(4, 26, 30, "Past compacted cutoff", [[1, 0, 0]]);
    seedChunk(5, 31, 40, "Missing endpoint dates", [[0.9, 0.1, 0]]);
    for (const [ordinal, time] of [[1, now - 4000], [5, now - 1000], [6, now - 1000], [10, now + 4000], [11, now + 4001], [20, now + 5000], [26, now], [30, now]])
        db.prepare("INSERT INTO message_fts_rowid_map(session_id, fts_rowid, message_ordinal, message_time_ms) VALUES(?, ?, ?, ?)")
            .run(session, ordinal, ordinal, time);

    const cases: Array<{ name: string; query: string; visibility?: boolean; embedding?: boolean;
        vector?: number[] | null; model?: string; from?: number; to?: number; cutoff?: number;
        memory?: boolean; sources?: string[]; limit?: number }> = [
        { name: "hybrid_visibility", query: "queue" },
        { name: "no_visibility_filter", query: "queue", visibility: false },
        { name: "embedding_disabled", query: "queue", embedding: false },
        { name: "embedding_failed", query: "queue", vector: null },
        { name: "wrong_model", query: "queue", model: "fixture:absent" },
        { name: "semantic_without_lexical", query: "overload mitigation" },
        { name: "punctuation_relaxed_fts", query: "pkg::worker.retry()" },
        { name: "inclusive_dates_and_overlap", query: "queue", from: now - 2000, to: now + 2000 },
        { name: "cutoff_zero", query: "queue", cutoff: 0 },
        { name: "cutoff_negative", query: "queue", cutoff: -1 },
        { name: "compartments_without_memory", query: "queue", memory: false },
        { name: "sources_empty", query: "queue", sources: [] },
        { name: "only_memory", query: "queue", sources: ["memory"] },
        { name: "only_message", query: "queue", sources: ["message"] },
        { name: "fractional_limit", query: "queue", limit: 2.9 },
        { name: "minimum_limit", query: "queue", limit: 0 },
        { name: "maximum_limit", query: "queue", limit: 10000 },
        { name: "fts_candidate_cap", query: "capstone", limit: 25, embedding: false },
        { name: "date_before_fts_cap", query: "capstone", embedding: false, from: now, to: now + 10, limit: 25 },
        { name: "whitespace_query", query: "\uFEFF   \n" },
    ];
    const captured = [];
    for (const c of cases) {
        const diagnostics = createUnifiedSearchDiagnostics();
        const q = c.vector === undefined ? vector : c.vector;
        const options: UnifiedSearchOptions = {
            limit: c.limit, from: c.from, to: c.to, memoryEnabled: c.memory ?? true,
            embeddingEnabled: c.embedding ?? true, sources: (c.sources ?? ["memory", "message"]) as UnifiedSearchOptions["sources"],
            maxMessageOrdinal: c.cutoff ?? 25, embeddingModelIdOverride: c.model ?? model,
            chunkModelIdOverride: c.model ?? model, isEmbeddingRuntimeEnabled: () => true,
            embedQuery: async () => q ? new Float32Array(q) : null,
            visibleMemoryIds: c.visibility === false ? null : getVisibleMemoryIds(db, session),
            backfillMemoryEmbeddings: false, countRetrievals: false, measurementDisabled: true, diagnostics,
        };
        const results = await unifiedSearch(db, session, project, c.query, options);
        captured.push({ name: c.name, query: c.query,
            options: { limit: c.limit, dates: { from_ms: c.from, to_ms: c.to }, sources: options.sources,
                memory_enabled: options.memoryEnabled, embedding_enabled: options.embeddingEnabled, max_message_ordinal: options.maxMessageOrdinal },
            model: c.model ?? model, vector: q, visibility: c.visibility !== false,
            results, reported_scores: results.map(r => r.score.toFixed(2)),
            suppressed_visible_memory_ids: diagnostics.suppressedVisibleMemoryIds });
    }
    writeFileSync(join(out, "golden.json"), JSON.stringify({ now, project, session, model, vector, visible,
        baseline, delta, stale, m0: folded.m0Text, m1: served.m1Text, cases: captured }, null, 2) + "\n");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    copyFileSync(path, join(out, "context.db"));
    console.log(`Captured ${captured.length} production TS search cases; visibility=${visible.join(",")}; bun=${Bun.version}`);
} finally {
    Date.now = realNow;
    try { db.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
}
