import { afterEach, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { getSubagentInvocations } from "../../features/magic-context/storage-subagent-invocations";
import type { PluginContext } from "../../plugin/types";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { recordPromptSessionError } from "../../shared/prompt-async-transport";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    resolveHiddenCompletionExecutor,
    runValidatedHistorianPass,
} from "./compartment-runner-historian";
import type { HiddenCompletionExecutor } from "./compartment-runner-types";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    clearModelsDevCache();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
    tempDirs.length = 0;
});

test("missing v2 hidden executor names the historian or dream entry point", () => {
    const db = openDatabase();
    for (const entryPoint of ["historian", "classify-memories", "compress-cues"]) {
        expect(() =>
            resolveHiddenCompletionExecutor(undefined, undefined, db, "/tmp", entryPoint),
        ).toThrow(`${entryPoint}: v2 hidden completion executor is missing`);
    }
    const executor = {
        capabilities: { tools: false, harness: "opencode2" },
    } as HiddenCompletionExecutor;
    expect(resolveHiddenCompletionExecutor(executor, undefined, db, "/tmp", "historian")).toBe(
        executor,
    );
});

test("historian ledger distinguishes empty, reasoning-only, length-capped and valid output", async () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-historian-ledger-"));
    tempDirs.push(directory);
    process.env.XDG_DATA_HOME = directory;
    const db = openDatabase();
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const cases = [
        { text: null, reasoning: null, lengthCapped: false, expected: "empty" },
        { text: null, reasoning: "thinking", lengthCapped: false, expected: "empty" },
        { text: null, reasoning: "thinking", lengthCapped: true, expected: "empty" },
        {
            text: '<output><compartment start="1" end="1" title="History"><p1>Preserve this.</p1></compartment></output>',
            reasoning: null,
            lengthCapped: false,
            expected: "completed",
        },
    ] as const;
    for (const [index, item] of cases.entries()) {
        const executor: HiddenCompletionExecutor = {
            capabilities: { tools: false, harness: "opencode" },
            open: async () => ({ id: `child-${index}`, childSessionId: `child-${index}` }),
            attempt: async () => {},
            collect: async () => ({ ...item, usage }),
            close: async () => {},
        };
        await runValidatedHistorianPass({
            client: undefined,
            hiddenCompletionExecutor: executor,
            db,
            parentSessionId: `parent-${index}`,
            sessionDirectory: directory,
            prompt: "Messages 1-1:\n1: U: preserve this",
            chunk: { startIndex: 1, endIndex: 1, lines: [{ ordinal: 1, messageId: "message-1" }] },
            priorCompartments: [],
            sequenceOffset: 0,
            dumpLabelBase: `case-${index}`,
        });
        const rows = getSubagentInvocations(db, `parent-${index}`);
        expect(rows[0]?.status).toBe(item.expected);
        if (item.expected === "empty") expect(rows[0]?.error).toBeTruthy();
    }
});

test("OpenCode 1 records the configured model and session.error when a child has no assistant", async () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-historian-model-refusal-"));
    tempDirs.push(directory);
    process.env.XDG_DATA_HOME = directory;
    const db = openDatabase();
    const model = "provider-not-configured/model-missing";
    const suggestion = "provider-not-configured/model-available";
    const hostError = {
        name: "ProviderModelNotFoundError",
        data: {
            message: `Model not found: ${model}. Did you mean: ${suggestion}?`,
            prompt: "PRIVATE_PROMPT_SENTINEL",
        },
    };
    const client = {
        session: {
            create: async () => ({ data: { id: "child-model-refusal" } }),
            promptAsync: async () => {
                setTimeout(() => recordPromptSessionError("child-model-refusal", hostError), 10);
                return { data: undefined };
            },
            status: async () => ({ data: {} }),
            messages: async () => ({ data: [] }),
            abort: async () => ({}),
            update: async () => ({}),
            delete: async () => ({}),
        },
    } as unknown as PluginContext["client"];

    await runValidatedHistorianPass({
        client,
        db,
        parentSessionId: "parent-model-refusal",
        sessionDirectory: directory,
        prompt: "Messages 1-1:\n1: U: preserve this",
        timeoutMs: 5_000,
        model: { model, sourceConfigKey: "historian.opencode.model" },
        chunk: { startIndex: 1, endIndex: 1, lines: [{ ordinal: 1, messageId: "message-1" }] },
        priorCompartments: [],
        sequenceOffset: 0,
        dumpLabelBase: "model-refusal",
    });

    const [row] = getSubagentInvocations(db, "parent-model-refusal");
    expect(row).toMatchObject({
        providerId: "provider-not-configured",
        modelId: "model-missing",
        status: "failed",
    });
    expect(row?.error).toContain("No reply: OpenCode refused the model");
    expect(row?.error).toContain(suggestion);
    expect(row?.error).not.toContain("PRIVATE_PROMPT_SENTINEL");
});

