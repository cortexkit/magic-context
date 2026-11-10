import { describe, expect, mock, spyOn, test } from "bun:test";
import { recordedGeminiQuotaMessages } from "../features/magic-context/dreamer/provider-output-failure.test-support";
import { HiddenAgentStepLimit } from "../v2/hooks/hidden-child";
import { hiddenModelCooldowns } from "./hidden-model-cooldown";
import {
    getPromptFailureDetail,
    noteModelActivityMonitored,
    noteModelOutputReceived,
    promptSyncWithModelSuggestionRetry,
    promptSyncWithValidatedOutputRetry,
} from "./model-suggestion-retry";

type PromptCall = {
    body: {
        model?: { providerID: string; modelID: string };
        system?: string;
        [key: string]: unknown;
    };
    signal?: AbortSignal;
};

function createClient(
    prompt: ReturnType<typeof mock>,
    abort?: ReturnType<typeof mock>,
    messages?: ReturnType<typeof mock>,
) {
    return {
        session: {
            prompt,
            abort: abort ?? mock(async () => ({})),
            messages: messages ?? mock(async () => []),
        },
    } as never;
}

function createArgs(model?: { providerID: string; modelID: string }) {
    return {
        path: { id: "ses-test" },
        body: model ? { model } : {},
    };
}

