/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import prefixBoundGolden from "../../../../../crates/mc-module/testdata/prefix-bound-reasoning-trim.json";
import budgetGolden from "../../../../../crates/mc-module/testdata/reasoning-budget-trim.json";
import { sessionDecisionCalibration } from "../../features/magic-context/session-decision-calibration";
import {
    getActiveTagsBySession,
    getOrCreateSessionMeta,
    getTagsBySession,
    insertTag,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    addMergedReasoningStrippedIds,
    addTrailingBlankDecisions,
    getEmergencyInputSample,
    setEmergencyDropSample,
} from "../../features/magic-context/storage-meta-persisted";
import {
    addRemovedReasoningIds,
    getReasoningRemovalState,
    getRemovedReasoningIds,
} from "../../features/magic-context/storage-reasoning-removal";
import { readReplayDocument } from "../../features/magic-context/storage-replay-document";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { EmergencyFailClosedError } from "./emergency-fail-closed";
import { estimateTokens } from "./read-session-formatting";
import { reasoningBudgetCutoff, reasoningStepCost } from "./reasoning-budget";
import {
    removeReasoningParts,
    selectReasoningRemovals,
    settleDroppedReasoningParts,
} from "./reasoning-removal";
import {
    isAnthropicFamilyRoute,
    isNeutralizedReasoningPart,
    makeSentinel,
    neutralizeDroppedReasoningPart,
} from "./sentinel";
import { findMergedReasoningStripDecisions, replayClearedReasoning } from "./strip-content";
import type { MessageLike } from "./tag-messages";
import { type TagTarget, tagMessages } from "./tag-messages";
import { runPostTransformPhase } from "./transform-postprocess-phase";

type PostTransformArgs = Parameters<typeof runPostTransformPhase>[0];

let db: Database | undefined;
afterEach(() => {
    db?.close();
    db = undefined;
});

const REASONING = new Set(["reasoning", "thinking", "redacted_thinking"]);
const reasoningCount = (message: MessageLike): number =>
    message.parts.filter((part) => REASONING.has(String((part as { type?: unknown }).type))).length;
const sha256 = (value: unknown): string =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * One user turn followed by `steps` assistant steps, each shaped like an
 * OpenCode step on OpenAI Responses: step markers, a reasoning part whose
 * encrypted payload lives in provider metadata, and a completed tool call.
 * Assistant step `i` owns tag `i + 2` (the user text is tag 1).
 */
function toolLoop(steps: number, options: { reasoningOnlyStep?: number } = {}) {
    const messages: MessageLike[] = [
        {
            info: { id: "user-1", role: "user", sessionID: "s" },
            parts: [{ type: "text", text: "do the work" }],
        } as unknown as MessageLike,
    ];
    for (let step = 0; step < steps; step += 1) {
        const reasoningOnly = options.reasoningOnlyStep === step;
        messages.push({
            info: {
                id: `assistant-${step}`,
                role: "assistant",
                sessionID: "s",
                tokens: { reasoning: 100 },
            },
            parts: [
                { type: "step-start" },
                {
                    type: "reasoning",
                    text: `thinking ${step}`,
                    metadata: {
                        openai: {
                            itemId: `rs_${step}`,
                            reasoningEncryptedContent: `ENC_${step}_${"x".repeat(64)}`,
                        },
                    },
                },
                ...(reasoningOnly
                    ? []
                    : [
                          {
                              type: "tool",
                              tool: "bash",
                              callID: `call-${step}`,
                              state: { status: "completed", input: {}, output: `out ${step}` },
                          },
                      ]),
                { type: "step-finish" },
            ],
        } as unknown as MessageLike);
    }
    const tags = new Map<MessageLike, number>();
    messages.forEach((message, index) => {
        if (message.info.role === "user") tags.set(message, 1);
        else if (message.parts.some((part) => (part as { type?: string }).type === "tool"))
            tags.set(message, index + 1);
    });
    return { messages, tags };
}

// The calibration witness prices historical steps rather than the active user
// turn. Its context carrier is synthetic; toolLoop retains its original shape.
function historicalToolLoop(steps: number) {
    const session = toolLoop(steps);
    (session.messages[0].parts[0] as Record<string, unknown>).synthetic = true;
    return session;
}