test("a resolving timed-out historian prompt is archived and recorded as timed_out", async () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-historian-timeout-"));
    tempDirs.push(directory);
    process.env.XDG_DATA_HOME = directory;
    const db = openDatabase();
    const abort = mock(async () => ({}));
    const update = mock(async () => ({}));
    const remove = mock(async () => ({}));
    const client = {
        session: {
            create: async () => ({ data: { id: "child-timeout" } }),
            prompt: ({ signal }: { signal: AbortSignal }) =>
                new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
            messages: async () => ({ data: [] }),
            abort,
            update,
            delete: remove,
        },
    } as unknown as PluginContext["client"];
    await runValidatedHistorianPass({
        client,
        db,
        parentSessionId: "parent-timeout",
        sessionDirectory: directory,
        prompt: "Messages 1-1:\n1: U: preserve this",
        timeoutMs: 20,
        model: { model: "provider/timeout-model", sourceConfigKey: "historian.opencode.model" },
        chunk: { startIndex: 1, endIndex: 1, lines: [{ ordinal: 1, messageId: "message-1" }] },
        priorCompartments: [],
        sequenceOffset: 0,
        dumpLabelBase: "timeout",
    });
    const rows = getSubagentInvocations(db, "parent-timeout");
    expect(rows[0]?.status).toBe("timed_out");
    expect(rows[0]?.error).toContain("prompt timed out after 20ms");
    expect(rows[0]?.providerId).toBe("provider");
    expect(rows[0]?.modelId).toBe("timeout-model");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
});

// Both historian lanes share one rule: a timed-out attempt moves on to the next model in
// the chain (the Rust module's firing loop mirrors this). This pins the TypeScript side.
test("a timed-out primary historian falls back to the next model and publishes its output", async () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-historian-timeout-fallback-"));
    tempDirs.push(directory);
    process.env.XDG_DATA_HOME = directory;
    const db = openDatabase();
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const attempted: string[] = [];
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode" },
        open: async (request) => {
            const id = `child-${request.model?.model ?? "agent"}`;
            return { id, childSessionId: id };
        },
        attempt: (_handle, request) => {
            const model = request.body?.model;
            const key = model ? `${model.providerID}/${model.modelID}` : "agent";
            attempted.push(key);
            if (key !== "prov/primary") return Promise.resolve();
            // The primary never answers: it rejects only once the prompt timeout aborts it,
            // which the prompt helper turns into a thrown "prompt timed out" error.
            return new Promise<void>((_resolve, reject) => {
                request.signal?.addEventListener("abort", () =>
                    reject(new Error("request aborted")),
                );
            });
        },
        collect: async () => ({
            text: '<output><compartment start="1" end="1" title="History"><p1>Fallback kept this.</p1></compartment></output>',
            reasoning: null,
            lengthCapped: false,
            usage,
        }),
        close: async () => {},
    };

    const result = await runValidatedHistorianPass({
        client: undefined,
        hiddenCompletionExecutor: executor,
        db,
        parentSessionId: "parent-timeout-fallback",
        sessionDirectory: directory,
        prompt: "Messages 1-1:\n1: U: preserve this",
        timeoutMs: 20,
        model: { model: "prov/primary" },
        fallbackModels: [{ model: "prov/fallback" }],
        chunk: { startIndex: 1, endIndex: 1, lines: [{ ordinal: 1, messageId: "message-1" }] },
        priorCompartments: [],
        sequenceOffset: 0,
        dumpLabelBase: "timeout-fallback",
    });

    expect(attempted).toEqual(["prov/primary", "prov/fallback"]);
    expect(result.ok).toBe(true);
    expect(result.compartments?.[0]?.content).toContain("Fallback kept this.");
    const invocations = getSubagentInvocations(db, "parent-timeout-fallback");
    const statuses = invocations.map((row) => row.status);
    expect(statuses).toContain("timed_out");
    expect(statuses).toContain("completed");
    expect(invocations.find((row) => row.status === "completed")?.task).toBe("fallback");
});

