import { describe, expect, it, spyOn } from "bun:test";
import { computeProtectionWindow } from "../../features/magic-context/protection-window";
import { CTX_REDUCE_KEEP } from "../../features/magic-context/reclaim-protection";
import type { TagEntry } from "../../features/magic-context/types";
import * as stableJson from "../../shared/stable-json";
import { buildChannel1Reminder, decideChannel1 } from "./ctx-reduce-nudge";
import * as formattingModule from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";
import {
    assertTailHygieneContentUnchanged,
    assertTailHygieneContentUnchangedIfEnabled,
    effectiveTailHygiene,
    measureTailHygiene,
    refreshTailHygieneBaseline,
    sameTailHygieneStructuralSignature,
    tailHygieneStructuralSignature,
} from "./tail-hygiene-walk";

function message(
    id: string,
    role: "user" | "assistant",
    parts: unknown[],
    extra: Partial<MessageLike["info"]> = {},
): MessageLike {
    return { info: { id, role, ...extra }, parts };
}

function textMessage(id: string, text: string, role: "user" | "assistant" = "user"): MessageLike {
    return message(id, role, [{ type: "text", text }]);
}

/** A text attachment: prose leaves U (#954), so U fixtures use file parts as reclaimable mass. */
function fileMessage(id: string, content: string): MessageLike {
    return message(id, "user", [{ type: "file", mime: "text/plain", content }]);
}

function tag(
    tagNumber: number,
    messageId: string,
    type: TagEntry["type"],
    overrides: Partial<TagEntry> = {},
): TagEntry {
    return {
        tagNumber,
        messageId,
        type,
        status: "active",
        dropMode: "full",
        toolName: type === "tool" ? "read" : null,
        inputByteSize: 0,
        byteSize: 1,
        reasoningByteSize: 0,
        sessionId: "ses-walk",
        cavemanDepth: 0,
        toolOwnerMessageId: type === "tool" ? "owner" : null,
        ...overrides,
    };
}

function nativeTool(ownerId: string, callID: string, input: unknown, output: string): MessageLike {
    return message(ownerId, "assistant", [
        { type: "tool", callID, tool: "read", state: { input, output } },
    ]);
}

