/// <reference types="bun-types" />

/**
 * Work bounds for the entry digest cache: an ordinary pass flattens and hashes
 * only new or changed messages however large the session is, and two large
 * sessions served alternately keep their retained entries instead of evicting
 * each other.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { createLkgEntryProjector, projectLkgEntry } from "./lkg-replay";
import {
    captureSlot,
    getLkgEntryWorkForTest,
    LKG_ENTRY_CACHE_TOTAL_BYTES,
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

/** Fresh objects and strings with the same content, as OpenCode 1 builds every request. */
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
        expect(LKG_ENTRY_CACHE_TOTAL_BYTES).toBeGreaterThanOrEqual(256 * 1024 * 1024);
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
