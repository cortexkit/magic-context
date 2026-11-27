import { expect, spyOn, test } from "bun:test";
import { getCompartments } from "../../features/magic-context/compartment-storage";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import { getSlot } from "../../hooks/magic-context/lkg-slot";
import * as renderOptions from "../../hooks/magic-context/render-options";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import * as models from "../../shared/models-dev-cache";
import { NativeFoldReplay } from "../fold/native-replay";
import {
    type AdmissionV3,
    type CapturedReplayV3,
    IMPORTED_MC_SUMMARY,
} from "../fold/native-replay-v3";
import { foldDigest } from "../fold/owner";
import {
    installBusyAdmission,
    lkgEvents,
    type Oc2ContextFixture,
    oc2ContextFixture,
} from "./__tests__/oc2-context.fixture";
import { HEAD_IDS } from "./payload";
import type { SessionContext } from "./types";

const options = {
    area: "oc2-new-baseline",
    instructions: true,
    temporal: false,
    cacheTtl: "never",
};

function rawIDs(draft: SessionContext) {
    return draft.messages.flatMap(({ id }) =>
        id && !HEAD_IDS.some((head) => head === id) ? [id] : [],
    );
}

function storeIDs(f: Oc2ContextFixture, after: number) {
    return (
        f.raw
            .prepare(
                "SELECT id FROM session_message WHERE session_id = ? AND seq > ? AND type IN ('user', 'assistant') ORDER BY seq",
            )
            .all(f.session, after) as { id: string }[]
    ).map(({ id }) => id);
}

function cached(f: Oc2ContextFixture) {
    return f.db
        .prepare(
            "SELECT cached_m0_last_baseline_end_message_id AS id, cached_m0_bytes IS NOT NULL AS hasBytes FROM session_meta WHERE session_id = ?",
        )
        .get(f.session);
}

function deleteRow(f: Oc2ContextFixture, id: string) {
    f.raw.prepare("DELETE FROM session_message WHERE id = ?").run(id);
}

function withoutCoveredInstructions(f: Oc2ContextFixture, draft: SessionContext, through: number) {
    const texts = new Set(
        (
            f.raw
                .prepare(
                    "SELECT json_extract(data, '$.text') AS text FROM session_message WHERE session_id = ? AND type = 'system' AND seq <= ?",
                )
                .all(f.session, through) as { text: string }[]
        ).map(({ text }) => text),
    );
    const messages = draft.messages.filter(
        (message) => !(message.role === "system" && texts.has(String(message.content[0]?.text))),
    );
    expect(messages.length).toBeLessThan(draft.messages.length);
    return JSON.stringify({ system: draft.system, messages });
}

async function replaceNativeReceipt<T>(
    f: Oc2ContextFixture,
    type: "native-fold" | "native-fold-state",
    edit: (value: T) => void,
) {
    const key = `${type}/v3/${encodeURIComponent(f.session)}`;
    const { payload } = (await f.hostStorage.get(key)) as { payload: string };
    const value = JSON.parse(payload) as T;
    edit(value);
    const updated = JSON.stringify(value);
    await f.hostStorage.set(key, { payload: updated, digest: foldDigest(updated) });
}

const reasons = [
    ["missing floor row", true],
    ["edited summary floor row", true],
    ["changed host identity", false],
    ["deleted control and changed hidden history", true],
    ["invalid captured floor", false],
    ["capture beyond surviving store", false],
    ["nonqualifying imported checkpoint", true],
    ["legacy receipt whose upgrade cannot prove its history", false],
] as const;

