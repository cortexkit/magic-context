import { expect, spyOn, test } from "bun:test";
import { patchSessionMeta } from "../../features/magic-context/__tests__/session-meta-fixture";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { hasFoldSummary, RAW_HISTORY_ACCOUNT } from "../fold/summary";
import {
    addCodeModeEntries,
    codeModeInstructionMetadata,
    renderCodeModeCatalog,
    replaceCodeModeCatalog,
} from "./__tests__/code-mode-catalog.fixture";
import { installBusyAdmission, oc2ContextFixture, prose } from "./__tests__/oc2-context.fixture";

const settle = async () => {
    for (let tick = 0; tick < 8; tick++)
        await new Promise<void>((resolve) => setImmediate(resolve));
};

test("manual host fold completes after the first summary covers tool calls", async () => {
    const f = await oc2ContextFixture(9870, {
        area: "host-fold-patch",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
    });
    try {
        const owner = f.rows[1]!;
        const call = {
            type: "tool-call" as const,
            id: "read-before-floor",
            name: "read",
            input: {},
        };
        f.raw
            .prepare(
                "UPDATE session_message SET data=json_set(data,'$.content',json(?)) WHERE id=?",
            )
            .run(JSON.stringify([call]), owner.id);
        f.compartment(4);
        const before = await f.pass((draft) => {
            const index = draft.messages.findIndex((message) => message.id === owner.id);
            draft.messages[index]!.content = [call];
            draft.messages.splice(index + 1, 0, {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: call.id,
                        name: call.name,
                        result: { type: "text", value: "covered tool output" },
                    },
                ],
            });
        });
        expect(before.logs.filter((line) => line.includes("capture unavailable"))).toEqual([]);
        expect(before.draft.messages.some((message) => message.id === owner.id)).toBe(false);
        const cut = await f.nativeFold(3, 0, "", "manual");
        const stored = f.raw.prepare("SELECT data FROM session_message WHERE id=?").get(cut) as {
            data: string;
        };
        expect(JSON.parse(stored.data).status).toBe("completed");
        expect(hasFoldSummary(JSON.parse(stored.data).summary)).toBe(true);
        const after = await f.pass();
        expect(after.bytes).toBe(before.bytes);
        expect((await f.pass()).bytes).toBe(after.bytes);
        await f.restart();
        expect((await f.pass()).bytes).toBe(after.bytes);
        expect(f.sessionLogs().some((line) => line.includes("compaction-fold cause="))).toBe(false);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("required host checkpoints answer without empty history and preserve raw replay", async () => {
    expect(hasFoldSummary(undefined)).toBe(false);
    expect(hasFoldSummary("<session-history> \n</session-history>")).toBe(false);
    const f = await oc2ContextFixture(9838, { area: "host-fold-patch", instructions: false });
    try {
        const before = await f.pass();
        patchSessionMeta(f.db, f.session, { cached_m0_bytes: null });
        await f.restart();
        const cut = await f.nativeFold();
        const completed = f.raw
            .prepare(
                "SELECT COUNT(*) AS n FROM session_message WHERE type = 'compaction' AND json_extract(data, '$.status') = 'completed'",
            )
            .get() as { n: number };
        expect(completed.n).toBe(1);
        const stored = f.raw.prepare("SELECT data FROM session_message WHERE id = ?").get(cut) as {
            data: string;
        };
        expect(JSON.parse(stored.data).summary).toBe(RAW_HISTORY_ACCOUNT);
        expect((await f.pass()).bytes).toBe(before.bytes);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("an expired idle fold is recovered after reload only on a rebuilding pass; warm and expired replays stay byte-identical", async () => {
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
        // Only the provider forgot the cache: the pass replays and queues nothing.
        expect((await f.pass()).bytes).toBe(before.bytes);
        await settle();
        expect(compact).toHaveBeenCalledTimes(0);
        f.setSystem("A changed system prefix rebuilds the request in the expired window.");
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
                patchSessionMeta(f.db, f.session, { is_subagent: 1, cached_m0_bytes: null });
            }
            await f.restart();
            f.idle(1);
            // Rebuild for a real reason, so only the blocked condition can refuse.
            f.setSystem("A changed system prefix rebuilds the request in the expired window.");
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
        // An expired cache alone does not rebuild, so the idle fold is recovered
        // on the pass that rebuilds for a real reason.
        f.setSystem("A changed system prefix rebuilds the request in the expired window.");
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

test("manual compact keeps an uncovered sole catalog and every unsummarized turn", async () => {
    const f = await oc2ContextFixture(9866, {
        area: "host-fold-patch",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
    });
    const admission = installBusyAdmission();
    try {
        f.compartment(4);
        f.instruction(renderCodeModeCatalog([`OLD_CATALOG ${"catalog entry ".repeat(3000)}`]));
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
        expect(after.bytes).toContain("OLD_CATALOG");
        for (const id of tailIds)
            expect(after.draft.messages.some((message) => message.id === id)).toBe(true);
        expect(after.draft.messages.some((message) => message.id === f.rows[6]!.id)).toBe(false);
        expect((await f.pass()).bytes).toBe(after.bytes);
        admission.state.busyNext = true;
        expect((await f.pass()).bytes).toBe(after.bytes);
        await f.restart();
        expect((await f.pass()).bytes).toBe(after.bytes);
        f.instruction(addCodeModeEntries(["NEW_EPOCH_CATALOG"]), codeModeInstructionMetadata);
        const next = await f.pass();
        expect(next.bytes).toContain("NEW_EPOCH_CATALOG");
        expect(next.bytes).toContain("OLD_CATALOG");
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
        // Establish the cached prefix before queuing notices, so this test
        // measures manual compaction rather than first-render reclaim.
        await f.pass();
        const initial = renderCodeModeCatalog(["INITIAL_CATALOG"]);
        f.instruction(initial);
        const notices: string[] = [];
        for (let i = 0; i < 51; i++) {
            const notice = replaceCodeModeCatalog([
                `CATALOG_${i}\n${"catalog item: available tool\n".repeat(335)}`,
            ]);
            notices.push(notice);
            f.instruction(notice, codeModeInstructionMetadata);
        }
        const tail = "UNSUMMARIZED_CONVERSATION\n" + prose.repeat(1800);
        f.user(tail, 1000);
        const before = await f.pass();
        expect(before.bytes).toContain("CATALOG_0");
        await f.nativeFold(3, 0, "", "manual");
        const after = await f.pass();
        expect(
            after.draft.messages
                .flatMap((message) => message.content)
                .some((part) => part.text?.includes(tail)),
        ).toBe(true);
        const afterText = after.draft.messages
            .flatMap((message) => message.content.map((part) => part.text ?? ""))
            .join("\n");
        expect(afterText).not.toContain(initial);
        for (const notice of notices.slice(0, -1)) expect(afterText).not.toContain(notice);
        expect(afterText).toContain(notices.at(-1)!);
        const reclaimedBytes = Buffer.byteLength(notices.slice(0, -1).join(""));
        expect(Buffer.byteLength(before.bytes) - Buffer.byteLength(after.bytes)).toBeGreaterThan(
            reclaimedBytes * 0.9,
        );
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
