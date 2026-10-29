/**
 * Worker entry for the canonical-ordinal warm-up: scans one OpenCode session's
 * messages for compaction-summary rows on its own read-only connection, so the
 * serving thread never reads a whole session's message JSON. See
 * `raw-ordinal-warmup.ts` for the caller.
 */
import { parentPort, workerData } from "node:worker_threads";
import { exitOnWorkerClose } from "../../shared/worker-shutdown";
import type { RawOrdinalWarmupInput, RawOrdinalWarmupReply } from "./raw-ordinal-warmup";

if (!parentPort) throw new Error("raw ordinal warm-up worker requires a parent port");
const port = parentPort;
const input = workerData as RawOrdinalWarmupInput;
// Report that the thread runs before importing the SQLite and scan modules, so
// the caller's first deadline only has to cover thread start.
port.postMessage({ kind: "accepted" } satisfies RawOrdinalWarmupReply);
// Every connection this job has open. When the owner stops the job early it asks
// this worker to close them and exit, instead of terminating the thread with a
// connection open (see worker-shutdown.ts). The request is read between awaits;
// a synchronous scan finishes first.
const openConnections = new Set<{ close(): void }>();
const { closePort } = exitOnWorkerClose(port, () => {
    for (const connection of openConnections) {
        try {
            connection.close();
        } catch {
            // The thread exits next either way; keep closing the others.
        }
    }
});

// The job runs outside module evaluation so the close request above can arrive
// during its awaits: some Bun releases (1.3.14 confirmed) deliver no parent
// message to a worker until its entry module has finished evaluating. A failure
// outside the job's own try/catch (a module that fails to load) is rethrown
// from a timer so it still reaches the owner as the worker's "error" event. (A
// microtask rethrow aborts the whole process on Bun 1.3.14.)
main().catch((error: unknown) => {
    setTimeout(() => {
        throw error;
    });
});

async function main(): Promise<void> {
    const [
        { Database, registerSqliteDiagnosticSink },
        { readRawSessionMessageIdsAtOrdinalsFromDb, scanRawSessionSummaryRows },
        { getHarness, setHarness },
        { log },
    ] = await Promise.all([
        import("../../shared/sqlite"),
        import("./read-session-raw"),
        import("../../shared/harness"),
        import("../../shared/logger"),
    ]);
    setHarness(input.harness ?? "opencode");
    registerSqliteDiagnosticSink(log, getHarness);
    let db: InstanceType<typeof Database> | undefined;
    let reply: RawOrdinalWarmupReply;
    try {
        // The imports above may still be loading after the parent requests termination.
        // Check shared cancellation before opening SQLite; termination itself is asynchronous.
        if (
            input.openCancellation &&
            Atomics.load(new Int32Array(input.openCancellation), 0) !== 0
        ) {
            throw new Error("warm-up owner closed before database open");
        }
        db =
            input.indexMessage || input.ftsRowidBackfill
                ? new Database(input.path)
                : new Database(input.path, { readonly: true });
        openConnections.add(db);
        db.exec("PRAGMA busy_timeout = 250");
        if (input.ftsRowidBackfill) {
            const { runMessageFtsRowidMapBackfill } = await import(
                "../../features/magic-context/message-fts-rowid-map"
            );
            // Startup reschedules transient SQLite contention; fail fast instead of waiting for the writer.
            db.exec("PRAGMA busy_timeout = 0");
            await runMessageFtsRowidMapBackfill(db);
            reply = { kind: "fts-rowid-backfill" };
        } else if (input.searchArchive) {
            const { renderSearchArchive } = await import("../../tools/ctx-expand/search-archive");
            const { readRawSessionMessageIdOrdinalsForRangeFromDb } = await import(
                "./read-session-raw"
            );
            const archive = input.searchArchive;
            let raw: InstanceType<typeof Database> | undefined;
            try {
                reply = {
                    kind: "search-archive",
                    text: renderSearchArchive(
                        db,
                        input.sessionId,
                        archive.start,
                        archive.end,
                        archive.tokenBudget,
                        archive.archiveOnly,
                        () => {
                            if (!archive.rawPath) return new Map(archive.rawIds);
                            raw = new Database(archive.rawPath, { readonly: true });
                            openConnections.add(raw);
                            raw.exec("PRAGMA busy_timeout = 250");
                            return readRawSessionMessageIdOrdinalsForRangeFromDb(
                                raw,
                                input.sessionId,
                                archive.start,
                                archive.end,
                            );
                        },
                    ),
                };
            } finally {
                if (raw) openConnections.delete(raw);
                raw?.close();
            }
        } else if (input.exactOrdinalIds) {
            reply = {
                kind: "exact-ordinal-ids",
                ids: readRawSessionMessageIdsAtOrdinalsFromDb(
                    db,
                    input.sessionId,
                    input.exactOrdinalIds,
                ),
            };
        } else if (input.indexMessage) {
            const { setHarness } = await import("../../shared/harness");
            setHarness(input.harness ?? "opencode");
            const [{ indexMessageInShortChunks }, { configureContextDatabasePragmas }] =
                await Promise.all([
                    import("../../features/magic-context/message-index-bounded"),
                    import("../../shared/sqlite-context-pragmas"),
                ]);
            configureContextDatabasePragmas(db);
            const writer = db;
            const message = input.indexMessage;
            const cancellation = input.indexCancellation
                ? new Int32Array(input.indexCancellation)
                : undefined;
            const result = await indexMessageInShortChunks(
                writer,
                input.sessionId,
                message,
                input,
                () => !cancellation || Atomics.load(cancellation, 0) === 0,
            );
            reply = {
                kind: "indexed",
                inserted: result.inserted,
                measurements: result.measurements,
            };
        } else if (input.tagRatio !== undefined) {
            const { scanTagOwnerSummary, scanTagOwnerDelta } = await import(
                "../../features/magic-context/storage-tags"
            );
            const delta = input.tagState
                ? scanTagOwnerDelta(db, input.sessionId, input.tagState)
                : null;
            if (delta) reply = { kind: "tag-delta", delta };
            else
                reply = {
                    kind: "tag-summary",
                    summary: scanTagOwnerSummary(
                        db,
                        input.sessionId,
                        input.tagRatio,
                        input.tagRatios,
                    ),
                };
        } else {
            const scan = scanRawSessionSummaryRows(db, input.sessionId, input.previous);
            reply = { kind: "scan", scan };
        }
    } catch (error) {
        const sqliteError = error as { code?: unknown; errcode?: unknown } | null;
        reply = {
            kind: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            code: typeof sqliteError?.code === "string" ? sqliteError.code : undefined,
            errcode: typeof sqliteError?.errcode === "number" ? sqliteError.errcode : undefined,
        };
    } finally {
        if (db) openConnections.delete(db);
        db?.close();
    }
    // Release SQLite before publishing: the host may stop the worker on receipt.
    port.postMessage(reply);
    // Removes the close listener before closing the port: Bun 1.3.14 keeps the
    // thread alive otherwise.
    closePort();
}
