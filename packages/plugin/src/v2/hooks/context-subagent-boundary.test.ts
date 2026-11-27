import { expect, test } from "bun:test";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

// A subagent session can still get a host checkpoint (a manual /compact) and
// stored summaries (the /ctx-recomp command rebuilds them on request). Its
// requests never carry the history head, so nothing would replace the
// messages a missing checkpoint floor hides: the turn must stay refused.
test("a checkpoint without a rendered history head still refuses when its floor is gone", async () => {
    const f = await oc2ContextFixture(62997, {
        area: "oc2-child-fresh-baseline-witness",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
    });
    try {
        f.raw
            .prepare("UPDATE session_v2 SET parent_id = 'ses-fixture-parent' WHERE id = ?")
            .run(f.session);
        await f.pass();
        const mode = f.db
            .prepare("SELECT is_subagent AS child FROM session_meta WHERE session_id = ?")
            .get(f.session);
        expect(mode).toEqual({ child: 1 });
        await f.nativeFold(3, 2, "", "manual");
        f.user("next child turn", 1000);
        const earliest = f.rows[0]!;
        f.compartment(5);
        clearCachedM0M1(f.db, f.session);
        f.raw.prepare("DELETE FROM session_message WHERE id = ?").run(earliest.id);
        await f.restart();
        const outcome = await f.attempt();
        expect(outcome.error).toBeInstanceOf(Error);
        expect(outcome.logs.join("\n")).toMatch(
            /\[MC-S06\].*Host checkpoint replay boundary is unavailable/,
        );
        expect(outcome.logs.join("\n")).not.toContain("transform completed");
    } finally {
        await f.cleanup();
    }
});
