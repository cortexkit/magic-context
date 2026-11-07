import { expect, test } from "bun:test";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import type { SessionContext } from "./types";

test("review: a kept leading effort marker is not duplicated when its source anchor is hidden", async () => {
    const f = await oc2ContextFixture(9831, {
        area: "fold-fix-round-review",
        host: "2.1.0",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
    });
    try {
        const keptID = f.rows.at(-1)!.id;
        const effortBeforeKept = (draft: SessionContext) => {
            const at = draft.messages.findIndex((message) => message.id === keptID);
            expect(at).toBeGreaterThanOrEqual(0);
            draft.messages.splice(at, 0, {
                role: "system",
                content: [{ type: "effort", effort: "low", previous: "high" }],
            });
        };
        const before = await f.pass(effortBeforeKept);
        expect((await f.pass(effortBeforeKept)).bytes).toBe(before.bytes);
        await f.nativeFold(3, 1, "");
        const after = await f.pass(effortBeforeKept);
        expect(
            after.draft.messages.filter((message) =>
                message.content.some((part) => part.type === "effort"),
            ),
        ).toHaveLength(1);
        expect(after.bytes).toBe(before.bytes);
        await f.restart();
        expect((await f.pass(effortBeforeKept)).bytes).toBe(before.bytes);
    } finally {
        await f.cleanup();
    }
}, 60000);
