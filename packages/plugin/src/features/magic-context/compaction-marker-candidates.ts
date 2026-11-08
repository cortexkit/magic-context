import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { registerExitAbort } from "../../shared/exit-abort-registry";
import { log } from "../../shared/logger";
import { reuseWorker } from "../../shared/reusable-worker";
import { type Database, getSqliteDatabasePath } from "../../shared/sqlite";
import { createWorkerShutdown } from "../../shared/worker-shutdown";

export interface MarkerFrontier {
    rowid: number;
    id: string;
}
/** Compaction parts that may carry a tail_start_id, found by one full scan of
 * the session, and the newest part rows of that same read snapshot. A later read
 * rechecks these IDs by primary key and reads only parts inserted after a
 * certified frontier row, so it never rescans the session's old parts. */
export interface MarkerReferenceSeed {
    partIds: string[];
    partFrontiers: MarkerFrontier[];
}
export interface MarkerCandidateSnapshot {
    ids: string[];
    frontier: MarkerFrontier | null;
    /** Present when the preparation asked for reference discovery. */
    references?: MarkerReferenceSeed;
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
    /** Also scan the session for tail_start_id reference rows (default true). */
    references?: boolean;
    /** Run a custom `entry` on the shared worker pool, as the default entry runs.
     * The entry must then serve jobs through serveWorkerJobs. */
    shareWorker?: boolean;
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
    // Once per distinct failure: discovery now also starts in the background
    // after every move, and an unrelated failure (a store removed under a
    // queued scan) must not hide a later, different one.
    const key = `${entry.href}\0${detail}`;
    if (missingWorkerWarnings.has(key)) return;
    missingWorkerWarnings.add(key);
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
            .all(basis.frontier?.id ?? null, basis.frontier?.rowid ?? 0, basis.sessionId)[0] as {
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

/** Forget this session's prepared basis so the next preparation scans again. */
export function discardMarkerCandidateBasis(db: Database, sessionId: string): void {
    candidates.get(db)?.delete(sessionId);
}
export function readMarkerCandidateBasis(
    db: Database,
    sessionId: string,
    readConnection: Database = db,
): MarkerCandidateBasis | undefined {
    const basis = candidates.get(db)?.get(sessionId);
    if (basis) {
        // Certify on the caller's read snapshot without moving the candidate
        // cache to that connection. The writer must still certify its own basis
        // after BEGIN IMMEDIATE, when all intervening host writes are visible.
        const snapshot = readConnection === db ? basis : { ...basis, connection: readConnection };
        if (isMarkerCandidateBasisCurrent(readConnection, snapshot)) {
            basis.frontier = snapshot.frontier;
            return readConnection === db ? basis : { ...snapshot, connection: db };
        }
    }
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
    const preparation = runCandidateWorker(path, sessionId, options.references !== false, options)
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
    references: boolean,
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
            const pooled = !options.entry || options.shareWorker === true;
            worker = inRootAsyncContext(() =>
                pooled
                    ? reuseWorker(entry, { workerData: { path, sessionId, references } })
                    : new Worker(entry, { workerData: { path, sessionId, references } }),
            );
            workers.add(worker);
            worker.unref();
            // Marker jobs for one store share a worker thread and run one at a time,
            // and a session's part scan can take many seconds. Start a queued job's
            // accept deadline when the job starts (the lease's "online"), so waiting
            // behind another session's scan is not reported as a dead worker. The
            // running job's own result deadline bounds how long the queue can wait.
            if (pooled) worker.once("online", () => deadline(options.acceptMs ?? 2000));
            else deadline(options.acceptMs ?? 2000);
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
 * those reads cannot be skipped by the next rowid-based certification. With
 * `references`, the same snapshot also supplies the compaction parts and part
 * frontier that marker replacement would otherwise have to scan for on the
 * main thread. The part table is the expensive one: it holds every tool output
 * and text of the session. */
export function scanMarkerCandidateSnapshot(
    db: Database,
    sessionId: string,
    references = true,
): MarkerCandidateSnapshot {
    const ownsSnapshot = !db.inTransaction;
    if (ownsSnapshot) db.exec("BEGIN");
    try {
        const ids = scanMarkerSummaryCandidates(db, sessionId);
        const frontier = readMarkerFrontier(db, "message");
        if (!references) return { ids, frontier };
        return {
            ids,
            frontier,
            references: {
                partIds: readMarkerReferenceRows(db, sessionId, "part").map((row) => row.id),
                partFrontiers: readMarkerFrontiers(db, "part"),
            },
        };
    } finally {
        if (ownsSnapshot) db.exec("ROLLBACK");
    }
}

/** The newest row of a host table by rowid, or null when the table is empty. */
function readMarkerFrontier(db: Database, table: "part" | "message"): MarkerFrontier | null {
    // all() rather than get(): a cursor left mid-step can pin the read snapshot.
    const frontier =
        (
            db
                .prepare(`SELECT rowid,id FROM ${table} ORDER BY rowid DESC LIMIT 1`)
                .all() as Array<MarkerFrontier>
        )[0] ?? null;
    if (frontier && !Number.isSafeInteger(frontier.rowid))
        throw new Error(`marker ${table} frontier rowid is not a safe integer`);
    return frontier;
}

/** How many of the newest rows a reference snapshot records as frontier
 * candidates. One deleted row (our own marker retirement, a cleanup, a host
 * revert) then leaves a lower candidate to read above instead of forcing a
 * new discovery. */
export const MARKER_FRONTIER_CANDIDATES = 3;

/** The newest rows of a host table by rowid, newest first; empty when the table is. */
export function readMarkerFrontiers(
    db: Database,
    table: "part" | "message",
    count = MARKER_FRONTIER_CANDIDATES,
): MarkerFrontier[] {
    // all() rather than get(): a cursor left mid-step can pin the read snapshot.
    const frontiers = db
        .prepare(`SELECT rowid,id FROM ${table} ORDER BY rowid DESC LIMIT ?`)
        .all(count) as MarkerFrontier[];
    if (frontiers.some((frontier) => !Number.isSafeInteger(frontier.rowid)))
        throw new Error(`marker ${table} frontier rowid is not a safe integer`);
    return frontiers;
}

export const MARKER_REFERENCE_FRONTIER_SQL = (table: "part" | "message") =>
    `SELECT rowid FROM ${table} WHERE id = ?`;

/** The rowid above which every row inserted into `table` since `frontiers` were
 * read must lie, or undefined when no recorded candidate can prove that.
 *
 * SQLite gives a new row a rowid above the table's current maximum. While a
 * recorded row keeps its ID and rowid, the maximum never drops below it, so
 * every later insert lands above that row, even if newer recorded rows were
 * deleted and their rowids reused. The highest candidate that still maps to its
 * recorded rowid is therefore a safe floor. If every candidate was deleted or
 * renumbered, a later insert may have reused a lower rowid and a suffix read
 * could miss it. The summary basis certifies its message frontier by the same
 * rule. No candidates means the table was empty: every row present now is new. */
export function certifiedMarkerReferenceFloor(
    db: Database,
    table: "part" | "message",
    frontiers: readonly MarkerFrontier[],
): number | undefined {
    if (frontiers.length === 0) return 0;
    const probe = db.prepare(MARKER_REFERENCE_FRONTIER_SQL(table));
    for (const frontier of [...frontiers].sort((a, b) => b.rowid - a.rowid)) {
        const current = probe.all(frontier.id) as Array<{ rowid: number }>;
        if (current[0]?.rowid === frontier.rowid) return frontier.rowid;
    }
    return undefined;
}

export interface MarkerTailReference {
    id: string;
    direct: unknown;
    nested: unknown;
}

const MARKER_TAIL_REFERENCE_COLUMNS = `id,
    CASE WHEN data LIKE '%tail_start_id%' THEN json_extract(data, '$.tail_start_id') END AS direct,
    CASE WHEN data LIKE '%tail_start_id%' THEN json_extract(data, '$.compaction.tail_start_id') END AS nested`;

/** Without `afterRowid`, read every reference row of the session: a full scan.
 * For parts only the discovery worker runs it; the message scan stays on the
 * main thread, once per session per process. With `afterRowid`, read only rows
 * inserted after a certified frontier row; +session_id keeps SQLite on the
 * rowid range instead of the session index. */
export function readMarkerReferenceRows(
    db: Database,
    sessionId: string,
    table: "part" | "message",
    afterRowid?: number,
): MarkerTailReference[] {
    // Discovery must also remember compactions with no tail yet: the host can
    // publish their tail_start_id later by updating the same primary key.
    return db
        .prepare(
            `SELECT ${MARKER_TAIL_REFERENCE_COLUMNS} FROM ${table}
             WHERE ${afterRowid === undefined ? "session_id = ?" : "rowid > ? AND +session_id = ?"}
             AND ${table === "part" ? "data LIKE '%compaction%' AND json_valid(data) AND json_extract(data, '$.type') = 'compaction'" : "(data LIKE '%compaction%' OR data LIKE '%tail_start_id%') AND json_valid(data) AND (json_type(data, '$.compaction') IS NOT NULL OR json_type(data, '$.tail_start_id') IS NOT NULL)"}`,
        )
        .all(
            ...(afterRowid === undefined ? [sessionId] : [afterRowid, sessionId]),
        ) as MarkerTailReference[];
}

/** Reread known reference rows by primary key; a deleted row returns nothing. */
export function readKnownMarkerReferenceRows(
    db: Database,
    sessionId: string,
    table: "part" | "message",
    ids: readonly string[],
): MarkerTailReference[] {
    const byId = db.prepare(
        `SELECT ${MARKER_TAIL_REFERENCE_COLUMNS} FROM ${table} WHERE id = ? AND session_id = ?`,
    );
    // Consume the cursor completely before ending a read snapshot. A get() left
    // mid-step can pin that snapshot across ROLLBACK and break the next writer.
    return ids.flatMap((id) => byId.all(id, sessionId) as MarkerTailReference[]);
}

import { inRootAsyncContext } from "../../shared/sqlite";