describe("promptSyncWithModelSuggestionRetry", () => {
    test("synchronous prompt completion retains await semantics with cancellation", async () => {
        const prompt = mock(() => undefined);
        const abort = mock(async () => ({}));

        await promptSyncWithModelSuggestionRetry(createClient(prompt, abort), createArgs(), {
            signal: new AbortController().signal,
        });

        expect(prompt).toHaveBeenCalledTimes(1);
        expect(abort).not.toHaveBeenCalled();
    });

    test("primary succeeds, no fallback iteration", async () => {
        const prompt = mock(async () => ({}));
        const client = createClient(prompt);

        await promptSyncWithModelSuggestionRetry(client, createArgs(), {
            fallbackModels: ["anthropic/claude-sonnet-4-6"],
        });

        expect(prompt).toHaveBeenCalledTimes(1);
    });

    test("primary succeeds with no fallbacks configured", async () => {
        const prompt = mock(async () => ({}));
        const client = createClient(prompt);

        await promptSyncWithModelSuggestionRetry(client, createArgs());

        expect(prompt).toHaveBeenCalledTimes(1);
    });

    test("each active fallback sends only its own variant", async () => {
        const prompt = mock(async () => {
            if (prompt.mock.calls.length <= 2) throw new Error("attempt failed");
            return {};
        });
        const client = createClient(prompt);

        await promptSyncWithModelSuggestionRetry(
            client,
            {
                path: { id: "ses-test" },
                body: { model: { providerID: "anthropic", modelID: "primary" }, variant: "high" },
            },
            {
                fallbackModels: [{ model: "anthropic/fallback", qualifier: "low" }, "google/bare"],
            },
        );

        expect((prompt.mock.calls[1]?.[0] as PromptCall).body).toMatchObject({
            model: { providerID: "anthropic", modelID: "fallback" },
            variant: "low",
        });
        const bareFallbackBody = (prompt.mock.calls[2]?.[0] as PromptCall).body;
        expect(bareFallbackBody.model).toEqual({ providerID: "google", modelID: "bare" });
        expect(bareFallbackBody.variant).toBeUndefined();
    });

    test("primary fails, fallback[0] succeeds", async () => {
        const prompt = mock(async () => {
            if (prompt.mock.calls.length === 1) throw new Error("primary failed");
            return {};
        });
        const client = createClient(prompt);

        await promptSyncWithModelSuggestionRetry(client, createArgs(), {
            fallbackModels: ["anthropic/claude-sonnet-4-6"],
        });

        expect(prompt).toHaveBeenCalledTimes(2);
        expect((prompt.mock.calls[1]?.[0] as PromptCall).body.model).toEqual({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
        });
    });

    test("primary fails, fallback[0] fails, fallback[1] succeeds", async () => {
        const prompt = mock(async () => {
            if (prompt.mock.calls.length <= 2)
                throw new Error(`failed ${prompt.mock.calls.length}`);
            return {};
        });
        const client = createClient(prompt);

        await promptSyncWithModelSuggestionRetry(client, createArgs(), {
            fallbackModels: ["anthropic/claude-sonnet-4-6", "google/gemini-3-flash"],
        });

        expect(prompt).toHaveBeenCalledTimes(3);
        expect((prompt.mock.calls[2]?.[0] as PromptCall).body.model).toEqual({
            providerID: "google",
            modelID: "gemini-3-flash",
        });
    });

    test("all attempts fail throws the last fallback error", async () => {
        const primaryError = new Error("primary failed");
        const firstFallbackError = new Error("fallback 0 failed");
        const lastFallbackError = new Error("fallback 1 failed");
        const errors = [primaryError, firstFallbackError, lastFallbackError];
        const prompt = mock(async () => {
            throw errors[prompt.mock.calls.length - 1];
        });
        const client = createClient(prompt);

        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), {
                fallbackModels: ["anthropic/claude-sonnet-4-6", "google/gemini-3-flash"],
            }),
        ).rejects.toBe(lastFallbackError);
        expect(prompt).toHaveBeenCalledTimes(3);
    });

    test("abort signal short-circuits", async () => {
        const controller = new AbortController();
        controller.abort();
        const prompt = mock(async () => {
            throw new Error("provider noticed abort");
        });
        const client = createClient(prompt);

        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), {
                signal: controller.signal,
                fallbackModels: ["anthropic/claude-sonnet-4-6"],
            }),
        ).rejects.toThrow("prompt aborted by external signal");
        // Pre-aborted signal MUST short-circuit before any upstream prompt
        // call — Audit Finding #1 hardening. No round-trip wasted on a
        // request the caller has already cancelled.
        expect(prompt).toHaveBeenCalledTimes(0);
    });

    test("pre-aborted lease signal carries its loss reason into the prompt error", async () => {
        const controller = new AbortController();
        controller.abort(new Error("lease_lost: taken by holder-b"));
        const prompt = mock(async () => {});
        await expect(
            promptSyncWithModelSuggestionRetry(createClient(prompt), createArgs(), {
                signal: controller.signal,
            }),
        ).rejects.toThrow("prompt aborted by external signal: lease_lost: taken by holder-b");
        expect(prompt).not.toHaveBeenCalled();
    });

    test("AbortError name short-circuits", async () => {
        const abortError = new Error("aborted by provider");
        abortError.name = "AbortError";
        const prompt = mock(async () => {
            throw abortError;
        });
        const client = createClient(prompt);

        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), {
                fallbackModels: ["anthropic/claude-sonnet-4-6"],
            }),
        ).rejects.toBe(abortError);
        expect(prompt).toHaveBeenCalledTimes(1);
    });

    test("timeout short-circuits", async () => {
        const timeoutError = new Error("prompt timed out after 5000ms");
        const prompt = mock(async () => {
            throw timeoutError;
        });
        const client = createClient(prompt);

        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), {
                fallbackModels: ["anthropic/claude-sonnet-4-6"],
            }),
        ).rejects.toBe(timeoutError);
        expect(prompt).toHaveBeenCalledTimes(1);
    });

    test("context overflow short-circuits", async () => {
        const overflowError = new Error("prompt is too long: 50000 tokens > 32000");
        const prompt = mock(async () => {
            throw overflowError;
        });
        const client = createClient(prompt);

        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), {
                fallbackModels: ["anthropic/claude-sonnet-4-6"],
            }),
        ).rejects.toBe(overflowError);
        expect(prompt).toHaveBeenCalledTimes(1);
    });

    // #154: our timeout must force-stop the child's SERVER-SIDE run loop via
    // session.abort — cancelling our client fetch alone leaves the child looping
    // the LLM past the timeout (uncancellable, only dies on process exit).
    test("timeout fires session.abort on the child session", async () => {
        // A prompt that respects the AbortController by hanging until aborted,
        // then throwing — mirrors a real in-flight request our timeout cancels.
        const prompt = mock((opts: { signal?: AbortSignal }) => {
            return new Promise((_resolve, reject) => {
                opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
        });
        const abort = mock(async () => ({}));
        const client = createClient(prompt as never, abort);

        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), { timeoutMs: 20 }),
        ).rejects.toThrow(/timed out/);
        expect(abort).toHaveBeenCalledTimes(1);
        expect((abort.mock.calls[0]?.[0] as { path: { id: string } }).path.id).toBe("ses-test");
    });

    test("timeout with a resolving transport still aborts the child", async () => {
        const abort = mock(async () => ({}));
        const client = createClient(
            mock(async () => ({})),
            abort,
        );
        const transport = Object.assign(
            ({ signal }: { signal?: AbortSignal }) =>
                new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve())),
            { childSessionId: "child-test" },
        );
        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), {
                timeoutMs: 10,
                transport,
            }),
        ).rejects.toThrow("prompt timed out after 10ms");
        expect(abort).toHaveBeenCalledTimes(1);
        expect((abort.mock.calls[0]?.[0] as { path: { id: string } }).path.id).toBe("child-test");
    });

    test("external abort with a resolving transport still aborts the child", async () => {
        const controller = new AbortController();
        const abort = mock(async () => ({}));
        const client = createClient(
            mock(async () => ({})),
            abort,
        );
        const transport = Object.assign(
            ({ signal }: { signal?: AbortSignal }) =>
                new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve())),
            { childSessionId: "child-test" },
        );
        setTimeout(() => controller.abort(), 10);
        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), {
                signal: controller.signal,
                transport,
            }),
        ).rejects.toThrow("prompt aborted by external signal");
        expect(abort).toHaveBeenCalledTimes(1);
    });

    // External abort (e.g. dreamer lease loss) mid-flight must also stop the
    // server-side loop, not just our fetch.
    test("external abort fires session.abort on the child session", async () => {
        const controller = new AbortController();
        const prompt = mock((opts: { signal?: AbortSignal }) => {
            return new Promise((_resolve, reject) => {
                opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
        });
        const abort = mock(async () => ({}));
        const client = createClient(prompt as never, abort);

        setTimeout(() => controller.abort(new Error("lease_lost: taken by holder-b")), 10);
        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), { signal: controller.signal }),
        ).rejects.toThrow("prompt aborted by external signal: lease_lost: taken by holder-b");
        expect(abort).toHaveBeenCalledTimes(1);
        expect((abort.mock.calls[0]?.[0] as { path: { id: string } }).path.id).toBe("ses-test");
    });

    // A failing session.abort must not mask the original timeout/abort error.
    test("session.abort failure does not mask the timeout error", async () => {
        const prompt = mock((opts: { signal?: AbortSignal }) => {
            return new Promise((_resolve, reject) => {
                opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
        });
        const abort = mock(async () => {
            throw new Error("abort endpoint 500");
        });
        const client = createClient(prompt as never, abort);

        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), { timeoutMs: 20 }),
        ).rejects.toThrow(/timed out/);
        expect(abort).toHaveBeenCalledTimes(1);
    });

    test("suggestion retry within attempt succeeds", async () => {
        const suggestionError = new Error("model not found");
        suggestionError.name = "ProviderModelNotFoundError";
        Object.assign(suggestionError, {
            data: {
                providerID: "anthropic",
                modelID: "claude-sonnet-4-6",
                suggestions: ["claude-sonnet-4-7"],
            },
        });
        const prompt = mock(async () => {
            if (prompt.mock.calls.length === 1) throw suggestionError;
            return {};
        });
        const client = createClient(prompt);

        await promptSyncWithModelSuggestionRetry(
            client,
            createArgs({ providerID: "anthropic", modelID: "claude-sonnet-4-6" }),
            { fallbackModels: ["google/gemini-3-flash"] },
        );

        expect(prompt).toHaveBeenCalledTimes(2);
        expect((prompt.mock.calls[1]?.[0] as PromptCall).body.model).toEqual({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-7",
        });
    });

    test("invalid fallback specs are skipped", async () => {
        const prompt = mock(async () => {
            if (prompt.mock.calls.length === 1) throw new Error("primary failed");
            return {};
        });
        const client = createClient(prompt);

        await promptSyncWithModelSuggestionRetry(client, createArgs(), {
            fallbackModels: ["no-slash", "/leading", "valid/model"],
        });

        expect(prompt).toHaveBeenCalledTimes(2);
        expect((prompt.mock.calls[1]?.[0] as PromptCall).body.model).toEqual({
            providerID: "valid",
            modelID: "model",
        });
    });

    test("iteration order respected", async () => {
        const prompt = mock(async () => {
            throw new Error(`failed ${prompt.mock.calls.length}`);
        });
        const client = createClient(prompt);

        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), {
                fallbackModels: [
                    "anthropic/claude-sonnet-4-6",
                    "google/gemini-3-flash",
                    "openrouter/qwen3-coder",
                ],
            }),
        ).rejects.toThrow("failed 4");

        expect(prompt).toHaveBeenCalledTimes(4);
        expect(prompt.mock.calls.map((call) => (call[0] as PromptCall).body.model)).toEqual([
            undefined,
            { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
            { providerID: "google", modelID: "gemini-3-flash" },
            { providerID: "openrouter", modelID: "qwen3-coder" },
        ]);
    });

    test("empty fallbackModels = legacy", async () => {
        const originalError = new Error("primary failed without suggestion");
        const prompt = mock(async () => {
            throw originalError;
        });
        const client = createClient(prompt);

        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), { fallbackModels: [] }),
        ).rejects.toBe(originalError);
        expect(prompt).toHaveBeenCalledTimes(1);
    });
});

