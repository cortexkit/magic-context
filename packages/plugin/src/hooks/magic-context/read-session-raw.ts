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

interface OrdinalRow {
    ordinal?: number;
}

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
                `SELECT message_id, data, time_updated
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
): RawMessage[] {
    const remaining = Math.max(0, Math.floor(finalWatermark) - Math.floor(afterOrdinal));
    const pageSize = Math.min(Math.max(1, Math.floor(limit)), remaining);
    if (pageSize === 0) return [];

    const messageRows = db
        .prepare(
            `SELECT id, data, time_created, time_updated
             FROM message
             WHERE session_id = ?
               AND NOT (
                   CASE WHEN json_valid(data) = 1
                        THEN COALESCE(json_extract(data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(data) = 1
                            THEN COALESCE(json_extract(data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )
             ORDER BY time_created ASC, id ASC
             LIMIT ? OFFSET ?`,
        )
        .all(sessionId, pageSize, Math.max(0, Math.floor(afterOrdinal)))
        .filter(isRawMessageRow)
        .map(
            (row, index): PagedRawMessageRow => ({
                ...row,
                ordinal: Math.floor(afterOrdinal) + index + 1,
            }),
        );

    if (messageRows.length === 0) return [];

    const placeholders = messageRows.map(() => "?").join(", ");
    const partRows = db
        .prepare(
            `SELECT message_id, data, time_updated
             FROM part
             WHERE +session_id = ?
               AND likelihood(message_id IN (${placeholders}), 0.000001)
             ORDER BY message_id ASC, time_created ASC, id ASC`,
        )
        .all(sessionId, ...messageRows.map((row) => row.id))
        .filter(isRawPartRow);
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
                    `SELECT message_id, data, time_updated FROM part WHERE +session_id = ? AND likelihood(message_id IN (${placeholders}), 0.000001) ORDER BY time_created ASC, id ASC`,
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
 * Resolve one message ID in the canonical raw-message ordinal space. Synthetic
 * compaction summaries are excluded so this count matches every module wire
 * ordinal and does not depend on the stored compartment basis.
 */
export function readRawSessionMessageOrdinalByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
): number | null {
    const row = db
        .prepare(
            `SELECT COUNT(candidate.id) AS ordinal
             FROM message AS target
             JOIN message AS candidate
               ON candidate.session_id = target.session_id
              AND NOT (
                  CASE WHEN json_valid(candidate.data) = 1
                       THEN COALESCE(json_extract(candidate.data, '$.summary'), 0)
                       ELSE 0 END = 1
                  AND CASE WHEN json_valid(candidate.data) = 1
                           THEN COALESCE(json_extract(candidate.data, '$.finish'), '')
                           ELSE '' END = 'stop'
              )
              AND (candidate.time_created < target.time_created
                   OR (candidate.time_created = target.time_created AND candidate.id <= target.id))
             WHERE target.session_id = ?
               AND target.id = ?
               AND NOT (
                   CASE WHEN json_valid(target.data) = 1
                        THEN COALESCE(json_extract(target.data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(target.data) = 1
                            THEN COALESCE(json_extract(target.data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )`,
        )
        .get(sessionId, messageId) as OrdinalRow | null;
    const ordinal = row?.ordinal;
    return typeof ordinal === "number" && ordinal > 0 ? ordinal : null;
}

export function readRawSessionMessageByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
): RawMessage | null {
    const row = db
        .prepare(
            "SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? AND id = ?",
        )
        .get(sessionId, messageId) as RawMessageRow | null;
    if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number") {
        return null;
    }

    const info = parseJsonRecord(row.data);
    if (!info || isRawCompactionSummaryInfo(info)) {
        return null;
    }

    const ordinalRow = db
        .prepare(
            `SELECT COUNT(*) AS ordinal FROM message
             WHERE session_id = ?
               AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                        AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
               AND (time_created < ? OR (time_created = ? AND id <= ?))`,
        )
        .get(sessionId, row.time_created, row.time_created, messageId) as OrdinalRow | null;
    const ordinal = typeof ordinalRow?.ordinal === "number" ? ordinalRow.ordinal : 0;
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

/** One stored row rebuilt in the shape OpenCode 1 hands the messages transform. */
export interface HostShapedMessage {
    info: Record<string, unknown>;
    parts: Record<string, unknown>[];
}

export type HostMessageRangeRead =
    | { status: "ok"; messages: HostShapedMessage[] }
    /** One of the two bound rows is not in the store for this session. */
    | { status: "missing-bound"; missing: "after" | "before" }
    /** More than `maxRows` rows lie between the bounds; nothing was decoded. */
    | { status: "too-many-rows"; rows: number };

/**
 * Read the rows strictly between two stored messages, in stored order, and rebuild
 * each one the way OpenCode 1 loads it: the message JSON with its row id and session
 * id added, and each part's JSON with its part id, session id and message id added,
 * parts in id order. An `after` bound that sorts at or past `before` is an empty
 * range, not an error.
 *
 * One indexed range read on (session, time_created, id), capped at `maxRows + 1`
 * rows so an unexpectedly long range is refused before any part is read.
 */
export function readHostMessageRangeFromDb(
    db: Database,
    sessionId: string,
    afterId: string,
    beforeId: string,
    maxRows: number,
): HostMessageRangeRead {
    const anchor = db.prepare(
        "SELECT time_created, id FROM message WHERE id = ? AND session_id = ?",
    );
    const after = anchor.get(afterId, sessionId);
    if (!isAnchorRow(after)) return { status: "missing-bound", missing: "after" };
    const before = anchor.get(beforeId, sessionId);
    if (!isAnchorRow(before)) return { status: "missing-bound", missing: "before" };
    const afterSortsFirst =
        after.time_created < before.time_created ||
        (after.time_created === before.time_created && after.id < before.id);
    if (!afterSortsFirst) return { status: "ok", messages: [] };

    const limit = Math.max(0, Math.floor(maxRows));
    const messageRows = db
        .prepare(
            `SELECT id, session_id, data FROM message
             WHERE session_id = ?
               AND (time_created, id) > (?, ?)
               AND (time_created, id) < (?, ?)
             ORDER BY time_created ASC, id ASC
             LIMIT ?`,
        )
        .all(
            sessionId,
            after.time_created,
            after.id,
            before.time_created,
            before.id,
            limit + 1,
        ) as Array<{ id: unknown; session_id: unknown; data: unknown }>;
    if (messageRows.length > limit) return { status: "too-many-rows", rows: messageRows.length };

    const partsByMessageId = new Map<string, Record<string, unknown>[]>();
    const ids = messageRows.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
    const CHUNK = 800;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const placeholders = slice.map(() => "?").join(",");
        const partRows = db
            .prepare(
                `SELECT id, session_id, message_id, data FROM part
                 WHERE +session_id = ? AND likelihood(message_id IN (${placeholders}), 0.000001)
                 ORDER BY message_id ASC, id ASC`,
            )
            .all(sessionId, ...slice) as Array<{
            id: unknown;
            session_id: unknown;
            message_id: unknown;
            data: unknown;
        }>;
        for (const part of partRows) {
            if (typeof part.message_id !== "string" || typeof part.data !== "string") continue;
            const data = parseJsonRecord(part.data);
            if (!data) continue;
            const list = partsByMessageId.get(part.message_id) ?? [];
            list.push({
                ...data,
                id: part.id,
                sessionID: part.session_id,
                messageID: part.message_id,
            });
            partsByMessageId.set(part.message_id, list);
        }
    }

    const messages: HostShapedMessage[] = [];
    for (const row of messageRows) {
        if (typeof row.id !== "string" || typeof row.data !== "string") continue;
        const info = parseJsonRecord(row.data);
        if (!info) continue;
        messages.push({
            info: { ...info, id: row.id, sessionID: row.session_id },
            parts: partsByMessageId.get(row.id) ?? [],
        });
    }
    return { status: "ok", messages };
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
