/// <reference types="bun-types" />

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
    producerInputTokenLimit,
    producerWindowFailureReason,
} from "../../../hooks/magic-context/producer-window-guard";
import { estimateTokens } from "../../../hooks/magic-context/read-session-formatting";
import * as logger from "../../../shared/logger";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    RETROSPECTIVE_MAX_USER_MESSAGE_CHARS,
    RETROSPECTIVE_MESSAGE_TRUNCATION_MARKER,
    type RetrospectiveProjectSession,
    type RetrospectiveRawMessage,
    type RetrospectiveRawProvider,
    type RetrospectiveSinceRead,
    readRetrospectiveScanWindow,
} from "./retrospective-raw-provider";
import {
    isRetrospectiveWindowProcessed,
    recordRetrospectiveWindowProcessed,
} from "./storage-task-schedule";
import { parseFrictionGateVerdict } from "./task-executor";
import { buildFrictionGatePrompt, FRICTION_GATE_SYSTEM_PROMPT } from "./task-prompts";

describe("parseFrictionGateVerdict", () => {
    test("clean verdicts: n / y:ords", () => {
        expect(parseFrictionGateVerdict("n")).toEqual({ hit: false, ordinals: [] });
        expect(parseFrictionGateVerdict("y: 3, 7")).toEqual({ hit: true, ordinals: [3, 7] });
        expect(parseFrictionGateVerdict("Y: 5")).toEqual({ hit: true, ordinals: [5] });
        expect(parseFrictionGateVerdict("no")).toEqual({ hit: false, ordinals: [] });
        expect(parseFrictionGateVerdict("yes: 1")).toEqual({ hit: true, ordinals: [1] });
    });

    test("prose-wrapped hit on its own line is still caught", () => {
        const v = "Looking at the lines, the user corrected the agent twice.\ny: 4, 9";
        expect(parseFrictionGateVerdict(v)).toEqual({ hit: true, ordinals: [4, 9] });
    });

    test("a stray number in prose BEFORE the verdict line does not fabricate ordinals", () => {
        // '2024' must not leak into the ordinals; the verdict line is 'n'.
        const v = "I reviewed all 2024 messages.\nn";
        expect(parseFrictionGateVerdict(v)).toEqual({ hit: false, ordinals: [] });
    });

    test("ordinals come ONLY from the verdict line, not surrounding prose", () => {
        const v = "Context from 2019 and 2020.\ny: 6\nirrelevant 9999 trailing";
        expect(parseFrictionGateVerdict(v)).toEqual({ hit: true, ordinals: [6] });
    });

    test("a prose 'yes…' line (no colon) is NOT a verdict — scanning continues to a real y:N", () => {
        // Old bug: the prose line early-returned, harvesting its stray '3' AND
        // swallowing the real verdict below. Colon-required fixes both.
        const v = "yes, the user was clearly upset about issue 3 earlier.\ny: 7";
        expect(parseFrictionGateVerdict(v)).toEqual({ hit: true, ordinals: [7] });
    });

    test("a prose 'yes…' line with NO following verdict fails safe (no harvested ordinals)", () => {
        expect(parseFrictionGateVerdict("yes the user mentioned 5 and 6 problems")).toEqual({
            hit: false,
            ordinals: [],
        });
    });

    test("'y' with no ordinals is NOT a hit (nothing to deepen on)", () => {
        expect(parseFrictionGateVerdict("y")).toEqual({ hit: false, ordinals: [] });
        expect(parseFrictionGateVerdict("yes, some friction")).toEqual({
            hit: false,
            ordinals: [],
        });
    });

    test("embedded y:<nums> with no clean verdict line is accepted", () => {
        expect(parseFrictionGateVerdict("verdict y: 2, 3 done")).toEqual({
            hit: true,
            ordinals: [2, 3],
        });
    });

    test("garbage fails safe (no hit)", () => {
        expect(parseFrictionGateVerdict("")).toEqual({ hit: false, ordinals: [] });
        expect(parseFrictionGateVerdict("maybe?")).toEqual({ hit: false, ordinals: [] });
        expect(parseFrictionGateVerdict("the answer is unclear")).toEqual({
            hit: false,
            ordinals: [],
        });
    });
});

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});
function freshDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