describe("process-wide hidden model quota cooldown", () => {
    test("structured refusal makes later runs start on the fallback, then expires", async () => {
        let now = 1791425104275;
        const clock = spyOn(Date, "now").mockImplementation(() => now);
        const models: string[] = [];
        const primary = { providerID: "quota-test", modelID: "primary" };
        const client = createClient(
            mock(async (args: PromptCall) => {
                const model = `${args.body.model?.providerID}/${args.body.model?.modelID}`;
                models.push(model);
                if (model === "quota-test/primary" && models.length === 1)
                    throw Object.assign(new Error("provider quota exhausted"), {
                        statusCode: 412,
                        responseHeaders: { "retry-after": "190000" },
                    });
                if (model === "quota-test/first") throw new Error("fallback unavailable");
                return {};
            }),
        );
        const run = () =>
            promptSyncWithValidatedOutputRetry(client, createArgs(primary), {
                fallbackModels: ["quota-test/first", "quota-test/second"],
                fetchOutput: async () => "valid",
                validateOutput: (output) => output,
            });
        try {
            await run();
            await run();
            now += 190_000_000;
            await run();
            expect(models).toEqual([
                "quota-test/primary",
                "quota-test/first",
                "quota-test/second",
                "quota-test/first",
                "quota-test/second",
                "quota-test/primary",
            ]);
        } finally {
            hiddenModelCooldowns.succeeded("quota-test/primary");
            clock.mockRestore();
        }
    });

    test("a prose quota notice still falls back but never creates a cooldown", async () => {
        const models: string[] = [];
        let latest = "";
        const client = createClient(
            mock(async (args: PromptCall) => {
                latest = `${args.body.model?.providerID}/${args.body.model?.modelID}`;
                models.push(latest);
                return {};
            }),
        );
        const run = () =>
            promptSyncWithValidatedOutputRetry(
                client,
                createArgs({ providerID: "quota-prose", modelID: "primary" }),
                {
                    fallbackModels: ["quota-prose/fallback"],
                    fetchOutput: async () =>
                        latest.endsWith("/primary") ? recordedGeminiQuotaMessages() : [],
                    validateOutput: () => "valid",
                },
            );
        await run();
        await run();
        expect(models).toEqual([
            "quota-prose/primary",
            "quota-prose/fallback",
            "quota-prose/primary",
            "quota-prose/fallback",
        ]);
        expect(
            hiddenModelCooldowns.live().some((entry) => entry.model === "quota-prose/primary"),
        ).toBe(false);
    });
});

