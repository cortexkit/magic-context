import { expect, test } from "bun:test";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

// Regression for #944: a completed host summary compaction is treated as a
// local checkpoint, and compaction-off mode used to restore every row before
// it. The next request then carried the whole pre-checkpoint transcript, so
// native compaction fired again on every step.
test("compaction-off serves the host checkpoint without restoring rows before it", async () => {
    const f = await oc2ContextFixture(9901, {
        area: "compaction-off-host-fold",
        temporal: false,
        configOverrides: { compaction: { enabled: false } },
    });
    try {
        const before = await f.pass();
        await f.fold(3, "Host summary of the earlier conversation.");
        const after = await f.pass();

        const keptStart = f.rows.length - 3;
        const beforeCheckpoint = new Set(f.rows.slice(0, keptStart).map((row) => row.id));
        const restored = after.draft.messages.filter(
            (message) => typeof message.id === "string" && beforeCheckpoint.has(message.id),
        );

        expect(restored).toHaveLength(0);
        expect(after.draft.messages.length).toBeLessThan(before.draft.messages.length);
    } finally {
        await f.cleanup();
    }
}, 60000);
