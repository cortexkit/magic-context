import { createHash } from "node:crypto";
import { BoundedSessionMap } from "../../shared/bounded-session-map";

/**
 * Proof that a host checkpoint admitted outside the transform changed the
 * history head a request serves.
 *
 * OpenCode 2 compacts by asking Magic Context's compaction hook for a summary.
 * On a manual /compact with published history, that hook already commits a
 * new history head (m[0] and m[1], the two synthetic messages that start every
 * request) while the host compacts, so no pass executes that fold, and the
 * hook also drops the last-good-request snapshot. The next request then starts
 * with different bytes than the last request served, and the provider's cached
 * prefix is lost exactly as on a fold executed in a pass. That request is the
 * rebuild every queued reduction should ride.
 *
 * The ride needs proof that the bytes changed. Each pass that injects a head
 * records a digest of it here, and the next pass compares the head it is about
 * to serve. A request whose head is unchanged keeps its cache and gets no ride,
 * whatever asked for the materialization. Without a record (the first pass in
 * this process, for example after a restart) the change is not proven.
 */

export interface ServedHead {
    m0Text: string | null | undefined;
    m1Text: string | null | undefined;
    muralDataUrl?: string | null;
}

const SERVED_HEADS_MAX = 100;
const servedHeads = new BoundedSessionMap<string>(SERVED_HEADS_MAX);

function headDigest(head: ServedHead): string {
    return createHash("sha256")
        .update(
            JSON.stringify([head.m0Text ?? null, head.m1Text ?? null, head.muralDataUrl ?? null]),
        )
        .digest("hex");
}

/** Record the head a pass injected into the request it serves. */
export function rememberServedHead(sessionId: string, head: ServedHead): void {
    if (head.m0Text == null || head.m1Text == null) {
        servedHeads.delete(sessionId);
        return;
    }
    servedHeads.set(sessionId, headDigest(head));
}

/** Whether `head` differs from the head the session's previous pass injected. */
export function hostCheckpointChangedServedHead(sessionId: string, head: ServedHead): boolean {
    const served = servedHeads.peek(sessionId);
    if (served === undefined || head.m0Text == null || head.m1Text == null) return false;
    return served !== headDigest(head);
}

/** Test seam: forget every recorded head. */
export function resetServedHeadsForTest(): void {
    servedHeads.clear();
}
