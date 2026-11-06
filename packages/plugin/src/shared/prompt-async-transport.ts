import type { createOpencodeClient } from "@opencode-ai/sdk";
import { buildHiddenAgentRegistrations } from "../agents/hidden-agent-registrations";
import {
    createDreamTokenBudget,
    DreamTokenBudgetExceeded,
    registerBudgetFinalizeChild,
    releaseBudgetFinalizeChild,
    TOKEN_BUDGET_FINALIZE_MESSAGE,
} from "../features/magic-context/dreamer/token-budget";
import {
    annotateSubagentInvocationError,
    sumTokensFromChildMessages,
} from "../features/magic-context/subagent-token-capture";
import { describeAssistantError } from "./assistant-message-extractor";
import { sessionLog } from "./logger";
import type { PromptArgs, PromptTransport } from "./model-suggestion-retry";
import {
    abortChildRun,
    noteModelActivityMonitored,
    noteModelOutputReceived,
} from "./model-suggestion-retry";

type Client = ReturnType<typeof createOpencodeClient> | undefined;

const activeSessionErrors = new Map<string, unknown>();
const budgetAbortedSessions = new Set<string>();

/** Feed host errors only to active background waits, not ordinary user sessions. */
export function recordPromptSessionError(sessionId: string, error: unknown): void {
    // The finalize nudge intentionally aborts the previous generation. Its late
    // event must not poison the replacement turn; other provider errors still count.
    if (
        budgetAbortedSessions.has(sessionId) &&
        describeAssistantError(error).startsWith("MessageAbortedError")
    )
        return;
    if (activeSessionErrors.has(sessionId) && activeSessionErrors.get(sessionId) === undefined)
        activeSessionErrors.set(sessionId, error);
}

/**
 * Why this exists: a synchronous `session.prompt` keeps one HTTP request open
 * for a child's whole agent loop, which for a dreamer batch is many minutes.
 * Some OpenCode 1 builds give plugins an SDK client whose fetch keeps Bun's
 * default request timer, which rejects with `TimeoutError` after five to six
 * minutes while the host keeps running the child. Sending with `prompt_async`
 * and polling for idle keeps every request short, so the caller's own slice
 * timer is the only thing that can end the run.
 */

const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** How long an idle child may show no started run before the send is treated as
 * lost. The host creates the user message and marks the session busy right after
 * accepting `prompt_async`, so this only has to cover a slow or contended host. */
const DEFAULT_START_GRACE_MS = 30_000;
/** The wait only looks at the newest messages: the ones this send appended and
 * the ones just before it. The host returns the most recent `limit` messages. */
const MESSAGE_WINDOW = 100;
const MAPPER_STEP_CAP = buildHiddenAgentRegistrations({
    dreamerPrompt: undefined,
    historianPrompt: undefined,
    historianEditorPrompt: undefined,
    historianDisallowed: [],
}).find((agent) => agent.id === "dreamer-memory-mapper")?.maxSteps;

export interface PromptAsyncWaitOptions {
    pollIntervalMs?: number;
    startGraceMs?: number;
    tokenBudget?: number;
    modelConfigKey?: string;
    /** Shared across retries of one child session. */
    budgetGuard?: ReturnType<typeof createDreamTokenBudget>;
    onBudgetUpdate?: (
        state: ReturnType<ReturnType<typeof createDreamTokenBudget>["snapshot"]> & {
            sessionId: string;
        },
    ) => void;
}

type SessionApi = {
    prompt?: (options: unknown) => Promise<unknown>;
    promptAsync?: (options: unknown) => Promise<unknown>;
    status?: (options?: unknown) => Promise<unknown>;
    messages?: (options: unknown) => Promise<unknown>;
    abort?: (options: unknown) => Promise<unknown>;
};

function sessionApi(client: Client): SessionApi | undefined {
    return (client as { session?: SessionApi } | undefined)?.session;
}

/** Marks the error the wait throws when the host reported a session error for the child. */
const HOST_SESSION_ERROR = Symbol("promptAsyncHostSessionError");