describe("promptSyncWithValidatedOutputRetry", () => {
    test("records a step cap as step_limit without a provider error", async () => {
        const prompt = mock(async () => {
            throw new HiddenAgentStepLimit("dreamer-retrospective", 40);
        });
        const client = createClient(prompt);
        let caught: unknown;
        try {
            await promptSyncWithValidatedOutputRetry(client, createArgs(), {
                fetchOutput: async () => "unused",
                validateOutput: (output) => output,
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(HiddenAgentStepLimit);
        expect(getPromptFailureDetail(caught)).toMatchObject({
            failureClass: "step_limit",
            providerError: null,
        });
        expect(prompt).toHaveBeenCalledTimes(1);
    });

    test("surfaces a host-recorded assistant refusal even when the row has no text", async () => {
        const client = createClient(mock(async () => ({})));
        const refusal =
            "UnknownError: custody accounts exhausted: provider=synthetic accounts=main:cooldown";

        await expect(
            promptSyncWithValidatedOutputRetry(client, createArgs(), {
                fetchOutput: async () => [
                    {
                        info: {
                            role: "assistant",
                            time: { created: 1 },
                            finish: "stop",
                            tokens: { output: 0 },
                        },
                        parts: [],
                    },
                    {
                        info: { role: "assistant", time: { created: 2 }, error: refusal },
                        parts: [],
                    },
                ],
                validateOutput: () => {
                    throw new Error("empty_completion");
                },
            }),
        ).rejects.toMatchObject({
            message: `Host recorded assistant error: ${refusal}`,
            transient: true,
        });
    });

    test("keeps a real empty completion without an assistant error on the normal validation path", async () => {
        const client = createClient(mock(async () => ({})));
        await expect(
            promptSyncWithValidatedOutputRetry(client, createArgs(), {
                fetchOutput: async () => [{ info: { role: "assistant" }, parts: [] }],
                validateOutput: () => {
                    throw new Error("empty_completion");
                },
            }),
        ).rejects.toThrow("empty_completion");
    });
    test("valid first model returns without trying fallbacks", async () => {
        const prompt = mock(async () => ({}));
        const messages = mock(async () => "primary-output");
        const client = createClient(prompt, undefined, messages);

        const result = await promptSyncWithValidatedOutputRetry(client, createArgs(), {
            fallbackModels: ["anthropic/claude-sonnet-4-6"],
            fetchOutput: async () => messages(),
            validateOutput: (output: string) => {
                if (output.trim().length === 0) throw new Error("empty output");
                return output.trim();
            },
        });

        expect(result.validated).toBe("primary-output");
        expect(prompt).toHaveBeenCalledTimes(1);
        expect(messages).toHaveBeenCalledTimes(1);
    });

    test("preserves body.system when a failed Pi-shaped attempt mutates its body", async () => {
        const prompt = mock(async (args: PromptCall) => {
            if (prompt.mock.calls.length === 1) {
                // Reproduce a facade/SDK that consumes the request body before
                // rejecting the primary model. The fallback must not inherit
                // that mutation and spawn without its task prompt.
                delete args.body.system;
                throw new Error("primary failed");
            }
            return {};
        });
        const client = createClient(prompt);
        const systemPrompt = "CLASSIFY_SYSTEM_PROMPT";

        await promptSyncWithValidatedOutputRetry(
            client,
            {
                path: { id: "ses-classify" },
                body: {
                    agent: "dreamer-classifier",
                    system: systemPrompt,
                    parts: [{ type: "text", text: "classify" }],
                },
            },
            {
                fallbackModels: ["anthropic/claude-sonnet-4-6"],
                fetchOutput: async () => "fallback-output",
                validateOutput: (output: string) => output,
            },
        );

        expect(prompt).toHaveBeenCalledTimes(2);
        expect((prompt.mock.calls[0]?.[0] as PromptCall).body.system).toBeUndefined();
        expect((prompt.mock.calls[1]?.[0] as PromptCall).body.system).toBe(systemPrompt);
    });

    test("empty first model tries the next fallback", async () => {
        const prompt = mock(async () => ({}));
        const messages = mock(async () =>
            messages.mock.calls.length === 1 ? "" : "fallback-output",
        );
        const client = createClient(prompt, undefined, messages);

        const result = await promptSyncWithValidatedOutputRetry(client, createArgs(), {
            fallbackModels: ["anthropic/claude-sonnet-4-6"],
            fetchOutput: async () => messages(),
            validateOutput: (output: string, attempt) => {
                if (output.trim().length === 0)
                    throw new Error(`empty output from ${attempt.label}`);
                return output.trim();
            },
        });

        expect(result.validated).toBe("fallback-output");
        expect(prompt).toHaveBeenCalledTimes(2);
        expect(messages).toHaveBeenCalledTimes(2);
        expect((prompt.mock.calls[1]?.[0] as PromptCall).body.model).toEqual({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
        });
    });

    test("all empty outputs surface the last validation failure and every attempted model", async () => {
        const prompt = mock(async () => ({}));
        const messages = mock(async () => "");
        const client = createClient(prompt, undefined, messages);

        await expect(
            promptSyncWithValidatedOutputRetry(client, createArgs(), {
                fallbackModels: ["anthropic/claude-sonnet-4-6"],
                fetchOutput: async () => messages(),
                validateOutput: (output: string, attempt) => {
                    if (output.trim().length === 0) {
                        throw new Error(`empty output from ${attempt.label}`);
                    }
                    return output.trim();
                },
            }),
        ).rejects.toThrow(
            /All models exhausted \(primary, anthropic\/claude-sonnet-4-6\): empty output from anthropic\/claude-sonnet-4-6/,
        );

        expect(prompt).toHaveBeenCalledTimes(2);
        expect(messages).toHaveBeenCalledTimes(2);
    });
});

/**
 * Bun's fetch rejects with this exact object when its default request timer
 * fires on a plugin SDK request (the name is "TimeoutError", legacy code 23).
 * The dreamer ledger shows it as `TimeoutError message="The operation timed out." code=23`.
 */
function hostFetchTimeout(): Error {
    return new DOMException("The operation timed out.", "TimeoutError") as unknown as Error;
}

describe("host fetch TimeoutError is a timeout", () => {
    test("validated retry stops the chain, aborts the child, and reports provider_timeout", async () => {
        const prompt = mock(async () => {
            throw hostFetchTimeout();
        });
        const abort = mock(async () => ({}));
        const client = createClient(prompt, abort);

        let caught: unknown;
        try {
            await promptSyncWithValidatedOutputRetry(client, createArgs(), {
                fallbackModels: ["anthropic/claude-sonnet-4-6", "google/gemini-3-flash"],
                fetchOutput: async () => "unused",
                validateOutput: (output: string) => output,
            });
        } catch (error) {
            caught = error;
        }

        expect((caught as Error | undefined)?.name).toBe("TimeoutError");
        // Another model would be sent into the same still-running child session and
        // hit the same host timer, so the chain must stop at the first attempt.
        expect(prompt).toHaveBeenCalledTimes(1);
        expect(getPromptFailureDetail(caught)?.failureClass).toBe("provider_timeout");
        // The host loop keeps running after the client-side timer fires unless the
        // child is aborted explicitly.
        expect(abort).toHaveBeenCalledTimes(1);
        expect(abort.mock.calls[0]?.[0]).toEqual({ path: { id: "ses-test" } });
    });

    test("unvalidated retry stops the chain and aborts the child", async () => {
        const prompt = mock(async () => {
            throw hostFetchTimeout();
        });
        const abort = mock(async () => ({}));
        const client = createClient(prompt, abort);

        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), {
                fallbackModels: ["anthropic/claude-sonnet-4-6"],
            }),
        ).rejects.toThrow("The operation timed out.");

        expect(prompt).toHaveBeenCalledTimes(1);
        expect(abort).toHaveBeenCalledTimes(1);
    });

    test("an ordinary provider error still falls back and does not abort the child", async () => {
        const prompt = mock(async () => {
            if (prompt.mock.calls.length === 1) throw new Error("upstream 502");
            return {};
        });
        const abort = mock(async () => ({}));
        const client = createClient(prompt, abort);

        await promptSyncWithModelSuggestionRetry(client, createArgs(), {
            fallbackModels: ["anthropic/claude-sonnet-4-6"],
        });

        expect(prompt).toHaveBeenCalledTimes(2);
        expect(abort).not.toHaveBeenCalled();
    });
});

