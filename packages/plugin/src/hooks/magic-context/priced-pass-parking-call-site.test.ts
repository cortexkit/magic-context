import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { requestPendingMaterialization } from "./pending-materialization";
import * as sizing from "./priced-pass-sizing";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

// The transform hands the priced-pass plan the trigger-parking permissions the
// postprocess phase will read when it decides the same pass. Under the strict
// signed-thinking hold, a force or materialization trigger parked on an earlier
// pass stays parked while the pass's head is frozen; on such a pass the plan
// must be told so.

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const message = (id: string, role = "user"): MessageLike => ({
    info: { id, role, sessionID: "parked" },
    parts: [{ type: "text", text: id }],
});

/** A session with a served head, a pending /ctx-flush and no provider reading. */
async function frozenPass(options: { keptThinking: boolean; parked: boolean }) {
    const temp = createTestTempDir("priced-pass-parking-");
    cleanups.push(temp.cleanup);
    const db = new Database(":memory:");
    cleanups.push(() => db.close());
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, "parked");
    const pending = new Set<string>();
    const transform = createTransform({
        db,
        directory: temp.dir,
        signedThinkingHold: "on",
        tagger: createTagger(),
        historianRunnable: false,
        scheduler: { shouldExecute: () => "defer" } as never,
        liveModelBySession: new Map([
            ["parked", { providerID: "anthropic", modelID: "claude-opus-5-5" }],
        ]),
        contextUsageMap: new Map(),
        pendingMaterializationSessions: pending,
        historyRefreshSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
    });
    const raw = [message("turn")];
    await transform({}, { messages: structuredClone(raw) });
    if (options.keptThinking) {
        // The current turn keeps signed thinking: the strict policy holds the head.
        const assistant = message("active", "assistant");
        assistant.parts.unshift({
            type: "reasoning",
            text: "Thought",
            metadata: { anthropic: { signature: "active" } },
        });
        raw.push(assistant);
    }
    if (options.parked)
        db.prepare("UPDATE session_meta SET held_release = ? WHERE session_id = 'parked'").run(
            JSON.stringify({
                version: 1,
                obligations: { materialization: "user_flush", force: "force" },
            }),
        );
    // A queued flush prices the pass, so it is sized from a count of its request.
    requestPendingMaterialization(pending, "parked", "user_flush");
    const plans = spyOn(sizing, "planPricedPass");
    try {
        await transform({}, { messages: structuredClone(raw) });
        return plans.mock.calls.map(([input]) => ({
            force: input.forceTriggerPermitted,
            materialization: input.materializationTriggerPermitted,
        }));
    } finally {
        plans.mockRestore();
    }
}

describe("the priced-pass plan's trigger-parking permissions at the transform", () => {
    it("withholds both on a frozen pass while the triggers stay parked", async () => {
        const plans = await frozenPass({ keptThinking: true, parked: true });
        expect(plans.length).toBeGreaterThan(0);
        for (const plan of plans) expect(plan).toEqual({ force: false, materialization: false });
    });

    it("permits both when nothing is parked or the head is not frozen", async () => {
        for (const options of [
            { keptThinking: true, parked: false },
            { keptThinking: false, parked: true },
        ]) {
            const plans = await frozenPass(options);
            expect(plans.length).toBeGreaterThan(0);
            for (const plan of plans) expect(plan).toEqual({ force: true, materialization: true });
        }
    });
});
