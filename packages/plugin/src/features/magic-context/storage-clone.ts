import { isReservedLedgerControlEntry } from "../../hooks/magic-context/tool-sweep-policy";
import { getHarness } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";
import {
    decodeMergedReasoningParts,
    MERGED_REASONING_PARTS_PREFIX,
} from "./merged-reasoning-decisions";
import { decodePiContentDecision, encodePiContentDecision } from "./pi-content-decisions";
import {
    parseStrippedPlaceholderState,
    serializeStrippedPlaceholderState,
    THINKING_BINDING_RECOVERY_FROZEN_PREFIX,
} from "./storage-meta-persisted";
import { getNativeReplayState } from "./storage-native-replay";
import {
    type ReplayDocument,
    readReplayDocument,
    writeReplayDocument,
} from "./storage-replay-document";

export interface CloneCompartmentRow {
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
}

export interface CloneTagRow {
    messageId: string;
    type: string;
    tagNumber: number;
    toolOwnerMessageId: string | null;
}

export interface CloneSessionStateFilter {
    resolveBoundaryOrdinal(messageId: string): number | undefined;
    includeTag(tag: CloneTagRow): boolean;
    includeMessageId(messageId: string): boolean;
    /** Map a source message/content id into the destination session. */
    mapMessageId?: (messageId: string) => string;
    /** Opt into remapping globally keyed tag ids; leave undefined for Pi compatibility. */
    mapTagId?: (sourceTagId: number, destinationTagId: number) => number;
    /** Pi forks inherit session notes/facts in the same atomic prefix copy. */
    copySessionNotesAndFacts?: boolean;
    /** Return the destination ordinal for an inherited source anchor. */
    mapOrdinal?: (sourceOrdinal: number) => number | undefined;
    selectPendingPiMarker(
        rawState: string | null,
        copiedCompartments: readonly CloneCompartmentRow[],
    ): string | null;
}

export interface CopySessionStateForCloneResult {
    kind: "migrated" | "destination-not-empty";
    compartmentsCopied: number;
    tagsCopied: number;
    pendingOpsCopied: number;
    notesCopied: number;
    factsCopied: number;
    pendingMarkerMigrated: boolean;
}

type RawCompartmentRow = {
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    start_block_index: number | null;
    end_block_index: number | null;
    title: string;
    content: string;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    importance: number;
    episode_type: string | null;
    legacy: number;
    created_at: number;
    harness: string;
};

type RawTagRow = {
    id: number;
    message_id: string;
    type: string;
    status: string;
    byte_size: number;
    tag_number: number;
    harness: string;
    entry_fingerprint: string | null;
    token_count: number | null;
    input_token_count: number | null;
    reasoning_token_count: number | null;
    reasoning_byte_size: number;
    drop_mode: string;
    tool_name: string | null;
    input_byte_size: number;
    caveman_depth: number;
    tool_owner_message_id: string | null;
};

type RawSessionMetaRow = {
    cleared_reasoning_through_tag: number | null;
    tool_reclaim_watermark: number | null;
    pi_stable_id_scheme: number | null;
    stripped_placeholder_ids: string | null;
    stale_reduce_stripped_ids: string | null;
    processed_image_stripped_ids: string | null;
    merged_reasoning_stripped_ids: string | null;
    pending_pi_compaction_marker_state: string | null;
    last_todo_state: string | null;
    todo_synthetic_call_id: string | null;
    todo_synthetic_anchor_message_id: string | null;
    todo_synthetic_state_json: string | null;
};

/**
 * Copy the reasoning replay ledger into the clone. The column holds several
 * kinds of entry side by side, and each must survive the clone:
 *
 * - session-wide control flags, which are not ids at all. Dropping them would
 *   silently reset the fork's served-bytes policy back to a pre-adoption
 *   default on its first pass, so they are copied through verbatim;
 * - Pi content decisions (`pi-content-replay-v1:` records);
 * - exact merged-reasoning part records (`__merged_reasoning_parts_v1__:`),
 *   whose assistant id and string part ids are remapped;
 * - thinking-binding recovery decisions (`binding_mismatch:<message id>`);
 * - bare assistant message ids, the legacy merged-reasoning form.
 *
 * Entries naming a message are filtered and remapped with the rest of the
 * session. A blob that does not parse yields an empty ledger rather than
 * aborting the whole clone transaction (and with it every other piece of
 * inherited state); the merged-reasoning reader treats such a blob as empty
 * too.
 */
