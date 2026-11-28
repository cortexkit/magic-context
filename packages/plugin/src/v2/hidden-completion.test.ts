import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { parsePluginConfig } from "../config";
import { withLiveDreamerOutputCap } from "../config/live-child-output-cap";
import { acquireLease } from "../features/magic-context/dreamer/lease";
import {
    mapMemories,
    parseMapMemoriesCompletion,
} from "../features/magic-context/dreamer/map-memories";
import { getDreamRuns } from "../features/magic-context/dreamer/storage-dream-runs";
import {
    createDreamTaskExecutor,
    inspectCurateMemoryOperations,
} from "../features/magic-context/dreamer/task-executor";
import { leaseKeyFor } from "../features/magic-context/dreamer/task-registry";
import { getMemoryVerifications, insertMemory } from "../features/magic-context/memory";
import { runMigrations } from "../features/magic-context/migrations";
import { closeDatabase, openDatabase } from "../features/magic-context/storage";
import { initializeDatabase } from "../features/magic-context/storage-db";
import { getSubagentInvocations } from "../features/magic-context/storage-subagent-invocations";
import { runValidatedHistorianPass } from "../hooks/magic-context/compartment-runner-historian";
import {
    HiddenCompletionRefusal,
    type HiddenRunIdentity,
} from "../hooks/magic-context/compartment-runner-types";
import {
    clearProducerModelObservations,
    observeProducerModelsForTest,
} from "../hooks/magic-context/producer-window-test-support";
import { hiddenModelCooldowns } from "../shared/hidden-model-cooldown";
import * as logger from "../shared/logger";
import { resolveHistorianModel } from "../shared/model-resolution";
import {
    getPromptFailureDetail,
    promptSyncWithValidatedOutputRetry,
} from "../shared/model-suggestion-retry";
import { Database } from "../shared/sqlite";
import { createTestTempDir } from "../shared/test-temp-dir";
import * as nativeChildren from "./hidden-child-native";
import {
    HIDDEN_CHILD_DEADLINE_GRACE_MS,
    HIDDEN_CHILD_MAX_AGE_MS,
    sweepHiddenChildren,
} from "./hidden-child-sweep";
import {
    createV2HiddenCompletionExecutor,
    type HiddenChildHost,
    HiddenProviderError,
    toolLoopMessages,
} from "./hidden-completion";
import { HiddenModelActivity } from "./hidden-model-activity";
import {
    __resetDisposedChildrenForTests,
    HIDDEN_CURATE_AGENT,
    HIDDEN_DREAMER_AGENT,
    HIDDEN_HISTORIAN_AGENT,
    HiddenChildHook,
    hiddenToolCallRefusal,
    registerHiddenChildAgents,
} from "./hooks/hidden-child";
import type { SessionContext } from "./hooks/types";
import type { StoreRow } from "./store-reader";

const run: HiddenRunIdentity = {
    parentSessionId: "user-session",
    agent: "historian-editor",
    kind: "historian-editor",
    system: "calibrated editor system",
    model: "mock/cheap",
    configuredModels: ["mock/cheap", "mock/fallback"],
    timeoutMs: 1200,
    title: "shared title is replaced by the carrier",
    directory: "/project",
};

const dreamerRun: HiddenRunIdentity = {
    ...run,
    agent: HIDDEN_DREAMER_AGENT,
    kind: "dreamer-task",
};

for (const identity of [run, dreamerRun]) {
    test(`${identity.kind} retries extend the durable deadline before each attempt`, async () => {
        const f = await setup();
        const started = Date.now();
        const now = spyOn(Date, "now").mockReturnValue(started);
        const timeoutMs = 2 * HIDDEN_CHILD_MAX_AGE_MS;
        const handle = await f.executor.open({ ...identity, timeoutMs });
        try {
            const record = () =>
                JSON.parse(
                    (
                        f.db
                            .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
                            .get(`hidden_child:${handle.id}`) as { value: string }
                    ).value,
                );
            expect(record().deadline_at).toBe(started + timeoutMs);
            await f.executor.attempt(handle, request());
            now.mockReturnValue(started + timeoutMs);
            await f.executor.attempt(handle, request());
            expect(record().deadline_at).toBe(started + 2 * timeoutMs);
            const removed: string[] = [];
            // No live-process guard: another process only has the durable deadline.
            await sweepHiddenChildren(
                f.db,
                async ({ sessionID }) => {
                    removed.push(sessionID);
                },
                () => {},
                {
                    now: started + timeoutMs + HIDDEN_CHILD_DEADLINE_GRACE_MS + 1,
                },
            );
            expect(removed).toEqual([]);
        } finally {
            now.mockRestore();
            await close(f.executor, handle, true);
            f.db.close();
        }
    });
}

test("a failed deadline extension is logged without refusing the attempt", async () => {
    const logs: string[] = [];
    const f = await setup("deadline-write-failure", { logs });
    const handle = await f.executor.open(run);
    try {
        f.db.exec(
            "CREATE TRIGGER reject_deadline BEFORE UPDATE ON schema_migrations_meta BEGIN SELECT RAISE(FAIL, 'store unavailable'); END",
        );
        await f.executor.attempt(handle, request());
        expect((await f.executor.collect(handle, 50)).text).toBe("editor completion");
        expect(
            logs.some((line) => line.includes("deadline update deferred: store unavailable")),
        ).toBe(true);
    } finally {
        await close(f.executor, handle, true);
        f.db.close();
    }
});

