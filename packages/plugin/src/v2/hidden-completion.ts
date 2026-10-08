import {
    createDreamTokenBudget,
    DreamTokenBudgetExceeded,
} from "../features/magic-context/dreamer/token-budget";
import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
    HiddenRunHandle,
    HiddenRunIdentity,
} from "../hooks/magic-context/compartment-runner-types";
import { HiddenCompletionRefusal } from "../hooks/magic-context/compartment-runner-types";
import { estimateTokens } from "../hooks/magic-context/read-session-formatting";
import { recordHiddenVariantWarning } from "../shared/hidden-variant-warnings";
import { log } from "../shared/logger";
import type { PromptArgs } from "../shared/model-suggestion-retry";
import { parseProviderModel, toModelEntry } from "../shared/resolve-fallbacks";
import { runTokenLog } from "../shared/run-token-log";
import type { Database } from "../shared/sqlite";
import { createNativeHiddenChildren } from "./hidden-child-native";
import {
    assistantOutcome,
    errorText,
    type HiddenChildHost,
    type HiddenChildLifecycle,
    type HiddenChildModel,
    type HiddenChildRole,
    type HiddenChildRows,
    type PersistedHiddenChild,
    withReader,
} from "./hidden-child-record";
import {
    HIDDEN_CURATE_AGENT,
    HiddenAgentStepLimit,
    type HiddenChildAttempt,
    type HiddenChildHook,
    hiddenToolLoop,
} from "./hooks/hidden-child";
import type { StoreRow } from "./store-reader";

export type { HiddenChildHost, HiddenChildRows } from "./hidden-child-record";

type Model = HiddenChildModel;

export interface V2HiddenCompletionOptions {
    db: Database;
    projectIdentity: string;
    directory: string;
    hook: HiddenChildHook;
    openReader: () => HiddenChildRows & { close?: () => void };
    ensureAgent?(): Promise<void>;
    generation?: string;
    /** Maximum time shutdown waits for the host to remove a child. */
    removalTimeoutMs?: number;
    /**
     * The user's `keep_subagents` setting. When true, retired children that the OpenCode 1 lane
     * would keep are left in the host instead of deleted (see `keptUnderRetention`).
     */
    keepSubagents?: boolean;
    log?: (message: string) => void;
    /** Return the host catalog when available; catalog failures leave the request unchanged. */
    modelCatalog?: () => Promise<unknown>;
}

interface RunState {
    identity: HiddenRunIdentity;
    budget?: ReturnType<typeof createDreamTokenBudget>;
    role: HiddenChildRole;
    child: PersistedHiddenChild;
    releaseRole: () => void;
    completion?: HiddenCompletion;
    failed: boolean;
    /** A failure other than a settled provider error row (dispatch error, refusal, timeout, abort). */
    unsettledFailure: boolean;
    retired: boolean;
}

const POLL_INTERVAL_MS = 200;

function modelKey(model: Model): string {
    return `${model.providerID}/${model.modelID}`;
}

function sameModel(left: Model, right: Model): boolean {
    return modelKey(left) === modelKey(right) && left.variant === right.variant;
}

function configuredHead(identity: HiddenRunIdentity): Model | undefined {
    const candidates = [identity.model, ...(identity.configuredModels ?? [])];
    for (const candidate of candidates) {
        const entry = toModelEntry(candidate);
        const parsed = entry ? parseProviderModel(entry.model) : null;
        if (parsed) return { ...parsed, ...(entry?.qualifier ? { variant: entry.qualifier } : {}) };
    }
    return undefined;
}

function roleFor(identity: HiddenRunIdentity): HiddenChildRole {
    if (identity.kind !== "dreamer-task") return "historian";
    return identity.agent === HIDDEN_CURATE_AGENT ? "dreamer-curate" : "dreamer";
}

function promptText(request: PromptArgs): string {
    const parts = request.body.parts;
    return Array.isArray(parts)
        ? parts
              .flatMap((part) =>
                  part &&
                  typeof part === "object" &&
                  typeof (part as { text?: unknown }).text === "string"
                      ? [(part as { text: string }).text]
                      : [],
              )
              .join("\n")
        : "";
}

