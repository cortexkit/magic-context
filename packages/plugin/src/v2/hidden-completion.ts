import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
    HiddenRunHandle,
    HiddenRunIdentity,
} from "../hooks/magic-context/compartment-runner-types";
import { HiddenCompletionRefusal } from "../hooks/magic-context/compartment-runner-types";
import { estimateTokens } from "../hooks/magic-context/read-session-formatting";
import type { PromptArgs } from "../shared/model-suggestion-retry";
import { parseProviderModel, toModelEntry } from "../shared/resolve-fallbacks";
import type { Database } from "../shared/sqlite";
import {
    HIDDEN_DREAMER_AGENT,
    HIDDEN_HISTORIAN_AGENT,
    type HiddenChildAttempt,
    type HiddenChildHook,
} from "./hooks/hidden-child";
import type { StoreRow } from "./store-reader";

interface Model {
    providerID: string;
    modelID: string;
    variant?: string;
}

type HiddenChildRole = "historian" | "dreamer";

interface PersistedHiddenChild {
    id: string;
    role: HiddenChildRole;
    generation: string;
    title: string;
    model: Model;
    created_at: number;
    title_reasserted: boolean;
}

interface RetiredHiddenChild extends PersistedHiddenChild {
    retired_at: number;
    reason: string;
}

interface HiddenChildrenMeta {
    version: 1;
    active: Partial<Record<HiddenChildRole, PersistedHiddenChild>>;
    retired_children: RetiredHiddenChild[];
}

export interface HiddenChildHost {
    create(input: {
        title: string;
        agent: string;
        model: { providerID: string; id: string; variant?: string };
        location: { directory: string };
        metadata: { magic_context: "hidden-run"; role: HiddenChildRole };
    }): Promise<{ id: string }>;
    get(input: { sessionID: string }): Promise<{
        model?: { providerID: string; id: string; variant?: string };
    }>;
    switchModel(input: {
        sessionID: string;
        model: { providerID: string; id: string; variant?: string };
    }): Promise<void>;
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    wait(input: { sessionID: string }): Promise<void>;
    interrupt(input: { sessionID: string }): Promise<{ interrupted: boolean }>;
    update(input: { sessionID: string; title: string }): Promise<void>;
}

export interface HiddenChildRows {
    latestSequence(sessionID: string): number;
    latestAssistant(sessionID: string): StoreRow<"assistant"> | undefined;
}

export interface V2HiddenCompletionOptions {
    db: Database;
    projectIdentity: string;
    hook: HiddenChildHook;
    openReader: () => HiddenChildRows & { close?: () => void };
    ensureAgent?(): Promise<void>;
    generation?: string;
}

interface RunState {
    identity: HiddenRunIdentity;
    role: HiddenChildRole;
    child: PersistedHiddenChild;
    releaseRole: () => void;
    completion?: HiddenCompletion;
    failed: boolean;
    /** A failure other than a settled provider error row (dispatch error, refusal, timeout, abort). */
    unsettledFailure: boolean;
    retired: boolean;
}

const META_PREFIX = "opencode2_hidden_children:";
const POLL_INTERVAL_MS = 200;

export function hiddenChildrenMetaKey(projectIdentity: string): string {
    return `${META_PREFIX}${projectIdentity}`;
}

function emptyMeta(): HiddenChildrenMeta {
    return { version: 1, active: {}, retired_children: [] };
}

function isModel(value: unknown): value is Model {
    if (!value || typeof value !== "object") return false;
    const model = value as Partial<Model>;
    return typeof model.providerID === "string" && typeof model.modelID === "string";
}

function isRole(value: unknown): value is HiddenChildRole {
    return value === "historian" || value === "dreamer";
}

function isPersistedChild(value: unknown): value is PersistedHiddenChild {
    if (!value || typeof value !== "object") return false;
    const child = value as Partial<PersistedHiddenChild>;
    return (
        typeof child.id === "string" &&
        isRole(child.role) &&
        typeof child.generation === "string" &&
        typeof child.title === "string" &&
        isModel(child.model) &&
        typeof child.created_at === "number" &&
        typeof child.title_reasserted === "boolean"
    );
}

function parseMeta(value: string | null): HiddenChildrenMeta {
    if (value === null) return emptyMeta();
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch (error) {
        throw new Error("Invalid OpenCode 2 hidden-child metadata JSON", { cause: error });
    }
    if (!parsed || typeof parsed !== "object") {
        throw new Error("Invalid OpenCode 2 hidden-child metadata");
    }
    const candidate = parsed as Partial<HiddenChildrenMeta>;
    if (candidate.version !== 1 || !candidate.active || !candidate.retired_children) {
        throw new Error("Unsupported OpenCode 2 hidden-child metadata version");
    }
    const active: HiddenChildrenMeta["active"] = {};
    for (const role of ["historian", "dreamer"] as const) {
        const child = candidate.active[role];
        if (child !== undefined) {
            if (!isPersistedChild(child) || child.role !== role) {
                throw new Error(`Invalid OpenCode 2 ${role} child metadata`);
            }
            active[role] = child;
        }
    }
    const retired = candidate.retired_children;
    if (
        !Array.isArray(retired) ||
        retired.some(
            (child) =>
                !isPersistedChild(child) ||
                typeof (child as Partial<RetiredHiddenChild>).retired_at !== "number" ||
                typeof (child as Partial<RetiredHiddenChild>).reason !== "string",
        )
    ) {
        throw new Error("Invalid OpenCode 2 retired-child metadata");
    }
    return { version: 1, active, retired_children: retired as RetiredHiddenChild[] };
}

