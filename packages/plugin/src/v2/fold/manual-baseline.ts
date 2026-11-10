import {
    readSessionRenderCache,
    type SessionRenderCacheColumn,
} from "../../features/magic-context/storage-session-cache";
import {
    type HostCheckpointCommit,
    type ServedHead,
    servedHeadChanged,
} from "../../hooks/magic-context/host-checkpoint-ride";
import type { Database } from "../../shared/sqlite";

type MetaRow = Record<string, string | number | Uint8Array | null>;

const text = (value: string | number | Uint8Array | null | undefined): string | null =>
    value == null
        ? null
        : typeof value === "string"
          ? value
          : Buffer.from(value as Uint8Array).toString("utf8");

/**
 * The history head a session serves: m[0], m[1] and the mural image. Current
 * stores keep these bytes in session_render_cache, outside the session_meta
 * row; a store from before that split still has them as session_meta columns.
 */
function headOf(db: Database, sessionID: string, row: MetaRow): ServedHead {
    const renderCache = !!db
        .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_render_cache'",
        )
        .get();
    const value = (column: SessionRenderCacheColumn) =>
        column in row
            ? row[column]
            : renderCache
              ? (readSessionRenderCache(db, sessionID, column) as MetaRow[string])
              : null;
    return {
        m0Text: text(value("cached_m0_bytes")),
        m1Text: text(value("cached_m1_bytes")),
        muralDataUrl: (value("cached_m0_mural_data_url") as string | null | undefined) ?? null,
    };
}

/** Render with the normal materializer, but publish its cache only after host admission. */
export function stageManualBaseline(db: Database, sessionID: string, render: () => string) {
    const read = () =>
        db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get(sessionID) as Record<
            string,
            string | number | Uint8Array | null
        >;
    const before = read();
    const headBefore = headOf(db, sessionID, before);
    const columns = Object.keys(before).filter(
        (key) =>
            key.startsWith("cached_m0_") ||
            key.startsWith("cached_m1_") ||
            key === "memory_block_count" ||
            key === "memory_block_ids",
    );
    const update = db.prepare(
        `UPDATE session_meta SET ${columns.map((key) => `${key} = ?`).join(", ")} WHERE session_id = ?`,
    );
    const restore = (row: typeof before) =>
        update.run(...columns.map((key) => row[key] ?? null), sessionID);
    let summary: string;
    let staged: typeof before;
    let stagedHead: ServedHead;
    let committed = false;
    try {
        summary = render();
        staged = read();
        stagedHead = headOf(db, sessionID, staged);
    } finally {
        // No await occurs between the materializer's commit and this restoration,
        // so another callback cannot observe a baseline without an admitted fold.
        restore(before);
    }
    const commit = db.prepare(
        `UPDATE session_meta SET ${columns.map((key) => `${key} = ?`).join(", ")} WHERE session_id = ? AND ${columns.map((key) => `${key} IS ?`).join(" AND ")}`,
    );
    return {
        summary,
        boundaryID: staged.cached_m0_last_baseline_end_message_id as string | null,
        commit() {
            // Do not overwrite cache metadata changed while host storage yielded.
            const result = commit.run(
                ...columns.map((key) => staged[key] ?? null),
                sessionID,
                ...columns.map((key) => before[key] ?? null),
            );
            if (result.changes !== 1)
                throw new Error("Manual compaction baseline changed during admission");
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
                        : ((before.cached_m0_max_compartment_seq as number | null) ?? null),
            };
        },
    };
}