describe("tail hygiene single-walk instrument", () => {
    it("reproduces the live incident from rendered-tail coordinates", () => {
        const messages = [
            textMessage("conversation", "prose ".repeat(58_000)),
            nativeTool("tool-owner", "call-live", { path: "fixture" }, "result ".repeat(81_000)),
            {
                info: { role: "user", syntheticHead: true },
                parts: [{ type: "text", text: "m0 ".repeat(131_000), synthetic: true }],
            } as MessageLike,
        ];
        const tags = [tag(2, "call-live", "tool", { toolOwnerMessageId: "tool-owner" })];

        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        const severity = measured.u / measured.t;
        const oldInputRelativeSeverity = measured.u / 648_000;
        const oldRebasedPressure = 0.2;
        const oldWouldFire = oldInputRelativeSeverity >= 0.2 && oldRebasedPressure >= 0.8;

        expect(measured.u).toBeGreaterThan(0);
        expect(measured.u).toBeLessThanOrEqual(measured.t);
        expect(severity).toBeGreaterThanOrEqual(0.55);
        expect(severity).toBeLessThan(0.7);
        expect(oldWouldFire).toBe(false);
    });

    it("consumes token-window membership derived from the floor and persisted tag mass", () => {
        const messages: MessageLike[] = [];
        const tags: TagEntry[] = [];
        const persistedRows: Array<{
            tag_number: number;
            block_id: string;
            kind: "tool";
            token_count: number;
        }> = [];
        for (let number = 1; number <= 4; number += 1) {
            const owner = `owner-${number}`;
            const callId = `call-${number}`;
            messages.push(nativeTool(owner, callId, { path: String(number) }, `result ${number}`));
            tags.push(tag(number, callId, "tool", { toolOwnerMessageId: owner }));
            persistedRows.push({
                tag_number: number,
                block_id: callId,
                kind: "tool",
                token_count: 4_000,
            });
        }
        const protectedTagNumbers = computeProtectionWindow(persistedRows, 16_000).tagNumberSet
            .tagNumbers;
        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers });

        expect(protectedTagNumbers).toEqual(new Set([1, 2, 3, 4]));
        expect(measured.u).toBe(0);
        expect(measured.t).toBeGreaterThan(0);

        const emptyProtectedTagNumbers = computeProtectionWindow(
            [{ tag_number: 5, block_id: "message:p0", kind: "message", token_count: 8_000 }],
            16_000,
        ).tagNumberSet.tagNumbers;
        const emptyWindowMeasured = measureTailHygiene({
            messages: [fileMessage("message", "still reclaimable")],
            tags: [tag(5, "message:file0", "file")],
            protectedTagNumbers: emptyProtectedTagNumbers,
        });
        expect(emptyProtectedTagNumbers).toEqual(new Set());
        expect(emptyWindowMeasured.u).toBe(emptyWindowMeasured.t);
    });

    it("is invariant to raw tag weights and measures only final rendered content", () => {
        const messages = [
            textMessage("m1", "kept rendered prose ".repeat(200)),
            nativeTool("m2", "call-drift", { path: "small" }, "rendered output ".repeat(150)),
        ];
        const normalTags = [
            tag(1, "m1:p0", "message", { byteSize: 100 }),
            tag(2, "call-drift", "tool", {
                byteSize: 100,
                inputByteSize: 20,
                toolOwnerMessageId: "m2",
            }),
        ];
        const driftedTags = normalTags.map((entry) => ({
            ...entry,
            byteSize: entry.byteSize + 380_000,
            inputByteSize: entry.inputByteSize + 200_000,
        }));

        expect(
            measureTailHygiene({ messages, tags: driftedTags, protectedTagNumbers: new Set() }),
        ).toEqual(
            measureTailHygiene({ messages, tags: normalTags, protectedTagNumbers: new Set() }),
        );
    });

    it("counts caveman-compressed bytes and excludes truncated tool skeletons", () => {
        const messages = [
            textMessage("compressed", "compact summary"),
            nativeTool(
                "skeleton-owner",
                "call-truncated",
                { path: "/very/large/original/path", payload: "x".repeat(50_000) },
                "[truncated §2§]",
            ),
        ];
        const tags = [
            tag(1, "compressed:p0", "message", { byteSize: 500_000, cavemanDepth: 3 }),
            tag(2, "call-truncated", "tool", {
                byteSize: 500_000,
                inputByteSize: 100_000,
                toolOwnerMessageId: "skeleton-owner",
            }),
        ];

        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        const compressedOnly = measureTailHygiene({
            messages: [messages[0]],
            tags: [tags[0]],
            protectedTagNumbers: new Set(),
        });

        expect(measured.u).toBe(compressedOnly.u);
        expect(measured.t).toBe(compressedOnly.t);
    });

    it("excludes reasoning and signatures in both directions", () => {
        const base = [textMessage("m", "visible working text ".repeat(100))];
        const withReasoning = [
            message("m", "user", [
                { type: "text", text: "visible working text ".repeat(100) },
                {
                    type: "thinking",
                    thinking: "private chain ".repeat(50_000),
                    signature: "signed ".repeat(10_000),
                },
                { type: "redacted_thinking", data: "opaque ".repeat(50_000) },
                { type: "signature", text: "signature ".repeat(50_000) },
            ]),
        ];
        const tags = [tag(1, "m:p0", "message")];

        const expected = measureTailHygiene({
            messages: base,
            tags,
            protectedTagNumbers: new Set(),
        });
        const actual = measureTailHygiene({
            messages: withReasoning,
            tags,
            protectedTagNumbers: new Set(),
        });
        expect({ u: actual.u, t: actual.t }).toEqual({ u: expected.u, t: expected.t });
    });

    it("excludes m0/m1, todo, Channel-2, and compaction-summary synthetics", () => {
        const syntheticMessages: MessageLike[] = [
            {
                info: { role: "user", syntheticHead: true },
                parts: [{ type: "text", text: "m0", synthetic: true }],
            },
            {
                info: { id: "__magic_context_todo_head__", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        callID: "mc_synthetic_todo_0123456789abcdef",
                        tool: "todowrite",
                        syntheticTodoMarker: true,
                        state: { input: { todos: [] }, output: "todo" },
                    },
                ],
            },
            message("channel2", "user", [
                { type: "text", text: "<system-reminder>drop</system-reminder>", synthetic: true },
            ]),
            message("summary", "assistant", [{ type: "text", text: "compacted" }], {
                summary: true,
            }),
        ];

        expect(
            measureTailHygiene({
                messages: syntheticMessages,
                tags: [],
                protectedTagNumbers: new Set(),
            }),
        ).toMatchObject({ u: 0, t: 0 });
    });

    it("excludes protected ctx_reduce exemplar arcs from U while retaining them in T", () => {
        const messages = Array.from({ length: 4 }, (_, index) =>
            nativeTool(
                `reduce-owner-${index + 1}`,
                `reduce-${index + 1}`,
                { drop: index + 1 },
                `reduced ${index + 1}`,
            ),
        );
        const tags = Array.from({ length: 4 }, (_, index) =>
            tag(index + 1, `reduce-${index + 1}`, "tool", {
                toolName: "ctx_reduce",
                toolOwnerMessageId: `reduce-owner-${index + 1}`,
            }),
        );

        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        const protectedTagNumbers = new Set(
            measured.parts.filter((part) => part.protected).map((part) => part.tagNumber),
        );
        const oldestArcParts = measured.parts.filter((part) => part.tagNumber === 1);
        const exemplarParts = measured.parts.filter((part) => (part.tagNumber ?? 0) >= 2);

        expect(protectedTagNumbers).toEqual(new Set([2, 3, 4]));
        expect(oldestArcParts.every((part) => part.uTokens > 0)).toBe(true);
        expect(exemplarParts.every((part) => part.uTokens === 0)).toBe(true);
        expect(measured.u).toBeGreaterThan(0);
        expect(measured.t).toBeGreaterThan(measured.u);
        expect(CTX_REDUCE_KEEP).toBe(3);
    });

    it("keeps U as a constructed subset of T, including image/file parts", () => {
        const messages = [
            message("file-owner", "user", [
                { type: "file", mime: "image/png", url: "data:image/png;base64,garbage" },
            ]),
            nativeTool("tool-owner", "call-subset", { query: "x" }, "answer"),
            textMessage("untagged", "visible but not reclaimable"),
        ];
        const tags = [
            tag(1, "file-owner:file0", "file"),
            tag(2, "call-subset", "tool", { toolOwnerMessageId: "tool-owner" }),
        ];
        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });

        expect(measured.u).toBeGreaterThan(0);
        expect(measured.u).toBeLessThan(measured.t);
        expect(measured.u).toBeLessThanOrEqual(measured.t);
    });

    it("attributes a single orphan only in its tag-number neighborhood", () => {
        const messages = [
            textMessage("before", "before"),
            nativeTool("legacy-owner", "call-reused", { n: 1 }, "legacy output"),
            textMessage("after", "after"),
            textMessage("later-before", "later before"),
            nativeTool("recycled-owner", "call-reused", { n: 2 }, "recycled output"),
            textMessage("later-after", "later after"),
        ];
        const tags = [
            tag(9, "before:p0", "message"),
            tag(10, "call-reused", "tool", { toolOwnerMessageId: null }),
            tag(11, "after:p0", "message"),
            tag(100, "later-before:p0", "message"),
            tag(102, "later-after:p0", "message"),
        ];

        const both = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        const legacyOnly = measureTailHygiene({
            messages: messages.slice(0, 3),
            tags,
            protectedTagNumbers: new Set(),
        });
        const legacyProseOnly = measureTailHygiene({
            messages: [messages[0], messages[2]],
            tags,
            protectedTagNumbers: new Set(),
        });
        const laterOnly = measureTailHygiene({
            messages: messages.slice(3),
            tags,
            protectedTagNumbers: new Set(),
        });
        const laterProseOnly = measureTailHygiene({
            messages: [messages[3], messages[5]],
            tags,
            protectedTagNumbers: new Set(),
        });
        const allProse = measureTailHygiene({
            messages: [messages[0], messages[2], messages[3], messages[5]],
            tags,
            protectedTagNumbers: new Set(),
        });
        const legacyToolU = legacyOnly.u - legacyProseOnly.u;

        expect(legacyToolU).toBeGreaterThan(0);
        expect(laterOnly.u).toBe(laterProseOnly.u);
        expect(both.u).toBe(allProse.u + legacyToolU);
        expect(both.u).toBeLessThan(both.t);
    });

    it("treats multiple NULL-owner rows for one callID as ambiguous", () => {
        const messages = [
            fileMessage("before", "before"),
            nativeTool("legacy-owner", "call-ambiguous", { n: 1 }, "legacy output"),
            fileMessage("after", "after"),
        ];
        const tags = [
            tag(9, "before:file0", "file"),
            tag(10, "call-ambiguous", "tool", { toolOwnerMessageId: null }),
            tag(10_000, "call-ambiguous", "tool", { toolOwnerMessageId: null }),
            tag(11, "after:file0", "file"),
        ];

        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        // The neighboring tagged files still contribute U even though both orphan rows are rejected.
        expect(measured.u).toBeGreaterThan(0);
        const textOnly = measureTailHygiene({
            messages: [messages[0], messages[2]],
            tags,
            protectedTagNumbers: new Set(),
        });
        expect(measured.u).toBe(textOnly.u);
        expect(measured.t).toBeGreaterThan(measured.u);
    });
});

