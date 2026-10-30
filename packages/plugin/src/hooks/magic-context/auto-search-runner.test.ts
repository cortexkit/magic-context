import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
    clearSessionMetaFixtureFault,
    rejectSessionMetaCollectionWrites,
} from "../../features/magic-context/__tests__/session-meta-faults";
import * as embedding from "../../features/magic-context/memory/embedding";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import * as storageMeta from "../../features/magic-context/storage-meta-persisted";
import { getAutoSearchHintDecisions } from "../../features/magic-context/storage-meta-persisted";
import { getUnpublishedAutoSearchNoHint } from "../../shared/auto-search-lifecycle";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    createAutoSearchReplayFixture,
    replayHint,
    replayPrompt,
    replayScenarios,
} from "./auto-search-replay.fixture";
import {
    _resetAutoSearchCache,
    clearAutoSearchForSession,
    runAutoSearchHint,
} from "./auto-search-runner";
import { autoSearchTestSnapshot } from "./auto-search-snapshot.fixture";
import * as searchModule from "./auto-search-worker-client";
import { injectM0M1, materializeM0 } from "./inject-compartments";
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

for (const host of ["opencode", "opencode2"] as const) {
    test(`unproven automatic recall keeps message/git results and drops memory/primer ${host}`, async () => {
        const fixture = createAutoSearchReplayFixture(host, "unproven-owner-cap");
        const state = autoSearchTestSnapshot(fixture.projectPath);
        const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue({
            ...state,
            gitCommitEnabled: true,
            features: { ...state.features, gitCommitEnabled: true },
        });
        const search = spyOn(searchModule, "searchAutoHint").mockResolvedValue([
            {
                source: "memory",
                memoryId: 777,
                category: "USER_DIRECTIVES",
                content: "owner-memory-secret payload",
                score: 1,
                matchType: "fts",
            },
            {
                source: "primer",
                primerId: 778,
                question: "owner-primer-secret",
                content: "owner-primer-secret answer",
                score: 1,
                support: 1,
                lastObservedAt: null,
                matchType: "fts",
            },
            {
                source: "message",
                messageId: "m-safe",
                messageOrdinal: 1,
                role: "user",
                content: "Cache ownership owner-message-key describes the earlier decision.",
                score: 0.95,
            },
            {
                source: "git_commit",
                sha: "a".repeat(40),
                shortSha: "aaaaaaa",
                author: null,
                committedAtMs: 1,
                content: "owner-git-key records the completed change.",
                score: 0.94,
                matchType: "fts",
            },
        ]);
        try {
            const messages = [makeUserMsg("owner-cap-user", replayPrompt)];
            await runAutoSearchHint({
                sessionId: fixture.sessionId,
                db: fixture.db,
                messages,
                options: {
                    enabled: true,
                    scoreThreshold: 0,
                    minPromptChars: 1,
                    projectPath: fixture.projectPath,
                    memoryOwnerUnavailable: true,
                },
            });
            const options = search.mock.calls[0]?.[4];
            expect(options?.memoryEnabled).toBe(false);
            expect(options?.gitCommitsEnabled).toBe(true);
            expect(options?.sources).toEqual(["message", "git_commit"]);
            const text = findUserPromptText(messages[0]);
            expect(text).toContain("owner-message-key");
            expect(text).toContain("owner-git-key");
            expect(text).not.toContain("owner-memory-secret");
            expect(text).not.toContain("owner-primer-secret");
        } finally {
            search.mockRestore();
            snapshot.mockRestore();
            fixture.close();
        }
    });

    test(`an ownerless turn keeps its captured empty hint across restart and later proof ${host}`, async () => {
        const fixture = createAutoSearchReplayFixture(host, "ownerless-empty-hint");
        const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(autoSearchTestSnapshot(fixture.projectPath));
        const search = spyOn(searchModule, "searchAutoHint").mockResolvedValue([replayHint]);
        try {
            const first = [makeUserMsg("ownerless-user", replayPrompt)];
            await runAutoSearchHint({ sessionId: fixture.sessionId, db: fixture.db, messages: first, options: {
                enabled: true, scoreThreshold: 0, minPromptChars: 1, memoryOwnerUnavailable: true,
            } });
            const captured = JSON.stringify(first);
            expect(captured).toBe(JSON.stringify([makeUserMsg("ownerless-user", replayPrompt)]));
            expect(search).not.toHaveBeenCalled();
            fixture.reopen();
            const proven = [makeUserMsg("ownerless-user", replayPrompt)];
            await runAutoSearchHint({ sessionId: fixture.sessionId, db: fixture.db, messages: proven, options: {
                enabled: true, scoreThreshold: 0, minPromptChars: 1, projectPath: fixture.projectPath,
            } });
            expect(JSON.stringify(proven)).toBe(captured);
            expect(search).not.toHaveBeenCalled();
        } finally {
            search.mockRestore(); snapshot.mockRestore(); fixture.close();
        }
    });

    for (const restart of [false, true]) {
        test(`a hint captured before owner proof stays byte-identical after proof restart=${restart} ${host}`, async () => {
            const fixture = createAutoSearchReplayFixture(host, `owner-proof-replay-${restart}`);
            const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
                autoSearchTestSnapshot(fixture.projectPath),
            );
            const search = spyOn(searchModule, "searchAutoHint").mockResolvedValue([
                {
                    source: "message",
                    content: "Cache ownership retains this captured decision.",
                    score: 0.95,
                    messageId: "owner-replay-result",
                    messageOrdinal: 1,
                    role: "user",
                },
            ]);
            try {
                const invoke = async (unproven: boolean) => {
                    const messages = [makeUserMsg("owner-proof-user", replayPrompt)];
                    await runAutoSearchHint({
                        sessionId: fixture.sessionId,
                        db: fixture.db,
                        messages,
                        options: {
                            enabled: true,
                            scoreThreshold: 0,
                            minPromptChars: 1,
                            projectPath: unproven ? fixture.projectPath : "pj-PROVEN-REPLAY",
                            memoryOwnerUnavailable: unproven,
                        },
                    });
                    return JSON.stringify(messages);
                };
                const captured = await invoke(true);
                expect(getAutoSearchHintDecisions(fixture.db, fixture.sessionId)[0]?.decision).toBe(
                    "hint",
                );
                expect(search).toHaveBeenCalledTimes(1);
                if (restart) fixture.reopen();
                search.mockResolvedValue([]);
                expect(await invoke(false)).toBe(captured);
                expect(search).toHaveBeenCalledTimes(1);
            } finally {
                search.mockRestore();
                snapshot.mockRestore();
                fixture.close();
            }
        });
    }

    test(`an existing memory hint replays unchanged when owner proof later becomes unavailable ${host}`, async () => {
        const fixture = createAutoSearchReplayFixture(host, "old-memory-owner-hint");
        const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
            autoSearchTestSnapshot(fixture.projectPath),
        );
        const search = spyOn(searchModule, "searchAutoHint").mockResolvedValue([
            {
                source: "memory",
                memoryId: 777,
                category: "USER_DIRECTIVES",
                content: "previously-captured-memory-marker stays in this hint.",
                score: 1,
                matchType: "fts",
            },
        ]);
        try {
            const first = [makeUserMsg("old-owner-hint", replayPrompt)];
            const options = {
                enabled: true,
                scoreThreshold: 0,
                minPromptChars: 1,
                projectPath: fixture.projectPath,
            };
            await runAutoSearchHint({
                sessionId: fixture.sessionId,
                db: fixture.db,
                messages: first,
                options,
            });
            const captured = JSON.stringify(first);
            expect(getAutoSearchHintDecisions(fixture.db, fixture.sessionId)[0]?.decision).toBe(
                "hint",
            );
            expect(captured).not.toBe(
                JSON.stringify([makeUserMsg("old-owner-hint", replayPrompt)]),
            );
            fixture.reopen();
            const replayed = [makeUserMsg("old-owner-hint", replayPrompt)];
            await runAutoSearchHint({
                sessionId: fixture.sessionId,
                db: fixture.db,
                messages: replayed,
                options: { ...options, projectPath: undefined, memoryOwnerUnavailable: true },
            });
            expect(JSON.stringify(replayed)).toBe(captured);
            expect(search).toHaveBeenCalledTimes(1);
        } finally {
            search.mockRestore();
            snapshot.mockRestore();
            fixture.close();
        }
    });
}