describe("selectReasoningRemovals", () => {
    it("random prefix sessions never leave a thinking gap across the stop rule", () => {
        let seed = 620;
        const random = (n: number) => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed % n;
        };
        for (let trial = 0; trial < 500; trial++) {
            const length = 3 + random(20);
            const { messages, tags } = toolLoop(length);
            const removedCount = random(length - 1);
            const alreadyRemoved = new Set(
                Array.from({ length: removedCount }, (_, i) => `assistant-${i}`),
            );
            for (let i = removedCount; i < length - 1; i++)
                if (random(3) === 0) tags.delete(messages[i + 1]);
            const steps = messages.slice(1).map((message, i) => ({
                tag: tags.get(message) ?? 0,
                cost: 1 + random(1000),
                exempt: i === length - 1,
                alreadyRemoved: alreadyRemoved.has(`assistant-${i}`),
            }));
            const cutoff = reasoningBudgetCutoff(steps, random(3000));
            const selected = selectReasoningRemovals({
                messages,
                messageTagNumbers: tags,
                cutoff,
                alreadyRemoved,
                prefixBound: true,
            });
            const gone = new Set([...alreadyRemoved, ...selected]);
            let seenKept = false;
            for (let i = 0; i < length; i++) {
                if (!gone.has(`assistant-${i}`)) seenKept = true;
                else expect({ trial, i, seenKept }).toEqual({ trial, i, seenKept: false });
            }
        }
    });
    it("matches the shared budget golden including the prefix-bound stop rule", () => {
        for (const scenario of budgetGolden.cases) {
            const { messages, tags } = toolLoop(scenario.steps.length);
            tags.clear();
            scenario.steps.forEach((step, index) => {
                if (step.tag > 0) tags.set(messages[index + 1], step.tag);
            });
            const alreadyRemoved = new Set(
                scenario.steps.flatMap((step, index) =>
                    step.already_removed ? [`assistant-${index}`] : [],
                ),
            );
            const cutoff = reasoningBudgetCutoff(
                scenario.steps.map((step) => ({
                    tag: step.tag,
                    cost: reasoningStepCost(
                        step.reported,
                        step.text_estimate ?? 0,
                        step.opaque === true,
                    ),
                    exempt: step.exempt,
                    alreadyRemoved: step.already_removed,
                })),
                scenario.budget,
            );
            const added = selectReasoningRemovals({
                messages,
                messageTagNumbers: tags,
                cutoff,
                alreadyRemoved,
                prefixBound: scenario.prefix_bound,
            });
            expect({
                name: scenario.name,
                removed: [...alreadyRemoved, ...added]
                    .map((id) => Number(id.slice("assistant-".length)))
                    .sort(),
            }).toEqual({ name: scenario.name, removed: scenario.removed_after });
        }
    });
    it("selects old reasoning-bearing assistants and never the newest", () => {
        const { messages, tags } = toolLoop(8);
        // maxTag = 9, age 3 → cutoff 6 → assistants with tags 2..6 (steps 0..4).
        const selected = selectReasoningRemovals({
            messages,
            messageTagNumbers: tags,
            cutoff: 6,
            alreadyRemoved: new Set(),
            prefixBound: false,
        });
        expect(selected).toEqual([
            "assistant-0",
            "assistant-1",
            "assistant-2",
            "assistant-3",
            "assistant-4",
        ]);

        // A newer user turn with many tags ages every assistant past the
        // cutoff; the newest assistant still keeps its reasoning.
        const followUp = {
            info: { id: "user-2", role: "user", sessionID: "s" },
            parts: [{ type: "text", text: "next" }],
        } as unknown as MessageLike;
        tags.set(followUp, 40);
        const all = selectReasoningRemovals({
            messages: [...messages, followUp],
            messageTagNumbers: tags,
            cutoff: 37,
            alreadyRemoved: new Set(),
            prefixBound: false,
        });
        expect(all).toContain("assistant-6");
        expect(all).not.toContain("assistant-7");
    });

    it("skips a message that would be left with no wire content", () => {
        const { messages, tags } = toolLoop(8, { reasoningOnlyStep: 2 });
        // A reasoning-only step has no tag of its own; give it one so only the
        // wire-content rule can exclude it.
        tags.set(messages[3], 4);
        const selected = selectReasoningRemovals({
            messages,
            messageTagNumbers: tags,
            cutoff: 6,
            alreadyRemoved: new Set(),
            prefixBound: false,
        });
        expect(selected).not.toContain("assistant-2");
        expect(selected).toContain("assistant-3");
    });

    // Rows of Anthropic's "What counts as an edit" table
    // (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking).
    it('prefix-bound: "Remove `thinking` blocks from the start of the history" is valid, so the oldest aged prefix is selected', () => {
        const { messages, tags } = toolLoop(8);
        const selected = selectReasoningRemovals({
            messages,
            messageTagNumbers: tags,
            cutoff: 6,
            alreadyRemoved: new Set(),
            prefixBound: true,
        });
        expect(selected).toEqual([
            "assistant-0",
            "assistant-1",
            "assistant-2",
            "assistant-3",
            "assistant-4",
        ]);
    });

    it('prefix-bound: "Remove a `thinking` block from the middle of the history and keep later ones" is invalid, so the walk stops at the first message it may not remove', () => {
        const { messages, tags } = toolLoop(8, { reasoningOnlyStep: 2 });
        tags.set(messages[3], 4);
        const selected = selectReasoningRemovals({
            messages,
            messageTagNumbers: tags,
            cutoff: 6,
            alreadyRemoved: new Set(),
            prefixBound: true,
        });
        // assistant-3 and assistant-4 are old enough, but removing them while
        // assistant-2 keeps its block would be a removal from the middle.
        expect(selected).toEqual(["assistant-0", "assistant-1"]);

        // Messages whose reasoning is already gone are passed over, so the
        // prefix continues behind them.
        expect(
            selectReasoningRemovals({
                messages,
                messageTagNumbers: tags,
                cutoff: 6,
                alreadyRemoved: new Set(["assistant-0"]),
                prefixBound: true,
                alsoGone: new Set(["assistant-1", "assistant-2"]),
            }),
        ).toEqual(["assistant-3", "assistant-4"]);
    });

    it("prefix-bound: matches the shared TypeScript, Pi and Rust golden", () => {
        for (const scenario of prefixBoundGolden.cases) {
            const { messages, tags } = toolLoop(scenario.steps);
            for (const message of messages) {
                const step = message.info.id?.replace("assistant-", "a");
                if (step && scenario.untagged.includes(step)) tags.delete(message);
            }
            const removed = scenario.already_removed.map((step) => step.replace("a", "assistant-"));
            const selected = selectReasoningRemovals({
                messages,
                messageTagNumbers: tags,
                cutoff: Math.max(...tags.values()) - scenario.clear_reasoning_age,
                alreadyRemoved: new Set(removed),
                prefixBound: true,
            });
            const after = [...removed, ...selected]
                .map((id) => id.replace("assistant-", "a"))
                .sort();
            expect({ name: scenario.name, after }).toEqual({
                name: scenario.name,
                after: [...scenario.removed_after].sort(),
            });
        }
    });

    it("does not stop at an ineligible message and does not reselect removed ids", () => {
        const { messages, tags } = toolLoop(8, { reasoningOnlyStep: 2 });
        tags.set(messages[3], 4);
        const selected = selectReasoningRemovals({
            messages,
            messageTagNumbers: tags,
            cutoff: 6,
            alreadyRemoved: new Set(["assistant-0"]),
            prefixBound: false,
        });
        expect(selected).toEqual(["assistant-1", "assistant-3", "assistant-4"]);
    });
});