test("a free-model retry error falls back in a fresh historian child without accepting partial output", async () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-historian-provider-fallback-"));
    tempDirs.push(directory);
    process.env.XDG_DATA_HOME = directory;
    const db = openDatabase();
    const attempted: string[] = [];
    const messages = new Map<string, unknown[]>();
    const retrying = new Set<string>();
    let nextChild = 0;
    const output = (text: string) =>
        `<output><compartment start="1" end="1" title="History"><p1>${text}</p1></compartment></output>`;
    const abort = mock(async ({ path }: { path: { id: string } }) => {
        retrying.delete(path.id);
        return {};
    });
    const client = {
        session: {
            create: async () => ({ data: { id: `provider-child-${nextChild++}` } }),
            promptAsync: async ({
                path,
                body,
            }: {
                path: { id: string };
                body: { model: { providerID: string; modelID: string } };
            }) => {
                const model = `${body.model.providerID}/${body.model.modelID}`;
                attempted.push(model);
                const primary = model === "opencode/free-model";
                if (primary) retrying.add(path.id);
                messages.set(path.id, [
                    {
                        info: {
                            id: `${path.id}-assistant`,
                            role: "assistant",
                            time: { created: 1, ...(primary ? {} : { completed: 2 }) },
                            ...(primary ? {} : { finish: "stop" }),
                        },
                        parts: [
                            {
                                type: "text",
                                text: output(
                                    primary ? "Incomplete primary." : "Fallback kept this.",
                                ),
                            },
                            ...(primary
                                ? [
                                      {
                                          type: "retry",
                                          error: {
                                              name: "APIError",
                                              data: {
                                                  statusCode: 429,
                                                  message: "Free usage limit reached",
                                              },
                                          },
                                      },
                                  ]
                                : []),
                        ],
                    },
                ]);
                return { data: undefined };
            },
            status: async () => ({
                data: Object.fromEntries([...retrying].map((id) => [id, { type: "retry" }])),
            }),
            messages: async ({ path }: { path: { id: string } }) => ({
                data: messages.get(path.id) ?? [],
            }),
            abort,
            delete: async () => ({}),
        },
    } as unknown as PluginContext["client"];
    const startedAt = Date.now();
    const result = await runValidatedHistorianPass({
        client,
        db,
        parentSessionId: "parent-provider-fallback",
        sessionDirectory: directory,
        prompt: "Messages 1-1:\n1: U: preserve this",
        timeoutMs: 5_000,
        model: { model: "opencode/free-model" },
        fallbackModels: [{ model: "prov/fallback" }],
        chunk: { startIndex: 1, endIndex: 1, lines: [{ ordinal: 1, messageId: "message-1" }] },
        priorCompartments: [],
        sequenceOffset: 0,
        dumpLabelBase: "provider-fallback",
    });
    expect(attempted).toEqual(["opencode/free-model", "prov/fallback"]);
    expect(nextChild).toBe(2);
    expect(abort).toHaveBeenCalledWith({ path: { id: "provider-child-0" } });
    expect(result.ok).toBe(true);
    expect(result.compartments?.[0]?.content).toContain("Fallback kept this.");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
});

test("a failed historian repair passes its repair prompt to fallback models", async () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-historian-repair-fallback-"));
    tempDirs.push(directory);
    process.env.XDG_DATA_HOME = directory;
    const db = openDatabase();
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const outputs = [
        "not xml",
        "still not xml",
        '<output><compartment start="1" end="1" title="History"><p1>Fallback repaired this.</p1></compartment></output>',
    ];
    const prompts: string[] = [];
    const outputIndexByChild = new Map<string, number>();
    let nextOutput = 0;
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode" },
        open: async () => {
            const index = nextOutput++;
            const id = `child-repair-fallback-${index}`;
            outputIndexByChild.set(id, index);
            return { id, childSessionId: id };
        },
        attempt: (_handle, request) => {
            const parts = (request.body as { parts?: Array<{ text?: string }> }).parts;
            prompts.push(parts?.[0]?.text ?? "");
            return Promise.resolve();
        },
        collect: async (handle) => ({
            text: outputs[outputIndexByChild.get(handle.id) ?? -1] ?? "",
            reasoning: null,
            lengthCapped: false,
            usage,
        }),
        close: async () => {},
    };

    const result = await runValidatedHistorianPass({
        client: undefined,
        hiddenCompletionExecutor: executor,
        db,
        parentSessionId: "parent-repair-fallback",
        sessionDirectory: directory,
        prompt: "Messages 1-1:\n1: U: preserve this",
        model: { model: "prov/primary" },
        fallbackModels: [{ model: "prov/fallback" }],
        chunk: { startIndex: 1, endIndex: 1, lines: [{ ordinal: 1, messageId: "message-1" }] },
        priorCompartments: [],
        sequenceOffset: 0,
        dumpLabelBase: "repair-fallback",
    });

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("Validation error:");
    expect(prompts[1]).toContain("Previous invalid XML:\nnot xml");
    expect(prompts[2]).toBe(prompts[1]);
    expect(result.ok).toBe(true);
    expect(result.compartments?.[0]?.content).toContain("Fallback repaired this.");
});