for (const [origin, offset] of [
    ["after summary publication", 62980],
    ["after a coordinate rebase", 63000],
] as const) {
    for (const [index, [reason, readmitted]] of reasons.entries()) {
        test(`a fresh baseline ${origin} with ${reason}: ${readmitted ? "managed, native, native" : "managed, managed"}`, async () => {
            const f = await oc2ContextFixture(offset + index, options);
            const restoration = spyOn(NativeFoldReplay.prototype, "restorationFloor");
            const native = spyOn(NativeFoldReplay.prototype, "restore");
            try {
                const floor = f.rows[5]!;
                const controlAnchor = f.rows[8]!;
                const anchor = f.rows[13]!;
                f.compartment(5);
                await f.pass((draft) => {
                    if (reason !== "deleted control and changed hidden history") return;
                    const position = draft.messages.findIndex(({ id }) => id === controlAnchor.id);
                    expect(position).toBeGreaterThan(0);
                    draft.messages.splice(position + 1, 0, {
                        role: "system",
                        content: [{ type: "effort", effort: "low", previous: "high" }],
                    });
                });
                const cut = await f.nativeFold(
                    reason.startsWith("legacy receipt") ? 2 : 3,
                    2,
                    "",
                    "manual",
                );
                f.user("first turn needing a fresh baseline", 1000);
                f.compartment(13);
                if (origin === "after a coordinate rebase") {
                    // The next pass converts the older host's coordinates and
                    // clears the baseline itself before looking at replay floors.
                    f.db
                        .prepare(
                            "UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?",
                        )
                        .run(f.session);
                    f.db
                        .prepare(
                            "UPDATE compartments SET start_message = start_message + 100, end_message = end_message + 100 WHERE session_id = ?",
                        )
                        .run(f.session);
                    expect(cached(f)).toEqual({ id: floor.id, hasBytes: 1 });
                } else {
                    // A replacement publication leaves the new summary ahead of
                    // the old receipt and clears the cached baseline.
                    clearCachedM0M1(f.db, f.session);
                    expect(cached(f)).toEqual({ id: null, hasBytes: 0 });
                }
                const stale = async () =>
                    replaceNativeReceipt<AdmissionV3>(f, "native-fold", (value) => {
                        value.proof.admissionID = "previous-local-checkpoint";
                    });
                switch (reason) {
                    case "missing floor row":
                        deleteRow(f, floor.id);
                        break;
                    case "edited summary floor row":
                        f.edit(floor.id, "The old floor was edited in place.");
                        break;
                    case "changed host identity":
                        await replaceNativeReceipt<AdmissionV3>(f, "native-fold", (value) => {
                            value.proof.sourceDigest = foldDigest("a replaced host store");
                        });
                        await replaceNativeReceipt<CapturedReplayV3>(
                            f,
                            "native-fold-state",
                            (value) => {
                                value.sourceDigest = foldDigest("a replaced host store");
                            },
                        );
                        break;
                    case "deleted control and changed hidden history":
                        deleteRow(f, controlAnchor.id);
                        break;
                    case "invalid captured floor":
                        await stale();
                        await replaceNativeReceipt<CapturedReplayV3>(
                            f,
                            "native-fold-state",
                            (value) => {
                                value.replay.floor.digest = foldDigest("old captured contents");
                            },
                        );
                        break;
                    case "capture beyond surviving store":
                        await stale();
                        await replaceNativeReceipt<CapturedReplayV3>(
                            f,
                            "native-fold-state",
                            (value) => {
                                value.through = f.rows.at(-1)!.seq + 1;
                            },
                        );
                        break;
                    case "nonqualifying imported checkpoint":
                        deleteRow(f, floor.id);
                        f.raw
                            .prepare(
                                "UPDATE session_message SET type = 'compaction', data = ? WHERE id = ?",
                            )
                            .run(
                                JSON.stringify({ status: "running", summary: IMPORTED_MC_SUMMARY }),
                                controlAnchor.id,
                            );
                        break;
                    case "legacy receipt whose upgrade cannot prove its history":
                        deleteRow(f, floor.id);
                        break;
                }
                await f.restart();
                native.mockClear();
                const first = await f.pass();
                expect(native).not.toHaveBeenCalled();
                expect(restoration).toHaveBeenCalledTimes(1);
                expect(await restoration.mock.results[0]?.value).toBeUndefined();
                const checkpoint = f.raw
                    .prepare("SELECT seq FROM session_message WHERE id = ?")
                    .get(cut) as { seq: number };
                const expected = storeIDs(f, anchor.seq);
                expect(expected.length).toBeGreaterThan(first.inputIds.length);
                expect(anchor.seq).toBeLessThan(checkpoint.seq);
                expect(rawIDs(first.draft)).toEqual(expected);
                expect(cached(f)).toEqual({ id: anchor.id, hasBytes: 1 });
                expect(first.logs.join("\n")).not.toContain("history boundary repair:");
                const next = await f.pass();
                expect(rawIDs(next.draft)).toEqual(expected);
                expect(next.draft.tools).toEqual(first.draft.tools);
                if (readmitted) {
                    expect(native).toHaveBeenCalledTimes(1);
                    expect(restoration).toHaveBeenCalledTimes(1);
                    expect(next.bytes).toBe(withoutCoveredInstructions(f, first.draft, anchor.seq));
                    expect(next.bytes).not.toBe(first.bytes);
                    const third = await f.pass();
                    expect(native).toHaveBeenCalledTimes(2);
                    expect(restoration).toHaveBeenCalledTimes(1);
                    expect(third.bytes).toBe(next.bytes);
                    expect(third.draft.tools).toEqual(next.draft.tools);
                } else {
                    expect(native).not.toHaveBeenCalled();
                    expect(restoration).toHaveBeenCalledTimes(2);
                    expect(next.bytes).toBe(first.bytes);
                }
                expect(next.logs.join("\n")).not.toMatch(
                    /history boundary repair:|HARD.*executed=true/,
                );
            } finally {
                native.mockRestore();
                restoration.mockRestore();
                await f.cleanup();
            }
        });
    }
}

