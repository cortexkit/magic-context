import { cachedPrefixFloor } from "./cache-bust-attribution";
import type { RunnerDecision } from "./cache-bust-runner-log";
import {
    creditRunnerViewRewrite,
    creditRunnerViewsOnExpiry,
    emptyRunnerViewAttribution,
    observeRunnerViewStep,
    type RunnerViewAttributionState,
} from "./cache-bust-runner-views";

export type RunnerBustClass =
    | "scope_changed"
    | "view"
    | "double_rebuild"
    | "plan_changed"
    | "provider_forgot"
    | "expired"
    | "unexplained";

export interface RunnerMeterStep {
    at: number;
    model: string;
    read: number;
    write: number;
}

export interface RunnerClassification {
    healthy: boolean;
    class?: RunnerBustClass;
    rewrittenTokens: number;
    previousTotal: number;
    evidence: string;
    afterRestart: boolean;
    previousStepAt?: number;
    idleGapMs?: number;
    viewVersion?: number;
    viewAcceptedAt?: number;
}

export type RunnerStepClassification = Omit<RunnerClassification, "class"> & {
    class?: Exclude<RunnerBustClass, "double_rebuild">;
};

// A runner applies a new view at its next request, so a second view for the
// same context-window pressure shows up within the next request or two.
export const DOUBLE_REBUILD_WINDOW_MS = 120_000;

export interface RunnerViewRewrite {
    at: number;
    viewVersion: number;
    viewAcceptedAt: number;
    written: number;
    idleGapMs?: number;
}

/** Group only rewrites already attributed to distinct accepted views. */
export function extendRunnerRebuildChain(
    chain: readonly RunnerViewRewrite[],
    step: RunnerMeterStep,
    classification: RunnerClassification,
): RunnerViewRewrite[] {
    if (classification.class !== "view" || classification.viewVersion === undefined ||
        classification.viewAcceptedAt === undefined) return [...chain];
    const rewrite: RunnerViewRewrite = {
        at: step.at,
        viewVersion: classification.viewVersion,
        viewAcceptedAt: classification.viewAcceptedAt,
        written: step.write,
        idleGapMs: classification.idleGapMs,
    };
    const last = chain.at(-1);
    if (!last || step.at - last.at > DOUBLE_REBUILD_WINDOW_MS || step.at < last.at)
        return [rewrite];
    if (chain.some((prior) => prior.viewVersion === rewrite.viewVersion ||
        prior.viewAcceptedAt === rewrite.viewAcceptedAt)) return [...chain];
    return [...chain, rewrite];
}

export interface RunnerCacheFacts {
    cacheTtlMs?: number;
    lastTouchAt?: number;
    previousCompletedAt?: number;
    scopeChange?: string;
    viewAttribution?: RunnerViewAttributionState;
}

/** Providers refresh the cached prompt when a request starts, so a start-to-start gap needs no expiry margin. */
export function classifyRunnerStep(
    previous: RunnerMeterStep,
    current: RunnerMeterStep,
    decisions: readonly RunnerDecision[],
    facts: RunnerCacheFacts = {},
): RunnerStepClassification {
    const views = facts.viewAttribution ?? emptyRunnerViewAttribution();
    observeRunnerViewStep(views, decisions, previous.at);
    observeRunnerViewStep(views, decisions, current.at);
    const cacheTtlMs = facts.cacheTtlMs ?? 3_600_000;
    const previousTotal = previous.read + previous.write;
    const window = decisions.filter(
        (event) => event.at > (facts.previousCompletedAt ?? previous.at) && event.at <= current.at,
    );
    const afterRestart = window.some((event) => event.kind === "setup");
    const base = {
        previousTotal,
        rewrittenTokens: Math.max(0, previousTotal - current.read),
        afterRestart,
        previousStepAt: previous.at,
        idleGapMs: current.at - previous.at,
    };
    if (
        current.read >= cachedPrefixFloor({ read: previous.read, write: previous.write, input: 0 })
    ) {
        return {
            ...base,
            healthy: true,
            rewrittenTokens: 0,
            evidence: "cache read covers the previous read + write minus 64",
        };
    }
    const result = (kind: NonNullable<RunnerStepClassification["class"]>, evidence: string): RunnerStepClassification => ({
        ...base,
        healthy: false,
        class: kind,
        evidence,
    });
    if (facts.scopeChange || current.model !== previous.model)
        return result(
            "scope_changed",
            facts.scopeChange ?? `model ${previous.model} → ${current.model}`,
        );
    const causes = (event: RunnerDecision): string[] =>
        event.kind === "ride"
            ? (event.detail.match(/^ride \[([^\]]*)\]/)?.[1] ?? "")
                  .split(",")
                  .map((cause) => cause.trim())
            : [];
    const plan = window.find(
        (event) =>
            event.kind === "signed_floor" ||
            causes(event).some((cause) => ["SurfaceChange", "ModelChange"].includes(cause)),
    );
    if (plan) return result("plan_changed", plan.line ?? plan.detail);
    const lastTouch = Math.max(
        previous.at,
        facts.lastTouchAt ?? -Infinity,
        facts.previousCompletedAt ?? -Infinity,
    );
    if (current.at - lastTouch > cacheTtlMs) {
        const applied = creditRunnerViewsOnExpiry(views, current.at);
        return result(
            "expired",
            `idle ${current.at - lastTouch}ms exceeds lifetime ${cacheTtlMs}ms${applied ? `; ${applied}` : ""}`,
        );
    }
    const view = creditRunnerViewRewrite(views, decisions, current.at);
    if (view) return {
        ...result("view", view.evidence),
        viewVersion: view.view.version,
        viewAcceptedAt: view.view.at,
    };
    const forgot = window.find((event) =>
        causes(event).some((cause) =>
            ["CacheExpired", "ChainReset", "TierChange", "AccountChange"].includes(cause),
        ),
    );
    if (forgot) return result("provider_forgot", forgot.line ?? forgot.detail);
    // A handshake does not change a provider's cache key. Without a recorded
    // cause, a restart must not hide a rewrite, including a complete cache miss.
    return result(
        "unexplained",
        `no model change, eligible accepted view, plan change, provider-forgot ride or proven expiry${afterRestart ? "; after a runner restart" : ""}; no other recorded cause`,
    );
}

export function formatRunnerStepTiming(
    timing?: Pick<RunnerClassification, "previousStepAt" | "idleGapMs">,
): string {
    return `idle=${timing?.idleGapMs === undefined ? "—" : (timing.idleGapMs / 60_000).toFixed(1)}; previous_step=${timing?.previousStepAt === undefined ? "—" : new Date(timing.previousStepAt).toISOString()}`;
}