describe("removeReasoningParts", () => {
    it("removes whole reasoning parts with their provider metadata and keeps everything else", () => {
        const { messages } = toolLoop(3);
        const removed = removeReasoningParts(messages, new Set(["assistant-0"]), "openai");
        expect(removed).toBe(1);
        expect(reasoningCount(messages[1])).toBe(0);
        expect(JSON.stringify(messages[1])).not.toContain("ENC_0");
        expect(messages[1].parts.map((part) => (part as { type: string }).type)).toEqual([
            "step-start",
            "tool",
            "step-finish",
        ]);
        expect(reasoningCount(messages[2])).toBe(1);
    });

    it("never leaves a selected message without wire content", () => {
        const { messages } = toolLoop(3, { reasoningOnlyStep: 0 });
        removeReasoningParts(messages, new Set(["assistant-0"]), "openai");
        expect(messages[1].parts).toContainEqual({ type: "text", text: "[dropped]" });
    });
});

describe("reasoning removal through postprocess", () => {
    function openDb(): Database {
        db = new Database(":memory:");
        initializeDatabase(db);
        return db;
    }

    function pass(
        database: Database,
        sessionId: string,
        session: { messages: MessageLike[]; tags: Map<MessageLike, number> },
        options: {
            busting: boolean;
            providerID: string | undefined;
            prefixBound?: boolean;
            overrides?: Partial<PostTransformArgs>;
        },
    ) {
        const args: PostTransformArgs = {
            sessionId,
            db: database,
            messages: session.messages,
            tags: [],
            targets: new Map(),
            reasoningByMessage: new Map(),
            messageTagNumbers: session.tags,
            tagger: createTagger(),
            ctxReduceAvailability: { callable: true, frozen: true },
            todowriteAvailability: { callable: true, frozen: true },
            batch: null,
            contextUsage: { percentage: 20, inputTokens: 1000 },
            usableWindow: 128_000,
            schedulerDecision: "defer",
            schedulerDeferReason: "scheduler_defer",
            fullFeatureMode: false,
            canRunCompartments: false,
            awaitedCompartmentRun: false,
            phaseJustAwaitedPublication: false,
            compartmentInProgress: false,
            historyRefreshExplicitBeforePrepare: false,
            deferredHistoryWasPendingAtPassStart: false,
            compartmentInjectionRebuiltFromDb: false,
            rebuiltHistoryFromInitialPrepare: false,
            historyRebuiltThisPass: false,
            canConsumeDeferredLate: false,
            sessionMeta: getOrCreateSessionMeta(database, sessionId),
            currentTurnId: null,
            pendingMaterializationSessions: new Set(options.busting ? [sessionId] : []),
            deferredHistoryRefreshSessions: new Set(),
            deferredMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            keepReasoningTokens: 300,
            protectedTagIds: new Set(),
            protectedTagNumbers: new Set(),
            protectedCutoff: null,
            protectedCount: 0,
            pendingCompartmentInjection: null,
            didMutateFromFlushedStatuses: false,
            watermark: 0,
            forceMaterializationPercentage: 85,
            hasRecentReduceCall: false,
            resolvedProviderID: options.providerID,
            thinkingBindingRecoveryEnabledForModel: options.prefixBound ?? false,
            ...options.overrides,
        };
        return runPostTransformPhase(args);
    }

    it("review: bust selection applies frozen prose calibration to unstored thinking estimates", async () => {
        const database = openDb();
        const sessionId = "review-calibrated-fallback";
        getOrCreateSessionMeta(database, sessionId);
        const ratio = sessionDecisionCalibration(database, sessionId, {
            bustPermitted: true,
            modelKey: "anthropic/claude-opus-5-5",
        }).proseRatio;
        expect(ratio).toBeGreaterThan(1);
        const session = historicalToolLoop(3);
        for (const message of session.messages.slice(1)) {
            (message.info as unknown as Record<string, unknown>).tokens = { reasoning: 0 };
            (message.parts[1] as { text: string }).text = "a substantial thought ".repeat(100);
        }
        const rawCost = estimateTokens("a substantial thought ".repeat(100));
        // Three raw estimates fit, but only the newest calibrated estimate fits.
        await pass(database, sessionId, session, {
            busting: true,
            providerID: "google-vertex-anthropic",
            prefixBound: true,
            overrides: { keepReasoningTokens: 3 * rawCost },
        });
        expect(getRemovedReasoningIds(database, sessionId)).toEqual(
            new Set(["assistant-0", "assistant-1"]),
        );
    });

    it("review: merged-assistant frozen strips cost zero on the next budget rebuild", async () => {
        const database = openDb();
        const sessionId = "review-merged-cost";
        getOrCreateSessionMeta(database, sessionId);
        const session = toolLoop(3);
        (session.messages[2].info as unknown as Record<string, unknown>).tokens = {
            reasoning: 20_000,
        };
        const frozen = findMergedReasoningStripDecisions(session.messages, "anthropic", new Set(), {
            mutationExemptMessage: session.messages[3],
        });
        expect(frozen).toContain("assistant-1");
        expect(addMergedReasoningStrippedIds(database, sessionId, frozen)).toBe(true);
        await pass(database, sessionId, session, {
            busting: true,
            providerID: "anthropic",
            overrides: {
                keepReasoningTokens: 200,
                reasoningByMessage: new Map(
                    session.messages
                        .slice(1)
                        .map((message) => [
                            message,
                            [message.parts[1] as import("./tag-messages").ThinkingLikePart],
                        ]),
                ),
            },
        });
        // a1 is already off-wire. a0 + newest a2 cost 100 + 100 and both fit.
        expect(getOrCreateSessionMeta(database, sessionId).clearedReasoningThroughTag).toBe(0);
    });

    it("removes old reasoning on a rebuilding pass and replays it byte-identically on defer passes", async () => {
        const database = openDb();
        const sessionId = "ses-openai-removal";

        // A defer pass never originates a removal.
        const before = toolLoop(8);
        await pass(database, sessionId, before, { busting: false, providerID: "openai" });
        expect(before.messages.slice(1).every((m) => reasoningCount(m) === 1)).toBe(true);
        expect(getRemovedReasoningIds(database, sessionId).size).toBe(0);

        // The rebuilding pass freezes and removes the old reasoning.
        const busting = toolLoop(8);
        await pass(database, sessionId, busting, { busting: true, providerID: "openai" });
        const removed = [0, 1, 2, 3, 4].map((step) => `assistant-${step}`);
        expect(getRemovedReasoningIds(database, sessionId)).toEqual(new Set(removed));
        for (const id of removed) {
            const message = busting.messages.find((m) => m.info.id === id) as MessageLike;
            expect(reasoningCount(message)).toBe(0);
        }
        expect(JSON.stringify(busting.messages)).not.toContain("ENC_0");
        expect(reasoningCount(busting.messages[busting.messages.length - 1])).toBe(1);

        // OpenCode rebuilds the array from its DB on every pass. Two defer
        // passes, the second with a longer tail, serve the same shared prefix.
        const deferOne = toolLoop(8);
        await pass(database, sessionId, deferOne, { busting: false, providerID: "openai" });
        expect(sha256(deferOne.messages)).toBe(sha256(busting.messages));

        const deferTwo = toolLoop(12);
        await pass(database, sessionId, deferTwo, { busting: false, providerID: "openai" });
        expect(sha256(deferTwo.messages.slice(0, busting.messages.length))).toBe(
            sha256(busting.messages),
        );
        // Newly aged reasoning waits for the next rebuilding pass.
        expect(reasoningCount(deferTwo.messages[6])).toBe(1);
        expect(getRemovedReasoningIds(database, sessionId)).toEqual(new Set(removed));
    });

    it("uses fixed 10000 by default at every window and charges reported counts rather than short summaries", async () => {
        const database = openDb();
        for (const window of [128_000, 272_000, 1_000_000]) {
            const sessionId = `fixed-budget-${window}`;
            const session = toolLoop(3);
            for (const message of session.messages.slice(1)) {
                (message.info as unknown as Record<string, unknown>).tokens = { reasoning: 8000 };
            }
            await pass(database, sessionId, session, {
                busting: true,
                providerID: "openai",
                overrides: { keepReasoningTokens: undefined, usableWindow: window },
            });
            expect(getRemovedReasoningIds(database, sessionId)).toEqual(
                new Set(["assistant-0", "assistant-1"]),
            );
            expect(reasoningCount(session.messages.at(-1) as MessageLike)).toBe(1);
        }
    });

    it("leaves canonical Anthropic on its existing lane and its frozen set empty", async () => {
        const database = openDb();
        const sessionId = "ses-anthropic-unchanged";
        const busting = toolLoop(8);
        await pass(database, sessionId, busting, { busting: true, providerID: "anthropic" });
        expect(getRemovedReasoningIds(database, sessionId).size).toBe(0);
    });

    it("fails closed instead of serving nothing when the replay document itself is unreadable", async () => {
        const database = openDb();
        const sessionId = "ses-removal-write-fails";
        getOrCreateSessionMeta(database, sessionId);
        // A document this reader cannot parse: the removal set is unknown, so
        // serving an empty set could bring removed reasoning back.
        database
            .prepare("UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?")
            .run('{"version":7}', sessionId);
        await expect(
            pass(database, sessionId, toolLoop(8), { busting: true, providerID: "openai" }),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
    });

    it("stores the set without disturbing other replay document lanes", () => {
        const database = openDb();
        const sessionId = "ses-removal-document";
        getOrCreateSessionMeta(database, sessionId);
        database
            .prepare("UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?")
            .run(JSON.stringify({ "assistant-x": "strip" }), sessionId);
        expect(addRemovedReasoningIds(database, sessionId, ["assistant-0"])).toBe(true);
        const raw = database
            .prepare(
                "SELECT trailing_blank_decisions AS raw FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { raw: string };
        expect(JSON.parse(raw.raw)).toEqual({
            version: 2,
            trailingBlank: { "assistant-x": "strip" },
            reasoningRemoval: { messageIds: ["assistant-0"] },
            reasoningRemovalBackup: { messageIds: ["assistant-0"] },
        });
    });

    it("replays the last good set when the persisted state becomes unreadable", async () => {
        const database = openDb();
        const sessionId = "ses-removal-read-failure";
        const busting = toolLoop(8);
        await pass(database, sessionId, busting, { busting: true, providerID: "openai" });
        expect(getRemovedReasoningIds(database, sessionId).size).toBe(5);
        const raw = database
            .prepare(
                "SELECT trailing_blank_decisions AS raw FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { raw: string };
        const corrupted = JSON.parse(raw.raw);
        corrupted.reasoningRemoval.messageIds.push(42);
        database
            .prepare("UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?")
            .run(JSON.stringify(corrupted), sessionId);
        const deferred = toolLoop(8);
        await pass(database, sessionId, deferred, { busting: false, providerID: "openai" });
        expect(sha256(deferred.messages)).toBe(sha256(busting.messages));
    });

    it("never selects removals when the provider is unresolved", async () => {
        const database = openDb();
        const sessionId = "ses-removal-unresolved";
        const busting = toolLoop(8);
        await pass(database, sessionId, busting, { busting: true, providerID: undefined });
        expect(getRemovedReasoningIds(database, sessionId).size).toBe(0);
        expect(busting.messages.slice(1).every((m) => reasoningCount(m) === 1)).toBe(true);
    });

    it("serves a drop's old [cleared] bytes until the first rebuilding pass, then leaves reasoning intact", async () => {
        const database = openDb();
        const sessionId = "ses-drop-mode";
        // A drop replay neutralizes the reasoning it is linked to on every pass.
        const withDrop = () => {
            const session = toolLoop(4);
            neutralizeDroppedReasoningPart(session.messages[2].parts[1]);
            return session;
        };
        const legacy = withDrop();
        await pass(database, sessionId, legacy, { busting: false, providerID: "openai" });
        expect(legacy.messages[2].parts[1]).toMatchObject({ type: "reasoning", text: "[cleared]" });
        expect(JSON.stringify(legacy.messages)).toContain("ENC_1");

        const rebuild = withDrop();
        await pass(database, sessionId, rebuild, { busting: true, providerID: "openai" });
        expect((rebuild.messages[2].parts[1] as { text: string }).text).toStartWith("thinking 1");
        expect(JSON.stringify(rebuild.messages)).not.toContain("[cleared]");

        const after = withDrop();
        await pass(database, sessionId, after, { busting: false, providerID: "openai" });
        expect(sha256(after.messages)).toBe(sha256(rebuild.messages));
    });

    for (const fullFeatureMode of [false, true]) {
        it(`keeps the emergency minimum when only persisted drops are replayed (100%, sub-2,000 selection, ${fullFeatureMode ? "primary" : "subagent"})`, async () => {
            const database = openDb();
            const sessionId = `ses-emergency-minimum-${fullFeatureMode}`;
            const toolMessage = {
                info: { id: "assistant-fresh", role: "assistant", sessionID: "s" },
                parts: [
                    {
                        type: "tool",
                        tool: "bash",
                        callID: "call-fresh",
                        state: { status: "completed", input: {}, output: "word ".repeat(100) },
                    },
                ],
            } as unknown as MessageLike;
            const conversation = {
                info: { id: "user-big", role: "user", sessionID: "s" },
                parts: [{ type: "text", text: "word ".repeat(7_000) }],
            } as unknown as MessageLike;
            insertTag(
                database,
                sessionId,
                "user-big",
                "message",
                35_000,
                1,
                0,
                null,
                0,
                null,
                null,
                {
                    tokenCount: 8_750,
                    inputTokenCount: 0,
                    reasoningTokenCount: 0,
                },
            );
            insertTag(database, sessionId, "call-fresh", "tool", 500, 2, 0, "bash", 0, null, null, {
                tokenCount: 125,
                inputTokenCount: 0,
                reasoningTokenCount: 0,
            });
            const targets = new Map<number, TagTarget>([
                [
                    1,
                    {
                        message: conversation,
                        setContent: () => false,
                        getContent: () => "word ".repeat(7_000),
                    },
                ],
                [
                    2,
                    {
                        message: toolMessage,
                        setContent: () => false,
                        canDrop: () => toolMessage.parts.length > 0,
                        measureReclaim: () => ({
                            beforeTools: 125,
                            afterTools: 0,
                            beforeProse: 0,
                            afterProse: 0,
                        }),
                        drop: () => {
                            toolMessage.parts.splice(0, 1);
                            return "removed";
                        },
                        skeletonReal: () => "truncated",
                        inputStringBytes: () => 0,
                    },
                ],
            ]);
            await pass(
                database,
                sessionId,
                { messages: [conversation, toolMessage], tags: new Map() },
                {
                    busting: false,
                    providerID: "openai",
                    overrides: {
                        schedulerDecision: "execute",
                        contextUsage: { percentage: 100, inputTokens: 335_000 },
                        emergencyCeilingTokens: 251_000,
                        // Replaying a persisted drop restored bytes already served; it
                        // must not count as a rewrite this pass already pays for.
                        didMutateFromFlushedStatuses: true,
                        fullFeatureMode,
                        tags: getActiveTagsBySession(database, sessionId),
                        targets,
                        sessionMeta: getOrCreateSessionMeta(database, sessionId),
                    },
                },
            );
            const fresh = getTagsBySession(database, sessionId).find((tag) => tag.tagNumber === 2);
            expect(fresh?.status).toBe("active");
            expect(toolMessage.parts).toHaveLength(1);
        });
    }

    const reasoningMap = (messages: MessageLike[]) => {
        const map = new Map<MessageLike, { type: string; text?: string }[]>();
        for (const message of messages) {
            const parts = message.parts.filter(
                (part) => (part as { type?: string }).type === "reasoning",
            ) as { type: string; text?: string }[];
            if (parts.length > 0) map.set(message, parts);
        }
        return map;
    };
    /** ABORT makes the write throw; IGNORE makes it silently change nothing. */
    const blockWrites = (database: Database, column: string, how: "ABORT" | "IGNORE" = "ABORT") =>
        database.exec(
            `CREATE TRIGGER block_${column} BEFORE UPDATE OF ${column} ON session_meta BEGIN SELECT RAISE(${how === "ABORT" ? "ABORT, 'blocked'" : "IGNORE"}); END;`,
        );
    /** The persisted watermark, replayed onto a fresh array as transform.ts does on every pass. */
    const replayOnNextPass = (
        database: Database,
        sessionId: string,
        fresh: ReturnType<typeof toolLoop>,
    ) =>
        replayClearedReasoning(
            fresh.messages,
            reasoningMap(fresh.messages) as never,
            fresh.tags,
            getOrCreateSessionMeta(database, sessionId).clearedReasoningThroughTag ?? 0,
        );

    it("prefix-bound canonical Anthropic: the inline strip never advances the watermark that later replays clear typed reasoning", async () => {
        const database = openDb();
        const sessionId = "ses-bound-inline";
        // The proactive strip's write fails here, so nothing masks a moved watermark.
        blockWrites(database, "merged_reasoning_stripped_ids");
        const withInline = () => {
            const session = toolLoop(8);
            session.messages[1].parts.splice(2, 0, {
                type: "text",
                text: "<thinking>inline</thinking>answer 0",
            });
            return session;
        };
        await expect(
            pass(database, sessionId, withInline(), {
                busting: true,
                providerID: "anthropic",
                prefixBound: true,
            }),
        ).rejects.toMatchObject({
            name: "DegradedPassRefusalError",
            site: "merged-reasoning-strip-exception",
        });
        expect(getOrCreateSessionMeta(database, sessionId).clearedReasoningThroughTag ?? 0).toBe(0);
        const next = withInline();
        const before = sha256(next.messages);
        expect(replayOnNextPass(database, sessionId, next)).toBe(0);
        expect(sha256(next.messages)).toBe(before);
    });

    it("prefix-bound canonical Anthropic: the age lane never clears typed reasoning", async () => {
        const database = openDb();
        const sessionId = "ses-bound-age";
        blockWrites(database, "merged_reasoning_stripped_ids");
        const session = toolLoop(8);
        await expect(
            pass(database, sessionId, session, {
                busting: true,
                providerID: "anthropic",
                prefixBound: true,
                overrides: { reasoningByMessage: reasoningMap(session.messages) as never },
            }),
        ).rejects.toMatchObject({
            name: "DegradedPassRefusalError",
            site: "merged-reasoning-strip-exception",
        });
        expect(getOrCreateSessionMeta(database, sessionId).clearedReasoningThroughTag ?? 0).toBe(0);
        expect(JSON.stringify(session.messages)).not.toContain("[cleared]");
        const next = toolLoop(8);
        const before = sha256(next.messages);
        replayOnNextPass(database, sessionId, next);
        expect(sha256(next.messages)).toBe(before);
    });

    it("once the drop switch is persisted, an unresolved provider still serves the restored bytes", async () => {
        const database = openDb();
        const sessionId = "ses-switch-unresolved";
        const withDrop = () => {
            const session = toolLoop(4);
            neutralizeDroppedReasoningPart(session.messages[2].parts[1]);
            return session;
        };
        await pass(database, sessionId, withDrop(), { busting: true, providerID: "openai" });
        const resolved = withDrop();
        await pass(database, sessionId, resolved, { busting: false, providerID: "openai" });
        const unresolved = withDrop();
        await pass(database, sessionId, unresolved, { busting: false, providerID: undefined });
        expect(sha256(unresolved.messages)).toBe(sha256(resolved.messages));
        expect(JSON.stringify(unresolved.messages)).not.toContain("[cleared]");
    });

    it("refuses a failed rebuilding write without committing the drop switch", async () => {
        const database = openDb();
        const sessionId = "ses-switch-blocked";
        getOrCreateSessionMeta(database, sessionId);
        // The compare-and-swap finds nothing updated and gives up: the write
        // reports failure without throwing.
        blockWrites(database, "trailing_blank_decisions", "IGNORE");
        const session = toolLoop(4);
        neutralizeDroppedReasoningPart(session.messages[2].parts[1]);
        await expect(
            pass(database, sessionId, session, { busting: true, providerID: "openai" }),
        ).rejects.toMatchObject({
            name: "DegradedPassRefusalError",
            site: "reasoning-removal-persistence-failure",
        });
        expect(getReasoningRemovalState(database, sessionId).dropLeavesReasoning).toBe(false);
    });

    it("serves the committed set after the write, including ids another process added meanwhile", async () => {
        const database = openDb();
        const sessionId = "ses-committed-union";
        getOrCreateSessionMeta(database, sessionId);
        // Stand-in for a concurrent writer: when this pass's write lands, another
        // process's id (assistant-6, newer than the age cutoff) joins the set.
        database.exec(`CREATE TRIGGER concurrent_writer AFTER UPDATE OF trailing_blank_decisions ON session_meta
            WHEN NEW.trailing_blank_decisions LIKE '%assistant-0%' AND NEW.trailing_blank_decisions NOT LIKE '%assistant-6%'
            BEGIN
              UPDATE session_meta SET trailing_blank_decisions = json_insert(
                json_insert(NEW.trailing_blank_decisions, '$.reasoningRemoval.messageIds[#]', 'assistant-6'),
                '$.reasoningRemovalBackup.messageIds[#]', 'assistant-6')
              WHERE session_id = NEW.session_id;
            END;`);
        const session = toolLoop(8);
        await pass(database, sessionId, session, { busting: true, providerID: "openai" });
        expect(getRemovedReasoningIds(database, sessionId).has("assistant-6")).toBe(true);
        expect(reasoningCount(session.messages[7])).toBe(0);
    });

    it("fails the pass closed when neither the removal set nor its backup can be read", async () => {
        const database = openDb();
        const sessionId = "ses-removal-unreadable";
        await pass(database, sessionId, toolLoop(8), { busting: true, providerID: "openai" });
        const raw = database
            .prepare(
                "SELECT trailing_blank_decisions AS raw FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { raw: string };
        const corrupted = JSON.parse(raw.raw);
        corrupted.reasoningRemoval.messageIds.push(42);
        corrupted.reasoningRemovalBackup.messageIds.push(42);
        database
            .prepare("UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?")
            .run(JSON.stringify(corrupted), sessionId);
        await expect(
            pass(database, sessionId, toolLoop(8), { busting: false, providerID: "openai" }),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
    });

    it("reads the removal set from the envelope without reading any trailing-blank decision row", () => {
        const database = openDb();
        const sessionId = "ses-removal-many-decisions";
        const DECISIONS = 2_000;
        expect(
            addTrailingBlankDecisions(
                database,
                sessionId,
                Array.from({ length: DECISIONS }, (_, index) => [`a-${index}`, "strip"] as const),
            ),
        ).toBe(true);
        expect(addRemovedReasoningIds(database, sessionId, ["assistant-0", "assistant-1"])).toBe(
            true,
        );
        // A decision row whose value is not a valid decision. The removal read
        // never needs the decision rows, so this row must not make it fail.
        database
            .prepare(
                "INSERT INTO session_replay_decisions (session_id, message_id, decision) VALUES (?, ?, ?)",
            )
            .run(sessionId, "a-invalid", "bogus");
        // The rows are really there: the strict full-document read refuses them.
        expect(() => readReplayDocument(database, sessionId)).toThrow();

        const counters = { statements: 0, rowsRead: 0 };
        const originalPrepare = database.prepare;
        database.prepare = ((sql: string) => {
            const statement = originalPrepare.call(database, sql);
            if (!/FROM\s+session_replay_decisions/i.test(sql)) return statement;
            counters.statements += 1;
            const mutable = statement as unknown as {
                all: (...args: unknown[]) => unknown[];
                get: (...args: unknown[]) => unknown;
            };
            const all = mutable.all.bind(statement);
            const get = mutable.get.bind(statement);
            mutable.all = (...args: unknown[]) => {
                const rows = all(...args);
                counters.rowsRead += rows.length;
                return rows;
            };
            mutable.get = (...args: unknown[]) => {
                const row = get(...args);
                if (row !== undefined && row !== null) counters.rowsRead += 1;
                return row;
            };
            return statement;
        }) as typeof database.prepare;
        try {
            const state = getReasoningRemovalState(database, sessionId);
            expect(state.messageIds).toEqual(new Set(["assistant-0", "assistant-1"]));
            expect(state.dropLeavesReasoning).toBe(false);
        } finally {
            database.prepare = originalPrepare;
        }
        expect(counters).toEqual({ statements: 0, rowsRead: 0 });
    });

    it("does not rearm the emergency episode for replayed drop statuses", async () => {
        const database = openDb();
        const sessionId = "ses-latch";
        getOrCreateSessionMeta(database, sessionId);
        setEmergencyDropSample(database, sessionId, 90_000);
        await pass(database, sessionId, toolLoop(2), {
            busting: true,
            providerID: "openai",
            overrides: {
                schedulerDecision: "execute",
                contextUsage: { percentage: 90, inputTokens: 90_000 },
                emergencyCeilingTokens: 80_000,
                didMutateFromFlushedStatuses: true,
                sessionMeta: getOrCreateSessionMeta(database, sessionId),
            },
        });
        expect(getEmergencyInputSample(database, sessionId)).toBe(90_000);
    });
});

describe("reasoning invalidated by drops", () => {
    it("neutralizes in place to the exact makeSentinel shape (canonical Anthropic output unchanged)", () => {
        const original = {
            type: "reasoning",
            text: "signed thought",
            metadata: { anthropic: { signature: "sig" } },
            cache_control: { type: "ephemeral" },
        };
        const expected = makeSentinel(structuredClone(original));
        const part = structuredClone(original) as Record<string, unknown>;
        neutralizeDroppedReasoningPart(part);
        expect(JSON.stringify(part)).toBe(JSON.stringify(expected));
        expect(isNeutralizedReasoningPart(part)).toBe(true);
        const redacted = { type: "redacted_thinking", data: "opaque" };
        neutralizeDroppedReasoningPart(redacted);
        expect(redacted).toEqual({ type: "redacted_thinking", data: "opaque" });
    });

    it("a drop leaves non-Anthropic reasoning to the age lane: the part is restored byte for byte", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const { messages } = toolLoop(4);
        const original = structuredClone(messages[1]);
        const tagged = tagMessages("ses-drop-path", messages, createTagger(), db);
        const row = db
            .prepare(
                "SELECT tag_number AS tagNumber FROM tags WHERE message_id = ? AND type = 'tool'",
            )
            .get("call-1") as { tagNumber: number } | undefined;
        expect(tagged.targets.get(row?.tagNumber ?? -1)?.drop?.()).toBe("removed");
        tagged.batch?.finalize();
        // The tag lane links call-1 to the reasoning of the step before it.
        expect(isNeutralizedReasoningPart(messages[1].parts[1])).toBe(true);
        expect(settleDroppedReasoningParts(messages, "restore")).toBe(1);
        expect(JSON.stringify(messages[1].parts[1])).toBe(JSON.stringify(original.parts[1]));
        expect(JSON.stringify(messages)).not.toContain("[cleared]");
    });

    it("legacy mode reproduces the [cleared] bytes drops served before", () => {
        const { messages } = toolLoop(2);
        const part = messages[1].parts[1] as Record<string, unknown>;
        const legacyShape = { ...part, text: "[cleared]" };
        neutralizeDroppedReasoningPart(part);
        settleDroppedReasoningParts(messages, "legacy");
        expect(JSON.stringify(part)).toBe(JSON.stringify(legacyShape));
    });

    it("scopes the forced skeleton to Anthropic-family routes", () => {
        expect(isAnthropicFamilyRoute("anthropic", "claude-sonnet-5")).toBe(true);
        expect(isAnthropicFamilyRoute("google-vertex-anthropic", "claude-opus-5-5")).toBe(true);
        expect(isAnthropicFamilyRoute("vertex-eu-anthropic", "claude-sonnet-5")).toBe(true);
        expect(isAnthropicFamilyRoute("amazon-bedrock", "us.anthropic.claude-fable-5-1-v1:0")).toBe(
            true,
        );
        expect(isAnthropicFamilyRoute("github-copilot", "claude-sonnet-5")).toBe(true);
        expect(isAnthropicFamilyRoute("openrouter", "anthropic/claude-haiku-4.5")).toBe(true);
        // Non-Claude Bedrock models produce no signed Anthropic thinking.
        expect(isAnthropicFamilyRoute("amazon-bedrock", "amazon.nova-pro-v1:0")).toBe(false);
        expect(isAnthropicFamilyRoute("amazon-bedrock", "meta.llama3-70b-instruct-v1:0")).toBe(
            false,
        );
        expect(isAnthropicFamilyRoute("openrouter", "google/gemini-3-flash-preview")).toBe(false);
        expect(isAnthropicFamilyRoute("openai", "gpt-6.1-sol")).toBe(false);
        expect(isAnthropicFamilyRoute("google", "gemini-2.5-pro")).toBe(false);
        expect(isAnthropicFamilyRoute("deepseek", "deepseek-reasoner")).toBe(false);
    });
});

/**
 * One OpenCode assistant step for each route shape, carrying the reasoning
 * payload the route's adapter actually sends.
 */
function routeStep(
    route: "openai" | "vertex" | "deepseek" | "openrouter-claude" | "openrouter-gemini",
) {
    const reasoning: Record<string, unknown> = { type: "reasoning", text: "PAYLOAD thought" };
    const tool: Record<string, unknown> = {
        type: "tool",
        tool: "bash",
        callID: "call-x",
        state: { status: "completed", input: {}, output: "out" },
    };
    if (route === "openai")
        reasoning.metadata = {
            openai: { itemId: "rs_x", reasoningEncryptedContent: "PAYLOAD_ENC" },
        };
    if (route === "vertex") reasoning.metadata = { anthropic: { signature: "PAYLOAD_SIG" } };
    if (route === "openrouter-claude") {
        const details = [
            {
                type: "reasoning.text",
                text: "PAYLOAD thought",
                signature: "PAYLOAD_SIG",
                format: "anthropic-claude-v1",
            },
        ];
        reasoning.metadata = { openrouter: { reasoning_details: details } };
        tool.metadata = { openrouter: { reasoning_details: details } };
    }
    if (route === "openrouter-gemini") {
        const details = [
            {
                type: "reasoning.encrypted",
                data: "PAYLOAD_TSIG",
                id: "call-x",
                format: "google-gemini-v1",
            },
        ];
        reasoning.metadata = { openrouter: { reasoning_details: details } };
        tool.metadata = { openrouter: { reasoning_details: details } };
    }
    return {
        info: { id: "assistant-x", role: "assistant", sessionID: "s" },
        parts: [{ type: "step-start" }, reasoning, tool, { type: "step-finish" }],
    } as unknown as MessageLike;
}

describe("the removal lane never changes bytes without taking reasoning off the wire", () => {
    const routes = [
        ["openai", "openai"],
        ["vertex", "google-vertex-anthropic"],
        ["deepseek", "deepseek"],
        ["openrouter-claude", "openrouter"],
        ["openrouter-gemini", "openrouter"],
    ] as const;
    for (const [shape, providerID] of routes) {
        it(`${shape}: either every reasoning payload leaves, or nothing changes`, () => {
            const message = routeStep(shape);
            const newer = {
                ...routeStep("deepseek"),
                info: { id: "assistant-newer", role: "assistant" },
            } as MessageLike;
            const messages = [message, newer];
            const before = JSON.stringify(message);
            const selected = selectReasoningRemovals({
                messages,
                messageTagNumbers: new Map([
                    [message, 1],
                    [newer, 20],
                ]),
                cutoff: 15,
                alreadyRemoved: new Set(),
                prefixBound: false,
            });
            removeReasoningParts(messages, new Set(["assistant-x"]), providerID);
            const after = JSON.stringify(message);
            if (after !== before) {
                expect(after).not.toContain("PAYLOAD");
                expect(selected).toEqual(["assistant-x"]);
            } else {
                expect(selected).toEqual([]);
            }
        });
    }

    it("openrouter Claude: the signed reasoning_details copies on the tool call leave too", () => {
        const message = routeStep("openrouter-claude");
        removeReasoningParts(
            [message, routeStep("deepseek")],
            new Set(["assistant-x"]),
            "openrouter",
        );
        expect(JSON.stringify(message)).not.toContain("reasoning_details");
        expect(message.parts.some((part) => (part as { type: string }).type === "tool")).toBe(true);
    });

    it("openrouter Gemini: thought signatures on tool calls are never touched", () => {
        const message = routeStep("openrouter-gemini");
        const before = JSON.stringify(message);
        removeReasoningParts(
            [message, routeStep("deepseek")],
            new Set(["assistant-x"]),
            "openrouter",
        );
        expect(JSON.stringify(message)).toBe(before);
    });
});

describe("replay and route guards", () => {
    it("frozen replay remains absorbing when removed assistants become newest", () => {
        const { messages } = toolLoop(3);
        const newest = messages[messages.length - 1];
        removeReasoningParts(messages, new Set(["assistant-1", "assistant-2"]), "openai");
        expect(reasoningCount(messages[2])).toBe(0);
        expect(reasoningCount(newest)).toBe(0);
    });

    it("recognizes the OpenRouter adapter by its metadata under any provider id", () => {
        const message = routeStep("openrouter-claude");
        removeReasoningParts(
            [message, routeStep("deepseek")],
            new Set(["assistant-x"]),
            "my-gateway",
        );
        expect(JSON.stringify(message)).not.toContain("PAYLOAD");
    });

    it("never strips a reasoning_details entry without a format", () => {
        const message = routeStep("openrouter-claude");
        for (const part of message.parts) {
            const details = (
                part as {
                    metadata?: { openrouter?: { reasoning_details?: Record<string, unknown>[] } };
                }
            ).metadata?.openrouter?.reasoning_details;
            for (const detail of details ?? []) delete detail.format;
        }
        const before = JSON.stringify(message);
        const newer = routeStep("deepseek");
        const selected = selectReasoningRemovals({
            messages: [message, newer],
            messageTagNumbers: new Map([
                [message, 1],
                [newer, 20],
            ]),
            cutoff: 15,
            alreadyRemoved: new Set(),
            prefixBound: false,
        });
        expect(selected).toEqual([]);
        removeReasoningParts([message, newer], new Set(["assistant-x"]), "openrouter");
        expect(JSON.stringify(message)).toBe(before);
    });
});