for (const [index, blocked] of (
    [
        "cached boundary id",
        "missing newest end",
        "an unresolved newest summary",
        "unknown session mode",
    ] as const
).entries()) {
    test(`an unusable checkpoint floor still refuses with ${blocked}`, async () => {
        const f = await oc2ContextFixture(62990 + index, options);
        try {
            const oldFloor = f.rows[5]!;
            const newest = f.rows[13]!;
            f.compartment(5);
            await f.pass();
            await f.nativeFold(3, 2, "", "manual");
            f.compartment(13);
            deleteRow(f, oldFloor.id);
            clearCachedM0M1(f.db, f.session);
            switch (blocked) {
                case "cached boundary id":
                    f.db
                        .prepare(
                            "UPDATE session_meta SET cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
                        )
                        .run(newest.id, f.session);
                    break;
                case "missing newest end":
                    deleteRow(f, newest.id);
                    break;
                case "an unresolved newest summary":
                    f.db
                        .prepare(
                            "UPDATE compartments SET rebase_status = 'unresolved' WHERE session_id = ? AND sequence = 1",
                        )
                        .run(f.session);
                    break;
                case "unknown session mode":
                    // Keep the mode unresolved when the normal host lookup retries it.
                    f.raw.prepare("DELETE FROM session_v2 WHERE id = ?").run(f.session);
                    f.db
                        .prepare("UPDATE session_meta SET is_subagent = NULL WHERE session_id = ?")
                        .run(f.session);
                    break;
            }
            await f.restart();
            const result = await f.attempt();
            expect(result.error).toBeInstanceOf(Error);
            expect(result.logs.join("\n")).toMatch(
                /\[MC-S06\].*Host checkpoint replay boundary is unavailable/,
            );
            expect(result.logs.join("\n")).not.toMatch(/HARD.*executed=true/);
        } finally {
            await f.cleanup();
        }
    });
}