/** True for the error the wait throws when the host recorded a session error for the child. */
export function isHostSessionError(error: unknown): boolean {
    return (
        error !== null &&
        typeof error === "object" &&
        (error as { [HOST_SESSION_ERROR]?: unknown })[HOST_SESSION_ERROR] === true
    );
}

/** Return the original host error carried by a marked child-session failure. */
export function hostSessionErrorOf(error: unknown): unknown {
    if (!isHostSessionError(error)) return undefined;
    return (error as { hostError?: unknown }).hostError;
}

function requestModelRef(request: PromptArgs): string | undefined {
    const model = request.body?.model;
    if (model && typeof model.providerID === "string" && typeof model.modelID === "string")
        return `${model.providerID}/${model.modelID}`;
    return undefined;
}

/** True when the host client can send without waiting and report session status. */
export function supportsPromptAsync(client: Client): boolean {
    const session = sessionApi(client);
    return (
        typeof session?.promptAsync === "function" &&
        typeof session?.status === "function" &&
        typeof session?.messages === "function"
    );
}

/**
 * Build a retry-chain transport that sends with `prompt_async` and waits for the
 * child to go idle. Returns undefined for a client without those endpoints, so
 * the caller falls back to the synchronous prompt.
 */
export function createPromptAsyncTransport(
    client: Client,
    childSessionId: string,
    options: PromptAsyncWaitOptions = {},
): PromptTransport | undefined {
    if (!supportsPromptAsync(client)) {
        // Pi's synchronous facade owns the subprocess budget. Forward its final
        // per-child state before manifest application, not just into the run ledger.
        const readChildTokenBudget = (
            client as unknown as
                | {
                      readChildTokenBudget?: (
                          id: string,
                      ) =>
                          | ReturnType<ReturnType<typeof createDreamTokenBudget>["snapshot"]>
                          | undefined;
                  }
                | undefined
        )?.readChildTokenBudget;
        const session = sessionApi(client);
        if (!readChildTokenBudget || !session?.prompt) return undefined;
        return Object.assign(
            async (request: PromptArgs) => {
                const previous = readChildTokenBudget(childSessionId);
                const remaining =
                    options.tokenBudget === undefined
                        ? undefined
                        : options.tokenBudget - (previous?.spent ?? 0);
                if ((remaining !== undefined && remaining <= 0) || previous?.finalizeFired)
                    throw new DreamTokenBudgetExceeded(childSessionId, previous?.spent ?? 0);
                try {
                    await session.prompt?.({
                        ...request,
                        ...(remaining === undefined ? {} : { tokenBudget: remaining }),
                    });
                } finally {
                    const state = readChildTokenBudget(childSessionId);
                    if (state) options.onBudgetUpdate?.({ ...state, sessionId: childSessionId });
                }
            },
            { childSessionId },
        );
    }
    const budgetGuard = options.tokenBudget
        ? createDreamTokenBudget(options.tokenBudget)
        : undefined;
    return Object.assign(
        (request: PromptArgs) =>
            promptAsyncAndWaitForIdle(client, request, { ...options, budgetGuard }),
        { childSessionId },
    );
}

type MessageInfo = {
    id?: unknown;
    role?: unknown;
    time?: { completed?: unknown };
    finish?: unknown;
    error?: unknown;
};

function infoOf(message: unknown): MessageInfo {
    const info = (message as { info?: unknown } | null)?.info;
    return info && typeof info === "object" ? (info as MessageInfo) : {};
}

function messageId(message: unknown): string | null {
    const id = infoOf(message).id;
    return typeof id === "string" ? id : null;
}

function recordedAssistantError(message: unknown): unknown {
    const info = infoOf(message);
    if (info.error != null) return info.error;
    // A completed step can retain retry parts from a provider attempt that
    // already recovered before this poll. Its successful settlement wins.
    if (isSettledAssistant(message)) return undefined;
    const parts = (message as { parts?: unknown[] } | null)?.parts;
    if (!Array.isArray(parts)) return undefined;
    // OpenCode records a failed provider attempt as a retry part before it
    // settles the assistant row or emits session.error.
    const retry = parts
        .slice()
        .reverse()
        .find(
            (part) =>
                part !== null &&
                typeof part === "object" &&
                (part as { type?: unknown }).type === "retry",
        ) as { error?: unknown } | undefined;
    return retry?.error ?? undefined;
}

