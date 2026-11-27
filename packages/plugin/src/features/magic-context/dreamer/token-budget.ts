export class DreamTokenBudgetExceeded extends Error {
    constructor(
        readonly sessionId: string,
        readonly spent: number,
    ) {
        super(`Dreamer child ${sessionId} spent ${spent} prompt tokens (token_budget)`);
        this.name = "DreamTokenBudgetExceeded";
    }
}

export const TOKEN_BUDGET_FINALIZE_MESSAGE =
    "You're out of token budget. Stop investigating: make no more tool calls and output your result now, covering only what you've already checked; leave the rest out.";
export const TOKEN_BUDGET_TOOL_REFUSAL =
    "Out of token budget: no more tool calls. Output your result now.";

/** Count only provider-reported prompt tokens. Output and reasoning do not replay
 * the accumulated context and must not be added to this cost guard. */
export interface DreamTokenBudgetState {
    readonly budget: number;
    readonly spent: number;
    /** Investigation ended early, either for tokens or the mapper's step ceiling. */
    readonly finalizeFired: boolean;
    readonly refusedCalls: number;
    readonly hardStopped: boolean;
}

interface FinalizingChild {
    budget: ReturnType<typeof createDreamTokenBudget>;
    refusedBeforeSubmission: Set<string>;
    inFlightAtAbort?: Set<string>;
}

const finalizingChildren = new Map<string, FinalizingChild>();

/**
 * OpenCode 1's `tool.execute.before` hook always refuses while finalizing.
 * Refusals start counting when the poller installs the in-flight set just
 * before it submits the finalize prompt.
 */
export function registerBudgetFinalizeChild(
    sessionId: string,
    budget: ReturnType<typeof createDreamTokenBudget>,
): (inFlightAtAbort: Set<string>) => void {
    const child: FinalizingChild = { budget, refusedBeforeSubmission: new Set() };
    finalizingChildren.set(sessionId, child);
    return (inFlightAtAbort) => {
        for (const id of child.refusedBeforeSubmission) inFlightAtAbort.delete(id);
        child.inFlightAtAbort = inFlightAtAbort;
    };
}

export function releaseBudgetFinalizeChild(sessionId: string): void {
    finalizingChildren.delete(sessionId);
}

export function refuseBudgetedToolCall(
    sessionId: string,
    callId?: string,
): { message: string; hardStopped: boolean; spared?: "before-submission" | "in-flight" } | null {
    const child = finalizingChildren.get(sessionId);
    if (!child) return null;
    const inFlight = child.inFlightAtAbort;
    if (inFlight === undefined) {
        if (callId) child.refusedBeforeSubmission.add(callId);
        return {
            message: TOKEN_BUDGET_TOOL_REFUSAL,
            hardStopped: child.budget.snapshot().hardStopped,
            spared: "before-submission",
        };
    }
    if (callId && inFlight.delete(callId)) {
        return {
            message: TOKEN_BUDGET_TOOL_REFUSAL,
            hardStopped: child.budget.snapshot().hardStopped,
            spared: "in-flight",
        };
    }
    return child.budget.refuseTool();
}

export function createDreamTokenBudget(budget: number) {
    if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("Invalid token budget");
    let spent = 0;
    let finalizeFired = false;
    let refusedCalls = 0;
    let forcedStop = false;
    const snapshot = (): DreamTokenBudgetState => ({
        budget,
        spent,
        finalizeFired,
        refusedCalls,
        hardStopped: forcedStop || spent >= budget || refusedCalls >= 2,
    });
    return {
        snapshot,
        /** Step ceilings use the same tool refusal and partial-result path as tokens. */
        finalize(): "continue" | "finalize" {
            if (finalizeFired) return "continue";
            finalizeFired = true;
            return "finalize";
        },
        /** Call once per provider usage report; a host must deduplicate message IDs. */
        charge(
            input: number,
            cacheRead: number,
            cacheWrite: number,
            completed = false,
            canFinalize = true,
        ): "continue" | "finalize" | "stop" {
            for (const value of [input, cacheRead, cacheWrite]) {
                if (!Number.isSafeInteger(value) || value < 0)
                    throw new Error("Invalid prompt usage");
            }
            spent += input + cacheRead + cacheWrite;
            // Usage caps further investigation, not a finished answer already paid for.
            if (completed) return "continue";
            if (spent >= budget) return "stop";
            if (!completed && !finalizeFired && spent >= budget * 0.8) {
                if (!canFinalize) {
                    forcedStop = true;
                    return "stop";
                }
                finalizeFired = true;
                return "finalize";
            }
            return "continue";
        },
        refuseTool(): { message: string; hardStopped: boolean } | null {
            if (!finalizeFired && !snapshot().hardStopped) return null;
            // Only refusals counted toward the stop belong in the budget state.
            refusedCalls += 1;
            return { message: TOKEN_BUDGET_TOOL_REFUSAL, hardStopped: snapshot().hardStopped };
        },
    };
}