function u(sessionId: string, ts: number, text: string): RetrospectiveRawMessage {
    return { sessionId, ordinal: 0, role: "user", text, ts };
}

/** A scripted provider: `since` returns rows with ts > watermark; `before`
 *  returns the newest `count` rows with ts <= watermark. */
class ScriptedProvider implements RetrospectiveRawProvider {
    constructor(
        private readonly sessions: string[],
        private readonly rowsBySession: Map<string, RetrospectiveRawMessage[]>,
    ) {}
    listProjectSessions(): RetrospectiveProjectSession[] {
        return this.sessions.map((sessionId) => ({
            sessionId,
            updatedAt: Math.max(
                0,
                ...(this.rowsBySession.get(sessionId) ?? []).map((row) => row.ts),
            ),
        }));
    }
    readUserMessagesSince(
        sessionId: string,
        sinceMs: number,
        capPerSession: number,
    ): RetrospectiveSinceRead {
        // Mirror the real readers: oldest-first, capped per session, with the
        // exact truncation signal.
        const limit = Math.max(1, Math.floor(capPerSession));
        const eligible = (this.rowsBySession.get(sessionId) ?? [])
            .filter((r) => r.ts > sinceMs)
            .sort((a, b) => a.ts - b.ts);
        return {
            messages: eligible.slice(0, limit),
            truncated: eligible.length > limit,
            firstOmittedTs: eligible[limit]?.ts,
        };
    }
    readOldestMessageTimesSince(
        sessionIds: readonly string[],
        sinceMs: number,
    ): Map<string, number> {
        const out = new Map<string, number>();
        for (const sessionId of sessionIds) {
            const oldest = (this.rowsBySession.get(sessionId) ?? [])
                .filter((r) => r.ts > sinceMs)
                .sort((a, b) => a.ts - b.ts)[0];
            if (oldest) out.set(sessionId, oldest.ts);
        }
        return out;
    }
    readUserMessagesBefore(
        sessionId: string,
        beforeMs: number,
        count: number,
    ): RetrospectiveRawMessage[] {
        return (this.rowsBySession.get(sessionId) ?? [])
            .filter((r) => r.ts <= beforeMs)
            .sort((a, b) => a.ts - b.ts)
            .slice(-count);
    }
}

