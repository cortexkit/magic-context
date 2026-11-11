/// <reference types="bun-types" />

// Review witness for the priced-pass plan (`planPricedPass`). When the provider
// has not reported the token count of the previous request, a pass is sized by
// counting the request it will serve, and the plan predicts which rewrites that
// request contains: whether the pass rebuilds its whole cached prefix and clears
// reasoning. The pass decision (`decidePassMutation`) reads the parked bust
// triggers (trigger-parking.ts): on a frozen pass (kept signed thinking or an
// unresolved project directory) under the strict hold policy, a parked
// materialization trigger withholds the explicit `/ctx-flush` and the
// materialization request, just as a parked force trigger withholds the
// force-band rebuild (`forceRide`). The plan now reads the force permission;
// this test checks that it reads the materialization permission too.

import { afterEach, describe, expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { decidePassMutation } from "./pass-mutation-decision";
import { planPricedPass } from "./priced-pass-sizing";
import { ParkedBustTriggers } from "./trigger-parking";

const SESSION = "priced-pass-sizing-review-session";
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

describe("the priced-pass plan reads the parked materialization trigger the pass decision reads", () => {
    it("review witness: a parked /ctx-flush on a frozen pass without a hold is not sized as a whole-prefix rewrite", () => {
        const db = database();
        // An earlier pass that kept signed thinking parked the flush; this pass
        // is still frozen by an unresolved project directory, without a hold.
        const parked = new ParkedBustTriggers();
        parked.holdMaterialization("user_flush");
        const frozen = true;
        const permissions = parked.permissions(frozen, true, false);
        expect(permissions.materialization).toBe(false);

        // What the transform hands the plan on this pass: the pending flush as
        // queued (`hasPendingMaterializationOrigin(..., "user_flush")`) and the
        // pending materialization set, neither filtered by parking.
        const planned = planPricedPass(
            {
                db,
                sessionId: SESSION,
                compactionOff: false,
                fullFeatureMode: true,
                schedulerDecision: "defer",
                forceMaterializationPercentage: 85,
                signedThinkingHold: false,
                firstRender: false,
                folds: false,
                explicitFlush: true,
                materializationRequested: true,
                historyRebuilt: false,
                alreadyRanThisTurn: false,
                forceTriggerPermitted: permissions.force,
            },
            { percentage: 50, fromEstimate: false },
        );
        // What the postprocess phase hands the decision on the same pass:
        // `isExplicitFlush &&= triggerPermissions.materialization`, and the
        // materialization request recomputed from it.
        const decided = decidePassMutation(
            {
                fullFeatureMode: true,
                compactionOff: false,
                schedulerDecision: "defer",
                contextPercentage: 50,
                forceMaterializationPercentage: 85,
                contextUsageFromEstimate: false,
                emergencyInputSample: () => 0,
                forceTriggerPermitted: permissions.force,
                servedShapeRepair: false,
                rewritingSignedPrefix: false,
                foldBustsServedPrefix: false,
                firstRenderBust: false,
                explicitFlush: permissions.materialization,
                publishedHistory: false,
                historyRebuiltThisPass: false,
                materializationRequested: permissions.materialization,
                alreadyRanThisTurn: false,
                signedThinkingHold: false,
            },
            () => false,
        );
        expect(decided.publishedWorkDrainAllowed).toBe(false);
        expect(planned.editsWholePrefix).toBe(decided.publishedWorkDrainAllowed);
    });
});
