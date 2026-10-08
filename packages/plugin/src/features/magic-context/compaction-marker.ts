/**
 * Compaction Marker Injection
 *
 * Injects compaction boundaries into OpenCode's SQLite DB so that
 * `filterCompacted` stops at the historian boundary. After injection,
 * the transform hook receives only post-boundary messages instead
 * of the full session history.
 *
 * Always-on as of v0.21.4. Previously gated behind `compaction_markers`
 * config (default true since v0.9.0); the knob was removed because the
 * feature is required for sane transform performance.
 *
 * ## What gets injected (3 rows):
 * 1. A `compaction` part on the boundary user message
 * 2. A summary assistant message with `parentID` → boundary user message
 * 3. A text part on that summary message containing a static placeholder
 *
 * The real `<session-history>` is injected by the transform pipeline via
 * inject-compartments.ts. The marker exists solely to make filterCompacted
 * stop at the boundary.
 *
 * ## How OpenCode's filterCompacted works:
 * - Iterates newest→oldest
 * - Stops when it finds a user message that:
 *   (a) has a part with type: "compaction"
 *   (b) has a completed summary assistant response (summary: true, finish: "stop")
 *       whose parentID matches that user message's id
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { harnessOwnsOpenCodeStore } from "../../shared/harness";
import { log } from "../../shared/logger";
import {
    assertOpenCodeStoreGeneration,
    resolveOpenCodeDbPath,
} from "../../shared/opencode-db-path";
import { Database, withoutSqliteTransformPass } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";

// ── ID Generation ────────────────────────────────────────────────

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_PREFIX_HEX_LENGTH = 12;
const ID_SUFFIX_LENGTH = 14;
const ID_PREFIX_MASK = (1n << BigInt(ID_PREFIX_HEX_LENGTH * 4)) - 1n;

function deterministicBase62(seed: string, length: number): string {
    let value = BigInt(`0x${createHash("sha256").update(seed).digest("hex")}`);
    const chars = Array<string>(length);
    for (let index = length - 1; index >= 0; index -= 1) {
        chars[index] = BASE62_CHARS[Number(value % 62n)];
        value /= 62n;
    }
    return chars.join("");
}

/**
 * Generate an OpenCode-compatible ascending ID.
 * Format: `prefix_[12-hex-chars][14-deterministic-base62]`.
 * The time prefix preserves OpenCode's lexicographic ordering, while the hash
 * suffix makes retries for the same marker identity converge on the same rows.
 */
function generateId(
    prefix: string,
    timestampMs: number,
    counter: bigint,
    identity: string,
): string {
    const encoded =
        (BigInt(Math.max(0, Math.floor(timestampMs))) * 0x1000n + counter) & ID_PREFIX_MASK;
    const hex = encoded.toString(16).padStart(ID_PREFIX_HEX_LENGTH, "0");
    return `${prefix}_${hex}${deterministicBase62(`${prefix}\0${identity}`, ID_SUFFIX_LENGTH)}`;
}

export function generateMessageId(timestampMs: number, counter = 0n, identity = ""): string {
    return generateId("msg", timestampMs, counter, identity);
}

export function generatePartId(timestampMs: number, counter = 0n, identity = ""): string {
    return generateId("prt", timestampMs, counter, identity);
}

// ── DB Access ────────────────────────────────────────────────────

export function getOpenCodeDbPath(): string {
    return resolveOpenCodeDbPath().path;
}

let cachedWriteDb: { path: string; db: Database } | null = null;
let cachedRemovalDb: { path: string; db: Database } | null = null;

// Marker publication already retains failed requests for the next consuming
// pass. Do not block that pass for seconds behind OpenCode's streaming writer.
const MARKER_BUSY_TIMEOUT_MS = 250;
const MARKER_REMOVAL_BUSY_TIMEOUT_MS = 5000;

/** One-shot cleanup callers cannot retain a failed deletion for the next pass. */
function runMarkerRemovalTransaction<T>(db: Database, operation: () => T): T {
    // A foreground transform normally shortens BEGIN admission to its shared
    // 250ms lease. Cleanup must keep the removal connection's full timeout,
    // including fork hygiene performed inside that foreground transform.
    return withoutSqliteTransformPass(() => db.transaction(operation).immediate());
}

/** Time the outer host-store lock, including COMMIT/rollback but not a nested savepoint. */
function runMarkerWriteTransaction<T>(db: Database, site: string, operation: () => T): T {
    if (db.inTransaction) return db.transaction(operation).immediate();
    const startedAt = performance.now();
    let acquiredAt: number | undefined;
    let workFinishedAt: number | undefined;
    let committed = false;
    try {
        const result = db
            .transaction(() => {
                acquiredAt = performance.now();
                try {
                    return operation();
                } finally {
                    workFinishedAt = performance.now();
                }
            })
            .immediate();
        committed = true;
        return result;
    } finally {
        const finishedAt = performance.now();
        const acquireMs = (acquiredAt ?? finishedAt) - startedAt;
        const holdMs = acquiredAt === undefined ? 0 : finishedAt - acquiredAt;
        const workMs = acquiredAt === undefined ? 0 : (workFinishedAt ?? finishedAt) - acquiredAt;
        const endMs = workFinishedAt === undefined ? 0 : finishedAt - workFinishedAt;
        // Marker moves are infrequent. Log even a fast failed acquisition so a
        // retained retry can be distinguished from a slow transaction body.
        try {
            log(
                `[magic-context] sqlite writer site=${site} db=opencode acquire_ms=${Math.round(acquireMs)} hold_ms=${Math.round(holdMs)} work_ms=${Math.round(workMs)} end_ms=${Math.round(endMs)} outcome=${acquiredAt === undefined ? "not_acquired" : committed ? "committed" : "failed"}`,
            );
        } catch {
            // A diagnostic must not turn a committed marker into a failed retry.
        }
    }
}

