import { expect, spyOn, test } from "bun:test";
import { NativeFoldReplay } from "../fold/native-replay";
import { IMPORTED_MC_SUMMARY } from "../fold/native-replay-v3";
import {
    installTransientFailure,
    type Oc2ContextFixture,
    oc2ContextFixture,
} from "./__tests__/oc2-context.fixture";
import { HEAD_IDS } from "./payload";
import type { SessionContext } from "./types";

const options = {
    area: "oc2-deleted-boundary",
    instructions: false,
    temporal: false,
    cacheTtl: "never",
};

type BoundarySession = {
    anchor: Oc2ContextFixture["rows"][number];
    newest: Oc2ContextFixture["rows"][number];
};

function seedSummaries(f: Oc2ContextFixture): BoundarySession {
    const anchor = f.rows[5]!;
    const newest = f.rows[13]!;
    f.compartment(5);
    f.compartment(13);
    return { anchor, newest };
}

function removeNewestCompartment(f: Oc2ContextFixture) {
    f.db.prepare("DELETE FROM compartments WHERE session_id = ? AND sequence = 1").run(f.session);
}

function deleteBoundary(f: Oc2ContextFixture, id: string) {
    f.raw.prepare("DELETE FROM session_message WHERE session_id = ? AND id = ?").run(f.session, id);
}

function storedIDs(f: Oc2ContextFixture, after: number, through = Infinity): string[] {
    return (
        f.raw
            .prepare(
                "SELECT id FROM session_message WHERE session_id = ? AND seq > ? AND seq <= ? AND type IN ('user','assistant') ORDER BY seq",
            )
            .all(f.session, after, through) as { id: string }[]
    ).map(({ id }) => id);
}

function rawIDs(draft: SessionContext): string[] {
    return draft.messages.flatMap(({ id }) =>
        id && !HEAD_IDS.some((head) => head === id) ? [id] : [],
    );
}

function cachedEnd(f: Oc2ContextFixture): string | null {
    return (
        f.db
            .prepare(
                "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
            )
            .get(f.session) as { id: string | null }
    ).id;
}

function cachedBaseline(f: Oc2ContextFixture): { id: string | null; bytes: Buffer | null } {
    return f.db
        .prepare(
            "SELECT cached_m0_last_baseline_end_message_id AS id, cached_m0_bytes AS bytes FROM session_meta WHERE session_id = ?",
        )
        .get(f.session) as { id: string | null; bytes: Buffer | null };
}

function prefix(draft: SessionContext, before: string): string {
    const index = draft.messages.findIndex(({ id }) => id === before);
    expect(index).toBeGreaterThan(0);
    return JSON.stringify({
        system: draft.system,
        tools: draft.tools,
        messages: draft.messages.slice(0, index),
    });
}

for (const [description, restart, seed] of [
    ["transient failure on the repair pass", false, 62907],
    ["transient failure on the repair pass, then a restart", true, 62908],
] as const) {
    test(description, async () => {
        const failure = installTransientFailure();
        const f = await oc2ContextFixture(seed, options);
        try {
            const { anchor, newest } = seedSummaries(f);
            await f.pass();
            const cut = await f.nativeFold(3, 2, "", "manual");
            f.user("repair turn", 1000);
            deleteBoundary(f, newest.id);
            await f.restart();
            failure.state.failNext = true;

            const failed = await f.attempt();
            expect(failed.error).toBeInstanceOf(Error);
            expect(failed.logs.join("\n")).toContain("re-anchored on compartment");
            expect(failed.logs.join("\n")).toContain("storage-busy");
            expect(cachedBaseline(f)).toEqual({ id: null, bytes: null });
            expect(
                f.db
                    .prepare("SELECT end_message_id FROM compartments WHERE session_id = ?")
                    .all(f.session),
            ).toEqual([{ end_message_id: anchor.id }]);

            if (restart) await f.restart();
            const retry = await f.attempt();
            expect(retry.logs.join("\n")).not.toContain("history boundary repair:");
            expect(retry.error).toBeUndefined();
            const checkpoint = f.raw
                .prepare("SELECT seq FROM session_message WHERE id = ?")
                .get(cut) as { seq: number };
            expect(
                storedIDs(f, anchor.seq, checkpoint.seq - 1).some(
                    (id) => !retry.inputIds.includes(id),
                ),
            ).toBe(true);
            expect(rawIDs(retry.draft)).toEqual(storedIDs(f, anchor.seq));
            expect(cachedEnd(f)).toBe(anchor.id);

            f.user("next turn", 1000);
            deleteBoundary(f, newest.id);
            const nextID = f.rows.at(-1)!.id;
            const next = await f.pass();
            expect(rawIDs(next.draft)).toEqual(storedIDs(f, anchor.seq));
            expect(prefix(next.draft, nextID)).toBe(
                JSON.stringify({
                    system: retry.draft.system,
                    tools: retry.draft.tools,
                    messages: retry.draft.messages,
                }),
            );
            expect(next.logs.join("\n")).not.toMatch(
                /history boundary repair:|HARD.*executed=true/,
            );
        } finally {
            failure.restore();
            await f.cleanup();
        }
    });
}