/** An assistant message the host has finished writing, successfully or not. */
function isSettledAssistant(message: unknown): boolean {
    const info = infoOf(message);
    if (info.role !== "assistant") return false;
    return info.time?.completed != null || info.error != null || info.finish != null;
}

function isTerminalAssistant(message: unknown): boolean {
    const info = infoOf(message);
    return (
        isSettledAssistant(message) &&
        info.finish !== "tool-calls" &&
        info.finish !== "tool_use" &&
        !(
            message &&
            typeof message === "object" &&
            Array.isArray((message as { parts?: unknown[] }).parts) &&
            (message as { parts: Array<{ type?: string }> }).parts.some(
                (part) => part.type === "tool",
            )
        )
    );
}

/**
 * True when an assistant row shows the model has answered: any token usage, or a
 * non-empty text or reasoning part, or a tool call. A row the host creates before
 * the provider responds carries none of these.
 */
function showsModelOutput(message: unknown): boolean {
    if (infoOf(message).role !== "assistant") return false;
    const tokens = sumTokensFromChildMessages([message]);
    if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0) return true;
    const parts = (message as { parts?: unknown } | null)?.parts;
    if (!Array.isArray(parts)) return false;
    return parts.some((part) => {
        if (!part || typeof part !== "object") return false;
        const { type, text } = part as { type?: unknown; text?: unknown };
        if (type === "tool") return true;
        return (
            (type === "text" || type === "reasoning") &&
            typeof text === "string" &&
            text.trim().length > 0
        );
    });
}

function unwrapData(response: unknown): unknown {
    if (response && typeof response === "object" && "data" in response) {
        return (response as { data?: unknown }).data;
    }
    return response;
}

function describeRejection(error: unknown): string {
    if (error instanceof Error) return error.message;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function abortError(signal: AbortSignal): unknown {
    return signal.reason ?? new Error("prompt_async wait aborted");
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError(signal));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError(signal as AbortSignal));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

async function readMessages(
    session: SessionApi,
    sessionId: string,
    directory: string | undefined,
    signal: AbortSignal | undefined,
): Promise<unknown[]> {
    const response = await session.messages?.({
        path: { id: sessionId },
        query: { ...(directory ? { directory } : {}), limit: MESSAGE_WINDOW },
        ...(signal ? { signal } : {}),
    });
    const data = unwrapData(response);
    return Array.isArray(data) ? data : [];
}

/** "busy"/"retry" while the loop runs, "idle" when absent or idle, null when unreadable. */
async function readStatus(
    session: SessionApi,
    sessionId: string,
    directory: string | undefined,
    signal: AbortSignal | undefined,
): Promise<string | null> {
    try {
        const response = await session.status?.({
            ...(directory ? { query: { directory } } : {}),
            ...(signal ? { signal } : {}),
        });
        if (response && typeof response === "object" && "error" in response) {
            if ((response as { error?: unknown }).error) return null;
        }
        const data = unwrapData(response);
        if (!data || typeof data !== "object") return null;
        const entry = (data as Record<string, unknown>)[sessionId];
        const type = (entry as { type?: unknown } | undefined)?.type;
        return typeof type === "string" ? type : "idle";
    } catch (error) {
        if (signal?.aborted) throw error;
        return null;
    }
}