test("a first render with published history and an unadmitted checkpoint restores the exact tail", async () => {
    const f = await oc2ContextFixture(62999, { ...options, instructions: false });
    try {
        const newest = f.rows[5]!;
        f.compartment(5);
        const cut = "unadmitted-local-cut";
        const seq = f.rows.at(-1)!.seq + 1;
        f.raw
            .prepare(
                "INSERT INTO session_message(id, session_id, type, seq, time_created, data) VALUES (?, ?, 'compaction', ?, ?, ?)",
            )
            .run(
                cut,
                f.session,
                seq,
                Date.now(),
                JSON.stringify({ status: "completed", summary: "Local summary" }),
            );
        const pass = () =>
            f.pass((draft) => {
                draft.messages.splice(0, draft.messages.length - 2, {
                    id: cut,
                    role: "user",
                    content: [{ type: "text", text: "<summary>\nLocal summary\n</summary>" }],
                });
            });
        const first = await pass();
        expect(rawIDs(first.draft)).toEqual(storeIDs(f, newest.seq));
        expect(cached(f)).toEqual({ id: newest.id, hasBytes: 1 });
        const next = await pass();
        expect(rawIDs(next.draft)).toEqual(storeIDs(f, newest.seq));
        expect(next.bytes).toBe(first.bytes);
    } finally {
        await f.cleanup();
    }
});

// A fresh-baseline floor relies on the shared trim, not on the summary text
// being visible: the history budget can archive even the newest summary.
test("an archived newest summary serves the same requests from the anchor or the earliest row: managed, native, native", async () => {
    const serve = async (startAtEarliest: boolean) => {
        const f = await oc2ContextFixture(62975, {
            ...options,
            model: "small-archive-model",
            limit: { context: 2000, input: 1800, output: 200 },
        });
        try {
            for (const row of f.rows) {
                row.inputTokens = 5;
                if (row.type !== "system") f.edit(row.id, `row-${row.seq}`);
            }
            f.compartment(5);
            await f.pass();
            await f.nativeFold(3, 2, "", "manual");
            f.compartment(13);
            clearCachedM0M1(f.db, f.session);
            deleteRow(f, f.rows[5]!.id);
            await f.restart();

            const resolve = renderOptions.createM0RenderOptions;
            const budget = spyOn(renderOptions, "createM0RenderOptions").mockImplementation(
                (...args) => ({ ...resolve(...args), historyBudgetTokens: 1 }),
            );
            // The existing source-change fallback starts at the earliest row.
            const changed = spyOn(NativeFoldReplay.prototype, "sourceChanged").mockReturnValue(
                startAtEarliest,
            );
            const native = spyOn(NativeFoldReplay.prototype, "restore");
            try {
                const first = await f.pass();
                expect(native).not.toHaveBeenCalled();
                expect(first.bytes).not.toContain("Review history 1");
                expect(first.logs.join("\n")).toMatch(/HARD.*reason=first_render executed=true/);
                expect(rawIDs(first.draft)).toEqual(storeIDs(f, f.rows[13]!.seq));
                changed.mockRestore();
                const next = await f.pass();
                expect(native).toHaveBeenCalledTimes(1);
                expect(next.bytes).toBe(
                    withoutCoveredInstructions(f, first.draft, f.rows[13]!.seq),
                );
                expect(next.bytes).not.toBe(first.bytes);
                const third = await f.pass();
                expect(native).toHaveBeenCalledTimes(2);
                expect(third.bytes).toBe(next.bytes);
                return [first.bytes, next.bytes, third.bytes];
            } finally {
                native.mockRestore();
                changed.mockRestore();
                budget.mockRestore();
            }
        } finally {
            await f.cleanup();
        }
    };
    const anchored = await serve(false);
    expect(await serve(true)).toEqual(anchored);
});