// Columns we INSERT into OpenCode's `message` and `part` tables. Kept in sync
// with the INSERT statements in injectCompactionMarker() below. If OpenCode
// ever renames/drops any of these columns, our INSERTs will fail at runtime —
// the schema probe below detects that BEFORE we try to write, so we fail
// cleanly instead of leaving half-written marker state in OpenCode's DB.
const REQUIRED_MESSAGE_COLUMNS = ["id", "session_id", "time_created", "time_updated", "data"];
const REQUIRED_PART_COLUMNS = [
    "id",
    "message_id",
    "session_id",
    "time_created",
    "time_updated",
    "data",
];

/**
 * Cache of schema-compatibility probe results per DB path.
 * null = not yet probed, true = compatible, false = incompatible (bail).
 */
let cachedSchemaCompatible: { path: string; compatible: boolean } | null = null;

/**
 * Probe OpenCode's `message` and `part` tables to verify they have the exact
 * columns our INSERTs reference. OpenCode uses Drizzle migrations and has
 * already shipped several schema updates; any future rename or column drop
 * would make our write silently fail at runtime. Probing once per cached-db
 * lifetime (startup + process restart) keeps the hot path cost at zero after
 * the first call.
 */
function isOpenCodeSchemaCompatible(db: Database, dbPath: string): boolean {
    if (cachedSchemaCompatible?.path === dbPath) {
        return cachedSchemaCompatible.compatible;
    }

    try {
        const messageCols = new Set(
            (db.prepare("PRAGMA table_info(message)").all() as Array<{ name?: string }>)
                .map((r) => r.name ?? "")
                .filter((n) => n.length > 0),
        );
        const partCols = new Set(
            (db.prepare("PRAGMA table_info(part)").all() as Array<{ name?: string }>)
                .map((r) => r.name ?? "")
                .filter((n) => n.length > 0),
        );

        const missingMessage = REQUIRED_MESSAGE_COLUMNS.filter((c) => !messageCols.has(c));
        const missingPart = REQUIRED_PART_COLUMNS.filter((c) => !partCols.has(c));

        if (missingMessage.length > 0 || missingPart.length > 0) {
            log(
                `[magic-context] compaction-marker: OpenCode DB schema missing required columns ` +
                    `(message: [${missingMessage.join(", ")}], part: [${missingPart.join(", ")}]). ` +
                    `Marker injection disabled for this process. ` +
                    `This usually means OpenCode was updated and magic-context is out of date.`,
            );
            cachedSchemaCompatible = { path: dbPath, compatible: false };
            return false;
        }

        cachedSchemaCompatible = { path: dbPath, compatible: true };
        return true;
    } catch (error) {
        log(
            `[magic-context] compaction-marker: schema probe failed: ${error instanceof Error ? error.message : String(error)}. ` +
                `Marker injection disabled until next process restart.`,
        );
        cachedSchemaCompatible = { path: dbPath, compatible: false };
        return false;
    }
}

function getWritableOpenCodeDb(purpose: "publication" | "removal" = "publication"): Database {
    if (!harnessOwnsOpenCodeStore()) {
        throw new Error("OpenCode database is not writable from a Pi-compatible process");
    }
    const resolution = resolveOpenCodeDbPath();
    const dbPath = resolution.path;
    // busy_timeout is connection-wide. Keep retryable publication separate
    // from cleanup, whose event/hygiene callers can discard the failure.
    const cached = purpose === "removal" ? cachedRemovalDb : cachedWriteDb;
    if (cached?.path === dbPath) {
        return cached.db;
    }
    if (cached) {
        try {
            closeQuietly(cached.db);
        } catch {
            // ignore
        }
    }
    // Fail with a diagnosable message instead of SQLite's bare `unable to open
    // database file`, and NEVER create the file: the default open mode creates
    // missing files, so on a machine without OpenCode (e.g. Pi-only installs)
    // a stray `~/.local/share/opencode/` directory would get a junk empty
    // opencode.db here and every later query would throw `no such table`.
    // Callers on such installs must not reach this at all (harness-gated);
    // this guard keeps the failure loud and side-effect-free if one does.
    if (!existsSync(dbPath)) {
        throw new Error(
            `OpenCode database not found at ${dbPath} (source=${resolution.source}; is OpenCode installed?)`,
        );
    }
    const db = new Database(dbPath);
    try {
        assertOpenCodeStoreGeneration(db, "v1", dbPath);
    } catch (error) {
        closeQuietly(db);
        throw error;
    }
    // Set the operation's timeout before WAL setup, which can need a lock too.
    // Confine the short deadline to publication: some removal callers discard
    // a failure rather than retaining a retry.
    const timeoutMs =
        purpose === "removal" ? MARKER_REMOVAL_BUSY_TIMEOUT_MS : MARKER_BUSY_TIMEOUT_MS;
    db.exec(`PRAGMA busy_timeout=${timeoutMs}`);
    db.exec("PRAGMA journal_mode=WAL");
    if (purpose === "removal") cachedRemovalDb = { path: dbPath, db };
    else cachedWriteDb = { path: dbPath, db };
    return db;
}

export function closeCompactionMarkerDb(): void {
    for (const cached of [cachedWriteDb, cachedRemovalDb]) {
        if (!cached) continue;
        try {
            closeQuietly(cached.db);
        } catch {
            // ignore
        }
    }
    cachedWriteDb = null;
    cachedRemovalDb = null;
    // Reset the schema-probe cache too — next open may be a different process
    // or a different opencode.db path (e.g. test isolation via XDG_DATA_HOME).
    cachedSchemaCompatible = null;
}

// ── Boundary User Message Resolution ─────────────────────────────

export interface BoundaryUserMessage {
    id: string;
    timeCreated: number;
}

interface NonSummaryMessageSortKey {
    id: string;
    timeCreated: number;
}

