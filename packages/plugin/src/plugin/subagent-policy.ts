/**
 * Per-session policy for subagent sessions.
 *
 * Magic Context stores one fact about a session (`session_meta.is_subagent`),
 * and two different answers are derived from it here.
 *
 *  - What the session is SHOWN and which context-management work it gets:
 *    compartment injection, the historian, full guidance, mural, caveman, the
 *    Rust pass inputs, system-prompt identity and the todo snapshot. Those
 *    gates read the projection from `getOrCreateSessionMeta` / `readSessionMeta`
 *    and `compress` turns them on for a child.
 *  - What it may WRITE, be DELIVERED, or appear as in status: the memory tools,
 *    channel-2 nudges, `/ctx-wrapup`, note-nudge accumulation and the status
 *    surfaces. Those gates read the stored fact (`storedSubagentMode` /
 *    `resolveStoredSubagentMode`) and never move with `compress`.
 *
 * The split is deliberate. `compress` is a context-management choice, so a
 * repository that turns it on in its own project config must not also gain
 * shared-memory writes, a follow-up child turn after the run ended, or a
 * wrapup. Where a gate belongs is decided by what it does, not by which module
 * it lives in.
 *
 * Defaults reproduce the pre-existing behaviour: children stay reduced and the
 * memory tools stay hidden.
 */

export interface SubagentPolicy {
    /** Children take the full path: compartments, historian, full guidance. */
    compress: boolean;
    /** Children may call `ctx_memory` / `ctx_note`. */
    memoryWrite: boolean;
}

const STOCK: SubagentPolicy = { compress: false, memoryWrite: false };

let policy: SubagentPolicy = STOCK;

/**
 * Set once per plugin instance from the resolved config, next to
 * `setKeepSubagents`. Process-global: one plugin instance per open project in
 * the same process means the last enabled project to boot owns the policy, and
 * a config change needs a restart (`subagent` is not a live-reload path).
 */
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
 * The `isSubagent` the presentation gates should act on. The stored value still
 * says the session is a child; with `compress` on, callers that decide what a
 * session sees get a primary session instead. Gates that write, deliver or
 * report must NOT use this; they read the stored fact.
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
