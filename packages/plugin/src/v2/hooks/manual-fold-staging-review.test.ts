import { expect, spyOn, test } from "bun:test";
import * as appliedProjection from "../../features/magic-context/memory/applied-projection";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

// Review witness for the OpenCode 2 manual-compact staging. A manual /compact
// renders a new history head (m[0] and m[1], the two synthetic messages at the
// start of every request) in the compaction hook, puts the old head back, and
// publishes the new one only when the host admitted the compaction. Whatever
// way the compaction ends without admission, the next request must be the
// request served before it, byte for byte.

const options = {
    area: "oc2-manual-fold-staging-review",
    instructions: false,
    temporal: false,
    cacheTtl: "never",
};

type Fixture = Awaited<ReturnType<typeof oc2ContextFixture>>;
type Pass = Awaited<ReturnType<Fixture["pass"]>>;

const head = (pass: Pass) => JSON.stringify(pass.draft.messages.slice(0, 2));

/** The host gives up on a compaction it was running (a refusal, a cancel, a restart). */
function failRunningCompaction(f: Fixture) {
    f.raw
        .prepare(
            "UPDATE session_message SET data = json_set(data, '$.status', 'failed') WHERE session_id = ? AND type = 'compaction' AND json_extract(data, '$.status') = 'running'",
        )
        .run(f.session);
}

// When the transaction that puts the old head back fails (a busy database), the
// hook refuses the compaction and the store keeps the new head it rendered. The
// host was told the compaction failed, so nothing admitted that head, and the
// hook recorded no proof that the head changed; the next request must still
// serve the head the provider cached. The restore is made to fail by throwing
// from its last step, inside its transaction, as a busy or full database would.
test("review witness: a manual compact refused because the old head could not be put back leaves the next request unchanged", async () => {
    const f = await oc2ContextFixture(65886, options);
    let failRestore = false;
    const real = appliedProjection.replaceStoredAppliedProjection;
    const replace = spyOn(appliedProjection, "replaceStoredAppliedProjection");
    replace.mockImplementation((...args) => {
        if (failRestore) throw new Error("database is locked");
        return real(...args);
    });
    try {
        f.compartment(4);
        const served = await f.pass();
        // A newer summary only a rebuilt head would render.
        f.compartment(10);
        failRestore = true;
        await expect(f.nativeFold(3, 0, "", "manual")).rejects.toThrow(
            "could not preserve the host checkpoint",
        );
        failRestore = false;
        failRunningCompaction(f);
        const after = await f.pass();
        expect(head(after)).not.toContain("Review history 1");
        expect(head(after)).toBe(head(served));
    } finally {
        replace.mockRestore();
        await f.cleanup();
    }
}, 60000);