class HiddenChildStateStore {
    private readonly key: string;

    constructor(
        private readonly db: Database,
        projectIdentity: string,
    ) {
        this.key = hiddenChildrenMetaKey(projectIdentity);
    }

    read(): HiddenChildrenMeta {
        const row = this.db
            .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
            .get(this.key) as { value: string } | undefined;
        return parseMeta(row?.value ?? null);
    }

    mutate<T>(change: (state: HiddenChildrenMeta) => T): T {
        return this.db.transaction(() => {
            const state = this.read();
            const result = change(state);
            this.db
                .prepare(
                    `INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                )
                .run(this.key, JSON.stringify(state));
            return result;
        })();
    }

    put(child: PersistedHiddenChild): void {
        this.mutate((state) => {
            state.active[child.role] = child;
        });
    }

    updateModel(child: PersistedHiddenChild, model: Model): PersistedHiddenChild {
        return this.mutate((state) => {
            const active = state.active[child.role];
            if (!active || active.id !== child.id) return { ...child, model };
            active.model = model;
            return { ...active };
        });
    }

    markTitleReasserted(child: PersistedHiddenChild): PersistedHiddenChild {
        return this.mutate((state) => {
            const active = state.active[child.role];
            if (!active || active.id !== child.id) return { ...child, title_reasserted: true };
            active.title_reasserted = true;
            return { ...active };
        });
    }

    retire(child: PersistedHiddenChild, reason: string): void {
        this.mutate((state) => {
            const active = state.active[child.role];
            if (!active || active.id !== child.id) return;
            state.retired_children.push({
                ...active,
                retired_at: Date.now(),
                reason,
            });
            delete state.active[child.role];
        });
    }
}

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
    return identity.kind === "dreamer-task" ? "dreamer" : "historian";
}

function roleTitle(role: HiddenChildRole): string {
    return role === "historian" ? "Magic Context historian" : "Magic Context dreamer";
}

function roleAgent(role: HiddenChildRole): string {
    return role === "historian" ? HIDDEN_HISTORIAN_AGENT : HIDDEN_DREAMER_AGENT;
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
 * The provider answered with an error (quota, rate limit, refused request) and the host persisted it
 * as a settled assistant row. The child is safe to reuse: every hidden prompt replaces the child's
 * whole context in the hidden-child hook, so the error row is never sent again.
 */
function settledProviderError(row: StoreRow<"assistant"> | undefined): boolean {
    return row !== undefined && row.data.error !== undefined;
}

const PROVIDER_ERROR_PREFIX = "Hidden completion provider error: ";

function successfulReusableAssistant(row: StoreRow<"assistant"> | undefined): boolean {
    return (
        row !== undefined &&
        typeof row.data.finish === "string" &&
        row.data.error === undefined &&
        row.data.tokens !== undefined
    );
}

function assistantText(row: StoreRow<"assistant">): string | null {
    const text = (row.data.content ?? [])
        .flatMap((part) =>
            part.type === "text" && typeof part.text === "string" ? [part.text] : [],
        )
        .join("");
    return text.length > 0 ? text : null;
}

function errorText(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
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

function withReader<T>(
    openReader: () => HiddenChildRows & { close?: () => void },
    read: (reader: HiddenChildRows) => T,
): T {
    const reader = openReader();
    try {
        return read(reader);
    } finally {
        reader.close?.();
    }
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

async function awaitAssistantRow(
    openReader: () => HiddenChildRows & { close?: () => void },
    childID: string,
    afterSeq: number,
    deadline: number,
    signal?: AbortSignal,
): Promise<StoreRow<"assistant">> {
    for (;;) {
        const row = withReader(openReader, (reader) => reader.latestAssistant(childID));
        if (row && row.seq > afterSeq) {
            if (row.data.error !== undefined) {
                throw new Error(`${PROVIDER_ERROR_PREFIX}${errorText(row.data.error)}`);
            }
            if (typeof row.data.finish === "string") return row;
        }
        if (Date.now() >= deadline) {
            throw new Error("Hidden completion timed out waiting for a persisted assistant row");
        }
        await sleepUntilPoll(signal, deadline);
    }
}

export async function createV2HiddenCompletionExecutor(
    host: HiddenChildHost,
    options: V2HiddenCompletionOptions,
): Promise<HiddenCompletionExecutor> {
    const runs = new WeakMap<HiddenRunHandle, RunState>();
    const store = new HiddenChildStateStore(options.db, options.projectIdentity);
    const generation = options.generation ?? "opencode2";
    const roleTails = new Map<HiddenChildRole, Promise<void>>();

    const persisted = store.read();
    for (const child of [...Object.values(persisted.active), ...persisted.retired_children]) {
        if (child) options.hook.registerChild(child.id);
    }

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

    const resolveHead = async (identity: HiddenRunIdentity): Promise<Model> => {
        const configured = configuredHead(identity);
        if (configured) return configured;
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
        run.child = store.updateModel(run.child, requested);
    };

    const retire = (run: RunState, reason: string): void => {
        if (run.retired) return;
        store.retire(run.child, reason);
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
        capabilities: { tools: false, harness: "opencode2" },
        async open(identity) {
            const role = roleFor(identity);
            const releaseRole = await acquireRole(role);
            let openedChild: PersistedHiddenChild | undefined;
            try {
                await options.ensureAgent?.();
                const head = await resolveHead(identity);
                let active = store.read().active[role];
                if (active && active.generation !== generation) {
                    store.retire(active, "host-generation-changed");
                    active = undefined;
                }
                if (active) {
                    const activeID = active.id;
                    const latest = withReader(options.openReader, (reader) =>
                        reader.latestAssistant(activeID),
                    );
                    if (!successfulReusableAssistant(latest) && !settledProviderError(latest)) {
                        store.retire(active, "newest-assistant-not-reusable");
                        active = undefined;
                    }
                }
                if (!active) {
                    const title = roleTitle(role);
                    const created = await host.create({
                        title,
                        agent: roleAgent(role),
                        model: {
                            providerID: head.providerID,
                            id: head.modelID,
                            ...(head.variant ? { variant: head.variant } : {}),
                        },
                        location: { directory: identity.directory },
                        metadata: { magic_context: "hidden-run", role },
                    });
                    if (!created.id)
                        throw new Error("OpenCode 2 did not return a child session id");
                    active = {
                        id: created.id,
                        role,
                        generation,
                        title,
                        model: head,
                        created_at: Date.now(),
                        title_reasserted: false,
                    };
                    store.put(active);
                    options.hook.registerChild(active.id);
                }
                openedChild = active;
                const handle = { id: active.id, childSessionId: active.id };
                const run: RunState = {
                    identity,
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
                if (openedChild) store.retire(openedChild, "hidden-run-open-failed");
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

            const requested = requestModel(request, run.child.model);
            await switchChildModel(run, requested);
            const baseline = withReader(options.openReader, (reader) =>
                reader.latestSequence(run.child.id),
            );
            const marker = `mc:hidden:${crypto.randomUUID()}:${crypto.randomUUID()}`;
            const attempt: HiddenChildAttempt = {
                childSessionId: run.child.id,
                identity: run.identity,
                request,
                shaped: false,
            };
            options.hook.registerAttempt(marker, attempt);
            const deadline = Date.now() + run.identity.timeoutMs;
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
                ]);
                await Promise.race([host.wait({ sessionID: run.child.id }), aborted]);
                clearTimeout(deadlineTimer);
                const row = await Promise.race([
                    awaitAssistantRow(
                        options.openReader,
                        run.child.id,
                        baseline,
                        deadline,
                        request.signal,
                    ),
                    aborted,
                ]);
                if (!attempt.shaped) {
                    throw new HiddenCompletionRefusal(
                        "hidden_prompt_unrecognized",
                        "Host did not dispatch the hidden child context hook",
                        true,
                    );
                }
                if (!run.child.title_reasserted) {
                    await host.update({ sessionID: run.child.id, title: run.child.title });
                    run.child = store.markTitleReasserted(run.child);
                }
                const text = assistantText(row);
                const system =
                    typeof request.body.system === "string"
                        ? request.body.system
                        : run.identity.system;
                const tokens = row.data.tokens;
                run.completion = {
                    text,
                    reasoning: null,
                    usage: tokens
                        ? {
                              input: tokens.input,
                              output: tokens.output,
                              cacheRead: tokens.cache.read,
                              cacheWrite: tokens.cache.write,
                          }
                        : meter(system, promptText(request), text ?? ""),
                    lengthCapped: ["length", "max_tokens"].includes(row.data.finish ?? ""),
                    providerId: row.data.model?.providerID ?? requested.providerID,
                    modelId: row.data.model?.id ?? requested.modelID,
                };
            } catch (error) {
                run.failed = true;
                if (!(error instanceof Error && error.message.startsWith(PROVIDER_ERROR_PREFIX))) {
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
                }
                throw error;
            } finally {
                clearTimeout(deadlineTimer);
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
                // A run that failed only on settled provider errors keeps its child: retiring it would
                // create a new session per failed run (with a pool at its quota, one per historian
                // trigger, indefinitely). The caller reports promptSettled=false after any failed
                // attempt, so it cannot tell this case apart; the run's own record of every failure
                // being a persisted provider error row (the child is idle) is what decides.
                const reusable = run.failed && !run.unsettledFailure;
                if (!run.completion && (run.failed || !settlement.promptSettled) && !reusable) {
                    retire(run, "hidden-run-failed");
                }
            } finally {
                runs.delete(handle);
                run.releaseRole();
            }
        },
    };
}