function getNonSummaryMessageSortKey(
    sessionId: string,
    messageId: string,
): NonSummaryMessageSortKey | null {
    const db = getWritableOpenCodeDb();
    const row = db
        .prepare(
            `SELECT time_created, id
             FROM message
             WHERE session_id = ?
               AND id = ?
               AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                        AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
             LIMIT 1`,
        )
        .get(sessionId, messageId) as { time_created?: unknown; id?: unknown } | undefined;
    if (typeof row?.time_created !== "number" || typeof row.id !== "string") {
        return null;
    }
    return { id: row.id, timeCreated: row.time_created };
}

/**
 * Find the nearest user message at or before the given end message id.
 * The boundary must be a user message for filterCompacted to work.
 *
 * Filters out compaction summary messages (summary=true, finish="stop")
 * so ordinals stay consistent with readRawSessionMessagesFromDb.
 */
export function findBoundaryUserMessage(
    sessionId: string,
    endMessageId: string,
): BoundaryUserMessage | null {
    const db = getWritableOpenCodeDb();

    // Resolve the target's canonical sort key first, using the same summary
    // exclusion as readRawSessionMessagesFromDb. If the stored endMessageId is
    // gone (or is itself one of our injected summaries), the pending/direct
    // marker update is stale and must not move the boundary.
    const target = getNonSummaryMessageSortKey(sessionId, endMessageId);
    if (!target) return null;

    // Match the raw-message reader's canonical ASC order
    // (time_created ASC, id ASC). "At or before target" is therefore
    // the inclusive row-value upper bound (time_created, id) <= target's key.
    // Unlike the equivalent OR expression, this lets SQLite seek directly to
    // the target in OpenCode's (session_id, time_created, id) index, then walk
    // backwards until LIMIT 1. The OR form can scan the entire session suffix,
    // or choose multiple index walks and sort all qualifying rows after parsing
    // their JSON. Both do work unrelated to the nearest qualifying user.
    // Push role='user' into SQL so a long assistant/tool span before the target
    // cannot exhaust a JS scan window and miss the prior user.
    // Disqualify the session-only part index with unary +, just as lineage
    // cleanup does. A session may have a million parts; each EXISTS must inspect
    // only this message's parts. The session identity is still checked. The
    // selectivity hint also avoids full part scans with stale host statistics.
    const boundary = db
        .prepare(
            `SELECT id, time_created, data
             FROM message
             WHERE session_id = ?
               AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                        AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
               AND COALESCE(json_extract(data, '$.role'), '') = 'user'
               AND (time_created, id) <= (?, ?)
                AND NOT (
                    EXISTS (SELECT 1 FROM part p
                            WHERE likelihood(p.message_id = message.id, 0.000001) AND +p.session_id = message.session_id
                              AND COALESCE(json_extract(p.data, '$.type'), '') <> 'compaction')
                    AND NOT EXISTS (SELECT 1 FROM part p
                                    WHERE likelihood(p.message_id = message.id, 0.000001) AND +p.session_id = message.session_id
                                      AND COALESCE(json_extract(p.data, '$.type'), '') <> 'compaction'
                                      AND COALESCE(json_extract(p.data, '$.synthetic'), 0) <> 1
                                      AND COALESCE(json_extract(p.data, '$.syntheticTodoMarker'), 0) <> 1)
                )
              ORDER BY time_created DESC, id DESC
             LIMIT 1`,
        )
        .get(sessionId, target.timeCreated, target.id) as
        | { id?: unknown; time_created?: unknown; data?: unknown }
        | undefined;

    if (typeof boundary?.id !== "string" || typeof boundary.time_created !== "number") {
        return null;
    }

    return { id: boundary.id, timeCreated: boundary.time_created };
}

export function compareOpenCodeMessagesByCanonicalOrder(
    sessionId: string,
    leftMessageId: string,
    rightMessageId: string,
): number | null {
    const left = getNonSummaryMessageSortKey(sessionId, leftMessageId);
    const right = getNonSummaryMessageSortKey(sessionId, rightMessageId);
    if (!left || !right) return null;
    if (left.timeCreated < right.timeCreated) return -1;
    if (left.timeCreated > right.timeCreated) return 1;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
}

/**
 * Check that no message the historian would read lies between these two messages.
 * Skip completed summaries and messages whose non-compaction parts all have
 * synthetic:true or syntheticTodoMarker:true as actual JSON booleans, with at
 * least one such part. Empty, unknown or mixed real/synthetic messages prevent
 * skipping history. Both endpoint messages must exist in timestamp/ID order;
 * only rows between them are read.
 */
export function isOpenCodeGapHistorianAbsent(
    sessionId: string,
    endId: string,
    nextId: string,
): boolean {
    const end = getNonSummaryMessageSortKey(sessionId, endId);
    const next = getNonSummaryMessageSortKey(sessionId, nextId);
    if (
        !end ||
        !next ||
        end.timeCreated > next.timeCreated ||
        (end.timeCreated === next.timeCreated && end.id >= next.id)
    )
        return false;
    // Keep these correlated probes on the message_id index too, rather than
    // rescanning all session parts for every message in the gap. Row-value
    // bounds let the message index seek to the gap rather than scan the session.
    const row = getWritableOpenCodeDb()
        .prepare(`SELECT 1 FROM message m
        WHERE m.session_id=?
          AND (m.time_created, m.id) > (?, ?)
          AND (m.time_created, m.id) < (?, ?)
          AND NOT (COALESCE(json_type(m.data,'$.summary'),'')='true' AND COALESCE(json_extract(m.data,'$.finish'),'')='stop')
          AND NOT (
            EXISTS (SELECT 1 FROM part p WHERE likelihood(p.message_id=m.id, 0.000001) AND +p.session_id=m.session_id AND COALESCE(json_extract(p.data,'$.type'),'')<>'compaction')
            AND NOT EXISTS (SELECT 1 FROM part p WHERE likelihood(p.message_id=m.id, 0.000001) AND +p.session_id=m.session_id
                AND COALESCE(json_extract(p.data,'$.type'),'')<>'compaction'
                AND COALESCE(json_type(p.data,'$.synthetic'),'')<>'true'
                AND COALESCE(json_type(p.data,'$.syntheticTodoMarker'),'')<>'true')
          ) LIMIT 1`)
        .get(sessionId, end.timeCreated, end.id, next.timeCreated, next.id);
    return !row;
}

