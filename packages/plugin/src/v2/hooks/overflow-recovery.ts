import { detectOverflow } from "../../features/magic-context/overflow-detection";
import {
    type ContextDatabase,
    getOverflowState,
    recordDetectedContextLimit,
    recordOverflowDetected,
} from "../../features/magic-context/storage";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { hiddenTerminalError } from "./hidden-terminal-error";

type Model = { providerID: string; id: string };
interface PrimaryRequest {
    model: Model;
    assistantMessageID?: string;
    observed: boolean;
}

function isRateLimit(error: unknown): boolean {
    const pending = [error];
    const seen = new Set<unknown>();
    for (let i = 0; pending.length && i < 16; i++) {
        const value = pending.shift();
        if (seen.has(value)) continue;
        seen.add(value);
        if (typeof value === "string") {
            try {
                pending.push(JSON.parse(value));
            } catch {
                /* Plain messages have no structured status. */
            }
        } else if (value && typeof value === "object") {
            const p = value as Record<string, unknown>;
            if (
                p.status === 429 ||
                p.statusCode === 429 ||
                [p.type, p.name, p.code, p._tag].some(
                    (tag) => typeof tag === "string" && /rate[_ .-]?limit|throttl/i.test(tag),
                )
            )
                return true;
            pending.push(p.data, p.error, p.cause);
        }
    }
    return false;
}

/** Match each error report to the request that failed, not a later model selection. */
export class V2OverflowRecovery {
    private readonly requests = new BoundedSessionMap<PrimaryRequest>(1000);

    constructor(
        private readonly deps: {
            database: () => ContextDatabase | null;
            compactionOff: boolean;
            isHidden: (sessionID: string) => boolean;
            onInputTokens?: (sessionID: string, inputTokens: number, limit: number) => void;
        },
    ) {}

    begin(input: {
        sessionID: string;
        kind: string;
        model: Model;
        assistantMessageID?: string;
    }): void {
        if (input.kind !== "primary" || this.deps.isHidden(input.sessionID)) return;
        const prior = this.requests.get(input.sessionID);
        // HTTP retries for the same assistant step and model reuse its request entry.
        if (
            input.assistantMessageID &&
            prior?.assistantMessageID === input.assistantMessageID &&
            prior.model.providerID === input.model.providerID &&
            prior.model.id === input.model.id
        )
            return;
        this.requests.set(input.sessionID, {
            model: { ...input.model },
            assistantMessageID: input.assistantMessageID,
            observed: false,
        });
    }

    forget(sessionID: string): void {
        this.requests.delete(sessionID);
    }

    observeTerminal(
        event: {
            type?: string;
            data?: { sessionID?: string; assistantMessageID?: string; error?: unknown };
        },
        readStep: (
            sessionID: string,
            messageID?: string,
        ) =>
            | {
                  id: string;
                  model?: Model;
                  error?: unknown;
              }
            | undefined,
    ): void {
        if (
            !["session.step.failed", "session.execution.failed", "session.error"].includes(
                event.type ?? "",
            )
        )
            return;
        const sessionID = event.data?.sessionID;
        if (!sessionID || this.deps.isHidden(sessionID)) return;
        const error =
            event.type === "session.step.failed" ? event.data?.error : hiddenTerminalError(event);
        if (error === undefined) return;
        const prior = this.requests.get(sessionID);
        if (prior?.observed || isRateLimit(error) || !detectOverflow(error).isOverflow) return;
        const messageID = event.data?.assistantMessageID;
        const step = readStep(sessionID, messageID);
        if (!step) return;
        // Execution errors have no step id. A later successful/in-flight assistant
        // is not evidence that the old failure belongs to that newer request.
        if (!messageID && (!step?.error || !detectOverflow(step.error).isOverflow)) return;
        if (!prior && step.model)
            this.begin({
                sessionID,
                kind: "primary",
                model: step.model,
                assistantMessageID: step.id,
            });
        const request = this.requests.get(sessionID);
        if (!request) return;
        this.observe({
            sessionID,
            error,
            model: step?.model ?? request.model,
            assistantMessageID: messageID ?? step?.id,
        });
    }

    observe(input: {
        sessionID: string;
        model: Model;
        assistantMessageID?: string;
        error: unknown;
        status?: number;
        kind?: string;
    }): void {
        if (!this.requests.has(input.sessionID) && input.kind === "primary")
            this.begin({ ...input, kind: "primary" });
        const request = this.requests.get(input.sessionID);
        if (
            !request ||
            request.observed ||
            this.deps.isHidden(input.sessionID) ||
            request.model.providerID !== input.model.providerID ||
            request.model.id !== input.model.id ||
            (input.assistantMessageID &&
                request.assistantMessageID &&
                input.assistantMessageID !== request.assistantMessageID)
        )
            return;
        if (input.status === 429 || isRateLimit(input.error)) return;
        const detection = detectOverflow(input.error);
        if (!detection.isOverflow) return;
        const db = this.deps.database();
        if (!db) return;
        const modelKey = `${input.model.providerID}/${input.model.id}`;
        if (this.deps.compactionOff) {
            if (detection.reportedLimit)
                recordDetectedContextLimit(
                    db,
                    input.sessionID,
                    detection.reportedLimit,
                    modelKey,
                    detection.reportedLimitProvenance,
                );
        } else {
            recordOverflowDetected(
                db,
                input.sessionID,
                detection.reportedLimit,
                modelKey,
                "provider_overflow",
                detection.reportedLimitProvenance,
                detection.reportedInputTokens,
            );
        }
        // If the durable write fails, another error report must be able to retry it.
        request.observed = true;
        if (!this.deps.compactionOff && detection.reportedInputTokens)
            this.deps.onInputTokens?.(
                input.sessionID,
                detection.reportedInputTokens,
                getOverflowState(db, input.sessionID, modelKey).detectedContextLimit,
            );
    }
}
