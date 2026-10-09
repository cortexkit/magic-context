import type { CredentialId } from "./ckcred";

/** Request and response encodings the recorder knows how to read. */
export type WireProtocol = "openai-responses" | "bedrock-converse" | "chat-completions" | "anthropic-messages";

export type AuthPlugin = "anthropic-auth" | "openai-auth";

/** One provider route under test: how the host reaches it and how its wire is read. */
export interface ProviderRoute {
    /** Stable label used in result files and `--only` filters, e.g. `openai`. */
    id: string;
    credentialId: CredentialId;
    /** Built OpenCode auth plugin loaded by absolute path, using only the disposable login slot. */
    authPlugin?: AuthPlugin;
    /** OpenCode provider id written into the throwaway host config. */
    providerId: string;
    npm: string;
    /** Real upstream base URL. The host talks to the loopback recorder, which forwards here. */
    upstreamBase: string;
    model: string;
    protocol: WireProtocol;
    /**
     * Model fields merged into the host config: reasoning flags, limits, and `interleaved`,
     * which names the assistant-message field OpenCode uses to send reasoning back
     * (`reasoning_content` on DeepSeek and Kimi).
     */
    modelConfig?: Record<string, unknown>;
    /** Provider options merged next to the key and the recorder base URL. */
    providerOptions?: Record<string, unknown>;
    /** Model call options (reasoning effort, `store`, `include`, thinking budget). */
    modelOptions?: Record<string, unknown>;
    /** How the key reaches the provider config. Defaults to `options.apiKey`. */
    keyPlacement?: "apiKey";
    notes?: string;
}

export type ScenarioKind = "age" | "drop" | "trim-only";

export interface ScenarioSpec {
    route: ProviderRoute;
    kind: ScenarioKind;
    /** Number of single `bash` calls the first turn asks the model to make, one per step. */
    loopSteps: number;
    /**
     * `keep_reasoning_tokens` in the throwaway config; removal rides rebuilding passes.
     */
    keepReasoningTokens: number;
    /** Hard cap on provider calls this scenario may make; the recorder refuses beyond it. */
    callBudget: number;
}

/** Normalized usage, plus the provider's own numbers. */
export interface UsageRecord {
    /** Input tokens as the provider reports them in its own field (see `inputField`). */
    input: number | null;
    inputField: string;
    cachedRead: number | null;
    cacheWrite: number | null;
    output: number | null;
    reasoning: number | null;
    /** Provider-reported charge in USD, when the provider sends one (OpenRouter). */
    cost: number | null;
    raw: unknown;
}

/** What the recorder found in one request body. */
export interface RequestShape {
    kind: "loop" | "aux";
    /** Assistant steps in request order: `R` carries reasoning, `-` does not. */
    reasoningMap: string;
    reasoningItems: number;
    /** Reasoning slots sent as empty strings (DeepSeek-style `reasoning_content: ""`). */
    emptyReasoning: number;
    toolCalls: number;
    toolResults: number;
    bytes: number;
    /** Provider-specific flags worth reporting, e.g. `store`, `include`, thinking config. */
    flags: Record<string, unknown>;
}

export interface CallRecord {
    index: number;
    at: string;
    /** Harness phase active when the call was made (`turn-1`, `flush`, `turn-2`, ...). */
    phase: string;
    path: string;
    model: string | null;
    status: number;
    accepted: boolean;
    /** Provider error text, truncated and scrubbed of anything key-shaped. */
    error: string | null;
    usage: UsageRecord | null;
    /** Allowlisted response diagnostics; absence is recorded explicitly, including SSE metadata. */
    diagnostics: Record<string, unknown>;
    requestId: string | null;
    request: RequestShape;
    durationMs: number;
}

export interface ScenarioResult {
    scenario: string;
    route: string;
    model: string;
    hostVersion: string;
    pluginCommit: string;
    startedAt: string;
    finishedAt: string;
    outcome: "completed" | "aborted";
    abortReason: string | null;
    /** Host retries the recorder answered itself after a rejection; never sent upstream. */
    locallyRefusedCalls: number;
    calls: CallRecord[];
    /** Magic Context log lines that show reasoning removal or the queued drop applying. */
    removalLog: string[];
    /** Database files the host process held open, all inside the throwaway root. */
    isolation: { hostPid: number | null; dbFiles: string[]; rootRemoved: boolean };
    summary: ScenarioSummary;
    trimOnly?: TrimOnlyEvidence;
}

export interface TrimOnlyEvidence {
    qualified: boolean;
    failures: string[];
    removedOldestBlocks: number;
    retainedSignedBlocks: number;
    trimCall: number | null;
    cacheCall: number | null;
    toolEditCall: number | null;
}

export interface ScenarioSummary {
    loopCalls: number;
    rejectedCalls: number;
    /** First loop call whose reasoning map shows a removed step. */
    firstRemovalCall: number | null;
    acceptedAfterRemoval: boolean | null;
    callsAfterRemoval: number;
    /** Last loop call before removal and first after it, for the billed-input comparison. */
    before: Pick<CallRecord, "index" | "usage" | "request"> | null;
    after: Pick<CallRecord, "index" | "usage" | "request"> | null;
}