function clonePiContentDecisions(
    raw: string | null,
    filter: CloneSessionStateFilter,
): string | null {
    if (!raw) return null;
    let entries: unknown;
    try {
        entries = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!Array.isArray(entries)) return null;
    const copied: string[] = [];
    for (const entry of entries) {
        if (typeof entry !== "string") continue;
        if (isReservedLedgerControlEntry(entry)) {
            copied.push(entry);
            continue;
        }
        const decision = decodePiContentDecision(entry);
        if (decision) {
            const [kind, id] = decision;
            const root = kind === "reminder-strip" ? id.replace(/:p\d+$/, "") : id;
            if (!filter.includeMessageId(root)) continue;
            copied.push(
                encodePiContentDecision(
                    kind,
                    `${mapMessageId(filter, root)}${id.slice(root.length)}`,
                ),
            );
            continue;
        }
        const mergedParts = decodeMergedReasoningParts(entry);
        if (mergedParts) {
            const [messageId, parts] = mergedParts;
            if (!filter.includeMessageId(messageId)) continue;
            const mappedParts = parts.map((part) =>
                typeof part === "string" ? (mapMessageId(filter, part) ?? part) : part,
            );
            copied.push(
                `${MERGED_REASONING_PARTS_PREFIX}${JSON.stringify([
                    mapMessageId(filter, messageId) ?? messageId,
                    mappedParts,
                ])}`,
            );
            continue;
        }
        // Thinking-binding recovery decisions name the message whose reasoning
        // was stripped after a provider rejected the thinking prefix.
        if (entry.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX)) {
            const messageId = entry.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length);
            if (messageId.length === 0 || !filter.includeMessageId(messageId)) continue;
            copied.push(
                `${THINKING_BINDING_RECOVERY_FROZEN_PREFIX}${mapMessageId(filter, messageId) ?? messageId}`,
            );
            continue;
        }
        // Anything else that is not a recognised record prefix is a bare
        // assistant message id. Unknown versioned records are dropped rather
        // than guessed at.
        if (
            entry.startsWith(MERGED_REASONING_PARTS_PREFIX) ||
            entry.startsWith("pi-content-replay-")
        )
            continue;
        if (entry.length === 0 || !filter.includeMessageId(entry)) continue;
        copied.push(mapMessageId(filter, entry) ?? entry);
    }
    return copied.length ? JSON.stringify(copied) : null;
}

function runImmediate<T>(db: Database, body: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    const transactionStartedAt = performance.now();
    let committed = false;
    try {
        const result = body();
        db.exec("COMMIT");
        committed = true;
        logSlowWriteTransaction("storage_clone_copy", transactionStartedAt);
        return result;
    } finally {
        if (!committed) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // The transaction may already have been rolled back by SQLite.
            }
        }
    }
}

function countRows(db: Database, table: string, sessionId: string): number {
    const row = db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
        .get(sessionId) as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
}

function mapMessageId(filter: CloneSessionStateFilter, messageId: string | null): string | null {
    if (messageId === null) return null;
    return filter.mapMessageId?.(messageId) ?? messageId;
}

function tableExists(db: Database, table: string): boolean {
    const row = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
    return row !== null && row !== undefined;
}

function insertDynamicRow(db: Database, table: string, row: Record<string, unknown>): void {
    const names = Object.keys(row);
    const quoted = names.map((name) => `"${name.replaceAll('"', '""')}"`);
    const placeholders = names.map(() => "?").join(", ");
    db.prepare(
        `INSERT INTO "${table.replaceAll('"', '""')}" (${quoted.join(", ")}) VALUES (${placeholders})`,
    ).run(...names.map((name) => row[name]));
}

function anchoredMessageId(blockId: string): string {
    const separator = blockId.lastIndexOf("#");
    return separator > 0 ? blockId.slice(0, separator) : blockId;
}

