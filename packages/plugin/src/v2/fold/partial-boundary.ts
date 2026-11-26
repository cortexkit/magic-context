import { moduleRawBlockMappings } from "../../hooks/magic-context/module-wire";
import type { Database } from "../../shared/sqlite";
import { rawMessagePage } from "../hooks/store";
import type { V2StoreReader } from "../store-reader";
import type { ReplayFloor } from "./native-replay-v3";

/**
 * Whether stored row `rowID` still has blocks after the last block a
 * compartment summarizes. A compartment can end inside a message: it records
 * the index of its last covered block (`end_block_index`) in the numbering the
 * Rust module gives a message's text, reasoning, tool call and tool result
 * blocks. The summarizer puts that index on the message's last block, so a
 * message is normally covered whole even with an index; blocks remain only when
 * the message gained blocks after the summary was written (for example a tool
 * call that completed later and so gained its result). The shared transform
 * keeps such a boundary message raw, which is how those blocks reach the model.
 */
export function hasUnsummarizedBlocks(
    db: Database,
    reader: V2StoreReader,
    sessionID: string,
    rowID: string,
): boolean {
    const ends = db
        .prepare(
            "SELECT end_block_index AS block FROM compartments WHERE session_id=? AND end_message_id=? AND end_block_index IS NOT NULL",
        )
        .all(sessionID, rowID) as Array<{ block: number }>;
    if (ends.length === 0) return false;
    const row = reader.messageById(sessionID, rowID);
    if (!row) return false;
    const last = moduleRawBlockMappings(rawMessagePage([row], 0)[0] ?? null).at(-1)?.blockIndex;
    return last !== undefined && ends.some((end) => end.block < last);
}

/**
 * The store sequence a restore after a host checkpoint starts after. A summary
 * floor normally excludes its own row, because the summary served before the
 * checkpoint covers it. When that row still has unsummarized blocks, the
 * restore starts one row earlier so the row is put back and the shared
 * transform serves it exactly as it did before the checkpoint. The stored floor
 * and every proof digested over it are unchanged; only what is restored moves.
 */
export function restoreAfter(
    db: Database,
    reader: V2StoreReader,
    sessionID: string,
    floor: ReplayFloor,
): number {
    return floor.kind === "summary" && hasUnsummarizedBlocks(db, reader, sessionID, floor.id)
        ? floor.after - 1
        : floor.after;
}
