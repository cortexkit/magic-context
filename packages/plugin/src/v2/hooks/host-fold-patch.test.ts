import { expect, spyOn, test } from "bun:test";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { hasFoldSummary } from "../fold/summary";
import { installBusyAdmission, oc2ContextFixture, prose } from "./__tests__/oc2-context.fixture";

const settle = async () => {
    for (let tick = 0; tick < 8; tick++)
        await new Promise<void>((resolve) => setImmediate(resolve));
};

test("host folds reject a missing or markup-only history summary", async () => {
    expect(hasFoldSummary(undefined)).toBe(false);
    expect(hasFoldSummary("<session-history> \n</session-history>")).toBe(false);
    const f = await oc2ContextFixture(9838, { area: "host-fold-patch", instructions: false });
    try {
        await f.pass();
        f.db
            .prepare("UPDATE session_meta SET cached_m0_bytes = NULL WHERE session_id = ?")
            .run(f.session);
        await f.restart();
        await expect(f.nativeFold()).rejects.toThrow("could not preserve the host checkpoint");
        const completed = f.raw
            .prepare(
                "SELECT COUNT(*) AS n FROM session_message WHERE type = 'compaction' AND json_extract(data, '$.status') = 'completed'",
            )
            .get() as { n: number };
        expect(completed.n).toBe(0);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("an expired idle fold is recovered after reload, but a warm defer stays byte-identical", async () => {
    const threshold = process.env.MC_OC2_HOST_FOLD_ROWS;
    process.env.MC_OC2_HOST_FOLD_ROWS = "1";
    const f = await oc2ContextFixture(9848, {
        area: "host-fold-patch",
        instructions: false,
        temporal: false,
        cacheTtl: "5m",
    });
    const compact = spyOn(f.hostSession, "compact").mockResolvedValue(undefined);
    try {
        f.compartment(4);
        f.respond();
        const before = await f.pass();
        await f.restart();
        expect((await f.pass()).bytes).toBe(before.bytes);
        await settle();
        expect(compact).toHaveBeenCalledTimes(0);
        f.idle(1);
        await f.pass();
        await settle();
        expect(compact).toHaveBeenCalledTimes(1);
    } finally {
        compact.mockRestore();
        await f.cleanup();
        if (threshold === undefined) delete process.env.MC_OC2_HOST_FOLD_ROWS;
        else process.env.MC_OC2_HOST_FOLD_ROWS = threshold;
    }
}, 60000);

for (const blocked of ["subagent", "below-threshold", "never"] as const) {
    test(`recovered idle folding still refuses ${blocked} sessions`, async () => {
        const threshold = process.env.MC_OC2_HOST_FOLD_ROWS;
        process.env.MC_OC2_HOST_FOLD_ROWS = blocked === "below-threshold" ? "1000" : "1";
        const f = await oc2ContextFixture(9850, {
            area: "host-fold-patch",
            instructions: false,
            temporal: false,
            cacheTtl: blocked === "never" ? "never" : "5m",
        });
        const compact = spyOn(f.hostSession, "compact").mockResolvedValue(undefined);
        try {
            f.compartment(4);
            f.respond();
            await f.pass();
            if (blocked === "subagent") {
                f.raw
                    .prepare("UPDATE session_v2 SET parent_id = 'parent' WHERE id = ?")
                    .run(f.session);
                f.db
                    .prepare(
                        "UPDATE session_meta SET is_subagent = 1, cached_m0_bytes = NULL WHERE session_id = ?",
                    )
                    .run(f.session);
            }
            await f.restart();
            f.idle(1);
            await f.pass();
            await settle();
            expect(compact).toHaveBeenCalledTimes(0);
        } finally {
            compact.mockRestore();
            await f.cleanup();
            if (threshold === undefined) delete process.env.MC_OC2_HOST_FOLD_ROWS;
            else process.env.MC_OC2_HOST_FOLD_ROWS = threshold;
        }
    }, 60000);
}

test("a claimed idle fold with host reason manual is not a user compaction", async () => {
    const threshold = process.env.MC_OC2_HOST_FOLD_ROWS;
    process.env.MC_OC2_HOST_FOLD_ROWS = "1";
    const f = await oc2ContextFixture(9851, {
        area: "host-fold-patch",
        instructions: false,
        temporal: false,
    });
    const compact = spyOn(f.hostSession, "compact").mockImplementation(async (input) => {
        await f.nativeFold(3, 0, "", "manual", input.id);
        return { id: input.id };
    });
    try {
        f.compartment(4);
        f.instruction("KEEP_IDLE_NOTICE");
        f.respond();
        await f.pass();
        f.idle(1);
        const cold = await f.pass();
        await settle();
        expect(compact).toHaveBeenCalledTimes(1);
        expect((await f.pass()).bytes).toBe(cold.bytes);
        expect(cold.bytes).toContain("KEEP_IDLE_NOTICE");
    } finally {
        compact.mockRestore();
        await f.cleanup();
        if (threshold === undefined) delete process.env.MC_OC2_HOST_FOLD_ROWS;
        else process.env.MC_OC2_HOST_FOLD_ROWS = threshold;
    }
}, 60000);

test("manual compact retires old notices and frozen replay but preserves every unsummarized turn", async () => {
    const f = await oc2ContextFixture(9866, {
        area: "host-fold-patch",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
    });
    const admission = installBusyAdmission();
    try {
        f.compartment(4);
        f.instruction(
            "This catalog supersedes the previous catalog: OLD_CATALOG " +
                "catalog entry ".repeat(3000),
        );
        f.respond();
        const before = await f.pass();
        f.compartment(12);
        expect((await f.pass()).bytes).toBe(before.bytes);
        const tailIds = f.rows
            .slice(13)
            .filter((row) => row.type !== "system")
            .map((row) => row.id);
        await f.nativeFold(3, 3, "", "manual");
        const after = await f.pass();
        expect(after.bytes).not.toContain("OLD_CATALOG");
        expect(after.bytes.length).toBeLessThan(before.bytes.length);
        for (const id of tailIds)
            expect(after.draft.messages.some((message) => message.id === id)).toBe(true);
        expect(after.draft.messages.some((message) => message.id === f.rows[6]!.id)).toBe(false);
        expect((await f.pass()).bytes).toBe(after.bytes);
        admission.state.busyNext = true;
        expect((await f.pass()).bytes).toBe(after.bytes);
        await f.restart();
        expect((await f.pass()).bytes).toBe(after.bytes);
        f.instruction("NEW_EPOCH_CATALOG");
        const next = await f.pass();
        expect(next.bytes).toContain("NEW_EPOCH_CATALOG");
        expect(next.bytes).not.toContain("OLD_CATALOG");
    } finally {
        admission.restore();
        await f.cleanup();
    }
}, 60000);

test("manual compact payload accounting separates notices from the unsummarized tail", async () => {
    const f = await oc2ContextFixture(9867, {
        area: "host-fold-patch",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
    });
    try {
        f.compartment(12);
        const notices: string[] = [];
        for (let i = 0; i < 51; i++) {
            const notice =
                `This catalog supersedes the previous catalog: ${i}\n` +
                "catalog item: available tool\n".repeat(335);
            notices.push(notice);
            f.instruction(notice);
        }
        const tail = "UNSUMMARIZED_CONVERSATION\n" + prose.repeat(1800);
        f.user(tail, 1000);
        const before = await f.pass();
        await f.nativeFold(3, 0, "", "manual");
        const after = await f.pass();
        expect(
            after.draft.messages
                .flatMap((message) => message.content)
                .some((part) => part.text?.includes(tail)),
        ).toBe(true);
        expect(after.bytes).not.toContain("This catalog supersedes");
        expect(estimateTokens(after.bytes)).toBeLessThan(estimateTokens(before.bytes));
        console.log(
            "manual compact accounting " +
                JSON.stringify({
                    beforeTokens: estimateTokens(before.bytes),
                    afterTokens: estimateTokens(after.bytes),
                    noticeBytes: Buffer.byteLength(notices.join("")),
                    noticeTokens: estimateTokens(notices.join("")),
                    unsummarizedTailTokens: estimateTokens(tail),
                }),
        );
    } finally {
        await f.cleanup();
    }
}, 60000);
