/// <reference types="bun-types" />

/**
 * Work bounds for the entry digest cache: an ordinary pass flattens and hashes
 * only new or changed messages however large the session is, and two large
 * sessions served alternately keep their retained entries instead of evicting
 * each other.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { captureLkgSlot, createLkgEntryProjector, projectLkgEntry, replayLkg } from "./lkg-replay";
import {
    captureSlot,
    getLkgEntryWorkForTest,
    LkgEntryDigestCache,
    type LkgEntryWork,
    lkgContentDigest,
    lkgContentFields,
    noteEntry,
    resetLkgSlotsForTest,
} from "./lkg-slot";
import type { MessageLike } from "./transform-operations";

function message(session: string, index: number, chars: number): MessageLike {
    return {
        info: { id: `${session}-${String(index).padStart(6, "0")}`, role: "assistant" } as never,
        parts: [
            { type: "text", text: `${session} ${index}` },
            {
                type: "tool",
                callID: `${session}-call-${index}`,
                state: {
                    status: "completed",
                    input: { path: `src/${index}.ts` },
                    output: `${session} ${index} `.padEnd(chars, "line of source\n"),
                },
            },
        ],
    };
}

function history(session: string, length: number, chars: number): MessageLike[] {
    return Array.from({ length }, (_, index) => message(session, index, chars));
}

/** Fresh objects and strings with the same content, as OpenCode 1 gives by reloading the session from its database for every request. */
function reloaded(messages: MessageLike[]): MessageLike[] {
    return JSON.parse(JSON.stringify(messages)) as MessageLike[];
}

function workDuring(run: () => void): LkgEntryWork {
    const before = getLkgEntryWorkForTest();
    run();
    const after = getLkgEntryWorkForTest();
    return Object.fromEntries(
        Object.entries(after).map(([key, value]) => [
            key,
            value - before[key as keyof LkgEntryWork],
        ]),
    ) as unknown as LkgEntryWork;
}

function stringChars(value: MessageLike): number {
    return (lkgContentFields(value) ?? []).reduce<number>(
        (sum, field) => sum + (typeof field === "string" ? field.length : 0),
        0,
    );
}

