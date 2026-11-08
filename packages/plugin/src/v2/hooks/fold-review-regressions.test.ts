import { expect, test } from "bun:test";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import type { SessionContext } from "./types";

test("kept and hidden repeated instructions preserve coordinates and adjacent effort markers", async () => {
    const f = await oc2ContextFixture(9731, {
        area: "fold-review-regressions",
        host: "2.1.0",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
    });
    try {
        f.compartment(0);
        f.instruction("REPEATED_AUTHORED_INSTRUCTION");
        f.user("source anchor between instructions", 1000);
        f.instruction("REPEATED_AUTHORED_INSTRUCTION");
        f.user("continue after both instructions", 1000);
        const efforts = (draft: SessionContext) => {
            const systems = draft.messages.filter(
                (message) =>
                    message.role === "system" &&
                    message.content.some((part) => part.text === "REPEATED_AUTHORED_INSTRUCTION"),
            );
            for (const [index, message] of systems.entries()) {
                const at = draft.messages.indexOf(message);
                const kept = systems.length === 1 || index === 1;
                draft.messages.splice(at + 1, 0, {
                    role: "system",
                    content: [
                        {
                            type: "effort",
                            effort: kept ? "high" : "low",
                            previous: kept ? "low" : "high",
                        },
                    ],
                });
            }
        };
        const before = await f.pass(efforts);
        expect((await f.pass(efforts)).bytes).toBe(before.bytes);
        await f.nativeFold(3, 2, "");
        const after = await f.pass(efforts);
        expect(
            after.draft.messages.filter((message) =>
                message.content.some((part) => part.text === "REPEATED_AUTHORED_INSTRUCTION"),
            ),
        ).toHaveLength(2);
        expect(
            after.draft.messages.filter((message) =>
                message.content.some((part) => part.type === "effort"),
            ),
        ).toHaveLength(2);
        expect(after.bytes).toBe(before.bytes);
        await f.restart();
        expect((await f.pass(efforts)).bytes).toBe(before.bytes);
    } finally {
        await f.cleanup();
    }
}, 60000);

for (const keptCount of [2, 3]) {
    test(`leading effort occurrences retain hidden equals and ${keptCount} kept suffix controls`, async () => {
        const f = await oc2ContextFixture(9740 + keptCount, {
            area: "fold-review-regressions",
            instructions: false,
            temporal: false,
            cacheTtl: "never",
        });
        try {
            f.compartment(0);
            const hiddenID = f.rows[1]!.id;
            const keptID = f.rows.at(-1)!.id;
            let folded = false;
            const controls = [
                { type: "effort", effort: "low", previous: "high" },
                { type: "effort", effort: "high", previous: "low" },
                { type: "effort", effort: "low", previous: "high" },
            ];
            const efforts = (draft: SessionContext) => {
                for (const [id, parts] of [
                    [hiddenID, controls.slice(0, 1)],
                    [keptID, folded ? controls.slice(-keptCount) : controls],
                ] as const) {
                    const at = draft.messages.findIndex((message) => message.id === id);
                    if (at >= 0)
                        draft.messages.splice(
                            at,
                            0,
                            ...parts.map((part) => ({
                                role: "system" as const,
                                content: [{ ...part }],
                            })),
                        );
                }
            };
            const before = await f.pass(efforts);
            expect((await f.pass(efforts)).bytes).toBe(before.bytes);
            await f.nativeFold(3, 1, "");
            folded = true;
            const after = await f.pass(efforts);
            expect(
                after.draft.messages.filter((message) =>
                    message.content.some((part) => part.type === "effort"),
                ),
            ).toHaveLength(4);
            expect(after.bytes).toBe(before.bytes);
            await f.restart();
            expect((await f.pass(efforts)).bytes).toBe(before.bytes);
        } finally {
            await f.cleanup();
        }
    }, 60000);
}

test("a staged V2 upgrade waits through an expiry for an independent rebuild before committing once", async () => {
    const f = await oc2ContextFixture(9732, {
        area: "fold-review-regressions",
        instructions: false,
        temporal: false,
        cacheTtl: "30s",
    });
    try {
        f.respond();
        const before = await f.pass();
        await f.nativeFold(2, 0, "incomplete host transcript");
        await f.restart();
        const warm = await f.pass();
        expect(warm.bytes).toBe(before.bytes);
        expect(warm.logs.some((line) => line.includes("upgrade-state HARD"))).toBe(false);
        expect(
            await f.hostStorage.get(`native-fold/v3/${encodeURIComponent(f.session)}`),
        ).toBeUndefined();
        f.compartment(10);
        expect((await f.pass()).bytes).toBe(before.bytes);
        f.idle(1);
        const expired = await f.pass();
        const clock = f.db
            .prepare("SELECT cache_ttl,last_response_time FROM session_meta WHERE session_id=?")
            .get(f.session) as { cache_ttl: string; last_response_time: number };
        expect(clock.cache_ttl).toBe("30s");
        expect(Date.now()).toBeGreaterThan(clock.last_response_time + 30000);
        // An expired cache alone is not permission to replace the prefix: the
        // pass replays, and the staged upgrade keeps waiting.
        expect(expired.logs.some((line) => /cacheTtl=30s.*decision=defer/.test(line))).toBe(true);
        expect(expired.logs.some((line) => line.includes("upgrade-state HARD"))).toBe(false);
        expect(expired.bytes).toBe(before.bytes);
        expect(
            await f.hostStorage.get(`native-fold/v3/${encodeURIComponent(f.session)}`),
        ).toBeUndefined();
        f.setSystem("A changed system prefix rebuilds the request.");
        const rebuilt = await f.pass();
        expect(rebuilt.logs.filter((line) => line.includes("upgrade-state HARD"))).toHaveLength(1);
        expect(
            await f.hostStorage.get(`native-fold/v3/${encodeURIComponent(f.session)}`),
        ).toBeDefined();
        expect((await f.pass()).bytes).toBe(rebuilt.bytes);
        await f.restart();
        expect((await f.pass()).bytes).toBe(rebuilt.bytes);
        expect(f.sessionLogs().filter((line) => line.includes("upgrade-state HARD"))).toHaveLength(
            1,
        );
    } finally {
        await f.cleanup();
    }
}, 60000);
