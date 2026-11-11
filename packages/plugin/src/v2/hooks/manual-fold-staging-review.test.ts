import { expect, spyOn, test } from "bun:test";
import * as appliedProjection from "../../features/magic-context/memory/applied-projection";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

// Review witness for the OpenCode 2 manual-compact staging. A manual /compact
// renders a new history head (m[0] and m[1], the two synthetic messages at the
// start of every request) in the compaction hook and publishes it only when the
// host admitted the compaction. Whatever way the compaction ends without
// admission, the next request must be the request served before it, byte for
// byte.

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

// The stage renders inside a write transaction it always rolls back. Make it
// throw inside the render (a write of the new head fails) or right after it
// (reading the rendered head fails): the hook refuses the compaction, nothing
// the render wrote survives, and the next request serves the head the provider
// cached.
const failures: Array<[string, () => () => void]> = [
    [
        "inside the render",
        () => {
            const spy = spyOn(appliedProjection, "writeHardProjection").mockImplementation(() => {
                throw new Error("database is locked");
            });
            return () => spy.mockRestore();
        },
    ],
    [
        "right after the render",
        () => {
            const real = appliedProjection.readStoredAppliedProjection;
            let reads = 0;
            const spy = spyOn(appliedProjection, "readStoredAppliedProjection").mockImplementation(
                (...args) => {
                    // The stage reads the head before the render and again after it.
                    if (++reads === 2) throw new Error("database is locked");
                    return real(...args);
                },
            );
            return () => spy.mockRestore();
        },
    ],
];

for (const [where, inject] of failures) {
    test(`review witness: a manual compact whose staging throws ${where} is refused and leaves the next request unchanged`, async () => {
        const f = await oc2ContextFixture(65886 + (where === "inside the render" ? 0 : 1), options);
        let restore: (() => void) | undefined;
        try {
            f.compartment(4);
            const served = await f.pass();
            // A newer summary only a rebuilt head would render.
            f.compartment(10);
            restore = inject();
            await expect(f.nativeFold(3, 0, "", "manual")).rejects.toThrow(
                "could not preserve the host checkpoint",
            );
            restore();
            restore = undefined;
            failRunningCompaction(f);
            const after = await f.pass();
            expect(head(after)).not.toContain("Review history 1");
            expect(head(after)).toBe(head(served));
            expect(after.bytes).toBe(served.bytes);
        } finally {
            restore?.();
            await f.cleanup();
        }
    }, 60000);
}
