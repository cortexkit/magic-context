import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as searchModule from "../../features/magic-context/search";
import { Database } from "../../shared/sqlite";
import { _resetAutoSearchCache, runAutoSearchHint } from "./auto-search-runner";
import type { MessageLike } from "./transform-operations";

function makeUserMsg(id: string, text: string): MessageLike {
    return {
        info: { id, role: "user" },
        parts: [{ type: "text", text }],
    } as unknown as MessageLike;
}

function findUserPromptText(msg: MessageLike): string {
    let out = "";
    for (const part of msg.parts) {
        const p = part as { type?: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") {
            out += (out ? "\n" : "") + p.text;
        }
    }
    return out;
}

describe("auto-search-runner", () => {
    let db: Database;
    const baseOptions = {
        enabled: true,
        scoreThreshold: 0.6,
        minPromptChars: 20,
        projectPath: "git:test",
        memoryEnabled: true,
        embeddingEnabled: true,
        gitCommitsEnabled: true,
    };

    beforeEach(() => {
        db = new Database(":memory:");
        _resetAutoSearchCache();
    });

    afterEach(() => {
        _resetAutoSearchCache();
    });

    test("caches no-hint decision on empty results so defer passes don't re-search", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => []);
        try {
            const messages: MessageLike[] = [
                makeUserMsg("u1", "please explain how the historian decides when to run"),
            ];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            // Three passes on the same user message id → exactly one search call.
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }
    });

    test("caches no-hint decision on below-threshold score", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async () =>
                [{ source: "memory", score: 0.4, id: 1, text: "x" }] as unknown as Awaited<
                    ReturnType<typeof searchModule.unifiedSearch>
                >,
        );
        try {
            const messages: MessageLike[] = [
                makeUserMsg("u1", "please explain how the historian decides when to run"),
            ];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            expect(spy).toHaveBeenCalledTimes(1);
            expect(findUserPromptText(messages[0])).not.toContain("<ctx-search-hint>");
        } finally {
            spy.mockRestore();
        }
    });

    test("timeout path: caches skip and returns without hanging transform", async () => {
        // Hanging search: never resolves.
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            () => new Promise(() => {}) as unknown as ReturnType<typeof searchModule.unifiedSearch>,
        );
        try {
            const messages: MessageLike[] = [
                makeUserMsg("u1", "a long enough prompt to pass the minPromptChars gate"),
            ];

            const started = Date.now();
            const runPromise = runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            const outerCap = new Promise<"cap">((resolve) =>
                setTimeout(() => resolve("cap"), 5_000),
            );
            const winner = await Promise.race([runPromise.then(() => "done" as const), outerCap]);
            const elapsed = Date.now() - started;

            expect(winner).toBe("done");
            // Must complete within the 3s AUTO_SEARCH_TIMEOUT_MS + some slack.
            expect(elapsed).toBeLessThan(4_000);

            // Second pass on the same message id must be cached (no new search call).
            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            expect(spy).toHaveBeenCalledTimes(1);
            expect(findUserPromptText(messages[0])).not.toContain("<ctx-search-hint>");
        } finally {
            spy.mockRestore();
        }
    }, 10_000);

    test("strips magic-context tag prefix, temporal markers, and system-reminder before search", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async (_db, _s, _p, prompt) => {
                capturedPrompt = prompt;
                return [];
            },
        );
        try {
            const rawText = [
                "§12345§ <!-- +5m -->",
                "<system-reminder>CONTEXT REMINDER — 42%</system-reminder>",
                '<instruction name="ctx_reduce_turn_cleanup">drop stuff</instruction>',
                "this is the actual user prompt text that should be embedded",
            ].join("\n");
            const messages: MessageLike[] = [makeUserMsg("u1", rawText)];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            expect(capturedPrompt).toBe(
                "this is the actual user prompt text that should be embedded",
            );
            expect(capturedPrompt).not.toContain("§");
            expect(capturedPrompt).not.toContain("<!--");
            expect(capturedPrompt).not.toContain("<system-reminder>");
            expect(capturedPrompt).not.toContain("<instruction");
        } finally {
            spy.mockRestore();
        }
    });

    test("strips week-format temporal markers (+Xw / +Xw Yd) before embedding", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async (_db, _s, _p, prompt) => {
                capturedPrompt = prompt;
                return [];
            },
        );
        try {
            const rawText = [
                "<!-- +1w -->",
                "<!-- +2w 3d -->",
                "what are the plans for historian v3 this quarter",
            ].join("\n");
            const messages: MessageLike[] = [makeUserMsg("u1", rawText)];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            expect(capturedPrompt).toBe("what are the plans for historian v3 this quarter");
            expect(capturedPrompt).not.toContain("+1w");
            expect(capturedPrompt).not.toContain("+2w");
            expect(capturedPrompt).not.toContain("<!--");
        } finally {
            spy.mockRestore();
        }
    });

    test("skips suppressed context (existing augmentation) without running search", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => []);
        try {
            const messages: MessageLike[] = [
                makeUserMsg(
                    "u1",
                    [
                        "help me implement feature X in the plugin",
                        "",
                        "<sidekick-augmentation>",
                        "relevant memories: transform pipeline",
                        "</sidekick-augmentation>",
                    ].join("\n"),
                ),
            ];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            // Existing augmentation block present → suppressed → no search call.
            // This is the regression for the dead isSuppressedContext bug: the
            // check used to run on post-stripped text (where the tag is already
            // gone) and would never suppress. Now it runs on raw parts.
            expect(spy).toHaveBeenCalledTimes(0);

            // Second pass on same message still doesn't search — skip is cached.
            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            expect(spy).toHaveBeenCalledTimes(0);
        } finally {
            spy.mockRestore();
        }
    });

    test("timeout triggers AbortSignal so underlying search can cancel in-flight work", async () => {
        let capturedSignal: AbortSignal | undefined;
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            (_db, _s, _p, _prompt, options) => {
                capturedSignal = (options as { signal?: AbortSignal } | undefined)?.signal;
                // Hang forever — simulates a stuck embedding fetch.
                return new Promise(() => {}) as unknown as ReturnType<
                    typeof searchModule.unifiedSearch
                >;
            },
        );
        try {
            const messages: MessageLike[] = [
                makeUserMsg("u1", "a long enough prompt to pass the minPromptChars gate"),
            ];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            expect(capturedSignal).toBeDefined();
            // After the 3s timeout fires, the controller is aborted.
            expect(capturedSignal?.aborted).toBe(true);
        } finally {
            spy.mockRestore();
        }
    }, 10_000);

    test("caches skip when prompt is shorter than minPromptChars", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => []);
        try {
            const messages: MessageLike[] = [makeUserMsg("u1", "short")];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            // Never calls search for too-short prompts, and caches the skip.
            expect(spy).toHaveBeenCalledTimes(0);
        } finally {
            spy.mockRestore();
        }
    });
});