for (const [kind, seed] of [
    ["repaired", 62901],
    ["baseline-reset", 62902],
] as const) {
    test(`a ${kind} boundary restores the missing checkpoint rows when no native floor survives`, async () => {
        const f = await oc2ContextFixture(seed, options);
        try {
            const { anchor, newest } = seedSummaries(f);
            await f.pass();
            const checkpointID = await f.nativeFold(3, 2, "", "manual");
            expect(cachedEnd(f)).toBe(newest.id);
            f.user("repair turn", 1000);
            if (kind === "baseline-reset") removeNewestCompartment(f);
            deleteBoundary(f, newest.id);
            await f.restart();

            const first = await f.attempt();
            expect(first.logs.join("\n")).toContain(
                kind === "repaired"
                    ? "re-anchored on compartment"
                    : "rebuilding it on this pass against compartment end",
            );
            expect(first.logs.join("\n")).toContain(
                "replay refused: invalid checkpoint floor or provenance",
            );
            expect(first.error).toBeUndefined();
            expect(cachedEnd(f)).toBe(anchor.id);
            const checkpoint = f.raw
                .prepare("SELECT seq FROM session_message WHERE id = ?")
                .get(checkpointID) as { seq: number };
            const hidden = storedIDs(f, anchor.seq, checkpoint.seq - 1).filter(
                (id) => !first.inputIds.includes(id),
            );
            expect(hidden.length).toBeGreaterThan(0);
            expect(rawIDs(first.draft)).toEqual(storedIDs(f, anchor.seq));
            expect(
                first.logs.filter((line) => /HARD.*reason=first_render executed=true/.test(line)),
            ).toHaveLength(1);

            f.user("next turn", 1000);
            deleteBoundary(f, newest.id);
            const nextID = f.rows.at(-1)!.id;
            const next = await f.pass();
            expect(rawIDs(next.draft)).toEqual(storedIDs(f, anchor.seq));
            expect(prefix(next.draft, nextID)).toBe(
                JSON.stringify({
                    system: first.draft.system,
                    tools: first.draft.tools,
                    messages: first.draft.messages,
                }),
            );
            expect(next.logs.join("\n")).not.toMatch(
                /history boundary repair:|HARD.*executed=true/,
            );
        } finally {
            await f.cleanup();
        }
    });
}

test("a missing native floor still refuses when no shared history repair ran", async () => {
    const f = await oc2ContextFixture(62903, options);
    try {
        const { newest } = seedSummaries(f);
        await f.pass();
        await f.nativeFold(3, 2, "", "manual");
        f.db.prepare("DELETE FROM compartments WHERE session_id = ?").run(f.session);
        deleteBoundary(f, newest.id);
        await f.restart();
        const result = await f.attempt();
        expect(result.error).toBeInstanceOf(Error);
        expect(result.logs.join("\n")).toContain("[MC-S06]");
        expect(result.logs.join("\n")).toContain("Host checkpoint replay boundary is unavailable");
        expect(result.logs.join("\n")).not.toContain("history boundary repair:");
    } finally {
        await f.cleanup();
    }
});

