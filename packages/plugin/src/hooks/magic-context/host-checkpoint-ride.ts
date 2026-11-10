import { createHash } from "node:crypto";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { stripMemoryMuralBlock } from "./inject-compartments";
import {
    clearPendingMaterializationOrigin,
    hasPendingMaterializationOrigin,
    requestPendingMaterialization,
} from "./pending-materialization";

/**
 * Proof that a host checkpoint admitted outside the transform changed the
 * history head a request serves.
 *
 * OpenCode 2 compacts by asking Magic Context's compaction hook for a summary.
 * On a manual /compact with published history, that hook commits a new history
 * head (m[0] and m[1], the two synthetic messages that start every request)
 * while the host compacts, so no pass executes that fold. The next request
 * then starts with different bytes than the provider cached, and the cached
 * prefix is lost exactly as on a fold executed in a pass. That request is the
 * rebuild every queued reduction should ride.
 *
 * The ride needs proof that the bytes changed. The hook knows the head it
 * replaced and the head it committed, so it records whether the served bytes
 * differ (noteHostCheckpointCommit) next to its materialization request. That
 * proof holds whatever this process served before, including nothing at all
 * after a restart. A caller that changes the head without the hook (the legacy
 * fold owner re-rendering m[0]) leaves no such record; for it the pass compares
 * the head it is about to serve with the head the last completed pass served.
 *
 * A pass records the head it served, and withdraws the request, only when it
 * completes. A pass refused after its postprocess phase puts back what it
 * consumed (revertHostCheckpointPass), so the retry can still ride.
 */

export interface ServedHead {
    m0Text: string | null | undefined;
    m1Text: string | null | undefined;
    muralDataUrl?: string | null;
}

/** What the compaction hook's commit did to the persisted head. */
export interface HostCheckpointCommit {
    /** Whether the committed head serves different bytes from the head it replaced. */
    changed: boolean;
    /** Newest compartment sequence the replaced head covered: -1 for no head, null when unknown. */
    previousCoverage: number | null;
}

export interface HostCheckpointProof {
    changed: boolean;
    /** `commit`: the hook's record; `served_head`: compared with the last completed pass; `none`: no proof. */
    source: "commit" | "served_head" | "none";
    previousCoverage: number | null;
}

interface ServedRecord {
    digest: string;
    coverage: number | null;
}

interface PassState {
    requested: boolean;
    commit: HostCheckpointCommit | undefined;
    previousRecord: ServedRecord | undefined;
    /** The head this pass injected: undefined when it injected none. */
    staged?: ServedRecord | null;
}

const SESSIONS_MAX = 100;
const servedHeads = new BoundedSessionMap<ServedRecord>(SESSIONS_MAX);
const commits = new BoundedSessionMap<HostCheckpointCommit>(SESSIONS_MAX);
const passes = new BoundedSessionMap<PassState>(SESSIONS_MAX);

/**
 * Digest of the bytes a head puts on the wire. A head without a mural image is
 * served with the mural block stripped from m[0] (prepareCachedM0M1Replay), so
 * a difference inside that block alone is not a change. Null when the head is
 * incomplete.
 */
export function servedHeadDigest(head: ServedHead): string | null {
    if (head.m0Text == null || head.m1Text == null) return null;
    const mural = head.muralDataUrl ?? null;
    const m0 = mural ? head.m0Text : stripMemoryMuralBlock(head.m0Text);
    return createHash("sha256")
        .update(JSON.stringify([m0, head.m1Text, mural]))
        .digest("hex");
}

/** Whether two heads serve different bytes. An incomplete head on either side is a change. */
export function servedHeadChanged(before: ServedHead, after: ServedHead): boolean {
    const a = servedHeadDigest(before);
    return a === null || a !== servedHeadDigest(after);
}

/** The compaction hook records what its commit did, next to its `host_compaction` request. */
export function noteHostCheckpointCommit(sessionId: string, commit: HostCheckpointCommit): void {
    commits.set(sessionId, commit);
}

/**
 * Whether the head a pass is about to serve differs from the one the provider
 * last saw. `head` is read only when the hook left no record.
 */
export function hostCheckpointHeadChange(
    sessionId: string,
    head: () => ServedHead,
): HostCheckpointProof {
    const commit = commits.peek(sessionId);
    if (commit)
        return {
            changed: commit.changed,
            source: "commit",
            previousCoverage: commit.previousCoverage,
        };
    const served = servedHeads.peek(sessionId);
    const digest = served ? servedHeadDigest(head()) : null;
    if (!served || digest === null)
        return { changed: false, source: "none", previousCoverage: null };
    return {
        changed: served.digest !== digest,
        source: "served_head",
        previousCoverage: served.coverage,
    };
}

/** Start of a postprocess pass: remember what a refusal would have to put back. */
export function beginHostCheckpointPass(sessionId: string, pending: Set<string>): void {
    passes.set(sessionId, {
        requested: hasPendingMaterializationOrigin(pending, sessionId, "host_compaction"),
        commit: commits.peek(sessionId),
        previousRecord: servedHeads.peek(sessionId),
    });
}

/** The head this pass injected. It becomes the comparison point only if the pass completes. */
export function stageServedHead(
    sessionId: string,
    head: ServedHead,
    coverage: number | null,
): void {
    const state = passes.peek(sessionId);
    if (!state) return;
    const digest = servedHeadDigest(head);
    state.staged = digest === null ? null : { digest, coverage };
}

/**
 * The postprocess phase completed: record the head it served, and withdraw the
 * `host_compaction` request when `withdraw` says the pass settled it (the proof
 * showed no change, or an allowed pass rode it). A request the shared drain
 * already cleared also drops its proof.
 */
export function completeHostCheckpointPass(
    sessionId: string,
    pending: Set<string>,
    withdraw: boolean,
): void {
    const state = passes.peek(sessionId);
    if (!state) return;
    if (state.staged !== undefined) {
        if (state.staged) servedHeads.set(sessionId, state.staged);
        else servedHeads.delete(sessionId);
    }
    if (withdraw) clearPendingMaterializationOrigin(pending, sessionId, "host_compaction");
    if (!hasPendingMaterializationOrigin(pending, sessionId, "host_compaction"))
        commits.delete(sessionId);
}

/**
 * The pass was refused or failed after this pass began: restore the served
 * head record and put back a `host_compaction` request (with the hook's proof)
 * that the pass withdrew or drained, so the retry can still ride.
 */
export function revertHostCheckpointPass(sessionId: string, pending: Set<string>): void {
    const state = passes.peek(sessionId);
    passes.delete(sessionId);
    if (!state) return;
    if (state.previousRecord) servedHeads.set(sessionId, state.previousRecord);
    else servedHeads.delete(sessionId);
    if (!state.requested) return;
    if (state.commit) commits.set(sessionId, state.commit);
    if (!hasPendingMaterializationOrigin(pending, sessionId, "host_compaction"))
        requestPendingMaterialization(pending, sessionId, "host_compaction");
}

/** The whole pass is over (served or reverted): nothing is left to put back. */
export function forgetHostCheckpointPass(sessionId: string): void {
    passes.delete(sessionId);
}

/** Test seam: forget every recorded head, hook record and pass in progress. */
export function resetServedHeadsForTest(): void {
    servedHeads.clear();
    commits.clear();
    passes.clear();
}
