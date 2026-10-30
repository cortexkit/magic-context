import { type MessagePort, Worker } from "node:worker_threads";
import { registerExitAbort } from "../../shared/exit-abort-registry";
import { inRootAsyncContext } from "../../shared/sqlite";
import { createWorkerShutdown, type WorkerShutdown } from "../../shared/worker-shutdown";

type ArchiveRead =
    | { kind: "archive"; start: number; end: number; tokenBudget: number; archiveOnly: boolean }
    | { kind: "tag"; tag: number };

interface Request {
    kind: "v2-archive-read";
    id: number;
    path: string;
    rawPath: string;
    sessionId: string;
    read: ArchiveRead;
}

type Reply =
    | { kind: "v2-archive-ready" }
    | { kind: "v2-archive-result"; id: number; text: string | null; error?: string };

interface Pending {
    resolve(text: string | null): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | undefined;
let shutdown: WorkerShutdown | undefined;
let ready: Promise<void> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let startingTimer: ReturnType<typeof setTimeout> | undefined;
let rejectStart: ((error: Error) => void) | undefined;
let nextId = 0;
let exitRegistered = false;
const pending = new Map<number, Pending>();

/** Drop the reader and its revision-bound anchors on shutdown or worker failure. */
export async function stopV2ArchiveReader(): Promise<void> {
    const closing = shutdown;
    worker = undefined;
    shutdown = undefined;
    ready = undefined;
    clearTimeout(idle);
    clearTimeout(startingTimer);
    rejectStart?.(new Error("Search archive worker unavailable: reader stopped"));
    rejectStart = undefined;
    for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("Search archive worker unavailable: reader stopped"));
    }
    pending.clear();
    await closing?.close();
}

function start(): Promise<void> {
    if (ready) return ready;
    if (!exitRegistered) {
        exitRegistered = true;
        const controller = new AbortController();
        controller.signal.addEventListener(
            "abort",
            () => {
                void stopV2ArchiveReader();
            },
            { once: true },
        );
        registerExitAbort(controller);
    }
    ready = new Promise<void>((resolve, reject) => {
        rejectStart = reject;
        const entry = new URL(
            import.meta.url.endsWith(".ts")
                ? "../../hooks/magic-context/raw-ordinal-warmup-worker.ts"
                : "./raw-ordinal-warmup-worker.js",
            import.meta.url,
        );
        const current = inRootAsyncContext(
            () => new Worker(entry, { workerData: { v2ArchiveReader: true } }),
        );
        worker = current;
        shutdown = createWorkerShutdown(current, "v2-archive-reader", 2_000);
        current.unref();
        const fail = (detail: string) => {
            if (worker !== current) return;
            clearTimeout(startingTimer);
            reject(new Error(`Search archive worker unavailable: ${detail}`));
            void stopV2ArchiveReader();
        };
        startingTimer = setTimeout(() => fail("reader did not start"), 10_000);
        startingTimer.unref?.();
        current.on("error", (error) => fail(String(error)));
        current.on("exit", (code) => fail(`exit code ${code}`));
        current.on("message", (reply: Reply) => {
            if (worker !== current) return;
            if (reply.kind === "v2-archive-ready") {
                clearTimeout(startingTimer);
                rejectStart = undefined;
                resolve();
            } else if (reply.kind === "v2-archive-result") {
                const item = pending.get(reply.id);
                if (!item) return;
                pending.delete(reply.id);
                clearTimeout(item.timer);
                if (reply.error)
                    item.reject(new Error(`Search archive worker unavailable: ${reply.error}`));
                else item.resolve(reply.text);
                if (pending.size === 0) {
                    idle = setTimeout(() => {
                        void stopV2ArchiveReader();
                    }, 60_000);
                    idle.unref?.();
                }
            }
        });
    });
    return ready;
}

/** A persistent read-only worker amortizes cold seq indexing across expansions. */
export async function readV2ArchiveOffThread(
    path: string,
    rawPath: string,
    sessionId: string,
    read: ArchiveRead,
): Promise<string | null> {
    try {
        clearTimeout(idle);
        await start();
        const current = worker;
        if (!current) throw new Error("Search archive worker unavailable: reader stopped");
        return await new Promise<string | null>((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
                void stopV2ArchiveReader();
            }, 10 * 60_000);
            timer.unref?.();
            pending.set(id, { resolve, reject, timer });
            try {
                current.postMessage({
                    kind: "v2-archive-read",
                    id,
                    path,
                    rawPath,
                    sessionId,
                    read,
                } satisfies Request);
            } catch {
                void stopV2ArchiveReader();
            }
        });
    } catch (error) {
        await stopV2ArchiveReader();
        if (
            error instanceof Error &&
            error.message.startsWith("Search archive worker unavailable:")
        )
            throw error;
        throw new Error(`Search archive worker unavailable: ${String(error)}`);
    }
}

/** Worker-side only. The store-reader pool stays open across requests;
 * each request opens the search archive and tag database read-only. */
export async function serveV2ArchiveReads(
    port: MessagePort,
    openConnections: Set<{ close(): void }>,
): Promise<void> {
    const [
        { Database },
        { V2StoreReaderPool },
        { createV2RawMessageReader, createV2RawMessageProvider },
        { setBoundedRawMessageProvider },
        { renderItemByTag },
        { renderSearchArchive },
    ] = await Promise.all([
        import("../../shared/sqlite"),
        import("../../v2/store-reader"),
        import("../../v2/hooks/store"),
        import("../../hooks/magic-context/read-session-chunk"),
        import("./render"),
        import("./search-archive"),
    ]);
    const pool = new V2StoreReaderPool();
    openConnections.add(pool);
    port.on("message", (request: Request) => {
        if (request.kind !== "v2-archive-read") return;
        let db: InstanceType<typeof Database> | undefined;
        let unregister: (() => void) | undefined;
        let reply: Reply;
        try {
            db = new Database(request.path, { readonly: true, fileMustExist: true });
            openConnections.add(db);
            db.exec("PRAGMA busy_timeout = 250");
            const reader = createV2RawMessageReader(() => pool.open(request.rawPath));
            unregister = setBoundedRawMessageProvider(
                request.sessionId,
                createV2RawMessageProvider(reader, request.sessionId),
            );
            const read = request.read;
            const text =
                read.kind === "tag"
                    ? renderItemByTag(db, request.sessionId, read.tag)
                    : renderSearchArchive(
                          db,
                          request.sessionId,
                          read.start,
                          read.end,
                          read.tokenBudget,
                          read.archiveOnly,
                          () => reader.ordinalMapForRange(request.sessionId, read.start, read.end),
                      );
            reply = { kind: "v2-archive-result", id: request.id, text };
        } catch (error) {
            reply = { kind: "v2-archive-result", id: request.id, text: null, error: String(error) };
        } finally {
            unregister?.();
            if (db) openConnections.delete(db);
            db?.close();
        }
        port.postMessage(reply);
    });
    port.postMessage({ kind: "v2-archive-ready" } satisfies Reply);
}
