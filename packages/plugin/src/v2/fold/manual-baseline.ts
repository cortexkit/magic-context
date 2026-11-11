import {
    readStoredAppliedProjection,
    replaceStoredAppliedProjection,
    type StoredAppliedProjection,
} from "../../features/magic-context/memory/applied-projection";
import {
    readSessionRenderCache,
    SESSION_RENDER_CACHE_COLUMNS,
    type SessionRenderCacheColumn,
    writeSessionRenderCache,
} from "../../features/magic-context/storage-session-cache";
import {
    isSessionMetaCollectionInline,
    readSessionMetaCollection,
    writeSessionMetaCollection,
    writeSessionMetaCollectionBytes,
} from "../../features/magic-context/storage-session-collections";
import { cachedM0UpgradeIdentityKey } from "../../hooks/magic-context/compartment-render-epoch";
import {
    type HostCheckpointCommit,
    type ServedHead,
    servedHeadChanged,
} from "../../hooks/magic-context/host-checkpoint-ride";
import type { Database } from "../../shared/sqlite";

type Value = string | number | Uint8Array | null;

const isHeadColumn = (key: string) =>
    key.startsWith("cached_m0_") ||
    key.startsWith("cached_m1_") ||
    key === "memory_block_count" ||
    key === "memory_block_ids";

/**
 * Everything a HARD fold (`materializeM0`) stores for one session's history
 * head. Current stores keep it in four places: the markers in session_meta, the
 * m[0]/m[1]/mural/upgrade-state payloads in session_render_cache, the ids of the
 * memories the head shows in the `memory_block_ids` collection, and the memory
 * projection keyed to the m[0] bytes. A store from before that split keeps the
 * payloads and ids as session_meta columns instead.
 */
interface StoredHead {
    meta: Record<string, Value>;
    payloads: Partial<Record<SessionRenderCacheColumn, Value>>;
    memoryBlockIds?: Value;
    projection: StoredAppliedProjection | null;
}

/** Which of those places this store has, fixed for one staging. */
interface HeadLayout {
    metaColumns: string[];
    payloadColumns: SessionRenderCacheColumn[];
    chunkedMemoryIds: boolean;
}

function layoutOf(db: Database, row: Record<string, Value>): HeadLayout {
    const renderCache = !!db
        .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_render_cache'",
        )
        .get();
    return {
        metaColumns: Object.keys(row).filter(isHeadColumn),
        payloadColumns: renderCache
            ? SESSION_RENDER_CACHE_COLUMNS.filter((column) => isHeadColumn(column))
            : [],
        chunkedMemoryIds:
            !("memory_block_ids" in row) && !isSessionMetaCollectionInline(db, "memory_block_ids"),
    };
}

function readMeta(db: Database, sessionID: string): Record<string, Value> {
    return db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get(sessionID) as Record<
        string,
        Value
    >;
}

/** Read every part of the head. The caller holds one transaction around it, so the parts agree. */
function readHead(db: Database, sessionID: string, layout: HeadLayout): StoredHead {
    const row = readMeta(db, sessionID);
    return {
        meta: Object.fromEntries(layout.metaColumns.map((column) => [column, row[column] ?? null])),
        payloads: Object.fromEntries(
            layout.payloadColumns.map((column) => [
                column,
                readSessionRenderCache(db, sessionID, column) as Value,
            ]),
        ),
        ...(layout.chunkedMemoryIds
            ? {
                  memoryBlockIds: readSessionMetaCollection(
                      db,
                      sessionID,
                      "memory_block_ids",
                  ) as Value,
              }
            : {}),
        projection: readStoredAppliedProjection(db, sessionID),
    };
}

/** Write every part of `head`. The caller holds one write transaction around it. */
function writeHead(db: Database, sessionID: string, layout: HeadLayout, head: StoredHead): void {
    if (layout.metaColumns.length > 0)
        db.prepare(
            `UPDATE session_meta SET ${layout.metaColumns.map((key) => `${key} = ?`).join(", ")} WHERE session_id = ?`,
        ).run(...layout.metaColumns.map((key) => head.meta[key] ?? null), sessionID);
    for (const column of layout.payloadColumns)
        writeSessionRenderCache(db, sessionID, column, head.payloads[column] ?? null);
    if (layout.chunkedMemoryIds) {
        const ids = head.memoryBlockIds ?? null;
        if (ids instanceof Uint8Array)
            writeSessionMetaCollectionBytes(db, sessionID, "memory_block_ids", ids, "blob");
        else
            writeSessionMetaCollection(
                db,
                sessionID,
                "memory_block_ids",
                ids === null ? null : String(ids),
            );
    }
    if (head.projection) replaceStoredAppliedProjection(db, sessionID, head.projection);
}