test("empty v1 and v2 replies report the provider finish reason", async () => {
    for (const output of [
        [{ info: { role: "assistant", finish: "stop" }, parts: [] }],
        { text: null, tokenLog: { finish_reason: "stop" } },
    ]) {
        const client = createClient(mock(async () => ({})));
        await expect(
            promptSyncWithValidatedOutputRetry(client, createArgs(), {
                fetchOutput: async () => output,
                validateOutput: () => {
                    throw new Error("map-memories returned no output");
                },
            }),
        ).rejects.toThrow("no output (finish=stop");
    }
});

test("DeepSeek unsupported-model 400 preserves provider status and message rather than no output", async () => {
    const message =
        "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4-flash";
    const client = createClient(mock(async () => ({})));
    let caught: unknown;
    try {
        await promptSyncWithValidatedOutputRetry(client, createArgs(), {
            fetchOutput: async () => [
                {
                    info: {
                        role: "assistant",
                        error: { name: "APIError", data: { statusCode: 400, message } },
                    },
                    parts: [],
                },
            ],
            validateOutput: () => {
                throw new Error("map-memories returned no output");
            },
        });
    } catch (error) {
        caught = error;
    }
    expect((caught as Error).message).toContain(message);
    expect((caught as Error).message).toContain("status=400");
    expect((caught as Error).message).not.toContain("no output");
    expect(getPromptFailureDetail(caught)).toMatchObject({ failureClass: "provider_error" });
});