/**
 * Check whether an OpenCode message ID still exists for a given session.
 *
 * Used by plan v6's deferred marker drain to validate that a deferred
 * compaction-marker target hasn't been wiped by recomp / revert / partial
 * recomp between publication and the consuming pass. Errors propagate
 * (unlike the swallow-and-return-empty helpers in `read-session-db.ts`):
 * the marker-manager wraps this call in its own try/catch so missing or
 * locked OpenCode DBs become `retryable-failure` outcomes, not silent skips.
 *
 * Note: returns `{ id }` rather than a richer row shape because the only
 * thing the caller needs is existence. If a future caller needs role or
 * timestamps, widen the return type but keep the throw-on-failure contract.
 */
export function getOpenCodeMessageById(
    sessionId: string,
    messageId: string,
): { id: string } | null {
    const db = getWritableOpenCodeDb();
    const row = db
        .prepare(`SELECT id FROM message WHERE session_id = ? AND id = ? LIMIT 1`)
        .get(sessionId, messageId) as { id: string } | null | undefined;
    return row ?? null;
}

// ── Marker State ─────────────────────────────────────────────────

interface CompactionMarkerState {
    /** The user message ID that has the compaction part */
    boundaryMessageId: string;
    /** The summary assistant message ID we injected */
    summaryMessageId: string;
    /** The compaction part ID on the user message */
    compactionPartId: string;
    /** The text part ID on the summary message */
    summaryPartId: string;
}

// ── Injection ────────────────────────────────────────────────────

export interface InjectCompactionMarkerArgs {
    sessionId: string;
    /** Raw ordinal of the last compartmentalized message */
    endOrdinal: number;
    /** OpenCode message id of the last compartmentalized message */
    endMessageId: string;
    /** Summary text for the compaction summary message (static placeholder) */
    summaryText: string;
    /** Working directory for the session */
    directory: string;
    /** Boundary resolved before removing the old marker (prevents null-boundary cache busts). */
    resolvedBoundary?: BoundaryUserMessage;
}

function removeLegacyMarkerLineageRows(
    db: Database,
    args: {
        sessionId: string;
        boundaryMessageId: string;
        summaryText: string;
        summaryMessageId: string;
        compactionPartId: string;
    },
): void {
    const legacySummaries = db
        .prepare(
            `SELECT m.id
             FROM message m
             WHERE m.session_id = ?
               AND m.id <> ?
               AND COALESCE(json_extract(m.data, '$.summary'), 0) = 1
               AND COALESCE(json_extract(m.data, '$.finish'), '') = 'stop'
               AND COALESCE(json_extract(m.data, '$.parentID'), '') = ?
               AND EXISTS (
                   SELECT 1
                   FROM part p
                   WHERE +p.session_id = m.session_id
                     AND p.message_id = m.id
                     AND COALESCE(json_extract(p.data, '$.type'), '') = 'text'
                     AND COALESCE(json_extract(p.data, '$.text'), '') = ?
               )`,
        )
        .all(
            args.sessionId,
            args.summaryMessageId,
            args.boundaryMessageId,
            args.summaryText,
        ) as Array<{ id?: unknown }>;
    const legacySummaryIds = legacySummaries.flatMap((row) =>
        typeof row.id === "string" ? [row.id] : [],
    );
    if (legacySummaryIds.length === 0) return;

    const deleteSummaryParts = db.prepare(
        "DELETE FROM part WHERE +session_id = ? AND message_id = ?",
    );
    const deleteSummary = db.prepare("DELETE FROM message WHERE session_id = ? AND id = ?");
    for (const summaryMessageId of legacySummaryIds) {
        deleteSummaryParts.run(args.sessionId, summaryMessageId);
        deleteSummary.run(args.sessionId, summaryMessageId);
    }

    // A stale marker lineage can carry its own compaction part. Once the
    // lineage is identified, retain only the deterministic boundary part.
    db.prepare(
        `DELETE FROM part
         WHERE +session_id = ?
           AND message_id = ?
           AND id <> ?
           AND COALESCE(json_extract(data, '$.type'), '') = 'compaction'
           AND COALESCE(json_extract(data, '$.auto'), 0) = 1`,
    ).run(args.sessionId, args.boundaryMessageId, args.compactionPartId);
}

/**
 * Inject a compaction marker into OpenCode's DB.
 * Returns the marker state if successful, null if boundary couldn't be found.
 */
