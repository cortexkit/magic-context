export type PassDegradationKind = "degraded" | "fatal";

/**
 * What a recorded degradation can do to the request the pass serves, compared
 * with the request a healthy pass would serve.
 *
 * - `changes-request`: the stage that failed decides bytes the request depends
 *   on (persisted drops and truncations, the history cut, the session-history
 *   head messages m[0]/m[1], and the reasoning, image and ctx_reduce strips
 *   replayed from earlier passes), so the served request can be larger than a
 *   healthy one or differ from it. With compaction enabled, failed stages
 *   replay the last-good request or refuse, regardless of the context limit.
 * - `served`: the request equals a healthy pass's, or a healthy pass's minus
 *   text appended to a new, never-served turn, so it can be neither larger nor
 *   different in anything already served. The pass is served as a healthy one
 *   would be, over the limit or not.
 *
 * Every site a pass records is listed here, with its verdict from
 * docs/reports/degraded-pass-fail-open.md. Recording a site that is not listed
 * does not type-check, so a new site cannot join or skip the size guard
 * without a verdict.
 */
export const PASS_DEGRADATION_EFFECTS = {
    // transform.ts: stages that refuse the pass outright (see failPass).
    "store-generation-rebase-failure": "changes-request",
    "session-meta-early-return": "changes-request",
    "compaction-mode-transition-failure": "changes-request",
    "rust-transform-unavailable": "changes-request",
    "overflow-state-read-failure": "changes-request",
    "tagging-persistence-failure": "changes-request",
    "flushed-status-failure": "changes-request",
    // transform.ts: stages that are recorded and served.
    "session-directory-fallback": "served",
    "compartment-trigger-failure": "served",
    "invalid-cache-ttl-fallback": "served",
    // transform-postprocess-phase.ts
    "m0-m1-fold-preexecution-degradation": "changes-request",
    "pending-operation-failure": "changes-request",
    "stale-reduce-strip-exception": "changes-request",
    "image-strip-exception": "changes-request",
    "m0-m1-injection-degradation": "changes-request",
    "m0-m1-fallback-failure": "changes-request",
    "compaction-marker-drain-failure": "changes-request",
    // An uncommitted reminder is not appended to the newest user turn.
    "note-nudge-cas-failure": "served",
    // A timeout, failed search or lost write race on a fresh tail turn skips
    // appending a new hint. A hint served on an earlier pass was re-appended
    // before the search ran.
    "auto-search-timeout": "served",
    "auto-search-search-failure": "served",
    "auto-search-cas-exhaustion": "served",
    // Persisted hints already replayed from the snapshot before the runner.
    // Failure to append an optional fresh-tail hint leaves managed history intact.
    "auto-search-internal-failure": "served",
    "thinking-binding-recovery-persistence-failure": "changes-request",
    "merged-reasoning-strip-persistence-failure": "changes-request",
    "merged-reasoning-strip-exception": "changes-request",
    "trailing-blank-heal-persistence-failure": "changes-request",
    "trailing-blank-heal-exception": "changes-request",
    "trailing-blank-decision-persistence-failure": "changes-request",
    "trailing-blank-decision-exception": "changes-request",
    "proactive-thinking-strip-persistence-failure": "changes-request",
    // The saved removal set is unreadable: the pass fails closed.
    "reasoning-removal-read-failure": "changes-request",
    // This pass's new removals were not saved: replay or refuse rather than
    // serving a partially prepared request.
    "reasoning-removal-persistence-failure": "changes-request",
} as const satisfies Record<string, "changes-request" | "served">;

export type PassDegradationSite = keyof typeof PASS_DEGRADATION_EFFECTS;

/** Whether a degradation at `site` can make the served request larger than, or different from, a healthy pass's. */
export function degradationChangesRequest(site: PassDegradationSite): boolean {
    return PASS_DEGRADATION_EFFECTS[site] === "changes-request";
}

export interface PassDegradation {
    site: PassDegradationSite;
    kind: PassDegradationKind;
}

export interface PassOutcome {
    degradations: PassDegradation[];
    finalized: boolean;
    record(site: PassDegradationSite, kind?: PassDegradationKind): void;
    markFinalized(): void;
    readonly captureEligible: boolean;
    isCaptureEligible(): boolean;
}

export function createPassOutcome(): PassOutcome {
    const degradations: PassDegradation[] = [];
    let finalized = false;
    return {
        degradations,
        get finalized() {
            return finalized;
        },
        record(site, kind = "degraded") {
            degradations.push({ site, kind });
        },
        markFinalized() {
            finalized = true;
        },
        get captureEligible() {
            // A deadline skip is a finalized optional-hint decision, not an
            // incomplete managed representation. Capture the bytes actually served.
            return (
                finalized &&
                degradations.every(
                    (item) => item.kind !== "fatal" && item.site === "auto-search-timeout",
                )
            );
        },
        isCaptureEligible() {
            // A deadline skip is a finalized optional-hint decision, not an
            // incomplete managed representation. Capture the bytes actually served.
            return (
                finalized &&
                degradations.every(
                    (item) => item.kind !== "fatal" && item.site === "auto-search-timeout",
                )
            );
        },
    };
}
