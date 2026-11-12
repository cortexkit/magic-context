/// <reference types="bun-types" />
// The served check through OpenCode 2's real context hook: an ordinary turn
// logs nothing, a last-good replay that serves exactly the request before it
// plus the host's new messages logs nothing, a replay that serves a drop the
// request before it did not carry is a mixed replay, and the compaction-off
// pass whose first-render strip cannot be saved (an open signed-thinking case)
// changes the served request without rebuild permission in front of kept
// thinking.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getTagsBySession } from "../../features/magic-context/storage";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import { markTagDropped } from "../../features/magic-context/storage-tags";
import { getServedCheckCountersForTest } from "../../hooks/magic-context/served-check";
import { installTransientFailure, oc2ContextFixture } from "./__tests__/oc2-context.fixture";

const EVENT = /^served check: (a pass without|a replay differed|a change in front|content changed)/;
const events = (logs: string[]) =>
    logs
        .map((line) => line.replace(/^.*?(served check: )/, "$1"))
        .filter((line) => EVENT.test(line));

test("OpenCode 2: ordinary turns and a plain replay log nothing; a replay with a drop the last request lacked is mixed", async () => {
    const fixture = await oc2ContextFixture(901, { area: "served-check", temporal: false });
    const failure = installTransientFailure();
    try {
        expect(events((await fixture.pass()).logs)).toEqual([]);
        for (let turn = 0; turn < 3; turn++) {
            fixture.respond();
            fixture.user(`Continue ${turn}.`, 1000);
            expect(events((await fixture.pass()).logs)).toEqual([]);
        }
        expect(getServedCheckCountersForTest(fixture.session)).toMatchObject({
            unknown: 1,
            appendOnly: 3,
        });

        fixture.respond();
        fixture.user("One more.", 1000);
        failure.state.failNext = true;
        const plain = await fixture.pass();
        expect(plain.logs.some((line) => line.includes("lkg_replay_served"))).toBe(true);
        expect(events(plain.logs)).toEqual([]);

        // Another process's pass committed a drop this process never served.
        const tag = getTagsBySession(fixture.db, fixture.session).find(
            (candidate) => candidate.status === "active" && candidate.type === "message",
        );
        if (!tag) throw new Error("no tagged message to drop");
        markTagDropped(fixture.db, fixture.session, tag.tagNumber);
        fixture.respond();
        fixture.user("And another.", 1000);
        failure.state.failNext = true;
        const mixed = await fixture.pass();
        expect(mixed.logs.some((line) => line.includes("lkg_replay_served"))).toBe(true);
        const mixedEvents = events(mixed.logs);
        expect(mixedEvents).toHaveLength(1);
        expect(mixedEvents[0]).toStartWith(
            "served check: a replay differed from the request served before it ",
        );
        expect(mixedEvents[0]).toContain("host=opencode2");

    } finally {
        failure.restore();
        await fixture.cleanup();
    }
}, 60_000);

test("OpenCode 2: the compaction-off pass whose first-render strip cannot be saved is an unpermitted change in front of kept signed thinking", async () => {
    const fixture = await oc2ContextFixture(902, {
        area: "served-check",
        temporal: false,
        provider: "anthropic",
        model: "claude-opus-5-5",
        configOverrides: { compaction: { enabled: false } },
    });
    // The project's docs render into the history head; the fixture's stores
    // and project directory share one root.
    const docs = join(dirname(process.env.HOME as string), "ARCHITECTURE.md");
    writeFileSync(docs, "# Architecture\n\nv1\n");
    try {
        await fixture.pass();
        for (let step = 1; step <= 3; step++) {
            fixture.respondWithTool(
                { name: "read", input: { path: `${step}.ts` }, output: `file ${step}` },
                undefined,
                `step ${step}: read the next file`,
            );
            expect(events((await fixture.pass()).logs)).toEqual([]);
        }
        writeFileSync(docs, "# Architecture\n\nv2\n");
        clearCachedM0M1(fixture.db, fixture.session);
        fixture.respondWithTool(
            { name: "read", input: { path: "4.ts" }, output: "file 4" },
            undefined,
            "step 4: read the last file",
        );
        fixture.db.exec(
            "CREATE TEMP TRIGGER fail_thinking_strip BEFORE UPDATE OF merged_reasoning_stripped_ids ON session_meta BEGIN SELECT RAISE(ABORT, 'thinking strip write failed'); END",
        );
        let failing: string[];
        try {
            const out = await fixture.pass();
            failing = events(out.logs);
        } finally {
            fixture.db.exec("DROP TRIGGER IF EXISTS temp.fail_thinking_strip");
        }
        expect(
            failing.some(
                (line) =>
                    line.startsWith(
                        "served check: a pass without rebuild permission changed served messages first_index=0 ",
                    ) && line.includes("host=opencode2"),
            ),
        ).toBe(true);
        expect(
            failing.some(
                (line) =>
                    line.startsWith(
                        "served check: a change in front of kept signed thinking on a prefix-bound model first_index=0 ",
                    ) && line.includes("thinking_stripped=false"),
            ),
        ).toBe(true);
    } finally {
        await fixture.cleanup();
    }
}, 60_000);