export function injectCompactionMarker(
    args: InjectCompactionMarkerArgs,
): CompactionMarkerState | null {
    // Verify OpenCode's schema still matches what our INSERTs expect BEFORE we
    // try to write. If OpenCode shipped a breaking schema change, bail cleanly
    // instead of half-writing marker state that'd leave the session's history
    // in an inconsistent state.
    const db = getWritableOpenCodeDb();
    if (!isOpenCodeSchemaCompatible(db, getOpenCodeDbPath())) {
        return null;
    }

    const boundary =
        args.resolvedBoundary ?? findBoundaryUserMessage(args.sessionId, args.endMessageId);
    if (!boundary) {
        log(
            `[magic-context] compaction-marker: no user message found at or before endMessageId ${args.endMessageId} (ordinal ${args.endOrdinal})`,
        );
        return null;
    }
    // Use timestamps relative to the boundary so OpenCode's time/id ordering
    // places the marker immediately after the boundary.
    const boundaryTime = boundary.timeCreated;
    const markerIdentity = `${args.sessionId}\0${args.endMessageId}`;
    const summaryMsgId = generateMessageId(
        boundaryTime + 1,
        1n,
        `${markerIdentity}\0summary-message`,
    );
    const compactionPartId = generatePartId(boundaryTime, 1n, `${markerIdentity}\0compaction-part`);
    const summaryPartId = generatePartId(boundaryTime + 1, 2n, `${markerIdentity}\0summary-part`);

    const summaryMsgData = JSON.stringify({
        role: "assistant",
        parentID: boundary.id,
        summary: true,
        finish: "stop",
        mode: "compaction",
        agent: "compaction",
        path: { cwd: args.directory, root: args.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "magic-context",
        providerID: "magic-context",
        time: { created: boundaryTime + 1, completed: boundaryTime + 1 },
    });

    try {
        runMarkerWriteTransaction(db, "compaction-marker-inject", () => {
            // A committed insert can outlive a failed context-state write. Remove
            // any stale lineage in the transaction that writes the canonical rows.
            removeLegacyMarkerLineageRows(db, {
                sessionId: args.sessionId,
                boundaryMessageId: boundary.id,
                summaryText: args.summaryText,
                summaryMessageId: summaryMsgId,
                compactionPartId,
            });

            // Deterministic IDs make this transaction an upsert on retry. Rewriting
            // the exact canonical row also repairs a partial or stale prior write.
            db.prepare(
                `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                     message_id = excluded.message_id,
                     session_id = excluded.session_id,
                     time_created = excluded.time_created,
                     time_updated = excluded.time_updated,
                     data = excluded.data`,
            ).run(
                compactionPartId,
                boundary.id,
                args.sessionId,
                boundaryTime,
                boundaryTime,
                '{"type":"compaction","auto":true}',
            );

            db.prepare(
                `INSERT INTO message (id, session_id, time_created, time_updated, data)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                     session_id = excluded.session_id,
                     time_created = excluded.time_created,
                     time_updated = excluded.time_updated,
                     data = excluded.data`,
            ).run(summaryMsgId, args.sessionId, boundaryTime + 1, boundaryTime + 1, summaryMsgData);

            db.prepare(
                `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                     message_id = excluded.message_id,
                     session_id = excluded.session_id,
                     time_created = excluded.time_created,
                     time_updated = excluded.time_updated,
                     data = excluded.data`,
            ).run(
                summaryPartId,
                summaryMsgId,
                args.sessionId,
                boundaryTime + 1,
                boundaryTime + 1,
                JSON.stringify({ type: "text", text: args.summaryText }),
            );
        });

        log(
            `[magic-context] compaction-marker: injected boundary at user msg ${boundary.id} (ordinal ~${args.endOrdinal}), summary msg ${summaryMsgId}`,
        );

        return {
            boundaryMessageId: boundary.id,
            summaryMessageId: summaryMsgId,
            compactionPartId,
            summaryPartId,
        };
    } catch (error) {
        log(
            `[magic-context] compaction-marker: injection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
    }
}

/**
 * Replace an existing marker and inject its successor under one host-store
 * write lock. Acquiring that lock before the first DELETE avoids SQLite's
 * read-to-write upgrade path, where SQLITE_BUSY does not honor busy_timeout.
 */
export type CompactionMarkerReplacementOutcome =
    | { kind: "committed"; marker: CompactionMarkerState }
    | { kind: "definitely-no-cut" | "uncertain"; error: Error };

export function replaceCompactionMarker(
    existing: CompactionMarkerState | null,
    args: InjectCompactionMarkerArgs,
): CompactionMarkerReplacementOutcome {
    let connection: Database | undefined;
    let entered = false;
    let readyToCommit = false;
    try {
        const db = getWritableOpenCodeDb();
        connection = db;
        const marker = runMarkerWriteTransaction(db, "compaction-marker-replace", () => {
            entered = true;
            if (existing) {
                db.prepare("DELETE FROM part WHERE id = ?").run(existing.summaryPartId);
                db.prepare("DELETE FROM message WHERE id = ?").run(existing.summaryMessageId);
                db.prepare("DELETE FROM part WHERE id = ?").run(existing.compactionPartId);
            }
            const replacement = injectCompactionMarker(args);
            if (!replacement) {
                throw new Error(
                    `failed to inject replacement marker at ordinal ${args.endOrdinal}`,
                );
            }
            readyToCommit = true;
            return replacement;
        });
        return { kind: "committed", marker };
    } catch (error) {
        log(
            `[magic-context] compaction-marker: atomic replacement failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        // A failed BEGIN never wrote. A callback failure before COMMIT is also
        // safe only when SQLite confirms the surrounding rollback completed.
        // A failure during COMMIT is ambiguous, even if the connection is idle.
        const definitelyNoCut = !entered || (!readyToCommit && connection?.inTransaction === false);
        return {
            kind: definitelyNoCut ? "definitely-no-cut" : "uncertain",
            error: error instanceof Error ? error : new Error(String(error)),
        };
    }
}

// ── Foreign-marker scan (fork-orphan hygiene, #263) ─────────────

/**
 * One compaction marker row-set found in opencode.db for a session.
 *
 * `summaryMessageIds` lists the completed summary assistant messages
 * (summary=true, finish="stop") parented to the boundary user message and
 * carrying magic-context's provider identity — i.e. the summaries THIS plugin
 * injected. OpenCode-native /compact summaries carry the real provider id and
 * are deliberately NOT listed, so callers can never delete a native compaction.
 */
export interface SessionCompactionMarkerRows {
    /** id of the `type:"compaction"` part on the boundary user message */
    compactionPartId: string;
    /** the user message id the compaction part is attached to */
    boundaryMessageId: string;
    /** magic-context-injected summary messages parented to the boundary */
    summaryMessageIds: string[];
}

/**
 * List compaction markers that have completed Magic Context summaries.
 *
 * The orphan-reconciliation caller cannot act on native or part-only markers.
 * Discovering completed summaries first bounds part reads to their parent
 * boundaries and avoids a full-session part scan plus one message scan per row.
 */
export function listSessionCompactionMarkers(sessionId: string): SessionCompactionMarkerRows[] {
    const db = getWritableOpenCodeDb();
    const summaryRows = db
        .prepare(
            `SELECT id, json_extract(data, '$.parentID') AS boundary_message_id
             FROM message
             WHERE session_id = ?
               AND COALESCE(json_extract(data, '$.summary'), 0) = 1
               AND COALESCE(json_extract(data, '$.finish'), '') = 'stop'
               AND COALESCE(json_extract(data, '$.providerID'), '') = 'magic-context'
             ORDER BY time_created ASC, id ASC`,
        )
        .all(sessionId) as Array<{ id?: unknown; boundary_message_id?: unknown }>;

    const summaryIdsByBoundary = new Map<string, string[]>();
    for (const row of summaryRows) {
        if (typeof row.id !== "string" || typeof row.boundary_message_id !== "string") continue;
        const summaryIds = summaryIdsByBoundary.get(row.boundary_message_id) ?? [];
        summaryIds.push(row.id);
        summaryIdsByBoundary.set(row.boundary_message_id, summaryIds);
    }

    const boundaryIds = [...summaryIdsByBoundary.keys()];
    const markers: Array<SessionCompactionMarkerRows & { timeCreated: number }> = [];
    const chunkSize = 800;
    for (let offset = 0; offset < boundaryIds.length; offset += chunkSize) {
        const boundaryChunk = boundaryIds.slice(offset, offset + chunkSize);
        const placeholders = boundaryChunk.map(() => "?").join(", ");
        const partRows = db
            .prepare(
                `SELECT id, message_id, time_created
                 FROM part
                 WHERE +session_id = ?
                   AND likelihood(message_id IN (${placeholders}), 0.000001)
                   AND COALESCE(json_extract(data, '$.type'), '') = 'compaction'
                 ORDER BY time_created ASC, id ASC`,
            )
            .all(sessionId, ...boundaryChunk) as Array<{
            id?: unknown;
            message_id?: unknown;
            time_created?: unknown;
        }>;
        for (const row of partRows) {
            if (
                typeof row.id !== "string" ||
                typeof row.message_id !== "string" ||
                typeof row.time_created !== "number"
            ) {
                continue;
            }
            const summaryMessageIds = summaryIdsByBoundary.get(row.message_id);
            if (!summaryMessageIds) continue;
            markers.push({
                compactionPartId: row.id,
                boundaryMessageId: row.message_id,
                summaryMessageIds: [...summaryMessageIds],
                timeCreated: row.time_created,
            });
        }
    }
    markers.sort(
        (left, right) =>
            left.timeCreated - right.timeCreated ||
            left.compactionPartId.localeCompare(right.compactionPartId),
    );
    return markers.map(({ timeCreated: _, ...marker }) => marker);
}

/**
 * Remove one foreign (not owned by this session's durable state) compaction
 * marker from opencode.db: its compaction part, plus the magic-context summary
 * lineage parented to its boundary message.
 *
 * Deleting the compaction part alone is sufficient to make `filterCompacted`
 * stop ignoring our marker (it requires a compaction part to break), but the
 * summary rows are removed too so no stale "[Compacted by magic-context]"
 * message lingers in the fork's history.
 *
 * `protectedSummaryMessageId` is the caller's OWN summary message id; it is
 * never deleted even if it happened to share the boundary (defensive — a
 * foreign boundary newer than ours should always differ).
 *
 * Returns false (without throwing) when the DELETE transaction fails, e.g.
 * SQLITE_BUSY. The hygiene caller reports failure, but its transform trigger
 * only runs once per degraded episode, so a later-pass retry is not guaranteed.
 */
export function removeForeignCompactionMarker(
    sessionId: string,
    marker: SessionCompactionMarkerRows,
    protectedSummaryMessageId: string | null,
): boolean {
    try {
        const db = getWritableOpenCodeDb("removal");
        runMarkerRemovalTransaction(db, () => {
            const deletePartsOfMessage = db.prepare(
                "DELETE FROM part WHERE +session_id = ? AND message_id = ?",
            );
            const deleteMessage = db.prepare("DELETE FROM message WHERE session_id = ? AND id = ?");
            for (const summaryMessageId of marker.summaryMessageIds) {
                if (summaryMessageId === protectedSummaryMessageId) continue;
                deletePartsOfMessage.run(sessionId, summaryMessageId);
                deleteMessage.run(sessionId, summaryMessageId);
            }
            db.prepare("DELETE FROM part WHERE session_id = ? AND id = ?").run(
                sessionId,
                marker.compactionPartId,
            );
        });
        return true;
    } catch (error) {
        log(
            `[magic-context] compaction-marker: foreign-marker removal failed (${sessionId}, part ${marker.compactionPartId}): ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
    }
}

// ── Removal ──────────────────────────────────────────────────────

/**
 * Result of the compaction-off flip cleanup over one session's opencode.db
 * rows (issue #266). Counts are row-level so the transition can both gate
 * the flip notice ("cleared something") and prove idempotence (a second run
 * reports zero removed rows).
 */
export interface McOwnedMarkerCleanupResult {
    /**
     * True only when cleanup completed without skipping an MC-owned lineage.
     * False keeps the mode transition retryable instead of recording a
     * successful flip while a marker can still hide history.
     */
    verified: boolean;
    /** MC-owned marker lineages fully removed (compaction part + summary rows together). */
    removedLineages: number;
    /** Message + part rows deleted in total. */
    removedRows: number;
    /**
     * Lineages deliberately LEFT in place because a surviving compaction part
     * (or message-level compaction field) carries a `tail_start_id` that
     * references a row the deletion would remove. A missing tail target makes
     * OpenCode's tailIndex resolve to -1 and silently bypass its reorder, so
     * the contract is retarget-or-retain, never blind-delete; this cleanup
     * retains.
     */
    retainedLineages: number;
}

/** True when a parsed part/message data object carries a `tail_start_id` reference. */
function dataReferencesTailStart(data: unknown): string | null {
    if (typeof data !== "object" || data === null) return null;
    const record = data as Record<string, unknown>;
    if (typeof record.tail_start_id === "string" && record.tail_start_id.length > 0) {
        return record.tail_start_id;
    }
    const nested = record.compaction;
    if (typeof nested === "object" && nested !== null) {
        const nestedTail = (nested as Record<string, unknown>).tail_start_id;
        if (typeof nestedTail === "string" && nestedTail.length > 0) return nestedTail;
    }
    return null;
}

/** Match the exact payload written by injectCompactionMarker, not a missing native field. */
function isMcCanonicalCompactionPartData(data: unknown): boolean {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
    const record = data as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return (
        keys.length === 2 &&
        keys[0] === "auto" &&
        keys[1] === "type" &&
        record.type === "compaction" &&
        record.auto === true
    );
}

/**
 * Delete every Magic Context-owned compaction-marker lineage for a session
 * from opencode.db. This is the flip-off transition's primary mechanism
 * (issue #266 decision #7): with MC no longer injecting `<session-history>`,
 * a surviving MC marker would keep `filterCompacted` hiding pre-boundary
 * history with nothing to replace it — orphaned context. Deleting the MC
 * pairs lets OpenCode recompute filtering live from the surviving rows, as if
 * the MC markers never existed (peer-verified newest-completed-summary
 * semantics; older markers inside the retained tail do not define the
 * boundary). Native compaction rows are never matched: ownership keys on
 * MC-specific signatures (the `magic-context` provider identity on summary
 * messages, the exact MC marker summary text for legacy lineages, and the
 * MC canonical compaction-part shape) plus session identity.
 *
 * Deletion caveats honored (both binding from the OpenCode peer verification):
 *   1. The compaction part and its summary assistant rows are deleted TOGETHER
 *      in one transaction (summary parts cascade first). Deleting only the
 *      compaction part would strand the summary message in model history.
 *      The boundary USER message row itself is real user history and is never
 *      deleted — only the MC-injected compaction part attached to it.
 *   2. tail_start_id PREFLIGHT: before deleting, every SURVIVING compaction
 *      part (and message-level compaction field) is checked for a
 *      `tail_start_id` equal to any row about to be deleted. On a hit the
 *      lineage is RETAINED, never blind-deleted.
 *
 * Idempotent: absent rows delete as a no-op (second run reports zeros).
 * Errors propagate — the transition treats them as retryable and reruns the
 * same logical cleanup on the next pass (delete-then-record protocol).
 */
export function removeMcOwnedCompactionMarkers(
    sessionId: string,
    summaryText: string,
): McOwnedMarkerCleanupResult {
    const db = getWritableOpenCodeDb("removal");
    if (!isOpenCodeSchemaCompatible(db, getOpenCodeDbPath())) {
        // Schema drift: we cannot prove our DELETEs match the live schema, so
        // leave every row in place. The marker stays inert-but-present; the
        // next process (after an OpenCode/MC update) retries.
        return {
            verified: false,
            removedLineages: 0,
            removedRows: 0,
            retainedLineages: 0,
        };
    }

    // MC-owned summary assistant messages: canonical lineage carries the MC
    // provider identity; supported LEGACY lineages (older builds) are
    // recognized the same way removeLegacyMarkerLineageRows recognizes them —
    // a completed summary parented to the boundary whose text part is exactly
    // the MC marker placeholder. A native summary can never match either
    // signature (native summaries carry the real provider id and text).
    const canonicalSummaries = db
        .prepare(
            `SELECT id, COALESCE(json_extract(data, '$.parentID'), '') AS parent_id
             FROM message
             WHERE session_id = ?
               AND COALESCE(json_extract(data, '$.summary'), 0) = 1
               AND COALESCE(json_extract(data, '$.finish'), '') = 'stop'
               AND COALESCE(json_extract(data, '$.providerID'), '') = 'magic-context'`,
        )
        .all(sessionId) as Array<{ id?: unknown; parent_id?: unknown }>;
    const legacySummaries = db
        .prepare(
            `SELECT m.id, COALESCE(json_extract(m.data, '$.parentID'), '') AS parent_id
             FROM message m
             WHERE m.session_id = ?
               AND COALESCE(json_extract(m.data, '$.summary'), 0) = 1
               AND COALESCE(json_extract(m.data, '$.finish'), '') = 'stop'
               AND COALESCE(json_extract(m.data, '$.providerID'), '') <> 'magic-context'
               AND EXISTS (
                   SELECT 1
                   FROM part p
                   WHERE +p.session_id = m.session_id
                     AND p.message_id = m.id
                     AND COALESCE(json_extract(p.data, '$.type'), '') = 'text'
                     AND COALESCE(json_extract(p.data, '$.text'), '') = ?
               )`,
        )
        .all(sessionId, summaryText) as Array<{ id?: unknown; parent_id?: unknown }>;

    const summariesByBoundary = new Map<string, Set<string>>();
    const orphanSummaryIds = new Set<string>();
    for (const row of [...canonicalSummaries, ...legacySummaries]) {
        if (typeof row.id !== "string") continue;
        if (typeof row.parent_id === "string" && row.parent_id.length > 0) {
            const set = summariesByBoundary.get(row.parent_id) ?? new Set<string>();
            set.add(row.id);
            summariesByBoundary.set(row.parent_id, set);
        } else {
            // A stranded MC summary whose boundary is gone is still MC-owned
            // and still visible in model history — remove it too.
            orphanSummaryIds.add(row.id);
        }
    }

    // Every compaction part in the session, parsed once: the preflight must
    // see surviving native parts, and ownership of a boundary's parts must be
    // decided with the full picture.
    const compactionParts = db
        .prepare(
            `SELECT id, message_id, data
             FROM part
             WHERE session_id = ?
               AND COALESCE(json_extract(data, '$.type'), '') = 'compaction'`,
        )
        .all(sessionId) as Array<{ id?: unknown; message_id?: unknown; data?: unknown }>;
    const parsedParts: Array<{
        id: string;
        messageId: string;
        data: unknown;
        tailStartId: string | null;
    }> = [];
    for (const part of compactionParts) {
        if (typeof part.id !== "string" || typeof part.message_id !== "string") continue;
        let data: unknown;
        try {
            data = typeof part.data === "string" ? JSON.parse(part.data) : part.data;
        } catch {
            data = null;
        }
        parsedParts.push({
            id: part.id,
            messageId: part.message_id,
            data,
            tailStartId: dataReferencesTailStart(data),
        });
    }

    // Message-level V2 compaction fields also carry tail_start_id; collect
    // their references for the preflight as well (conservative: any reference
    // into the deletion set retains the lineage).
    const messageTailRefs = db
        .prepare(
            `SELECT id, data
             FROM message
             WHERE session_id = ?
               AND json_extract(data, '$.compaction.tail_start_id') IS NOT NULL`,
        )
        .all(sessionId) as Array<{ id?: unknown; data?: unknown }>;
    const messageTailStartIds = new Set<string>();
    for (const row of messageTailRefs) {
        if (typeof row.id !== "string") continue;
        let data: unknown;
        try {
            data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
        } catch {
            data = null;
        }
        const ref = dataReferencesTailStart(data);
        if (ref) messageTailStartIds.add(ref);
    }

    let removedLineages = 0;
    let removedRows = 0;
    let retainedLineages = 0;

    const deletePartsOfMessage = db.prepare(
        "DELETE FROM part WHERE +session_id = ? AND message_id = ?",
    );
    const deleteMessage = db.prepare("DELETE FROM message WHERE session_id = ? AND id = ?");
    const deletePart = db.prepare("DELETE FROM part WHERE session_id = ? AND id = ?");

    const deleteSummaries = (summaryIds: Set<string>): number => {
        let rows = 0;
        for (const summaryId of summaryIds) {
            rows += deletePartsOfMessage.run(sessionId, summaryId).changes;
            rows += deleteMessage.run(sessionId, summaryId).changes;
        }
        return rows;
    };

    for (const [boundaryMessageId, summaryIds] of summariesByBoundary) {
        // MC-owned compaction parts on this boundary: the canonical MC shape
        // is exactly {"type":"compaction","auto":true} — no tail_start_id.
        // A compaction part carrying tail_start_id belongs to a native
        // compaction and is never deleted.
        const boundaryParts = parsedParts.filter((part) => part.messageId === boundaryMessageId);
        const mcPartIds = boundaryParts
            .filter((part) => isMcCanonicalCompactionPartData(part.data))
            .map((part) => part.id);

        // Preflight (deletion caveat 2): rows this lineage would delete. Parts
        // are first-class tail targets too, so omitting them can strand a
        // surviving native marker even when every deleted message is covered.
        const rowsToDelete = new Set<string>([...summaryIds, ...mcPartIds]);
        const survivingPartsReferenceDeletion = parsedParts.some(
            (part) =>
                !mcPartIds.includes(part.id) &&
                part.tailStartId !== null &&
                rowsToDelete.has(part.tailStartId),
        );
        const messageFieldReferencesDeletion = [...rowsToDelete].some((id) =>
            messageTailStartIds.has(id),
        );
        if (survivingPartsReferenceDeletion || messageFieldReferencesDeletion) {
            // Retarget-or-retain contract: retain rather than risk a dangling
            // tail target (tailIndex=-1 silently bypasses OpenCode's reorder).
            retainedLineages += 1;
            log(
                `[magic-context] compaction-marker: flip-off cleanup RETAINED lineage at boundary ${boundaryMessageId} — a surviving tail_start_id references a row the deletion would remove`,
            );
            continue;
        }

        // Caveat 1: compaction part + summary rows deleted TOGETHER.
        const rows = runMarkerRemovalTransaction(db, () => {
            let changed = deleteSummaries(summaryIds);
            for (const partId of mcPartIds) {
                changed += deletePart.run(sessionId, partId).changes;
            }
            return changed;
        });
        if (rows > 0 || summaryIds.size > 0 || mcPartIds.length > 0) {
            removedLineages += 1;
            removedRows += rows;
        }
    }

    if (orphanSummaryIds.size > 0) {
        // No boundary to preflight against beyond the summaries themselves.
        const rowsToDelete = new Set<string>(orphanSummaryIds);
        const survivingPartsReferenceDeletion = parsedParts.some(
            (part) => part.tailStartId !== null && rowsToDelete.has(part.tailStartId),
        );
        const messageFieldReferencesDeletion = [...rowsToDelete].some((id) =>
            messageTailStartIds.has(id),
        );
        if (survivingPartsReferenceDeletion || messageFieldReferencesDeletion) {
            retainedLineages += 1;
        } else {
            const rows = runMarkerRemovalTransaction(db, () => deleteSummaries(orphanSummaryIds));
            removedLineages += 1;
            removedRows += rows;
        }
    }

    if (removedLineages > 0 || retainedLineages > 0) {
        log(
            `[magic-context] compaction-marker: flip-off cleanup for ${sessionId} removed ${removedLineages} lineage(s) (${removedRows} rows), retained ${retainedLineages}`,
        );
    }
    return {
        verified: retainedLineages === 0,
        removedLineages,
        removedRows,
        retainedLineages,
    };
}

/**
 * Remove an existing compaction marker (all 3 rows).
 * Used on removed-message, native-compaction and session-deletion events.
 */
export function removeCompactionMarker(state: CompactionMarkerState): boolean {
    try {
        const db = getWritableOpenCodeDb("removal");
        runMarkerRemovalTransaction(db, () => {
            // Delete in reverse order of dependencies
            db.prepare("DELETE FROM part WHERE id = ?").run(state.summaryPartId);
            db.prepare("DELETE FROM message WHERE id = ?").run(state.summaryMessageId);
            db.prepare("DELETE FROM part WHERE id = ?").run(state.compactionPartId);
        });
        return true;
    } catch (error) {
        log(
            `[magic-context] compaction-marker: removal failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
    }
}
