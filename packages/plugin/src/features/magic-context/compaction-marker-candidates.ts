import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { registerExitAbort } from "../../shared/exit-abort-registry";
import { log } from "../../shared/logger";
import { reuseWorker } from "../../shared/reusable-worker";
import { type Database, getSqliteDatabasePath } from "../../shared/sqlite";
import { createWorkerShutdown } from "../../shared/worker-shutdown";

interface MarkerFrontier {
    rowid: number;
    id: string;
}
export interface MarkerCandidateSnapshot {
    ids: string[];
    frontier: MarkerFrontier | null;
}
export interface MarkerCandidateBasis extends MarkerCandidateSnapshot {
    connection: Database;
    sessionId: string;
    revisionKey: string;
    ownWriteRevision: number;
}
export interface MarkerCandidatePreparationOptions {
    entry?: URL;
    acceptMs?: number;
    resultMs?: number;
}
export type MarkerCandidateReply =
    | { kind: "accepted" }
    | { kind: "candidates"; snapshot: MarkerCandidateSnapshot }
    | { kind: "error"; error: string };

const candidates = new WeakMap<Database, Map<string, MarkerCandidateBasis>>();
const pending = new WeakMap<Database, Map<string, Promise<boolean>>>();
const workers = new Set<Worker>();
const missingWorkerWarnings = new Set<string>();
const ownWriteRevisions = new Map<string, number>();
let exitRegistered = false;

function reportWorkerUnavailable(entry: URL, detail: string): void {
    if (missingWorkerWarnings.has(entry.href)) return;
    missingWorkerWarnings.add(entry.href);
    const path = entry.protocol === "file:" ? fileURLToPath(entry) : entry.href;
    log(
        `[magic-context] [ERROR] compaction-marker: candidate worker unavailable ${path}: ${detail}; marker unchanged, advancement deferred`,
    );
}

export const MARKER_CERTIFICATION_SQL = `SELECT
    (SELECT rowid FROM message WHERE id = ?) AS previousRowid,
    (SELECT rowid FROM message ORDER BY rowid DESC LIMIT 1) AS newestRowid,
    (SELECT id FROM message ORDER BY rowid DESC LIMIT 1) AS newestId,
    EXISTS(SELECT 1 FROM message
      WHERE rowid > ? AND +session_id = ? AND json_valid(data)
        AND COALESCE(json_extract(data, '$.summary'), 0) = 1) AS newSummary`;

export function isMarkerCandidateBasisCurrent(db: Database, basis: MarkerCandidateBasis): boolean {
    if (
        basis.connection !== db ||
        ownWriteRevisions.get(basis.revisionKey) !== basis.ownWriteRevision
    )
        return false;
    try {
        // The worker saved IDs of rows already marked summary=true and the highest
        // SQLite rowid it saw. Normal OpenCode 1.19.x summary writers and 2.0.x
        // compaction writers insert fresh IDs, giving new summaries higher rowids.
        // Our own in-place summary upserts invalidate the saved candidate list.
        // Arbitrary external SQL turning an old ordinary row into a summary is not
        // supported. Before deleting any candidate, cleanup looks up its ID and
        // rechecks its summary flag, parent, finish status and exact text: edits to
        // known candidates therefore cannot delete unrelated messages or parts.
        const current = db
            .prepare(MARKER_CERTIFICATION_SQL)
            .get(basis.frontier?.id ?? null, basis.frontier?.rowid ?? 0, basis.sessionId) as {
            previousRowid: number | null;
            newestRowid: number | null;
            newestId: string | null;
            newSummary: number;
        };
        if (
            current.newSummary ||
            (basis.frontier &&
                (current.previousRowid !== basis.frontier.rowid ||
                    current.newestRowid === null ||
                    current.newestRowid < basis.frontier.rowid))
        )
            return false;
        if (
            current.newestRowid !== null &&
            (!Number.isSafeInteger(current.newestRowid) || current.newestId === null)
        )
            return false;
        // The saved rowid/ID pair, later inserts and newest row share one SQLite
        // statement snapshot. Remembering the newest row lets the next certification
        // start after the ordinary messages already checked.
        basis.frontier =
            current.newestRowid === null || current.newestId === null
                ? null
                : { rowid: current.newestRowid, id: current.newestId };
        return true;
    } catch {
        return false;
    }
}

export function invalidateMarkerCandidateBasis(db: Database, sessionId: string): void {
    candidates.get(db)?.delete(sessionId);
    const path = getSqliteDatabasePath(db);
    if (!path) return;
    const key = `${realpathSync(path)}\0${sessionId}`;
    const revision = ownWriteRevisions.get(key);
    if (revision !== undefined) ownWriteRevisions.set(key, revision + 1);
}
export function readMarkerCandidateBasis(
    db: Database,
    sessionId: string,
): MarkerCandidateBasis | undefined {
    const basis = candidates.get(db)?.get(sessionId);
    if (basis && isMarkerCandidateBasisCurrent(db, basis)) return basis;
    candidates.get(db)?.delete(sessionId);
    return undefined;
}

/** Discover summary IDs off-thread. Defer cleanup if a new summary appears or the
 * last scanned row is deleted or assigned a different rowid. Ordinary message
 * updates and appends do not invalidate the discovered summary IDs. */