test("repair without a local host checkpoint continues to restore the host's uncut rows", async () => {
    const f = await oc2ContextFixture(62904, options);
    try {
        const { anchor, newest } = seedSummaries(f);
        await f.pass();
        deleteBoundary(f, newest.id);
        await f.restart();
        const result = await f.pass((draft) => {
            draft.messages = draft.messages.filter(({ id }) => id !== newest.id);
        });
        expect(result.logs.join("\n")).toContain("history boundary repair:");
        expect(cachedEnd(f)).toBe(anchor.id);
        expect(rawIDs(result.draft)).toEqual(storedIDs(f, anchor.seq));
    } finally {
        await f.cleanup();
    }
});

// A fix that restores the uncovered rows should turn these tests red on purpose.
test("known gap: rows between the newest summary and a higher imported floor are not restored", async () => {
    const f = await oc2ContextFixture(62905, options);
    const native = spyOn(NativeFoldReplay.prototype, "restore");
    try {
        const { anchor, newest } = seedSummaries(f);
        const imported = f.rows[9]!;
        await f.pass();
        await f.nativeFold(3, 2, "", "manual");
        f.raw
            .prepare("UPDATE session_message SET type = 'compaction', data = ? WHERE id = ?")
            .run(
                JSON.stringify({ status: "completed", summary: IMPORTED_MC_SUMMARY }),
                imported.id,
            );
        deleteBoundary(f, newest.id);
        await f.restart();

        const first = await f.pass();
        const next = await f.pass();
        expect(first.logs.join("\n")).toContain("history boundary repair:");
        expect(first.logs.join("\n")).toContain(
            "replay refused: invalid checkpoint floor or provenance",
        );
        expect(cachedEnd(f)).toBe(anchor.id);
        expect(native).not.toHaveBeenCalled();
        const skipped = storedIDs(f, anchor.seq, imported.seq);
        expect(skipped).toEqual(f.rows.slice(6, 9).map(({ id }) => id));
        // These rows are in neither the surviving summary nor a served checkpoint.
        for (const pass of [first, next]) {
            expect(rawIDs(pass.draft)).toEqual(storedIDs(f, imported.seq));
            expect(pass.bytes).not.toContain(IMPORTED_MC_SUMMARY);
            expect(pass.bytes).not.toContain("Review history 1");
        }
        expect(next.bytes).toBe(first.bytes);
    } finally {
        native.mockRestore();
        await f.cleanup();
    }
});

test("known gap: a cached-boundary reset can replay a higher native floor and omit uncovered rows", async () => {
    const f = await oc2ContextFixture(62906, options);
    const native = spyOn(NativeFoldReplay.prototype, "restore");
    try {
        const { anchor, newest } = seedSummaries(f);
        await f.pass();
        await f.nativeFold(3, 2, "", "manual");
        // Keep the native checkpoint admission and its host rows valid. The
        // cached baseline points at an absent row and only the older summary survives.
        removeNewestCompartment(f);
        f.db
            .prepare(
                "UPDATE session_meta SET cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
            )
            .run("missing-cached-boundary", f.session);
        await f.restart();

        const first = await f.pass();
        expect(first.logs.join("\n")).toContain(
            "rebuilding it on this pass against compartment end",
        );
        expect(native).toHaveBeenCalledTimes(1);
        const next = await f.pass();
        expect(native).toHaveBeenCalledTimes(2);
        expect(cachedEnd(f)).toBe(anchor.id);
        const skipped = storedIDs(f, anchor.seq, newest.seq);
        expect(skipped).toEqual(f.rows.slice(6, 14).map(({ id }) => id));
        for (const pass of [first, next]) {
            expect(rawIDs(pass.draft)).toEqual(storedIDs(f, newest.seq));
            expect(pass.bytes).not.toContain("<conversation-checkpoint>");
            expect(pass.bytes).not.toContain("Review history 1");
        }
        expect(next.bytes).toBe(first.bytes);
    } finally {
        native.mockRestore();
        await f.cleanup();
    }
});
