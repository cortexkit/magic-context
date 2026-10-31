/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { acquireLease } from "../dreamer/lease";
import { getDreamTaskBacklog } from "../dreamer/task-gates";
import {
    ensureContextStoreUuid,
    installAuthorityManagedMarker,
} from "../legacy-authority-fixture.test-support";
import { getMemoryById, insertMemory, updateMemoryContent } from "../memory";
import { computeNormalizedHash } from "../memory/normalize-hash";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    applyCues,
    CHUNK_TIMEOUT_FLOOR_MS,
    type CompressCuesArgs,
    computeChunkSliceMs,
    runCompressCues,
} from "./compress-cues";
import { validateCue } from "./cue-validation";
import {
    computeCueContentHash,
    getMuralCueState,
    memoryNeedsCue,
    setMuralCue,
} from "./storage-mural-cues";

function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}

function successfulCueClient(onPrompt?: () => void) {
    let manifest = "";
    return {
        session: {
            create: async () => ({ data: { id: "cue-child" } }),
            prompt: async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                const prompt = args.body?.parts?.[0]?.text ?? "";
                const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
                manifest = `<cues>${ids.map((id) => `<cue id="${id}">anchor ${id}</cue>`).join("")}</cues>`;
                onPrompt?.();
                return {};
            },
            messages: async () => ({ data: assistantMessages(manifest) }),
            delete: async () => ({}),
        },
    };
}

/** A client whose prompt always fails with the exact timeout error that
 *  promptWithTimeout throws, so the chunk is classified as a timeout-class
 *  failure (the kind that trips the consecutive-timeout circuit breaker). */
function timeoutCueClient(onPrompt?: () => void) {
    return {
        session: {
            create: async () => ({ data: { id: "cue-child" } }),
            prompt: async () => {
                onPrompt?.();
                throw new Error("prompt timed out after 99997ms");
            },
            messages: async () => ({ data: [] }),
            delete: async () => ({}),
        },
    };
}

/** A client that repeats one candidate cue for every memory in the pool. */
function repeatingCueClient(cue: string) {
    let manifest = "";
    return {
        session: {
            create: async () => ({ data: { id: "cue-child" } }),
            prompt: async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                const prompt = args.body?.parts?.[0]?.text ?? "";
                const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
                manifest = `<cues>${ids.map((id) => `<cue id="${id}">${cue}</cue>`).join("")}</cues>`;
                return {};
            },
            messages: async () => ({ data: assistantMessages(manifest) }),
            delete: async () => ({}),
        },
    };
}

/** A client whose prompt succeeds but returns output with no <cues> manifest,
 *  so output validation fails. This is a VALIDATION-class failure (bad manifest),
 *  which must NOT trip the timeout breaker — every chunk is still attempted. */
function invalidOutputCueClient(onPrompt?: () => void) {
    return {
        session: {
            create: async () => ({ data: { id: "cue-child" } }),
            prompt: async () => {
                onPrompt?.();
                return {};
            },
            messages: async () => ({ data: assistantMessages("garbage without a cues root") }),
            delete: async () => ({}),
        },
    };
}

function providerFailureCueClient(onPrompt?: () => void) {
    return {
        session: {
            create: async () => ({ data: { id: "cue-child" } }),
            prompt: async () => {
                onPrompt?.();
                return {};
            },
            messages: async () => ({
                data: [
                    {
                        info: {
                            role: "assistant",
                            time: { created: Date.now() },
                            finish: "stop",
                            error: null,
                            tokens: { output: 8, reasoning: 0 },
                        },
                        parts: [{ type: "text", text: "All Antigravity endpoints failed" }],
                    },
                ],
            }),
            delete: async () => ({}),
        },
    };
}

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function cueRow(db: Database, id: number) {
    return db
        .prepare(
            "SELECT content, mural_cue, mural_cue_hash, mural_cue_at, updated_at FROM memories WHERE id = ?",
        )
        .get(id) as {
        content: string;
        mural_cue: string | null;
        mural_cue_hash: string | null;
        mural_cue_at: number | null;
        updated_at: number;
    };
}

