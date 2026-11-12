/// <reference types="bun-types" />

// A pass the provider has not measured is sized from a count of the request it
// will serve (servedRequestForSizing). Every pass removes again, at the end of
// its postprocess phase, the reasoning that earlier passes removed by message
// id, whether or not it clears any reasoning itself. These tests pin that the
// count leaves that reasoning out on a pass that clears nothing, including on a
// prefix-bound model, which never clears reasoning by age.

import { afterEach, describe, expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    addMergedReasoningStrippedIds,
    thinkingBindingRecoveryFrozenId,
} from "../../features/magic-context/storage-meta-persisted";
import { addRemovedReasoningIds } from "../../features/magic-context/storage-reasoning-removal";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    type PricedPassSizingInput,
    planPricedPass,
    servedRequestForSizing,
} from "./priced-pass-sizing";
import type { MessageLike } from "./tag-messages";

const SESSION = "priced-pass-sizing-session";
const databases: ContextDatabase[] = [];

afterEach(() => {
    for (const db of databases.splice(0)) closeQuietly(db);
});

function database(): ContextDatabase {
    const db = new Database(":memory:") as ContextDatabase;
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    return db;
}

function assistant(id: string): MessageLike {
    return {
        info: { id, role: "assistant", sessionID: SESSION },
        parts: [
            { type: "reasoning", text: `Thinking about ${id}.`, metadata: { signature: id } },
            { type: "text", text: `Answer ${id}.` },
        ],
    } as MessageLike;
}

function reasoningOf(messages: readonly MessageLike[]): string[] {
    return messages.flatMap((message) =>
        message.parts.some((part) => (part as { type?: string }).type === "reasoning")
            ? [String(message.info.id)]
            : [],
    );
}

function sizingInput(
    db: ContextDatabase,
    messages: MessageLike[],
    wholePartRemoval: boolean,
): PricedPassSizingInput {
    return {
        db,
        sessionId: SESSION,
        messages,
        messageTagNumbers: new Map(messages.map((message, index) => [message, index + 1])),
        headFolds: false,
        coveredInstructions: [],
        replayedRemovals: { providerID: "anthropic", wholePartRemoval, bindingStrips: true },
        // A prefix-bound model clears no reasoning by age.
        reasoning: undefined,
    };
}

describe("a priced pass is sized without the reasoning earlier passes removed", () => {
    it("leaves out stored removals and binding strips on a pass that clears nothing", () => {
        const db = database();
        const messages = ["a1", "a2", "a3", "a4"].map(assistant);
        // An earlier pass removed a1's reasoning by id, and a signed-thinking
        // binding strip took a2's off the request.
        expect(addRemovedReasoningIds(db, SESSION, ["a1"])).toBe(true);
        expect(
            addMergedReasoningStrippedIds(db, SESSION, [thinkingBindingRecoveryFrozenId("a2")]),
        ).toBe(true);
        const counted = servedRequestForSizing(sizingInput(db, messages, true), {
            editsWholePrefix: false,
            clearsReasoning: false,
        });
        expect(reasoningOf(counted)).toEqual(["a3", "a4"]);
        // The served messages are not changed.
        expect(reasoningOf(messages)).toEqual(["a1", "a2", "a3", "a4"]);
        expect(counted[2]).toBe(messages[2]!);
    });

    it("keeps stored removals in the count where the pass does not replay them", () => {
        const db = database();
        const messages = ["a1", "a2", "a3"].map(assistant);
        expect(addRemovedReasoningIds(db, SESSION, ["a1"])).toBe(true);
        expect(
            addMergedReasoningStrippedIds(db, SESSION, [thinkingBindingRecoveryFrozenId("a2")]),
        ).toBe(true);
        // Canonical Anthropic on a model that is not prefix-bound replays a
        // watermark instead of whole-part removals; binding strips still apply.
        const counted = servedRequestForSizing(sizingInput(db, messages, false), {
            editsWholePrefix: false,
            clearsReasoning: false,
        });
        expect(reasoningOf(counted)).toEqual(["a1", "a3"]);
    });
});

describe("the plan ends a bounded signed-thinking hold where the pass's sized reading does", () => {
    // A subagent execute pass whose force band starts at 85%, with the cap the
    // caller passes (75% at the default threshold). Its only ride is the subagent execute, which a held pass may not
    // take, so `editsWholePrefix` shows whether the plan still counts it held.
    const plan = (
        db: ContextDatabase,
        usage: { percentage: number; fromEstimate: boolean },
        cap: number | undefined,
    ) =>
        planPricedPass(
            {
                db,
                sessionId: SESSION,
                compactionOff: false,
                fullFeatureMode: false,
                schedulerDecision: "execute",
                forceMaterializationPercentage: 85,
                signedThinkingHold: true,
                signedThinkingHoldCapPercentage: cap,
                firstRender: false,
                folds: false,
                explicitFlush: false,
                materializationRequested: false,
                historyRebuilt: false,
                alreadyRanThisTurn: false,
            },
            usage,
        );

    it("keeps the hold below the cap and outside the force band", () => {
        expect(plan(database(), { percentage: 70, fromEstimate: true }, 75).editsWholePrefix).toBe(
            false,
        );
    });

    it("ends the hold in force-band pressure below the cap", () => {
        // A cap above the force band, as with an 82.7% threshold (cap 92.7%).
        expect(
            plan(database(), { percentage: 88, fromEstimate: false }, 92.7).editsWholePrefix,
        ).toBe(true);
        expect(
            plan(database(), { percentage: 88, fromEstimate: false }, undefined).editsWholePrefix,
        ).toBe(true);
        // A local count below 95% is not force-band pressure.
        expect(
            plan(database(), { percentage: 88, fromEstimate: true }, 92.7).editsWholePrefix,
        ).toBe(false);
    });

    it("ends the hold at the cap of a local count below the force band", () => {
        expect(plan(database(), { percentage: 80, fromEstimate: true }, 75).editsWholePrefix).toBe(
            true,
        );
    });
});
