import { expect, test } from "bun:test";
import { type Oc2ContextFixture, oc2ContextFixture, prose } from "./__tests__/oc2-context.fixture";

async function observeRequest(fixture: Oc2ContextFixture) {
    const { draft, logs } = await fixture.pass();
    expect(logs.some((line) => line.includes("transform completed"))).toBe(true);
    return new WeakRef(draft.messages);
}

async function requestArraysReleased() {
    const fixture = await oc2ContextFixture(800, { area: "issue-800", temporal: false });
    try {
        for (const row of fixture.rows) row.text += prose.repeat(512);
        fixture.respond();
        const first = await observeRequest(fixture);
        fixture.respond();
        fixture.user("Continue the review.", 1000);
        const second = await observeRequest(fixture);

        // A WeakRef target is kept alive until the current JavaScript job finishes.
        // Collect on later event-loop ticks without reading either array between rounds.
        for (let round = 0; round < 6; round++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            Bun.gc(true);
        }
        return { first: first.deref() === undefined, second: second.deref() === undefined };
    } finally {
        await fixture.cleanup();
    }
}

test("releases large context message arrays between requests while the hook stays registered", async () => {
    // A failing heap snapshot showed only an internal runtime root to a completed
    // pass result, with no JavaScript holder. Use independent fresh fixtures rather
    // than retrying collection of the same arrays when the collector keeps one alive.
    // A hook retaining the latest request fails every attempt: its second array is
    // checked before cleanup or any later hook pass could replace that request.
    let released = { first: false, second: false };
    for (let attempt = 0; attempt < 3; attempt++) {
        released = await requestArraysReleased();
        if (released.first && released.second) break;
    }
    expect(released.first).toBe(true);
    expect(released.second).toBe(true);
}, 30000);
