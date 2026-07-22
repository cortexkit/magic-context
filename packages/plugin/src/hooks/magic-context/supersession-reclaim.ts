import { type ContextDatabase, getActiveTagsBySession } from "../../features/magic-context/storage";
import type { PendingOp } from "../../features/magic-context/types";
import { isEditTool } from "./edit-marker";
import type { TagTarget } from "./tag-messages";

// Smart-drops Phase 1: select provably-superseded "spent control-plane" tool
// outputs for reclaim. These classes are dead by SUPERSESSION (not age), and
// the caller only ACTS on the result inside the existing
// execute + already-mutating gate, so this never originates a cache bust.
//
// Keep-counts are fixed constants (no config sub-knobs):
//   - todowrite: keep newest 1 (the live plan is the synthetic todowrite we
//     inject + protect every pass; real ones are older snapshots).
//   - ctx_reduce: keep newest 5 (preserves the visible reduce rhythm).
//   - zero-value meta: keep 0 (worthless once executed).
const TODOWRITE_KEEP = 1;
const CTX_REDUCE_KEEP = 5;

// Tools whose output is worthless once the call ran. ctx_note is handled
// separately because only its read/dismiss actions are zero-value.
const ZERO_VALUE_META_TOOLS = new Set(["bash_status", "bash_kill"]);
// ctx_note actions that carry no durable value (write/update carry intent and
// are never dropped). An unreadable action fails safe = not a target.
const CTX_NOTE_ZERO_VALUE_ACTIONS = new Set(["read", "dismiss"]);

/**
 * Build synthetic drop ops for superseded spent-control-plane tool outputs.
 * The caller merges these into a gated `applyPendingOperations` call.
 */
export function buildSupersessionReclaimOps(input: {
    db: ContextDatabase;
    sessionId: string;
    targets: Map<number, TagTarget>;
    pendingOps?: readonly PendingOp[];
}): PendingOp[] {
    const realPendingTagIds = new Set((input.pendingOps ?? []).map((op) => op.tagId));
    const tags = getActiveTagsBySession(input.db, input.sessionId);

    // Active tool tags, newest-first, so "keep newest N" = the first N seen.
    const toolTags = tags
        .filter((tag) => tag.type === "tool" && tag.status === "active")
        .sort((left, right) => right.tagNumber - left.tagNumber);

    const dropTagIds: number[] = [];
    let todowriteSeen = 0;
    let ctxReduceSeen = 0;

    for (const tag of toolTags) {
        const name = tag.toolName;
        if (!name) continue;

        let isTarget = false;
        if (name === "todowrite") {
            todowriteSeen += 1;
            isTarget = todowriteSeen > TODOWRITE_KEEP;
        } else if (name === "ctx_reduce") {
            ctxReduceSeen += 1;
            isTarget = ctxReduceSeen > CTX_REDUCE_KEEP;
        } else if (ZERO_VALUE_META_TOOLS.has(name)) {
            isTarget = true;
        } else if (name === "ctx_note") {
            const action = input.targets.get(tag.tagNumber)?.readInput?.()?.action;
            // Fail safe: only drop when we can positively read a zero-value action.
            isTarget = typeof action === "string" && CTX_NOTE_ZERO_VALUE_ACTIONS.has(action);
        }
        if (isTarget) dropTagIds.push(tag.tagNumber);
    }

    const synthetic: PendingOp[] = [];
    for (const tagId of dropTagIds) {
        if (realPendingTagIds.has(tagId)) continue;
        if (input.targets.get(tagId)?.canDrop?.() !== true) continue;
        synthetic.push({
            id: 0,
            sessionId: input.sessionId,
            tagId,
            operation: "drop",
            queuedAt: 0,
        });
    }
    return synthetic;
}

/**
 * Select superseded edit/write tool calls for COMPRESSION (not full drop).
 * Among active edit/write tags grouped by their `filePath`, the newest stays
 * full; every older edit to the same file is an edit_marker target. The caller
 * only acts inside the gated pass.
 *
 * Returns both the drop ops AND the set of tag ids that must be compressed as
 * edit_marker (the caller passes the set to applyPendingOperations).
 */
export function buildEditSupersessionReclaim(input: {
    db: ContextDatabase;
    sessionId: string;
    targets: Map<number, TagTarget>;
    pendingOps?: readonly PendingOp[];
}): { ops: PendingOp[]; editMarkerTagIds: Set<number> } {
    const realPendingTagIds = new Set((input.pendingOps ?? []).map((op) => op.tagId));
    const tags = getActiveTagsBySession(input.db, input.sessionId);

    // Active edit/write tags, newest-first, so the FIRST seen per file is kept.
    const editTags = tags
        .filter((tag) => tag.type === "tool" && tag.status === "active" && isEditTool(tag.toolName))
        .sort((left, right) => right.tagNumber - left.tagNumber);

    const seenFile = new Set<string>();
    const ops: PendingOp[] = [];
    const editMarkerTagIds = new Set<number>();

    for (const tag of editTags) {
        const filePath = readFilePath(input.targets.get(tag.tagNumber));
        // No resolvable filePath → cannot prove supersession by file identity;
        // leave it alone (fail safe).
        if (!filePath) continue;
        if (!seenFile.has(filePath)) {
            seenFile.add(filePath); // newest edit to this file stays full
            continue;
        }
        // Older edit to an already-seen file → compress.
        if (realPendingTagIds.has(tag.tagNumber)) continue;
        if (input.targets.get(tag.tagNumber)?.canDrop?.() !== true) continue;
        editMarkerTagIds.add(tag.tagNumber);
        ops.push({
            id: 0,
            sessionId: input.sessionId,
            tagId: tag.tagNumber,
            operation: "drop",
            queuedAt: 0,
        });
    }
    return { ops, editMarkerTagIds };
}

const FILE_PATH_KEYS = ["filePath", "file_path", "path"] as const;

function readFilePath(target: TagTarget | undefined): string | null {
    const input = target?.readInput?.();
    if (!input) return null;
    for (const key of FILE_PATH_KEYS) {
        const value = input[key];
        if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
}