const bytesOf = (value: string | Uint8Array) =>
    Buffer.from(typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64");

const textOf = (value: Value | undefined): string | null =>
    value == null
        ? null
        : typeof value === "string"
          ? value
          : typeof value === "number"
            ? String(value)
            : Buffer.from(value).toString("utf8");

/** JSON with object keys sorted, so key order is not a difference. */
function canonicalJson(value: string): string {
    const sort = (node: unknown): unknown =>
        Array.isArray(node)
            ? node.map(sort)
            : node !== null && typeof node === "object"
              ? Object.fromEntries(
                    Object.keys(node)
                        .sort()
                        .map((key) => [key, sort((node as Record<string, unknown>)[key])]),
                )
              : node;
    try {
        return `json:${JSON.stringify(sort(JSON.parse(value)))}`;
    } catch {
        return `raw:${value}`;
    }
}

/** A list of memory ids is a set: the same ids in another order are the same manifest. */
function memoryIdsKey(value: Value | undefined): string | null {
    const text = textOf(value);
    if (text === null) return null;
    try {
        const ids: unknown = JSON.parse(text);
        if (Array.isArray(ids) && ids.every((id) => Number.isSafeInteger(id)))
            return `ids:${JSON.stringify([...new Set(ids as number[])].sort((a, b) => a - b))}`;
    } catch {
        // Not a JSON id list: compare the stored text itself.
    }
    return `raw:${text}`;
}

/**
 * One stored value as a comparison key. Text and bytes compare by their bytes,
 * whichever storage class holds them; the upgrade-state marker compares by its
 * fields, and the memory id manifest by its ids.
 */
function valueKey(column: string, value: Value | undefined): unknown {
    if (column === "cached_m0_upgrade_state")
        return ["upgrade", cachedM0UpgradeIdentityKey(textOf(value))];
    if (column === "memory_block_ids") return ["ids", memoryIdsKey(value)];
    if (value == null) return null;
    if (typeof value === "number") return ["number", value];
    return ["bytes", bytesOf(value)];
}

/**
 * The comparison key of a stored head, used to prove nothing changed it while
 * the host admitted the compaction. The projection's generation is part of the
 * key: every projection write advances it, so a writer that ran in between is
 * seen even when it wrote the same content.
 */
function headKey(layout: HeadLayout, head: StoredHead): string {
    return JSON.stringify({
        meta: layout.metaColumns.map((column) => [column, valueKey(column, head.meta[column])]),
        payloads: layout.payloadColumns.map((column) => [
            column,
            valueKey(column, head.payloads[column]),
        ]),
        memoryBlockIds: layout.chunkedMemoryIds ? memoryIdsKey(head.memoryBlockIds) : undefined,
        projection: head.projection && {
            snapshots: head.projection.snapshots.map((row) => ({
                ...row,
                hard_memory_block: canonicalJson(row.hard_memory_block),
                committed_fragments_json: canonicalJson(row.committed_fragments_json),
            })),
            rows: head.projection.rows.map((row) => ({
                ...row,
                projected_metadata_json: canonicalJson(row.projected_metadata_json),
            })),
        },
    });
}

/**
 * The history head a stored head serves: m[0], m[1] and the mural image. A
 * render-cache row takes precedence over an inline session_meta column, as in
 * `sessionRenderCacheValueSql`, which every session_meta read of these payloads uses.
 */
function headOf(head: StoredHead): ServedHead {
    const value = (column: SessionRenderCacheColumn) =>
        head.payloads[column] ?? head.meta[column] ?? null;
    return {
        m0Text: textOf(value("cached_m0_bytes")),
        m1Text: textOf(value("cached_m1_bytes")),
        muralDataUrl: textOf(value("cached_m0_mural_data_url")),
    };
}

/**
 * Render with the normal materializer, but publish what it stored only after
 * host admission.
 *
 * The materializer commits a complete new head. Right after it, with no await
 * in between, the head it replaced is put back in one write transaction, so the
 * store serves the old head for as long as the host takes to admit the
 * compaction: a refusal, a reader in the meantime and a process that stops
 * there all see the old head. `commit` then writes the rendered head in one
 * write transaction, unless the stored head changed in the meantime.
 *
 * If putting the old head back fails (a busy database, say), the error
 * propagates and the hook refuses the compaction. The store then keeps the new
 * head the materializer committed, together with its own markers.
 *
 * Every read and write here runs in a write (IMMEDIATE) transaction: the reads
 * are a few rows on the rare manual-compaction path, and reading the rendered
 * head in the same transaction that puts the old one back leaves no gap
 * between them for another writer.
 */
export function stageManualBaseline(db: Database, sessionID: string, render: () => string) {
    const layout = layoutOf(db, readMeta(db, sessionID));
    const before = db.transaction(() => readHead(db, sessionID, layout)).immediate();
    const headBefore = headOf(before);
    let summary: string;
    let staged: StoredHead | null = null;
    let rendered = false;
    let committed = false;
    try {
        summary = render();
        rendered = true;
    } finally {
        staged = db
            .transaction(() => {
                const current = rendered ? readHead(db, sessionID, layout) : null;
                writeHead(db, sessionID, layout, before);
                return current;
            })
            .immediate();
    }
    const stagedHeadParts = staged;
    if (!stagedHeadParts) throw new Error("Manual compaction baseline was not staged");
    const stagedHead = headOf(stagedHeadParts);
    const beforeKey = headKey(layout, before);
    return {
        summary,
        boundaryID: stagedHeadParts.meta.cached_m0_last_baseline_end_message_id as string | null,
        commit() {
            db.transaction(() => {
                // Do not overwrite a head changed while host storage yielded.
                if (headKey(layout, readHead(db, sessionID, layout)) !== beforeKey)
                    throw new Error("Manual compaction baseline changed during admission");
                writeHead(db, sessionID, layout, stagedHeadParts);
            }).immediate();
            committed = true;
        },
        /**
         * What the commit did to the head the provider last saw: the persisted
         * pair before it is what every earlier request served or committed.
         * Nothing changed when the commit never ran.
         */
        headCommit(): HostCheckpointCommit {
            return {
                changed: committed && servedHeadChanged(headBefore, stagedHead),
                previousCoverage:
                    headBefore.m0Text == null
                        ? -1
                        : ((before.meta.cached_m0_max_compartment_seq as number | null) ?? null),
            };
        },
    };
}