function cueArgs(db: Database, projectIdentity: string): CompressCuesArgs {
    const holderId = "compress-holder";
    const leaseKey = `compress-${Math.random()}`;
    expect(acquireLease(db, holderId, leaseKey)).toBe(true);
    return {
        db,
        client: {} as never,
        projectIdentity,
        parentSessionId: "ses-parent",
        sessionDirectory: process.cwd(),
        holderId,
        leaseKey,
        // Comfortably above CHUNK_TIMEOUT_FLOOR_MS so the run loop actually
        // attempts chunks instead of stopping at the floor guard. Tests that
        // exercise the floor/deadline stops mutate this per case.
        deadline: Date.now() + 600_000,
    };
}

describe("timestamp-only cue freshness", () => {
    test("a timestamp-only write makes the gate due once and does not rewrite the cue", async () => {
        const db = freshDb();
        try {
            const project = "git:cue-timestamp-only";
            const text = "Keep the same memory text.";
            const memory = insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: text,
                sourceSessionId: "ses",
            });
            const cue = "kept cue";
            const hash = computeCueContentHash(text);
            db.prepare(
                `UPDATE memories
                    SET mural_cue = ?, mural_cue_hash = ?, mural_cue_at = ?, updated_at = ?
                  WHERE id = ?`,
            ).run(cue, hash, 10, 99, memory.id);
            expect(getDreamTaskBacklog(db, project, "compress-cues")).toEqual({
                pending: 1,
                total: 1,
            });

            const args = cueArgs(db, project);
            let prompted = 0;
            args.client = {
                session: {
                    create: async () => {
                        prompted += 1;
                        throw new Error("timestamp-only cue must not open a child");
                    },
                    prompt: async () => {
                        prompted += 1;
                        throw new Error("timestamp-only cue must not be recompressed");
                    },
                    messages: async () => ({ data: [] }),
                    delete: async () => ({}),
                },
            } as never;

            const result = await runCompressCues(args);
            expect(result).toMatchObject({ compressed: 0, complete: true, remaining: 0 });
            expect(prompted).toBe(0);
            expect(cueRow(db, memory.id)).toEqual({
                content: text,
                mural_cue: cue,
                mural_cue_hash: hash,
                mural_cue_at: 99,
                updated_at: 99,
            });
            expect(getDreamTaskBacklog(db, project, "compress-cues").pending).toBe(0);

            const again = await runCompressCues(args);
            expect(again.complete).toBe(true);
            expect(prompted).toBe(0);
            expect(cueRow(db, memory.id).mural_cue).toBe(cue);
            expect(getDreamTaskBacklog(db, project, "compress-cues").pending).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("a content change still produces a new cue", async () => {
        const db = freshDb();
        try {
            const project = "git:cue-content-changed";
            const previous = "The handler used the old name.";
            const edited = "The handler uses the new name.";
            const memory = insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: previous,
                sourceSessionId: "ses",
            });
            db.prepare(
                `UPDATE memories
                    SET content = ?, normalized_hash = ?, mural_cue = ?, mural_cue_hash = ?,
                        mural_cue_at = ?, updated_at = ?
                  WHERE id = ?`,
            ).run(
                edited,
                computeNormalizedHash(edited),
                "old cue",
                computeCueContentHash(previous),
                10,
                99,
                memory.id,
            );
            expect(getDreamTaskBacklog(db, project, "compress-cues").pending).toBe(1);

            const args = cueArgs(db, project);
            args.client = successfulCueClient() as never;
            const result = await runCompressCues(args);

            expect(result.compressed).toBe(1);
            const row = cueRow(db, memory.id);
            expect(row.mural_cue).toBe(`anchor ${memory.id}`);
            expect(row.mural_cue).not.toBe("old cue");
            expect(row.mural_cue_hash).toBe(computeCueContentHash(edited));
        } finally {
            closeQuietly(db);
        }
    });
});

