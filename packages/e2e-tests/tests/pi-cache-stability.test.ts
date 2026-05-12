/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiTestHarness } from "../src/pi-harness";

interface HarnessOptions {
    magicContextConfig?: Record<string, unknown>;
    modelContextLimit?: number;
}

async function withPiHarness<T>(
    options: HarnessOptions,
    fn: (h: PiTestHarness) => Promise<T>,
): Promise<T> {
    const h = await PiTestHarness.create(options);
    try {
        return await fn(h);
    } finally {
        await h.dispose();
    }
}

function openWritableDb(h: PiTestHarness): Database {
    return new Database(h.contextDbPath(), { readwrite: true });
}

function readDb<T>(h: PiTestHarness, fn: (db: Database) => T): T {
    const db = new Database(h.contextDbPath(), { readonly: true });
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

function writeDb<T>(h: PiTestHarness, fn: (db: Database) => T): T {
    const db = openWritableDb(h);
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

function mainRequests(h: PiTestHarness) {
    return h.mock.requests().filter((request) => {
        const system = request.body.system;
        if (system === undefined || system === null) return false;
        const asString = typeof system === "string" ? system : JSON.stringify(system);
        return asString.includes("## Magic Context");
    });
}

function serialize(value: unknown): string {
    return JSON.stringify(value);
}

function requestMessages(request: { body: { messages?: unknown } }): unknown[] {
    return Array.isArray(request.body.messages) ? request.body.messages : [];
}

function firstUserMessage(request: { body: { messages?: unknown } }): unknown {
    return requestMessages(request).find(
        (message) =>
            message !== null &&
            typeof message === "object" &&
            (message as { role?: unknown }).role === "user",
    );
}

function maxTagNumber(h: PiTestHarness, sessionId: string): number {
    return readDb(h, (db) => {
        const row = db
            .prepare("SELECT COALESCE(MAX(tag_number), 0) AS n FROM tags WHERE session_id = ?")
            .get(sessionId) as { n: number } | null;
        return row?.n ?? 0;
    });
}

function queueDrop(h: PiTestHarness, sessionId: string, tagNumber: number): void {
    writeDb(h, (db) => {
        db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, 'pi')",
        ).run(sessionId, tagNumber, Date.now());
    });
}