/** Local estimate used only when a completed GA row omitted provider usage. */
function meter(system: string, prompt: string, text: string) {
    return {
        input: estimateTokens(system) + estimateTokens(prompt),
        output: estimateTokens(text),
        cacheRead: 0,
        cacheWrite: 0,
    };
}

/**
 * The text a successful wire tool result carries: `{ type: "text", value }` for a single
 * text part, `{ type: "content", value: [{ text }] }` for several. Error results
 * (`{ error, content }`) yield nothing, so a failed call never reads as an applied one.
 */
function toolResultText(result: unknown): string | undefined {
    if (typeof result !== "object" || result === null) return undefined;
    const value = (result as { value?: unknown }).value;
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return undefined;
    const text = value
        .map((part) =>
            typeof part === "object" &&
            part !== null &&
            typeof (part as { text?: unknown }).text === "string"
                ? (part as { text: string }).text
                : "",
        )
        .filter((part) => part.length > 0)
        .join("\n");
    return text.length > 0 ? text : undefined;
}

/**
 * Rebuild the child's tool calls in the host message shape the dreamer validators read
 * (`state.status`, `state.input`, `state.output`), matching what the OpenCode 1 transport
 * returns. Curate counts an operation as applied only from its result text, so the text
 * has to survive this conversion.
 */
export function toolLoopMessages(attempt: HiddenChildAttempt): unknown[] {
    const messages = attempt.observedMessages ?? [];
    const results = new Map<string, { status: string; output?: string }>();
    for (const message of messages) {
        if (message.role !== "tool") continue;
        for (const part of message.content) {
            if (part.type !== "tool-result" || typeof part.id !== "string") continue;
            const result = part.result as { type?: unknown; error?: unknown } | undefined;
            // The wire marks a failed call with `resultType: "error"` on the part and an
            // `{ error, content }` result, not with `type: "error"` inside the result.
            const failed =
                result?.type === "error" ||
                (part as { resultType?: unknown }).resultType === "error" ||
                (typeof result === "object" && result !== null && "error" in result);
            const output = failed ? undefined : toolResultText(result);
            results.set(part.id, {
                status: failed ? "error" : "completed",
                ...(output === undefined ? {} : { output }),
            });
        }
    }
    return messages.flatMap((message) => {
        if (message.role !== "assistant") return [];
        const parts = message.content.flatMap((part) => {
            if (
                part.type !== "tool-call" ||
                typeof part.id !== "string" ||
                typeof part.name !== "string"
            )
                return [];
            const result = results.get(part.id);
            return [
                {
                    type: "tool",
                    tool: part.name,
                    state: {
                        status: result?.status ?? "pending",
                        input: part.input,
                        ...(result?.output === undefined ? {} : { output: result.output }),
                    },
                },
            ];
        });
        return parts.length ? [{ info: { role: "assistant" }, parts }] : [];
    });
}

function assistantReasoning(row: StoreRow<"assistant">): string | null {
    const reasoning = (row.data.content ?? [])
        .flatMap((part) =>
            part.type === "reasoning" && typeof part.text === "string" ? [part.text] : [],
        )
        .join("\n");
    return reasoning.length > 0 ? reasoning : null;
}

function assistantText(row: StoreRow<"assistant">): string | null {
    const text = (row.data.content ?? [])
        .flatMap((part) =>
            part.type === "text" && typeof part.text === "string" ? [part.text] : [],
        )
        .join("");
    return text.length > 0 ? text : null;
}

/**
 * A terminal provider or model-resolution failure persisted by the host, as opposed to an unsettled
 * dispatch error, timeout, or abort. The type keeps lifecycle handling independent of provider
 * wording; terminal provider failures are quarantined by retiring the child before its attempt
 * marker is released.
 */
export class HiddenProviderError extends Error {
    readonly settled: boolean;

    constructor(detail: string, options: { settled?: boolean } = {}) {
        super(`Hidden completion provider error: ${detail}`);
        this.name = "HiddenProviderError";
        this.settled = options.settled ?? true;
    }
}

