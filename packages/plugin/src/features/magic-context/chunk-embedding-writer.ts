import { getHarness } from "../../shared/harness";
import { reuseWorker } from "../../shared/reusable-worker";
import { type Database, getSqliteDatabasePath, inRootAsyncContext } from "../../shared/sqlite";
import { createWorkerShutdown } from "../../shared/worker-shutdown";
import type {
    CompartmentChunkBackfillCandidate,
    SaveCompartmentChunkEmbeddingInput,
} from "./compartment-chunk-embedding";
import type { acquireGitSweepLease } from "./git-commits/sweep-coordinator";
import { isSynapseEmbeddingTruncated } from "./memory/embedding-synapse";

export interface ChunkEmbeddingWrite {
    kind: "replace";
    rows: SaveCompartmentChunkEmbeddingInput[];
    sourceKey: string;
}

export type ChunkEmbeddingWorkerRequest =
    | ChunkEmbeddingWrite
    | { kind: "project"; project: string; session: string }
    | { kind: "count"; project: string; session: string; model: string; tokens: number }
    | {
          kind: "candidates";
          project: string;
          session: string;
          model: string;
          tokens: number;
          limit: number;
          excluded: number[];
      }
    | {
          kind: "backoff";
          candidate: CompartmentChunkBackfillCandidate;
          project: string;
          model: string;
      }
    | { kind: "acquire" | "renew" | "release"; project: string; holder: string };

/** Keep disk commits off the host event loop; a filesystem flush can exceed any CPU slice. */
export function createChunkEmbeddingWriter(db: Database) {
    const path = getSqliteDatabasePath(db);
    if (!path) return null;
    if (path.startsWith("file:"))
        throw new Error("chunk embedding writer requires a filesystem path");
    const entry = new URL(
        import.meta.url.endsWith(".ts")
            ? "./chunk-embedding-write-worker.ts"
            : "./chunk-embedding-write-worker.js",
        import.meta.url,
    );
    const timeout = (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    const worker = inRootAsyncContext(() =>
        reuseWorker(entry, { workerData: { path, harness: getHarness(), timeout } }),
    );
    // The worker reads the close request between operations. One operation may
    // first wait up to this connection's busy timeout for the writer lock and
    // then write a batch of vectors, so allow that wait plus a margin before
    // terminating it.
    const shutdown = createWorkerShutdown(worker, "chunk-embedding-writer", timeout + 2_000);
    let pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
    let failure: Error | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    worker.on("message", (reply: { error?: string; value?: unknown }) => {
        clearTimeout(deadline);
        const request = pending;
        pending = undefined;
        if (reply.error) request?.reject(new Error(reply.error));
        else request?.resolve(reply.value);
    });
    const fail = (error: Error) => {
        clearTimeout(deadline);
        failure = error;
        pending?.reject(error);
        pending = undefined;
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`chunk embedding writer exited (${code})`)));
    worker.unref();
    // Renewal timers may arrive during a write. Serialize their requests instead
    // of moving SQLite lease updates back onto the host event loop.
    let queue: Promise<unknown> = Promise.resolve();
    const request = <T>(message: ChunkEmbeddingWorkerRequest): Promise<T> => {
        const result = queue.then(() => {
            if (failure) throw failure;
            return new Promise<unknown>((resolve, reject) => {
                pending = { resolve, reject };
                deadline = inRootAsyncContext(() =>
                    setTimeout(() => {
                        fail(
                            new Error(
                                "chunk embedding database operation timed out; coverage will be rechecked",
                            ),
                        );
                        void shutdown.close();
                    }, 30_000),
                );
                deadline.unref();
                worker.postMessage(message);
            });
        });
        queue = result.catch(() => {});
        return result as Promise<T>;
    };
    return {
        async replace(
            rows: SaveCompartmentChunkEmbeddingInput[],
            sourceKey: string,
        ): Promise<void> {
            // Truncation evidence is held in a WeakMap and cannot survive structured cloning.
            if (rows.some((row) => isSynapseEmbeddingTruncated(row.vector))) return;
            await request<void>({ kind: "replace", rows, sourceKey });
        },
        project: (project: string, session: string) =>
            request<void>({ kind: "project", project, session }),
        count: (project: string, session: string, model: string, tokens: number) =>
            request<number>({ kind: "count", project, session, model, tokens }),
        candidates: (
            project: string,
            session: string,
            model: string,
            limit: number,
            excluded: number[],
            tokens: number,
        ) =>
            request<CompartmentChunkBackfillCandidate[]>({
                kind: "candidates",
                project,
                session,
                model,
                limit,
                excluded,
                tokens,
            }),
        backoff: (candidate: CompartmentChunkBackfillCandidate, project: string, model: string) =>
            request<void>({ kind: "backoff", candidate, project, model }),
        acquire: (project: string, holder: string) =>
            request<ReturnType<typeof acquireGitSweepLease>>({ kind: "acquire", project, holder }),
        renew: (project: string, holder: string) =>
            request<boolean>({ kind: "renew", project, holder }),
        release: (project: string, holder: string) =>
            request<void>({ kind: "release", project, holder }),
        async close(): Promise<void> {
            clearTimeout(deadline);
            await shutdown.close();
        },
    };
}
