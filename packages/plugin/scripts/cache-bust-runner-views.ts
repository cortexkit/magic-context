import type { RunnerDecision } from "./cache-bust-runner-log";

export const RUNNER_VIEW_RETENTION_MS = 30 * 3_600_000;
// Allow three intervening requests with cache-read/write counts because requests
// already in flight can still carry the old view. Idle time consumes none of
// this allowance, even when a turn ends for hours.
export const MAX_RUNNER_VIEW_DELAY_STEPS = 3;

export interface RunnerAcceptedView {
    at: number;
    version: number;
    line: string;
    credited: boolean;
    withdrawnAt?: number;
}

// Requests already in flight can finish under the old view. Healthy steps must
// not consume an accepted view; saved credits prevent reuse after a restart.
export interface RunnerViewAttributionState {
    views: RunnerAcceptedView[];
    steps: number[];
}

export const emptyRunnerViewAttribution = (): RunnerViewAttributionState => ({ views: [], steps: [] });

export function pruneRunnerViews(state: RunnerViewAttributionState, now: number): void {
    const cutoff = now - RUNNER_VIEW_RETENTION_MS;
    state.views = state.views.filter((view) => view.at >= cutoff);
    state.steps = state.steps.filter((at) => at >= cutoff);
}

/** Retain accepted views even when no metered request has carried them yet. */
export function syncRunnerViews(
    state: RunnerViewAttributionState,
    decisions: readonly RunnerDecision[],
    before: number,
): void {
    pruneRunnerViews(state, before);
    for (const event of decisions.filter((event) =>
        event.at >= before - RUNNER_VIEW_RETENTION_MS && event.at < before,
    ).sort((a, b) => a.at - b.at)) {
        if (event.kind === "view" && event.version !== undefined &&
            !state.views.some((view) => view.version === event.version)) {
            state.views.push({
                at: event.at, version: event.version, line: event.line ?? event.detail,
                credited: false,
            });
        }
        // Setup can silently re-offer a pending view, even when it reports an
        // older applied version. Only a recorded failure withdraws that offer.
        if (event.kind !== "view_refused" && event.kind !== "view_unknown" && event.kind !== "view_reoffer_failed") continue;
        for (const view of state.views) {
            if (event.at < view.at) continue;
            // A boundary refusal rolls back all newer unconfirmed views as well.
            // A failed re-offer rolls back every pending view, including older ones.
            if ((event.kind === "view_refused" && event.version !== undefined && view.version >= event.version) ||
                (event.kind === "view_unknown" && view.version === event.version) ||
                event.kind === "view_reoffer_failed")
                view.withdrawnAt = Math.min(view.withdrawnAt ?? Infinity, event.at);
        }
    }
}

export function observeRunnerViewStep(
    state: RunnerViewAttributionState,
    decisions: readonly RunnerDecision[],
    at: number,
): void {
    syncRunnerViews(state, decisions, at);
    if (!state.steps.includes(at)) state.steps.push(at);
}

/** An expired prompt is rebuilt in full, so pending views ride that same request. */
export function creditRunnerViewsOnExpiry(state: RunnerViewAttributionState, at: number): string {
    return state.views.filter((view) =>
        !view.credited && (view.withdrawnAt ?? Infinity) >= at && view.at < at,
    ).sort((a, b) => a.at - b.at || a.version - b.version).map((view) => {
        view.credited = true;
        return `view ${view.version} accepted at ${new Date(view.at).toISOString()} was applied with this rewrite`;
    }).join("; ");
}

/** Credit pending accepts together so an older view cannot hide a later rewrite. */
export function creditRunnerViewRewrite(
    state: RunnerViewAttributionState,
    decisions: readonly RunnerDecision[],
    at: number,
): { view: RunnerAcceptedView; evidence: string } | undefined {
    const stepsBetween = (view: RunnerAcceptedView) =>
        state.steps.filter((step) => step > view.at && step < at).length;
    const view = state.views.filter((candidate) =>
        !candidate.credited && (candidate.withdrawnAt ?? Infinity) >= at && candidate.at < at &&
        candidate.at >= at - RUNNER_VIEW_RETENTION_MS && stepsBetween(candidate) <= MAX_RUNNER_VIEW_DELAY_STEPS,
    ).sort((a, b) => a.at - b.at || a.version - b.version).at(-1);
    if (!view) return undefined;
    for (const candidate of state.views)
        if (candidate.at <= view.at) candidate.credited = true;
    const steps = stepsBetween(view);
    const reading = decisions.filter((event) =>
        event.kind === "stale_reading" && event.at > view.at && event.at < at,
    ).at(-1);
    return {
        view,
        evidence: `view ${view.version} accepted at ${new Date(view.at).toISOString()}; ${steps} metered step(s) between accept and rewrite; ${view.line}${reading ? `; ${reading.line ?? reading.detail}` : ""}`,
    };
}