function copyPiSessionNotesAndFacts(
    db: Database,
    sourceSessionId: string,
    destinationSessionId: string,
    filter: CloneSessionStateFilter,
): { notesCopied: number; factsCopied: number } {
    let notesCopied = 0;
    if (tableExists(db, "notes")) {
        const sourceNotes = db
            .prepare(
                "SELECT * FROM notes WHERE session_id = ? AND type = 'session' ORDER BY id ASC",
            )
            .all(sourceSessionId) as Array<Record<string, unknown>>;
        for (const source of sourceNotes) {
            const row: Record<string, unknown> = {
                ...source,
                session_id: destinationSessionId,
            };
            delete row.id;
            const blockId =
                typeof source.anchor_block_id === "string" ? source.anchor_block_id : "";
            if (blockId) {
                const sourceMessageId = anchoredMessageId(blockId);
                if (!filter.includeMessageId(sourceMessageId)) continue;
                const mappedMessageId = mapMessageId(filter, sourceMessageId) ?? sourceMessageId;
                row.anchor_block_id = `${mappedMessageId}${blockId.slice(sourceMessageId.length)}`;
                const mappedOrdinal = filter.resolveBoundaryOrdinal(sourceMessageId);
                if (mappedOrdinal === undefined) continue;
                if ("anchor_ordinal" in row) row.anchor_ordinal = mappedOrdinal;
            } else if (typeof source.anchor_ordinal === "number" && filter.mapOrdinal) {
                const mappedOrdinal = filter.mapOrdinal(source.anchor_ordinal);
                if (mappedOrdinal === undefined) continue;
                row.anchor_ordinal = mappedOrdinal;
            }
            insertDynamicRow(db, "notes", row);
            notesCopied += 1;
        }
    }

    let factsCopied = 0;
    if (tableExists(db, "session_facts")) {
        const sourceFacts = db
            .prepare("SELECT * FROM session_facts WHERE session_id = ? ORDER BY id ASC")
            .all(sourceSessionId) as Array<Record<string, unknown>>;
        for (const source of sourceFacts) {
            const row: Record<string, unknown> = {
                ...source,
                session_id: destinationSessionId,
            };
            delete row.id;
            insertDynamicRow(db, "session_facts", row);
            factsCopied += 1;
        }
    }
    return { notesCopied, factsCopied };
}

function filterIdBlob(raw: string | null, filter: CloneSessionStateFilter): string {
    if (!raw) return "";
    try {
        const value = JSON.parse(raw);
        if (!Array.isArray(value)) return "";
        const filtered = value
            .filter((id): id is string => typeof id === "string" && filter.includeMessageId(id))
            .map((id) => mapMessageId(filter, id));
        return filtered.length > 0 ? JSON.stringify(filtered) : "";
    } catch {
        return "";
    }
}

/**
 * The stripped-placeholder column has two shapes: a plain id array, and an
 * `{ ids, hiddenSeamIds }` object once a fold has hidden seam placeholders.
 * Both are read with the column's own parser so the clone replays exactly the
 * placeholders the source session strips.
 */
function filterStrippedPlaceholderBlob(
    raw: string | null,
    filter: CloneSessionStateFilter,
): string {
    const state = parseStrippedPlaceholderState(raw);
    const keep = (ids: readonly string[]): string[] =>
        ids.filter((id) => filter.includeMessageId(id)).map((id) => mapMessageId(filter, id) ?? id);
    const ids = keep(state.ids);
    const copied = new Set(ids);
    return serializeStrippedPlaceholderState({
        ids,
        hiddenSeamIds: keep(state.hiddenSeamIds).filter((id) => copied.has(id)),
    });
}

function filterNativeToolInputs(
    inputs: ReadonlyMap<string, string>,
    copiedToolCallIds: ReadonlySet<string>,
    filter: CloneSessionStateFilter,
): Record<string, string> {
    const filtered = new Map<string, string>();
    for (const [sourceId, serializedInput] of inputs) {
        if (!copiedToolCallIds.has(sourceId)) continue;
        const destinationId = mapMessageId(filter, sourceId);
        if (destinationId === null) continue;
        const existing = filtered.get(destinationId);
        if (existing !== undefined && existing !== serializedInput) {
            throw new Error(`native tool input clone collision for ${destinationId}`);
        }
        filtered.set(destinationId, serializedInput);
    }
    return Object.fromEntries(filtered);
}

