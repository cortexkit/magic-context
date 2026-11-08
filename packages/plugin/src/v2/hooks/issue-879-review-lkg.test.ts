import { expect, spyOn, test } from "bun:test";
import { getSlot } from "../../hooks/magic-context/lkg-slot";
import * as models from "../../shared/models-dev-cache";
import { retiredLiveInstructionIDs } from "../fold/instruction-supersession";
import { replaceCodeModeCatalog } from "./__tests__/code-mode-catalog.fixture";
import { installBusyAdmission, oc2ContextFixture } from "./__tests__/oc2-context.fixture";

test("a live instruction retirement preserves LKG capture for later busy requests", async () => {
    const f = await oc2ContextFixture(31879, {
        area: "issue-879-review",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
    });
    const busy = installBusyAdmission();
    const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
    try {
        f.compartment(4);
        await f.pass();
        expect(getSlot(f.session)).toBeDefined();
        const old = replaceCodeModeCatalog(["RETIRED_CATALOG"]);
        const latest = replaceCodeModeCatalog(["CURRENT_CATALOG"]);
        const metadata = { instructionSources: ["core/codemode"] };
        f.instruction(old, metadata);
        const oldID = f.rows.at(-1)!.id;
        f.instruction(latest, metadata);
        f.respond(1, 900000);
        const retired = await f.pass();
        expect(retiredLiveInstructionIDs(f.db, f.session).has(oldID)).toBe(true);
        expect(retired.bytes).not.toContain("RETIRED_CATALOG");
        expect(retired.bytes).toContain("CURRENT_CATALOG");
        expect(getSlot(f.session)).toBeDefined();

        // A busy database offers the saved request before normal transformations run.
        busy.state.busyNext = true;
        const replay = await f.pass();
        expect(replay.logs.some((line) => line.endsWith("lkg_replay_served"))).toBe(true);
        expect(replay.bytes).not.toContain("RETIRED_CATALOG");
        expect(replay.bytes).toContain("CURRENT_CATALOG");
    } finally {
        limit.mockRestore();
        busy.restore();
        await f.cleanup();
    }
}, 60000);