describe("runCompressCues disposition", () => {
    test("compresses through the v2 executor without a v1 client", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:cues-v2";
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Cue fact.",
                sourceSessionId: "ses",
            });
            const args = cueArgs(db, projectIdentity);
            args.client = undefined;
            let opened = 0;
            let manifest = "";
            args.hiddenCompletionExecutor = {
                capabilities: { tools: false, harness: "opencode2" },
                open: async () => {
                    opened++;
                    return { id: "v2-cues" };
                },
                attempt: async (_handle, request) => {
                    const prompt = request.body?.parts?.[0]?.text ?? "";
                    const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) =>
                        Number(match[1]),
                    );
                    manifest = `<cues>${ids.map((id) => `<cue id="${id}">anchor ${id}</cue>`).join("")}</cues>`;
                },
                collect: async () => ({ text: manifest, reasoning: null, lengthCapped: false }),
                close: async () => {},
            } satisfies HiddenCompletionExecutor;
            const result = await runCompressCues(args);
            expect(opened).toBe(1);
            expect(result.compressed).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });
    test("banks a completed chunk and reports the deadline remainder", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:cues-deadline";
            for (let index = 0; index < 41; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Cue fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = cueArgs(db, projectIdentity);
            args.client = successfulCueClient(() => {
                args.deadline = Date.now() - 1;
            }) as never;

            const result = await runCompressCues(args);

            expect(result.compressed).toBe(40);
            expect(result.remaining).toBe(1);
            expect(result.complete).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("reports complete after fully draining the selected set", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:cues-complete";
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Cue fact.",
                sourceSessionId: "ses",
            });
            const args = cueArgs(db, projectIdentity);
            args.client = successfulCueClient() as never;

            const result = await runCompressCues(args);
            expect(result.compressed).toBe(1);
            expect(result.remaining).toBe(0);
            expect(result.complete).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("reports a swallowed chunk failure as incomplete", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:cues-failure";
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Cue fact.",
                sourceSessionId: "ses",
            });
            const args = cueArgs(db, projectIdentity);
            args.client = {
                session: {
                    create: async () => {
                        throw new Error("provider unavailable");
                    },
                },
            } as never;

            const result = await runCompressCues(args);
            expect(result.failure).toBeInstanceOf(Error);
            expect((result.failure as Error).message).toContain("provider unavailable");
            expect(result.failureStage).toBe("child-start");
            expect(result.complete).toBe(false);
            expect(result.remaining).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("stops banking progress when the remaining budget falls below the chunk floor", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:cues-floor-stop";
            for (let index = 0; index < 41; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Cue fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = cueArgs(db, projectIdentity);
            // First chunk succeeds and banks its 40 cues; the callback then drops
            // the deadline to a value that is still > 0 but below the chunk floor,
            // so the loop must stop at the floor guard (not the <= 0 guard) before
            // attempting chunk 2.
            args.client = successfulCueClient(() => {
                args.deadline = Date.now() + 60_000; // > 0, < CHUNK_TIMEOUT_FLOOR_MS
            }) as never;

            const result = await runCompressCues(args);

            expect(result.compressed).toBe(40);
            expect(result.remaining).toBe(1);
            expect(result.chunks).toBe(1);
            expect(result.complete).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    for (const hostTimeout of [false, true])
        test(
            hostTimeout
                ? "two consecutive host request timeouts trip the cue breaker"
                : "two consecutive chunk timeouts trip the breaker; the third chunk is never attempted",
            async () => {
                const db = freshDb();
                try {
                    const projectIdentity = "git:cues-breaker";
                    // 120 memories = exactly 3 chunks of 40.
                    for (let index = 0; index < 120; index += 1) {
                        insertMemory(db, {
                            projectPath: projectIdentity,
                            category: "ARCHITECTURE",
                            content: `Cue fact ${index}.`,
                            sourceSessionId: "ses",
                        });
                    }
                    const args = cueArgs(db, projectIdentity);
                    let promptCalls = 0;
                    args.client = timeoutCueClient(() => {
                        promptCalls += 1;
                        if (hostTimeout)
                            throw new DOMException("The operation timed out.", "TimeoutError");
                    }) as never;

                    const result = await runCompressCues(args);

                    // The breaker trips after the 2nd consecutive timeout, so chunk 3 is
                    // never attempted: exactly 2 prompt calls, not 3.
                    expect(promptCalls).toBe(2);
                    expect(result.chunks).toBe(2);
                    expect(result.compressed).toBe(0);
                    expect(result.remaining).toBe(120);
                    expect(result.complete).toBe(false);
                } finally {
                    closeQuietly(db);
                }
            },
        );

    test("provider-outage completion aborts remaining chunks after the model ladder", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:cues-provider-outage";
            for (let index = 0; index < 120; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Cue outage fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = cueArgs(db, projectIdentity);
            let promptCalls = 0;
            args.client = providerFailureCueClient(() => {
                promptCalls += 1;
            }) as never;
            args.fallbackModels = ["provider/fallback-one", "provider/fallback-two"];

            let thrown: unknown;
            try {
                await runCompressCues(args);
            } catch (error) {
                thrown = error;
            }

            expect(String(thrown)).toContain("provider-outage completion");
            expect(promptCalls).toBe(3);
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM memories WHERE project_path = ? AND mural_cue IS NOT NULL",
                    )
                    .get(projectIdentity),
            ).toEqual({ count: 0 });
        } finally {
            closeQuietly(db);
        }
    });

    test("validation failures do not trip the timeout breaker (every chunk still attempted)", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:cues-validation";
            for (let index = 0; index < 120; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Cue fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = cueArgs(db, projectIdentity);
            let promptCalls = 0;
            args.client = invalidOutputCueClient(() => {
                promptCalls += 1;
            }) as never;

            const result = await runCompressCues(args);

            // Bad-manifest (validation) failures keep the per-chunk retry-next-run
            // behavior: all 3 chunks are attempted, the run is not stopped early.
            expect(promptCalls).toBe(3);
            expect(result.chunks).toBe(3);
            expect(result.compressed).toBe(0);
            expect(result.complete).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("cue validation precision", () => {
    test("rejects only the memory's own id and accepts legitimate issue references", () => {
        expect(validateCue("leaked #123", 50, 123)?.reason).toBe("leaked-id");
        expect(validateCue("PR #21729 → issue #31638", 50, 123)).toBeNull();
        expect(validateCue("foreign #999", 50, 123)).toBeNull();
        expect(validateCue("embedded #1234", 50, 123)).toBeNull();
    });

    test("writes live-shaped PR and issue cues instead of retrying them", () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:cues-live-shape";
            const prMemory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "KNOWN_ISSUES",
                content: "PR #21729 tracks the parser fix.",
                sourceSessionId: "ses",
            });
            const issueMemory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "KNOWN_ISSUES",
                content: "Issue #31638 tracks the retry loop.",
                sourceSessionId: "ses",
            });
            const chunk = [
                { memory: prMemory, contentHash: computeCueContentHash(prMemory.content) },
                { memory: issueMemory, contentHash: computeCueContentHash(issueMemory.content) },
            ];
            const manifest = `<cues><cue id="${prMemory.id}">PR #21729 → parser fix</cue><cue id="${issueMemory.id}">issue #31638 → retry loop</cue></cues>`;

            expect(applyCues(cueArgs(db, projectIdentity), chunk, manifest)).toEqual({
                compressed: 2,
                skipped: 0,
            });
            expect(getMuralCueState(db, [prMemory.id]).get(prMemory.id)?.cue).toBe(
                "PR #21729 → parser fix",
            );
            expect(getMuralCueState(db, [issueMemory.id]).get(issueMemory.id)?.cue).toBe(
                "issue #31638 → retry loop",
            );
        } finally {
            closeQuietly(db);
        }
    });
});

