import { isMainThread } from "node:worker_threads";
import { type Database, getSqliteDatabasePath } from "../../shared/sqlite";
import { prewarmRawSessionOrdinalsForDb } from "./raw-ordinal-warmup";

export interface RawMessageParts {
    id: string;
    role: string;
    parts: unknown[];
    createdAt?: number | null;
    version?: string | number | null;
    /** Native store row type when the host exposes one; intentionally absent on v1. */
    storeType?: string;
}

export interface RawMessage extends RawMessageParts {
    ordinal: number;
}

/**
 * Rust's codec/opencode.rs:1627 is_synthetic_message and sidecar.rs:413
 * is_synthetic_part classify non-empty, all-marked parts; historian_chunk.rs:584
 * excludes meta.synthetic rows. Native decode tests the full parts array, while
 * the OpenCode wire twin (module-wire.ts encodeOpenCodeMessagesToCk) ignores
 * compaction markers first, as we do here. Neither checks role or content type.
 * Synthetic content is model-visible, not ephemeral; this only classifies
 * holes in existing Rust coverage, not what the TS historian should cover.
 */
export function areRustHistorianSyntheticParts(parts: readonly unknown[]): boolean {
    const contentParts = parts.filter(
        (part) =>
            part === null ||
            typeof part !== "object" ||
            (part as Record<string, unknown>).type !== "compaction",
    );
    return (
        contentParts.length > 0 &&
        contentParts.every(
            (part) =>
                part !== null &&
                typeof part === "object" &&
                ((part as Record<string, unknown>).synthetic === true ||
                    (part as Record<string, unknown>).syntheticTodoMarker === true),
        )
    );
}

/** Strictly classify rows that carry no user/assistant narrative and may fill a range gap. */
export function isStrictGapHealingMessage(message: RawMessage): boolean {
    if (message.storeType === "synthetic") return true;
    let sawTool = false;
    for (const part of message.parts) {
        if (!part || typeof part !== "object" || Array.isArray(part)) return false;
        const record = part as Record<string, unknown>;
        const type = typeof record.type === "string" ? record.type : "";
        if (type === "tool" || type === "tool_use" || type === "tool_result") {
            sawTool = true;
            continue;
        }
        const text =
            typeof record.text === "string"
                ? record.text
                : typeof record.content === "string"
                  ? record.content
                  : "";
        if (text.trim().length > 0 || type.length > 0) return false;
    }
    return sawTool;
}

export interface RawMessageOrdinalAnchor {
    timeCreated: number;
    id: string;
}

export interface RawMessageOrdinalEntry extends RawMessageOrdinalAnchor {
    contributesOrdinal: boolean;
    hasValidInfo: boolean;
}

interface RawMessageRow {
    id: string;
    data: string;
    time_created?: number;
    time_updated?: number;
}

interface RawPartRow {
    message_id: string;
    data: string;
    time_updated?: number;
}

/**
 * OpenCode message IDs are global primary keys and `part.message_id` references
 * that key. Unary `+` keeps the cross-session correctness filter but prevents
 * SQLite from choosing the session-only index instead of the bounded message-id
 * lookup. Keep the likelihood hint for planner versions that honor it.
 */
export const RAW_MESSAGE_PARTS_BY_ID_SQL =
    "SELECT message_id, data, time_updated FROM part WHERE +session_id = ? AND likelihood(message_id = ?, 0.000001) ORDER BY time_created ASC, id ASC";

function isRawMessageRow(row: unknown): row is RawMessageRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.id === "string" && typeof candidate.data === "string";
}

function isRawPartRow(row: unknown): row is RawPartRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.message_id === "string" && typeof candidate.data === "string";
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(value);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

export function isRawCompactionSummaryInfo(info: unknown): boolean {
    if (info === null || typeof info !== "object" || Array.isArray(info)) return false;
    const candidate = info as Record<string, unknown>;
    return candidate.summary === true && candidate.finish === "stop";
}

/** Tool metadata up to this many characters is loaded whole. */
const RAW_METADATA_KEEP_CHARS = 16_384;
/** The metadata keys raw-history readers use: tool line labels and user answers. */
const RAW_METADATA_KEPT_KEYS = [
    "description",
    "title",
    "userAnswer",
    "answers",
    "answer",
    "selectedOptions",
    "customInput",
    "results",
] as const;

/**
 * A part's stored JSON for the session readers below. Edit and write tools
 * store workspace-wide LSP diagnostics, diffs and file snapshots in
 * `state.metadata`, often several MiB per part, which the provider never sees
 * (see provider-visible-parts.ts) and no reader here uses. Large metadata on a
 * non-error tool part is reduced inside SQLite to the keys readers do use
 * (absent keys stay absent), so the JavaScript side never parses it. An error
 * part keeps its metadata: OpenCode sends an interrupted call's output from it.
 */
const RAW_PART_DATA_SQL = `CASE
    WHEN json_valid(data) = 1
     AND json_type(data, '$.state.metadata') = 'object'
     AND COALESCE(json_extract(data, '$.state.status'), '') <> 'error'
     AND length(json_extract(data, '$.state.metadata')) > ${RAW_METADATA_KEEP_CHARS}
    THEN json_set(data, '$.state.metadata', json_patch('{}', json_object(${RAW_METADATA_KEPT_KEYS.map(
        (key) => `'${key}', json_extract(data, '$.state.metadata.${key}')`,
    ).join(", ")})))
    ELSE data
END`;

