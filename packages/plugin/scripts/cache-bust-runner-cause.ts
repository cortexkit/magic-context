import {
    classifyRunnerStep,
    type RunnerCacheFacts,
    type RunnerMeterStep,
    type RunnerStepClassification,
} from "./cache-bust-runner-classification";
import type { RunnerStepFacts } from "./cache-bust-runner-feed";
import type { RunnerDecision } from "./cache-bust-runner-log";
import {
    creditRunnerViewsOnExpiry,
    creditRunnerViewVersion,
    emptyRunnerViewAttribution,
    observeRunnerViewStep,
} from "./cache-bust-runner-views";

type RunnerRewriteClass = NonNullable<RunnerStepClassification["class"]>;

/**
 * Astrocyte names a rewrite's cause from the facts runners put on each step
 * (`rewrite_cause` in the cortexkit-usage-steps crate). Each cause maps onto the
 * class the log-timing guess would give the same event, so the wake rules stay
 * those of that class. A signed-floor move is a plan change, as in the log path.
 */
export const ASTROCYTE_CAUSE_CLASSES: ReadonlyMap<string, RunnerRewriteClass> = new Map([
    ["account_or_model_changed", "scope_changed"],
    ["cache_expired", "expired"],
    ["tools_or_system_changed", "plan_changed"],
    ["view_changed", "view"],
    ["signed_floor_moved", "plan_changed"],
    ["unexplained", "unexplained"],
]);

/**
 * Astrocyte skips each comparison whose facts are missing, so a row from before
 * the runner sent facts reads `unexplained` with nothing compared. Its cause
 * counts only when both steps carry at least one comparable fact.
 */
export function carriesCauseFacts(facts: RunnerStepFacts | undefined): boolean {
    return facts !== undefined && (facts.view_version !== undefined || facts.tools_digest !== undefined ||
        facts.system_digest !== undefined || facts.account_ref !== undefined);
}

/** The facts both steps must carry before Astrocyte's "unexplained" is trusted. */
const UNEXPLAINED_NEEDS = ["view_version", "tools_digest", "system_digest"] as const;

export interface RunnerFeedStepDecision {
    classification: RunnerStepClassification;
    /** Set when Astrocyte's cause decided a class other than the log-timing guess. */
    disagreement?: { cause: string; astrocyteClass: RunnerRewriteClass; logClass: RunnerRewriteClass };
}

/**
 * Classify a feed step, preferring Astrocyte's cause over the log-timing guess
 * when the cause is known and both steps carry its facts. Otherwise this is
 * exactly `classifyRunnerStep`, so runners that send no facts are judged as before.
 */
