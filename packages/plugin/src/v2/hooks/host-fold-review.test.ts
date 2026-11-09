import { expect, spyOn, test } from "bun:test";
import {
    getCompartments,
    replaceAllCompartments,
} from "../../features/magic-context/compartment-storage";
import { NativeFoldReplay } from "../fold/native-replay";
import { RAW_HISTORY_ACCOUNT } from "../fold/summary";
import { V2StoreReader } from "../store-reader";
import {
    addCodeModeEntries,
    codeModeInstructionMetadata,
    renderCodeModeCatalog,
    replaceCodeModeCatalog,
} from "./__tests__/code-mode-catalog.fixture";
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
        const instruction = renderCodeModeCatalog(["KEEP_THIS_APPLICABLE_CATALOG"]);
        f.instruction(instruction);
        const applicable = "Never run deployment commands without explicit user approval.";
        f.instruction(applicable);
        f.user("Continue the code review; do not deploy.", 1000);
        const before = await f.pass();
        expect(
            before.draft.messages
                .flatMap((message) => message.content.map((part) => part.text ?? ""))
                .join("\n"),
        ).toContain(instruction);
        expect(
            before.draft.messages.flatMap((message) => message.content.map((part) => part.text)),
        ).toContain(applicable);
        await f.nativeFold(3, 0, "", "manual");
        const after = await f.pass();
        expect(
            after.draft.messages
                .flatMap((message) => message.content.map((part) => part.text ?? ""))
                .join("\n")
                .includes(instruction),
        ).toBe(true);
        expect(after.bytes.includes(applicable)).toBe(true);
        expect(
            after.draft.messages.flatMap((message) => message.content.map((part) => part.text)),
        ).toContain(applicable);
    } finally {
        await f.cleanup();
    }
}, 60000);

for (const version of ["2.0.22", "2.1.4", "2.2.3"] as const) {
    test(`manual compact retires catalogs before a full replacement but keeps later increments (${version})`, async () => {
        const f = await oc2ContextFixture(
            11866 + ["2.0.22", "2.1.4", "2.2.3"].indexOf(version),
            options,
        );
        try {
            f.compartment(4);
            const initial = renderCodeModeCatalog(["INITIAL_CATALOG"], version);
            const before = addCodeModeEntries(["BEFORE_REPLACEMENT"]);
            const oldFull = replaceCodeModeCatalog(["OLD_FULL_CATALOG"], version);
            const beforeLatest = addCodeModeEntries(["BEFORE_LATEST_REPLACEMENT"]);
            const latest = `${replaceCodeModeCatalog(["LATEST_FULL_CATALOG"], version)}\n\nPreserve the current working branch.`;
            const after = addCodeModeEntries(["AFTER_REPLACEMENT"]);
            f.instruction(initial);
            const otherSource = renderCodeModeCatalog(["UNRELATED_INSTRUCTION_SOURCE"], version);
            f.instruction(otherSource, {
                notice: "instructions",
                instructionSources: ["plugin/policy"],
            });
            const combined = `${replaceCodeModeCatalog(["COMBINED_INSTRUCTION_SOURCES"], version)}\n\nDo not deploy without explicit approval.`;
            f.instruction(combined, {
                notice: "instructions",
                instructionSources: ["core/codemode", "plugin/policy"],
            });
            for (const text of [before, oldFull, beforeLatest])
                f.instruction(text, codeModeInstructionMetadata);
            f.instruction(latest, {
                notice: "instructions",
                instructionSources: ["core/codemode", "plugin/policy"],
            });
            f.instruction(after, codeModeInstructionMetadata);
            await f.pass();
            await f.nativeFold(3, 0, "", "manual");
            const folded = await f.pass();
            const sent = folded.draft.messages
                .flatMap((message) => message.content.map((part) => part.text ?? ""))
                .join("\n");
            for (const text of [initial, before, oldFull, beforeLatest])
                expect(sent).not.toContain(text);
            for (const text of [latest, after, otherSource, combined]) expect(sent).toContain(text);
            await f.restart();
            expect((await f.pass()).bytes).toBe(folded.bytes);
        } finally {
            await f.cleanup();
        }
    }, 60000);
}

test("manual compact keeps the initial catalog and incremental changes without a full replacement", async () => {
    const f = await oc2ContextFixture(11870, options);
    try {
        f.compartment(4);
        const instructions = [
            renderCodeModeCatalog(["INITIAL_CATALOG"]),
            addCodeModeEntries(["FIRST_ADDITION"]),
            addCodeModeEntries(["SECOND_ADDITION"]),
        ];
        for (const [index, text] of instructions.entries())
            f.instruction(text, index === 0 ? undefined : codeModeInstructionMetadata);
        await f.pass();
        await f.nativeFold(3, 0, "", "manual");
        const after = await f.pass();
        const sent = after.draft.messages
            .flatMap((message) => message.content.map((part) => part.text ?? ""))
            .join("\n");
        for (const text of instructions) expect(sent).toContain(text);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("manual compact can retire a catalog re-stated by its fresh summary", async () => {
    const f = await oc2ContextFixture(11871, options);
    try {
        f.compartment(4);
        const catalog = renderCodeModeCatalog(["SUMMARY_RESTATES_THIS_CATALOG"]);
        f.instruction(catalog);
        const before = await f.pass();
        expect(
            before.draft.messages
                .flatMap((message) => message.content.map((part) => part.text ?? ""))
                .join("\n")
                .split(catalog),
        ).toHaveLength(2);
        f.db
            .prepare(
                "UPDATE compartments SET content = ?, p1 = ?, p2 = ?, p3 = ?, p4 = ? WHERE session_id = ?",
            )
            .run(catalog, catalog, catalog, catalog, catalog, f.session);
        await f.nativeFold(3, 0, "", "manual");
        const after = await f.pass();
        expect(
            after.draft.messages
                .flatMap((message) => message.content.map((part) => part.text ?? ""))
                .join("\n")
                .split(catalog),
        ).toHaveLength(2);
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
        // An expired cache alone rebuilds nothing, so this replay queues nothing.
        await f.pass();
        await settle();
        expect(compact).toHaveBeenCalledTimes(0);
        // A real rebuild inside the expired window recovers the idle fold once.
        f.setSystem("The host changed its system prefix, but no response completed.");
        await f.pass();
        await settle();
        expect(compact).toHaveBeenCalledTimes(1);
        f.setSystem("The host changed its system prefix again, still with no response.");
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

test("manual compact without compartments answers while preserving raw conversation bytes", async () => {
    const f = await oc2ContextFixture(10869, options);
    try {
        const before = await f.pass();
        const cut = await f.nativeFold(3, 0, "", "manual");
        const stored = f.raw.prepare("SELECT data FROM session_message WHERE id = ?").get(cut) as {
            data: string;
        };
        expect(JSON.parse(stored.data).summary).toBe(RAW_HISTORY_ACCOUNT);
        const after = await f.pass();
        expect(after.bytes).toBe(before.bytes);
        for (const row of f.rows)
            expect(after.draft.messages.some((message) => message.id === row.id)).toBe(true);
        await f.restart();
        expect((await f.pass()).bytes).toBe(before.bytes);
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