function parseJsonUnknown(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function attachRawPartVersion(value: unknown, timeUpdated: number | undefined): unknown {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    if (typeof timeUpdated !== "number") return value;
    try {
        Object.defineProperty(value, "__magicContextPartUpdatedAt", {
            value: timeUpdated,
            enumerable: false,
            configurable: true,
        });
    } catch {
        // Non-extensible provider objects are rare; the recursive byte-length
        // fingerprint still catches content changes when metadata cannot attach.
    }
    return value;
}

export function readRawSessionMessagesFromDb(db: Database, sessionId: string): RawMessage[] {
    const messageRows = db
        .prepare(
            "SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId)
        .filter(isRawMessageRow);

    const partsByMessageId = new Map<string, unknown[]>();
    const partMessageBatchSize = 128;
    for (let offset = 0; offset < messageRows.length; offset += partMessageBatchSize) {
        const messageIds = messageRows
            .slice(offset, offset + partMessageBatchSize)
            .map((row) => row.id);
        if (messageIds.length === 0) continue;
        const placeholders = messageIds.map(() => "?").join(", ");
        const partRows = db
            .prepare(
                `SELECT message_id, ${RAW_PART_DATA_SQL} AS data, time_updated
                 FROM part
                 WHERE +session_id = ?
                   AND likelihood(message_id IN (${placeholders}), 0.000001)
                 ORDER BY message_id ASC, time_created ASC, id ASC`,
            )
            .all(sessionId, ...messageIds)
            .filter(isRawPartRow);
        for (const part of partRows) {
            const list = partsByMessageId.get(part.message_id) ?? [];
            list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
            partsByMessageId.set(part.message_id, list);
        }
    }

    // Filter out compaction summary messages injected by magic-context.
    // These exist only for OpenCode's filterCompacted boundary and must not
    // be visible to historian, trigger evaluation, FTS indexing, or ctx_expand.
    const filtered = messageRows.filter(
        (row) => !isRawCompactionSummaryInfo(parseJsonRecord(row.data)),
    );

    return filtered.flatMap((row, index) => {
        const info = parseJsonRecord(row.data);
        if (!info) return [];
        const role = typeof info.role === "string" ? info.role : "unknown";
        return {
            ordinal: index + 1,
            id: row.id,
            role,
            parts: partsByMessageId.get(row.id) ?? [],
            createdAt: row.time_created ?? null,
            version: row.time_updated ?? null,
        };
    });
}

interface PagedRawMessageRow extends RawMessageRow {
    ordinal: number;
}

/**
 * Read one bounded page from the canonical raw-message ordinal space. Message
 * and part JSON parsing is limited to the requested page so background FTS work
 * cannot monopolize the event loop by hydrating an entire long session.
 */
export function readRawSessionMessagePageFromDb(
    db: Database,
    sessionId: string,
    afterOrdinal: number,
    limit: number,
    finalWatermark = Number.MAX_SAFE_INTEGER,
    after?: RawMessageOrdinalAnchor,
): RawMessage[] {
    const messageRows = readRawMessagePageRows(
        db,
        sessionId,
        afterOrdinal,
        limit,
        finalWatermark,
        after,
    );
    if (messageRows.length === 0) return [];

    const placeholders = messageRows.map(() => "?").join(", ");
    const partRows = db
        .prepare(
            `SELECT message_id, ${RAW_PART_DATA_SQL} AS data, time_updated
             FROM part
             WHERE +session_id = ?
               AND likelihood(message_id IN (${placeholders}), 0.000001)
             ORDER BY message_id ASC, time_created ASC, id ASC`,
        )
        .all(sessionId, ...messageRows.map((row) => row.id))
        .filter(isRawPartRow);
    return assembleRawMessagePage(messageRows, partRows);
}

function readRawMessagePageRows(
    db: Database,
    sessionId: string,
    afterOrdinal: number,
    limit: number,
    finalWatermark: number,
    after?: RawMessageOrdinalAnchor,
): PagedRawMessageRow[] {
    const remaining = Math.max(0, Math.floor(finalWatermark) - Math.floor(afterOrdinal));
    const pageSize = Math.min(Math.max(1, Math.floor(limit)), remaining);
    if (pageSize === 0) return [];

    return withReadSnapshot(db, () => {
        const ordinal = Math.max(0, Math.floor(afterOrdinal));
        // A restarted reconciler has an ordinal but no keyset anchor. Worker
        // ranks let it start at the nearest page, not parse the entire prefix.
        const points = currentOrdinalCheckpoints(db, sessionId)?.scan.checkpoints ?? [];
        let low = 0;
        let high = points.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (points[middle].ordinal <= ordinal) low = middle + 1;
            else high = middle;
        }
        const floor = points[low - 1];
        const useFloor = floor && (!after || compareOrdinalKeys(floor, after) > 0);
        const anchor = useFloor ? floor : after;
        const skip = anchor === after && after ? 0 : ordinal - (floor?.ordinal ?? 0);
        if (skip > ORDINAL_LOOKUP_LIMIT) {
            void prewarmRawSessionOrdinalsForDb(db, sessionId);
            throw new RawOrdinalsNotReady();
        }
        // Limit index keys BEFORE touching JSON. Even a long run of excluded
        // summaries cannot turn a small LIMIT into an unbounded table scan.
        const rawLimit = skip + pageSize + ORDINAL_LOOKUP_LIMIT;
        const rows = db
            .prepare(`SELECT id, data, time_created, time_updated, ${EXCLUDED_ROW_SQL} AS excluded
                FROM message WHERE id IN (
                    SELECT id FROM message WHERE session_id = ?
                    ${anchor ? "AND (time_created, id) > (?, ?)" : ""}
                    ORDER BY time_created, id LIMIT ?)
                ORDER BY time_created, id`)
            .all(sessionId, ...(anchor ? [anchor.timeCreated, anchor.id] : []), rawLimit) as Array<
            RawMessageRow & { excluded: number }
        >;
        rawMessagePageRowsVisited += rows.length;
        const eligible = rows.filter((row) => row.excluded !== 1);
        if (eligible.length <= skip && rows.length === rawLimit) {
            void prewarmRawSessionOrdinalsForDb(db, sessionId);
            throw new RawOrdinalsNotReady();
        }
        return eligible
            .slice(skip, skip + pageSize)
            .filter(isRawMessageRow)
            .map(
                (row, index): PagedRawMessageRow => ({
                    ...row,
                    ordinal: ordinal + index + 1,
                }),
            );
    });
}

let rawMessagePageRowsVisited = 0;

/** @internal Message rows examined by raw page reads, including excluded rows. */
export function getRawMessagePageRowsVisitedForTest(): number {
    return rawMessagePageRowsVisited;
}

/** @internal */
export function resetRawMessagePageRowsVisitedForTest(): void {
    rawMessagePageRowsVisited = 0;
}

function assembleRawMessagePage(
    messageRows: readonly PagedRawMessageRow[],
    partRows: readonly RawPartRow[],
): RawMessage[] {
    const partsByMessageId = new Map<string, unknown[]>();
    for (const part of partRows) {
        const list = partsByMessageId.get(part.message_id) ?? [];
        list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
        partsByMessageId.set(part.message_id, list);
    }

    return messageRows.map((row) => {
        const info = parseJsonRecord(row.data);
        return {
            ordinal: row.ordinal,
            id: row.id,
            role: typeof info?.role === "string" ? info.role : "unknown",
            parts: partsByMessageId.get(row.id) ?? [],
            createdAt: row.time_created ?? null,
            version: row.time_updated ?? null,
        };
    });
}

/** Longest text a summary page keeps from one text part or one tool key argument. */
export const RAW_SUMMARY_TEXT_MAX_CHARS = 8192;
const RAW_SUMMARY_ARG_MAX_CHARS = 512;

/** Tool input keys the `TC:` summary line reads (see extractToolCallSummaries). */
const RAW_SUMMARY_TOOL_INPUT_KEYS = [
    "description",
    "filePath",
    "path",
    "pattern",
    "query",
    "symbol",
    "module",
    "action",
] as const;

function summaryStringField(jsonPath: string): string {
    return `CASE WHEN json_type(data, '${jsonPath}') = 'text' THEN substr(json_extract(data, '${jsonPath}'), 1, ${RAW_SUMMARY_ARG_MAX_CHARS}) END`;
}

/**
 * Part projection for summary pages, computed inside SQLite so the JavaScript
 * heap never holds a whole tool output. A text part keeps its fields with the
 * text cut to RAW_SUMMARY_TEXT_MAX_CHARS. A tool part is rebuilt from its name,
 * call id, status, the input keys a `TC:` line uses, and the metadata
 * description; its output, full metadata (LSP diagnostics and the like), and
 * bulky inputs such as written file contents are never read into JavaScript.
 */
const RAW_SUMMARY_PART_DATA_SQL = `CASE
    WHEN json_extract(data, '$.type') = 'text'
        THEN json_set(data, '$.text', substr(json_extract(data, '$.text'), 1, ${RAW_SUMMARY_TEXT_MAX_CHARS}))
    ELSE json_object(
        'type', 'tool',
        'tool', ${summaryStringField("$.tool")},
        'callID', ${summaryStringField("$.callID")},
        'state', json_object(
            'status', ${summaryStringField("$.state.status")},
            'input', json_object(${RAW_SUMMARY_TOOL_INPUT_KEYS.map(
                (key) => `'${key}', ${summaryStringField(`$.state.input.${key}`)}`,
            ).join(", ")}),
            'metadata', json_object('description', ${summaryStringField("$.state.metadata.description")})
        )
    )
END`;

/**
 * Read one bounded page in the same ordinal space as
 * {@link readRawSessionMessagePageFromDb}, keeping only text and tool parts in
 * their summary projection. For callers that render `U:` / `TC:` lines and
 * never need tool outputs, reasoning, or file payloads: peak memory is one page
 * of small projected parts, whatever the session or tool-output size.
 */
export function readRawSessionMessageSummaryPageFromDb(
    db: Database,
    sessionId: string,
    afterOrdinal: number,
    limit: number,
    finalWatermark = Number.MAX_SAFE_INTEGER,
    after?: RawMessageOrdinalAnchor,
): RawMessage[] {
    const messageRows = readRawMessagePageRows(
        db,
        sessionId,
        afterOrdinal,
        limit,
        finalWatermark,
        after,
    );
    if (messageRows.length === 0) return [];

    const placeholders = messageRows.map(() => "?").join(", ");
    const partRows = db
        .prepare(
            `SELECT message_id, ${RAW_SUMMARY_PART_DATA_SQL} AS data, time_updated
             FROM part
             WHERE +session_id = ?
               AND likelihood(message_id IN (${placeholders}), 0.000001)
               AND json_valid(data) = 1
               AND json_extract(data, '$.type') IN ('text', 'tool')
             ORDER BY message_id ASC, time_created ASC, id ASC`,
        )
        .all(sessionId, ...messageRows.map((row) => row.id))
        .filter(isRawPartRow);
    return assembleRawMessagePage(messageRows, partRows);
}

/**
 * Number of ordinal-bearing messages in a session. Counted from the
 * `(session_id, time_created, id)` index minus the session's finished
 * compaction summaries (see {@link countCanonicalOrdinalsIndexed}); the
 * statement below, which reads every message's JSON, is used only when that
 * path is unavailable.
 */
export function countRawSessionMessageOrdinalsFromDb(db: Database, sessionId: string): number {
    const indexed = countCanonicalOrdinalsIndexed(db, sessionId, null, null);
    if (indexed !== null) return indexed;
    const row = db
        .prepare(
            `SELECT COUNT(*) AS count
             FROM message
             WHERE session_id = ?
               AND NOT (
                   CASE WHEN json_valid(data) = 1
                        THEN COALESCE(json_extract(data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(data) = 1
                            THEN COALESCE(json_extract(data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )`,
        )
        .get(sessionId) as { count?: number } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

let exactOrdinalScansOnThisThread = 0;

/**
 * @internal Calls in this thread to the two readers whose cost grows with the
 * whole session: {@link readRawSessionMessageIdOrdinalsFromDb} and
 * {@link readRawSessionMessageIdOrdinalsForRangeFromDb}. A worker thread loads
 * its own copy of this module, so reads it runs are not counted here; a test
 * can use that to prove a read happened on a worker and not on the serving
 * thread.
 */
export function getExactOrdinalScansOnThisThreadForTest(): number {
    return exactOrdinalScansOnThisThread;
}

/** @internal */
export function resetExactOrdinalScansOnThisThreadForTest(): void {
    exactOrdinalScansOnThisThread = 0;
}

/**
 * Read the canonical raw-message ordinal space without loading or parsing part rows.
 * Keep the ordering, summary predicate, and malformed-message behavior identical to
 * `readRawSessionMessagesFromDb`; consumers compare these ordinals across passes.
 */
export function readRawSessionMessageIdOrdinalsFromDb(
    db: Database,
    sessionId: string,
): Map<string, number> {
    exactOrdinalScansOnThisThread += 1;
    const messageRows = db
        .prepare(
            "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId)
        .filter(isRawMessageRow);
    const ordinalById = new Map<string, number>();
    let ordinal = 0;
    for (const row of messageRows) {
        const info = parseJsonRecord(row.data);
        if (isRawCompactionSummaryInfo(info)) continue;
        ordinal += 1;
        if (info) ordinalById.set(row.id, ordinal);
    }
    return ordinalById;
}

/** Hydrate only the requested range; malformed rows consume ordinals but have no id entry. */
export function readRawSessionMessageIdOrdinalsForRangeFromDb(
    db: Database,
    sessionId: string,
    fromOrdinal: number,
    toOrdinal: number,
): Map<string, number> {
    const from = Math.max(1, Math.floor(fromOrdinal));
    const to = Math.floor(toOrdinal);
    if (to < from) return new Map();
    exactOrdinalScansOnThisThread += 1;
    const rows = db
        .prepare(`
        SELECT id, data FROM message WHERE session_id = ?
          AND CASE WHEN json_valid(data) THEN NOT (
            COALESCE(json_type(data, '$.summary'), '') = 'true'
            AND COALESCE(json_extract(data, '$.finish'), '') = 'stop'
          ) ELSE 1 END
        ORDER BY time_created, id LIMIT ? OFFSET ?
    `)
        .all(sessionId, to - from + 1, from - 1)
        .filter(isRawMessageRow);
    const result = new Map<string, number>();
    for (const [index, row] of rows.entries()) {
        if (parseJsonRecord(row.data)) result.set(row.id, from + index);
    }
    return result;
}

/**
 * The message id at each requested ordinal, by the same exact single-ordinal read
 * as `readRawSessionMessageIdOrdinalsForRangeFromDb(db, sessionId, n, n)`, all
 * from one read snapshot. Null means no message, or a malformed row, holds that
 * ordinal. Each read evaluates every preceding message's JSON, so on a long
 * session this belongs on a worker thread, never on the serving thread.
 */
export function readRawSessionMessageIdsAtOrdinalsFromDb(
    db: Database,
    sessionId: string,
    ordinals: readonly number[],
): Array<[number, string | null]> {
    return withReadSnapshot(db, () =>
        ordinals.map((ordinal): [number, string | null] => [
            ordinal,
            readRawSessionMessageIdOrdinalsForRangeFromDb(db, sessionId, ordinal, ordinal)
                .keys()
                .next().value ?? null,
        ]),
    );
}

/** Read a keyset page used to incrementally maintain shadow message ordinals. */
export function readRawSessionMessageOrdinalPageFromDb(
    db: Database,
    sessionId: string,
    after: RawMessageOrdinalAnchor | null,
    limit: number,
): RawMessageOrdinalEntry[] {
    const pageSize = Math.max(1, Math.floor(limit));
    const rows = (
        after
            ? db
                  .prepare(
                      `SELECT id, data, time_created
                       FROM message
                       WHERE session_id = ?
                         AND (time_created, id) > (?, ?)
                       ORDER BY time_created ASC, id ASC
                       LIMIT ?`,
                  )
                  .all(sessionId, after.timeCreated, after.id, pageSize)
            : db
                  .prepare(
                      `SELECT id, data, time_created
                       FROM message
                       WHERE session_id = ?
                       ORDER BY time_created ASC, id ASC
                       LIMIT ?`,
                  )
                  .all(sessionId, pageSize)
    ).filter(isRawMessageRow);

    return rows.flatMap((row) => {
        if (typeof row.time_created !== "number") return [];
        const info = parseJsonRecord(row.data);
        return {
            id: row.id,
            timeCreated: row.time_created,
            contributesOrdinal: !isRawCompactionSummaryInfo(info),
            hasValidInfo: info !== null,
        };
    });
}

/** Count stored rows without inspecting message JSON, allowing the session-id index to answer it. */
export function countStoredRawSessionMessagesFromDb(db: Database, sessionId: string): number {
    const row = db
        .prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?")
        .get(sessionId) as { count?: number } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

interface AnchorRow {
    time_created: number;
    id: string;
}

function isAnchorRow(row: unknown): row is AnchorRow {
    return (
        row !== null &&
        typeof row === "object" &&
        typeof (row as { time_created?: unknown }).time_created === "number" &&
        typeof (row as { id?: unknown }).id === "string"
    );
}

/**
 * Read ONLY the eligible tail — messages at/after the last compartment boundary
 * — assigning them their correct ABSOLUTE ordinals (continuing from
 * `baseOrdinal`), and return the absolute session message count alongside.
 *
 * This is the O(tail) read: it never touches the ~63k pre-boundary rows that the
 * full reader scans just to recover the tail's ordinal base — a number the
 * compaction marker already stores (`end_message` ordinal + `end_message_id`
 * anchor). On a months-long session the full read is O(session) and grows
 * unbounded; this stays flat at the tail size.
 *
 * Anchor semantics: reads rows with `(time_created, id) >= anchor` (INCLUSIVE of
 * the boundary message), in the same sort order as the full reader, filters
 * compaction-summary rows identically, and numbers the kept messages
 * `baseOrdinal, baseOrdinal+1, …`. Including the anchor keeps
 * `messageIdAtOrdinal(baseOrdinal)` real (the full reader has it too) so
 * boundary-edge message ids match.
 *
 * Returns null when the anchor message id isn't found (deleted / legacy
 * compartment without `end_message_id`); the caller then falls back to the full
 * read. `absoluteMessageCount` = `baseOrdinal + (keptTail - 1)` = the exact
 * count the full reader would produce, so every absolute-ordinal consumer lines
 * up.
 */
export function readRawSessionTailFromDb(
    db: Database,
    sessionId: string,
    baseOrdinal: number,
    anchorMessageId: string,
): { messages: RawMessage[]; absoluteMessageCount: number } | null {
    const anchorRow = db
        .prepare("SELECT time_created, id, data FROM message WHERE id = ? AND session_id = ?")
        .get(anchorMessageId, sessionId);
    if (!isAnchorRow(anchorRow)) return null;

    // Defensive: if the anchor itself is a compaction-summary row, the ordinal
    // mapping is ill-defined — summary rows are filtered out BEFORE ordinal
    // assignment in the full numbering, so a summary anchor has no ordinal and
    // `baseOrdinal` cannot correspond to it. Unreachable from current callers
    // (compartment boundaries come from ordinal walks over non-summary rows),
    // but if it ever happens, bail to the full reader rather than produce an
    // off-by-one window.
    const anchorInfo = parseJsonRecord((anchorRow as { data?: string }).data ?? "");
    if (anchorInfo?.summary === true && anchorInfo?.finish === "stop") return null;

    const messageRows = db
        .prepare(
            `SELECT id, data, time_created, time_updated FROM message
             WHERE session_id = ?
               AND (time_created > ? OR (time_created = ? AND id >= ?))
             ORDER BY time_created ASC, id ASC`,
        )
        .all(sessionId, anchorRow.time_created, anchorRow.time_created, anchorRow.id)
        .filter(isRawMessageRow);

    // Identical compaction-summary filter to the full reader, applied BEFORE
    // ordinal assignment.
    const filtered = messageRows.filter((row) => {
        const info = parseJsonRecord(row.data);
        return !(info?.summary === true && info?.finish === "stop");
    });

    const ids = filtered.map((row) => row.id);
    const partsByMessageId = new Map<string, unknown[]>();
    if (ids.length > 0) {
        const CHUNK = 800;
        for (let i = 0; i < ids.length; i += CHUNK) {
            const slice = ids.slice(i, i + CHUNK);
            const placeholders = slice.map(() => "?").join(",");
            const partRows = db
                .prepare(
                    `SELECT message_id, ${RAW_PART_DATA_SQL} AS data, time_updated FROM part WHERE +session_id = ? AND likelihood(message_id IN (${placeholders}), 0.000001) ORDER BY time_created ASC, id ASC`,
                )
                .all(sessionId, ...slice)
                .filter(isRawPartRow);
            for (const part of partRows) {
                const list = partsByMessageId.get(part.message_id) ?? [];
                list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
                partsByMessageId.set(part.message_id, list);
            }
        }
    }

    const messages: RawMessage[] = [];
    let ord = baseOrdinal;
    for (const row of filtered) {
        const info = parseJsonRecord(row.data);
        if (!info) {
            // Mirror the full reader: a malformed row keeps its ordinal slot but
            // yields no element.
            ord += 1;
            continue;
        }
        messages.push({
            ordinal: ord,
            id: row.id,
            role: typeof info.role === "string" ? info.role : "unknown",
            parts: partsByMessageId.get(row.id) ?? [],
            createdAt: row.time_created ?? null,
            version: row.time_updated ?? null,
        });
        ord += 1;
    }

    // ord now points one past the last assigned ordinal, so the absolute count is
    // ord - 1 (== baseOrdinal + keptIncludingMalformed - 1).
    return { messages, absoluteMessageCount: Math.max(0, ord - 1) };
}

/**
 * Minimal structural view of an in-memory transform message, extracted from
 * OpenCode's `MessageLike` by the caller. Kept dependency-free so this module
 * doesn't import the transform/tagging layer.
 */
export interface InMemoryMessageView {
    id: string;
    role: string;
    parts: unknown[];
    /** From the message `info` if present; used to mirror the DB summary filter. */
    summary?: boolean;
    finish?: string;
}

export interface InMemoryTailResult {
    messages: RawMessage[];
    absoluteMessageCount: number;
    /** True when the compaction anchor id was located within the array. */
    anchorFound: boolean;
}

/**
 * Extract the minimal structural view from OpenCode transform messages
 * (`args.messages`, MessageLike-shaped: `{ info, parts }`). Tolerates missing
 * fields — a message without a string id becomes an empty-id view, which
 * `buildInMemoryTailRawMessages` treats as a malformed row (ordinal slot kept,
 * no element), mirroring the DB reader.
 */
export function extractInMemoryMessageViews(
    messages: readonly { info?: unknown; parts?: unknown }[],
): InMemoryMessageView[] {
    return messages.map((m) => {
        const info = (m.info ?? {}) as Record<string, unknown>;
        return {
            id: typeof info.id === "string" ? info.id : "",
            role: typeof info.role === "string" ? info.role : "unknown",
            parts: Array.isArray(m.parts) ? m.parts : [],
            summary: info.summary === true ? true : undefined,
            finish: typeof info.finish === "string" ? info.finish : undefined,
        };
    });
}

/**
 * Build an absolute-ordinal `RawMessage[]` tail from the in-memory transform
 * messages (`args.messages`), mirroring {@link readRawSessionTailFromDb} so the
 * boundary resolver produces an identical result without any opencode.db read.
 *
 * OpenCode hands the transform the post-compaction-marker tail, i.e. the eligible
 * window, already parsed. Ordinals are anchored at the last compartment boundary:
 *
 * - If `anchorMessageId` is found at index k, that message IS the boundary
 *   (ordinal `lastCompartmentEnd`); messages k, k+1, … get ordinals
 *   `lastCompartmentEnd, lastCompartmentEnd+1, …`. Messages before k (compaction
 *   marker lag — already compartmentalized) are dropped, matching the DB tail
 *   which starts AT the anchor.
 * - If the anchor isn't present (it was a summary row OpenCode already filtered,
 *   or marker is ahead), the array is assumed to start at `lastCompartmentEnd+1`
 *   and ordinals run `lastCompartmentEnd+1, …`. `anchorFound=false` flags this so
 *   callers can choose the DB fallback if they don't trust the assumption.
 * - No compartments yet (#132): pass `lastCompartmentEnd=0`,
 *   `anchorMessageId=null` → ordinals from 1 over the whole array.
 *
 * Mirrors the DB reader's contracts: compaction-summary rows
 * (`summary===true && finish==='stop'`) are filtered BEFORE ordinal assignment;
 * a malformed message (no string id) keeps its ordinal slot but yields no element;
 * `absoluteMessageCount` equals what the DB reader would report for the same tail.
 *
 * Returns null when there are no usable messages.
 */
export function buildInMemoryTailRawMessages(args: {
    messages: readonly InMemoryMessageView[];
    lastCompartmentEnd: number;
    anchorMessageId: string | null;
}): InMemoryTailResult | null {
    const { messages, lastCompartmentEnd, anchorMessageId } = args;

    // Mirror the DB reader's compaction-summary filter, applied BEFORE ordinal
    // assignment. (These rows are normally already absent post-filterCompacted,
    // but filtering defensively keeps ordinals aligned if one slips through.)
    const filtered = messages.filter((m) => !(m.summary === true && m.finish === "stop"));
    if (filtered.length === 0) return null;

    let startIndex = 0;
    let baseOrdinal: number;
    let anchorFound = false;
    if (anchorMessageId) {
        const anchorIndex = filtered.findIndex((m) => m.id === anchorMessageId);
        if (anchorIndex >= 0) {
            anchorFound = true;
            startIndex = anchorIndex;
            baseOrdinal = lastCompartmentEnd; // the anchor row IS lastCompartmentEnd
        } else {
            // Anchor filtered out / marker ahead: assume array starts just past it.
            baseOrdinal = Math.max(1, lastCompartmentEnd + 1);
        }
    } else {
        // No-compartment (#132) case: whole array is eligible from ordinal 1.
        baseOrdinal = Math.max(1, lastCompartmentEnd + 1);
    }

    const out: RawMessage[] = [];
    let ord = baseOrdinal;
    for (let i = startIndex; i < filtered.length; i += 1) {
        const m = filtered[i];
        if (!m.id || typeof m.id !== "string") {
            // Mirror the DB reader: malformed row keeps its ordinal slot, no element.
            ord += 1;
            continue;
        }
        out.push({
            ordinal: ord,
            id: m.id,
            role: typeof m.role === "string" ? m.role : "unknown",
            parts: m.parts ?? [],
            version: null,
        });
        ord += 1;
    }

    return { messages: out, absoluteMessageCount: Math.max(0, ord - 1), anchorFound };
}

export function readRawSessionMessagePartsByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
    onQuery?: () => void,
): RawMessageParts | null {
    onQuery?.();
    const row = db
        .prepare(
            "SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? AND id = ?",
        )
        .get(sessionId, messageId) as RawMessageRow | null;
    if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number") return null;

    const info = parseJsonRecord(row.data);
    if (!info || isRawCompactionSummaryInfo(info)) return null;
    onQuery?.();
    const partRows = db
        .prepare(RAW_MESSAGE_PARTS_BY_ID_SQL)
        .all(sessionId, messageId)
        .filter(isRawPartRow);
    return {
        id: row.id,
        role: typeof info.role === "string" ? info.role : "unknown",
        parts: partRows.map((part) =>
            attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated),
        ),
        createdAt: row.time_created,
        version: row.time_updated ?? null,
    };
}

/**
 * Flags for the canonical ordinal predicate. A row is excluded from the ordinal
 * space when both flags are 1: a compaction summary (`summary` true or numeric
 * 1) that finished with `stop`. Malformed JSON has neither flag, so it counts,
 * as it does in {@link readRawSessionMessagesFromDb}.
 */
const ORDINAL_SUMMARY_FLAG_SQL = `(CASE WHEN json_valid(data) = 1
        THEN COALESCE(json_extract(data, '$.summary'), 0)
        ELSE 0 END = 1)`;
const ORDINAL_STOP_FLAG_SQL = `(CASE WHEN json_valid(data) = 1
        THEN COALESCE(json_extract(data, '$.finish'), '')
        ELSE '' END = 'stop')`;

/**
 * Count one `(time_created, id)` range of a session. The row-value bounds seek
 * the `(session_id, time_created, id)` index, so only rows inside the range are
 * visited. `eligible` is the number of ordinal-bearing rows in the range.
 */
function ordinalRangeSql(lowerBound: boolean): string {
    return `SELECT COUNT(*) AS visited,
                   COALESCE(SUM(CASE WHEN ${ORDINAL_SUMMARY_FLAG_SQL} AND ${ORDINAL_STOP_FLAG_SQL}
                                     THEN 0 ELSE 1 END), 0) AS eligible
            FROM message
            WHERE session_id = ?
              ${lowerBound ? "AND (time_created, id) > (?, ?)" : ""}
              AND (time_created, id) <= (?, ?)`;
}

const ORDINAL_RANGE_FROM_START_SQL = ordinalRangeSql(false);
const ORDINAL_RANGE_BETWEEN_SQL = ordinalRangeSql(true);

interface OrdinalKey {
    timeCreated: number;
    id: string;
}

/**
 * What this connection can observe about changes to the whole store: commits by
 * any other connection or process move `data_version`, this connection's own
 * writes move `total_changes()`, and schema changes move `schema_version`.
 * While all three are unchanged, nothing in the store has changed.
 */
interface StoreStamp {
    dataVersion: number;
    totalChanges: number;
    schemaVersion: number;
}

function readStoreStamp(db: Database): StoreStamp | null {
    try {
        const row = db
            .prepare(
                `SELECT data_version AS dataVersion, total_changes() AS totalChanges,
                        (SELECT schema_version FROM pragma_schema_version) AS schemaVersion
                 FROM pragma_data_version`,
            )
            .get() as Partial<StoreStamp> | null;
        if (
            typeof row?.dataVersion !== "number" ||
            typeof row.totalChanges !== "number" ||
            typeof row.schemaVersion !== "number"
        )
            return null;
        return {
            dataVersion: row.dataVersion,
            totalChanges: row.totalChanges,
            schemaVersion: row.schemaVersion,
        };
    } catch {
        return null;
    }
}

function sameStoreStamp(left: StoreStamp | null, right: StoreStamp | null): boolean {
    return (
        left !== null &&
        right !== null &&
        left.dataVersion === right.dataVersion &&
        left.totalChanges === right.totalChanges &&
        left.schemaVersion === right.schemaVersion
    );
}

/**
 * A message whose canonical ordinal this connection counted while the store
 * was in the state `stamp` describes. It is only reused while the stamp is
 * unchanged, which proves no row at or before it can have changed.
 */
interface OrdinalWatermark extends OrdinalKey {
    ordinal: number;
    stamp: StoreStamp;
    epoch: number;
}

/**
 * Watermarks are per connection: tests and tools open several stores that reuse
 * the same session ids, and a count proven in one store says nothing about another.
 */
const ordinalWatermarks = new WeakMap<Database, Map<string, OrdinalWatermark>>();
/** Bumped by {@link forgetRawSessionOrdinalWatermark}; older watermarks are not reused. */
const ordinalWatermarkEpochs = new Map<string, number>();
let ordinalRowsVisited = 0;
/** Attempts to get one count while the store holds still before giving up on reuse. */
const STABLE_STORE_ATTEMPTS = 3;

/**
 * Stop reusing every ordinal watermark of a session. The store stamp already
 * catches every write; this lets a removal event drop the watermark early.
 */
export function forgetRawSessionOrdinalWatermark(sessionId: string): void {
    ordinalWatermarkEpochs.set(sessionId, (ordinalWatermarkEpochs.get(sessionId) ?? 0) + 1);
}

/** @internal Rows the canonical ordinal statements have visited since the last reset. */
export function getRawSessionOrdinalRowsVisitedForTest(): number {
    return ordinalRowsVisited;
}

/** @internal */
export function resetRawSessionOrdinalRowsVisitedForTest(): void {
    ordinalRowsVisited = 0;
}

/** Order two keys the way SQLite's BINARY collation orders `(time_created, id)`. */
function compareOrdinalKeys(left: OrdinalKey, right: OrdinalKey): number {
    if (left.timeCreated !== right.timeCreated)
        return left.timeCreated < right.timeCreated ? -1 : 1;
    if (left.id === right.id) return 0;
    return Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8"));
}

function countEligibleOrdinals(
    db: Database,
    sessionId: string,
    after: OrdinalKey | null,
    through: OrdinalKey,
): number {
    const indexed = countCanonicalOrdinalsIndexed(db, sessionId, after, through);
    if (indexed !== null) return indexed;
    const row = (
        after
            ? db
                  .prepare(ORDINAL_RANGE_BETWEEN_SQL)
                  .get(sessionId, after.timeCreated, after.id, through.timeCreated, through.id)
            : db
                  .prepare(ORDINAL_RANGE_FROM_START_SQL)
                  .get(sessionId, through.timeCreated, through.id)
    ) as { visited?: unknown; eligible?: unknown } | null;
    const visited = typeof row?.visited === "number" ? row.visited : 0;
    ordinalRowsVisited += visited;
    // This statement parses the JSON of every row it visits.
    ordinalJsonRowsRead += visited;
    return typeof row?.eligible === "number" ? row.eligible : 0;
}

/*
 * Index-only canonical counts.
 *
 * A canonical ordinal is the number of a session's messages at or before a
 * point in `(time_created, id)` order, minus the finished compaction summaries
 * among them. The first part is a COUNT(*) that the
 * `(session_id, time_created, id)` index answers on its own. The second part
 * needs message JSON, but only for rows whose `summary` flag is set, and those
 * are rare. Each connection keeps, per session, the ids of the rows it has seen
 * with that flag (the candidates). Every count re-reads the candidates by
 * primary key, so a summary that finishes later, moves in time, changes session
 * or is deleted is seen in the same statement that counts the index.
 *
 * New rows are found by rowid. `message` is an ordinary rowid table (OpenCode
 * declares `id text PRIMARY KEY`, so the rowid is separate and not
 * AUTOINCREMENT): a new row gets a rowid above every existing one. The set
 * remembers the highest rows of the table, with their ids, when it was last
 * brought up to date; the next count reads only the session's rows above the
 * highest of those that still holds the same message. SQLite hands a deleted
 * top rowid to the next insert, so a remembered row that has gone, or now holds
 * a different message, is passed over for a lower one, and only when none
 * survive is the session scanned in full again.
 *
 * This relies on one property of the writers: a row carries its `summary` flag
 * from the moment it is inserted. OpenCode 1.18 creates its compaction
 * assistant with `summary: true` and only later sets `finish` (compaction.ts
 * and processor.ts at v1.18.35), and its message upsert never changes a row's
 * session or creation time. Magic Context's own compaction marker writer
 * reports the summary rows it writes through
 * {@link noteRawSessionSummaryRowWritten}, which covers the case where its
 * upsert rewrites an existing row. An in-place edit by any other writer that
 * turns an ordinary row into a summary is not seen until
 * {@link forgetRawSessionSummaryRows} runs for the session.
 */

const EXCLUDED_ROW_SQL = `${ORDINAL_SUMMARY_FLAG_SQL} AND ${ORDINAL_STOP_FLAG_SQL}`;
/** How far below the highest rowid the remembered rows reach. */
const SUMMARY_ANCHOR_SPAN = 256;
/** How many of those rows are remembered. */
const SUMMARY_ANCHOR_LIMIT = 64;
/** Written summary ids kept per session before falling back to a full rescan. */
const WRITTEN_SUMMARY_ID_LIMIT = 4096;

interface RowAnchor {
    rowid: number;
    id: string;
}

interface SummaryCandidates {
    epoch: number;
    /** The highest rows of `message` when the set was last updated, highest first. Empty when the table was empty. */
    anchors: RowAnchor[];
    /** Ids of this session's rows that carried the `summary` flag when read. */
    ids: Set<string>;
}

/** The candidates as one count uses them: every flagged row is in `ids` or above `floorRowid`. */
interface CandidateView {
    ids: string[];
    floorRowid: number;
    /** The id the row at `floorRowid` must still hold; null when the table was empty. */
    floorId: string | null;
}

const summaryCandidateSets = new WeakMap<Database, Map<string, SummaryCandidates>>();
/** Bumped by {@link forgetRawSessionSummaryRows}; older candidate sets are rebuilt. */
const summaryCandidateEpochs = new Map<string, number>();
/** Summary rows Magic Context wrote, merged into every connection's candidates. */
const writtenSummaryIds = new Map<string, Set<string>>();
/** Connections whose `message` table cannot be read by rowid or lacks json_each. */
const indexedCountUnsupported = new WeakSet<Database>();
let ordinalJsonRowsRead = 0;
let summaryFullScans = 0;

/**
 * Rebuild a session's summary candidates from a full scan on the next count.
 * Needed only after an in-place edit that gave an existing ordinary row the
 * `summary` flag; deletes, inserts, moved timestamps and summaries finishing
 * are all seen without it.
 */
export function forgetRawSessionSummaryRows(sessionId: string): void {
    summaryCandidateEpochs.set(sessionId, (summaryCandidateEpochs.get(sessionId) ?? 0) + 1);
    writtenSummaryIds.delete(sessionId);
    // A watermark proven with the old candidates may carry the missed summary.
    forgetRawSessionOrdinalWatermark(sessionId);
}

/**
 * Record that this process wrote a compaction-summary row, so counts on every
 * connection re-read it even when the write rewrote an existing row in place.
 */
export function noteRawSessionSummaryRowWritten(sessionId: string, messageId: string): void {
    let ids = writtenSummaryIds.get(sessionId);
    if (!ids) {
        ids = new Set();
        writtenSummaryIds.set(sessionId, ids);
    }
    ids.add(messageId);
    if (ids.size > WRITTEN_SUMMARY_ID_LIMIT) forgetRawSessionSummaryRows(sessionId);
}

/** @internal Message rows whose JSON the ordinal counts may have parsed since the last reset. */
export function getRawSessionOrdinalJsonRowsReadForTest(): number {
    return ordinalJsonRowsRead;
}

/** @internal Full summary scans of a session since the last reset. */
export function getRawSessionSummaryFullScansForTest(): number {
    return summaryFullScans;
}

/** @internal */
export function resetRawSessionOrdinalJsonRowsReadForTest(): void {
    ordinalJsonRowsRead = 0;
    summaryFullScans = 0;
}

const ANCHOR_ROWS_SQL = `SELECT rowid AS rid, id, 1 AS kind FROM message
    WHERE rowid > (SELECT MAX(rowid) FROM message) - ${SUMMARY_ANCHOR_SPAN}`;

/**
 * One statement, so the remembered rows and the candidates come from the same
 * state. kind 1: a remembered row; 2: a flagged row of the session; 3: an
 * unflagged new row of the session; 4: the session's row count.
 */
const SUMMARY_FULL_SCAN_SQL = `${ANCHOR_ROWS_SQL}
    UNION ALL
    SELECT rowid, id, 2 FROM message WHERE session_id = ? AND ${ORDINAL_SUMMARY_FLAG_SQL}
    UNION ALL
    SELECT COUNT(*), NULL, 4 FROM message WHERE session_id = ?`;

/** `+session_id` keeps SQLite on the rowid range instead of the session index. */
const SUMMARY_SCAN_AFTER_SQL = `${ANCHOR_ROWS_SQL}
    UNION ALL
    SELECT rowid, id, CASE WHEN ${ORDINAL_SUMMARY_FLAG_SQL} THEN 2 ELSE 3 END
    FROM message WHERE rowid > ? AND +session_id = ?`;

const ANCHOR_CHECK_SQL =
    "SELECT rowid AS rid, id FROM message WHERE rowid IN (SELECT value FROM json_each(?))";

interface ScanRow {
    rid: number | null;
    id: string | null;
    kind: number;
}

/** The highest remembered row that still holds the same message, or undefined if none does. */
function survivingAnchor(db: Database, set: SummaryCandidates): RowAnchor | null | undefined {
    if (set.anchors.length === 0) return null;
    const current = new Map(
        (
            db
                .prepare(ANCHOR_CHECK_SQL)
                .all(JSON.stringify(set.anchors.map((anchor) => anchor.rowid))) as Array<{
                rid: number;
                id: string;
            }>
        ).map((row) => [row.rid, row.id]),
    );
    return set.anchors.find((anchor) => current.get(anchor.rowid) === anchor.id);
}

/**
 * A worker snapshot of summary candidates, global rowid anchors and exact ranks.
 * Checkpoints are durable prefix ranks: new messages extend the last anchor,
 * and a revert truncates to the newest surviving checkpoint. Message identities
 * and ordering are immutable outside tail deletion in the OpenCode store.
 */
export interface RawSessionSummaryScan {
    anchors: Array<{ rowid: number; id: string }>;
    ids: string[];
    /** Rows of the session whose JSON the scan read. */
    sessionRows: number;
    checkpoints?: Array<OrdinalKey & { ordinal: number; storedCount?: number }>;
    total?: number;
    /**
     * Highest `message` rowid the scan has observed (any session). Extension
     * only trusts ranks taken at or below this mark: a row this session
     * gains above it that sorts behind the newest checkpoint is a late
     * commit the checkpoints missed (see hasLateCommitBehindCheckpoint).
     * Absent on scans built before the mark existed; those skip the check.
     */
    maxRowid?: number;
}

interface OrdinalCheckpointState {
    epoch: number;
    scan: RawSessionSummaryScan;
}
const ordinalCheckpoints = new WeakMap<Database, Map<string, OrdinalCheckpointState>>();
const ordinalSummarySeeds = new WeakMap<
    Database,
    Map<string, { epoch: number; scan: RawSessionSummaryScan }>
>();
/**
 * Whether a late commit landed behind the newest checkpoint since the scan
 * last observed the store: rows this session gained with a rowid above the
 * scan's high-water mark that sort at or behind the checkpoint key. Such a
 * row is invisible to checkpoint extension, so extending would bake a
 * one-short drift into every later number. The rowid range seek touches only
 * rows written after the high-water mark, and message JSON is read only for
 * those rows to skip finished summaries (which never bear ordinals); with no
 * late commit the check reads nothing, however large the session. Deletions
 * behind the checkpoint are not visible here; they stay with the boundary
 * validation backstop and the newest-checkpoint truncation below.
 */
function hasLateCommitBehindCheckpoint(
    db: Database,
    sessionId: string,
    scan: RawSessionSummaryScan,
): boolean {
    const tail = scan.checkpoints?.at(-1);
    if (!tail || scan.maxRowid === undefined) return false;
    const row = db
        .prepare(
            `SELECT COUNT(*) AS count FROM message
             WHERE rowid > ? AND +session_id = ?
               AND (time_created, id) <= (?, ?)
               AND NOT (${EXCLUDED_ROW_SQL})`,
        )
        .get(scan.maxRowid, sessionId, tail.timeCreated, tail.id) as {
        count?: unknown;
    } | null;
    return typeof row?.count === "number" && row.count > 0;
}

/** Drop retained ranks and warm-up seeds without touching the summary epoch. */
function discardRetainedOrdinalRanks(db: Database, sessionId: string): void {
    ordinalCheckpoints.get(db)?.delete(sessionId);
    ordinalSummarySeeds.get(db)?.delete(sessionId);
}

const ORDINAL_LOOKUP_LIMIT = 512;

function currentOrdinalCheckpoints(
    db: Database,
    sessionId: string,
): OrdinalCheckpointState | undefined {
    const cached = ordinalCheckpoints.get(db)?.get(sessionId);
    if (!cached) return undefined;
    return withReadSnapshot(db, () => {
        if (!extendOrdinalCheckpoints(db, sessionId, cached.scan, ORDINAL_LOOKUP_LIMIT))
            return undefined;
        cached.epoch = getRawSessionSummaryEpoch(sessionId);
        return cached;
    });
}

/** Retain prefix ranks across commits; OpenCode reverts remove only a suffix. A
 * late commit behind the newest checkpoint is invisible to extension, so when
 * the check below finds one the retained ranks are dropped instead and the
 * next warm-up scans from scratch. */
function extendOrdinalCheckpoints(
    db: Database,
    sessionId: string,
    scan: RawSessionSummaryScan,
    limit?: number,
): boolean {
    const points = scan.checkpoints ?? [];
    const exists = (point: OrdinalKey) =>
        Boolean(
            db
                .prepare("SELECT 1 FROM message WHERE id=? AND session_id=? AND time_created=?")
                .get(point.id, sessionId, point.timeCreated),
        );
    // Binary search keeps the newest surviving page after a revert. At most one
    // old page is replayed, rather than warming the entire surviving prefix.
    if (points.length && !exists(points[points.length - 1])) {
        let low = 0;
        let high = points.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (exists(points[middle])) low = middle + 1;
            else high = middle;
        }
        points.length = low;
        scan.total = points.at(-1)?.ordinal ?? 0;
        scan.sessionRows = points.at(-1)?.storedCount ?? 0;
    }
    const tail = points.at(-1);
    const rows = db
        .prepare(`SELECT id, time_created AS timeCreated, rowid AS rowid, ${EXCLUDED_ROW_SQL} AS excluded FROM message
        WHERE session_id=?${tail ? " AND (time_created,id) > (?,?)" : ""}
        ORDER BY time_created,id${limit === undefined ? "" : ` LIMIT ${limit + 1}`}`)
        .all(sessionId, ...(tail ? [tail.timeCreated, tail.id] : [])) as Array<
        OrdinalKey & { excluded: number; rowid: number }
    >;
    ordinalJsonRowsRead += rows.length;
    if (hasLateCommitBehindCheckpoint(db, sessionId, scan)) {
        // A commit landed behind the newest checkpoint: the retained prefix
        // ranks are short, and extending them would bake the drift into every
        // later number. Drop them so the next warm-up scans from scratch,
        // and report not-warm so callers defer and re-warm. The serving thread
        // additionally bumps the summary epoch, rejecting a warm-up already
        // in flight that was built from the drifted ranks. A worker never
        // bumps it: its install carries the serving thread's epoch, and any
        // install the bump would have rejected is caught by the next check
        // instead — the store necessarily changed after those ranks were
        // taken.
        discardRetainedOrdinalRanks(db, sessionId);
        if (isMainThread) forgetRawSessionSummaryRows(sessionId);
        return false;
    }
    if (limit !== undefined && rows.length > limit) return false;
    let total = scan.total ?? 0;
    // Only page boundaries and the current tail are retained, even after years
    // of one-message appends. The previous partial-page tail is redundant.
    if (rows.length && tail && (tail.storedCount ?? 0) % 256 !== 0) points.pop();
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (row.excluded !== 1) total++;
        const storedCount = scan.sessionRows + index + 1;
        if (storedCount % 256 === 0 || index === rows.length - 1)
            points.push({ id: row.id, timeCreated: row.timeCreated, ordinal: total, storedCount });
    }
    scan.checkpoints = points;
    scan.sessionRows += rows.length;
    scan.total = total;
    // The rows above are complete (the capped-page case returned early), so
    // the highest rowid seen is the new high-water mark for the next check.
    if (rows.length > 0) {
        let maxRowid = scan.maxRowid ?? -1;
        for (const row of rows) if (row.rowid > maxRowid) maxRowid = row.rowid;
        scan.maxRowid = maxRowid;
    }
    return true;
}

