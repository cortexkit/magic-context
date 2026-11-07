import type { Database } from "../../shared/sqlite";

/** Render with the normal materializer, but publish its cache only after host admission. */
export function stageManualBaseline(db: Database, sessionID: string, render: () => string) {
    const read = () =>
        db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get(sessionID) as Record<
            string,
            string | number | Uint8Array | null
        >;
    const before = read();
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
    try {
        summary = render();
        staged = read();
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
        },
    };
}
