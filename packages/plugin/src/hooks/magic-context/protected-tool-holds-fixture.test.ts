import { expect } from "bun:test";
import fixture from "../../../test-fixtures/runtime/protected-tool-holds.json";
import { protectedToolTagNumbers } from "../../features/magic-context/reclaim-protection";
import {
    getActiveTagsBySession,
    getPendingOps,
    getTagsBySession,
    insertTag,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { markTagsCompactedByMessageIds } from "../../features/magic-context/storage-tags";
import { Database } from "../../shared/sqlite";
import { createCtxReduceTools } from "../../tools/ctx-reduce/tools";
import { applyPendingOperations } from "./apply-operations";
import { queueDropsForCompartmentalizedMessages } from "./compartment-runner-drop-queue";
import type { TagTarget } from "./tag-messages";

export interface HoldCase {
    label: string;
    tools: string[];
    protected_tools: Record<string, number>;
    drop: number;
    new_tool: string;
    historian?: boolean;
    agent_self_stamp?: boolean;
    protected_after_trim?: number[];
}
export const holdCases = fixture as HoldCase[];
export async function checkProtectedToolHold(
    spec: HoldCase,
    invoke?: (db: Database, sessionId: string, spec: HoldCase) => Promise<string>,
) {
    const db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "held-tool";
    const targets = new Map<number, TagTarget>();
    const add = (tag: number, name: string, tokens = 1) => {
        insertTag(db, sessionId, `call-${tag}`, "tool", tokens * 4, tag, 0, name, 0, null, null, {
            tokenCount: tokens,
            inputTokenCount: 0,
            reasoningTokenCount: 0,
        });
        targets.set(tag, { setContent: () => true, canDrop: () => true, drop: () => "removed" });
    };
    for (const [i, name] of spec.tools.entries()) add(i + 1, name);
    // Large later results keep the token-window hold independent from the
    // per-tool keep count being tested here.
    for (const n of [100, 101, 102]) add(n, "bash", 8000);
    try {
        if (spec.historian) {
            queueDropsForCompartmentalizedMessages(db, sessionId, spec.drop, {
                messageFileKeys: new Set(),
                toolObservations: new Map([[`call-${spec.drop}`, new Set([`owner-${spec.drop}`])]]),
            });
        } else {
            const text = invoke
                ? await invoke(db, sessionId, spec)
                : await createCtxReduceTools({
                      db,
                      protectedTools: spec.protected_tools,
                      protectedSet: new Set(),
                  }).ctx_reduce.execute({ drop: String(spec.drop) }, {
                      sessionID: sessionId,
                  } as never);
            if (spec.agent_self_stamp) {
                expect(text).toBe(
                    "1 was a ctx_reduce call; leave those alone, they are cleaned up automatically.",
                );
                expect(getPendingOps(db, sessionId)).toHaveLength(0);
                expect(
                    getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === spec.drop)
                        ?.status,
                ).toBe("active");
                return;
            }
            expect(text).toBe("1 tag stamped.");
        }
        expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([spec.drop]);
        const status = () =>
            getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === spec.drop)!.status;
        const apply = () =>
            applyPendingOperations(
                sessionId,
                db,
                targets,
                protectedToolTagNumbers(
                    getActiveTagsBySession(db, sessionId),
                    spec.protected_tools,
                ),
            );
        expect(apply()).toBe(false);
        expect(status()).toBe("active");
        expect(apply()).toBe(false);
        expect(getPendingOps(db, sessionId)).toHaveLength(1);
        if (spec.historian) {
            // Summarizing the source removes its raw result even while its queued drop is held.
            markTagsCompactedByMessageIds(db, sessionId, [`call-${spec.drop}`]);
            expect(status()).toBe("compacted");
            expect(
                [
                    ...protectedToolTagNumbers(
                        getActiveTagsBySession(db, sessionId),
                        spec.protected_tools,
                    ),
                ].sort((a, b) => a - b),
            ).toEqual(spec.protected_after_trim ?? [1]);
            expect(apply()).toBe(false);
            expect(getPendingOps(db, sessionId)).toHaveLength(0);
            return;
        }
        add(200, spec.new_tool);
        // A newer call displaces the result; a later rebuilding pass applies the drop.
        expect(status()).toBe("active");
        expect(apply()).toBe(true);
        expect(status()).toBe("dropped");
        expect(getPendingOps(db, sessionId)).toHaveLength(0);
        expect(apply()).toBe(false);
        expect(status()).toBe("dropped");
    } finally {
        db.close();
    }
}
