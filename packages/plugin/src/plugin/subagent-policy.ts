/**
 * Per-session policy for subagent sessions.
 *
 * Magic Context stores one fact about a session (`session_meta.is_subagent`)
 * and uses it for three independent decisions: whether the session takes the
 * reduced path (no compartments, no historian, reduced guidance), whether it
 * may call `ctx_memory` / `ctx_note`, and whether the dreamer's retrospective
 * may read it. A long-running child wants the first and not the other two, and
 * one stored flag cannot express that, so the stored fact stays as it is and
 * the three answers are derived here.
 *
 * Defaults reproduce the pre-existing behaviour: children stay reduced,
 * memory tools stay hidden, and the retrospective keeps skipping them.
 */

export interface SubagentPolicy {
    /** Children take the full path: compartments, historian, full guidance. */
    compress: boolean;
    /** Children may call `ctx_memory` / `ctx_note`. */
    memoryWrite: boolean;
    /** The dreamer retrospective may read child sessions. */
    dream: boolean;
}

const STOCK: SubagentPolicy = { compress: false, memoryWrite: false, dream: false };

let policy: SubagentPolicy = STOCK;

/** Set once from the resolved plugin config, next to `setKeepSubagents`. */
export function setSubagentPolicy(next: Partial<SubagentPolicy>): void {
    policy = { ...STOCK, ...next };
}

export function getSubagentPolicy(): SubagentPolicy {
    return policy;
}

/** Test seam: drop back to the stock policy. */
export function resetSubagentPolicy(): void {
    policy = STOCK;
}

/**
 * The `isSubagent` a caller should act on. The stored value still says the
 * session is a child; with `compress` on, the callers that gate the reduced
 * path see a primary session instead.
 */
export function effectiveSubagent(stored: boolean): boolean {
    return stored && !policy.compress;
}

/**
 * Whether `ctx_memory` / `ctx_note` stay hidden. Independent of `compress`:
 * turning compression on must not hand a child the tools that write project
 * memory.
 */
export function hidesMemoryTools(stored: boolean): boolean {
    return stored && !policy.memoryWrite;
}

/** Whether the dreamer retrospective may read child sessions. */
export function dreamIncludesChildren(): boolean {
    return policy.dream;
}
