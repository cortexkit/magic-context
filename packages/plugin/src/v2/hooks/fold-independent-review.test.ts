import { expect, test } from "bun:test";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

test("review: a kept id-less instruction appears exactly once after a native checkpoint", async () => {
    const f = await oc2ContextFixture(9631, {
        area: "independent-fold-review",
        host: "2.1.0",
        temporal: false,
        cacheTtl: "never",
    });
    try {
        f.instruction("REVIEW_KEPT_INSTRUCTION use the supplied workspace only");
        f.user("continue after the instruction", 1000);
        const before = await f.pass();
        expect((await f.pass()).bytes).toBe(before.bytes);
        await f.nativeFold(3, 2, "");
        const after = await f.pass();
        const instructions = after.draft.messages.filter((message) =>
            message.content.some(
                (part) =>
                    typeof part.text === "string" && part.text.includes("REVIEW_KEPT_INSTRUCTION"),
            ),
        );
        expect(instructions).toHaveLength(1);
        expect(after.bytes).toBe(before.bytes);
        await f.restart();
        expect((await f.pass()).bytes).toBe(before.bytes);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("review: a partial legacy transcript containing repeated text is not full coverage", async () => {
    const f = await oc2ContextFixture(9633, {
        area: "independent-fold-review",
        host: "2.1.0",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
    });
    try {
        for (const row of f.rows) row.text = "REVIEW_REPEATED_TEXT";
        f.edit(f.rows[0]!.id, "REVIEW_REPEATED_TEXT");
        const before = await f.pass();
        expect(f.coveredThrough).toBe(-1);
        await f.nativeFold(2, 0, "REVIEW_REPEATED_TEXT");
        await f.restart();
        const after = await f.pass();
        const surviving = new Set(after.draft.messages.map((message) => message.id));
        expect(f.rows.every((row) => surviving.has(row.id))).toBe(true);
        expect(after.bytes).toBe(before.bytes);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("review: upgrading a V2 receipt does not change a still-warm request", async () => {
    const f = await oc2ContextFixture(9632, {
        area: "independent-fold-review",
        host: "2.1.0",
        instructions: false,
        temporal: false,
        cacheTtl: "5m",
    });
    try {
        f.respond();
        const before = await f.pass();
        await f.nativeFold(2);
        await f.restart();
        const after = await f.pass();
        expect(after.bytes).toBe(before.bytes);
        expect(after.logs.some((line) => line.includes("upgrade-state HARD"))).toBe(false);
    } finally {
        await f.cleanup();
    }
}, 60000);
