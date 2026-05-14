export type BypassReason = "force-materialize" | "explicit-bust" | "subagent" | "none";

export interface BypassInput {
    contextUsage: { percentage: number };
    sessionMeta: { isSubagent: boolean };
    historyRefreshSessions: Set<string>;
    sessionId: string;
}

export const FORCE_MATERIALIZE_PERCENTAGE = 85;

export function detectMidTurnBypassReason(input: BypassInput): BypassReason {
    if (input.contextUsage.percentage >= FORCE_MATERIALIZE_PERCENTAGE) return "force-materialize";
    if (input.historyRefreshSessions.has(input.sessionId)) return "explicit-bust";
    if (input.sessionMeta.isSubagent) return "subagent";
    return "none";
}

export interface ApplyMidTurnDeferralInput {
    base: "execute" | "defer";
    bypassReason: BypassReason;
    midTurn: boolean;
}

export interface ApplyMidTurnDeferralOutput {
    midTurnAdjustedSchedulerDecision: "execute" | "defer";
    sideEffect: "set-flag" | "none";
}

export function applyMidTurnDeferral(input: ApplyMidTurnDeferralInput): ApplyMidTurnDeferralOutput {
    // Scope: bypass evaluation is nested under base === "execute".
    if (input.base === "defer") {
        return { midTurnAdjustedSchedulerDecision: "defer", sideEffect: "none" };
    }
    // base === "execute"
    if (input.bypassReason !== "none") {
        return { midTurnAdjustedSchedulerDecision: "execute", sideEffect: "none" };
    }
    if (input.midTurn) {
        return { midTurnAdjustedSchedulerDecision: "defer", sideEffect: "set-flag" };
    }
    return { midTurnAdjustedSchedulerDecision: "execute", sideEffect: "none" };
}
