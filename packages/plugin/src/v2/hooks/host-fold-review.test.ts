import { expect, spyOn, test } from "bun:test";
import {
    getCompartments,
    replaceAllCompartments,
} from "../../features/magic-context/compartment-storage";
import { NativeFoldReplay } from "../fold/native-replay";
import { V2StoreReader } from "../store-reader";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

const options = {
    area: "host-fold-review",
    instructions: false,
    temporal: false,
    cacheTtl: "never",
};

test("manual compact keeps an unsummarized instruction that still applies", async () => {
    const f = await oc2ContextFixture(10866, options);
    try {
        f.compartment(4);
        const instruction = "Never run deployment commands without explicit user approval.";
        f.instruction(instruction);
        f.user("Continue the code review; do not deploy.", 1000);
        const before = await f.pass();
        expect(before.bytes).toContain(instruction);
        await f.nativeFold(3, 0, "", "manual");
        const after = await f.pass();
        expect(after.bytes.includes(instruction)).toBe(true);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("a refused manual compact leaves the frozen baseline unchanged", async () => {
    const f = await oc2ContextFixture(10867, options);
    const realSet = f.hostStorage.set.bind(f.hostStorage);
    let refuse = false;
    const write = spyOn(f.hostStorage, "set").mockImplementation(async (key, value) => {
        if (refuse && key.startsWith("native-fold/v3/"))
            throw new Error("isolated host storage write failure");
        return realSet(key, value);
    });
    const baseline = () =>
        f.db
            .prepare(
                "SELECT cached_m0_last_baseline_end_message_id FROM session_meta WHERE session_id = ?",
            )
            .get(f.session);
    try {
        f.compartment(4);
        const served = await f.pass();
        const before = baseline();
        f.compartment(12);
        refuse = true;
        await expect(f.nativeFold(3, 0, "", "manual")).rejects.toThrow(
            "could not preserve the host checkpoint",
        );
        const afterRefusal = baseline();
        refuse = false;
        f.raw
            .prepare(
                "UPDATE session_message SET data = json_set(data, '$.status', 'failed') WHERE session_id = ? AND type = 'compaction' AND json_extract(data, '$.status') = 'running'",
            )
            .run(f.session);
        await f.restart();
        const after = await f.pass();
        console.log(
            "refused fold state",
            JSON.stringify({
                before,
                afterRefusal,
                requestUnchangedAfterReload: after.bytes === served.bytes,
            }),
        );
        expect(afterRefusal).toEqual(before);
    } finally {
        write.mockRestore();
        await f.cleanup();
    }
}, 60000);

test("a failed manual checkpoint does not retire instructions under the previous checkpoint", async () => {
    const f = await oc2ContextFixture(10868, options);
    const realSet = f.hostStorage.set.bind(f.hostStorage);
    let refuse = false;
    const write = spyOn(f.hostStorage, "set").mockImplementation(async (key, value) => {
        if (refuse && key.startsWith("native-fold/v3/"))
            throw new Error("isolated host storage write failure");
        return realSet(key, value);
    });
    try {
        f.compartment(4);
        await f.pass();
        await f.nativeFold(3, 0, "");
        await f.pass();
        const instruction = "REQUIRED_NOTICE_AFTER_SUCCESSFUL_CHECKPOINT";
        f.instruction(instruction);
        const before = await f.pass();
        expect(before.bytes.includes(instruction)).toBe(true);
        refuse = true;
        await expect(f.nativeFold(3, 0, "", "manual")).rejects.toThrow(
            "could not preserve the host checkpoint",
        );
        refuse = false;
        f.raw
            .prepare(
                "UPDATE session_message SET data = json_set(data, '$.status', 'failed') WHERE session_id = ? AND type = 'compaction' AND json_extract(data, '$.status') = 'running'",
            )
            .run(f.session);
        await f.restart();
        const after = await f.pass();
        expect(after.bytes.includes(instruction)).toBe(true);
    } finally {
        write.mockRestore();
        await f.cleanup();
    }
}, 60000);

test("manual compact twice retains the unsummarized tail", async () => {
    const f = await oc2ContextFixture(10868, options);
    try {
        f.compartment(4);
        await f.pass();
        await f.nativeFold(3, 0, "", "manual");
        await f.pass();
        await f.nativeFold(3, 0, "", "manual");
        const after = await f.pass();
        for (const row of f.rows.slice(5))
            expect(after.draft.messages.some((message) => message.id === row.id)).toBe(true);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("manual compact cannot keep a floor beyond a shortened summary", async () => {
    const f = await oc2ContextFixture(10871, options);
    try {
        f.compartment(4);
        f.compartment(12);
        const before = await f.pass();
        expect(before.bytes.includes("Review history 1")).toBe(true);
        await f.nativeFold(3, 0, "", "manual");
        await f.pass();
        const first = getCompartments(f.db, f.session)[0]!;
        replaceAllCompartments(f.db, f.session, [first]);
        await f.nativeFold(3, 0, "", "manual");
        const after = await f.pass();
        const uncovered = f.rows.slice(5, 13).map((row) => row.id);
        const missing = uncovered.filter(
            (id) => !after.draft.messages.some((message) => message.id === id),
        );
        const stillSummarized = after.bytes.includes("Review history 1");
        console.log("shortened fold coverage", JSON.stringify({ stillSummarized, missing }));
        expect(stillSummarized ? [] : missing).toEqual([]);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("idle recovery queues at most one compaction for one expired response window", async () => {
    const threshold = process.env.MC_OC2_HOST_FOLD_ROWS;
    process.env.MC_OC2_HOST_FOLD_ROWS = "1";
    const f = await oc2ContextFixture(10872, { ...options, cacheTtl: "5m" });
    const compact = spyOn(f.hostSession, "compact").mockResolvedValue(undefined);
    const settle = async () => {
        for (let tick = 0; tick < 8; tick++)
            await new Promise<void>((resolve) => setImmediate(resolve));
    };
    try {
        f.compartment(4);
        f.respond();
        await f.pass();
        await f.restart();
        f.idle(1);
        await f.pass();
        await settle();
        expect(compact).toHaveBeenCalledTimes(1);
        f.setSystem("The host changed its system prefix, but no response completed.");
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

test("manual compact without compartments refuses without losing raw conversation", async () => {
    const f = await oc2ContextFixture(10869, options);
    try {
        await f.pass();
        await expect(f.nativeFold(3, 0, "", "manual")).rejects.toThrow(
            "could not preserve the host checkpoint",
        );
        const after = await f.pass();
        for (const row of f.rows)
            expect(after.draft.messages.some((message) => message.id === row.id)).toBe(true);
    } finally {
        await f.cleanup();
    }
}, 60000);

for (const retired of [false, true]) {
    test(`measure retirement checks on a long instruction tail: retired=${retired}`, async () => {
        const f = await oc2ContextFixture(retired ? 10870 : 10873, options);
        try {
            f.compartment(4);
            await f.pass();
            await f.nativeFold(3, 0, "", retired ? "manual" : undefined);
            await f.pass();
            const count = 1000;
            const firstSeq = Math.max(...f.rows.map((row) => row.seq)) + 2;
            const insert = f.raw.prepare(
                "INSERT INTO session_message(id,session_id,type,seq,time_created,data) VALUES (?,?,?,?,?,?)",
            );
            f.raw.exec("BEGIN");
            for (let i = 0; i < count; i++) {
                const row = {
                    id: `long-system-${i}`,
                    type: "system" as const,
                    text: `Instruction ${i}: preserve the project constraints.`,
                    created: Date.now(),
                    seq: firstSeq + i,
                };
                f.rows.push(row);
                insert.run(
                    row.id,
                    f.session,
                    row.type,
                    row.seq,
                    row.created,
                    JSON.stringify({ text: row.text }),
                );
            }
            f.raw.exec("COMMIT");
            await f.pass();
            const retirement = spyOn(NativeFoldReplay.prototype, "retiredInstructionThrough");
            const latest = spyOn(V2StoreReader.prototype, "latestCompaction");
            const sequence = spyOn(V2StoreReader.prototype, "sequenceForId");
            try {
                const start = performance.now();
                const warm = await f.pass();
                console.log(
                    "host fold review per-pass cost",
                    JSON.stringify({
                        retired,
                        systemRows: count,
                        elapsedMs: performance.now() - start,
                        retiredInstructionThrough: retirement.mock.calls.length,
                        latestCompaction: latest.mock.calls.length,
                        sequenceForId: sequence.mock.calls.length,
                    }),
                );
                expect(warm.bytes).toContain("Instruction 999");
            } finally {
                retirement.mockRestore();
                latest.mockRestore();
                sequence.mockRestore();
            }
        } finally {
            await f.cleanup();
        }
    }, 60000);
}