export class RawOrdinalsNotReady extends Error {
    constructor() {
        super("canonical ordinals are warming off-thread; retry after preparation");
    }
}

/** Retained ranks seed a worker when more than one bounded page was appended. */
export function rawOrdinalSummarySeed(
    db: Database,
    sessionId: string,
): RawSessionSummaryScan | undefined {
    const retained = ordinalCheckpoints.get(db)?.get(sessionId);
    if (retained) return retained.scan;
    const seed = ordinalSummarySeeds.get(db)?.get(sessionId);
    if (!seed || seed.epoch !== getRawSessionSummaryEpoch(sessionId)) return undefined;
    return {
        ...seed.scan,
        ids: [...new Set([...seed.scan.ids, ...(writtenSummaryIds.get(sessionId) ?? [])])],
    };
}

/**
 * Drop this connection's retained ordinal ranks for a session after an exact
 * read proved them wrong (a row committed behind the newest checkpoint is
 * invisible to checkpoint extension, so every later rank is one short).
 * Deleting both the serving ranks and the warm-up seed forces the next
 * warm-up to scan the session from scratch instead of extending the drifted
 * ranks. The epoch bump additionally rejects a warm-up that is already in
 * flight but was built from those ranks, so only a post-drop full scan can
 * install. Callers re-warm with {@link prewarmRawSessionOrdinalsForDb} (see
 * raw-ordinal-warmup.ts) and read nothing until it reports warm.
 */
