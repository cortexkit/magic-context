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
import { decidePassMutation } from "./pass-mutation-decision";
import {
    type PricedPassPlanInput,
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

// A force trigger parked on an earlier frozen pass (signed thinking kept, or an
// unresolved project directory) withholds the force ride below 95% until it is
// released. The postprocess phase reads that permission when it decides the
// pass; the plan a priced pass is sized from must read the same one, or it
// counts a request with rewrites the pass will not make.
describe("the priced-pass plan reads the parked force trigger the pass decision reads", () => {
    type Row = Omit<
        PricedPassPlanInput,
        "db" | "sessionId" | "forceTriggerPermitted" | "materializationTriggerPermitted"
    > & {
        percentage: number;
        fromEstimate: boolean;
    };
    const flags = [false, true];
    const rows: Row[] = [];
    for (const percentage of [0, 50, 70, 86, 90, 95, 99])
        for (const fromEstimate of flags)
            for (const schedulerDecision of ["execute", "defer"] as const)
                for (const fullFeatureMode of flags)
                    for (const signedThinkingHold of flags)
                        for (const folds of flags)
                            for (const firstRender of flags)
                                for (const explicitFlush of flags)
                                    for (const compactionOff of flags)
                                        rows.push({
                                            percentage,
                                            fromEstimate,
                                            schedulerDecision,
                                            fullFeatureMode,
                                            signedThinkingHold,
                                            folds,
                                            firstRender,
                                            explicitFlush,
                                            compactionOff,
                                            forceMaterializationPercentage: 85,
                                            materializationRequested: explicitFlush,
                                            historyRebuilt: false,
                                            alreadyRanThisTurn: false,
                                        });
    /** Trigger-parking permissions; an omitted one is not passed to the plan. */
    type Permissions = { force?: boolean; materialization?: boolean };
    const plan = (db: ContextDatabase, row: Row, permissions: Permissions = {}) =>
        planPricedPass(
            {
                ...row,
                db,
                sessionId: SESSION,
                ...(permissions.force === undefined
                    ? {}
                    : { forceTriggerPermitted: permissions.force }),
                ...(permissions.materialization === undefined
                    ? {}
                    : { materializationTriggerPermitted: permissions.materialization }),
            },
            { percentage: row.percentage, fromEstimate: row.fromEstimate },
        );
    /**
     * The pass decision for the same pass, with no ride the plan cannot know. A
     * withheld materialization permission clears the flush and the request
     * before the decision, as the postprocess phase does.
     */
    const decision = (row: Row, { force = true, materialization = true }: Permissions = {}) =>
        decidePassMutation(
            {
                fullFeatureMode: row.fullFeatureMode,
                compactionOff: row.compactionOff,
                schedulerDecision: row.schedulerDecision,
                contextPercentage: row.percentage,
                forceMaterializationPercentage: row.forceMaterializationPercentage,
                contextUsageFromEstimate: row.fromEstimate,
                emergencyInputSample: () => 0,
                forceTriggerPermitted: force,
                servedShapeRepair: false,
                rewritingSignedPrefix: false,
                foldBustsServedPrefix: row.folds,
                firstRenderBust: row.firstRender,
                explicitFlush: row.explicitFlush && materialization,
                publishedHistory: false,
                historyRebuiltThisPass: row.historyRebuilt,
                materializationRequested: row.materializationRequested && materialization,
                alreadyRanThisTurn: row.alreadyRanThisTurn,
                signedThinkingHold: row.signedThinkingHold,
            },
            () => false,
        );

    it("predicts the whole-prefix rewrite the decision allows, parked or not", () => {
        const db = database();
        const mismatches = rows.flatMap((row) =>
            flags.flatMap((permitted) => {
                const allowed =
                    decision(row, { force: permitted }).publishedWorkDrainAllowed &&
                    !row.signedThinkingHold;
                return plan(db, row, { force: permitted }).editsWholePrefix === allowed
                    ? []
                    : [{ ...row, permitted, allowed }];
            }),
        );
        expect(mismatches).toEqual([]);
    });

    it("changes the plan only where a parked trigger withholds the force ride", () => {
        const db = database();
        const changed = rows.filter(
            (row) =>
                JSON.stringify(plan(db, row, { force: false })) !== JSON.stringify(plan(db, row)) ||
                JSON.stringify(plan(db, row, { force: true })) !== JSON.stringify(plan(db, row)),
        );
        // Omitting the permission still means permitted, and a parked trigger
        // matters only in the force band below 95% on a provider reading.
        expect(JSON.stringify(rows.map((row) => plan(db, row, { force: true })))).toBe(
            JSON.stringify(rows.map((row) => plan(db, row))),
        );
        expect(
            changed.filter(
                (row) =>
                    row.compactionOff ||
                    row.fromEstimate ||
                    row.percentage < 85 ||
                    row.percentage >= 95,
            ),
        ).toEqual([]);
        // The frozen pass without a hold that nothing else rebuilds: the plan
        // no longer counts the force ride's whole-prefix rewrite.
        const frozen = rows.find(
            (row) =>
                row.percentage === 90 &&
                !row.fromEstimate &&
                row.schedulerDecision === "execute" &&
                row.fullFeatureMode &&
                !row.signedThinkingHold &&
                !row.folds &&
                !row.firstRender &&
                !row.explicitFlush &&
                !row.compactionOff,
        )!;
        expect(decision(frozen, { force: false }).publishedWorkDrainAllowed).toBe(false);
        expect(plan(db, frozen, { force: false })).toEqual({
            editsWholePrefix: false,
            clearsReasoning: false,
        });
        expect(plan(db, frozen).editsWholePrefix).toBe(true);
        expect(changed).toContainEqual(frozen);
    });
    // The same holds for a materialization trigger parked behind kept signed
    // thinking: on a later frozen pass the postprocess phase clears the
    // `/ctx-flush` and the materialization request before it decides.
    it("predicts the whole-prefix rewrite the decision allows with a parked materialization trigger", () => {
        const db = database();
        const mismatches = rows.flatMap((row) =>
            flags.flatMap((force) =>
                flags.flatMap((materialization) => {
                    const permissions = { force, materialization };
                    const allowed =
                        decision(row, permissions).publishedWorkDrainAllowed &&
                        !row.signedThinkingHold;
                    return plan(db, row, permissions).editsWholePrefix === allowed
                        ? []
                        : [{ ...row, ...permissions, allowed }];
                }),
            ),
        );
        expect(mismatches).toEqual([]);
    });

    it("changes the plan only where a parked trigger withholds the flush", () => {
        const db = database();
        expect(JSON.stringify(rows.map((row) => plan(db, row, { materialization: true })))).toBe(
            JSON.stringify(rows.map((row) => plan(db, row))),
        );
        const changed = rows.filter(
            (row) =>
                JSON.stringify(plan(db, row, { materialization: false })) !==
                JSON.stringify(plan(db, row)),
        );
        // Only a pass that has a flush or a materialization request to withhold.
        expect(
            changed.filter((row) => !row.explicitFlush && !row.materializationRequested),
        ).toEqual([]);
        // The frozen pass without a hold whose only rebuild is the parked flush.
        const frozen = rows.find(
            (row) =>
                row.percentage === 50 &&
                !row.fromEstimate &&
                row.schedulerDecision === "defer" &&
                row.fullFeatureMode &&
                !row.signedThinkingHold &&
                !row.folds &&
                !row.firstRender &&
                row.explicitFlush &&
                !row.compactionOff,
        )!;
        expect(decision(frozen, { materialization: false }).publishedWorkDrainAllowed).toBe(false);
        expect(plan(db, frozen, { materialization: false }).editsWholePrefix).toBe(false);
        expect(plan(db, frozen).editsWholePrefix).toBe(true);
        expect(changed).toContainEqual(frozen);
    });
});