export function classifyRunnerFeedStep(
    previous: RunnerMeterStep,
    current: RunnerMeterStep,
    decisions: readonly RunnerDecision[],
    facts: RunnerCacheFacts = {},
    cause?: string,
): RunnerFeedStepDecision {
    // An unfamiliar cause from a newer Astrocyte has no class here yet.
    const mapped = cause === undefined ? undefined : ASTROCYTE_CAUSE_CLASSES.get(cause);
    if (cause === undefined || !mapped || !carriesCauseFacts(previous.facts) || !carriesCauseFacts(current.facts))
        return { classification: classifyRunnerStep(previous, current, decisions, facts) };
    const views = facts.viewAttribution ?? emptyRunnerViewAttribution();
    // The log-timing guess runs on a copy and is kept only for comparison: any
    // view it credited would no longer be available to explain a later rewrite.
    const guess = classifyRunnerStep(previous, current, decisions, {
        ...facts,
        viewAttribution: structuredClone(views),
    });
    // Count both requests on the real state too, as the guess did on its copy,
    // so a later rewrite still sees how many requests followed each acceptance.
    observeRunnerViewStep(views, decisions, previous.at);
    observeRunnerViewStep(views, decisions, current.at);
    if (guess.healthy || !guess.class) return { classification: guess };
    const before = previous.facts!;
    const after = current.facts!;
    // Astrocyte calls a rewrite unexplained when none of the facts it compares
    // changed, so the verdict only holds when both steps carry each of them. A
    // step can carry an account and nothing else: a runner may send the view
    // and digests only on requests that asked the module. Then a view or plan
    // change is invisible to Astrocyte, and the module log decides.
    // Expiry is judged from the previous request's finish time and cache
    // lifetime and this request's start time. Without them Astrocyte cannot
    // see an idle-expired cache, so a step after a day's silence would read
    // as unexplained.
    if (
        cause === "unexplained" &&
        (UNEXPLAINED_NEEDS.some((key) => before[key] === undefined || after[key] === undefined) ||
            before.cache_ttl_ms === undefined ||
            before.finished_at_ms === undefined ||
            after.started_at_ms === undefined)
    )
        return { classification: guess };
    const changed = (key: keyof RunnerStepFacts): boolean =>
        before[key] !== undefined && after[key] !== undefined && before[key] !== after[key];
    // The facts that differ between the two steps, then supporting detail.
    const deciding: string[] = [];
    const detail: string[] = [];
    const classification: RunnerStepClassification = {
        healthy: false,
        class: mapped,
        cause,
        previousTotal: guess.previousTotal,
        rewrittenTokens: guess.rewrittenTokens,
        afterRestart: guess.afterRestart,
        previousStepAt: guess.previousStepAt,
        idleGapMs: guess.idleGapMs,
        evidence: "",
    };
    switch (cause) {
        case "account_or_model_changed":
            // Account refs are already one-way hashes; a prefix is enough to
            // tell several sessions that moved between the same accounts.
            if (changed("account_ref"))
                deciding.push(`account ${before.account_ref!.slice(0, 8)}→${after.account_ref!.slice(0, 8)}`);
            if (previous.model !== current.model) deciding.push(`model ${previous.model}→${current.model}`);
            break;
        case "cache_expired": {
            if (after.started_at_ms !== undefined && before.finished_at_ms !== undefined && before.cache_ttl_ms !== undefined)
                deciding.push(`${after.started_at_ms - before.finished_at_ms}ms from the previous request's finish to this one's start exceeds its cache lifetime ${before.cache_ttl_ms}ms`);
            // A rebuilt prompt carries every pending view, as in the log path.
            const applied = creditRunnerViewsOnExpiry(views, current.at);
            if (applied) detail.push(applied);
            break;
        }
        case "tools_or_system_changed":
            if (changed("tools_digest")) deciding.push("tools digest changed");
            if (changed("system_digest")) deciding.push("system digest changed");
            break;
        case "view_changed": {
            if (changed("view_version")) deciding.push(`view ${before.view_version}→${after.view_version}`);
            if (after.view_version === undefined) break;
            const view = creditRunnerViewVersion(views, decisions, after.view_version, current.at);
            classification.viewVersion = after.view_version;
            if (view) {
                classification.viewAcceptedAt = view.at;
                detail.push(`view ${view.version} accepted at ${new Date(view.at).toISOString()}; ${view.line}`);
            } else detail.push(`no acceptance of view ${after.view_version} in the module log`);
            break;
        }
        case "signed_floor_moved":
            if (changed("signed_floor")) deciding.push(`signed floor ${before.signed_floor}→${after.signed_floor}`);
            break;
        case "unexplained":
            deciding.push(`no account, model, expiry, tools, system, view or signed-floor change${guess.afterRestart ? "; after a runner restart" : ""}`);
            break;
    }
    // Astrocyte compares with its own previous row, which can be a step this
    // watcher does not judge (no counts, or another provider).
    if (!deciding.length) deciding.push("no deciding fact changed since the previous metered step");
    classification.evidence = `cause=${cause} (astrocyte); ${[...deciding, ...detail].join("; ")}`;
    return {
        classification,
        ...(guess.class !== mapped
            ? { disagreement: { cause, astrocyteClass: mapped, logClass: guess.class } }
            : {}),
    };
}