export function dropRawSessionOrdinalCheckpoints(db: Database, sessionId: string): void {
    discardRetainedOrdinalRanks(db, sessionId);
    forgetRawSessionSummaryRows(sessionId);
}

function boundedOrdinalPrefix(db: Database, sessionId: string, through: OrdinalKey | null): number {
    const cached = currentOrdinalCheckpoints(db, sessionId);
    if (cached && through === null) return cached.scan.total ?? 0;
    let floor: (OrdinalKey & { ordinal: number }) | undefined;
    if (cached && through) {
        const points = cached.scan.checkpoints ?? [];
        let low = 0;
        let high = points.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (compareOrdinalKeys(points[middle], through) <= 0) low = middle + 1;
            else high = middle;
        }
        floor = points[low - 1];
        if (floor && compareOrdinalKeys(floor, through) === 0) return floor.ordinal;
    }
    const bindings: Array<string | number> = [sessionId];
    if (floor) bindings.push(floor.timeCreated, floor.id);
    if (through) bindings.push(through.timeCreated, through.id);
    // LIMIT is applied to index keys before reading JSON. Even an unprepared
    // synchronous caller can inspect only this bounded suffix, never a prefix scan.
    const rows = db
        .prepare(`SELECT ${EXCLUDED_ROW_SQL} AS excluded FROM message WHERE id IN (
        SELECT id FROM message WHERE session_id = ?${floor ? " AND (time_created, id) > (?, ?)" : ""}${through ? " AND (time_created, id) <= (?, ?)" : ""}
        ORDER BY time_created, id LIMIT ${ORDINAL_LOOKUP_LIMIT + 1})`)
        .all(...bindings) as Array<{ excluded: number }>;
    ordinalRowsVisited += rows.length;
    ordinalJsonRowsRead += rows.length;
    if (rows.length > ORDINAL_LOOKUP_LIMIT) {
        void prewarmRawSessionOrdinalsForDb(db, sessionId);
        throw new RawOrdinalsNotReady();
    }
    return (floor?.ordinal ?? 0) + rows.reduce((sum, row) => sum + (row.excluded === 1 ? 0 : 1), 0);
}