test("host unknown terminal error retains the hook's typed local refusal", async () => {
    const f = await setup();
    const handle = await f.executor.open(dreamerRun);
    f.setReadableSessionError({ type: "unknown", message: "host serialized hook failure" });
    f.host.prompt = async (input) => {
        try {
            f.hook.apply({
                sessionID: input.sessionID,
                model: { providerID: "mock", id: "cheap" },
                agent: "dreamer",
                system: [],
                tools: {},
                options: {},
                messages: [
                    {
                        role: "user",
                        // No text part equals the run's registered prompt
                        // (`input.text`): an instruction appended to it makes the
                        // part foreign, so the hook refuses.
                        content: [
                            { type: "text", text: "extra instruction before marker" },
                            { type: "text", text: `${input.text} extra instruction after marker` },
                        ],
                    },
                ],
            });
        } catch {
            f.rows.appendIdle(input.sessionID, "failed");
        }
    };
    let caught: unknown;
    try {
        await promptSyncWithValidatedOutputRetry(undefined, request(), {
            transport: (args) => f.executor.attempt(handle, args),
            fetchOutput: async () => "unreachable",
            validateOutput: (value) => value,
        });
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(HiddenCompletionRefusal);
    expect((caught as HiddenCompletionRefusal).code).toBe("hidden_prompt_unrecognized");
    expect((caught as Error).message).toContain("Refusing an unregistered prompt");
    expect(getPromptFailureDetail(caught)?.failureClass).toBe("local_refusal");
    await f.executor.close(handle, {
        promptSettled: false,
        privacySensitive: false,
        context: "test",
        log() {},
    });
    f.db.close();
});

const request = (
    modelID = "cheap",
    extra: Record<string, unknown> = {},
): {
    path: { id: string };
    body: Record<string, unknown> & {
        model: { providerID: string; modelID: string };
        parts: Array<{ type: string; text: string; synthetic: boolean }>;
    };
} => ({
    path: { id: "child" },
    body: {
        model: { providerID: "mock", modelID },
        parts: [{ type: "text", text: "calibrated chunk", synthetic: true }],
        ...extra,
    },
});

class Rows {
    private readonly rows = new Map<string, StoreRow<"assistant">[]>();
    private readonly idle = new Map<string, StoreRow<"idle">[]>();
    private readonly synthetic: StoreRow<"synthetic">[] = [];
    private seq = 0;
    latestAssistantCalls = 0;
    latestIdleCalls = 0;

    latestSequence(sessionID: string): number {
        return Math.max(
            this.rows.get(sessionID)?.at(-1)?.seq ?? -1,
            this.idle.get(sessionID)?.at(-1)?.seq ?? -1,
        );
    }

    assistantSince(sessionID: string, afterSeq: number): StoreRow<"assistant">[] {
        return (this.rows.get(sessionID) ?? []).filter((row) => row.seq > afterSeq);
    }

    range(sessionID: string, afterSeq: number, throughSeq: number): StoreRow[] {
        return [...this.assistantSince(sessionID, afterSeq), ...this.synthetic]
            .filter(
                (row) =>
                    row.session_id === sessionID && row.seq > afterSeq && row.seq <= throughSeq,
            )
            .sort((left, right) => left.seq - right.seq);
    }

    appendSynthetic(sessionID: string, text: string) {
        this.synthetic.push({
            id: `message-${++this.seq}`,
            session_id: sessionID,
            type: "synthetic",
            seq: this.seq,
            data: { text, time: { created: Date.now() } },
        });
    }

    latestAssistant(sessionID: string): StoreRow<"assistant"> | undefined {
        this.latestAssistantCalls += 1;
        return this.rows.get(sessionID)?.at(-1);
    }

    latestIdle(sessionID: string): StoreRow<"idle"> | undefined {
        this.latestIdleCalls += 1;
        return this.idle.get(sessionID)?.at(-1);
    }

    appendIdle(
        sessionID: string,
        outcome: "succeeded" | "failed" | "interrupted",
        error?: unknown,
    ) {
        const row: StoreRow<"idle"> = {
            id: `message-${++this.seq}`,
            session_id: sessionID,
            type: "idle",
            seq: this.seq,
            data: {
                outcome,
                time: { created: Date.now() },
                ...(error === undefined ? {} : { error }),
            },
        };
        const current = this.idle.get(sessionID) ?? [];
        current.push(row);
        this.idle.set(sessionID, current);
        return row;
    }

    append(
        sessionID: string,
        text: string,
        options: {
            modelID?: string;
            usage?: boolean;
            cache?: boolean;
            rawTokens?: boolean;
            error?: unknown;
            finish?: string;
            outcome?: "succeeded" | "failed" | "interrupted";
            omitFinish?: boolean;
        } = {},
    ): StoreRow<"assistant"> {
        const row: StoreRow<"assistant"> = {
            id: `message-${++this.seq}`,
            session_id: sessionID,
            type: "assistant",
            seq: this.seq,
            data: {
                content: [{ type: "text", text }],
                ...(options.omitFinish ? {} : { finish: options.finish ?? "stop" }),
                ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
                ...(options.error === undefined ? {} : { error: options.error }),
                model: { providerID: "mock", id: options.modelID ?? "cheap" },
                ...(options.usage === false
                    ? {}
                    : {
                          // Deliberately exercise corrupt and older rows with incomplete token data.
                          tokens: (options.rawTokens
                              ? { input: null, output: "not-a-number", reasoning: 3 }
                              : {
                                    input: 101,
                                    output: 11,
                                    reasoning: 3,
                                    ...(options.cache === false
                                        ? {}
                                        : { cache: { read: 7, write: 5 } }),
                                }) as StoreRow<"assistant">["data"]["tokens"],
                      }),
                time: { created: Date.now(), completed: Date.now() },
            },
        };
        const current = this.rows.get(sessionID) ?? [];
        current.push(row);
        this.rows.set(sessionID, current);
        return row;
    }
}

/**
 * Waits for work the executor deliberately does not make its callers wait on: session removal is
 * queued so a hidden run never blocks on host cleanup.
 */
async function eventually(check: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for queued cleanup");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

async function setup(
    generation = "host-generation-1",
    capabilities: {
        remove?: boolean;
        modelCatalog?: () => Promise<unknown>;
        historianTemperature?: () => number | undefined;
        logs?: string[];
        /**
         * Which registration, if any, the fake host would report as its own. Undefined stands for
         * a host that registered no service at all (`--standalone`, or a plain `serve`).
         */
        owner?: unknown;
        keepSubagents?: boolean;
        skipContextHook?: boolean;
        writeRows?: (rows: Rows, sessionID: string) => void;
        holdStore?: () => () => void;
        hostVersion?: string;
    } = {},
) {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const rows = new Rows();
    const activity = new HiddenModelActivity();
    const hook = new HiddenChildHook();
    const children = new Map<
        string,
        { model: { providerID: string; id: string; variant?: string } }
    >();
    const creates: Parameters<HiddenChildHost["create"]>[0][] = [];
    const switches: Parameters<HiddenChildHost["switchModel"]>[0][] = [];
    const updates: Parameters<HiddenChildHost["update"]>[0][] = [];
    const interrupts: string[] = [];
    const requests: SessionContext[] = [];
    const removed: string[] = [];
    const removals: Array<{ sessionID: string; owner?: unknown; directory?: string }> = [];
    let nextID = 0;
    let failPrompt = false;
    let promptError: Error | undefined;
    let providerError: unknown;
    let providerErrorUnsettled = false;
    let terminalOutcome: "succeeded" | "failed" | "interrupted" | undefined;
    let terminalRowType: "assistant" | "idle" = "assistant";
    let readableSessionError: unknown;
    let eventSessionError: unknown;
    let removeError: Error | undefined;
    let removeHook: HiddenChildHost["removeSession"];
    let delayRowMs = 0;
    let omitUsage = false;
    let omitCache = false;
    let rawTokens = false;
    let completion = "editor completion";
    let reasoningOnly = false;

    const host: HiddenChildHost = {
        watchModelActivity: (sessionID, onOutput) => activity.watch(sessionID, onOutput),
        async create(input) {
            creates.push(structuredClone(input));
            const id = `child-${++nextID}`;
            children.set(id, { model: structuredClone(input.model) });
            return { id };
        },
        async get() {
            return {
                model: { providerID: "mock", id: "user" },
                ...(readableSessionError === undefined ? {} : { error: readableSessionError }),
            };
        },
        async terminalError() {
            return eventSessionError;
        },
        async switchModel(input) {
            switches.push(structuredClone(input));
            children.set(input.sessionID, { model: structuredClone(input.model) });
        },
        async prompt(input) {
            const child = children.get(input.sessionID);
            if (!child) throw new Error("missing child");
            const draft: SessionContext = {
                sessionID: input.sessionID,
                model: child.model,
                agent: "historian",
                system: [{ type: "text", text: "host system" }],
                tools: { read: { description: "read", input: {} } },
                options: { hostDefault: true },
                messages: [
                    {
                        id: "history",
                        role: "assistant",
                        content: [{ type: "text", text: "private child history" }],
                    },
                    { role: "user", content: [{ type: "text", text: input.text }] },
                ],
            };
            if (!capabilities.skipContextHook) hook.apply(draft);
            requests.push(structuredClone(draft));
            if (capabilities.writeRows) {
                capabilities.writeRows(rows, input.sessionID);
                return;
            }
            if (failPrompt) throw new Error("provider unavailable");
            if (promptError) throw promptError;
            if (providerError !== undefined) {
                rows.append(input.sessionID, "", {
                    error: providerError,
                    usage: false,
                    ...(providerErrorUnsettled ? { omitFinish: true } : { finish: "error" }),
                });
                return;
            }
            if (terminalOutcome !== undefined) {
                if (terminalRowType === "idle") rows.appendIdle(input.sessionID, terminalOutcome);
                else
                    rows.append(input.sessionID, "", {
                        outcome: terminalOutcome,
                        usage: false,
                        omitFinish: true,
                    });
                return;
            }
            const write = () => {
                const row = rows.append(input.sessionID, completion, {
                    usage: !omitUsage,
                    cache: !omitCache,
                    rawTokens,
                    modelID: child.model.id,
                    ...(reasoningOnly ? { finish: "length" } : {}),
                });
                if (reasoningOnly)
                    row.data.content = [{ type: "reasoning", text: "private reasoning" }];
            };
            if (delayRowMs > 0) setTimeout(write, delayRowMs);
            else write();
        },
        async wait() {},
        async interrupt(input) {
            interrupts.push(input.sessionID);
            return { interrupted: true };
        },
        async update(input) {
            updates.push(structuredClone(input));
        },
        async removeSession(input) {
            if (removeHook) await removeHook(input);
            if (removeError) throw removeError;
            removed.push(input.sessionID);
        },
    };
    const create = (hostGeneration = generation) =>
        createV2HiddenCompletionExecutor(host, {
            db,
            projectIdentity: "/project",
            directory: "/project",
            hook,
            openReader: () => rows,
            holdStore: capabilities.holdStore,
            hostVersion: capabilities.hostVersion,
            generation: hostGeneration,
            ...(capabilities.keepSubagents ? { keepSubagents: true } : {}),
            log: (message) => capabilities.logs?.push(message),
            ...(capabilities.modelCatalog ? { modelCatalog: capabilities.modelCatalog } : {}),
            ...(capabilities.historianTemperature
                ? { historianTemperature: capabilities.historianTemperature }
                : {}),
        });
    const executor = await create();
    return {
        db,
        rows,
        activity,
        hook,
        host,
        executor,
        create,
        creates,
        switches,
        updates,
        interrupts,
        requests,
        removed,
        removals,
        setFailPrompt(value: boolean) {
            failPrompt = value;
        },
        setPromptError(value: Error | undefined) {
            promptError = value;
        },
        setProviderError(value: unknown) {
            providerError = value;
        },
        setProviderErrorUnsettled(value: boolean) {
            providerErrorUnsettled = value;
        },
        setTerminalOutcome(value: "succeeded" | "failed" | "interrupted" | undefined) {
            terminalOutcome = value;
        },
        setTerminalRowType(value: "assistant" | "idle") {
            terminalRowType = value;
        },
        setReadableSessionError(value: unknown) {
            readableSessionError = value;
        },
        setEventSessionError(value: unknown) {
            eventSessionError = value;
        },
        setRemoveError(value: Error | undefined) {
            removeError = value;
        },
        setRemoveHook(hook: HiddenChildHost["removeSession"]) {
            removeHook = hook;
        },
        setDelayRow(value: number) {
            delayRowMs = value;
        },
        setOmitUsage(value: boolean) {
            omitUsage = value;
        },
        setOmitCache(value: boolean) {
            omitCache = value;
        },
        setRawTokens(value: boolean) {
            rawTokens = value;
        },
        setCompletion(value: string) {
            completion = value;
        },
        setReasoningOnly(value: boolean) {
            reasoningOnly = value;
        },
    };
}

async function close(
    executor: Awaited<ReturnType<typeof createV2HiddenCompletionExecutor>>,
    handle: Awaited<ReturnType<typeof executor.open>>,
    settled: boolean,
): Promise<void> {
    await executor.close(handle, {
        promptSettled: settled,
        privacySensitive: false,
        context: "historian",
        log() {},
    });
}

afterEach(() => {
    jest.useRealTimers();
    // The stub hands out the same child IDs in independent fixtures.
    __resetDisposedChildrenForTests();
});

describe("OpenCode 2 hidden child completion", () => {
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

    for (const clock of ["work", "shared"] as const) {
        for (const remaining of [59, 60]) {
            test(`${clock} clock sliver: ${remaining} ms of 1200 ${remaining === 60 ? "dispatches" : "refuses"}`, async () => {
                const f = await setup();
                jest.useFakeTimers({ doNotFake: ["setImmediate"] });
                const handle = await f.executor.open({
                    ...run,
                    timeoutMs: clock === "work" ? 1_200 : 4_000,
                });
                const switching = Promise.withResolvers<void>();
                const switched = Promise.withResolvers<void>();
                f.host.switchModel = () => {
                    switching.resolve();
                    return switched.promise;
                };
                const outcome = promptSyncWithValidatedOutputRetry(undefined, request("fallback"), {
                    transport: (args) => f.executor.attempt(handle, args),
                    timeoutMs: clock === "work" ? 4_000 : 1_200,
                    fetchOutput: () => f.executor.collect(handle),
                    validateOutput: (completion) => completion.text,
                }).catch((error: unknown) => error);
                try {
                    await switching.promise;
                    jest.advanceTimersByTime(1_200 - remaining);
                    switched.resolve();
                    const result = await outcome;
                    if (remaining === 60) {
                        expect(result).toMatchObject({ validated: "editor completion" });
                        expect(f.requests).toHaveLength(1);
                    } else {
                        expect(result).toMatchObject({
                            code: "hidden_setup_timeout",
                            message: expect.stringContaining("preparing to send the prompt"),
                        });
                        expect(f.requests).toHaveLength(0);
                    }
                } finally {
                    switched.resolve();
                    await close(f.executor, handle, remaining === 60);
                    await flush();
                    f.db.close();
                }
            });
        }
    }

    for (const stage of ["setup", "post-dispatch", "unshaped"] as const) {
        test(`historian retry loop: ${stage === "unshaped" ? "an unshaped child with a transient directory name retains the legacy retry" : `a ${stage} timeout is attempted once`}`, async () => {
            const { dir: dataHome, cleanup } = createTestTempDir("v2-historian-timeout-");
            const previous = process.env.XDG_DATA_HOME;
            process.env.XDG_DATA_HOME = dataHome;
            let catalogCalls = 0;
            const f = await setup(undefined, {
                historianTemperature: () => 0.3,
                skipContextHook: stage === "unshaped",
                modelCatalog: () => {
                    catalogCalls++;
                    return stage === "setup" ? new Promise(() => {}) : Promise.resolve([]);
                },
            });
            if (stage === "post-dispatch") f.host.wait = () => new Promise(() => {});
            try {
                if (!openDatabase()) throw new Error("invocation test database did not open");
                jest.useFakeTimers({ doNotFake: ["setImmediate"] });
                const timeoutMs = 150;
                let result: Awaited<ReturnType<typeof runValidatedHistorianPass>> | undefined;
                const outcome = runValidatedHistorianPass({
                    client: undefined,
                    hiddenCompletionExecutor: f.executor,
                    db: f.db,
                    parentSessionId: `historian-timeout-${stage}`,
                    sessionDirectory: stage === "unshaped" ? "/project/timeout" : "/project",
                    prompt: "Summarize history",
                    chunk: { startIndex: 1, endIndex: 1, lines: [{ ordinal: 1, messageId: "m1" }] },
                    priorCompartments: [],
                    sequenceOffset: 0,
                    dumpLabelBase: `historian-timeout-${stage}`,
                    model: { model: "mock/cheap", sourceConfigKey: "historian.opencode.model" },
                    timeoutMs,
                });
                void outcome.then((value) => {
                    result = value;
                });
                await flush();
                expect(catalogCalls).toBe(1);
                // Advance through any retries and their backoffs, without waiting in real time.
                for (let attempt = 0; attempt < 3 && !result; attempt++) {
                    jest.advanceTimersByTime(timeoutMs);
                    await flush();
                    if (!result) {
                        jest.advanceTimersByTime(10_000);
                        await flush();
                    }
                }
                expect(result).toMatchObject({
                    ok: false,
                    error: expect.stringContaining(
                        stage === "setup"
                            ? "hidden_setup_timeout"
                            : stage === "post-dispatch"
                              ? "prompt timed out after 150ms"
                              : "directory=/project/timeout",
                    ),
                });
                expect(catalogCalls).toBe(stage === "unshaped" ? 3 : 1);
                expect(f.requests).toHaveLength(
                    stage === "unshaped" ? 3 : stage === "setup" ? 0 : 1,
                );
            } finally {
                f.db.close();
                closeDatabase();
                if (previous === undefined) delete process.env.XDG_DATA_HOME;
                else process.env.XDG_DATA_HOME = previous;
                cleanup();
            }
        });
    }

    test("time spent queued for a role leaves the first attempt its full work budget", async () => {
        const f = await setup();
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const first = await f.executor.open(run);
        const queued = f.executor.open(run);
        await flush();
        jest.advanceTimersByTime(run.timeoutMs - 5);
        expect(f.creates).toHaveLength(1);
        await close(f.executor, first, true);
        const next = await queued;
        f.host.wait = () => new Promise(() => {});
        let failure: unknown;
        const result = f.executor.attempt(next, request());
        void result.catch((error) => {
            failure = error;
        });
        try {
            await flush();
            expect(f.requests.map(({ sessionID }) => sessionID)).toEqual([next.id]);
            jest.advanceTimersByTime(run.timeoutMs - 1);
            await flush();
            expect(failure).toBeUndefined();
            jest.advanceTimersByTime(1);
            await expect(result).rejects.toThrow(`prompt timed out after ${run.timeoutMs}ms`);
            expect(f.interrupts).toEqual([next.id]);
        } finally {
            await close(f.executor, next, false);
            await flush();
            f.db.close();
        }
    });

    test("bounds waiting for the role without starting a child", async () => {
        const f = await setup();
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const first = await f.executor.open(run);
        const other = f.executor.open(run);
        let failure: unknown;
        void other.catch((error) => {
            failure = error;
        });
        try {
            jest.advanceTimersByTime(run.timeoutMs - 1);
            await flush();
            expect(failure).toBeUndefined();
            jest.advanceTimersByTime(1);
            await flush();
            expect(failure).toMatchObject({ code: "hidden_setup_timeout", terminal: true });
            expect(String(failure)).toContain("waiting for its role");
            expect(f.creates).toHaveLength(1);
        } finally {
            await close(f.executor, first, true);
            const handle = await other.catch(() => undefined);
            if (handle) await close(f.executor, handle, false);
            f.db.close();
        }
    });

    test("retires without dispatching if setup leaves less than five percent of the budget", async () => {
        const f = await setup();
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const handle = await f.executor.open(run);
        f.host.switchModel = async () => {
            jest.advanceTimersByTime(run.timeoutMs - 5);
        };
        try {
            const outcome = await promptSyncWithValidatedOutputRetry(
                undefined,
                request("fallback"),
                {
                    transport: (args) => f.executor.attempt(handle, args),
                    timeoutMs: run.timeoutMs,
                    fallbackModels: ["mock/cheap"],
                    fetchOutput: () => f.executor.collect(handle),
                    validateOutput: (completion) => completion.text,
                },
            ).catch((error: unknown) => error);
            expect(outcome).toMatchObject({ code: "hidden_setup_timeout", terminal: true });
            expect(getPromptFailureDetail(outcome)?.failureClass).toBe("local_refusal");
            expect(f.requests).toEqual([]);
            expect(f.interrupts).toEqual([]);
            expect(f.removed).toEqual([handle.id]);
        } finally {
            await close(f.executor, handle, false);
            f.db.close();
        }
    });

    test("rechecks the deadline before committing a model switch that just answered", async () => {
        const make = nativeChildren.createNativeHiddenChildren;
        const updateModel = spyOn(nativeChildren, "createNativeHiddenChildren");
        let updates = 0;
        updateModel.mockImplementation((...args) => {
            const owned = make(...args);
            const update = owned.updateModel;
            owned.updateModel = (...input) => {
                updates++;
                return update(...input);
            };
            return owned;
        });
        const f = await setup();
        updateModel.mockRestore();
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const startedAt = Date.now();
        const handle = await f.executor.open(run);
        let switchAnswered = false;
        let reads = 0;
        const now = spyOn(Date, "now").mockImplementation(() =>
            // First the timer is armed, then the returned promise passes its guard.
            // The next read belongs to the continuation that would publish the model.
            switchAnswered && ++reads >= 3 ? startedAt + run.timeoutMs : startedAt,
        );
        f.host.switchModel = async () => {
            switchAnswered = true;
        };
        try {
            await expect(f.executor.attempt(handle, request("fallback"))).rejects.toThrow(
                "switching the child model",
            );
            expect(updates).toBe(0);
            expect(f.requests).toEqual([]);
            expect(f.removed).toEqual([handle.id]);
        } finally {
            now.mockRestore();
            await close(f.executor, handle, false);
            f.db.close();
        }
    });

    for (const order of [
        "executor first",
        "shared timer first on equal retry budgets",
        "shorter shared budget after a silent primary",
        "shorter shared budget leaves a sliver after a silent primary",
    ]) {
        test(`reports a stalled model switch as a local setup timeout (${order})`, async () => {
            const silentPrimary = order.startsWith("shorter shared budget");
            const sharedSliver = order.includes("leaves a sliver");
            const equalRetry = order === "shared timer first on equal retry budgets";
            const make = nativeChildren.createNativeHiddenChildren;
            const lifecycle = spyOn(
                nativeChildren,
                "createNativeHiddenChildren",
            ).mockImplementation((...args) => {
                const owned = make(...args);
                const create = owned.create;
                // Exercise a replacement whose host model still needs the switch.
                if (silentPrimary)
                    owned.create = async (...args) => ({
                        ...(await create(...args)),
                        model: { providerID: "mock", modelID: "cheap" },
                    });
                return owned;
            });
            const f = await setup();
            lifecycle.mockRestore();
            jest.useFakeTimers({ doNotFake: ["setImmediate"] });
            const handle = await f.executor.open(run);
            const spentInOpen = 100;
            if (equalRetry) await f.executor.attempt(handle, request());
            else if (!silentPrimary) jest.advanceTimersByTime(spentInOpen);
            const firstWait = Promise.withResolvers<void>();
            const switching = Promise.withResolvers<void>();
            const switchedAnswer = Promise.withResolvers<void>();
            const switched: string[] = [];
            f.host.wait = () => {
                firstWait.resolve();
                return new Promise(() => {});
            };
            f.host.switchModel = (input) => {
                switched.push(input.model.id);
                switching.resolve();
                return switchedAnswer.promise;
            };
            const silentMs = 60;
            const outcome = promptSyncWithValidatedOutputRetry(
                undefined,
                request(silentPrimary ? "cheap" : "fallback"),
                {
                    transport: (args) => f.executor.attempt(handle, args),
                    timeoutMs: run.timeoutMs,
                    ...(silentPrimary
                        ? { firstOutputTimeoutMs: silentMs, fallbackModels: ["mock/fallback"] }
                        : { fallbackModels: ["mock/cheap"] }),
                    fetchOutput: () => f.executor.collect(handle),
                    validateOutput: (completion) => completion.text,
                },
            ).catch((error: unknown) => error);
            try {
                if (silentPrimary) {
                    await firstWait.promise;
                    jest.advanceTimersByTime(silentMs);
                }
                await switching.promise;
                let result: unknown;
                void outcome.then((settled) => {
                    result = settled;
                });
                const remaining =
                    run.timeoutMs - (silentPrimary ? silentMs : equalRetry ? 0 : spentInOpen);
                jest.advanceTimersByTime(remaining - 1);
                await flush();
                expect(result).toBeUndefined();
                if (sharedSliver) {
                    // 1 ms remains on the shared retry timer, but 61 ms remain on
                    // the executor's 1,200 ms budget: only the shared limit refuses dispatch.
                    switchedAnswer.resolve();
                    await flush();
                    expect(f.requests).toHaveLength(1);
                    expect(result).toMatchObject({ code: "hidden_setup_timeout" });
                } else {
                    jest.advanceTimersByTime(1);
                }
                const error = await outcome;
                expect(error).toMatchObject({ code: "hidden_setup_timeout", terminal: true });
                expect((error as Error).message).toBe(
                    `hidden_setup_timeout: Hidden completion setup timed out while ${sharedSliver ? "preparing to send the prompt" : "switching the child model"}`,
                );
                expect(getPromptFailureDetail(error)?.failureClass).toBe("local_refusal");
                expect(switched).toEqual(["fallback"]);
                expect(f.requests).toHaveLength(equalRetry || silentPrimary ? 1 : 0);
            } finally {
                await flush();
                await close(f.executor, handle, false);
                await flush();
                f.db.close();
            }
        });
    }

    test("refuses a timed-out curate child's memory writes before the interrupt answers", async () => {
        const f = await setup();
        const identity = { ...dreamerRun, agent: HIDDEN_CURATE_AGENT };
        const interrupt = Promise.withResolvers<{ interrupted: boolean }>();
        f.host.wait = () => new Promise(() => {});
        f.host.interrupt = () => interrupt.promise;
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const first = await f.executor.open(identity);
        const result = f.executor.attempt(first, request());
        void result.catch(() => {});
        const gate = (sessionID: string) =>
            hiddenToolCallRefusal(
                { tool: "ctx_memory", sessionID, agent: HIDDEN_CURATE_AGENT },
                f.hook,
            );
        await flush();
        expect(gate(first.id)).toBeUndefined();
        jest.advanceTimersByTime(identity.timeoutMs);
        await expect(result).rejects.toThrow("timed out");
        await close(f.executor, first, false);
        expect(gate(first.id)).toContain("timed out");
        const opening = f.executor.open({ ...identity, timeoutMs: 4_000 });
        jest.advanceTimersByTime(2_000);
        const next = await opening;
        try {
            expect(gate(first.id)).toContain("ctx_memory refused");
            expect(gate(next.id)).toBeUndefined();
        } finally {
            interrupt.resolve({ interrupted: true });
            await close(f.executor, next, true);
            f.db.close();
        }
    });

    for (const source of ["shared timer", "caller abort"] as const) {
        test(`${source} after dispatch refuses tools, further steps and compaction before interrupt answers`, async () => {
            const f = await setup();
            const identity = { ...dreamerRun, agent: HIDDEN_CURATE_AGENT, timeoutMs: 4_000 };
            const interrupt = Promise.withResolvers<{ interrupted: boolean }>();
            const waiting = Promise.withResolvers<void>();
            f.host.interrupt = () => interrupt.promise;
            f.host.wait = () => {
                waiting.resolve();
                return new Promise(() => {});
            };
            let marker = "";
            const prompt = f.host.prompt;
            f.host.prompt = (input) => {
                marker = input.text;
                return prompt(input);
            };
            jest.useFakeTimers({ doNotFake: ["setImmediate"] });
            const handle = await f.executor.open(identity);
            const gate = () =>
                hiddenToolCallRefusal(
                    { tool: "ctx_memory", sessionID: handle.id, agent: HIDDEN_CURATE_AGENT },
                    f.hook,
                );
            const caller = new AbortController();
            const outcome = promptSyncWithValidatedOutputRetry(undefined, request(), {
                transport: (args) => f.executor.attempt(handle, args),
                timeoutMs: 1_200,
                signal: caller.signal,
                fetchOutput: () => f.executor.collect(handle),
                validateOutput: (completion) => completion.text,
            }).catch((error: unknown) => error);
            try {
                await waiting.promise;
                expect(f.requests).toHaveLength(1);
                expect(gate()).toBeUndefined();
                if (source === "shared timer") jest.advanceTimersByTime(1_200);
                else caller.abort();
                await flush();
                expect(gate()).toContain("ctx_memory refused");
                expect(() =>
                    f.hook.apply({
                        sessionID: handle.id,
                        model: { providerID: "mock", id: "cheap" },
                        agent: HIDDEN_CURATE_AGENT,
                        system: [],
                        tools: {},
                        options: {},
                        messages: [{ role: "user", content: [{ type: "text", text: marker }] }],
                    }),
                ).toThrow("cancelled or timed out");
                expect(() => f.hook.compactionSummary(handle.id, HIDDEN_CURATE_AGENT)).toThrow(
                    "cancelled or timed out",
                );
                expect(String(await outcome)).toContain(
                    source === "shared timer"
                        ? "prompt timed out after 1200ms"
                        : "prompt aborted by external signal",
                );
            } finally {
                interrupt.resolve({ interrupted: true });
                await outcome;
                await close(f.executor, handle, false);
                await flush();
                f.db.close();
            }
        });
    }

    for (const hostTimer of [true, false]) {
        test(`${hostTimer ? "a host request timer" : "a non-timeout error mentioning timed out"} after dispatch ${hostTimer ? "marks" : "does not mark"} the child`, async () => {
            const f = await setup();
            const identity = { ...dreamerRun, agent: HIDDEN_CURATE_AGENT };
            const interrupt = Promise.withResolvers<{ interrupted: boolean }>();
            const interrupting = Promise.withResolvers<string>();
            f.host.interrupt = ({ sessionID }) => {
                interrupting.resolve(sessionID);
                return interrupt.promise;
            };
            f.host.wait = async () => {
                throw hostTimer
                    ? Object.assign(new Error("The operation timed out."), { name: "TimeoutError" })
                    : new Error("Provider unavailable: its last health check timed out.");
            };
            jest.useFakeTimers({ doNotFake: ["setImmediate"] });
            const handle = await f.executor.open(identity);
            const outcome = promptSyncWithValidatedOutputRetry(undefined, request(), {
                transport: (args) => f.executor.attempt(handle, args),
                timeoutMs: identity.timeoutMs,
                fetchOutput: () => f.executor.collect(handle),
                validateOutput: (completion) => completion.text,
            }).catch((error: unknown) => error);
            try {
                await flush();
                expect(f.requests).toHaveLength(1);
                expect(await interrupting.promise).toBe(handle.id);
                const gate = hiddenToolCallRefusal(
                    { tool: "ctx_memory", sessionID: handle.id, agent: HIDDEN_CURATE_AGENT },
                    f.hook,
                );
                interrupt.resolve({ interrupted: true });
                expect(getPromptFailureDetail(await outcome)?.failureClass).toBe(
                    hostTimer ? "provider_timeout" : "provider_error",
                );
                if (hostTimer) expect(gate).toContain("ctx_memory refused");
                else expect(gate).toBeUndefined();
            } finally {
                interrupt.resolve({ interrupted: true });
                await outcome;
                await close(f.executor, handle, false);
                await flush();
                f.db.close();
            }
        });
    }

    test("a retry on the same handle waits for the prior child to retire before sending", async () => {
        const f = await setup();
        const interrupt = Promise.withResolvers<{ interrupted: boolean }>();
        const wait = f.host.wait;
        f.host.wait = () => new Promise(() => {});
        f.host.interrupt = () => interrupt.promise;
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const handle = await f.executor.open(run);
        const first = f.executor.attempt(handle, request());
        void first.catch(() => {});
        await flush();
        jest.advanceTimersByTime(run.timeoutMs);
        await expect(first).rejects.toThrow("timed out");
        f.host.wait = wait;
        const retry = f.executor.attempt(handle, request("fallback"));
        void retry.catch(() => {});
        try {
            await flush();
            expect(f.requests.map((draft) => draft.sessionID)).toEqual(["child-1"]);
            expect(f.creates).toHaveLength(1);
            interrupt.resolve({ interrupted: true });
            await retry;
            expect(f.requests.map((draft) => draft.sessionID)).toEqual(["child-1", "child-2"]);
        } finally {
            interrupt.resolve({ interrupted: true });
            await retry.catch(() => {});
            await close(f.executor, handle, true);
            f.db.close();
        }
    });

    test("an assistant poll that wakes after the deadline does not read the store again", async () => {
        const f = await setup();
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const startedAt = Date.now();
        const handle = await f.executor.open(run);
        // The host accepted the marker but has not persisted any assistant output.
        f.setDelayRow(run.timeoutMs + 100);
        const latest = f.rows.latestAssistant.bind(f.rows);
        let lateReads = 0;
        f.rows.latestAssistant = (id) => {
            if (Date.now() >= startedAt + run.timeoutMs) {
                lateReads++;
                throw new Error("late store read");
            }
            return latest(id);
        };
        const result = f.executor.attempt(handle, request());
        void result.catch(() => {});
        try {
            await flush();
            expect(f.rows.latestAssistantCalls).toBeGreaterThan(0);
            jest.advanceTimersByTime(run.timeoutMs);
            await expect(result).rejects.toThrow("timed out");
            await flush();
            expect(lateReads).toBe(0);
        } finally {
            await close(f.executor, handle, false);
            f.db.close();
        }
    });

    test("releases a role acquired after its timer fired even when the wall clock stepped back", async () => {
        const f = await setup();
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const first = await f.executor.open(run);
        const startedAt = Date.now();
        const expiring = f.executor.open(run);
        void expiring.catch(() => {});
        await flush();
        jest.advanceTimersByTime(run.timeoutMs);
        await expect(expiring).rejects.toThrow("timed out");
        const now = spyOn(Date, "now").mockReturnValue(startedAt + run.timeoutMs - 1);
        try {
            await close(f.executor, first, true);
            await flush();
        } finally {
            now.mockRestore();
        }
        const next = f.executor.open({ ...run, timeoutMs: 50 });
        let outcome: unknown;
        void next.then(
            (handle) => {
                outcome = handle;
            },
            (error) => {
                outcome = error;
            },
        );
        try {
            await flush();
            jest.advanceTimersByTime(50);
            await flush();
            expect(outcome).toMatchObject({ id: "child-2" });
            expect(f.creates).toHaveLength(2);
        } finally {
            const handle = await next.catch(() => undefined);
            if (handle) await close(f.executor, handle, true);
            f.db.close();
        }
    });

    test("removes a child returned after its timer fired even when the wall clock stepped back", async () => {
        const f = await setup();
        const answer = Promise.withResolvers<void>();
        const creating = Promise.withResolvers<void>();
        const create = f.host.create;
        f.host.create = async (input) => {
            creating.resolve();
            await answer.promise;
            return create(input);
        };
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const startedAt = Date.now();
        const opening = f.executor.open(run);
        void opening.catch(() => {});
        await creating.promise;
        jest.advanceTimersByTime(run.timeoutMs);
        await expect(opening).rejects.toThrow("timed out");
        const now = spyOn(Date, "now").mockReturnValue(startedAt + run.timeoutMs - 1);
        try {
            answer.resolve();
            await flush();
            expect(f.removed).toEqual(["child-1"]);
            expect(f.hook.owns("child-1")).toBe(false);
        } finally {
            now.mockRestore();
            f.db.close();
        }
    });

    for (const [method, label] of [
        ["open", "initial"],
        ["create", "replacement"],
    ] as const) {
        test(`retires an admitted ${label} child whose lifecycle answer reaches the executor late`, async () => {
            const logs: string[] = [];
            const childReady = Promise.withResolvers<string>();
            const deliver = Promise.withResolvers<void>();
            const make = nativeChildren.createNativeHiddenChildren;
            const lifecycle = spyOn(
                nativeChildren,
                "createNativeHiddenChildren",
            ).mockImplementation((...args) => {
                const owned = make(...args);
                const create = owned[method];
                owned[method] = async (...args) => {
                    const child = await create(...args);
                    childReady.resolve(child.id);
                    await deliver.promise;
                    return child;
                };
                return owned;
            });
            const f = await setup(undefined, { logs });
            lifecycle.mockRestore();
            jest.useFakeTimers({ doNotFake: ["setImmediate"] });
            const prior = method === "create" ? await f.executor.open(run) : undefined;
            if (prior) {
                f.setProviderError({ type: "provider.error", message: "primary refused" });
                await expect(f.executor.attempt(prior, request())).rejects.toBeInstanceOf(
                    HiddenProviderError,
                );
            }
            const stalled = prior
                ? f.executor.attempt(prior, request("fallback"))
                : f.executor.open(run);
            void stalled.catch(() => {});
            const id = await childReady.promise;
            const removing = Promise.withResolvers<{ sessionID: string }>();
            f.setRemoveHook(async (input) => {
                if (input.sessionID === id) {
                    removing.resolve(input);
                    await new Promise(() => {});
                }
            });
            try {
                jest.advanceTimersByTime(run.timeoutMs);
                await expect(stalled).rejects.toThrow("creating the child session");
                expect(nativeChildren.isLiveHiddenChild(id)).toBe(true);
                let removalID: string | undefined;
                void removing.promise.then(({ sessionID }) => {
                    removalID = sessionID;
                });
                deliver.resolve();
                await flush();
                expect(removalID).toBe(id);
                expect(nativeChildren.isLiveHiddenChild(id)).toBe(false);
                expect(f.requests.some((draft) => draft.sessionID === id)).toBe(false);
                const note = `[magic-context] late hidden child ${id} could not be removed`;
                jest.advanceTimersByTime(1_999);
                await flush();
                expect(logs).not.toContain(note);
                jest.advanceTimersByTime(1);
                await flush();
                expect(logs.filter((line) => line === note)).toEqual([note]);
            } finally {
                deliver.resolve();
                if (prior) await close(f.executor, prior, false);
                f.db.close();
            }
        });
    }

    test("retains a retiring late child in the store until the sweep confirms removal", async () => {
        const logs: string[] = [];
        const f = await setup(undefined, { logs });
        const creating = Promise.withResolvers<void>();
        const answer = Promise.withResolvers<void>();
        const create = f.host.create;
        f.host.create = async (input) => {
            creating.resolve();
            await answer.promise;
            return create(input);
        };
        const record = () => {
            const row = f.db
                .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
                .get("hidden_child:child-1") as { value: string } | undefined;
            return row ? JSON.parse(row.value) : null;
        };
        let recordAtRemove: unknown;
        f.setRemoveHook(async () => {
            recordAtRemove = record();
            throw new Error("host refused a private path and error body");
        });
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const opening = f.executor.open(run);
        void opening.catch(() => {});
        try {
            await creating.promise;
            jest.advanceTimersByTime(run.timeoutMs);
            await expect(opening).rejects.toThrow("creating the child session");
            answer.resolve();
            await flush();
            expect(recordAtRemove).toMatchObject({ id: "child-1", retiring: true });
            expect(record()).toEqual(recordAtRemove);
            expect(nativeChildren.isLiveHiddenChild("child-1")).toBe(false);
            expect(f.hook.owns("child-1")).toBe(false);
            expect(logs.filter((line) => line.includes("late hidden child"))).toEqual([
                "[magic-context] late hidden child child-1 could not be removed",
            ]);
            const removed: string[] = [];
            await sweepHiddenChildren(
                f.db,
                async ({ sessionID }) => {
                    removed.push(sessionID);
                },
                () => {},
                {
                    now: Date.now() + HIDDEN_CHILD_MAX_AGE_MS + 1,
                    isLive: nativeChildren.isLiveHiddenChild,
                },
            );
            expect(removed).toEqual(["child-1"]);
            expect(record()).toBeNull();
        } finally {
            answer.resolve();
            f.db.close();
        }
    });

    for (const removal of ["removed", "not found", "record write failed"] as const) {
        test(`late child retirement: ${removal}`, async () => {
            const logs: string[] = [];
            const f = await setup(undefined, { logs });
            const creating = Promise.withResolvers<void>();
            const answer = Promise.withResolvers<void>();
            const create = f.host.create;
            f.host.create = async (input) => {
                creating.resolve();
                await answer.promise;
                return create(input);
            };
            const records = () => f.db.prepare("SELECT key FROM schema_migrations_meta").all();
            const reported: unknown[][] = [];
            f.setRemoveHook(async () => {
                reported.push(records());
                if (removal === "not found") {
                    throw Object.assign(new Error("session not found"), { status: 404 });
                }
                if (removal === "record write failed") throw new Error("private host error");
            });
            if (removal === "record write failed") {
                f.db.exec(
                    "CREATE TRIGGER reject_record BEFORE INSERT ON schema_migrations_meta BEGIN SELECT RAISE(FAIL, 'private store error'); END",
                );
            }
            jest.useFakeTimers({ doNotFake: ["setImmediate"] });
            const opening = f.executor.open(run);
            void opening.catch(() => {});
            try {
                await creating.promise;
                jest.advanceTimersByTime(run.timeoutMs);
                await expect(opening).rejects.toThrow("creating the child session");
                answer.resolve();
                await flush();
                expect(reported).toEqual([
                    removal === "record write failed" ? [] : [{ key: "hidden_child:child-1" }],
                ]);
                expect(records()).toEqual([]);
                expect(logs.filter((line) => line.includes("late hidden child"))).toEqual(
                    removal === "record write failed"
                        ? [
                              "[magic-context] late hidden child child-1 record failed (Error)",
                              "[magic-context] late hidden child child-1 could not be removed",
                          ]
                        : [],
                );
                expect(logs.join("\n")).not.toContain("private");
            } finally {
                answer.resolve();
                f.db.close();
            }
        });
    }

    test("times out a stalled child creation, releases its leases, and retires the late child", async () => {
        let holds = 0;
        const f = await setup(undefined, {
            holdStore: () => {
                holds++;
                return () => {
                    holds--;
                };
            },
        });
        const creating = Promise.withResolvers<void>();
        const answer = Promise.withResolvers<void>();
        const create = f.host.create;
        f.host.create = async (input) => {
            creating.resolve();
            await answer.promise;
            return create(input);
        };
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
        const opening = f.executor.open(dreamerRun);
        let outcome: unknown;
        void opening.then(
            (handle) => {
                outcome = handle;
            },
            (error) => {
                outcome = error;
            },
        );
        try {
            await creating.promise;
            expect(holds).toBe(1);
            jest.advanceTimersByTime(dreamerRun.timeoutMs - 1);
            await flush();
            expect(outcome).toBeUndefined();
            jest.advanceTimersByTime(1);
            await flush();
            expect(outcome).toBeInstanceOf(Error);
            await expect(opening).rejects.toThrow("timed out");
            expect(holds).toBe(0);

            f.host.create = create;
            const next = await f.executor.open(dreamerRun);
            try {
                answer.resolve();
                await flush();
                expect(f.removed).toEqual(["child-2"]);
                expect(f.requests).toEqual([]);
                await f.executor.attempt(next, request());
                expect(f.requests.map((draft) => draft.sessionID)).toEqual([next.id]);
            } finally {
                await close(f.executor, next, true);
            }
        } finally {
            answer.resolve();
            const handle = await opening.catch(() => undefined);
            if (handle) await close(f.executor, handle, false);
            f.db.close();
        }
    });

    test("a stalled interrupt does not delay rejection at the run deadline", async () => {
        let holds = 0;
        const f = await setup(undefined, {
            holdStore: () => {
                holds++;
                return () => {
                    holds--;
                };
            },
        });
        const reloading = Promise.withResolvers<void>();
        const reloaded = Promise.withResolvers<void>();
        const create = f.host.create;
        f.host.create = async (input) => {
            reloading.resolve();
            await reloaded.promise;
            return create(input);
        };
        const waiting = Promise.withResolvers<void>();
        const interrupt = Promise.withResolvers<{ interrupted: boolean }>();
        const interruptCalls: string[] = [];
        const wait = f.host.wait;
        f.host.wait = async () => {
            waiting.resolve();
            await new Promise(() => {});
        };
        f.host.interrupt = ({ sessionID }) => {
            interruptCalls.push(sessionID);
            return interrupt.promise;
        };
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
        const opening = f.executor.open(run);
        await reloading.promise;
        const setupMs = 300;
        jest.advanceTimersByTime(setupMs);
        reloaded.resolve();
        const handle = await opening;
        const result = f.executor.attempt(handle, request());
        let failure: unknown;
        void result.catch((error) => {
            failure = error;
        });
        try {
            await waiting.promise;
            jest.advanceTimersByTime(run.timeoutMs - setupMs - 1);
            await flush();
            expect(failure).toBeUndefined();
            jest.advanceTimersByTime(1);
            await flush();
            expect(interruptCalls).toEqual([handle.id]);
            expect(failure).toBeInstanceOf(Error);
            await expect(result).rejects.toThrow("timed out");
            await close(f.executor, handle, false);
            expect(holds).toBe(1);
            let replacementId: string | undefined;
            const replacing = f.executor.open({ ...run, timeoutMs: 4_000 });
            void replacing.then(
                (next) => {
                    replacementId = next.id;
                },
                () => {},
            );
            jest.advanceTimersByTime(1999);
            await flush();
            expect(replacementId).toBeUndefined();
            expect(holds).toBe(2);
            expect(f.removed).toEqual([]);
            jest.advanceTimersByTime(1);
            await flush();
            expect(replacementId).toBe("child-2");
            const next = await replacing;
            try {
                expect(holds).toBe(1);
                expect(f.removed).toEqual([handle.id]);
                interrupt.resolve({ interrupted: true });
                await flush();
                f.host.wait = wait;
                await f.executor.attempt(next, request());
                expect(f.requests.map((draft) => draft.sessionID)).toEqual([handle.id, next.id]);
                expect(f.removed).toEqual([handle.id]);
            } finally {
                await close(f.executor, next, true);
            }
            expect(holds).toBe(0);
        } finally {
            interrupt.resolve({ interrupted: true });
            if (failure === undefined) jest.advanceTimersByTime(run.timeoutMs);
            await result.catch(() => {});
            await close(f.executor, handle, false);
            f.db.close();
        }
    });

    test("keeps a late permanent holder without dispatching its child and reuses it", async () => {
        const { dir, cleanup } = createTestTempDir("v2-late-background-holder-");
        const f = await setup(undefined, { hostVersion: "2.4.2" });
        const creatingHolder = Promise.withResolvers<void>();
        const holderAnswer = Promise.withResolvers<void>();
        const holders = new Map<
            string,
            Awaited<ReturnType<NonNullable<HiddenChildHost["createHolder"]>>>
        >();
        const children: Parameters<HiddenChildHost["create"]>[0][] = [];
        f.host.createHolder = async (input) => {
            const prior = holders.get(input.id!);
            if (prior) return prior;
            const holder = { id: input.id!, location: input.location, metadata: input.metadata };
            holders.set(holder.id, holder);
            creatingHolder.resolve();
            await holderAnswer.promise;
            return holder;
        };
        f.host.create = async (input) => {
            children.push(input);
            return { id: input.id!, parentID: input.parentID, location: { directory: dir } };
        };
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
        const identity = { ...run, directory: dir };
        const opening = f.executor.open(identity);
        void opening.catch(() => {});
        try {
            await creatingHolder.promise;
            jest.advanceTimersByTime(run.timeoutMs);
            await expect(opening).rejects.toThrow("timed out");
            holderAnswer.resolve();
            await flush();
            expect(holders.size).toBe(1);
            expect(children).toEqual([]);
            const next = await f.executor.open(identity);
            try {
                expect(holders.size).toBe(1);
                expect(children).toHaveLength(1);
                expect(children[0]?.parentID).toBe(holders.keys().next().value);
            } finally {
                await close(f.executor, next, true);
            }
            expect(f.removed).toEqual([next.id]);
        } finally {
            holderAnswer.resolve();
            f.db.close();
            cleanup();
        }
    });

    for (const retryAfterMs of [undefined, 190_000_000]) {
        test(`retains structured quota delay when the host exposes it (${retryAfterMs ?? "unavailable"})`, async () => {
            const f = await setup();
            const handle = await f.executor.open(dreamerRun);
            const hostError = {
                type: "provider.rate-limit",
                status: 429,
                message: "quota exhausted",
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            };
            f.host.prompt = async ({ sessionID }) => {
                f.rows.append(sessionID, "", { error: hostError });
            };
            try {
                await expect(
                    promptSyncWithValidatedOutputRetry(undefined, request(), {
                        transport: (args) => f.executor.attempt(handle, args),
                        fetchOutput: () => f.executor.collect(handle),
                        validateOutput: (completion) => completion.text,
                    }),
                ).rejects.toThrow("quota exhausted");
                expect(
                    hiddenModelCooldowns.live().some((entry) => entry.model === "mock/cheap"),
                ).toBe(retryAfterMs !== undefined);
            } finally {
                hiddenModelCooldowns.succeeded("mock/cheap");
                await close(f.executor, handle, false);
                f.db.close();
            }
        });
    }

    test("records the dispatched model and terminal host error when no assistant row exists", async () => {
        const { dir: dataHome, cleanup } = createTestTempDir("v2-model-refusal-");
        const previous = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = dataHome;
        const state = await setup();
        try {
            const db = openDatabase();
            if (!db) throw new Error("invocation test database did not open");
            const model = "mock/missing";
            const suggestion = "mock/available";
            state.setTerminalOutcome("failed");
            state.setTerminalRowType("idle");
            state.setEventSessionError({
                type: "provider.error",
                name: "ProviderModelNotFoundError",
                data: {
                    providerID: "mock",
                    modelID: "missing",
                    message: `Model not found: ${model}. Did you mean: ${suggestion}?`,
                    suggestions: [suggestion],
                },
            });

            await runValidatedHistorianPass({
                client: undefined,
                hiddenCompletionExecutor: state.executor,
                db: state.db,
                parentSessionId: "v2-model-refusal-parent",
                sessionDirectory: "/project",
                prompt: "Summarize history",
                chunk: {
                    startIndex: 1,
                    endIndex: 1,
                    lines: [{ ordinal: 1, messageId: "m1" }],
                },
                priorCompartments: [],
                sequenceOffset: 0,
                dumpLabelBase: "v2-model-refusal",
                model: { model, sourceConfigKey: "historian.opencode.model" },
            });

            const [row] = getSubagentInvocations(db, "v2-model-refusal-parent");
            expect(row).toMatchObject({
                providerId: "mock",
                modelId: "missing",
                status: "failed",
            });
            expect(row?.error).toContain("No reply: OpenCode 2 refused the model");
            expect(row?.error).toContain(suggestion);
        } finally {
            state.db.close();
            closeDatabase();
            if (previous === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = previous;
            cleanup();
        }
    });

    for (const streaming of [false, true]) {
        test(`OpenCode 2 dreamer ${streaming ? "streamed primary keeps its full timeout" : "silent primary is cut and fallback completes with a timed_out attempt row"}`, async () => {
            const f = await setup();
            initializeDatabase(f.db);
            runMigrations(f.db);
            jest.useFakeTimers({ doNotFake: ["setImmediate"] });
            jest.setSystemTime(new Date("2026-08-11T12:00:00Z"));
            const handle = await f.executor.open({
                ...dreamerRun,
                title: "magic-context-dream-classify-memories",
            });
            const prompt = f.host.prompt;
            const sent: string[] = [];
            const primaryReady = Promise.withResolvers<void>();
            f.host.prompt = async (input) => {
                const model = f.creates.find((_, i) => `child-${i + 1}` === input.sessionID)?.model
                    .id;
                sent.push(model ?? "unknown");
                if (model !== "cheap") return prompt(input);
                f.rows.append(input.sessionID, "", { omitFinish: true, usage: false });
                f.activity.observe({
                    type: "session.execution.started",
                    data: { sessionID: input.sessionID },
                });
                // A different child's output cannot protect this attempt from its deadline.
                f.activity.observe({
                    type: "session.text.delta",
                    data: { sessionID: "foreign", delta: "x" },
                });
                if (streaming)
                    f.activity.observe({
                        type: "session.reasoning.delta",
                        data: { sessionID: input.sessionID, delta: "thinking" },
                    });
                primaryReady.resolve();
            };
            f.host.wait = async ({ sessionID }) => {
                if (sessionID === "child-1") await new Promise(() => {});
            };
            const flushAttempt = () => new Promise<void>((resolve) => setImmediate(resolve));
            const startedAt = Date.now();
            try {
                const result = promptSyncWithValidatedOutputRetry(undefined, request(), {
                    transport: (args) => f.executor.attempt(handle, args),
                    timeoutMs: 500,
                    firstOutputTimeoutMs: 60,
                    fallbackModels: ["mock/fallback"],
                    fetchOutput: () => f.executor.collect(handle),
                    validateOutput: (completion) => completion.text,
                });
                let settledAt: number | undefined;
                void result.then(
                    () => {
                        settledAt = Date.now();
                    },
                    () => {
                        settledAt = Date.now();
                    },
                );
                const deadline = streaming ? 500 : 60;
                // Keep virtual time still until the host has published its activity.
                await Promise.race([primaryReady.promise, result]);
                await flushAttempt();
                expect(sent).toEqual(["cheap"]);
                jest.advanceTimersByTime(deadline - 1);
                await flushAttempt();
                expect(sent).toEqual(["cheap"]);
                expect(settledAt).toBeUndefined();
                jest.advanceTimersByTime(1);
                await flushAttempt();
                expect(settledAt).toBe(startedAt + deadline);
                if (streaming) {
                    await expect(result).rejects.toThrow("prompt timed out after 500ms");
                    expect(sent).toEqual(["cheap"]);
                    expect(getSubagentInvocations(f.db, "user-session")).toHaveLength(0);
                } else {
                    expect((await result).validated).toBe("editor completion");
                    expect(sent).toEqual(["cheap", "fallback"]);
                    expect(f.interrupts).toContain("child-1");
                    expect(getSubagentInvocations(f.db, "user-session")).toMatchObject([
                        {
                            modelId: "cheap",
                            harness: "opencode2",
                            status: "timed_out",
                            error: expect.stringContaining(
                                "prompt timed out after 60ms with no model output",
                            ),
                        },
                    ]);
                }
            } finally {
                await close(f.executor, handle, !streaming);
                f.db.close();
            }
        });
    }
    for (const stage of ["initial", "repair", "fallback", "editor"] as const) {
        test(`OpenCode 2 historian rejects unconfigured model suggestions during ${stage}`, async () => {
            const { dir: dataHome, cleanup } = createTestTempDir("v2-historian-suggestion-");
            const previous = process.env.XDG_DATA_HOME;
            process.env.XDG_DATA_HOME = dataHome;
            const state = await setup();
            try {
                await observeProducerModelsForTest(["mock/cheap", "mock/fallback", "mock/user"]);
                const valid =
                    '<compartment start="1" end="2" title="Allowed"><p1>Summary</p1></compartment>';
                const prompt = state.host.prompt.bind(state.host);
                let calls = 0;
                state.host.prompt = async (input) => {
                    calls += 1;
                    const shouldSuggest = calls === (stage === "initial" ? 1 : 2);
                    state.setCompletion(stage === "repair" && calls === 1 ? "not XML" : valid);
                    state.setPromptError(
                        shouldSuggest
                            ? new Error(
                                  `model not found: mock/${stage === "fallback" ? "fallback" : "cheap"}. Did you mean: user?`,
                              )
                            : stage === "fallback" && calls === 1
                              ? new Error("invalid credentials for configured primary")
                              : undefined,
                    );
                    await prompt(input);
                };
                const result = await runValidatedHistorianPass({
                    client: undefined,
                    hiddenCompletionExecutor: state.executor,
                    db: state.db,
                    parentSessionId: "user-session",
                    sessionDirectory: "/project",
                    prompt: "Summarize history",
                    chunk: {
                        startIndex: 1,
                        endIndex: 2,
                        lines: [
                            { ordinal: 1, messageId: "m1" },
                            { ordinal: 2, messageId: "m2" },
                        ],
                    },
                    priorCompartments: [],
                    sequenceOffset: 0,
                    dumpLabelBase: `v2-suggestion-${stage}`,
                    model: { model: "mock/cheap", qualifier: "high" },
                    fallbackModels: stage === "fallback" ? ["mock/fallback"] : [],
                    fallbackModelId: "mock/user",
                    twoPass: stage === "editor",
                });
                expect(
                    state.requests.map(
                        (request) => `${request.model.providerID}/${request.model.id}`,
                    ),
                ).toEqual(
                    stage === "initial"
                        ? ["mock/cheap"]
                        : ["mock/cheap", stage === "fallback" ? "mock/fallback" : "mock/cheap"],
                );
                expect(state.switches.some((input) => input.model.id === "user")).toBe(false);
                expect(result.ok).toBe(stage === "editor");
                if (result.ok) expect(result.compartments[0]?.title).toBe("Allowed");
            } finally {
                state.db.close();
                closeDatabase();
                clearProducerModelObservations();
                if (previous === undefined) delete process.env.XDG_DATA_HOME;
                else process.env.XDG_DATA_HOME = previous;
                cleanup();
            }
        });
    }
    for (const scenario of ["exhausted", "success", "unconfigured"] as const) {
        test(`OpenCode 2 historian ${scenario} respects configured model ownership`, async () => {
            const { dir: dataHome, cleanup } = createTestTempDir("v2-historian-chain-");
            const previous = process.env.XDG_DATA_HOME;
            process.env.XDG_DATA_HOME = dataHome;
            const state = await setup();
            try {
                await observeProducerModelsForTest(["mock/cheap", "mock/fallback", "mock/user"]);
                const config = parsePluginConfig(
                    scenario === "unconfigured"
                        ? {}
                        : {
                              historian: {
                                  opencode: {
                                      model: "mock/cheap",
                                      fallback_models: ["mock/fallback"],
                                  },
                              },
                          },
                );
                const models = resolveHistorianModel(config, "opencode");
                if (scenario === "unconfigured") expect(models.primary).toBeUndefined();
                state.setCompletion(
                    scenario === "exhausted"
                        ? ""
                        : '<compartment start="1" end="2" title="Allowed"><p1>Summary</p1></compartment>',
                );
                const result = await runValidatedHistorianPass({
                    client: undefined,
                    hiddenCompletionExecutor: state.executor,
                    db: state.db,
                    parentSessionId: "user-session",
                    sessionDirectory: "/project",
                    prompt: "Summarize history",
                    chunk: {
                        startIndex: 1,
                        endIndex: 2,
                        lines: [
                            { ordinal: 1, messageId: "m1" },
                            { ordinal: 2, messageId: "m2" },
                        ],
                    },
                    priorCompartments: [],
                    sequenceOffset: 0,
                    dumpLabelBase: "v2-chain-policy",
                    model: models.primary,
                    fallbackModels: models.fallbacks,
                    fallbackModelId: "mock/user",
                });
                expect(
                    state.requests.map(
                        (request) => `${request.model.providerID}/${request.model.id}`,
                    ),
                ).toEqual(
                    scenario === "exhausted"
                        ? ["mock/cheap", "mock/fallback"]
                        : [scenario === "unconfigured" ? "mock/user" : "mock/cheap"],
                );
                expect(result.ok).toBe(scenario !== "exhausted");
                if (!result.ok) expect(result.error).toBeTruthy();
            } finally {
                state.db.close();
                closeDatabase();
                clearProducerModelObservations();
                if (previous === undefined) delete process.env.XDG_DATA_HOME;
                else process.env.XDG_DATA_HOME = previous;
                cleanup();
            }
        });
    }
    test("names retrospective and curate at the missed context-shaping stage without model fallback", async () => {
        for (const [task, agent] of [
            ["retrospective", "dreamer-retrospective"],
            ["curate", "dreamer"],
        ]) {
            // Simulate a host that settles a carrier turn without invoking its context hook.
            // This exercises the executor's last-resort check, not the before-provider guard.
            const state = await setup("missing-context", { skipContextHook: true });
            let handle: Awaited<ReturnType<typeof state.executor.open>> | null = null;
            try {
                handle = await state.executor.open({
                    ...dreamerRun,
                    agent,
                    title: `magic-context-dream-${task}`,
                });
                let caught: unknown;
                try {
                    await promptSyncWithValidatedOutputRetry(undefined, request(), {
                        transport: (args) => state.executor.attempt(handle!, args),
                        fallbackModels: ["mock/fallback"],
                        callContext: `dreamer:${task}`,
                        fetchOutput: () => state.executor.collect(handle!, 50),
                        validateOutput: (completion) => completion.text,
                    });
                } catch (error) {
                    caught = error;
                }
                expect(caught).toBeInstanceOf(HiddenCompletionRefusal);
                expect(caught).toMatchObject({
                    code: "hidden_prompt_unrecognized",
                    terminal: true,
                });
                expect((caught as Error).message).toContain(`task=${task}`);
                expect((caught as Error).message).toContain("stage=context/HiddenChildHook.apply");
                expect((caught as Error).message).toContain(`child=${handle.id}`);
                expect((caught as Error).message).toContain("directory=/project");
                expect(getPromptFailureDetail(caught)).toMatchObject({
                    failureClass: "local_refusal",
                    modelsTried: ["mock/cheap"],
                });
                expect(state.requests).toHaveLength(1);
                expect(state.creates).toHaveLength(1);
                expect(state.switches).toEqual([]);
            } finally {
                if (handle) await close(state.executor, handle, false);
                state.db.close();
            }
        }
    });
    test.each([
        "historian",
        "dreamer-task",
    ] as const)("retains length-capped reasoning for %s", async (kind) => {
        const state = await setup();
        try {
            state.setReasoningOnly(true);
            const handle = await state.executor.open({
                ...run,
                kind,
                agent: kind === "historian" ? "historian" : "dreamer-classifier",
            });
            await state.executor.attempt(handle, request("cheap"));
            const completion = await state.executor.collect(handle, 50);
            expect(completion).toMatchObject({
                text: null,
                reasoning: "private reasoning",
                lengthCapped: true,
                tokenLog: { max_tokens: null, finish_reason: "length", reasoning: 3 },
            });
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    const outputLimit = {
        type: "output-limit",
        message: "Response still truncated after two output token limit continuations",
    };

    function writeContinuedLengthRows(rows: Rows, sessionID: string, continuations = 2) {
        // OpenCode persists a synthetic instruction before each continuation.
        for (let call = 0; call <= continuations; call++) {
            if (call > 0) {
                rows.appendSynthetic(
                    sessionID,
                    "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.",
                );
            }
            const row = rows.append(sessionID, "", { finish: "length" });
            row.data.rawFinish = "max_output_tokens";
            row.data.content = [{ type: "reasoning", text: "budget spent reasoning" }];
            row.data.tokens = {
                input: 101,
                output: 64,
                reasoning: 0,
                cache: { read: 0, write: 0 },
            };
        }
    }

    test("collects the last assistant when OpenCode ends a hidden run at the output limit", async () => {
        const state = await setup(undefined, {
            writeRows(rows, sessionID) {
                writeContinuedLengthRows(rows, sessionID);
                rows.appendIdle(sessionID, "failed", outputLimit);
            },
        });
        const handle = await state.executor.open({ ...run, kind: "historian", agent: "historian" });
        try {
            await state.executor.attempt(handle, request());
            expect(await state.executor.collect(handle, 50)).toMatchObject({
                text: null,
                reasoning: "budget spent reasoning",
                lengthCapped: true,
                usage: { input: 101, output: 64, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
                tokenLog: { input: 101, output: 64, finish_reason: "length" },
            });
            expect(state.requests).toHaveLength(1);
        } finally {
            await close(state.executor, handle, true);
            state.db.close();
        }
    });

    test.each([
        { host: "2.4.2", continuations: 2, spent: 642 },
        { host: "2.0.22", continuations: 0, spent: 440 },
    ])("records tool-loop steps and the capped reply on OpenCode $host", async ({
        continuations,
        spent,
    }) => {
        const state = await setup(undefined, {
            writeRows(rows, sessionID) {
                for (let step = 0; step < 3; step++) {
                    const row = rows.append(sessionID, "", { finish: "tool-calls" });
                    row.data.content = [
                        {
                            type: "tool",
                            name: "read",
                            state: { status: "completed", input: { filePath: `file-${step}.ts` } },
                        },
                    ];
                }
                writeContinuedLengthRows(rows, sessionID, continuations);
                if (continuations) rows.appendIdle(sessionID, "failed", outputLimit);
                else rows.appendIdle(sessionID, "succeeded");
            },
        });
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const { dir: projectIdentity, cleanup } = createTestTempDir("mc-v2-map-capped-");
        try {
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Prefer explicit error handling.",
            });
            const holderId = "holder";
            const leaseKey = leaseKeyFor("map-memories", projectIdentity);
            expect(acquireLease(db, holderId, leaseKey)).toBe(true);
            const execute = createDreamTaskExecutor({
                hiddenCompletionExecutor: state.executor,
                parentSessionId: "parent",
                sessionDirectory: projectIdentity,
                openOpenCodeDb: () => null,
            });
            const result = await execute(
                {
                    task: "map-memories",
                    schedule: "0 5 * * *",
                    timeoutMinutes: 20,
                    tokenBudget: 1000,
                    model: "mock/cheap",
                },
                { db, projectIdentity, holderId, leaseKey },
            );
            expect(result).toMatchObject({
                status: "failed",
                error: expect.stringContaining("length-capped"),
            });
            expect(state.requests).toHaveLength(1);
            const summary = JSON.parse(getDreamRuns(db, projectIdentity)[0]!.tasks_json)[0];
            expect(summary).toMatchObject({
                name: "map-memories",
                status: "failed",
                error: expect.stringContaining("length-capped"),
                children: [{ sessionId: "child-1", promptTokens: spent }],
                tokenBudget: { budget: 1000, spent, finalizeFired: false, banked: 0 },
            });
            expect(getSubagentInvocations(db, "parent")).toMatchObject([
                {
                    task: "map-memories",
                    status: "empty",
                    error: expect.stringContaining("length-capped at 97 tokens"),
                    inputTokens: 404,
                    outputTokens: 97,
                    cacheReadTokens: 21,
                    cacheWriteTokens: 15,
                },
            ]);
        } finally {
            db.close();
            state.db.close();
            cleanup();
        }
    });

    test("rejects provider failure even after length-capped assistant rows", async () => {
        const providerError = { ...outputLimit, type: "provider.rate-limit" };
        const state = await setup(undefined, {
            writeRows(rows, sessionID) {
                writeContinuedLengthRows(rows, sessionID);
                rows.appendIdle(sessionID, "failed", providerError);
            },
        });
        state.setEventSessionError(providerError);
        const handle = await state.executor.open(run);
        try {
            const attempt = state.executor.attempt(handle, request());
            await expect(attempt).rejects.toBeInstanceOf(HiddenProviderError);
            await expect(attempt).rejects.toMatchObject({ hostError: providerError });
        } finally {
            await close(state.executor, handle, false);
            state.db.close();
        }
    });

    test("rejects interruption even after length-capped assistant rows", async () => {
        const state = await setup(undefined, {
            writeRows(rows, sessionID) {
                writeContinuedLengthRows(rows, sessionID);
                rows.appendIdle(sessionID, "interrupted", outputLimit);
            },
        });
        const handle = await state.executor.open(run);
        try {
            await expect(state.executor.attempt(handle, request())).rejects.toThrow(
                "outcome=interrupted",
            );
        } finally {
            await close(state.executor, handle, false);
            state.db.close();
        }
    });

    test("times out and interrupts a hidden run with no terminal rows", async () => {
        const state = await setup(undefined, { writeRows() {} });
        const handle = await state.executor.open({ ...run, timeoutMs: 40 });
        try {
            await expect(state.executor.attempt(handle, request())).rejects.toThrow("timed out");
            expect(state.interrupts).toEqual([handle.id]);
        } finally {
            await close(state.executor, handle, false);
            state.db.close();
        }
    });

    test("sends the exact calibrated pair with options and provider usage", async () => {
        const state = await setup("host-generation-1", {
            modelCatalog: async () => [
                { id: "cheap", providerID: "mock", capabilities: { temperature: true } },
            ],
        });
        try {
            const handle = await state.executor.open(run);
            await state.executor.attempt(handle, request("cheap", { temperature: 0.25 }));
            const completion = await state.executor.collect(handle, 50);
            expect(state.creates).toEqual([
                {
                    title: "Magic Context historian",
                    agent: "historian",
                    model: { providerID: "mock", id: "cheap" },
                    location: { directory: "/project" },
                    metadata: { magic_context: "hidden-run", role: "historian" },
                    // The historian has no tools: the session rules deny everything,
                    // and the host evaluates them after the user's own rules.
                    permissions: [{ action: "*", resource: "*", effect: "deny" }],
                },
            ]);
            expect(state.requests).toHaveLength(1);
            expect(state.requests[0]?.system).toEqual([
                { type: "text", text: "calibrated editor system" },
            ]);
            expect(state.requests[0]?.messages).toEqual([
                { role: "user", content: [{ type: "text", text: "calibrated chunk" }] },
            ]);
            expect(state.requests[0]?.tools).toEqual({});
            // This run configured no output cap, so the request carries only the
            // temperature the caller asked for — and none of the host defaults.
            expect(state.requests[0]?.options).toEqual({ temperature: 0.25 });
            expect(completion).toMatchObject({
                text: "editor completion",
                usage: { input: 101, output: 11, cacheRead: 7, cacheWrite: 5, reasoning: 3 },
                tokenLog: {
                    input: 101,
                    output: 11,
                    reasoning: 3,
                    cache_read: 7,
                    cache_write: 5,
                    max_tokens: null,
                },
                providerId: "mock",
                modelId: "cheap",
            });
            expect(state.updates).toEqual([]);
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("sends an output cap only when the run configured one", async () => {
        const state = await setup();
        try {
            const uncapped = await state.executor.open(run);
            await state.executor.attempt(uncapped, request());
            await close(state.executor, uncapped, true);

            const capped = await state.executor.open({ ...run, maxOutputTokens: 4096 });
            await state.executor.attempt(capped, request());
            await close(state.executor, capped, true);

            expect(state.requests.map((draft) => draft.options)).toEqual([
                {},
                { maxOutputTokens: 4096, maxTokens: 4096 },
            ]);
        } finally {
            state.db.close();
        }
    });

    test("creates a fresh successful child for each run without rewriting its title", async () => {
        const state = await setup();
        try {
            for (const text of ["first", "second"]) {
                state.setCompletion(text);
                const handle = await state.executor.open(run);
                await state.executor.attempt(handle, request());
                expect((await state.executor.collect(handle, 50)).text).toBe(text);
                await close(state.executor, handle, true);
            }
            expect(state.creates).toHaveLength(2);
            expect(state.requests).toHaveLength(2);
            expect(state.updates).toHaveLength(0);
        } finally {
            state.db.close();
        }
    });

    test("does not reuse a child after a settled provider error", async () => {
        const state = await setup();
        try {
            state.setProviderError({ message: "Go usage limit exceeded" });
            for (let i = 0; i < 5; i++) {
                const handle = await state.executor.open(run);
                expect(handle.id).toBe(`child-${i + 1}`);
                await expect(state.executor.attempt(handle, request("cheap"))).rejects.toThrow(
                    "Hidden completion provider error: ",
                );
                await close(state.executor, handle, false);
            }
            state.setProviderError(undefined);
            const recovered = await state.executor.open(run);
            expect(recovered.id).toBe("child-6");
            await state.executor.attempt(recovered, request());
            await close(state.executor, recovered, true);
            expect(state.creates).toHaveLength(6);
            expect(state.removed).toHaveLength(6);
        } finally {
            state.db.close();
        }
    });

    test("retires a child immediately after a settled provider failure", async () => {
        const state = await setup();
        try {
            state.setProviderError({ message: "Go usage limit exceeded" });
            const handle = await state.executor.open(run);
            await expect(state.executor.attempt(handle, request())).rejects.toThrow(
                "Hidden completion provider error: ",
            );
            await close(state.executor, handle, false);

            // After a provider failure the child is stopped and retired, so a pending host step
            // (such as a scheduled retry) cannot run on it after the run's marker is released.
            expect(state.interrupts).toEqual(["child-1"]);
            expect(state.removed).toEqual(["child-1"]);

            state.setProviderError(undefined);
            const recovered = await state.executor.open(run);
            expect(recovered.id).toBe("child-2");
            await state.executor.attempt(recovered, request());
            await close(state.executor, recovered, true);
        } finally {
            state.db.close();
        }
    });

    for (const keepSubagents of [false, true]) {
        for (const identity of [run, dreamerRun]) {
            test(`logs one retirement decision for ${identity.kind} with keep_subagents=${keepSubagents}`, async () => {
                const logs: string[] = [];
                const state = await setup("host-generation-1", { keepSubagents, logs });
                try {
                    state.setProviderError({ message: "provider unavailable" });
                    const handle = await state.executor.open(identity);
                    await expect(state.executor.attempt(handle, request())).rejects.toThrow(
                        "Hidden completion provider error: ",
                    );
                    await close(state.executor, handle, false);
                    const role = identity.kind === "dreamer-task" ? "dreamer" : "historian";
                    expect(logs.filter((line) => line.includes("hidden child child-1 "))).toEqual([
                        `[magic-context] hidden child child-1 created role=${role} keep_subagents=${keepSubagents}`,
                        ...(keepSubagents && role === "historian"
                            ? ["[magic-context] hidden child child-1 kept (keep_subagents)"]
                            : [
                                  "[magic-context] hidden child child-1 removing",
                                  "[magic-context] hidden child child-1 removed",
                              ]),
                    ]);
                } finally {
                    state.db.close();
                }
            });
        }
    }

    test("reopens a fresh child when a fallback retries a retired run", async () => {
        const state = await setup();
        try {
            state.setProviderError({ message: "Go usage limit exceeded" });
            const handle = await state.executor.open(run);
            await expect(state.executor.attempt(handle, request("cheap"))).rejects.toThrow(
                "Hidden completion provider error: ",
            );

            state.setProviderError(undefined);
            await state.executor.attempt(handle, request("fallback"));
            expect(handle.id).toBe("child-2");
            expect(state.creates[1]?.model).toEqual({ providerID: "mock", id: "fallback" });
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("interrupts and retires a failed child while its attempt marker is still registered", async () => {
        const state = await setup();
        try {
            const events: string[] = [];
            const release = state.hook.releaseAttempt.bind(state.hook);
            state.hook.releaseAttempt = (marker: string) => {
                events.push("release");
                release(marker);
            };
            const interrupt = state.host.interrupt.bind(state.host);
            state.host.interrupt = async (input) => {
                events.push(`interrupt ${input.sessionID}`);
                return interrupt(input);
            };
            state.setProviderError({ message: "Go usage limit exceeded" });
            const handle = await state.executor.open(run);
            await expect(state.executor.attempt(handle, request())).rejects.toThrow(
                "Hidden completion provider error: ",
            );
            // Until the marker is released the hook still recognises this run's prompt, so
            // stopping the child first leaves no window in which a host step on it is refused.
            expect(events).toEqual(["interrupt child-1", "release"]);
            await close(state.executor, handle, false);
        } finally {
            state.db.close();
        }
    });

    test("fails an outcome-only failed assistant in one poll with persisted host detail", async () => {
        const state = await setup();
        try {
            state.setTerminalOutcome("failed");
            state.setEventSessionError({
                type: "ProviderModelNotFoundError",
                message: "ollama-cloud/deepseek-v4.1-flash is unavailable",
            });
            const handle = await state.executor.open({ ...run, timeoutMs: 40 });
            const pollsBefore = state.rows.latestAssistantCalls;
            const failure = state.executor.attempt(handle, request());
            await expect(failure).rejects.toThrow("outcome=failed");
            await expect(failure).rejects.toThrow("ProviderModelNotFoundError");
            await expect(failure).rejects.toThrow(
                "ollama-cloud/deepseek-v4.1-flash is unavailable",
            );
            expect(state.rows.latestAssistantCalls - pollsBefore).toBe(1);
            await close(state.executor, handle, false);
        } finally {
            state.db.close();
        }
    });

    test("fails an outcome-only idle row in one poll", async () => {
        const state = await setup();
        try {
            state.setTerminalRowType("idle");
            state.setTerminalOutcome("failed");
            const handle = await state.executor.open({ ...run, timeoutMs: 40 });
            const pollsBefore = state.rows.latestIdleCalls;
            const failure = state.executor.attempt(handle, request());
            await expect(failure).rejects.toThrow("outcome=failed");
            await expect(failure).rejects.toThrow('"type":"idle"');
            expect(state.rows.latestIdleCalls - pollsBefore).toBe(1);
            await close(state.executor, handle, false);

            state.setTerminalOutcome(undefined);
            state.setTerminalRowType("assistant");
            const recovered = await state.executor.open(run);
            expect(recovered.id).toBe("child-2");
            await state.executor.attempt(recovered, request());
            await close(state.executor, recovered, true);
        } finally {
            state.db.close();
        }
    });

    test("treats every OpenCode 2.0.12 assistant outcome as terminal", async () => {
        const state = await setup();
        try {
            state.setTerminalOutcome("interrupted");
            const interrupted = await state.executor.open({ ...run, timeoutMs: 40 });
            await expect(state.executor.attempt(interrupted, request())).rejects.toThrow(
                "outcome=interrupted",
            );
            await close(state.executor, interrupted, false);

            state.setTerminalOutcome("succeeded");
            const succeeded = await state.executor.open({ ...run, timeoutMs: 40 });
            await state.executor.attempt(succeeded, request());
            expect((await state.executor.collect(succeeded, 50)).text).toBeNull();
            await close(state.executor, succeeded, true);
        } finally {
            state.db.close();
        }
    });

    test("retires a child whose newest assistant error row never settled", async () => {
        const state = await setup();
        try {
            // An error recorded on a row the host has not finished says a failure happened, not
            // that the message is over, so the child may still be mid-write and is not reusable.
            state.setProviderError({ message: "The usage limit has been reached" });
            state.setProviderErrorUnsettled(true);
            const handle = await state.executor.open(run);
            expect(handle.id).toBe("child-1");
            await expect(state.executor.attempt(handle, request())).rejects.toThrow();
            await close(state.executor, handle, false);

            state.setProviderError(undefined);
            state.setProviderErrorUnsettled(false);
            const next = await state.executor.open(run);
            expect(next.id).toBe("child-2");
            await state.executor.attempt(next, request());
            await close(state.executor, next, true);
            expect(state.removed).toEqual(["child-1", "child-2"]);
        } finally {
            state.db.close();
        }
    });

    test("retires the child when a dispatch failure only reads like a provider error", async () => {
        const state = await setup();
        try {
            // Whether the child survives is decided by the kind of failure, never by how the
            // failure happens to be worded.
            state.setPromptError(new Error("Hidden completion provider error: dispatch refused"));
            const handle = await state.executor.open(run);
            expect(handle.id).toBe("child-1");
            await expect(state.executor.attempt(handle, request())).rejects.toThrow();
            await close(state.executor, handle, false);

            state.setPromptError(undefined);
            const next = await state.executor.open(run);
            expect(next.id).toBe("child-2");
            await state.executor.attempt(next, request());
            await close(state.executor, next, true);
            expect(state.removed).toEqual(["child-1", "child-2"]);
        } finally {
            state.db.close();
        }
    });

    test("switches the same child for a retry model before re-prompting", async () => {
        const state = await setup();
        try {
            state.setFailPrompt(true);
            const handle = await state.executor.open(run);
            await expect(state.executor.attempt(handle, request("cheap"))).rejects.toThrow();
            state.setFailPrompt(false);
            await state.executor.attempt(handle, request("fallback"));
            expect((await state.executor.collect(handle, 50)).modelId).toBe("fallback");
            expect(state.creates).toHaveLength(1);
            expect(state.switches).toEqual([
                {
                    sessionID: "child-1",
                    model: { providerID: "mock", id: "fallback" },
                },
            ]);
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("does not treat an old assistant as completion when wait returns immediately", async () => {
        const state = await setup();
        try {
            const first = await state.executor.open(run);
            await state.executor.attempt(first, request());
            await close(state.executor, first, true);

            state.setCompletion("new persisted completion");
            state.setDelayRow(250);
            const second = await state.executor.open(run);
            const started = Date.now();
            await state.executor.attempt(second, request());
            expect(Date.now() - started).toBeGreaterThanOrEqual(180);
            expect((await state.executor.collect(second, 50)).text).toBe(
                "new persisted completion",
            );
            await close(state.executor, second, true);
        } finally {
            state.db.close();
        }
    });

    test("uses the local meter only when a completed row omits usage", async () => {
        const state = await setup();
        try {
            state.setOmitUsage(true);
            const handle = await state.executor.open(run);
            await state.executor.attempt(handle, request());
            const completion = await state.executor.collect(handle, 50);
            expect(completion.usage.input).toBeGreaterThan(0);
            expect(completion.usage.output).toBeGreaterThan(0);
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("falls back to the local meter when token fields are non-numeric", async () => {
        const state = await setup();
        try {
            state.setRawTokens(true);
            const handle = await state.executor.open(run);
            await state.executor.attempt(handle, request());
            const completion = await state.executor.collect(handle, 50);
            expect(completion.usage.input).toBeGreaterThan(0);
            expect(completion.usage.output).toBeGreaterThan(0);
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("preserves partial provider usage without dereferencing a missing cache", async () => {
        const state = await setup();
        try {
            state.setOmitCache(true);
            const handle = await state.executor.open(run);
            await state.executor.attempt(handle, request());
            const completion = await state.executor.collect(handle, 50);
            expect(completion.usage).toEqual({
                input: 101,
                output: 11,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: 3,
            });
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("abort interrupts and retires the child before the next open", async () => {
        const state = await setup();
        try {
            state.setDelayRow(1000);
            const handle = await state.executor.open(run);
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 20);
            await expect(
                state.executor.attempt(handle, {
                    ...request(),
                    signal: controller.signal,
                }),
            ).rejects.toThrow("aborted");
            await close(state.executor, handle, false);
            expect(state.interrupts).toEqual(["child-1"]);
            state.setDelayRow(0);
            const fresh = await state.executor.open(run);
            expect(fresh.id).toBe("child-2");
            await close(state.executor, fresh, false);
        } finally {
            state.db.close();
        }
    });

    test("registers fail-closed hidden carrier agents", async () => {
        const agents = new Map<
            string,
            {
                system?: string;
                description?: string;
                mode: "subagent" | "primary" | "all";
                hidden: boolean;
                request: {
                    settings: Record<string, unknown>;
                    headers: Record<string, string>;
                    body: Record<string, unknown>;
                };
                permissions: Array<{
                    action: string;
                    resource: string;
                    effect: "allow" | "deny" | "ask";
                }>;
            }
        >();
        await registerHiddenChildAgents({
            async transform(callback) {
                callback({
                    update(id, update) {
                        const agent = {
                            mode: "primary" as const,
                            hidden: false,
                            request: { settings: {}, headers: {}, body: {} },
                            permissions: [],
                        };
                        update(agent);
                        agents.set(id, agent);
                    },
                });
            },
        });
        expect([...agents.keys()]).toEqual([
            HIDDEN_HISTORIAN_AGENT,
            HIDDEN_DREAMER_AGENT,
            HIDDEN_CURATE_AGENT,
            "dreamer-memory-mapper",
            "dreamer-primer-investigator",
            "dreamer-retrospective",
        ]);
        for (const [id, agent] of agents) {
            expect(agent.hidden).toBe(true);
            const tools: Record<string, string[]> = {
                [HIDDEN_HISTORIAN_AGENT]: ["read"],
                [HIDDEN_DREAMER_AGENT]: ["read"],
                [HIDDEN_CURATE_AGENT]: ["ctx_memory"],
                "dreamer-memory-mapper": [
                    "read",
                    "grep",
                    "glob",
                    "aft_outline",
                    "aft_zoom",
                    "aft_search",
                ],
                "dreamer-primer-investigator": [
                    "read",
                    "grep",
                    "glob",
                    "aft_outline",
                    "aft_zoom",
                    "aft_search",
                    "ctx_search",
                ],
                "dreamer-retrospective": ["ctx_search"],
            };
            expect(agent.permissions).toEqual([
                { action: "*", resource: "*", effect: "deny" },
                ...(tools[id] ?? []).map((tool) => ({
                    action: tool,
                    resource: "*",
                    effect: "allow" as const,
                })),
            ]);
        }
    });

    test("ordinary drafts are untouched and unregistered child prompts fail closed", async () => {
        const state = await setup();
        try {
            const ordinary: SessionContext = {
                sessionID: "ordinary",
                model: { providerID: "mock", id: "user" },
                agent: "build",
                system: [],
                tools: {},
                options: {},
                messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            };
            const bytes = JSON.stringify(ordinary);
            expect(state.hook.apply(ordinary)).toBe(false);
            expect(JSON.stringify(ordinary)).toBe(bytes);

            const handle = await state.executor.open(run);
            const unregistered = { ...ordinary, sessionID: handle.id };
            expect(() => state.hook.apply(unregistered)).toThrow(HiddenCompletionRefusal);
            await close(state.executor, handle, false);
        } finally {
            state.db.close();
        }
    });

    test("drops and warns once for an undeclared hidden-run variant", async () => {
        const logs: string[] = [];
        const state = await setup("host-generation-1", {
            logs,
            modelCatalog: async () => [{ id: "cheap", providerID: "mock", variants: { high: {} } }],
        });
        const identity = { ...run, model: { model: "mock/cheap", qualifier: "medium" } };
        try {
            const handle = await state.executor.open(identity);
            expect(state.creates[0]?.model).toEqual({ providerID: "mock", id: "cheap" });
            await state.executor.attempt(handle, request("cheap"));
            await state.executor.attempt(handle, request("cheap"));
            expect(state.creates[0]?.model).toEqual({ providerID: "mock", id: "cheap" });
            expect(logs.filter((line) => line.includes("variant 'medium'")).length).toBe(1);
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("passes a declared hidden-run variant through unchanged", async () => {
        const state = await setup("host-generation-1", {
            modelCatalog: async () => [
                { id: "cheap", providerID: "mock", variants: { medium: {} } },
            ],
        });
        const identity = { ...run, model: { model: "mock/cheap", qualifier: "medium" } };
        try {
            const handle = await state.executor.open(identity);
            expect(state.creates[0]?.model).toEqual({
                providerID: "mock",
                id: "cheap",
                variant: "medium",
            });
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test.each([
        "bare array",
        "data envelope",
    ])("uses catalog variant ids from a %s at creation and model switch", async (shape) => {
        const logs: string[] = [];
        const state = await setup("array-variants", {
            logs,
            modelCatalog: async () => {
                const data = [
                    {
                        id: "cheap",
                        providerID: "mock",
                        variants: [
                            { id: "high", settings: {} },
                            { id: "medium", settings: {} },
                        ],
                    },
                ];
                return shape === "bare array" ? data : { data };
            },
        });
        try {
            const handle = await state.executor.open({
                ...dreamerRun,
                model: { model: "mock/cheap", qualifier: "high" },
            });
            expect(state.creates[0]?.model.variant).toBe("high");
            await state.executor.attempt(handle, request("cheap", { variant: "medium" }));
            expect(state.switches.at(-1)?.model.variant).toBe("medium");
            await state.executor.attempt(handle, request("cheap", { variant: "not-offered" }));
            expect(state.switches.at(-1)?.model.variant).toBeUndefined();
            expect(logs.filter((line) => line.includes("variant '"))).toEqual([
                expect.stringContaining("variant 'not-offered' not offered"),
            ]);
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });
});

test("OC2 mapper retains the persisted incremental transcript and final reply without reasoning", async () => {
    const state = await setup();
    const final = '<memory id="1" files="src/fact.ts"/>\n</mappings>';
    const prefix = '<mappings>\n<memory id="2" independent="true"/>\n';
    state.host.prompt = async ({ sessionID, text }) => {
        state.hook.apply({
            sessionID,
            agent: "dreamer-memory-mapper",
            model: { providerID: "mock", id: "cheap" },
            system: [],
            tools: {},
            options: {},
            messages: [{ role: "user", content: [{ type: "text", text }] }],
        });
        const first = state.rows.append(sessionID, prefix, { finish: "tool-calls" });
        first.data.content?.push({
            type: "reasoning",
            text: "private <mappings>reasoning</mappings>",
        });
        state.rows.append(sessionID, final);
    };
    try {
        const handle = await state.executor.open({ ...dreamerRun, agent: "dreamer-memory-mapper" });
        await state.executor.attempt(handle, request());
        const completion = await state.executor.collect(handle, 50);
        expect(completion.text).toBe(final);
        expect(completion.usage).toEqual({
            input: 202,
            output: 22,
            cacheRead: 14,
            cacheWrite: 10,
            reasoning: 6,
        });
        expect(completion.tokenLog?.reasoning).toBe(6);
        expect(completion.messages).toEqual([
            { info: { role: "assistant" }, parts: [{ type: "text", text: prefix }] },
            { info: { role: "assistant" }, parts: [{ type: "text", text: final }] },
        ]);
        expect(parseMapMemoriesCompletion(final, completion, new Set([1, 2]))).toEqual([
            { id: 2, files: [], independent: true },
            { id: 1, files: ["src/fact.ts"], independent: false },
        ]);
        await close(state.executor, handle, true);
    } finally {
        state.db.close();
    }
});

for (const failure of ["prompt timed out after 30000ms", "provider unavailable"]) {
    test(`OpenCode 2 map-memories keeps partial mappings after ${failure}`, async () => {
        const state = await setup();
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const { dir: directory, cleanup } = createTestTempDir("mc-v2-map-partial-");
        const log = spyOn(logger, "log").mockImplementation(() => {});
        try {
            const memory = insertMemory(db, {
                projectPath: directory,
                category: "ARCHITECTURE",
                content: "Prefer explicit error handling.",
            });
            expect(acquireLease(db, "holder", "mapping")).toBe(true);
            state.host.prompt = async ({ sessionID, text }) => {
                state.hook.apply({
                    sessionID,
                    agent: "dreamer-memory-mapper",
                    model: { providerID: "mock", id: "cheap" },
                    system: [],
                    tools: {},
                    options: {},
                    messages: [{ role: "user", content: [{ type: "text", text }] }],
                });
                state.rows.append(
                    sessionID,
                    `<mappings><memory id="${memory.id}" independent="true"/>`,
                    { omitFinish: true },
                );
                throw new Error(failure);
            };
            state.host.removeSession = async ({ sessionID }) => {
                state.removed.push(sessionID);
                state.rows.assistantSince = () => [];
                state.rows.latestAssistant = () => undefined;
            };
            const result = await mapMemories({
                db,
                projectIdentity: directory,
                sessionDirectory: directory,
                parentSessionId: "parent",
                holderId: "holder",
                leaseKey: "mapping",
                deadline: Date.now() + 600_000,
                model: "mock/cheap",
                hiddenCompletionExecutor: withLiveDreamerOutputCap(state.executor, {}, () => ({})),
            });
            expect(result.independent).toBe(1);
            expect(result.remaining).toBe(0);
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)?.mappingOrigin).toBe(
                "mapper",
            );
            expect(getSubagentInvocations(db, "parent")[0]).toMatchObject({
                inputTokens: 101,
                outputTokens: 11,
                cacheReadTokens: 7,
                cacheWriteTokens: 5,
            });
            expect(state.removed).toHaveLength(1);
            expect(
                log.mock.calls.some(([message]) =>
                    message.includes("map-memories batch: steps=1 committed=1"),
                ),
            ).toBe(true);
        } finally {
            log.mockRestore();
            db.close();
            state.db.close();
            cleanup();
        }
    });
}

test("hidden tool-loop charges settled usage once across polls and the final completion", async () => {
    const fixture = await setup();
    const originalPrompt = fixture.host.prompt;
    let release!: () => void;
    fixture.host.wait = () =>
        new Promise<void>((resolve) => {
            release = resolve;
        });
    fixture.host.prompt = async (input) => {
        await originalPrompt(input);
        const row = fixture.rows.latestAssistant(input.sessionID)!;
        delete row.data.finish;
        delete row.data.tokens;
    };
    const reads = spyOn(fixture.rows, "assistantSince");
    const spent: number[] = [];
    const handle = await fixture.executor.open({
        ...dreamerRun,
        agent: HIDDEN_CURATE_AGENT,
        metadata: {
            tokenBudget: 1000,
            onBudgetUpdate: (state: { spent: number }) => spent.push(state.spent),
        },
    });
    try {
        const attempt = fixture.executor.attempt(handle, request());
        await eventually(() => reads.mock.calls.length >= 2);
        expect(spent).toEqual([]);
        const row = fixture.rows.latestAssistant(handle.id)!;
        row.data.tokens = { input: 101, output: 11, cache: { read: 7, write: 5 } };
        row.data.finish = "tool-calls";
        await eventually(() => spent.length === 1);
        const readCount = reads.mock.calls.length;
        await eventually(() => reads.mock.calls.length > readCount);
        expect(spent).toEqual([113]);
        fixture.rows.append(handle.id, "done");
        release();
        await attempt;
        expect(spent).toEqual([113, 226]);
    } finally {
        reads.mockRestore();
        await close(fixture.executor, handle, true);
        fixture.db.close();
    }
});

test("hidden tool-loop accounts for a final answer that settles before the first budget poll", async () => {
    const fixture = await setup();
    const spent: number[] = [];
    const handle = await fixture.executor.open({
        ...dreamerRun,
        agent: HIDDEN_CURATE_AGENT,
        metadata: {
            tokenBudget: 1000,
            onBudgetUpdate: (state: { spent: number }) => spent.push(state.spent),
        },
    });
    try {
        await fixture.executor.attempt(handle, request());
        expect(spent).toEqual([113]);
    } finally {
        await close(fixture.executor, handle, true);
        fixture.db.close();
    }
});

test("hidden tool-loop hard-stops when an in-flight row receives final usage", async () => {
    const fixture = await setup();
    fixture.setDelayRow(1200);
    const executor = fixture.executor;
    let finalized: boolean | undefined;
    const handle = await executor.open({
        ...dreamerRun,
        agent: HIDDEN_CURATE_AGENT,
        timeoutMs: 3000,
        metadata: {
            tokenBudget: 130,
            onBudgetUpdate: (state: { finalizeFired: boolean }) => {
                finalized = state.finalizeFired;
            },
        },
    });
    const attempt = executor.attempt(handle, request());
    await eventually(() => fixture.requests.length > 0);
    // The fixture's assistant reports 101 input, 7 cache read and 5 cache write tokens.
    const row = fixture.rows.append(handle.id, "", { omitFinish: true, usage: false });
    const reads = spyOn(fixture.rows, "assistantSince");
    await eventually(() => reads.mock.calls.length >= 2);
    row.data.tokens = { input: 101, output: 11, cache: { read: 7, write: 5 } };
    row.data.finish = "tool-calls";
    await expect(attempt).rejects.toMatchObject({ name: "DreamTokenBudgetExceeded" });
    expect(fixture.interrupts).toContain(handle.id);
    expect(fixture.requests).toHaveLength(1);
    expect(finalized).toBe(false);
    reads.mockRestore();
    await executor.close(handle, {
        promptSettled: false,
        privacySensitive: true,
        context: "test",
        log: () => {},
    });
});

describe("curate validation over the OpenCode 2 tool-loop transcript", () => {
    // The wire fallback uses the shapes `v2/fold/restore.ts` builds when it restores
    // a child's transcript into provider messages. Persisted tool parts differ.
    const call = (id: string, action: string) => ({
        role: "assistant",
        content: [{ type: "tool-call", id, name: "ctx_memory", input: { action, ids: [1] } }],
    });
    const transcript = (results: unknown[]) =>
        toolLoopMessages({ observedMessages: results } as never);

    test.each([
        "completed",
        "error",
    ])("preserves a persisted %s tool result for curate validation", (status) => {
        const rows = new Rows();
        const row = rows.append("child", "");
        row.data.content = [
            {
                type: "tool",
                id: "c1",
                name: "ctx_memory",
                state: {
                    status,
                    input: { action: "archive", ids: [1] },
                    content: [{ type: "text", text: "Archived memory [ID: 1]." }],
                },
            },
        ];
        expect(inspectCurateMemoryOperations(toolLoopMessages({} as never, [row]))).toEqual({
            totalCalls: 1,
            completedActions: status === "completed" ? ["archive"] : [],
            refusals: [],
        });
    });

    test("counts a persisted safety refusal as a refused call, not an applied operation", () => {
        const rows = new Rows();
        const row = rows.append("child", "");
        row.data.content = [
            {
                type: "tool",
                id: "c1",
                name: "ctx_memory",
                state: {
                    status: "completed",
                    input: { action: "archive", ids: [1, 2] },
                    content: [
                        {
                            type: "text",
                            text: "Skipped archive for memory [ID: 1, 2]: curate safety refusal (directive-shaped-project-rule,user-profile-is-not-project-memory); refused=7.",
                        },
                    ],
                },
            },
        ];
        expect(inspectCurateMemoryOperations(toolLoopMessages({} as never, [row]))).toEqual({
            totalCalls: 1,
            completedActions: [],
            refusals: [["directive-shaped-project-rule", "user-profile-is-not-project-memory"]],
        });
    });

    test("counts an applied operation from a single text result", () => {
        const messages = transcript([
            call("c1", "archive"),
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "c1",
                        result: { type: "text", value: "Archived memory [ID: 1]." },
                    },
                ],
            },
        ]);
        expect(inspectCurateMemoryOperations(messages)).toEqual({
            totalCalls: 1,
            completedActions: ["archive"],
            refusals: [],
        });
    });

    test("counts an applied operation from a multi-part content result", () => {
        const messages = transcript([
            call("c1", "merge"),
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "c1",
                        result: {
                            type: "content",
                            value: [{ type: "text", text: "Merged memories [1, 2] into [3]." }],
                        },
                    },
                ],
            },
        ]);
        expect(inspectCurateMemoryOperations(messages).completedActions).toEqual(["merge"]);
    });

    test("never counts a failed call, even when its content reads like success", () => {
        const messages = transcript([
            call("c1", "archive"),
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "c1",
                        resultType: "error",
                        result: {
                            error: "refused",
                            content: [{ type: "text", text: "Archived memory [ID: 1]." }],
                        },
                    },
                ],
            },
            call("c2", "update"),
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "c2",
                        result: { type: "text", value: "Error: unsafe target" },
                    },
                ],
            },
        ]);
        expect(inspectCurateMemoryOperations(messages)).toEqual({
            totalCalls: 2,
            completedActions: [],
            refusals: [],
        });
        const [refused] = messages as { parts: { state: { status: string } }[] }[];
        expect(refused?.parts[0]?.state.status).toBe("error");
    });
});

describe("hidden completion temperature capabilities", () => {
    test("OpenCode 2 decides per selected model and honours zero only with positive metadata", async () => {
        const state = await setup("temperature-metadata", {
            modelCatalog: async () => ({
                data: [
                    { id: "cheap", providerID: "mock", capabilities: { temperature: true } },
                    { id: "fallback", providerID: "mock", capabilities: { temperature: false } },
                ],
            }),
        });
        try {
            const handle = await state.executor.open(run);
            await state.executor.attempt(handle, request("cheap", { temperature: 0 }));
            await state.executor.attempt(handle, request("fallback", { temperature: 0.1 }));
            await state.executor.attempt(handle, request("unknown", { temperature: 0.1 }));
            expect(state.requests.map((draft) => draft.options)).toEqual([
                { temperature: 0 },
                {},
                {},
            ]);
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("OpenCode 2 falls back to the models.dev cache when its catalog rows carry no temperature field", async () => {
        const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { __temperatureTest } = await import("../shared/subagent-temperature");
        const cacheRoot = join(tmpdir(), `mc-oc2-temperature-${crypto.randomUUID()}`);
        mkdirSync(join(cacheRoot, "opencode"), { recursive: true });
        writeFileSync(
            join(cacheRoot, "opencode", "models.json"),
            JSON.stringify({
                google: { models: { "gemini-3.8-flash": { temperature: true } } },
                openai: { models: { "gpt-6.1-sol": { temperature: false } } },
            }),
        );
        const saved = {
            XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
            OPENCODE_MODELS_PATH: process.env.OPENCODE_MODELS_PATH,
        };
        process.env.XDG_CACHE_HOME = cacheRoot;
        delete process.env.OPENCODE_MODELS_PATH;
        __temperatureTest.reset();
        const notes: string[] = [];
        // OpenCode 2.0.22 model rows: capabilities hold tools and modalities only.
        const row = (providerID: string, id: string) => ({
            id,
            providerID,
            capabilities: { tools: true, input: ["text"], output: ["text"] },
        });
        const state = await setup("temperature-catalog", {
            logs: notes,
            modelCatalog: async () => [
                row("google", "gemini-3.8-flash"),
                row("google", "antigravity-gemini-3.8-flash"),
                row("openai", "gpt-6.1-sol"),
            ],
        });
        try {
            const handle = await state.executor.open(run);
            for (const [providerID, modelID] of [
                ["google", "gemini-3.8-flash"],
                ["google", "antigravity-gemini-3.8-flash"],
                ["openai", "gpt-6.1-sol"],
            ] as const) {
                await state.executor.attempt(
                    handle,
                    request(modelID, { model: { providerID, modelID }, temperature: 0.1 }),
                );
            }
            expect(state.requests.map((draft) => draft.options)).toEqual([
                { temperature: 0.1 },
                { temperature: 0.1 },
                {},
            ]);
            expect(notes.filter((line) => line.includes("Subagent temperature"))).toEqual([
                expect.stringContaining(
                    "sent for google/gemini-3.8-flash: models.dev cache entry google/gemini-3.8-flash says yes",
                ),
                expect.stringContaining(
                    "sent for google/antigravity-gemini-3.8-flash: models.dev cache entry google/gemini-3.8-flash says yes",
                ),
                expect.stringContaining(
                    "omitted for openai/gpt-6.1-sol: models.dev cache entry openai/gpt-6.1-sol says no",
                ),
            ]);
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            __temperatureTest.reset();
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    test("OpenCode 2 authors historian.temperature on historian passes only when metadata accepts it", async () => {
        const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { __temperatureTest } = await import("../shared/subagent-temperature");
        const cacheRoot = join(tmpdir(), `mc-oc2-authored-temperature-${crypto.randomUUID()}`);
        mkdirSync(join(cacheRoot, "opencode"), { recursive: true });
        writeFileSync(
            join(cacheRoot, "opencode", "models.json"),
            JSON.stringify({ google: { models: { "gemini-3.8-flash": { temperature: true } } } }),
        );
        const saved = {
            XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
            OPENCODE_MODELS_PATH: process.env.OPENCODE_MODELS_PATH,
        };
        process.env.XDG_CACHE_HOME = cacheRoot;
        delete process.env.OPENCODE_MODELS_PATH;
        __temperatureTest.reset();
        // OpenCode 2.0.22 rows carry no temperature field, so the cached catalogue decides for
        // google and openai; the mock row states its flag, so host metadata decides for it.
        const rows = [
            { id: "gemini-3.8-flash", providerID: "google", capabilities: { tools: true } },
            { id: "gpt-6.1-sol", providerID: "openai", capabilities: { tools: true } },
            { id: "cheap", providerID: "mock", capabilities: { temperature: true } },
        ];
        let configured: number | undefined = 0.1;
        const state = await setup("authored-temperature", {
            modelCatalog: async () => rows,
            historianTemperature: () => configured,
        });
        const at = (providerID: string, modelID: string) =>
            request(modelID, { model: { providerID, modelID } });
        try {
            for (const kind of ["historian", "historian-editor"] as const) {
                const handle = await state.executor.open({ ...run, kind, agent: kind });
                await state.executor.attempt(handle, at("google", "gemini-3.8-flash"));
                await state.executor.attempt(handle, at("openai", "gpt-6.1-sol"));
                await state.executor.attempt(handle, at("openai-codex", "gpt-6.1-sol"));
                await close(state.executor, handle, true);
            }
            configured = 0;
            const zero = await state.executor.open(run);
            await state.executor.attempt(zero, at("mock", "cheap"));
            await state.executor.attempt(zero, at("google", "gemini-3.8-flash"));
            await close(state.executor, zero, true);
            configured = undefined;
            const unset = await state.executor.open(run);
            await state.executor.attempt(unset, at("google", "gemini-3.8-flash"));
            await close(state.executor, unset, true);
            expect(state.requests.map((draft) => draft.options)).toEqual([
                { temperature: 0.1 },
                {},
                {},
                { temperature: 0.1 },
                {},
                {},
                { temperature: 0 },
                { temperature: 0 },
                {},
            ]);
        } finally {
            state.db.close();
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            __temperatureTest.reset();
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    test("OpenCode 2 dreamer requests are unchanged by a configured historian temperature", async () => {
        const capture = async (historianTemperature?: () => number | undefined) => {
            const state = await setup("dreamer-untouched", {
                modelCatalog: async () => [
                    { id: "cheap", providerID: "mock", capabilities: { temperature: true } },
                ],
                ...(historianTemperature ? { historianTemperature } : {}),
            });
            const sent: unknown[] = [];
            const prompt = state.host.prompt;
            state.host.prompt = async (input) => {
                sent.push(input);
                await prompt(input);
            };
            try {
                const handle = await state.executor.open(dreamerRun);
                await state.executor.attempt(handle, request("cheap"));
                await close(state.executor, handle, true);
                expect(sent).toHaveLength(1);
                expect(state.requests).toHaveLength(1);
                // Each attempt carries a fresh random marker; everything else must match.
                return JSON.stringify({ sent, drafts: state.requests }).replace(
                    /mc:hidden:[0-9a-f-]+:[0-9a-f-]+/g,
                    "mc:hidden:marker",
                );
            } finally {
                state.db.close();
            }
        };
        const without = await capture();
        const withTemperature = await capture(() => 0.1);
        expect(withTemperature).toBe(without);
        expect(without).not.toContain("temperature");
    });

    test("OpenCode 2 Codex-shaped provider receives no temperature and needs no retry or fallback", async () => {
        const state = await setup("temperature-codex");
        const prompt = state.host.prompt;
        let calls = 0;
        state.host.prompt = async (input) => {
            calls++;
            await prompt(input);
            if (state.requests.at(-1)?.options.temperature !== undefined)
                throw new Error("Codex error: Unsupported parameter: temperature");
        };
        try {
            const handle = await state.executor.open(run);
            await state.executor.attempt(handle, request("cheap", { temperature: 0.1 }));
            expect((await state.executor.collect(handle)).text).toBe("editor completion");
            expect(calls).toBe(1);
            expect(state.switches).toHaveLength(0);
            expect(state.requests[0]?.options).not.toHaveProperty("temperature");
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("OpenCode 2 rejection despite positive metadata is an ordinary provider error without replay", async () => {
        const state = await setup("temperature-wrong-metadata", {
            modelCatalog: async () => [
                { id: "cheap", providerID: "mock", capabilities: { temperature: true } },
            ],
        });
        try {
            const handle = await state.executor.open(run);
            state.setPromptError(new Error("Codex error: Unsupported parameter: temperature"));
            await expect(
                state.executor.attempt(handle, request("cheap", { temperature: 0.1 })),
            ).rejects.toThrow("Unsupported parameter: temperature");
            expect(state.requests).toHaveLength(1);
            expect(state.requests[0]?.options.temperature).toBe(0.1);
            await close(state.executor, handle, false);
        } finally {
            state.db.close();
        }
    });
});

test("v2 historian sums all blocked-call steps and excludes previous attempts", async () => {
    const f = await setup();
    const identity = {
        ...run,
        agent: "historian",
        kind: "historian" as const,
        model: "opencode/free",
    };
    const handle = await f.executor.open(identity);
    f.rows.append(handle.id, "earlier run on this carrier");
    const prompt = f.host.prompt.bind(f.host);
    let filesystemOpens = 0;
    let refusal: string | undefined;
    f.host.prompt = async (input) => {
        const first = f.rows.append(input.sessionID, "", { finish: "tool_calls" });
        first.data.tokens = { input: 13, output: 5, cache: { read: 3, write: 2 } };
        first.data.content = [
            {
                type: "tool-call",
                id: "forced-read",
                name: "read",
                input: { path: "/project/sentinel" },
            },
        ] as never;
        refusal = hiddenToolCallRefusal({ sessionID: input.sessionID, tool: "read" }, f.hook);
        if (refusal === undefined) filesystemOpens += 1;
        await prompt(input);
    };
    try {
        await f.executor.attempt(
            handle,
            request("free", { model: { providerID: "opencode", modelID: "free" } }),
        );
        const completion = await f.executor.collect(handle, 50);
        expect(refusal).toContain("tool use is disabled for this task");
        expect(filesystemOpens).toBe(0);
        expect(completion.text).toBe("editor completion");
        expect(completion.usage).toEqual({
            input: 114,
            output: 16,
            cacheRead: 10,
            cacheWrite: 7,
            reasoning: 3,
        });
        expect(Object.keys(f.requests[0]!.tools)).toEqual(["read"]);
        expect(f.requests[0]!.system).toEqual([
            {
                type: "text",
                text: "calibrated editor system\n\nSummarize only the supplied conversation and memory context. Do not call tools.",
            },
        ]);
    } finally {
        await f.executor.close(handle, {
            promptSettled: true,
            privacySensitive: false,
            context: "test",
            log() {},
        });
        f.db.close();
    }
});

for (const agent of [
    "historian",
    "historian-recomp",
    "historian-editor",
    "dreamer-classifier",
    "dreamer-reviewer",
    "smart-note-compiler",
]) {
    test(`v2 non-Zen ${agent} retains its original prompt and empty tool surface`, async () => {
        const f = await setup();
        const handle = await f.executor.open({
            ...run,
            agent,
            kind: agent.startsWith("historian") ? "historian" : "dreamer-task",
        });
        try {
            await f.executor.attempt(handle, request());
            expect(JSON.stringify(f.requests[0]!.system)).toBe(
                '[{"type":"text","text":"calibrated editor system"}]',
            );
            expect(JSON.stringify(f.requests[0]!.tools)).toBe("{}");
        } finally {
            await f.executor.close(handle, {
                promptSettled: true,
                privacySensitive: false,
                context: "test",
                log() {},
            });
            f.db.close();
        }
    });
}

test("v2 does not append the tool instruction when the host supplied no read definition", () => {
    const hook = new HiddenChildHook(() => {});
    const identity = {
        ...run,
        agent: "historian",
        kind: "historian" as const,
        model: "opencode/free",
    };
    const marker = "mc:hidden:aaaa:bbbb";
    hook.registerChild("child", "historian");
    hook.registerAttempt(marker, {
        childSessionId: "child",
        identity,
        request: request("free"),
        shaped: false,
    });
    const draft: SessionContext = {
        sessionID: "child",
        agent: "historian",
        model: { providerID: "opencode", id: "free" },
        system: [],
        tools: {},
        options: {},
        messages: [{ role: "user", content: [{ type: "text", text: marker }] }],
    };
    hook.apply(draft);
    expect(draft.system).toEqual([{ type: "text", text: identity.system }]);
    expect(draft.tools).toEqual({});
});

test("v2 cross-provider fallback replaces the Zen surface without retaining its instruction", async () => {
    const f = await setup();
    const identity = {
        ...run,
        agent: "historian",
        kind: "historian" as const,
        model: "opencode/free",
    };
    const handle = await f.executor.open(identity);
    try {
        await f.executor.attempt(
            handle,
            request("free", { model: { providerID: "opencode", modelID: "free" } }),
        );
        const zenChild = handle.id;
        expect(f.creates[0]?.permissions).toEqual([
            { action: "*", resource: "*", effect: "deny" },
            { action: "read", resource: "*", effect: "allow" },
        ]);
        await f.executor.attempt(handle, request("fallback"));
        expect(handle.id).not.toBe(zenChild);
        expect(f.creates[1]?.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
        expect(f.requests[1]?.tools).toEqual({});
        expect(f.requests[1]?.system).toEqual([{ type: "text", text: identity.system }]);
    } finally {
        await f.executor.close(handle, {
            promptSettled: true,
            privacySensitive: false,
            context: "test",
            log() {},
        });
        f.db.close();
    }
});
