import { expect } from "bun:test";
import fixture from "../../../test-fixtures/runtime/protected-tools.json";
import { getTagsBySession, insertTag } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import { buildEditSupersessionReclaim, buildSupersessionReclaimOps } from "./supersession-reclaim";
import type { TagTarget } from "./tag-messages";
import { buildSyntheticToolReclaimOps } from "./tool-reclaim";

export const cases: {
    label: string;
    lane: string;
    protected_tools: Record<string, number>;
    tools: string[];
    expected: number[];
}[] = fixture as {
    label: string;
    lane: string;
    protected_tools: Record<string, number>;
    tools: string[];
    expected: number[];
}[];
export function checkProtectedToolsCase(
    spec: (typeof cases)[number],
    piCleanup?: typeof applyHeuristicCleanup,
) {
    const db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "protected-tools";
    const targets = new Map<number, TagTarget>();
    const parts = spec.tools.map((tool, i) => ({
        type: "tool",
        tool,
        callID: `call-${i}`,
        state: { status: "completed", input: { filePath: "same" }, output: "x".repeat(4000) },
    }));
    const message = { info: { id: "owner", role: "assistant" }, parts };
    for (const [i, tool] of spec.tools.entries()) {
        const n = i + 1;
        insertTag(db, sessionId, `call-${i}`, "tool", 4000, n, 0, tool, 0, "owner");
        targets.set(n, {
            message,
            measureReclaim: () => ({
                beforeTools: 1000,
                afterTools: 0,
                beforeProse: 0,
                afterProse: 0,
            }),
            canDrop: () => true,
            setContent: () => true,
            drop: () => "removed",
            readInput: () => ({ filePath: "same" }),
        });
    }
    try {
        const input = { db, sessionId, targets, protectedTools: spec.protected_tools };
        let selected: number[];
        if (spec.lane === "age")
            selected = buildSyntheticToolReclaimOps({ ...input, watermark: 4 }).map(
                (op) => op.tagId,
            );
        else if (spec.lane === "supersession")
            selected = buildSupersessionReclaimOps(input).map((op) => op.tagId);
        else if (spec.lane === "edit")
            selected = buildEditSupersessionReclaim({
                ...input,
                watermark: Number.MAX_SAFE_INTEGER,
            }).ops.map((op) => op.tagId);
        else {
            (piCleanup ?? applyHeuristicCleanup)(sessionId, db, targets, new Map([[message, 4]]), {
                protectedTools: spec.protected_tools,
                protectedTagNumbers: new Set(),
                protectedCutoff: null,
                ...(spec.lane === "emergency"
                    ? {
                          routine: false,
                          emergency: {
                              currentTotalInputTokens: 4000,
                              ceilingTokens: 1,
                              usagePercentage: 95,
                              passAlreadyPriced: true,
                          },
                      }
                    : {}),
            });
            selected = getTagsBySession(db, sessionId)
                .filter((tag) => tag.status === "dropped")
                .map((tag) => tag.tagNumber);
        }
        expect(
            selected.sort((a, b) => a - b),
            spec.label,
        ).toEqual(spec.expected);
    } finally {
        db.close();
    }
}