/** Discover summary candidates and build ranks on the worker's read snapshot. */
export function scanRawSessionSummaryRows(
    db: Database,
    sessionId: string,
    previous?: RawSessionSummaryScan,
): RawSessionSummaryScan {
    return withReadSnapshot(db, () => {
        if (previous?.checkpoints && extendOrdinalCheckpoints(db, sessionId, previous)) {
            return previous;
        }
        // A retained checkpoint the store has moved behind (a late commit) is
        // not extended: the full scan below rebuilds ranks from scratch
        // instead of baking the drift in.
        if (previous) {
            const sessions = summaryCandidateSets.get(db) ?? new Map();
            sessions.set(sessionId, {
                epoch: getRawSessionSummaryEpoch(sessionId),
                anchors: previous.anchors,
                ids: new Set(previous.ids),
            });
            summaryCandidateSets.set(db, sessions);
        }
        const incremental =
            previous && isRawSessionSummaryWarm(db, sessionId)
                ? summaryCandidatesOf(db, sessionId)
                : undefined;
        const rows = incremental
            ? []
            : (db.prepare(SUMMARY_FULL_SCAN_SQL).all(sessionId, sessionId) as ScanRow[]);
        const anchors: RowAnchor[] = [];
        const ids: string[] = [];
        let sessionRows = 0;
        for (const row of rows) {
            if (row.kind === 1 && typeof row.rid === "number" && typeof row.id === "string")
                anchors.push({ rowid: row.rid, id: row.id });
            else if (row.kind === 2 && typeof row.id === "string") ids.push(row.id);
            else if (row.kind === 4 && typeof row.rid === "number") sessionRows = row.rid;
        }
        if (incremental) {
            ids.push(...incremental.ids);
            anchors.push(...(summaryCandidateSets.get(db)?.get(sessionId)?.anchors ?? []));
            sessionRows = countStoredRawSessionRowsIndexed(db, sessionId);
        }
        anchors.sort((left, right) => right.rowid - left.rowid);
        anchors.length = Math.min(anchors.length, SUMMARY_ANCHOR_LIMIT);
        // Seeds are discovery hints, not exclusion certificates. An existing
        // row can move into this session below every surviving anchor. Rank
        // construction therefore evaluates the current predicate for every row
        // on the worker snapshot, including IDs absent from the seed.
        const keys = db
            .prepare(`SELECT id, time_created AS timeCreated, rowid AS rowid, ${EXCLUDED_ROW_SQL} AS excluded FROM message WHERE session_id = ?
        ORDER BY time_created, id`)
            .all(sessionId) as Array<OrdinalKey & { excluded: number; rowid: number }>;
        const checkpoints: Array<OrdinalKey & { ordinal: number; storedCount: number }> = [];
        let total = 0;
        let maxRowid: number | undefined;
        for (let index = 0; index < keys.length; index++) {
            const key = keys[index];
            if (typeof key.rowid === "number")
                maxRowid = maxRowid === undefined ? key.rowid : Math.max(maxRowid, key.rowid);
            if (key.excluded !== 1) total++;
            if (index % 256 === 255 || index === keys.length - 1)
                checkpoints.push({
                    id: key.id,
                    timeCreated: key.timeCreated,
                    ordinal: total,
                    storedCount: index + 1,
                });
        }
        return { anchors, ids, sessionRows, checkpoints, total, maxRowid };
    });
}

