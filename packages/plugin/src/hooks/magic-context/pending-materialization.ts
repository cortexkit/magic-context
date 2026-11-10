export type PendingMaterializationOrigin =
    | "fit_retry"
    | "system_hash"
    | "user_flush"
    | "variant_change"
    | "recomp"
    | "boundary_repair"
    | "host_history_change"
    | "host_compaction"
    | "tag_identity_repair"
    | "thinking_hold"
    | "mutation_drift";

// Record whether a user command, system change, fit retry or another event
// requested the pending work, separately for each plugin's Set. Postprocess
// (or Pi's pipeline) drains it only after an allowed materialization succeeds.
const origins = new WeakMap<Set<string>, Map<string, PendingMaterializationOrigin>>();
const causes = new WeakMap<Set<string>, Map<string, Set<PendingMaterializationOrigin>>>();

export function requestPendingMaterialization(
    sessions: Set<string>,
    sessionId: string,
    origin: PendingMaterializationOrigin,
): void {
    let reasons = origins.get(sessions);
    if (!reasons) origins.set(sessions, (reasons = new Map()));
    let sessionCauses = causes.get(sessions);
    if (!sessionCauses) causes.set(sessions, (sessionCauses = new Map()));
    let pendingCauses = sessionCauses.get(sessionId);
    if (!sessions.has(sessionId) || !pendingCauses) {
        pendingCauses = new Set();
        sessionCauses.set(sessionId, pendingCauses);
    }
    pendingCauses.add(origin);
    if (!sessions.has(sessionId) || !reasons.has(sessionId) || origin === "fit_retry")
        reasons.set(sessionId, origin);
    sessions.add(sessionId);
}

export function pendingMaterializationOrigin(sessions: Set<string>, sessionId: string): string {
    return sessions.has(sessionId)
        ? (origins.get(sessions)?.get(sessionId) ?? "pending_materialization")
        : "pending_materialization";
}

/** Admission uses every recorded cause, not just the first diagnostic label. */
export function hasPendingMaterializationOrigin(
    sessions: Set<string>,
    sessionId: string,
    origin: PendingMaterializationOrigin,
): boolean {
    return sessions.has(sessionId) && causes.get(sessions)?.get(sessionId)?.has(origin) === true;
}

export function clearPendingMaterialization(sessions: Set<string>, sessionId: string): void {
    sessions.delete(sessionId);
    origins.get(sessions)?.delete(sessionId);
    causes.get(sessions)?.delete(sessionId);
}

/** Save a pending rebuild and every reason for it; a failed edit/removal transaction restores this session only. */
export function snapshotPendingMaterialization(
    sessions: Set<string>,
    sessionId: string,
): () => void {
    const pending = sessions.has(sessionId);
    const origin = origins.get(sessions)?.get(sessionId);
    const previous = causes.get(sessions)?.get(sessionId);
    const savedCauses = previous ? new Set(previous) : undefined;
    return () => {
        if (pending) sessions.add(sessionId);
        else sessions.delete(sessionId);
        let originMap = origins.get(sessions);
        if (origin !== undefined) {
            if (!originMap) origins.set(sessions, (originMap = new Map()));
            originMap.set(sessionId, origin);
        } else originMap?.delete(sessionId);
        let causeMap = causes.get(sessions);
        if (savedCauses) {
            if (!causeMap) causes.set(sessions, (causeMap = new Map()));
            causeMap.set(sessionId, new Set(savedCauses));
        } else causeMap?.delete(sessionId);
    };
}

/** Withdraw one recorded cause. The session stays pending while another cause
 * remains, and its log label moves to one of those remaining causes. */
export function clearPendingMaterializationOrigin(
    sessions: Set<string>,
    sessionId: string,
    origin: PendingMaterializationOrigin,
): void {
    const pendingCauses = causes.get(sessions)?.get(sessionId);
    if (!sessions.has(sessionId) || !pendingCauses?.has(origin)) return;
    pendingCauses.delete(origin);
    const [next] = pendingCauses;
    if (next === undefined) {
        clearPendingMaterialization(sessions, sessionId);
        return;
    }
    if (origins.get(sessions)?.get(sessionId) === origin)
        origins.get(sessions)?.set(sessionId, next);
}

/** The first origin remains the log label, but subsequent requests still matter:
 * a flush arriving while a system edit awaits its reply must not be deferred. */
export function hasOnlySystemHashMaterialization(
    sessions: Set<string>,
    sessionId: string,
): boolean {
    const pendingCauses = causes.get(sessions)?.get(sessionId);
    return sessions.has(sessionId) && pendingCauses?.size === 1 && pendingCauses.has("system_hash");
}

// A real host system-prompt change edits bytes before every kept signed
// thinking block, so on a prefix-bound model the older thinking must be stripped
// together with it. The system hook records the change here; the first transform
// pass with no current-turn thinking boundary consumes it with that strip. The
// record is separate from the materialization request because that request can
// be drained or deferred independently of the pass that pays for the strip.
const systemPromptEdits = new WeakMap<Set<string>, Set<string>>();

export function recordSystemPromptEdit(sessions: Set<string>, sessionId: string): void {
    let edited = systemPromptEdits.get(sessions);
    if (!edited) systemPromptEdits.set(sessions, (edited = new Set()));
    edited.add(sessionId);
}

export function hasSystemPromptEdit(sessions: Set<string>, sessionId: string): boolean {
    return systemPromptEdits.get(sessions)?.has(sessionId) === true;
}

export function clearSystemPromptEdit(sessions: Set<string>, sessionId: string): void {
    systemPromptEdits.get(sessions)?.delete(sessionId);
}
