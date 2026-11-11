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

/** A project's stored mural row, read as stored, and the identity it replaced. */
interface StagedMural {
    projectPath: string;
    /** Identity of the row before the render; null when the project had none. */
    before: string | null;
    row: Record<string, Value>;
}

function muralTablePresent(db: Database): boolean {
    return !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mural_manifest'")
        .get();
}

/**
 * Every project's stored mural, identified without its image: the text hash it
 * was rendered from, when, at what size, by what, and for which memories.
 */
function readMuralIdentities(db: Database): Map<string, string> {
    const identities = new Map<string, string>();
    if (!muralTablePresent(db)) return identities;
    for (const row of db
        .prepare(
            "SELECT project_path, content_hash, rendered_at, model, memory_ids_json, width, height FROM mural_manifest",
        )
        .all() as Array<Record<string, Value>>) {
        const { project_path, ...identity } = row;
        identities.set(String(project_path), JSON.stringify(identity));
    }
    return identities;
}

/** The mural rows the render wrote: projects whose stored identity changed. */
function readRenderedMurals(db: Database, before: Map<string, string>): StagedMural[] {
    const murals: StagedMural[] = [];
    for (const [projectPath, identity] of readMuralIdentities(db)) {
        if (before.get(projectPath) === identity) continue;
        murals.push({
            projectPath,
            before: before.get(projectPath) ?? null,
            row: db
                .prepare("SELECT * FROM mural_manifest WHERE project_path = ?")
                .get(projectPath) as Record<string, Value>,
        });
    }
    return murals;
}

/**
 * Store the mural rows the render wrote, verbatim. A row that another fold
 * replaced in the meantime is left alone: it was rendered from the project's
 * memories as they stood later, and the mural renderer compares its in-memory
 * render with the stored row before reusing either.
 */
function writeRenderedMurals(db: Database, murals: readonly StagedMural[]): void {
    if (murals.length === 0) return;
    const current = readMuralIdentities(db);
    for (const mural of murals) {
        if ((current.get(mural.projectPath) ?? null) !== mural.before) continue;
        const columns = Object.keys(mural.row);
        db.prepare(
            `INSERT INTO mural_manifest (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
             ON CONFLICT(project_path) DO UPDATE SET ${columns
                 .filter((column) => column !== "project_path")
                 .map((column) => `${column} = excluded.${column}`)
                 .join(", ")}`,
        ).run(...columns.map((column) => mural.row[column] ?? null));
    }
}

/**
 * Render a manual compaction's history head with the normal materializer, and
 * keep it aside until the host admits the compaction.
 *
 * The render runs inside one write transaction that is always rolled back,
 * whether it succeeds or throws. Inside it, the stored head is read before the
 * render (`before`) and after it (the staged head and the summary). Rolling the
 * transaction back means nothing the render wrote is ever committed: until
 * `commit` runs, the store holds the previous head, so a refused compaction, a
 * process that stops at any point, and another reader all see that head. No
 * step puts an old head back, so there is no such step that can fail.
 *
 * `commit` writes the staged head verbatim in its own write transaction, unless
 * the stored head changed while the host admitted the compaction. It also
 * stores the mural rows the render wrote, so the next fold reuses that render.
 * The render is never run again.
 */
export function stageManualBaseline(db: Database, sessionID: string, render: () => string) {
    const stage: {
        value?: {
            layout: HeadLayout;
            before: StoredHead;
            summary: string;
            staged: StoredHead;
            murals: StagedMural[];
        };
    } = {};
    const rolledBack = new Error("The manual compaction stage is rolled back by design");
    try {
        db.transaction(() => {
            const layout = layoutOf(db, readMeta(db, sessionID));
            const before = readHead(db, sessionID, layout);
            const murals = readMuralIdentities(db);
            const summary = render();
            stage.value = {
                layout,
                before,
                summary,
                staged: readHead(db, sessionID, layout),
                murals: readRenderedMurals(db, murals),
            };
            throw rolledBack;
        }).immediate();
    } catch (error) {
        if (error !== rolledBack) throw error;
    }
    if (!stage.value) throw new Error("Manual compaction baseline was not staged");
    const { layout, before, summary, staged, murals } = stage.value;
    const headBefore = headOf(before);
    const stagedHead = headOf(staged);
    const beforeKey = headKey(layout, before);
    let committed = false;
    return {
        summary,
        boundaryID: staged.meta.cached_m0_last_baseline_end_message_id as string | null,
        commit() {
            db.transaction(() => {
                // Do not overwrite a head changed while host storage yielded.
                if (headKey(layout, readHead(db, sessionID, layout)) !== beforeKey)
                    throw new Error("Manual compaction baseline changed during admission");
                writeHead(db, sessionID, layout, staged);
                writeRenderedMurals(db, murals);
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