describe("cue rejection latch", () => {
    test("falls back after three same-content rejections and completes the run", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:cues-latch";
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "KNOWN_ISSUES",
                content: "The repeater must remain stable for issue #31638.",
                importance: 90,
                sourceSessionId: "ses",
            });
            const overBudget = "x ".repeat(49);
            const client = repeatingCueClient(overBudget);

            const first = cueArgs(db, projectIdentity);
            first.client = client as never;
            const firstResult = await runCompressCues(first);
            expect(firstResult).toMatchObject({ compressed: 0, skipped: 1, remaining: 1 });

            const second = cueArgs(db, projectIdentity);
            second.client = client as never;
            const secondResult = await runCompressCues(second);
            expect(secondResult).toMatchObject({ compressed: 0, skipped: 1, remaining: 1 });

            const third = cueArgs(db, projectIdentity);
            third.client = client as never;
            const thirdResult = await runCompressCues(third);
            expect(thirdResult).toMatchObject({
                compressed: 1,
                skipped: 0,
                remaining: 0,
                complete: true,
            });

            const state = getMuralCueState(db, [memory.id]).get(memory.id);
            expect(state?.cue).toBeTruthy();
            expect(state?.cue).not.toContain(`#${memory.id}`);
            expect([...(state?.cue ?? "")].length).toBeLessThanOrEqual(90);
            expect(validateCue(state?.cue ?? "", 90, memory.id)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("content edits clear the rejection latch before the next attempt", () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:cues-latch-reset";
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "KNOWN_ISSUES",
                content: "Original issue #31638 content.",
                sourceSessionId: "ses",
            });
            const chunk = [{ memory, contentHash: computeCueContentHash(memory.content) }];
            const invalid = `<cues><cue id="${memory.id}">broken (</cue></cues>`;
            applyCues(cueArgs(db, projectIdentity), chunk, invalid);
            expect(getMuralCueState(db, [memory.id]).get(memory.id)?.rejectionCount).toBe(1);

            updateMemoryContent(
                db,
                memory.id,
                "Edited issue #31638 content.",
                computeNormalizedHash("Edited issue #31638 content."),
            );

            const state = getMuralCueState(db, [memory.id]).get(memory.id);
            expect(state?.cue).toBeNull();
            expect(state?.hash).toBeNull();
            expect(state?.rejectionCount ?? 0).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("computeChunkSliceMs (chunk time floor)", () => {
    test("applies the floor when the even split would be below it", () => {
        // 12 chunks of a 1_200s budget → even split 100s < 240s floor → floor wins.
        // This is the live failure shape: a 470-memory pool split into 12 chunks.
        expect(computeChunkSliceMs(1_200_000, 12)).toBe(CHUNK_TIMEOUT_FLOOR_MS);
    });

    test("uses the even split when it already exceeds the floor", () => {
        expect(computeChunkSliceMs(1_200_000, 2)).toBe(600_000);
    });

    test("never exceeds the remaining budget", () => {
        expect(computeChunkSliceMs(300_000, 1)).toBe(300_000);
    });
});

describe("mural cue storage", () => {
    test("setMuralCue writes cue + hash; getMuralCueState reads them back", () => {
        const db = freshDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:p",
                category: "ARCHITECTURE",
                content: "some fact",
                sourceSessionId: "s",
            });
            const hash = computeCueContentHash("some fact");
            setMuralCue(db, memory.projectPath, memory.id, "fact anchor", hash);
            const state = getMuralCueState(db, [memory.id]).get(memory.id);
            expect(state).toEqual({ cue: "fact anchor", hash });
        } finally {
            closeQuietly(db);
        }
    });

    test("writes only cue cache columns for an authority-managed memory", () => {
        const db = freshDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:managed-cues",
                category: "ARCHITECTURE",
                content: "authoritative content",
                sourceSessionId: "s",
            });
            const uuid = ensureContextStoreUuid(db);
            installAuthorityManagedMarker(db, memory.projectPath, uuid);

            const hash = computeCueContentHash(memory.content);
            expect(() =>
                setMuralCue(db, memory.projectPath, memory.id, "managed cue", hash),
            ).not.toThrow();
            expect(getMuralCueState(db, [memory.id]).get(memory.id)).toEqual({
                cue: "managed cue",
                hash,
            });

            expect(() =>
                db
                    .prepare("UPDATE memories SET content = ? WHERE id = ?")
                    .run("forbidden edit", memory.id),
            ).toThrow(/managed by the Rust module/i);
            expect(getMemoryById(db, memory.id)?.content).toBe("authoritative content");
        } finally {
            closeQuietly(db);
        }
    });

    test("memoryNeedsCue: NULL cue and stale-hash need compression, current does not", () => {
        expect(memoryNeedsCue(undefined, "x")).toBe(true);
        expect(memoryNeedsCue({ cue: null, hash: null }, "x")).toBe(true);
        expect(memoryNeedsCue({ cue: "c", hash: "stale" }, "x")).toBe(true);
        expect(memoryNeedsCue({ cue: "c", hash: computeCueContentHash("x") }, "x")).toBe(false);
    });

    test("editing a memory's content clears its stored cue", () => {
        const db = freshDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:p",
                category: "NAMING",
                content: "old content",
                sourceSessionId: "s",
            });
            setMuralCue(
                db,
                memory.projectPath,
                memory.id,
                "old cue",
                computeCueContentHash("old content"),
            );
            expect(getMuralCueState(db, [memory.id]).get(memory.id)?.cue).toBe("old cue");

            updateMemoryContent(db, memory.id, "new content", computeNormalizedHash("new content"));

            const state = getMuralCueState(db, [memory.id]).get(memory.id);
            expect(state?.cue).toBeNull();
            expect(state?.hash).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});