/** The value to pass to {@link installRawSessionSummaryScan} for a scan started now. */
export function getRawSessionSummaryEpoch(sessionId: string): number {
    return summaryCandidateEpochs.get(sessionId) ?? 0;
}

/**
 * Retain discovered candidates and prefix ranks for incremental extension.
 * Tail removals during a cold scan are repaired against the serving snapshot
 * before ranks become ready. A later revert retains the same surviving prefix.
 */
export function installRawSessionSummaryScan(
    db: Database,
    sessionId: string,
    scan: RawSessionSummaryScan,
    epoch: number,
    workerPrepared = false,
): boolean {
    if (epoch !== getRawSessionSummaryEpoch(sessionId)) return false;
    const seeds = ordinalSummarySeeds.get(db) ?? new Map();
    seeds.set(sessionId, { epoch, scan });
    ordinalSummarySeeds.set(db, seeds);
    if (scan.checkpoints && workerPrepared) {
        const counts = ordinalCheckpoints.get(db) ?? new Map();
        counts.set(sessionId, { epoch, scan });
        ordinalCheckpoints.set(db, counts);
    } else if (getSqliteDatabasePath(db) && isMainThread) return false;
    if (isRawSessionSummaryWarm(db, sessionId)) return true;
    let sessions = summaryCandidateSets.get(db);
    if (!sessions) {
        sessions = new Map();
        summaryCandidateSets.set(db, sessions);
    }
    sessions.set(sessionId, { epoch, anchors: [...scan.anchors], ids: new Set(scan.ids) });
    return isRawSessionSummaryWarm(db, sessionId);
}

/**
 * File-store reads need worker-built prefix ranks so host lookups read only a
 * bounded suffix. Workers and memory stores can discover summary candidates
 * directly, retaining them while their remembered rowid still names the same row.
 */
export function isRawSessionSummaryWarm(db: Database, sessionId: string): boolean {
    if (isMainThread && getSqliteDatabasePath(db)) {
        return Boolean(currentOrdinalCheckpoints(db, sessionId));
    }
    const set = summaryCandidateSets.get(db)?.get(sessionId);
    if (!set || set.epoch !== getRawSessionSummaryEpoch(sessionId)) return false;
    try {
        return survivingAnchor(db, set) !== undefined;
    } catch {
        return false;
    }
}