test("32k historian reaches the provider without a configured output cap and surfaces its assistant error", async () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-historian-assistant-error-"));
    tempDirs.push(directory);
    process.env.XDG_DATA_HOME = directory;
    const db = openDatabase();
    const assistant = {
        info: {
            role: "assistant",
            time: { created: 1, completed: 2 },
            finish: "error",
            error: {
                name: "ProviderAuthError",
                data: {
                    providerID: "google",
                    message: "Antigravity authorization refused the hidden child session",
                },
            },
        },
        parts: [],
    };
    const client = {
        session: {
            create: async () => ({ data: { id: "child-provider-error" } }),
            prompt: async () => ({ data: assistant }),
            messages: async () => ({ data: [assistant] }),
            delete: async () => ({}),
        },
    } as unknown as PluginContext["client"];

    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: "google",
                            models: {
                                // Unknown calibration doubles the estimate: the system prompt alone
                                // costs 30,108 tokens. This reserve leaves a 30,170-token input limit,
                                // barely enough for the tiny chunk. Keep the fixture near the 32k
                                // boundary to catch the old implicit 32,768-token output cap.
                                "fixture-model": { limit: { context: 32_000, output: 896 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
    const result = await runValidatedHistorianPass({
        model: "google/fixture-model",
        client,
        db,
        parentSessionId: "parent-provider-error",
        sessionDirectory: directory,
        prompt: "Messages 1-1:\n1: U: preserve this",
        chunk: {
            startIndex: 1,
            endIndex: 1,
            lines: [{ ordinal: 1, messageId: "message-1" }],
        },
        priorCompartments: [],
        sequenceOffset: 0,
        dumpLabelBase: "provider-error",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ProviderAuthError");
    expect(result.error).toContain("Antigravity authorization refused the hidden child session");
    expect(result.error).toContain("finish=error");
    expect(result.error).not.toContain("Historian returned no assistant output");
});

// Reporter shape from a Regolo setup: opencode.json sets limit.context to
// 120,000 while the provider catalog advertises 262,144. A live OpenCode 1.18
// host returns the configured 120,000 from config.providers() (the catalog value
// never reaches the plugin), so the historian must refuse a prompt that only
// fits the advertised window. The advertised payload is run first as a control:
// the same prompt reaches the provider there, which proves the refusal comes
// from the window value and not from something else in the prompt.
test("historian refuses a prompt sized for an advertised window larger than the configured limit.context", async () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-historian-configured-window-"));
    tempDirs.push(directory);
    process.env.XDG_DATA_HOME = directory;
    const db = openDatabase();
    // About 175K calibrated provider tokens: over the 120K window's admission
    // limit (~100K after the output reserve and margin), under the 262K one's (~238K).
    const prompt = `Messages 1-1:\n1: U: ${"alpha beta gamma delta ".repeat(20_000)}`;
    const runWithWindow = async (context: number, parentSessionId: string) => {
        clearModelsDevCache();
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: "regolo-ai",
                                models: {
                                    "qwen3.5-122b": { limit: { context, output: 16_384 } },
                                },
                            },
                        ],
                    },
                }),
            },
        });
        const prompted = mock(async () => ({ data: { info: { role: "assistant" }, parts: [] } }));
        const client = {
            session: {
                create: async () => ({ data: { id: `child-${parentSessionId}` } }),
                prompt: prompted,
                messages: async () => ({ data: [] }),
                delete: async () => ({}),
            },
        } as unknown as PluginContext["client"];
        const result = await runValidatedHistorianPass({
            model: "regolo-ai/qwen3.5-122b",
            client,
            db,
            parentSessionId,
            sessionDirectory: directory,
            prompt,
            // The control run only needs to reach the provider; its empty reply
            // should not wait out the default historian timeout.
            timeoutMs: 500,
            chunk: { startIndex: 1, endIndex: 1, lines: [{ ordinal: 1, messageId: "message-1" }] },
            priorCompartments: [],
            sequenceOffset: 0,
            dumpLabelBase: parentSessionId,
        });
        return { result, promptCalls: prompted.mock.calls.length };
    };

    const advertised = await runWithWindow(262_144, "parent-advertised-window");
    expect(advertised.promptCalls).toBeGreaterThan(0);

    const configured = await runWithWindow(120_000, "parent-configured-window");
    expect(configured.promptCalls).toBe(0);
    expect(configured.result.ok).toBe(false);
    expect(configured.result.error).toContain("producer_prompt_exceeds_window");
}, 60_000);