describe("applyCues (per-cue validation, skip-not-reject, hash-race)", () => {
    test("writes valid cues and skips invalid ones without rejecting the chunk", () => {
        const db = freshDb();
        try {
            const good = insertMemory(db, {
                projectPath: "git:p",
                category: "ARCHITECTURE",
                content: "good fact",
                sourceSessionId: "s",
            });
            const bad = insertMemory(db, {
                projectPath: "git:p",
                category: "CONSTRAINTS",
                content: "bad fact",
                sourceSessionId: "s",
            });
            const chunk = [
                { memory: good, contentHash: computeCueContentHash(good.content) },
                { memory: bad, contentHash: computeCueContentHash(bad.content) },
            ];
            // The bad cue is an unbalanced-parens violation → skipped, not fatal.
            const manifest = `<cues><cue id="${good.id}">good anchor</cue><cue id="${bad.id}">oops (unbalanced</cue></cues>`;
            const result = applyCues(cueArgs(db, "git:p"), chunk, manifest);
            expect(result.compressed).toBe(1);
            expect(result.skipped).toBe(1);
            // good got its cue; bad stayed NULL (retried next run).
            expect(getMuralCueState(db, [good.id]).get(good.id)?.cue).toBe("good anchor");
            expect(getMuralCueState(db, [bad.id]).get(bad.id)?.cue ?? null).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("stores the SELECTION-time content hash so an edit mid-run yields a stale (excluded) cue", () => {
        const db = freshDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:p",
                category: "ARCHITECTURE",
                content: "original content",
                sourceSessionId: "s",
            });
            // Candidate captured at selection time (hash of the ORIGINAL content).
            const chunk = [{ memory, contentHash: computeCueContentHash("original content") }];

            // The memory is edited AFTER selection but BEFORE the cue is applied.
            updateMemoryContent(
                db,
                memory.id,
                "edited content",
                computeNormalizedHash("edited content"),
            );

            const manifest = `<cues><cue id="${memory.id}">anchor from original</cue></cues>`;
            applyCues(cueArgs(db, "git:p"), chunk, manifest);

            // The stored hash is the ORIGINAL content's hash, which no longer
            // matches the current ("edited") content — so the cue is stale and
            // memoryNeedsCue re-selects it next run.
            const current = getMemoryById(db, memory.id)!;
            const state = getMuralCueState(db, [memory.id]).get(memory.id)!;
            expect(state.hash).toBe(computeCueContentHash("original content"));
            expect(state.hash).not.toBe(computeCueContentHash(current.content));
            expect(memoryNeedsCue(state, current.content)).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test.each([
        ["missing", (_id: number) => `<cues></cues>`, /missing id/],
        [
            "duplicate",
            (id: number) => `<cues><cue id="${id}">one</cue><cue id="${id}">two</cue></cues>`,
            /duplicate id/,
        ],
        [
            "foreign",
            (id: number) => `<cues><cue id="${id}">ok</cue><cue id="99999">stray</cue></cues>`,
            /unknown id/,
        ],
    ])("rejects %s manifest membership before writing", (_kind, manifestFor, error) => {
        const db = freshDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:p",
                category: "NAMING",
                content: "in chunk",
                sourceSessionId: "s",
            });
            const chunk = [{ memory, contentHash: computeCueContentHash(memory.content) }];

            expect(() => applyCues(cueArgs(db, "git:p"), chunk, manifestFor(memory.id))).toThrow(
                error,
            );
            expect(getMuralCueState(db, [memory.id]).get(memory.id)?.cue ?? null).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