/** Message rows of a session, counted from the `(session_id, ...)` index alone. */
export function countStoredRawSessionRowsIndexed(db: Database, sessionId: string): number {
    const row = db
        .prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?")
        .get(sessionId) as { count?: number } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

function summaryCandidatesOf(db: Database, sessionId: string): CandidateView {
    let sessions = summaryCandidateSets.get(db);
    if (!sessions) {
        sessions = new Map();
        summaryCandidateSets.set(db, sessions);
    }
    const epoch = getRawSessionSummaryEpoch(sessionId);
    const cached = sessions.get(sessionId);
    // null: the table was empty, so every row is new. undefined: rescan.
    const floor = cached && cached.epoch === epoch ? survivingAnchor(db, cached) : undefined;
    let ids: Set<string>;
    let anchors: RowAnchor[];
    if (floor === undefined) {
        const scan = scanRawSessionSummaryRows(db, sessionId);
        summaryFullScans += 1;
        ordinalJsonRowsRead += scan.sessionRows;
        ids = new Set(scan.ids);
        anchors = scan.anchors;
    } else {
        const rows = db
            .prepare(SUMMARY_SCAN_AFTER_SQL)
            .all(floor?.rowid ?? 0, sessionId) as ScanRow[];
        ids = cached?.ids ?? new Set<string>();
        anchors = [];
        for (const row of rows) {
            if (row.kind === 1 && typeof row.rid === "number" && typeof row.id === "string")
                anchors.push({ rowid: row.rid, id: row.id });
            else if (row.kind === 2 && typeof row.id === "string") ids.add(row.id);
            if (row.kind === 2 || row.kind === 3) ordinalJsonRowsRead += 1;
        }
        anchors.sort((left, right) => right.rowid - left.rowid);
        anchors.length = Math.min(anchors.length, SUMMARY_ANCHOR_LIMIT);
    }
    for (const id of writtenSummaryIds.get(sessionId) ?? []) ids.add(id);
    sessions.set(sessionId, { epoch, anchors, ids });
    const top = anchors[0];
    return { ids: [...ids], floorRowid: top?.rowid ?? 0, floorId: top?.id ?? null };
}

function canonicalCountSql(lower: boolean, upper: boolean): string {
    const range = `${lower ? " AND (time_created, id) > (?, ?)" : ""}${
        upper ? " AND (time_created, id) <= (?, ?)" : ""
    }`;
    return `SELECT
        (SELECT COUNT(*) FROM message WHERE session_id = ?${range}) AS stored,
        (SELECT COUNT(*) FROM message
          WHERE id IN (SELECT value FROM json_each(?)) AND +session_id = ?${range}
            AND ${EXCLUDED_ROW_SQL}) AS knownExcluded,
        (SELECT COUNT(*) FROM message
          WHERE rowid > ? AND +session_id = ? AND id NOT IN (SELECT value FROM json_each(?))${range}
            AND ${EXCLUDED_ROW_SQL}) AS newExcluded,
        (SELECT id FROM message WHERE rowid = ?) AS floorId`;
}

const CANONICAL_COUNT_SQL = new Map<string, string>();
function canonicalCountStatementText(lower: boolean, upper: boolean): string {
    const key = `${lower}:${upper}`;
    let sql = CANONICAL_COUNT_SQL.get(key);
    if (!sql) {
        sql = canonicalCountSql(lower, upper);
        CANONICAL_COUNT_SQL.set(key, sql);
    }
    return sql;
}

/**
 * File-store serving counts use checkpoints and bounded reads, or defer. Workers
 * and in-memory stores use the index plus summary candidates, with the legacy
 * JSON-reading fallback when those facilities are unavailable.
 */
function countCanonicalOrdinalsIndexed(
    db: Database,
    sessionId: string,
    after: OrdinalKey | null,
    through: OrdinalKey | null,
): number | null {
    if (isMainThread && getSqliteDatabasePath(db)) {
        return withReadSnapshot(
            db,
            () =>
                boundedOrdinalPrefix(db, sessionId, through) -
                (after ? boundedOrdinalPrefix(db, sessionId, after) : 0),
        );
    }
    if (indexedCountUnsupported.has(db)) return null;
    const range: Array<string | number> = [];
    if (after) range.push(after.timeCreated, after.id);
    if (through) range.push(through.timeCreated, through.id);
    try {
        return withReadSnapshot(db, () => {
            // Inside one read snapshot no other connection's commit can land
            // between validating the remembered rows, reading the rows above
            // them and counting. The check that the remembered top row still
            // holds the same message id (floorId) can then only fail when the
            // caller's own open transaction wrote in between.
            for (let attempt = 0; attempt < STABLE_STORE_ATTEMPTS; attempt += 1) {
                const view = summaryCandidatesOf(db, sessionId);
                const ids = JSON.stringify(view.ids);
                const row = db
                    .prepare(canonicalCountStatementText(after !== null, through !== null))
                    .get(
                        sessionId,
                        ...range,
                        ids,
                        sessionId,
                        ...range,
                        view.floorRowid,
                        sessionId,
                        ids,
                        ...range,
                        view.floorRowid,
                    ) as {
                    stored?: unknown;
                    knownExcluded?: unknown;
                    newExcluded?: unknown;
                    floorId?: unknown;
                } | null;
                if (view.floorId !== null && row?.floorId !== view.floorId) continue;
                const stored = typeof row?.stored === "number" ? row.stored : 0;
                const excluded =
                    (typeof row?.knownExcluded === "number" ? row.knownExcluded : 0) +
                    (typeof row?.newExcluded === "number" ? row.newExcluded : 0);
                ordinalRowsVisited += stored;
                ordinalJsonRowsRead += view.ids.length;
                return stored - excluded;
            }
            return null;
        });
    } catch (error) {
        // A store without a rowid `message` table or without JSON1's json_each
        // (test fixtures, unusual builds) keeps the JSON-reading count.
        if (/no such (column|table|function)|json_each/i.test(String(error))) {
            indexedCountUnsupported.add(db);
            return null;
        }
        throw error;
    }
}

function connectionHasOpenTransaction(db: Database): boolean {
    const state = db as unknown as { inTransaction?: unknown; isTransaction?: unknown };
    return state.inTransaction === true || state.isTransaction === true;
}

/**
 * Run `read` inside one read transaction, so all its statements see the same
 * committed state (in WAL mode, one snapshot). A transaction the caller already
 * holds is used as it is. The transaction only reads, so it is ended with
 * ROLLBACK, which releases the snapshot without a commit.
 */
function withReadSnapshot<T>(db: Database, read: () => T): T {
    if (connectionHasOpenTransaction(db)) return read();
    db.exec("BEGIN");
    try {
        return read();
    } finally {
        if (connectionHasOpenTransaction(db)) db.exec("ROLLBACK");
    }
}

function reusableWatermark(
    db: Database,
    sessionId: string,
    stamp: StoreStamp | null,
): OrdinalWatermark | null {
    const watermark = ordinalWatermarks.get(db)?.get(sessionId);
    if (
        !watermark ||
        watermark.epoch !== (ordinalWatermarkEpochs.get(sessionId) ?? 0) ||
        !sameStoreStamp(watermark.stamp, stamp)
    )
        return null;
    return watermark;
}

function rememberOrdinalWatermark(
    db: Database,
    sessionId: string,
    key: OrdinalKey,
    ordinal: number,
    stamp: StoreStamp,
): void {
    let sessions = ordinalWatermarks.get(db);
    if (!sessions) {
        sessions = new Map();
        ordinalWatermarks.set(db, sessions);
    }
    const current = sessions.get(sessionId);
    // Within one store state keep the latest proven point: lookups of later
    // messages then count only the rows after it.
    if (current && sameStoreStamp(current.stamp, stamp) && compareOrdinalKeys(current, key) >= 0)
        return;
    sessions.set(sessionId, {
        timeCreated: key.timeCreated,
        id: key.id,
        ordinal,
        stamp,
        epoch: ordinalWatermarkEpochs.get(sessionId) ?? 0,
    });
}

/**
 * Canonical ordinal of one stored message: the number of ordinal-bearing rows
 * of the session at or before it in `(time_created, id)` order. Returns the raw
 * count, which is 0 when nothing at or before the target bears an ordinal.
 *
 * `readTarget` reads the target's key. It runs between two readings of the
 * store stamp together with the count, so a result is only reused, or used to
 * leave a watermark, when no commit or local write happened while it was
 * computed. A watermark is used only while the stamp it was proven under is
 * unchanged; then a lookup counts just the rows between the watermark and the
 * target. Any write anywhere in the store (an append, a delete, a moved
 * timestamp, a rewritten summary, another process's commit) changes the stamp,
 * and the whole prefix is counted again. That count reads the index, not the
 * messages: see {@link countCanonicalOrdinalsIndexed}.
 */
function canonicalOrdinalOf<T extends OrdinalKey>(
    db: Database,
    sessionId: string,
    readTarget: () => T | null,
): { target: T; ordinal: number } | null {
    for (let attempt = 1; ; attempt += 1) {
        const before = readStoreStamp(db);
        const target = readTarget();
        if (!target) return null;
        const watermark =
            attempt < STABLE_STORE_ATTEMPTS ? reusableWatermark(db, sessionId, before) : null;
        if (!watermark) {
            // One statement over the whole prefix is consistent on its own.
            const ordinal = countEligibleOrdinals(db, sessionId, null, target);
            if (before && sameStoreStamp(before, readStoreStamp(db)))
                rememberOrdinalWatermark(db, sessionId, target, ordinal, before);
            return { target, ordinal };
        }
        const order = compareOrdinalKeys(target, watermark);
        const ordinal =
            order === 0
                ? watermark.ordinal
                : order < 0
                  ? // ordinal(target) = ordinal(watermark) - eligible rows in (target, watermark].
                    watermark.ordinal - countEligibleOrdinals(db, sessionId, target, watermark)
                  : watermark.ordinal + countEligibleOrdinals(db, sessionId, watermark, target);
        if (sameStoreStamp(before, readStoreStamp(db))) {
            rememberOrdinalWatermark(db, sessionId, target, ordinal, before as StoreStamp);
            return { target, ordinal };
        }
        // The store changed while counting, so the answer may mix two states.
        // Try again; the last attempt counts the whole prefix.
    }
}

/**
 * Resolve one message ID in the canonical raw-message ordinal space. Synthetic
 * compaction summaries are excluded so this count matches every module wire
 * ordinal and does not depend on the stored compartment basis.
 */
export function readRawSessionMessageOrdinalByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
): number | null {
    const counted = canonicalOrdinalOf(db, sessionId, () => {
        const row = db
            .prepare(
                `SELECT id, time_created, ${ORDINAL_SUMMARY_FLAG_SQL} AND ${ORDINAL_STOP_FLAG_SQL} AS excluded
                 FROM message WHERE session_id = ? AND id = ?`,
            )
            .get(sessionId, messageId) as {
            id?: unknown;
            time_created?: unknown;
            excluded?: unknown;
        } | null;
        if (typeof row?.id !== "string" || typeof row.time_created !== "number") return null;
        return { id: row.id, timeCreated: row.time_created, excluded: row.excluded === 1 };
    });
    // An excluded target has no ordinal of its own.
    if (!counted || counted.target.excluded) return null;
    return counted.ordinal > 0 ? counted.ordinal : null;
}

export function readRawSessionMessageByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
): RawMessage | null {
    const counted = canonicalOrdinalOf(db, sessionId, () => {
        const row = db
            .prepare(
                "SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? AND id = ?",
            )
            .get(sessionId, messageId) as RawMessageRow | null;
        if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number") return null;
        // Unreadable messages and compaction summaries are not served; skip the count.
        const parsed = parseJsonRecord(row.data);
        if (!parsed || isRawCompactionSummaryInfo(parsed)) return null;
        return { ...row, timeCreated: row.time_created, info: parsed };
    });
    if (!counted) return null;
    const { target: row, ordinal } = counted;
    const info = row.info;
    if (ordinal <= 0) {
        return null;
    }

    const partRows = db
        .prepare(RAW_MESSAGE_PARTS_BY_ID_SQL)
        .all(sessionId, messageId)
        .filter(isRawPartRow);

    const role = typeof info.role === "string" ? info.role : "unknown";
    return {
        ordinal,
        id: row.id,
        role,
        parts: partRows.map((part) =>
            attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated),
        ),
        createdAt: row.time_created,
        version: row.time_updated ?? null,
    };
}

/** Existence does not require a canonical ordinal or any part payloads. */
export function hasRawSessionMessageByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
): boolean {
    const row = db
        .prepare("SELECT id, data, time_created FROM message WHERE session_id = ? AND id = ?")
        .get(sessionId, messageId) as RawMessageRow | null;
    if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number") return false;
    const info = parseJsonRecord(row.data);
    if (!info || isRawCompactionSummaryInfo(info)) return false;
    // The legacy ordinal SQL also excludes numeric summary=1. Preserve its
    // unusual point-lookup behavior for those rows without taxing ordinary ids.
    if (info.summary === 1 && info.finish === "stop")
        return readRawSessionMessageByIdFromDb(db, sessionId, messageId) !== null;
    return true;
}

