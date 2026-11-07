import type { UnifiedSearchStepTimings } from "../../features/magic-context/search";
import { serveWorkerJobs } from "../../shared/reusable-worker-entry";
import type { Database as DatabaseHandle } from "../../shared/sqlite";
import { exitOnWorkerClose } from "../../shared/worker-shutdown";
import type {
    AutoSearchEmbeddingReply,
    AutoSearchWorkerInput,
    AutoSearchWorkerReply,
} from "./auto-search-worker-client";

serveWorkerJobs<AutoSearchWorkerInput>(async (initial, port) => {
    let input = initial;
    function post(reply: AutoSearchWorkerReply): void {
        port.postMessage({ ...reply, jobId: input.jobId });
    }
    const persistent = input.persistent === true;
    // Tell a message-search caller the worker is running before loading the search
    // modules: the caller's first deadline only has to cover thread start, and a
    // worker that never gets this far is replaced by the in-process search.
    if (input.job === "messages") {
        post({ kind: "accepted" });
    }
    const [
        { ensureMemoryEmbeddings },
        { getProjectEmbeddings },
        { getMemoriesByProject },
        { installProjectEmbeddingSearchBridge },
        { searchMessageHistory, unifiedSearch },
        { getLastCompartmentChunkPoolWarm, maintainCompartmentChunkSearchPools },
        { setEmbeddingSessionBusy },
        { getHarness, setHarness },
        { Database, registerSqliteDiagnosticSink },
        { log },
    ] = await Promise.all([
        import("../../features/magic-context/memory/embedding-backfill"),
        import("../../features/magic-context/memory/embedding-cache"),
        import("../../features/magic-context/memory/storage-memory"),
        import("../../features/magic-context/project-embedding-registry"),
        import("../../features/magic-context/search"),
        import("../../features/magic-context/compartment-chunk-embedding"),
        import("../../shared/embedding-activity"),
        import("../../shared/harness"),
        import("../../shared/sqlite"),
        import("../../shared/logger"),
    ]);
    // Workers have their own module globals; session rows must retain their owner's
    // harness identity, and Pi/OMP must never inherit OpenCode-store ownership.
    setHarness(input.harness);
    registerSqliteDiagnosticSink(log, getHarness);
    let nextId = 0;
    const pending = new Map<number, (reply: AutoSearchEmbeddingReply) => void>();
    let queryDimensions: number | null = null;
    let db: DatabaseHandle;
    port.on("message", (reply: AutoSearchEmbeddingReply) => {
        if (reply.jobId !== input.jobId) return;
        // Backfill's busy-host gate is owner state, not this worker's empty activity
        // tracker. Refresh it when an embedding continuation is about to resume SQL.
        if (reply.embeddingHostBusy !== undefined)
            setEmbeddingSessionBusy(input.sessionId, reply.embeddingHostBusy);
        const vector = reply.result instanceof Float32Array ? reply.result : reply.result?.vector;
        if (vector) queryDimensions = vector.length;
        pending.get(reply.id)?.(reply);
        pending.delete(reply.id);
    });
    function request(
        message:
            | Omit<Extract<AutoSearchWorkerReply, { kind: "query" }>, "id">
            | Omit<Extract<AutoSearchWorkerReply, { kind: "batch" }>, "id">,
    ): Promise<AutoSearchEmbeddingReply> {
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, (reply) =>
                reply.error ? reject(new Error(reply.error)) : resolve(reply),
            );
            post({ ...message, id });
        });
    }
    // Reuse the connection and decoded-vector pool between jobs; install each job's
    // embedding snapshot and reset its query dimensions before running search.
    db = new Database(input.path, input.job === "backfill" ? undefined : { readonly: true });
    db.exec("PRAGMA busy_timeout = 250");
    // The owner disposes this worker by asking it to close: the connection must be
    // closed here, before the thread ends, or Bun 1.4.4's teardown blocks the
    // owner's next write (see worker-shutdown.ts).
    const { closePort } = exitOnWorkerClose(port, () => db.close());

    /**
     * How often a pooled search worker checks whether the sessions it searched have
     * new or changed history-chunk vectors, and decodes them into its pool. This is
     * what keeps the pool warm between turns: after a compartment is published or
     * its vectors are written, the next check picks the rows up, so the next hint
     * finds the pool warm. Between full metadata probes (at most one a minute per
     * session), a check that finds nothing new costs one index-only count per
     * session.
     */
    const CHUNK_POOL_MAINTENANCE_INTERVAL_MS = 5_000;
    let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
    let maintaining = false;
    function maintainChunkPools(): void {
        if (maintaining) return;
        maintaining = true;
        void maintainCompartmentChunkSearchPools(db)
            .catch(() => {})
            .finally(() => {
                maintaining = false;
            });
    }
    /** Start the periodic check once this worker has served a search, and run one now. */
    function scheduleChunkPoolMaintenance(): void {
        if (!persistent) return;
        if (!maintenanceTimer) {
            maintenanceTimer = setInterval(maintainChunkPools, CHUNK_POOL_MAINTENANCE_INTERVAL_MS);
            // Never keep the worker alive on its own; the owner decides its lifetime.
            maintenanceTimer.unref?.();
        }
        setTimeout(maintainChunkPools, 0);
    }

    async function run(jobInput: AutoSearchWorkerInput): Promise<void> {
        input = jobInput;
        queryDimensions = null;
        setEmbeddingSessionBusy(input.sessionId, input.embeddingHostBusy === true);
        if (input.snapshot) {
            installProjectEmbeddingSearchBridge(input.snapshot, {
                modelId: input.snapshot.modelId,
                initialize: async () => true,
                isLoaded: () => true,
                dispose: async () => {},
                embed: async (text) => {
                    const result = (await request({ kind: "query", text })).result;
                    return result instanceof Float32Array ? result : (result?.vector ?? null);
                },
                embedBatch: async (texts, _signal, purpose = "passage") => {
                    const passage = (await request({ kind: "batch", texts, purpose })).passage;
                    const captured = input.snapshot;
                    if (
                        !passage ||
                        !captured ||
                        passage.generation !== captured.generation ||
                        passage.modelId !== captured.modelId ||
                        passage.providerIdentity !== captured.providerIdentity ||
                        passage.runtimeFingerprint !== captured.runtimeFingerprint ||
                        !queryDimensions ||
                        passage.dimensions !== queryDimensions ||
                        passage.vectors.length !== texts.length
                    )
                        return texts.map(() => null);
                    return passage.vectors.map((vector) =>
                        vector && vector.length === queryDimensions && vector.every(Number.isFinite)
                            ? vector
                            : null,
                    );
                },
            });
        }
        // Search is enforced read-only by SQLite, not just by a caller convention.
        // Only the separate backfill job may open a writable connection.
        try {
            if (input.job === "backfill") {
                if (input.snapshot?.enabled && input.snapshot.features.memoryEnabled) {
                    // Capture query dimensions before the passage RPC so incompatible batches
                    // can never be stored under the captured model's namespace.
                    await request({ kind: "query", text: input.query });
                    if (queryDimensions) {
                        const existingEmbeddings = getProjectEmbeddings(
                            db,
                            input.projectPath,
                            input.snapshot.modelId,
                        );
                        const memories = getMemoriesByProject(db, input.projectPath)
                            .filter((memory) => !existingEmbeddings.has(memory.id))
                            .slice(0, 50);
                        await ensureMemoryEmbeddings({
                            db,
                            projectIdentity: input.projectPath,
                            memories,
                            existingEmbeddings,
                        });
                    }
                }
                post({ kind: "result", results: [] });
            } else if (input.job === "messages") {
                if (!input.messageRequest) throw new Error("message search job carries no request");
                const outcome = searchMessageHistory(db, input.messageRequest);
                post({ kind: "messages", outcome });
            } else {
                const jobStarted = performance.now();
                const steps: UnifiedSearchStepTimings = {};
                const diagnostics = input.options.autoSearchDiagnostics;
                const results = await unifiedSearch(
                    db,
                    input.sessionId,
                    input.projectPath,
                    input.query,
                    {
                        ...input.options,
                        backfillMemoryEmbeddings: false,
                        countRetrievals: false,
                        measurementDisabled: true,
                        embedQuery: async (text) =>
                            (await request({ kind: "query", text })).result ?? null,
                        isEmbeddingRuntimeEnabled: () => input.embeddingRuntimeEnabled,
                        stepTimings: steps,
                        onAutoSearchDiagnostics: diagnostics
                            ? () =>
                                  port.postMessage({
                                      kind: "diagnostics",
                                      diagnostics,
                                      jobId: jobInput.jobId,
                                  } satisfies AutoSearchWorkerReply)
                            : undefined,
                    },
                );
                post({
                    kind: "result",
                    results,
                    timings: {
                        steps,
                        jobMs: performance.now() - jobStarted,
                        lastPoolWarm: getLastCompartmentChunkPoolWarm(),
                    },
                } satisfies AutoSearchWorkerReply);
                scheduleChunkPoolMaintenance();
            }
        } catch (error) {
            post({
                kind: "error",
                error: error instanceof Error ? error.message : String(error),
            } satisfies AutoSearchWorkerReply);
        } finally {
            setEmbeddingSessionBusy(input.sessionId, false);
            if (!persistent) {
                db.close();
                // Removes the close listener before closing the port: Bun 1.3.14
                // keeps the thread alive otherwise.
                closePort();
            }
        }
    }

    // The client leases one job at a time. When the owner stops waiting at a
    // deadline it keeps the lease until this job has replied, so live jobs never
    // share the module-level input, query dimensions or embedding bridge. Pool
    // maintenance reads only the connection and its own arguments.
    port.on("message", (message: { kind?: string; input?: AutoSearchWorkerInput }) => {
        if (message.kind === "run" && message.input) void run(message.input);
    });
    // Start the first job without awaiting it so this module finishes evaluating.
    // run() waits for parent embedding replies, and some Bun releases (1.3.14
    // confirmed) deliver no parent message to a worker whose entry module is still
    // evaluating, so a top-level `await` here would wait forever for the first
    // reply. A failure is rethrown from a timer so it still reaches the parent as
    // the worker's "error" event, as a rejected top-level await did. (A microtask
    // rethrow aborts the whole process on Bun 1.3.14.)
    await run(input);
});