test("timeout rejects an uncooperative carrier and aborts its child", async () => {
    const abort = mock(async () => ({}));
    const client = createClient(
        mock(() => new Promise(() => {})),
        abort,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await expect(
            Promise.race([
                promptSyncWithModelSuggestionRetry(client, createArgs(), { timeoutMs: 10 }),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error("carrier remained stuck")), 200);
                }),
            ]),
        ).rejects.toThrow("prompt timed out after 10ms");
        expect(abort).toHaveBeenCalledTimes(1);
    } finally {
        clearTimeout(timer);
    }
});

describe("first-output deadline", () => {
    const primary = { providerID: "opencode", modelID: "free-model" };
    type Behaviour = "silent" | "partial" | "answer" | "unmonitored";

    /**
     * A transport double that behaves per model. "silent" watches the child but the
     * model never answers; "partial" streams something and then hangs; "unmonitored"
     * hangs without ever reporting whether the model answered (the Pi and OpenCode 2
     * carriers); "answer" completes at once.
     */
    function modelTransport(behaviours: Record<string, Behaviour>) {
        const calls: Array<{ model: string; startedAt: number }> = [];
        const transport = Object.assign(
            async (request: PromptCall & { signal?: AbortSignal }) => {
                const model = request.body.model
                    ? `${request.body.model.providerID}/${request.body.model.modelID}`
                    : "primary";
                calls.push({ model, startedAt: Date.now() });
                const behaviour = behaviours[model] ?? "answer";
                if (behaviour === "answer") return;
                if (behaviour === "silent") noteModelActivityMonitored(request.signal);
                if (behaviour === "partial") noteModelOutputReceived(request.signal);
                await new Promise<void>((_resolve, reject) =>
                    request.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
                );
            },
            { childSessionId: "child-first-output" },
        );
        return { transport, calls };
    }

    async function run(
        behaviours: Record<string, Behaviour>,
        options: { timeoutMs: number; firstOutputTimeoutMs?: number; fallbackModels?: string[] },
    ) {
        const { transport, calls } = modelTransport(behaviours);
        const startedAt = Date.now();
        let caught: unknown;
        let result: Awaited<ReturnType<typeof promptSyncWithValidatedOutputRetry>> | undefined;
        try {
            result = await promptSyncWithValidatedOutputRetry(
                createClient(mock(async () => ({}))),
                createArgs(primary),
                {
                    transport: transport as never,
                    timeoutMs: options.timeoutMs,
                    ...(options.firstOutputTimeoutMs !== undefined
                        ? { firstOutputTimeoutMs: options.firstOutputTimeoutMs }
                        : {}),
                    fallbackModels: options.fallbackModels ?? ["anthropic/claude-sonnet-5-5"],
                    fetchOutput: async () => "<classify></classify>",
                    validateOutput: (output: string) => output,
                },
            );
        } catch (error) {
            caught = error;
        }
        return { result, caught, calls, elapsedMs: Date.now() - startedAt };
    }

    test("a primary that streams nothing by the deadline moves on to the fallback", async () => {
        const outcome = await run(
            { "opencode/free-model": "silent" },
            { timeoutMs: 2_000, firstOutputTimeoutMs: 40 },
        );
        expect(outcome.caught).toBeUndefined();
        expect(outcome.result?.attempt.label).toBe("anthropic/claude-sonnet-5-5");
        expect(outcome.calls.map((call) => call.model)).toEqual([
            "opencode/free-model",
            "anthropic/claude-sonnet-5-5",
        ]);
        // The silent primary was cut at its first-output deadline, not its timeout.
        expect(outcome.elapsedMs).toBeLessThan(1_000);
    });

    test("the unvalidated chain also moves on from a silent primary", async () => {
        const { transport, calls } = modelTransport({ "opencode/free-model": "silent" });
        await promptSyncWithModelSuggestionRetry(
            createClient(mock(async () => ({}))),
            createArgs(primary),
            {
                transport: transport as never,
                timeoutMs: 2_000,
                firstOutputTimeoutMs: 40,
                fallbackModels: ["anthropic/claude-sonnet-5-5"],
            },
        );
        expect(calls.map((call) => call.model)).toEqual([
            "opencode/free-model",
            "anthropic/claude-sonnet-5-5",
        ]);
    });

    test("a primary that produced output before timing out does not fall back", async () => {
        const outcome = await run(
            { "opencode/free-model": "partial" },
            { timeoutMs: 120, firstOutputTimeoutMs: 20 },
        );
        expect((outcome.caught as Error).message).toBe("prompt timed out after 120ms");
        expect(outcome.calls).toHaveLength(1);
        expect(getPromptFailureDetail(outcome.caught)?.failureClass).toBe("provider_timeout");
    });

    test("a silent primary's time comes out of the fallback's timeout", async () => {
        // The fallback is the last model, so it gets no first-output cut of its own;
        // its timeout is what the silent primary left of the overall 300 ms.
        const outcome = await run(
            { "opencode/free-model": "silent", "anthropic/claude-sonnet-5-5": "silent" },
            { timeoutMs: 300, firstOutputTimeoutMs: 100 },
        );
        const message = (outcome.caught as Error).message;
        const fallbackTimeoutMs = Number(/prompt timed out after (\d+)ms$/.exec(message)?.[1]);
        expect(outcome.calls).toHaveLength(2);
        expect(fallbackTimeoutMs).toBeLessThanOrEqual(200);
        expect(fallbackTimeoutMs).toBeGreaterThan(100);
        expect(outcome.elapsedMs).toBeLessThan(300 + 150);
    });

    test("the last model in the chain is never cut for silence", async () => {
        const outcome = await run(
            { "opencode/free-model": "silent" },
            { timeoutMs: 120, firstOutputTimeoutMs: 20, fallbackModels: [] },
        );
        expect((outcome.caught as Error).message).toBe("prompt timed out after 120ms");
        expect(outcome.calls).toHaveLength(1);
    });

    test("a transport that cannot see model output keeps the plain timeout", async () => {
        const outcome = await run(
            { "opencode/free-model": "unmonitored" },
            { timeoutMs: 120, firstOutputTimeoutMs: 20 },
        );
        expect((outcome.caught as Error).message).toBe("prompt timed out after 120ms");
        expect(outcome.calls).toHaveLength(1);
    });

    test("a caller without a first-output deadline keeps timeouts final", async () => {
        // The historian passes no first-output deadline: a silent model still ends
        // its chain at the timeout, exactly as before.
        const outcome = await run({ "opencode/free-model": "silent" }, { timeoutMs: 120 });
        expect((outcome.caught as Error).message).toBe("prompt timed out after 120ms");
        expect(outcome.calls).toHaveLength(1);
    });

    test("a caller without a first-output deadline still falls back on a provider failure", async () => {
        const prompt = mock(async (args: PromptCall) => {
            if (args.body.model?.providerID === "opencode")
                throw new Error("429 Too Many Requests: quota exceeded");
            return {};
        });
        const result = await promptSyncWithValidatedOutputRetry(
            createClient(prompt),
            createArgs(primary),
            {
                fallbackModels: ["anthropic/claude-sonnet-5-5"],
                fetchOutput: async () => "summary",
                validateOutput: (output: string) => output,
            },
        );
        expect(result.attempt.label).toBe("anthropic/claude-sonnet-5-5");
        expect(prompt).toHaveBeenCalledTimes(2);
    });
});