for (const host of ["opencode", "opencode2"] as const) {
    test(`review exception CAS failure still freezes served omission ${host}`, async () => {
        const fixture = createAutoSearchReplayFixture(host, "failed-omission-save");
        const { sessionId, projectPath } = fixture;
        const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
            autoSearchTestSnapshot(projectPath),
        );
        const search = spyOn(searchModule, "searchAutoHint")
            .mockResolvedValue([replayHint])
            .mockImplementationOnce(async () => {
                throw new Error("transient search failure");
            });
        const options = {
            enabled: true,
            projectPath,
            scoreThreshold: 0.6,
            minPromptChars: 12,
            memoryEnabled: true,
            embeddingEnabled: false,
        };
        const invoke = async (database = fixture.db, id = "served") => {
            const messages = [makeUserMsg(id, replayPrompt)];
            const outcome = await runAutoSearchHint({ db: database, sessionId, messages, options });
            return { bytes: JSON.stringify(messages[0]), outcome };
        };
        try {
            rejectSessionMetaCollectionWrites(
                fixture.db,
                "auto_search_hint_decisions",
                "review_fail_cas",
                { ignore: true },
            );
            const first = await invoke();
            expect(first.outcome).toEqual({ ok: false, kind: "cas-exhaustion" });
            expect(first.bytes).not.toContain("<ctx-search-hint>");
            expect(getAutoSearchHintDecisions(fixture.db, sessionId)).toEqual([]);
            clearAutoSearchForSession(sessionId);
            clearSessionMetaFixtureFault(fixture.db, "review_fail_cas");
            fixture.reopen(true);
            expect((await invoke()).bytes).toBe(first.bytes);
            expect(search).toHaveBeenCalledTimes(1);
            expect(getAutoSearchHintDecisions(fixture.db, sessionId)).toEqual([
                { messageId: "served", decision: "no-hint", reason: "error" },
            ]);
            expect(getUnpublishedAutoSearchNoHint(sessionId, "served")).toBeUndefined();
            rejectSessionMetaCollectionWrites(
                fixture.db,
                "auto_search_hint_decisions",
                "review_fail_cas",
                { ignore: true },
            );
            const failedHintSave = await invoke(fixture.db, "hint-save-failed");
            expect(failedHintSave.bytes).not.toContain("<ctx-search-hint>");
            expect((await invoke(fixture.db, "hint-save-failed")).bytes).toBe(failedHintSave.bytes);
            expect(search).toHaveBeenCalledTimes(2);
            expect(getUnpublishedAutoSearchNoHint(sessionId, "hint-save-failed")).toBe("error");
            clearSessionMetaFixtureFault(fixture.db, "review_fail_cas");
            expect((await invoke(fixture.db, "hint-save-failed")).bytes).toBe(failedHintSave.bytes);
            expect(getUnpublishedAutoSearchNoHint(sessionId, "hint-save-failed")).toBeUndefined();
            expect((await invoke(fixture.db, "new-user")).bytes).toContain(
                "Independent search-only hint",
            );
            expect(search).toHaveBeenCalledTimes(3);
        } finally {
            search.mockRestore();
            snapshot.mockRestore();
            fixture.close();
        }
    });
    test(`a busy store while saving the decision serves the turn plain instead of refusing it ${host}`, async () => {
        const fixture = createAutoSearchReplayFixture(host, "busy-decision-save");
        const { sessionId, projectPath } = fixture;
        const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
            autoSearchTestSnapshot(projectPath),
        );
        const search = spyOn(searchModule, "searchAutoHint").mockResolvedValue([replayHint]);
        const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        const append = spyOn(storageMeta, "appendAutoSearchHintDecision").mockImplementationOnce(
            () => {
                throw busy;
            },
        );
        const options = {
            enabled: true,
            projectPath,
            scoreThreshold: 0.6,
            minPromptChars: 12,
            memoryEnabled: true,
            embeddingEnabled: false,
        };
        const invoke = async () => {
            const messages = [makeUserMsg("busy", replayPrompt)];
            const outcome = await runAutoSearchHint({
                db: fixture.db,
                sessionId,
                messages,
                options,
            });
            return { bytes: JSON.stringify(messages[0]), outcome };
        };
        try {
            // Saving the auto-search decision hits a locked store. The pass still returns
            // the message, without a hint, and remembers the omission for a later save.
            const first = await invoke();
            expect(first.outcome).toEqual({ ok: false, kind: "storage-busy" });
            expect(first.bytes).not.toContain("<ctx-search-hint>");
            expect(getUnpublishedAutoSearchNoHint(sessionId, "busy")).toBe("error");
            // The next pass saves the served omission and keeps the bytes, even though
            // search would now return a hint.
            const second = await invoke();
            expect(second.bytes).toBe(first.bytes);
            expect(getUnpublishedAutoSearchNoHint(sessionId, "busy")).toBeUndefined();
            expect(getAutoSearchHintDecisions(fixture.db, sessionId)).toEqual([
                { messageId: "busy", decision: "no-hint", reason: "error" },
            ]);
            expect(search).toHaveBeenCalledTimes(1);
        } finally {
            append.mockRestore();
            search.mockRestore();
            snapshot.mockRestore();
            fixture.close();
        }
    });
    for (const scenario of replayScenarios) {
        test(`${host} search exception preserves served user bytes after ${scenario}`, async () => {
            const fixture = createAutoSearchReplayFixture(host, scenario);
            const { sessionId, projectPath } = fixture;
            const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
                autoSearchTestSnapshot(projectPath),
            );
            const search = spyOn(searchModule, "searchAutoHint")
                .mockResolvedValue([replayHint])
                .mockImplementationOnce(async () => {
                    throw new Error("transient search failure");
                });
            const options = {
                enabled: true,
                projectPath,
                scoreThreshold: 0.6,
                minPromptChars: 12,
                memoryEnabled: true,
                embeddingEnabled: false,
            };
            const invoke = async (id: string, answered = false) => {
                const messages = [makeUserMsg(id, replayPrompt)];
                if (answered) {
                    messages.push({
                        info: { id: "answer", role: "assistant" },
                        parts: [{ type: "text", text: "Answer" }],
                    } as MessageLike);
                }
                await runAutoSearchHint({ db: fixture.db, sessionId, messages, options });
                return JSON.stringify(messages[0]);
            };
            const pair = () => {
                const result = injectM0M1({
                    ...fixture.renderOptions(),
                    isCacheBustingPass: false,
                });
                return [result.m0Bytes?.toString("utf8"), result.m1Text];
            };
            try {
                materializeM0(fixture.renderOptions());
                const baseline = pair();
                expect(baseline[0]).toContain("Pair baseline distinct from hint.");
                const served = await invoke("u1");
                expect(served).not.toContain("<ctx-search-hint>");
                expect(pair()).toEqual(baseline);
                if (scenario === "revert") expect(await invoke("u1", true)).toBe(served);
                if (scenario === "reopen") fixture.reopen();
                if (scenario === "model fold") {
                    const fold = materializeM0(fixture.renderOptions("anthropic/other"));
                    expect(fold.snapshotMarkers.modelKey).toBe("anthropic/other");
                }
                expect(await invoke("u1")).toBe(served);
                expect(search).toHaveBeenCalledTimes(1);
                expect(getAutoSearchHintDecisions(fixture.db, sessionId)).toEqual([
                    { messageId: "u1", decision: "no-hint", reason: "error" },
                ]);
                expect(await invoke("u2")).toContain("Independent search-only hint");
                expect(search).toHaveBeenCalledTimes(2);
            } finally {
                search.mockRestore();
                snapshot.mockRestore();
                fixture.close();
            }
        });
    }
}