// Each refused attempt used to open a hidden child session first and then let
// the transport refuse the prompt, so an over-window session left one hidden
// session behind per trigger. The refusal now comes before the child is opened.
test("a prompt refused for the selected model's window opens no child session", async () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-historian-refusal-no-child-"));
    tempDirs.push(directory);
    process.env.XDG_DATA_HOME = directory;
    const db = openDatabase();
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: "small-provider",
                            models: {
                                "small-model": { limit: { context: 40_000, output: 4_096 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
    const create = mock(async () => ({ data: { id: "child-refused" } }));
    const prompted = mock(async () => ({ data: { info: { role: "assistant" }, parts: [] } }));
    const client = {
        session: {
            create,
            prompt: prompted,
            messages: async () => ({ data: [] }),
            delete: async () => ({}),
        },
    } as unknown as PluginContext["client"];

    const result = await runValidatedHistorianPass({
        model: "small-provider/small-model",
        client,
        db,
        parentSessionId: "parent-refused-no-child",
        sessionDirectory: directory,
        prompt: `Messages 1-1:\n1: U: ${"alpha beta gamma delta ".repeat(20_000)}`,
        timeoutMs: 500,
        chunk: { startIndex: 1, endIndex: 1, lines: [{ ordinal: 1, messageId: "message-1" }] },
        priorCompartments: [],
        sequenceOffset: 0,
        dumpLabelBase: "refused-no-child",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("producer_prompt_exceeds_window");
    expect(create).toHaveBeenCalledTimes(0);
    expect(prompted).toHaveBeenCalledTimes(0);
});

test("historian cache admission skips fresh prompts, writes transient retries and rebuilds repair", async () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-historian-cache-"));
    tempDirs.push(directory);
    process.env.XDG_DATA_HOME = directory;
    const requests: import("../../shared/model-suggestion-retry").PromptArgs[] = [];
    let opened = 0;
    let collected = 0;
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode2" },
        open: async () => ({ id: `child-${++opened}` }),
        attempt: async (_handle, request) => {
            requests.push(request);
            if (requests.length === 1) throw new Error("503 overloaded");
        },
        collect: async () => ({
            text:
                ++collected === 1
                    ? "invalid XML"
                    : '<output><compartment start="1" end="1" title="History"><p1>Preserve this.</p1></compartment></output>',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            lengthCapped: false,
        }),
        close: async () => {},
    };
    const result = await runValidatedHistorianPass({
        client: undefined,
        hiddenCompletionExecutor: executor,
        db: openDatabase(),
        parentSessionId: "parent-cache",
        sessionDirectory: directory,
        prompt: "Messages 1-1:\n1: U: preserve this",
        chunk: { startIndex: 1, endIndex: 1, lines: [{ ordinal: 1, messageId: "message-1" }] },
        priorCompartments: [],
        sequenceOffset: 0,
        dumpLabelBase: "cache",
    });
    expect(result.ok).toBe(true);
    expect(opened).toBe(2);
    expect(requests.map((request) => request.cacheTail)).toEqual(["skip", "write", "skip"]);
    expect(requests[0]!.body).toEqual(requests[1]!.body);
    const originalText = (requests[0]!.body.parts as Array<{ text: string }>)[0]!.text;
    const repairText = (requests[2]!.body.parts as Array<{ text: string }>)[0]!.text;
    expect(repairText.startsWith(originalText)).toBe(true);
    expect(repairText).not.toBe(originalText);
    expect(requests.every((request) => !("cacheTail" in request.body))).toBe(true);
});