function requestModel(request: PromptArgs, current: Model): Model {
    const requested = request.body.model;
    if (
        requested &&
        typeof requested.providerID === "string" &&
        typeof requested.modelID === "string"
    ) {
        return {
            providerID: requested.providerID,
            modelID: requested.modelID,
            ...(typeof request.body.variant === "string" ? { variant: request.body.variant } : {}),
        };
    }
    return current;
}

async function sleepUntilPoll(signal: AbortSignal | undefined, deadline: number): Promise<void> {
    if (signal?.aborted) throw new Error("Hidden completion prompt aborted");
    const delay = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (delay <= 0) return;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        const abort = () => {
            clearTimeout(timer);
            reject(new Error("Hidden completion prompt aborted"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        else
            setTimeout(() => {
                signal?.removeEventListener("abort", abort);
            }, delay);
    });
}

function isProviderFailure(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const type = (error as { type?: unknown }).type;
    return (
        typeof type === "string" &&
        (type.startsWith("provider.") || type.toLowerCase().includes("provider"))
    );
}

async function awaitAssistantRow(
    openReader: () => HiddenChildRows & { close?: () => void },
    readSessionError: () => Promise<unknown>,
    localFailure: () => Error | undefined,
    childID: string,
    afterSeq: number,
    deadline: number,
    signal?: AbortSignal,
): Promise<StoreRow<"assistant">> {
    for (;;) {
        const { assistant, idle } = withReader(openReader, (reader) => ({
            assistant: reader.latestAssistant(childID),
            idle: reader.latestIdle(childID),
        }));
        const newAssistant = assistant && assistant.seq > afterSeq ? assistant : undefined;
        const newIdle = idle && idle.seq > afterSeq ? idle : undefined;
        const refused = localFailure();
        if (refused) throw refused;
        if (newIdle && (!newAssistant || newIdle.seq > newAssistant.seq)) {
            const outcome = newIdle.data.outcome;
            if (outcome === "failed" || outcome === "interrupted") {
                const sessionError = await readSessionError();
                const details = [
                    `outcome=${outcome}`,
                    `terminal_row=${errorText(newIdle)}`,
                    `session_error=${sessionError === undefined ? "unavailable" : errorText(sessionError)}`,
                ];
                throw sessionError === undefined || !isProviderFailure(sessionError)
                    ? new Error(`Hidden completion failed: ${details.join("; ")}`)
                    : new HiddenProviderError(details.join("; "));
            }
            if (outcome === "succeeded" && newAssistant) return newAssistant;
        }
        if (newAssistant) {
            const outcome = assistantOutcome(newAssistant);
            if (outcome === "failed" || outcome === "interrupted") {
                const sessionError = await readSessionError();
                const details = [
                    `outcome=${outcome}`,
                    `terminal_row=${errorText(newAssistant)}`,
                    `session_error=${sessionError === undefined ? "unavailable" : errorText(sessionError)}`,
                ];
                throw sessionError === undefined || !isProviderFailure(sessionError)
                    ? new Error(`Hidden completion failed: ${details.join("; ")}`)
                    : new HiddenProviderError(details.join("; "));
            }
            if (newAssistant.data.error !== undefined) {
                throw new HiddenProviderError(errorText(newAssistant.data.error), {
                    settled: typeof newAssistant.data.finish === "string",
                });
            }
            if (typeof newAssistant.data.finish === "string" || outcome === "succeeded") {
                return newAssistant;
            }
        }
        if (Date.now() >= deadline) {
            throw new Error("Hidden completion timed out waiting for a persisted assistant row");
        }
        await sleepUntilPoll(signal, deadline);
    }
}

/** What the OpenCode 2 hidden executor can do; fixed for this host. */
export const V2_HIDDEN_EXECUTOR_CAPABILITIES: HiddenCompletionExecutor["capabilities"] = {
    tools: true,
    harness: "opencode2",
};

/**
 * An executor that forwards to whichever executor `current` returns and refuses
 * while there is none. Holders registered once at setup (RPC handlers and
 * commands) get this after a refused storage open, so the executor wired on the
 * first successful open later reaches them without a restart.
 */
export function createLateHiddenExecutor(
    current: () => HiddenCompletionExecutor | undefined,
): HiddenCompletionExecutor {
    const wired = (): HiddenCompletionExecutor => {
        const executor = current();
        if (executor) return executor;
        throw new Error(
            "Magic Context hidden work is unavailable until the context database opens.",
        );
    };
    return {
        get capabilities() {
            return current()?.capabilities ?? V2_HIDDEN_EXECUTOR_CAPABILITIES;
        },
        open: (run) => wired().open(run),
        attempt: (handle, request) => wired().attempt(handle, request),
        collect: (handle, limit) => wired().collect(handle, limit),
        close: (handle, settlement) => wired().close(handle, settlement),
    };
}

export async function createV2HiddenCompletionExecutor(
    host: HiddenChildHost,
    options: V2HiddenCompletionOptions,
): Promise<HiddenCompletionExecutor> {
    const runs = new WeakMap<HiddenRunHandle, RunState>();
    const generation = options.generation ?? "opencode2";
    const roleTails = new Map<HiddenChildRole, Promise<void>>();
    const note = options.log ?? log;

    const removeSession = host.removeSession;
    if (!removeSession) throw new Error("Magic Context requires OpenCode 2.0.22 session.remove");
    const lifecycle: HiddenChildLifecycle = createNativeHiddenChildren(
        host,
        (input) => removeSession.call(host, input),
        {
            hook: options.hook,
            generation,
            keepSubagents: options.keepSubagents === true,
            log: note,
            removalTimeoutMs: options.removalTimeoutMs,
            directory: options.directory,
        },
    );

    const acquireRole = async (role: HiddenChildRole): Promise<() => void> => {
        const previous = roleTails.get(role) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => gate);
        roleTails.set(role, tail);
        await previous;
        return () => {
            release();
            if (roleTails.get(role) === tail) roleTails.delete(role);
        };
    };

    const warnedVariants = new Set<string>();
    const validateVariant = async (model: Model): Promise<Model> => {
        if (!model.variant || !options.modelCatalog) return model;
        try {
            const listed = await options.modelCatalog();
            const rows = Array.isArray(listed)
                ? listed
                : listed &&
                    typeof listed === "object" &&
                    Array.isArray((listed as { data?: unknown }).data)
                  ? (listed as { data: unknown[] }).data
                  : [];
            const entry = rows.find(
                (row) =>
                    row &&
                    typeof row === "object" &&
                    (row as { providerID?: unknown }).providerID === model.providerID &&
                    (row as { id?: unknown }).id === model.modelID,
            ) as { variants?: unknown } | undefined;
            if (!entry) return model;
            if (
                entry.variants &&
                typeof entry.variants === "object" &&
                Object.hasOwn(entry.variants, model.variant)
            )
                return model;
            const key = `${model.providerID}/${model.modelID}:${model.variant}`;
            if (!warnedVariants.has(key)) {
                warnedVariants.add(key);
                note(
                    `[magic-context] ${recordHiddenVariantWarning(model.providerID, model.modelID, model.variant)}`,
                );
            }
            return { providerID: model.providerID, modelID: model.modelID };
        } catch {
            return model;
        }
    };

    const resolveHead = async (identity: HiddenRunIdentity): Promise<Model> => {
        const configured = configuredHead(identity);
        if (configured) return validateVariant(configured);
        if (!identity.parentSessionId) {
            throw new HiddenCompletionRefusal(
                "hidden_model_unsupported",
                "Hidden completion requires a configured model or an existing parent session model",
                true,
            );
        }
        const parent = await host.get({ sessionID: identity.parentSessionId });
        if (!parent.model) {
            throw new HiddenCompletionRefusal(
                "hidden_model_unsupported",
                "Hidden completion could not resolve the parent session model",
                true,
            );
        }
        return {
            providerID: parent.model.providerID,
            modelID: parent.model.id,
            ...(parent.model.variant ? { variant: parent.model.variant } : {}),
        };
    };

    const switchChildModel = async (run: RunState, requested: Model): Promise<void> => {
        if (sameModel(run.child.model, requested)) return;
        await host.switchModel({
            sessionID: run.child.id,
            model: {
                providerID: requested.providerID,
                id: requested.modelID,
                ...(requested.variant ? { variant: requested.variant } : {}),
            },
        });
        run.child = lifecycle.updateModel(run.child, requested);
    };

    const retire = (run: RunState, reason: string): void => {
        if (run.retired) return;
        lifecycle.retire(run.child, reason);
        run.retired = true;
    };

    const interruptAndRetire = async (run: RunState, reason: string): Promise<void> => {
        try {
            await host.interrupt({ sessionID: run.child.id });
        } finally {
            retire(run, reason);
        }
    };

    return {
        capabilities: V2_HIDDEN_EXECUTOR_CAPABILITIES,
        async open(identity) {
            const role = roleFor(identity);
            const releaseRole = await acquireRole(role);
            let openedChild: PersistedHiddenChild | undefined;
            try {
                await options.ensureAgent?.();
                const head = await resolveHead(identity);
                const active = await lifecycle.open(identity, role, head);
                openedChild = active;
                const handle = { id: active.id, childSessionId: active.id };
                const tokenBudget = identity.metadata?.tokenBudget;
                const run: RunState = {
                    identity,
                    ...(hiddenToolLoop(identity) && typeof tokenBudget === "number"
                        ? { budget: createDreamTokenBudget(tokenBudget) }
                        : {}),
                    role,
                    child: active,
                    releaseRole,
                    failed: false,
                    unsettledFailure: false,
                    retired: false,
                };
                runs.set(handle, run);
                await switchChildModel(run, head);
                return handle;
            } catch (error) {
                if (openedChild) lifecycle.retire(openedChild, "hidden-run-open-failed");
                releaseRole();
                throw error;
            }
        },
        async attempt(handle, request) {
            const run = runs.get(handle);
            if (!run) throw new Error("Unknown hidden completion run");
            if (request.signal?.aborted) {
                await interruptAndRetire(run, "aborted-before-prompt");
                throw new Error("Hidden completion prompt aborted");
            }

            const requested = await validateVariant(requestModel(request, run.child.model));
            if (run.retired) {
                // Fallback retries share the original handle. A terminal provider failure has
                // already retired its child, so give the retry a fresh carrier instead of
                // prompting a session that is queued for deletion.
                run.child = await lifecycle.create(run.identity, run.role, requested);
                run.failed = false;
                run.unsettledFailure = false;
                run.retired = false;
                handle.id = run.child.id;
                handle.childSessionId = run.child.id;
            }
            await switchChildModel(run, requested);
            const baseline = withReader(options.openReader, (reader) =>
                reader.latestSequence(run.child.id),
            );
            const marker = `mc:hidden:${crypto.randomUUID()}:${crypto.randomUUID()}`;
            run.completion = undefined;
            const attempt: HiddenChildAttempt = {
                childSessionId: run.child.id,
                identity: run.identity,
                request,
                shaped: false,
                budget: run.budget,
            };
            options.hook.registerAttempt(marker, attempt);
            const deadline = Date.now() + run.identity.timeoutMs;
            const budget = run.budget;
            if (budget?.snapshot().finalizeFired) {
                throw new DreamTokenBudgetExceeded(run.child.id, budget.snapshot().spent);
            }
            let usageSeq = baseline;
            let budgetPoll: ReturnType<typeof setInterval> | undefined;
            let budgetReject!: (error: Error) => void;
            const budgetStopped = new Promise<never>((_resolve, reject) => {
                budgetReject = reject;
            });
            if (budget) {
                budgetPoll = setInterval(() => {
                    try {
                        const fresh = withReader(
                            options.openReader,
                            (reader) =>
                                reader.assistantSince?.(run.child.id, usageSeq) ??
                                (() => {
                                    const latest = reader.latestAssistant(run.child.id);
                                    return latest ? [latest] : [];
                                })(),
                        );
                        for (const row of fresh) {
                            if (row.seq <= usageSeq) continue;
                            usageSeq = row.seq;
                            const tokens = row.data.tokens;
                            const decision = budget.charge(
                                Math.max(0, tokens?.input ?? 0),
                                Math.max(0, tokens?.cache?.read ?? 0),
                                Math.max(0, tokens?.cache?.write ?? 0),
                                row.data.finish === "stop" &&
                                    !(row.data.content ?? []).some(
                                        (part) => part.type === "tool-call",
                                    ),
                                false,
                            );
                            const onBudgetUpdate = run.identity.metadata?.onBudgetUpdate;
                            if (typeof onBudgetUpdate === "function")
                                onBudgetUpdate({ ...budget.snapshot(), sessionId: run.child.id });
                            if (decision !== "continue") {
                                if (budgetPoll) clearInterval(budgetPoll);
                                // This host exposes context shaping but no pre-tool execution
                                // hook for hidden children. Stop at the soft threshold instead
                                // of allowing another investigation call to execute.
                                attempt.budgetExceeded = new DreamTokenBudgetExceeded(
                                    run.child.id,
                                    budget.snapshot().spent,
                                );
                                void interruptAndRetire(run, "token-budget").finally(() =>
                                    budgetReject(attempt.budgetExceeded as Error),
                                );
                                return;
                            }
                        }
                    } catch (error) {
                        if (budgetPoll) clearInterval(budgetPoll);
                        budgetReject(error instanceof Error ? error : new Error(String(error)));
                    }
                }, POLL_INTERVAL_MS);
            }
            let abortReject!: (error: Error) => void;
            const aborted = new Promise<never>((_resolve, reject) => {
                abortReject = reject;
            });
            const onAbort = () => {
                void interruptAndRetire(run, "prompt-aborted").finally(() =>
                    abortReject(new Error("Hidden completion prompt aborted")),
                );
            };
            const deadlineTimer = setTimeout(
                () => {
                    void interruptAndRetire(run, "prompt-timeout").finally(() =>
                        abortReject(new Error("Hidden completion prompt timed out")),
                    );
                },
                Math.max(0, deadline - Date.now()),
            );
            request.signal?.addEventListener("abort", onAbort, { once: true });
            try {
                await Promise.race([
                    host.prompt({ sessionID: run.child.id, text: marker }),
                    aborted,
                    ...(budget ? [budgetStopped] : []),
                ]);
                await Promise.race([
                    host.wait({ sessionID: run.child.id }),
                    aborted,
                    ...(budget ? [budgetStopped] : []),
                ]);
                const row = await Promise.race([
                    awaitAssistantRow(
                        options.openReader,
                        async () => {
                            try {
                                const eventError = await host.terminalError?.({
                                    sessionID: run.child.id,
                                });
                                if (eventError !== undefined) return eventError;
                                return (await host.get({ sessionID: run.child.id })).error;
                            } catch {
                                return undefined;
                            }
                        },
                        () => attempt.refusal ?? attempt.stepLimit,
                        run.child.id,
                        baseline,
                        deadline,
                        request.signal,
                    ),
                    aborted,
                    ...(budget ? [budgetStopped] : []),
                ]);
                if (!attempt.shaped) {
                    throw new HiddenCompletionRefusal(
                        "hidden_prompt_unrecognized",
                        "Host did not dispatch the hidden child context hook",
                        true,
                    );
                }
                const text = assistantText(row);
                const system =
                    typeof request.body.system === "string"
                        ? request.body.system
                        : run.identity.system;
                const tokens = row.data.tokens;
                const tokenNumber = (value: unknown): number | undefined =>
                    typeof value === "number" && Number.isFinite(value) ? value : undefined;
                const reportedInput = tokenNumber(tokens?.input);
                const reportedOutput = tokenNumber(tokens?.output);
                // A host promise may resolve at the same instant as cancellation.
                // Never publish a completion after the child has been retired.
                if (request.signal?.aborted || run.retired || Date.now() >= deadline) {
                    await interruptAndRetire(run, "prompt-aborted-or-timeout");
                    throw new Error(
                        request.signal?.aborted
                            ? "Hidden completion prompt aborted"
                            : "Hidden completion prompt timed out",
                    );
                }
                run.completion = {
                    text,
                    tokenLog: runTokenLog(tokens, run.identity.maxOutputTokens, row.data.finish),
                    ...(hiddenToolLoop(run.identity)
                        ? { messages: toolLoopMessages(attempt) }
                        : {}),
                    reasoning: text ? null : assistantReasoning(row),
                    // If either side is numeric, retain the provider's partial usage
                    // and floor omitted components to zero. With no numeric usage,
                    // use the local meter so budget accounting remains finite.
                    usage:
                        reportedInput !== undefined || reportedOutput !== undefined
                            ? {
                                  input: reportedInput ?? 0,
                                  output: reportedOutput ?? 0,
                                  cacheRead: tokenNumber(tokens?.cache?.read) ?? 0,
                                  cacheWrite: tokenNumber(tokens?.cache?.write) ?? 0,
                              }
                            : meter(system, promptText(request), text ?? ""),
                    lengthCapped: ["length", "max_tokens"].includes(row.data.finish ?? ""),
                    providerId: row.data.model?.providerID ?? requested.providerID,
                    modelId: row.data.model?.id ?? requested.modelID,
                };
                // Recorded for `keep_subagents` retention: this child now holds a settled run.
                if (!run.child.ever_settled) run.child = lifecycle.markEverSettled(run.child);
            } catch (caught) {
                const error =
                    attempt.budgetExceeded ?? attempt.stepLimit ?? attempt.refusal ?? caught;
                run.failed = true;
                if (!(error instanceof HiddenProviderError)) {
                    run.unsettledFailure = true;
                }
                if (request.signal?.aborted && !run.retired) {
                    await interruptAndRetire(run, "prompt-aborted");
                } else if (
                    error instanceof Error &&
                    error.message.includes("timed out") &&
                    !run.retired
                ) {
                    await interruptAndRetire(run, "prompt-timeout");
                } else if (
                    (error instanceof HiddenAgentStepLimit ||
                        (error instanceof HiddenProviderError && error.settled)) &&
                    !run.retired
                ) {
                    // Stop the child before the marker is released in finally: once the marker is
                    // gone, any further host step on this child (a scheduled retry, for example)
                    // has no registered request and HiddenChildHook.apply refuses it into the
                    // host's drain loop. Retiring it means the next run starts on a clean child.
                    await interruptAndRetire(
                        run,
                        error instanceof HiddenAgentStepLimit
                            ? "hidden-run-step-limit"
                            : "hidden-run-provider-error",
                    );
                }
                throw error;
            } finally {
                clearTimeout(deadlineTimer);
                if (budgetPoll) clearInterval(budgetPoll);
                request.signal?.removeEventListener("abort", onAbort);
                options.hook.releaseAttempt(marker);
            }
        },
        async collect(handle) {
            const completion = runs.get(handle)?.completion;
            if (!completion) throw new Error("Hidden completion has no settled output");
            return completion;
        },
        async close(handle, settlement) {
            if (!handle) return;
            const run = runs.get(handle);
            if (!run) return;
            try {
                // Settled provider failures are retired in attempt() before the marker is released.
                // Keep this guard for callers that close an unsuccessful run without an attempt
                // error, but never make a retired child reusable through close().
                const reusable = !run.retired && run.failed && !run.unsettledFailure;
                if (hiddenToolLoop(run.identity)) {
                    retire(
                        run,
                        settlement.promptSettled ? "tool-loop-settled" : "tool-loop-failed",
                    );
                } else if (
                    !run.completion &&
                    (run.failed || !settlement.promptSettled) &&
                    !reusable
                ) {
                    retire(run, "hidden-run-failed");
                }
            } finally {
                runs.delete(handle);
                run.releaseRole();
            }
            await lifecycle.finish(run.child, run.retired);
        },
    };
}
