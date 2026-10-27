import type { PluginContext } from "../../../plugin/types";
import type { V2Context } from "../../../v2/hooks/types";
import { EmergencyFailClosedError } from "../emergency-fail-closed";
import type { MarkerEnvelope } from "../marker-envelope";
import type { MessageLike } from "../transform-operations";
import type { BridgeReceipt } from "./bridge-receipt";
import type { FallbackInputs } from "./fallback-admissibility";
import type { ExitReason, HookOutcome, Subject } from "./record";

/** Opaque Magic Context payload relay: one whole subc frame payload per call, with an absolute Unix-ms deadline.
 * The bridge owns JSON encoding and reply-page assembly; failures reject with BridgeTransportError. */
export interface BridgeTransport {
    request(
        method: string,
        body: Uint8Array,
        opts: { deadlineMs: number; signal?: AbortSignal },
    ): Promise<Uint8Array>;
}

export type BridgeTransportError =
    | { source: "module"; code: string; message: string }
    | {
          source: "relay";
          code: "relay_unavailable" | "session_scope_missing" | "deadline" | "aborted";
      };

export interface BridgeAdapterOptions {
    openCodeClient: PluginContext["client"] | V2Context;
    projectRoot: string;
    connectionFile: string;
    storageDir: string;
    configPath: string;
    /** Caller-owned relay; when supplied, the bridge never opens its own subc connection. */
    transport?: BridgeTransport;
    /** OpenCode/Pi share context.db; upgrades can make older binaries unable to open it, so opt-in is required. */
    allowMigration?: boolean;
}

export interface BridgeRunInput {
    sessionId: string;
    messages: MessageLike[];
    /** Model step only; the native adapter decides when history must be rebuilt from persisted source/model state. */
    kind: "model";
}

export interface BridgeFactScope {
    sessionId: string;
    lineageId: string;
    model: { providerID: string; modelID: string };
    /** Unix milliseconds; older observations of the same kind are ignored. */
    observedAt: number;
}

/** Observations do not certify delivery or authorize removing history from the host store. */
export type BridgeHostFact = BridgeFactScope &
    (
        | {
              kind: "provider_response";
              requestId: string;
              completedAt: number;
              finishReason: string;
              /** Terminal request outcome, independent of receipt/delivery acknowledgement. */
              outcome: "success" | "failed" | "aborted";
              error?: unknown;
              /** Raw usage components; scheduling uses input + cacheRead + cacheWrite, never output. */
              usage?: { input: number; cacheRead: number; cacheWrite: number; output: number };
              /** Positive host-resolved usable input window, including auth/config route caps. */
              contextWindow: number;
              /** System strings, visible tool definitions and unobserved tool names sent by requestId.
               * Usage is reusable only for a matching model and envelope; a successful response's
               * usage also derives the envelope reading that bounds unobserved tool schemas. */
              material?: MarkerEnvelope;
          }
        | {
              kind: "system_prompt";
              /** Effective host prompt, including date fields; use the returned normalized bytes. */
              system: string[];
          }
        | {
              kind: "todowrite";
              tool: "todowrite";
              ownerMessageId: string;
              /** Host's current permission verdict for the exact native tool. */
              callable: boolean;
              todos: {
                  id?: string;
                  content: string;
                  status: "pending" | "in_progress" | "completed" | "cancelled";
                  priority: "high" | "medium" | "low";
              }[];
          }
    );

export interface BridgeHostFactResult {
    accepted: boolean;
    /** Present for system_prompt; these are the bytes the host must send. */
    system?: string[];
}

export type BridgeStepKind = "ordinary" | "bootstrap" | "rebuild";

export interface BridgeView {
    messages: MessageLike[];
    kind: BridgeStepKind;
    receipt: BridgeReceipt;
}

export class StepBudgetExceededError extends Error {
    readonly code = "step_budget_exceeded";
    constructor(
        readonly budget_ms: number,
        readonly kind: BridgeStepKind,
    ) {
        super(`Bridge ${kind} step exceeded its ${budget_ms} ms budget`);
        this.name = "StepBudgetExceededError";
    }
}

export type BridgeFallbackInputs = Omit<FallbackInputs, "messages"> & {
    /** Complete host-sent window; the facade normalizes OpenCode's C/S-before-tail order. */
    messages: readonly MessageLike[];
};

export type BridgeMarkerInputs = Omit<
    BridgeFallbackInputs,
    "envelope" | "systemPromptTokens" | "toolDefinitionTokens" | "material"
> & {
    /** Final system-transform strings, the visible sent tool definitions and the names of
     * sent tools whose schema is not visible, not host token estimates. */
    material?: MarkerEnvelope;
};

export type BridgeRefusalReason =
    | ExitReason
    | "bootstrap_declined"
    | "provider_disabled"
    | "rollback"
    | "raw_history_provider_missing"
    | "covered_range_changed"
    | "served_bytes_changed";

const REFUSAL_MESSAGES: Partial<Record<BridgeRefusalReason, string>> = {
    raw_history_provider_missing:
        "OpenCode 2 bridge requires a registered per-session raw-history provider before run",
    served_bytes_changed:
        "Bridge refused the step: the new view would change Magic Context's bytes in messages already returned, or put them back to raw host text. Nothing was committed. Confirm delivery of requests that reached the provider (completeRequest with a clean end), then call run() again",
};

/** Refuse the native adapter's full-request execution path; callers must prove fallback admission before sending history. */
export class BridgeRefusalError extends EmergencyFailClosedError {
    /** True when the refused step committed nothing, so the host may call run() again
     * after the fix the message names, without changing the session's history. */
    readonly retryable: boolean;
    constructor(readonly reason: BridgeRefusalReason) {
        super(
            REFUSAL_MESSAGES[reason] ??
                `Bridge provider handoff refused: ${reason}; check isFallbackAdmissible or refuse the step`,
            { code: `bridge_${reason}` },
        );
        this.name = "BridgeRefusalError";
        this.retryable = reason === "served_bytes_changed";
    }
}

/** Awaited for newly saved hook ops or unavailability before messages are served. */
export type BridgeOutcomeListener = (
    messageId: string,
    subject: Subject,
    outcome: HookOutcome,
) => Promise<void>;