test("a recovered null cached boundary logs one removal of covered instructions", async () => {
    const f = await oc2ContextFixture(64100, options);
    try {
        const old = f.rows[5]!;
        const newest = f.rows[13]!;
        f.compartment(5);
        await f.pass();
        const cut = await f.nativeFold(3, 2, "", "manual");
        f.compartment(13);
        deleteRow(f, old.id);
        clearCachedM0M1(f.db, f.session);
        f.db
            .prepare("UPDATE session_meta SET cached_m0_bytes = ? WHERE session_id = ?")
            .run(Buffer.from("frozen baseline"), f.session);
        await f.restart();

        const first = await f.pass();
        const raw = rawIDs(first.draft);
        const rows = storeIDs(f, -1);
        expect(rows).toHaveLength(24);
        expect(raw).toEqual(storeIDs(f, newest.seq));
        const summaries = getCompartments(f.db, f.session);
        expect(summaries.map(({ title }) => title)).toEqual([
            "Review history 0",
            "Review history 1",
        ]);
        for (const summary of summaries) expect(first.bytes.split(summary.title)).toHaveLength(2);
        const position = (id: string | null) => f.rows.find(({ id: rowId }) => rowId === id)?.seq;
        for (const id of rows) {
            const seq = position(id);
            expect(seq).toBeDefined();
            const coverage = summaries.filter(({ startMessageId, endMessageId }) => {
                const start = position(startMessageId);
                const end = position(endMessageId);
                return start !== undefined && end !== undefined && seq! >= start && seq! <= end;
            });
            expect(raw.filter((rawID) => rawID === id).length + coverage.length).toBe(1);
        }
        expect(cached(f)).toEqual({ id: newest.id, hasBytes: 1 });
        expect(first.logs.join("\n")).not.toContain("was re-admitted");

        const next = await f.pass();
        expect(next.bytes).toBe(withoutCoveredInstructions(f, first.draft, newest.seq));
        expect(next.bytes).not.toBe(first.bytes);
        expect(next.draft.tools).toEqual(first.draft.tools);
        expect(next.logs.filter((line) => line.includes("was re-admitted"))).toEqual([
            expect.stringContaining(
                `the native record for checkpoint ${cut} was re-admitted; 1 covered instruction row is no longer sent, changing the cached prefix once`,
            ),
        ]);
        await f.restart();
        const third = await f.pass();
        expect(third.bytes).toBe(next.bytes);
        expect(third.draft.tools).toEqual(next.draft.tools);
        expect(third.logs.join("\n")).not.toContain("was re-admitted");
    } finally {
        await f.cleanup();
    }
});