describe("entry digest cache work per pass", () => {
    beforeEach(() => resetLkgSlotsForTest());

    it("flattens and hashes only the appended messages, whatever the session size", () => {
        const appendedWork = (length: number) => {
            resetLkgSlotsForTest();
            const project = createLkgEntryProjector();
            const base = history("s", length, 20_000);
            project("s", reloaded(base));
            const next = [...base, message("s", length, 20_000), message("s", length + 1, 20_000)];
            const served = reloaded(next);
            let digests: (string | null)[] = [];
            const work = workDuring(() => {
                digests = project("s", served).map((entry) => entry.contentDigest?.() ?? null);
            });
            expect(digests).toEqual(served.map((entry) => lkgContentDigest(entry)));
            return {
                flattenedMessages: work.flattenedMessages,
                hashedMessages: work.hashedMessages,
                flattenedChars: work.flattenedChars,
            };
        };
        const appendedChars =
            stringChars(message("s", 40, 20_000)) + stringChars(message("s", 41, 20_000));
        const small = appendedWork(40);
        // Same appended messages (their ids and content depend only on the index).
        const large = appendedWork(400);
        expect(small).toEqual({
            flattenedMessages: 2,
            hashedMessages: 2,
            flattenedChars: appendedChars,
        });
        expect(large.flattenedMessages).toBe(2);
        expect(large.hashedMessages).toBe(2);
        expect(large.flattenedChars).toBe(
            stringChars(message("s", 400, 20_000)) + stringChars(message("s", 401, 20_000)),
        );
    });

    it("projects without hashing after the messages handler noted the same pass's entry", () => {
        const project = createLkgEntryProjector();
        const base = history("s", 30, 5_000);
        project("s", reloaded(base));
        // A slot anchored early, so most of the input lies after the anchor.
        captureSlot("s", {
            jsonPrefix: "[]",
            inputIdSeq: [],
            inputContentDigests: [],
            lastInputMessageId: (base[2]?.info as { id: string }).id,
            modelKey: null,
            providerKey: null,
            capturedAt: 1,
        });
        const served = reloaded([...base, message("s", 30, 5_000)]);
        const noted = workDuring(() => noteEntry("s", served));
        expect(noted.hashedMessages).toBe(1);
        const projected = workDuring(() => project("s", served));
        expect(projected.hashedMessages).toBe(0);
        expect(projected.flattenedMessages).toBe(0);
    });

    it("neither digests nor invalidates a replay for a tool-metadata-only change", () => {
        // An edit tool part carrying about 1 MB of workspace diagnostics, which
        // the provider never receives, followed by the newest user message.
        const turn = (diagnosticsText: string, errorOutput = "partial"): MessageLike[] => [
            {
                info: { id: "u1", role: "user", time: { created: 1 } } as never,
                parts: [{ type: "text", text: "fix it" }],
            },
            {
                info: {
                    id: "a1",
                    role: "assistant",
                    time: { created: 2 },
                    finish: "stop",
                } as never,
                parts: [
                    {
                        type: "tool",
                        callID: "call-edit",
                        tool: "edit",
                        state: {
                            status: "completed",
                            input: { filePath: "/repo/a.ts" },
                            output: "Edit applied successfully.",
                            title: "a.ts",
                            time: { start: 3, end: 4 },
                            metadata: {
                                diagnostics: Object.fromEntries(
                                    Array.from({ length: 2_000 }, (_, file) => [
                                        `/repo/src/f${file}.ts`,
                                        [{ line: file, message: diagnosticsText.repeat(10) }],
                                    ]),
                                ),
                            },
                        },
                    },
                    {
                        type: "tool",
                        callID: "call-sleep",
                        tool: "bash",
                        state: {
                            status: "error",
                            input: { command: "sleep 9" },
                            error: "aborted",
                            metadata: { interrupted: true, output: errorOutput },
                        },
                    },
                ],
            },
            {
                info: { id: "u2", role: "user", time: { created: 5 } } as never,
                parts: [{ type: "text", text: "next" }],
            },
        ];
        const project = createLkgEntryProjector();
        const first = turn("Cannot find name 'x'. ");
        const firstWork = workDuring(() => {
            expect(
                captureLkgSlot({
                    sessionId: "s",
                    input: project("s", first),
                    output: first,
                    modelKey: "m/m",
                    providerKey: "m",
                    capturedAt: 1,
                }),
            ).toBe(true);
        });
        // The diagnostics were never flattened, even on the first pass.
        expect(firstWork.flattenedChars).toBeLessThan(1_000);
        const changed = turn("Property 'y' does not exist. ");
        const work = workDuring(() => {
            expect(project("s", changed).map((entry) => entry.contentDigest?.())).toEqual(
                project("s", first).map((entry) => entry.contentDigest?.()),
            );
        });
        expect(work.hashedMessages).toBe(0);
        expect(work.comparedChars).toBeLessThan(1_000);
        const replay = replayLkg({
            sessionId: "s",
            messages: changed,
            modelKey: "m/m",
            providerKey: "m",
        });
        expect(replay.ok).toBe(true);

        // An interrupted call's output is provider-visible: it is digested and
        // refuses a replay of the old bytes.
        const interrupted = turn("Property 'y' does not exist. ", "partial, then more");
        const visibleWork = workDuring(() => project("s", interrupted));
        expect(visibleWork.hashedMessages).toBe(1);
        expect(
            replayLkg({ sessionId: "s", messages: interrupted, modelKey: "m/m", providerKey: "m" }),
        ).toEqual({ ok: false, reason: "lkg_content_mismatch" });
    });

    it("hashes a message served again as the same object after an in-place edit", () => {
        const project = createLkgEntryProjector();
        const served = history("s", 20, 1_000);
        project("s", served);
        const state = (served[3]?.parts[1] as { state: { output: string } }).state;
        // Same length, same object: neither the identity nor the size reveals the edit.
        state.output = `X${state.output.slice(1)}`;
        let digests: (string | null)[] = [];
        const work = workDuring(() => {
            digests = project("s", served).map((entry) => entry.contentDigest?.() ?? null);
        });
        expect(work.hashedMessages).toBe(1);
        expect(digests).toEqual(projectLkgEntry(served).map((entry) => entry.contentDigest?.()));
    });

    it("keeps two sessions over half of the old 64 MiB budget resident when they alternate", () => {
        // About 36 MB of estimated retained bytes per session: each alone was over
        // half of the old shared budget, so each store evicted the other session.
        const sessions = [history("a", 18, 1_000_000), history("b", 18, 1_000_000)];
        let reused = 0;
        let retained = 0;
        const project = createLkgEntryProjector({
            onReuse: (stats) => {
                reused = stats.reused;
                retained = stats.retained;
            },
        });
        for (let pass = 0; pass < 3; pass += 1) {
            for (const [index, current] of sessions.entries()) {
                const work = workDuring(() => project(index ? "b" : "a", reloaded(current)));
                if (pass === 0) continue;
                expect({ pass, index, reused, retained, hashed: work.hashedMessages }).toEqual({
                    pass,
                    index,
                    reused: 18,
                    retained: 18,
                    hashed: 0,
                });
            }
        }
    });

    it("trims sessions to a fair share when another joins, and never exceeds the ceiling", () => {
        const cache = new LkgEntryDigestCache({
            sessionMaxBytes: 2_000_000,
            totalMaxBytes: 3_000_000,
            maxSessions: 16,
        });
        // About 1.4 MB of estimated bytes per session (70 messages of about 20 KB).
        const sessions = ["a", "b", "c"].map((name) => history(name, 70, 10_000));
        const reusedBySession = new Map<number, number[]>();
        for (let pass = 0; pass < 4; pass += 1) {
            for (const [index, current] of sessions.entries()) {
                const { digests, stats } = cache.digests(String(index), reloaded(current));
                expect(digests).toEqual(current.map((entry) => lkgContentDigest(entry)));
                const totals = cache.stats();
                expect(totals.totalBytes).toBeLessThanOrEqual(3_000_000);
                expect(totals.sessions.reduce((sum, item) => sum + item.bytes, 0)).toBe(
                    totals.totalBytes,
                );
                if (pass > 0) {
                    reusedBySession.set(index, [
                        ...(reusedBySession.get(index) ?? []),
                        stats.reused,
                    ]);
                }
            }
        }
        // All three sessions stay resident at a third of the ceiling each, so every
        // later pass reuses that share instead of starting from nothing.
        expect(cache.stats().sessions.map((item) => item.sessionId)).toEqual(["0", "1", "2"]);
        for (const reused of reusedBySession.values()) {
            for (const count of reused) expect(count).toBeGreaterThan(40);
        }
    });
});
