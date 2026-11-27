import { expect, test } from "bun:test";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import type { AdmissionV3 } from "../fold/native-replay-v3";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

// A fix to native admission should turn this test red on purpose.
test("known gap: a matching admission with a deleted effort-control row refuses before managed restoration", async () => {
    const f = await oc2ContextFixture(62970, {
        area: "oc2-deleted-boundary-control-witness",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
    });
    try {
        const controlAnchor = f.rows[8]!;
        const latestSummaryEnd = f.rows[13]!;
        f.compartment(5);
        await f.pass((draft) => {
            const index = draft.messages.findIndex(({ id }) => id === controlAnchor.id);
            expect(index).toBeGreaterThan(0);
            draft.messages.splice(index + 1, 0, {
                role: "system",
                content: [{ type: "effort", effort: "low", previous: "high" }],
            });
        });
        f.compartment(13);
        await f.nativeFold(3, 2, "", "manual");
        const key = `native-fold/v3/${encodeURIComponent(f.session)}`;
        const receipt = (await f.hostStorage.get(key)) as { payload: string };
        const admission = JSON.parse(receipt.payload) as AdmissionV3;
        expect(admission.replay.floor.id).toBe(latestSummaryEnd.id);
        expect(admission.replay.controls).toContainEqual({
            after: controlAnchor.id,
            effort: "low",
            previous: "high",
        });
        f.user("the turn after the hidden control anchor was removed", 1000);
        f.raw.prepare("DELETE FROM session_message WHERE id = ?").run(controlAnchor.id);
        clearCachedM0M1(f.db, f.session);
        await f.restart();
        const pass = await f.attempt();
        expect(pass.error).toBeInstanceOf(Error);
        expect(pass.logs.join("\n")).toContain("[MC-S06]");
        expect(
            pass.logs.filter((line) =>
                line.includes("replay refused: missing usable checkpoint boundary"),
            ),
        ).toHaveLength(2);
    } finally {
        await f.cleanup();
    }
});