describe("readRetrospectiveScanWindow", () => {
    const gatePromptFor = (messages: RetrospectiveRawMessage[]): string => {
        const userLines = messages
            .map((message, index) => ({ ...message, ordinal: index + 1 }))
            .filter((message) => message.role === "user")
            .map((message) => `${message.ordinal}: ${message.text}`);
        return `${FRICTION_GATE_SYSTEM_PROMPT}\n${buildFrictionGatePrompt({ userLines })}`;
    };

    test("a prompt-budget tie waits for the entire next timestamp cohort", async () => {
        const earlier = u("s", 101, "earlier " + "payload ".repeat(300));
        const peers = [
            u("s", 102, "peer-one " + "payload ".repeat(300)),
            u("s", 102, "peer-two " + "payload ".repeat(300)),
        ];
        const usableInputTokens = 1_100;
        const provider = new ScriptedProvider(["s"], new Map([["s", [earlier, ...peers]]]));
        const opts = { usableInputTokens };
        const first = await readRetrospectiveScanWindow(provider, "proj", 100, 0, opts);
        expect(first.budgetTruncated).toBe(true);
        expect(first.messages).toEqual([earlier]);
        expect(first.maxScannedTs).toBe(101);
        const next = await readRetrospectiveScanWindow(
            provider,
            "proj",
            first.maxScannedTs,
            0,
            opts,
        );
        expect(next.messages).toEqual(peers);
        expect(next.maxScannedTs).toBe(102);
    });

    test("the per-session lookahead commits a complete cohort that fills its cap", async () => {
        const cohort = [u("s", 101, "one"), u("s", 101, "two")];
        const tail = u("s", 102, "tail");
        const provider = new ScriptedProvider(["s"], new Map([["s", [...cohort, tail]]]));
        const opts = { capPerSession: 2 };
        const first = await readRetrospectiveScanWindow(provider, "proj", 100, 0, opts);
        expect(first.maxScannedTs).toBe(101);
        expect(first.messages).toEqual(cohort);
        const next = await readRetrospectiveScanWindow(
            provider,
            "proj",
            first.maxScannedTs,
            0,
            opts,
        );
        expect(next.messages).toEqual([tail]);
        expect(next.maxScannedTs).toBe(102);
    });

    test("a tie with an excluded session waits until both sessions fit", async () => {
        const earlier = u("first", 101, "earlier");
        const peers = [u("inside", 102, "inside"), u("outside", 102, "outside")];
        const provider = new ScriptedProvider(
            ["first", "inside", "outside"],
            new Map([
                ["first", [earlier]],
                ["inside", [peers[0]!]],
                ["outside", [peers[1]!]],
            ]),
        );
        const opts = { maxSessionsPerRun: 2 };
        const first = await readRetrospectiveScanWindow(provider, "proj", 100, 0, opts);
        expect(first.messages).toEqual([earlier]);
        expect(first.maxScannedTs).toBe(101);
        const next = await readRetrospectiveScanWindow(
            provider,
            "proj",
            first.maxScannedTs,
            0,
            opts,
        );
        expect(next.messages).toEqual(peers);
        expect(next.maxScannedTs).toBe(102);
    });

    test("skips an oversized first timestamp cohort without prompting any of its rows", async () => {
        const rows = [
            u("root", 101, "one"),
            u("root", 101, "two"),
            u("root", 101, "three"),
            u("root", 102, "tail"),
        ];
        const provider = new ScriptedProvider(["root"], new Map([["root", rows]]));
        const opts = { capPerSession: 2 };
        const log = spyOn(logger, "log").mockImplementation(() => {});
        try {
            const first = await readRetrospectiveScanWindow(provider, "proj", 100, 0, opts);
            expect(first.messages).toEqual([]);
            expect(first.maxScannedTs).toBe(101);
            expect(log.mock.calls).toEqual([
                [expect.stringContaining("sessionIds=root timestamp=101 skippedAtLeast=3")],
            ]);
            const next = await readRetrospectiveScanWindow(
                provider,
                "proj",
                first.maxScannedTs,
                0,
                opts,
            );
            expect(next.messages).toEqual([rows[3]!]);
            expect(next.maxScannedTs).toBe(102);
        } finally {
            log.mockRestore();
        }
    });

    test.each([
        "count",
        "budget",
    ] as const)("logs the exact count when the first whole timestamp cannot fit the %s cap", async (limit) => {
        const peers = [
            u("root", 101, `one ${"payload ".repeat(300)}`),
            u("root", 101, `two ${"payload ".repeat(300)}`),
        ];
        const tail = u("root", 102, "tail");
        const provider = new ScriptedProvider(["root"], new Map([["root", [...peers, tail]]]));
        const opts = limit === "count" ? { maxMessagesPerRun: 1 } : { usableInputTokens: 750 };
        const log = spyOn(logger, "log").mockImplementation(() => {});
        try {
            const first = await readRetrospectiveScanWindow(provider, "proj", 100, 0, opts);
            expect(first.messages).toEqual([]);
            expect(first.maxScannedTs).toBe(101);
            expect(log.mock.calls).toEqual([
                [expect.stringContaining("sessionIds=root timestamp=101 skipped=2")],
            ]);
            const next = await readRetrospectiveScanWindow(
                provider,
                "proj",
                first.maxScannedTs,
                0,
                opts,
            );
            expect(next.messages).toEqual([tail]);
            expect(next.maxScannedTs).toBe(102);
        } finally {
            log.mockRestore();
        }
    });

    test("skips a first timestamp cohort that alone spans too many sessions", async () => {
        const provider = new ScriptedProvider(
            ["s1", "s2"],
            new Map([
                ["s1", [u("s1", 101, "visible peer")]],
                ["s2", [u("s2", 101, "excluded peer"), u("s2", 102, "tail")]],
            ]),
        );
        const log = spyOn(logger, "log").mockImplementation(() => {});
        try {
            const result = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
                maxSessionsPerRun: 1,
            });
            expect(result.messages).toEqual([]);
            expect(result.maxScannedTs).toBe(101);
            expect(log.mock.calls).toEqual([
                [expect.stringContaining("sessionIds=s1,s2 timestamp=101 skippedAtLeast=2")],
            ]);
        } finally {
            log.mockRestore();
        }
    });

    test("clamps an oversized genuine user line head+tail before prompt assembly", async () => {
        const head = "HEAD-FRICTION ";
        const tail = " TAIL-CONTEXT";
        const pastedLog = `${head}${"chromium gpu error\n".repeat(40_000)}${tail}`;
        const provider = new ScriptedProvider(["s1"], new Map([["s1", [u("s1", 100, pastedLog)]]]));

        const win = await readRetrospectiveScanWindow(provider, "proj", 0, 0);

        expect(win.messages).toHaveLength(1);
        expect(win.messages[0]?.text.length).toBeLessThanOrEqual(
            RETROSPECTIVE_MAX_USER_MESSAGE_CHARS,
        );
        expect(win.messages[0]?.text).toStartWith(head);
        expect(win.messages[0]?.text).toEndWith(tail);
        expect(win.messages[0]?.text).toContain(RETROSPECTIVE_MESSAGE_TRUNCATION_MARKER);
    });

    test("reproduces the 1.8MB rejection shape, then admits only the oldest lines inside the child window", async () => {
        const logDump = (label: string) =>
            `${label}\n${"[ERROR:gpu_process_host.cc] GPU process crashed\n".repeat(6_500)}`;
        const rows = new Map([
            [
                "s1",
                Array.from({ length: 7 }, (_, index) =>
                    u("s1", 100 + index * 10, logDump(`paste-${index + 1}`)),
                ),
            ],
        ]);
        const rawMessages = rows.get("s1") ?? [];
        const beforePrompt = gatePromptFor(rawMessages);
        const beforeBytes = Buffer.byteLength(beforePrompt);
        const usableInputTokens = 8_000;
        const contextLimitTokens = 12_000;
        const maxOutputTokens = contextLimitTokens - usableInputTokens;

        expect(beforeBytes).toBeGreaterThan(1_790_000);
        expect(
            producerWindowFailureReason({
                producerSourceTokens: estimateTokens(beforePrompt),
                contextLimitTokens,
                maxOutputTokens,
            }),
        ).toContain("producer_source_exceeds_window");

        const win = await readRetrospectiveScanWindow(
            new ScriptedProvider(["s1"], rows),
            "proj",
            0,
            0,
            { usableInputTokens },
        );
        const afterPrompt = gatePromptFor(win.messages);
        const admittedLimit = producerInputTokenLimit(usableInputTokens, 0);

        expect(win.budgetTruncated).toBe(true);
        expect(win.messages.length).toBeGreaterThan(0);
        expect(win.messages.length).toBeLessThan(rawMessages.length);
        expect(win.messages.map((message) => message.text)).toEqual(
            rawMessages
                .slice(0, win.messages.length)
                .map((message) => expect.stringContaining(message.text.slice(0, 100))),
        );
        expect(Buffer.byteLength(afterPrompt)).toBeLessThan(beforeBytes);
        expect(estimateTokens(afterPrompt)).toBeLessThanOrEqual(admittedLimit ?? 0);
        expect(win.promptTokens).toBe(estimateTokens(afterPrompt));
        expect(win.promptInputLimitTokens).toBe(admittedLimit);
        expect(win.maxScannedTs).toBe(win.messages.at(-1)?.ts);
    });

    test("prompt-budget frontier drains oldest-first without skipping omitted lines", async () => {
        const rows = new Map([
            [
                "s1",
                Array.from({ length: 12 }, (_, index) =>
                    u("s1", 100 + index * 10, `${index + 1}:${"payload ".repeat(300)}`),
                ),
            ],
        ]);
        const options = { usableInputTokens: 2_000 };
        const first = await readRetrospectiveScanWindow(
            new ScriptedProvider(["s1"], rows),
            "proj",
            0,
            0,
            options,
        );
        const second = await readRetrospectiveScanWindow(
            new ScriptedProvider(["s1"], rows),
            "proj",
            first.maxScannedTs,
            0,
            options,
        );

        expect(first.budgetTruncated).toBe(true);
        expect(first.messages.map((message) => message.ts)).toEqual(
            [...first.messages.map((message) => message.ts)].sort((a, b) => a - b),
        );
        expect(second.messages[0]?.ts).toBeGreaterThan(first.messages.at(-1)?.ts ?? 0);
        expect(
            new Set([...first.messages, ...second.messages].map((message) => message.ts)).size,
        ).toBe(first.messages.length + second.messages.length);
    });

    test("recency cutoff skips ancient lines and advances the persisted frontier past them", async () => {
        const cutoff = 30 * 24 * 60 * 60 * 1000;
        const rows = new Map([
            ["s1", [u("s1", cutoff - 20, "ancient"), u("s1", cutoff, "boundary")]],
        ]);

        const win = await readRetrospectiveScanWindow(
            new ScriptedProvider(["s1"], rows),
            "proj",
            0,
            0,
            { recencyCutoffMs: cutoff },
        );

        expect(win.messages.map((message) => message.text)).toEqual(["boundary"]);
        expect(win.maxScannedTs).toBe(cutoff);

        const onlyAncient = await readRetrospectiveScanWindow(
            new ScriptedProvider(["s1"], new Map([["s1", [u("s1", cutoff - 20, "ancient")]]])),
            "proj",
            0,
            0,
            { recencyCutoffMs: cutoff },
        );
        expect(onlyAncient.messages).toEqual([]);
        expect(onlyAncient.maxScannedTs).toBe(cutoff - 1);
    });

    test("the 30-day cutoff cannot hold a 25-day-old watermark and passes it on day 31", async () => {
        const day = 24 * 60 * 60 * 1000;
        const watermark = 40 * day;
        const row = u("s", watermark + 1, "earliest later user line");
        const provider = new ScriptedProvider(["s"], new Map([["s", [row]]]));
        const active = await readRetrospectiveScanWindow(provider, "proj", watermark, 0, {
            recencyCutoffMs: watermark + (25 - 30) * day,
        });
        expect(active.messages).toEqual([row]);
        expect(active.maxScannedTs).toBe(watermark + 1);
        const expired = await readRetrospectiveScanWindow(provider, "proj", watermark, 0, {
            recencyCutoffMs: watermark + (31 - 30) * day,
        });
        expect(expired.messages).toEqual([]);
        expect(expired.maxScannedTs).toBe(watermark + day - 1);
    });

    test("merges since + overlap; maxScannedTs comes ONLY from the since portion", async () => {
        const rows = new Map([
            [
                "s1",
                [
                    u("s1", 100, "old1"),
                    u("s1", 150, "old2"),
                    u("s1", 250, "new1"),
                    u("s1", 300, "new2"),
                ],
            ],
        ]);
        const provider = new ScriptedProvider(["s1"], rows);

        const win = await readRetrospectiveScanWindow(provider, "proj", 200, 2);
        const texts = win.messages.map((m) => m.text);
        // since (>200): new1, new2. overlap (<=200, last 2): old1, old2.
        expect(texts.sort()).toEqual(["new1", "new2", "old1", "old2"]);
        // watermark only advances to the newest SINCE row, never pulled back by overlap.
        expect(win.maxScannedTs).toBe(300);
    });

    test("watermark=0 (never scanned) reads no overlap, only since", async () => {
        const rows = new Map([["s1", [u("s1", 100, "a"), u("s1", 200, "b")]]]);
        const provider = new ScriptedProvider(["s1"], rows);
        const win = await readRetrospectiveScanWindow(provider, "proj", 0, 12);
        expect(win.messages.map((m) => m.text).sort()).toEqual(["a", "b"]);
        expect(win.maxScannedTs).toBe(200);
    });

    test("backlog: keeps the OLDEST since-rows and never advances the watermark past a dropped row (global cap)", async () => {
        // 6 new post-watermark rows, global cap 3. Must keep the oldest 3 and
        // stop the watermark BELOW the first dropped row, so the dropped newer
        // rows are re-read next run (no permanent loss).
        const rows = new Map([
            [
                "s1",
                [
                    u("s1", 110, "a1"),
                    u("s1", 120, "a2"),
                    u("s1", 130, "a3"),
                    u("s1", 140, "a4"),
                    u("s1", 150, "a5"),
                    u("s1", 160, "a6"),
                ],
            ],
        ]);
        const provider = new ScriptedProvider(["s1"], rows);

        const win = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
            maxMessagesPerRun: 3,
            capPerSession: 100,
        });
        expect(win.messages.map((m) => m.text)).toEqual(["a1", "a2", "a3"]);
        // watermark = newest KEPT ts (a3 @ 130). The dropped rows a4..a6 are all
        // NEWER, so they're re-read next run — nothing lost.
        expect(win.maxScannedTs).toBe(130);

        // Next run from the advanced watermark re-reads a4..a6 (nothing lost).
        const win2 = await readRetrospectiveScanWindow(provider, "proj", win.maxScannedTs, 0, {
            maxMessagesPerRun: 3,
            capPerSession: 100,
        });
        expect(win2.messages.map((m) => m.text)).toEqual(["a4", "a5", "a6"]);
        expect(win2.maxScannedTs).toBe(160);
    });

    test("the global cap defers the whole same-ms group so no sibling is lost or repeated", async () => {
        // Two sessions, each individually UNsaturated (so saturatedFrontier stays
        // +Inf), but the GLOBAL cap of 3 splits a same-ms (130) pair: a3 kept, b3
        // dropped. A ts-only watermark of 130 would skip b3 forever, so leave the
        // whole timestamp out of this prompt and read it in the next run.
        const rows = new Map([
            ["s1", [u("s1", 110, "a1"), u("s1", 120, "a2"), u("s1", 130, "a3")]],
            ["s2", [u("s2", 130, "b3")]],
        ]);
        const provider = new ScriptedProvider(["s1", "s2"], rows);

        const win = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
            maxMessagesPerRun: 3,
            capPerSession: 100,
        });
        expect(win.messages.map((m) => m.text).sort()).toEqual(["a1", "a2"]);
        expect(win.maxScannedTs).toBe(120);

        // The next run reads both siblings as new without re-reading a1 or a2.
        const win2 = await readRetrospectiveScanWindow(provider, "proj", win.maxScannedTs, 0, {
            maxMessagesPerRun: 3,
            capPerSession: 100,
        });
        expect(win2.messages.map((m) => m.text).sort()).toEqual(["a3", "b3"]);
        expect(win2.maxScannedTs).toBe(130);
    });

    test("a per-session-saturated read advances through the last complete timestamp", async () => {
        // capPerSession 2: the session returns its OLDEST 2 but holds newer
        // unseen rows. The next row's later timestamp proves the kept group is complete.
        const rows = new Map([
            ["s1", [u("s1", 110, "a1"), u("s1", 120, "a2"), u("s1", 130, "a3")]],
        ]);
        const provider = new ScriptedProvider(["s1"], rows);

        const win = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 2,
        });
        expect(win.messages.map((m) => m.text)).toEqual(["a1", "a2"]);
        expect(win.maxScannedTs).toBe(120);
    });

    test("saturation uses the explicit `truncated` signal, not messages.length", async () => {
        // A provider whose normalized output is SHORTER than its cap (e.g. rows
        // dropped during normalization) but which DID truncate. A length-based
        // guess (length < cap → not saturated) would false-negative and let the
        // watermark jump past unseen rows. The explicit signal must win.
        const provider: RetrospectiveRawProvider = {
            listProjectSessions: () => [{ sessionId: "s1" }],
            // returns 1 row but reports truncated=true (cap was hit upstream).
            readUserMessagesSince: () => ({
                messages: [u("s1", 130, "kept")],
                truncated: true,
            }),
            readUserMessagesBefore: () => [],
        };
        const win = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 5,
        });
        // frontier = lastKept(130) − 1 = 129 even though only 1 row < cap 5.
        expect(win.maxScannedTs).toBe(129);
        expect(win.messages).toEqual([]);
    });

    test("an unknown unread boundary blocks new work and leaves it for retry", async () => {
        const provider: RetrospectiveRawProvider = {
            listProjectSessions: () => [{ sessionId: "empty" }, { sessionId: "visible" }],
            readUserMessagesSince: (id) =>
                id === "empty"
                    ? { messages: [], truncated: true }
                    : {
                          messages: [u("visible", 110, "cannot pass the unknown boundary")],
                          truncated: false,
                      },
            readUserMessagesBefore: () => [],
        };
        const result = await readRetrospectiveScanWindow(provider, "proj", 100, 0);
        expect(result.messages).toEqual([]);
        expect(result.maxScannedTs).toBe(100);
    });

    test("an excluded legacy session's update time is not its oldest pending timestamp", async () => {
        const provider: RetrospectiveRawProvider = {
            listProjectSessions: () => [
                { sessionId: "s1", updatedAt: 101 },
                { sessionId: "excluded", updatedAt: 101 },
            ],
            readUserMessagesSince: () => ({
                messages: [u("s1", 101, "not safe to send")],
                truncated: false,
            }),
            readUserMessagesBefore: () => [],
        };
        const result = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
            maxSessionsPerRun: 1,
        });
        expect(result.messages).toEqual([]);
        expect(result.maxScannedTs).toBe(100);
    });

    test("advances past observed assistant-only activity when no user message remains", async () => {
        const provider: RetrospectiveRawProvider = {
            listProjectSessions: () => [{ sessionId: "s", updatedAt: 300 }],
            readOldestMessageTimesSince: () => new Map(),
            readUserMessagesSince: () => ({ messages: [], truncated: false }),
            readUserMessagesBefore: () => [],
        };
        const win = await readRetrospectiveScanWindow(provider, "proj", 200, 0);
        expect(win.maxScannedTs).toBe(300);
        expect(win.messages).toEqual([]);
    });

    test("session cap drains oldest eligible sessions without skipping older backlog", async () => {
        const sessionIds = Array.from({ length: 25 }, (_, i) => `s${25 - i}`);
        const rows = new Map(
            sessionIds.map((sessionId) => {
                const n = Number(sessionId.slice(1));
                return [sessionId, [u(sessionId, 100 + n, `message-${sessionId}`)]] as const;
            }),
        );
        const provider = new ScriptedProvider(sessionIds, rows);

        const win = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 10,
            maxSessionsPerRun: 20,
        });

        expect(win.messages).toHaveLength(20);
        expect(win.messages.map((m) => m.sessionId)).toEqual(
            Array.from({ length: 20 }, (_, i) => `s${i + 1}`),
        );
        expect(win.maxScannedTs).toBe(120);

        const win2 = await readRetrospectiveScanWindow(provider, "proj", win.maxScannedTs, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 10,
            maxSessionsPerRun: 20,
        });
        expect(win2.messages.map((m) => m.sessionId)).toEqual(["s21", "s22", "s23", "s24", "s25"]);
        expect(win2.maxScannedTs).toBe(125);

        const scanned = [...win.messages, ...win2.messages].map((message) => message.sessionId);
        expect(new Set(scanned).size).toBe(25);
        expect(scanned.sort()).toEqual(sessionIds.slice().sort());
    });

    test("session cap clamps to the oldest pending message in an excluded long session", async () => {
        const rows = new Map([
            ["recent-short", [u("recent-short", 120, "already later")]],
            [
                "long-session",
                [u("long-session", 115, "older backlog"), u("long-session", 200, "tail")],
            ],
        ]);
        const provider = new ScriptedProvider(["recent-short", "long-session"], rows);

        const win = await readRetrospectiveScanWindow(provider, "proj", 100, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 10,
            maxSessionsPerRun: 1,
        });
        expect(win.messages.map((m) => m.text)).toEqual(["older backlog"]);
        expect(win.maxScannedTs).toBe(115);

        const win2 = await readRetrospectiveScanWindow(provider, "proj", win.maxScannedTs, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 10,
            maxSessionsPerRun: 1,
        });
        expect(win2.messages.map((m) => m.text)).toEqual(["already later"]);
        expect(win2.maxScannedTs).toBe(120);

        const win3 = await readRetrospectiveScanWindow(provider, "proj", win2.maxScannedTs, 0, {
            maxMessagesPerRun: 100,
            capPerSession: 10,
            maxSessionsPerRun: 1,
        });
        expect(win3.messages.map((m) => m.text)).toEqual(["tail"]);
        expect(win3.maxScannedTs).toBe(200);
    });

    test("dedupes a row that appears in both since and overlap reads", async () => {
        // A provider whose `before` overlaps the `since` boundary row.
        const rows = new Map([["s1", [u("s1", 200, "boundary"), u("s1", 250, "after")]]]);
        const provider: RetrospectiveRawProvider = {
            listProjectSessions: () => [{ sessionId: "s1" }],
            readUserMessagesSince: (_s, since) => ({
                messages: (rows.get("s1") ?? []).filter((r) => r.ts > since),
                truncated: false,
            }),
            // deliberately also return the boundary row (ts == watermark) in overlap
            readUserMessagesBefore: () => [u("s1", 200, "boundary")],
        };
        const win = await readRetrospectiveScanWindow(provider, "proj", 199, 5);
        // "boundary" (ts 200) is > 199 so in since AND returned by overlap → one copy.
        expect(win.messages.filter((m) => m.text === "boundary")).toHaveLength(1);
    });
});

describe("retrospective processed-window idempotence", () => {
    test("record then check round-trips per (project, key)", () => {
        db = freshDb();
        expect(isRetrospectiveWindowProcessed(db, "proj", "k1")).toBe(false);
        recordRetrospectiveWindowProcessed(db, "proj", "k1");
        expect(isRetrospectiveWindowProcessed(db, "proj", "k1")).toBe(true);
        // scoped by project + key
        expect(isRetrospectiveWindowProcessed(db, "proj", "k2")).toBe(false);
        expect(isRetrospectiveWindowProcessed(db, "other", "k1")).toBe(false);
    });

    test("re-recording the same key is an idempotent no-op (no throw)", () => {
        db = freshDb();
        recordRetrospectiveWindowProcessed(db, "proj", "k1");
        expect(() => recordRetrospectiveWindowProcessed(db, "proj", "k1")).not.toThrow();
        expect(isRetrospectiveWindowProcessed(db, "proj", "k1")).toBe(true);
    });
});