describe("pi cache stability", () => {
    it("persists tag source_contents once with harness='pi' and keeps original unprefixed text", async () => {
        await withPiHarness({}, async (h) => {
            const original = "pi source persistence: keep this exact unprefixed user text";
            h.mock.setDefault({
                text: "first response",
                usage: { input_tokens: 120, output_tokens: 10, cache_creation_input_tokens: 120 },
            });

            const first = await h.sendPrompt(original, { timeoutMs: 60_000 });
            expect(first.exitCode).toBe(0);
            expect(first.sessionId).toBeTruthy();

            await h.waitFor(() => h.countTags(first.sessionId!) > 0, {
                label: "pi tags persisted",
            });

            const initial = readDb(h, (db) => {
                return db
                    .prepare(
                        `SELECT t.tag_number, t.harness AS tag_harness, s.content, s.harness AS source_harness, s.created_at
                         FROM tags t
                         JOIN source_contents s ON s.session_id = t.session_id AND s.tag_id = t.tag_number
                         WHERE t.session_id = ? AND t.type = 'message'
                         ORDER BY t.tag_number ASC
                         LIMIT 1`,
                    )
                    .get(first.sessionId!) as
                    | {
                          tag_number: number;
                          tag_harness: string;
                          source_harness: string;
                          content: string;
                          created_at: number;
                      }
                    | null;
            });
            expect(initial).not.toBeNull();
            expect(initial!.tag_harness).toBe("pi");
            expect(initial!.source_harness).toBe("pi");
            expect(initial!.content).toBe(original);
            expect(initial!.content).not.toContain("§");

            h.mock.setDefault({
                text: "second response",
                usage: { input_tokens: 125, output_tokens: 10, cache_creation_input_tokens: 125 },
            });
            const second = await h.sendPrompt("second pass retags prior content", {
                timeoutMs: 60_000,
                continueSession: true,
            });
            expect(second.exitCode).toBe(0);

            const after = readDb(h, (db) => {
                const count = db
                    .prepare(
                        "SELECT COUNT(*) AS n FROM source_contents WHERE session_id = ? AND tag_id = ?",
                    )
                    .get(first.sessionId!, initial!.tag_number) as { n: number } | null;
                const row = db
                    .prepare(
                        "SELECT content, harness, created_at FROM source_contents WHERE session_id = ? AND tag_id = ?",
                    )
                    .get(first.sessionId!, initial!.tag_number) as
                    | { content: string; harness: string; created_at: number }
                    | null;
                return { count: count?.n ?? 0, row };
            });
            expect(after.count).toBe(1);
            expect(after.row?.content).toBe(original);
            expect(after.row?.harness).toBe("pi");
            expect(after.row?.created_at).toBe(initial!.created_at);
        });
    }, 120_000);

    it("replays caveman-compressed text byte-identically from source_contents on defer passes", async () => {
        await withPiHarness(
            {
                magicContextConfig: {
                    ctx_reduce_enabled: false,
                    execute_threshold_percentage: 90,
                    experimental: {
                        caveman_text_compression: { enabled: true, min_chars: 40 },
                        auto_search: { enabled: false },
                        git_commit_indexing: { enabled: false },
                    },
                },
            },
            async (h) => {
                const largeOriginal =
                    "Pi caveman replay source. " +
                    "This sentence intentionally has many connective words and repeated structure so lite compression has material. ".repeat(
                        8,
                    );
                h.mock.setDefault({
                    text: "ok",
                    usage: { input_tokens: 80, output_tokens: 10, cache_creation_input_tokens: 80 },
                });

                const first = await h.sendPrompt(largeOriginal, { timeoutMs: 60_000 });
                expect(first.sessionId).toBeTruthy();
                await h.waitFor(() => h.countTags(first.sessionId!) > 0, { label: "tag ready" });

                const tagNumber = readDb(h, (db) => {
                    const row = db
                        .prepare(
                            "SELECT tag_number FROM tags WHERE session_id = ? AND type = 'message' ORDER BY tag_number ASC LIMIT 1",
                        )
                        .get(first.sessionId!) as { tag_number: number } | null;
                    return row?.tag_number ?? 0;
                });
                expect(tagNumber).toBeGreaterThan(0);

                // Simulate the execute pass that escalated this tag to lite/depth 2.
                // The assertion below verifies subsequent low-pressure Pi turns replay
                // from the pristine source row, not from already-compressed text.
                writeDb(h, (db) => {
                    db.prepare(
                        "UPDATE tags SET caveman_depth = 2 WHERE session_id = ? AND tag_number = ?",
                    ).run(first.sessionId!, tagNumber);
                });

                await h.sendPrompt("defer pass one after caveman", {
                    timeoutMs: 60_000,
                    continueSession: true,
                });
                const replayOne = firstUserMessage(mainRequests(h).at(-1)!);

                await h.sendPrompt("defer pass two after caveman", {
                    timeoutMs: 60_000,
                    continueSession: true,
                });
                const replayTwo = firstUserMessage(mainRequests(h).at(-1)!);

                expect(serialize(replayTwo)).toBe(serialize(replayOne));

                const source = readDb(h, (db) => {
                    const row = db
                        .prepare(
                            "SELECT content FROM source_contents WHERE session_id = ? AND tag_id = ?",
                        )
                        .get(first.sessionId!, tagNumber) as { content: string } | null;
                    return row?.content ?? "";
                });
                expect(source).toBe(largeOriginal);
            },
        );
    }, 180_000);

    it("materializes queued text drops only on an execute pass, preserving defer-pass prefix stability", async () => {
        await withPiHarness(
            {
                modelContextLimit: 200,
                magicContextConfig: { protected_tags: 1, execute_threshold_percentage: 20 },
            },
            async (h) => {
                h.mock.script([
                    {
                        text: "low pressure one",
                        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 10 },
                    },
                    {
                        text: "high pressure marker for next transform",
                        usage: { input_tokens: 150, output_tokens: 5, cache_creation_input_tokens: 150 },
                    },
                    {
                        text: "after materialization",
                        usage: { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 20 },
                    },
                ]);

                const firstText = "pi queued drop target should survive one defer pass";
                const first = await h.sendPrompt(firstText, { timeoutMs: 60_000 });
                expect(first.sessionId).toBeTruthy();
                await h.waitFor(() => h.countTags(first.sessionId!) > 0, { label: "tag ready" });
                queueDrop(h, first.sessionId!, 1);

                await h.sendPrompt("second turn stays defer and must not drain pending_ops", {
                    timeoutMs: 60_000,
                    continueSession: true,
                });
                expect(h.countPendingOps(first.sessionId!)).toBe(1);
                expect(JSON.stringify(h.mock.lastRequest()!.body)).toContain(firstText);
                expect(JSON.stringify(h.mock.lastRequest()!.body)).not.toContain("truncated §1§");

                await h.sendPrompt("third turn sees prior high usage and executes drops", {
                    timeoutMs: 60_000,
                    continueSession: true,
                });
                expect(h.countPendingOps(first.sessionId!)).toBe(0);
                expect(h.countDroppedTags(first.sessionId!)).toBeGreaterThanOrEqual(1);
                expect(JSON.stringify(h.mock.lastRequest()!.body)).toContain("truncated §1§");
            },
        );
    }, 180_000);

    it("keeps toolCall/toolResult pairing intact when a queued Pi tool drop materializes", async () => {
        await withPiHarness(
            {
                modelContextLimit: 200,
                magicContextConfig: { protected_tags: 1, execute_threshold_percentage: 20 },
            },
            async (h) => {
                const callId = "toolu_pi_pairing_cache_stability";
                h.mock.script([
                    {
                        content: [
                            {
                                type: "tool_use",
                                id: callId,
                                name: "ctx_search",
                                input: { query: "pi no result expected", limit: 1 },
                            },
                        ],
                        stop_reason: "tool_use",
                        usage: { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 20 },
                    },
                    {
                        text: "tool loop complete",
                        usage: { input_tokens: 30, output_tokens: 5, cache_creation_input_tokens: 30 },
                    },
                    {
                        text: "high usage before materialization",
                        usage: { input_tokens: 150, output_tokens: 5, cache_creation_input_tokens: 150 },
                    },
                    {
                        text: "after tool drop",
                        usage: { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 20 },
                    },
                ]);

                const first = await h.sendPrompt("call ctx_search once so Pi stores a tool pair", {
                    timeoutMs: 60_000,
                });
                expect(first.sessionId).toBeTruthy();

                const toolTag = await h.waitFor(
                    () =>
                        readDb(h, (db) => {
                            const row = db
                                .prepare(
                                    "SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number ASC LIMIT 1",
                                )
                                .get(first.sessionId!) as { tag_number: number } | null;
                            return row?.tag_number ?? 0;
                        }),
                    { label: "tool tag persisted" },
                );
                queueDrop(h, first.sessionId!, toolTag);

                await h.sendPrompt("record high usage for the next execute pass", {
                    timeoutMs: 60_000,
                    continueSession: true,
                });
                await h.sendPrompt("materialize the queued tool drop", {
                    timeoutMs: 60_000,
                    continueSession: true,
                });

                const body = JSON.stringify(h.mock.lastRequest()!.body);
                expect(body).toContain(callId);
                expect(body).toContain("__magic_context_dropped__");
                expect(body).toContain(`[dropped §${toolTag}§]`);

                const occurrences = body.split(callId).length - 1;
                expect(occurrences).toBeGreaterThanOrEqual(2);
            },
        );
    }, 180_000);

    it("keeps Pi system prompt bytes stable across unchanged defer turns", async () => {
        await withPiHarness(
            {
                magicContextConfig: { execute_threshold_percentage: 90 },
            },
            async (h) => {
                writeFileSync(
                    join(h.env.workdir, "ARCHITECTURE.md"),
                    "Pi cache-stability architecture note that should render consistently.",
                );
                h.mock.setDefault({
                    text: "ok",
                    usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
                });

                const first = await h.sendPrompt("system prompt stable turn 1", { timeoutMs: 60_000 });
                expect(first.sessionId).toBeTruthy();
                for (let i = 2; i <= 4; i++) {
                    await h.sendPrompt(`system prompt stable turn ${i}`, {
                        timeoutMs: 60_000,
                        continueSession: true,
                    });
                }

                const systems = mainRequests(h).map((request) => serialize(request.body.system));
                expect(systems.length).toBeGreaterThanOrEqual(4);
                expect(new Set(systems.slice(1)).size).toBe(1);
                expect(systems.at(-1)).toContain("<project-docs>");
                expect(systems.at(-1)).toContain("Pi cache-stability architecture note");
            },
        );
    }, 180_000);

    it("keeps prior Pi message prefix bytes stable across defer turns", async () => {
        await withPiHarness(
            {
                magicContextConfig: { execute_threshold_percentage: 90 },
            },
            async (h) => {
                h.mock.setDefault({
                    text: "ok",
                    usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
                });
                const first = await h.sendPrompt("prefix stable turn 1", { timeoutMs: 60_000 });
                expect(first.sessionId).toBeTruthy();
                for (let i = 2; i <= 5; i++) {
                    await h.sendPrompt(`prefix stable turn ${i}`, {
                        timeoutMs: 60_000,
                        continueSession: true,
                    });
                }

                const requests = mainRequests(h);
                expect(requests.length).toBeGreaterThanOrEqual(5);
                for (let i = 1; i < requests.length - 1; i++) {
                    const earlier = requestMessages(requests[i]!);
                    const later = requestMessages(requests[i + 1]!);
                    expect(earlier.length).toBeLessThanOrEqual(later.length);
                    // The newest user/assistant tail can legitimately gain fresh §N§ tags
                    // on the next Pi subprocess. The older prefix is the cache-sensitive
                    // part and should be byte-identical across defer passes.
                    const stablePrefixLength = Math.max(0, earlier.length - 2);
                    for (let j = 0; j < stablePrefixLength; j++) {
                        expect(serialize(later[j])).toBe(serialize(earlier[j]));
                    }
                }
            },
        );
    }, 180_000);

    it("resumes the tag counter from DB max across Pi --print restarts", async () => {
        await withPiHarness({}, async (h) => {
            h.mock.script([
                {
                    content: Array.from({ length: 49 }, (_, index) => ({
                        type: "text",
                        text: `assistant block ${index + 1} for tag counter restart coverage`,
                    })),
                    usage: { input_tokens: 120, output_tokens: 60, cache_creation_input_tokens: 120 },
                },
                {
                    text: "second response after many assistant blocks",
                    usage: { input_tokens: 120, output_tokens: 10, cache_creation_input_tokens: 120 },
                },
                {
                    text: "third response after restart",
                    usage: { input_tokens: 120, output_tokens: 10, cache_creation_input_tokens: 120 },
                },
            ]);

            const first = await h.sendPrompt("bootstrap tag counter restart coverage", {
                timeoutMs: 60_000,
            });
            expect(first.sessionId).toBeTruthy();

            await h.sendPrompt("second turn tags all prior assistant text blocks", {
                timeoutMs: 60_000,
                continueSession: true,
            });
            const beforeRestart = maxTagNumber(h, first.sessionId!);
            expect(beforeRestart).toBeGreaterThanOrEqual(50);

            await h.sendPrompt("third turn must allocate after the persisted max", {
                timeoutMs: 60_000,
                continueSession: true,
            });
            const afterRestart = maxTagNumber(h, first.sessionId!);
            expect(afterRestart).toBeGreaterThan(beforeRestart);
            expect(afterRestart).not.toBe(1);
        });
    }, 180_000);

    // FIXME(pi-cache-stability): expected to fail until Pi gets OpenCode v10-style
    // history injection cache parity for background publication during defer passes.
    it.skip("does not rebuild <session-history> after historian publishes during a defer pass", () => {});

    // FIXME(pi-cache-stability): pi --print exits immediately after the parent turn;
    // existing Pi smoke tests document that async historian completion is out of scope
    // for print-mode until Pi exposes a durable single-shot drain surface.
    it.skip("fires historian on commit cluster trigger and publishes harness='pi' compartments", () => {});

    // FIXME(pi-cache-stability): depends on the same print-mode historian child drain;
    // keep as durable coverage target for fallback model retry once that lands.
    it.skip("publishes historian output through fallback_models after primary 503", () => {});

    // FIXME(pi-cache-stability): Pi --print reloads the extension between user turns,
    // so in-memory adjunct caches do not currently preserve the design invariant that
    // ctx_memory writes wait for an explicit /ctx-flush before refreshing the system prompt.
    it.skip("refreshes system-prompt memory adjuncts only after explicit /ctx-flush", () => {});

    // FIXME(pi-cache-stability): sticky reminder anchor persistence is wired through
    // session_meta, but Pi --print cannot yet synthesize the exact multi-turn nudge
    // anchor/restart sequence without interactive process control.
    it.skip("keeps sticky reminder anchored at the same message across defer passes and restart", () => {});

    // FIXME(pi-cache-stability): native compaction is cancelled by session_before_compact,
    // but the current e2e harness has no hook to force Pi's native compact event in print mode.
    it.skip("cancels native Pi compaction and lets Magic Context own compaction", () => {});

    // FIXME(pi-cache-stability): requires reliable print-mode historian publication and
    // inspection of Pi's JSONL compaction entry after appendCompaction(...).
    it.skip("writes a Pi compaction marker at the historian boundary and resumes after it", () => {});

    // FIXME(pi-cache-stability): /ctx-aug subagent runs need a print-mode command/tool
    // harness that can wait for the child Pi process and inspect its session rows.
    it.skip("marks Pi subagents isolated and skips historian/project-docs/user-profile/key-files", () => {});

    // FIXME(pi-cache-stability): same subagent command harness gap as above; target is
    // cross-session memory visibility via ctx_search from a Pi subagent.
    it.skip("allows Pi subagents to search parent-written project memory", () => {});

    // FIXME(pi-cache-stability): simulating SIGKILL mid-historian in print mode currently
    // races Pi process shutdown; keep as the restart-recovery target for stale state cleanup.
    it.skip("clears stale compartment_in_progress after Pi restart", () => {});
});