describe("tail hygiene baseline and defer-window deltas", () => {
    it("keeps a bust pass and an unchanged defer pass identical", () => {
        const messages = [textMessage("m", "working tail ".repeat(10_000))];
        const tags = [tag(1, "m:p0", "message")];
        const bust = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        const defer = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: false,
            previous: bust,
        });

        expect(effectiveTailHygiene(defer)).toEqual(effectiveTailHygiene(bust));
        expect(defer.baselineGeneration).toBe(bust.baselineGeneration);
        expect(defer.evaluable).toBe(true);
    });

    it("subtracts queued-drop mass through the defer delta without changing T or the frozen baseline", () => {
        const messages = [
            fileMessage("queued", "mass ".repeat(25_000)),
            fileMessage("remaining", "mass ".repeat(45_000)),
            textMessage("untagged", "mass ".repeat(30_000)),
        ];
        const tags = [tag(1, "queued:file0", "file"), tag(2, "remaining:file0", "file")];
        const initial = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        const queuedMass = measureTailHygiene({
            messages: [messages[0]],
            tags: [tags[0]],
            protectedTagNumbers: new Set(),
        }).u;
        const baseline = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        const queued = measureTailHygiene({
            messages,
            tags,
            protectedTagNumbers: new Set(),
            pendingDropTagNumbers: new Set([1]),
        });
        const defer = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTagNumbers: new Set(),
            pendingDropTagNumbers: new Set([1]),
            cacheBusting: false,
            previous: baseline,
        });

        expect(queued.t).toBe(initial.t);
        expect(queued.u).toBe(initial.u - queuedMass);
        expect(defer.evaluable).toBe(true);
        expect(defer.baselineU).toBe(baseline.baselineU);
        expect(defer.baselineT).toBe(baseline.baselineT);
        expect(effectiveTailHygiene(defer)).toEqual({ u: queued.u, t: queued.t });
        expect(
            decideChannel1({
                ...baseline,
                lastNudgeUndropped: 0,
                lastNudgeLevel: "",
                hasRecentReduce: false,
            }).level,
        ).toBe("urgent");
        expect(
            decideChannel1({
                ...defer,
                lastNudgeUndropped: 0,
                lastNudgeLevel: "",
                hasRecentReduce: false,
            }).level,
        ).toBe("firm");
    });

    it("replays a prior Channel-1 reminder byte-identically when queue state changes U", () => {
        const original = nativeTool(
            "owner",
            "call-replay",
            { path: "x" },
            "tool output ".repeat(500),
        );
        const tags = [tag(1, "call-replay", "tool", { toolOwnerMessageId: "owner" })];
        const reminder = buildChannel1Reminder("firm", 42_000, 16);
        const served = structuredClone(original) as MessageLike;
        (served.parts[0] as { state: { output: string } }).state.output += reminder;
        const baseline = refreshTailHygieneBaseline({
            messages: [served],
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        const replay = refreshTailHygieneBaseline({
            messages: [served],
            tags,
            protectedTagNumbers: new Set(),
            pendingDropTagNumbers: new Set([1]),
            cacheBusting: false,
            previous: baseline,
        });

        expect((served.parts[0] as { state: { output: string } }).state.output).toContain(reminder);
        expect(replay.contentSignature).toBe(baseline.contentSignature);
        expect(replay.evaluable).toBe(true);
    });

    it("walks typed appended deltas while protected and untagged tool output is T-only", () => {
        const baseMessages = [textMessage("base", "base text ".repeat(100))];
        const baseTags = [tag(1, "base:p0", "message")];
        const baseline = refreshTailHygieneBaseline({
            messages: baseMessages,
            tags: baseTags,
            protectedTagNumbers: new Set([1]),
            cacheBusting: true,
        });
        const messages = [
            ...baseMessages,
            textMessage("user-delta", "new user prose ".repeat(100)),
            textMessage("assistant-delta", "new assistant prose ".repeat(100), "assistant"),
            message("image-delta", "user", [
                { type: "file", mime: "image/png", url: "data:image/png;base64,garbage" },
            ]),
            nativeTool("tool-delta", "call-delta", { path: "new" }, "new tool output ".repeat(100)),
            nativeTool("untagged-tool", "call-untagged", { path: "other" }, "untagged output"),
        ];
        const tags = [
            ...baseTags,
            tag(2, "user-delta:p0", "message"),
            tag(3, "assistant-delta:p0", "message"),
            tag(4, "image-delta:file0", "file"),
            tag(5, "call-delta", "tool", { toolOwnerMessageId: "tool-delta" }),
        ];
        const defer = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTagNumbers: new Set([1, 5]),
            cacheBusting: false,
            previous: baseline,
        });

        expect(defer.evaluable).toBe(true);
        expect(defer.turnDeltaT).toBeGreaterThan(0);
        expect(defer.turnDeltaU).toBeGreaterThan(0);
        expect(defer.turnDeltaU).toBeLessThan(defer.turnDeltaT);
        expect(effectiveTailHygiene(defer).u).toBeLessThanOrEqual(effectiveTailHygiene(defer).t);
    });

    it("counts an appended tool output after it ages out of the protected suffix", () => {
        const baseMessages = [textMessage("base", "base text")];
        const baseTags = [tag(1, "base:p0", "message")];
        const appended = nativeTool(
            "tool-delta",
            "call-delta",
            { path: "new" },
            "reclaimable tool output ".repeat(1_000),
        );
        const messages = [...baseMessages, appended];
        const tags = [
            ...baseTags,
            tag(2, "call-delta", "tool", { toolOwnerMessageId: "tool-delta" }),
        ];
        const baseline = refreshTailHygieneBaseline({
            messages: baseMessages,
            tags: baseTags,
            protectedTagNumbers: new Set([1]),
            cacheBusting: true,
        });
        const protectedDefer = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTagNumbers: new Set([1, 2]),
            cacheBusting: false,
            previous: baseline,
        });
        const agedDefer = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTagNumbers: new Set([1]),
            cacheBusting: false,
            previous: protectedDefer,
        });
        const measuredAged = measureTailHygiene({
            messages,
            tags,
            protectedTagNumbers: new Set([1]),
        });

        expect(effectiveTailHygiene(protectedDefer).u).toBe(0);
        expect(effectiveTailHygiene(agedDefer)).toEqual({
            u: measuredAged.u,
            t: measuredAged.t,
        });
    });

    it("adds exactly persisted mass when the protection boundary advances", () => {
        const before = [
            fileMessage("old", "old reclaimable mass ".repeat(100)),
            fileMessage("protected", "still protected ".repeat(100)),
        ];
        const beforeTags = [tag(1, "old:file0", "file"), tag(2, "protected:file0", "file")];
        const baseline = refreshTailHygieneBaseline({
            messages: before,
            tags: beforeTags,
            protectedTagNumbers: new Set([1, 2]),
            cacheBusting: true,
        });
        const oldMass = measureTailHygiene({
            messages: [before[0]],
            tags: [beforeTags[0]],
            protectedTagNumbers: new Set(),
        }).t;
        const appended = fileMessage("newest", "newest protected ".repeat(100));
        const defer = refreshTailHygieneBaseline({
            messages: [...before, appended],
            tags: [...beforeTags, tag(3, "newest:file0", "file")],
            protectedTagNumbers: new Set([2, 3]),
            cacheBusting: false,
            previous: baseline,
        });

        expect(baseline.baselineU).toBe(0);
        expect(defer.evaluable).toBe(true);
        expect(defer.turnDeltaU).toBe(oldMass);
        expect(defer.baselineGeneration).toBe(baseline.baselineGeneration);
    });

    it("ignores a Channel-1 reminder appended after the measured pass", () => {
        const original = nativeTool("owner", "call-reminder", { path: "x" }, "tool output");
        // The newest message is never frozen, so the tool arc being tested needs a
        // message after it to land inside the frozen prefix, where its delta is zero.
        const newest = textMessage("newest", "newest turn");
        const tags = [tag(1, "call-reminder", "tool", { toolOwnerMessageId: "owner" })];
        const baseline = refreshTailHygieneBaseline({
            messages: [original, newest],
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        const mutated = structuredClone(original) as MessageLike;
        const toolPart = mutated.parts[0] as { state: { output: string } };
        toolPart.state.output += buildChannel1Reminder("gentle", 25_000, 16);
        const defer = refreshTailHygieneBaseline({
            messages: [mutated, newest],
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: false,
            previous: baseline,
        });

        expect(defer.evaluable).toBe(true);
        expect(defer.turnDeltaU).toBe(0);
        expect(defer.turnDeltaT).toBe(baseline.turnDeltaT);
        expect(effectiveTailHygiene(defer)).toEqual(effectiveTailHygiene(baseline));
    });

    it("re-measures a non-append mutation on the defer pass that finds it", () => {
        const newest = textMessage("newest", "newest turn");
        const original = [textMessage("m", "original content"), newest];
        const tags = [tag(1, "m:p0", "message")];
        const baseline = refreshTailHygieneBaseline({
            messages: original,
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        const changed = [textMessage("m", "changed content and then some"), newest];
        const defer = refreshTailHygieneBaseline({
            messages: changed,
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: false,
            previous: baseline,
        });
        const measured = measureTailHygiene({
            messages: changed,
            tags,
            protectedTagNumbers: new Set(),
        });
        const steady = refreshTailHygieneBaseline({
            messages: changed,
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: false,
            previous: defer,
        });

        // The mutation is detected and reported, then measured on this same pass
        // instead of being held until the next cache-busting pass.
        expect(defer.lastPrefixMismatch).toMatchObject({
            partIndex: 0,
            messageId: "m",
            field: "contentHash",
        });
        expect(defer.evaluable).toBe(true);
        expect(defer.generationInvalidated).toBe(false);
        expect(defer.baselineGeneration).toBe(baseline.baselineGeneration + 1);
        expect(effectiveTailHygiene(defer)).toEqual({ u: measured.u, t: measured.t });
        // One invalidation event, one diagnostic: the next quiet pass reports none.
        expect(steady.lastPrefixMismatch).toBeUndefined();
        expect(steady.baselineGeneration).toBe(defer.baselineGeneration);
    });

    it("detects a byte mutation after the walk with a content-hash assertion", () => {
        const messages = [textMessage("m", "stable content")];
        const tags = [tag(1, "m:p0", "message")];
        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        (messages[0].parts[0] as { text: string }).text = "mutated bytes!";

        expect(() =>
            assertTailHygieneContentUnchanged({
                messages,
                tags,
                protectedTagNumbers: new Set(),
                expectedSignature: measured.contentSignature,
            }),
        ).toThrow(/tail hygiene walk was not the last byte-affecting operation/i);
    });
});

describe("tail hygiene image content memoization", () => {
    it("hashes raw and prefixed user/tool-result images without text-tokenizing their payloads", () => {
        const rawPayload = "A".repeat(3 * 1024 * 1024);
        const prefixedPayload = `data:image/png;base64,${rawPayload}`;
        const messages = [
            message("user-image", "user", [{ type: "file", mime: "image/png", url: rawPayload }]),
            message("tool-result-image", "assistant", [
                { type: "file", mime: "image/png", url: prefixedPayload },
            ]),
        ];
        const tokenizer = spyOn(formattingModule, "estimateTokens");
        try {
            const tags = [
                tag(1, "user-image:file0", "file"),
                tag(2, "tool-result-image:file0", "file"),
            ];
            const baseline = measureTailHygiene({
                messages,
                tags,
                protectedTagNumbers: new Set(),
            });
            const measured = measureTailHygiene({
                messages,
                tags,
                protectedTagNumbers: new Set([2]),
                pendingDropTagNumbers: new Set([1]),
            });
            const imageParts = measured.parts.filter((part) => part.kind === "file");
            const imagePayloadCalls = tokenizer.mock.calls.filter(
                ([content]) => typeof content === "string" && content.includes(rawPayload),
            );

            expect(imagePayloadCalls).toHaveLength(0);
            expect(imageParts.map(({ kind, tokens }) => ({ kind, tokens }))).toEqual([
                { kind: "file", tokens: 1200 },
                { kind: "file", tokens: 1200 },
            ]);
            expect(measured.t).toBe(baseline.t);
            expect(measured.u).toBe(0);
            expect(baseline.contentSignature).toBe(measured.contentSignature);
            expect(measured.contentSignature).toBe("30a3de96");
            expect(measured.parts.find((part) => part.tagNumber === 1)).toMatchObject({
                queuedForDrop: true,
                protected: false,
            });
            expect(measured.parts.find((part) => part.tagNumber === 2)).toMatchObject({
                queuedForDrop: false,
                protected: true,
                uTokens: 0,
            });
        } finally {
            tokenizer.mockRestore();
        }
    });

    it("counts a previously hash-only file key exactly once when text accounting follows", () => {
        const content = `data:image/png;base64,${"B".repeat(64)}`;
        const part = { type: "file", mime: "image/png", url: content };
        const imageMessage = message("hash-first", "user", [part]);
        const expectedTextTokens = formattingModule.estimateTokens(content);
        const tokenizer = spyOn(formattingModule, "estimateTokens");
        try {
            measureTailHygiene({
                messages: [imageMessage],
                tags: [tag(3, "hash-first:file0", "file")],
                protectedTagNumbers: new Set(),
            });
            part.mime = "text/plain";
            const measured = measureTailHygiene({
                messages: [imageMessage],
                tags: [tag(3, "hash-first:file0", "file")],
                protectedTagNumbers: new Set(),
            });
            const textCalls = tokenizer.mock.calls.filter(([value]) => value === content);

            expect(textCalls).toHaveLength(1);
            expect(measured.parts[0]?.tokens).toBe(expectedTextTokens);
        } finally {
            tokenizer.mockRestore();
        }
    });

    it("calibrates the Fable tool-only hygiene floors and reminder figures", () => {
        const tokenizer = spyOn(formattingModule, "estimateTokens").mockImplementation((content) =>
            content.startsWith("fable-output-") ? 10_000 : 0,
        );
        try {
            const messages = [1, 2, 3, 4].map((number) =>
                nativeTool(
                    `fable-owner-${number}`,
                    `fable-call-${number}`,
                    {},
                    `fable-output-${number}`,
                ),
            );
            const tags = [1, 2, 3, 4].map((number) =>
                tag(number, `fable-call-${number}`, "tool", {
                    toolOwnerMessageId: `fable-owner-${number}`,
                }),
            );
            const baseline = refreshTailHygieneBaseline({
                messages,
                tags,
                protectedTagNumbers: new Set([3, 4]),
                cacheBusting: true,
                calibration: { toolsRatio: 1.551639, proseRatio: 1.571778 },
                hygieneUnitsVersion: 2,
            });
            const effective = effectiveTailHygiene(baseline);
            const decision = decideChannel1({
                ...baseline,
                lastNudgeUndropped: 0,
                lastNudgeLevel: "",
                hasRecentReduce: false,
            });

            expect(effective).toEqual({ u: 31_033, t: 62_066 });
            expect(decision).toMatchObject({ fire: true, band: "firm", level: "firm" });
            expect(buildChannel1Reminder("firm", effective.u, 4)).toContain(
                "4 spent tool outputs (~31k tokens)",
            );
        } finally {
            tokenizer.mockRestore();
        }
    });

    it("caches a genuine zero and keeps excluded content out of the tokenizer", () => {
        const zeroContent = "opencode-zero-token-fixture";
        const excludedContent = "opencode-excluded-fixture";
        const tokenizer = spyOn(formattingModule, "estimateTokens").mockImplementation((content) =>
            content === zeroContent ? 0 : 1,
        );
        try {
            const messages = [
                message("zero", "user", [
                    { type: "text", text: zeroContent },
                    { type: "thinking", thinking: excludedContent },
                ]),
            ];
            const input = {
                messages,
                tags: [tag(4, "zero:p0", "message")],
                protectedTagNumbers: new Set<number>(),
            };
            const first = measureTailHygiene(input);
            const second = measureTailHygiene(input);
            expect(first.parts.find((part) => part.kind === "text")?.tokens).toBe(0);
            expect(second.parts.find((part) => part.kind === "text")?.tokens).toBe(0);
            expect(tokenizer.mock.calls.filter(([value]) => value === zeroContent)).toHaveLength(1);
            expect(
                tokenizer.mock.calls.filter(([value]) => value === excludedContent),
            ).toHaveLength(0);
        } finally {
            tokenizer.mockRestore();
        }
    });
});

describe("tail hygiene walk performance", () => {
    it("tokenizes each rendered character exactly once, whatever the rendered size", () => {
        // This is the load-invariant half of the linear-cost claim, and it is the one
        // that always runs. "One pass over the rendered text" is a statement about
        // WORK, not about elapsed time: the walk must hand every rendered character to
        // the tokenizer exactly once and must not re-scan the text as it grows. Both
        // of those are exact counts, so a busy machine cannot change the answer — a
        // wall-clock ratio can be moved by a single scheduler stall, which is how the
        // ratio form of this test kept reading red on shared runners (10.66ms against
        // a 10.31ms bound derived from a 1.29ms small sample).
        //
        // A regression that re-read the text per tag, per part, or per pass would show
        // up here as more calls or more characters, at any load.
        const tags = [tag(1, "perf:p0", "message")];
        const workAt = (tokens: number, marker: string) => {
            // The walk memoizes token counts by content, so each size needs content no
            // earlier measurement can have cached.
            const text = `${marker} ${"token ".repeat(tokens)}`;
            const messages = [textMessage("perf", text)];
            let calls = 0;
            let charactersTokenized = 0;
            const tokenizer = spyOn(formattingModule, "estimateTokens").mockImplementation(
                (content: string) => {
                    calls += 1;
                    charactersTokenized += content.length;
                    return content.length;
                },
            );
            try {
                measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
            } finally {
                tokenizer.mockRestore();
            }
            return { calls, charactersTokenized, rendered: text.length };
        };
        const small = workAt(50_000, "tail-hygiene-walk-cost-50k");
        const large = workAt(250_000, "tail-hygiene-walk-cost-250k");

        expect(small.calls).toBe(1);
        expect(large.calls).toBe(1);
        expect(small.charactersTokenized).toBe(small.rendered);
        expect(large.charactersTokenized).toBe(large.rendered);
        // Five times the text, five times the work, to the character.
        expect(large.charactersTokenized * small.rendered).toBe(
            small.charactersTokenized * large.rendered,
        );
    });

    it("scales linearly with rendered size (250k tokens cost at most ~5x 50k)", () => {
        // The wall-clock form of the same claim. Even measured as same-process medians
        // the ratio starves on a loaded shared runner: the 50k sample is small enough
        // (1–3ms) that one scheduler stall in the 250k sample moves the ratio past any
        // honest bound. So the bound is asserted only where wall-clock budgets mean
        // something and recorded otherwise; the count-based test above carries the
        // invariant everywhere else.
        const tags = [tag(1, "perf:p0", "message")];
        const timeAt = (tokens: number): number => {
            const messages = [textMessage("perf", "token ".repeat(tokens))];
            const durations: number[] = [];
            for (let iteration = 0; iteration < 25; iteration += 1) {
                const start = performance.now();
                measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
                durations.push(performance.now() - start);
            }
            durations.sort((left, right) => left - right);
            return durations[Math.floor(durations.length / 2)];
        };
        const small = timeAt(50_000);
        const large = timeAt(250_000);
        console.log(`tail-hygiene-walk p50: 50k=${small.toFixed(3)}ms 250k=${large.toFixed(3)}ms`);
        if (process.env.MC_PERF_GATE) {
            expect(large).toBeLessThan(Math.max(small, 0.2) * 8);
            expect(large).toBeLessThan(30);
        }
    });
});

describe("tail hygiene structural signature", () => {
    it("counts nested string lengths, own keys and array elements without serializing or encoding", () => {
        const messages = [message("m", "user", [{ text: "🙂", nested: ["abc", null, 42, false] }])];
        const stringify = spyOn(JSON, "stringify").mockImplementation(() => {
            throw new Error("structural traversal must not serialize");
        });
        const encode = spyOn(TextEncoder.prototype, "encode").mockImplementation(() => {
            throw new Error("structural traversal must not encode");
        });
        let signature: ReturnType<typeof tailHygieneStructuralSignature>;
        try {
            signature = tailHygieneStructuralSignature(messages);
            expect(stringify).not.toHaveBeenCalled();
            expect(encode).not.toHaveBeenCalled();
        } finally {
            stringify.mockRestore();
            encode.mockRestore();
        }
        // Six own keys, five array elements, and ten UTF-16 string code units.
        expect(signature).toEqual({ messageCount: 1, partCounts: [1], totalBytes: 21 });
    });

    it("detects nested string growth and structural additions on the same objects", () => {
        const part = { text: "before", nested: ["kept"] };
        const messages = [message("m", "user", [part])];
        const before = tailHygieneStructuralSignature(messages);
        part.text += "!";
        expect(
            sameTailHygieneStructuralSignature(before, tailHygieneStructuralSignature(messages)),
        ).toBe(false);
        part.text = "before";
        part.nested.push("");
        expect(
            sameTailHygieneStructuralSignature(before, tailHygieneStructuralSignature(messages)),
        ).toBe(false);
        part.nested.pop();
        Object.assign(part, { added: null });
        expect(
            sameTailHygieneStructuralSignature(before, tailHygieneStructuralSignature(messages)),
        ).toBe(false);
    });

    it("remains a size alarm rather than a same-length content hash", () => {
        const part = { text: "before" };
        const messages = [message("m", "user", [part])];
        const before = tailHygieneStructuralSignature(messages);
        part.text = "after!";
        expect(
            sameTailHygieneStructuralSignature(before, tailHygieneStructuralSignature(messages)),
        ).toBe(true);
    });
});

describe("tail hygiene protectedTagNumbers set form (token window)", () => {
    it("consumes protectedTagNumbers set in tag-number coordinate space and excludes protected tool tags from U", () => {
        const messages = [
            nativeTool("owner-1", "call-1", { cmd: "test" }, "tool output 1 ".repeat(100)),
            nativeTool("owner-2", "call-2", { cmd: "test" }, "tool output 2 ".repeat(100)),
        ];
        const tags = [
            tag(10, "call-1", "tool", { toolOwnerMessageId: "owner-1" }),
            tag(20, "call-2", "tool", { toolOwnerMessageId: "owner-2" }),
        ];

        // Coordinate space: tag-number space. Tag 20 is in the token protection window
        const protectedTagNumbers: ReadonlySet<number> = new Set([20]);

        const measured = measureTailHygiene({
            messages,
            tags,
            protectedTagNumbers,
        });

        // Tag 10 is unprotected -> included in U
        // Tag 20 is protected -> excluded from U
        expect(measured.t).toBeGreaterThan(0);
        expect(measured.u).toBeGreaterThan(0);
        expect(measured.u).toBeLessThan(measured.t);

        const part10 = measured.parts.find((p) => p.tagNumber === 10);
        const part20 = measured.parts.find((p) => p.tagNumber === 20);
        expect(part10?.protected).toBe(false);
        expect(part10?.uTokens).toBeGreaterThan(0);
        expect(part20?.protected).toBe(true);
        expect(part20?.uTokens).toBe(0);
    });

    it("declares empty-window behavior: empty set protects 0 tool tags, non-tool tags are never reclaim targets", () => {
        const messages = [
            textMessage("msg-1", "prose message text ".repeat(50)),
            nativeTool("owner-1", "call-1", { cmd: "test" }, "tool output 1 ".repeat(50)),
        ];
        const tags = [
            tag(5, "msg-1:p0", "message"),
            tag(10, "call-1", "tool", { toolOwnerMessageId: "owner-1" }),
        ];

        // Empty window: protectedTagNumbers = empty set
        const protectedTagNumbers: ReadonlySet<number> = new Set();

        const measured = measureTailHygiene({
            messages,
            tags,
            protectedTagNumbers,
        });

        // Tool tag 10 is unprotected
        const toolPart = measured.parts.find((p) => p.tagNumber === 10);
        expect(toolPart?.protected).toBe(false);
        expect(toolPart?.uTokens).toBeGreaterThan(0);

        // Non-tool message tag 5 has its eligibility decided solely by independent protections (prose text)
        const msgPart = measured.parts.find((p) => p.tagNumber === 5);
        expect(msgPart?.kind).toBe("text");
    });
});

describe("tail baseline replay memo", () => {
    it("reuses unchanged message content on append while detecting historical in-place edits", () => {
        const messages = [
            nativeTool(
                "incremental-owner",
                "incremental-call",
                { path: "original-path" },
                "original output",
            ),
            textMessage("incremental-newest", "old newest"),
        ];
        const tags = [
            tag(101, "incremental-call", "tool", { toolOwnerMessageId: "incremental-owner" }),
        ];
        const input = { messages, tags, protectedTagNumbers: new Set<number>() };
        let previous = refreshTailHygieneBaseline({ ...input, cacheBusting: true });
        const serialize = spyOn(stableJson, "stableStringify");
        try {
            messages.push(textMessage("incremental-appended", "appended tail"));
            previous = refreshTailHygieneBaseline({ ...input, previous, cacheBusting: false });
            expect(serialize).not.toHaveBeenCalled();
            expect(previous.contentSignature).toBe(measureTailHygiene(input).contentSignature);
            (messages[0].parts[0] as { state: { input: { path: string } } }).state.input.path =
                "ORIGINAL-path";
            const edited = refreshTailHygieneBaseline({ ...input, previous, cacheBusting: false });
            expect(edited.lastPrefixMismatch?.messageId).toBe("incremental-owner");
            expect(edited.contentSignature).toBe(measureTailHygiene(input).contentSignature);
            expect(effectiveTailHygiene(edited)).toEqual({
                u: measureTailHygiene(input).u,
                t: measureTailHygiene(input).t,
            });
        } finally {
            serialize.mockRestore();
        }
    });

    it("rechecks cross-message ownership and paired drop sentinels on replay", () => {
        const messages = [
            message("arc-owner", "assistant", [
                { type: "tool_use", id: "arc", input: { command: "read" } },
            ]),
            textMessage("arc-middle", "middle"),
        ];
        const tags = [tag(102, "arc", "tool", { toolOwnerMessageId: "arc-owner" })];
        const input = { messages, tags, protectedTagNumbers: new Set<number>() };
        const previous = refreshTailHygieneBaseline({ ...input, cacheBusting: true });
        messages.push(
            message("arc-result", "user", [
                { type: "tool_result", tool_use_id: "arc", content: "[dropped §102§]" },
            ]),
        );
        const changed = refreshTailHygieneBaseline({ ...input, previous, cacheBusting: false });
        const fresh = measureTailHygiene(input);
        expect(changed.contentSignature).toBe(fresh.contentSignature);
        expect(effectiveTailHygiene(changed)).toEqual({ u: fresh.u, t: fresh.t });
        expect(changed.lastPrefixMismatch?.messageId).toBe("arc-owner");
    });

    it("requires the explicit debug flag for content assertions regardless of NODE_ENV", () => {
        const previousDebug = process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS;
        const previousNodeEnv = process.env.NODE_ENV;
        const input = {
            messages: [textMessage("debug-guard", "content")],
            tags: [],
            protectedTagNumbers: new Set<number>(),
            expectedSignature: "wrong",
        };
        try {
            process.env.NODE_ENV = "test";
            delete process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS;
            expect(() => assertTailHygieneContentUnchangedIfEnabled(input)).not.toThrow();
            process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS = "0";
            expect(() => assertTailHygieneContentUnchangedIfEnabled(input)).not.toThrow();
            process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS = "1";
            process.env.NODE_ENV = "production";
            expect(() => assertTailHygieneContentUnchangedIfEnabled(input)).toThrow(
                "tail hygiene walk was not the last byte-affecting operation",
            );
        } finally {
            if (previousDebug === undefined) delete process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS;
            else process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS = previousDebug;
            if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = previousNodeEnv;
        }
    });

    it("reuses exact replay measurements without serializing tool input again", () => {
        const input = {
            messages: [
                nativeTool("memo-owner", "memo-call", { path: "unique-memo-path" }, "memo output"),
                textMessage("memo-newest", "newest turn"),
            ],
            tags: [tag(1, "memo-call", "tool", { toolOwnerMessageId: "memo-owner" })],
            protectedTagNumbers: new Set<number>(),
            cacheBusting: false,
        };
        const first = refreshTailHygieneBaseline(input);
        const serialize = spyOn(stableJson, "stableStringify");
        try {
            const replay = refreshTailHygieneBaseline({
                ...structuredClone(input),
                previous: first,
            });
            expect(replay).toEqual(first);
            expect(serialize).not.toHaveBeenCalled();
            const changed = structuredClone(input);
            (
                changed.messages[0].parts[0] as { state: { input: { path: string } } }
            ).state.input.path = "unique-memo-PATh";
            const invalidated = refreshTailHygieneBaseline({ ...changed, previous: replay });
            expect(invalidated.lastPrefixMismatch?.messageId).toBe("memo-owner");
            expect(invalidated.baselineGeneration).toBe(first.baselineGeneration + 1);
            expect(invalidated.contentSignature).not.toBe(first.contentSignature);
            expect(serialize).toHaveBeenCalled();
        } finally {
            serialize.mockRestore();
        }
    });

    it("invalidates memo attribution on pending-drop, protection and tag changes", () => {
        const input = {
            messages: [
                nativeTool(
                    "memo-owner-2",
                    "memo-call-2",
                    { path: "file" },
                    "large output ".repeat(200),
                ),
                textMessage("memo-newest-2", "newest turn"),
            ],
            tags: [tag(2, "memo-call-2", "tool", { toolOwnerMessageId: "memo-owner-2" })],
            protectedTagNumbers: new Set<number>(),
            cacheBusting: false,
        };
        const first = refreshTailHygieneBaseline(input);
        expect(effectiveTailHygiene(first).u).toBeGreaterThan(0);
        const queued = refreshTailHygieneBaseline({
            ...input,
            previous: first,
            pendingDropTagNumbers: new Set([2]),
        });
        expect(effectiveTailHygiene(queued).u).toBe(0);
        const unqueued = refreshTailHygieneBaseline({ ...input, previous: queued });
        expect(effectiveTailHygiene(unqueued).u).toBe(effectiveTailHygiene(first).u);
        // Protection entering a frozen part and a tag leaving active are both
        // unattributable on a defer pass: each is named, then re-measured.
        const protectedReplay = refreshTailHygieneBaseline({
            ...input,
            previous: unqueued,
            protectedTagNumbers: new Set([2]),
        });
        expect(protectedReplay.lastPrefixMismatch?.field).toBe("protection-entered");
        expect(effectiveTailHygiene(protectedReplay).u).toBe(0);
        input.tags[0].status = "dropped";
        const dropped = refreshTailHygieneBaseline({ ...input, previous: first });
        expect(dropped.lastPrefixMismatch?.field).toBe("tagStatus");
        expect(dropped.baselineGeneration).toBe(first.baselineGeneration + 1);
        const rebuilt = refreshTailHygieneBaseline({
            ...input,
            previous: dropped,
            cacheBusting: true,
        });
        expect(rebuilt.generationInvalidated).toBe(false);
        expect(effectiveTailHygiene(rebuilt).u).toBe(0);
    });
});

describe("prose stays in T but not in U (#954)", () => {
    const reclaimableKinds = new Set(["toolInput", "toolOutput", "file"]);

    function toolAndFileTokens(parts: ReturnType<typeof measureTailHygiene>["parts"]): number {
        return parts
            .filter((part) => reclaimableKinds.has(part.kind) && part.tagStatus === "active")
            .reduce((sum, part) => sum + part.tokens, 0);
    }

    it("reads U = 0 for a tail of user and assistant prose with fully reduced tool output", () => {
        const messages = [
            textMessage("u1", "please look at the parser ".repeat(40)),
            nativeTool("a1", "call-dropped", { path: "parser.ts" }, "[dropped §2§]"),
            textMessage("a2", "the parser splits on commas ".repeat(40), "assistant"),
        ];
        const tags = [
            tag(1, "u1:p0", "message"),
            tag(2, "call-dropped", "tool", { toolOwnerMessageId: "a1" }),
            tag(3, "a2:p0", "message"),
        ];

        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });

        expect(measured.t).toBeGreaterThan(0);
        expect(measured.u).toBe(0);
        expect(measured.parts.filter((part) => part.kind === "text")).toHaveLength(2);
        expect(
            measured.parts
                .filter((part) => part.kind === "text")
                .every((part) => part.uTokens === 0),
        ).toBe(true);
    });

    it("counts only tool input, tool output and files in U of a mixed tail", () => {
        const messages = [
            textMessage("u1", "read the config file ".repeat(30)),
            nativeTool("a1", "call-read", { path: "config.json" }, "config body ".repeat(60)),
            message("u2", "user", [
                { type: "text", text: "here is the attachment" },
                {
                    type: "file",
                    mime: "text/plain",
                    url: "file://notes.txt",
                    content: "note ".repeat(50),
                },
            ]),
            textMessage("a2", "the config sets three keys ".repeat(30), "assistant"),
        ];
        const tags = [
            tag(1, "u1:p0", "message"),
            tag(2, "call-read", "tool", { toolOwnerMessageId: "a1" }),
            tag(3, "u2:p0", "message"),
            tag(4, "u2:file1", "file"),
            tag(5, "a2:p0", "message"),
        ];

        const measured = measureTailHygiene({ messages, tags, protectedTagNumbers: new Set() });
        const textTokens = measured.parts
            .filter((part) => part.kind === "text")
            .reduce((sum, part) => sum + part.tokens, 0);

        expect(textTokens).toBeGreaterThan(0);
        expect(measured.parts.some((part) => part.kind === "file" && part.uTokens > 0)).toBe(true);
        expect(measured.u).toBe(toolAndFileTokens(measured.parts));
        expect(measured.t).toBe(measured.u + textTokens);
    });

    it("keeps a defer pass after appended prose equal to a full walk", () => {
        const base = [
            textMessage("u1", "start the migration ".repeat(30)),
            nativeTool("a1", "call-1", { path: "schema.sql" }, "create table ".repeat(80)),
            textMessage("a2", "the schema has two tables ".repeat(30), "assistant"),
        ];
        const baseTags = [
            tag(1, "u1:p0", "message"),
            tag(2, "call-1", "tool", { toolOwnerMessageId: "a1" }),
            tag(3, "a2:p0", "message"),
        ];
        const first = refreshTailHygieneBaseline({
            messages: base,
            tags: baseTags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        const firstFull = measureTailHygiene({
            messages: base,
            tags: baseTags,
            protectedTagNumbers: new Set(),
        });
        expect(effectiveTailHygiene(first).u).toBe(toolAndFileTokens(firstFull.parts));

        const appended = [
            ...base,
            textMessage("u3", "now add an index ".repeat(30)),
            textMessage("a4", "the index is on the id column ".repeat(30), "assistant"),
        ];
        const appendedTags = [...baseTags, tag(4, "u3:p0", "message"), tag(5, "a4:p0", "message")];
        const deferred = refreshTailHygieneBaseline({
            messages: appended,
            tags: appendedTags,
            protectedTagNumbers: new Set(),
            cacheBusting: false,
            previous: first,
        });
        const full = refreshTailHygieneBaseline({
            messages: appended,
            tags: appendedTags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });

        expect(deferred.lastPrefixMismatch).toBeUndefined();
        expect(deferred.baselineGeneration).toBe(first.baselineGeneration);
        expect(effectiveTailHygiene(deferred)).toEqual(effectiveTailHygiene(full));
        expect(effectiveTailHygiene(deferred).u).toBe(effectiveTailHygiene(first).u);
        expect(effectiveTailHygiene(deferred).t).toBeGreaterThan(effectiveTailHygiene(first).t);

        // A second defer pass replays the unchanged prose messages from the memo.
        const again = [...appended, textMessage("u5", "thanks ".repeat(20))];
        const againTags = [...appendedTags, tag(6, "u5:p0", "message")];
        const replayed = refreshTailHygieneBaseline({
            messages: again,
            tags: againTags,
            protectedTagNumbers: new Set(),
            cacheBusting: false,
            previous: deferred,
        });
        const replayedFull = refreshTailHygieneBaseline({
            messages: again,
            tags: againTags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        expect(replayed.lastPrefixMismatch).toBeUndefined();
        expect(effectiveTailHygiene(replayed)).toEqual(effectiveTailHygiene(replayedFull));
        expect(effectiveTailHygiene(replayed).u).toBe(effectiveTailHygiene(first).u);
    });
});