export async function promptAsyncAndWaitForIdle(
    client: Client,
    request: PromptArgs,
    options: PromptAsyncWaitOptions = {},
): Promise<void> {
    const session = sessionApi(client);
    if (!session || !supportsPromptAsync(client)) {
        throw new Error("prompt_async transport is unavailable on this client");
    }
    const sessionId = request.path.id;
    const directory = (request.query as { directory?: unknown } | undefined)?.directory;
    const dir = typeof directory === "string" ? directory : undefined;
    const signal = request.signal;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startGraceMs = options.startGraceMs ?? DEFAULT_START_GRACE_MS;
    const budget =
        options.budgetGuard ??
        (options.tokenBudget ? createDreamTokenBudget(options.tokenBudget) : undefined);
    if (budget && (budget.snapshot().finalizeFired || budget.snapshot().hardStopped))
        throw new DreamTokenBudgetExceeded(sessionId, budget.snapshot().spent);
    const seenUsage = new Set<string>();
    const seenSteps = new Set<string>();
    const mapper = request.body.agent === "dreamer-memory-mapper";
    let finalizing = false;
    let completionBaseline = new Set(
        (await readMessages(session, sessionId, dir, signal))
            .map(messageId)
            .filter((id): id is string => id !== null),
    );
    const initialBaseline = new Set(completionBaseline);
    // Dispatch can fail before an assistant row exists. The plugin event hook
    // retains that provider/model error while this child is actively awaited.
    activeSessionErrors.set(sessionId, undefined);
    const failForHostError = async (hostError: unknown): Promise<never> => {
        // Stop the host's retry loop before handing the attempt to our model
        // chain; otherwise the failed model keeps making requests in parallel.
        await abortChildRun(client, sessionId);
        const error = new Error(
            `Host recorded session error: ${describeAssistantError(hostError)}`,
        );
        Object.assign(error, {
            name: "DreamerProviderOutputFailureError",
            transient: true,
            [HOST_SESSION_ERROR]: true,
            hostError,
        });
        annotateSubagentInvocationError(error, {
            attemptedModel: requestModelRef(request),
            modelConfigKey: options.modelConfigKey,
            hostError,
        });
        throw error;
    };
    try {
        let sent: unknown;
        try {
            sent = await session.promptAsync?.(request);
        } catch (error) {
            annotateSubagentInvocationError(error, {
                attemptedModel: requestModelRef(request),
                modelConfigKey: options.modelConfigKey,
                hostError: error,
            });
            throw error;
        }
        if (sent && typeof sent === "object" && "error" in sent) {
            const rejection = (sent as { error?: unknown }).error;
            if (rejection) {
                const error = new Error(
                    `prompt_async was rejected: ${describeRejection(rejection)}`,
                    {
                        cause: rejection,
                    },
                );
                annotateSubagentInvocationError(error, {
                    attemptedModel: requestModelRef(request),
                    modelConfigKey: options.modelConfigKey,
                    hostError: rejection,
                });
                throw error;
            }
        }
        let sentAt = Date.now();
        let sawBusy = false;
        // From here on this wait reports whether the model has produced anything,
        // which lets the model chain tell a silent model from a slow answer.
        noteModelActivityMonitored(signal);
        let sawOutput = false;

        for (;;) {
            await sleep(pollIntervalMs, signal);
            const hostError = activeSessionErrors.get(sessionId);
            if (hostError !== undefined) {
                await failForHostError(hostError);
            }
            const status = await readStatus(session, sessionId, dir, signal);
            const messages = await readMessages(session, sessionId, dir, signal);
            const latestAssistant = messages
                .slice()
                .reverse()
                .find((message) => {
                    const id = messageId(message);
                    return (
                        id !== null &&
                        !completionBaseline.has(id) &&
                        infoOf(message).role === "assistant"
                    );
                });
            const assistantError = recordedAssistantError(latestAssistant);
            if (assistantError !== undefined) await failForHostError(assistantError);
            if (
                !sawOutput &&
                messages.some((message) => {
                    const id = messageId(message);
                    // Rows from before this send belong to an earlier attempt.
                    return id !== null && !initialBaseline.has(id) && showsModelOutput(message);
                })
            ) {
                sawOutput = true;
                noteModelOutputReceived(signal);
            }
            if (budget) {
                const latest = messages.at(-1);
                const latestId = messageId(latest);
                const completedAnswer =
                    latestId !== null &&
                    !completionBaseline.has(latestId) &&
                    isTerminalAssistant(latest) &&
                    infoOf(latest).error == null;
                for (const message of messages) {
                    const id = messageId(message);
                    if (!id || infoOf(message).role !== "assistant") continue;
                    // The initial baseline belongs to a previous child attempt.
                    if (initialBaseline.has(id)) continue;
                    if (isSettledAssistant(message)) seenSteps.add(id);
                    if (seenUsage.has(id)) continue;
                    const tokens = sumTokensFromChildMessages([message]);
                    // A streaming row may not have usage yet; let a later poll
                    // charge its final report rather than remembering zero tokens.
                    if (tokens.input + tokens.cacheRead + tokens.cacheWrite > 0) seenUsage.add(id);
                    let decision = budget.charge(
                        tokens.input,
                        tokens.cacheRead,
                        tokens.cacheWrite,
                        // A poll can receive several usage rows together. Charge
                        // all of them, but never abort an answer already completed.
                        completedAnswer ||
                            (isTerminalAssistant(message) && infoOf(message).error == null),
                    );
                    // Polling can see an in-flight turn after the newest usage row;
                    // reserve it and a final answer before OpenCode's hard step cap.
                    if (
                        mapper &&
                        MAPPER_STEP_CAP !== undefined &&
                        !completedAnswer &&
                        decision === "continue" &&
                        seenSteps.size >= MAPPER_STEP_CAP - 2
                    )
                        decision = budget.finalize();
                    options.onBudgetUpdate?.({ ...budget.snapshot(), sessionId });
                    if (decision === "stop") {
                        await session.abort?.({ path: { id: sessionId } });
                        throw new DreamTokenBudgetExceeded(sessionId, budget.snapshot().spent);
                    }
                    if (decision === "finalize") {
                        finalizing = true;
                        sessionLog(
                            sessionId,
                            "dreamer token budget: finalize fired",
                            budget.snapshot(),
                        );
                        budgetAbortedSessions.add(sessionId);
                        registerBudgetFinalizeChild(sessionId, budget);
                        if (!session.abort)
                            throw new DreamTokenBudgetExceeded(sessionId, budget.snapshot().spent);
                        await session.abort({ path: { id: sessionId } });
                        // Wait for the cancelled generation to become idle before
                        // submitting a new user turn in the same session.
                        const abortDeadline = Date.now() + startGraceMs;
                        while (Date.now() < abortDeadline) {
                            const state = await readStatus(session, sessionId, dir, signal);
                            if (state === "idle") break;
                            await sleep(pollIntervalMs, signal);
                        }
                        if ((await readStatus(session, sessionId, dir, signal)) !== "idle") {
                            throw new DreamTokenBudgetExceeded(sessionId, budget.snapshot().spent);
                        }
                        // An aborted assistant is not the answer to the new user turn.
                        completionBaseline = new Set(
                            (await readMessages(session, sessionId, dir, signal))
                                .map(messageId)
                                .filter((value): value is string => value !== null),
                        );
                        const finalizeResponse = await session.promptAsync?.({
                            ...request,
                            body: {
                                ...request.body,
                                parts: [{ type: "text", text: TOKEN_BUDGET_FINALIZE_MESSAGE }],
                            },
                        });
                        if (
                            finalizeResponse &&
                            typeof finalizeResponse === "object" &&
                            "error" in finalizeResponse &&
                            finalizeResponse.error
                        ) {
                            throw new DreamTokenBudgetExceeded(sessionId, budget.snapshot().spent);
                        }
                        sentAt = Date.now();
                        sawBusy = false;
                        break;
                    }
                }
                if (budget.snapshot().hardStopped && !completedAnswer) {
                    await session.abort?.({ path: { id: sessionId } });
                    throw new DreamTokenBudgetExceeded(sessionId, budget.snapshot().spent);
                }
            }
            if (status === "busy" || status === "retry") {
                sawBusy = true;
                continue;
            }
            if (status === null) continue;
            const current = finalizing
                ? await readMessages(session, sessionId, dir, signal)
                : messages;
            const last = current.at(-1);
            const lastId = messageId(last);
            if (
                last &&
                lastId !== null &&
                !completionBaseline.has(lastId) &&
                isSettledAssistant(last)
            )
                return;
            // An accepted user message is not a completion. A host-side rejection
            // can leave only that row behind while the session remains idle.
            if (Date.now() - sentAt >= startGraceMs) {
                throw new Error(
                    `prompt_async did not start a run with a settled assistant in child session ${sessionId} within ${startGraceMs}ms (observed_busy=${sawBusy})`,
                );
            }
        }
    } finally {
        activeSessionErrors.delete(sessionId);
        budgetAbortedSessions.delete(sessionId);
        if (budget) releaseBudgetFinalizeChild(sessionId);
    }
}