test("a repair above the old native floor changes only covered instructions: managed, native, native; logging is independent", async () => {
    const serve = async (diagnostic: "present" | "absent" | "different checkpoint") => {
        const f = await oc2ContextFixture(63020, options);
        const native = spyOn(NativeFoldReplay.prototype, "restore");
        const peek = BoundedSessionMap.prototype.peek;
        let markerReads = 0;
        // Alter only the diagnostic record, never the store or the checkpoint in the draft.
        const marker = spyOn(BoundedSessionMap.prototype, "peek").mockImplementation(function (
            this: BoundedSessionMap<unknown>,
            id: string,
        ) {
            const value = peek.call(this, id);
            if (!value || typeof value !== "object" || !("coveredInstructionIDs" in value))
                return value;
            markerReads++;
            if (diagnostic === "absent") return undefined;
            return diagnostic === "different checkpoint"
                ? { ...value, checkpointID: "another-cut" }
                : value;
        });
        try {
            const old = f.rows[5]!;
            const anchor = f.rows[13]!;
            const deleted = f.rows[17]!;
            f.compartment(5);
            await f.pass();
            const cut = await f.nativeFold(3, 2, "", "manual");
            const currentFloor = async () => {
                const key = `native-fold/v3/${encodeURIComponent(f.session)}`;
                const { payload } = (await f.hostStorage.get(key)) as { payload: string };
                return (JSON.parse(payload) as AdmissionV3).replay.floor.id;
            };
            expect(await currentFloor()).toBe(old.id);
            f.compartment(13);
            f.compartment(17);
            f.user("first turn after history deletion", 1000);
            deleteRow(f, old.id);
            deleteRow(f, deleted.id);
            await f.restart();
            const first = await f.pass();
            expect(first.logs.join("\n")).toContain("history boundary repair:");
            expect(native).not.toHaveBeenCalled();
            expect(await currentFloor()).toBe(anchor.id);
            expect(rawIDs(first.draft)).toEqual(storeIDs(f, anchor.seq));
            const next = await f.pass();
            expect(native).toHaveBeenCalledTimes(1);
            expect(next.logs.join("\n")).toContain("rematerialized=false, reason=cache_hit");
            expect(next.logs.filter((line) => line.includes("was re-admitted"))).toEqual(
                diagnostic === "present"
                    ? [
                          `${f.session} v2 host fold: after history recovery, the native record for checkpoint ${cut} was re-admitted; 1 covered instruction row is no longer sent, changing the cached prefix once`,
                      ]
                    : [],
            );
            expect(next.bytes).toBe(withoutCoveredInstructions(f, first.draft, anchor.seq));
            expect(next.bytes).not.toBe(first.bytes);
            expect(next.draft.tools).toEqual(first.draft.tools);
            const third = await f.pass();
            expect(native).toHaveBeenCalledTimes(2);
            expect(third.bytes).toBe(next.bytes);
            expect(third.draft.tools).toEqual(next.draft.tools);
            expect(third.logs.join("\n")).not.toContain("was re-admitted");
            expect(markerReads).toBe(1);
            return JSON.stringify({
                system: next.draft.system,
                messages: next.draft.messages,
                tools: next.draft.tools,
            });
        } finally {
            marker.mockRestore();
            native.mockRestore();
            await f.cleanup();
        }
    };
    const logged = await serve("present");
    expect(await serve("absent")).toBe(logged);
    expect(await serve("different checkpoint")).toBe(logged);
});

test("read-only recovery cannot use the fresh-baseline start without a receipt", async () => {
    const admission = installBusyAdmission();
    const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
    const f = await oc2ContextFixture(63045, { ...options, instructions: false });
    // The read-only replay is served only when the input it rebuilds equals
    // the input saved with the last good request. That saved input starts
    // right after the newest summary. Keep the post-pass capture from saving
    // a start point, so the two can only match if the read-only path wrongly
    // starts after the newest summary too, which only a writing pass may do.
    const capture = spyOn(NativeFoldReplay.prototype, "capture").mockResolvedValue(undefined);
    try {
        f.compartment(5);
        await f.pass();
        await f.nativeFold(3, 2, "", "manual");
        const key = `native-fold/v3/${encodeURIComponent(f.session)}`;
        const captureKey = `native-fold-state/v3/${encodeURIComponent(f.session)}`;
        await f.hostStorage.set(key, undefined);
        await f.hostStorage.set(captureKey, undefined);
        clearCachedM0M1(f.db, f.session);
        await f.restart();
        f.user("healthy request saved after a fresh baseline", 120000);
        await f.pass();
        f.respond();
        f.user("request while another writer is busy", 120000);
        expect(getSlot(f.session)).toBeDefined();
        expect(await f.hostStorage.get(key)).toBeUndefined();
        expect(await f.hostStorage.get(captureKey)).toBeUndefined();
        clearCachedM0M1(f.db, f.session);
        admission.state.exhaustNext = true;
        const attempt = await f.attempt();
        expect(attempt.error).toBeInstanceOf(Error);
        expect(lkgEvents(attempt.logs)).toBe("lkg_invalidated_reshape,lkg_miss");
        expect(attempt.logs.join("\n")).toContain("arm=storage-busy");
        expect(cached(f)).toEqual({ id: null, hasBytes: 0 });
    } finally {
        capture.mockRestore();
        limit.mockRestore();
        admission.restore();
        await f.cleanup();
    }
});