function filterNativeReasoningIds(
    ids: ReadonlySet<string>,
    filter: CloneSessionStateFilter,
): string[] {
    const filtered = new Set<string>();
    for (const sourceId of ids) {
        if (!filter.includeMessageId(sourceId)) continue;
        const destinationId = mapMessageId(filter, sourceId);
        if (destinationId !== null) filtered.add(destinationId);
    }
    return [...filtered];
}

function cloneReplayDocument(
    db: Database,
    sourceSessionId: string,
    copiedToolCallIds: ReadonlySet<string>,
    filter: CloneSessionStateFilter,
): ReplayDocument {
    const document = readReplayDocument(db, sourceSessionId);
    const trailingBlank = new Map<string, ReplayDocument["trailingBlank"][string]>();
    for (const [sourceId, decision] of Object.entries(document.trailingBlank)) {
        if (!filter.includeMessageId(sourceId)) continue;
        const destinationId = mapMessageId(filter, sourceId);
        if (destinationId === null) continue;
        const existing = trailingBlank.get(destinationId);
        if (existing !== undefined && existing !== decision) {
            throw new Error(`trailing blank clone collision for ${destinationId}`);
        }
        trailingBlank.set(destinationId, decision);
    }
    document.trailingBlank = Object.fromEntries(trailingBlank);
    if (document.version === 1 || document.piNative === undefined) return document;

    const nativeReplay = getNativeReplayState(db, sourceSessionId);
    return {
        ...document,
        piNative: {
            ...(document.piNative as Record<string, unknown>),
            toolInputs: filterNativeToolInputs(nativeReplay.toolInputs, copiedToolCallIds, filter),
            reasoningIds: filterNativeReasoningIds(nativeReplay.reasoningIds, filter),
        },
    };
}

/**
 * SQLite builds used by node:sqlite (Pi, OpenCode Desktop) accept at most
 * 32,766 bound variables per statement, so a long session's tag list is read
 * in slices well under that limit, matching `getTagsByNumbers`.
 */
const TAG_ID_QUERY_CHUNK_SIZE = 900;

