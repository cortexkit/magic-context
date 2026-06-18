import { describe, expect, mock, test } from "bun:test";

import { promptSyncWithModelSuggestionRetry } from "./model-suggestion-retry";

type PromptCall = {
    body: { model?: { providerID: string; modelID: string } };
    signal?: AbortSignal;
};

function createClient(prompt: ReturnType<typeof mock>, abort?: ReturnType<typeof mock>) {
    return {
        session: {
            prompt,
            abort: abort ?? mock(async () => ({})),
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

        setTimeout(() => controller.abort(), 10);
        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), { signal: controller.signal }),
        ).rejects.toThrow(/aborted by external signal/);
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

    // --- validateResponse: empty-response detection ---

    test("validateResponse: primary returns empty → fallback[0] succeeds", async () => {
        const prompt = mock(async () => ({})); // both succeed (HTTP 200)
        const client = createClient(prompt);
        const validate = mock(async () => {
            // primary attempt (call 1): empty → throw
            if (validate.mock.calls.length === 1) {
                throw new Error("empty response (0 tokens)");
            }
            // fallback attempt (call 2): non-empty → ok
        });

        await promptSyncWithModelSuggestionRetry(client, createArgs(), {
            fallbackModels: ["anthropic/claude-sonnet-4-6"],
            validateResponse: validate,
        });

        expect(prompt).toHaveBeenCalledTimes(2);
        expect(validate).toHaveBeenCalledTimes(2);
        expect((prompt.mock.calls[1]?.[0] as PromptCall).body.model).toEqual({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
        });
    });

    test("validateResponse: all attempts return empty → throws last error", async () => {
        const prompt = mock(async () => ({}));
        const client = createClient(prompt);
        const emptyError = new Error("empty response (0 tokens)");
        const validate = mock(async () => {
            throw emptyError;
        });

        await expect(
            promptSyncWithModelSuggestionRetry(client, createArgs(), {
                fallbackModels: ["anthropic/claude-sonnet-4-6", "google/gemini-3-flash"],
                validateResponse: validate,
            }),
        ).rejects.toBe(emptyError);

        expect(prompt).toHaveBeenCalledTimes(3); // primary + 2 fallbacks
        expect(validate).toHaveBeenCalledTimes(3);
    });

    test("validateResponse: primary non-empty → no fallback tried", async () => {
        const prompt = mock(async () => ({}));
        const client = createClient(prompt);
        const validate = mock(async () => {}); // always passes

        await promptSyncWithModelSuggestionRetry(client, createArgs(), {
            fallbackModels: ["anthropic/claude-sonnet-4-6"],
            validateResponse: validate,
        });

        expect(prompt).toHaveBeenCalledTimes(1);
        expect(validate).toHaveBeenCalledTimes(1);
    });

    test("validateResponse absent → backward compatible", async () => {
        const prompt = mock(async () => ({}));
        const client = createClient(prompt);

        await promptSyncWithModelSuggestionRetry(client, createArgs(), {
            fallbackModels: ["anthropic/claude-sonnet-4-6"],
            // no validateResponse — legacy behavior
        });

        expect(prompt).toHaveBeenCalledTimes(1);
    });
});
