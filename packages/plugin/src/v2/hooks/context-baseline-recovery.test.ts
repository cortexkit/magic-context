import { expect, spyOn, test } from "bun:test";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import * as renderOptions from "../../hooks/magic-context/render-options";
import { NativeFoldReplay } from "../fold/native-replay";
import {
    type AdmissionV3,
    type CapturedReplayV3,
    IMPORTED_MC_SUMMARY,
} from "../fold/native-replay-v3";
import { foldDigest } from "../fold/owner";
import { type Oc2ContextFixture, oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import { HEAD_IDS } from "./payload";
import type { SessionContext } from "./types";

const options = {
    area: "oc2-new-baseline",
    instructions: false,
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
    "missing floor row",
    "edited summary floor row",
    "changed host identity",
    "deleted control and changed hidden history",
    "invalid captured floor",
    "capture beyond surviving store",
    "nonqualifying imported checkpoint",
    "legacy receipt whose upgrade cannot prove its history",
] as const;

for (const [origin, offset] of [
    ["after summary publication", 62980],
    ["after a coordinate rebase", 63000],
] as const) {
    for (const [index, reason] of reasons.entries()) {
        test(`a fresh baseline ${origin} restores the exact checkpoint tail with ${reason}`, async () => {
            const f = await oc2ContextFixture(offset + index, options);
            const restoration = spyOn(NativeFoldReplay.prototype, "restorationFloor");
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
                const first = await f.pass();
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
                expect(next.bytes).toBe(first.bytes);
                expect(next.logs.join("\n")).not.toMatch(
                    /history boundary repair:|HARD.*executed=true/,
                );
            } finally {
                restoration.mockRestore();
                await f.cleanup();
            }
        });
    }
}

for (const [index, blocked] of (
    ["cached boundary id", "cached baseline bytes", "no summaries", "missing newest end"] as const
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
                case "cached baseline bytes":
                    f.db
                        .prepare("UPDATE session_meta SET cached_m0_bytes = ? WHERE session_id = ?")
                        .run(Buffer.from("frozen baseline"), f.session);
                    break;
                case "no summaries":
                    f.db.prepare("DELETE FROM compartments WHERE session_id = ?").run(f.session);
                    break;
                case "missing newest end":
                    deleteRow(f, newest.id);
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
    const f = await oc2ContextFixture(62994, options);
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
test("an archived newest summary serves the same prefix from the anchor or the earliest row", async () => {
    const serve = async (startAtEarliest: boolean) => {
        const f = await oc2ContextFixture(62975, {
            ...options,
            model: "small-archive-model",
            limit: { context: 2000, input: 1800, output: 200 },
        });
        try {
            for (const row of f.rows) {
                row.inputTokens = 5;
                f.edit(row.id, `row-${row.seq}`);
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
            try {
                const first = await f.pass();
                expect(first.bytes).not.toContain("Review history 1");
                expect(first.logs.join("\n")).toMatch(/HARD.*reason=first_render executed=true/);
                expect(rawIDs(first.draft)).toEqual(storeIDs(f, f.rows[13]!.seq));
                changed.mockRestore();
                const next = await f.pass();
                expect(next.bytes).toBe(first.bytes);
                return first.bytes;
            } finally {
                changed.mockRestore();
                budget.mockRestore();
            }
        } finally {
            await f.cleanup();
        }
    };
    const anchored = await serve(false);
    expect(await serve(true)).toBe(anchored);
});
