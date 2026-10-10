import type { Database } from "../../shared/sqlite";

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

    // The ordinal seek is needed only for the first page of a range. Later
    // pages resume after the last filtered row, including timestamp ties. The
    // redundant lower bound lets SQLite seek the session/time index before
    // evaluating the tie-break and JSON filter.
    const parameters: Array<string | number> = [sessionId];
    if (after) parameters.push(after.timeCreated, after.timeCreated, after.timeCreated, after.id);
    parameters.push(pageSize);
    if (!after) parameters.push(Math.max(0, Math.floor(afterOrdinal)));
    return db
        .prepare(
            `SELECT id, data, time_created, time_updated
             FROM message
             WHERE session_id = ?
                ${after ? "AND time_created >= ? AND (time_created > ? OR (time_created = ? AND id > ?))" : ""}
                AND NOT (
                   CASE WHEN json_valid(data) = 1
                        THEN COALESCE(json_extract(data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(data) = 1
                            THEN COALESCE(json_extract(data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )
             ORDER BY time_created ASC, id ASC
             LIMIT ? ${after ? "" : "OFFSET ?"}`,
        )
        .all(...parameters)
        .filter(isRawMessageRow)
        .map(
            (row, index): PagedRawMessageRow => ({
                ...row,
                ordinal: Math.floor(afterOrdinal) + index + 1,
            }),
        );
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

export function countRawSessionMessageOrdinalsFromDb(db: Database, sessionId: string): number {
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

/**
 * Read the canonical raw-message ordinal space without loading or parsing part rows.
 * Keep the ordering, summary predicate, and malformed-message behavior identical to
 * `readRawSessionMessagesFromDb`; consumers compare these ordinals across passes.
 */
export function readRawSessionMessageIdOrdinalsFromDb(
    db: Database,
    sessionId: string,
): Map<string, number> {
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
    const row = (
        after
            ? db
                  .prepare(ORDINAL_RANGE_BETWEEN_SQL)
                  .get(sessionId, after.timeCreated, after.id, through.timeCreated, through.id)
            : db
                  .prepare(ORDINAL_RANGE_FROM_START_SQL)
                  .get(sessionId, through.timeCreated, through.id)
    ) as { visited?: unknown; eligible?: unknown } | null;
    ordinalRowsVisited += typeof row?.visited === "number" ? row.visited : 0;
    return typeof row?.eligible === "number" ? row.eligible : 0;
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
 * and the whole prefix is counted again, which costs one indexed range scan
 * that reads each earlier message's JSON.
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