/** Run `<sqlPrefix> (?, ?, …)` once per slice of `tagIds` and return every row. */
function selectRowsByTagIds<T>(
    db: Database,
    sqlPrefix: string,
    sessionId: string,
    tagIds: readonly number[],
): T[] {
    const rows: T[] = [];
    for (let start = 0; start < tagIds.length; start += TAG_ID_QUERY_CHUNK_SIZE) {
        const chunk = tagIds.slice(start, start + TAG_ID_QUERY_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(", ");
        rows.push(
            ...(db.prepare(`${sqlPrefix} (${placeholders})`).all(sessionId, ...chunk) as T[]),
        );
    }
    return rows;
}

function clampWatermark(value: number | null, maxCopiedTag: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
    return Math.min(Math.floor(value), maxCopiedTag);
}

/**
 * Copy durable session content into a clone under one immediate transaction.
 * The destination guard runs after the write lock is acquired so two plugin
 * processes cannot both observe an empty clone and duplicate its state.
 */
export function copySessionStateForClone(
    db: Database,
    sourceSessionId: string,
    destinationSessionId: string,
    filter: CloneSessionStateFilter,
): CopySessionStateForCloneResult {
    return runImmediate(db, () => {
        // The offline clone command also supports pre-v95 stores without
        // upgrading them; only current stores have indexed temporal choices.
        const hasTemporalDecisions = tableExists(db, "temporal_decisions");
        if (
            countRows(db, "compartments", destinationSessionId) > 0 ||
            countRows(db, "tags", destinationSessionId) > 0 ||
            (hasTemporalDecisions &&
                countRows(db, "temporal_decisions", destinationSessionId) > 0) ||
            (filter.copySessionNotesAndFacts === true &&
                ((tableExists(db, "notes") && countRows(db, "notes", destinationSessionId) > 0) ||
                    (tableExists(db, "session_facts") &&
                        countRows(db, "session_facts", destinationSessionId) > 0)))
        ) {
            return {
                kind: "destination-not-empty",
                compartmentsCopied: 0,
                tagsCopied: 0,
                pendingOpsCopied: 0,
                notesCopied: 0,
                factsCopied: 0,
                pendingMarkerMigrated: false,
            };
        }

        const compartmentColumns = db.prepare("PRAGMA table_info(compartments)").all() as {
            name: string;
        }[];
        const hasBlockIndices = ["start_block_index", "end_block_index"].every((name) =>
            compartmentColumns.some((column) => column.name === name),
        );
        const blockProjection = hasBlockIndices
            ? "start_block_index, end_block_index"
            : "NULL AS start_block_index, NULL AS end_block_index";
        const sourceCompartments = db
            .prepare(
                `SELECT sequence, start_message, end_message, start_message_id, end_message_id,
                        title, content, p1, p2, p3, p4, importance, episode_type, legacy,
                        created_at, harness, ${blockProjection}
                   FROM compartments WHERE session_id = ? ORDER BY sequence ASC`,
            )
            .all(sourceSessionId) as RawCompartmentRow[];
        const insertCompartment = db.prepare(
            `INSERT INTO compartments
                (session_id, sequence, start_message, end_message, start_message_id,
                 end_message_id, title, content, p1, p2, p3, p4, importance,
                 episode_type, legacy, created_at, harness${hasBlockIndices ? ", start_block_index, end_block_index" : ""})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${hasBlockIndices ? ", ?, ?" : ""})`,
        );
        const copiedCompartments: CloneCompartmentRow[] = [];
        for (const row of sourceCompartments) {
            const startMessage = filter.resolveBoundaryOrdinal(row.start_message_id);
            const endMessage = filter.resolveBoundaryOrdinal(row.end_message_id);
            if (startMessage === undefined || endMessage === undefined) continue;
            insertCompartment.run(
                destinationSessionId,
                row.sequence,
                startMessage,
                endMessage,
                mapMessageId(filter, row.start_message_id),
                mapMessageId(filter, row.end_message_id),
                row.title,
                row.content,
                row.p1,
                row.p2,
                row.p3,
                row.p4,
                row.importance,
                row.episode_type,
                row.legacy,
                row.created_at,
                row.harness,
                ...(hasBlockIndices ? [row.start_block_index, row.end_block_index] : []),
            );
            copiedCompartments.push({
                sequence: row.sequence,
                startMessage,
                endMessage,
                startMessageId: mapMessageId(filter, row.start_message_id) ?? row.start_message_id,
                endMessageId: mapMessageId(filter, row.end_message_id) ?? row.end_message_id,
            });
        }

        const sourceTags = db
            .prepare(
                `SELECT id, message_id, type, status, byte_size, tag_number, harness,
                        entry_fingerprint, token_count, input_token_count,
                        reasoning_token_count, reasoning_byte_size, drop_mode, tool_name,
                        input_byte_size, caveman_depth, tool_owner_message_id
                   FROM tags WHERE session_id = ? ORDER BY tag_number ASC`,
            )
            .all(sourceSessionId) as RawTagRow[];
        const insertTag = db.prepare(
            `INSERT INTO tags
                (session_id, message_id, type, status, byte_size, tag_number, harness,
                 entry_fingerprint, token_count, input_token_count, reasoning_token_count,
                 reasoning_byte_size, drop_mode, tool_name, input_byte_size,
                 caveman_depth, tool_owner_message_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const copiedTagNumbers: number[] = [];
        const copiedTagIds = new Map<number, number>();
        const copiedToolCallIds = new Set<string>();
        for (const row of sourceTags) {
            if (
                !filter.includeTag({
                    messageId: row.message_id,
                    type: row.type,
                    tagNumber: row.tag_number,
                    toolOwnerMessageId: row.tool_owner_message_id,
                })
            ) {
                continue;
            }
            const insertResult = insertTag.run(
                destinationSessionId,
                mapMessageId(filter, row.message_id),
                row.type,
                row.status,
                row.byte_size,
                row.tag_number,
                row.harness,
                row.entry_fingerprint,
                row.token_count,
                row.input_token_count,
                row.reasoning_token_count,
                row.reasoning_byte_size,
                row.drop_mode,
                row.tool_name,
                row.input_byte_size,
                row.caveman_depth,
                mapMessageId(filter, row.tool_owner_message_id),
            );
            const insertedTagId = Number(insertResult.lastInsertRowid);
            if (!Number.isSafeInteger(insertedTagId) || insertedTagId <= 0) {
                throw new Error(`failed to obtain destination tag id for tag ${row.tag_number}`);
            }
            const sourceTagId = filter.mapTagId ? row.id : row.tag_number;
            const destinationTagId = filter.mapTagId
                ? filter.mapTagId(sourceTagId, insertedTagId)
                : sourceTagId;
            copiedTagIds.set(sourceTagId, destinationTagId);
            copiedTagNumbers.push(row.tag_number);
            if (row.type === "tool") copiedToolCallIds.add(row.message_id);
        }

        if (copiedTagNumbers.length > 0) {
            const sourceContents = selectRowsByTagIds<{
                tag_id: number;
                content: string | null;
                created_at: number | null;
                harness: string;
            }>(
                db,
                `SELECT tag_id, content, created_at, harness
                   FROM source_contents
                  WHERE session_id = ? AND tag_id IN`,
                sourceSessionId,
                [...copiedTagIds.keys()],
            );
            const insertSourceContent = db.prepare(
                "INSERT INTO source_contents (tag_id, session_id, content, created_at, harness) VALUES (?, ?, ?, ?, ?)",
            );
            for (const row of sourceContents) {
                const destinationTagId = copiedTagIds.get(row.tag_id);
                if (destinationTagId === undefined) continue;
                insertSourceContent.run(
                    destinationTagId,
                    destinationSessionId,
                    row.content,
                    row.created_at,
                    row.harness,
                );
            }

            // Queued operations always name the tag by its per-session tag
            // number (that is what ctx_reduce and the historian queue, and what
            // the drain resolves), and the clone keeps every tag number. They
            // therefore never go through the row-id remap that source contents
            // may need.
            const pendingOps = selectRowsByTagIds<{
                id: number;
                tag_id: number;
                operation: string | null;
                queued_at: number | null;
                harness: string;
            }>(
                db,
                `SELECT id, tag_id, operation, queued_at, harness
                   FROM pending_ops
                  WHERE session_id = ? AND tag_id IN`,
                sourceSessionId,
                copiedTagNumbers,
            ).sort((a, b) => a.id - b.id);
            const insertPendingOp = db.prepare(
                "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, ?, ?, ?)",
            );
            for (const row of pendingOps) {
                insertPendingOp.run(
                    destinationSessionId,
                    row.tag_id,
                    row.operation,
                    row.queued_at,
                    row.harness,
                );
            }
        }

        if (hasTemporalDecisions) {
            const temporalRows = db
                .prepare("SELECT message_id,marker FROM temporal_decisions WHERE session_id=?")
                .all(sourceSessionId) as Array<{ message_id: string; marker: string | null }>;
            const insertTemporal = db.prepare(
                "INSERT INTO temporal_decisions(session_id,message_id,marker) VALUES (?,?,?)",
            );
            for (const row of temporalRows) {
                if (filter.includeMessageId(row.message_id))
                    insertTemporal.run(
                        destinationSessionId,
                        mapMessageId(filter, row.message_id),
                        row.marker,
                    );
            }
        }

        const inherited =
            filter.copySessionNotesAndFacts === true
                ? copyPiSessionNotesAndFacts(db, sourceSessionId, destinationSessionId, filter)
                : { notesCopied: 0, factsCopied: 0 };

        const meta = db
            .prepare(
                `SELECT cleared_reasoning_through_tag, tool_reclaim_watermark,
                        pi_stable_id_scheme, stripped_placeholder_ids,
                        stale_reduce_stripped_ids, processed_image_stripped_ids, merged_reasoning_stripped_ids,
                        pending_pi_compaction_marker_state, last_todo_state,
                        todo_synthetic_call_id, todo_synthetic_anchor_message_id,
                        todo_synthetic_state_json
                   FROM session_meta WHERE session_id = ?`,
            )
            .get(sourceSessionId) as RawSessionMetaRow | undefined;
        const maxCopiedTag = copiedTagNumbers.reduce((max, value) => Math.max(max, value), 0);
        const pendingMarker = filter.selectPendingPiMarker(
            meta?.pending_pi_compaction_marker_state ?? null,
            copiedCompartments,
        );
        const todoAnchor = meta?.todo_synthetic_anchor_message_id ?? "";
        const migrateTodo = todoAnchor.length > 0 && filter.includeMessageId(todoAnchor);

        db.prepare(
            `INSERT INTO session_meta
                (session_id, harness, counter, cleared_reasoning_through_tag,
                 tool_reclaim_watermark, pi_stable_id_scheme, stripped_placeholder_ids,
                 stale_reduce_stripped_ids, processed_image_stripped_ids, merged_reasoning_stripped_ids,
                 pending_pi_compaction_marker_state, last_todo_state,
                 todo_synthetic_call_id, todo_synthetic_anchor_message_id,
                 todo_synthetic_state_json, served_prefix, held_release)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
             ON CONFLICT(session_id) DO UPDATE SET
                harness = excluded.harness,
                counter = excluded.counter,
                cleared_reasoning_through_tag = excluded.cleared_reasoning_through_tag,
                tool_reclaim_watermark = excluded.tool_reclaim_watermark,
                pi_stable_id_scheme = excluded.pi_stable_id_scheme,
                stripped_placeholder_ids = excluded.stripped_placeholder_ids,
                stale_reduce_stripped_ids = excluded.stale_reduce_stripped_ids,
                 processed_image_stripped_ids = excluded.processed_image_stripped_ids,
                 merged_reasoning_stripped_ids = excluded.merged_reasoning_stripped_ids,
                pending_pi_compaction_marker_state = excluded.pending_pi_compaction_marker_state,
                last_todo_state = excluded.last_todo_state,
                todo_synthetic_call_id = excluded.todo_synthetic_call_id,
                todo_synthetic_anchor_message_id = excluded.todo_synthetic_anchor_message_id,
                todo_synthetic_state_json = excluded.todo_synthetic_state_json,
                cached_m0_bytes = NULL,
                cached_m1_bytes = NULL,
                served_prefix = NULL,
                held_release = NULL`,
        ).run(
            destinationSessionId,
            getHarness(),
            maxCopiedTag,
            clampWatermark(meta?.cleared_reasoning_through_tag ?? null, maxCopiedTag),
            clampWatermark(meta?.tool_reclaim_watermark ?? null, maxCopiedTag),
            typeof meta?.pi_stable_id_scheme === "number" &&
                Number.isFinite(meta.pi_stable_id_scheme)
                ? meta.pi_stable_id_scheme
                : null,
            filterStrippedPlaceholderBlob(meta?.stripped_placeholder_ids ?? null, filter),
            filterIdBlob(meta?.stale_reduce_stripped_ids ?? null, filter),
            filterIdBlob(meta?.processed_image_stripped_ids ?? null, filter),
            clonePiContentDecisions(meta?.merged_reasoning_stripped_ids ?? null, filter),
            pendingMarker,
            migrateTodo ? (meta?.last_todo_state ?? "") : "",
            migrateTodo ? (meta?.todo_synthetic_call_id ?? "") : "",
            migrateTodo ? (mapMessageId(filter, todoAnchor) ?? "") : "",
            migrateTodo ? (meta?.todo_synthetic_state_json ?? "") : "",
        );
        // Clone owns the whole replay document so its filtered native state
        // cannot be overwritten by the CLI's later generic metadata copy.
        const metaColumnRows = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
            name: string;
        }>;
        const metaColumns = new Set(metaColumnRows.map((column) => column.name));
        if (metaColumns.has("trailing_blank_decisions")) {
            const replayDocument = cloneReplayDocument(
                db,
                sourceSessionId,
                copiedToolCallIds,
                filter,
            );
            writeReplayDocument(db, destinationSessionId, replayDocument);
        }

        const pendingOpsRow = db
            .prepare("SELECT COUNT(*) AS count FROM pending_ops WHERE session_id = ?")
            .get(destinationSessionId) as { count?: number } | undefined;
        return {
            kind: "migrated",
            compartmentsCopied: copiedCompartments.length,
            tagsCopied: copiedTagNumbers.length,
            pendingOpsCopied: typeof pendingOpsRow?.count === "number" ? pendingOpsRow.count : 0,
            notesCopied: inherited.notesCopied,
            factsCopied: inherited.factsCopied,
            pendingMarkerMigrated: pendingMarker !== null,
        };
    });
}