export function prepareMarkerCandidateBasis(
    db: Database,
    sessionId: string,
    options: MarkerCandidatePreparationOptions = {},
): Promise<boolean> {
    if (readMarkerCandidateBasis(db, sessionId)) return Promise.resolve(true);
    const path = getSqliteDatabasePath(db);
    if (!path || db.inTransaction) return Promise.resolve(false);
    const active = pending.get(db) ?? new Map<string, Promise<boolean>>();
    const existing = active.get(sessionId);
    if (existing) return existing;
    const revisionKey = `${realpathSync(path)}\0${sessionId}`;
    const ownWriteRevision = ownWriteRevisions.get(revisionKey) ?? 0;
    ownWriteRevisions.set(revisionKey, ownWriteRevision);
    const entry = options.entry ?? markerWorkerEntry();
    if (entry.protocol === "file:" && !existsSync(fileURLToPath(entry))) {
        reportWorkerUnavailable(entry, "file missing");
        return Promise.resolve(false);
    }
    const preparation = runCandidateWorker(path, sessionId, options)
        .then((snapshot) => {
            if (!snapshot) return false;
            const basis: MarkerCandidateBasis = {
                ...snapshot,
                connection: db,
                sessionId,
                revisionKey,
                ownWriteRevision,
            };
            if (!isMarkerCandidateBasisCurrent(db, basis)) {
                candidates.get(db)?.delete(sessionId);
                log(
                    `[magic-context] compaction-marker: deferred candidate preparation for ${sessionId}: summary set or frontier changed during discovery; marker unchanged`,
                );
                return false;
            }
            const sessions = candidates.get(db) ?? new Map<string, MarkerCandidateBasis>();
            sessions.set(sessionId, basis);
            candidates.set(db, sessions);
            return true;
        })
        .finally(() => {
            if (active.get(sessionId) === preparation) active.delete(sessionId);
        });
    active.set(sessionId, preparation);
    pending.set(db, active);
    return preparation;
}

function markerWorkerEntry(): URL {
    return new URL(
        new URL(import.meta.url).pathname.endsWith(".ts")
            ? "./compaction-marker-candidates-worker.ts"
            : "./compaction-marker-candidates-worker.js",
        import.meta.url,
    );
}

function runCandidateWorker(
    path: string,
    sessionId: string,
    options: MarkerCandidatePreparationOptions,
): Promise<MarkerCandidateSnapshot | undefined> {
    if (!exitRegistered) {
        exitRegistered = true;
        const controller = new AbortController();
        controller.signal.addEventListener(
            "abort",
            () => {
                for (const worker of workers) {
                    void worker.terminate();
                    worker.unref();
                }
            },
            { once: true },
        );
        registerExitAbort(controller);
    }
    return new Promise((resolve) => {
        const entry = options.entry ?? markerWorkerEntry();
        let worker: Worker | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let done = false;
        const finish = (snapshot?: MarkerCandidateSnapshot) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (!worker) {
                resolve(snapshot);
                return;
            }
            workers.delete(worker);
            const stopped = snapshot
                ? createWorkerShutdown(worker, "marker-candidates", 1_000).close()
                : worker.terminate();
            worker.unref();
            void stopped.then(
                () => resolve(snapshot),
                () => resolve(snapshot),
            );
        };
        const deadline = (ms: number) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                reportWorkerUnavailable(entry, "worker deadline exceeded");
                finish();
            }, ms);
            timer.unref?.();
        };
        try {
            worker = inRootAsyncContext(() =>
                options.entry
                    ? new Worker(entry, { workerData: { path, sessionId } })
                    : reuseWorker(entry, { workerData: { path, sessionId } }),
            );
            workers.add(worker);
            worker.unref();
            deadline(options.acceptMs ?? 2000);
            worker.on("message", (reply: MarkerCandidateReply) => {
                if (reply.kind === "accepted") deadline(options.resultMs ?? 600000);
                else if (reply.kind === "candidates") finish(reply.snapshot);
                else {
                    reportWorkerUnavailable(entry, reply.error);
                    finish();
                }
            });
            worker.on("error", (error) => {
                reportWorkerUnavailable(entry, error.message);
                finish();
            });
            worker.on("exit", (code) => {
                if (!done)
                    reportWorkerUnavailable(entry, `worker exited before replying (${code})`);
                finish();
            });
        } catch (error) {
            reportWorkerUnavailable(entry, error instanceof Error ? error.message : String(error));
            finish();
        }
    });
}

/** Find all messages with the summary flag on a worker. Marker cleanup then
 * checks each ID's parent, completion status and exact text before deleting it.
 * Do not filter by creation time: imported or rewritten legacy summaries can
 * precede their parent even though the original writer used later timestamps. */
export function scanMarkerSummaryCandidates(db: Database, sessionId: string): string[] {
    const ownsSnapshot = !db.inTransaction;
    if (ownsSnapshot) db.exec("BEGIN");
    try {
        return (
            db
                .prepare(`SELECT id FROM message WHERE session_id=? AND
            CASE WHEN json_valid(data) THEN COALESCE(json_extract(data,'$.summary'),0) ELSE 0 END=1`)
                .all(sessionId) as { id: string }[]
        ).map((row) => row.id);
    } finally {
        if (ownsSnapshot) db.exec("ROLLBACK");
    }
}

/** Read summary IDs and the newest row in one snapshot, so an insert between
 * those reads cannot be skipped by the next rowid-based certification. */
export function scanMarkerCandidateSnapshot(
    db: Database,
    sessionId: string,
): MarkerCandidateSnapshot {
    const ownsSnapshot = !db.inTransaction;
    if (ownsSnapshot) db.exec("BEGIN");
    try {
        const ids = scanMarkerSummaryCandidates(db, sessionId);
        const frontier = (db
            .prepare("SELECT rowid,id FROM message ORDER BY rowid DESC LIMIT 1")
            .get() ?? null) as MarkerFrontier | null;
        if (frontier && !Number.isSafeInteger(frontier.rowid))
            throw new Error("marker frontier rowid is not a safe integer");
        return { ids, frontier };
    } finally {
        if (ownsSnapshot) db.exec("ROLLBACK");
    }
}

import { inRootAsyncContext } from "../../shared/sqlite";