/** Read the canonical servable tail and its parts in one query, including its boundary row. */
export function readRawSeedTailFromDb(
    db: Database,
    sessionId: string,
    boundaryId: string | null,
): Map<string, RawMessage> {
    const rows = db
        .prepare(`
        WITH canonical AS (
            SELECT id, time_created,
                   ROW_NUMBER() OVER (ORDER BY time_created, id) AS ordinal
            FROM message WHERE session_id = ?
              AND NOT (CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.summary'), 0) ELSE 0 END = 1
                AND CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.finish'), '') ELSE '' END = 'stop')
        )
        SELECT c.id, m.data, c.time_created, m.time_updated, c.ordinal,
               p.data AS part_data, p.time_updated AS part_updated
        FROM canonical c JOIN message m ON m.id = c.id
        LEFT JOIN part p ON +p.session_id = ? AND likelihood(p.message_id = c.id, 0.000001)
        WHERE ? IS NULL OR c.ordinal >= (SELECT ordinal FROM canonical WHERE id = ?)
        ORDER BY c.ordinal, p.time_created, p.id
    `)
        .all(sessionId, sessionId, boundaryId, boundaryId) as Array<
        RawMessageRow & { ordinal: number; part_data: string | null; part_updated: number | null }
    >;
    const messages = new Map<string, RawMessage>();
    for (const row of rows) {
        if (!messages.has(row.id)) {
            const info = parseJsonRecord(row.data);
            if (!info) continue;
            messages.set(row.id, {
                id: row.id,
                ordinal: row.ordinal,
                role: typeof info.role === "string" ? info.role : "unknown",
                createdAt: row.time_created,
                version: row.time_updated,
                parts: [],
            });
        }
        if (row.part_data !== null)
            messages
                .get(row.id)
                ?.parts.push(
                    attachRawPartVersion(
                        parseJsonUnknown(row.part_data),
                        row.part_updated ?? undefined,
                    ),
                );
    }
    if (boundaryId !== null && !messages.has(boundaryId))
        throw new Error("state_sync materialized boundary is missing from raw storage");
    return messages;
}

/**
 * What compartment boundary resolution needs to know about one boundary
 * message. `null` in the result map means the message is not servable (absent,
 * unreadable, or a finished compaction summary), exactly the messages
 * {@link readRawSessionMessagePartsByIdFromDb} returns null for.
 */
export interface RawBoundaryEndpoint {
    /** Ordinal as {@link readRawSessionMessageIdOrdinalsForRangeFromDb} numbers it; null when it has none. */
    ordinal: number | null;
    createdAt: number;
    /**
     * Index of the message's last module block, the value
     * `moduleRawBlockMappings(parts).at(-1)?.blockIndex ?? 0` yields. Only
     * present when the caller asked for it.
     */
    lastBlockIndex?: number;
}

/**
 * Ordinals of the requested ids. The numbering repeats
 * {@link readRawSessionMessageIdOrdinalsForRangeFromDb} from ordinal 1: the
 * same summary predicate and order, and a row whose id or data is not text
 * takes no ordinal (that reader drops such rows before numbering). SQLite
 * numbers the whole session, but only the requested ids come back.
 */
const BOUNDARY_ORDINAL_SQL = `
    SELECT id, ordinal FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY time_created, id) AS ordinal
        FROM message
        WHERE session_id = ?
          AND typeof(id) = 'text' AND typeof(data) = 'text'
          AND CASE WHEN json_valid(data) THEN NOT (
                COALESCE(json_type(data, '$.summary'), '') = 'true'
                AND COALESCE(json_extract(data, '$.finish'), '') = 'stop'
              ) ELSE 1 END
    )
    WHERE id IN (SELECT value FROM json_each(?))`;

/**
 * The requested rows themselves, by primary key (unary `+` keeps the planner
 * off the session index), with their small info JSON.
 */
const BOUNDARY_MESSAGE_SQL = `
    SELECT id, data, time_created FROM message
    WHERE +session_id = ? AND id IN (SELECT value FROM json_each(?))`;

/**
 * Module blocks per message, computed inside SQLite so multi-MiB tool parts
 * are never copied into JavaScript. The weights repeat `moduleRawBlockMappings`
 * in module-wire.ts: a part that is not a JSON object adds nothing; a type
 * that is not a string counts as "unknown"; ignored text and bookkeeping
 * parts add nothing; a tool call adds one block, plus one for its result once
 * the state is completed or errored; every other part adds one. Keep the two
 * in step.
 */
const BOUNDARY_BLOCK_COUNT_SQL = `
    SELECT message_id AS id, SUM(
        CASE
            WHEN NOT json_valid(data) OR json_type(data) <> 'object' THEN 0
            ELSE CASE (CASE WHEN json_type(data, '$.type') = 'text'
                            THEN json_extract(data, '$.type') ELSE 'unknown' END)
                WHEN 'text' THEN CASE WHEN json_type(data, '$.ignored') = 'true' THEN 0 ELSE 1 END
                WHEN 'reasoning' THEN 1
                WHEN 'thinking' THEN 1
                WHEN 'redacted_thinking' THEN 1
                WHEN 'tool' THEN 1 + CASE
                    WHEN json_type(data, '$.state') = 'object'
                     AND json_type(data, '$.state.status') = 'text'
                     AND json_extract(data, '$.state.status') IN ('completed', 'error')
                    THEN 1 ELSE 0 END
                WHEN 'compaction' THEN 0
                WHEN 'step-finish' THEN 0
                WHEN 'snapshot' THEN 0
                WHEN 'patch' THEN 0
                WHEN 'agent' THEN 0
                WHEN 'retry' THEN 0
                ELSE 1
            END
        END) AS blocks
    FROM part
    WHERE +session_id = ?
      AND message_id IN (SELECT value FROM json_each(?))
      AND typeof(message_id) = 'text' AND typeof(data) = 'text'
    GROUP BY message_id`;

interface BoundaryEndpointCache {
    stamp: StoreStamp;
    endpoints: Map<string, RawBoundaryEndpoint | null>;
}

/**
 * Boundary facts per connection and session, valid only while the store stamp
 * they were read under is unchanged: any write anywhere in the store moves the
 * stamp, so a reused fact is one no write could have changed.
 */
const boundaryEndpointCaches = new WeakMap<Database, Map<string, BoundaryEndpointCache>>();
/** Sessions kept per connection; a host process works on a handful at a time. */
const BOUNDARY_ENDPOINT_CACHE_SESSIONS = 16;
let boundaryEndpointRowsRead = 0;

/** @internal Boundary message ids read from the store since the last reset. */
export function getRawBoundaryEndpointRowsReadForTest(): number {
    return boundaryEndpointRowsRead;
}

/** @internal */
export function resetRawBoundaryEndpointRowsReadForTest(): void {
    boundaryEndpointRowsRead = 0;
}

function readBoundaryEndpointRows(
    db: Database,
    sessionId: string,
    ids: readonly string[],
    blockIds: readonly string[],
    into: Map<string, RawBoundaryEndpoint | null>,
): void {
    if (ids.length > 0) {
        boundaryEndpointRowsRead += ids.length;
        const wanted = JSON.stringify(ids);
        const ordinals = new Map<string, number>();
        for (const row of db.prepare(BOUNDARY_ORDINAL_SQL).all(sessionId, wanted) as Array<{
            id: string;
            ordinal: number;
        }>) {
            ordinals.set(row.id, row.ordinal);
        }
        const rows = db.prepare(BOUNDARY_MESSAGE_SQL).all(sessionId, wanted) as RawMessageRow[];
        for (const id of ids) into.set(id, null);
        for (const row of rows) {
            // Skip rows readRawSessionMessagePartsByIdFromDb would return null for:
            // non-text id or data, a non-numeric time_created, info that is not a
            // JSON object, and finished compaction summaries.
            if (!isRawMessageRow(row) || typeof row.time_created !== "number") continue;
            const info = parseJsonRecord(row.data);
            if (!info || isRawCompactionSummaryInfo(info)) continue;
            into.set(row.id, {
                ordinal: ordinals.get(row.id) ?? null,
                createdAt: row.time_created,
            });
        }
    }
    const servable = blockIds.filter((id) => {
        const endpoint = into.get(id);
        return endpoint && endpoint.lastBlockIndex === undefined;
    });
    if (servable.length === 0) return;
    const counts = new Map<string, number>();
    for (const row of db
        .prepare(BOUNDARY_BLOCK_COUNT_SQL)
        .all(sessionId, JSON.stringify(servable)) as Array<{ id: string; blocks: number }>) {
        counts.set(row.id, row.blocks);
    }
    for (const id of servable) {
        const endpoint = into.get(id);
        if (!endpoint) continue;
        const blocks = counts.get(id) ?? 0;
        into.set(id, { ...endpoint, lastBlockIndex: blocks > 0 ? blocks - 1 : 0 });
    }
}

/**
 * For each id, its ordinal and creation time, or null when it is not
 * servable (see RawBoundaryEndpoint). Ids in `blockIds` also get
 * `lastBlockIndex`, the index of the message's last module block. Message rows
 * are read in two statements over just the requested ids, and block counts in
 * one more, so no message JSON other than theirs reaches JavaScript. While the
 * store is unchanged since an earlier call, ids answered then are not read
 * again.
 */
export function readRawSessionBoundaryEndpointsFromDb(
    db: Database,
    sessionId: string,
    ids: readonly string[],
    blockIds: readonly string[] = [],
): Map<string, RawBoundaryEndpoint | null> {
    const wanted = [...new Set(ids)];
    const wantedBlocks = [...new Set(blockIds)];
    let sessions = boundaryEndpointCaches.get(db);
    if (!sessions) {
        sessions = new Map();
        boundaryEndpointCaches.set(db, sessions);
    }
    for (let attempt = 1; ; attempt += 1) {
        const before = readStoreStamp(db);
        const cached = sessions.get(sessionId);
        // The second attempt reads everything again, so the answer comes from
        // one snapshot even when the store moved while the first was reading.
        const reuse = attempt === 1 && cached && sameStoreStamp(cached.stamp, before);
        const endpoints = new Map(reuse ? cached.endpoints : []);
        const missing = wanted.filter((id) => !endpoints.has(id));
        withReadSnapshot(db, () =>
            readBoundaryEndpointRows(db, sessionId, missing, wantedBlocks, endpoints),
        );
        const unchanged = before !== null && sameStoreStamp(before, readStoreStamp(db));
        if (unchanged) {
            sessions.delete(sessionId);
            sessions.set(sessionId, { stamp: before, endpoints });
            while (sessions.size > BOUNDARY_ENDPOINT_CACHE_SESSIONS) {
                const oldest = sessions.keys().next().value;
                if (oldest === undefined) break;
                sessions.delete(oldest);
            }
        } else if (reuse) {
            // Cached facts and fresh reads may describe different store states.
            continue;
        }
        return new Map(wanted.map((id) => [id, endpoints.get(id) ?? null]));
    }
}