describe("auto-search-runner", () => {
    let snapshotSpy: ReturnType<typeof spyOn<typeof embedding, "getProjectEmbeddingSnapshot">>;
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
        snapshotSpy = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
            autoSearchTestSnapshot(baseOptions.projectPath),
        );
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        _resetAutoSearchCache();
    });

    afterEach(() => {
        _resetAutoSearchCache();
        snapshotSpy.mockRestore();
        closeQuietly(db);
    });

    test("caches no-hint decision on empty results so defer passes don't re-search", async () => {
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(async () => []);
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

    test("cold preparation is deferred and its late continuation never searches the skipped turn", async () => {
        snapshotSpy.mockReturnValue(null);
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(async () => []);
        let release: (() => void) | undefined;
        const preparation = new Promise<void>((resolve) => {
            release = resolve;
        });
        const messages = [makeUserMsg("u1", "What's the current status ?")];
        const before = JSON.stringify(messages);
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const pass = runAutoSearchHint({
            sessionId: "s1",
            db,
            messages,
            options: {
                ...baseOptions,
                directory: "/copied-project",
                ensureProjectRegistered: () => preparation,
            },
        });
        try {
            const outcome = await Promise.race([
                pass,
                new Promise<string>((resolve) => {
                    watchdog = setTimeout(() => resolve("watchdog"), 3500);
                }),
            ]);
            expect(outcome).toEqual({ ok: true });
            expect(JSON.stringify(messages)).toBe(before);
            release?.();
            await pass;
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(spy).toHaveBeenCalledTimes(0);
        } finally {
            release?.();
            await pass;
            if (watchdog) clearTimeout(watchdog);
            spy.mockRestore();
        }
    }, 6000);

    test("excludes Primers from transform-time auto-search hints", async () => {
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(async () => []);
        try {
            const messages: MessageLike[] = [
                makeUserMsg(
                    "u1",
                    "please explain how durable project primer questions are maintained",
                ),
            ];

            await runAutoSearchHint({
                sessionId: "s-primer-neutral",
                db,
                messages,
                options: baseOptions,
            });

            const options = spy.mock.calls[0]?.[4];
            expect(options?.sources).toEqual(["memory", "message", "git_commit"]);
        } finally {
            spy.mockRestore();
        }
    });

    test("caches no-hint decision on below-threshold score", async () => {
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
            async () =>
                [{ source: "memory", score: 0.4, id: 1, text: "x" }] as unknown as Awaited<
                    ReturnType<typeof searchModule.searchAutoHint>
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

    test("timeout path: returns without hanging transform and does NOT inject a hint", async () => {
        // Hanging search: never resolves.
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
            () =>
                new Promise(() => {}) as unknown as ReturnType<typeof searchModule.searchAutoHint>,
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
            // Timeout must not inject a hint into the user message.
            expect(findUserPromptText(messages[0])).not.toContain("<ctx-search-hint>");

            // A served timeout skip is sticky. Adding a hint on a later pass of
            // the same tail turn would rewrite bytes already sent to the provider.
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

    test("strips magic-context tag prefix, temporal markers, and system-reminder content before search", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
            async (_db, _s, _p, prompt) => {
                capturedPrompt = prompt;
                return [];
            },
        );
        try {
            // Note: <system-reminder> content is DROPPED entirely (depth-aware
            // parser — content is plugin/host noise, never user data).
            // Generic paired tags like <instruction> have their MARKUP stripped
            // but their TEXT CONTENT preserved (see the generic-XML test below)
            // because pasted user content in arbitrary tags can carry signal.
            const rawText = [
                "§12345§ <!-- +5m -->",
                "<system-reminder>CONTEXT REMINDER — 42%</system-reminder>",
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
            // Plugin-internal markers are gone.
            expect(capturedPrompt).not.toContain("§");
            expect(capturedPrompt).not.toContain("<!--");
            // system-reminder block and its content are gone.
            expect(capturedPrompt).not.toContain("<system-reminder>");
            expect(capturedPrompt).not.toContain("CONTEXT REMINDER");
        } finally {
            spy.mockRestore();
        }
    });

    /**
     * Regression for the nested-system-reminder leak observed in production.
     *
     * Live LMStudio embedding logs showed the orphan tail
     * `Please address this message and continue with your tasks.\n</system-reminder>`
     * arriving as the embedded query. Root cause: the previous non-greedy regex
     * matched from the OUTER open tag to the FIRST close tag (which was the
     * INNER one), leaving the outer close tag and the text between the inner
     * close and outer close as the "user prompt".
     *
     * The depth-aware parser must drop ALL nested system-reminder content,
     * keeping only text outside every level.
     */
    test("strips nested system-reminders without leaking the outer reminder's tail or close tag", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
            async (_db, _s, _p, prompt) => {
                capturedPrompt = prompt;
                return [];
            },
        );
        try {
            // Mirrors the real-world structure: outer reminder wrapping an
            // inner reminder whose content is a background-task notification,
            // followed by the outer reminder's "Please address..." tail.
            const rawText = [
                "actual user typed text before the noise",
                "<system-reminder>",
                "The user sent the following message:",
                "<system-reminder>",
                "[BACKGROUND TASK COMPLETED]",
                "**ID:** `bg_xyz`",
                "</system-reminder>",
                "",
                "Please address this message and continue with your tasks.",
                "</system-reminder>",
                "more user text after",
            ].join("\n");
            const messages: MessageLike[] = [makeUserMsg("u-nested", rawText)];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            // Both the inner reminder content AND the outer-reminder tail
            // ("Please address this message...") must be dropped. Only text
            // outside every reminder level survives.
            expect(capturedPrompt).not.toContain("Please address this message");
            expect(capturedPrompt).not.toContain("BACKGROUND TASK");
            expect(capturedPrompt).not.toContain("</system-reminder>");
            expect(capturedPrompt).not.toContain("<system-reminder>");
            expect(capturedPrompt).toContain("actual user typed text before the noise");
            expect(capturedPrompt).toContain("more user text after");
        } finally {
            spy.mockRestore();
        }
    });

    test("strips orphan system-reminder close tag (malformed input) without leaving it in the prompt", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
            async (_db, _s, _p, prompt) => {
                capturedPrompt = prompt;
                return [];
            },
        );
        try {
            // Malformed input: close tag with no matching open tag. The
            // depth-aware parser must drop it silently rather than leaving
            // it as embedded text.
            const rawText =
                "real user prompt</system-reminder> with a leftover close tag from a truncated parent";
            const messages: MessageLike[] = [makeUserMsg("u-orphan", rawText)];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            expect(capturedPrompt).not.toContain("</system-reminder>");
            expect(capturedPrompt).toContain("real user prompt");
            expect(capturedPrompt).toContain("leftover close tag from a truncated parent");
        } finally {
            spy.mockRestore();
        }
    });

    test("strips arbitrary XML/HTML tags and HTML comments (generic, not allowlisted) before embedding", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
            async (_db, _s, _p, prompt) => {
                capturedPrompt = prompt;
                return [];
            },
        );
        try {
            // Mix of plugin-known tags (instruction, ctx-search-hint),
            // plugin-unknown tags (custom-tag, deferred_notes), pasted code
            // markup (Component, props), comments with non-temporal content,
            // and self-closing tags. The generic stripper must remove all
            // tags while preserving any text between paired tags as data the
            // user typed.
            const rawText = [
                "<!-- arbitrary comment with note -->",
                '<instruction name="deferred_notes">You have 7 deferred notes.</instruction>',
                "<custom-tag>data the user wants embedded</custom-tag>",
                "real user question about <Component props={x} /> usage",
                "<some-future-marker/>",
                "after the markup",
            ].join("\n");
            const messages: MessageLike[] = [makeUserMsg("u-generic", rawText)];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            // All markup is gone…
            expect(capturedPrompt).not.toContain("<");
            expect(capturedPrompt).not.toContain(">");
            expect(capturedPrompt).not.toContain("<!--");
            expect(capturedPrompt).not.toContain("arbitrary comment");
            expect(capturedPrompt).not.toContain("deferred_notes");

            // …but text content between paired tags survives. We preserve
            // text between paired tags because real user paste (e.g. quoted
            // log output, code with type parameters) often contains useful
            // semantic content that the embedding should see.
            expect(capturedPrompt).toContain("You have 7 deferred notes");
            expect(capturedPrompt).toContain("data the user wants embedded");
            expect(capturedPrompt).toContain("real user question about");
            expect(capturedPrompt).toContain("usage");
            expect(capturedPrompt).toContain("after the markup");
        } finally {
            spy.mockRestore();
        }
    });

    test("preserves canonical whitespace bytes while sanitizing adversarial multi-part prompts", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
            async (_db, _s, _p, prompt) => {
                capturedPrompt = prompt;
                return [];
            },
        );
        try {
            const messages: MessageLike[] = [
                {
                    info: { id: "u-byte-parity", role: "user" },
                    parts: [
                        { type: "text", text: "§17§ alpha   beta\tgamma" },
                        {
                            type: "text",
                            text: "<system-reminder>drop <system-reminder>nested</system-reminder> tail</system-reminder>",
                        },
                        { type: "text", text: "<!-- hidden\ncomment -->" },
                        { type: "text", text: "<custom-tag>delta</custom-tag>" },
                        { type: "text", text: "" },
                        { type: "text", text: "omega  end" },
                    ],
                } as unknown as MessageLike,
            ];

            await runAutoSearchHint({
                sessionId: "s-byte-parity",
                db,
                messages,
                options: baseOptions,
            });

            expect(capturedPrompt).toBe("alpha   beta\tgamma\n\ndelta\n\nomega  end");
        } finally {
            spy.mockRestore();
        }
    });

    test("strips week-format temporal markers (+Xw / +Xw Yd) before embedding", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
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
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(async () => []);
        try {
            const messages: MessageLike[] = [
                makeUserMsg(
                    "u1",
                    [
                        "help me implement feature X in the plugin",
                        "",
                        "<ctx-search-auto>",
                        "relevant memories: transform pipeline",
                        "</ctx-search-auto>",
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
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
            (_db, _s, _p, _prompt, options) => {
                capturedSignal = (options as { signal?: AbortSignal } | undefined)?.signal;
                // Hang forever — simulates a stuck embedding fetch.
                return new Promise(() => {}) as unknown as ReturnType<
                    typeof searchModule.searchAutoHint
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
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(async () => []);
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

    test("skips ignored plugin-internal messages — does not embed announcements/warnings", async () => {
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(async () => []);
        try {
            // Mimic the startup announcement (or any sendIgnoredMessage payload) —
            // text part with `ignored: true`. These are persisted as ordinary
            // user-role messages but must NEVER reach the embedding endpoint.
            const announcement = {
                info: { id: "u_announcement", role: "user" },
                parts: [
                    {
                        type: "text",
                        text: "✨ Magic Context — what's new in v0.21.7:\n\n  • Pi parity sweep: 44 audit findings fixed, …",
                        ignored: true,
                    },
                ],
            } as unknown as MessageLike;
            const messages: MessageLike[] = [announcement];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            // No meaningful user message → no search call → no embedding hit.
            expect(spy).toHaveBeenCalledTimes(0);
        } finally {
            spy.mockRestore();
        }
    });

    test("ignored part next to a real user message: real prompt embedded, ignored text excluded", async () => {
        let capturedQuery: string | undefined;
        const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
            async (_db, _sessionId, _projectPath, query) => {
                capturedQuery = query as string;
                return [];
            },
        );
        try {
            // Realistic shape: an OpenCode user message can carry MULTIPLE parts.
            // If an upstream extension ever attaches an ignored notification part
            // alongside the real prompt, the embedded query must contain only the
            // real prompt — the ignored part must be excluded from `collectUserPromptParts`.
            const mixed = {
                info: { id: "u_mixed", role: "user" },
                parts: [
                    {
                        type: "text",
                        text: "✨ Magic Context — what's new: announcement bullet here",
                        ignored: true,
                    },
                    {
                        type: "text",
                        text: "please explain how the historian decides when to run",
                    },
                ],
            } as unknown as MessageLike;
            const messages: MessageLike[] = [mixed];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            expect(spy).toHaveBeenCalledTimes(1);
            expect(capturedQuery).toBeDefined();
            // The real prompt is in the embedded query…
            expect(capturedQuery ?? "").toContain("historian decides when to run");
            // …and the ignored announcement is NOT.
            expect(capturedQuery ?? "").not.toContain("Magic Context");
            expect(capturedQuery ?? "").not.toContain("announcement bullet");
        } finally {
            spy.mockRestore();
        }
    });
});
