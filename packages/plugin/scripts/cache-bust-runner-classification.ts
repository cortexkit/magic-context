import { cachedPrefixFloor } from "./cache-bust-attribution";
import type { RunnerDecision } from "./cache-bust-runner-log";

export type RunnerBustClass =
    | "scope_changed"
    | "view"
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
}

export interface RunnerCacheFacts {
    cacheTtlMs?: number;
    lastTouchAt?: number;
    previousCompletedAt?: number;
    scopeChange?: string;
}

/** Providers refresh the cached prompt when a request starts, so a start-to-start gap needs no expiry margin. */
export function classifyRunnerStep(
    previous: RunnerMeterStep,
    current: RunnerMeterStep,
    decisions: readonly RunnerDecision[],
    facts: RunnerCacheFacts = {},
): RunnerClassification {
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
    const result = (kind: RunnerBustClass, evidence: string): RunnerClassification => ({
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
    const previousVersion = decisions
        .filter((event) => event.at <= previous.at)
        .sort((a, b) => a.at - b.at)
        .flatMap((event) => {
            if (event.kind === "view" && event.version !== undefined) return [event.version];
            const applied =
                event.kind === "setup"
                    ? /applied view (Some\((\d+)\)|None)/.exec(event.detail)
                    : undefined;
            return applied ? [applied[2] ? Number(applied[2]) : 0] : [];
        })
        .at(-1);
    const view = window.find(
        (event) =>
            event.kind === "view" &&
            event.version !== undefined &&
            previousVersion !== undefined &&
            event.version > previousVersion,
    );
    if (view) return result("view", view.line ?? view.detail);
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
    const forgot = window.find((event) =>
        causes(event).some((cause) =>
            ["CacheExpired", "ChainReset", "TierChange", "AccountChange"].includes(cause),
        ),
    );
    if (forgot) return result("provider_forgot", forgot.line ?? forgot.detail);
    const lastTouch = Math.max(
        previous.at,
        facts.lastTouchAt ?? -Infinity,
        facts.previousCompletedAt ?? -Infinity,
    );
    if (current.at - lastTouch > cacheTtlMs)
        return result(
            "expired",
            `idle ${current.at - lastTouch}ms exceeds lifetime ${cacheTtlMs}ms`,
        );
    // A handshake does not change a provider's cache key. Without a recorded
    // cause, a restart must not hide a rewrite, including a complete cache miss.
    return result(
        "unexplained",
        `no model change, higher accepted view, plan change, provider-forgot ride or proven expiry${afterRestart ? "; after a runner restart" : ""}; no other recorded cause`,
    );
}

export function formatRunnerStepTiming(
    timing?: Pick<RunnerClassification, "previousStepAt" | "idleGapMs">,
): string {
    return `idle=${timing?.idleGapMs === undefined ? "—" : (timing.idleGapMs / 60_000).toFixed(1)}; previous_step=${timing?.previousStepAt === undefined ? "—" : new Date(timing.previousStepAt).toISOString()}`;
}
